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

#[derive(Clone)]
struct GraphSnapshot {
    root: String,
    filepath: String,
    scope: String,
    data: Value,
}

static RUNTIME: LazyLock<Mutex<Option<RuntimeProc>>> = LazyLock::new(|| Mutex::new(None));
static LAST_GRAPH: LazyLock<Mutex<Option<GraphSnapshot>>> = LazyLock::new(|| Mutex::new(None));
const ANALYZER_DIR: &str = "bingraph";
const ANALYZER_PY: &str = "python\\python.exe";

/// `canonicalize()` on Windows returns `\\?\D:\...`. angr/cle cannot use that
/// form for its RTDB storage and fails with "No writable directory found".
fn native_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = raw.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

fn analyzer_log_path() -> PathBuf {
    std::env::temp_dir().join("kdock-bingraph.log")
}

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
    let root_s = native_path_string(&root);
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
    let logfile = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(analyzer_log_path())
        .map_err(|e| format!("创建分析器日志失败：{e}"))?;
    let mut cmd = Command::new(&py);
    cmd.arg(pkg.join("run.py"))
        .arg("--root").arg(&root_s).arg("server").arg("--port").arg(port.to_string())
        .env("BINGRAPH_NATIVE_BLOB_SPECS", blob_spec)
        .env("BINGRAPH_NATIVE_VECTOR_BASE", vector_base)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(logfile));
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
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        let detail = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("detail")
                    .or_else(|| v.get("error"))
                    .or_else(|| v.get("message"))
                    .map(|m| {
                        m.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| m.to_string())
                    })
            })
            .unwrap_or_else(|| String::from_utf8_lossy(&body).chars().take(800).collect());
        return Err(format!(
            "分析器返回 {}：{}（日志：{}）",
            head.lines().next().unwrap_or("HTTP error"),
            detail,
            analyzer_log_path().display()
        ));
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

pub(crate) fn analyze_sync(
    app: &tauri::AppHandle,
    root: &str,
    filepath: &str,
    scope: &str,
    blob_base: &str,
    blob_arch: &str,
    blob_entry: &str,
    vector_base: &str,
) -> Result<Value, String> {
    let base = blob_base.trim();
    let arch = blob_arch.trim();
    let entry = blob_entry.trim();
    let vector = vector_base.trim();
    let blob_spec = if !base.is_empty() {
        let name = filepath.rsplit(['/', '\\']).next().unwrap_or(filepath);
        let arch = if arch.is_empty() { "ARMCortexM" } else { arch };
        if entry.is_empty() {
            format!("{name}:{base}:{arch}")
        } else {
            format!("{name}:{base}:{arch}:{entry}")
        }
    } else {
        String::new()
    };
    let api = if scope == "all" {
        "/api/functions/json"
    } else {
        "/api/runtime/json"
    };
    let mut path = format!("{api}?filepath={}", filepath_url(filepath));
    if !entry.is_empty() {
        path.push_str("&entry=");
        path.push_str(&filepath_url(entry));
    }
    // A failed request may leave angr's project/cache in a dead state. Stop
    // that process and retry once with a fresh analyzer instead of making
    // every later click fail against the same broken instance.
    let mut port = ensure(app, root, &blob_spec, vector)?;
    let mut data = match get_json(port, &path) {
        Ok(v) => v,
        Err(first) => {
            stop_locked();
            let retry_port = ensure(app, root, &blob_spec, vector)?;
            let value = get_json(retry_port, &path).map_err(|second| {
                format!("{first}\n已重启分析器重试一次，仍失败：{second}")
            })?;
            port = retry_port;
            value
        }
    };
    if let Some(obj) = data.as_object_mut() {
        obj.insert("analyzerPort".into(), json!(port));
        obj.insert("root".into(), json!(root));
        obj.insert("scope".into(), json!(scope));
    }
    if let Ok(mut g) = LAST_GRAPH.lock() {
        *g = Some(GraphSnapshot {
            root: root.to_string(),
            filepath: filepath.to_string(),
            scope: scope.to_string(),
            data: data.clone(),
        });
    }
    Ok(data)
}

