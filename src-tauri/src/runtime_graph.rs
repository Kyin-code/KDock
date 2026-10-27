use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

struct RuntimeProc {
    child: Child,
    port: u16,
    root: String,
    blob_spec: String,
    vector_base: String,
}

static RUNTIME: LazyLock<Mutex<Option<RuntimeProc>>> = LazyLock::new(|| Mutex::new(None));
const ANALYZER_DIR: &str = "bingraph";
const ANALYZER_PY: &str = "python\\python.exe";

fn resource_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = app.path().resource_dir() {
        out.push(p.join("resources").join(ANALYZER_DIR));
        out.push(p.join(ANALYZER_DIR));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("resources").join(ANALYZER_DIR));
            out.push(dir.join(ANALYZER_DIR));
            out.push(dir.join("_up_").join("resources").join(ANALYZER_DIR));
            out.push(dir.join("_up_").join(ANALYZER_DIR));
        }
    }
    out
}

fn find_build_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    let rel = Path::new("tools").join("bingraph").join("build-portable.ps1");
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.clone());
        roots.push(dir.join("_up_"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("_up_").join("resources"));
            roots.push(dir.join("_up_"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots.into_iter().map(|root| root.join(&rel)).find(|path| path.is_file())
}

fn find_python(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    let mut explicit = Vec::new();
    if let Ok(dir) = app.path().app_local_data_dir() {
        explicit.push(dir.join(ANALYZER_DIR));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        explicit.push(dir.join(ANALYZER_DIR));
    }
    for dir in explicit {
        let py = dir.join(ANALYZER_PY);
        if py.is_file() && dir.join("run.py").is_file() {
            return Some((py, dir));
        }
    }
    for root in resource_roots(app) {
        for sub in [
            ANALYZER_DIR.to_string(),
            "resources/bingraph".to_string(),
            "_up_/resources/bingraph".to_string(),
            "_up_/bingraph".to_string(),
        ] {
            let dir = root.join(sub);
            let py = dir.join(ANALYZER_PY);
            if py.is_file() && dir.join("run.py").is_file() { return Some((py, dir)); }
        }
        let py = root.join(ANALYZER_PY);
        if py.is_file() && root.join("run.py").is_file() { return Some((py, root.clone())); }
    }
    if let Ok(base) = app.path().resource_dir() {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.join(ANALYZER_PY).is_file() && dir.join("run.py").is_file() {
                    return Some((dir.join(ANALYZER_PY), dir));
                }
            }
        }
    }
    None
}

fn probe(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut s) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(180),
    ) else { return false; };
    let _ = s.set_read_timeout(Some(Duration::from_millis(900)));
    let req = "GET /docs HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if s.write_all(req.as_bytes()).is_err() { return false; }
    let mut buf = [0u8; 256];
    match s.read(&mut buf) {
        Ok(n) if n >= 12 => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/"),
        _ => false,
    }
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("找不到空闲端口：{e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn wait_ready(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if probe(port) { return Ok(()); }
        if let Ok(Some(st)) = child.try_wait() {
            return Err(format!("分析器启动后退出（{}）", st));
        }
        std::thread::sleep(Duration::from_millis(220));
    }
    let _ = child.kill();
    Err("分析器启动超时（45 秒）".into())
}

fn stop_locked() {
    if let Ok(mut g) = RUNTIME.lock() {
        if let Some(mut p) = g.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

fn ensure(
    app: &tauri::AppHandle,
    root: &str,
    blob_spec: &str,
    vector_base: &str,
) -> Result<u16, String> {
    let root = Path::new(root).canonicalize().map_err(|e| format!("固件目录无效：{e}"))?;
    if !root.is_dir() { return Err("固件目录不是文件夹".into()); }
    let root_s = root.to_string_lossy().to_string();
    let mut g = RUNTIME.lock().map_err(|_| "分析器锁不可用".to_string())?;
    if let Some(p) = g.as_mut() {
        if p.root == root_s
            && p.blob_spec == blob_spec
            && p.vector_base == vector_base
            && probe(p.port)
        {
            return Ok(p.port);
        }
        let _ = p.child.kill();
        let _ = p.child.wait();
        *g = None;
    }
    let (py, pkg) = find_python(app).ok_or_else(|| {
        "未找到便携分析器。请到「环境配置 → 固件运行结构分析器」点一键准备。".to_string()
    })?;
    let port = free_port()?;
    let mut cmd = Command::new(&py);
    cmd.arg(pkg.join("run.py"))
        .arg("--root").arg(&root_s).arg("server").arg("--port").arg(port.to_string())
        .env("BINGRAPH_NATIVE_BLOB_SPECS", blob_spec)
        .env("BINGRAPH_NATIVE_VECTOR_BASE", vector_base)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = crate::process_guard::spawn(&mut cmd).map_err(|e| format!("启动分析器失败：{e}"))?;
    wait_ready(&mut child, port)?;
    *g = Some(RuntimeProc {
        child, port, root: root_s,
        blob_spec: blob_spec.to_string(),
        vector_base: vector_base.to_string(),
    });
    Ok(port)
}

fn get_json(port: u16, path: &str) -> Result<Value, String> {
    let addr = format!("127.0.0.1:{port}");
    let mut s = TcpStream::connect_timeout(
        &addr.parse().map_err(|_| "分析器端口无效".to_string())?,
        Duration::from_secs(3),
    ).map_err(|e| format!("连接分析器失败：{e}"))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(180)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|e| format!("请求分析器失败：{e}"))?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| format!("读取分析结果失败：{e}"))?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("分析器响应格式错误")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return Err(format!("分析失败：{}", head.lines().next().unwrap_or("HTTP error")));
    }
    let mut body = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = Vec::new();
        let mut i = 0;
        while i < body.len() {
            let Some(end) = body[i..].windows(2).position(|w| w == b"\r\n") else { break; };
            let line = String::from_utf8_lossy(&body[i..i + end]);
            let n = usize::from_str_radix(line.trim(), 16).unwrap_or(0);
            if n == 0 { break; }
            i += end + 2;
            if i + n > body.len() { break; }
            out.extend_from_slice(&body[i..i + n]);
            i += n + 2;
        }
        body = out;
    }
    serde_json::from_slice(&body).map_err(|e| format!("分析结果不是有效 JSON：{e}"))
}

