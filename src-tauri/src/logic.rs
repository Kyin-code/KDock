//! 逻辑分析仪真机采集：调用外部的 `sigrok-cli`。
//!
//! 为什么不自己写 USB：fx2lafw（老款 Saleae Logic / 各种 FX2 分析仪）、saleae-logic16、
//! DSLogic 这一票设备的协议，sigrok 已经维护了十几年。我们复用它的驱动层，只负责
//! 「列设备 → 起一次采集 → 把采样数据交给前端」，换设备不用改代码。
//! 代价是机器上得有 sigrok-cli（「环境配置」页可以一键装）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::env_setup;

/// sigrok-cli 可能在的地方（PATH 之外）
const EXE_EXTRA: &str =
    "C:\\Program Files\\sigrok\\sigrok-cli;C:\\Program Files\\sigrok;D:\\ENV;F:\\ENV;I:\\ENV";

/// 前端一次最多拿多少点（8 通道 × 2000 万点 = 160MB 的 bits，已经够狠了）
const MAX_SAMPLES: u64 = 20_000_000;

/// 设备 id → 总通道数。libsigrok 的 unitsize 按驱动/设备定：
/// fx2lafw 8ch = 1 字节，16ch = 2 字节；DSLogic / saleae-logic16 恒为 2 字节。
static DEV_CHANS: LazyLock<Mutex<HashMap<String, usize>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 从 `--show` / `--scan` 的 "… with N channels:" 里拿总通道数
fn parse_total_channels(text: &str) -> Option<usize> {
    for line in text.lines() {
        let Some((_, tail)) = line.split_once(" with ") else { continue };
        let Some((num, _)) = tail.split_once(" channels") else { continue };
        if let Ok(n) = num.trim().parse::<usize>() {
            return Some(n);
        }
    }
    None
}

fn total_channels(cli: &Path, id: &str) -> usize {
    if let Ok(g) = DEV_CHANS.lock() {
        if let Some(&n) = g.get(id) {
            return n;
        }
    }
    let (show, _) = run_both(cli, &["-d", id, "--show"]).unwrap_or_default();
    let n = parse_total_channels(&show).unwrap_or(8);
    if let Ok(mut g) = DEV_CHANS.lock() {
        g.insert(id.to_string(), n);
    }
    n
}

fn find_cli() -> Option<PathBuf> {
    env_setup::find_tool("sigrok-cli.exe", EXE_EXTRA)
}

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别闪黑框
    }
}

/// 跑一次 sigrok-cli，拿 (stdout, stderr)。stderr 里会有 "sr: …" 这类设备层警告
/// （典型：LIBUSB_ERROR_ACCESS = 设备被占用 / 需要重新插拔），要原样带回界面。
fn run_both(cli: &Path, args: &[&str]) -> Result<(String, String), String> {
    let mut c = Command::new(cli);
    c.args(args);
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("启动 sigrok-cli 失败：{e}"))?;
    let so = String::from_utf8_lossy(&out.stdout).to_string();
    let se = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() && so.trim().is_empty() && se.trim().is_empty() {
        return Err(format!("sigrok-cli 退出码 {}", out.status.code().unwrap_or(-1)));
    }
    Ok((so, se))
}

fn parse_hz(num: &str, unit: &str) -> Option<u64> {
    let v: f64 = num.parse().ok()?;
    let m = match unit {
        "GHz" => 1e9,
        "MHz" => 1e6,
        "kHz" => 1e3,
        "Hz" => 1.0,
        _ => return None,
    };
    let hz = v * m;
    if hz > 0.0 && hz < 1e12 { Some(hz as u64) } else { None }
}

