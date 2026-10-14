//! 示波器（RIGOL DS1000Z / DS1000Z-E 系列）SCPI 客户端。
//!
//! 走的是示波器的"远程控制"裸 socket 端口（默认 5555），命令就是 SCPI 文本。
//! 这一层同时给三处用：界面上的「示波器」页、agent 的 `scope_*` 工具、以及原来的裸 SCPI 控制台。
//!
//! 两个踩过的坑，这里都处理了：
//! 1. `:DISP:DATA?`（截屏）和 `:WAV:DATA?`（波形）回的是 **IEEE 488.2 定长块**
//!    `#<位数><长度><二进制数据>`：不能按行读到 `\n` 为止 —— 二进制里本来就有 0x0A，
//!    也不能按 UTF-8 当文本处理（会把 PNG 弄坏）。这里按长度精确读字节。
//! 2. 示波器"测不到"时给的是 9.9E37（±inf 哨兵值），要当"没有信号"看，别直接显示成科学计数法。

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

static SCOPE: LazyLock<Mutex<Option<TcpStream>>> = LazyLock::new(|| Mutex::new(None));
static LAST_IO: LazyLock<Mutex<Instant>> =
    LazyLock::new(|| Mutex::new(Instant::now() - Duration::from_secs(5)));

/// DS1000Z 判"测不到 / 超量程"用的哨兵值（9.9E37 = 约 +inf）
pub const NO_VALUE: f64 = 9.9e37;
/// 行式命令的超时（普通查询毫秒级就回）
const LINE_TIMEOUT: Duration = Duration::from_secs(3);
/// 两条命令之间的最小间隔。
/// **实测踩过**：DS1000Z 的命令缓冲区很小，连着发太快它会"吞"掉整条命令
/// （表现是 `:WAV:DATA?` 石沉大海、读超时），所以所有出栈命令统一在这里限速。
const CMD_GAP: Duration = Duration::from_millis(70);

fn lock() -> std::sync::MutexGuard<'static, Option<TcpStream>> {
    SCOPE.lock().expect("scope mutex")
}

/// 拿连接做一件事；没连就直接报一句人话
fn with_stream<T>(f: impl FnOnce(&mut TcpStream) -> Result<T, String>) -> Result<T, String> {
    let mut g = lock();
    let s = g.as_mut().ok_or("示波器还没连接（在「示波器」页点「连接」）")?;
    f(s)
}

fn write_cmd(s: &mut TcpStream, cmd: &str) -> Result<(), String> {
    throttle();
    s.write_all(format!("{}\n", cmd.trim_end()).as_bytes())
        .map_err(|e| format!("发送失败: {e}"))?;
    s.flush().map_err(|e| format!("发送失败: {e}"))
}

/// 出栈限速（见 CMD_GAP 的注释）
fn throttle() {
    let mut t = LAST_IO.lock().expect("scope io mutex");
    if let Some(rest) = CMD_GAP.checked_sub(t.elapsed()) {
        std::thread::sleep(rest);
    }
    *t = Instant::now();
}

