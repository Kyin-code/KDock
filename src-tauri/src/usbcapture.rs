//! USBPcap 抓包（可选组件）。
//!
//! 驱动与命令行工具都来自 USBPcap 官方安装包：
//!   - USBPcapDriver：GPLv2（本程序不链接、不打包，只调用用户自己安装的组件）
//!   - USBPcapCMD：BSD-2-Clause（运行时调用，解析它生成的 pcap）
//!
//! 实时性：USBPcapCMD 用 `-o <file>` 时对文件独占且缓冲；改用 `-o -`（stdout）并由提权脚本把
//! stdout 重定向到一个普通文件 —— 这个文件是**边写边可读**的，主程序 tail 它就能实时解析。

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const EXE_EXTRA: &str = "C:\\Program Files\\USBPcap;C:\\Program Files (x86)\\USBPcap";

struct Cap {
    stop: Arc<AtomicBool>,
    stopfile: PathBuf,
}

static CAP: LazyLock<Mutex<Option<Cap>>> = LazyLock::new(|| Mutex::new(None));

fn find_cmd() -> Option<PathBuf> {
    crate::env_setup::find_tool("USBPcapCMD.exe", EXE_EXTRA)
}

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开一个 USBPcap 控制设备，只用于判定驱动是否已经加载。
///
/// 不能把“整个系统还有一个待重启的 Windows 更新”当成 USBPcap 待重启：
/// 两者没有关系，而且 CBS 的 RebootPending 会在任何组件更新后出现。设备
/// 能打开（或因为当前进程没提权而返回 ACCESS_DENIED）就说明驱动已经上线；
/// 只有设备不存在才可能是装完还没重启。
#[cfg(windows)]
fn usbpcap_device_state(path: &str) -> UsbPcapDeviceState {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND,
        ERROR_PATH_NOT_FOUND, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let p = w(path);
    let h = unsafe {
        CreateFileW(
            p.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        return match err {
            // 节点存在，只是普通权限不能直接读控制端点；实际抓包会走 UAC。
            ERROR_ACCESS_DENIED => UsbPcapDeviceState::NeedsElevation,
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => UsbPcapDeviceState::Missing,
            _ => UsbPcapDeviceState::Unknown(err),
        };
    }
    unsafe { CloseHandle(h) };
    UsbPcapDeviceState::Ready
}

#[cfg(not(windows))]
fn usbpcap_device_state(_path: &str) -> UsbPcapDeviceState {
    UsbPcapDeviceState::Missing
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UsbPcapDeviceState {
    Ready,
    NeedsElevation,
    Missing,
    Unknown(u32),
}

impl UsbPcapDeviceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NeedsElevation => "elevation-required",
            Self::Missing => "missing",
            Self::Unknown(_) => "unknown",
        }
    }
}

/// 汇总每个根 Hub 的设备探测结果。
///
/// - 任意一个设备处于 ready / elevation-required，就说明驱动已经加载；
/// - 有未知错误时不要贸然说“缺驱动”，保留 unknown 供 UI 报具体错误；
/// - 只有全部设备都 missing 时才可能是安装后尚未重启。
fn driver_status(states: &[UsbPcapDeviceState]) -> (bool, &'static str) {
    if states.iter().any(|state| *state == UsbPcapDeviceState::Ready) {
        return (true, "ready");
    }
    if states.iter().any(|state| *state == UsbPcapDeviceState::NeedsElevation) {
        return (true, "elevation-required");
    }
    if states.is_empty() || states.iter().any(|state| matches!(state, UsbPcapDeviceState::Unknown(_))) {
        return (false, "unknown");
    }
    (false, "missing")
}

pub(crate) struct UsbpcapStatus {
    pub cmd: Option<PathBuf>,
    pub command_installed: bool,
    pub driver_ready: bool,
    pub driver_state: &'static str,
    pub root_hubs: usize,
    pub devices: Vec<String>,
    pub device_states: Vec<&'static str>,
}