fn filepath_url(filepath: &str) -> String {
    let mut out = String::new();
    for b in filepath.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub fn runtime_analyzer_status(app: tauri::AppHandle) -> Value {
    let found = find_python(&app);
    let running = RUNTIME.lock().ok().and_then(|g| g.as_ref().map(|p| p.port));
    json!({
        "installed": found.is_some(),
        "path": found.map(|(p, _)| p.to_string_lossy().to_string()),
        "running": running.is_some(),
        "port": running,
        "python": "portable / bundled",
        "version": "pybingraph-native 0.1.0 / Python 3.13",
    })
}

#[tauri::command]
pub async fn runtime_prepare(app: tauri::AppHandle) -> Result<Value, String> {
    let dir = app.path().app_local_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join(ANALYZER_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(_) = find_python(&app) {
            return Ok(json!({ "installed": true, "message": "分析器已经就绪" }));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建分析器目录失败：{e}"))?;
        let script = find_build_script(&app).ok_or_else(|| {
            "当前构建没有携带分析器安装脚本；请从正式安装包或完整运行包启动 KDock。".to_string()
        })?;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-OutDir").arg(&dir)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| format!("启动分析器准备失败：{e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = if stderr.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout).into_owned()
            } else {
                stderr.into_owned()
            };
            let tail = detail.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("分析器准备失败：{tail}"));
        }
        Ok(json!({ "installed": true, "path": dir.to_string_lossy(), "message": "便携分析器已安装" }))
    }).await.map_err(|e| format!("准备任务失败：{e}"))?
}

#[tauri::command]
pub async fn runtime_analyze(
    app: tauri::AppHandle,
    root: String,
    filepath: String,
    scope: Option<String>,
    blob_base: Option<String>,
    blob_arch: Option<String>,
    blob_entry: Option<String>,
    vector_base: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = blob_base.unwrap_or_default().trim().to_string();
        let arch = blob_arch.unwrap_or_default().trim().to_string();
        let entry = blob_entry.unwrap_or_default().trim().to_string();
        let vector = vector_base.unwrap_or_default().trim().to_string();
        let blob_spec = if !base.is_empty() {
            let name = filepath.rsplit(['/', '\\']).next().unwrap_or(&filepath);
            let arch = if arch.is_empty() { "ARMCortexM" } else { arch.as_str() };
            if entry.is_empty() {
                format!("{name}:{base}:{arch}")
            } else {
                format!("{name}:{base}:{arch}:{entry}")
            }
        } else {
            String::new()
        };
        let port = ensure(&app, &root, &blob_spec, &vector)?;
        let api = if scope.as_deref() == Some("all") {
            "/api/functions/json"
        } else {
            "/api/runtime/json"
        };
        let mut path = format!("{api}?filepath={}", filepath_url(&filepath));
        if !entry.is_empty() {
            path.push_str("&entry=");
            path.push_str(&filepath_url(&entry));
        }
        let mut data = get_json(port, &path)?;
        if let Some(obj) = data.as_object_mut() {
            obj.insert("analyzerPort".into(), json!(port));
            obj.insert("root".into(), json!(root));
        }
        Ok(data)
    }).await.map_err(|e| format!("分析任务失败：{e}"))?
}

#[tauri::command]
pub fn runtime_stop() {
    stop_locked();
}

pub fn cleanup() {
    stop_locked();
}
