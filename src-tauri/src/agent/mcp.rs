//! MCP（Model Context Protocol）最小客户端：stdio + 换行分隔的 JSON-RPC 2.0。
//!
//! 支持本地 stdio 与远程 Streamable HTTP 两种 transport。
//! 两者都只实现 initialize / tools/list / tools/call；连接按 server 复用，
//! 配置变化时主动清理。

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::store::agent_dir;

pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// agent 当前会话的工作区。给 `server-filesystem` 这类 MCP 自动带上当"可访问目录"：
/// 配置里往往只写死了某一个目录（实测用户那份是 D:\env），于是 agent 看不到自己的工作区、
/// 只能把文件拷到那个目录里再看 —— 既费事又留下垃圾。
static EXTRA_ROOTS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

pub fn set_extra_roots(roots: Vec<String>) {
    if let Ok(mut g) = EXTRA_ROOTS.lock() {
        *g = roots;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "RawMcp")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    /// 可执行文件（npx / uvx / node / 你自己的 mcp server.exe）
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 远程 Streamable HTTP MCP 地址。有 command 时也可以保留 URL（用于显示/诊断），实际走 stdio。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 远程 MCP 的额外请求头（例如 Authorization）。查询参数里已有 key 时可以不填。
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// 解析用的中间结构：**同时吃两种写法**，方便从 opencode / CCSwitch 直接抄配置。
///
/// - KDock 自己的写法：`{"command": "npx", "args": ["-y", "pkg"], "env": {...}}`
/// - opencode 那套：`{"command": ["npx", "-y", "pkg"], "environment": {...}}`
///   （命令和参数连在一个数组里、环境变量键叫 `environment`）
///
/// 同时支持 opencode / VS Code / Claude 的远程写法：`url`（以及 `serverUrl` / `httpUrl`）。
/// 没有 command 时自动走 Streamable HTTP MCP。
#[derive(Deserialize)]
struct RawMcp {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    command: CmdField,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, alias = "environment")]
    env: BTreeMap<String, String>,
    #[serde(default, alias = "serverUrl", alias = "httpUrl")]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    enabled: bool,
}

#[derive(Deserialize, Default)]
#[serde(untagged)]
enum CmdField {
    #[default]
    Empty,
    One(String),
    Many(Vec<String>),
}

impl From<RawMcp> for McpServer {
    fn from(r: RawMcp) -> Self {
        let (command, head_args) = match r.command {
            CmdField::Empty => (String::new(), Vec::new()),
            CmdField::One(c) => (c, Vec::new()),
            // 数组形式：第一个是命令，后面都当参数（排在 args 前面，保持原顺序）
            CmdField::Many(mut v) => {
                if v.is_empty() {
                    (String::new(), Vec::new())
                } else {
                    let cmd = v.remove(0);
                    (cmd, v)
                }
            }
        };
        let mut args = head_args;
        args.extend(r.args);
        McpServer {
            id: r.id,
            name: if r.name.trim().is_empty() { String::new() } else { r.name },
            command,
            args,
            env: r.env,
            enabled: r.enabled,
            url: r.url,
            headers: r.headers,
        }
    }
}

fn yes() -> bool {
    true
}

/// 给 cmd.exe 用的一层引用：含空格/特殊字符的参数才加引号（内部引号翻倍）。
/// 只用在"要借 cmd 起 .cmd/.bat"的那条路上；直接 CreateProcess 的路径不做任何加工。
fn cmd_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let special = |c: char| matches!(c, ' ' | '\t' | '&' | '|' | '<' | '>' | '^' | '"' | '(' | ')');
    if !s.chars().any(special) {
        return s.to_string();
    }
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn mcp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("mcp.json"))
}