/// 把还在路上的旧数据丢掉（上一次读超时/被打断时，示波器可能还在往外吐数据）。
/// 只在"要发新命令前"调用，且有总时长上限。
fn drain(s: &mut TcpStream, max_ms: u64) {
    let _ = s.set_read_timeout(Some(Duration::from_millis(40)));
    let t0 = Instant::now();
    let mut b = [0u8; 512];
    while t0.elapsed() < Duration::from_millis(max_ms) {
        match s.read(&mut b) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = s.set_read_timeout(Some(LINE_TIMEOUT));
}

/// 读到 `\n` 为止（行式回复）
fn read_line_io(s: &mut TcpStream) -> Result<String, String> {
    let mut out: Vec<u8> = Vec::new();
    let mut b = [0u8; 1];
    loop {
        match s.read(&mut b) {
            Ok(0) => break,
            Ok(_) => {
                if b[0] == b'\n' {
                    break;
                }
                if b[0] != b'\r' {
                    out.push(b[0]);
                }
                if out.len() > 8 * 1024 * 1024 {
                    break;
                }
            }
            Err(e) => {
                // 已经收到一部分就先用着（有些回复不带换行）
                if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
                    && !out.is_empty()
                {
                    break;
                }
                return Err(format!("等示波器回话失败: {e}"));
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// 发一条查询并读回一行；示波器不认的命令会回 "Command error"，这里翻译成人话
fn ask(s: &mut TcpStream, cmd: &str) -> Result<String, String> {
    // 回空行通常意味着"上一次读超时留下半截回包"（示波器端口同时只认一个客户端，
    // 被别人抢过、或者读到一半断了都会这样）。冲一下再来一次就好。
    let mut r = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            drain(s, 400);
        }
        write_cmd(s, cmd)?;
        r = read_line_io(s)?;
        if r.contains("Command error") || r.contains("Invalid") {
            return Err(format!("示波器不认这条命令：{cmd}（这台机器可能没有这个功能）"));
        }
        if !r.trim().is_empty() {
            break;
        }
    }
    Ok(r)
}

/// 读一个 IEEE 488.2 定长块 `#<位数><长度><数据>`（二进制安全）
fn read_block(s: &mut TcpStream, timeout: Duration) -> Result<Vec<u8>, String> {
    let _ = s.set_read_timeout(Some(timeout));
    let res = (|| -> Result<Vec<u8>, String> {
        let mut b = [0u8; 1];
        // `#` 之前可能有上一条命令的尾巴，丢掉（但别丢太多）
        let mut guard = 0;
        loop {
            s.read_exact(&mut b)
                .map_err(|e| format!("读数据块头失败（示波器没回数据）: {e}"))?;
            if b[0] == b'#' {
                break;
            }
            guard += 1;
            if guard > 128 {
                return Err("没等到 #（回的不是数据块）".into());
            }
        }
        s.read_exact(&mut b).map_err(|e| format!("读数据块长度失败: {e}"))?;
        let digits = (b[0] as char).to_digit(10).ok_or("数据块头的位数不是数字")? as usize;
        if digits == 0 || digits > 9 {
            return Err(format!("数据块位数 {digits} 不合理"));
        }
        let mut lb = vec![0u8; digits];
        s.read_exact(&mut lb).map_err(|e| format!("读数据块长度失败: {e}"))?;
        let len: usize = String::from_utf8_lossy(&lb)
            .trim()
            .parse()
            .map_err(|_| "数据块长度不是数字".to_string())?;
        if len > 64 * 1024 * 1024 {
            return Err(format!("数据块长度 {len} 太大，不读了"));
        }
        let mut body = vec![0u8; len];
        s.read_exact(&mut body)
            .map_err(|e| format!("读数据块失败（要 {len} 字节）: {e}"))?;
        let _ = s.read_exact(&mut b); // 结尾那个 \n（有就读掉，没有就算了）
        Ok(body)
    })();
    let _ = s.set_read_timeout(Some(LINE_TIMEOUT));
    res
}

/// 型号 → 通道数：DS1000Z 系列里 "DS1" 之后第 4 位数字就是通道数（DS1054Z=4、DS1202Z-E=2）
fn model_channels(model: &str) -> u8 {
    let digits: String = model.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        if let Some(d) = digits.chars().nth(3).and_then(|c| c.to_digit(10)) {
            if (2..=4).contains(&d) {
                return d as u8;
            }
        }
    }
    2
}

fn num(v: &str) -> Option<f64> {
    let x: f64 = v.trim().parse().ok()?;
    if x.is_finite() && x.abs() < NO_VALUE / 2.0 {
        Some(x)
    } else {
        None
    }
}

// ── 连接 ────────────────────────────────────────────────────────────

pub fn connect(host: &str, port: u16) -> Result<String, String> {
    let addr = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|e| format!("地址解析失败: {e}"))?
        .next()
        .ok_or("地址解析失败")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("连不上 {addr}: {e}"))?;
    let _ = s.set_nodelay(true);
    let _ = s.set_read_timeout(Some(LINE_TIMEOUT));
    let _ = s.set_write_timeout(Some(LINE_TIMEOUT));
    *lock() = Some(s);
    // 上一个连接被我们打断时（读块超时），示波器可能还在往外吐数据：
    // 先冲干净再问 IDN，否则第一句就会读到上一次的尾巴（实测连上要等 30 多秒就是这原因）。
    with_stream(|s| {
        drain(s, 500);
        Ok(())
    })?;
    match with_stream(|s| ask(s, "*IDN?")) {
        Ok(idn) => Ok(idn),
        Err(e) => {
            *lock() = None;
            Err(e)
        }
    }
}

