//! 跑本机命令 + 把它的输出**正确解成文本**。
//!
//! 为什么单独一个模块：这两件事以前在 `lib.rs`（工具页/编排的 local_run）和
//! `agent/tools.rs`（agent 的 local_run）各写了一份，结果踩了同一批坑：
//!
//!   1. **引号**：`Command::args(["/C", cmd])` 会被 Rust 再包一层引号，
//!      cmd 看到的是 `cmd /C "powershell ... -Command "Get-CimInstance ...""` ——
//!      内层引号被打乱，`$_`、`$env:x` 被外层吃掉、结尾的 `D:\` 被当成转义引号。
//!      所以这里用 `raw_arg` 把命令**原样**交给 cmd（cmd 自己解析）。
//!   2. **编码**：cmd/PowerShell 在中文系统上按 OEM 代码页（GBK/936）输出，
//!      直接 `from_utf8_lossy` 会得到一屏乱码（`10.opengl-2D������ת�ƶ�.gif`）。
//!      这里先按 UTF-8 严格解，再显式识别 GBK/CP936，最后用本机 OEM/ANSI
//!      代码页兜底，因此英文和 CI Windows 也能正确解中文输出。

use std::io::Read;
use std::time::{Duration, Instant};

/// 把一段字节解成文本：UTF-8 优先；非 UTF-8 先识别明确的 GBK 中文，
/// 否则按当前机器的 OEM/ANSI 代码页解。
pub fn decode(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[cfg(windows)]
    {
        let oem = decode_code_page(bytes, 1 /* CP_OEMCP */);
        let ansi = decode_code_page(bytes, 0 /* CP_ACP */);
        let gbk = decode_code_page(bytes, 936 /* GBK / CP936 */);
        // CI 和英文 Windows 的 OEM 代码页是 437，会把 GBK 字节解成
        // `╓╨╬─`。本机代码页解不出任何非 ASCII 字母、而 CP936 能解出
        // CJK 时才采用 CP936，避免把 CP437 重音字符、日文或韩文误判成中文。
        if let Some(gbk_text) = gbk.as_ref() {
            if should_prefer_gbk(gbk_text, oem.as_deref()) {
                return gbk_text.clone();
            }
        }
        if let Some(s) = oem {
            return s;
        }
        if let Some(s) = ansi {
            return s;
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(windows)]
fn cjk_count(text: &str) -> usize {
    text.chars()
        .filter(|c| matches!(*c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF))
        .count()
}

#[cfg(windows)]
fn should_prefer_gbk(gbk: &str, oem: Option<&str>) -> bool {
    let gbk_cjk = cjk_count(gbk);
    let local_letters = oem.map(non_ascii_alpha_count).unwrap_or(0);
    gbk_cjk >= 1 && local_letters == 0 && !gbk.contains('\u{FFFD}')
}

#[cfg(windows)]
fn non_ascii_alpha_count(text: &str) -> usize {
    text.chars()
        .filter(|c| !c.is_ascii() && c.is_alphabetic())
        .count()
}

#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    use std::os::raw::{c_char, c_int};
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            mb: *const c_char,
            cb: c_int,
            wc: *mut u16,
            cch: c_int,
        ) -> c_int;
    }
    if bytes.is_empty() {
        return Some(String::new());
    }
    let len = unsafe {
        MultiByteToWideChar(code_page, 0, bytes.as_ptr() as *const c_char, bytes.len() as c_int, std::ptr::null_mut(), 0)
    };
    if len <= 0 {
        return None;
    }
    let mut buf: Vec<u16> = vec![0; len as usize];
    let n = unsafe {
        MultiByteToWideChar(code_page, 0, bytes.as_ptr() as *const c_char, bytes.len() as c_int, buf.as_mut_ptr(), len)
    };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(String::from_utf16_lossy(&buf))
}

/// 起一个跑本机命令的子进程（不弹窗、stdin 关掉、stdout/stderr 都接管道）。
/// 在指定工作目录起一个命令（跨平台参数与编码规则统一在这里）。
pub fn spawn_in(cmd: &str, cwd: Option<&std::path::Path>) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        // raw_arg：命令原样交给 cmd，别再套一层引号（见文件头注释）
        c.raw_arg("/C ").raw_arg(cmd);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::process_guard::spawn(&mut c)
}

