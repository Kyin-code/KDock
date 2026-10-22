//! 网络抓包：调用 Wireshark 自带的 tshark（GPLv2）实时输出 EK JSON。
//! 本程序不打包/不链接 Wireshark，只在用户自行安装后调用它。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const EXE_EXTRA: &str =
    "C:\\Program Files\\Wireshark;C:\\Program Files (x86)\\Wireshark;F:\\wireshark;D:\\wireshark;E:\\wireshark";

struct Cap {
    child: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
}

static CAP: LazyLock<Mutex<Option<Cap>>> = LazyLock::new(|| Mutex::new(None));

fn find_tshark() -> Option<PathBuf> {
    crate::env_setup::find_tool("tshark.exe", EXE_EXTRA)
}

#[tauri::command]
pub async fn tshark_info() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cmd = find_tshark();
        let mut ifaces: Vec<Value> = Vec::new();
        if let Some(c) = &cmd {
            if let Some(out) = crate::env_setup::run_text(c.to_string_lossy().as_ref(), &["-D"]) {
                for line in out.lines() {
                    let l = line.trim();
                    if l.is_empty() {
                        continue;
                    }
                    let Some((num, rest)) = l.split_once(". ") else { continue };
                    let (dev, name) = match rest.rfind(" (") {
                        Some(i) => (&rest[..i], rest[i + 2..].trim_end_matches(')')),
                        None => (rest, ""),
                    };
                    if !dev.contains("NPF") && !dev.contains("Loopback") {
                        continue;
                    }
                    ifaces.push(json!({ "index": num.trim(), "device": dev, "name": name }));
                }
            }
        }
        json!({
            "installed": cmd.is_some(),
            "cmd": cmd.map(|p| p.to_string_lossy().to_string()),
            "interfaces": ifaces,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))
}

#[tauri::command]
pub async fn tshark_start(app: tauri::AppHandle, iface: String) -> Result<Value, String> {
    let _ = tshark_stop();
    let cmd = find_tshark().ok_or_else(|| "没装 Wireshark / tshark —— 到「环境配置」里装一下".to_string())?;
    let mut child_cmd = Command::new(&cmd);
    child_cmd
        .args([
            "-i", &iface, "-l", "-T", "ek",
            "-e", "frame.time_epoch", "-e", "frame.number", "-e", "frame.len",
            "-e", "eth.src", "-e", "eth.dst", "-e", "ip.src", "-e", "ip.dst",
            "-e", "_ws.col.Protocol", "-e", "_ws.col.Info",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::from(std::fs::File::create(std::env::temp_dir().join("kdock-tshark-err.log")).map_err(|e| e.to_string())?))
        .creation_flags(0x0800_0000);
    let mut child = crate::process_guard::spawn(&mut child_cmd)
        .map_err(|e| format!("启动 tshark 失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("拿不到 tshark 输出")?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let app2 = app.clone();
        let st = stop.clone();
        std::thread::spawn(move || {
            use tauri::Emitter;
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if st.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(line) = line else { break };
                if !line.trim_start().starts_with('{') {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let Some(layers) = v.get("layers") else { continue };
                    let get = |k: &str| -> String {
                        layers
                            .get(k)
                            .and_then(|x| x.as_array())
                            .and_then(|a| a.first())
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string()
                    };
                    let t = get("frame_time_epoch").parse::<f64>().unwrap_or(0.0);
                    let src = { let s = get("ip_src"); if s.is_empty() { get("eth_src") } else { s } };
                    let dst = { let s = get("ip_dst"); if s.is_empty() { get("eth_dst") } else { s } };
                    let rec = json!({
                        "t": (t * 1_000_000.0) as u64,
                        "no": get("frame_number"),
                        "len": get("frame_len"),
                        "src": src,
                        "dst": dst,
                        "proto": get("_ws_col_protocol"),
                        "info": get("_ws_col_info"),
                    });
                    let _ = app2.emit("net://cap", json!({ "record": rec }));
                }
            }
            let _ = app2.emit("net://cap-end", json!({}));
        });
    }
    let child = Arc::new(Mutex::new(Some(child)));
    if let Ok(mut g) = CAP.lock() {
        *g = Some(Cap { child: child.clone(), stop: stop.clone() });
    }
    Ok(json!({ "iface": iface }))
}

#[tauri::command]
pub fn tshark_stop() -> Result<(), String> {
    if let Ok(mut g) = CAP.lock() {
        if let Some(c) = g.take() {
            c.stop.store(true, Ordering::Relaxed);
            if let Ok(mut ch) = c.child.lock() {
                if let Some(mut p) = ch.take() {
                    let _ = p.kill();
                    let _ = p.wait();
                }
            }
        }
    }
    Ok(())
}