pub fn close() {
    *lock() = None;
}

/// 裸 SCPI：非查询命令只发不读，查询命令回一行文本（原来那个控制台 / agent `scope` 工具用）
pub fn raw(cmd: &str) -> Result<String, String> {
    with_stream(|s| {
        write_cmd(s, cmd)?;
        if !cmd.trim().ends_with('?') {
            return Ok("(已发送，无查询)".to_string());
        }
        read_line_io(s)
    })
}

// ── 状态一览（对应 skill 的 scope_info）────────────────────────────

pub fn info() -> Result<Value, String> {
    with_stream(|s| {
        let idn = ask(s, "*IDN?")?;
        let model = idn.split(',').nth(1).unwrap_or("").trim().to_string();
        let chans = model_channels(&model);
        let mut channels = Vec::new();
        for n in 1..=chans {
            let disp = ask(s, &format!(":CHAN{n}:DISP?")).unwrap_or_default();
            let scale = ask(s, &format!(":CHAN{n}:SCAL?")).ok().and_then(|v| num(&v));
            let offset = ask(s, &format!(":CHAN{n}:OFFS?")).ok().and_then(|v| num(&v));
            let coup = ask(s, &format!(":CHAN{n}:COUP?")).unwrap_or_default();
            let probe = ask(s, &format!(":CHAN{n}:PROB?")).ok().and_then(|v| num(&v));
            channels.push(json!({
                "n": n,
                "display": disp.trim() == "1",
                "scale": scale,
                "offset": offset,
                "coupling": coup.trim(),
                "probe": probe,
            }));
        }
        Ok(json!({
            "idn": idn.trim(),
            "model": model,
            "channels": channels,
            "timebase": ask(s, ":TIM:SCAL?").ok().and_then(|v| num(&v)),
            "timebase_offset": ask(s, ":TIM:OFFS?").ok().and_then(|v| num(&v)),
            "sample_rate": ask(s, ":ACQ:SRAT?").ok().and_then(|v| num(&v)),
            "memory_depth": ask(s, ":ACQ:MDEP?").ok(),
            "trigger": {
                "source": ask(s, ":TRIG:EDGE:SOUR?").unwrap_or_default().trim(),
                "level": ask(s, ":TRIG:EDGE:LEV?").ok().and_then(|v| num(&v)),
                "sweep": ask(s, ":TRIG:SWE?").unwrap_or_default().trim(),
                "status": ask(s, ":TRIG:STAT?").unwrap_or_default().trim(),
            },
        }))
    })
}

// ── 自动测量（对应 skill 的 scope_measure）─────────────────────────

/// 测量项：短名 → 示波器那条查询里的名字（RIS/FALL 是上升/下降时间）
pub const MEAS_ITEMS: [(&str, &str); 13] = [
    ("VPP", "VPP"),
    ("VMAX", "VMAX"),
    ("VMIN", "VMIN"),
    ("VAVG", "VAVG"),
    ("VRMS", "VRMS"),
    ("VTOP", "VTOP"),
    ("VBASE", "VBASE"),
    ("FREQ", "FREQ"),
    ("PER", "PER"),
    ("RTIM", "RIS"),
    ("FTIM", "FALL"),
    ("PDUT", "PDUT"),
    ("NDUT", "NDUT"),
];

fn canon_item(name: &str) -> Option<&'static str> {
    let up = name.trim().to_ascii_uppercase();
    MEAS_ITEMS
        .iter()
        .find(|(short, _)| *short == up || short.starts_with(&up))
        .map(|(_, q)| *q)
}

pub fn measure(channel: u8, items: &[String]) -> Result<Value, String> {
    if !(1..=4).contains(&channel) {
        return Err(format!("通道号 {channel} 不对（1~4）"));
    }
    let list: Vec<&'static str> = if items.is_empty() {
        vec!["VPP", "FREQ", "VMAX", "VMIN"]
    } else {
        let mut v = Vec::new();
        for it in items {
            v.push(canon_item(it).ok_or_else(|| format!("不认识的测量项：{it}"))?);
        }
        v
    };
    with_stream(|s| {
        let mut out = serde_json::Map::new();
        for q in list {
            let cmd = format!(":MEAS:{q}? CHAN{channel}");
            let v = match ask(s, &cmd) {
                Ok(t) => num(&t).map(Value::from).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            };
            out.insert(q.to_string(), v);
        }
        Ok(json!({ "channel": channel, "items": out }))
    })
}