/// 解析 `--scan` 的输出：
/// `fx2lafw:conn=1.54 - Saleae Logic [S/N: Saleae Logic] with 8 channels: D0 D1 …`
fn parse_devices(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with("The following") || l.starts_with("demo -") {
            continue;
        }
        let Some((id, rest)) = l.split_once(" - ") else { continue };
        let (name, chans) = match rest.rsplit_once(" with ") {
            Some((nm, tail)) => {
                let ch: Vec<String> = tail
                    .split_once(": ")
                    .map(|(_, c)| {
                        c.split_whitespace()
                            .map(|s| s.trim_end_matches([',', '.']).to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                (nm.to_string(), ch)
            }
            None => (rest.to_string(), Vec::new()),
        };
        out.push(json!({ "id": id, "name": name, "channels": chans }));
    }
    out
}

/// 解析 `--show` 里的采样率表（"20 kHz (current)" …）
fn parse_rates(text: &str) -> Vec<u64> {
    let mut on = false;
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if !on {
            if l.starts_with("samplerate") && l.contains("supported") {
                on = true;
            }
            continue;
        }
        let mut it = l.split_whitespace();
        let (Some(num), Some(unit)) = (it.next(), it.next()) else { break };
        match parse_hz(num, unit) {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

fn devices_blocking() -> Result<Value, String> {
    let cli = find_cli().ok_or_else(|| {
        "没找到 sigrok-cli.exe —— 去「环境配置」页装 sigrok-cli，或者把它的目录加进 PATH。".to_string()
    })?;
    let (scan, scan_err) = run_both(&cli, &["--scan"])?;
    let mut devs = parse_devices(&scan);
    let mut warnings: Vec<String> = scan_err
        .lines()
        .filter(|l| l.trim().starts_with("sr:"))
        .map(|l| l.trim().to_string())
        .collect();
    for d in devs.iter_mut() {
        let id = d["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let mut show = run_both(&cli, &["-d", &id, "--show"]).map(|(o, _)| o).unwrap_or_default();
        let mut rates = parse_rates(&show);
        if rates.is_empty() {
            // 刚插上 / 刚启动时设备可能还没稳定，等一下再问一次
            std::thread::sleep(std::time::Duration::from_millis(400));
            show = run_both(&cli, &["-d", &id, "--show"]).map(|(o, _)| o).unwrap_or_default();
            rates = parse_rates(&show);
        }
        if let Some(n) = parse_total_channels(&show) {
            if let Ok(mut g) = DEV_CHANS.lock() {
                g.insert(id.clone(), n);
            }
        }
        d["rates"] = json!(rates);
    }
    warnings.truncate(6);
    Ok(json!({
        "cli": cli.to_string_lossy(),
        "devices": devs,
        "warnings": warnings,
        "raw": scan.lines().take(8).collect::<Vec<_>>().join("\n"),
    }))
}

fn capture_blocking(device: &str, rate: u64, samples: u64, channels: &[String]) -> Result<Value, String> {
    let cli = find_cli().ok_or_else(|| {
        "没找到 sigrok-cli.exe —— 去「环境配置」页装 sigrok-cli，或者把它的目录加进 PATH。".to_string()
    })?;
    if device.trim().is_empty() {
        return Err("没有选设备".into());
    }
    if rate == 0 {
        return Err("采样率不能为 0".into());
    }
    if channels.is_empty() {
        return Err("至少要选一个通道".into());
    }
    if channels.len() > 16 {
        return Err("这一版最多支持 16 个通道".into());
    }
    let n = samples.clamp(1, MAX_SAMPLES);
    let ch = channels.join(",");
    // libsigrok 的 binary 输出是驱动给的 unitsize：
    //   fx2lafw 8ch = 1 字节 / 16ch = 2 字节；DSLogic、saleae-logic16 恒为 2 字节。
    // 先按设备总通道数定，再用实际文件长度兜底（两次采集之间设备换了也不至于解错）。
    let total = total_channels(&cli, device);
    let mut bps: usize = if total > 8 { 2 } else { 1 };

    let dir = std::env::temp_dir().join("kdock-la");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败：{e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let bin = dir.join(format!("cap-{stamp}.bin"));
    let log = dir.join(format!("cap-{stamp}.log"));

    let mut c = Command::new(&cli);
    c.args([
        "-d", device,
        "-C", &ch,
        "--config", &format!("samplerate={rate}"),
        "--samples", &n.to_string(),
        "-O", "binary",
        "-o", bin.to_string_lossy().as_ref(),
    ]);
    no_window(&mut c);
    let lf = std::fs::File::create(&log).map_err(|e| format!("建日志失败：{e}"))?;
    c.stdout(Stdio::from(lf.try_clone().map_err(|e| e.to_string())?));
    c.stderr(Stdio::from(lf));

    let mut child = c.spawn().map_err(|e| format!("启动采集失败：{e}"))?;
    let timeout = Duration::from_secs(((n as f64 / rate as f64) + 30.0).min(600.0) as u64 + 1);
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("等待采集进程失败：{e}")),
        }
        if t0.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&bin);
            return Err(format!("采集超时（{} 秒）", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(40));
    }

    let bytes = std::fs::read(&bin).unwrap_or_default();
    let logtxt = std::fs::read_to_string(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&bin);
    let _ = std::fs::remove_file(&log);
    if bytes.is_empty() {
        let msg = logtxt
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        let hint = if msg.contains("LIBUSB_ERROR_ACCESS") {
            "设备被占用 / 需要重新插拔（或让 Windows 重启一下这个 USB 设备）"
        } else if msg.contains("No such device") {
            "设备掉线了（检查线缆 / 重新插拔）"
        } else {
            ""
        };
        return Err(if msg.is_empty() {
            format!("没采到数据（设备 {device}）")
        } else if hint.is_empty() {
            format!("没采到数据：{msg}")
        } else {
            format!("没采到数据：{hint}｜{msg}")
        });
    }
    if bytes.len() % bps != 0 {
        // 兜底：另一个 unitsize 能整除就用它
        let alt = if bps == 1 { 2 } else { 1 };
        if bytes.len() % alt == 0 {
            bps = alt;
        } else {
            return Err(format!("返回的数据长度不是 {} 字节/采样的整数倍（{} 字节）", bps, bytes.len()));
        }
    }
    let got = (bytes.len() / bps) as u64;
    let warning = if got < n {
        Some(format!("设备只采到 {} / {} 点", got, n))
    } else {
        None
    };
    Ok(json!({
        "rate": rate,
        "n": got,
        "bps": bps,
        "requested": n,
        "channels": channels,
        "data": crate::base64_encode(&bytes),
        "warning": warning,
        "log": logtxt.lines().take(6).collect::<Vec<_>>().join("\n"),
    }))
}

/// 列出 sigrok 能看到的设备（含各自通道与支持的采样率）
#[tauri::command]
pub async fn logic_devices() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(devices_blocking)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

/// 采一次：`-O binary` 的原始采样按通道位打包（1 字节 = 8 通道），base64 回前端
#[tauri::command]
pub async fn logic_capture(
    device: String,
    rate: u64,
    samples: u64,
    channels: Vec<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || capture_blocking(&device, rate, samples, &channels))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}