/// 统一的只读状态探测：环境配置和“监听”页共用同一套判断。
pub(crate) fn status_snapshot() -> UsbpcapStatus {
    let cmd = find_cmd();
    let hubs = root_hub_count();
    let devices: Vec<String> = (1..=hubs.max(1))
        .map(|n| format!("\\\\.\\USBPcap{}", n))
        .collect();
    let states: Vec<UsbPcapDeviceState> = devices
        .iter()
        .map(|path| usbpcap_device_state(path))
        .collect();
    let (driver_ready, driver_state) = driver_status(&states);
    UsbpcapStatus {
        command_installed: cmd.is_some(),
        cmd,
        driver_ready,
        driver_state,
        root_hubs: hubs,
        devices,
        device_states: states.iter().map(|s| s.as_str()).collect(),
    }
}

/// USB 根 Hub 数量（USBPcap 每个根 Hub 一个 \\.\USBPcapN 控制设备）
fn root_hub_count() -> usize {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
    let mut n = 0usize;
    unsafe {
        let h = SetupDiGetClassDevsW(
            std::ptr::null(),
            w("USB").as_ptr(),
            std::ptr::null_mut(),
            DIGCF_PRESENT | DIGCF_ALLCLASSES,
        );
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
            if SetupDiGetDeviceInstanceIdW(h, &info, buf.as_mut_ptr(), buf.len() as u32, &mut need)
                == 0
            {
                continue;
            }
            let s = String::from_utf16_lossy(
                &buf[..((need as usize).saturating_sub(1)).min(buf.len())],
            )
            .to_uppercase();
            if s.starts_with("USB\\ROOT_HUB") {
                n += 1;
            }
        }
        SetupDiDestroyDeviceInfoList(h);
    }
    n
}

/// pcap 解析：USBPcap 的 linktype = 249，每条记录前是 27/28 字节伪头
struct Parser {
    header_done: bool,
    buf: Vec<u8>,
}

impl Parser {
    fn new() -> Self {
        Self {
            header_done: false,
            buf: Vec::new(),
        }
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
                self.buf.clear();
                return out;
            }
            pos = 24;
            self.header_done = true;
        }
        while self.buf.len() >= pos + 16 {
            let ts_sec = u32::from_le_bytes([
                self.buf[pos],
                self.buf[pos + 1],
                self.buf[pos + 2],
                self.buf[pos + 3],
            ]);
            let ts_usec = u32::from_le_bytes([
                self.buf[pos + 4],
                self.buf[pos + 5],
                self.buf[pos + 6],
                self.buf[pos + 7],
            ]);
            let incl = u32::from_le_bytes([
                self.buf[pos + 8],
                self.buf[pos + 9],
                self.buf[pos + 10],
                self.buf[pos + 11],
            ]) as usize;
            if incl > 4 * 1024 * 1024 {
                break;
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
            v["data"] = json!(crate::base64_encode(&payload[8..]));
        }
    }
    Some(v)
}

/// 列表 / 安装状态
#[tauri::command]
pub async fn usbpcap_info() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let status = status_snapshot();
        json!({
            // installed 保留给旧调用方；驱动真正可用的条件要看 driverReady。
            "installed": status.command_installed && status.driver_ready,
            "commandInstalled": status.command_installed,
            "driverReady": status.driver_ready,
            "driverState": status.driver_state,
            "cmd": status.cmd.map(|p| p.to_string_lossy().to_string()),
            "rootHubs": status.root_hubs,
            // 兼容旧前端：驱动未上线时才提示重启；不再参考系统级更新状态。
            "rebootPending": status.command_installed && !status.driver_ready,
            "devices": status.devices,
            "states": status.device_states,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))
}

fn take_cap() -> Option<Cap> {
    if let Ok(mut g) = CAP.lock() {
        g.take()
    } else {
        None
    }
}

