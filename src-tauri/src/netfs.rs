//! 文件管理页的"网络盘"后端：FTP / FTPS（显式 AUTH TLS + 隐式 990）/ TFTP。
//!
//! 设计要点：
//!   · 协议自己写（FTP 是一行一行的纯文本；TFTP 是 RFC 1350 + blksize/tsize 选项），
//!     不引第三方 FTP crate —— 少一层依赖，也少一份要跟的对端怪癖；
//!   · FTPS 的 TLS 用 rustls（Apache-2.0/MIT/ISC；仓库里 ureq 本来就在用它），
//!     证书默认走系统信任根（webpki-roots），内网自签名设备可以勾"不校验证书"；
//!   · 数据连接（RETR/STOR/LIST）和控制连接共用同一份 ClientConfig（开了会话缓存），
//!     否则 vsftpd 这类 require_ssl_reuse=YES 的服务器会拒掉数据连接；
//!   · 会话按 id 存在全局表里（控制连接是有状态的，不能每次命令重连），
//!     TFTP 是无状态的一问一答，不需要会话；
//!   · 内置 TFTP 服务端（给设备/下位机来取固件用）也在这个模块里，不依赖任何外部程序。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};



const IO_TIMEOUT: Duration = Duration::from_secs(20);

/* ───────────────────────── TLS ───────────────────────── */

/// "不校验证书"模式：内网设备大多是自签名证书，UI 上默认不勾，
/// 勾上就从"拒绝一切"换成"接受一切"（连接建立后仍会把指纹回显给上层看）。
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// 一份 TLS 配置。同一个 FTP 会话的控制连接和数据连接共用它（会话缓存才有意义）。
fn tls_config(insecure: bool) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("rustls 默认协议版本");
    let mut cfg = if insecure {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
            .with_no_client_auth()
    } else {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    // FTPS 的数据连接要复用控制连接的 TLS 会话（vsftpd 默认就要求这个）
    cfg.resumption = rustls::client::Resumption::store(Arc::new(rustls::client::ClientSessionMemoryCache::new(32)));
    Arc::new(cfg)
}

fn tls_wrap(cfg: &Arc<ClientConfig>, tcp: TcpStream, host: &str) -> Result<StreamOwned<ClientConnection, TcpStream>, String> {
    tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();
    let name = ServerName::try_from(host.to_string()).map_err(|e| format!("服务器名不合法（{host}）: {e}"))?;
    let conn = ClientConnection::new(cfg.clone(), name).map_err(|e| format!("TLS 初始化失败: {e}"))?;
    Ok(StreamOwned::new(conn, tcp))
}

/* ───────────────────────── 通道 ───────────────────────── */

/// 控制连接 / 数据连接都收敛成这一个：明文或 TLS，上层不用分支。
enum Chan {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Read for Chan {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Chan::Plain(s) => s.read(buf),
            Chan::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Chan {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Chan::Plain(s) => s.write(buf),
            Chan::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Chan::Plain(s) => s.flush(),
            Chan::Tls(s) => s.flush(),
        }
    }
}

/* ───────────────────────── FTP ───────────────────────── */

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub mtime: String,
}

impl Entry {
    fn json(&self) -> Value {
        json!({ "name": self.name, "size": self.size, "is_dir": self.is_dir, "mtime": self.mtime })
    }
}

struct Ftp {
    ctrl: Chan,
    cfg: Arc<ClientConfig>,
    /// 连的是哪台（TLS 的 SNI / 证书校验要用域名，不能用标签里抠出来的）
    host: String,
    /// 数据连接要不要 TLS（PROT P）。FTPS 都是 P。
    data_tls: bool,
    /// 控制连接对端的 IP —— PASV 应答里给的地址经常是内网地址甚至 0.0.0.0，用对端 IP 更稳。
    peer: IpAddr,
    label: String,
    mlsd: bool,
}

fn io_err(what: &str, e: std::io::Error) -> String {
    format!("{what}失败: {e}")
}

