//! 固件升级：本地/服务器取包 → 串口(app 在线升级) 或 网口(TCP 788 服务通道)
//!
//! 两条路都不需要 J-Link：
//!   * 串口：cshell `upload firmware`(YMODEM) → `upgrade <name> -f -s` → app 自己复位
//!   * 网口：PC --TCP--> 网关板 --SPI--> 主控 的内部服务通道(SVC1/SVR1 + CRC8)
//!
//! 过程信息全部通过 Ctx 回调抛给上层(串口工具里就是"主输出窗口")。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU16, Ordering};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::transport::Conn;

// ---------------------------------------------------------------- 升级包(.fw)
pub const FW_MAGIC: u32 = 0x5746_594B; // "KYFW"
pub const FW_HDR_VER: u16 = 1;
pub const FW_HDR_SIZE: u16 = 64;
// 打包时写进包头 "target" 字段的地址（app 区基址）。当前只在 make_fw 里用，
// 留着是因为它同时是这套 .fw 格式的口径说明，别让它变死代码警告。
#[allow(dead_code)]
pub const APP_TARGET: u32 = 0x0802_0400;

#[derive(Debug, Clone, serde::Serialize)]
pub struct FwInfo {
    /// 三段式版本号 PD_HW.PD_SW.PD_FIX, 例 "1.3.1"
    pub version: String,
    pub payload_size: u32,
    pub payload_crc32: u32,
    pub file_size: u32,
    pub file_crc32: u32,
    pub board: String,
    pub name: String,
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320u32 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn cstr16(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}

/// 解析 .fw 包头(顺带验 CRC)
pub fn parse_fw(data: &[u8], name: &str) -> Result<FwInfo, String> {
    if data.len() < FW_HDR_SIZE as usize {
        return Err("文件太小，不是 .fw 升级包".into());
    }
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    if magic != FW_MAGIC {
        return Err("不是 .fw 升级包（裸 .bin 没有版本号，请先打成 .fw）".into());
    }
    let hdr_ver = u16::from_le_bytes([data[4], data[5]]);
    let hdr_size = u16::from_le_bytes([data[6], data[7]]);
    if hdr_ver != FW_HDR_VER || hdr_size != FW_HDR_SIZE {
        return Err(format!("包头版本/长度不支持: {}/{}", hdr_ver, hdr_size));
    }
    let payload_size = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
    let payload_crc32 = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);
    let hdr_crc32 = u32::from_le_bytes([data[16], data[17], data[18], data[19]]);
    let fw_version = u32::from_le_bytes([data[20], data[21], data[22], data[23]]);
    let mut head = data[..FW_HDR_SIZE as usize].to_vec();
    head[16..20].copy_from_slice(&[0, 0, 0, 0]);
    if crc32(&head) != hdr_crc32 {
        return Err("包头 CRC 不对（文件可能损坏）".into());
    }
    if payload_size as usize + FW_HDR_SIZE as usize != data.len() {
        return Err(format!("长度不符: 包头 {} + 64 != 文件 {}", payload_size, data.len()));
    }
    if crc32(&data[FW_HDR_SIZE as usize..]) != payload_crc32 {
        return Err("payload CRC 不对（文件可能损坏）".into());
    }
    let ver = if (fw_version >> 24) == 0xA5 {
        format!("{}.{}.{}", (fw_version >> 16) & 0xFF, (fw_version >> 8) & 0xFF, fw_version & 0xFF)
    } else {
        format!(
            "{}.{}.{}.{} (旧格式)",
            (fw_version >> 24) & 0xFF,
            (fw_version >> 16) & 0xFF,
            (fw_version >> 8) & 0xFF,
            fw_version & 0xFF
        )
    };
    Ok(FwInfo {
        version: ver,
        payload_size,
        payload_crc32,
        file_size: data.len() as u32,
        file_crc32: crc32(data),
        board: cstr16(&data[32..48]),
        name: name.to_string(),
    })
}

pub fn ver_u32(s: &str) -> u32 {
    let parts: Vec<u32> = s.split('.').map(|p| p.trim().parse::<u32>().unwrap_or(0)).collect();
    let g = |i: usize| *parts.get(i).unwrap_or(&0) & 0xFF;
    (0xA5 << 24) | (g(0) << 16) | (g(1) << 8) | g(2)
}

/// 裸镜像按 .fw 格式打包(和 tools/mkfw.py 一致)
/// 目前上位机只**解包**不打包（.fw 由 MCU 工程侧的 mkfw 工具生成），
/// 这份实现留着做格式对照 / 以后要支持就地打包时直接用。
#[allow(dead_code)]
pub fn make_fw(image: &[u8], version: &str, note: &str) -> Vec<u8> {
    let mut hdr = vec![0u8; FW_HDR_SIZE as usize];
    hdr[0..4].copy_from_slice(&FW_MAGIC.to_le_bytes());
    hdr[4..6].copy_from_slice(&FW_HDR_VER.to_le_bytes());
    hdr[6..8].copy_from_slice(&FW_HDR_SIZE.to_le_bytes());
    hdr[8..12].copy_from_slice(&(image.len() as u32).to_le_bytes());
    hdr[12..16].copy_from_slice(&crc32(image).to_le_bytes());
    hdr[20..24].copy_from_slice(&ver_u32(version).to_le_bytes());
    hdr[24..28].copy_from_slice(&APP_TARGET.to_le_bytes());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0);
    hdr[28..32].copy_from_slice(&ts.to_le_bytes());
    // 板卡名（16 字节 C 字符串）。打包工具通常填自己的目标板名，这里给个中性占位。
    hdr[32..32 + 7].copy_from_slice(b"demo-bd");
    let n = note.as_bytes();
    let n = &n[..n.len().min(15)];
    hdr[48..48 + n.len()].copy_from_slice(n);
    let crc = crc32(&hdr);
    hdr[16..20].copy_from_slice(&crc.to_le_bytes());
    let mut out = hdr;
    out.extend_from_slice(image);
    out
}

// ---------------------------------------------------------------- 回调上下文
pub struct Ctx<'a> {
    pub log: &'a mut dyn FnMut(&str),
    pub progress: &'a mut dyn FnMut(f64),
}

impl Ctx<'_> {
    pub fn say(&mut self, s: impl AsRef<str>) {
        (self.log)(s.as_ref());
    }
    pub fn line(&mut self, s: impl AsRef<str>) {
        (self.log)(&format!("{}\n", s.as_ref()));
    }
    pub fn prog(&mut self, p: f64) {
        (self.progress)(p);
    }
}

// ---------------------------------------------------------------- 服务器
#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerItem {
    pub version: String,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub crc32: Option<u32>,
    pub payload_crc32: Option<u32>,
    pub board: String,
}

fn parse_hex_u32(s: &str) -> Option<u32> {
    let t = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(t, 16).ok()
}

pub fn http_get(url: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| format!("访问 {} 失败: {}", url, e))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败: {}", e))?;
    Ok(buf)
}

/// 支持: ①标准 manifest.json ②面板导出的 firmware-data.json（versions/targets/files 那套）
/// 服务器地址容错：用户只填到目录（`http://host/ota/device/xxx/`）也行 —— 这里自动补
/// `manifest.json`；已经带 `.json` / `.fw` 的地址原样返回。
/// 界面上就不用再教用户"要填到 manifest.json"了。
pub fn normalize_server_url(input: &str) -> String {
    let u = input.trim();
    let low = u.to_ascii_lowercase();
    if low.ends_with(".json") || low.ends_with(".fw") {
        return u.to_string();
    }
    if u.ends_with('/') {
        format!("{}manifest.json", u)
    } else {
        format!("{}/manifest.json", u)
    }
}

