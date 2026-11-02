//! Agent 本机命令执行边界。
//!
//! `workspace` 模式不是命令前缀过滤：Windows 下用 AppContainer 启动
//! `cmd.exe`，默认不授予网络能力，只把工作区和工具目录的 ACL 显式授予
//! AppContainer SID；再用独立 Job Object 限制进程树、内存和生命周期。
//! `trusted` 模式明确回退到宿主权限，供必须访问整台机器的硬件工具使用。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
    Workspace,
    Trusted,
}

impl Default for SandboxMode {
    fn default() -> Self {
        Self::Workspace
    }
}

impl SandboxMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "trusted" | "host" => Self::Trusted,
            _ => Self::Workspace,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Trusted => "trusted",
        }
    }
}

pub fn run(
    mode: SandboxMode,
    cmd: &str,
    timeout_ms: u64,
    should_stop: &dyn Fn() -> bool,
    extra_path: &str,
    cwd: Option<&std::path::Path>,
    network: bool,
) -> Result<(i32, String, String), String> {
    match mode {
        SandboxMode::Trusted => match cwd {
            Some(dir) => crate::shell::run_with_path_in(cmd, timeout_ms, should_stop, extra_path, dir),
            None => crate::shell::run_with_path(cmd, timeout_ms, should_stop, extra_path),
        },
        SandboxMode::Workspace => {
            let workspace = cwd.ok_or("工作区沙箱命令必须指定工作目录")?;
            #[cfg(windows)]
            {
                self::windows::run_appcontainer(
                    cmd,
                    workspace,
                    timeout_ms,
                    should_stop,
                    extra_path,
                    network,
                )
            }
            #[cfg(not(windows))]
            {
                let _ = network;
                crate::shell::run_with_path_in(cmd, timeout_ms, should_stop, extra_path, workspace)
            }
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::collections::HashSet;
    use std::ffi::{c_void, OsStr};
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, SetHandleInformation, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
        SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, WinCapabilityInternetClientSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        STARTUPINFOW, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    };

    const E_ACCESSDENIED: i32 = 0x80070005u32 as i32;
    const ERROR_ALREADY_EXISTS: i32 = 183;
    const APP_CONTAINER_NAME: &str = "KDock.AgentSandbox.v1";
    const MAX_PROCESSES: u32 = 64;
    const MAX_PROCESS_MEMORY: usize = 4 * 1024 * 1024 * 1024;

    static ACL_CACHE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    static PROFILE_GATE: Mutex<()> = Mutex::new(());

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn sid_string(sid: PSID) -> Result<String, String> {
        let mut raw = std::ptr::null_mut();
        unsafe {
            if ConvertSidToStringSidW(sid, &mut raw) == 0 {
                return Err(format!(
                    "ConvertSidToStringSidW 失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
            let mut len = 0usize;
            while *raw.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
            LocalFree(raw as *mut c_void);
            Ok(text)
        }
    }

    fn appcontainer_sid() -> Result<PSID, String> {
        let _guard = PROFILE_GATE.lock().map_err(|_| "AppContainer 锁不可用")?;
        let name = wide(OsStr::new(APP_CONTAINER_NAME));
        let mut sid: PSID = std::ptr::null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        if hr >= 0 {
            return Ok(sid);
        }
        let code = (hr as u32) & 0xffff;
        if code != ERROR_ALREADY_EXISTS as u32 && hr != E_ACCESSDENIED {
            // Some Windows builds return HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
            // as a signed value; fall through to deriving the stable SID.
        }
        let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if hr < 0 || sid.is_null() {
            return Err(format!(
                "创建 AppContainer 失败（HRESULT 0x{:08X}）",
                hr as u32
            ));
        }
        Ok(sid)
    }

    fn grant_acl(path: &Path, sid: &str, rights: &str) -> Result<(), String> {
        let cache = ACL_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
        let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let cache_key = PathBuf::from(format!("{}|{}", key.display(), rights));
        if cache.lock().map(|g| g.contains(&cache_key)).unwrap_or(false) {
            return Ok(());
        }
        let grant = format!("*{sid}:{rights}");
        let mut cmd = Command::new("icacls");
        cmd.arg(path)
            .arg("/grant")
            .arg(grant)
            .arg("/T")
            .arg("/C")
            .arg("/Q")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = crate::process_guard::spawn(&mut cmd)
            .map_err(|e| format!("授予工作区隔离访问权限失败: {e}"))?
            .wait()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "授予 AppContainer 工作区权限失败（icacls 退出码 {}）",
                status.code().unwrap_or(-1)
            ));
        }
        if let Ok(mut guard) = cache.lock() {
            guard.insert(cache_key);
        }
        Ok(())
    }

    fn make_pipe(inheritable: SECURITY_ATTRIBUTES) -> Result<(OwnedHandle, OwnedHandle), String> {
        let mut read: HANDLE = std::ptr::null_mut();
        let mut write: HANDLE = std::ptr::null_mut();
        unsafe {
            if CreatePipe(&mut read, &mut write, &inheritable, 0) == 0 {
                return Err(format!("CreatePipe 失败（{}）", std::io::Error::last_os_error()));
            }
            SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
        }
        Ok((OwnedHandle(read), OwnedHandle(write)))
    }

    fn open_nul(inheritable: &SECURITY_ATTRIBUTES) -> Result<OwnedHandle, String> {
        let name = wide(OsStr::new("NUL"));
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                inheritable,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(format!("打开 NUL 失败（{}）", std::io::Error::last_os_error()));
        }
        Ok(OwnedHandle(handle))
    }

    fn build_job() -> Result<OwnedHandle, String> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "CreateJobObject 失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
            let job = OwnedHandle(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.BasicLimitInformation.ActiveProcessLimit = MAX_PROCESSES;
            info.ProcessMemoryLimit = MAX_PROCESS_MEMORY;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!(
                    "配置命令 Job 失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }

    pub(super) fn run_appcontainer(
        cmd: &str,
        workspace: &Path,
        timeout_ms: u64,
        should_stop: &dyn Fn() -> bool,
        extra_path: &str,
        network: bool,
    ) -> Result<(i32, String, String), String> {
        let sid = appcontainer_sid()?;
        let sid_text = sid_string(sid)?;
        grant_acl(workspace, &sid_text, "(OI)(CI)M")?;
        let temp = workspace.join(".kdock-tmp");
        let _ = std::fs::create_dir_all(&temp);
        grant_acl(&temp, &sid_text, "(OI)(CI)M")?;
        if !extra_path.trim().is_empty() {
            for path in std::env::split_paths(extra_path) {
                if path.is_dir() {
                    let _ = grant_acl(&path, &sid_text, "(OI)(CI)RX");
                }
            }
        }

        let mut capability_buf = [0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut capability_size = SECURITY_MAX_SID_SIZE;
        let capability_ok = unsafe {
            CreateWellKnownSid(
                WinCapabilityInternetClientSid,
                std::ptr::null_mut(),
                capability_buf.as_mut_ptr() as PSID,
                &mut capability_size,
            )
        };
        let mut capabilities = [SID_AND_ATTRIBUTES::default()];
        let caps_ptr = if network && capability_ok != 0 {
            capabilities[0].Sid = capability_buf.as_mut_ptr() as PSID;
            capabilities[0].Attributes = 0x0000_0004; // SE_GROUP_ENABLED
            capabilities.as_mut_ptr()
        } else {
            std::ptr::null_mut()
        };
        let security = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: caps_ptr,
            CapabilityCount: if network && capability_ok != 0 { 1 } else { 0 },
            Reserved: 0,
        };

        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let (out_read, out_write) = make_pipe(attrs)?;
        let (err_read, err_write) = make_pipe(attrs)?;
        let nul = open_nul(&attrs)?;

        let mut attr_size = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
        }
        let mut attr_buf = vec![0u8; attr_size];
        let attr_list = attr_buf.as_mut_ptr() as *mut c_void;
        unsafe {
            if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) == 0 {
                return Err(format!(
                    "初始化进程隔离属性失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
        }
        let attr_guard = AttrGuard(attr_list);
        unsafe {
            if UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &security as *const _ as *const c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) == 0
            {
                return Err(format!(
                    "写入 AppContainer 能力失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
        }

        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let exe = root.join("System32").join("cmd.exe");
        let exe_w = wide(exe.as_os_str());
        let prefix = if extra_path.trim().is_empty() {
            String::new()
        } else {
            format!("set \"PATH={};%PATH%\" && ", extra_path.trim())
        };
        let full = format!(
            "set \"TEMP=%CD%\\.kdock-tmp\" && set \"TMP=%CD%\\.kdock-tmp\" && set \"HOME=%CD%\" && set \"USERPROFILE=%CD%\" && {prefix}{cmd}"
        );
        let mut command_line = wide(OsStr::new(&format!("\"{}\" /D /S /C \"{}\"", exe.display(), full)));
        let cwd_w = wide(workspace.as_os_str());
        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = nul.0;
        si.StartupInfo.hStdOutput = out_write.0;
        si.StartupInfo.hStdError = err_write.0;
        si.lpAttributeList = attr_list;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                exe_w.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null(),
                cwd_w.as_ptr(),
                &si as *const _ as *const STARTUPINFOW,
                &mut pi,
            )
        };
        drop(attr_guard);
        if created == 0 {
            return Err(format!(
                "AppContainer 进程启动失败（{}）",
                std::io::Error::last_os_error()
            ));
        }
        let process = OwnedHandle(pi.hProcess);
        let thread = OwnedHandle(pi.hThread);
        drop(out_write);
        drop(err_write);
        drop(nul);

        let job = build_job()?;
        unsafe {
            if AssignProcessToJobObject(job.0, process.0) == 0 {
                let _ = TerminateJobObject(job.0, 1);
                return Err(format!(
                    "把沙箱进程加入 Job 失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
            if ResumeThread(thread.0) == u32::MAX {
                let _ = TerminateJobObject(job.0, 1);
                return Err(format!(
                    "恢复沙箱进程失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
        }
        drop(thread);

        let mut out_file = unsafe { std::fs::File::from_raw_handle(out_read.0) };
        let mut err_file = unsafe { std::fs::File::from_raw_handle(err_read.0) };
        std::mem::forget(out_read);
        std::mem::forget(err_read);
        let out_thread = std::thread::spawn(move || {
            let mut data = Vec::new();
            let _ = out_file.read_to_end(&mut data);
            data
        });
        let err_thread = std::thread::spawn(move || {
            let mut data = Vec::new();
            let _ = err_file.read_to_end(&mut data);
            data
        });

        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.max(200));
        let mut timed_out = false;
        let mut stopped = false;
        loop {
            let wait = unsafe { WaitForSingleObject(process.0, 40) };
            if wait == WAIT_OBJECT_0 {
                break;
            }
            if should_stop() {
                stopped = true;
                unsafe { TerminateJobObject(job.0, 1) };
                break;
            }
            if start.elapsed() >= timeout {
                timed_out = true;
                unsafe { TerminateJobObject(job.0, 1) };
                break;
            }
            if wait != WAIT_TIMEOUT {
                unsafe { TerminateJobObject(job.0, 1) };
                return Err(format!(
                    "等待沙箱进程失败（{}）",
                    std::io::Error::last_os_error()
                ));
            }
        }
        unsafe {
            WaitForSingleObject(process.0, u32::MAX);
            TerminateJobObject(job.0, 1);
        }
        let mut code = -1i32;
        unsafe {
            let mut raw = 0u32;
            if GetExitCodeProcess(process.0, &mut raw) != 0 {
                code = raw as i32;
            }
        }
        let out = out_thread.join().unwrap_or_default();
        let err = err_thread.join().unwrap_or_default();
        if stopped {
            return Err("用户停止了这条沙箱命令（进程树已杀掉）".into());
        }
        if timed_out {
            return Err(format!(
                "沙箱命令超过 {}ms 没结束，已杀掉整棵进程树",
                timeout.as_millis()
            ));
        }
        Ok((code, crate::shell::decode(&out), crate::shell::decode(&err)))
    }

    struct AttrGuard(*mut c_void);
    impl Drop for AttrGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { DeleteProcThreadAttributeList(self.0) };
            }
        }
    }

    pub fn describe() -> Result<serde_json::Value, String> {
        let sid = appcontainer_sid()?;
        Ok(serde_json::json!({
            "mode": "appcontainer",
            "profile": APP_CONTAINER_NAME,
            "sid": sid_string(sid)?,
            "network_default": "denied",
            "workspace_only": true,
            "job_limits": {
                "processes": MAX_PROCESSES,
                "process_memory": MAX_PROCESS_MEMORY
            }
        }))
    }
}

#[cfg(not(windows))]
pub fn describe() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "mode": "process",
        "network_default": "denied",
        "workspace_only": true
    }))
}

#[cfg(windows)]
pub fn describe() -> Result<serde_json::Value, String> {
    windows::describe()
}

pub fn policy_for(mode: SandboxMode, network: bool) -> serde_json::Value {
    serde_json::json!({
        "mode": mode.as_str(),
        "workspace_only": mode == SandboxMode::Workspace,
        "network": if mode == SandboxMode::Workspace { network } else { true },
        "process_isolation": true,
        "fallback": "trusted_host"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modes_and_builds_policy() {
        assert_eq!(SandboxMode::parse("workspace"), SandboxMode::Workspace);
        assert_eq!(SandboxMode::parse("trusted"), SandboxMode::Trusted);
        assert_eq!(SandboxMode::parse("nonsense"), SandboxMode::Workspace);
        let p = policy_for(SandboxMode::Workspace, false);
        assert_eq!(p["workspace_only"], true);
        assert_eq!(p["network"], false);
        assert_eq!(p["process_isolation"], true);
    }

    #[cfg(windows)]
    #[test]
    fn appcontainer_blocks_writes_outside_workspace() {
        let workspace =
            std::env::temp_dir().join(format!("kdock-sandbox-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).unwrap();
        let inside = workspace.join("inside.txt");
        let outside = std::env::temp_dir().join(format!(
            "kdock-sandbox-escape-{}.txt",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&outside);

        let script = format!(
            "echo INSIDE>\"{}\" & echo ESCAPE>\"{}\"",
            inside.display(),
            outside.display()
        );
        let (_, out, err) = run(
            SandboxMode::Workspace,
            &script,
            60_000,
            &|| false,
            "",
            Some(&workspace),
            false,
        )
        .expect("sandbox command should start");
        assert!(
            std::fs::read_to_string(&inside)
                .unwrap_or_default()
                .contains("INSIDE"),
            "workspace write should succeed: out={out} err={err}"
        );
        assert!(
            !outside.exists(),
            "AppContainer escaped the workspace and wrote {}",
            outside.display()
        );

        let (network_code, network_out, network_err) = run(
            SandboxMode::Workspace,
            "curl.exe -sS --max-time 5 https://example.com",
            15_000,
            &|| false,
            "",
            Some(&workspace),
            false,
        )
        .expect("network probe should start in the sandbox");
        assert_ne!(
            network_code, 0,
            "AppContainer without InternetClient capability must not reach the network: out={network_out} err={network_err}"
        );

        let (code, out, err) = run(
            SandboxMode::Workspace,
            "powershell -NoProfile -Command \"$v = 41; Write-Output ('KDOCK_' + ($v + 1))\"",
            60_000,
            &|| false,
            "",
            Some(&workspace),
            false,
        )
        .expect("quoted command should start");
        assert_eq!(code, 0, "stderr={err}");
        assert!(out.contains("KDOCK_42"), "stdout={out}");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
