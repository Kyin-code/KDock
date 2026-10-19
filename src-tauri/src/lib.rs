//! Tauri 端：连接管理 + 命令桥接。
//!
//! 串口 / TCP Client / TCP Server / UDP 四种传输都收敛在 [`transport::Conn`] 上，
//! 命令层不区分传输类型；HEX 编解码与行尾处理只有 `kdock-core` 里那一份。

mod agent;
mod android;
mod checksum;
mod debug;
mod env_setup;
mod kbview;
mod logic;
mod netcapture;
mod netfs;
mod ocr;
mod remote_screen;
mod scope;
mod shell;
mod storage;
mod transport;
pub mod usb;
pub mod usbcapture;
mod upgrade;
mod webview2;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use serde::Serialize;
use serialport::{SerialPortInfo, SerialPortType};
use tauri::{AppHandle, Emitter, Manager, State};

use kdock_core::hex;
use kdock_core::lineending::LineEnding;
use kdock_core::session::{now_ms, Direction, LogLine, SessionLog};

use transport::{Conn, Endpoint};

const READ_CHUNK: usize = 4096;

// ── 展示用结构 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub port_name: String,
    pub port_type: String,
    pub description: Option<String>,
    /// Windows 上的"友好名"，例如 "USB-SERIAL CH340 (COM7)"（best-effort）
    pub friendly: Option<String>,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

fn describe(info: &SerialPortInfo) -> PortInfo {
    let mut out = PortInfo {
        port_name: info.port_name.clone(),
        port_type: "unknown".into(),
        description: None,
        friendly: friendly_of(&info.port_name),
        manufacturer: None,
        serial_number: None,
        vid: None,
        pid: None,
    };
    match &info.port_type {
        SerialPortType::UsbPort(usb) => {
            out.port_type = "usb".into();
            out.vid = Some(usb.vid);
            out.pid = Some(usb.pid);
            out.serial_number = usb.serial_number.clone();
            out.manufacturer = usb.manufacturer.clone();
            out.description = usb
                .product
                .clone()
                .or_else(|| usb.manufacturer.clone())
                .or_else(|| Some(format!("USB {:04X}:{:04X}", usb.vid, usb.pid)));
        }
        SerialPortType::PciPort => out.port_type = "pci".into(),
        SerialPortType::BluetoothPort => out.port_type = "bluetooth".into(),
        SerialPortType::Unknown => {}
    }
    out
}

/// 断线自动重连开关（TCP Client；串口不重连——串口掉了多半是拔了线）
static AUTO_RECONNECT: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_auto_reconnect(v: bool) {
    AUTO_RECONNECT.store(v, Ordering::Relaxed);
}

/// 断线后在后台重连：每 1.5s 试一次，最多 ~20 次；期间报 reconnecting/reconnected 事件。
/// 有"独占连接"的操作(升级/收发文件)在跑时跳过，别去抢。
fn spawn_reconnect(app: AppHandle, st: Arc<AppState>, ep: Endpoint) {
    std::thread::spawn(move || {
        for i in 1..=20u32 {
            if !AUTO_RECONNECT.load(Ordering::Relaxed) {
                return;
            }
            let _ = app.emit("link://reconnecting", i);
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let guard = match LINK_OP.try_lock() {
                Ok(g) => g,
                Err(_) => continue,          // 正在升级/收发文件，等下一次
            };
            if st.link.lock().expect("link mutex").is_some() {
                return;                       // 已经有人接上了
            }
            match transport::open_endpoint(&ep) {
                Ok(conn) => {
                    drop(guard);
                    let _ = st.reader_stop.lock().expect("stop mutex").replace(
                        Arc::new(AtomicBool::new(false)),
                    );
                    if start_reader(app.clone(), st.clone(), conn).is_ok() {
                        let _ = app.emit("link://reconnected", i);
                    }
                    return;
                }
                Err(_) => continue,
            }
        }
        let _ = app.emit("link://state", "reconnect-failed");
    });
}

// ── 屏幕捕获：DXGI 桌面复制(screenshots crate) -> JPEG -> base64 推给前端 ──
// 帧率/画质都可调；1:1 显示还是适应窗口由前端决定（这里永远给原始分辨率）。
static CAP_STOP: LazyLock<Mutex<Option<Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(None));
/// 每次"开始"生成一个新的会话号，事件里带上它；前端只认自己那一次的会话，
/// 否则上一路捕获线程退出时发的 `stopped` 会把新会话的状态顶成"已停止"
/// （4K 屏上表现为：画面还在刷，状态却显示已停止）。
static CAP_SESSION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(windows)]
#[tauri::command]
fn capture_list() -> Result<Vec<MonitorInfo>, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    Ok(screens
        .iter()
        .enumerate()
        .map(|(i, s)| MonitorInfo {
            id: i as u32,
            name: format!("显示器 {} · {}x{}", i + 1, s.display_info.width, s.display_info.height),
            width: s.display_info.width,
            height: s.display_info.height,
        })
        .collect())
}

#[cfg(not(windows))]
#[tauri::command]
fn capture_list() -> Result<Vec<MonitorInfo>, String> {
    Err("屏幕捕获目前只做了 Windows(DXGI)".into())
}

#[cfg(windows)]
#[tauri::command]
fn capture_start(app: AppHandle, monitor: usize, fps: u32, quality: u8) -> Result<u64, String> {
    capture_stop();
    let stop = Arc::new(AtomicBool::new(false));
    *CAP_STOP.lock().expect("capture mutex") = Some(stop.clone());
    // 会话号：这一路捕获线程的"身份证"，事件都带着它
    let session = CAP_SESSION.fetch_add(1, Ordering::Relaxed) + 1;
    let app2 = app.clone();
    std::thread::spawn(move || {
        fn fail(app: &AppHandle, session: u64, msg: String) {
            let _ = app.emit(
                "capture://error",
                serde_json::json!({ "session": session, "msg": msg }),
            );
            let _ = app.emit("capture://stopped", serde_json::json!({ "session": session }));
        }
        let screens = match screenshots::Screen::all() {
            Ok(s) => s,
            Err(e) => {
                fail(&app2, session, format!("枚举显示器失败: {e}"));
                return;
            }
        };
        let screen = match screens.get(monitor) {
            Some(s) => s,
            None => {
                fail(&app2, session, "显示器序号不对".to_string());
                return;
            }
        };
        let fps = fps.clamp(1, 30);
        let frame_ms = (1000 / fps) as u64;
        let quality = quality.clamp(20, 95);
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let t0 = Instant::now();
            match screen.capture() {
                Ok(img) => {
                    let (w, h) = (img.width(), img.height());
                    let rgb = image::DynamicImage::ImageRgba8(img).into_rgb8();
                    let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
                    use image::ImageEncoder;
                    let ok = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
                        .write_image(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
                        .is_ok();
                    if ok && !buf.is_empty() {
                        let _ = app2.emit(
                            "capture://frame",
                            serde_json::json!({
                                "session": session,
                                "w": w, "h": h, "ts": now_ms(),
                                "bytes": buf.len(),
                                "data": upgrade::b64_encode(&buf),
                            }),
                        );
                    }
                }
                Err(e) => {
                    let _ = app2.emit(
                        "capture://error",
                        serde_json::json!({ "session": session, "msg": format!("抓屏失败: {e}") }),
                    );
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
            let used = t0.elapsed().as_millis() as u64;
            if used < frame_ms {
                std::thread::sleep(std::time::Duration::from_millis(frame_ms - used));
            }
        }
        let _ = app2.emit("capture://stopped", serde_json::json!({ "session": session }));
    });
    Ok(session)
}

#[cfg(not(windows))]
#[tauri::command]
fn capture_start(
    _app: AppHandle,
    _monitor: usize,
    _fps: u32,
    _quality: u8,
) -> Result<u64, String> {
    Err("屏幕捕获目前只做了 Windows(DXGI)".into())
}

#[tauri::command]
fn capture_stop() {
    if let Some(s) = CAP_STOP.lock().expect("capture mutex").take() {
        s.store(true, Ordering::Relaxed);
    }
}

// ── 烧录：直接跑外部烧录器（openocd / J-Link / STM32CubeProgrammer），输出流式回前端 ──
static FLASH_CHILD: LazyLock<Mutex<Option<Arc<Mutex<std::process::Child>>>>> =
    LazyLock::new(|| Mutex::new(None));

#[tauri::command]
fn flash_run(app: AppHandle, exe: String, args: Vec<String>) -> Result<(), String> {
    // 先收掉上一个
    {
        let mut g = FLASH_CHILD.lock().expect("flash mutex");
        if let Some(c) = g.take() {
            if let Ok(mut c) = c.lock() {
                let _ = c.kill();
            }
        }
    }
    let _ = app.emit("flash://log", format!("> {} {}\n", exe, args.join(" ")));
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别弹黑框
    }
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动 {exe} 失败: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    if let Some(o) = out {
        let a = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(o).lines().map_while(Result::ok) {
                let _ = a.emit("flash://log", format!("{line}\n"));
            }
        });
    }
    if let Some(e2) = err {
        let a = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(e2).lines().map_while(Result::ok) {
                let _ = a.emit("flash://log", format!("{line}\n"));
            }
        });
    }
    let shared = Arc::new(Mutex::new(child));
    *FLASH_CHILD.lock().expect("flash mutex") = Some(shared.clone());
    let a2 = app.clone();
    std::thread::spawn(move || loop {
        // 用 try_wait 轮询，别在锁里 wait（否则 flash_stop 的 kill 拿不到锁）
        let done = {
            match shared.lock() {
                Ok(mut c) => match c.try_wait() {
                    Ok(Some(s)) => Some(s.code().unwrap_or(-1)),
                    Ok(None) => None,
                    Err(_) => Some(-1),
                },
                Err(_) => Some(-1),
            }
        };
        if let Some(code) = done {
            let _ = a2.emit("flash://done", code);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    });
    Ok(())
}

/// 列出烧录器可用的"器件/适配器"清单：
/// 本机没找到 JLinkDevices.xml，就用 **openocd 自带的 scripts**（target/interface/board 三类 cfg），
/// 这也正是我们烧录用的一套。返回 [{name, desc, group}]，前端做 J-Flash 那种搜索选择。
#[tauri::command]
async fn flash_scripts(kind: String, scripts_dir: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    // 扫盘 + 读上百个 .cfg，放到阻塞线程池，别让首开烧录页卡住 webview
    tauri::async_runtime::spawn_blocking(move || flash_scripts_blocking(kind, scripts_dir))
        .await
        .map_err(|e| format!("器件库扫描线程失败：{e}"))?
}

fn flash_scripts_blocking(kind: String, scripts_dir: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(d) = scripts_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        roots.push(std::path::PathBuf::from(d));
    }
    // 1) 从 PATH 里的 openocd 推它的 scripts 目录
    if let Ok(o) = std::process::Command::new("where").arg("openocd").output() {
        if let Some(line) = String::from_utf8_lossy(&o.stdout).lines().next() {
            if let Some(bin) = std::path::Path::new(line.trim()).parent() {
                roots.push(bin.join("..").join("share").join("openocd").join("scripts"));
            }
        }
    }
    // 2) 常见安装位置兜底
    for base in ["F:/ENV", "C:/", "D:/ENV", "C:/Program Files"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.to_lowercase().contains("openocd") {
                    roots.push(e.path().join("share").join("openocd").join("scripts"));
                }
            }
        }
    }
    let kinds: Vec<String> = if kind == "all" {
        vec!["target".into(), "interface".into(), "board".into()]
    } else {
        vec![kind.clone()]
    };
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut used_root: Option<std::path::PathBuf> = None;
    for root in roots.iter() {
        if used_root.is_some() {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        used_root = Some(root.clone());
        for k in kinds.iter() {
            let dir = root.join(k);
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for e in rd.flatten() {
                let path = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".cfg") {
                    continue;
                }
                let stem = name.trim_end_matches(".cfg").to_string();
                // 第一行注释通常就是芯片/适配器说明
                let desc = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| {
                        t.lines()
                            .map(|l| l.trim_start_matches('#').trim().to_string())
                            .find(|l| !l.is_empty() && !l.starts_with("SPDX") && !l.starts_with("Copyright"))
                    })
                    .unwrap_or_default();
                out.push(serde_json::json!({
                    "name": stem, "desc": desc, "group": k,
                    "file": name, "path": path.to_string_lossy(),
                }));
            }
        }
    }
    out.sort_by(|a, b| {
        a["group"].as_str().cmp(&b["group"].as_str()).then(
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        )
    });
    if out.is_empty() {
        return Err("没找到 openocd 的 scripts 目录（看看 openocd 是否在 PATH 里）".into());
    }
    Ok(out)
}

/// 去掉 Windows 原生那圈"窗体边框"（WS_CAPTION）：留着 WS_THICKFRAME 所以还能拖边改大小/贴边。
/// 顺手让 DWM 保持圆角，避免变成硬直角。
#[cfg(windows)]
fn strip_native_frame(window: &tauri::WebviewWindow) {
    // 反复调用是安全的：DWM 在最大化/还原/激活时会把这些属性重画回默认值
    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_CAPTION: isize = 0x00C0_0000;
    const WS_THICKFRAME: isize = 0x0004_0000;   // 连它一起去掉：那 2~7px 的 frame 会被系统画成主题色
    const WS_MINIMIZEBOX: isize = 0x0002_0000;
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    const WS_EX_APPWINDOW: isize = 0x0004_0000; // 明确要求"任务栏上要有按钮"
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const i32, size: u32) -> i32;
    }
    let Ok(h) = window.hwnd() else { return };
    let hwnd = h.0 as isize;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        // 彻底无边框：CAPTION/THICKFRAME 都不要（拖拽/缩放我们在前端自己做）
        let new_style = (style & !WS_CAPTION & !WS_THICKFRAME) | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);
        // 顺确保有 APPWINDOW（任务栏按钮）= 有；没有它的话无边框窗口可能不出现在任务栏上
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_APPWINDOW == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_APPWINDOW);
        }
        SetWindowPos(hwnd, 0, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        // DWMWA_WINDOW_CORNER_PREFERENCE(33) = DWMWCP_ROUND(2)：保住 Win11 圆角
        let pref: i32 = 2;
        DwmSetWindowAttribute(hwnd, 33, &pref, std::mem::size_of::<i32>() as u32);
        // DWMWA_BORDER_COLOR(34) = DWMWA_COLOR_NONE(0xFFFFFFFE)：去掉顶上那条系统描边（常见是一条蓝线）
        // 注意：值要按 COLORREF(DWORD) 传；Win11 22H2+ 才支持，老系统会返回错误（忽略即可）
        let none: u32 = 0xFFFF_FFFE;
        let _ = DwmSetWindowAttribute(hwnd, 34, &none as *const u32 as *const i32, std::mem::size_of::<u32>() as u32);
        // DWMWA_USE_IMMERSIVE_DARK_MODE(20)：让系统描边/阴影跟随深色，进一步减少"亮线"
        let dark: i32 = 1;
        let _ = DwmSetWindowAttribute(hwnd, 20, &dark, std::mem::size_of::<i32>() as u32);
    }
}

// ── 无边框窗口：把原生非客户区**彻底**清零 ──────────────────────────────
// 只清 WS_CAPTION/WS_THICKFRAME 是不够的：Win11 会给"看起来还带边框"的窗口画一圈系统描边
// （右/下边尤其明显就是那条蓝线），而且窗口被 window-state 直接恢复成最大化时
// 不会走 `win_ctl`，没人把它贴回工作区 → 盖住任务栏、任务栏点不动。
// 这里用**子类化窗口过程**处理 WM_NCCALCSIZE：返回 0 且不改参数 = 客户区就是整个窗口，
// 这是"无边框"的标准做法，与 Windows 版本无关；DWM 那几个属性只当补充手段。
/// 每个窗口“原子过程”的存放位置名。用窗口属性（SetProp/GetProp）存，
/// 而不是全局变量 —— 主窗口和启动画面**各自**都要装一次子类化，
/// 全局变量会导致"只有第一个装的窗口生效"（启动画面就是这么漏出一条边的）。
#[cfg(windows)]
const KDOCK_WNDPROC_PROP: &str = "kdock_orig_wndproc";