/// 从 URL 里取文件名（`.../demo-v1.3.1.fw` -> `demo-v1.3.1.fw`）
pub fn url_basename(u: &str) -> String {
    let cut = u.split('?').next().unwrap_or(u);
    cut.trim_end_matches('/').rsplit('/').next().unwrap_or("fw.fw").to_string()
}

pub fn fetch_server_items(input: &str) -> Result<Vec<ServerItem>, String> {
    let url = normalize_server_url(input);
    if url.is_empty() {
        return Err("请填服务器地址".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("服务器地址要以 http:// 或 https:// 开头".into());
    }
    let body = http_get(&url)?;
    let v: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("{} 不是合法 JSON: {}", url, e))?;
    let base = url::Url::parse(&url).map_err(|e| format!("地址解析失败: {}", e))?;
    let mut out: Vec<ServerItem> = Vec::new();

    fn push_item(out: &mut Vec<ServerItem>, obj: &serde_json::Value, base: &url::Url) {
        let s = |k: &str| obj.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = {
            let n = s("name");
            if n.is_empty() { s("file") } else { n }
        };
        let rel = {
            let u = s("url");
            if u.is_empty() { name.clone() } else { u }
        };
        let full = base.join(&rel).map(|u| u.to_string()).unwrap_or(rel);
        let num = |k: &str| obj.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let crc = |k: &str| match obj.get(k) {
            Some(serde_json::Value::String(x)) => parse_hex_u32(x),
            Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x as u32),
            _ => None,
        };
        out.push(ServerItem {
            version: s("version").trim_start_matches('v').to_string(),
            name: if name.is_empty() { "firmware.fw".to_string() } else { name },
            url: full,
            size: num("size"),
            crc32: crc("crc32"),
            payload_crc32: crc("payload_crc32"),
            board: s("board"),
        });
    }

    if let Some(arr) = v.get("firmwares").and_then(|x| x.as_array()) {
        for it in arr {
            push_item(&mut out, it, &base);
        }
    } else if let Some(arr) = v.get("versions").and_then(|x| x.as_array()) {
        for ver in arr {
            let version = ver
                .get("version")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim_start_matches('v')
                .to_string();
            let folder = ver.get("folder").and_then(|x| x.as_str()).unwrap_or("");
            let mut files = Vec::new();
            if let Some(tg) = ver.get("targets").and_then(|x| x.as_array()) {
                for t in tg {
                    if let Some(fs) = t.get("files").and_then(|x| x.as_array()) {
                        files.extend(fs.iter().cloned());
                    }
                }
            }
            for f in files {
                let name = f.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if name.is_empty() {
                    continue;
                }
                let url = if folder.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", folder.trim_end_matches('/'), name)
                };
                let mut o = f.clone();
                if o.get("version").is_none() {
                    o["version"] = serde_json::Value::String(version.clone());
                }
                if o.get("url").is_none() {
                    o["url"] = serde_json::Value::String(url);
                }
                push_item(&mut out, &o, &base);
            }
        }
    } else if v.get("name").is_some() {
        push_item(&mut out, &v, &base);
    }

    // 清单里所有 .fw 都收下：板卡名只在明细里显示、由用户自己挑。
    // （早先这里按某个固定板名过滤，换个项目就得改代码 —— 开源版不该有这种耦合。）
    out.retain(|it| it.name.to_lowercase().ends_with(".fw"));
    if out.is_empty() {
        return Err("服务器上没有 .fw 文件（或清单格式不认识）".into());
    }
    out.sort_by(|a, b| ver_u32(&b.version).cmp(&ver_u32(&a.version)));
    Ok(out)
}

/// 版本号是不是三段式(PD_HW.PD_SW.PD_FIX)。四段的是老包, 设备新规则会拒。
pub fn ver_is_3seg(v: &str) -> bool {
    let s = v.trim().trim_start_matches('v');
    let n = s.split('.').count();
    n == 3 && s.split('.').all(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty())
}

pub fn download_fw(ctx: &mut Ctx, item: &ServerItem) -> Result<Vec<u8>, String> {
    ctx.line(format!("下载 {}", item.url));
    let data = http_get(&item.url)?;
    let info = parse_fw(&data, &item.name)?;
    // 服务器上还是老四段包的话, 这里就说清楚, 别等设备拒了才知道
    if !ver_is_3seg(&info.version) {
        return Err(format!(
            "服务器上的 {} 是老的四段格式包(v{})，设备现在的规则会拒收；\
             请把新的三段式包(如 demo-v1.3.1.fw)传到服务器再升级",
            item.name, info.version
        ));
    }
    if item.size > 0 && item.size as usize != data.len() {
        return Err(format!("下载长度不对: 清单 {} vs 实收 {}", item.size, data.len()));
    }
    if let Some(c) = item.crc32 {
        if c != info.file_crc32 {
            return Err(format!("文件 CRC32 不对: 清单 {:08X} vs 实际 {:08X}", c, info.file_crc32));
        }
    }
    if let Some(c) = item.payload_crc32 {
        if c != info.payload_crc32 {
            return Err(format!("payload CRC32 不对: 清单 {:08X} vs 实际 {:08X}", c, info.payload_crc32));
        }
    }
    ctx.line(format!(
        "校验通过: v{}  payload {} B  crc32={:08X}",
        info.version, info.payload_size, info.payload_crc32
    ));
    Ok(data)
}

// ---------------------------------------------------------------- 网口(服务通道)
const SVC_REQ_MAGIC: [u8; 4] = *b"SVC1";
const SVC_RSP_MAGIC: [u8; 4] = *b"SVR1";
const SVC_PING: u8 = 0x01;
const SVC_LIST: u8 = 0x02;
const SVC_OPEN: u8 = 0x04;
const SVC_WRITE: u8 = 0x05;
const SVC_READ: u8 = 0x06;
const SVC_CLOSE: u8 = 0x07;
const SVC_CRC: u8 = 0x08;
const SVC_DELETE: u8 = 0x09;
const SVC_OTA_VERIFY: u8 = 0x0C;
const SVC_OTA_APPLY: u8 = 0x0D;
const SVC_REBOOT: u8 = 0x0E;
const SVC_CHUNK: usize = 512;
/// 每块之间的间隔(ms): 稳定优先, 慢一点没关系
const SVC_CHUNK_GAP_MS: u64 = 6;

