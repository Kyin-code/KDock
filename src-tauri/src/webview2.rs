//! 启动前的 WebView2 检查。
//!
//! 为什么要它：Windows 上界面是 WebView2 渲染的，而 release 是 `windows_subsystem = "windows"` ——
//! 缺运行时时 `run()` 末尾的 `.expect(...)` panic 既没有控制台也没有对话框，用户看到的就是
//! "双击了但什么都没发生"。所以这里在**建任何窗口之前**先查一次注册表：缺了就弹个框，
//! 能自动帮它装（官方 Evergreen Bootstrapper，约 2 MB，不需要管理员），也能打开下载页。
//!
//! 检测口径和静态链接进 exe 的那个 WebView2 loader 一致（下面的 GUID 就是从 exe 里抠出来的）：
//! `HKCU / HKLM\Software\Microsoft\EdgeUpdate\Clients\{GUID}` 的 `pv` 值，32 位与 64 位注册表视图都查。
//! 除了 WebView2 Runtime 本身，Edge 的 stable / beta / dev / canary 也算数 —— loader 会回退用它们。
//!
//! 三个开关（环境变量，排查/企业内网用）：
//! - `KDOCK_SKIP_WEBVIEW2_CHECK=1`   跳过检查
//! - `KDOCK_FAKE_NO_WEBVIEW2=1`      假装没装（演练弹窗与安装流程）
//! - `KDOCK_WEBVIEW2_BOOTSTRAPPER_URL=<url>`  换成内网镜像的 Bootstrapper（http(s)，也支持 file:// 或本地/UNC 路径）

#[cfg(not(windows))]
pub fn ensure() -> bool {
    true
}

#[cfg(windows)]
pub fn ensure() -> bool {
    if env_flag("KDOCK_SKIP_WEBVIEW2_CHECK") {
        return true;
    }
    let forced = env_flag("KDOCK_FAKE_NO_WEBVIEW2");
    if !forced && runtime_installed() {
        return true;
    }
    prompt(forced)
}

#[cfg(windows)]
fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| !v.trim().is_empty() && v.trim() != "0").unwrap_or(false)
}

/// WebView2 loader 会去找的这些东西（从 exe 里抠出来的 GUID）：
/// Runtime 本身 + Edge 四个通道 + loader 额外查的那个。
#[cfg(windows)]
const CLIENT_GUIDS: [&str; 6] = [
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", // WebView2 Runtime（Evergreen）
    "{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}", // Microsoft Edge stable
    "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}", // Microsoft Edge Beta
    "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}", // Microsoft Edge Dev
    "{65C35B14-6C1D-4122-AC46-7148CC9D6497}", // Microsoft Edge Canary
    "{BE59E8FD-089A-411B-A3B0-051D9E417818}", // loader 也在查的一个（fixed-version 那套）
];