#[cfg(windows)]
unsafe extern "system" fn kdock_wndproc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    const WM_NCCALCSIZE: u32 = 0x0083;
    const WM_GETMINMAXINFO: u32 = 0x0024;
    const WM_STYLECHANGING: u32 = 0x007C;
    const WM_STYLECHANGED: u32 = 0x007D;
    const GWL_STYLE: isize = -16;
    const WS_CAPTION: isize = 0x00C0_0000;
    const WS_THICKFRAME: isize = 0x0004_0000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    #[link(name = "user32")]
    extern "system" {
        fn CallWindowProcW(p: isize, h: isize, m: u32, w: usize, l: isize) -> isize;
        fn DefWindowProcW(h: isize, m: u32, w: usize, l: isize) -> isize;
        fn MonitorFromWindow(h: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(mon: isize, info: *mut MONITORINFO) -> i32;
        fn GetPropW(h: isize, name: *const u16) -> isize;
        fn GetWindowLongPtrW(h: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(h: isize, index: i32, value: isize) -> isize;
        fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct RECT {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb: u32,
        rc: RECT,
        work: RECT,
        flags: u32,
    }
    #[repr(C)]
    struct MINMAXINFO {
        pt_reserved: POINT,
        pt_max_size: POINT,
        pt_max_position: POINT,
        pt_min_track: POINT,
        pt_max_track: POINT,
    }
    // WM_NCCALCSIZE(wParam=TRUE)：返回 0、不动 NCCALCSIZE_PARAMS → 非客户区为零
    if msg == WM_NCCALCSIZE && wparam != 0 {
        return 0;
    }
    // WM_STYLECHANGING：**从根上拦住"边框被加回来"**。
    // 为什么要拦：tao 每次改窗口标志（显示、最大化、置顶…）都会 `SetWindowLongW(GWL_STYLE, ...)`
    // 把整套样式重写一遍，而那套样式里**带着 WS_CAPTION/WS_THICKFRAME**（见 tao
    // `WindowState::to_window_styles`，它只在 CHILD 窗口上才去掉这两个位）。
    // 结果就是：我们启动时清掉的边框，会在 window-state 恢复/窗口显示那一刻被原样加回来 ——
    // 用户看到的就是"顶上三条边"，以及最大化时按整屏算尺寸把任务栏盖住。
    // 定时器每 300ms 补一次只是事后扑火（中间那几百毫秒照样露边），这里直接改掉"即将写入的样式"。
    if msg == WM_STYLECHANGING && wparam as isize == GWL_STYLE && lparam != 0 {
        let st = lparam as *mut u32; // STYLESTRUCT { styleOld: u32, styleNew: u32 }
        if !st.is_null() {
            let proposed = *st.add(1) as isize;
            *st.add(1) = (proposed & !WS_CAPTION & !WS_THICKFRAME) as u32;
        }
        return 0;
    }
    // WM_STYLECHANGED：兜底。万一有别的路径绕过 STYLECHANGING 直接落样式，这里立刻再清一次。
    // 递归保护靠"比较"：清干净之后样式就相等了，不会再触发 SetWindowLongPtrW，循环自然停止。
    if msg == WM_STYLECHANGED && wparam as isize == GWL_STYLE {
        unsafe {
            let cur = GetWindowLongPtrW(hwnd, GWL_STYLE as i32);
            let cleaned = cur & !WS_CAPTION & !WS_THICKFRAME;
            if cleaned != cur {
                SetWindowLongPtrW(hwnd, GWL_STYLE as i32, cleaned);
                SetWindowPos(
                    hwnd, 0, 0, 0, 0, 0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }
    // WM_GETMINMAXINFO：**必须**一起接管。非客户区归零之后 Windows 会"以为"这窗口没有边框，
    // 最大化时按整块显示器算尺寸 → 窗口盖住任务栏（任务栏还看得见，但点不动）。
    // 这里把最大化的尺寸/位置按显示器工作区给回去，系统自己就会精确贴好，不用事后补正。
    if msg == WM_GETMINMAXINFO && lparam != 0 {
        unsafe {
            let mon = MonitorFromWindow(hwnd, 2); // MONITOR_DEFAULTTONEAREST
            let mut mi = MONITORINFO {
                cb: std::mem::size_of::<MONITORINFO>() as u32,
                rc: RECT { l: 0, t: 0, r: 0, b: 0 },
                work: RECT { l: 0, t: 0, r: 0, b: 0 },
                flags: 0,
            };
            if mon != 0 && GetMonitorInfoW(mon, &mut mi) != 0 {
                let mmi = lparam as *mut MINMAXINFO;
                if !mmi.is_null() {
                    (*mmi).pt_max_position.x = mi.work.l - mi.rc.l;
                    (*mmi).pt_max_position.y = mi.work.t - mi.rc.t;
                    (*mmi).pt_max_size.x = mi.work.r - mi.work.l;
                    (*mmi).pt_max_size.y = mi.work.b - mi.work.t;
                }
                return 0;
            }
        }
    }
    // 取这个窗口自己的原过程（窗口属性，和 GWLP_USERDATA 无关，不会踩到 tao 的状态）
    let name: Vec<u16> = KDOCK_WNDPROC_PROP.encode_utf16().chain(std::iter::once(0)).collect();
    let orig = GetPropW(hwnd, name.as_ptr());
    if orig == 0 {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    } else {
        CallWindowProcW(orig, hwnd, msg, wparam, lparam)
    }
}

#[cfg(windows)]
fn install_frame_proc(window: &tauri::WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowLongPtrW(h: isize, index: i32, value: isize) -> isize;
        fn SetPropW(h: isize, name: *const u16, data: isize) -> i32;
        fn GetPropW(h: isize, name: *const u16) -> isize;
    }
    const GWLP_WNDPROC: i32 = -4;
    let Ok(h) = window.hwnd() else { return };
    let hwnd = h.0 as isize;
    let name: Vec<u16> = KDOCK_WNDPROC_PROP.encode_utf16().chain(std::iter::once(0)).collect();
    // 已经装过就别重复装（重复装会把我们自己的过程当成"原过程"，越套越深）
    let already = unsafe { GetPropW(hwnd, name.as_ptr()) } != 0;
    if already {
        return;
    }
    // 先转成 fn 指针再转整数（直接 `fn as isize` 会被 lint 拦）
    let proc_ptr: unsafe extern "system" fn(isize, u32, usize, isize) -> isize = kdock_wndproc;
    let old = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_ptr as isize) };
    if old != 0 {
        unsafe { SetPropW(hwnd, name.as_ptr(), old) };
    }
}

/// 盯着"最大化"这件事：无边框窗口最大化后要自己贴到显示器工作区，否则会盖住任务栏
/// （任务栏还在但点不动）。启动时被 window-state 恢复成最大化的情况也靠它兜住。
#[cfg(windows)]
fn spawn_frame_watcher(window: tauri::WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn IsZoomed(h: isize) -> i32;
    }
    std::thread::spawn(move || {
        let hwnd = match window.hwnd() {
            Ok(h) => h.0 as isize,
            Err(_) => return,
        };
        // 启动瞬间可能已经被 window-state 直接恢复成最大化了：前几秒补几次，
        // 别等 30 秒的周期 —— 那段时间里窗口是盖着任务栏的。
        // 这里**只管主窗口**：启动画面不归 window-state 管（见 denylist），尺寸是定死的，
        // 不会再被"恢复"成别的尺寸。以前每 100ms 去清一次 splash 的样式，反而是在一个
        // 已经显示出来的窗口上反复发 WM_FRAMECHANGED —— 那一下会让右边/底边闪出一条边框。
        for i in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if i % 3 == 0 {
                strip_native_frame(&window);
                if unsafe { IsZoomed(hwnd) } != 0 {
                    fit_work_area(&window);
                }
            }
        }
        let mut last_max = unsafe { IsZoomed(hwnd) } != 0;
        let mut last_fix = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let now_max = unsafe { IsZoomed(hwnd) } != 0;
            // 状态变了就修；另外隔 30 秒兜一次（DWM/系统有时会把样式自己改回去）
            let periodic = last_fix.elapsed() > std::time::Duration::from_secs(30);
            if now_max != last_max || periodic {
                last_max = now_max;
                last_fix = std::time::Instant::now();
                strip_native_frame(&window);
                if now_max {
                    fit_work_area(&window);
                } else if !periodic {
                    // 刚从最大化"还原"回来：那个还原矩形可能是历史遗留的越界值（-8,-8 那套，
                    // 老配置里存的），夹回工作区，别让窗口左下角挂到屏幕外
                    clamp_to_work_area(&window);
                }
            }
        }
    });
}

/// 把主窗口叫到前面来：最小化状态要先 unminimize，否则 show() 不起作用（托盘点了像没反应）。
fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        #[cfg(windows)]
        strip_native_frame(&w);
    }
}

/// 直接给窗口发 SW_HIDE。
/// 为什么要绕过 `window.hide()`：tao 认为这个窗口**已经**是隐藏的（它内部的 VISIBLE 标志是 false），
/// 于是 `set_window_flags` 里 diff 为空、直接返回，一个 SW_HIDE 都不会发出去。
/// 而我们恰好在处理"tao 以为隐藏、实际被 ShowWindow(SW_RESTORE) 露出来了"这种情况。
fn hide_native(w: &tauri::WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(h: isize, cmd: i32) -> i32;
    }
    const SW_HIDE: i32 = 0;
    if let Ok(h) = w.hwnd() {
        unsafe {
            ShowWindow(h.0 as isize, SW_HIDE);
        }
    }
}

/// 把窗口贴到显示器工作区（最大化时用，避开无边框窗口那 8px 边框）。
#[cfg(windows)]
fn fit_work_area(w: &tauri::WebviewWindow) {
    #[repr(C)]
    struct RECT { l: i32, t: i32, r: i32, b: i32 }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SPI_GETWORKAREA: u32 = 0x0030;
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut RECT, winini: u32) -> i32;
        fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(mon: isize, info: *mut MONITORINFO) -> i32;
    }
    #[repr(C)]
    struct MONITORINFO { cb: u32, rc: RECT, work: RECT, flags: u32 }
    if let Ok(h) = w.hwnd() {
        unsafe {
            let hwnd = h.0 as isize;
            let mon = MonitorFromWindow(hwnd, 2);   // NEAREST
            let mut mi = MONITORINFO { cb: std::mem::size_of::<MONITORINFO>() as u32,
                rc: RECT { l: 0, t: 0, r: 0, b: 0 }, work: RECT { l: 0, t: 0, r: 0, b: 0 }, flags: 0 };
            if mon != 0 && GetMonitorInfoW(mon, &mut mi) != 0 {
                let wk = mi.work;
                SetWindowPos(hwnd, 0, wk.l, wk.t, wk.r - wk.l, wk.b - wk.t, SWP_NOZORDER | SWP_NOACTIVATE);
                return;
            }
            let mut r = RECT { l: 0, t: 0, r: 0, b: 0 };
            if SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r, 0) != 0 {
                SetWindowPos(hwnd, 0, r.l, r.t, r.r - r.l, r.b - r.t, SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }
}

/// 按位移移动窗口（自绘标题栏用；delta 是物理像素）。
#[tauri::command]
fn win_move(app: tauri::AppHandle, dx: i32, dy: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        const SWP_NOSIZE: u32 = 0x0001;
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        #[repr(C)]
        struct RECT { l: i32, t: i32, r: i32, b: i32 }
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowRect(hwnd: isize, r: *mut RECT) -> i32;
            fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        }
        let w = app.get_webview_window("main").ok_or("找不到主窗口")?;
        let h = w.hwnd().map_err(|e| e.to_string())?.0 as isize;
        unsafe {
            let mut r = RECT { l: 0, t: 0, r: 0, b: 0 };
            if GetWindowRect(h, &mut r) == 0 { return Err("GetWindowRect 失败".into()); }
            SetWindowPos(h, 0, r.l + dx, r.t + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, dx, dy); Ok(()) }
}

/// 按位移改窗口大小（自绘边框用）。edge: n/s/e/w/ne/nw/se/sw，delta 是物理像素。
#[tauri::command]
fn win_resize(app: tauri::AppHandle, edge: String, dx: i32, dy: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        const MIN_W: i32 = 640;
        const MIN_H: i32 = 420;
        #[repr(C)]
        struct RECT { l: i32, t: i32, r: i32, b: i32 }
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowRect(hwnd: isize, r: *mut RECT) -> i32;
            fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        }
        let w = app.get_webview_window("main").ok_or("找不到主窗口")?;
        let h = w.hwnd().map_err(|e| e.to_string())?.0 as isize;
        unsafe {
            let mut r = RECT { l: 0, t: 0, r: 0, b: 0 };
            if GetWindowRect(h, &mut r) == 0 { return Err("GetWindowRect 失败".into()); }
            let (mut l, mut t, mut rr, mut b) = (r.l, r.t, r.r, r.b);
            if edge.contains('w') { l += dx; }
            if edge.contains('e') { rr += dx; }
            if edge.contains('n') { t += dy; }
            if edge.contains('s') { b += dy; }
            if rr - l < MIN_W { if edge.contains('w') { l = rr - MIN_W; } else { rr = l + MIN_W; } }
            if b - t < MIN_H { if edge.contains('n') { t = b - MIN_H; } else { b = t + MIN_H; } }
            SetWindowPos(h, 0, l, t, rr - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, edge, dx, dy); Ok(()) }
}

/// 自检：当前的 WS_CAPTION/WS_THICKFRAME 以及 DWM 描边色（34）、圆角（33）。
#[tauri::command]
fn win_frame_info(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(windows)]
    {
        const GWL_STYLE: i32 = -16;
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        }
        #[link(name = "dwmapi")]
        extern "system" {
            fn DwmGetWindowAttribute(hwnd: isize, attr: u32, value: *mut i32, size: u32) -> i32;
        }
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(h) = w.hwnd() {
                let hwnd = h.0 as isize;
                unsafe {
                    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                    let mut border: i32 = -1;
                    let mut corner: i32 = -1;
                    let hr1 = DwmGetWindowAttribute(hwnd, 34, &mut border, std::mem::size_of::<i32>() as u32);
                    let hr2 = DwmGetWindowAttribute(hwnd, 33, &mut corner, std::mem::size_of::<i32>() as u32);
                    return serde_json::json!({
                        "caption": (style & 0x00C0_0000) != 0,
                        "thickframe": (style & 0x0004_0000) != 0,
                        "style_hex": format!("0x{:X}", style),
                        "border_color_attr_hr": hr1,
                        "border_color": format!("0x{:08X}", border as u32),
                        "corner_attr_hr": hr2,
                        "corner": corner,
                    });
                }
            }
        }
    }
    serde_json::json!({ "error": "windows only" })
}

/// 无边框标题栏的窗口控制：min / toggle_max / close / drag。
#[tauri::command]
fn win_ctl(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("找不到主窗口")?;
    // Windows 在最大化/还原/最小化后会把原生 caption 样式加回来，所以每次操作后都再去一遍
    #[cfg(windows)]
    let again = |w: &tauri::WebviewWindow| {
        strip_native_frame(w);
    };
    match action.as_str() {
        "min" => {
            w.minimize().map_err(|e| e.to_string())?;
            #[cfg(windows)]
            again(&w);
            Ok(())
        }
        // 这个 Tauri 版本没有 toggle_maximize；is_maximized 在无边框窗口上不一定准，
        // 所以自己记一个状态位（双击/按钮都走这里，能同步）
        "toggle_max" => {
            let cur = w.is_maximized().unwrap_or(false) || WINDOW_MAXED.load(Ordering::Relaxed);
            let want = !cur;
            if want {
                w.maximize().map_err(|e| e.to_string())?;
                // 无边框窗口最大化时 Windows 会留 8px 边框（会把标题栏顶掉一截）。
                // maximize 是异步生效的，等它落定再贴齐工作区（保存/恢复用的 restore rect 不受影响）
                #[cfg(windows)]
                {
                    let w2 = w.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(80));
                        fit_work_area(&w2);
                    });
                }
            } else {
                w.unmaximize().map_err(|e| e.to_string())?;
            }
            WINDOW_MAXED.store(want, Ordering::Relaxed);
            #[cfg(windows)]
            again(&w);
            Ok(())
        }
        "close" => w.close().map_err(|e| e.to_string()),
        "drag" => w.start_dragging().map_err(|e| e.to_string()),
        // 全屏（「屏幕共享」页用）：隐藏状态栏/任务栏盖住的那种全屏，Esc/F11 退回来
        "fullscreen" => {
            w.set_fullscreen(true).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            again(&w);
            Ok(())
        }
        "unfullscreen" => {
            w.set_fullscreen(false).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            {
                let w2 = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    strip_native_frame(&w2);
                });
            }
            Ok(())
        }
        _ => Err(format!("未知动作 {action}")),
    }
}

/// 跑个命令抓输出（带超时、不弹黑框）；用来取工具版本。
fn run_capture(exe: &std::path::Path, args: &[&str], timeout_ms: u64) -> Option<String> {
    let mut c = std::process::Command::new(exe);
    c.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().ok()?;
    let t0 = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => return None,
        }
        if t0.elapsed().as_millis() as u64 > timeout_ms {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let out = child.wait_with_output().ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(s)
}

/// 在 PATH 里找可执行文件（用 where / which）。
fn find_in_path(name: &str) -> Option<std::path::PathBuf> {
    let out = run_capture(std::path::Path::new("where"), &[name], 3000)?;
    out.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
}