// ── 波形（对应 skill 的 scope_waveform）───────────────────────────

/// 一次最多回多少点（RAW 抓几万点也够看了；再多 JSON 太大，前端画不动）
const MAX_RETURN_POINTS: usize = 12_000;

struct Preamble {
    xinc: f64,
    xorigin: f64,
    yinc: f64,
    yorigin: f64,
    yref: f64,
}

/// `:WAV:PRE?` 一次拿全 10 个字段：format,type,points,count,xin,xor,xref,yin,yor,yref。
/// 比一条条问（5 次往返）省事得多 —— 少发命令，示波器就不容易吞命令。
fn preamble(s: &mut TcpStream) -> Result<Preamble, String> {
    if let Ok(line) = ask(s, ":WAV:PRE?") {
        let f: Vec<f64> = line
            .split(',')
            .filter_map(|x| x.trim().parse::<f64>().ok())
            .collect();
        if f.len() >= 10 {
            return Ok(Preamble {
                xinc: f[4],
                xorigin: f[5],
                yinc: f[7],
                yorigin: f[8],
                yref: f[9],
            });
        }
    }
    // 老固件没有 :WAV:PRE? 就一条条问
    Ok(Preamble {
        xinc: ask(s, ":WAV:XINC?")?.parse().unwrap_or(0.0),
        xorigin: ask(s, ":WAV:XOR?")?.parse().unwrap_or(0.0),
        yinc: ask(s, ":WAV:YINC?")?.parse().unwrap_or(0.0),
        yorigin: ask(s, ":WAV:YOR?")?.parse().unwrap_or(0.0),
        yref: ask(s, ":WAV:YREF?")?.parse().unwrap_or(0.0),
    })
}

