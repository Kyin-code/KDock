//! Agent 能用的**工具**。
//!
//! 两类：
//! - **native**：直接调 KDock 自己那套 Rust 能力（链路、设备文件、OTA、烧录、示波器、工作区、技能）。
//!   agent 用**自己的一条连接**（不抢传输页那条主连接），所以你手动敲命令时它也能自己连一条。
//! - **host**：JS 那边实现的能力（中控编排、切页面、屏幕捕获…），走 `agent://host_call` 事件往返。

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::transport::Conn;
use crate::upgrade;

use super::store;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub host: bool,
}

/// agent 自己那条链路的当前状态
#[derive(Default)]
pub struct Link {
    pub conn: Option<Conn>,
    pub mode: String,
    pub label: String,
}

/// 工具清单（同时也是给模型看的 schema）
pub fn catalog() -> Vec<ToolDef> {
    let mut t: Vec<ToolDef> = Vec::new();
    let mut push = |name: &'static str, description: &'static str, schema: Value, host: bool| {
        t.push(ToolDef { name, description, schema, host });
    };

    push("link_open", "打开一条 agent 自己的链路（串口/网口）。会先关掉上一条。",
        json!({"type":"object","properties":{
            "mode":{"type":"string","enum":["serial","tcp","udp"],"description":"链路类型"},
            "port":{"type":"string","description":"串口名，如 COM7"},
            "baud":{"type":"integer","description":"波特率，默认 115200"},
            "host":{"type":"string","description":"TCP/UDP 目标 IP"},
            "remote_port":{"type":"integer","description":"TCP/UDP 目标端口"},
            "local_port":{"type":"integer","description":"UDP 本地端口"}
        },"required":["mode"]}), false);
    push("link_close", "关掉 agent 的链路。", json!({"type":"object","properties":{}}), false);
    push("link_status", "看 agent 链路现在通不通。", json!({"type":"object","properties":{}}), false);
    push("link_send", "往链路发数据（文本或 HEX）。",
        json!({"type":"object","properties":{
            "data":{"type":"string","description":"要发的内容"},
            "hex":{"type":"boolean","description":"true 表示 data 是十六进制，如 '41 54'"},
            "line_ending":{"type":"string","enum":["none","cr","lf","crlf"],"description":"行尾，默认 cr"}
        },"required":["data"]}), false);
    push("link_read", "读链路返回（等到静默超时或命中 until）。",
        json!({"type":"object","properties":{
            "timeout_ms":{"type":"integer","description":"最多等多久，默认 3000"},
            "idle_ms":{"type":"integer","description":"静默多久算读完，默认 400"},
            "until":{"type":"string","description":"命中这个子串就立刻返回"},
            "max_bytes":{"type":"integer","description":"最多读多少字节，默认 65536"}
        }}), false);
    push("device_list", "列设备上的目录（串口走 cshell ls，网口走 6666 服务通道）。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"设备上的路径，默认 /"}}}), false);
    push("device_pull", "把设备上的文件取回本机（带 CRC32 校验）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"设备上的文件路径"},
            "save_to":{"type":"string","description":"本机保存路径；不填就存到工作区里"}
        },"required":["path"]}), false);
    push("device_push", "把本机文件发到设备。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机文件路径"},
            "remote":{"type":"string","description":"设备上的目标路径，默认同名放根目录"}
        },"required":["local"]}), false);
    push("firmware_info", "读一个 .fw 升级包的版本/大小/CRC32。",
        json!({"type":"object","properties":{"local":{"type":"string"}},"required":["local"]}), false);
    push("firmware_upgrade", "把 .fw 包升级进设备（串口或网口）。**会复位设备**，做完最好再确认一次版本。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机 .fw 路径"},
            "transport":{"type":"string","enum":["auto","serial","net"],"description":"默认跟着当前链路走"},
            "host":{"type":"string","description":"走网口时的设备 IP"},
            "remote_port":{"type":"integer","description":"网口服务端口，默认 6666"}
        },"required":["local"]}), false);
    push("local_run", "在本机跑一条命令（cmd /C），返回退出码和输出。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string"},
            "timeout_ms":{"type":"integer","description":"默认 15000"}
        },"required":["cmd"]}), false);
    push("flash", "用烧录器写片（J-Link / openocd / STM32CubeProgrammer）。",
        json!({"type":"object","properties":{
            "tool":{"type":"string","enum":["jlink","openocd","stm32"]},
            "file":{"type":"string","description":"要烧的 .hex/.bin/.elf"},
            "exe":{"type":"string","description":"工具可执行文件路径，不填就按 PATH 找"},
            "device":{"type":"string","description":"芯片型号，如 STM32F407VG"},
            "addr":{"type":"string","description":"bin 的烧写地址，如 0x08000000"}
        },"required":["tool","file"]}), false);
    push("scope", "给示波器发一条 SCPI 命令（Rigol），返回设备回包。",
        json!({"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}), false);
    push("workspace_list", "列 agent 工作区里的文件。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"相对路径，默认 ."}}}), false);
    push("workspace_read", "读工作区里的文本文件。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "max_bytes":{"type":"integer","description":"默认 65536"}
        },"required":["path"]}), false);
    push("workspace_write", "写工作区里的文件（会自动建目录）。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "content":{"type":"string"},
            "append":{"type":"boolean","description":"true 表示追加"}
        },"required":["path","content"]}), false);
    push("workspace_mkdir", "在工作区里建目录。",
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}), false);
    push("skill_list", "列出已安装的技能（名字 + 描述）。", json!({"type":"object","properties":{}}), false);
    push("skill_read", "读一个技能的完整 SKILL.md。",
        json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}), false);
    push("skill_create", "新建一个技能（一份带 frontmatter 的 SKILL.md）。",
        json!({"type":"object","properties":{
            "name":{"type":"string","description":"技能名，会做 slug 化"},
            "description":{"type":"string","description":"一句话说明什么时候用它"},
            "body":{"type":"string","description":"正文（Markdown）"}
        },"required":["name","description"]}), false);
    push("skill_update", "整体覆盖一个技能的 SKILL.md。",
        json!({"type":"object","properties":{"name":{"type":"string"},"content":{"type":"string"}},"required":["name","content"]}), false);
    push("skill_delete", "删掉一个技能。",
        json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}), false);

    // ── host：JS 那边实现 ───────────────────────────────────────────
    push("browser_open", "用内置浏览器打开一个网页（抓下来抽正文，页面同时会显示在右侧「浏览器」里）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"网址，可以不带 https://"}
        },"required":["url"]}), false);
    push("browser_read", "读「当前页」的正文（browser_open 之后用；不传 url 就是当前页）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"可选，先抓这个再读"},
            "max_chars":{"type":"integer","description":"最多返回多少字，默认 12000"}
        }}), false);
    push("browser_find", "在「当前页」正文里找一段文字，返回前后文。",
        json!({"type":"object","properties":{
            "text":{"type":"string"},
            "max_hits":{"type":"integer","description":"默认 5"}
        },"required":["text"]}), false);
    push("history_search", "在**本会话的原始记录**里按关键词回查（包括已经被摘要压缩掉的那段）。上下文被压缩后，想找回细节就用它。",
        json!({"type":"object","properties":{
            "text":{"type":"string","description":"要找的关键词"},
            "max_hits":{"type":"integer","description":"最多返回几条，默认 8"}
        },"required":["text"]}), false);
    push("ui_show_text", "把一段文本显示到右侧「文本」页（给用户看 / 自己回头看）。",
        json!({"type":"object","properties":{
            "title":{"type":"string"},
            "text":{"type":"string"}
        },"required":["text"]}), true);
    push("ui_goto", "把界面切到某个页（transfer/upgrade/flash/files/chart/flow/capture/scope）。",
        json!({"type":"object","properties":{"page":{"type":"string"}},"required":["page"]}), true);
    push("flow_run", "跑中控编排（不传 graph 就跑当前画布上的）。",
        json!({"type":"object","properties":{
            "graph":{"type":"object","description":"可选，直接给编排 JSON"},
            "wait":{"type":"boolean","description":"等它跑完再返回，默认 true"}
        }}), true);
    push("flow_status", "看中控编排跑到哪了／日志尾巴。", json!({"type":"object","properties":{}}), true);
    push("flow_stop", "停掉正在跑的中控编排。", json!({"type":"object","properties":{}}), true);
    push("capture_save", "抓一张屏幕（存到工作区）。",
        json!({"type":"object","properties":{
            "monitor":{"type":"integer","description":"显示器序号，默认 0"},
            "save_as":{"type":"string","description":"相对工作区的文件名，默认 shot.png"}
        }}), true);

    t
}

