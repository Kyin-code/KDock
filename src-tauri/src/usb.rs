//! USB 诊断（免驱）：枚举 USB 设备 + 读 Hub 端口 / 设备描述符 / 配置 / 接口 / 端点。
//!
//! 走的是 Windows 自带的两套 API：
//!   - SetupAPI：列出所有 USB 设备（友好名、VID/PID、驱动服务、位置、问题码）
//!   - Hub IOCTL：打开根 Hub，逐端口拿连接状态、速度、设备描述符、配置描述符
//!
//! **不装任何驱动、不挂钩子**：这就是 Bus Hound / USBTreeView 的"设备视图"那一半；
//! 传输级的抓包要 USBPcap 这类过滤驱动，不在这个模块里。

use serde_json::{json, Value};

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
use windows_sys::Win32::Devices::Usb::*;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::DeviceIoControl;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn reg_string(h: HDEVINFO, info: &SP_DEVINFO_DATA, prop: u32) -> Option<String> {
    let mut ty = 0u32;
    let mut buf = [0u16; 512];
    let mut need = 0u32;
    let ok = SetupDiGetDeviceRegistryPropertyW(
        h,
        info,
        prop,
        &mut ty,
        buf.as_mut_ptr() as *mut u8,
        (buf.len() * 2) as u32,
        &mut need,
    );
    if ok == 0 {
        return None;
    }
    let n = if need > 0 {
        ((need as usize) / 2).min(buf.len())
    } else {
        0
    };
    let s = String::from_utf16_lossy(&buf[..n])
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if s.is_empty() { None } else { Some(s) }
}

