//! USBPcap 抓包（可选组件）。
//!
//! 驱动与命令行工具都来自 USBPcap 官方安装包：
//!   - USBPcapDriver：GPLv2（本程序不链接、不打包，只调用用户自己安装的组件）
//!   - USBPcapCMD：BSD-2-Clause（运行时调用，解析它生成的 pcap）
//!
//! 抓包需要管理员权限，所以真正跑 USBPcapCMD 的是本程序自己的提权子进程
//! （`--usbpcap-run`），父进程只负责 tail pcap 文件、解析、推给前端。

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const EXE_EXTRA: &str = "C:\\Program Files\\USBPcap;C:\\Program Files (x86)\\USBPcap";

struct Cap {
    stop: Arc<AtomicBool>,
    pcap: PathBuf,
    stopfile: PathBuf,
}

static CAP: LazyLock<Mutex<Option<Cap>>> = LazyLock::new(|| Mutex::new(None));

fn find_cmd() -> Option<PathBuf> {
    crate::env_setup::find_tool("USBPcapCMD.exe", EXE_EXTRA)
}

/// USB 根 Hub 数量（USBPcap 每个根 Hub 一个 \\.\USBPcapN 控制设备）
fn root_hub_count() -> usize {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
    let mut n = 0usize;
    unsafe {
        let h = SetupDiGetClassDevsW(std::ptr::null(), w("USB").as_ptr(), std::ptr::null_mut(), DIGCF_PRESENT | DIGCF_ALLCLASSES);
        if h == -1isize {
            return 0;
        }
        let mut info: SP_DEVINFO_DATA = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        let mut i = 0u32;
        while SetupDiEnumDeviceInfo(h, i, &mut info) != 0 {
            i += 1;
            let mut buf = [0u16; 512];
            let mut need = 0u32;
            if SetupDiGetDeviceInstanceIdW(h, &info, buf.as_mut_ptr(), buf.len() as u32, &mut need) == 0 {
                continue;
            }
            let s = String::from_utf16_lossy(&buf[..((need as usize).saturating_sub(1)).min(buf.len())]).to_uppercase();
            if s.starts_with("USB\\ROOT_HUB") {
                n += 1;
            }
        }
        SetupDiDestroyDeviceInfoList(h);
    }
    n
}

fn reboot_pending() -> bool {
    use windows_sys::Win32::System::Registry::*;
    let path = w("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending");
    let mut h = std::ptr::null_mut();
    let r = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut h) };
    if r == 0 {
        unsafe { RegCloseKey(h) };
        true
    } else {
        false
    }
}

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// pcap 解析：USBPcap 的 linktype = 249，每条记录前是 27/28 字节伪头
struct Parser {
    header_done: bool,
    buf: Vec<u8>,
}

impl Parser {
    fn new() -> Self {
        Self { header_done: false, buf: Vec::new() }
    }

    fn feed(&mut self, data: &[u8]) -> Vec<Value> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut pos = 0usize;
        if !self.header_done {
            if self.buf.len() < 24 {
                return out;
            }
            let magic = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
            if magic != 0xa1b2c3d4 {
                // 不是经典 pcap（可能还没写头部）：丢掉已有数据，等下一批
                self.buf.clear();
                return out;
            }
            pos = 24;
            self.header_done = true;
        }
        while self.buf.len() >= pos + 16 {
            let ts_sec = u32::from_le_bytes([self.buf[pos], self.buf[pos + 1], self.buf[pos + 2], self.buf[pos + 3]]);
            let ts_usec = u32::from_le_bytes([self.buf[pos + 4], self.buf[pos + 5], self.buf[pos + 6], self.buf[pos + 7]]);
            let incl = u32::from_le_bytes([self.buf[pos + 8], self.buf[pos + 9], self.buf[pos + 10], self.buf[pos + 11]]) as usize;
            if incl > 4 * 1024 * 1024 {
                break; // 明显不对，等下一批（或文件损坏）
            }
            let total = 16 + incl;
            if self.buf.len() < pos + total {
                break;
            }
            let packet = &self.buf[pos + 16..pos + total];
            let ts = (ts_sec as u64) * 1_000_000 + ts_usec as u64;
            if let Some(rec) = decode_packet(packet, ts) {
                out.push(rec);
            }
            pos += total;
        }
        if pos > 0 {
            self.buf.drain(..pos);
        }
        out
    }
}

