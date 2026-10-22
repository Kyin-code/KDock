//! 安卓（ADB）页的后端：设备列表 / shell / 推拉文件 / 装 APK / 投屏（抓屏轮询）/ 反向控制。
//!
//! 设计要点：
//!   · adb 和 scrcpy 都当**外部程序**用（跟 ssh / ffmpeg 一个路子）：装不装、装哪儿由用户决定，
//!     我们只负责找、调、把输出画出来；「环境配置」页有一键安装；
//!   · 投屏走 `adb exec-out screencap -p`（PNG）轮询 → 解码 → 缩放 → JPEG → 界面显示。
//!     为什么不用 scrcpy 内嵌：scrcpy 的解码在它自己的 SDL 窗口里，塞不进 WebView；
//!     所以这里给两条路 —— 内置轮询投屏（能点在画面上反向控制）+ 一键起 scrcpy（独立窗口、更丝滑）；
//!   · `exec-out` 是二进制安全的（`shell` 会把 \n 变成 \r\n，PNG 就烂了），所以抓屏必须用它。

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::env_setup;

const ADB_EXTRA: &str = "%ENVDIR%\\adb;%ENVDIR%;%LOCALAPPDATA%\\Android\\Sdk\\platform-tools;%USERPROFILE%\\platform-tools;%USERPROFILE%\\AppData\\Local\\Android\\Sdk\\platform-tools;C:\\platform-tools;D:\\platform-tools;C:\\Android\\platform-tools;D:\\Android\\platform-tools;E:\\platform-tools";
const SCRCPY_EXTRA: &str = "%ENVDIR%\\scrcpy;%ENVDIR%;%USERPROFILE%\\scrcpy;%LOCALAPPDATA%\\scrcpy;C:\\scrcpy;D:\\scrcpy;E:\\scrcpy";

pub fn find_adb() -> Option<std::path::PathBuf> {
    env_setup::find_tool("adb.exe", ADB_EXTRA)
}

pub fn find_scrcpy() -> Option<std::path::PathBuf> {
    env_setup::find_tool("scrcpy.exe", SCRCPY_EXTRA)
}

fn adb_path() -> Result<std::path::PathBuf, String> {
    find_adb().ok_or_else(|| {
        "没找到 adb.exe。到「环境配置 → Android Platform Tools（adb）」点一键安装，或者把解压好的 platform-tools 目录加到 PATH".to_string()
    })
}

/// 跑一条 adb 命令，拿 (退出码, stdout, stderr)
fn adb_run(args: &[&str], timeout_ms: u64) -> Result<(i32, String, String), String> {
    let exe = adb_path()?;
    let mut c = std::process::Command::new(exe);
    c.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut c).map_err(|e| format!("起 adb 失败: {e}"))?;
    // 简单超时：到点就杀（adb 自己也有超时，但 server 卡死时得有人管）
    let t0 = Instant::now();
    let out = child.stdout.take();
    let err = child.stderr.take();
    let h1 = out.map(|mut s| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = s.read_to_end(&mut b);
            b
        })
    });
    let h2 = err.map(|mut s| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = s.read_to_end(&mut b);
            b
        })
    });
    let code = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st.code().unwrap_or(-1),
            None => {
                if t0.elapsed().as_millis() as u64 > timeout_ms {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("adb 命令超时（{} ms）：adb {}", timeout_ms, args.join(" ")));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    let so = h1.and_then(|h| h.join().ok()).unwrap_or_default();
    let se = h2.and_then(|h| h.join().ok()).unwrap_or_default();
    Ok((code, String::from_utf8_lossy(&so).to_string(), String::from_utf8_lossy(&se).to_string()))
}

fn sdev(serial: &str) -> Vec<String> {
    if serial.trim().is_empty() {
        vec![]
    } else {
        vec!["-s".into(), serial.trim().into()]
    }
}

