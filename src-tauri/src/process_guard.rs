//! 外部子进程的统一登记与回收。
//!
//! KDock 会启动 adb / tshark / sigrok-cli / ffmpeg / ssh / MCP 等长期进程。
//! 其中 adb 这类客户端会再拉起 server；如果只杀直接子进程，server 会继续存活，
//! 甚至锁住 portable 目录里的 exe/dll。Windows 上用 Job Object 把整棵进程树收进
//! 同一个 kill-on-close job，退出（包括异常退出）时由系统统一回收。
//!
//! 关键点：必须先让 **KDock 自己**成为这个 Job 的成员，再启动任何子进程。
//! 否则 `adb start-server` 可能在父进程 `AssignProcessToJobObject` 之前就 fork 出
//! `adb server`，server 不在 Job 里，退出后仍会残留（实测可复现）。Job 成员的子进程
//! 会自动继承 Job 成员关系，所以先加入自己才没有竞态窗口。

use std::io;
use std::process::{Child, Command};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::GetCurrentProcess;

static TRACKED_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

#[cfg(windows)]
static JOB_HANDLE: Mutex<Option<usize>> = Mutex::new(None);

/// 在创建任何外部进程前调用。把 KDock 自身挂到 kill-on-close Job 上。
/// 子进程会继承这个 Job，因此 adb 自己 fork 出来的 server 也不会逃逸。
/// 重复调用是安全的；失败时返回提示，但程序仍可继续运行。
pub fn init() -> Option<String> {
    #[cfg(windows)]
    {
        let mut guard = match JOB_HANDLE.lock() {
            Ok(g) => g,
            Err(_) => return Some("进程回收器锁不可用".into()),
        };
        if guard.is_some() {
            return None;
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Some(format!(
                    "CreateJobObject 失败（错误 {}）",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Some(format!("SetInformationJobObject 失败（{err}）"));
            }
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Some(format!("AssignProcessToJobObject(self) 失败（{err}）"));
            }
            *guard = Some(job as usize);
            None
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 启动子进程。Windows 下 KDock 自己已经在 Job 中，子进程会自动继承成员关系；
/// 这里仍登记 PID，作为非 Windows / Job 初始化失败时的兜底。
pub fn spawn(cmd: &mut Command) -> io::Result<Child> {
    let child = cmd.spawn()?;
    if let Ok(mut pids) = TRACKED_PIDS.lock() {
        pids.push(child.id());
    }
    Ok(child)
}

/// 应用退出时集中回收。Windows 优先终止 job；再对登记过的 PID 做一次兜底。
/// 这里只处理本进程启动过的 PID，不会按名字误杀用户自己开的同名程序。
pub fn cleanup_all() {
    #[cfg(windows)]
    unsafe {
        if let Ok(mut guard) = JOB_HANDLE.lock() {
            if let Some(raw) = guard.take() {
                let job = raw as HANDLE;
                let _ = TerminateJobObject(job, 1);
                CloseHandle(job);
            }
        }
    }

    let pids = TRACKED_PIDS
        .lock()
        .map(|mut p| std::mem::take(&mut *p))
        .unwrap_or_default();
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        for pid in pids {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    #[cfg(not(windows))]
    {
        for pid in pids {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}