fn decode_packet(d: &[u8], ts: u64) -> Option<Value> {
    if d.len() < 27 {
        return None;
    }
    let hlen = u16::from_le_bytes([d[0], d[1]]) as usize;
    if hlen < 27 || d.len() < hlen {
        return None;
    }
    let status = u32::from_le_bytes([d[10], d[11], d[12], d[13]]);
    let info = d[16];
    let bus = u16::from_le_bytes([d[17], d[18]]);
    let dev = u16::from_le_bytes([d[19], d[20]]);
    let ep = d[21];
    let xfer = d[22];
    let dlen = u32::from_le_bytes([d[23], d[24], d[25], d[26]]);
    if xfer == 0xFE || xfer == 0xFF {
        return None;
    }
    let payload = &d[hlen..];
    let dir_in = info & 1 != 0;
    let kind = match xfer {
        0 => "iso",
        1 => "int",
        2 => "ctl",
        3 => "bulk",
        _ => "?",
    };
    let mut v = json!({
        "t": ts,
        "bus": bus,
        "dev": dev,
        "ep": format!("0x{:02X}", ep),
        "xfer": kind,
        "dir": if dir_in { "IN" } else { "OUT" },
        "status": status,
        "len": dlen,
        "data": crate::base64_encode(payload),
    });
    if xfer == 2 {
        let stage = if hlen > 27 { d[27] } else { 0xFF };
        v["stage"] = json!(stage);
        if stage == 0 && payload.len() >= 8 {
            let bm = payload[0];
            let br = payload[1];
            let wv = u16::from_le_bytes([payload[2], payload[3]]);
            let wi = u16::from_le_bytes([payload[4], payload[5]]);
            let wl = u16::from_le_bytes([payload[6], payload[7]]);
            let dir = if bm & 0x80 != 0 { "IN" } else { "OUT" };
            let ty = match bm & 0x60 {
                0x00 => "std",
                0x20 => "class",
                0x40 => "vendor",
                _ => "reserved",
            };
            v["setup"] = json!({
                "bmRequestType": format!("0x{:02X}", bm),
                "bRequest": format!("0x{:02X}", br),
                "wValue": format!("0x{:04X}", wv),
                "wIndex": format!("0x{:04X}", wi),
                "wLength": wl,
                "dir": dir,
                "type": ty,
            });
            // setup 阶段的 payload 前 8 字节是 setup 包，剩下的是 OUT 数据
            v["data"] = json!(crate::base64_encode(&payload[8..]));
        }
    }
    Some(v)
}

#[tauri::command]
pub async fn usbpcap_info() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cmd = find_cmd();
        let hubs = root_hub_count();
        json!({
            "installed": cmd.is_some(),
            "cmd": cmd.map(|p| p.to_string_lossy().to_string()),
            "rootHubs": hubs,
            "rebootPending": reboot_pending(),
            "devices": (1..=hubs.max(1)).map(|n| format!("\\\\.\\USBPcap{}", n)).collect::<Vec<_>>(),
        })
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))
}