/// adb 在不在、版本是多少
#[tauri::command]
pub fn adb_status() -> Value {
    match find_adb() {
        Some(p) => {
            let v = env_setup::run_text(p.to_string_lossy().as_ref(), &["version"]).unwrap_or_default();
            let ver = v.lines().find(|l| l.to_lowercase().contains("android debug bridge")).unwrap_or("").trim().to_string();
            json!({ "ok": true, "path": p.to_string_lossy(), "version": ver,
                    "scrcpy": find_scrcpy().map(|s| s.to_string_lossy().to_string()) })
        }
        None => json!({ "ok": false, "path": "", "version": "", "scrcpy": find_scrcpy().map(|s| s.to_string_lossy().to_string()) }),
    }
}

/// 列设备（`adb devices -l` 解析成结构）
#[tauri::command]
pub fn adb_devices() -> Result<Vec<Value>, String> {
    let (_, out, err) = adb_run(&["devices", "-l"], 15_000)?;
    let mut list = Vec::new();
    for line in out.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let serial = it.next().unwrap_or("").to_string();
        let state = it.next().unwrap_or("").to_string();
        let mut model = String::new();
        let mut product = String::new();
        let mut device = String::new();
        let mut transport = String::new();
        for kv in it {
            if let Some((k, v)) = kv.split_once(':') {
                match k {
                    "model" => model = v.replace('_', " "),
                    "product" => product = v.to_string(),
                    "device" => device = v.to_string(),
                    "transport_id" => transport = v.to_string(),
                    _ => {}
                }
            }
        }
        list.push(json!({
            "serial": serial, "state": state, "model": model, "product": product,
            "device": device, "transport": transport,
        }));
    }
    if list.is_empty() && !err.trim().is_empty() {
        return Err(err.trim().to_string());
    }
    Ok(list)
}

/// 把 "IP" / "IP:端口" 拼成 adb 要的 target（默认 5555）
fn adb_target(host: &str, port: Option<u16>, def_port: u16) -> Result<String, String> {
    let h = host.trim();
    if h.is_empty() {
        return Err("要填设备地址（IP 或 IP:端口）".into());
    }
    if h.contains(':') {
        Ok(h.to_string())
    } else {
        Ok(format!("{}:{}", h, port.unwrap_or(def_port)))
    }
}

/// 无线调试列表（Android 11+ 的 `adb mdns services`）：配对/连接前先看这个
#[tauri::command]
pub fn adb_mdns() -> Result<Value, String> {
    let (_, out, err) = adb_run(&["mdns", "services"], 15_000)?;
    let text = if out.trim().is_empty() { err.trim().to_string() } else { out };
    let list: Vec<String> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.to_lowercase().starts_with("list of discovered"))
        .map(|l| l.to_string())
        .collect();
    Ok(json!({ "raw": text.trim(), "list": list }))
}

/// 连一台（已配对的）无线调试设备：`adb connect IP[:端口]`，默认 5555
#[tauri::command]
pub fn adb_connect(host: String, port: Option<u16>) -> Result<Value, String> {
    let target = adb_target(&host, port, 5555)?;
    let (code, out, err) = adb_run(&["connect", &target], 30_000)?;
    let text = format!("{}{}", out.trim(), err.trim());
    let low = text.to_lowercase();
    // adb 的"失败"并不总体现在退出码上：得看词
    let bad = ["failed", "cannot", "refused", "unable", "no route", "timed out"]
        .iter()
        .any(|k| low.contains(k));
    if bad {
        return Err(format!(
            "连 {target} 失败：{text}\n（Android 11+ 的无线调试要先在设备上打开「无线调试」，\
             用设备上显示的配对码在这里先配对；配对端口和连接端口不是同一个）"
        ));
    }
    Ok(json!({ "target": target, "code": code, "text": text }))
}

/// 配对新设备（Android 11+）：`adb pair IP:配对端口 配对码`
#[tauri::command]
pub fn adb_pair(host: String, port: Option<u16>, code: String) -> Result<Value, String> {
    let target = adb_target(&host, port, 0)?;
    if target.ends_with(":0") {
        return Err("配对待填设备上显示的「IP 地址和端口」（形如 192.168.1.37:37000）".into());
    }
    let c = code.trim();
    if c.is_empty() {
        return Err("配对要填设备上显示的 6 位配对码".into());
    }
    let (exit, out, err) = adb_run(&["pair", &target, c], 60_000)?;
    let text = format!("{}{}", out.trim(), err.trim());
    if !text.to_lowercase().contains("successfully paired") {
        return Err(format!("配对 {target} 失败：{text}"));
    }
    Ok(json!({ "target": target, "code": exit, "text": text }))
}

