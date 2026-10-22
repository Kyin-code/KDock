//! 内嵌调试：GDB（MI 模式）通道 + GDB Server（openocd / JLinkGDBServer…）子进程管理。
//!
//! 这一层只做三件事：起进程、把子进程输出**按行原样**推给前端（`debug://gdb` / `debug://server`）、
//! 把前端敲的命令写进 gdb 的 stdin。MI 的解析和所有界面都在前端 —— 控制台和面板可以随时改，不用动后端。
//!
//! 用法上：gdb 走 `--interpreter=mi2`，但前端控制台里敲的普通命令会被自动包成
//! `-interpreter-exec console "…"`，所以敲起来和裸 gdb 一样（`target extended-remote :3333`、
//! `break main`、`continue`…）；面板则用 MI 的结构化输出（`-stack-list-frames`、
//! `-data-list-register-values`、`-stack-list-variables`、`-break-list`）。
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct DebugState {
    gdb: Mutex<Option<GdbProc>>,
    server: Mutex<Option<Child>>,
}

struct GdbProc {
    child: Child,
    stdin: ChildStdin,
}

fn state(app: &AppHandle) -> Arc<DebugState> {
    let st = app.state::<Arc<DebugState>>();
    st.inner().clone()
}

/// 子进程输出 → 每行一个事件（gdb 的 MI 输出本来就是一行一条记录）
fn spawn_reader<R: std::io::Read + Send + 'static>(app: AppHandle, r: R, event: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines() {
            match line {
                Ok(l) => {
                    let _ = app.emit(event, l);
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(event, "\n[kdock] 输出流结束（进程可能已退出）");
    });
}

/// 起 gdb（MI 模式）。path 留空就用 `gdb`。会先关掉上一个。
#[tauri::command]
pub fn debug_gdb_start(
    app: AppHandle,
    path: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(), String> {
    debug_gdb_stop(app.clone()).ok();
    let exe = if path.trim().is_empty() { "gdb".to_string() } else { path.trim().to_string() };
    let mut cmd = Command::new(&exe);
    cmd.args(["-q", "--interpreter=mi2"]);
    cmd.arg("-ex").arg("set pagination off");
    cmd.arg("-ex").arg("set confirm off");
    if let Some(a) = args.filter(|a| !a.is_empty()) {
        cmd.args(a);
    }
    if let Some(d) = cwd.filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(d);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别弹黑框
    }
    let mut child = crate::process_guard::spawn(&mut cmd)
        .map_err(|e| format!("起 gdb 失败（{exe}）：{e}"))?;
    let stdin = child.stdin.take().ok_or("拿不到 gdb 的 stdin")?;
    if let Some(out) = child.stdout.take() {
        spawn_reader(app.clone(), out, "debug://gdb");
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(app.clone(), err, "debug://gdb");
    }
    *state(&app).gdb.lock().expect("gdb mutex") = Some(GdbProc { child, stdin });
    let _ = app.emit("debug://gdb", format!("[kdock] 已启动 {exe}（MI 模式）"));
    Ok(())
}

#[tauri::command]
pub fn debug_gdb_stop(app: AppHandle) -> Result<(), String> {
    let proc = state(&app).gdb.lock().expect("gdb mutex").take();
    if let Some(mut p) = proc {
        let _ = p.stdin.write_all(b"-gdb-exit\n");
        let _ = p.stdin.flush();
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = p.child.kill();
        let _ = p.child.wait();
        let _ = app.emit("debug://gdb", "\n[kdock] gdb 已关闭");
    }
    Ok(())
}

/// 给 gdb 发一条命令：以 `-` 开头（MI）就原样发；否则包成 `-interpreter-exec console "…"` ——
/// 所以控制台里可以直接敲 `target extended-remote :3333` / `break main` / `continue`。
#[tauri::command]
pub fn debug_gdb_cmd(app: AppHandle, line: String) -> Result<(), String> {
    let l = line.trim();
    if l.is_empty() {
        return Ok(());
    }
    let mi = if l.starts_with('-') {
        l.to_string()
    } else {
        format!(
            "-interpreter-exec console \"{}\"",
            l.replace('\\', "\\\\").replace('"', "\\\"")
        )
    };
    let _ = app.emit("debug://gdb", format!("(gdb) {l}"));
    let st = state(&app);
    let mut g = st.gdb.lock().expect("gdb mutex");
    let Some(p) = g.as_mut() else { return Err("gdb 还没起来（先点「启动 gdb」）".into()) };
    p.stdin
        .write_all(mi.as_bytes())
        .and_then(|_| p.stdin.write_all(b"\n"))
        .and_then(|_| p.stdin.flush())
        .map_err(|e| format!("发给 gdb 失败: {e}"))
}

/// 起 GDB Server（openocd / JLinkGDBServerCL / pyocd gdbserver…）
#[tauri::command]
pub fn debug_server_start(
    app: AppHandle,
    program: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(), String> {
    debug_server_stop(app.clone()).ok();
    if program.trim().is_empty() {
        return Err("先填 GDB Server 的可执行文件".into());
    }
    let mut cmd = Command::new(program.trim());
    if let Some(a) = args.filter(|a| !a.is_empty()) {
        cmd.args(a);
    }
    if let Some(d) = cwd.filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(d);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut cmd)
        .map_err(|e| format!("起 {} 失败: {e}", program.trim()))?;
    if let Some(out) = child.stdout.take() {
        spawn_reader(app.clone(), out, "debug://server");
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(app.clone(), err, "debug://server");
    }
    *state(&app).server.lock().expect("server mutex") = Some(child);
    let _ = app.emit("debug://server", format!("[kdock] 已启动 {}", program.trim()));
    Ok(())
}

#[tauri::command]
pub fn debug_server_stop(app: AppHandle) -> Result<(), String> {
    let s = state(&app).server.lock().expect("server mutex").take();
    if let Some(mut c) = s {
        let _ = c.kill();
        let _ = c.wait();
        let _ = app.emit("debug://server", "\n[kdock] GDB Server 已关闭");
    }
    Ok(())
}

/// 有没有在跑（界面刷新按钮状态用）
#[tauri::command]
pub fn debug_status(app: AppHandle) -> serde_json::Value {
    let st = state(&app);
    let gdb = st.gdb.lock().map(|g| g.is_some()).unwrap_or(false);
    let server = st.server.lock().map(|s| s.is_some()).unwrap_or(false);
    serde_json::json!({ "gdb": gdb, "server": server })
}