#[tauri::command]
pub async fn usbpcap_start(app: tauri::AppHandle, device: String) -> Result<Value, String> {
    let _ = usbpcap_stop();
    let cmd = find_cmd().ok_or_else(|| "没装 USBPcap —— 到「环境配置」里装一下".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pcap = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.pcap"));
    let stopfile = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.stop"));
    let _ = std::fs::remove_file(&pcap);
    let _ = std::fs::remove_file(&stopfile);

    let ps1 = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.ps1"));
    let script = format!(
        "$p = Start-Process -FilePath '{}' -ArgumentList '-d','{}','-A','-o','{}' -PassThru -WindowStyle Hidden -RedirectStandardOutput '{}.out' -RedirectStandardError '{}.err'\n\
         while (-not (Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 200 }}\n\
         if (-not $p.HasExited) {{ Stop-Process -Id $p.Id -Force }}\n\
         Remove-Item -LiteralPath '{}' -ErrorAction SilentlyContinue\n",
        cmd.display(), device, pcap.display(), pcap.display(), pcap.display(),
        stopfile.display(), stopfile.display()
    );
    std::fs::write(&ps1, script).map_err(|e| format!("写提权脚本失败：{e}"))?;
    let ps = format!(
        "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}' -Verb RunAs -WindowStyle Hidden",
        ps1.display()
    );
    let st = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .creation_flags(0x0800_0000)
        .status()
        .map_err(|e| format!("启动提权进程失败：{e}"))?;
    if !st.success() {
        return Err("提权失败或用户取消了 UAC".into());
    }
    // 等 pcap 文件出现（最多 6 秒）
    let mut ok = false;
    for _ in 0..60 {
        if pcap.exists() {
            ok = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !ok {
        let _ = std::fs::write(&stopfile, b"stop");
        return Err(format!(
            "USBPcap 没开始写数据（{}）。设备名对吗？驱动装完需要重启一次。",
            device
        ));
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let app2 = app.clone();
        let st2 = stop.clone();
        let file = pcap.clone();
        std::thread::spawn(move || reader_loop(app2, file, st2));
    }
    if let Ok(mut g) = CAP.lock() {
        *g = Some(Cap { stop, pcap: pcap.clone(), stopfile: stopfile.clone() });
    }
    let _ = cmd;
    Ok(json!({ "pcap": pcap.to_string_lossy(), "device": device }))
}

#[tauri::command]
pub fn usbpcap_stop() -> Result<(), String> {
    if let Ok(mut g) = CAP.lock() {
        if let Some(c) = g.take() {
            c.stop.store(true, Ordering::Relaxed);
            let _ = std::fs::write(&c.stopfile, b"stop");
            std::thread::sleep(Duration::from_millis(400));
            let _ = c.pcap.clone();
        }
    }
    Ok(())
}

fn reader_loop(app: tauri::AppHandle, file: PathBuf, stop: Arc<AtomicBool>) {
    use tauri::Emitter;
    let mut f = loop {
        match std::fs::File::open(&file) {
            Ok(f) => break f,
            Err(_) => {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    let mut parser = Parser::new();
    let mut chunk = [0u8; 65536];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match f.read(&mut chunk) {
            Ok(0) => std::thread::sleep(Duration::from_millis(60)),
            Ok(n) => {
                let recs = parser.feed(&chunk[..n]);
                if !recs.is_empty() {
                    let _ = app.emit("usb://cap", json!({ "records": recs }));
                }
            }
            Err(_) => break,
        }
    }
    let _ = app.emit("usb://cap-end", json!({}));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(ts: u32, data: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&ts.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    #[test]
    fn parses_bulk_and_control() {
        let mut file = Vec::new();
        file.extend_from_slice(&0xa1b2c3d4u32.to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&4u16.to_le_bytes());
        file.extend_from_slice(&0i32.to_le_bytes());
        file.extend_from_slice(&0u32.to_le_bytes());
        file.extend_from_slice(&65535u32.to_le_bytes());
        file.extend_from_slice(&249u32.to_le_bytes());

        // bulk IN: bus 1 dev 5 ep 0x81, payload AA BB
        let mut b = Vec::new();
        b.extend_from_slice(&27u16.to_le_bytes());
        b.extend_from_slice(&1u64.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.push(1); // info: IN
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&5u16.to_le_bytes());
        b.push(0x81);
        b.push(3); // bulk
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&[0xAA, 0xBB]);
        file.extend_from_slice(&pkt(100, &b));

        // control SETUP: GET_DESCRIPTOR (0x80 0x06 0x0100 0x0000 64)
        let mut c = Vec::new();
        c.extend_from_slice(&28u16.to_le_bytes());
        c.extend_from_slice(&2u64.to_le_bytes());
        c.extend_from_slice(&0u32.to_le_bytes());
        c.extend_from_slice(&0u16.to_le_bytes());
        c.push(0);
        c.extend_from_slice(&1u16.to_le_bytes());
        c.extend_from_slice(&5u16.to_le_bytes());
        c.push(0x00);
        c.push(2); // control
        c.extend_from_slice(&8u32.to_le_bytes());
        c.push(0); // stage SETUP
        c.extend_from_slice(&[0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 64, 0x00]);
        file.extend_from_slice(&pkt(101, &c));

        let mut p = Parser::new();
        let recs = p.feed(&file);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0]["xfer"], "bulk");
        assert_eq!(recs[0]["dir"], "IN");
        assert_eq!(recs[1]["xfer"], "ctl");
        assert_eq!(recs[1]["setup"]["bRequest"], "0x06");
        assert_eq!(recs[1]["setup"]["wLength"], 64);
    }
}