/// 断开一台无线调试设备：`adb disconnect IP[:端口]`
#[tauri::command]
pub fn adb_disconnect(host: String, port: Option<u16>) -> Result<Value, String> {
    let target = adb_target(&host, port, 5555)?;
    let (code, out, err) = adb_run(&["disconnect", &target], 20_000)?;
    Ok(json!({ "target": target, "code": code, "text": format!("{}{}", out.trim(), err.trim()) }))
}

/// 跑一条 shell 命令（点一次跑一条，不是长连接）
#[tauri::command]
pub fn adb_shell(serial: String, cmd: String, timeout_ms: Option<u64>) -> Result<Value, String> {
    let mut args = sdev(&serial);
    args.push("shell".into());
    args.push(cmd.clone());
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a, timeout_ms.unwrap_or(20_000))?;
    Ok(json!({ "code": code, "stdout": out, "stderr": err }))
}

/// 本机 → 设备
#[tauri::command]
pub fn adb_push(serial: String, local: String, remote: String) -> Result<Value, String> {
    let mut args = sdev(&serial);
    args.extend(["push".into(), local.clone(), remote.clone()]);
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a, 10 * 60_000)?;
    if code != 0 {
        return Err(format!("{}{}", out.trim(), err.trim()));
    }
    Ok(json!({ "code": code, "text": out.trim() }))
}

/// 设备 → 本机
#[tauri::command]
pub fn adb_pull(serial: String, remote: String, save_to: String) -> Result<Value, String> {
    let mut args = sdev(&serial);
    args.extend(["pull".into(), remote.clone(), save_to.clone()]);
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a, 10 * 60_000)?;
    if code != 0 {
        return Err(format!("{}{}", out.trim(), err.trim()));
    }
    let size = std::fs::metadata(&save_to).map(|m| m.len()).unwrap_or(0);
    Ok(json!({ "code": code, "text": out.trim(), "bytes": size }))
}

/// 装 APK
#[tauri::command]
pub fn adb_install(serial: String, apk: String, reinstall: Option<bool>) -> Result<Value, String> {
    let mut args = sdev(&serial);
    args.push("install".into());
    if reinstall.unwrap_or(false) {
        args.push("-r".into());
    }
    args.push(apk.clone());
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a, 5 * 60_000)?;
    let text = format!("{}{}", out.trim(), err.trim());
    Ok(json!({ "code": code, "text": text, "ok": text.contains("Success") }))
}

/// 卸 App
#[tauri::command]
pub fn adb_uninstall(serial: String, pkg: String) -> Result<Value, String> {
    let mut args = sdev(&serial);
    args.extend(["uninstall".into(), pkg.clone()]);
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a, 120_000)?;
    Ok(json!({ "code": code, "text": format!("{}{}", out.trim(), err.trim()) }))
}

/// 装没装某个包 / 列出第三方包（简版包管理）
#[tauri::command]
pub fn adb_packages(serial: String, filter: Option<String>) -> Result<Vec<String>, String> {
    let mut args = sdev(&serial);
    args.extend(["shell".into(), "pm list packages -3".into()]);
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_, out, err) = adb_run(&a, 30_000)?;
    let f = filter.unwrap_or_default().to_lowercase();
    let mut v: Vec<String> = out
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .map(|s| s.trim().to_string())
        .filter(|s| f.is_empty() || s.to_lowercase().contains(&f))
        .collect();
    v.sort();
    if v.is_empty() && !err.trim().is_empty() {
        return Err(err.trim().to_string());
    }
    Ok(v)
}

/* ───────────────────── 投屏：screencap 轮询 → JPEG ───────────────────── */

static MIR_STOP: LazyLock<Mutex<Option<Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(None));
static MIR_SESSION: AtomicU64 = AtomicU64::new(0);