/// 给模型的 tools 数组（OpenAI function 格式）
pub fn schema_json(defs: &[ToolDef], allow_host: bool) -> Vec<Value> {
    defs.iter()
        .filter(|d| !d.host || allow_host)
        .map(|d| {
            json!({"type":"function","function":{
                "name": d.name, "description": d.description, "parameters": d.schema}})
        })
        .collect()
}

pub fn is_known(name: &str) -> bool { catalog().iter().any(|d| d.name == name) }
pub fn is_host(name: &str) -> bool { catalog().iter().any(|d| d.name == name && d.host) }

/// 工具执行的环境
pub struct ToolCtx<'a> {
    pub app: &'a tauri::AppHandle,
    pub state: &'a super::AgentState,
    pub workspace: std::path::PathBuf,
    /// 当前会话 id（history_search 要用来翻原始记录）
    pub session: &'a str,
    /// 权限：read / ask / auto
    pub perm: &'a str,
    /// perm=ask 时问用户（返回 true 才执行）
    pub approve: &'a dyn Fn(&str, &Value) -> Result<bool, String>,
    /// host 工具：发事件给前端并等结果
    pub host: &'a dyn Fn(&str, &Value, u64) -> Result<String, String>,
    /// 进度日志
    pub log: &'a dyn Fn(&str),
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}
fn arg_u64(args: &Value, key: &str, default: u64) -> u64 {
    args.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}
fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn line_ending(kind: &str) -> &'static [u8] {
    match kind {
        "none" => b"",
        "lf" => b"\n",
        "crlf" => b"\r\n",
        _ => b"\r",
    }
}

fn set_timeout(conn: &mut Conn, ms: u64) {
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(ms));
    }
}

/// 二进制就用 HEX 呈现，免得模型把乱码当成内容
fn text_and_hex(data: &[u8]) -> String {
    let printable = data.iter().filter(|b| **b == b'\n' || **b == b'\r' || (32..127).contains(*b)).count();
    if printable * 100 / data.len().max(1) >= 90 {
        String::from_utf8_lossy(data).to_string()
    } else {
        format!("(二进制 {} 字节)\nHEX: {}", data.len(), kdock_core::hex::bytes_to_hex(data))
    }
}

/// 借用 agent 的链路跑一段（用完还回去）
fn with_conn<T>(ctx: &ToolCtx, f: impl FnOnce(&mut Conn) -> Result<T, String>) -> Result<T, String> {
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    let mut conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    set_timeout(&mut conn, 6000);
    let r = f(&mut conn);
    g.conn = Some(conn);
    r
}

/// 网口那几个操作要 `Svc` 按值拿走 Conn，所以单独一个壳：拿出来 -> 包 Svc -> 用完再还
fn with_svc<T>(ctx: &ToolCtx, f: impl FnOnce(&mut upgrade::Svc) -> Result<T, String>) -> Result<T, String> {
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    let conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    let mut svc = upgrade::Svc::from_conn(conn);
    let r = f(&mut svc);
    let back = svc.into_conn();
    g.conn = Some(back);
    r
}

/// 当前是不是串口链路
fn is_serial(ctx: &ToolCtx) -> bool {
    ctx.state.link.lock().map(|g| g.mode == "serial").unwrap_or(false)
}

/// 会改设备/改盘上东西的工具：权限管的就是这些
pub fn is_dangerous(name: &str) -> bool {
    matches!(
        name,
        "link_send" | "device_push" | "firmware_upgrade" | "flash" | "local_run"
            | "workspace_write" | "workspace_mkdir" | "skill_create" | "skill_update"
            | "skill_delete" | "flow_run" | "capture_save"
    )
}