#[tauri::command]
pub async fn usbpcap_start(
    app: tauri::AppHandle,
    device: String,
    devices: Option<String>,
) -> Result<Value, String> {
    if let Some(c) = take_cap() {
        c.stop.store(true, Ordering::Relaxed);
        let _ = std::fs::write(&c.stopfile, b"stop");
    }
    let cmd = find_cmd().ok_or_else(|| "没装 USBPcap —— 到「环境配置」里装一下".to_string())?;
    let filter = devices.unwrap_or_default().trim().to_string();
    let pick = if filter.is_empty() {
        "-A".to_string()
    } else {
        format!("--devices {filter}")
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pcap = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.pcap"));
    let stopfile = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.stop"));
    let errfile = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.err"));
    let ps1 = std::env::temp_dir().join(format!("kdock-usbpcap-{stamp}.ps1"));
    let _ = std::fs::remove_file(&pcap);
    let _ = std::fs::remove_file(&stopfile);
    let _ = std::fs::remove_file(&errfile);

    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         $p = Start-Process -FilePath '{}' -ArgumentList '-d','{}','{}','-o','-' -PassThru -WindowStyle Hidden -RedirectStandardOutput '{}' -RedirectStandardError '{}'\n\
         while (-not (Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 200 }}\n\
         if (-not $p.HasExited) {{ Stop-Process -Id $p.Id -Force }}\n\
         Remove-Item -LiteralPath '{}' -ErrorAction SilentlyContinue\n",
        cmd.display(),
        device,
        pick,
        pcap.display(),
        errfile.display(),
        stopfile.display(),
        stopfile.display()
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

    let stop = Arc::new(AtomicBool::new(false));
    {
        let app2 = app.clone();
        let st2 = stop.clone();
        let file = pcap.clone();
        let stop_file = stopfile.clone();
        std::thread::spawn(move || reader_loop(app2, file, stop_file, st2));
    }
    if let Ok(mut g) = CAP.lock() {
        *g = Some(Cap {
            stop,
            stopfile: stopfile.clone(),
        });
    }
    Ok(json!({ "pcap": pcap.to_string_lossy(), "device": device }))
}

#[tauri::command]
pub async fn usbpcap_stop() -> Result<(), String> {
    if let Some(c) = take_cap() {
        c.stop.store(true, Ordering::Relaxed);
        let _ = std::fs::write(&c.stopfile, b"stop");
    }
    Ok(())
}

fn reader_loop(app: tauri::AppHandle, file: PathBuf, stopfile: PathBuf, stop: Arc<AtomicBool>) {
    use tauri::Emitter;
    // 文件由提权脚本的 stdout 重定向创建（边写边可读）；等它出现
    let mut f = None;
    for _ in 0..100 {
        match std::fs::File::open(&file) {
            Ok(fh) => {
                f = Some(fh);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let Some(mut f) = f else {
        let _ = app.emit(
            "usb://cap-end",
            json!({ "error": "抓包文件没有创建，请看 %TEMP% 下的 kdock-usbpcap-*.err" }),
        );
        return;
    };
    let mut parser = Parser::new();
    let mut buf = [0u8; 65536];
    let mut stop_started: Option<Instant> = None;
    loop {
        match f.read(&mut buf) {
            Ok(0) => {
                if stop.load(Ordering::Relaxed) {
                    // 停止文件由提权脚本在杀掉 USBPcapCMD 后删除。等它消失，确保最后的
                    // stdio 缓冲已经落盘，而不是在 EOF 时提前丢掉尾部记录。
                    let t0 = *stop_started.get_or_insert_with(Instant::now);
                    let elapsed = t0.elapsed();
                    if (!stopfile.exists() && elapsed >= Duration::from_millis(250))
                        || elapsed >= Duration::from_secs(8)
                    {
                        loop {
                            match f.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    let recs = parser.feed(&buf[..n]);
                                    for chunk in recs.chunks(256) {
                                        let _ = app.emit("usb://cap", json!({ "records": chunk }));
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                } else {
                    std::thread::sleep(Duration::from_millis(60));
                }
            }
            Ok(n) => {
                let recs = parser.feed(&buf[..n]);
                // 每次从文件读到新数据就立即推送。不要等凑满 200 条，否则低流量设备
                // （例如串口打印）会长时间什么都不显示。
                for chunk in recs.chunks(256) {
                    let _ = app.emit("usb://cap", json!({ "records": chunk }));
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

    #[test]
    fn driver_status_accepts_elevation_required_device() {
        // 普通权限打开控制设备会得到 ACCESS_DENIED。设备节点已经存在，
        // 抓包本身会提权，所以这里必须算“已就绪”，不能再要求重启。
        assert_eq!(
            driver_status(&[UsbPcapDeviceState::Missing, UsbPcapDeviceState::NeedsElevation]),
            (true, "elevation-required")
        );
        assert_eq!(
            driver_status(&[UsbPcapDeviceState::NeedsElevation]),
            (true, "elevation-required")
        );
    }

    #[test]
    fn driver_status_reports_ready_before_elevation() {
        assert_eq!(
            driver_status(&[UsbPcapDeviceState::NeedsElevation, UsbPcapDeviceState::Ready]),
            (true, "ready")
        );
    }

    #[test]
    fn driver_status_only_calls_all_missing_a_pending_reboot() {
        assert_eq!(
            driver_status(&[UsbPcapDeviceState::Missing, UsbPcapDeviceState::Missing]),
            (false, "missing")
        );
        assert_eq!(driver_status(&[]), (false, "unknown"));
        assert_eq!(
            driver_status(&[UsbPcapDeviceState::Missing, UsbPcapDeviceState::Unknown(87)]),
            (false, "unknown")
        );
    }

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

        let mut b = Vec::new();
        b.extend_from_slice(&27u16.to_le_bytes());
        b.extend_from_slice(&1u64.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.push(1);
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&5u16.to_le_bytes());
        b.push(0x81);
        b.push(3);
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&[0xAA, 0xBB]);
        file.extend_from_slice(&pkt(100, &b));

        let mut c = Vec::new();
        c.extend_from_slice(&28u16.to_le_bytes());
        c.extend_from_slice(&2u64.to_le_bytes());
        c.extend_from_slice(&0u32.to_le_bytes());
        c.extend_from_slice(&0u16.to_le_bytes());
        c.push(0);
        c.extend_from_slice(&1u16.to_le_bytes());
        c.extend_from_slice(&5u16.to_le_bytes());
        c.push(0x00);
        c.push(2);
        c.extend_from_slice(&8u32.to_le_bytes());
        c.push(0);
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

    #[test]
    fn parses_incremental_stream() {
        let mut file = Vec::new();
        file.extend_from_slice(&0xa1b2c3d4u32.to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&4u16.to_le_bytes());
        file.extend_from_slice(&0i32.to_le_bytes());
        file.extend_from_slice(&0u32.to_le_bytes());
        file.extend_from_slice(&65535u32.to_le_bytes());
        file.extend_from_slice(&249u32.to_le_bytes());

        let mut b = Vec::new();
        b.extend_from_slice(&27u16.to_le_bytes());
        b.extend_from_slice(&1u64.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.push(1);
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&5u16.to_le_bytes());
        b.push(0x81);
        b.push(3);
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&[0x10, 0x20, 0x30]);
        file.extend_from_slice(&pkt(102, &b));

        let mut parser = Parser::new();
        let mut records = Vec::new();
        for chunk in file.chunks(3) {
            records.extend(parser.feed(chunk));
        }
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0]["data"],
            crate::base64_encode(&[0x10, 0x20, 0x30])
        );
    }
}