pub(crate) fn agent_analyze(
    app: &tauri::AppHandle,
    path: &str,
    scope: &str,
    blob_base: &str,
    blob_arch: &str,
    blob_entry: &str,
    vector_base: &str,
) -> Result<String, String> {
    let file = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("固件文件无效：{e}"))?;
    if !file.is_file() {
        return Err("固件路径不是文件".into());
    }
    let root = file
        .parent()
        .ok_or_else(|| "无法确定固件目录".to_string())?;
    let filepath = file
        .file_name()
        .ok_or_else(|| "固件文件名为空".to_string())?
        .to_string_lossy()
        .to_string();
    let root_s = native_path_string(root);
    let data = analyze_sync(
        app,
        &root_s,
        &filepath,
        scope,
        blob_base,
        blob_arch,
        blob_entry,
        vector_base,
    )?;
    let nodes = data.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
    let incoming = nodes
        .iter()
        .map(|n| {
            (
                n.get("addr").and_then(Value::as_str).unwrap_or("").to_string(),
                n.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut caller_count = std::collections::HashMap::<String, usize>::new();
    for n in &nodes {
        for call in n.get("calls").and_then(Value::as_array).into_iter().flatten() {
            if let Some(addr) = call.get("addr").and_then(Value::as_str) {
                *caller_count.entry(addr.to_string()).or_default() += 1;
            }
        }
    }
    let mut ranked = nodes
        .iter()
        .map(|n| {
            let addr = n.get("addr").and_then(Value::as_str).unwrap_or("");
            let calls = n.get("calls").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            (
                calls + caller_count.get(addr).copied().unwrap_or(0),
                json!({
                    "addr": addr,
                    "name": n.get("name").and_then(Value::as_str).unwrap_or(""),
                    "calls": calls,
                    "callers": caller_count.get(addr).copied().unwrap_or(0),
                    "size": n.get("size").and_then(Value::as_u64).unwrap_or(0),
                    "blocks": n.get("blocks").and_then(Value::as_u64).unwrap_or(0),
                }),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let roots = data
        .get("roots")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(30)
                .filter_map(Value::as_str)
                .map(|addr| {
                    json!({
                        "addr": addr,
                        "name": incoming.get(addr).cloned().unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let summary = json!({
        "file": file.to_string_lossy(),
        "scope": scope,
        "entry": data.get("entry").cloned().unwrap_or(Value::Null),
        "entryName": data.get("entryName").cloned().unwrap_or(Value::Null),
        "functions": data.get("totalFunctions").and_then(Value::as_u64).unwrap_or(nodes.len() as u64),
        "nodes": nodes.len(),
        "calls": data.get("totalCalls").and_then(Value::as_u64).unwrap_or(0),
        "interrupts": data.get("interrupts").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "roots": roots,
        "topFunctions": ranked.into_iter().take(30).map(|(_, v)| v).collect::<Vec<_>>(),
        "next": "用 runtime_graph_query 按函数名或地址查看 callers / calls",
    });
    serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())
}

pub(crate) fn agent_query(query: &str, limit: usize) -> Result<String, String> {
    let graph = LAST_GRAPH
        .lock()
        .map_err(|_| "运行结构缓存锁不可用".to_string())?
        .clone()
        .ok_or_else(|| "还没有运行结构数据；先调用 runtime_graph_analyze".to_string())?;
    let nodes = graph
        .data
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err("query 不能为空".into());
    }
    let hex = needle.trim_start_matches("0x");
    let by_addr = nodes
        .iter()
        .filter_map(|n| {
            let addr = n.get("addr").and_then(Value::as_str)?;
            Some((addr.to_string(), n.clone()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut callers = std::collections::HashMap::<String, Vec<Value>>::new();
    for n in &nodes {
        let src_addr = n.get("addr").and_then(Value::as_str).unwrap_or("");
        let src_name = n.get("name").and_then(Value::as_str).unwrap_or("");
        for call in n.get("calls").and_then(Value::as_array).into_iter().flatten() {
            if let Some(dst) = call.get("addr").and_then(Value::as_str) {
                callers.entry(dst.to_string()).or_default().push(json!({
                    "addr": src_addr,
                    "name": src_name,
                    "site": call.get("site").cloned().unwrap_or(Value::Null),
                }));
            }
        }
    }
    let hits = nodes
        .iter()
        .filter(|n| {
            let name = n.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let addr = n.get("addr").and_then(Value::as_str).unwrap_or("").to_lowercase();
            name.contains(&needle) || addr.contains(hex)
        })
        .take(limit.clamp(1, 50))
        .map(|n| {
            let addr = n.get("addr").and_then(Value::as_str).unwrap_or("");
            let calls = n
                .get("calls")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .take(40)
                        .map(|c| {
                            json!({
                                "addr": c.get("addr").cloned().unwrap_or(Value::Null),
                                "name": c.get("name").cloned().unwrap_or(Value::Null),
                                "site": c.get("site").cloned().unwrap_or(Value::Null),
                                "mnemonic": c.get("mnemonic").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "addr": addr,
                "name": n.get("name").cloned().unwrap_or(Value::Null),
                "size": n.get("size").cloned().unwrap_or(Value::Null),
                "blocks": n.get("blocks").cloned().unwrap_or(Value::Null),
                "calls": calls,
                "callers": callers.get(addr).cloned().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    if hits.is_empty() {
        return Err(format!("没有找到函数：{query}（先 runtime_graph_analyze）"));
    }
    serde_json::to_string_pretty(&json!({
        "file": graph.filepath,
        "root": graph.root,
        "scope": graph.scope,
        "matches": hits,
        "knownFunctions": by_addr.len(),
    }))
    .map_err(|e| e.to_string())
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
        analyze_sync(
            &app,
            &root,
            &filepath,
            scope.as_deref().unwrap_or("runtime"),
            blob_base.as_deref().unwrap_or(""),
            blob_arch.as_deref().unwrap_or(""),
            blob_entry.as_deref().unwrap_or(""),
            vector_base.as_deref().unwrap_or(""),
        )
    }).await.map_err(|e| format!("分析任务失败：{e}"))?
}

#[tauri::command]
pub fn runtime_stop() {
    stop_locked();
}

pub fn cleanup() {
    stop_locked();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_extended_paths_are_removed_before_starting_angr() {
        assert_eq!(
            native_path_string(Path::new(r"\\?\D:\firmware\build")),
            r"D:\firmware\build"
        );
        assert_eq!(
            native_path_string(Path::new(r"\\?\UNC\nas\share\build")),
            r"\\nas\share\build"
        );
        assert_eq!(
            native_path_string(Path::new(r"D:\firmware\build")),
            r"D:\firmware\build"
        );
    }

    #[test]
    fn agent_query_returns_calls_and_callers() {
        if let Ok(mut g) = LAST_GRAPH.lock() {
            *g = Some(GraphSnapshot {
                root: r"D:\fw".into(),
                filepath: "demo.elf".into(),
                scope: "all".into(),
                data: json!({
                    "nodes": [
                        {"addr":"10","name":"main","size":32,"blocks":2,"calls":[
                            {"addr":"20","name":"worker","site":"12","mnemonic":"bl worker"}
                        ]},
                        {"addr":"20","name":"worker","size":16,"blocks":1,"calls":[]}
                    ]
                }),
            });
        }
        let text = agent_query("worker", 8).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["matches"][0]["name"], "worker");
        assert_eq!(value["matches"][0]["callers"][0]["name"], "main");
        assert_eq!(agent_query("main", 8).unwrap().contains("\"worker\""), true);
        if let Ok(mut g) = LAST_GRAPH.lock() {
            *g = None;
        }
    }
}
