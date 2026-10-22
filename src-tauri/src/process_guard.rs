//! 外部子进程的统一登记与回收。
//!
//! KDock 会启动 adb / tshark / sigrok-cli / ffmpeg / ssh / MCP 等长期进程。
//! 其中 adb 这类客户端会再拉起 server；如果只杀直接子进程，server 会继续存活，
//! 甚至锁住 portable 目录里的 exe/dll。Windows 上用 Job Object 把整棵进程树收进
//! 同一个 kill-on-close job，退出（包括异常退出）时由系统统一回收。

use std::io;
use std::process::{Child, Command};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

static TRACKED_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

#[cfg(windows)]
static JOB_HANDLE: Mutex<Option<usize>> = Mutex::new(None);

/// 启动子进程并登记到统一回收器。所有可能长期存活的进程都应走这里。
pub fn spawn(cmd: &mut Command) -> io::Result<Child> {
    let child = cmd.spawn()?;
    if let Ok(mut pids) = TRACKED_PIDS.lock() {
        pids.push(child.id());
    }
    #[cfg(windows)]
    assign_to_job(&child);
    Ok(child)
}

#[cfg(windows)]
fn job_handle() -> Option<HANDLE> {
    let mut guard = JOB_HANDLE.lock().ok()?;
    if let Some(raw) = *guard {
        return Some(raw as HANDLE);
    }

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
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
            CloseHandle(job);
            return None;
        }
        *guard = Some(job as usize);
        Some(job)
    }
}

#[cfg(windows)]
fn assign_to_job(child: &Child) {
    let Some(job) = job_handle() else {
        return;
    };
    unsafe {
        let _ = AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
    }
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
        use std::os::windows::process::CommandExt;
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