const CRC8_TABLE: [u8; 256] = [
    0x00, 0x07, 0x0E, 0x09, 0x1C, 0x1B, 0x12, 0x15,
    0x38, 0x3F, 0x36, 0x31, 0x24, 0x23, 0x2A, 0x2D,
    0x70, 0x77, 0x7E, 0x79, 0x6C, 0x6B, 0x62, 0x65,
    0x48, 0x4F, 0x46, 0x41, 0x54, 0x53, 0x5A, 0x5D,
    0xE0, 0xE7, 0xEE, 0xE9, 0xFC, 0xFB, 0xF2, 0xF5,
    0xD8, 0xDF, 0xD6, 0xD1, 0xC4, 0xC3, 0xCA, 0xCD,
    0x90, 0x97, 0x9E, 0x99, 0x8C, 0x8B, 0x82, 0x85,
    0xA8, 0xAF, 0xA6, 0xA1, 0xB4, 0xB3, 0xBA, 0xBD,
    0xC7, 0xC0, 0xC9, 0xCE, 0xDB, 0xDC, 0xD5, 0xD2,
    0xFF, 0xF8, 0xF1, 0xF6, 0xE3, 0xE4, 0xED, 0xEA,
    0xB7, 0xB0, 0xB9, 0xBE, 0xAB, 0xAC, 0xA5, 0xA2,
    0x8F, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9D, 0x9A,
    0x27, 0x20, 0x29, 0x2E, 0x3B, 0x3C, 0x35, 0x32,
    0x1F, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0D, 0x0A,
    0x57, 0x50, 0x59, 0x5E, 0x4B, 0x4C, 0x45, 0x42,
    0x6F, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7D, 0x7A,
    0x89, 0x8E, 0x87, 0x80, 0x95, 0x92, 0x9B, 0x9C,
    0xB1, 0xB6, 0xBF, 0xB8, 0xAD, 0xAA, 0xA3, 0xA4,
    0xF9, 0xFE, 0xF7, 0xF0, 0xE5, 0xE2, 0xEB, 0xEC,
    0xC1, 0xC6, 0xCF, 0xC8, 0xDD, 0xDA, 0xD3, 0xD4,
    0x69, 0x6E, 0x67, 0x60, 0x75, 0x72, 0x7B, 0x7C,
    0x51, 0x56, 0x5F, 0x58, 0x4D, 0x4A, 0x43, 0x44,
    0x19, 0x1E, 0x17, 0x10, 0x05, 0x02, 0x0B, 0x0C,
    0x21, 0x26, 0x2F, 0x28, 0x3D, 0x3A, 0x33, 0x34,
    0x4E, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5C, 0x5B,
    0x76, 0x71, 0x78, 0x7F, 0x6A, 0x6D, 0x64, 0x63,
    0x3E, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2C, 0x2B,
    0x06, 0x01, 0x08, 0x0F, 0x1A, 0x1D, 0x14, 0x13,
    0xAE, 0xA9, 0xA0, 0xA7, 0xB2, 0xB5, 0xBC, 0xBB,
    0x96, 0x91, 0x98, 0x9F, 0x8A, 0x8D, 0x84, 0x83,
    0xDE, 0xD9, 0xD0, 0xD7, 0xC2, 0xC5, 0xCC, 0xCB,
    0xE6, 0xE1, 0xE8, 0xEF, 0xFA, 0xFD, 0xF4, 0xF3,
];

/// 每一条请求都用**全局唯一**的 seq：
///   - 设备端按 seq 去重，同一条重发不会重复执行(重试仍然沿用同一个 seq)
///   - F4 那座桥偶尔会把**上一条**响应漏下来，靠 seq 就能识别并丢掉，
///     否则会出现"命令 A 拿到命令 B 的结果"这种整体错位一格的问题
static SVC_SEQ: AtomicU16 = AtomicU16::new(0x2000);

fn next_seq() -> u16 {
    let v = SVC_SEQ.fetch_add(1, Ordering::Relaxed);
    if v == 0 {
        1
    } else {
        v
    }
}

fn crc8(data: &[u8]) -> u8 {
    let mut c = 0u8;
    for &b in data {
        c = CRC8_TABLE[(c ^ b) as usize];
    }
    c
}

fn svc_status_text(s: u16) -> String {
    match s as i16 {
        0 => "OK".into(),
        1 => "参数不对".into(),
        2 => "设备端句柄用完 / 文件不存在".into(),
        -3 => "不是 .fw 升级包".into(),
        -5 => "包头 CRC 错".into(),
        -7 => "payload CRC 不匹配".into(),
        -8 => "板卡型号不匹配".into(),
        -15 => "硬件版本不同，不允许升级".into(),
        -16 => "版本低于允许的最低版本".into(),
        -17 => "升级包版本格式太旧".into(),
        0x7FFF => "网口桥超时(SPI 没回)".into(),
        o => format!("设备返回错误 {}", o),
    }
}

pub struct Svc {
    io: Conn,
    seq: u16,
}

impl Svc {
    /// 复用已有连接。工具平时用 50ms 读超时给 reader 轮询, 升级期间必须放宽,
    /// 否则设备端稍慢一点就误判断线。
    pub fn from_conn(io: Conn) -> Svc {
        if let Conn::Tcp(s) = &io {
            let _ = s.set_read_timeout(Some(Duration::from_secs(6)));
            let _ = s.set_write_timeout(Some(Duration::from_secs(6)));
        }
        Svc { io, seq: 3 }
    }