impl Ftp {
    fn read_reply(&mut self) -> Result<(u16, String), String> {
        let mut out = String::new();
        let mut buf = [0u8; 1];
        // 逐行读：FTP 应答最多几行，且必须读到 "NNN " 才算结束
        loop {
            let mut line = String::new();
            loop {
                let n = self.ctrl.read(&mut buf).map_err(|e| io_err("读应答", e))?;
                if n == 0 {
                    if line.is_empty() && out.is_empty() {
                        return Err("服务器把连接关了（没给应答）".into());
                    }
                    break;
                }
                line.push(buf[0] as char);
                if line.ends_with("\n") {
                    break;
                }
                if line.len() > 4096 {
                    break;
                }
            }
            if line.is_empty() {
                break;
            }
            out.push_str(&line);
            let t = line.trim_end();
            if t.len() >= 4 && t.as_bytes()[3] == b' ' {
                break;
            }
            if out.len() > 16 * 1024 {
                break;
            }
        }
        let code: u16 = out
            .get(0..3)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("看不懂的应答：{}", out.trim()))?;
        Ok((code, out))
    }

    fn send(&mut self, line: &str) -> Result<(), String> {
        let s = format!("{line}\r\n");
        self.ctrl.write_all(s.as_bytes()).map_err(|e| io_err("写命令", e))?;
        self.ctrl.flush().map_err(|e| io_err("写命令", e))
    }

    fn cmd(&mut self, line: &str) -> Result<(u16, String), String> {
        self.send(line)?;
        self.read_reply()
    }

    /// 跑一条命令并要求应答码在 codes 里，否则报错（把服务器那句话带出来，排障最有用）
    fn must(&mut self, line: &str, codes: &[u16]) -> Result<String, String> {
        let (c, t) = self.cmd(line)?;
        if codes.contains(&c) {
            Ok(t)
        } else {
            Err(format!("{} → {}", line, t.trim()))
        }
    }

    fn open(cfg: TlsCfg, host: &str, port: u16, user: &str, pass: &str, data_tls: bool) -> Result<Ftp, String> {
        let addr = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("解析地址失败（{host}:{port}）: {e}"))?
            .next()
            .ok_or_else(|| format!("解析不到地址：{host}:{port}"))?;
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|e| format!("连不上 {host}:{port} → {e}"))?;
        tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
        tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();
        tcp.set_nodelay(true).ok();
        let peer = addr.ip();
        let tls = tls_config(cfg.insecure);
        let mut me = Ftp {
            ctrl: if cfg.implicit {
                Chan::Tls(Box::new(tls_wrap(&tls, tcp, host)?))
            } else {
                Chan::Plain(tcp)
            },
            cfg: tls,
            host: host.to_string(),
            data_tls,
            peer,
            label: format!("FTP {host}:{port}"),
            mlsd: false,
        };
        let (c, t) = me.read_reply()?;
        if c != 220 {
            return Err(format!("服务器没准备好：{}", t.trim()));
        }
        if cfg.explicit {
            me.must("AUTH TLS", &[234, 334])?;
            // 把控制连接升级成 TLS：句柄复制一份给 TLS 那半（同一张 socket），
            // 然后把明文那句柄扔掉 —— 两条 handle 指向同一个 socket，读写都作数
            let plain = match &me.ctrl {
                Chan::Plain(s) => s.try_clone().map_err(|e| io_err("复制控制连接句柄", e))?,
                other => {
                    let _ = other;
                    return Err("内部错误：AUTH TLS 后控制连接不是明文".into());
                }
            };
            let cfg2 = me.cfg.clone();
            me.ctrl = Chan::Tls(Box::new(tls_wrap(&cfg2, plain, host)?));
            me.must("PBSZ 0", &[200])?;
            if data_tls {
                me.must("PROT P", &[200])?;
            }
        }
        // 登录
        let (c, _) = me.cmd(&format!("USER {}", user))?;
        if c == 331 {
            me.must(&format!("PASS {}", pass), &[230, 202])?;
        } else if c != 230 {
            return Err("服务器不接受这个用户名".into());
        }
        me.must("TYPE I", &[200])?;
        // 有没有 MLSD（能给出带时间戳的结构化列表）
        if let Ok(t) = me.must("FEAT", &[211]) {
            me.mlsd = t.to_uppercase().contains("MLSD");
        }
        Ok(me)
    }

    /// 开数据连接：EPSV 优先（IPv6/防火墙友好），不行再 PASV。
    fn data_socket(&mut self) -> Result<Chan, String> {
        let sock = match self.must("EPSV", &[229]) {
            Ok(t) => {
                // 229 Entering Extended Passive Mode (|||6446|)
                // 注意：分隔符后面尾巴上还有个 '|)'，只取数字那一段
                let p = t
                    .split("|||")
                    .nth(1)
                    .map(|s| s.trim().chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
                    .and_then(|s| s.parse::<u16>().ok())
                    .ok_or_else(|| format!("看不懂 EPSV 应答：{}", t.trim()))?;
                TcpStream::connect_timeout(&SocketAddr::new(self.peer, p), Duration::from_secs(8))
                    .map_err(|e| format!("数据连接失败（{}:{p}）: {e}", self.peer))?
            }
            Err(_) => {
                let t = self.must("PASV", &[227])?;
                let inside = t
                    .split('(')
                    .nth(1)
                    .and_then(|s| s.split(')').next())
                    .ok_or_else(|| format!("看不懂 PASV 应答：{}", t.trim()))?;
                let nums: Vec<u16> = inside.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if nums.len() < 6 {
                    return Err(format!("看不懂 PASV 应答：{}", t.trim()));
                }
                let port = nums[4] * 256 + nums[5];
                TcpStream::connect_timeout(&SocketAddr::new(self.peer, port), Duration::from_secs(8))
                    .map_err(|e| format!("数据连接失败（{}:{port}）: {e}", self.peer))?
            }
        };
        sock.set_read_timeout(Some(IO_TIMEOUT)).ok();
        sock.set_write_timeout(Some(IO_TIMEOUT)).ok();
        if self.data_tls {
            let host = self.host.clone();
            let cfg = self.cfg.clone();
            Ok(Chan::Tls(Box::new(tls_wrap(&cfg, sock, &host)?)))
        } else {
            Ok(Chan::Plain(sock))
        }
    }

    fn list(&mut self, path: &str) -> Result<Vec<Entry>, String> {
        let path = if path.trim().is_empty() { "/" } else { path };
        let data = self.data_socket()?;
        let use_mlsd = self.mlsd;
        let cmd = if use_mlsd { format!("MLSD {}", path) } else { format!("LIST {}", path) };
        let (c, t) = self.cmd(&cmd)?;
        if c != 150 && c != 125 {
            // 有些服务器对不存在的目录先给 550，再给一个空列表；直接报错更清楚
            return Err(format!("{cmd} → {}", t.trim()));
        }
        let mut raw = Vec::new();
        let mut d = data;
        d.read_to_end(&mut raw).map_err(|e| io_err("读目录列表", e))?;
        drop(d);
        let (c2, t2) = self.read_reply()?;
        if c2 != 226 && c2 != 250 {
            return Err(format!("列目录没成功：{}", t2.trim()));
        }
        let text = String::from_utf8_lossy(&raw).to_string();
        Ok(if use_mlsd { parse_mlsd(&text) } else { parse_list(&text) })
    }

    fn retr(&mut self, path: &str, sink: &mut dyn Write, mut on_progress: impl FnMut(u64)) -> Result<u64, String> {
        let mut data = self.data_socket()?;
        let (c, t) = self.cmd(&format!("RETR {}", path))?;
        if c != 150 && c != 125 {
            return Err(format!("取文件失败：{}", t.trim()));
        }
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        let mut last = 0u64;
        loop {
            let n = data.read(&mut buf).map_err(|e| io_err("读数据", e))?;
            if n == 0 {
                break;
            }
            sink.write_all(&buf[..n]).map_err(|e| io_err("写本地文件", e))?;
            total += n as u64;
            if total - last >= 512 * 1024 {
                last = total;
                on_progress(total);
            }
        }
        drop(data);
        let (c2, t2) = self.read_reply()?;
        if c2 != 226 && c2 != 250 {
            return Err(format!("传输没正常结束：{}", t2.trim()));
        }
        on_progress(total);
        Ok(total)
    }

    fn stor(&mut self, path: &str, src: &[u8], mut on_progress: impl FnMut(u64)) -> Result<u64, String> {
        let mut data = self.data_socket()?;
        let (c, t) = self.cmd(&format!("STOR {}", path))?;
        if c != 150 && c != 125 {
            return Err(format!("发文件失败：{}", t.trim()));
        }
        let mut sent = 0usize;
        while sent < src.len() {
            let n = data.write(&src[sent..]).map_err(|e| io_err("写数据", e))?;
            if n == 0 {
                return Err("数据连接被对端关掉了".into());
            }
            sent += n;
            if sent % (512 * 1024) < n {
                on_progress(sent as u64);
            }
        }
        data.flush().ok();
        drop(data);                        // 关数据连接 = 告诉服务器"发完了"
        let (c2, t2) = self.read_reply()?;
        if c2 != 226 && c2 != 250 {
            return Err(format!("传输没正常结束：{}", t2.trim()));
        }
        on_progress(sent as u64);
        Ok(sent as u64)
    }
}

#[derive(Clone, Copy)]
struct TlsCfg {
    explicit: bool,
    implicit: bool,
    insecure: bool,
}

/// MLSD：`type=file;size=1234;modify=20240101120000; name`
fn parse_mlsd(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        let (facts, name) = match line.split_once(' ') {
            Some((f, n)) => (f, n.trim()),
            None => continue,
        };
        if name == "." || name == ".." {
            continue;
        }
        let mut size = 0u64;
        let mut is_dir = false;
        let mut mtime = String::new();
        let mut self_ref = false;
        for kv in facts.split(';') {
            if let Some((k, v)) = kv.split_once('=') {
                match k.to_ascii_lowercase().as_str() {
                    // cdir / pdir 是"当前目录 / 上级目录"自己，列表里不该出现
                    "type" => {
                        is_dir = v.eq_ignore_ascii_case("dir");
                        self_ref = v.eq_ignore_ascii_case("cdir") || v.eq_ignore_ascii_case("pdir");
                    }
                    "size" => size = v.parse().unwrap_or(0),
                    "modify" => mtime = fmt_ftp_time(v),
                    _ => {}
                }
            }
        }
        if self_ref {
            continue;
        }
        out.push(Entry { name: name.to_string(), size, is_dir, mtime });
    }
    sort_entries(&mut out);
    out
}

