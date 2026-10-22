//! 传输抽象：串口 / TCP / UDP / SSH 都收敛成同一个 [`Conn`]。
//!
//! UI 只依赖这一层，命令层里没有任何 `if 是串口 … else if 是 TCP …` 的分支。
//! HEX 编解码与行尾处理不在这一层——它们只有 `kdock-core` 里那一份。
//!
//! SSH 走系统自带的 OpenSSH 客户端（`ssh.exe`，Win10 1809 起是可选组件），
//! 用管道当"终端"：远端 PTY（`-tt`）的输入输出就是我们的收发通道，
//! 于是传输页、命令表、中控编排、Agent 都能拿它当一条普通连接用。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serialport::SerialPort;

use kdock_core::net::{connect_tcp_from, NetError, TcpServer, UdpEndpoint};
use kdock_core::SerialConfig;

/// 读超时。所有实现都用它，好让 reader 线程周期性检查停止开关。
pub const POLL_TIMEOUT: Duration = Duration::from_millis(50);

/// 读线程的"空闲"判定：这些错误表示**当前没有数据**，不该让读线程退出。
/// 串口、TCP、UDP 三种实现共用这一条判定。
pub fn is_idle_read_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    )
}

/// 连接参数。`mode` 决定后面读哪几个字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Endpoint {
    Serial {
        port: String,
        config: SerialConfig,
    },
    TcpClient {
        host: String,
        port: u16,
        #[serde(default)]
        local_addr: Option<String>,
    },
    TcpServer {
        #[serde(default)]
        host: Option<String>,
        port: u16,
    },
    Udp {
        local_port: u16,
        #[serde(default)]
        local_addr: Option<String>,
        #[serde(default)]
        remote_host: String,
        #[serde(default)]
        remote_port: u16,
    },
    /// SSH：交给系统 ssh.exe 跑一个远端 shell，收发都走它的管道
    Ssh {
        host: String,
        #[serde(default)]
        port: u16,
        #[serde(default)]
        user: String,
        /// 填了就自动应答第一次密码提示（不填就自己在终端里敲）
        #[serde(default)]
        password: String,
        /// 追加的 ssh 参数（例如 -i 私钥、-L 转发）
        #[serde(default)]
        extra: String,
    },
}

impl Endpoint {
    pub fn mode(&self) -> &'static str {
        match self {
            Endpoint::Serial { .. } => "serial",
            Endpoint::TcpClient { .. } => "tcp_client",
            Endpoint::TcpServer { .. } => "tcp_server",
            Endpoint::Udp { .. } => "udp",
            Endpoint::Ssh { .. } => "ssh",
        }
    }

    pub fn label(&self) -> String {
        match self {
            Endpoint::Serial { port, config } => format!("{port} @ {}", config.summary()),
            Endpoint::TcpClient {
                host,
                port,
                local_addr,
            } => match local_addr.as_deref().filter(|s| !s.is_empty()) {
                Some(local) => format!("TCP {host}:{port} @ {local}"),
                None => format!("TCP {host}:{port}"),
            },
            Endpoint::TcpServer { host, port } => {
                let h = host.clone().unwrap_or_else(|| "0.0.0.0".into());
                format!("TCP 监听 {h}:{port}")
            }
            Endpoint::Udp {
                local_port,
                local_addr,
                remote_host,
                remote_port,
            } => {
                let local = local_addr
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("0.0.0.0");
                if remote_host.is_empty() || *remote_port == 0 {
                    format!("UDP 本地 {local}:{local_port}")
                } else {
                    format!("UDP {local}:{local_port} <-> {remote_host}:{remote_port}")
                }
            }
            Endpoint::Ssh { host, port, user, .. } => {
                let p = if *port == 0 { 22 } else { *port };
                if user.is_empty() {
                    format!("SSH {host}:{p}")
                } else {
                    format!("SSH {user}@{host}:{p}")
                }
            }
        }
    }
}