    fn connect(host: &str, port: u16) -> Result<Svc, String> {
        let addr = format!("{}:{}", host, port)
            .to_socket_addrs()
            .map_err(|e| format!("地址不对: {}", e))?
            .next()
            .ok_or_else(|| "地址解析失败".to_string())?;
        let mut last = String::new();
        for _ in 0..10 {
            match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
                Ok(s) => {
                    let _ = s.set_read_timeout(Some(Duration::from_secs(6)));
                    let _ = s.set_write_timeout(Some(Duration::from_secs(6)));
                    let _ = s.set_nodelay(true);
                    return Ok(Svc::from_conn(Conn::Tcp(s)));
                }
                Err(e) => {
                    last = e.to_string();
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
        Err(format!("连不上 {}:{} ({})", host, port, last))
    }

    fn set_read_timeout(&mut self, secs: u64) {
        if let Conn::Tcp(s) = &self.io {
            let _ = s.set_read_timeout(Some(Duration::from_secs(secs)));
        }
    }

    fn read_exact_conn(io: &mut Conn, buf: &mut [u8]) -> Result<(), String> {
        let mut off = 0usize;
        while off < buf.len() {
            match io.read(&mut buf[off..]) {
                Ok(0) => return Err("连接被对端关闭".into()),
                Ok(n) => off += n,
                Err(e) => return Err(format!("收响应失败: {}", e)),
            }
        }
        Ok(())
    }

    fn write_conn(io: &mut Conn, data: &[u8]) -> Result<(), String> {
        let mut off = 0usize;
        while off < data.len() {
            match io.write(&data[off..]) {
                Ok(0) => return Err("发送 0 字节".into()),
                Ok(n) => off += n,
                Err(e) => return Err(format!("发送失败: {}", e)),
            }
        }
        let _ = io.flush();
        Ok(())
    }

    fn transact(&mut self, cmd: u8, payload: &[u8]) -> Result<(u16, Vec<u8>), String> {
        let seq = self.seq;
        let mut frame = Vec::with_capacity(7 + payload.len());
        frame.push(0u8);
        frame.push(cmd);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(&seq.to_be_bytes());
        frame.extend_from_slice(payload);
        let c = crc8(&frame);
        frame.push(c);
        let mut out = Vec::with_capacity(6 + frame.len());
        out.extend_from_slice(&SVC_REQ_MAGIC);
        out.extend_from_slice(&(frame.len() as u16).to_be_bytes());
        out.extend_from_slice(&frame);
        Svc::write_conn(&mut self.io, &out)?;
        // 最多容忍几条"不是这次的"响应(桥漏下来的上一条/重复帧)
        for _ in 0..4 {
            let mut hdr = [0u8; 6];
            Svc::read_exact_conn(&mut self.io, &mut hdr)?;
            if hdr[0..4] != SVC_RSP_MAGIC {
                return Err("响应头不对".into());
            }
            let n = u16::from_be_bytes([hdr[4], hdr[5]]) as usize;
            if !(7..=1201).contains(&n) {
                return Err(format!("响应长度不对: {}", n));
            }
            let mut body = vec![0u8; n];
            Svc::read_exact_conn(&mut self.io, &mut body)?;
            let plen = u16::from_be_bytes([body[2], body[3]]) as usize;
            if plen + 7 != n || crc8(&body[0..6 + plen]) != body[6 + plen] {
                return Err("响应 CRC/长度不对".into());
            }
            let rseq = u16::from_be_bytes([body[4], body[5]]);
            if rseq != seq {
                continue; // 不是这条命令的响应，丢掉再读
            }
            let status = u16::from_be_bytes([body[6], body[7]]);
            return Ok((status, body[8..6 + plen].to_vec()));
        }
        Err("响应序列号一直对不上(桥把旧响应漏下来了?)".into())
    }

    /// 用完把底层连接还回去(界面还要继续用它)。
    /// TCP 的读超时要恢复成 reader 轮询用的 50ms，否则 reader 会沿着这里的 6s 超时跑。
    pub fn into_conn(self) -> Conn {
        if let Conn::Tcp(s) = &self.io {
            let _ = s.set_read_timeout(Some(crate::transport::POLL_TIMEOUT));
        }
        self.io
    }

    /// 列目录。设备回的是 "F <size> <name>\n" / "D <size> <name>\n"
    pub fn list_dir(&mut self, path: &str) -> Result<Vec<SvcEntry>, String> {
        if path.len() >= 192 {
            return Err("路径太长(设备端上限 191 字节)".into());
        }
        let (st, data) = self.request(SVC_LIST, path.as_bytes(), 1)?;
        if st != 0 {
            return Err(format!("列目录失败: {}", svc_status_text(st)));
        }
        let text = String::from_utf8_lossy(&data);
        let mut out = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let mut it = line.splitn(3, ' ');
            let ty = it.next().unwrap_or("");
            let size = it.next().unwrap_or("0").trim().parse::<u64>().unwrap_or(0);
            let name = it.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            out.push(SvcEntry { name, is_dir: ty.starts_with('D'), size });
        }
        Ok(out)
    }

    /// 只读打开一个文件, 拿到设备端句柄
    pub fn open_read(&mut self, path: &str) -> Result<u16, String> {
        if path.len() >= 190 {
            return Err("路径太长(设备端上限 191 字节)".into());
        }
        let mut p = Vec::with_capacity(1 + path.len());
        p.push(0u8); // mode 0 = 只读
        p.extend_from_slice(path.as_bytes());
        let (st, d) = self.request(SVC_OPEN, &p, 1)?;
        if st != 0 {
            return Err(format!("打不开 {}: {}", path, svc_status_text(st)));
        }
        if d.len() < 2 {
            return Err("OPEN 返回太短".into());
        }
        Ok(u16::from_be_bytes([d[0], d[1]]))
    }

    /// 从偏移读一段(设备端单次上限 1000 字节)
    pub fn read_at(&mut self, h: u16, off: u32, want: u16) -> Result<Vec<u8>, String> {
        let mut p = Vec::with_capacity(8);
        p.extend_from_slice(&h.to_be_bytes());
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(&want.to_be_bytes());
        let (st, d) = self.request(SVC_READ, &p, 1)?;
        if st != 0 {
            return Err(format!("读文件失败: {}", svc_status_text(st)));
        }
        Ok(d)
    }

    /// 只写打开(mode 1 = WRONLY|CREAT|TRUNC)，用于往设备写文件
    pub fn open_write(&mut self, path: &str) -> Result<u16, String> {
        if path.len() >= 190 {
            return Err("路径太长(设备端上限 191 字节)".into());
        }
        let mut p = Vec::with_capacity(1 + path.len());
        p.push(1u8); // mode 1 = 覆盖写
        p.extend_from_slice(path.as_bytes());
        let (st, d) = self.request(SVC_OPEN, &p, 1)?;
        if st != 0 {
            return Err(format!("设备上建不了 {}: {}", path, svc_status_text(st)));
        }
        if d.len() < 2 {
            return Err("OPEN 返回太短".into());
        }
        Ok(u16::from_be_bytes([d[0], d[1]]))
    }

    /// 往偏移写一段，返回设备实际写进去的字节数
    pub fn write_at(&mut self, h: u16, off: u32, data: &[u8]) -> Result<u32, String> {
        let mut p = Vec::with_capacity(6 + data.len());
        p.extend_from_slice(&h.to_be_bytes());
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(data);
        let (st, d) = self.request(SVC_WRITE, &p, 1)?;
        if st != 0 {
            return Err(format!("写文件失败: {}", svc_status_text(st)));
        }
        if d.len() < 4 {
            return Ok(data.len() as u32);
        }
        Ok(u32::from_be_bytes([d[0], d[1], d[2], d[3]]))
    }

    /// 关句柄
    pub fn close_handle(&mut self, h: u16) -> Result<(), String> {
        let (st, _) = self.request(SVC_CLOSE, &h.to_be_bytes(), 1)?;
        if st != 0 {
            return Err(format!("关文件失败: {}", svc_status_text(st)));
        }
        Ok(())
    }

    /// 同一 seq 重发: 设备按整帧去重, 重发不会重复执行
    fn request(&mut self, cmd: u8, payload: &[u8], retries: u32) -> Result<(u16, Vec<u8>), String> {
        self.seq = next_seq();
        let mut last = String::new();
        for i in 0..=retries {
            match self.transact(cmd, payload) {
                Ok(r) => return Ok(r),
                Err(e) => {
                    last = e;
                    if i < retries {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        }
        Err(format!("命令 0x{:02X} 失败: {}", cmd, last))
    }
}

// ---------------------------------------------------------------- 串口: 目录 / 取文件
// 走 cshell 现成的两条命令:
//   ls <dir>                -> 固定格式的表格
//   get <file> -t base64    -> 把文件按 base64 逐行吐出来, 最后一行 "end"
// 选 base64 而不是 XMODEM: 不需要握手/ACK, 实现简单也不会因为超时把设备卡住,
// 代价是 33% 冗余(115200 下大约 8KB/s)。设备最后还会回 region crc32, 可以核对。

/// 读到"提示符 + 安静下来"为止(或者彻底没动静/超时)
fn serial_read_prompt(conn: &mut Conn, total: Duration) -> String {
    let mut acc: Vec<u8> = Vec::new();
    let start = Instant::now();
    let mut last = Instant::now();
    let mut seen_prompt = false;
    while start.elapsed() < total {
        if crate::agent::stop_requested() {
            break; // 用户按了停止：把已经收到的吐出去就行
        }
        let mut b = [0u8; 1];
        match conn.read(&mut b) {
            Ok(1) => {
                acc.push(b[0]);
                last = Instant::now();
                if acc.len() >= 2 && &acc[acc.len() - 2..] == b"# " {
                    seen_prompt = true;
                }
            }
            Ok(_) => {}
            Err(_) => {
                if seen_prompt && last.elapsed() >= Duration::from_millis(200) {
                    break;
                }
                if !acc.is_empty() && last.elapsed() >= Duration::from_secs(3) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    String::from_utf8_lossy(&acc).to_string()
}

/// 一直读，直到尾部出现任一关键字（或者彻底没动静 / 超时）。
/// 用尾窗匹配，不用每次全文搜索 —— 大文件 base64 有 1MB 量级。
fn serial_read_until(
    conn: &mut Conn,
    needles: &[&str],
    total: Duration,
    idle: Duration,
) -> String {
    let mut acc: Vec<u8> = Vec::new();
    let start = Instant::now();
    let mut last = Instant::now();
    while start.elapsed() < total {
        if crate::agent::stop_requested() {
            break;
        }
        let mut b = [0u8; 1];
        match conn.read(&mut b) {
            Ok(1) => {
                acc.push(b[0]);
                last = Instant::now();
                let from = acc.len().saturating_sub(160);
                let tail = String::from_utf8_lossy(&acc[from..]);
                if needles.iter().any(|n| tail.contains(n)) {
                    break;
                }
            }
            Ok(_) => {}
            Err(_) => {
                if last.elapsed() >= idle {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    String::from_utf8_lossy(&acc).to_string()
}

/// 跑一条 cshell 命令并收回显/输出
pub fn serial_run(conn: &mut Conn, cmd: &str, total: Duration) -> Result<String, String> {
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(80));
    }
    let _ = conn_write(conn, format!("{}\r", cmd).as_bytes());
    std::thread::sleep(Duration::from_millis(20));
    Ok(serial_read_prompt(conn, total))
}

/// 极简 base64 解码(设备端固定用标准字母表, 可能带 '=' 填充)
/// base64 解码（忽略空白/换行）。agent 的密钥文件也用它。
pub fn b64_decode(s: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut n = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = val(c) else { continue };
        acc = (acc << 6) | v;
        n += 1;
        if n == 4 {
            out.push((acc >> 16) as u8);
            out.push((acc >> 8) as u8);
            out.push(acc as u8);
            acc = 0;
            n = 0;
        }
    }
    if n == 3 {
        acc <<= 6;
        out.push((acc >> 16) as u8);
        out.push((acc >> 8) as u8);
    } else if n == 2 {
        acc <<= 12;
        out.push((acc >> 16) as u8);
    }
    out
}

/// 串口: `ls <dir>` -> 目录项
pub fn serial_list(conn: &mut Conn, dir: &str) -> Result<Vec<SvcEntry>, String> {
    let out = serial_run(conn, &format!("ls {}", dir), Duration::from_secs(10))?;
    if out.contains("No such directory") {
        return Err(format!("目录不存在: {}", dir));
    }
    let mut entries = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("----") {
            continue;
        }
        let is_dir = t.starts_with("DIR ");
        let is_file = t.starts_with("FILE ");
        if !is_dir && !is_file {
            continue;
        }
        let mut it = t.split_whitespace();
        it.next(); // DIR/FILE
        let size = it.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
        let name = it.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        entries.push(SvcEntry { name, is_dir, size });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// 串口: `get <file> -t base64` -> 写本地文件
pub fn serial_pull(
    conn: &mut Conn,
    path: &str,
    save_to: &str,
    mut log: impl FnMut(&str),
) -> Result<PullResult, String> {
    log(&format!("[文件] 串口取文件: {}\n", path));
    // 设备传完一定会打 "get: region crc32=..."；中途它主循环忙起来可能几秒不出字节，
    // 所以这里按"关键字 + 8 秒静默"收，而不是"安静 3 秒就收工"(那样大文件会被截断)。
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(80));
    }
    let _ = conn_write(conn, format!("get {} -t base64\r", path).as_bytes());
    let out = serial_read_until(
        conn,
        &[
            "get: region crc32=",
            "get: cannot open",
            "transfer failed",
            "get: aborted",
        ],
        Duration::from_secs(900),
        Duration::from_secs(8),
    );
    if crate::agent::stop_requested() {
        return Err("用户停止了这次取文件（设备侧可能还在传，等一下再操作）".into());
    }
    if out.contains("cannot open") {
        return Err(format!("设备上打不开: {}", path));
    }
    if out.contains("unknown mode") {
        return Err("设备端不支持 base64 模式(固件太旧?)".into());
    }
    let mut expected: Option<u64> = None;
    let mut data: Vec<u8> = Vec::new();
    let mut in_payload = false;
    let mut dev_crc: Option<u32> = None;
    for line in out.lines() {
        let t = line.trim();
        // 设备最后那行 region crc32 是**校验依据**，必须在"数据段"状态之外也能认出来
        if let Some(rest) = t.strip_prefix("get: region crc32=") {
            dev_crc = u32::from_str_radix(rest.split_whitespace().next().unwrap_or(""), 16).ok();
            continue;
        }
        if !in_payload {
            if let Some(rest) = t.strip_prefix("get: ") {
                if let Some(idx) = rest.rfind(" (") {
                    if let Ok(n) = rest[idx + 2..].trim_end_matches(" bytes)").trim().parse::<u64>() {
                        expected = Some(n);
                        in_payload = true;
                        continue;
                    }
                }
            }
            continue;
        }
        if t == "end" {
            in_payload = false;
            continue;
        }
        if t.starts_with("get:") || t.starts_with("root@") {
            continue;
        }
        data.extend_from_slice(&b64_decode(t));
    }
    if let Some(n) = expected {
        if data.len() as u64 != n {
            return Err(format!("收下来的长度不对: 设备说 {} 字节, 实际 {}", n, data.len()));
        }
    }
    if data.is_empty() {
        return Err("没收到内容(设备没回 base64? 用 ASCII 交互看一眼)".into());
    }
    let mut crc = Crc32::new();
    crc.update(&data);
    let got = crc.finish();
    if let Some(dc) = dev_crc {
        if dc != got {
            return Err(format!("CRC 不匹配: 设备 {:08X} vs 本机 {:08X}(串口丢字节了, 重来一次)", dc, got));
        }
        log(&format!("[文件] 设备端 CRC32 核对通过: {:08X}\n", dc));
    }
    std::fs::write(save_to, &data).map_err(|e| format!("写本地文件 {} 失败: {}", save_to, e))?;
    Ok(PullResult { bytes: data.len() as u64, crc32: got })
}

/// 网口: 把本机数据写到设备上(设备端 OPEN 用 TRUNC，写完才 rename 由 put 保证；
/// 我们这条路是直接覆盖，中途断了文件就是残缺的 —— 传完会用 CRC 核对)
pub fn svc_upload(
    svc: &mut Svc,
    path: &str,
    data: &[u8],
    mut log: impl FnMut(&str),
) -> Result<u32, String> {
    let h = svc.open_write(path)?;
    let mut crc = Crc32::new();
    crc.update(data);
    let mut off: u32 = 0;
    let mut last_report = Instant::now();
    while (off as usize) < data.len() {
        if crate::agent::stop_requested() {
            let _ = svc.close_handle(h);
            return Err("用户停止了这次写文件（设备上可能留下半个文件）".into());
        }
        let n = (data.len() - off as usize).min(512);
        let chunk = &data[off as usize..off as usize + n];
        match svc.write_at(h, off, chunk) {
            Ok(w) if (w as usize) == n => {}
            Ok(w) => {
                let _ = svc.close_handle(h);
                return Err(format!("设备只写进去 {} / {} 字节", w, n));
            }
            Err(e) => {
                let _ = svc.close_handle(h);
                return Err(e);
            }
        }
        off += n as u32;
        if last_report.elapsed().as_millis() >= 200 {
            log(&format!("[文件] 已发 {} / {} 字节 ...\n", off, data.len()));
            last_report = Instant::now();
        }
    }
    let _ = svc.close_handle(h);
    Ok(crc.finish())
}

/// 极简 base64 编码(76 字符一行，和 `get/put -t base64` 的行宽一致)
pub fn b64_encode(data: &[u8]) -> String {
    const TAB: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let v = (b0 << 16) | (b1 << 8) | b2;
        out.push(TAB[((v >> 18) & 0x3F) as usize] as char);
        out.push(TAB[((v >> 12) & 0x3F) as usize] as char);
        out.push(if c.len() > 1 { TAB[((v >> 6) & 0x3F) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { TAB[(v & 0x3F) as usize] as char } else { '=' });
    }
    out
}

/// 串口: 等设备吐出某段文字(收到的内容留在 acc 里，失败时能看设备到底说了啥)
fn serial_wait_text_acc(conn: &mut Conn, needle: &str, total: Duration, acc: &mut String) -> bool {
    let start = Instant::now();
    while start.elapsed() < total {
        let mut b = [0u8; 1];
        match conn.read(&mut b) {
            Ok(1) => {
                acc.push(b[0] as char);
                if acc.contains(needle) {
                    return true;
                }
                if acc.len() > 8192 {
                    let cut = acc.len() - 4096;
                    acc.drain(..cut);
                }
            }
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    false
}

/// 串口: 用 cshell 的 `put <path> -t base64 -s <size>` 把本机文件写到设备
pub fn serial_upload(
    conn: &mut Conn,
    path: &str,
    data: &[u8],
    mut log: impl FnMut(&str),
) -> Result<u32, String> {
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(80));
    }
    log(&format!("[文件] 串口发文件: {} ({} B)\n", path, data.len()));
    let _ = conn_write(
        conn,
        format!("put {} -t base64 -s {}\r", path, data.len()).as_bytes(),
    )?;
    let mut seen = String::new();
    if !serial_wait_text_acc(conn, "paste base64", Duration::from_secs(10), &mut seen) {
        log(&format!("[文件] 设备回: {}\n", seen.trim()));
        return Err(format!(
            "设备没进入 base64 接收状态。设备说: {}",
            seen.trim().chars().take(160).collect::<String>()
        ));
    }
    let b64 = b64_encode(data);
    let bytes = b64.as_bytes();
    // 设备那边的 UART 接收**没有流控**，一小段一小段喂；
    // 一次砸几千字节会把它的接收缓冲冲掉，连后面的 "end" 都会丢(现象就是设备一直不回话)。
    // 128B / 12ms ≈ 10.6KB/s，和 115200 的线速基本一致，不会再额外变慢。
    let mut off = 0usize;
    while off < bytes.len() {
        let n = (bytes.len() - off).min(128);
        conn_write(conn, &bytes[off..off + n])?;
        off += n;
        std::thread::sleep(Duration::from_millis(12));
    }
    conn_write(conn, b"\r\nend\r\n")?;
    // 估算：发送时长 ×2 再留 30s(设备写完还要做 lfs rename + CRC)
    let budget_ms = 30_000 + (b64.len() as u64) * 12 / 128 * 2;
    let mut out = String::new();
    serial_wait_text_acc(conn, "put: ok", Duration::from_millis(budget_ms), &mut out);
    out.push_str(&serial_read_prompt(conn, Duration::from_secs(3)));
    log(&format!("[文件] 设备回: {}\n", out.trim().chars().take(300).collect::<String>()));
    if !out.contains("put: ok") {
        let tail: String = out.trim().chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("没等到 put: ok。设备说: {}", tail));
    }
    if out.contains("transfer failed") || out.contains("got ") {
        return Err(format!("设备说没写好: {}", out.lines().find(|l| l.contains("put:")).unwrap_or("")));
    }
    let mut crc = Crc32::new();
    crc.update(data);
    let mine = crc.finish();
    // "put: ok -> /x (N bytes, crc32=XXXXXXXX)"
    if let Some(pos) = out.rfind("crc32=") {
        let hex = &out[pos + 6..];
        let hex: String = hex.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if let Ok(dev) = u32::from_str_radix(&hex, 16) {
            if dev != mine {
                return Err(format!("设备端 CRC {:08X} != 本机 {:08X}", dev, mine));
            }
            log(&format!("[文件] 设备端 CRC32 核对通过: {:08X}\n", dev));
        }
    }
    Ok(mine)
}

/// 设备上的一个目录项(网口 / 串口两条路都归一到这个结构)
#[derive(Debug, Clone, serde::Serialize)]
pub struct SvcEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 一次拉取的结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct PullResult {
    pub bytes: u64,
    pub crc32: u32,
}

/// 增量 CRC32(文件可能几百 KB~几 MB, 不整份读进内存)
pub struct Crc32 {
    state: u32,
}

impl Crc32 {
    pub fn new() -> Crc32 {
        Crc32 { state: 0xFFFF_FFFF }
    }
    pub fn update(&mut self, data: &[u8]) {
        for &b in data {
            self.state ^= b as u32;
            for _ in 0..8 {
                self.state =
                    (self.state >> 1) ^ (0xEDB8_8320u32 & (0u32.wrapping_sub(self.state & 1)));
            }
        }
    }
    pub fn finish(&self) -> u32 {
        !self.state
    }
}

/// 网口: 走服务通道把设备上的文件拉回本机
pub fn svc_pull(
    svc: &mut Svc,
    path: &str,
    save_to: &str,
    mut log: impl FnMut(&str),
) -> Result<PullResult, String> {
    let h = svc.open_read(path)?;
    let mut f = std::fs::File::create(save_to)
        .map_err(|e| format!("建不了本地文件 {}: {}", save_to, e))?;
    let mut crc = Crc32::new();
    let mut off: u32 = 0;
    let mut total: u64 = 0;
    let mut last_report = Instant::now();
    loop {
        if crate::agent::stop_requested() {
            let _ = svc.close_handle(h);
            return Err("用户停止了这次取文件".into());
        }
        let chunk = match svc.read_at(h, off, 1000) {
            Ok(c) => c,
            Err(e) => {
                let _ = svc.close_handle(h);
                return Err(e);
            }
        };
        if chunk.is_empty() {
            break;
        }
        let n = chunk.len();
        crc.update(&chunk);
        f.write_all(&chunk).map_err(|e| format!("写本地文件失败: {}", e))?;
        off += n as u32;
        total += n as u64;
        if last_report.elapsed().as_millis() >= 200 {
            log(&format!("[文件] 已收 {} 字节 ...\n", total));
            last_report = Instant::now();
        }
        if n < 1000 {
            break;
        }
    }
    let _ = svc.close_handle(h);
    f.flush().map_err(|e| format!("落盘失败: {}", e))?;
    Ok(PullResult { bytes: total, crc32: crc.finish() })
}

/// 断线可重连的会话: F4 只有一条服务 socket, 传大文件时偶尔会断,
/// 断了就重连再发同一条命令(写带偏移, 重发安全)。
struct Session {
    host: String,
    port: u16,
    svc: Option<Svc>,
}

impl Session {
    fn new(host: &str, port: u16, svc: Svc) -> Session {
        Session { host: host.to_string(), port, svc: Some(svc) }
    }

    fn req(&mut self, ctx: &mut Ctx, cmd: u8, payload: &[u8], retries: u32) -> Result<(u16, Vec<u8>), String> {
        let r = self.svc.as_mut().expect("svc").request(cmd, payload, retries);
        match r {
            Ok(v) => Ok(v),
            Err(e) => {
                ctx.line(format!("[升级] 传输中断({}), 重连后重发 ...", e));
                self.reconnect(ctx)?;
                self.svc.as_mut().expect("svc").request(cmd, payload, retries)
            }
        }
    }

    /// 不重连的版本(等设备回来时用: 断了说明还没起来, 属正常)
    fn req0(&mut self, _ctx: &mut Ctx, cmd: u8) -> Result<u16, String> {
        match self.svc.as_mut() {
            Some(s) => s.request(cmd, &[], 0).map(|(st, _)| st),
            None => Err("no link".into()),
        }
    }

    fn set_read_timeout(&mut self, secs: u64) {
        if let Some(s) = self.svc.as_mut() {
            s.set_read_timeout(secs);
        }
    }

    fn reconnect(&mut self, ctx: &mut Ctx) -> Result<(), String> {
        ctx.line("重新连接设备 ...");
        self.svc = None;
        std::thread::sleep(Duration::from_millis(800));
        self.svc = Some(Svc::connect(&self.host, self.port)?);
        Ok(())
    }
}

/// 网口升级: 上传到设备 /firmware → 设备侧 CRC → 写升级请求 → 复位 → 等回来
pub fn net_upgrade_conn(
    ctx: &mut Ctx,
    svc: Svc,
    host: &str,
    port: u16,
    name: &str,
    data: &[u8],
) -> Result<(), String> {
    let info = parse_fw(data, name)?;
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let remote = format!("/firmware/{}", if clean.is_empty() { "fw.fw".into() } else { clean });
    ctx.line(format!(
        "网口升级: {}:{}  -> {}  (v{}, {} B)",
        host, port, remote, info.version, info.file_size
    ));

    let mut session = Session::new(host, port, svc);
    let (st, _) = session.req(ctx, SVC_PING, &[], 3)?;
    if st != 0 {
        return Err(format!("设备无响应: {}", svc_status_text(st)));
    }
    ctx.line("设备在线，开始上传");

    let _ = session.req(ctx, SVC_DELETE, remote.as_bytes(), 1);
    let mut p = vec![1u8];
    p.extend_from_slice(remote.as_bytes());
    let (st, d) = session.req(ctx, SVC_OPEN, &p, 3)?;
    if st != 0 || d.len() < 2 {
        return Err(format!("设备打开文件失败: {}", svc_status_text(st)));
    }
    let handle = u16::from_be_bytes([d[0], d[1]]);

    let total = data.len();
    let mut off = 0usize;
    let t0 = Instant::now();
    let mut last_log = 0usize;
    while off < total {
        if crate::agent::stop_requested() {
            let _ = session.req(ctx, SVC_CLOSE, &handle.to_be_bytes(), 1);
            return Err("用户停止了这次网口升级（设备上可能留下半个包）".into());
        }
        let end = (off + SVC_CHUNK).min(total);
        let mut p = Vec::with_capacity(6 + (end - off));
        p.extend_from_slice(&handle.to_be_bytes());
        p.extend_from_slice(&(off as u32).to_be_bytes());
        p.extend_from_slice(&data[off..end]);
        let (status, rd) = session.req(ctx, SVC_WRITE, &p, 4)?;
        if status != 0 {
            return Err(format!("写入失败 @{}: {}", off, svc_status_text(status)));
        }
        let n = if rd.len() >= 4 {
            u32::from_be_bytes([rd[0], rd[1], rd[2], rd[3]]) as usize
        } else {
            0
        };
        if n == 0 {
            return Err(format!("设备写了 0 字节 @{}", off));
        }
        off += n;
        // 主动降速: 每块歇一下, 让 F4 那边(单 socket + SPI 桥)喘口气
        std::thread::sleep(Duration::from_millis(SVC_CHUNK_GAP_MS));
        ctx.prog(off as f64 / total as f64 * 80.0);
        if off - last_log >= 16 * 1024 || off >= total {
            last_log = off;
            let el = t0.elapsed().as_secs_f64();
            ctx.line(format!(
                "上传 {} / {} B   {:.1} KB/s",
                off,
                total,
                if el > 0.0 { off as f64 / 1024.0 / el } else { 0.0 }
            ));
        }
    }
    let _ = session.req(ctx, SVC_CLOSE, &handle.to_be_bytes(), 2);
    ctx.line(format!("上传完成 {} B，用时 {:.1} s，正在校验", total, t0.elapsed().as_secs_f64()));
    ctx.prog(85.0);

    let (st, d) = session.req(ctx, SVC_CRC, remote.as_bytes(), 3)?;
    if st != 0 || d.len() < 8 {
        return Err(format!("设备算 CRC 失败: {}", svc_status_text(st)));
    }
    let dev_crc = u32::from_be_bytes([d[0], d[1], d[2], d[3]]);
    let dev_len = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
    if dev_crc != info.file_crc32 || dev_len != info.file_size {
        return Err(format!(
            "设备里的包和本地不一致(设备 {:08X}/{}B, 本地 {:08X}/{}B)",
            dev_crc, dev_len, info.file_crc32, info.file_size
        ));
    }
    ctx.line(format!("校验通过: {} B, crc32={:08X}", dev_len, dev_crc));

    let (st, d) = session.req(ctx, SVC_OTA_VERIFY, remote.as_bytes(), 3)?;
    if st != 0 {
        return Err(format!("升级包校验失败: {}", svc_status_text(st)));
    }
    if d.len() >= 12 {
        let v = u32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        ctx.line(format!(
            "设备确认: v{}.{}.{}  payload {} B  crc32={:08X}",
            (v >> 16) & 0xFF,
            (v >> 8) & 0xFF,
            v & 0xFF,
            u32::from_be_bytes([d[4], d[5], d[6], d[7]]),
            u32::from_be_bytes([d[8], d[9], d[10], d[11]])
        ));
    }
    ctx.prog(90.0);
    let (st, _) = session.req(ctx, SVC_OTA_APPLY, remote.as_bytes(), 3)?;
    if st != 0 {
        return Err(format!("写升级请求失败: {}", svc_status_text(st)));
    }
    ctx.line("升级请求已写入设备，复位中 ...");
    let _ = session.req(ctx, SVC_REBOOT, &[], 1);

    // 等"确实下去过 + 又稳定应答": 设备复位时网口桥会先超时
    session.set_read_timeout(3);
    let t0 = Instant::now();
    let mut down = false;
    let mut streak = 0;
    while t0.elapsed() < Duration::from_secs(150) {
        if crate::agent::stop_requested() {
            return Err("用户停止了等待（设备可能还在重启，过一会儿手动 ping 一下）".into());
        }
        std::thread::sleep(Duration::from_millis(1500));
        match session.req0(ctx, SVC_PING) {
            Ok(0) => {
                if down {
                    streak += 1;
                    if streak >= 2 {
                        ctx.prog(100.0);
                        ctx.line(format!("设备已回来(用时 {:.0} s)", t0.elapsed().as_secs_f64()));
                        return Ok(());
                    }
                }
            }
            _ => {
                down = true;
                streak = 0;
            }
        }
    }
    Err("设备超过 150 秒没有回来，请检查设备日志".into())
}

/// 自己开连接做网口升级(工具没连 788 时用)
pub fn net_upgrade(ctx: &mut Ctx, host: &str, port: u16, name: &str, data: &[u8]) -> Result<(), String> {
    let s = Svc::connect(host, port)?;
    net_upgrade_conn(ctx, s, host, port, name, data)
}

// ---------------------------------------------------------------- 串口(app 在线升级)
const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const CRC_C: u8 = 0x43;
/// 串口每个 YMODEM 块之间的间隔(ms): 稳定优先
const SER_BLOCK_GAP_MS: u64 = 4;

fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn ymodem_block(seq: u8, payload: &[u8], size: usize) -> Vec<u8> {
    let mut body = payload.to_vec();
    body.resize(size, 0x1A);
    let c = crc16(&body);
    let mut out = vec![if size == 1024 { STX } else { SOH }, seq, 0xFF - seq];
    out.extend_from_slice(&body);
    out.push((c >> 8) as u8);
    out.push((c & 0xFF) as u8);
    out
}

/// Conn 没实现 std::io::Write, 这里做"写满"
fn conn_write(conn: &mut Conn, data: &[u8]) -> Result<(), String> {
    let mut off = 0usize;
    while off < data.len() {
        match conn.write(&data[off..]) {
            Ok(0) => return Err("串口写了 0 字节".into()),
            Ok(n) => off += n,
            Err(e) => return Err(format!("写串口失败: {}", e)),
        }
    }
    let _ = conn.flush();
    Ok(())
}

fn set_timeout(conn: &mut Conn, ms: u64) {
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(ms));
    }
}

/// 读一个字节; show=true 时把字节当设备日志抛给主输出窗口
fn read_byte_logged(ctx: &mut Ctx, conn: &mut Conn, timeout: Duration, show: bool) -> Option<u8> {
    let end = Instant::now() + timeout;
    loop {
        if Instant::now() >= end {
            return None;
        }
        let mut b = [0u8; 1];
        match conn.read(&mut b) {
            Ok(1) => {
                if show {
                    ctx.say(String::from_utf8_lossy(&b).to_string());
                }
                return Some(b[0]);
            }
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn wait_text(ctx: &mut Ctx, conn: &mut Conn, needles: &[&str], total: Duration) -> bool {
    let mut acc = String::new();
    let end = Instant::now() + total;
    while Instant::now() < end {
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_millis(300), true) {
            acc.push(b as char);
            if acc.len() > 4096 {
                let cut = acc.len() - 2048;
                acc.drain(..cut);
            }
            if needles.iter().any(|n| acc.contains(n)) {
                return true;
            }
        }
    }
    false
}

fn drain(ctx: &mut Ctx, conn: &mut Conn, dur: Duration) {
    let end = Instant::now() + dur;
    while Instant::now() < end {
        if read_byte_logged(ctx, conn, Duration::from_millis(30), true).is_none() {
            break;
        }
    }
}

fn send_ymodem(ctx: &mut Ctx, conn: &mut Conn, name: &str, data: &[u8], base: f64) -> Result<(), String> {
    let total = data.len();
    // 1) 等握手 'C'
    let end = Instant::now() + Duration::from_secs(30);
    let mut got = false;
    while Instant::now() < end {
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_millis(300), false) {
            if b == CRC_C {
                got = true;
                break;
            }
        }
    }
    if !got {
        return Err("没等到设备的 YMODEM 握手(C)".into());
    }
    // 2) 块0: 文件名 + 长度
    let mut b0 = name.as_bytes().to_vec();
    b0.push(0);
    b0.extend_from_slice(total.to_string().as_bytes());
    b0.push(0);
    let pkt0 = ymodem_block(0, &b0, 128);
    let mut ok = false;
    for _ in 0..10 {
        conn_write(conn, &pkt0)?;
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_secs(3), false) {
            if b == ACK {
                ok = true;
                break;
            }
            if b == CAN {
                return Err("设备取消了传输".into());
            }
        }
    }
    if !ok {
        return Err("块0 没有被应答".into());
    }
    // 3) 等 'C' 再发数据块
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_millis(300), true) {
            if b == CRC_C {
                break;
            }
        }
    }
    let mut off = 0usize;
    let mut seq: u8 = 1;
    let t0 = Instant::now();
    while off < total {
        if crate::agent::stop_requested() {
            // YMODEM 的中止是发 CAN：不发的话设备会一直等着下一个块
            for _ in 0..3 {
                let _ = conn_write(conn, &[CAN]);
            }
            return Err("用户停止了这次串口升级（已发 CAN 中止）".into());
        }
        let end = (off + 1024).min(total);
        let pkt = ymodem_block(seq, &data[off..end], 1024);
        let mut acked = false;
        for _ in 0..10 {
            conn_write(conn, &pkt)?;
            match read_byte_logged(ctx, conn, Duration::from_secs(10), false) {
                Some(ACK) => {
                    acked = true;
                    break;
                }
                Some(CAN) => return Err("设备取消了传输".into()),
                _ => continue,
            }
        }
        if !acked {
            return Err(format!("第 {} 块没有被应答", seq));
        }
        off = end;
        seq = seq.wrapping_add(1);
        std::thread::sleep(Duration::from_millis(SER_BLOCK_GAP_MS));
        if seq % 16 == 0 || off >= total {
            let el = t0.elapsed().as_secs_f64();
            ctx.prog(base + off as f64 / total as f64 * (80.0 - base));
            ctx.line(format!(
                "发送 {} / {} B   {:.1} KB/s",
                off,
                total,
                if el > 0.0 { off as f64 / 1024.0 / el } else { 0.0 }
            ));
        }
    }
    // 4) 两个 EOT + 结束块
    for _ in 0..10 {
        conn_write(conn, &[EOT])?;
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_secs(3), false) {
            if b == NAK {
                break;
            }
        }
    }
    conn_write(conn, &[EOT])?;
    let _ = read_byte_logged(ctx, conn, Duration::from_secs(3), false);
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if let Some(b) = read_byte_logged(ctx, conn, Duration::from_millis(300), true) {
            if b == CRC_C {
                break;
            }
        }
    }
    conn_write(conn, &ymodem_block(0, &[0u8], 128))?;
    let _ = read_byte_logged(ctx, conn, Duration::from_secs(3), false);
    Ok(())
}

/// 串口升级: cshell `upload firmware`(YMODEM) → `upgrade <name> -f -s` → app 自己复位
pub fn serial_upgrade(ctx: &mut Ctx, conn: &mut Conn, name: &str, data: &[u8]) -> Result<(), String> {
    let info = parse_fw(data, name)?;
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let fname = if clean.is_empty() { "fw.fw".to_string() } else { clean };
    ctx.line(format!("串口升级: {}  (v{}, {} B)", fname, info.version, info.file_size));
    set_timeout(conn, 300);
    for _ in 0..2 {
        let _ = conn_write(conn, b"\r\n");
        std::thread::sleep(Duration::from_millis(150));
    }
    drain(ctx, conn, Duration::from_millis(300));
    ctx.line("发送 upload firmware ...");
    conn_write(conn, b"upload firmware\r\n")?;
    if !wait_text(
        ctx,
        conn,
        &["upload ->", "Now in your terminal tool", "YMODEM"],
        Duration::from_secs(30),
    ) {
        return Err("设备没有进入 upload/YMODEM 状态(串口要接在运行 app 的那块板上)".into());
    }
    ctx.line("设备已进入接收状态，开始发送固件 ...");
    send_ymodem(ctx, conn, &fname, data, 10.0)?;
    ctx.line("等待设备保存固件 ...");
    if !wait_text(ctx, conn, &["upload: ok", "upload: crc32"], Duration::from_secs(120)) {
        return Err("没等到 upload 完成回显".into());
    }
    ctx.prog(88.0);
    ctx.line(format!("通知 app 写升级请求并复位: upgrade {} -f -s", fname));
    conn_write(conn, format!("upgrade {} -f -s\r\n", fname).as_bytes())?;
    // 等设备重启后重新吐日志(最多 3 分钟)
    // 不傻等固定时长：连续 8 秒没有新字节就认为设备说完了(最长 3 分钟兜底)
    let end = Instant::now() + Duration::from_secs(180);
    let mut silent = 0u32;
    while Instant::now() < end {
        match read_byte_logged(ctx, conn, Duration::from_millis(500), true) {
            Some(_) => silent = 0,
            None => {
                silent += 1;
                if silent >= 16 {
                    break;
                }
            }
        }
    }
    ctx.prog(100.0);
    Ok(())
}