/// 抓一帧（PNG 字节）
fn screencap(serial: &str, timeout_ms: u64) -> Result<Vec<u8>, String> {
    let exe = adb_path()?;
    let mut c = std::process::Command::new(exe);
    let mut args = sdev(serial);
    args.extend(["exec-out".into(), "screencap -p".into()]);
    c.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut c).map_err(|e| format!("起 adb 失败: {e}"))?;
    let mut so = child.stdout.take().ok_or("拿不到 adb 输出")?;
    let mut se = child.stderr.take().ok_or("拿不到 adb 错误输出")?;
    let h = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let mut buf = Vec::with_capacity(1 << 20);
    let t0 = Instant::now();
    let mut tmp = [0u8; 65536];
    loop {
        match so.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > 64 * 1024 * 1024 {
                    let _ = child.kill();
                    return Err("截图太大（超过 64 MB），放弃".into());
                }
            }
            Err(e) => return Err(format!("读截图失败: {e}")),
        }
        if t0.elapsed().as_millis() as u64 > timeout_ms {
            let _ = child.kill();
            return Err("截图超时（设备没反应？）".into());
        }
    }
    let _ = child.wait();
    let err = h.join().unwrap_or_default();
    if buf.is_empty() {
        return Err(format!("截图为空：{}", String::from_utf8_lossy(&err).trim()));
    }
    Ok(buf)
}

/// 抓一帧存成 PNG（另存为…）
#[tauri::command]
pub fn adb_screenshot(serial: String, save_to: String) -> Result<Value, String> {
    let png = screencap(&serial, 20_000)?;
    std::fs::write(&save_to, &png).map_err(|e| format!("写 {} 失败: {e}", save_to))?;
    Ok(json!({ "bytes": png.len(), "path": save_to }))
}

#[cfg(windows)]
#[tauri::command]
pub fn adb_mirror_start(app: AppHandle, serial: String, fps: u32, quality: u8, scale: f32) -> Result<u64, String> {
    adb_mirror_stop();
    // 先确认设备在：错误早点给，别让用户对着黑屏等
    let _ = screencap(&serial, 20_000)?;
    let stop = Arc::new(AtomicBool::new(false));
    *MIR_STOP.lock().expect("mirror mutex") = Some(stop.clone());
    let session = MIR_SESSION.fetch_add(1, Ordering::Relaxed) + 1;
    let app2 = app.clone();
    let fps = fps.clamp(1, 30);
    let frame_ms = (1000 / fps.max(1)) as u64;
    let quality = quality.clamp(20, 95);
    let scale = if scale <= 0.0 { 1.0 } else { scale.clamp(0.1, 1.0) };
    std::thread::spawn(move || {
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let t0 = Instant::now();
            match screencap(&serial, 20_000) {
                Ok(png) => {
                    let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png);
                    match img {
                        Ok(img) => {
                            let full = img.to_rgb8();
                            let (fw, fh) = full.dimensions();
                            let w = (((fw as f32) * scale) as u32).max(1);
                            let h = (((fh as f32) * scale) as u32).max(1);
                            let rgb = if (w, h) == (fw, fh) {
                                full
                            } else {
                                image::imageops::resize(&full, w, h, image::imageops::FilterType::Triangle)
                            };
                            let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
                            use image::ImageEncoder;
                            let ok = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
                                .write_image(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
                                .is_ok();
                            if ok {
                                let _ = app2.emit(
                                    "adb://frame",
                                    json!({
                                        "session": session, "w": w, "h": h, "srcW": fw, "srcH": fh,
                                        "bytes": buf.len(), "data": crate::upgrade::b64_encode(&buf),
                                    }),
                                );
                            }
                        }
                        Err(e) => {
                            let _ = app2.emit("adb://error", json!({ "session": session, "msg": format!("解码 PNG 失败: {e}") }));
                        }
                    }
                }
                Err(e) => {
                    let _ = app2.emit("adb://error", json!({ "session": session, "msg": e }));
                    std::thread::sleep(Duration::from_millis(600));
                }
            }
            let used = t0.elapsed().as_millis() as u64;
            if used < frame_ms {
                std::thread::sleep(Duration::from_millis(frame_ms - used));
            }
        }
        let _ = app2.emit("adb://stopped", json!({ "session": session }));
    });
    Ok(session)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn adb_mirror_start(_app: AppHandle, _serial: String, _fps: u32, _quality: u8, _scale: f32) -> Result<u64, String> {
    Err("投屏解码用的是 image crate，这个平台没编进去".into())
}