fn net_to_io(e: NetError) -> std::io::Error {
    // 保留 kind：读超时等"空闲"情况必须能被读线程识别，否则 UDP 读线程
    // 会在第一个空闲 poll 周期就退出。
    match e {
        NetError::Io { kind, msg } => std::io::Error::new(kind, msg),
        other => std::io::Error::new(std::io::ErrorKind::Other, other.to_string()),
    }
}

/// 一条已经建立的双向连接。
pub enum Conn {
    Serial(Box<dyn SerialPort>),
    Tcp(TcpStream),
    Udp(UdpEndpoint),
    Ssh(SshConn),
}

/* ───────────────────────── SSH（系统 ssh.exe + 管道） ───────────────────────── */

/// 找系统的 ssh.exe：PATH 优先，其次 Windows 自带的那个目录。
pub fn find_ssh() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for d in path.split(';').filter(|s| !s.trim().is_empty()) {
            let p = std::path::Path::new(d).join("ssh.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for c in [
        "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
        "C:\\Program Files\\OpenSSH\\ssh.exe",
    ] {
        let p = std::path::Path::new(c);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    None
}

/// 找 PuTTY 的 plink.exe：**密码登录只能靠它** ——
/// Windows 自带的 ssh.exe 在"要密码"时只从控制台读，管道里预先写好的密码它看不见
/// （实测：`echo pw | ssh ...` 会一直卡在密码提示上）。plink 支持 `-pw`，一次给足。
pub fn find_plink() -> Option<PathBuf> {
    crate::env_setup::find_tool(
        "plink.exe",
        "%ENVDIR%\\plink;%ENVDIR%\\putty;%ProgramFiles%\\PuTTY;%ProgramFiles(x86)%\\PuTTY;%ENVDIR%",
    )
}

/// plink 的"主机指纹"缓存（首次连接探测到之后存这儿；文件由 lib.rs 启动时告知）
static HOSTKEY_FILE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

pub fn set_hostkey_cache(p: PathBuf) {
    if let Ok(mut g) = HOSTKEY_FILE.lock() {
        *g = Some(p);
    }
}

fn hostkey_get(host: &str, port: u16) -> Option<String> {
    let p = HOSTKEY_FILE.lock().ok().and_then(|g| g.clone())?;
    let t = std::fs::read_to_string(p).ok()?;
    let key = format!("{host}:{port} ");
    t.lines().find_map(|l| l.trim().strip_prefix(&key).map(|s| s.trim().to_string()))
}

fn hostkey_put(host: &str, port: u16, fp: &str) {
    let p = match HOSTKEY_FILE.lock().ok().and_then(|g| g.clone()) {
        Some(p) => p,
        None => return,
    };
    let mut lines: Vec<String> = std::fs::read_to_string(&p)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with(&format!("{host}:{port} ")))
        .map(|s| s.to_string())
        .collect();
    lines.push(format!("{host}:{port} {fp}"));
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).ok();
    }
    let _ = std::fs::write(&p, lines.join("\n") + "\n");
}

/// plink 遇到"没缓存过的主机"时，会在 -batch 模式下把指纹打印出来然后放弃 ——
/// 我们把它抠出来（等于 TOFU：首次信任 + 之后钉死），下次连接就用 -hostkey 对上。
fn parse_plink_fingerprint(text: &str) -> Option<String> {
    if let Some(i) = text.find("SHA256:") {
        let rest = &text[i..];
        let fp: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
        if fp.len() > 12 {
            return Some(fp);
        }
    }
    // 老版本 plink 打的是 MD5 那种 xx:xx:xx:… 的指纹
    for line in text.lines() {
        let t = line.trim();
        if t.len() >= 47 && t.matches(':').count() >= 15 && t.split_whitespace().count() <= 3 {
            return Some(t.split_whitespace().last().unwrap_or(t).to_string());
        }
    }
    None
}