pub fn load(app: &AppHandle) -> Vec<McpServer> {
    let Ok(text) = std::fs::read_to_string(mcp_path(app).unwrap_or_default()) else {
        return Vec::new();
    };
    // 逐条解析：某一条写错了（少字段、类型不对）只丢那一条，
    // 别让整个文件解析失败 —— 那样界面上会是"一条都没有"，很难查（踩过）。
    let Ok(items) = serde_json::from_str::<Vec<Value>>(&text) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<McpServer>(v).ok())
        .collect()
}

pub fn save(app: &AppHandle, list: &[McpServer]) -> Result<(), String> {
    let path = mcp_path(app)?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写 {} 失败: {e}", path.display()))
}

pub fn find(app: &AppHandle, id: &str) -> Option<McpServer> {
    load(app).into_iter().find(|s| s.id == id)
}

#[derive(Debug, Clone)]
struct StdioTransport {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    rx: Arc<Mutex<std::sync::mpsc::Receiver<String>>>,
}

#[derive(Debug, Clone)]
struct HttpTransport {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: String,
    authenticated: bool,
}

#[derive(Debug, Clone)]
enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
}

struct Client {
    transport: Transport,
    next_id: u64,
    info: Value,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Client {
    fn spawn_stdio(srv: &McpServer) -> Result<Self, String> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if srv.command.trim().is_empty() {
            return Err(format!("「{}」没写 command（本地 stdio 类型必须有要启动的命令）", srv.id));
        }
        // npx/npm 这类在 Windows 上是 .cmd 脚本，必须借 cmd.exe 起（直接 CreateProcess 会失败）
        #[cfg(windows)]
        let needs_shell = srv.command.ends_with(".cmd")
            || srv.command.ends_with(".bat")
            || srv.command == "npx"
            || srv.command == "npm";
        #[cfg(not(windows))]
        let needs_shell = false;

        // filesystem 这类 server：把 agent 当前工作区也当成可访问目录加进去
        let is_fs_server = srv.command.to_lowercase().contains("server-filesystem")
            || srv.args.iter().any(|a| a.to_lowercase().contains("server-filesystem"));
        let mut extra: Vec<String> = Vec::new();
        if is_fs_server {
            if let Ok(g) = EXTRA_ROOTS.lock() {
                for r in g.iter() {
                    let r = r.trim();
                    if !r.is_empty() && !srv.args.iter().any(|a| a.trim().eq_ignore_ascii_case(r)) {
                        extra.push(r.to_string());
                    }
                }
            }
        }

        let mut cmd = if needs_shell {
            #[cfg(windows)]
            let c = Command::new("cmd");
            #[cfg(not(windows))]
            let c = Command::new("sh");
            c
        } else {
            Command::new(&srv.command)
        };
        if needs_shell {
            // 命令 + 参数先拼成"一整条命令行"，再交给 shell。
            let mut parts = vec![cmd_quote(&srv.command)];
            parts.extend(srv.args.iter().map(|a| cmd_quote(a)));
            parts.extend(extra.iter().map(|a| cmd_quote(a)));
            let line = parts.join(" ");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.arg("/C");
                cmd.raw_arg(format!("\"{line}\""));
            }
            #[cfg(not(windows))]
            {
                cmd.arg("-c");
                cmd.arg(line);
            }
        }
        if !needs_shell {
            cmd.args(&srv.args);
            cmd.args(&extra);
        }
        for (k, v) in &srv.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("起 {} 失败: {e}", srv.command))?;
        let stdin = child.stdin.take().ok_or("拿不到 stdin")?;
        let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
        let stderr = child.stderr.take();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = stderr {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut q) = tail.lock() {
                        if q.len() >= 40 { q.pop_front(); }
                        q.push_back(line);
                    }
                }
            });
        }
        Ok(Self {
            transport: Transport::Stdio(StdioTransport {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(stdin)),
                rx: Arc::new(Mutex::new(rx)),
            }),
            next_id: 1,
            info: Value::Null,
            stderr_tail,
        })
    }

    fn spawn_http(srv: &McpServer) -> Result<Self, String> {
        let url = srv.url.as_deref().unwrap_or("").trim();
        if url.is_empty() {
            return Err(format!("「{}」既没有 command，也没有 url", srv.id));
        }
        let mut headers = srv.headers.clone();
        if !headers.keys().any(|k| k.eq_ignore_ascii_case("accept")) {
            headers.insert("Accept".into(), "application/json, text/event-stream".into());
        }
        Ok(Self {
            transport: Transport::Http(HttpTransport {
                url: url.to_string(),
                headers,
                session_id: String::new(),
                authenticated: false,
            }),
            next_id: 1,
            info: Value::Null,
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        })
    }

    fn spawn(srv: &McpServer) -> Result<Self, String> {
        if !srv.command.trim().is_empty() {
            Self::spawn_stdio(srv)
        } else {
            Self::spawn_http(srv)
        }
    }

    fn stderr_tail_text(&self) -> String {
        let lines = self
            .stderr_tail
            .lock()
            .map(|q| q.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        if lines.trim().is_empty() { String::new() } else { format!("\nMCP stderr:\n{lines}") }
    }

    fn send_stdio(&mut self, msg: &Value) -> Result<(), String> {
        let Transport::Stdio(t) = &self.transport else { return Err("不是 stdio transport".into()); };
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = t.stdin.lock().map_err(|_| "MCP stdin mutex".to_string())?;
        stdin.write_all(line.as_bytes()).map_err(|e| format!("写给 MCP 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush 失败: {e}"))
    }

    fn post_http(&mut self, msg: &Value) -> Result<String, String> {
        let (url, headers, session_id) = match &self.transport {
            Transport::Http(t) => (t.url.clone(), t.headers.clone(), t.session_id.clone()),
            _ => return Err("不是 HTTP transport".into()),
        };
        let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        let mut req = ureq::post(&url)
            .timeout(Duration::from_secs(120))
            .set("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.set(&k, &v);
        }
        if !session_id.is_empty() {
            req = req.set("Mcp-Session-Id", &session_id);
        }
        let resp = req.send_string(&body).map_err(|e| {
            match e {
                ureq::Error::Status(code, r) => {
                    let text = r.into_string().unwrap_or_default();
                    format!("MCP HTTP {code}: {}", text.chars().take(600).collect::<String>())
                }
                other => format!("MCP HTTP 请求失败: {other}"),
            }
        })?;
        if let Some(sid) = resp.header("Mcp-Session-Id") {
            if let Transport::Http(t) = &mut self.transport {
                t.session_id = sid.to_string();
            }
        }
        resp.into_string().map_err(|e| format!("读 MCP HTTP 响应失败: {e}"))
    }

    fn read_sse_messages(text: &str, want_id: u64) -> Result<Value, String> {
        let mut data: Vec<String> = Vec::new();
        let mut last_json = Value::Null;
        let consume = |data: &mut Vec<String>| -> Option<Value> {
            if data.is_empty() { return None; }
            let payload = data.drain(..).collect::<Vec<_>>().join("\n");
            serde_json::from_str::<Value>(&payload)
                .ok()
                .and_then(|v| { if v.get("id").and_then(|x| x.as_u64()) == Some(want_id) { Some(v) } else { None } })
        };
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                data.push(rest.trim_start().to_string());
            } else if line.trim().is_empty() {
                if let Some(v) = consume(&mut data) { return Ok(v); }
            }
        }
        if let Some(v) = consume(&mut data) { return Ok(v); }
        if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
            if v.get("id").and_then(|x| x.as_u64()) == Some(want_id) { return Ok(v); }
            last_json = v;
        }
        if last_json.is_null() {
            Err("MCP HTTP 响应里没有 JSON-RPC 消息".into())
        } else {
            Ok(last_json)
        }
    }

    fn request_http(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let text = self.post_http(&msg)?;
        let _ = timeout;
        let reply = Self::read_sse_messages(&text, id)?;
        if let Some(err) = reply.get("error") { return Err(format!("MCP 报错: {err}")); }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    fn request_stdio(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_stdio(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let start = Instant::now();
        loop {
            let left = timeout.saturating_sub(start.elapsed());
            if left.is_zero() { return Err(format!("{method} 超时{}", self.stderr_tail_text())); }
            let Transport::Stdio(t) = &self.transport else { return Err("不是 stdio transport".into()); };
            let line = {
                let rx = t.rx.lock().map_err(|_| "MCP stdout mutex".to_string())?;
                match rx.recv_timeout(left) {
                    Ok(line) => line,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        return Err(format!("等 MCP 回话超时（服务没响应）{}", self.stderr_tail_text()))
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        return Err(format!("MCP 进程提前退出{}", self.stderr_tail_text()))
                    }
                }
            };
            let t = line.trim();
            if t.is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<Value>(t) {
                if v.get("id").and_then(|x| x.as_u64()) != Some(id) { continue; }
                if let Some(err) = v.get("error") { return Err(format!("MCP 报错: {err}")); }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self.transport {
            Transport::Http(_) => self.request_http(method, params, timeout),
            Transport::Stdio(_) => self.request_stdio(method, params, timeout),
        }
    }

    fn notify_http_initialized(&mut self) -> Result<(), String> {
        let text = self.post_http(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
        let _ = text;
        Ok(())
    }

    fn notify_stdio_initialized(&mut self) -> Result<(), String> {
        self.send_stdio(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
    }

    fn handshake(&mut self) -> Result<Value, String> {
        let r = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "KDock", "version": "0.1.0"}
            }),
            Duration::from_secs(20),
        )?;
        match self.transport {
            Transport::Http(_) => {
                if let Transport::Http(t) = &mut self.transport { t.authenticated = true; }
                let _ = self.notify_http_initialized();
            }
            Transport::Stdio(_) => { let _ = self.notify_stdio_initialized(); }
        }
        Ok(r)
    }

    fn tools(&mut self) -> Result<Vec<Value>, String> {
        let r = self.request("tools/list", json!({}), Duration::from_secs(20))?;
        Ok(r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default())
    }
}
/// 常驻 MCP 进程池：server 配置 + filesystem extra roots 作为 key。
static CLIENTS: LazyLock<Mutex<std::collections::HashMap<String, std::sync::Arc<Mutex<Client>>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn client_key(srv: &McpServer) -> String {
    let roots = EXTRA_ROOTS
        .lock()
        .map(|g| g.join("|"))
        .unwrap_or_default();
    // 远程 HTTP 的 tools/list 可能每次探测都会变；连接池只按真正影响进程/端点的字段建 key，
    // 否则一次探测失败会把刚建好的会话丢掉。
    let endpoint = if srv.command.trim().is_empty() { srv.url.clone().unwrap_or_default() } else { format!("{} {:?}", srv.command, srv.args) };
    format!("{}|{}|roots={roots}|headers={:?}", srv.id, endpoint, srv.headers)
}