/// 在若干根目录下按"目录名包含关键词"扫一层，再拼相对路径找可执行文件。
fn scan_for(roots: &[&str], needle: &str, rel: &str) -> Option<std::path::PathBuf> {
    let mut hits: Vec<std::path::PathBuf> = Vec::new();
    for root in roots {
        let r = std::path::Path::new(root);
        if !r.is_dir() { continue; }
        let direct = r.join(rel);
        if direct.is_file() { hits.push(direct); }
        if let Ok(rd) = std::fs::read_dir(r) {
            let mut subs: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path()).collect();
            subs.sort();
            for p in subs.into_iter().rev() {
                let n = p.file_name().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                if p.is_dir() && n.contains(&needle.to_lowercase()) {
                    let c = p.join(rel);
                    if c.is_file() { hits.push(c); }
                }
            }
        }
    }
    hits.into_iter().next()
}
/// 找本机的 JLink.exe（J-Link Commander）。
fn find_jlink_exe() -> Option<std::path::PathBuf> {
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("JLINK_EXE") {
        let p = std::path::PathBuf::from(v.trim());
        if p.is_file() { cands.push(p); }
    }
    for root in ["C:/Program Files/SEGGER", "C:/Program Files (x86)/SEGGER",
                 "G:/JLink", "G:/jlink", "G:/seggar", "G:/SEGGER", "D:/SEGGER",
                 "F:/SEGGER", "F:/ENV", "D:/ENV", "E:/SEGGER"] {
        let r = std::path::Path::new(root);
        if !r.is_dir() { continue; }
        let direct = r.join("JLink.exe");
        if direct.is_file() { cands.push(direct); }
        if let Ok(rd) = std::fs::read_dir(r) {
            let mut subs: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path()).collect();
            subs.sort();
            for p in subs.into_iter().rev() {
                if p.is_dir() {
                    let c = p.join("JLink.exe");
                    if c.is_file() { cands.push(c); }
                }
            }
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

/// 找本机的 JLinkDevices.xml（老版本 J-Link 的附加器件库）：环境变量优先，其次常见安装位置。
fn find_jlink_xml() -> Option<std::path::PathBuf> {
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("JLINK_DEVICES") {
        for part in v.split(';') {
            if !part.trim().is_empty() { cands.push(std::path::PathBuf::from(part.trim())); }
        }
    }
    for root in ["C:/Program Files/SEGGER", "C:/Program Files (x86)/SEGGER", "G:/seggar", "G:/SEGGER",
                 "G:/jlink", "H:/seggar", "H:/SEGGER", "D:/seggar", "F:/seggar", "E:/seggar",
                 "E:/keil4/ARM/Segger", "F:/ENV", "D:/ENV", "E:/ENV"] {
        let r = std::path::Path::new(root);
        if !r.is_dir() { continue; }
        let direct = r.join("JLinkDevices.xml");
        if direct.is_file() { cands.push(direct); }
        if let Ok(rd) = std::fs::read_dir(r) {
            let mut subs: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path()).collect();
            subs.sort();
            for p in subs.into_iter().rev() {
                if p.is_dir() {
                    let c = p.join("JLinkDevices.xml");
                    if c.is_file() { cands.push(c); }
                }
            }
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

fn xml_attr(tag: &str, key: &str) -> Option<String> {
    let pat = format!("{}=\"", key);
    let i = tag.find(&pat)? + pat.len();
    let j = i + tag[i..].find('"')?;
    Some(tag[i..j].to_string())
}

/// 让本机 JLink.exe 把 DLL 内置的器件库导成 XML（`ExpDevListXML`），返回导出的文件路径。
/// 这份库才是 J-Flash/J-Link 真正认的名字（比如 STM32F407VG，老 JLinkDevices.xml 里可能没有）。
fn jlink_export_devices(exe: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, String> {
    let exe = match exe {
        Some(p) if p.is_file() => p,
        _ => find_jlink_exe().ok_or("没找到 JLink.exe")?,
    };
    let dir = std::env::temp_dir().join("kdock");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("jlink-devices.xml");
    let script = dir.join("expdevlist.jlink");
    let _ = std::fs::remove_file(&out);
    std::fs::write(&script, format!("ExpDevListXML {}\nexit\n", out.to_string_lossy()))
        .map_err(|e| e.to_string())?;
    let st = std::process::Command::new(&exe)
        .args(["-NoGui", "1", "-CommanderScript", &script.to_string_lossy()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("跑 JLink.exe 失败: {e}"))?;
    if !out.is_file() {
        return Err(format!("JLink.exe 没有导出器件库（退出码 {:?}；没接 J-Link 时也可能失败）", st.code()));
    }
    Ok(out)
}

/// 解析 J-Link 导出的器件库 XML（`<VendorInfo Name>` / `<DeviceInfo Name Core>` / `<AliasInfo Name>`）。
fn parse_jlink_db(txt: &str) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut vendor = String::new();
    for line in txt.lines() {
        let t = line.trim();
        if t.contains("<VendorInfo") {
            vendor = xml_attr(t, "Name").unwrap_or_default();
            continue;
        }
        if t.contains("<DeviceInfo") {
            let name = xml_attr(t, "Name").unwrap_or_default();
            if name.is_empty() { continue; }
            out.push(serde_json::json!({
                "name": name, "vendor": vendor,
                "core": xml_attr(t, "Core").unwrap_or_default(),
                "alias": false,
            }));
            continue;
        }
        if t.contains("<AliasInfo") {
            let name = xml_attr(t, "Name").unwrap_or_default();
            if name.is_empty() { continue; }
            out.push(serde_json::json!({ "name": name, "vendor": vendor, "core": "", "alias": true }));
        }
    }
    out
}

/// J-Link 器件库。优先让本机 JLink.exe 导出（DLL 内置库，型号最全），失败再退回 JLinkDevices.xml。
/// 返回 { source, path, count, devices:[{name,vendor,core,alias}] }。
#[tauri::command]
async fn flash_jlink_devices(path: Option<String>, exe: Option<String>) -> Result<serde_json::Value, String> {
    // 这里可能会真的起 JLink.exe 导器件库（几秒），同样不能占用主线程
    tauri::async_runtime::spawn_blocking(move || flash_jlink_devices_blocking(path, exe))
        .await
        .map_err(|e| format!("J-Link 器件库线程失败：{e}"))?
}

fn flash_jlink_devices_blocking(path: Option<String>, exe: Option<String>) -> Result<serde_json::Value, String> {
    let exe = exe.map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).map(std::path::PathBuf::from);
    let mut errs: Vec<String> = Vec::new();
    let explicit = path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if explicit.is_none() {
        let cached = std::env::temp_dir().join("kdock").join("jlink-devices.xml");
        let fresh = cached.is_file()
            && std::fs::metadata(&cached).ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs() < 7 * 24 * 3600)
                .unwrap_or(false);
        let file: Result<std::path::PathBuf, String> = if fresh { Ok(cached) } else {
            match jlink_export_devices(exe.clone()) {
                Ok(p) => Ok(p),
                Err(e) => { errs.push(e); Ok(cached) }
            }
        };
        if let Ok(f) = file {
            if let Ok(txt) = std::fs::read_to_string(&f) {
                let devices = parse_jlink_db(&txt);
                if !devices.is_empty() {
                    return Ok(serde_json::json!({
                        "source": "JLink.exe (built-in DLL)", "path": f.to_string_lossy(),
                        "count": devices.len(), "devices": devices,
                    }));
                }
            }
        }
    }
    let file = match explicit {
        Some(p) => std::path::PathBuf::from(p),
        None => find_jlink_xml().ok_or_else(|| {
            let mut m = String::from("没找到 J-Link 器件库");
            if !errs.is_empty() { m.push_str(&format!("（{}）", errs.join("; "))); }
            m
        })?,
    };
    let txt = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    // 老格式（JLinkDevices.xml）：<Device><ChipInfo Vendor= Name= Core= />
    let mut devices: Vec<serde_json::Value> = Vec::new();
    for chunk in txt.split("<Device>").skip(1) {
        let Some(ci) = chunk.find("<ChipInfo") else { continue };
        let rest = &chunk[ci..];
        let Some(e) = rest.find('>') else { continue };
        let tag = &rest[..e];
        let name = xml_attr(tag, "Name").unwrap_or_default();
        if name.is_empty() { continue; }
        devices.push(serde_json::json!({
            "name": name,
            "vendor": xml_attr(tag, "Vendor").unwrap_or_default(),
            "core": xml_attr(tag, "Core").unwrap_or_default().replace("JLINK_CORE_", ""),
            "alias": false,
        }));
    }
    if devices.is_empty() {
        devices = parse_jlink_db(&txt);
    }
    Ok(serde_json::json!({
        "source": "JLinkDevices.xml", "path": file.to_string_lossy(),
        "count": devices.len(), "devices": devices,
    }))
}

/// 找烧录工具：优先用前端传来的手动路径(overrides)，否则 PATH，再否则扫常见安装目录。
/// 返回每个工具的 exe / 是否找到 / 来源(manual|path|scan) / 版本(尽量取)；openocd 还会给出 scripts 目录。
#[tauri::command]
async fn flash_tools(overrides: Option<serde_json::Value>) -> serde_json::Value {
    // 会跑 openocd --version / JLink -? / 扫多个安装目录
    tauri::async_runtime::spawn_blocking(move || flash_tools_blocking(overrides))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": format!("烧录器检测线程失败：{e}") }))
}

fn flash_tools_blocking(overrides: Option<serde_json::Value>) -> serde_json::Value {
    let ov = |k: &str| {
        overrides
            .as_ref()
            .and_then(|v| v.get(k))
            .and_then(|x| x.as_str())
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
    };
    let openocd_roots = ["F:/ENV", "D:/ENV", "H:/ENV", "E:/ENV", "C:/Program Files",
                         "C:/Program Files (x86)", "G:/ENV", "C:/xpack-openocd", "D:/tools"];
    let stm_roots = ["C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin",
                     "C:/Program Files (x86)/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin",
                     "H:/STM32CLT", "H:/STMCLT", "D:/STM32CubeProgrammer", "C:/ST"];
    // ---- OpenOCD ----
    let mut ocd = ov("openocd").map(std::path::PathBuf::from).filter(|p| p.is_file());
    let mut ocd_src = if ocd.is_some() { "manual" } else { "" };
    if ocd.is_none() {
        if let Some(p) = find_in_path("openocd") { ocd = Some(p); ocd_src = "path"; }
    }
    if ocd.is_none() {
        if let Some(p) = scan_for(&openocd_roots, "openocd", "bin/openocd.exe") { ocd = Some(p); ocd_src = "scan"; }
    }
    let ocd_exe = ocd.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    // scripts：手动给的优先，否则从 exe 推 ./../share/openocd/scripts
    let mut scripts = ov("openocd_scripts").map(std::path::PathBuf::from).filter(|p| p.is_dir());
    if scripts.is_none() {
        if let Some(p) = ocd.as_ref().and_then(|p| p.parent()).and_then(|b| b.parent()) {
            let c = p.join("share").join("openocd").join("scripts");
            if c.is_dir() { scripts = Some(c); }
        }
    }
    if scripts.is_none() {
        scripts = scan_for(&openocd_roots, "openocd", "share/openocd/scripts").filter(|p| p.is_dir());
    }
    // ---- J-Link ----
    let mut jl = ov("jlink").map(std::path::PathBuf::from).filter(|p| p.is_file());
    let mut jl_src = if jl.is_some() { "manual" } else { "" };
    if jl.is_none() {
        if let Some(p) = find_jlink_exe() { jl = Some(p); jl_src = "scan"; }
    }
    let jl_ver = jl
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(|d| d.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // ---- STM32_Programmer_CLI ----
    let mut st = ov("stm32cli").map(std::path::PathBuf::from).filter(|p| p.is_file());
    let mut st_src = if st.is_some() { "manual" } else { "" };
    if st.is_none() {
        if let Some(p) = find_in_path("STM32_Programmer_CLI") { st = Some(p); st_src = "path"; }
    }
    if st.is_none() {
        st = scan_for(&stm_roots, "stm32cubeprogrammer", "STM32_Programmer_CLI.exe");
        if st.is_some() { st_src = "scan"; }
    }
    if st.is_none() {
        for p in stm_roots {
            let c = std::path::Path::new(p).join("STM32_Programmer_CLI.exe");
            if c.is_file() { st = Some(c); st_src = "scan"; break; }
        }
    }
    // ---- pyOCD：CMSIS-DAP / DAPLink / WCH-Link / ST-Link 的统一烧录入口 ----
    let mut py = ov("pyocd").map(std::path::PathBuf::from).filter(|p| p.is_file());
    let mut py_src = if py.is_some() { "manual" } else { "" };
    if py.is_none() {
        py = env_setup::find_tool(
            "pyocd.exe",
            "%USERPROFILE%\\AppData\\Roaming\\Python\\Python39\\Scripts;%APPDATA%\\Python\\Python39\\Scripts",
        );
        if py.is_some() {
            py_src = "scan";
        }
    }
    // ---- WCH：优先 wlink（命令行，RISC-V / CH32 全系），退回厂商 GUI ----
    let wch = ov("wchlink")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| env_setup::find_tool("wlink.exe", "%ENVDIR%\\wlink;%ENVDIR%;C:\\wlink;D:\\wlink"))
        .or_else(|| env_setup::find_tool("WCH-LinkUtility.exe", "%ENVDIR%\\wchlink;C:\\WCH-LinkUtility;C:\\Program Files\\WCH;C:\\Program Files (x86)\\WCH"));
    let aurix = ov("aurix")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| env_setup::find_tool("AURIXFlasher.exe", "%ENVDIR%\\aurix;C:\\Program Files\\Infineon;C:\\Infineon;C:\\Program Files (x86)\\Infineon"));
    // 版本探测并行跑：pyOCD 是 Python 启动（1s+）、STM32 CLI 也不快。串行时要等它们一个个来，
    // 首开烧录页就卡在 18%。这里最慢的一个决定总耗时。
    let (ocd_ver, st_ver, py_ver, wch_ver) = std::thread::scope(|s| {
        let o = ocd.clone();
        let t_ocd = s.spawn(move || {
            o.as_ref()
                .and_then(|p| run_capture(p, &["--version"], 3000))
                .and_then(|t| t.lines().find(|l| l.to_lowercase().contains("open on-chip")).map(|l| l.trim().to_string()))
                .unwrap_or_default()
        });
        let stc = st.clone();
        let t_st = s.spawn(move || {
            stc.as_ref()
                .and_then(|p| run_capture(p, &["--version"], 4000))
                .and_then(|t| t.lines().find(|l| l.to_lowercase().contains("version")).map(|l| l.trim().to_string()))
                .unwrap_or_default()
        });
        let pyc = py.clone();
        let t_py = s.spawn(move || {
            pyc.as_ref()
                .and_then(|p| run_capture(p, &["--version"], 3000))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        });
        let wc = wch.clone();
        let t_wch = s.spawn(move || {
            wc.as_ref()
                .and_then(|p| run_capture(p, &["--version"], 3000))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        });
        (
            t_ocd.join().unwrap_or_default(),
            t_st.join().unwrap_or_default(),
            t_py.join().unwrap_or_default(),
            t_wch.join().unwrap_or_default(),
        )
    });
    serde_json::json!({
        "openocd": { "exe": ocd_exe, "found": !ocd_exe.is_empty(), "from": ocd_src, "version": ocd_ver,
                     "scripts": scripts.map(|p| p.to_string_lossy().to_string()).unwrap_or_default() },
        "jlink": { "exe": jl.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                   "found": jl.is_some(), "from": jl_src, "version": jl_ver },
        "stm32cli": { "exe": st.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                      "found": st.is_some(), "from": st_src, "version": st_ver },
        "pyocd": { "exe": py.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                   "found": py.is_some(), "from": py_src, "version": py_ver },
        "wchlink": { "exe": wch.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                     "found": wch.is_some(), "from": if wch.is_some() { "scan" } else { "" }, "version": wch_ver },
        "aurix": { "exe": aurix.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                   "found": aurix.is_some(), "from": if aurix.is_some() { "scan" } else { "" }, "version": "" },
    })
}

/// pyOCD 支持的芯片名（`pyocd flash -t <name>`）。前端把它挂成目标芯片输入的候选项，
/// 免得上游 OpenOCD 的 `stm32f4x` 被直接喂给 pyOCD。
#[tauri::command]
async fn pyocd_targets(exe: Option<String>) -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = exe
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "pyocd".to_string());
        let Some(text) = run_capture(std::path::Path::new(&exe), &["list", "--targets", "--no-header"], 12000) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for line in text.lines() {
            let mut it = line.split_whitespace();
            let (Some(name), Some(vendor)) = (it.next(), it.next()) else { continue };
            if name.eq_ignore_ascii_case("name") { continue; }
            out.push(serde_json::json!({ "name": name, "vendor": vendor }));
        }
        out
    })
    .await
    .unwrap_or_default()
}
/// 文件大小（选完固件给个"多大"的反馈用）。
#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// 跑一条本机命令（中控编排里"本机 ping"这种步骤用），返回 { code, stdout, stderr }。
#[tauri::command]
fn local_run(cmd: String, timeout_ms: u64) -> Result<serde_json::Value, String> {
    // 引号与输出编码都交给 shell 模块统一处理（以前这里的 args(["/C", cmd]) 会被再包一层引号，
    // 中文系统的 GBK 输出也会变成乱码）
    let (code, stdout, stderr) = shell::run(&cmd, timeout_ms, &|| false)?;
    Ok(serde_json::json!({ "code": code, "stdout": stdout, "stderr": stderr }))
}
/// 读一个 openocd `.cfg` 的文本内容。用途：点“开发板”时，板级 cfg 里通常写着
/// `source [find target/stm32f4x.cfg]` / `interface/stlink.cfg`，据此把芯片、适配器一起选好。
/// 只让读 .cfg 且限制大小，防止被当成任意文件读取的入口。
#[tauri::command]
fn flash_cfg_text(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("cfg")) != Some(true) {
        return Err("只允许读 .cfg".into());
    }
    let md = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if md.len() > 256 * 1024 {
        return Err("cfg 太大".into());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}