pub fn execute(ctx: &ToolCtx, name: &str, args: &Value) -> Result<String, String> {
    // 权限闸门：只读直接拒；需要批准就先问人
    if is_dangerous(name) || name.starts_with("mcp__") {
        match ctx.perm {
            "read" => {
                return Err(format!(
                    "当前权限是「只读」，{name} 不执行。要用的话，在输入框下面那行把权限切成「需要批准」或「自动」。"
                ))
            }
            "ask" => {
                if !(ctx.approve)(name, args)? {
                    return Err(format!("用户拒绝了 {name}（可以问问他为什么，或者换个做法）"));
                }
            }
            _ => {}
        }
    }
    if is_host(name) {
        return (ctx.host)(name, args, 120_000);
    }
    match name {
        "link_open" => link_open(ctx, args),
        "link_close" => {
            let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
            let had = g.conn.take();
            g.mode.clear();
            g.label.clear();
            if let Some(mut c) = had {
                c.shutdown();
            }
            Ok("链路已关闭".into())
        }
        "link_status" => {
            let g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
            Ok(if g.conn.is_some() { format!("已连接（{}）", g.label) } else { "未连接（先 link_open）".into() })
        }
        "link_send" => link_send(ctx, args),
        "link_read" => link_read(ctx, args),
        "device_list" => device_list(ctx, args),
        "device_pull" => device_pull(ctx, args),
        "device_push" => device_push(ctx, args),
        "firmware_info" => firmware_info(args),
        "firmware_upgrade" => firmware_upgrade(ctx, args),
        "local_run" => local_run(args),
        "flash" => flash(ctx, args),
        "scope" => crate::scope_cmd_impl(&arg_str(args, "cmd").ok_or("缺少 cmd")?),
        "history_search" => history_search(ctx, args),
        "browser_open" => browser_open(ctx, args),
        "browser_read" => browser_read(ctx, args),
        "browser_find" => browser_find(ctx, args),
        "workspace_list" => workspace_list(ctx, args),
        "workspace_read" => workspace_read(ctx, args),
        "workspace_write" => workspace_write(ctx, args),
        "workspace_mkdir" => workspace_mkdir(ctx, args),
        "skill_list" => {
            let list = store::skills_list(ctx.app);
            if list.is_empty() {
                return Ok("（还没有技能）".into());
            }
            Ok(list.iter().map(|s| format!("{} — {}", s.slug, s.description)).collect::<Vec<_>>().join("\n"))
        }
        "skill_read" => store::skill_read(ctx.app, &arg_str(args, "name").ok_or("缺少 name")?),
        "skill_create" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let desc = arg_str(args, "description").ok_or("缺少 description")?;
            let body = arg_str(args, "body").unwrap_or_default();
            let slug = store::slugify(&name);
            let content = format!("---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n");
            let path = store::skill_write(ctx.app, &slug, &content)?;
            Ok(format!("技能已建：{slug}（{path}）"))
        }
        "skill_update" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let content = arg_str(args, "content").ok_or("缺少 content")?;
            let path = store::skill_write(ctx.app, &name, &content)?;
            Ok(format!("技能已更新：{path}"))
        }
        "skill_delete" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            store::skill_delete(ctx.app, &name)?;
            Ok(format!("技能已删除：{name}"))
        }
        other if other.starts_with("mcp__") => super::mcp::call_by_full_name(ctx.app, other, args),
        other if !is_known(other) => Err(format!("不认识工具 {other}")),
        other => Err(format!("工具 {other} 还没实现")),
    }
}

fn link_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let mode = arg_str(args, "mode").ok_or("缺少 mode")?;
    let endpoint = match mode.as_str() {
        "serial" => {
            let port = arg_str(args, "port").ok_or("串口链路要给 port，例如 COM7")?;
            let baud = arg_u64(args, "baud", 115200) as u32;
            let config: kdock_core::config::SerialConfig =
                serde_json::from_value(json!({
                    "baud": baud, "data_bits": "eight", "stop_bits": "one",
                    "parity": "none", "flow_control": "none"
                })).map_err(|e| format!("串口参数不对: {e}"))?;
            crate::transport::Endpoint::Serial { port, config }
        }
        "tcp" => crate::transport::Endpoint::TcpClient {
            host: arg_str(args, "host").ok_or("TCP 链路要给 host")?,
            port: arg_u64(args, "remote_port", 6666) as u16,
        },
        "udp" => crate::transport::Endpoint::Udp {
            local_port: arg_u64(args, "local_port", 0) as u16,
            remote_host: arg_str(args, "host").unwrap_or_default(),
            remote_port: arg_u64(args, "remote_port", 0) as u16,
        },
        other => return Err(format!("不支持的链路类型 {other}")),
    };
    let label = endpoint.label();
    let mut conn = crate::transport::open_endpoint(&endpoint)?;
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    if let Some(mut old) = g.conn.take() {
        old.shutdown();
    }
    set_timeout(&mut conn, 200);
    g.conn = Some(conn);
    g.mode = mode.clone();
    g.label = label.clone();
    (ctx.log)(&format!("[agent] 链路已打开：{label}\n"));
    Ok(format!("已打开 {label}"))
}