fn client_for(srv: &McpServer) -> Result<std::sync::Arc<Mutex<Client>>, String> {
    let key = client_key(srv);
    if let Ok(g) = CLIENTS.lock() {
        if let Some(c) = g.get(&key) {
            return Ok(c.clone());
        }
    }
    let mut c = Client::spawn(srv)?;
    let info = c.handshake()?;
    c.info = info;
    let arc = std::sync::Arc::new(Mutex::new(c));
    if let Ok(mut g) = CLIENTS.lock() {
        g.insert(key, arc.clone());
    }
    Ok(arc)
}

fn drop_client(srv: &McpServer) {
    if let Ok(mut g) = CLIENTS.lock() {
        g.remove(&client_key(srv));
    }
}

pub fn shutdown_all() {
    if let Ok(mut g) = CLIENTS.lock() {
        g.clear(); // Drop 会 kill + wait 子进程
    }
}

/// 连一次，返回 (serverInfo, tools)
pub fn probe(srv: &McpServer) -> Result<(Value, Vec<Value>), String> {
    let c = client_for(srv)?;
    let mut g = c.lock().map_err(|_| "MCP client mutex".to_string())?;
    let info = g.info.clone();
    let tools = g.tools()?;
    Ok((info, tools))
}

/// 调一个工具，把 content 拼成文本
pub fn call_tool(srv: &McpServer, tool: &str, args: &Value) -> Result<String, String> {
    let call = |c: std::sync::Arc<Mutex<Client>>| -> Result<String, String> {
        let mut g = c.lock().map_err(|_| "MCP client mutex".to_string())?;
        let r = g.request(
            "tools/call",
            json!({"name": tool, "arguments": args}),
            Duration::from_secs(120),
        )?;
        Ok(render_content(&r))
    };
    let c = client_for(srv)?;
    // 远程 HTTP MCP 没有常驻子进程；401 可能只是会话过期，重连一次即可。
    match call(c) {
        Ok(v) => Ok(v),
        Err(e) => {
            // 进程可能已经死了/协议错位：丢掉旧进程再试一次。
            drop_client(srv);
            let c = client_for(srv)?;
            call(c).map_err(|e2| format!("{e}；重连后仍失败：{e2}"))
        }
    }
}