/// 跳过前 n 个空白分隔的字段，返回剩下那截（名字里有空格也不怕）
fn rest_after_fields(line: &str, n: usize) -> &str {
    let mut it = line.char_indices().peekable();
    let mut seen = 0;
    while let Some((i, c)) = it.next() {
        if c.is_whitespace() {
            // 字段结束：连着的空白一起吃掉
            while let Some(&(_, c2)) = it.peek() {
                if c2.is_whitespace() {
                    it.next();
                } else {
                    break;
                }
            }
            seen += 1;
            if seen >= n {
                return line[i..].trim_start();
            }
        }
    }
    line.trim_start()
}

/// `01-02-24` / `2024-01-02` 这种开头 = DOS/Windows 风格列表
fn is_dos_date(tok: &str) -> bool {
    let groups: Vec<&str> = tok.split('-').collect();
    groups.len() == 3 && groups.iter().all(|g| !g.is_empty() && g.chars().all(|c| c.is_ascii_digit()))
}

/// LIST：要么是 unix 风格（`-rw-r--r-- 1 u g 1234 Jan 01 12:00 name`），
/// 要么是 DOS 风格（`01-01-24  12:00PM  <DIR>  name` / `...  2048  name`）。两种都认。
fn parse_list(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        let up = line.to_uppercase();
        let parts: Vec<&str> = line.split_whitespace().collect();
        // DOS / Windows 风格
        if parts.len() >= 3 && is_dos_date(parts[0]) {
            let is_dir = up.contains("<DIR>");
            let size = if is_dir { 0 } else { parts[2].replace(',', "").parse().unwrap_or(0) };
            let name = if is_dir {
                match up.find("<DIR>") {
                    Some(i) => line[i + 5..].trim().to_string(),
                    None => String::new(),
                }
            } else {
                parts[3..].join(" ")
            };
            if !name.is_empty() && name != "." && name != ".." {
                out.push(Entry { name, size, is_dir, mtime: dos_date(line) });
            }
            continue;
        }
        // unix 风格：权限行 + 链接数 + owner + group + size + 月 日 时 名
        if parts.len() >= 9 && (parts[0].starts_with('-') || parts[0].starts_with('d') || parts[0].starts_with('l')) {
            let is_dir = parts[0].starts_with('d');
            let size: u64 = parts[4].parse().unwrap_or(0);
            let name = rest_after_fields(line, 8).to_string();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            let mtime = format!("{} {} {}", parts[5], parts[6], parts[7]);
            out.push(Entry { name, size, is_dir, mtime });
            continue;
        }
        // 兜底：只当名字（有些精简服务器只回文件名）
        let name = line.trim().to_string();
        if !name.is_empty() && name != "." && name != ".." {
            out.push(Entry { name, size: 0, is_dir: false, mtime: String::new() });
        }
    }
    sort_entries(&mut out);
    out
}

fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}

fn dos_date(line: &str) -> String {
    line.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

/// 20240101120000 → 2024-01-01 12:00:00（解析不了就原样返回）
fn fmt_ftp_time(v: &str) -> String {
    let d: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
    if d.len() >= 14 {
        format!("{}-{}-{} {}:{}:{}", &d[0..4], &d[4..6], &d[6..8], &d[8..10], &d[10..12], &d[12..14])
    } else {
        v.to_string()
    }
}

/* ───────────────────────── TFTP（RFC 1350 + options） ───────────────────────── */

const TFTP_RRQ: u16 = 1;
const TFTP_WRQ: u16 = 2;
const TFTP_DATA: u16 = 3;
const TFTP_ACK: u16 = 4;
const TFTP_ERROR: u16 = 5;
const TFTP_OACK: u16 = 6;

fn tftp_err_text(code: u16, msg: &str) -> String {
    let name = match code {
        1 => "文件不存在",
        2 => "权限不允许",
        3 => "磁盘满了",
        4 => "非法操作",
        5 => "未知 TID（端口不对）",
        6 => "文件已存在",
        7 => "没有这个用户",
        _ => "TFTP 错误",
    };
    format!("{name}（{code}）{msg}")
}

fn tftp_opt_blksize() -> u16 {
    1468 // 以太网 MTU 1500 减去 IP/UDP/TFTP 头，避免分片
}

/// RRQ：取文件。返回字节数。
pub fn tftp_recv(host: &str, port: u16, remote: &str, sink: &mut dyn Write) -> Result<u64, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("建 UDP 失败: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let server: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("解析地址失败: {e}"))?
        .next()
        .ok_or_else(|| "解析不到地址".to_string())?;
    let mut req = Vec::new();
    req.extend_from_slice(&TFTP_RRQ.to_be_bytes());
    req.extend_from_slice(remote.as_bytes());
    req.push(0);
    req.extend_from_slice(b"octet\0");
    let bs = tftp_opt_blksize().to_string();
    req.extend_from_slice(b"blksize\0");
    req.extend_from_slice(bs.as_bytes());
    req.push(0);
    sock.send_to(&req, server).map_err(|e| format!("发 RRQ 失败: {e}"))?;

    let mut peer = server;
    let mut expect: u16 = 1;
    let mut blk: usize = 512;
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 2048 + 4];
    let mut retry = 0;
    loop {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                if from.ip() != server.ip() {
                    continue; // 不是我们等的那个服务器
                }
                if n < 4 {
                    continue;
                }
                let op = u16::from_be_bytes([buf[0], buf[1]]);
                peer = from;
                match op {
                    TFTP_ERROR => {
                        let code = u16::from_be_bytes([buf[2], buf[3]]);
                        let msg = String::from_utf8_lossy(&buf[4..n.saturating_sub(1)]).to_string();
                        return Err(tftp_err_text(code, &msg));
                    }
                    TFTP_OACK => {
                        // 服务器答应了选项：回 ACK 0，然后开始收数据
                        if let Some(b) = parse_bs(&buf[2..n]) {
                            blk = b;
                        }
                        send_ack(&sock, peer, 0)?;
                        retry = 0;
                    }
                    TFTP_DATA => {
                        let b = u16::from_be_bytes([buf[2], buf[3]]);
                        // 重复块（ACK 丢了）：重发 ACK 就行
                        if b == expect.wrapping_sub(1) {
                            send_ack(&sock, peer, b)?;
                            continue;
                        }
                        if b != expect {
                            return Err(format!("块号乱序：等到 {expect}，收到 {b}"));
                        }
                        let payload = &buf[4..n];
                        sink.write_all(payload).map_err(|e| format!("写本地文件失败: {e}"))?;
                        total += payload.len() as u64;
                        send_ack(&sock, peer, b)?;
                        retry = 0;
                        if payload.len() < blk {
                            return Ok(total); // 短块 = 结束
                        }
                        expect = expect.wrapping_add(1);
                    }
                    _ => {}
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                retry += 1;
                if retry > 6 {
                    return Err(format!("收数据超时（{total} B 后没动静了）"));
                }
                // ACK 丢了就重发上一个 ACK / 重发 RRQ
                if expect > 1 {
                    send_ack(&sock, peer, expect - 1)?;
                } else {
                    sock.send_to(&req, server).map_err(|e2| format!("重发 RRQ 失败: {e2}"))?;
                }
            }
            Err(e) => return Err(format!("收数据失败: {e}")),
        }
    }
}

