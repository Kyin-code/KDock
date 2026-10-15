//! MCP（Model Context Protocol）最小客户端：stdio + 换行分隔的 JSON-RPC 2.0。
//!
//! 只做三件事：initialize / tools/list / tools/call。
//! 每次调用**起一个新进程**（跑完就杀）：无状态、不会漏子进程，代价是每次多几百毫秒。
//! 对我们这种"手动点一下才用到 MCP"的场景，这个取舍比维护长连接划算。

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::store::agent_dir;

pub const PROTOCOL_VERSION: &str = "2024-11-05";

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
    /// 只有 opencode 那种 remote(HTTP) 服务才有；我们目前不支持，读到它只为了给人一句明确的提示
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// 解析用的中间结构：**同时吃两种写法**，方便从 opencode / CCSwitch 直接抄配置。
///
/// - KDock 自己的写法：`{"command": "npx", "args": ["-y", "pkg"], "env": {...}}`
/// - opencode 那套：`{"command": ["npx", "-y", "pkg"], "environment": {...}}`
///   （命令和参数连在一个数组里、环境变量键叫 `environment`）
///
/// 另外把 `url` 也收下：那是 remote(HTTP) 服务，我们目前只支持本地 stdio，
/// 但要能**读进来**并在用到时报一句人话，而不是让整个文件解析失败（见 `load`）。
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
    #[serde(default)]
    url: Option<String>,
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

struct Client {
    child: Child,
    stdin: ChildStdin,
    /// 读线程把子进程的每一行送过来。
    /// 为什么要单独开线程：管道读是**阻塞**的，直接在 recv 时 read_line 的话，
    /// 对方不回话就永远醒不过来（原来的"超时"只在两行之间生效，等于没有超时），
    /// 一个不响应的 MCP 服务能把整个 Agent 永久卡死。
    rx: std::sync::mpsc::Receiver<String>,
    next_id: u64,
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Client {
    fn spawn(srv: &McpServer) -> Result<Self, String> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if srv.command.trim().is_empty() {
            return Err(match &srv.url {
                Some(u) => format!("「{}」是远程(HTTP) MCP（{u}）——KDock 目前只支持本地 stdio 类型", srv.id),
                None => format!("「{}」没写 command（本地 stdio 类型必须有要启动的命令）", srv.id),
            });
        }
        // npx/npm 这类在 Windows 上是 .cmd 脚本，必须借 cmd.exe 起（直接 CreateProcess 会失败）
        #[cfg(windows)]
        let needs_shell = srv.command.ends_with(".cmd")
            || srv.command.ends_with(".bat")
            || srv.command == "npx"
            || srv.command == "npm";
        #[cfg(not(windows))]
        let needs_shell = false;

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
            let line = parts.join(" ");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.arg("/C");
                // ⚠️ 两个坑一起踩过（`npx.cmd` 这类 server 一直"启动失败/超时"就是这么来的）：
                //   1. 参数必须**真的传下去**（原来只 arg(command)、args 直接丢了 → npx 空跑等超时）；
                //   2. cmd /C 后面如果以引号开头，它会把这行的首尾引号各剥一层 —— 所以整条命令
                //      要**再包一层引号**：cmd /C ""C:\Program Files\nodejs\npx.cmd" -y pkg"。
                //   3. 而且要用 raw_arg：走正常 arg() 的话 Rust 会按 C 运行时规则把引号转义成 \"，
                //      cmd 不认那种写法，命令会散掉。
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
        }
        for (k, v) in &srv.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("起 {} 失败: {e}", srv.command))?;
        let stdin = child.stdin.take().ok_or("拿不到 stdin")?;
        let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break; // 主线程不听了（已经拿到结果/退出）
                }
            }
        });
        Ok(Client { child, stdin, rx, next_id: 1 })
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(|e| format!("写给 MCP 失败: {e}"))?;
        self.stdin.flush().map_err(|e| format!("flush 失败: {e}"))
    }

    /// 读一行（跳过空行/通知），带超时
    fn read_msg(&mut self, timeout: Duration) -> Result<Value, String> {
        let start = Instant::now();
        loop {
            let left = timeout.saturating_sub(start.elapsed());
            if left.is_zero() {
                return Err("等 MCP 回话超时（服务没响应）".into());
            }
            match self.rx.recv_timeout(left) {
                Ok(line) => {
                    let t = line.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(t) {
                        if v.get("id").is_some() {
                            return Ok(v);
                        }
                        // 通知（比如 logging）忽略
                    }
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err("等 MCP 回话超时（服务没响应）".into())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("MCP 进程提前退出了".into())
                }
            }
        }
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let start = Instant::now();
        loop {
            let left = timeout.saturating_sub(start.elapsed());
            if left.is_zero() {
                return Err(format!("{method} 超时"));
            }
            let msg = self.read_msg(left)?;
            if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(format!("MCP 报错: {err}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
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
        let _ = self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        Ok(r)
    }

    fn tools(&mut self) -> Result<Vec<Value>, String> {
        let r = self.request("tools/list", json!({}), Duration::from_secs(20))?;
        Ok(r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default())
    }
}

/// 连一次，返回 (serverInfo, tools)
pub fn probe(srv: &McpServer) -> Result<(Value, Vec<Value>), String> {
    let mut c = Client::spawn(srv)?;
    let info = c.handshake()?;
    let tools = c.tools()?;
    Ok((info, tools))
}

/// 调一个工具，把 content 拼成文本
pub fn call_tool(srv: &McpServer, tool: &str, args: &Value) -> Result<String, String> {
    let mut c = Client::spawn(srv)?;
    c.handshake()?;
    let r = c.request(
        "tools/call",
        json!({"name": tool, "arguments": args}),
        Duration::from_secs(120),
    )?;
    Ok(render_content(&r))
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