fn link_send(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let data = arg_str(args, "data").ok_or("缺少 data")?;
    let hex = arg_bool(args, "hex", false);
    let le = arg_str(args, "line_ending").unwrap_or_else(|| "cr".into());
    let mut payload: Vec<u8> = if hex {
        kdock_core::hex::hex_to_bytes(&data).map_err(|e| format!("HEX 解析失败: {e:?}"))?
    } else {
        data.as_bytes().to_vec()
    };
    payload.extend_from_slice(line_ending(&le));
    // 写满 + flush 放在**同一次** with_conn 里：中间松手等于把链路还回去，
    // 中控/前端可能正好插进来抢这条连接；而且 write 允许短写，必须写满。
    with_conn(ctx, |conn| {
        conn.write_all(&payload).map_err(|e| format!("写失败: {e}"))?;
        conn.flush().map_err(|e| format!("flush 失败: {e}"))
    })?;
    Ok(format!("已发送 {} 字节（{}）", payload.len(), if hex { "HEX" } else { "文本" }))
}

fn link_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let timeout = Duration::from_millis(arg_u64(args, "timeout_ms", 3000));
    let idle = Duration::from_millis(arg_u64(args, "idle_ms", 400));
    let until = arg_str(args, "until");
    let max_bytes = arg_u64(args, "max_bytes", 65_536) as usize;
    with_conn(ctx, |conn| {
        set_timeout(conn, 50);
        let mut out: Vec<u8> = Vec::new();
        let mut buf = [0u8; 1024];
        let start = Instant::now();
        let mut last = Instant::now();
        loop {
            if start.elapsed() > timeout || out.len() >= max_bytes {
                break;
            }
            // 用户点了停止：别在这儿干等到超时
            if crate::agent::stop_requested() {
                return Err("用户停止了这次等待（link_read）".into());
            }
            match conn.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    last = Instant::now();
                    if let Some(k) = &until {
                        if String::from_utf8_lossy(&out).contains(k.as_str()) {
                            break;
                        }
                    }
                }
                Err(e) => {
                    if crate::transport::is_idle_read_error(&e) {
                        if !out.is_empty() && last.elapsed() > idle {
                            break;
                        }
                    } else {
                        return Err(format!("读失败: {e}"));
                    }
                }
            }
        }
        if out.is_empty() {
            Ok(format!("（{}ms 内没有收到数据）", start.elapsed().as_millis()))
        } else {
            Ok(text_and_hex(&out))
        }
    })
}

fn device_list(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path").unwrap_or_else(|| "/".into());
    let entries = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_list(conn, &path))?
    } else {
        with_svc(ctx, |svc| svc.list_dir(&path))?
    };
    if entries.is_empty() {
        return Ok(format!("{path}：空目录"));
    }
    let mut lines = vec![format!("{path} 下的 {} 项：", entries.len())];
    for e in entries.iter().take(300) {
        lines.push(if e.is_dir {
            format!("D {}", e.name)
        } else {
            format!("F {:>10}  {}", e.size, e.name)
        });
    }
    Ok(lines.join("\n"))
}

fn device_pull(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path").ok_or("缺少 path")?;
    let save_to = match arg_str(args, "save_to") {
        Some(p) => p,
        None => {
            let name = path.rsplit('/').next().unwrap_or("pull.bin").to_string();
            store::resolve_in_workspace(&ctx.workspace, &name)?.to_string_lossy().to_string()
        }
    };
    if let Some(parent) = std::path::Path::new(&save_to).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = ctx.log;
    let r = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_pull(conn, &path, &save_to, |s| log(s)))?
    } else {
        with_svc(ctx, |svc| upgrade::svc_pull(svc, &path, &save_to, |s| log(s)))?
    };
    Ok(format!("已取回 {} 字节 -> {}\ncrc32={:08X}", r.bytes, save_to, r.crc32))
}