fn parse_bs(opts: &[u8]) -> Option<usize> {
    let s = String::from_utf8_lossy(opts);
    let mut it = s.split('\0');
    while let Some(k) = it.next() {
        let v = it.next().unwrap_or("");
        if k.eq_ignore_ascii_case("blksize") {
            return v.trim().parse::<usize>().ok().filter(|b| *b >= 8 && *b <= 65464);
        }
    }
    None
}

fn send_ack(sock: &UdpSocket, peer: SocketAddr, block: u16) -> Result<(), String> {
    let mut p = Vec::with_capacity(4);
    p.extend_from_slice(&TFTP_ACK.to_be_bytes());
    p.extend_from_slice(&block.to_be_bytes());
    sock.send_to(&p, peer).map_err(|e| format!("发 ACK 失败: {e}"))?;
    Ok(())
}

/// WRQ：送文件。
pub fn tftp_send(host: &str, port: u16, remote: &str, data: &[u8]) -> Result<u64, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("建 UDP 失败: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let server: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("解析地址失败: {e}"))?
        .next()
        .ok_or_else(|| "解析不到地址".to_string())?;
    let mut req = Vec::new();
    req.extend_from_slice(&TFTP_WRQ.to_be_bytes());
    req.extend_from_slice(remote.as_bytes());
    req.push(0);
    req.extend_from_slice(b"octet\0");
    let bs = tftp_opt_blksize().to_string();
    req.extend_from_slice(b"blksize\0");
    req.extend_from_slice(bs.as_bytes());
    req.push(0);
    sock.send_to(&req, server).map_err(|e| format!("发 WRQ 失败: {e}"))?;

    let mut blk = 512usize;
    let mut buf = vec![0u8; 2048];
    let mut peer = server;
    let mut retry = 0;
    // 等第一个 ACK（0）或者 OACK
    loop {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                peer = from;
                if n < 4 {
                    continue;
                }
                let op = u16::from_be_bytes([buf[0], buf[1]]);
                match op {
                    TFTP_ERROR => {
                        let code = u16::from_be_bytes([buf[2], buf[3]]);
                        let msg = String::from_utf8_lossy(&buf[4..n.saturating_sub(1)]).to_string();
                        return Err(tftp_err_text(code, &msg));
                    }
                    TFTP_OACK => {
                        if let Some(b) = parse_bs(&buf[2..n]) {
                            blk = b;
                        }
                        send_ack(&sock, peer, 0)?;
                        break;
                    }
                    TFTP_ACK => {
                        let b = u16::from_be_bytes([buf[2], buf[3]]);
                        if b == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                retry += 1;
                if retry > 6 {
                    return Err("服务器没应答（WRQ 超时）".into());
                }
                sock.send_to(&req, peer).map_err(|e2| format!("重发 WRQ 失败: {e2}"))?;
            }
            Err(e) => return Err(format!("收 ACK 失败: {e}")),
        }
    }

    // 一块一块发
    let chunks: Vec<&[u8]> = if data.is_empty() {
        vec![&data[..0]]
    } else {
        data.chunks(blk).collect()
    };
    let mut last = 0u16;
    for (i, c) in chunks.iter().enumerate() {
        let block = (i as u16).wrapping_add(1);
        let mut pkt = Vec::with_capacity(4 + c.len());
        pkt.extend_from_slice(&TFTP_DATA.to_be_bytes());
        pkt.extend_from_slice(&block.to_be_bytes());
        pkt.extend_from_slice(c);
        let mut acked = false;
        let mut tries = 0;
        while !acked {
            sock.send_to(&pkt, peer).map_err(|e| format!("发数据失败: {e}"))?;
            match sock.recv_from(&mut buf) {
                Ok((n, _)) => {
                    if n < 4 {
                        continue;
                    }
                    let op = u16::from_be_bytes([buf[0], buf[1]]);
                    if op == TFTP_ERROR {
                        let code = u16::from_be_bytes([buf[2], buf[3]]);
                        let msg = String::from_utf8_lossy(&buf[4..n.saturating_sub(1)]).to_string();
                        return Err(tftp_err_text(code, &msg));
                    }
                    if op == TFTP_ACK {
                        let b = u16::from_be_bytes([buf[2], buf[3]]);
                        if b == block {
                            acked = true;
                            last = block;
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    tries += 1;
                    if tries > 6 {
                        return Err(format!("第 {block} 块没等到 ACK"));
                    }
                }
                Err(e) => return Err(format!("收 ACK 失败: {e}")),
            }
        }
    }
    let _ = last;
    Ok(data.len() as u64)
}

/* ───────────────────────── 会话表 + 命令 ───────────────────────── */

static NETFS_SEQ: AtomicU32 = AtomicU32::new(1);
static NETFS: LazyLock<Mutex<HashMap<u32, Ftp>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn progress(app: &AppHandle, id: u32, path: &str, done: u64) {
    let _ = app.emit("netfs://progress", json!({ "id": id, "path": path, "bytes": done }));
}

/// 打开一个网络文件会话。proto: ftp / ftps（显式）/ ftps_implicit / tftp
#[tauri::command]
pub fn netfs_open(
    proto: String,
    host: String,
    port: Option<u16>,
    user: Option<String>,
    password: Option<String>,
    insecure: Option<bool>,
) -> Result<Value, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("要填服务器地址".into());
    }
    let p = proto.to_lowercase();
    if p == "tftp" {
        // TFTP 没有连接概念：这里只是把参数记住（顺便探一下地址能不能解析）
        let port = port.unwrap_or(69);
        (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("解析地址失败（{host}:{port}）: {e}"))?
            .next()
            .ok_or_else(|| format!("解析不到地址：{host}:{port}"))?;
        let id = NETFS_SEQ.fetch_add(1, Ordering::Relaxed);
        return Ok(json!({ "id": id, "label": format!("TFTP {host}:{port}"), "note": "TFTP 没有目录列表：直接填路径取/送文件" }));
    }
    let (explicit, implicit, default_port) = match p.as_str() {
        "ftp" => (false, false, 21),
        "ftps" => (true, false, 21),
        "ftps_implicit" => (false, true, 990),
        other => return Err(format!("不认识的协议：{other}（可用 ftp / ftps / ftps_implicit / tftp）")),
    };
    let port = port.unwrap_or(default_port);
    let user = user.unwrap_or_default();
    let user = if user.is_empty() { "anonymous".to_string() } else { user };
    let pass = password.unwrap_or_default();
    let insecure = insecure.unwrap_or(false);
    // FTP（不加密）时 data_tls 没意义；FTPS 两个模式都加密数据
    let tls = TlsCfg { explicit, implicit, insecure };
    let data_tls = explicit || implicit;
    let me = Ftp::open(tls, &host, port, &user, &pass, data_tls)?;
    let label = me.label.clone();
    let id = NETFS_SEQ.fetch_add(1, Ordering::Relaxed);
    let mlsd = me.mlsd;
    NETFS.lock().expect("netfs mutex").insert(id, me);
    Ok(json!({
        "id": id, "label": label,
        "note": if mlsd { "MLSD（带时间戳的结构化列表）" } else { "LIST（老式列表）" },
    }))
}