fn plink_args(host: &str, port: u16, user: &str, password: &str, extra: &str, hostkey: Option<&str>, cmd: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-ssh".into(), "-P".into(), port.to_string()];
    if !user.is_empty() {
        a.push("-l".into());
        a.push(user.to_string());
    }
    a.push("-pw".into());
    a.push(password.to_string());
    a.push("-batch".into());
    if let Some(k) = hostkey {
        a.push("-hostkey".into());
        a.push(k.to_string());
    }
    for x in extra.split_whitespace() {
        a.push(x.to_string());
    }
    a.push(host.to_string());
    if let Some(c) = cmd {
        a.push(c.to_string());
    }
    a
}

fn plink_run(exe: &PathBuf, args: &[String], timeout: Duration) -> Option<(i32, String)> {
    use std::process::{Command, Stdio};
    let mut c = Command::new(exe);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut c).ok()?;
    let t0 = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let out = child.wait_with_output().ok()?;
                let mut s = String::from_utf8_lossy(&out.stdout).to_string();
                s.push_str(&String::from_utf8_lossy(&out.stderr));
                return Some((st.code().unwrap_or(-1), s));
            }
            Ok(None) => {
                if t0.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Some((-1, "（探测主机指纹超时）".into()));
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            Err(_) => return None,
        }
    }
}

/// 首次连接先探一次主机指纹（拿不到就返回 None，让上层照原样跑）
fn plink_ensure_hostkey(exe: &PathBuf, host: &str, port: u16, user: &str, password: &str, extra: &str) -> Option<String> {
    if let Some(k) = hostkey_get(host, port) {
        return Some(k);
    }
    let args = plink_args(host, port, user, password, extra, None, Some("echo kdock-probe"));
    let (_, text) = plink_run(exe, &args, Duration::from_secs(12))?;
    let fp = parse_plink_fingerprint(&text)?;
    hostkey_put(host, port, &fp);
    Some(fp)
}

/// 一次性在远程跑一条命令（不进交互 shell）—— 给 agent 的 `ssh_run` 用。
/// 有密码走 plink（`-pw`），没密码走 ssh.exe（BatchMode + accept-new + 可选 -i 私钥）。
pub fn ssh_run_once(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    key: &str,
    cmd: &str,
    timeout_ms: u64,
) -> Result<(i32, String), String> {
    use std::process::{Command, Stdio};
    let host = host.trim();
    if host.is_empty() {
        return Err("要填主机".into());
    }
    let port = if port == 0 { 22 } else { port };
    let mut extra = String::new();
    if !key.trim().is_empty() {
        extra = format!("-i {}", key.trim());
    }
    let mut c;
    if !password.is_empty() {
        let exe = find_plink().ok_or_else(|| {
            "密码登录要用 PuTTY 的 plink（Windows 自带的 ssh.exe 只在控制台里读密码，管道喂不进去）。到「环境配置 → PuTTY plink」一键安装。".to_string()
        })?;
        let fp = plink_ensure_hostkey(&exe, host, port, user, password, &extra);
        c = Command::new(&exe);
        c.args(plink_args(host, port, user, password, &extra, fp.as_deref(), Some(cmd)));
    } else {
        let exe = find_ssh().ok_or_else(|| {
            "没找到 ssh.exe。到「环境配置 → OpenSSH 客户端」一键安装。".to_string()
        })?;
        c = Command::new(&exe);
        c.args(["-p", &port.to_string()]);
        c.args(["-o", "BatchMode=yes"]);
        c.args(["-o", "StrictHostKeyChecking=accept-new"]);
        c.args(["-o", "ConnectTimeout=10"]);
        if !key.trim().is_empty() {
            c.args(["-i", key.trim()]);
        }
        let target = if user.trim().is_empty() { host.to_string() } else { format!("{}@{host}", user.trim()) };
        c.arg(target);
        c.arg(cmd);
    }
    c.env("TERM", "dumb");
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut c)
        .map_err(|e| format!("起 ssh 进程失败: {e}"))?;
    let t0 = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let mut s = String::from_utf8_lossy(&out.stdout).to_string();
                let err = String::from_utf8_lossy(&out.stderr);
                if !err.trim().is_empty() {
                    if !s.is_empty() && !s.ends_with('\n') {
                        s.push('\n');
                    }
                    s.push_str("[stderr] ");
                    s.push_str(err.trim());
                }
                return Ok((st.code().unwrap_or(-1), s));
            }
            None => {
                if t0.elapsed().as_millis() as u64 > timeout_ms {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("远端命令超时（{timeout_ms} ms）：{cmd}"));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
        }
    }
}