/// 写个临时脚本文件（J-Link Commander 那种要脚本的），返回绝对路径
#[tauri::command]
fn write_temp_file(name: String, content: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let path = std::env::temp_dir().join(if safe.is_empty() { "kdock.tmp".to_string() } else { safe });
    std::fs::write(&path, content).map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn flash_stop() {
    let mut g = FLASH_CHILD.lock().expect("flash mutex");
    if let Some(c) = g.take() {
        if let Ok(mut c) = c.lock() {
            let _ = c.kill();
        }
    }
}

// ── 知识库页：把外部页面（管理界面 / 对话界面）贴进主窗口 ──
// 位置与大小由前端按 DOM 占位区的实际坐标给（CSS 像素，相对窗口客户区）。

#[tauri::command]
async fn kb_show(
    app: AppHandle,
    kind: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    kbview::show(&app, &kind, &url, x, y, w, h)
}

#[tauri::command]
async fn kb_bounds(app: AppHandle, kind: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    kbview::bounds(&app, &kind, x, y, w, h)
}

#[tauri::command]
fn kb_hide(kind: String) {
    kbview::hide(&kind);
}

#[tauri::command]
fn kb_hide_all() {
    kbview::hide_all();
}

#[tauri::command]
fn kb_reload(kind: String) -> Result<(), String> {
    kbview::reload(&kind)
}

/// 这块内置浏览器现在停在哪个地址（没开过就是 null）
#[tauri::command]
fn kb_url(kind: String) -> Option<String> {
    kbview::current_url(&kind)
}

// ── 示波器：SCPI（RIGOL DS1000Z 系，裸 socket 5555）──
// 实现都在 `scope` 模块里，这里只是命令层的薄壳（UI 和 agent 工具共用同一份实现）。

#[tauri::command]
fn scope_open(host: String, port: u16) -> Result<String, String> {
    scope::connect(&host, port)
}

#[tauri::command]
fn scope_close() {
    scope::close();
}

#[tauri::command]
fn scope_cmd(cmd: String) -> Result<String, String> {
    scope::raw(&cmd)
}

#[tauri::command]
fn scope_info() -> Result<serde_json::Value, String> {
    scope::info()
}

#[tauri::command]
fn scope_measure(channel: u8, items: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    scope::measure(channel, &items.unwrap_or_default())
}

/// 波形：`mode` = NORM（屏幕 1200 点）/ RAW（深存储，分块读）
#[tauri::command]
fn scope_waveform(
    channel: u8,
    points: Option<usize>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    scope::wave(channel, points.unwrap_or(1200), mode.as_deref().unwrap_or("NORM"))
}

/// 老的"读波形"入口（只读 CH1 的屏幕数据），留着兼容旧前端
#[tauri::command]
fn scope_wave() -> Result<serde_json::Value, String> {
    scope::wave(1, 1200, "NORM")
}

#[tauri::command]
fn scope_screenshot(path: Option<String>) -> Result<serde_json::Value, String> {
    let p = path.map(std::path::PathBuf::from);
    scope::screenshot(p)
}

/// 「另存为」：把前端手上那份 PNG 写到用户选的路径
#[tauri::command]
fn scope_save_png(path: String, data_url: String) -> Result<String, String> {
    let body = data_url
        .split_once(",")
        .map(|(_, b)| b)
        .unwrap_or(data_url.as_str());
    let bytes = upgrade::b64_decode(body);
    if bytes.is_empty() {
        return Err("图片内容是空的".into());
    }
    scope::save_png(&bytes, std::path::Path::new(&path))
}

#[tauri::command]
fn scope_control(args: serde_json::Value) -> Result<serde_json::Value, String> {
    scope::control(&args)
}

// ── 中控（时序编排）自带的连接 ─────────────────────────────────────
// 和"主连接"并存、独立收发：中控里可以同时挂串口 + 网口等多条链路，
// 每条一个读线程，数据用 `seq://data`（带 id）推给前端。
struct ExtraConn {
    id: u32,
    label: String,
    conn: Conn,
    stop: Arc<AtomicBool>,
}

static EXTRA_SEQ: AtomicU32 = AtomicU32::new(1);
static EXTRA: LazyLock<Mutex<Vec<ExtraConn>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn encode_payload(
    payload: &str,
    mode: &str,
    line_ending: &str,
    raw: bool,
) -> Result<Vec<u8>, String> {
    if raw {
        return Ok(payload.as_bytes().to_vec());
    }
    let le = LineEnding::parse(line_ending).ok_or_else(|| format!("未知行尾: {line_ending}"))?;
    match mode {
        "hex" => {
            let mut v = hex::hex_to_bytes(payload).map_err(|e| format!("HEX 解析失败: {e}"))?;
            v.extend_from_slice(le.bytes());
            Ok(v)
        }
        "text" => Ok(le.encode(payload)),
        other => Err(format!("未知发送模式: {other}")),
    }
}

/// 中控：开一条独立连接，返回 (id, 标签)
#[tauri::command]
fn extra_open(app: AppHandle, endpoint: Endpoint) -> Result<serde_json::Value, String> {
    let conn = transport::open_endpoint(&endpoint)?;
    let mut reader = conn.try_clone()?;
    let id = EXTRA_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = endpoint.label();
    let stop = Arc::new(AtomicBool::new(false));
    EXTRA.lock().expect("extra mutex").push(ExtraConn {
        id,
        label: label.clone(),
        conn,
        stop: stop.clone(),
    });
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let _ = app2.emit(
                        "seq://data",
                        serde_json::json!({
                            "id": id,
                            "text": String::from_utf8_lossy(&data),
                            "hex": hex::bytes_to_hex(&data),
                        }),
                    );
                }
                Err(ref e) if transport::is_idle_read_error(e) => {}
                Err(_) => break,
            }
        }
        let _ = app2.emit("seq://closed", id);
    });
    Ok(serde_json::json!({"id": id, "label": label}))
}

#[tauri::command]
fn extra_close(id: u32) {
    let mut g = EXTRA.lock().expect("extra mutex");
    if let Some(pos) = g.iter().position(|c| c.id == id) {
        g[pos].stop.store(true, Ordering::Relaxed);
        g.remove(pos);
    }
}

#[tauri::command]
fn extra_list() -> Vec<serde_json::Value> {
    EXTRA
        .lock()
        .expect("extra mutex")
        .iter()
        .map(|c| serde_json::json!({ "id": c.id, "label": c.label }))
        .collect()
}

/// 中控：往指定那条连接写
#[tauri::command]
async fn extra_write(
    id: u32,
    payload: String,
    mode: String,
    line_ending: String,
    raw: Option<bool>,
) -> Result<usize, String> {
    let bytes = encode_payload(&payload, &mode, &line_ending, raw.unwrap_or(false))?;
    if bytes.is_empty() {
        return Err("没有可发送的内容".into());
    }
    let mut g = EXTRA.lock().expect("extra mutex");
    let c = g
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接 {id} 不存在（可能已断开）"))?;
    c.conn
        .write_paced(&bytes)
        .map_err(|e| format!("发送失败: {e}"))?;
    Ok(bytes.len())
}

/// 「关闭到托盘」开关：关窗时不退出，只把窗口藏起来（前端把这个偏好放到 localStorage 里，
/// 启动时通过命令同步过来）
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
static WINDOW_MAXED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_close_to_tray(v: bool) {
    CLOSE_TO_TRAY.store(v, Ordering::Relaxed);
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ── 界面偏好（主题 / 配色 / 语言）─────────────────────────────────
// 为什么不只用 WebView 的 localStorage：localStorage 按 **origin** 隔离 ——
// dev 模式跑的是 http://localhost:1420，打包后是 http://tauri.localhost，
// 两边各存一份，于是"开发时挑的主题配色，换成 exe 就没了"。
// 这里往 app_data 目录落一份 JSON，前端两个 origin 共用同一个文件。
fn ui_prefs_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录 {} 失败: {e}", dir.display()))?;
    Ok(dir.join("ui-prefs.json"))
}

/// 读界面偏好。没有文件（第一次跑这个版本）就返回空对象，让前端把现有选择写上来。
#[tauri::command]
fn ui_prefs_get(app: AppHandle) -> serde_json::Value {
    ui_prefs_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 写界面偏好（先写临时文件再改名，写一半崩了不会把好文件弄坏）
#[tauri::command]
fn ui_prefs_set(app: AppHandle, prefs: serde_json::Value) -> Result<(), String> {
    let path = ui_prefs_path(&app)?;
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("改名到 {} 失败: {e}", path.display()))
}

/// 工作区（任意目录）的 git 快照："Agent 信息"面板显示当前工作区 git 信息用。
/// 不是 git 仓库就返回 `repo: false`，不报错（工作区经常就是个普通目录）。
#[tauri::command]
fn workspace_git(path: String) -> serde_json::Value {
    if !std::path::Path::new(&path).is_dir() {
        return serde_json::json!({ "repo": false, "error": "目录不存在" });
    }
    let run = |args: &[&str]| -> Option<String> {
        let mut c = std::process::Command::new("git");
        c.arg("-C")
            .arg(&path)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别弹黑框
        }
        let out = c.output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let Some(branch) = run(&["rev-parse", "--abbrev-ref", "HEAD"]) else {
        return serde_json::json!({ "repo": false, "path": path });
    };
    let head = run(&["log", "-1", "--pretty=%h %s"]).unwrap_or_default();
    let status = run(&["status", "--porcelain"]).unwrap_or_default();
    let (mut staged, mut modified, mut untracked) = (0u32, 0u32, 0u32);
    for line in status.lines() {
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        if x == '?' && y == '?' {
            untracked += 1;
            continue;
        }
        if x != ' ' {
            staged += 1;
        }
        if y != ' ' {
            modified += 1;
        }
    }
    serde_json::json!({
        "repo": true, "path": path, "branch": branch, "head": head,
        "staged": staged, "modified": modified, "untracked": untracked,
        "dirty": staged + modified + untracked,
    })
}

/// Windows 友好端口名：`Win32_PnPEntity.Name` 就是 "USB-SERIAL CH340 (COM7)" 这种。
/// 一次 PowerShell 查询把整张表拿回来，缓存起来（只在插拔时刷新）。
static FRIENDLY: LazyLock<Mutex<std::collections::HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[cfg(windows)]
fn refresh_friendly() {
    let script = "Get-CimInstance Win32_PnPEntity | ForEach-Object { $_.Name } | \
                  Where-Object { $_ -match '\\(COM[0-9]+\\)' }";
    let out = match std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut map = FRIENDLY.lock().expect("friendly mutex");
    map.clear();
    for line in text.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        // 取最后一个 (COMxx)
        if let Some(start) = name.rfind('(') {
            let com = name[start + 1..].trim_end_matches(')').trim();
            if com.to_ascii_uppercase().starts_with("COM") {
                map.insert(com.to_string(), name.to_string());
            }
        }
    }
}

#[cfg(not(windows))]
fn refresh_friendly() {}

fn friendly_of(port: &str) -> Option<String> {
    let map = FRIENDLY.lock().expect("friendly mutex");
    map.get(port).cloned()
}