/// 跑命令前先把几个目录塞到 PATH 最前面。
///
/// 为什么：agent 用 local_run 时看的是**系统 PATH**，而 KDock 自己装的东西（adb / scrcpy /
/// ffmpeg / plink）都在 `%ENVDIR%` 下 —— 它看不见，只能全盘 `Get-ChildItem -Recurse` 去找，
/// 实测白烧好几分钟、还找不到我们的那份。这里等价于"KDock 装的东西默认就能直接调"。
pub fn run_with_path(
    cmd: &str,
    timeout_ms: u64,
    should_stop: &dyn Fn() -> bool,
    extra_path: &str,
) -> Result<(i32, String, String), String> {
    let prefix = extra_path.trim();
    if prefix.is_empty() {
        return run(cmd, timeout_ms, should_stop);
    }
    #[cfg(windows)]
    let patched = format!("set \"PATH={prefix};%PATH%\" && {cmd}");
    #[cfg(not(windows))]
    let patched = format!("PATH=\"{prefix}:$PATH\" {cmd}");
    run(&patched, timeout_ms, should_stop)
}

/// 同 `run_with_path`，但带工作目录（给 workspace_run / workspace_test 用）。
pub fn run_with_path_in(
    cmd: &str,
    timeout_ms: u64,
    should_stop: &dyn Fn() -> bool,
    extra_path: &str,
    cwd: &std::path::Path,
) -> Result<(i32, String, String), String> {
    let prefix = extra_path.trim();
    #[cfg(windows)]
    let patched = if prefix.is_empty() {
        cmd.to_string()
    } else {
        format!("set \"PATH={prefix};%PATH%\" && {cmd}")
    };
    #[cfg(not(windows))]
    let patched = if prefix.is_empty() {
        cmd.to_string()
    } else {
        format!("PATH=\"{prefix}:$PATH\" {cmd}")
    };
    run_in(&patched, timeout_ms, should_stop, Some(cwd))
}

/// 跑完（或超时/被叫停）返回 (退出码, stdout, stderr)。文本已按本机代码页解好。
pub fn run(cmd: &str, timeout_ms: u64, should_stop: &dyn Fn() -> bool) -> Result<(i32, String, String), String> {
    run_in(cmd, timeout_ms, should_stop, None)
}

pub fn run_in(
    cmd: &str,
    timeout_ms: u64,
    should_stop: &dyn Fn() -> bool,
    cwd: Option<&std::path::Path>,
) -> Result<(i32, String, String), String> {
    let mut child = spawn_in(cmd, cwd).map_err(|e| format!("起进程失败: {e}"))?;
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.max(200));
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None => {
                if should_stop() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("用户停止了这条本机命令（进程已杀掉）".into());
                }
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("命令超过 {}ms 没结束，已杀掉", timeout.as_millis()));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    };
    let mut out = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut out);
    }
    let mut err = Vec::new();
    if let Some(mut se) = child.stderr.take() {
        let _ = se.read_to_end(&mut err);
    }
    Ok((status.code().unwrap_or(-1), decode(&out), decode(&err)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_passes_through_and_gbk_is_decoded() {
        assert_eq!(decode("中文 abc".as_bytes()), "中文 abc");
        #[cfg(windows)]
        {
            // GBK 的"中文" = D6 D0 CE C4。结果不能取决于机器的 OEM 代码页；
            // 英文 CI Runner 的 CP437 会把它解成 `╓╨╬─`。
            let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
            assert_eq!(decode(&gbk), "中文");
            let cp437 = decode_code_page(&gbk, 437).unwrap();
            let cp936 = decode_code_page(&gbk, 936).unwrap();
            assert_eq!(cp437, "╓╨╬─");
            assert_eq!(cp936, "中文");
            assert!(should_prefer_gbk(&cp936, Some(&cp437)));
            assert!(should_prefer_gbk("一", Some("╓")));
            assert!(!should_prefer_gbk("中文", Some("你好")));
            assert!(!should_prefer_gbk("中文", Some("café")));
        }
    }

    #[cfg(windows)]
    #[test]
    fn command_keeps_dollar_signs_and_backslashes() {
        // 这条以前会被外层引号搞坏：$_.Name 变成 .Name、D:\ 被当成转义引号
        let (code, out, _) = run(
            "powershell -NoProfile -Command \"$v = 41; Write-Output ('KDOCK_' + ($v + 1))\"",
            // Allow for a cold Windows PowerShell start on CI.
            60_000,
            &|| false,
        )
        .expect("跑得起来");
        assert_eq!(code, 0, "退出码应为 0，输出：{out}");
        assert!(out.contains("KDOCK_42"), "$_ / $var 不该被外层吃掉，实际输出：{out}");
        // 结尾反斜杠：以前会被当成转义引号
        let (_, out2, _) = run("cmd /C dir /b C:\\", 60_000, &|| false).expect("跑得起来");
        assert!(!out2.contains("syntax is incorrect"), "dir C:\\ 不该报语法错：{out2}");
    }
}