struct SshInner {
    child: std::sync::Mutex<std::process::Child>,
    stdin: std::sync::Mutex<Option<Box<dyn Write + Send>>>,
    /// stdout / stderr 两条泵线都往这里塞，读的一方从这里取 ——
    /// 合成一路的好处：密码提示、指纹确认（走 stderr）和正文（stdout）在同一处按顺序显示
    rx: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u8>>>,
    dead: AtomicBool,
}

/// SSH 连接：一个 ssh.exe 进程 + 它的 stdin/stdout 管道
#[derive(Clone)]
pub struct SshConn(std::sync::Arc<SshInner>);

impl SshConn {
    /// 起一个 ssh 会话。password 非空时自动应答第一次密码提示。
    pub fn spawn(host: &str, port: u16, user: &str, password: &str, extra: &str) -> Result<SshConn, String> {
        use std::process::{Command, Stdio};
        let port = if port == 0 { 22 } else { port };
        let target = if user.is_empty() { host.to_string() } else { format!("{user}@{host}") };
        let use_plink = !password.is_empty() && find_plink().is_some();
        let mut cmd;
        if use_plink {
            let exe = find_plink().expect("plink 在上面判断过存在");
            let fp = plink_ensure_hostkey(&exe, host, port, user, password, extra);
            cmd = Command::new(&exe);
            cmd.args(plink_args(host, port, user, password, extra, fp.as_deref(), None));
        } else {
            if !password.is_empty() {
                // 说清楚为什么不用密码：这不是"我们没实现"，是 Windows OpenSSH 的脾气
                return Err("密码登录需要 PuTTY 的 plink：Windows 自带的 ssh.exe 只在控制台里读密码，管道喂不进去。\
请到「环境配置 → PuTTY plink」点一键安装；用密钥登录的话把密码留空、在「高级 → 附加参数」里填 -i <私钥>。"
                    .to_string());
            }
            let exe = find_ssh().ok_or_else(|| {
                "没找到 ssh.exe。到「环境配置 → OpenSSH 客户端」点一键安装（Windows 可选组件，不用联网）".to_string()
            })?;
            cmd = Command::new(&exe);
            // -tt：即使本地不是终端也分配远端 PTY（远端就会给提示符、不缓冲）
            cmd.arg("-tt");
            cmd.args(["-p", &port.to_string()]);
            cmd.args(["-o", "ServerAliveInterval=30"]);
            cmd.args(["-o", "ServerAliveCountMax=4"]);
            cmd.args(["-o", "StrictHostKeyChecking=accept-new"]);
            for a in extra.split_whitespace() {
                cmd.arg(a);
            }
            cmd.arg(&target);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：ssh 自己不许弹黑框
        }
        let mut child = crate::process_guard::spawn(&mut cmd)
            .map_err(|e| format!("起 ssh.exe 失败: {e}"))?;
        let stdin: Option<Box<dyn Write + Send>> = child.stdin.take().map(|s| Box::new(s) as Box<dyn Write + Send>);
        let stdout: Option<Box<dyn Read + Send>> = child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        let stderr: Option<Box<dyn Read + Send>> = child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        let (stdin, stdout) = match (stdin, stdout) {
            (Some(i), Some(o)) => (i, o),
            _ => return Err("ssh 的管道没建起来".into()),
        };
        let rx: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u8>>> =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        for mut f in [Some(stdout), stderr].into_iter().flatten() {
            let q = rx.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match f.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut g) = q.lock() {
                                g.extend(&buf[..n]);
                                while g.len() > 8 * 1024 * 1024 {
                                    g.pop_front(); // 前端不看了也不能把内存吃光
                                }
                            }
                        }
                    }
                }
            });
        }
        let inner = std::sync::Arc::new(SshInner {
            child: std::sync::Mutex::new(child),
            stdin: std::sync::Mutex::new(Some(stdin)),
            rx,
            dead: AtomicBool::new(false),
        });
        Ok(SshConn(inner))
    }

    /// 结束这个会话（杀 ssh.exe；远端 shell 会跟着退）
    pub fn kill(&self) {
        self.0.dead.store(true, Ordering::Relaxed);
        if let Ok(mut c) = self.0.child.lock() {
            let _ = c.kill();
        }
        if let Ok(mut i) = self.0.stdin.lock() {
            i.take();
        }
    }

    /// 从合并后的接收队列里取数据；队列空就报"空闲超时"（上层按空闲处理，不会当成断开）
    fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.0.dead.load(Ordering::Relaxed) {
            return Ok(0);
        }
        if let Ok(mut q) = self.0.rx.lock() {
            if !q.is_empty() {
                let n = buf.len().min(q.len());
                for (i, slot) in buf.iter_mut().take(n).enumerate() {
                    let _ = i;
                    *slot = q.pop_front().unwrap_or(0);
                }
                return Ok(n);
            }
        }
        std::thread::sleep(Duration::from_millis(8)); // 别空转烧 CPU：约 120Hz 的轮询
        Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "ssh 空闲"))
    }

    fn write(&self, data: &[u8]) -> std::io::Result<usize> {
        let mut g = self.0.stdin.lock().expect("ssh stdin mutex");
        let f = g.as_mut().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "ssh 已关闭"))?;
        f.write_all(data)?;
        f.flush()?;
        Ok(data.len())
    }
}