unsafe fn instance_id(h: HDEVINFO, info: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buf = [0u16; 512];
    let mut need = 0u32;
    let ok = SetupDiGetDeviceInstanceIdW(
        h,
        info,
        buf.as_mut_ptr(),
        buf.len() as u32,
        &mut need,
    );
    if ok == 0 {
        return None;
    }
    let n = ((need as usize).saturating_sub(1)).min(buf.len());
    let s = String::from_utf16_lossy(&buf[..n]).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// `USB\VID_0925&PID_3881\...` → (0925, 3881)
fn vid_pid(instance: &str) -> (Option<String>, Option<String>) {
    let up = instance.to_uppercase();
    let get = |tag: &str| -> Option<String> {
        let i = up.find(tag)? + tag.len();
        let v: String = up[i..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if v.len() == 4 { Some(v) } else { None }
    };
    (get("VID_"), get("PID_"))
}

/// 扁平设备列表（SetupAPI）：不打开设备，所以普通权限也能跑
fn list_devices() -> Vec<Value> {
    let mut out = Vec::new();
    unsafe {
        let h = SetupDiGetClassDevsW(std::ptr::null(), wide("USB").as_ptr(), std::ptr::null_mut(), DIGCF_PRESENT | DIGCF_ALLCLASSES);
        if h == -1isize {
            return out;
        }
        let mut info: SP_DEVINFO_DATA = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        let mut i = 0u32;
        while SetupDiEnumDeviceInfo(h, i, &mut info) != 0 {
            i += 1;
            let id = match instance_id(h, &info) { Some(v) => v, None => continue };
            let (vid, pid) = vid_pid(&id);
            let name = reg_string(h, &info, SPDRP_FRIENDLYNAME)
                .or_else(|| reg_string(h, &info, SPDRP_DEVICEDESC))
                .unwrap_or_default();
            let class = reg_string(h, &info, SPDRP_CLASS).unwrap_or_default();
            let service = reg_string(h, &info, SPDRP_SERVICE).unwrap_or_default();
            let location = reg_string(h, &info, SPDRP_LOCATION_INFORMATION).unwrap_or_default();
            let manufacturer = reg_string(h, &info, SPDRP_MFG).unwrap_or_default();
            // 问题码：22=已停用、28=没有驱动、10=无法启动、43=驱动故障…
            let mut node_status = 0u32;
            let mut problem = 0u32;
            let cr = CM_Get_DevNode_Status(&mut node_status, &mut problem, info.DevInst, 0);
            let problem = if cr == 0 { problem } else { 0 };
            out.push(json!({
                "instance": id,
                "name": name,
                "vid": vid,
                "pid": pid,
                "class": class,
                "service": service,
                "location": location,
                "manufacturer": manufacturer,
                "problem": problem,
            }));
        }
        SetupDiDestroyDeviceInfoList(h);
    }
    out
}

/// 系统里的串口（COM），带 USB VID/PID / 序列号 / 厂商 / 产品名
fn serial_ports() -> Vec<Value> {
    match serialport::available_ports() {
        Ok(list) => list
            .into_iter()
            .map(|p| {
                let mut v = json!({ "port": p.port_name, "type": "unknown" });
                match p.port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        v["type"] = json!("usb");
                        v["vid"] = json!(format!("{:04X}", info.vid));
                        v["pid"] = json!(format!("{:04X}", info.pid));
                        v["serial"] = json!(info.serial_number);
                        v["manufacturer"] = json!(info.manufacturer);
                        v["product"] = json!(info.product);
                    }
                    serialport::SerialPortType::PciPort => v["type"] = json!("pci"),
                    serialport::SerialPortType::BluetoothPort => v["type"] = json!("bluetooth"),
                    serialport::SerialPortType::Unknown => {}
                }
                v
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

unsafe fn hub_interface_paths() -> Vec<(String, String)> {
    // (instance_id, device_interface_path)
    let mut out = Vec::new();
    let h = SetupDiGetClassDevsW(
        &GUID_DEVINTERFACE_USB_HUB,
        std::ptr::null(),
        std::ptr::null_mut(),
        DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
    );
    if h == -1isize {
        return out;
    }
    let mut iface: SP_DEVICE_INTERFACE_DATA = std::mem::zeroed();
    iface.cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
    let mut i = 0u32;
    while SetupDiEnumDeviceInterfaces(h, std::ptr::null(), &GUID_DEVINTERFACE_USB_HUB, i, &mut iface) != 0 {
        i += 1;
        let mut need = 0u32;
        SetupDiGetDeviceInterfaceDetailW(h, &iface, std::ptr::null_mut(), 0, &mut need, std::ptr::null_mut());
        if need == 0 { continue; }
        let mut buf = vec![0u8; need as usize];
        let detail = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
        (*detail).cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
        let mut devinfo: SP_DEVINFO_DATA = std::mem::zeroed();
        devinfo.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        if SetupDiGetDeviceInterfaceDetailW(h, &iface, detail, need, &mut need, &mut devinfo) == 0 {
            continue;
        }
        // DevicePath 在结构体里只声明了 1 个 wchar，真实字符串跟在后面：
        // cbSize(4) + 对齐（64 位再 4 字节）之后就是路径起点，长度以 need 为准。
        // 实测：64 位下 cbSize 要填 8，但 DevicePath 的字符串仍从偏移 4 开始（后面 4 字节是填充）
        let off = 4usize;
        let p = buf.as_ptr().add(off) as *const u16;
        let max = need as usize;
        let mut len = 0usize;
        while off + (len + 1) * 2 <= max && *p.add(len) != 0 { len += 1; }
        let units: Vec<u16> = (0..len).map(|i| *p.add(i)).collect();
        let path = String::from_utf16_lossy(&units);
        let inst = instance_id(h, &devinfo).unwrap_or_default();
        out.push((inst, path));
    }
    SetupDiDestroyDeviceInfoList(h);
    out
}

fn speed_name(s: u8) -> &'static str {
    match s {
        0 => "Low (1.5 Mbit/s)",
        1 => "Full (12 Mbit/s)",
        2 => "High (480 Mbit/s)",
        3 => "Super (5+ Gbit/s)",
        _ => "?",
    }
}

unsafe fn read_config_descriptor(hub: HANDLE, port: u32) -> Option<Value> {
    const CFG: u8 = 2;
    let mut buf = vec![0u8; 4096];
    let req = buf.as_mut_ptr() as *mut USB_DESCRIPTOR_REQUEST;
    (*req).ConnectionIndex = port;
    (*req).SetupPacket.bmRequest = 0x80;
    (*req).SetupPacket.bRequest = 0x06; // GET_DESCRIPTOR
    (*req).SetupPacket.wValue = (CFG as u16) << 8;
    (*req).SetupPacket.wIndex = 0;
    (*req).SetupPacket.wLength = 4096;
    let mut ret = 0u32;
    let data_off = std::mem::size_of::<USB_DESCRIPTOR_REQUEST>() - 1;
    let ok = DeviceIoControl(
        hub,
        IOCTL_USB_GET_DESCRIPTOR_FROM_NODE_CONNECTION,
        req as *const _,
        buf.len() as u32,
        req as *mut _,
        buf.len() as u32,
        &mut ret,
        std::ptr::null_mut(),
    );
    if ok == 0 || ret as usize <= data_off + 8 {
        return None;
    }
    let data = &buf[data_off..ret as usize];
    if data.len() < 9 || data[1] != CFG {
        return None;
    }
    let total = u16::from_le_bytes([data[2], data[3]]) as usize;
    let total = total.min(data.len());
    let mut ifaces = Vec::new();
    let mut i = data[0] as usize; // bLength
    let mut cur: Option<(u8, u8, u8, Vec<Value>)> = None;
    while i + 2 <= total {
        let blen = data[i] as usize;
        if blen < 2 || i + blen > total { break; }
        let dtype = data[i + 1];
        match dtype {
            4 => { // interface
                if let Some((n, alt, cls, eps)) = cur.take() {
                    ifaces.push(json!({ "number": n, "alt": alt, "class": cls, "endpoints": eps }));
                }
                cur = Some((data[i + 2], data[i + 3], data[i + 5], Vec::new()));
            }
            5 => { // endpoint
                if let Some((_, _, _, eps)) = cur.as_mut() {
                    let addr = data[i + 2];
                    let attr = data[i + 3];
                    let mps = u16::from_le_bytes([data[i + 4], data[i + 5]]);
                    let interval = data[i + 6];
                    let kind = match attr & 0x03 {
                        0 => "control", 1 => "isochronous", 2 => "bulk", 3 => "interrupt", _ => "?",
                    };
                    eps.push(json!({
                        "address": format!("0x{:02X}", addr),
                        "ep": addr & 0x0F,
                        "dir": if addr & 0x80 != 0 { "IN" } else { "OUT" },
                        "type": kind,
                        "maxPacket": mps,
                        "interval": interval,
                    }));
                }
            }
            _ => {}
        }
        i += blen;
    }
    if let Some((n, alt, cls, eps)) = cur.take() {
        ifaces.push(json!({ "number": n, "alt": alt, "class": cls, "endpoints": eps }));
    }
    Some(json!({
        "numInterfaces": data[4],
        "selfPowered": data[7] & 0x40 != 0,
        "maxPowerMa": data[8] as u32 * 2,
        "interfaces": ifaces,
    }))
}

/// 打开一个 Hub，逐端口读连接信息；本身是 Hub 的端口递归下去
unsafe fn read_hub(inst: &str, path: &str, depth: u32, budget: &mut u32) -> Result<Value, String> {
    if depth > 6 || *budget == 0 { return Err("递归过深".into()); }
    *budget -= 1;
    let h = CreateFileW(
        wide(path).as_ptr(),
        GENERIC_WRITE,
        FILE_SHARE_WRITE | FILE_SHARE_READ,
        std::ptr::null_mut(),
        OPEN_EXISTING,
        0,
        std::ptr::null_mut(),
    );
    if h == INVALID_HANDLE_VALUE {
        return Err(format!("CreateFile err={} path={}", GetLastError(), path));
    }
    let mut node: USB_NODE_INFORMATION = std::mem::zeroed();
    let mut ret = 0u32;
    let ok = DeviceIoControl(
        h,
        IOCTL_USB_GET_NODE_INFORMATION,
        &mut node as *mut USB_NODE_INFORMATION as *const _,
        std::mem::size_of::<USB_NODE_INFORMATION>() as u32,
        &mut node as *mut USB_NODE_INFORMATION as *mut _,
        std::mem::size_of::<USB_NODE_INFORMATION>() as u32,
        &mut ret,
        std::ptr::null_mut(),
    );
    if ok == 0 {
        let e = GetLastError();
        CloseHandle(h);
        return Err(format!("IOCTL_USB_GET_NODE_INFORMATION err={e}"));
    }
    let ports = node.u.HubInformation.HubDescriptor.bNumberOfPorts;
    let mut list = Vec::new();
    for port in 1..=ports as u32 {
        let mut buf = vec![0u8; 2048];
        let ci = buf.as_mut_ptr() as *mut USB_NODE_CONNECTION_INFORMATION_EX;
        (*ci).ConnectionIndex = port;
        let ok = DeviceIoControl(
            h,
            IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX,
            ci as *const _,
            buf.len() as u32,
            ci as *mut _,
            buf.len() as u32,
            &mut ret,
            std::ptr::null_mut(),
        );
        if ok == 0 { continue; }
        let ci = &*ci;
        if ci.ConnectionStatus != 1 { continue; } // DeviceConnected
        // packed struct：用 read_unaligned 整体拷到本地再取字段
        let d: USB_DEVICE_DESCRIPTOR = std::ptr::read_unaligned(std::ptr::addr_of!(ci.DeviceDescriptor));
        // packed 结构体：字段按值拷出来再用（直接取引用会报 unaligned）
        let (vid, pid, bcd_usb, bcd_dev, dclass, dsub, dproto, ncfg) = (
            d.idVendor, d.idProduct, d.bcdUSB, d.bcdDevice,
            d.bDeviceClass, d.bDeviceSubClass, d.bDeviceProtocol, d.bNumConfigurations,
        );
        let mut entry = json!({
            "port": port,
            "speed": speed_name(ci.Speed),
            "vid": format!("{:04X}", vid),
            "pid": format!("{:04X}", pid),
            "bcdUSB": format!("{:04X}", bcd_usb),
            "bcdDevice": format!("{:04X}", bcd_dev),
            "class": dclass,
            "subClass": dsub,
            "protocol": dproto,
            "isHub": ci.DeviceIsHub,
            "numConfigs": ncfg,
        });
        if let Some(cfg) = read_config_descriptor(h, port) {
            entry["config"] = cfg;
        }
        if ci.DeviceIsHub {
            let mut name_buf = vec![0u8; 1024];
            let cn = name_buf.as_mut_ptr() as *mut USB_NODE_CONNECTION_NAME;
            (*cn).ConnectionIndex = port;
            let ok = DeviceIoControl(
                h,
                IOCTL_USB_GET_NODE_CONNECTION_NAME,
                cn as *const _,
                name_buf.len() as u32,
                cn as *mut _,
                name_buf.len() as u32,
                &mut ret,
                std::ptr::null_mut(),
            );
            if ok != 0 {
                // packed struct：NodeName 用原始指针读，别取引用
                let wp = std::ptr::addr_of!((*cn).NodeName) as *const u16;
                let mut n = 0usize;
                while n < 256 && *wp.add(n) != 0 { n += 1; }
                let units: Vec<u16> = (0..n).map(|i| *wp.add(i)).collect();
                let name = String::from_utf16_lossy(&units);
                if !name.is_empty() {
                    if let Ok(sub) = read_hub("", &name, depth + 1, budget) {
                        entry["hub"] = sub;
                    }
                }
            }
        }
        list.push(entry);
    }
    CloseHandle(h);
    Ok(json!({ "instance": inst, "ports": list }))
}


/* ────────────── 串口原始数据（诊断用）：独立打开一个 COM，RX/TX 逐段回传 ────────────── */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

struct Diag {
    stop: Arc<AtomicBool>,
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    name: String,
}

static DIAG: LazyLock<Mutex<Option<Diag>>> = LazyLock::new(|| Mutex::new(None));

fn parse_hex(s: &str) -> Result<Vec<u8>, String> {
    let mut clean = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '0' && it.peek() == Some(&'x') { it.next(); continue; }
        if c.is_ascii_hexdigit() { clean.push(c); }
    }
    if clean.len() % 2 != 0 { return Err("HEX 长度不是偶数".into()); }
    (0..clean.len() / 2)
        .map(|i| u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// 打开一个串口做原始数据抓取（和传输页那条主连接互不影响）
#[tauri::command]
pub async fn serial_diag_open(app: tauri::AppHandle, port: String, baud: u32) -> Result<Value, String> {
    let _ = serial_diag_close();
    let sp = serialport::new(&port, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开 {port} 失败：{e}（被别的程序占用？）"))?;
    let shared: Arc<Mutex<Box<dyn serialport::SerialPort>>> = Arc::new(Mutex::new(sp));
    let stop = Arc::new(AtomicBool::new(false));
    {
        let app2 = app.clone();
        let sh = shared.clone();
        let st = stop.clone();
        let name = port.clone();
        std::thread::spawn(move || {
            use tauri::Emitter;
            let mut buf = [0u8; 8192];
            loop {
                if st.load(Ordering::Relaxed) {
                    break;
                }
                let r = {
                    let mut g = match sh.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    g.read(&mut buf)
                };
                match r {
                    Ok(n) if n > 0 => {
                        let _ = app2.emit(
                            "usb://serial-rx",
                            json!({ "port": name, "data": crate::base64_encode(&buf[..n]) }),
                        );
                    }
                    Ok(_) => {}
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => {
                        let _ = app2.emit("usb://serial-err", json!({ "port": name, "msg": e.to_string() }));
                        break;
                    }
                }
            }
        });
    }
    if let Ok(mut g) = DIAG.lock() {
        *g = Some(Diag { stop, port: shared, name: port.clone() });
    }
    Ok(json!({ "port": port, "baud": baud }))
}

/// 关闭抓取用的串口
#[tauri::command]
pub fn serial_diag_close() -> Result<(), String> {
    if let Ok(mut g) = DIAG.lock() {
        if let Some(d) = g.take() {
            d.stop.store(true, Ordering::Relaxed);
            let _ = d.name;
        }
    }
    Ok(())
}

/// 往抓取用的串口写数据（HEX 或文本）
#[tauri::command]
pub fn serial_diag_write(data: String, hex: bool) -> Result<usize, String> {
    let bytes: Vec<u8> = if hex { parse_hex(&data)? } else { data.into_bytes() };
    let g = DIAG.lock().map_err(|_| "状态锁失败".to_string())?;
    let d = g.as_ref().ok_or_else(|| "没有打开的串口".to_string())?;
    let mut p = d.port.lock().map_err(|_| "串口锁失败".to_string())?;
    p.write_all(&bytes).map_err(|e| format!("发送失败：{e}"))?;
    let _ = p.flush();
    Ok(bytes.len())
}

/// 同步快照：设备列表 + Hub 树（Hub 部分需要管理员）
pub fn usb_snapshot() -> Value {
    let devices = list_devices();
    let hubs_paths = unsafe { hub_interface_paths() };
    let mut hubs = Vec::new();
    let mut warnings = Vec::new();
    let mut budget = 64u32;
    for (inst, path) in &hubs_paths {
        match unsafe { read_hub(inst, path, 0, &mut budget) } {
            Ok(v) => hubs.push(v),
            Err(e) => warnings.push(format!("打不开 Hub：{inst} → {e}")),
        }
    }
    if hubs.is_empty() {
        warnings.push("没读到 Hub 端口（普通权限下 Windows 不允许打开 Hub）。下面的设备列表仍然可用；要看端口/描述符点「以管理员身份读取」。".into());
    }
    json!({
        "devices": devices,
        "serial": serial_ports(),
        "hubs": hubs,
        "warnings": warnings,
        "admin": !hubs.is_empty(),
        "needAdmin": hubs.is_empty(),
    })
}

/// 提权子进程用：把快照写到文件（不经过 Tauri）
pub fn usb_dump_to(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("缺少输出路径".into());
    }
    let v = usb_snapshot();
    let txt = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| format!("写文件失败：{e}"))
}

/// 普通权限：设备列表一定有；Hub 端口/描述符可能读不到（needAdmin=true）
#[tauri::command]
pub async fn usb_diag() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(usb_snapshot)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))
}

/// 提权读取：拉起自己（--usb-dump），弹一次 UAC，把带端口/描述符的 JSON 读回来
#[tauri::command]
pub async fn usb_diag_elevated() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = std::env::current_exe().map_err(|e| format!("取 exe 路径失败：{e}"))?;
        let out = std::env::temp_dir().join(format!("kdock-usb-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let ps = format!(
            "$p = Start-Process -FilePath '{}' -ArgumentList '--usb-dump','{}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode",
            exe.display(),
            out.display()
        );
        let st = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
            .status()
            .map_err(|e| format!("启动提权进程失败：{e}"))?;
        if !st.success() {
            return Err("提权失败或用户取消了 UAC".into());
        }
        let txt = std::fs::read_to_string(&out).map_err(|e| format!("读取结果失败：{e}"))?;
        let _ = std::fs::remove_file(&out);
        serde_json::from_str(&txt).map_err(|e| format!("解析结果失败：{e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}