#[tauri::command]
pub fn netfs_close(id: u32) {
    let mut g = NETFS.lock().expect("netfs mutex");
    if let Some(mut s) = g.remove(&id) {
        let _ = s.send("QUIT"); // 好聚好散：有些服务器不 QUIT 会留半截连接
    }
}

#[tauri::command]
pub fn netfs_sessions() -> Vec<Value> {
    NETFS
        .lock()
        .expect("netfs mutex")
        .iter()
        .map(|(id, s)| json!({ "id": id, "label": s.label }))
        .collect()
}

#[tauri::command]
pub async fn netfs_list(id: u32, path: String) -> Result<Vec<Value>, String> {
    let mut g = NETFS.lock().expect("netfs mutex");
    let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在（可能已断开）"))?;
    Ok(s.list(&path)?.iter().map(|e| e.json()).collect())
}

#[tauri::command]
pub fn netfs_stat(id: u32, path: String) -> Result<Value, String> {
    let mut g = NETFS.lock().expect("netfs mutex");
    let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?;
    // SIZE 不一定支持（很多嵌入式 FTP 没有），拿不到就算了
    match s.cmd(&format!("SIZE {}", path)) {
        Ok((213, t)) => Ok(json!({ "size": t.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) })),
        _ => Ok(json!({ "size": null })),
    }
}

/// 取一个文件到本机。TFTP 走 tftp_recv（不需要会话）。
#[allow(clippy::too_many_arguments)]
pub fn session_get(
    id: u32,
    path: &str,
    save_to: &str,
    tftp: Option<(&str, u16)>,
    mut on_progress: impl FnMut(u64),
) -> Result<u64, String> {
    let tmp = format!("{save_to}.part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("建文件 {} 失败: {e}", tmp))?;
    let bytes = if let Some((h, p)) = tftp {
        let n = tftp_recv(h, p, path.trim_start_matches('/'), &mut f)?;
        on_progress(n);
        n
    } else {
        let mut g = NETFS.lock().expect("netfs mutex");
        let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?;
        s.retr(path, &mut f, &mut on_progress)?
    };
    drop(f);
    std::fs::rename(&tmp, save_to).map_err(|e| format!("改名到 {save_to} 失败: {e}"))?;
    Ok(bytes)
}

/// 把数据发到服务器（FTP STOR / TFTP WRQ）——命令层和测试都走这里
pub fn session_put(
    id: u32,
    path: &str,
    data: &[u8],
    tftp: Option<(&str, u16)>,
    mut on_progress: impl FnMut(u64),
) -> Result<u64, String> {
    let n = if let Some((h, p)) = tftp {
        tftp_send(h, p, path.trim_start_matches('/'), data)?
    } else {
        let mut g = NETFS.lock().expect("netfs mutex");
        let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?;
        s.stor(path, data, &mut on_progress)?
    };
    on_progress(n);
    Ok(n)
}

#[tauri::command]
pub async fn netfs_get(
    app: AppHandle,
    id: u32,
    path: String,
    save_to: String,
    tftp_host: Option<String>,
    tftp_port: Option<u16>,
) -> Result<Value, String> {
    let tftp = tftp_host.as_deref().map(|h| (h, tftp_port.unwrap_or(69)));
    let bytes = session_get(id, &path, &save_to, tftp, |done| progress(&app, id, &path, done))?;
    // crc32 回显：跟串口/服务通道那两条路一样，方便用户对拍
    let data = std::fs::read(&save_to).map_err(|e| e.to_string())?;
    Ok(json!({ "bytes": bytes, "path": save_to, "crc32": crc32fast::hash(&data) }))
}

/// 把一个文件发到服务器（FTP STOR / TFTP WRQ）
#[tauri::command]
pub async fn netfs_put(
    app: AppHandle,
    id: u32,
    path: String,
    data: Vec<u8>,
    tftp_host: Option<String>,
    tftp_port: Option<u16>,
) -> Result<Value, String> {
    let tftp = tftp_host.as_deref().map(|h| (h, tftp_port.unwrap_or(69)));
    let n = session_put(id, &path, &data, tftp, |done| progress(&app, id, &path, done))?;
    Ok(json!({ "bytes": n, "crc32": crc32fast::hash(&data) }))
}

#[tauri::command]
pub fn netfs_mkdir(id: u32, path: String) -> Result<(), String> {
    let mut g = NETFS.lock().expect("netfs mutex");
    g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?.must(&format!("MKD {path}"), &[257, 250])?;
    Ok(())
}

#[tauri::command]
pub fn netfs_delete(id: u32, path: String, is_dir: bool) -> Result<(), String> {
    let mut g = NETFS.lock().expect("netfs mutex");
    let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?;
    if is_dir {
        s.must(&format!("RMD {path}"), &[250])?;
    } else {
        s.must(&format!("DELE {path}"), &[250])?;
    }
    Ok(())
}

#[tauri::command]
pub fn netfs_rename(id: u32, from: String, to: String) -> Result<(), String> {
    let mut g = NETFS.lock().expect("netfs mutex");
    let s = g.get_mut(&id).ok_or_else(|| format!("会话 {id} 不存在"))?;
    s.must(&format!("RNFR {from}"), &[350])?;
    s.must(&format!("RNTO {to}"), &[250])?;
    Ok(())
}

/* ───────────────────────── 内置 TFTP 服务端 ───────────────────────── */

struct TftpSrv {
    stop: Arc<AtomicBool>,
    root: String,
    port: u16,
    allow_write: bool,
}

static TFTP_SRV: LazyLock<Mutex<Option<TftpSrv>>> = LazyLock::new(|| Mutex::new(None));

fn srv_log(app: &AppHandle, text: &str) {
    let _ = app.emit("tftp://log", json!({ "text": text, "ts": kdock_core::session::now_ms() }));
}

/// 把客户端给的路径收拾成"根目录里的一个相对路径"，顺手挡住 `..` 穿越
fn safe_join(root: &str, remote: &str) -> Result<std::path::PathBuf, String> {
    let rel = remote.trim().trim_start_matches(['/', '\\']).replace('\\', "/");
    let mut out = std::path::PathBuf::from(root);
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("路径里不能有 ..（只允许根目录下面）".into());
        }
        out.push(part);
    }
    Ok(out)
}