impl Drop for SshInner {
    fn drop(&mut self) {
        self.dead.store(true, Ordering::Relaxed);
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Conn {
    /// 给 reader 线程用的复制品。UDP 是共享同一个 socket。
    pub fn try_clone(&self) -> Result<Conn, String> {
        match self {
            Conn::Serial(p) => p
                .try_clone()
                .map(Conn::Serial)
                .map_err(|e| format!("克隆串口句柄失败: {e}")),
            Conn::Tcp(s) => s
                .try_clone()
                .map(Conn::Tcp)
                .map_err(|e| format!("克隆 TCP 连接失败: {e}")),
            Conn::Udp(u) => Ok(Conn::Udp(u.clone())),
            Conn::Ssh(s) => Ok(Conn::Ssh(s.clone())),   // 共享同一个 ssh 进程（收发队列在 Arc 里）
        }
    }

    pub fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Serial(p) => p.read(buf),
            Conn::Tcp(s) => s.read(buf),
            Conn::Udp(u) => u.recv_learn(buf).map_err(net_to_io),
            Conn::Ssh(s) => s.read(buf),
        }
    }

    pub fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Serial(p) => p.write(data),
            Conn::Tcp(s) => s.write(data),
            Conn::Udp(u) => u.send(data).map_err(net_to_io),
            Conn::Ssh(s) => s.write(data),
        }
    }

    /// 写满整段：`write` 允许只写进去一部分（串口和 TCP 都会），
    /// 剩下的必须接着写，否则这一段数据就**悄悄丢**了。
    /// 一次 0 字节（真写不进去）直接报错，避免在这儿死循环。
    pub fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut off = 0usize;
        while off < data.len() {
            match self.write(&data[off..])? {
                0 => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "写出去 0 字节",
                    ))
                }
                n => off += n,
            }
        }
        Ok(())
    }

    /// 写出去。串口**一段一段发**：设备那边的 UART 接收没有流控，
    /// 一次性灌几千字节会把它的接收缓冲冲掉(丢字节甚至丢命令)，
    /// 所以按 16 字节 / 2ms 的节奏喂 —— 大约 8KB/s，比 115200 的线速还低一点，
    /// 对长报文不会额外变慢，短报文也几乎无感(像人一个一个敲)。
    pub fn write_paced(&mut self, data: &[u8]) -> std::io::Result<()> {
        const CHUNK: usize = 16;
        const GAP_MS: u64 = 2;
        if !matches!(self, Conn::Serial(_)) {
            self.write_all(data)?;
            return self.flush();
        }
        let mut off = 0;
        while off < data.len() {
            let n = (data.len() - off).min(CHUNK);
            // 每一段都要写满：短写在这里同样会丢字节
            self.write_all(&data[off..off + n])?;
            off += n;
            if off < data.len() {
                std::thread::sleep(std::time::Duration::from_millis(GAP_MS));
            }
        }
        self.flush()
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Serial(p) => p.flush(),
            Conn::Tcp(s) => s.flush(),
            // UDP 每次 send 就是一个报文，没有缓冲
            Conn::Udp(_) => Ok(()),
            // SSH 每条命令自己 write_all + flush
            Conn::Ssh(_) => Ok(()),
        }
    }

    pub fn shutdown(&mut self) {
        match self {
            Conn::Tcp(s) => {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
            // SSH：杀进程（否则读线程会一直挂着，断开按钮就成了摆设）
            Conn::Ssh(s) => s.kill(),
            _ => {}
        }
    }

    /// 是不是流式（TCP/串口）传输——流读到 0 字节意味着对端关了。
    pub fn is_stream(&self) -> bool {
        !matches!(self, Conn::Udp(_))
    }

    /// UDP 端点（非 UDP 返回 `None`）。UI 可以据此显示真实绑定的端口。
    pub fn udp(&self) -> Option<&UdpEndpoint> {
        match self {
            Conn::Udp(u) => Some(u),
            _ => None,
        }
    }
}

