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
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, RawHandle};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_INBOUND;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const EXE_EXTRA: &str = "C:\\Program Files\\USBPcap;C:\\Program Files (x86)\\USBPcap";

struct PipeHandle(HANDLE);
unsafe impl Send for PipeHandle {}

struct Cap {
    stop: Arc<AtomicBool>,
    pcap: PathBuf,
    stopfile: PathBuf,
    got: Arc<AtomicUsize>,
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
pub async fn usbpcap_start(app: tauri::AppHandle, device: String, devices: Option<String>) -> Result<Value, String> {
    if let Some(c) = take_cap() {
        c.stop.store(true, Ordering::Relaxed);
        let _ = std::fs::write(&c.stopfile, b"stop");
    }
    let cmd = find_cmd().ok_or_else(|| "没装 USBPcap —— 到「环境配置」里装一下".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pcap = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.pcap"));
    let stopfile = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.stop"));
    let _ = std::fs::remove_file(&pcap);
    let _ = std::fs::remove_file(&stopfile);

    let filter = devices.unwrap_or_default().trim().to_string();
    let pick = if filter.is_empty() { "-A".to_string() } else { format!("--devices {filter}") };
    let pipe_name = format!("kdock-usbpcap-{stamp}");
    let pipe_wide = w(&format!("\\\\.\\pipe\\{pipe_name}"));
    let ph = unsafe {
        CreateNamedPipeW(
            pipe_wide.as_ptr(),
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            std::ptr::null_mut(),
        )
    };
    if ph == INVALID_HANDLE_VALUE {
        return Err(format!("创建命名管道失败：{}", unsafe { GetLastError() }));
    }
    let ps1 = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.ps1"));
    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         $stopPath = '{}'\n\
         $psi = New-Object System.Diagnostics.ProcessStartInfo\n\
         $psi.FileName = '{}'\n\
         $psi.Arguments = '-d {} {} -o -'\n\
         $psi.UseShellExecute = $false\n\
         $psi.RedirectStandardOutput = $true\n\
         $psi.CreateNoWindow = $true\n\
         $proc = [System.Diagnostics.Process]::Start($psi)\n\
         $log = '{}'\n\
         try {{\n\
           $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', '{}', [System.IO.Pipes.PipeDirection]::Out)\n\
           $client.Connect(8000)\n\
           \"connected\" | Out-File $log\n\
         }} catch {{\n\
           \"connect failed: $($_.Exception.Message)\" | Out-File $log\n\
           if (-not $proc.HasExited) {{ $proc.Kill() }}\n\
           $p2 = Start-Process -FilePath '{}' -ArgumentList '-d','{}','{}','-o','{}' -PassThru -WindowStyle Hidden\n\
           while (-not (Test-Path -LiteralPath $stopPath)) {{ Start-Sleep -Milliseconds 200 }}\n\
           if (-not $p2.HasExited) {{ Stop-Process -Id $p2.Id -Force }}\n\
           exit\n\
         }}\n\
         $src = $proc.StandardOutput.BaseStream\n\
         $buf = New-Object byte[] 65536\n\
         while ($true) {{\n\
           if (Test-Path -LiteralPath $stopPath) {{ break }}\n\
           $t = $src.ReadAsync($buf, 0, $buf.Length)\n\
           while (-not $t.IsCompleted) {{ if (Test-Path -LiteralPath $stopPath) {{ break }}; Start-Sleep -Milliseconds 100 }}\n\
           if (Test-Path -LiteralPath $stopPath) {{ break }}\n\
           $n = $t.Result\n\
           if ($n -le 0) {{ break }}\n\
           $client.Write($buf, 0, $n); $client.Flush()\n\
         }}\n\
         if (-not $proc.HasExited) {{ $proc.Kill() }}\n\
         $client.Dispose()\n\
         Remove-Item -LiteralPath $stopPath -ErrorAction SilentlyContinue\n",
        stopfile.display(),
        cmd.display(),
        device,
        pick,
        format!("{}.log", ps1.display()),
        pipe_name,
        cmd.display(),
        device,
        pick,
        pcap.display()
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
        unsafe { CloseHandle(ph) };
        return Err("提权失败或用户取消了 UAC".into());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let got = Arc::new(AtomicUsize::new(0));
    {
        let app2 = app.clone();
        let st2 = stop.clone();
        let g2 = got.clone();
        let handle = PipeHandle(ph);
        std::thread::spawn(move || reader_loop_pipe(app2, handle, st2, g2));
    }
    if let Ok(mut g) = CAP.lock() {
        *g = Some(Cap { stop, pcap: pcap.clone(), stopfile: stopfile.clone(), got });
    }
    let _ = cmd;
    return Ok(json!({ "pcap": pcap.to_string_lossy(), "device": device, "pipe": pipe_name }));
}

fn take_cap() -> Option<Cap> {
    if let Ok(mut g) = CAP.lock() {
        g.take()
    } else {
        None
    }
}

#[tauri::command]
pub async fn usbpcap_stop(app: tauri::AppHandle) -> Result<(), String> {
    let Some(c) = take_cap() else { return Ok(()); };
    c.stop.store(true, Ordering::Relaxed);
    let _ = std::fs::write(&c.stopfile, b"stop");
    std::thread::sleep(Duration::from_millis(600));
    // 管道没连上（一条记录都没收到）→ 回退：脚本会把 pcap 写到文件，这里再解析
    if c.got.load(Ordering::Relaxed) == 0 {
        let app2 = app.clone();
        let path = c.pcap.clone();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Emitter;
            for _ in 0..50 {
                if let Ok(mut f) = std::fs::File::open(&path) {
                    let mut parser = Parser::new();
                    let mut buf = [0u8; 65536];
                    let mut batch: Vec<Value> = Vec::new();
                    loop {
                        match f.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                batch.extend(parser.feed(&buf[..n]));
                                if batch.len() >= 500 {
                                    let _ = app2.emit("usb://cap", json!({ "records": batch }));
                                    batch = Vec::new();
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    if !batch.is_empty() {
                        let _ = app2.emit("usb://cap", json!({ "records": batch }));
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = app2.emit("usb://cap-end", json!({}));
        });
    }
    Ok(())
}

fn reader_loop_pipe(app: tauri::AppHandle, handle: PipeHandle, _stop: Arc<AtomicBool>, got: Arc<AtomicUsize>) {
    use tauri::Emitter;
    // 等提权脚本连上来（阻塞；脚本连不上时这个线程会一直等，进程退出时一起结束）
    unsafe {
        let ok = ConnectNamedPipe(handle.0, std::ptr::null_mut());
        if ok == 0 && GetLastError() != 535 {
            // 535 = ERROR_PIPE_CONNECTED（已经连上）
            CloseHandle(handle.0);
            let _ = app.emit("usb://cap-end", json!({}));
            return;
        }
    }
    let mut file = unsafe { std::fs::File::from_raw_handle(handle.0 as RawHandle) };
    let mut parser = Parser::new();
    let mut buf = [0u8; 65536];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let recs = parser.feed(&buf[..n]);
                if !recs.is_empty() {
                    got.fetch_add(recs.len(), Ordering::Relaxed);
                    let _ = app.emit("usb://cap", json!({ "records": recs }));
                }
            }
            Err(_) => break,
        }
    }
    let _ = app.emit("usb://cap-end", json!({}));
}

#[tauri::command]
pub async fn usbpcap_open(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let mut f = std::fs::File::open(&path).map_err(|e| format!("打开失败：{e}"))?;
        let mut parser = Parser::new();
        let mut buf = [0u8; 65536];
        let mut batch: Vec<Value> = Vec::new();
        let mut total = 0usize;
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    batch.extend(parser.feed(&buf[..n]));
                    total += batch.len();
                    if batch.len() >= 500 {
                        let _ = app.emit("usb://cap", json!({ "records": batch }));
                        batch = Vec::new();
                    }
                }
                Err(e) => return Err(format!("读取失败：{e}")),
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("usb://cap", json!({ "records": batch }));
        }
        let _ = app.emit("usb://cap-end", json!({}));
        Ok(json!({ "records": total }))
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
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