#[tauri::command]
pub fn tftp_server_start(app: AppHandle, root: String, port: Option<u16>, allow_write: Option<bool>) -> Result<Value, String> {
    tftp_server_stop();
    let port = port.unwrap_or(69);
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("要选一个 TFTP 根目录".into());
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("建根目录失败: {e}"))?;
    let allow_write = allow_write.unwrap_or(false);
    let sock = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| {
        format!("监听 UDP {port} 失败: {e}（69 端口要管理员权限；换个 1024 以上的端口，或者用管理员启动 KDock）")
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    *TFTP_SRV.lock().expect("tftp mutex") = Some(TftpSrv { stop: stop.clone(), root: root.clone(), port, allow_write });
    let app2 = app.clone();
    let root_for_emit = root.clone();
    let root_for_loop = root.clone();
    std::thread::spawn(move || {
        let _ = app2.emit("tftp://state", json!({ "running": true, "port": port, "root": root_for_emit, "allowWrite": allow_write }));
        sock.set_read_timeout(Some(Duration::from_millis(300))).ok();
        let mut buf = vec![0u8; 2048];
        while !stop.load(Ordering::Relaxed) {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if n < 4 {
                        continue;
                    }
                    let pkt = buf[..n].to_vec();
                    let st = stop.clone();
                    let root2 = root_for_loop.clone();
                    let app3 = app2.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = srv_handle(&app3, &pkt, from, &root2, allow_write, st) {
                            srv_log(&app3, &format!("{from} → 失败：{e}"));
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
        let _ = app2.emit("tftp://state", json!({ "running": false }));
    });
    Ok(json!({ "running": true, "port": port, "root": root }))
}

fn srv_handle(
    app: &AppHandle,
    pkt: &[u8],
    from: SocketAddr,
    root: &str,
    allow_write: bool,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let op = u16::from_be_bytes([pkt[0], pkt[1]]);
    if op != TFTP_RRQ && op != TFTP_WRQ {
        return Ok(());
    }
    // 文件名（到第一个 0 结束）
    let rest = &pkt[2..];
    let name_end = rest.iter().position(|b| *b == 0).ok_or("包不完整（没有文件名）")?;
    let remote = String::from_utf8_lossy(&rest[..name_end]).to_string();
    let opts = &rest[name_end + 1..];
    let mut blk: usize = 512;
    let size_only = opts.windows(5).any(|w| w.eq_ignore_ascii_case(b"tsize"));
    if let Some(b) = parse_bs(opts) {
        blk = b;
    }
    let path = safe_join(root, &remote)?;
    // 每个请求用一个自己的端口（标准要求的 TID），客户端会把后续数据发到这个端口
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("建 UDP 失败: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();
    srv_log(app, &format!("{from} → {} {}", if op == TFTP_RRQ { "取" } else { "送" }, remote));

    if op == TFTP_RRQ {
        let data = std::fs::read(&path).map_err(|e| {
            let _ = send_err(&sock, from, 1, &format!("{remote}: {e}"));
            format!("读 {} 失败: {e}", path.display())
        })?;
        // 选项应答（含 tsize：有些客户端要它才知道文件多大）
        let oack = build_oack(blk, if size_only { Some(data.len() as u64) } else { None });
        let mut ack = [0u8; 4];
        if let Some(o) = oack {
            sock.send_to(&o, from).map_err(|e| format!("发 OACK 失败: {e}"))?;
            let (n, _) = sock.recv_from(&mut ack).map_err(|e| format!("等 ACK 失败: {e}"))?;
            if n < 4 || u16::from_be_bytes([ack[0], ack[1]]) != TFTP_ACK {
                return Err("没收到 ACK 0".into());
            }
        }
        let chunks: Vec<&[u8]> = if data.is_empty() { vec![&data[..0]] } else { data.chunks(blk).collect() };
        for (i, c) in chunks.iter().enumerate() {
            let block = (i as u16).wrapping_add(1);
            // 最后一块（短块）发出去就算了：客户端收完就直接写盘退出，
            // 它那个 ACK 经常在"进程已经没了"的竞态里丢掉 —— 揪着要 ACK 只会白重发，还会误报失败。
            let last = i + 1 == chunks.len();
            let mut p = Vec::with_capacity(4 + c.len());
            p.extend_from_slice(&TFTP_DATA.to_be_bytes());
            p.extend_from_slice(&block.to_be_bytes());
            p.extend_from_slice(c);
            let mut ok = false;
            let mut tries = 0;
            let max_tries = if last { 1 } else { 5 };
            while !ok {
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                sock.send_to(&p, from).map_err(|e| format!("发数据失败: {e}"))?;
                match sock.recv_from(&mut ack) {
                    Ok((n, _)) if n >= 4 => {
                        if u16::from_be_bytes([ack[0], ack[1]]) == TFTP_ACK && u16::from_be_bytes([ack[2], ack[3]]) == block {
                            ok = true;
                        }
                    }
                    Ok(_) => {}
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                        tries += 1;
                        if tries >= max_tries {
                            if last {
                                break;      // 最后一块：没等到就没等到
                            }
                            return Err(format!("第 {block} 块没等到 ACK"));
                        }
                    }
                    Err(e) => return Err(format!("等 ACK 失败: {e}")),
                }
            }
        }
        srv_log(app, &format!("{remote} 已送出（{} B）", data.len()));
        return Ok(());
    }

    // WRQ：收文件
    if !allow_write {
        let _ = send_err(&sock, from, 2, "服务端没开「写入」开关");
        return Err("写请求被拒（没开写入开关）".into());
    }
    let mut out: Vec<u8> = Vec::new();
    let mut oack_sent = false;
    if let Some(o) = build_oack(blk, None) {
        sock.send_to(&o, from).map_err(|e| format!("发 OACK 失败: {e}"))?;
        oack_sent = true;
    }
    let mut expect: u16 = 1;
    let mut buf = vec![0u8; 65536];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        match sock.recv_from(&mut buf) {
            Ok((n, peer)) if n >= 4 => {
                let op2 = u16::from_be_bytes([buf[0], buf[1]]);
                if op2 != TFTP_DATA {
                    continue;
                }
                let b = u16::from_be_bytes([buf[2], buf[3]]);
                if !oack_sent && b == 0 {
                    continue; // 客户端对我们的 OACK 回的第 0 块不算数据
                }
                if b != expect {
                    // 重复块：重发上一个 ACK
                    let a = expect.wrapping_sub(1);
                    let mut p = Vec::new();
                    p.extend_from_slice(&TFTP_ACK.to_be_bytes());
                    p.extend_from_slice(&a.to_be_bytes());
                    let _ = sock.send_to(&p, peer);
                    continue;
                }
                let payload = &buf[4..n];
                out.extend_from_slice(payload);
                oack_sent = false;
                let mut p = Vec::new();
                p.extend_from_slice(&TFTP_ACK.to_be_bytes());
                p.extend_from_slice(&b.to_be_bytes());
                sock.send_to(&p, peer).map_err(|e| format!("发 ACK 失败: {e}"))?;
                if payload.len() < blk {
                    break;
                }
                expect = expect.wrapping_add(1);
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                break;
            }
            Err(e) => return Err(format!("收数据失败: {e}")),
        }
    }
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).ok();
    }
    std::fs::write(&path, &out).map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
    srv_log(app, &format!("{remote} 已收到（{} B）→ {}", out.len(), path.display()));
    Ok(())
}