fn device_push(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let remote = arg_str(args, "remote").unwrap_or_else(|| {
        format!("/{}", std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "up.bin".into()))
    });
    let log = ctx.log;
    let crc = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_upload(conn, &remote, &data, |s| log(s)))?
    } else {
        with_svc(ctx, |svc| upgrade::svc_upload(svc, &remote, &data, |s| log(s)))?
    };
    Ok(format!("已发送 {} 字节 -> {}\ncrc32={:08X}", data.len(), remote, crc))
}

fn firmware_info(args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!(
        "版本 v{}\npayload {} B  crc32={:08X}\n整包 {} B  crc32={:08X}\nboard={} name={}",
        info.version, info.payload_size, info.payload_crc32, info.file_size, info.file_crc32, info.board, info.name))
}

fn firmware_upgrade(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let transport = arg_str(args, "transport").unwrap_or_else(|| "auto".into());
    let use_net = match transport.as_str() {
        "net" => true,
        "serial" => false,
        _ => !is_serial(ctx),
    };
    let log = ctx.log;
    let mut lines: Vec<String> = Vec::new();
    {
        let mut log_fn = |s: &str| { log(s); };
        let mut prog_fn = |_p: f64| {};
        let mut cx = upgrade::Ctx { log: &mut log_fn, progress: &mut prog_fn };
        if use_net {
            let host = arg_str(args, "host")
                .or_else(|| ctx.state.link.lock().ok().and_then(|g| {
                    let l = g.label.clone();
                    l.strip_prefix("TCP ").and_then(|r| r.split(':').next().map(|s| s.to_string()))
                }))
                .ok_or("网口升级要知道设备 IP：给 host，或者先 link_open 一条 TCP 链路")?;
            let port = arg_u64(args, "remote_port", 6666) as u16;
            upgrade::net_upgrade(&mut cx, &host, port, &name, &data)?;
            lines.push(format!("网口升级完成：{host}:{port}"));
        } else {
            with_conn(ctx, |conn| upgrade::serial_upgrade(&mut cx, conn, &name, &data))?;
            lines.push("串口升级完成".to_string());
        }
    }
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!("{}\npayload {} B  crc32={:08X}\n设备已复位；等它起来后建议 device_list / firmware 版本确认一次。",
        lines.join("\n"), info.payload_size, info.payload_crc32))
}