#[tauri::command]
pub fn adb_mirror_stop() {
    if let Some(s) = MIR_STOP.lock().expect("mirror mutex").take() {
        s.store(true, Ordering::Relaxed);
    }
}

/* ───────────────────── 反向控制（点在画面上） ───────────────────── */

fn sh_quote(s: &str) -> String {
    // adb shell 里那一层 shell 的引号：用单引号包起来，内部的单引号按 shell 规矩转义
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 触摸 / 按键：点在投屏画面上就是它。
/// kind: tap | swipe | key | text
#[tauri::command]
pub fn adb_input(serial: String, kind: String, a: Option<f64>, b: Option<f64>, c: Option<f64>, d: Option<f64>, text: Option<String>, duration: Option<u64>) -> Result<Value, String> {
    let cmd = match kind.as_str() {
        "tap" => format!("input tap {} {}", a.unwrap_or(0.0) as i64, b.unwrap_or(0.0) as i64),
        "swipe" => format!(
            "input swipe {} {} {} {} {}",
            a.unwrap_or(0.0) as i64,
            b.unwrap_or(0.0) as i64,
            c.unwrap_or(0.0) as i64,
            d.unwrap_or(0.0) as i64,
            duration.unwrap_or(200)
        ),
        "key" => format!("input keyevent {}", text.unwrap_or_default()),
        "text" => {
            // 空格在 input text 里要写成 %s，其余特殊字符让 shell 别解释
            let t = text.unwrap_or_default().replace(' ', "%s");
            format!("input text {}", sh_quote(&t))
        }
        other => return Err(format!("不认识的输入类型：{other}（tap / swipe / key / text）")),
    };
    let mut args = sdev(&serial);
    args.push("shell".into());
    args.push(cmd.clone());
    let a2: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = adb_run(&a2, 15_000)?;
    Ok(json!({ "code": code, "cmd": cmd, "stdout": out, "stderr": err }))
}

/* ───────────────────── scrcpy（独立窗口，外部程序） ───────────────────── */

static SCRCPY: LazyLock<Mutex<Option<std::process::Child>>> = LazyLock::new(|| Mutex::new(None));

/// 起 scrcpy（独立窗口）。参数原样透传，方便用户自己加 --max-size / --bit-rate 这些。
#[tauri::command]
pub fn adb_scrcpy_run(serial: String, args: Option<String>) -> Result<Value, String> {
    adb_scrcpy_stop();
    let exe = find_scrcpy().ok_or_else(|| {
        "没找到 scrcpy.exe。到「环境配置 → scrcpy」点一键安装（或者把 scrcpy 的 zip 丢进 <exe 同目录>\\drivers\\scrcpy\\ 再点一次）".to_string()
    })?;
    let mut c = std::process::Command::new(&exe);
    if !serial.trim().is_empty() {
        c.args(["-s", serial.trim()]);
    }
    if let Some(a) = args.filter(|a| !a.trim().is_empty()) {
        for x in a.split_whitespace() {
            c.arg(x);
        }
    }
    let child = crate::process_guard::spawn(&mut c).map_err(|e| format!("起 scrcpy 失败: {e}"))?;
    let pid = child.id();
    *SCRCPY.lock().expect("scrcpy mutex") = Some(child);
    Ok(json!({ "pid": pid, "exe": exe.to_string_lossy() }))
}

#[tauri::command]
pub fn adb_scrcpy_stop() {
    if let Some(mut c) = SCRCPY.lock().expect("scrcpy mutex").take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[tauri::command]
pub fn adb_scrcpy_state() -> Value {
    let mut g = SCRCPY.lock().expect("scrcpy mutex");
    let running = match g.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    };
    json!({ "running": running, "path": find_scrcpy().map(|p| p.to_string_lossy().to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_survives_single_quotes() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }
}