fn build_oack(blk: usize, tsize: Option<u64>) -> Option<Vec<u8>> {
    let mut o = Vec::new();
    o.extend_from_slice(&TFTP_OACK.to_be_bytes());
    o.extend_from_slice(b"blksize\0");
    o.extend_from_slice(blk.to_string().as_bytes());
    o.push(0);
    if let Some(t) = tsize {
        o.extend_from_slice(b"tsize\0");
        o.extend_from_slice(t.to_string().as_bytes());
        o.push(0);
    }
    Some(o)
}

fn send_err(sock: &UdpSocket, to: SocketAddr, code: u16, msg: &str) -> Result<(), String> {
    let mut p = Vec::new();
    p.extend_from_slice(&TFTP_ERROR.to_be_bytes());
    p.extend_from_slice(&code.to_be_bytes());
    p.extend_from_slice(msg.as_bytes());
    p.push(0);
    sock.send_to(&p, to).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tftp_server_stop() {
    if let Some(s) = TFTP_SRV.lock().expect("tftp mutex").take() {
        s.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn tftp_server_state() -> Value {
    let g = TFTP_SRV.lock().expect("tftp mutex");
    match g.as_ref() {
        Some(s) => json!({ "running": true, "port": s.port, "root": s.root, "allowWrite": s.allow_write }),
        None => json!({ "running": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    /// 一个"够用"的 FTP 服务器（只实现测试要用的那几条命令）：
    /// 用来跟我们的客户端对拍 —— 控制连接、EPSV 数据连接、MLSD/RETR/STOR 全走真实 socket。
    struct FakeFtp {
        port: u16,
        files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    }

    fn fake_ftp() -> FakeFtp {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ftp");
        let port = listener.local_addr().expect("addr").port();
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
        files.lock().unwrap().insert("/fw/app.bin".into(), vec![7u8; 4096]);
        let files2 = files.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(s) = stream else { continue };
                let files3 = files2.clone();
                std::thread::spawn(move || {
                    let _ = fake_ftp_conn(s, files3);
                });
            }
        });
        FakeFtp { port, files }
    }

    fn fake_ftp_conn(mut s: TcpStream, files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> std::io::Result<()> {
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        s.write_all(b"220 kdock-test ready\r\n")?;
        let mut r = std::io::BufReader::new(s.try_clone()?);
        let mut data_listener: Option<std::net::TcpListener> = None;
        loop {
            let mut line = String::new();
            if r.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let cmd = line.trim_end().to_string();
            let up = cmd.to_uppercase();
            if up.starts_with("USER") {
                s.write_all(b"331 need password\r\n")?;
            } else if up.starts_with("PASS") {
                s.write_all(b"230 logged in\r\n")?;
            } else if up == "FEAT" {
                s.write_all(b"211-Features:\r\n MLST type*;size*;modify*;\r\n MLSD\r\n211 End\r\n")?;
            } else if up.starts_with("TYPE") {
                s.write_all(b"200 binary\r\n")?;
            } else if up == "EPSV" {
                let l = std::net::TcpListener::bind("127.0.0.1:0")?;
                let p = l.local_addr()?.port();
                data_listener = Some(l);
                s.write_all(format!("229 Entering Extended Passive Mode (|||{p}|)\r\n").as_bytes())?;
            } else if up.starts_with("MLSD") {
                s.write_all(b"150 here comes the listing\r\n")?;
                let l = data_listener.take().expect("要先 EPSV");
                let (mut d, _) = l.accept()?;
                let mut body = String::new();
                for (name, data) in files.lock().unwrap().iter() {
                    body.push_str(&format!("type=file;size={};modify=20240102030405; {}\r\n", data.len(), name.rsplit('/').next().unwrap()));
                }
                body.push_str("type=dir;modify=20240102030405; cfg\r\n");
                d.write_all(body.as_bytes())?;
                drop(d);
                s.write_all(b"226 done\r\n")?;
            } else if up.starts_with("RETR") {
                let want = cmd[5..].trim().to_string();
                let key = if want.starts_with('/') { want.clone() } else { format!("/{want}") };
                let data = files.lock().unwrap().get(&key).cloned();
                match data {
                    Some(d) => {
                        s.write_all(b"150 opening\r\n")?;
                        let l = data_listener.take().expect("要先 EPSV");
                        let (mut dc, _) = l.accept()?;
                        dc.write_all(&d)?;
                        drop(dc);
                        s.write_all(b"226 done\r\n")?;
                    }
                    None => s.write_all(b"550 no such file\r\n")?,
                }
            } else if up.starts_with("STOR") {
                let want = cmd[5..].trim().to_string();
                let key = if want.starts_with('/') { want.clone() } else { format!("/{want}") };
                s.write_all(b"150 go ahead\r\n")?;
                let l = data_listener.take().expect("要先 EPSV");
                let (mut dc, _) = l.accept()?;
                let mut buf = Vec::new();
                dc.read_to_end(&mut buf)?;
                drop(dc);
                files.lock().unwrap().insert(key, buf);
                s.write_all(b"226 done\r\n")?;
            } else if up.starts_with("SIZE") {
                let want = cmd[5..].trim().to_string();
                let n = files.lock().unwrap().get(&want).map(|v| v.len()).unwrap_or(0);
                s.write_all(format!("213 {n}\r\n").as_bytes())?;
            } else if up.starts_with("MKD") {
                s.write_all(b"257 \"/x\" created\r\n")?;
            } else if up == "QUIT" {
                s.write_all(b"221 bye\r\n")?;
                return Ok(());
            } else {
                s.write_all(b"502 not implemented\r\n")?;
            }
        }
    }

    /// 真的跟一个"服务器"跑一遍：登录 → 列目录 → 取文件 → 发文件
    #[test]
    fn ftp_client_round_trips_against_a_real_socket() {
        let srv = fake_ftp();
        let v = netfs_open("ftp".into(), "127.0.0.1".into(), Some(srv.port), Some("u".into()), Some("p".into()), None)
            .expect("登录");
        let id = v["id"].as_u64().expect("id") as u32;
        assert!(v["note"].as_str().unwrap().contains("MLSD"), "服务器说支持 MLSD，客户端就该用 MLSD");

        // 列目录
        let list = ftp_list_blocking(id, "/");
        let names: Vec<String> = list.iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"app.bin".to_string()), "列出来的：{names:?}");
        let app = list.iter().find(|x| x["name"] == "app.bin").unwrap();
        assert_eq!(app["size"].as_u64().unwrap(), 4096);
        assert_eq!(app["mtime"].as_str().unwrap(), "2024-01-02 03:04:05");
        assert!(list.iter().any(|x| x["name"] == "cfg" && x["is_dir"] == json!(true)));

        // 取文件（走 RETR + 临时文件改名）
        let tmp = std::env::temp_dir().join(format!("kdock_ftp_get_{}.bin", std::process::id()));
        let tmp_s = tmp.to_string_lossy().to_string();
        let n = session_get(id, "/fw/app.bin", &tmp_s, None, |_| {}).expect("取文件");
        assert_eq!(n, 4096);
        assert_eq!(std::fs::read(&tmp).unwrap(), vec![7u8; 4096]);
        assert!(!std::path::Path::new(&format!("{tmp_s}.part")).exists(), "临时文件要改名掉");

        // 发文件（走 STOR）
        let payload = b"hello ftp".to_vec();
        let sent = session_put(id, "/fw/new.txt", &payload, None, |_| {}).expect("发文件");
        assert_eq!(sent, payload.len() as u64);
        assert_eq!(srv.files.lock().unwrap().get("/fw/new.txt").cloned().unwrap(), payload);

        // SIZE（很多嵌入式设备也提供）
        let st = netfs_stat(id, "/fw/app.bin".into()).expect("SIZE");
        assert_eq!(st["size"].as_u64().unwrap(), 4096);

        netfs_close(id);
        std::fs::remove_file(&tmp).ok();
    }

    /// netfs_list 是 async 命令（给 Tauri 用的），测试里用一个小 futures-free 的桥接
    fn ftp_list_blocking(id: u32, path: &str) -> Vec<Value> {
        let mut g = NETFS.lock().expect("netfs mutex");
        let s = g.get_mut(&id).expect("会话在");
        s.list(path).expect("列目录").iter().map(|e| e.json()).collect()
    }

    /// 一个最小的 TFTP 服务器（RRQ 发数据 / WRQ 收数据），用来对拍客户端
    fn fake_tftp(serve: Vec<u8>) -> (u16, Arc<Mutex<Vec<u8>>>) {
        let sock = UdpSocket::bind("127.0.0.1:0").expect("bind tftp");
        let port = sock.local_addr().unwrap().port();
        let got: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let got2 = got.clone();
        std::thread::spawn(move || {
            sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut buf = vec![0u8; 2048];
            let (n, from) = sock.recv_from(&mut buf).expect("收到请求");
            let op = u16::from_be_bytes([buf[0], buf[1]]);
            // 每个传输用自己的 TID（标准做法）
            let s = UdpSocket::bind("127.0.0.1:0").unwrap();
            s.set_read_timeout(Some(Duration::from_secs(3))).ok();
            if op == TFTP_RRQ {
                // 先 OACK（blksize），再一块块发
                let blk = parse_bs(&buf[2..n]).unwrap_or(512);
                let o = build_oack(blk, None).unwrap();
                s.send_to(&o, from).unwrap();
                let mut ack = [0u8; 4];
                let _ = s.recv_from(&mut ack);
                let chunks: Vec<&[u8]> = if serve.is_empty() { vec![&serve[..0]] } else { serve.chunks(blk).collect() };
                for (i, c) in chunks.iter().enumerate() {
                    let block = (i as u16) + 1;
                    let mut p = Vec::new();
                    p.extend_from_slice(&TFTP_DATA.to_be_bytes());
                    p.extend_from_slice(&block.to_be_bytes());
                    p.extend_from_slice(c);
                    s.send_to(&p, from).unwrap();
                    let _ = s.recv_from(&mut ack);
                }
            } else {
                let blk = parse_bs(&buf[2..n]).unwrap_or(512);
                s.send_to(&build_oack(blk, None).unwrap(), from).unwrap();
                let mut expect = 1u16;
                let mut out: Vec<u8> = Vec::new();
                loop {
                    let (n2, _) = match s.recv_from(&mut buf) {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    if u16::from_be_bytes([buf[0], buf[1]]) != TFTP_DATA {
                        continue;
                    }
                    let b = u16::from_be_bytes([buf[2], buf[3]]);
                    if b == 0 {
                        continue; // 客户端对我们 OACK 的确认
                    }
                    if b != expect {
                        continue;
                    }
                    let payload = &buf[4..n2];
                    out.extend_from_slice(payload);
                    send_ack(&s, from, b).unwrap();
                    if payload.len() < blk {
                        break;
                    }
                    expect = expect.wrapping_add(1);
                }
                *got2.lock().unwrap() = out;
            }
        });
        (port, got)
    }

    #[test]
    fn tftp_client_receives_and_sends_full_blocks() {
        // 大文件（跨好几块）走 RRQ
        let mut data = Vec::new();
        for i in 0..9000u32 {
            data.push((i % 251) as u8);
        }
        let (port, _) = fake_tftp(data.clone());
        let mut out: Vec<u8> = Vec::new();
        let n = tftp_recv("127.0.0.1", port, "firmware.bin", &mut out).expect("RRQ");
        assert_eq!(n as usize, data.len());
        assert_eq!(out, data, "收到的字节要和服务器发的一模一样");

        // WRQ：送出去的数据服务器要一字不差地收到
        let (port2, got) = fake_tftp(Vec::new());
        let payload = vec![0xA5u8; 5000];
        let sent = tftp_send("127.0.0.1", port2, "up.bin", &payload).expect("WRQ");
        assert_eq!(sent as usize, payload.len());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(*got.lock().unwrap(), payload);
    }

    #[test]
    fn mlsd_parses_files_and_dirs() {
        let t = "type=file;size=1234;modify=20240102030405; firmware.bin\r\ntype=dir;modify=20240102030405; logs\r\ntype=cdir; /";
        let v = parse_mlsd(t);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "logs");
        assert!(v[0].is_dir);
        assert_eq!(v[1].name, "firmware.bin");
        assert_eq!(v[1].size, 1234);
        assert_eq!(v[1].mtime, "2024-01-02 03:04:05");
    }

    #[test]
    fn list_parses_unix_and_dos() {
        let unix = "-rw-r--r--   1 root  root      2048 Jan 02 03:04 boot.bin\ndrwxr-xr-x   2 root  root         0 Jan 02 03:04 cfg";
        let v = parse_list(unix);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "cfg");
        assert!(v[0].is_dir);
        assert_eq!(v[1].name, "boot.bin");
        assert_eq!(v[1].size, 2048);
        let dos = "01-02-24  03:04PM       <DIR>          cfg\n01-02-24  03:05PM                 2048 boot.bin";
        let v2 = parse_list(dos);
        assert_eq!(v2.len(), 2);
        assert!(v2[0].is_dir);
        assert_eq!(v2[1].size, 2048);
    }

    #[test]
    fn tftp_path_escape_is_refused() {
        assert!(safe_join("C:\\tftp", "fw/app.bin").is_ok());
        assert!(safe_join("C:\\tftp", "/fw/app.bin").is_ok());
        assert!(safe_join("C:\\tftp", "../windows/system32/x.dll").is_err());
        assert!(safe_join("C:\\tftp", "a/../../x").is_err());
    }

    #[test]
    fn tftp_oack_roundtrip_blksize() {
        let o = build_oack(1468, Some(4096)).unwrap();
        assert_eq!(u16::from_be_bytes([o[0], o[1]]), TFTP_OACK);
        assert_eq!(parse_bs(&o[2..]), Some(1468));
    }
}