fn local_run(args: &Value) -> Result<String, String> {
    let cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let timeout = Duration::from_millis(arg_u64(args, "timeout_ms", 15_000));
    let mut child = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &cmd]);
        c
    }
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(|e| format!("起进程失败: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let mut text = String::new();
                text.push_str(&format!("exit={}\n", status.code().unwrap_or(-1)));
                let so = String::from_utf8_lossy(&out.stdout);
                let se = String::from_utf8_lossy(&out.stderr);
                if !so.trim().is_empty() { text.push_str(&format!("--- stdout ---\n{}\n", so.trim_end())); }
                if !se.trim().is_empty() { text.push_str(&format!("--- stderr ---\n{}\n", se.trim_end())); }
                let cut: String = text.chars().take(8000).collect();
                return Ok(cut);
            }
            None => {
                if crate::agent::stop_requested() {
                    let _ = child.kill();
                    return Err("用户停止了这条本机命令（进程已杀掉）".into());
                }
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("命令超过 {}ms 没结束，已杀掉", timeout.as_millis()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn which(exe: &str) -> Option<String> {
    let out = if cfg!(windows) {
        std::process::Command::new("where").arg(exe).output().ok()?
    } else {
        std::process::Command::new("sh").args(["-c", &format!("command -v {exe}")]).output().ok()?
    };
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn flash(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let tool = arg_str(args, "tool").ok_or("缺少 tool")?;
    let file = arg_str(args, "file").ok_or("缺少 file")?;
    if !std::path::Path::new(&file).exists() {
        return Err(format!("找不到固件文件 {file}"));
    }
    let exe = match arg_str(args, "exe") {
        Some(p) => p,
        None => match tool.as_str() {
            "jlink" => which("JLink.exe").or_else(|| which("JLink")).ok_or("PATH 里没有 JLink.exe，请用 exe 指定全路径")?,
            "openocd" => which("openocd.exe").or_else(|| which("openocd")).ok_or("PATH 里没有 openocd.exe，请用 exe 指定全路径")?,
            "stm32" => which("STM32_Programmer_CLI.exe").or_else(|| which("STM32_Programmer_CLI"))
                .ok_or("PATH 里没有 STM32_Programmer_CLI.exe，请用 exe 指定全路径")?,
            other => return Err(format!("不支持的烧录工具 {other}")),
        },
    };
    let addr = arg_str(args, "addr").unwrap_or_else(|| "0x08000000".into());
    let device = arg_str(args, "device").unwrap_or_else(|| "STM32F407VG".into());
    let argv: Vec<String>;
    match tool.as_str() {
        "jlink" => {
            // 用命令行脚本方式：先写一份临时 script，再让 JLink.exe 跑它
            let script = format!(
                "device {device}\nsi SWD\nspeed 4000\nconnect\nh\nloadfile \"{file}\"\nr\ng\nexit\n");
            let tmp = std::env::temp_dir().join("kdock_agent_flash.jlink");
            std::fs::write(&tmp, script).map_err(|e| format!("写 J-Link 脚本失败: {e}"))?;
            argv = vec!["-ExitOnError".into(), "1".into(), "-CommanderScript".into(), tmp.to_string_lossy().to_string()];
        }
        "openocd" => {
            let cfg = arg_str(args, "config").unwrap_or_else(|| "interface/cmsis-dap.cfg".into());
            let target = arg_str(args, "target").unwrap_or_else(|| "target/stm32f4x.cfg".into());
            argv = vec![
                "-f".into(), cfg, "-f".into(), target,
                "-c".into(), "init".into(), "-c".into(), "halt".into(),
                "-c".into(), format!("program \"{file}\" verify reset exit"),
            ];
        }
        _ => {
            argv = vec![
                "-c".into(), "port=SWD".into(), "-w".into(), file.clone(), addr.clone(),
                "-v".into(), "-rst".into(),
            ];
        }
    }
    let (log, app) = (ctx.log, ctx.app);
    (log)(&format!("[agent] 烧录: {} {}\n", exe, argv.join(" ")));
    let _ = app.emit("flash://log", format!("\n[agent] $ {} {}\n", exe, argv.join(" ")));
    let mut child = std::process::Command::new(&exe)
        .args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("起 {exe} 失败: {e}"))?;
    let start = Instant::now();
    let timeout = Duration::from_millis(180_000);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let text = format!(
                    "exit={}\n{}\n{}",
                    status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr));
                let _ = app.emit("flash://log", text.clone());
                let tail: Vec<&str> = text.lines().rev().take(40).collect();
                let mut tail: Vec<&str> = tail.into_iter().collect();
                tail.reverse();
                let ok = status.success();
                return Ok(format!("烧录退出码 {}（{}）\n--- 末尾输出 ---\n{}",
                    status.code().unwrap_or(-1), if ok { "成功" } else { "失败" }, tail.join("\n")));
            }
            None => {
                if crate::agent::stop_requested() {
                    let _ = child.kill();
                    return Err("用户停止了这次烧录（烧录器进程已杀掉）".into());
                }
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err("烧录超过 180s，已中断".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// codex/magic-context 那套"原始记录永不丢，细节按需回查"的出口
fn history_search(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let needle = arg_str(args, "text").ok_or("缺少 text")?;
    let max_hits = arg_u64(args, "max_hits", 8) as usize;
    let raw = crate::agent::store::session_raw(ctx.app, ctx.session);
    if raw.is_empty() {
        return Ok("会话记录是空的".into());
    }
    let mut hits: Vec<String> = Vec::new();
    for line in raw.lines() {
        if hits.len() >= max_hits {
            break;
        }
        if !line.contains(&needle) {
            continue;
        }
        let ev: Value = serde_json::from_str(line).unwrap_or(Value::Null);
        let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("?");
        let text = match kind {
            "user" | "assistant" | "note" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "tool_call" => format!("{} {}", ev.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                   ev.get("args").cloned().unwrap_or(Value::Null)),
            "tool_result" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "summary" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            _ => String::new(),
        };
        let at = text.find(&needle).unwrap_or(0);
        let start = at.saturating_sub(80);
        let end = (at + needle.len() + 160).min(text.len());
        let mut s0 = start;
        while s0 < text.len() && !text.is_char_boundary(s0) {
            s0 += 1;
        }
        let mut e0 = end;
        while e0 > 0 && !text.is_char_boundary(e0) {
            e0 -= 1;
        }
        hits.push(format!("[{kind}] …{}…", &text[s0..e0]));
    }
    if hits.is_empty() {
        return Ok(format!("会话记录里没找到「{needle}」"));
    }
    Ok(format!("在会话记录里找到 {} 处（含已压缩部分）：\n{}", hits.len(), hits.join("\n")))
}

fn set_page(ctx: &ToolCtx, page: super::browser::Page) {
    if let Ok(mut g) = ctx.state.page.lock() {
        if let Some(old) = g.replace(page.clone()) {
            if let Ok(mut h) = ctx.state.history.lock() {
                h.push(old);
                if h.len() > 30 {
                    h.remove(0);
                }
            }
        }
    }
    let _ = ctx.app.emit("agent://browser", &page);
}

fn browser_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let url = arg_str(args, "url").ok_or("缺少 url")?;
    let page = super::browser::fetch(&url)?;
    let chars = page.text.chars().count();
    let links = page.links.len();
    let out = format!(
        "已打开 {}\n标题：{}\n正文 {} 字 / {} 个链接\n--- 正文开头 ---\n{}",
        page.url,
        page.title,
        chars,
        links,
        page.text.chars().take(3000).collect::<String>()
    );
    set_page(ctx, page);
    Ok(out)
}

fn browser_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    if let Some(url) = arg_str(args, "url") {
        let page = super::browser::fetch(&url)?;
        set_page(ctx, page);
    }
    let max = arg_u64(args, "max_chars", 12_000) as usize;
    let g = ctx.state.page.lock().map_err(|_| "page mutex".to_string())?;
    let page = g.as_ref().ok_or("还没有打开任何网页，先 browser_open")?;
    let body: String = page.text.chars().take(max).collect();
    let more = if page.text.chars().count() > max { "\n…(截断)" } else { "" };
    Ok(format!("{}\n标题：{}\n--- 正文 ---\n{}{}", page.url, page.title, body, more))
}

fn browser_find(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let needle = arg_str(args, "text").ok_or("缺少 text")?;
    let max_hits = arg_u64(args, "max_hits", 5) as usize;
    let g = ctx.state.page.lock().map_err(|_| "page mutex".to_string())?;
    let page = g.as_ref().ok_or("还没有打开任何网页，先 browser_open")?;
    let text = &page.text;
    let mut out = Vec::new();
    let mut pos = 0usize;
    while out.len() < max_hits {
        let Some(rel) = text[pos..].find(&needle) else { break };
        let at = pos + rel;
        let start = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let end = text[at..].find('\n').map(|i| at + i).unwrap_or(text.len());
        out.push(format!("…{}…", text[start..end].trim()));
        pos = end.max(at + 1);
    }
    if out.is_empty() {
        return Ok(format!("当前页 {} 里没有找到「{needle}」", page.url));
    }
    Ok(format!("在 {} 里找到 {} 处：\n{}", page.url, out.len(), out.join("\n")))
}

fn workspace_list(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").unwrap_or_else(|| ".".into());
    let dir = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    std::fs::create_dir_all(&dir).ok();
    let mut lines = vec![format!("工作区 {}/ 下：", rel)];
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("读目录失败: {e}"))?.flatten() {
        let md = entry.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let name = entry.file_name().to_string_lossy().to_string();
        lines.push(if is_dir { format!("D {name}/") } else { format!("F {size:>10}  {name}") });
    }
    Ok(lines.join("\n"))
}

fn workspace_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let max = arg_u64(args, "max_bytes", 65_536) as usize;
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    let data = std::fs::read(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
    let cut = &data[..data.len().min(max)];
    Ok(text_and_hex(cut))
}

fn workspace_write(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let content = arg_str(args, "content").unwrap_or_default();
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let size = content.len();
    if arg_bool(args, "append", false) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)
            .map_err(|e| format!("打开失败: {e}"))?;
        f.write_all(content.as_bytes()).map_err(|e| format!("写失败: {e}"))?;
    } else {
        std::fs::write(&path, content).map_err(|e| format!("写失败: {e}"))?;
    }
    Ok(format!("已写 {} 字节 -> {}", size, path.display()))
}

fn workspace_mkdir(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("建目录失败: {e}"))?;
    Ok(format!("已建目录 {}", path.display()))
}