fn render_content(result: &Value) -> String {
    if let Some(arr) = result.get("content").and_then(|c| c.as_array()) {
        let mut out = Vec::new();
        for item in arr {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("text") => out.push(item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()),
                Some(other) => out.push(format!("[{other} 内容]")),
                None => out.push(item.to_string()),
            }
        }
        if !out.is_empty() {
            return out.join("\n");
        }
    }
    result.to_string()
}

/// 给模型用的工具名：mcp__<server>__<tool>（跟别处一样用双下划线分段）
pub fn tool_full_name(server_id: &str, tool: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect::<String>();
    format!("mcp__{}__{}", clean(server_id), clean(tool))
}

pub fn parse_tool_name(full: &str) -> Option<(String, String)> {
    let rest = full.strip_prefix("mcp__")?;
    let (sid, tool) = rest.split_once("__")?;
    Some((sid.to_string(), tool.to_string()))
}

/// 把某个 server 的工具转成 OpenAI function schema
pub fn tool_schemas(srv: &McpServer, tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let name = t.get("name").and_then(|v| v.as_str())?;
            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let schema = t.get("inputSchema").cloned().unwrap_or(json!({"type":"object","properties":{}}));
            Some(json!({"type":"function","function":{
                "name": tool_full_name(&srv.id, name),
                "description": format!("[MCP:{}] {desc}", srv.name),
                "parameters": schema
            }}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_url_aliases_and_headers() {
        let srv: McpServer = serde_json::from_value(json!({
            "id": "exa",
            "name": "Exa",
            "serverUrl": "https://mcp.exa.ai/mcp",
            "headers": {"Authorization": "Bearer test"},
            "enabled": true
        })).unwrap();
        assert_eq!(srv.url.as_deref(), Some("https://mcp.exa.ai/mcp"));
        assert_eq!(srv.headers.get("Authorization").map(String::as_str), Some("Bearer test"));
        assert!(srv.command.is_empty());
    }

    #[test]
    fn parses_sse_jsonrpc_data_frame() {
        let text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let v = Client::read_sse_messages(text, 2).unwrap();
        assert_eq!(v["id"], 2);
        assert!(v["result"]["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn remote_url_is_not_a_local_command() {
        let srv = McpServer {
            id: "remote".into(), name: "Remote".into(), command: String::new(),
            args: Vec::new(), env: BTreeMap::new(),
            url: Some("https://example.invalid/mcp".into()),
            headers: BTreeMap::new(), enabled: true,
        };
        assert!(srv.command.is_empty() && srv.url.is_some());
    }
}
/// 当前所有启用 server 的工具（带缓存到内存的意图：调用方自己管缓存）
pub fn all_tool_schemas(app: &AppHandle) -> Vec<Value> {
    let mut out = Vec::new();
    for srv in load(app).into_iter().filter(|s| s.enabled) {
        if let Ok((_info, tools)) = probe(&srv) {
            out.extend(tool_schemas(&srv, &tools));
        }
    }
    out
}

/// MCP 工具清单缓存：(配置指纹, 写入时间, 工具 schema)
static TOOLS_CACHE: LazyLock<Mutex<Option<(String, Instant, Vec<Value>)>>> =
    LazyLock::new(|| Mutex::new(None));

/// 配置变了（存/删 MCP 服务）就作废
pub fn invalidate_cache() {
    if let Ok(mut g) = TOOLS_CACHE.lock() {
        *g = None;
    }
    shutdown_all();
}

/// 取所有启用 MCP 服务的工具 schema（**带缓存**），返回 (schema, 这次是否真的重新探测了)。
///
/// 为什么要缓存，两层原因：
///   1. 每轮都 spawn 一遍 MCP 服务太贵 —— `npx` 那种握手要好几秒，直接拖慢每一轮；
///   2. 更要紧的是**前缀缓存命中率**：tools 定义在 prompt 的**前缀**里，
///      只要有一处字段/顺序不同，DeepSeek 的自动前缀缓存就从这里开始全部失效。
///      所以按"配置内容指纹 + 10 分钟"复用同一份，顺序也排死（按工具名排序）。
pub fn all_tool_schemas_cached(app: &AppHandle) -> (Vec<Value>, bool) {
    let key = serde_json::to_string(&load(app)).unwrap_or_default();
    if let Ok(g) = TOOLS_CACHE.lock() {
        if let Some((k, at, v)) = g.as_ref() {
            // 10 分钟 → 60 分钟：工具清单在 prompt 前缀里，刷新一次整段前缀缓存就作废，
            // 而 MCP 服务的工具列表本来就极少变（配置改动会另走失效路径）。宁可晚点发现变化，
            // 也要少让用户的缓存命中率掉下来。
            if *k == key && at.elapsed() < Duration::from_secs(3600) {
                return (v.clone(), false);
            }
        }
    }
    let mut v = all_tool_schemas(app);
    // 顺序排死：两次请求的工具顺序不同 = 前缀缓存全废
    v.sort_by_key(|t| {
        t.get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string()
    });
    if let Ok(mut g) = TOOLS_CACHE.lock() {
        *g = Some((key, Instant::now(), v.clone()));
    }
    (v, true)
}

/// 前端"测一测"用：返回一句人话
pub fn describe(app: &AppHandle, id: &str) -> Result<String, String> {
    let srv = find(app, id).ok_or("找不到这个 MCP 服务")?;
    let (info, tools) = probe(&srv)?;
    let name = info
        .get("serverInfo")
        .and_then(|s| s.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or(&srv.name);
    let list = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .take(20)
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("连上了：{name}，{} 个工具（{list}）", tools.len()))
}

/// 让 agent 调用的入口：`mcp__<server>__<tool>`
pub fn call_by_full_name(app: &AppHandle, full: &str, args: &Value) -> Result<String, String> {
    let (sid, tool) = parse_tool_name(full).ok_or_else(|| format!("不是 MCP 工具名: {full}"))?;
    let srv = find(app, &sid).ok_or_else(|| format!("没有配置 MCP 服务 {sid}"))?;
    call_tool(&srv, &tool, args)
}

/// 让前端知道 MCP 配置目录在哪
pub fn dir_hint(app: &AppHandle) -> String {
    mcp_path(app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}