/// 端口插拔监听：后端每 1.5s 看一次串口集合，变了才推 `ports-changed`（前端不用再轮询）。
fn spawn_port_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Vec<String> = Vec::new();
        let mut first = true;
        loop {
            let now: Vec<String> = match serialport::available_ports() {
                Ok(ps) => ps.iter().map(|p| p.port_name.clone()).collect(),
                Err(_) => Vec::new(),
            };
            if now != last {
                last = now.clone();
                refresh_friendly();
                let list: Vec<PortInfo> = serialport::available_ports()
                    .map(|ps| ps.iter().map(describe).collect())
                    .unwrap_or_default();
                let _ = app.emit("ports-changed", list);
                if !first {
                    let _ = app.emit("ports-changed-note", now.clone());
                }
            }
            first = false;
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub connected: bool,
    pub listening: bool,
    pub mode: Option<String>,
    pub label: Option<String>,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    /// tx/rx 的“字符数”(UTF-8 解码后计)，界面只统计这个，不统计时长
    pub tx_chars: u64,
    pub rx_chars: u64,
    pub elapsed_ms: u64,
    pub tx_rate: f64,
    pub rx_rate: f64,
    pub log_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Chunk {
    pub ts_ms: i64,
    pub hex: String,
    pub text: String,
    pub ascii: String,
}

/// 一次发送的结果。前端用它渲染 TX 行，显示的就是**真正写到线上的字节**，
/// 不会再出现"界面显示的和实际发出去的不一致"。
#[derive(Debug, Clone, Serialize)]
pub struct WriteAck {
    pub bytes: usize,
    pub hex: String,
    pub ascii: String,
    pub text: String,
}

// ── 应用状态 ──────────────────────────────────────────────────

#[derive(Default)]
pub struct AppState {
    /// 写端。`Some` 表示已经有可用连接。
    link: Mutex<Option<Conn>>,
    /// TCP Server 正在监听时的监听器。
    listener: Mutex<Option<kdock_core::net::TcpServer>>,
    reader_stop: Mutex<Option<Arc<AtomicBool>>>,
    log: Mutex<SessionLog>,
    endpoint: Mutex<Option<Endpoint>>,
    opened_at: Mutex<Option<Instant>>,
    counters: Mutex<(u64, u64)>,
    /// (tx_chars, rx_chars): 发出/收到的“字符数”
    char_counts: Mutex<(u64, u64)>,
}

impl AppState {
    fn is_busy(&self) -> bool {
        self.link.lock().expect("link mutex").is_some()
            || self.listener.lock().expect("listener mutex").is_some()
    }
}

// ── reader 线程 ───────────────────────────────────────────────

fn start_reader(app: AppHandle, st: Arc<AppState>, conn: Conn) -> Result<(), String> {
    let mut reader = conn.try_clone()?;
    let stream_like = conn.is_stream();
    *st.link.lock().expect("link mutex") = Some(conn);

    let stop = st
        .reader_stop
        .lock()
        .expect("stop mutex")
        .clone()
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

    let ep_for_reconnect = st.endpoint.lock().expect("endpoint mutex").clone();
    std::thread::spawn(move || {
        // ── 行装配 ─────────────────────────────────────────────────────
        // 一次 read() 常常只回来小半行；而且设备回显很慢(实测长命令每 1.6s 才补一段)。
        // 所以分两种事件：
        //   link://data —— 已经结束的**整行**(落到会话日志、可保存/回放)
        //   link://tail —— 还没等到换行的**半行**，界面就地把它"长出来"，
        //                  不再切成一截一截的新行（这是用户看到的"一行被劈开"的根因）
        const FLUSH_IDLE: std::time::Duration = std::time::Duration::from_millis(60);
        const MAX_PENDING: usize = 16384;

        fn log_line(app: &AppHandle, data: &[u8], ts: i64) {
            if data.is_empty() {
                return;
            }
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state
                    .log
                    .lock()
                    .expect("log mutex")
                    .push(ts, Direction::Rx, data.to_vec());
            }
            let payload = Chunk {
                ts_ms: ts,
                hex: hex::bytes_to_hex(data),
                text: String::from_utf8_lossy(data).to_string(),
                ascii: hex::ascii_column(data),
            };
            let _ = app.emit("link://data", payload);
        }

        /// 一块数据按 \n 切成整行逐条发出（行尾字节保留），最后没换行的尾巴也算一条
        fn log_lines(app: &AppHandle, block: &[u8], ts: i64) {
            let mut start = 0usize;
            for i in 0..block.len() {
                if block[i] == b'\n' {
                    log_line(app, &block[start..=i], ts);
                    start = i + 1;
                }
            }
            if start < block.len() {
                log_line(app, &block[start..], ts);
            }
        }

        let mut buf = vec![0u8; READ_CHUNK];
        let mut pending: Vec<u8> = Vec::new();
        let mut pending_ts = 0i64;
        let mut last_rx = std::time::Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    if stream_like {
                        let _ = app.emit("link://state", "closed");
                        // 对端关了：把自己从 link 里摘掉，必要时后台重连
                        if st.link.lock().expect("link mutex").is_some() {
                            *st.link.lock().expect("link mutex") = None;
                            if AUTO_RECONNECT.load(Ordering::Relaxed) {
                                if let Some(ep @ Endpoint::TcpClient { .. }) = ep_for_reconnect.clone() {
                                    spawn_reconnect(app.clone(), st.clone(), ep);
                                }
                            }
                        }
                        break;
                    }
                }
                Ok(n) => {
                    if pending.is_empty() {
                        pending_ts = now_ms();
                    }
                    // 统计按"实际收到的字节"算，跟后面怎么分行无关
                    if let Some(state) = app.try_state::<Arc<AppState>>() {
                        state.counters.lock().expect("counters mutex").1 += n as u64;
                        state.char_counts.lock().expect("chars mutex").1 +=
                            String::from_utf8_lossy(&buf[..n]).chars().count() as u64;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    last_rx = std::time::Instant::now();
                    if let Some(pos) = pending.iter().rposition(|&b| b == b'\n') {
                        let block: Vec<u8> = pending.drain(..=pos).collect();
                        log_lines(&app, &block, pending_ts);
                        pending_ts = now_ms();
                        let _ = app.emit("link://tail", "");   // 整行已落库，尾巴清空
                    }
                    while pending.len() >= MAX_PENDING {
                        let block: Vec<u8> = pending.drain(..MAX_PENDING).collect();
                        log_lines(&app, &block, pending_ts);
                        pending_ts = now_ms();
                        let _ = app.emit("link://tail", "");
                    }
                }
                // 空闲（读超时 / 被打断 / 非阻塞无数据）不算错误；
                // 把"正在长的半行"推给界面就地更新，不落日志
                Err(ref e) if transport::is_idle_read_error(e) => {
                    if !pending.is_empty() && last_rx.elapsed() >= FLUSH_IDLE {
                        let tail = Chunk {
                            ts_ms: pending_ts,
                            hex: hex::bytes_to_hex(&pending),
                            text: String::from_utf8_lossy(&pending).to_string(),
                            ascii: hex::ascii_column(&pending),
                        };
                        let _ = app.emit("link://tail", serde_json::to_string(&tail).unwrap_or_default());
                    }
                }
                Err(e) => {
                    let _ = app.emit("link://error", format!("读取失败: {e}"));
                    if stream_like {
                        if st.link.lock().expect("link mutex").is_some() {
                            *st.link.lock().expect("link mutex") = None;
                            if AUTO_RECONNECT.load(Ordering::Relaxed) {
                                if let Some(ep @ Endpoint::TcpClient { .. }) = ep_for_reconnect.clone() {
                                    spawn_reconnect(app.clone(), st.clone(), ep);
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
        if !pending.is_empty() {
            log_lines(&app, &pending, pending_ts);
        }
    });
    Ok(())
}

// ── 命令 ──────────────────────────────────────────────────────

#[tauri::command]
fn list_ports() -> Result<Vec<PortInfo>, String> {
    match serialport::available_ports() {
        Ok(ports) => Ok(ports.iter().map(describe).collect()),
        Err(e) => Err(format!("枚举串口失败: {e}")),
    }
}

/// 打开连接。串口 / TCP Client / UDP 立刻建立；TCP Server 先监听，
/// 有客户端连进来后再把状态推给前端。
#[tauri::command]
async fn open_transport(app: AppHandle, endpoint: Endpoint) -> Result<String, String> {
    open_main(&app, endpoint, "user")
}

/// 打开主连接。界面的「连接」按钮和 agent 的 `port_open` 共用这一条 ——
/// agent 连的也是**用户那条连接**，所以状态、日志、按钮全都一致。
/// `by` = "user" / "agent"：前端收到 `main://opened` 会把界面里的连接参数同步过去。
pub(crate) fn open_main(app: &AppHandle, endpoint: Endpoint, by: &str) -> Result<String, String> {
    let ep_json = serde_json::to_value(&endpoint).unwrap_or_default();
    let msg = open_main_inner(app, endpoint)?;
    let _ = app.emit("main://opened", serde_json::json!({ "by": by, "endpoint": ep_json }));
    Ok(msg)
}

fn open_main_inner(app: &AppHandle, endpoint: Endpoint) -> Result<String, String> {
    let state = app.state::<Arc<AppState>>();
    if state.is_busy() {
        return Err("已有一个连接，请先断开".into());
    }

    *state.counters.lock().expect("counters mutex") = (0, 0);
    *state.char_counts.lock().expect("chars mutex") = (0, 0);
    *state.opened_at.lock().expect("opened mutex") = Some(Instant::now());
    *state.endpoint.lock().expect("endpoint mutex") = Some(endpoint.clone());

    let stop = Arc::new(AtomicBool::new(false));
    *state.reader_stop.lock().expect("stop mutex") = Some(stop.clone());

    if let Endpoint::TcpServer { .. } = endpoint {
        let server = transport::bind_server(&endpoint)?;
        let port = server.local_port();
        *state.listener.lock().expect("listener mutex") = Some(server.clone());
        state.log.lock().expect("log mutex").push(
            now_ms(),
            Direction::Sys,
            format!("listen {}", endpoint.label()).into_bytes(),
        );

        let st = state.inner().clone();
        let handle = app.clone();
        std::thread::spawn(move || {
            // 循环收：一个客户端断开后继续等下一个（设备重启/重连能自动接上），
            // 用户不用重新点"连接"。
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let stream = match transport::accept_client(&server, &stop) {
                    Some(s) => s,
                    None => return,
                };
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let addr = stream
                    .peer_addr()
                    .map(|a| a.to_string())
                    .unwrap_or_else(|_| "?".to_string());
                *st.listener.lock().expect("listener mutex") = None;
                if let Some(st0) = handle.try_state::<Arc<AppState>>() {
                    st0.log.lock().expect("log mutex").push(
                        now_ms(),
                        Direction::Sys,
                        format!("客户端接入 {addr}").into_bytes(),
                    );
                }
                let _ = handle.emit("srv-client", format!("接入 {addr}"));
                let _ = handle.emit("link://state", "connected");
                if let Err(e) = start_reader(handle.clone(), st.clone(), Conn::Tcp(stream)) {
                    let _ = handle.emit("link://error", e);
                }
                // 等这条连接结束（reader 会在断开时把 link 清掉）
                while st.link.lock().expect("link mutex").is_some()
                    && !stop.load(Ordering::Relaxed)
                {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                if let Some(st0) = handle.try_state::<Arc<AppState>>() {
                    st0.log.lock().expect("log mutex").push(
                        now_ms(),
                        Direction::Sys,
                        format!("客户端断开 {addr}").into_bytes(),
                    );
                }
                let _ = handle.emit("srv-client", format!("断开 {addr}"));
                *st.reader_stop.lock().expect("stop mutex") =
                    Some(Arc::new(AtomicBool::new(false)));
            }
        });
        return Ok(format!("正在监听，端口 {port}（可反复接入）"));
    }

    let conn = transport::open_endpoint(&endpoint)?;
    // UDP 本地端口填 0 时把系统分配到的真实端口带回去，方便两个实例互指
    let local_hint = match conn.udp() {
        Some(ep) => format!("（本地端口 {}）", ep.local_port()),
        None => String::new(),
    };
    start_reader(app.clone(), state.inner().clone(), conn)?;
    state.log.lock().expect("log mutex").push(
        now_ms(),
        Direction::Sys,
        format!("open {}{}", endpoint.label(), local_hint).into_bytes(),
    );
    Ok(format!("已连接 {}{}", endpoint.label(), local_hint))
}

/// 断开 / 停止监听。
#[tauri::command]
async fn close_transport(app: AppHandle) -> Result<String, String> {
    close_main(&app)
}

/// 断开主连接（界面「断开」和 agent 的 `port_close` 共用）
pub(crate) fn close_main(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<Arc<AppState>>();
    let stop = state.reader_stop.lock().expect("stop mutex").take();
    if let Some(flag) = &stop {
        flag.store(true, Ordering::Relaxed);
    }
    let listening = state.listener.lock().expect("listener mutex").take().is_some();
    let mut link = state.link.lock().expect("link mutex").take();
    if let Some(conn) = link.as_mut() {
        conn.shutdown();
    }
    let label = state
        .endpoint
        .lock()
        .expect("endpoint mutex")
        .take()
        .map(|e| e.label());
    *state.opened_at.lock().expect("opened mutex") = None;

    if link.is_none() && !listening {
        return Err("当前没有连接".into());
    }
    let label = label.unwrap_or_else(|| "?".into());
    state.log.lock().expect("log mutex").push(
        now_ms(),
        Direction::Sys,
        format!("close {label}").into_bytes(),
    );
    Ok(format!("已断开 {label}"))
}

/// 发送。`mode` 取 `text` / `hex`，四种传输共用同一条路径。
#[tauri::command]
async fn write_data(
    app: AppHandle,
    payload: String,
    mode: String,
    line_ending: String,
    raw: Option<bool>,
) -> Result<WriteAck, String> {
    write_main(&app, &payload, &mode, &line_ending, raw.unwrap_or(false))
}

/// 主连接写数据的核心：前端"发送"按钮和 agent 的 `port_write` 工具共用这一条 ——
/// agent 也走这里发，它的 TX 才会落进用户在传输页看到的那份日志。
pub(crate) fn write_main(
    app: &AppHandle,
    payload: &str,
    mode: &str,
    line_ending: &str,
    raw: bool,
) -> Result<WriteAck, String> {
    let state = app.state::<Arc<AppState>>();
    // `raw = true`：ASCII 交互(终端)模式专用 —— 一个字符都不加工，原样写出去。
    // 关键是"不剥末尾换行"：终端里敲回车本来就只发一个 "\r"，
    // 如果交给 `LineEnding::encode`，它会把末尾换行当成"用户多打的回车"剥掉，
    // 结果编码成空串，设备永远收不到回车（ASCII 模式下敲不动的根因）。
    let bytes: Vec<u8> = if raw {
        payload.as_bytes().to_vec()
    } else {
        let le =
            LineEnding::parse(line_ending).ok_or_else(|| format!("未知行尾: {line_ending}"))?;
        match mode {
            "hex" => {
                let mut v =
                    hex::hex_to_bytes(payload).map_err(|e| format!("HEX 解析失败: {e}"))?;
                v.extend_from_slice(le.bytes());
                v
            }
            // 行尾完全由"行尾"设置决定：末尾的换行会先被剥掉，
            // 中间换行保留（`encode` 里有单测）
            "text" => le.encode(payload),
            other => return Err(format!("未知发送模式: {other}")),
        }
    };

    if bytes.is_empty() {
        return Err("没有可发送的内容".into());
    }

    {
        let mut guard = state.link.lock().expect("link mutex");
        let conn = guard
            .as_mut()
            .ok_or("还没有连接（TCP Server 需要先等客户端接入）")?;
        conn.write_paced(&bytes)
            .map_err(|e| format!("发送失败: {e}"))?;
    }

    state
        .log
        .lock()
        .expect("log mutex")
        .push(now_ms(), Direction::Tx, bytes.clone());
    state.counters.lock().expect("counters mutex").0 += bytes.len() as u64;
    state.char_counts.lock().expect("chars mutex").0 +=
        String::from_utf8_lossy(&bytes).chars().count() as u64;

    Ok(WriteAck {
        bytes: bytes.len(),
        hex: hex::bytes_to_hex(&bytes),
        ascii: hex::ascii_column(&bytes),
        text: String::from_utf8_lossy(&bytes).to_string(),
    })
}

#[tauri::command]
fn get_log(state: State<'_, Arc<AppState>>) -> Vec<LogLine> {
    state.log.lock().expect("log mutex").lines().to_vec()
}

/// 页面缩放（设置里的"字号 × 放大"）。用 WebView 自己的页面缩放，所以控件、文本、字号一起变，
/// 而且是**叠加**在系统显示缩放之上的（系统 125% + 用户 110% = 实际 137.5%）。
#[tauri::command]
fn window_set_zoom(app: AppHandle, scale: f64) -> Result<(), String> {
    let s = if scale.is_finite() { scale.clamp(0.5, 3.0) } else { 1.0 };
    if let Some(w) = app.get_webview_window("main") {
        w.set_zoom(s).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 本机 IPv4 地址（agent 开 TCP 服务端 / UDP 时要告诉用户连哪个地址）。
/// 两条路：先按主机名解析（能拿到多张网卡的地址），拿不到再用"UDP connect 问路由"兜一下。
pub(crate) fn local_ips() -> Vec<String> {
    use std::net::ToSocketAddrs;
    let mut out: Vec<String> = Vec::new();
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if let Ok(list) = (format!("{name}:0"), 0u16).to_socket_addrs() {
            for a in list {
                if let std::net::IpAddr::V4(v4) = a.ip() {
                    let s = v4.to_string();
                    if !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        }
    }
    if out.is_empty() {
        if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
            // UDP 的 connect 只是记下对端/问一下路由表，不会真的发包
            if s.connect("8.8.8.8:80").is_ok() {
                if let Ok(a) = s.local_addr() {
                    out.push(a.ip().to_string());
                }
            }
        }
    }
    out
}

#[tauri::command]
fn net_interfaces() -> Vec<serde_json::Value> {
    let script = "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | \
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | \
        Select-Object InterfaceAlias,IPAddress,InterfaceIndex | ConvertTo-Json -Compress";
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return Vec::new();
    };
    match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![v],
        _ => Vec::new(),
    }
}

/// 主连接最近的收发记录（agent 的 `port_read` 读的就是用户在传输页看到的那一份）
pub(crate) fn main_log_lines(app: &AppHandle, tail: usize) -> Vec<LogLine> {
    let state = app.state::<Arc<AppState>>();
    let log = state.log.lock().expect("log mutex");
    let lines = log.lines();
    let from = lines.len().saturating_sub(tail.max(1));
    lines[from..].to_vec()
}

/// 把主连接最近的收发记录排成人话：`[14:32:05.123] RX 内容`
pub(crate) fn main_log_text(app: &AppHandle, tail: usize) -> String {
    let lines = main_log_lines(app, tail);
    if lines.is_empty() {
        return "（主连接还没有任何收发记录 —— 用户可能还没连接，或者还没收发过）".to_string();
    }
    let mut out = String::new();
    for l in &lines {
        let dir = match l.dir {
            Direction::Rx => "RX",
            Direction::Tx => "TX",
            Direction::Sys => "SYS",
        };
        let stamp = match local_hms(l.ts_ms) {
            Some((h, m, s, ms)) => format!("{h:02}:{m:02}:{s:02}.{ms:03}"),
            None => format!("{}", l.ts_ms),
        };
        let text = String::from_utf8_lossy(&l.data);
        let clean = text.replace('\r', "");
        let printable = !clean.trim().is_empty() && clean.chars().all(|c| !c.is_control());
        let body = if printable {
            clean.replace('\n', "↵")
        } else {
            hex::bytes_to_hex(&l.data)
        };
        out.push_str(&format!("[{stamp}] {dir} {body}\n"));
    }
    out
}

/// 毫秒时间戳 → 本地钟点（Windows 的 FileTime 转换帮忙算时区/夏令时，不引时间库）
#[cfg(windows)]
fn local_hms(ts_ms: i64) -> Option<(u16, u16, u16, u16)> {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct SystemTimeW {
        year: u16,
        month: u16,
        dow: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        ms: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToLocalFileTime(inp: *const FileTime, out: *mut FileTime) -> i32;
        fn FileTimeToSystemTime(ft: *const FileTime, st: *mut SystemTimeW) -> i32;
    }
    if ts_ms <= 0 {
        return None;
    }
    // 1601-01-01 到 1970-01-01 的 100ns 数
    let ticks = (ts_ms as i128) * 10_000 + 116_444_736_000_000_000i128;
    let ft = FileTime { low: (ticks as u64 & 0xFFFF_FFFF) as u32, high: (ticks >> 32) as u32 };
    let mut lt = FileTime::default();
    let mut st = SystemTimeW::default();
    unsafe {
        if FileTimeToLocalFileTime(&ft, &mut lt) == 0 {
            return None;
        }
        if FileTimeToSystemTime(&lt, &mut st) == 0 {
            return None;
        }
    }
    Some((st.hour, st.minute, st.second, st.ms))
}

#[cfg(not(windows))]
fn local_hms(_ts_ms: i64) -> Option<(u16, u16, u16, u16)> {
    None
}

#[tauri::command]
fn clear_log(state: State<'_, Arc<AppState>>) {
    state.log.lock().expect("log mutex").clear();
}

#[tauri::command]
async fn get_stats(app: AppHandle) -> Result<Stats, String> {
    stats_of(&app)
}

/// 主连接状态（界面的 get_stats 与 agent 的 port_state 共用）
pub(crate) fn stats_of(app: &AppHandle) -> Result<Stats, String> {
    let state = app.state::<Arc<AppState>>();
    let log = state.log.lock().expect("log mutex");
    // try_lock：设备读写/升级这类"独占连接"的操作会把 link 占住很久，
    // 而 get_stats 是前端每 500ms 轮询一次的 —— 用 lock() 会把主线程（同步命令跑在主线程）冻住，
    // 整个界面就"无响应"了。拿不到锁就按 endpoint 判断，够界面用。
    let connected = match state.link.try_lock() {
        Ok(g) => g.is_some(),
        Err(_) => state.endpoint.lock().map(|e| e.is_some()).unwrap_or(false),
    };
    let listening = state.listener.lock().expect("listener mutex").is_some();
    let endpoint = state.endpoint.lock().expect("endpoint mutex").clone();
    let opened = *state.opened_at.lock().expect("opened mutex");
    let (tx, rx) = *state.counters.lock().expect("counters mutex");
    let (tx_chars, rx_chars) = *state.char_counts.lock().expect("chars mutex");

    let elapsed_ms = opened.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
    let secs = elapsed_ms as f64 / 1000.0;
    Ok(Stats {
        connected,
        listening,
        mode: endpoint.as_ref().map(|e| e.mode().to_string()),
        label: endpoint.as_ref().map(|e| e.label()),
        tx_bytes: tx,
        rx_bytes: rx,
        tx_chars,
        rx_chars,
        elapsed_ms,
        tx_rate: if secs > 0.0 { tx as f64 / secs } else { 0.0 },
        rx_rate: if secs > 0.0 { rx as f64 / secs } else { 0.0 },
        log_lines: log.len(),
    })
}

#[tauri::command]
fn save_session(state: State<'_, Arc<AppState>>, path: String) -> Result<usize, String> {
    let log = state.log.lock().expect("log mutex");
    let text = log.to_jsonl();
    let n = log.len();
    drop(log);
    std::fs::write(&path, text).map_err(|e| format!("写入 {path} 失败: {e}"))?;
    Ok(n)
}

#[tauri::command]
fn load_session(state: State<'_, Arc<AppState>>, path: String) -> Result<usize, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 {path} 失败: {e}"))?;
    let loaded = SessionLog::from_jsonl(&text).map_err(|e| format!("解析 {path} 失败: {e}"))?;
    let n = loaded.len();
    *state.log.lock().expect("log mutex") = loaded;
    Ok(n)
}

#[tauri::command]
fn export_csv(state: State<'_, Arc<AppState>>, path: String) -> Result<usize, String> {
    let log = state.log.lock().expect("log mutex");
    let csv = log.to_csv();
    let n = log.len();
    drop(log);
    std::fs::write(&path, csv).map_err(|e| format!("写入 {path} 失败: {e}"))?;
    Ok(n)
}

#[tauri::command]
fn replay_plan(state: State<'_, Arc<AppState>>, speed: f64) -> Vec<u64> {
    state.log.lock().expect("log mutex").replay_gaps(speed)
}

/// 读超时常量暴露给前端展示（也顺手证明四种传输共用同一套 reader 节奏）。
#[tauri::command]
fn poll_timeout_ms() -> u64 {
    transport::POLL_TIMEOUT.as_millis() as u64
}

// ── 入口 ──────────────────────────────────────────────────────

// ---------------------------------------------------------------- 固件升级
// 极简界面: 本地/服务器选一个包 -> 看版本号 -> 点升级; 过程全部打到主输出窗口

#[derive(Default)]
struct UpgState {
    running: bool,
    percent: f64,
    text: String,
}

static UPG: LazyLock<Mutex<UpgState>> = LazyLock::new(|| Mutex::new(UpgState::default()));

#[derive(Serialize)]
struct UpgSnapshot {
    running: bool,
    percent: f64,
    text: String,
}

#[tauri::command]
fn upgrade_state() -> UpgSnapshot {
    let s = UPG.lock().expect("upg mutex");
    UpgSnapshot {
        running: s.running,
        percent: s.percent,
        text: s.text.clone(),
    }
}

fn upg_set(running: bool, percent: f64, text: impl Into<String>) {
    let mut s = UPG.lock().expect("upg mutex");
    s.running = running;
    s.percent = percent;
    s.text = text.into();
}

/// 一行升级输出: 进主输出窗口(SessionLog 的 SYS 行) + 前端事件
fn upg_log(app: &AppHandle, text: &str) {
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.log
            .lock()
            .expect("log mutex")
            .push(now_ms(), Direction::Sys, text.as_bytes().to_vec());
    }
    let _ = app.emit("upgrade://log", text.to_string());
}

fn upg_progress(app: &AppHandle, pct: f64, text: impl Into<String>) {
    let t: String = text.into();
    upg_set(true, pct, t.clone());
    let _ = app.emit(
        "upgrade://state",
        serde_json::json!({"running": true, "percent": pct, "text": t}),
    );
}

/// 本地 .fw -> 版本等信息(只解析包头, 不重新上传数据)
#[tauri::command]
fn fw_info_local(name: String, data: Vec<u8>) -> Result<upgrade::FwInfo, String> {
    upgrade::parse_fw(&data, &name)
}

/// 服务器网址(manifest.json / firmware-data.json / 单个 .fw) -> 最新包的版本信息
#[tauri::command]
fn fw_info_server(url: String) -> Result<upgrade::FwInfo, String> {
    if url.trim().is_empty() {
        return Err("请填服务器地址".into());
    }
    let u = upgrade::normalize_server_url(&url);
    if u.to_lowercase().ends_with(".fw") {
        let data = upgrade::http_get(&u)?;
        return upgrade::parse_fw(&data, &u);
    }
    let items = upgrade::fetch_server_items(&u)?;
    let it = items.first().ok_or_else(|| "服务器上没有可用固件".to_string())?;
    let mut ver = it.version.clone();
    if !upgrade::ver_is_3seg(&ver) {
        ver.push_str(" (老的四段格式, 设备会拒)");
    }
    Ok(upgrade::FwInfo {
        version: ver,
        payload_size: 0,
        payload_crc32: it.payload_crc32.unwrap_or(0),
        file_size: it.size as u32,
        file_crc32: it.crc32.unwrap_or(0),
        board: it.board.clone(),
        name: it.name.clone(),
    })
}

// ── 设备文件: 列目录 / 把指定文件拉回本机(网口走服务通道, 串口走 cshell) ──

/// 独占连接的操作用它排队：界面上"发完自动刷列表"和用户手点很容易撞一起，
/// 撞上了第二个会拿到空连接、报一条看不懂的错。串起来就没这事了。
static LINK_OP: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 独占当前连接做一件事(先停 reader，做完再把连接还给 reader)
fn with_link<T>(
    app: &AppHandle,
    st: &Arc<AppState>,
    f: impl FnOnce(Conn) -> (Result<T, String>, Conn),
) -> Result<T, String> {
    let _serial = LINK_OP.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(stop) = st.reader_stop.lock().expect("stop mutex").as_ref() {
        stop.store(true, Ordering::Relaxed);
    }
    std::thread::sleep(std::time::Duration::from_millis(450));
    let conn = st
        .link
        .lock()
        .expect("link mutex")
        .take()
        .ok_or_else(|| "还没有连接：先在这页(或【传输】页)连上设备".to_string())?;
    let (res, back) = f(conn);
    std::thread::sleep(std::time::Duration::from_millis(200));
    *st.reader_stop.lock().expect("stop mutex") = Some(Arc::new(AtomicBool::new(false)));
    if let Err(e) = start_reader(app.clone(), st.clone(), back) {
        return Err(format!("用完把连接还回去失败: {e}"));
    }
    res
}

fn does_list(
    app: &AppHandle,
    st: &Arc<AppState>,
    ep: &Endpoint,
    path: &str,
) -> Result<Vec<upgrade::SvcEntry>, String> {
    match ep {
        Endpoint::TcpClient { .. } => with_link(app, st, |conn| {
            let mut svc = upgrade::Svc::from_conn(conn);
            let r = svc.list_dir(path);
            (r, svc.into_conn())
        }),
        Endpoint::Serial { .. } => with_link(app, st, |mut conn| {
            let r = upgrade::serial_list(&mut conn, path);
            (r, conn)
        }),
        other => Err(format!(
            "当前是 {}，设备文件只支持【串口】或【TCP Client(6666)】",
            other.label()
        )),
    }
}

fn does_pull(
    app: &AppHandle,
    st: &Arc<AppState>,
    ep: &Endpoint,
    path: &str,
    save_to: &str,
) -> Result<upgrade::PullResult, String> {
    let a1 = app.clone();
    match ep {
        Endpoint::TcpClient { .. } => with_link(app, st, |conn| {
            let mut svc = upgrade::Svc::from_conn(conn);
            let a2 = a1.clone();
            let r = upgrade::svc_pull(&mut svc, path, save_to, move |s| upg_log(&a2, s));
            (r, svc.into_conn())
        }),
        Endpoint::Serial { .. } => with_link(app, st, |mut conn| {
            let a2 = a1.clone();
            let r = upgrade::serial_pull(&mut conn, path, save_to, move |s| upg_log(&a2, s));
            (r, conn)
        }),
        other => Err(format!(
            "当前是 {}，设备文件只支持【串口】或【TCP Client(6666)】",
            other.label()
        )),
    }
}

fn does_upload(
    app: &AppHandle,
    st: &Arc<AppState>,
    ep: &Endpoint,
    path: &str,
    data: &[u8],
) -> Result<u32, String> {
    let a1 = app.clone();
    match ep {
        Endpoint::TcpClient { .. } => with_link(app, st, |conn| {
            let mut svc = upgrade::Svc::from_conn(conn);
            let a2 = a1.clone();
            let r = upgrade::svc_upload(&mut svc, path, data, move |s| upg_log(&a2, s));
            (r, svc.into_conn())
        }),
        Endpoint::Serial { .. } => with_link(app, st, |mut conn| {
            let a2 = a1.clone();
            let r = upgrade::serial_upload(&mut conn, path, data, move |s| upg_log(&a2, s));
            (r, conn)
        }),
        other => Err(format!(
            "当前是 {}，设备文件只支持【串口】或【TCP Client(6666)】",
            other.label()
        )),
    }
}

/// 把本机文件写到设备上
#[tauri::command]
async fn device_upload(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    data: Vec<u8>,
) -> Result<u32, String> {
    if path.trim().is_empty() {
        return Err("没给设备上的目标路径".into());
    }
    if data.is_empty() {
        return Err("本机文件是空的".into());
    }
    let st = state.inner().clone();
    let ep = st
        .endpoint
        .lock()
        .expect("endpoint mutex")
        .clone()
        .ok_or_else(|| "还没有连接：先连上设备".to_string())?;
    tauri::async_runtime::spawn_blocking(move || does_upload(&app, &st, &ep, &path, &data))
        .await
        .map_err(|e| format!("线程失败: {e}"))?
}

/// 默认保存目录：有「下载」文件夹就用它，否则用用户主目录
#[tauri::command]
fn default_save_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    let dl = std::path::Path::new(&home).join("Downloads");
    if dl.is_dir() {
        dl.to_string_lossy().to_string()
    } else {
        home
    }
}

/// 在资源管理器里打开一个目录（传输页顶部那行"日志路径"点一下就用它）
/// 算一个文件的校验值（CRC16/CRC32/MD5/SHA1/SHA256），可选只算某一段。
/// 放后端做：按 1MB 分块流式读，几百 MB 的固件也不会把前端卡住。
#[tauri::command]
fn file_digest(path: String, offset: Option<u64>, length: Option<u64>) -> Result<serde_json::Value, String> {
    checksum::file_digest(&path, offset.unwrap_or(0), length.unwrap_or(0))
}

/// 读一个文本文件（批量文本页的「导入…」和拖文件进来都用它）。
/// 走 Rust 而不是前端的 fs 插件：前端那条被文件选择器的授权框着，拖进来的路径读不了。
/// 默认上限 16MB（文本工具够用），超了直接说清楚；不是合法 UTF-8 时按替换字符给，并告诉前端。
#[tauri::command]
fn file_read_text(path: String, max_bytes: Option<u64>) -> Result<serde_json::Value, String> {
    let cap = max_bytes.unwrap_or(16 * 1024 * 1024);
    let meta = std::fs::metadata(&path).map_err(|e| format!("读不到文件: {e}"))?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > cap {
        return Err(format!(
            "文件太大（{:.1} MB），这里最多读 {:.0} MB —— 先切一段再导吧",
            meta.len() as f64 / 1048576.0,
            cap as f64 / 1048576.0
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到文件: {e}"))?;
    let (text, utf8) = match String::from_utf8(bytes.clone()) {
        Ok(t) => (t, true),
        Err(_) => (String::from_utf8_lossy(&bytes).to_string(), false),
    };
    let eol = if text.contains("\r\n") { "CRLF" } else if text.contains('\n') { "LF" } else { "—" };
    Ok(serde_json::json!({ "text": text, "bytes": bytes.len(), "utf8": utf8, "eol": eol }))
}
/// 读一个二进制文件并把内容按 base64 返回（逻辑分析仪的原始二进制导入用）。
/// 默认上限 64MB —— base64 之后还要过一遍 JSON，太大就别走了。
#[tauri::command]
fn file_read_bytes(path: String, max_bytes: Option<u64>) -> Result<serde_json::Value, String> {
    let cap = max_bytes.unwrap_or(64 * 1024 * 1024);
    let meta = std::fs::metadata(&path).map_err(|e| format!("读不到文件: {e}"))?;
    if !meta.is_file() { return Err("这不是一个文件".into()); }
    if meta.len() > cap {
        return Err(format!("文件太大（{:.1} MB），最多 {:.0} MB", meta.len() as f64 / 1048576.0, cap as f64 / 1048576.0));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到文件: {e}"))?;
    Ok(serde_json::json!({ "bytes": base64_encode(&bytes), "size": bytes.len() }))
}

/// base64（标准字母表，带 padding）—— 只给上面那个命令用，不引依赖
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 按路径写文本文件（la_save 用：agent 没法走文件选择框）。上限 128MB。
#[tauri::command]
fn file_write_text(path: String, content: String) -> Result<serde_json::Value, String> {
    if content.len() > 128 * 1024 * 1024 { return Err("内容太大（>128MB）".into()); }
    if let Some(dir) = std::path::Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() { std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?; }
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写不进去: {e}"))?;
    Ok(serde_json::json!({ "bytes": content.len() }))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {path}"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("只在 Windows 上实现了打开目录".into())
    }
}

/// 列设备上的目录
#[tauri::command]
async fn device_list(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<upgrade::SvcEntry>, String> {
    let st = state.inner().clone();
    let ep = st
        .endpoint
        .lock()
        .expect("endpoint mutex")
        .clone()
        .ok_or_else(|| "还没有连接：先连上设备".to_string())?;
    let p = if path.trim().is_empty() { "/".to_string() } else { path.trim().to_string() };
    tauri::async_runtime::spawn_blocking(move || does_list(&app, &st, &ep, &p))
        .await
        .map_err(|e| format!("线程失败: {e}"))?
}

/// 把设备上的指定文件拉回本机
#[tauri::command]
async fn device_pull(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    save_to: String,
) -> Result<upgrade::PullResult, String> {
    if save_to.trim().is_empty() {
        return Err("没给保存路径".into());
    }
    let st = state.inner().clone();
    let ep = st
        .endpoint
        .lock()
        .expect("endpoint mutex")
        .clone()
        .ok_or_else(|| "还没有连接：先连上设备".to_string())?;
    tauri::async_runtime::spawn_blocking(move || does_pull(&app, &st, &ep, &path, &save_to))
        .await
        .map_err(|e| format!("线程失败: {e}"))?
}

/// 读服务器上的**全部**可用包(给版本下拉框用)：
/// 既能吃 manifest.json / firmware-data.json，也能直接吃一个 .fw 地址。
#[tauri::command]
fn server_fw_list(url: String) -> Result<Vec<upgrade::ServerItem>, String> {
    if url.trim().is_empty() {
        return Err("请填服务器地址".into());
    }
    let u = upgrade::normalize_server_url(&url);
    if u.to_ascii_lowercase().ends_with(".fw") {
        let data = upgrade::http_get(&u)?;
        let name = upgrade::url_basename(&u);
        let info = upgrade::parse_fw(&data, &name)?;
        return Ok(vec![upgrade::ServerItem {
            version: info.version,
            name,
            url: u,
            size: data.len() as u64,
            crc32: Some(info.file_crc32),
            payload_crc32: Some(info.payload_crc32),
            board: info.board,
        }]);
    }
    upgrade::fetch_server_items(&u)
}

/// 点【升级】: 按当前连接方式自动选串口 / 网口
#[tauri::command]
fn start_upgrade(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    source: String,
    url: String,
    name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if UPG.lock().expect("upg mutex").running {
        return Err("上一次升级还没结束".into());
    }
    let endpoint = state
        .endpoint
        .lock()
        .expect("endpoint mutex")
        .clone()
        .ok_or_else(|| "请先连接设备: 串口选 COM 口, 网口用 TCP Client 连 设备IP:6666".to_string())?;
    let st = state.inner().clone();
    upg_set(true, 0.0, "准备升级 ...");
    let _ = app.emit(
        "upgrade://state",
        serde_json::json!({"running": true, "percent": 0.0, "text": "准备升级 ..."}),
    );

    std::thread::spawn(move || {
        let a1 = app.clone();
        let mut log = move |s: &str| upg_log(&a1, s);
        let a2 = app.clone();
        let mut prog = move |p: f64| {
            let t = if p >= 100.0 {
                "升级成功".to_string()
            } else if p >= 90.0 {
                "设备重启中，等待新固件 ...".to_string()
            } else if p >= 85.0 {
                "上传完成，设备侧校验中 ...".to_string()
            } else {
                format!("上传中 {:.0}%", p / 80.0 * 100.0)
            };
            upg_progress(&a2, p, t);
        };
        let mut ctx = upgrade::Ctx {
            log: &mut log,
            progress: &mut prog,
        };

        let result: Result<(), String> = (|| {
            // 1) 取固件(本地 or 服务器)
            let (fw_name, bytes) = if source == "server" {
                let url = upgrade::normalize_server_url(&url);
                // 前端把"版本下拉框选中的那一个"排在第一位；地址直接是 .fw 就单开一条
                let mut items = if url.to_ascii_lowercase().ends_with(".fw") {
                    let name = upgrade::url_basename(&url);
                    upg_log(&app, &format!("[升级] 直接下载: {}\n", url));
                    vec![upgrade::ServerItem {
                        version: String::new(),
                        name,
                        url: url.clone(),
                        size: 0,
                        crc32: None,
                        payload_crc32: None,
                        board: String::new(),
                    }]
                } else {
                    upg_log(&app, &format!("[升级] 服务器清单: {}\n", url));
                    upgrade::fetch_server_items(&url)?
                };
                let it = items.remove(0);
                let ver = if it.version.is_empty() {
                    "(包内版本)".to_string()
                } else {
                    format!("v{}", it.version)
                };
                upg_log(&app, &format!("[升级] 选中 {} {}\n", it.name, ver));
                let d = upgrade::download_fw(&mut ctx, &it)?;
                (it.name.clone(), d)
            } else {
                if data.is_empty() {
                    return Err("还没有选择固件文件".into());
                }
                let nm = if name.is_empty() {
                    "fw.fw".to_string()
                } else {
                    name.clone()
                };
                (nm, data)
            };
            let info = upgrade::parse_fw(&bytes, &fw_name)?;
            upg_log(
                &app,
                &format!(
                    "[升级] 包: {}  v{}  payload {} B  crc32={:08X}\n",
                    info.name, info.version, info.payload_size, info.payload_crc32
                ),
            );

            // 2) 按当前连接方式升级。两种方式都要独占"当前连接":
            //    串口 -> 停 reader 拿串口; 网口 -> 停 reader 复用那条 TCP
            //    (F4 只有一条服务 socket, 再开第二条会被静默丢掉)
            let take_link = |st: &Arc<AppState>| -> Option<Conn> {
                if let Some(stop) = st.reader_stop.lock().expect("stop mutex").as_ref() {
                    stop.store(true, Ordering::Relaxed);
                }
                std::thread::sleep(std::time::Duration::from_millis(450));
                st.link.lock().expect("link mutex").take()
            };

            match endpoint.clone() {
                Endpoint::TcpClient { host, port, .. } => {
                    if host.trim().is_empty() {
                        return Err("TCP Client 没填目标 IP".into());
                    }
                    let conn = take_link(&st);
                    let r = match conn {
                        Some(c) if matches!(c, Conn::Tcp(_)) => {
                            upg_log(&app, "[升级] 复用已经连好的那条网络连接\n");
                            let svc = upgrade::Svc::from_conn(c);
                            upgrade::net_upgrade_conn(&mut ctx, svc, &host, port, &fw_name, &bytes)
                        }
                        other => {
                            drop(other);
                            upgrade::net_upgrade(&mut ctx, &host, port, &fw_name, &bytes)
                        }
                    };
                    r
                }
                Endpoint::Udp {
                    local_addr,
                    remote_host,
                    remote_port,
                    ..
                } => {
                    if remote_host.trim().is_empty() || remote_port == 0 {
                        return Err("UDP 升级要填目标 IP 和端口".into());
                    }
                    let conn = take_link(&st);
                    let r = match conn {
                        Some(c) if matches!(c, Conn::Udp(_)) => {
                            upg_log(&app, "[升级] 复用已经连好的 UDP 连接\n");
                            let svc = upgrade::Svc::from_conn(c);
                            upgrade::net_upgrade_conn(&mut ctx, svc, &remote_host, remote_port, &fw_name, &bytes)
                        }
                        other => {
                            drop(other);
                            upgrade::net_upgrade_udp(
                                &mut ctx,
                                local_addr.as_deref(),
                                &remote_host,
                                remote_port,
                                &fw_name,
                                &bytes,
                            )
                        }
                    };
                    r
                }
                Endpoint::Serial { .. } => {
                    let conn = take_link(&st);
                    let mut conn = match conn {
                        Some(c) => c,
                        None => return Err("请先在左边点【连接】再升级".into()),
                    };
                    upgrade::serial_upgrade(&mut ctx, &mut conn, &fw_name, &bytes)
                }
                other => Err(format!(
                    "当前是 {} 连接, 升级请用【串口】或【TCP Client】(默认 6666 端口)",
                    other.label()
                )),
            }
        })();

        // 升级(或失败)之后把连接还给界面: 按原 Endpoint 重连一次
        {
            let ep = {
                let g = st.endpoint.lock().expect("endpoint mutex");
                g.clone()
            };
            if let Some(ep) = ep {
                std::thread::sleep(std::time::Duration::from_millis(400));
                match transport::open_endpoint(&ep) {
                    Ok(conn) => {
                        *st.reader_stop.lock().expect("stop mutex") =
                            Some(Arc::new(AtomicBool::new(false)));
                        if let Err(e) = start_reader(app.clone(), st.clone(), conn) {
                            upg_log(&app, &format!("[升级] 提示: 升级后自动重连失败({}), 请手动连接\n", e));
                        }
                    }
                    Err(e) => upg_log(
                        &app,
                        &format!("[升级] 提示: 升级后自动重连失败({}), 请手动点【连接】\n", e),
                    ),
                }
            }
        }

        match result {
            Ok(()) => {
                // 注意：这里必须用 upg_set(false,..) 而不是 upg_progress(..)。
                // 后者会把 running 又置回 true，界面就会一直卡在"升级中 100%"
                // （按钮 disabled 不放，下一次升级还会被"上一次还没结束"挡住）。
                upg_set(false, 100.0, "升级成功");
                upg_log(&app, "\n[升级] 升级成功\n");
                let _ = app.emit(
                    "upgrade://state",
                    serde_json::json!({"running": false, "percent": 100.0, "text": "升级成功"}),
                );
            }
            Err(e) => {
                upg_set(false, 0.0, format!("升级失败: {}", e));
                upg_log(&app, &format!("\n[升级] 失败: {}\n", e));
                let _ = app.emit(
                    "upgrade://state",
                    serde_json::json!({"running": false, "percent": 0.0,"text": format!("升级失败: {}", e)}),
                );
            }
        }
    });
    Ok(())
}

/// 内嵌一份图标做兜底：`app.default_window_icon()` 在开发运行时常常是 None
/// （图标是打包阶段才进资源的），结果就是**任务栏按钮和托盘都没有图标**。
fn fallback_icon() -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).ok()
}

/// 设置**大图标**（任务栏按钮 / Alt-Tab 用的那个）。
/// 为什么得自己来：tao 的 `set_window_icon` 内部只 `WM_SETICON(ICON_SMALL)`
/// （见 tao 源码 window.rs `IconType::Small`），大图标从来没设过 ——
/// 任务栏就只能退回 exe 图标，丢了就是空白/默认图标。
#[cfg(windows)]
fn set_big_icon(window: &tauri::WebviewWindow, img: &tauri::image::Image<'_>) {
    #[link(name = "user32")]
    extern "system" {
        fn CreateIconIndirect(info: *mut IconInfo) -> isize;
        fn SendMessageW(h: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateBitmap(w: i32, h: i32, planes: u32, bpp: u32, bits: *const u8) -> isize;
    }
    #[repr(C)]
    struct IconInfo {
        f_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        hbm_mask: isize,
        hbm_color: isize,
    }
    const WM_SETICON: u32 = 0x0080;
    const ICON_BIG: usize = 1;
    let (w, h) = (img.width() as i32, img.height() as i32);
    if w <= 0 || h <= 0 {
        return;
    }
    // CreateBitmap 要的是 BGRA
    let mut bgra = Vec::with_capacity(img.rgba().len());
    for px in img.rgba().chunks_exact(4) {
        bgra.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    unsafe {
        let color = CreateBitmap(w, h, 1, 32, bgra.as_ptr());
        let mask = CreateBitmap(w, h, 1, 1, std::ptr::null());
        if color == 0 || mask == 0 {
            return;
        }
        let mut info = IconInfo {
            f_icon: 1,
            x_hotspot: 0,
            y_hotspot: 0,
            hbm_mask: mask,
            hbm_color: color,
        };
        let hicon = CreateIconIndirect(&mut info);
        if hicon != 0 {
            if let Ok(hwnd) = window.hwnd() {
                SendMessageW(hwnd.0 as isize, WM_SETICON, ICON_BIG, hicon);
            }
        }
        // 位图交给系统句柄持有；HICON 故意不销毁 —— 它跟着窗口一辈子（进程退出时回收）
    }
}

/// 把窗口拉回显示器工作区。
/// 从 window-state 恢复出来的位置可能已经不在可见区域（换显示器/改缩放，或者存的是
/// 最大化时那个 -8 的坐标）—— 那就"看不见"了。这里把它夹回工作区内。
#[cfg(windows)]
fn clamp_to_work_area(w: &tauri::WebviewWindow) {
    #[repr(C)]
    struct RECT {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb: u32,
        rc: RECT,
        work: RECT,
        flags: u32,
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(h: isize, r: *mut RECT) -> i32;
        fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn MonitorFromWindow(h: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(mon: isize, info: *mut MONITORINFO) -> i32;
    }
    let Ok(h) = w.hwnd() else { return };
    let hwnd = h.0 as isize;
    unsafe {
        let mut r = RECT { l: 0, t: 0, r: 0, b: 0 };
        if GetWindowRect(hwnd, &mut r) == 0 {
            return;
        }
        let mon = MonitorFromWindow(hwnd, 2);
        let mut mi = MONITORINFO {
            cb: std::mem::size_of::<MONITORINFO>() as u32,
            rc: RECT { l: 0, t: 0, r: 0, b: 0 },
            work: RECT { l: 0, t: 0, r: 0, b: 0 },
            flags: 0,
        };
        if mon == 0 || GetMonitorInfoW(mon, &mut mi) == 0 {
            return;
        }
        let work = mi.work;
        let (mut x, mut y) = (r.l, r.t);
        let (mut cx, mut cy) = (r.r - r.l, r.b - r.t);
        let mut moved = false;
        if cx > work.r - work.l {
            cx = work.r - work.l;
            moved = true;
        }
        if cy > work.b - work.t {
            cy = work.b - work.t;
            moved = true;
        }
        if x < work.l {
            x = work.l;
            moved = true;
        }
        if y < work.t {
            y = work.t;
            moved = true;
        }
        if x + cx > work.r {
            x = work.r - cx;
            moved = true;
        }
        if y + cy > work.b {
            y = work.b - cy;
            moved = true;
        }
        if moved {
            SetWindowPos(hwnd, 0, x, y, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
}

// ── 启动画面 ──────────────────────────────────────────────────────
// 启动画面是 tauri.conf.json 的 `app.windows[0]`（label = "splash"）：Tauri 在 setup 之前就把它
// 建好了，比"前端跑起来"更早 —— "主窗口藏着、前端还没画出来"那段空白靠它顶着。主窗口在同配置里
// 也是 visible:false；前端把第一屏画完会调 `ui_ready`：关掉 splash、把主窗口放出来（另有 6 秒兜底）。
//
// 为什么不照以前那样由前端 invoke("splash_show") 来建：那条路上它必须等 index.html + main.js
// 下载解析执行完（实测温启动 ~900ms 才轮到它出现），而它又在第一屏画完时立刻被关掉，于是只活
// 0.35~0.55 秒 —— 看起来就像"没有启动画面"（实测时间线：0→940ms 屏幕上什么都没有）。
/// 启动阶段是否已经收尾（`ui_ready` 跑过）。启动画面只属于"启动那一下"：收尾之后再放出来，
/// 就是一个没边框、不在任务栏、还置顶的小窗，用户关不掉（它没有标题栏）。
static UI_READY_DONE: AtomicBool = AtomicBool::new(false);

// 启动画面的底色。WebView2 画出第一帧之前窗口里是**默认白底**（实测 t+0 整窗 #FFFFFF，
// t+120ms 才画上深色卡片），暗色界面上等于闪一下白，所以窗口一建好就把底色按用户主题定下来。
fn splash_bg_hsl(app: &AppHandle) -> (f64, f64, f64) {
    let prefs = ui_prefs_get(app.clone());
    let theme = prefs.get("theme").and_then(|v| v.as_str()).unwrap_or("dark");
    if theme == "light" {
        // 亮色主题：splash.html 的 --bg 不跟着配色走（保持 220 43% 97%）
        return (220.0, 43.0, 97.0);
    }
    // 主色相表要和 src/main.js 里的 SCHEMES、splash.html 里的 HUES 同步（三处同源）
    let scheme = prefs.get("scheme").and_then(|v| v.as_str()).unwrap_or("ocean");
    let hue = match scheme {
        "slate" => 220.0,
        "ocean" => 205.0,
        "mint" => 167.0,
        "forest" => 128.0,
        "twilight" => 255.0,
        "amber" => 35.0,
        "sakura" => 338.0,
        _ => 205.0,
    };
    // dark / auto 都按暗色走：auto 要知道系统深浅色，为 WebView 首帧那几十毫秒去读注册表不值
    (hue, 24.0, 10.0)
}

/// HSL(h 0-360, s/l 0-100) → RGBA，和 CSS 的 hsl() 同一套算法。
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> tauri::window::Color {
    let s = (s / 100.0).clamp(0.0, 1.0);
    let l = (l / 100.0).clamp(0.0, 1.0);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp.floor() as i64 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    tauri::window::Color(to8(r), to8(g), to8(b), 255)
}

#[cfg(test)]
mod tests {
    use super::hsl_to_rgb;

    /// 这两个值直接对应 splash.html 的底色：暗色 = hsl(205 24% 10%)（抓图实测就是 #131B20）、
    /// 亮色 = CSS 里写死的 hsl(220 43% 97%)。改了配色表就容易把这两处改脱钩，钉住。
    #[test]
    fn splash_background_matches_the_stylesheet() {
        let dark = hsl_to_rgb(205.0, 24.0, 10.0);
        assert_eq!((dark.0, dark.1, dark.2, dark.3), (19, 27, 32, 255));
        let light = hsl_to_rgb(220.0, 43.0, 97.0);
        assert_eq!((light.0, light.1, light.2, light.3), (244, 246, 251, 255));
        // 换个色相也要跟着走（森林绿：hsl(128 24% 10%)）
        let forest = hsl_to_rgb(128.0, 24.0, 10.0);
        assert!(forest.1 > forest.0 && forest.1 > forest.2);
    }
}

fn ui_ready_impl(app: &AppHandle) {
    UI_READY_DONE.store(true, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(true);
        if !visible {
            #[cfg(windows)]
            {
                strip_native_frame(&w);   // 先修样式再显示，免得闪一下原生边框
                if w.is_maximized().unwrap_or(false) {
                    // 显示前先贴好：状态是 window-state 恢复出来的，那条路没走过 win_ctl
                    fit_work_area(&w);
                } else {
                    // 非最大化：位置可能是坏的（换显示器/缩放/存了 -8 这种坐标）→ 夹回工作区
                    clamp_to_work_area(&w);
                }
            }
            let _ = w.show();
            let _ = w.set_focus();
            // 显示这一下会让 Windows 按"恢复出来的最大化尺寸"再排一次版（那条路没走过 win_ctl），
            // 所以显示之后再补一次贴工作区，别让任务栏被压住哪怕一秒
            #[cfg(windows)]
            {
                if w.is_maximized().unwrap_or(false) {
                    fit_work_area(&w);   // 立刻补一次（多半能贴上）
                }
                let w2 = w.clone();
                std::thread::spawn(move || {
                    // 显示之后系统还会再排一次版：补几次，越快贴上越好（任务栏不能被压住）
                    for ms in [60u64, 200, 500, 1200] {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        strip_native_frame(&w2);
                        if w2.is_maximized().unwrap_or(false) {
                            fit_work_area(&w2);
                        }
                    }
                });
            }
        }
    }
    if let Some(s) = app.get_webview_window("splash") {
        let _ = s.close();
    }
}

/// 前端第一屏画好了（main() 末尾调）
#[tauri::command]
fn ui_ready(app: AppHandle) {
    ui_ready_impl(&app);
}

/// 前端刚跑起来时（main() 最开始）调一下。正常情况下启动画面**早就有了** —— 它在
/// tauri.conf.json 里声明、由 Tauri 在 setup 之前建好、setup 里显示出来，比这里早得多；
/// 这一下只是再确保它在最前面。
/// 真没有（配置那条路没建起来）才补建一个：那时前端已经跑起来、主 webview 早就绪，创建稳。
/// 但启动阶段一旦收尾就绝不再建/再放：那时放出来的窗口没人会关，会变成一个没边框、
/// 不在任务栏、还置顶的常驻小窗。
#[tauri::command]
async fn splash_show(app: AppHandle) -> Result<(), String> {
    if UI_READY_DONE.load(Ordering::Relaxed) {
        return Ok(()); // 启动阶段已经结束（ui_ready 跑过），别再放出来
    }
    if let Some(sp) = app.get_webview_window("splash") {
        let _ = sp.show();
        let _ = sp.set_always_on_top(true);
        return Ok(()); // 已经有了：只把它在最前面顶一下
    }
    // 图标做成 'static 的 owned Image：`default_window_icon()` 借的是 app，
    // 直接 cloned() 会因生命周期不够长编译不过（E0597）
    let icon: Option<tauri::image::Image<'static>> = app
        .default_window_icon()
        .map(|i| tauri::image::Image::new_owned(i.rgba().to_vec(), i.width(), i.height()))
        .or_else(fallback_icon);
    let built = tauri::WebviewWindowBuilder::new(
        &app,
        "splash",
        tauri::WebviewUrl::App("splash.html".into()),
    )
    .title("KDock")
    .inner_size(380.0, 260.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    // 先不显示：窗口"创建"这一下就会带着 WS_CAPTION 亮一帧（实测约 250ms 的边框），
    // 等下面把边框处理和图标都做完再 show()，用户就看不到那三条边
    .visible(false)
    .center()
    .build();
    let Ok(sp) = built else { return Ok(()) };
    #[cfg(windows)]
    {
        install_frame_proc(&sp);
        strip_native_frame(&sp);
        // 创建那一下是按"带标题栏的窗口"算的外框（380x260 的客户区 → 396x269 的窗口），
        // 边框清掉之后客户区会撑满那 396x269。这里显式再定一次尺寸，启动画面就是干净的
        // 380x260（不依赖任何"恢复"来的值）。
        let _ = sp.set_size(tauri::PhysicalSize::new(380, 260));
        let _ = sp.center();
    }
    if let Some(icon) = icon {
        let _ = sp.set_icon(icon.clone());
        #[cfg(windows)]
        set_big_icon(&sp, &icon);
    }
    let _ = sp.show();
    let _ = sp.set_always_on_top(true);
    Ok(())
}

/// 老版本的应用数据目录名（改名前叫 serialtool）。只用于一次性搬迁。
const LEGACY_APP_DIR: &str = "com.kyin.serialtool";
/// 现在的目录名（和 tauri.conf.json 的 identifier 一致）。
const CURRENT_APP_DIR: &str = "com.kyin.kdock";

/// 把旧目录整份复制到新目录（只在"新目录不存在、旧目录存在"时做一次）。
/// 复制而不是移动：万一新版有问题，旧版本仍然能正常打开。
fn migrate_legacy_data_dir() {
    let Ok(base) = std::env::var("APPDATA") else { return };
    let old = std::path::Path::new(&base).join(LEGACY_APP_DIR);
    let new = std::path::Path::new(&base).join(CURRENT_APP_DIR);
    if new.exists() || !old.exists() {
        return;
    }
    if copy_dir_all(&old, &new).is_ok() {
        // 留个标记，方便排查"我的配置怎么过来的"
        let _ = std::fs::write(new.join("migrated-from.txt"), format!("{LEGACY_APP_DIR}\n"));
    }
}

fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst)?;
        } else if ty.is_file() {
            let _ = std::fs::copy(entry.path(), &dst);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先确认起得来：缺 WebView2 时 Tauri 在 windows 子系统里是静默失败（双击没反应、没提示），
    // 这里在建任何窗口之前查一次注册表，缺了就弹框 —— 可以直接帮用户装好。
    if !webview2::ensure() {
        return;
    }
    // 目录名从 com.kyin.serialtool 换成了 com.kyin.kdock（应用改名）。老用户第一次跑新版时把
    // 旧的配置/会话/技能/密钥整份搬过去一次，别让人白配一遍。
    // 必须在建任何窗口/插件之前做：window-state 和 store 都是在 setup 阶段读这些文件的。
    migrate_legacy_data_dir();
    // 调试口子：设了 KDOCK_DEBUG_PORT，就让 WebView2 打开远程调试端口（**只在 debug 构建里生效**）。
    // 用途是用 CDP 脚本驱动界面做回归测试（npm run dev 起的 dev 模式同样适用）；release 包里这段不存在。
    #[cfg(debug_assertions)]
    if let Ok(port) = std::env::var("KDOCK_DEBUG_PORT") {
        if !port.trim().is_empty() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={}", port.trim()),
            );
        }
    }
    let mut builder = tauri::Builder::default();
    // 原生文件对话框 / 文件读写：WebView 里 window.prompt 是空实现，靠这两个插件兜住
    builder = builder
        // 单实例必须**第一个**装：第二个实例直接退出去叫醒已有窗口，
        // 不去碰 WebView2 的用户数据目录（两个实例抢同一个目录 = HRESULT(0x8007139F) 起不来）
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 窗口位置/大小记忆。
        // **不要**让它恢复/保存"可见性"：启动画面靠 visible=false 先把主窗口藏起来，
        // 插件一恢复 visible=true 就直接把主窗口顶上来了（实测：主窗口比启动画面还先出现）
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                // 启动画面**不进**这套记录：它尺寸是定死的（380x260），"恢复"它没有任何意义，
                // 反而会出事 —— 插件会在它显示出来之后把尺寸改成上一轮存下的值，而 tao 改尺寸时
                // 会顺手把 WS_CAPTION/WS_THICKFRAME 写回样式，于是右边/底边就闪出一条原生边框
                // （实测抓到：396x269 显示正常 → 428x377 并带 8px 非客户区）。
                .with_denylist(&["splash"])
                .build(),
        );
    #[cfg(windows)]
    {
        // 开机自启（Windows 下写注册表 Run 项）
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }
    builder = builder
        .on_window_event(|window, event| {
            // 「关闭到托盘」开着的时候，点 X 只隐藏窗口，不退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // SSH(plink) 的主机指纹缓存：放在应用数据目录里，跟别的配置一处（「设置 → 缓存」能一起看）
            if let Ok(d) = app.path().app_data_dir() {
                transport::set_hostkey_cache(d.join("ssh_hostkeys.txt"));
            }
            // 它内部要跑 PowerShell + WMI（好几秒），别挡着窗口显示 —— 丢后台线程慢慢补名字
            std::thread::spawn(refresh_friendly);
            agent::schedule::start(app.handle().clone());
            // 任务栏/标题栏图标：显式再设一次。
            // 实测这台机器上 WM_GETICON 的**大图标是 0**（只有小图标有值），
            // 任务栏按钮于是显示成空白/默认图标。
            // 优先用打包进去的图标；没有（开发运行时常见）就用源码里内嵌的那份。
            // 都做成 'static 的 owned Image —— 启动画面和托盘两步都要用同一个。
            let icon: Option<tauri::image::Image<'static>> = app
                .default_window_icon()
                .map(|i| tauri::image::Image::new_owned(i.rgba().to_vec(), i.width(), i.height()))
                .or_else(fallback_icon);
            // ── 先把启动画面顶上去 ──
            // 它是 tauri.conf.json 里的 windows[0]，Tauri 在 setup **之前**就建好了，那时主 webview
            // 还在加载 index.html（前面那 ~0.9 秒就是它）。这里只做三件事：修边框 → 设底色 → 显示。
            // 顺序有讲究：先修边框再 show()，用户就看不到那三面系统边；底色要在 show() **之前**设，
            // 否则先闪一帧白（WebView2 的默认底色是白的，页面还没画上去）。
            if let Some(sp) = app.get_webview_window("splash") {
                #[cfg(windows)]
                {
                    install_frame_proc(&sp);
                    strip_native_frame(&sp);
                    // 创建那一下是按"带标题栏的窗口"算的外框（380x260 的客户区 → 396x269 的窗口），
                    // 边框清掉之后客户区会撑满那 396x269。这里显式再定一次尺寸，启动画面就是干净的
                    // 380x260（不依赖任何"恢复"来的值）。
                    let _ = sp.set_size(tauri::PhysicalSize::new(380, 260));
                    let _ = sp.center();
                }
                let (hue, sat, lig) = splash_bg_hsl(app.handle());
                let _ = sp.set_background_color(Some(hsl_to_rgb(hue, sat, lig)));
                if let Some(icon) = icon.clone() {
                    let _ = sp.set_icon(icon.clone());
                    #[cfg(windows)]
                    set_big_icon(&sp, &icon);
                }
                let _ = sp.show();
                let _ = sp.set_always_on_top(true);
            }
            // 自绘标题栏：把原生窗体边框去掉（decorations=false 在 Windows 上还会剩一圈）
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                install_frame_proc(&w);      // 非客户区彻底清零（WM_NCCALCSIZE），从根上不留边框
                strip_native_frame(&w);
                // "隐藏 + 最大化"是 window-state 恢复出来的，而那次最大化发生在子类化之前，
                // 尺寸是按整块显示器算的（这台机器上是 2576x1408@-8,-8）。子类装好之后直接贴回
                // 工作区就行 —— **不要**再"取消最大化 + 重新最大化"：tao 的取消最大化走的是
                // ShowWindow(SW_RESTORE)，那会把还藏着的主窗口显示出来，开机就闪一个没画内容的
                // 空窗口（实测 8ms 轮询在 8 次启动里抓到 6 次，闪一下就在 -8,-8 那个尺寸位置）。
                if w.is_maximized().unwrap_or(false) {
                    fit_work_area(&w);
                }
                // 兜底：上面任何一步若让窗口露了头，这里按原状态藏回去（tao 的 hide() 在这种
                // "它以为已经隐藏"的情况下是空操作，所以走 Win32）
                if !w.is_visible().unwrap_or(false) {
                    hide_native(&w);
                }
                // 之后由守护线程盯着：最大化状态一变就重清样式 + 贴回工作区（普通线程，不引 tokio）
                spawn_frame_watcher(w.clone());
            }
            // 图标已经设给启动画面了；主窗口（长期存在的那个）这边再设一次
            if let Some(icon) = icon.clone() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_icon(icon.clone());   // 小图标（tao 只做这个）
                    #[cfg(windows)]
                    set_big_icon(&w, &icon);            // 大图标得自己设
                }
            }
            // 兜底：前端 6 秒内没喊"画好了"（比如脚本报错），也把主窗口放出来，
            // 别让人一直对着启动画面等
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    ui_ready_impl(&h);
                });
            }
            spawn_port_watcher(app.handle().clone());
            // 托盘：显示主窗口 / 退出（左键点图标也能把窗口叫回来）
            let show = tauri::menu::MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("KDock")
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击 = 打开主界面（原来只 show()，窗口最小化时等于没反应）
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            focus_main(tray.app_handle());
                        }
                    }
                });
            if let Some(icon) = icon.clone() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        });
    builder
        .manage(Arc::new(debug::DebugState::default()))
        .manage(Arc::new(AppState::default()))
        .manage(Arc::new(agent::AgentState::default()))
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_transport,
            close_transport,
            write_data,
            get_log,
            clear_log,
            get_stats,
            save_session,
            load_session,
            export_csv,
            replay_plan,
            poll_timeout_ms,
            fw_info_local,
            fw_info_server,
            server_fw_list,
            default_save_dir,
            open_folder,
            file_digest,
            file_read_text,
            file_read_bytes,
            file_write_text,
            env_setup::env_scan,
            logic::logic_devices,
            logic::dsview_decoders,
            logic::dsview_decode,
            net_interfaces,
            usb::cmsis_probe_detail,
            usb::usb_diag,
            usb::usb_diag_elevated,
            usbcapture::usbpcap_info,
            usbcapture::usbpcap_start,
            usbcapture::usbpcap_stop,
            netcapture::tshark_info,
            netcapture::tshark_start,
            netcapture::tshark_stop,
            logic::logic_capture,
            env_setup::env_install,
            storage::command_table_get,
            storage::command_table_save,
            storage::cache_items,
            storage::cache_delete,
            storage::app_restart,
            device_list,
            device_pull,
            device_upload,
            start_upgrade,
            upgrade_state,
            set_close_to_tray,
            show_main_window,
            ui_prefs_get,
            ui_prefs_set,
            workspace_git,
            ui_ready,
            splash_show,
            set_auto_reconnect,
            extra_open,
            extra_close,
            extra_list,
            extra_write,
            flash_run,
            flash_stop,
            flash_scripts,
            flash_cfg_text,
            flash_jlink_devices,
            local_run,
            file_size,
            win_ctl,
            win_frame_info,
            win_move,
            win_resize,
            flash_tools,
            pyocd_targets,
            capture_list,
            capture_start,
            capture_stop,
            write_temp_file,
            scope_open,
            scope_close,
            scope_cmd,
            scope_wave,
                scope_info,
                scope_measure,
                scope_waveform,
                scope_screenshot,
                scope_save_png,
                scope_control,
                // ── 知识库页的内置浏览器（WebView2 子视图）──
                kb_show,
                kb_bounds,
                kb_hide,
                kb_hide_all,
                kb_reload,
                kb_url,
                // ── 文件管理：FTP / FTPS / TFTP（客户端 + 内置 TFTP 服务端）──
                netfs::netfs_open,
                netfs::netfs_close,
                netfs::netfs_sessions,
                netfs::netfs_list,
                netfs::netfs_stat,
                netfs::netfs_get,
                netfs::netfs_put,
                netfs::netfs_mkdir,
                netfs::netfs_delete,
                netfs::netfs_rename,
                netfs::tftp_server_start,
                netfs::tftp_server_stop,
                netfs::tftp_server_state,
                // ── 安卓（ADB）：设备 / shell / 推拉 / APK / 投屏 / 反向控制 / scrcpy ──
                android::adb_status,
                android::adb_devices,
                android::adb_mdns,
                android::adb_connect,
                android::adb_pair,
                android::adb_disconnect,
                android::adb_shell,
                android::adb_push,
                android::adb_pull,
                android::adb_install,
                android::adb_uninstall,
                android::adb_packages,
                android::adb_screenshot,
                android::adb_mirror_start,
                android::adb_mirror_stop,
                android::adb_input,
                android::adb_scrcpy_run,
                android::adb_scrcpy_stop,
                android::adb_scrcpy_state,
                // ── 屏幕共享：VNC（含键鼠回传）+ RTSP / RTMP / H.264（FFmpeg 解码）──
                remote_screen::rs_open,
                remote_screen::rs_stop,
                remote_screen::rs_stop_all,
                remote_screen::rs_list,
                remote_screen::rs_pointer,
                remote_screen::rs_key,
                remote_screen::rs_snapshot,
                remote_screen::rs_ffmpeg,
            // ── Agent ──
            agent::agent_config_get,
            agent::agent_provider_save,
            agent::agent_provider_delete,
            agent::agent_provider_set_active,
            agent::agent_secret_set,
            agent::agent_models,
            agent::agent_ping_provider,
            agent::agent_probe_models,
            agent::agent_probe_chat,
            agent::agent_sessions,
            agent::agent_session_new,
            agent::agent_session_load,
            agent::agent_session_delete,
            agent::agent_session_rename,
            agent::agent_session_set_workspace,
                agent::agent_session_set_provider,
            agent::agent_session_set_perm,
            agent::agent_session_set_goal,
            agent::agent_approval_result,
            agent::agent_workspace_write_bytes,
            agent::agent_send,
            agent::agent_running,
            agent::agent_stop,
            agent::agent_compact,
            agent::agent_provider_balance,
            agent::amd_load,
            agent::agent_speed_get,
            agent::agent_amd_reseed,
            agent::agent_context_breakdown,
            agent::agent_host_result,
            agent::agent_skills,
            agent::agent_skill_read,
            agent::agent_skill_save,
            agent::agent_skill_delete,
            agent::agent_skill_set_enabled,
            agent::agent_skill_import,
            agent::agent_skills_dir,
            agent::agent_slash_list,
            agent::agent_slash_dir,
            agent::agent_slash_save,
            agent::agent_slash_delete,
            agent::schedule::agent_schedule_add,
            agent::schedule::agent_schedule_list,
            agent::schedule::agent_schedule_cancel,
            agent::pricing::agent_pricing_calendar,
            // ── 三层上下文：内置指令 / 技能（全局·工作区） / 指导文件 / 工具开关 / 骨架 ──
            agent::agent_tools_list,
            agent::agent_tool_set,
            agent::agent_guidance_get,
            agent::agent_guidance_set,
            agent::agent_skills_workspace,
            agent::agent_skill_convert,
            agent::agent_skill_archive,
            agent::agent_skill_archive_restore,
            agent::agent_skill_archive_delete,
            agent::agent_migrate_always_skills,
            agent::agent_tools,
            agent::agent_workspaces,
            agent::agent_workspace_new,
            agent::agent_workspace_delete,
            agent::agent_workspace_rename,
            agent::agent_workspace_write,
            agent::agent_workspace_read,
            agent::browser_fetch,
            agent::browser_back,
            agent::browser_current,
            agent::browser_open_external,
            agent::mcp_list,
            agent::mcp_save,
            agent::mcp_delete,
            agent::mcp_test,
            agent::mcp_tools,
            agent::mcp_path_hint,
            window_set_zoom,
            debug::debug_gdb_start,
            debug::debug_gdb_stop,
            debug::debug_gdb_cmd,
            debug::debug_server_start,
            debug::debug_server_stop,
            debug::debug_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                agent::mcp::shutdown_all();
            }
        });
}