#[cfg(windows)]
const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
#[cfg(windows)]
const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// 装了没有？（任一 GUID 的 pv 有值就算装了；Edge 通道也算）
#[cfg(windows)]
fn runtime_installed() -> bool {
    for guid in CLIENT_GUIDS {
        let sub = format!("Software\\Microsoft\\EdgeUpdate\\Clients\\{guid}");
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for wow in [0u32, RRF_SUBKEY_WOW6432KEY] {
                if let Some(pv) = reg_sz(hive, &sub, "pv", wow) {
                    let v = pv.trim();
                    if !v.is_empty() && v != "0.0.0.0" {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(windows)]
const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as isize;
#[cfg(windows)]
const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as isize;
#[cfg(windows)]
const RRF_RT_REG_SZ: u32 = 0x0000_0002;
#[cfg(windows)]
const RRF_SUBKEY_WOW6432KEY: u32 = 0x0002_0000;

#[cfg(windows)]
fn reg_sz(hive: isize, subkey: &str, value: &str, extra: u32) -> Option<String> {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            hkey: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            ty: *mut u32,
            data: *mut std::ffi::c_void,
            cb: *mut u32,
        ) -> i32;
    }
    let k = wide(subkey);
    let v = wide(value);
    let mut buf = [0u16; 256];
    let mut cb = (buf.len() * 2) as u32;
    let mut ty = 0u32;
    let rc = unsafe {
        RegGetValueW(
            hive,
            k.as_ptr(),
            v.as_ptr(),
            extra | RRF_RT_REG_SZ,
            &mut ty,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut cb,
        )
    };
    if rc != 0 {
        return None;
    }
    let n = ((cb as usize) / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// 弹框：能自动装就装，装不了给下载页，用户想退出就退出。
#[cfg(windows)]
fn prompt(forced: bool) -> bool {
    const MB_OK: u32 = 0x0000_0000;
    const MB_YESNOCANCEL: u32 = 0x0000_0003;
    const MB_ICONWARNING: u32 = 0x0000_0030;
    const MB_ICONINFORMATION: u32 = 0x0000_0040;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;
    const IDYES: i32 = 6;
    const IDNO: i32 = 7;

    let debug_note = if forced { "\n（调试开关 KDOCK_FAKE_NO_WEBVIEW2 生效）\n" } else { "" };
    let ask = match saved_lang() {
        Some(true) => format!(
            "KDock 需要「Microsoft Edge WebView2 Runtime」来显示界面，这台机器上没检测到。{debug_note}\n\
             点「是」：现在自动下载并安装（约 2 MB，安装时有进度条，不需要管理员，装完自动继续）\n\
             点「否」：打开官方下载页，我自己装\n\
             点「取消」：退出"
        ),
        Some(false) => format!(
            "KDock needs the Microsoft Edge WebView2 Runtime to render its UI, and it wasn't found on \
             this machine.{debug_note}\n\n\
             Yes = download & install it now (~2 MB, shows a progress bar, no admin needed)\n\
             No = open the official download page\n\
             Cancel = quit"
        ),
        None => format!(
            "KDock 需要「Microsoft Edge WebView2 Runtime」来显示界面，这台机器上没检测到。{debug_note}\n\
             点「是」= 现在自动下载并安装（约 2 MB，不需要管理员，装完自动继续）；\
             点「否」= 打开官方下载页；点「取消」= 退出。\n\n\
             KDock needs the Microsoft Edge WebView2 Runtime, which is missing here.\n\
             Yes = download & install it now (~2 MB, no admin needed); \
             No = open the download page; Cancel = quit."
        ),
    };
    let r = msgbox(&ask, MB_YESNOCANCEL | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST);

    if r == IDYES {
        if install_runtime() {
            return true;
        }
        let fail = match saved_lang() {
            Some(false) => "Automatic install didn't work (offline, or blocked by policy?).\n\
                            I'll open the official download page — install it and start KDock again."
                .to_string(),
            _ => "自动安装没成功（可能没网，或被策略拦了）。\n\
                  我帮你打开官方下载页，装好之后重新打开 KDock 就行。".to_string(),
        };
        msgbox(&fail, MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST);
        open_url(DOWNLOAD_PAGE);
        return false;
    }
    if r == IDNO {
        open_url(DOWNLOAD_PAGE);
        let note = match saved_lang() {
            Some(false) => "The download page is open — install WebView2, then start KDock again.",
            _ => "已打开下载页：装好 WebView2 之后，重新打开 KDock 即可。",
        };
        msgbox(note, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
        return false;
    }
    false // 取消 / 直接关掉对话框
}

/// 读一下用户上次选的语言（ui-prefs.json），没有就返回 None（弹双语）
#[cfg(windows)]
fn saved_lang() -> Option<bool> {
    let base = std::env::var("APPDATA").ok()?;
    let path = std::path::Path::new(&base).join("com.kyin.kdock").join("ui-prefs.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("lang").and_then(|x| x.as_str()).map(|s| s == "zh")
}

/// 下载官方 Bootstrapper 并跑一遍（/passive：有进度条、不用点）。
/// 装完再查一次注册表确认；确认真装了才返回 true。
#[cfg(windows)]
fn install_runtime() -> bool {
    let url = std::env::var("KDOCK_WEBVIEW2_BOOTSTRAPPER_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| BOOTSTRAPPER_URL.to_string());
    let exe = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    if !fetch_bootstrapper(&url, &exe) {
        return false;
    }
    for args in [["/passive", "/install"], ["/silent", "/install"]] {
        if let Ok(mut child) = std::process::Command::new(&exe).args(args).spawn() {
            let _ = child.wait();
        }
        if runtime_installed() {
            let _ = std::fs::remove_file(&exe);
            return true;
        }
    }
    let _ = std::fs::remove_file(&exe);
    false
}

/// 拿 Bootstrapper：http(s) 就下载；`file://` 前缀、UNC（\\server\share\…）或本地路径就直接拷贝 ——
/// 内网镜像/离线分发常这么给（`KDOCK_WEBVIEW2_BOOTSTRAPPER_URL` 可以指到共享盘上的安装包）。
#[cfg(windows)]
fn fetch_bootstrapper(url: &str, path: &std::path::Path) -> bool {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        let src = url.strip_prefix("file://").unwrap_or(url);
        let src = src.trim_start_matches('/');      // file:///I:/x → I:/x
        return std::fs::copy(src, path).is_ok();
    }
    let Ok(resp) = ureq::get(url).timeout(std::time::Duration::from_secs(180)).call() else {
        return false;
    };
    let Ok(mut file) = std::fs::File::create(path) else { return false };
    std::io::copy(&mut resp.into_reader(), &mut file).is_ok()
}

#[cfg(windows)]
fn msgbox(text: &str, flags: u32) -> i32 {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let t = wide(text);
    let c = wide("KDock");
    unsafe { MessageBoxW(0, t.as_ptr(), c.as_ptr(), flags) }
}

#[cfg(windows)]
fn open_url(url: &str) -> bool {
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }
    let op = wide("open");
    let f = wide(url);
    unsafe { ShellExecuteW(0, op.as_ptr(), f.as_ptr(), std::ptr::null(), std::ptr::null(), 1) > 32 }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