/// 发一次读数据块的命令；示波器偶尔吞命令（命令发太快时），所以失败就再来一次。
fn ask_block(s: &mut TcpStream, cmd: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            drain(s, 600); // 先把它上一轮没吐完的东西清掉再重试
        }
        write_cmd(s, cmd)?;
        match read_block(s, timeout) {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 读波形。`mode` = NORM（屏幕 1200 点，快）/ RAW（深存储，分块读）
pub fn wave(channel: u8, points: usize, mode: &str) -> Result<Value, String> {
    if !(1..=4).contains(&channel) {
        return Err(format!("通道号 {channel} 不对（1~4）"));
    }
    let raw_mode = mode.eq_ignore_ascii_case("RAW");
    let ask_points = if raw_mode {
        points.clamp(1200, 120_000)
    } else {
        points.clamp(1, 1200)
    };
    with_stream(|s| {
        // 注意：这里**故意不复原**原来的 :WAV:* 设置（原来是 NORM/BYTE/1200 的话本来也一样，
        // 而多问 4 条命令只会让示波器更容易吞命令）。真改了用户手动设的深存储参数，
        // 下一次读波形时我们又会重新设一遍，不影响。
        write_cmd(s, &format!(":WAV:SOUR CHAN{channel}"))?;
        write_cmd(s, ":WAV:FORM BYTE")?;
        write_cmd(s, &format!(":WAV:MODE {}", if raw_mode { "RAW" } else { "NORM" }))?;
        if raw_mode {
            // 深存储：存储深度得够才拿得到点数（AUTO / 正在跑的时候设不进去，那就按实际来）
            let _ = write_cmd(s, &format!(":ACQ:MDEP {ask_points}"));
        }
        write_cmd(s, &format!(":WAV:POIN {ask_points}"))?;
        std::thread::sleep(Duration::from_millis(300));
        // 实际能拿多少点，以**示波器**为准：AUTO 存储深度下就是屏幕的 1200 点
        let want = ask(s, ":WAV:POIN?")
            .ok()
            .and_then(|t| t.trim().parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(ask_points);

        let mut ys: Vec<f64> = Vec::new();
        let mut pre = Preamble { xinc: 0.0, xorigin: 0.0, yinc: 0.0, yorigin: 0.0, yref: 0.0 };
        let result = (|| -> Result<(), String> {
            if raw_mode {
                // RAW 要分块读：RIGOL 建议每块 ≤ 25 万点，这里取 12.5 万
                let chunk = 125_000usize;
                let mut start = 1usize;
                let mut first = true;
                while start <= want {
                    let stop = (start + chunk - 1).min(want);
                    write_cmd(s, &format!(":WAV:STAR {start}"))?;
                    write_cmd(s, &format!(":WAV:STOP {stop}"))?;
                    std::thread::sleep(Duration::from_millis(250));
                    let p = preamble(s)?;
                    let body = ask_block(s, ":WAV:DATA?", Duration::from_secs(25))?;
                    if first {
                        pre = Preamble { xinc: p.xinc, xorigin: p.xorigin, yinc: p.yinc, yorigin: p.yorigin, yref: p.yref };
                        first = false;
                    }
                    for b in body.iter() {
                        ys.push((*b as f64 - p.yorigin - p.yref) * p.yinc);
                    }
                    start = stop + 1;
                }
            } else {
                pre = preamble(s)?;
                let body = ask_block(s, ":WAV:DATA?", Duration::from_secs(20))?;
                for b in body.iter() {
                    ys.push((*b as f64 - pre.yorigin - pre.yref) * pre.yinc);
                }
            }
            Ok(())
        })();
        result?;

        if ys.is_empty() {
            return Err("没读到波形数据".into());
        }
        // 点太多就抽稀（前端画不了那么多，JSON 也太大）
        let stride = (ys.len() as f64 / MAX_RETURN_POINTS as f64).ceil() as usize;
        let stride = stride.max(1);
        let y: Vec<f64> = if stride == 1 { ys.clone() } else { ys.iter().step_by(stride).copied().collect() };
        let x: Vec<f64> = (0..y.len()).map(|i| pre.xorigin + (i * stride) as f64 * pre.xinc).collect();
        Ok(json!({
            "channel": channel,
            "mode": if raw_mode { "RAW" } else { "NORM" },
            "requested": ask_points,
            "acquired": ys.len(),
            "stride": stride,
            "points": y.len(),
            "xinc": pre.xinc * stride as f64,
            "x": x,
            "y": y,
        }))
    })
}

// ── 截屏（对应 skill 的 scope_screenshot）──────────────────────────

/// 截屏：`:DISP:DATA? ON,OFF,PNG` 回的是 TMC 里的**二进制 PNG**（约 45 KB / 800x480）
pub fn screenshot(path: Option<PathBuf>) -> Result<Value, String> {
    let p = path.unwrap_or_else(temp_shot_path);
    with_stream(|s| {
        write_cmd(s, ":DISP:DATA? ON,OFF,PNG")?;
        let body = read_block(s, Duration::from_secs(15))?;
        if !body.starts_with(&[0x89, b'P', b'N', b'G']) {
            return Err("截屏回的不是 PNG（固件太旧？可以试试 :DISP:DATA? ON,OFF,BMP）".into());
        }
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&p, &body).map_err(|e| format!("写文件失败 {}: {e}", p.display()))?;
        Ok(json!({
            "path": p.to_string_lossy(),
            "bytes": body.len(),
            "dataUrl": format!("data:image/png;base64,{}", crate::upgrade::b64_encode(&body)),
        }))
    })
}

fn temp_shot_path() -> PathBuf {
    let dir = std::env::temp_dir().join("kdock-scope");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("scope_{}.png", crate::now_ms()))
}

// ── 远程控制（对应 skill 的 scope_control）─────────────────────────