/// 打开一个「立刻就有连接」的传输：串口 / TCP Client / UDP。
pub fn open_endpoint(endpoint: &Endpoint) -> Result<Conn, String> {
    match endpoint {
        Endpoint::Serial { port, config } => {
            let params = config
                .to_port_params()
                .map_err(|e| format!("串口参数非法: {e}"))?;
            let p = serialport::new(port, params.baud)
                .data_bits(params.data_bits)
                .stop_bits(params.stop_bits)
                .parity(params.parity)
                .flow_control(params.flow_control)
                .timeout(POLL_TIMEOUT)
                .open()
                .map_err(|e| format!("打开 {port} 失败: {e}"))?;
            Ok(Conn::Serial(p))
        }
        Endpoint::TcpClient {
            host,
            port,
            local_addr,
        } => {
            let local = local_addr.as_deref().unwrap_or("");
            let s = connect_tcp_from(local, host, *port, Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            s.set_read_timeout(Some(POLL_TIMEOUT))
                .map_err(|e| format!("设置读超时失败: {e}"))?;
            Ok(Conn::Tcp(s))
        }
        Endpoint::Udp {
            local_port,
            local_addr,
            remote_host,
            remote_port,
        } => {
            let local = local_addr
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("0.0.0.0");
            let ep = UdpEndpoint::bind_host(local, *local_port).map_err(|e| e.to_string())?;
            if !remote_host.is_empty() && *remote_port != 0 {
                ep.set_remote(remote_host, *remote_port)
                    .map_err(|e| e.to_string())?;
            }
            ep.set_read_timeout(POLL_TIMEOUT)
                .map_err(|e| format!("设置读超时失败: {e}"))?;
            Ok(Conn::Udp(ep))
        }
        Endpoint::TcpServer { .. } => Err("TCP Server 用 bind_server 打开".into()),
        Endpoint::Ssh { host, port, user, password, extra } => Ok(Conn::Ssh(SshConn::spawn(
            host,
            *port,
            user,
            password,
            extra,
        )?)),
    }
}

/// TCP Server：绑定并监听。
pub fn bind_server(endpoint: &Endpoint) -> Result<TcpServer, String> {
    match endpoint {
        Endpoint::TcpServer { host, port } => {
            let h = host.clone().unwrap_or_else(|| "0.0.0.0".into());
            TcpServer::bind(&h, *port).map_err(|e| e.to_string())
        }
        _ => Err("不是 TCP Server 参数".into()),
    }
}

/// 同一监听 socket 上**反复**收客户端：返回下一个连进来的 stream（每 50ms 检查一次停止开关）。
/// 多客户端 TCP Server 用它，而不是"收一个就把监听丢掉"。
pub fn accept_client(server: &TcpServer, stop: &AtomicBool) -> Option<TcpStream> {
    let _ = server.set_nonblocking(true);
    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        match server.try_accept() {
            Ok(Some(stream)) => {
                let _ = stream.set_read_timeout(Some(POLL_TIMEOUT));
                return Some(stream);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    /// AC-3 的可观察证据：UDP 的空闲读超时穿到 transport 层之后，
    /// `ErrorKind` 仍然是 `TimedOut`——读线程正是按它判断"空闲"的。
    #[test]
    fn udp_idle_timeout_keeps_its_kind_across_transport_layer() {
        let ep = UdpEndpoint::bind(0).expect("bind");
        ep.set_read_timeout(Duration::from_millis(40)).unwrap();

        let mut buf = [0u8; 16];
        let err = ep.recv(&mut buf).expect_err("空闲时应当读超时");
        assert!(err.is_timeout(), "kdock-core 这一层就该认出超时: {err}");

        let io_err = net_to_io(err);
        assert_eq!(
            io_err.kind(),
            ErrorKind::TimedOut,
            "kind 不能在 transport 层被压成 Other"
        );
        // 与 lib.rs 读线程里的判定完全一致
        assert!(matches!(
            io_err.kind(),
            ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
        ));
    }

    /// 反过来：真正的错误不能被当成"空闲"悄悄吞掉。
    #[test]
    fn real_errors_are_not_classified_as_idle() {
        let err = serialize_only_error_kind();
        assert!(!matches!(
            err,
            ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
        ));
    }

    fn serialize_only_error_kind() -> ErrorKind {
        let ep = UdpEndpoint::bind(0).unwrap();
        // 没设置远端时发送是错误，但不是"空闲"
        let e = ep.send(b"x").expect_err("没远端时应当失败");
        assert!(!e.is_idle());
        net_to_io(e).kind()
    }

    /// 端到端（应用层）回归：UDP 连接先空闲若干个 poll 周期，
    /// 读线程判定必须一直认为"空闲"，之后仍然能双向收发。
    #[test]
    fn udp_conn_survives_idle_polls_then_round_trips() {
        let mut a = open_endpoint(&Endpoint::Udp {
            local_port: 0,
            local_addr: None,
            remote_host: String::new(),
            remote_port: 0,
        })
        .expect("open a");
        let mut b = open_endpoint(&Endpoint::Udp {
            local_port: 0,
            local_addr: None,
            remote_host: String::new(),
            remote_port: 0,
        })
        .expect("open b");

        let pa = a.udp().unwrap().local_port();
        let pb = b.udp().unwrap().local_port();
        a.udp().unwrap().set_remote("127.0.0.1", pb).unwrap();
        b.udp().unwrap().set_remote("127.0.0.1", pa).unwrap();

        let mut buf = [0u8; 128];
        let mut idle_polls = 0usize;
        let until = std::time::Instant::now() + POLL_TIMEOUT * 3;
        while std::time::Instant::now() < until {
            match a.read(&mut buf) {
                Ok(n) => panic!("空闲期不该有数据（{n} 字节）"),
                Err(e) if is_idle_read_error(&e) => idle_polls += 1,
                Err(e) => panic!("空闲读超时被当成真错误，读线程会退出: {e}"),
            }
        }
        assert!(idle_polls >= 1, "至少经历一次空闲 poll");

        a.write(b"ping from a").unwrap();
        let n = b.read(&mut buf).expect("a -> b 应当收得到");
        assert_eq!(&buf[..n], b"ping from a");

        b.write(b"pong from b").unwrap();
        let n2 = a.read(&mut buf).expect("b -> a 应当收得到");
        assert_eq!(&buf[..n2], b"pong from b");
    }
}
