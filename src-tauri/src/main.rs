#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 提权子进程：只做一次 USB 快照然后退出（不初始化 Tauri / WebView）
    if std::env::args().nth(1).as_deref() == Some("--usbpcap-run") {
        let device = std::env::args().nth(2).unwrap_or_default();
        let pcap = std::env::args().nth(3).unwrap_or_default();
        let stopfile = std::env::args().nth(4).unwrap_or_default();
        kdock_lib::usbcapture_run_helper(&device, &pcap, &stopfile);
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--usb-dump") {
        let path = std::env::args().nth(2).unwrap_or_default();
        let _ = kdock_lib::usb::usb_dump_to(&path);
        return;
    }
    kdock_lib::run()
}