fn fnum(args: &Value, key: &str) -> Option<f64> {
    args.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

pub fn control(args: &Value) -> Result<Value, String> {
    with_stream(|s| {
        let mut applied: Vec<String> = Vec::new();
        let ch = args.get("channel").and_then(|v| v.as_u64()).map(|v| v.clamp(1, 4) as u8);
        if let Some(ch) = ch {
            if let Some(v) = args.get("display").and_then(|v| v.as_bool()) {
                write_cmd(s, &format!(":CHAN{ch}:DISP {}", if v { 1 } else { 0 }))?;
                applied.push(format!("CH{ch} 显示={v}"));
            }
            if let Some(v) = fnum(args, "scale") {
                if v <= 0.0 {
                    return Err("档位（scale，V/div）要大于 0".into());
                }
                write_cmd(s, &format!(":CHAN{ch}:SCAL {v}"))?;
                applied.push(format!("CH{ch} 档位={v} V/div"));
            }
            if let Some(v) = fnum(args, "offset") {
                write_cmd(s, &format!(":CHAN{ch}:OFFS {v}"))?;
                applied.push(format!("CH{ch} 偏移={v} V"));
            }
            if let Some(v) = fnum(args, "probe") {
                write_cmd(s, &format!(":CHAN{ch}:PROB {v}"))?;
                applied.push(format!("CH{ch} 探头={v}x"));
            }
            if let Some(v) = args.get("coupling").and_then(|v| v.as_str()) {
                let up = v.trim().to_ascii_uppercase();
                if !matches!(up.as_str(), "AC" | "DC" | "GND") {
                    return Err(format!("耦合只能 AC / DC / GND，收到 {v}"));
                }
                write_cmd(s, &format!(":CHAN{ch}:COUP {up}"))?;
                applied.push(format!("CH{ch} 耦合={up}"));
            }
        }
        if let Some(v) = fnum(args, "timebase") {
            if v <= 0.0 {
                return Err("时基（timebase，s/div）要大于 0".into());
            }
            write_cmd(s, &format!(":TIM:SCAL {v}"))?;
            applied.push(format!("时基={v} s/div"));
        }
        if let Some(v) = fnum(args, "timebase_offset") {
            write_cmd(s, &format!(":TIM:OFFS {v}"))?;
            applied.push(format!("时基偏移={v} s"));
        }
        if let Some(v) = args.get("trigger_source").and_then(|v| v.as_str()) {
            let up = v.trim().to_ascii_uppercase().replace(' ', "");
            let src = match up.as_str() {
                "CHAN1" | "CH1" | "1" => "CHAN1".to_string(),
                "CHAN2" | "CH2" | "2" => "CHAN2".to_string(),
                "CHAN3" | "CH3" | "3" => "CHAN3".to_string(),
                "CHAN4" | "CH4" | "4" => "CHAN4".to_string(),
                _ => return Err(format!("触发源只能 CHAN1~CHAN4，收到 {v}")),
            };
            write_cmd(s, &format!(":TRIG:EDGE:SOUR {src}"))?;
            applied.push(format!("触发源={src}"));
        }
        if let Some(v) = fnum(args, "trigger_level") {
            write_cmd(s, &format!(":TRIG:EDGE:LEV {v}"))?;
            applied.push(format!("触发电平={v} V"));
        }
        if let Some(v) = args.get("trigger_sweep").and_then(|v| v.as_str()) {
            let up = v.trim().to_ascii_uppercase();
            if !matches!(up.as_str(), "AUTO" | "NORMAL" | "SINGLE") {
                return Err(format!("触发方式只能 AUTO / NORMAL / SINGLE，收到 {v}"));
            }
            write_cmd(s, &format!(":TRIG:SWE {up}"))?;
            applied.push(format!("触发方式={up}"));
        }
        if let Some(run) = args.get("run").and_then(|v| v.as_bool()) {
            write_cmd(s, if run { ":RUN" } else { ":STOP" })?;
            applied.push(if run { "RUN".into() } else { "STOP".to_string() });
        }
        if args.get("autoset").and_then(|v| v.as_bool()) == Some(true) {
            write_cmd(s, ":AUT")?;
            std::thread::sleep(Duration::from_millis(1200));
            applied.push("自动设置(:AUT)".to_string());
        }
        if applied.is_empty() {
            return Err("没有给任何要改的参数".into());
        }
        std::thread::sleep(Duration::from_millis(120));
        Ok(json!({ "ok": true, "applied": applied }))
    })
}

/// 给"另存为"用：把已经拿到的 PNG 落到用户选的路径
pub fn save_png(bytes: &[u8], path: &Path) -> Result<String, String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(path, bytes).map_err(|e| format!("写文件失败 {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}
