#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 提权子进程：只做一次 USB 快照然后退出（不初始化 Tauri / WebView）
    if std::env::args().nth(1).as_deref() == Some("--usb-dump") {
        let path = std::env::args().nth(2).unwrap_or_default();
        let _ = kdock_lib::usb::usb_dump_to(&path);
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|arg| arg == "--automation-run") {
        if let Some(id) = args.get(pos + 1) {
            std::env::set_var("KDOCK_AUTOMATION_RUN", id);
        }
    }
    kdock_lib::run()
}

