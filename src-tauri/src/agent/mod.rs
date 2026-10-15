//! Agent：一个能自己动手的调试助手（二级菜单"Agent"）。
//!
//! 结构上跟 juanx 学的是这几点：**供应商 profile 与密钥分开存**、**工具目录是能力的唯一来源**、
//! **上下文按预算组装**；不学的是它的重量（不引异步运行时、不建数据库）。
//!
//! 一条回合（turn）的流程：
//! ```text
//! agent_send -> [压缩?] -> 组装 messages -> POST /chat/completions(流式)
//!            -> 有 tool_calls 就执行 -> 结果回填 -> 再来一轮（最多 MAX_ROUNDS 轮）
//!            -> 没有工具调用就收尾；全过程每一步都追加写进会话 JSONL
//! ```

pub mod anthropic;
pub mod browser;
pub mod llm;
pub mod mcp;
pub mod store;
pub mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use store::{Event, Provider};
use tools::{Link, ToolCtx};

const MAX_ROUNDS: usize = 16;

/// 当前这一轮是否被要求停止。工具层里的长循环（读串口、传文件、烧录、升级…）不在 turn 的
/// 调用栈上，拿不到那一轮的 `Arc<AtomicBool>`，所以这里挂一个进程级标志给它们查。
pub static STOPPED: AtomicBool = AtomicBool::new(false);

#[inline]
pub fn stop_requested() -> bool {
    STOPPED.load(Ordering::Relaxed)
}

/// 老版本内置过一个免费模型（AMD Radeon Cloud 的 GLM-5.3-Flash，公开 key）。
/// 该服务已经下线/极不稳定，所以**不再自动创建**；只在云端还能用时，用户从
/// 「厂家预设」里手动选（预设里那条备注写了"可能不可用"）。
/// 这里只负责把老版本自动塞进去的、已经打不通的那条清掉，免得用户以为配好了。
pub fn prune_dead_builtin(app: &AppHandle) {
    const OLD_ID: &str = "glm-5.3-flash";
    let mut cfg = store::load_providers(app);
    let Some(pos) = cfg.providers.iter().position(|p| p.id == OLD_ID) else { return };
    // 只在"它还是默认项、而且用户从没成功用过"时才自动删：判断依据是会话里没有它的记录
    let used = store::sessions_list(app).iter().any(|m| m.provider_id == OLD_ID);
    if used {
        return;
    }
    cfg.providers.remove(pos);
    if cfg.active_id.as_deref() == Some(OLD_ID) {
        cfg.active_id = cfg.providers.first().map(|p| p.id.clone());
    }
    let _ = store::save_providers(app, &cfg);
    let _ = store::secret_set(app, OLD_ID, "");
}
/// 工作区里的项目级说明文件（跟 Codex 的 AGENTS.md 一个意思）
const WORKSPACE_INSTRUCTIONS: &str = "AGENTS.md";

#[derive(Default)]
pub struct AgentState {
    pub link: Mutex<Link>,
    pub run: Mutex<Option<Arc<AtomicBool>>>,
    /// 运行中用户"补充"的话：等这一轮的下一个边界再并进对话（codex 那种边跑边改方向）
    pub pending: Mutex<Vec<String>>,
    pub host_waiters: Mutex<HashMap<u64, Sender<Result<String, String>>>>,
    pub host_seq: std::sync::atomic::AtomicU64,
    /// perm=ask 时要等用户点"允许/拒绝"
    pub approve_waiters: Mutex<HashMap<u64, Sender<bool>>>,
    pub approve_seq: std::sync::atomic::AtomicU64,
    /// 内置浏览器"当前页"（agent 和右侧浏览器面板共用）
    pub page: Mutex<Option<browser::Page>>,
    pub history: Mutex<Vec<browser::Page>>,
}

impl AgentState {
    pub fn running(&self) -> bool {
        self.run.lock().map(|g| g.is_some()).unwrap_or(false)
    }
}

// ── 小工具 ──────────────────────────────────────────────────────────

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn workspace_of(app: &AppHandle, session_id: &str) -> std::path::PathBuf {
    let meta = store::session_meta_of(app, session_id);
    match meta {
        Some(m) if !m.workspace.trim().is_empty() => {
            let p = std::path::PathBuf::from(&m.workspace);
            let _ = std::fs::create_dir_all(&p);
            p
        }
        _ => store::default_workspace(app),
    }
}

fn resolve_provider(app: &AppHandle, want: Option<&str>) -> Result<(Provider, String), String> {
    prune_dead_builtin(app);
    let cfg = store::load_providers(app);
    if cfg.providers.is_empty() {
        return Err("还没有可用的模型：打开「设置」（左下角齿轮，或 Ctrl+,）→ 模型与供应商 → \
                    上面选一个厂家预设点「填入表单」，再粘上你的 API Key 保存即可。".into());
    }
    let provider = store::find_provider(&cfg, want).ok_or("找不到这个供应商 profile")?;
    let key = store::secret_get(app, &provider.api_key_ref).unwrap_or_default();
    if key.trim().is_empty() && !provider.api_key_ref.trim().is_empty() {
        return Err(format!(
            "供应商「{}」还没填 API Key（或解不开）：设置 → 模型与供应商 → 在 API Key 那一栏粘贴后保存。",
            provider.name
        ));
    }
    Ok((provider, key))
}

// ── 配置 / 供应商 ───────────────────────────────────────────────────

// ── AMD Radeon Cloud 免费模型：内置一批 profile ─────────────────────
// 为什么要做成"一批 profile"：这里的模型选择就是切 profile（endpoint + model + 自己的 key），
// 每个模型一条，用户在会话下面那个下拉里就能直接挑。**可以删**（删了不会自己长回来：
// 靠 providers.json 里的 amd_seeded 标记），想加回来点设置里的按钮（agent_amd_reseed）。
const AMD_ENDPOINT: &str = "https://developer.amd.com.cn/radeon/api/v1";
pub const AMD_MODELS: &[&str] = &[
    "DeepSeek-V4-Flash",
    "DeepSeek-V4-Flash-Vision-Exp",
    "DeepSeek-V4.1-Flash",
    "Qwen3.8-Flash-Next",
    "Qwen3.8-27B",
    "GLM-5.3-Flash",
    "MiMo-V2.6-Flash",
    "MiniCPM-V-4.7-35B-A3B",
    "MiniCPM5-2B",
    "Gemma-4-31B-IT",
];

/// AMD 模型名 → 稳定的 profile id（`amd-deepseek-v4-flash` 这种）
pub fn amd_profile_id(model: &str) -> String {
    let mut s = String::from("amd-");
    for c in model.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if c == ' ' || c == '_' || c == '-' || c == '/' {
            s.push('-');
        } else if c == '.' {
            s.push('-');
        }
        // 其它字符直接丢（模型名里基本只有 - _ . 空格）
    }
    while s.ends_with('-') {
        s.pop();
    }
    s
}

fn amd_provider(model: &str) -> Provider {
    Provider {
        id: amd_profile_id(model),
        name: format!("AMD 免费 · {model}"),
        kind: "openai".into(),
        endpoint: AMD_ENDPOINT.into(),
        model: model.to_string(),
        api_key_ref: "amd".into(),
        temperature: 0.2,
        context_window: 128_000,
        reserve_output: 8192,
        max_messages: 40,
        supports_tools: true,
        supports_stream: true,
    }
}

/// 首次运行时把 AMD 这批模型塞进 provider 列表（只做一次；删掉之后不会再回来）
pub fn ensure_amd_builtin(app: &AppHandle) -> bool {
    let mut cfg = store::load_providers(app);
    if cfg.amd_seeded {
        return false;
    }
    let mut added = 0;
    for m in AMD_MODELS {
        let p = amd_provider(m);
        if !cfg.providers.iter().any(|x| x.id == p.id) {
            cfg.providers.push(p);
            added += 1;
        }
    }
    cfg.amd_seeded = true;
    let _ = store::save_providers(app, &cfg);
    added > 0
}

/// 设置里那个"把 AMD 免费模型加回来"的按钮
#[tauri::command]
pub fn agent_amd_reseed(app: AppHandle) -> Result<Value, String> {
    let mut cfg = store::load_providers(&app);
    let mut added = 0;
    for m in AMD_MODELS {
        let p = amd_provider(m);
        if !cfg.providers.iter().any(|x| x.id == p.id) {
            cfg.providers.push(p);
            added += 1;
        }
    }
    cfg.amd_seeded = true;
    store::save_providers(&app, &cfg)?;
    Ok(json!({ "ok": true, "added": added, "total": AMD_MODELS.len() }))
}

// ── 出字速度统计（只统计"模型正在出字"的那段） ──────────────────────
// 存 agent/speed.json：每个 profile 记最近一次 + 累计平均。
// 平均是**加权**的：总 token / 总毫秒，不是"每次速度求平均"（那样短回答会污染结果）。
fn speed_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(store::agent_dir(app)?.join("speed.json"))
}

pub fn load_speed(app: &AppHandle) -> Value {
    std::fs::read_to_string(speed_path(app).unwrap_or_default())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

/// 删 profile 时把它的速度记录也删掉，免得列表里留一堆用不上的条目
pub fn forget_speed(app: &AppHandle, provider_id: &str) {
    let mut all = load_speed(app);
    let removed = all.as_object_mut().map(|m| m.remove(provider_id).is_some()).unwrap_or(false);
    if !removed {
        return;
    }
    if let Ok(p) = speed_path(app) {
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&all).unwrap_or_default());
    }
}

/// 记一次出字速度。tokens 用厂商给的 completion_tokens，没有就按字数估。
pub fn record_speed(app: &AppHandle, provider_id: &str, tokens: u64, gen_ms: u64) {
    if provider_id.trim().is_empty() || tokens == 0 || gen_ms < 80 {
        return; // 太短的一段（几乎瞬间返回）算出来没意义
    }
    let mut all = load_speed(app);
    let entry = all
        .as_object_mut()
        .map(|m| {
            m.entry(provider_id.to_string())
                .or_insert_with(|| json!({"tokens": 0, "ms": 0, "samples": 0}))
                .clone()
        })
        .unwrap_or_else(|| json!({}));
    let tot_tokens = entry.get("tokens").and_then(|v| v.as_u64()).unwrap_or(0) + tokens;
    let tot_ms = entry.get("ms").and_then(|v| v.as_u64()).unwrap_or(0) + gen_ms;
    let samples = entry.get("samples").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
    let last = tokens as f64 * 1000.0 / gen_ms as f64;
    let avg = if tot_ms > 0 { tot_tokens as f64 * 1000.0 / tot_ms as f64 } else { 0.0 };
    let rounded = |x: f64| (x * 10.0).round() / 10.0;
    let val = json!({
        "last": rounded(last), "avg": rounded(avg),
        "tokens": tot_tokens, "ms": tot_ms, "samples": samples, "at": now_ms(),
    });
    if let Some(m) = all.as_object_mut() {
        m.insert(provider_id.to_string(), val.clone());
    }
    if let Ok(p) = speed_path(app) {
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&all).unwrap_or_default());
    }
    emit(app, "agent://speed", json!({ "id": provider_id, "stat": val, "all": all }));
}

#[tauri::command]
pub fn agent_speed_get(app: AppHandle) -> Value {
    load_speed(&app)
}

#[tauri::command]
pub async fn agent_config_get(app: AppHandle) -> Value {
    prune_dead_builtin(&app);
    ensure_amd_builtin(&app);
    let cfg = store::load_providers(&app);
    json!({
        "activeId": cfg.active_id,
        "providers": cfg.providers,
        "secrets": store::secret_names(&app),
        "secretScheme": store::secret_scheme(),
        "workspace": store::default_workspace(&app).to_string_lossy(),
        "dataDir": store::agent_dir(&app).map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
        // 真实状态：前端切页/重连后靠它把"思考中"同步回来
        "running": app.state::<Arc<AgentState>>().running(),
        "link": link_snapshot(&app),
    })
}

/// 链路快照。**用 try_lock**：设备读写/升级/link_read 这些长操作会把 link 独占很久，
/// 而这些命令是同步跑在主线程上的 —— 一旦用 lock() 就会把整个界面冻住
/// （实测：长 link_read 期间前端每 1.5 秒轮询一次，最后被 Windows 判成"无响应"杀掉）。
/// 拿不到锁就返回 busy，界面照常。
fn link_snapshot(app: &AppHandle) -> Value {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    if let Ok(g) = st.link.try_lock() {
        let connected = g.conn.is_some();
        let label = g.label.clone();
        return json!({ "connected": connected, "label": label });
    }
    json!({ "connected": null, "label": "", "busy": true })
}

#[tauri::command]
pub fn agent_provider_save(app: AppHandle, provider: Provider, make_active: bool) -> Result<Value, String> {
    let mut cfg = store::load_providers(&app);
    let id = provider.id.trim().to_string();
    if id.is_empty() {
        return Err("profile id 不能为空".into());
    }
    match cfg.providers.iter().position(|p| p.id == id) {
        Some(i) => cfg.providers[i] = provider,
        None => cfg.providers.push(provider),
    }
    if make_active {
        cfg.active_id = Some(id);
    } else if cfg.active_id.is_none() {
        cfg.active_id = cfg.providers.first().map(|p| p.id.clone());
    }
    store::save_providers(&app, &cfg)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn agent_provider_delete(app: AppHandle, id: String) -> Result<Value, String> {
    let mut cfg = store::load_providers(&app);
    cfg.providers.retain(|p| p.id != id);
    if cfg.active_id.as_deref() == Some(id.as_str()) {
        cfg.active_id = cfg.providers.first().map(|p| p.id.clone());
    }
    store::save_providers(&app, &cfg)?;
    forget_speed(&app, &id);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn agent_provider_set_active(app: AppHandle, id: String) -> Result<Value, String> {
    let mut cfg = store::load_providers(&app);
    if !cfg.providers.iter().any(|p| p.id == id) {
        return Err("没有这个 profile".into());
    }
    cfg.active_id = Some(id);
    store::save_providers(&app, &cfg)?;
    Ok(json!({ "ok": true }))
}

/// 存 API Key（Windows 上按当前用户 DPAPI 加密）
#[tauri::command]
pub fn agent_secret_set(app: AppHandle, name: String, value: String) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("密钥名不能为空".into());
    }
    store::secret_set(&app, name.trim(), &value)?;
    Ok(json!({ "ok": true, "scheme": store::secret_scheme() }))
}

/// 拉模型列表，给下拉框用（读已保存的 profile）
#[tauri::command]
pub fn agent_models(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let (provider, key) = resolve_provider(&app, Some(&id))?;
    llm::list_models(&provider, &key)
}

/// 连通性自检：发一句最短的话过去（读已保存的 profile）
#[tauri::command]
pub fn agent_ping_provider(app: AppHandle, id: String) -> Result<String, String> {
    let (provider, key) = resolve_provider(&app, Some(&id))?;
    ping_once(&provider, &key)
}

fn ping_once(provider: &Provider, key: &str) -> Result<String, String> {
    let msgs = vec![
        json!({"role":"system","content":"只回复 ok"}),
        json!({"role":"user","content":"ping"}),
    ];
    let stop = AtomicBool::new(false);
    let out = llm::chat(provider, key, &msgs, &[], &stop, &mut llm::NullSink)?;
    // 显示真正用到的地址：Anthropic 协议走的是 /v1/messages，不是 /chat/completions
    let url = if llm::is_anthropic(provider) {
        anthropic::messages_url(&provider.endpoint)
    } else {
        provider.chat_url()
    };
    Ok(format!(
        "通了：{} · {}\n地址 {}\n回复 {:?}\ntokens in={} out={}",
        provider.name, provider.model, url, out.content.trim(),
        out.usage.prompt_tokens, out.usage.completion_tokens))
}

/// 用**表单里刚填的值**试连（不必先保存）—— 填完 Key 就能点
#[tauri::command]
pub fn agent_probe_models(app: AppHandle, provider: Provider, api_key: Option<String>) -> Result<Vec<String>, String> {
    if provider.endpoint.trim().is_empty() {
        return Err("先填地址（endpoint）".into());
    }
    let key = form_key(&app, &provider, api_key);
    llm::list_models(&provider, &key)
}

#[tauri::command]
pub fn agent_probe_chat(app: AppHandle, provider: Provider, api_key: Option<String>) -> Result<String, String> {
    if provider.endpoint.trim().is_empty() {
        return Err("先填地址（endpoint）".into());
    }
    if provider.model.trim().is_empty() {
        return Err("先填模型名".into());
    }
    let key = form_key(&app, &provider, api_key);
    ping_once(&provider, &key)
}

/// 表单里没填 Key 就退回密钥库里存的那把（改完别的字段直接测也能用）
fn form_key(app: &AppHandle, provider: &Provider, typed: Option<String>) -> String {
    let typed = typed.unwrap_or_default();
    if !typed.trim().is_empty() {
        return typed;
    }
    let name = if provider.api_key_ref.trim().is_empty() { provider.id.as_str() } else { provider.api_key_ref.as_str() };
    store::secret_get(app, name).unwrap_or_default()
}

/// 设当前会话的权限（read / ask / auto）
#[tauri::command]
pub fn agent_session_set_perm(app: AppHandle, id: String, perm: String) -> Result<Value, String> {
    let mut meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    meta.perm = match perm.as_str() {
        "read" => "read".to_string(),
        "auto" => "auto".to_string(),
        _ => "ask".to_string(),
    };
    store::session_update_meta(&app, &meta)?;
    // 切成"自动（完全权限）"时，**正等着的审批直接放行** —— 和 codex 一致：
    // 用户把权限放宽了，就不该再让一个已经挂在那儿的弹窗挡着。
    let mut approved = 0usize;
    if meta.perm == "auto" {
        let st = app.state::<Arc<AgentState>>().inner().clone();
        let waiters: Vec<(u64, Sender<bool>)> = st
            .approve_waiters
            .lock()
            .map_err(|_| "approve mutex".to_string())?
            .drain()
            .collect();
        approved = waiters.len();
        for (_id, tx) in waiters {
            let _ = tx.send(true);
        }
    }
    Ok(json!({ "ok": true, "perm": meta.perm, "autoApproved": approved }))
}

/// 设置/清除本次会话的目标（`/goal xxx` / `/goal clear`）。
/// 目标存在会话 meta 里，每一轮都会拼进系统提示 —— 相当于一个"一直记着"的长期指令。
#[tauri::command]
pub fn agent_session_set_goal(app: AppHandle, id: String, goal: String) -> Result<Value, String> {
    let mut meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    let text = goal.trim().to_string();
    let clearing = matches!(text.as_str(), "" | "clear" | "清除" | "清空");
    meta.goal = if clearing { String::new() } else { text.clone() };
    meta.updated = now_ms();
    store::session_update_meta(&app, &meta)?;
    Ok(json!({ "ok": true, "goal": meta.goal, "cleared": clearing }))
}

/// 技能开关（关掉的挪到 skills-off/，不进口令索引）
#[tauri::command]
pub fn agent_skill_set_enabled(app: AppHandle, name: String, on: bool) -> Result<Value, String> {
    let path = store::skill_set_enabled(&app, &name, on)?;
    Ok(json!({ "ok": true, "path": path, "enabled": on }))
}

/// 从本机导入技能（SKILL.md 或装着它的目录）
#[tauri::command]
pub fn agent_skill_import(app: AppHandle, path: String) -> Result<Value, String> {
    let p = store::skill_import(&app, &path)?;
    Ok(json!({ "ok": true, "path": p }))
}

// ── 斜杠指令（/xxx）─────────────────────────────────────────────────
// 内置那些（/goal /compact /new /perm /stop /model /rename /skills /help）在前端 agSlash 里；
// 这里管**用户自己加**的：一条 .md 一条指令，放 agent/slash/ 下，frontmatter 写 name / description，
// 正文就是提示词模板 —— `{{args}}` 会替换成"斜杠指令后面跟的参数"，没写就附在末尾。
// 「用 skill 或其它手段提供指令」就靠这个目录：把文件丢进去即可（技能作者也能随技能一起分发）。
const SLASH_EXAMPLE: &str = "---\nname: explain\ndescription: 用三句话解释刚才那段输出（不跑工具）\n---\n\n用三句话解释上面最后一段输出或结果，别调用任何工具，中文，直接给结论。\n\n（提示：正文里写 {{args}} 的位置会被换成「/指令 后面跟的参数」；不写就附在末尾。）\n";

fn slash_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let d = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent")
        .join("slash");
    std::fs::create_dir_all(&d).map_err(|e| format!("建 {} 失败: {e}", d.display()))?;
    // 第一次跑：给一条示例，让用户知道格式
    if std::fs::read_dir(&d).map(|mut i| i.next().is_none()).unwrap_or(false) {
        let _ = std::fs::write(d.join("explain.md"), SLASH_EXAMPLE);
    }
    Ok(d)
}

#[derive(serde::Serialize)]
pub struct SlashCmd {
    pub name: String,
    pub description: String,
    pub body: String,
    pub path: String,
}

/// 列出自定义斜杠指令（/help 与设置页都用它）
#[tauri::command]
pub fn agent_slash_list(app: AppHandle) -> Vec<SlashCmd> {
    let Ok(dir) = slash_dir(&app) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<SlashCmd> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let (fm, body) = store::parse_frontmatter(&text);
        let name = fm
            .get("name")
            .cloned()
            .unwrap_or_else(|| p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
        let name = name.trim().trim_start_matches('/').to_string();
        if name.is_empty() {
            continue;
        }
        out.push(SlashCmd {
            name,
            description: fm.get("description").cloned().unwrap_or_default().trim().to_string(),
            body: body.trim().to_string(),
            path: p.to_string_lossy().to_string(),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 斜杠指令目录（设置页「打开目录」用）
#[tauri::command]
pub fn agent_slash_dir(app: AppHandle) -> String {
    slash_dir(&app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

/// 存一条自定义斜杠指令
#[tauri::command]
pub fn agent_slash_save(app: AppHandle, name: String, description: String, body: String) -> Result<String, String> {
    let slug = store::slugify(&name);
    if slug.trim().is_empty() {
        return Err("名字不能为空".into());
    }
    let p = slash_dir(&app)?.join(format!("{slug}.md"));
    let text = format!("---\nname: {}\ndescription: {}\n---\n\n{}\n", name.trim(), description.trim(), body.trim());
    std::fs::write(&p, text).map_err(|e| format!("写 {} 失败: {e}", p.display()))?;
    Ok(p.to_string_lossy().to_string())
}

/// 删一条自定义斜杠指令
#[tauri::command]
pub fn agent_slash_delete(app: AppHandle, name: String) -> Result<(), String> {
    let p = slash_dir(&app)?.join(format!("{}.md", store::slugify(&name)));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("删 {} 失败: {e}", p.display()))?;
    }
    Ok(())
}

/// 技能目录（"打开技能目录"用）
#[tauri::command]
pub fn agent_skills_dir(app: AppHandle) -> String {
    store::skills_dir(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 前端把"允许/拒绝"点完送回来
#[tauri::command]
pub fn agent_approval_result(app: AppHandle, id: u64, ok: bool) -> Result<Value, String> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    let tx = st.approve_waiters.lock().map_err(|_| "mutex".to_string())?.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(ok);
            Ok(json!({ "ok": true }))
        }
        None => Ok(json!({ "ok": false, "reason": "这条审批已经不用管了" })),
    }
}

/// 把"文本"页/附件写进工作区（二进制也用这个）
#[tauri::command]
pub fn agent_workspace_write_bytes(app: AppHandle, session_id: String, path: String, data: Vec<u8>) -> Result<String, String> {
    let ws = workspace_of(&app, &session_id);
    std::fs::create_dir_all(&ws).map_err(|e| format!("建工作区失败: {e}"))?;
    let target = store::resolve_in_workspace(&ws, &path)?;
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&target, &data).map_err(|e| format!("写失败: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

// ── 会话 ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_sessions(app: AppHandle) -> Vec<store::SessionMeta> {
    store::sessions_list(&app)
}

#[tauri::command]
pub fn agent_session_new(
    app: AppHandle,
    title: Option<String>,
    provider_id: Option<String>,
    ws_id: Option<String>,
) -> Result<store::SessionMeta, String> {
    let ws_entry = ws_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .and_then(|id| store::workspace_by_id(&app, id))
        .unwrap_or_else(|| store::ensure_workspaces(&app).into_iter().next().unwrap_or_else(|| store::default_workspace_entry(&app)));
    let ws = std::path::PathBuf::from(&ws_entry.path);
    let _ = std::fs::create_dir_all(&ws);
    let mut meta = store::session_new(&app, title.as_deref().unwrap_or(""), &ws.to_string_lossy())?;
    meta.ws = ws_entry.id.clone();
    if let Some(p) = provider_id {
        meta.provider_id = p;
    }
    if let Ok(cfg) = store::providers_path(&app) {
        let _ = cfg;
    }
    let cfg = store::load_providers(&app);
    if meta.provider_id.is_empty() {
        meta.provider_id = cfg.active_id.clone().unwrap_or_default();
    }
    if let Some(p) = cfg.providers.iter().find(|p| p.id == meta.provider_id) {
        meta.model = p.model.clone();
    }
    store::session_update_meta(&app, &meta)?;
    Ok(meta)
}

#[tauri::command]
pub fn agent_session_load(app: AppHandle, id: String) -> Result<Value, String> {
    let meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    let events = store::session_read(&app, &id);
    Ok(json!({ "meta": meta, "events": events }))
}

#[tauri::command]
pub fn agent_session_delete(app: AppHandle, id: String) -> Result<Value, String> {
    store::session_delete(&app, &id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn agent_session_rename(app: AppHandle, id: String, title: String) -> Result<Value, String> {
    let mut meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    meta.title = title;
    meta.updated = now_ms();
    store::session_update_meta(&app, &meta)?;
    Ok(json!({ "ok": true }))
}

/// 会话中途换模型：把"这个会话用哪个 profile"也一起改掉。
/// 不这么做的话会出现两套口径 —— 发送时用的是全局 active（`agent_send` 带过去的 providerId），
/// 而会话自己记的还是旧 profile：上下文面板显示的窗口、压缩判断的预算全是旧模型的。
#[tauri::command]
pub fn agent_session_set_provider(app: AppHandle, id: String, provider_id: String) -> Result<Value, String> {
    let mut meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    let cfg = store::load_providers(&app);
    let p = cfg
        .providers
        .iter()
        .find(|x| x.id == provider_id)
        .ok_or("找不到这个供应商 profile")?;
    if meta.provider_id != provider_id {
        meta.provider_id = provider_id;
        meta.model = p.model.clone();
        meta.updated = now_ms();
        store::session_update_meta(&app, &meta)?;
    }
    Ok(json!({ "ok": true, "provider": meta.provider_id, "model": meta.model }))
}

#[tauri::command]
pub fn agent_session_set_workspace(app: AppHandle, id: String, path: String) -> Result<Value, String> {
    let mut meta = store::session_meta_of(&app, &id).ok_or("找不到这个会话")?;
    if meta.workspace != path {
        meta.workspace = path.clone();
        store::session_update_meta(&app, &meta)?;
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("建不了工作区 {path}: {e}"))?;
    Ok(json!({ "ok": true, "workspace": path }))
}

// ── 工作区 ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_workspaces(app: AppHandle) -> Vec<store::Workspace> {
    store::ensure_workspaces(&app)
}

#[tauri::command]
pub fn agent_workspace_new(app: AppHandle, path: String, name: Option<String>) -> Result<store::Workspace, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("这个路径不是一个目录：{path}"));
    }
    let mut list = store::ensure_workspaces(&app);
    if let Some(existing) = list.iter().find(|w| w.path == path) {
        return Ok(existing.clone());
    }
    let w = store::new_workspace(&path, name.as_deref().unwrap_or(""));
    list.push(w.clone());
    store::save_workspaces(&app, &list)?;
    Ok(w)
}

#[tauri::command]
pub fn agent_workspace_delete(app: AppHandle, id: String) -> Result<Value, String> {
    if id == "default" {
        return Err("默认工作区不能删".into());
    }
    let mut list = store::ensure_workspaces(&app);
    list.retain(|w| w.id != id);
    store::save_workspaces(&app, &list)?;
    Ok(json!({ "ok": true }))
}

/// 只改名字（路径不动，免得把会话里的相对路径搞乱）
#[tauri::command]
pub fn agent_workspace_rename(app: AppHandle, id: String, name: String) -> Result<Value, String> {
    let mut list = store::ensure_workspaces(&app);
    if let Some(w) = list.iter_mut().find(|w| w.id == id) {
        w.name = name;
    }
    store::save_workspaces(&app, &list)?;
    Ok(json!({ "ok": true }))
}

// ── 技能 ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_skills(app: AppHandle) -> Vec<store::SkillInfo> {
    store::skills_list(&app)
}

#[tauri::command]
pub fn agent_skill_read(app: AppHandle, name: String) -> Result<String, String> {
    store::skill_read(&app, &name)
}

#[tauri::command]
pub fn agent_skill_save(app: AppHandle, name: String, content: String) -> Result<String, String> {
    store::skill_write(&app, &name, &content)
}

#[tauri::command]
pub fn agent_skill_delete(app: AppHandle, name: String) -> Result<Value, String> {
    store::skill_delete(&app, &name)?;
    Ok(json!({ "ok": true }))
}

/// 开关技能的"常驻"：勾上就每轮把正文注入系统提示（身份 / 口吻 / 说话规则这类技能用这个）
#[tauri::command]
pub fn agent_skill_set_always(app: AppHandle, name: String, on: bool) -> Result<Value, String> {
    store::skill_set_always(&app, &name, on)?;
    Ok(json!({
        "ok": true, "slug": name, "always": on,
        "bytes": store::skills_always_bytes(&app), "limit": store::SKILLS_ALWAYS_LIMIT,
    }))
}

/// 常驻技能清单（界面显示开关状态和"已用多少 KB"）
#[tauri::command]
pub fn agent_skills_always(app: AppHandle) -> Result<Value, String> {
    Ok(json!({
        "slugs": store::skills_always(&app),
        "bytes": store::skills_always_bytes(&app),
        "limit": store::SKILLS_ALWAYS_LIMIT,
    }))
}

#[tauri::command]
pub fn agent_tools() -> Vec<Value> {
    tools::catalog()
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "host": t.host }))
        .collect()
}

// ── 上下文组装 / 压缩 ───────────────────────────────────────────────

/// 系统提示里的"常驻技能"那一段（没有常驻技能就返回空串）。
/// 单独抽出来是因为 `agent_context_breakdown` 要按同一份文本算它占多少 token。
/// 那句"优先于上面的通用角色描述"是**通用**优先级，不是给某个技能写死的：
/// 用户丢进来一个身份技能并勾上常驻，人格就该压过 KDock 的默认角色设定（和 opencode 里
/// "装了人格技能就自称那个人格"是一个效果）。但它不去动那句默认角色描述本身。
fn always_skills_section(app: &AppHandle) -> String {
    let blk = store::always_skills_block(app);
    if blk.is_empty() {
        return String::new();
    }
    format!("常驻技能（每个请求都在场；技能里写的自我设定、口吻与做事规则，优先于上面那句通用角色描述）：\n{blk}\n")
}

/// 会话内称呼那一行（第一轮由模型从"用户自称 / 身份技能"里总结出来；没定下来就返回空串，
/// 免得凭空编出真实姓名）。
fn names_line(app: &AppHandle, session_id: &str) -> String {
    let Some(m) = store::session_meta_of(app, session_id) else { return String::new() };
    let u = m.user_name.trim();
    let a = m.agent_name.trim();
    if u.is_empty() && a.is_empty() {
        return String::new();
    }
    format!(
        "本会话里的称呼：{}（用户） / {}（你自己）。对话里就按这个称呼来回，别用别的名字。\n",
        if u.is_empty() { "用户" } else { u },
        if a.is_empty() { "Agent" } else { a },
    )
}

fn system_prompt(
    app: &AppHandle,
    workspace: &std::path::Path,
    perm: &str,
    goal: &str,
    names: &str,
) -> String {
    let mut p = String::new();
    p.push_str("你是 KDock 里的设备调试助手，跑在用户的电脑上（桌面版上位机）。\n");
    p.push_str("KDock 已经内置：串口/网口收发、设备文件读写、固件升级(OTA)、烧录器写片、示波器控制、中控编排(时序流程)、屏幕捕获。你能直接调它们。\n\n");
    p.push_str(&format!("工作区（相对路径都相对它）：{}\n", workspace.to_string_lossy()));
    p.push_str(names);
    p.push_str("注意：传输页那条主连接是用户自己的；要**互不干扰**就用你自己的 link_*（那条用户看不见）。\n");
    p.push_str("但**用户想看着你干**、或者你想跟用户看同一份设备返回时，用 port_* 直接操作主连接：\n");
    p.push_str("port_list 看本机有哪些串口（别去跑 PowerShell 扫）、port_state 看主连接状态、port_write 往主连接发、port_read 读主连接的收发记录（用户在传输页看到的就是这一份）。\n");
    p.push_str("你在主连接上做的事会实时出现在用户的传输页里，所以那是「看得见」的通道。\n\n");
    p.push_str(&format!(
        "权限级别：{}\n",
        match perm {
            "read" => "只读（写设备/写文件/跑命令/烧录都会被后端直接拒绝，别去试）",
            "auto" => "自动（危险动作也会直接执行，做完要汇报清楚）",
            _ => "需要批准（写设备/写文件/跑命令/烧录前，系统会弹给用户点允许，你只管说明你要做什么）",
        }
    ));
    p.push_str("做事原则：\n");
    p.push_str("1. 先观察再动手（先 list/read 看清现状），改设备状态前先说明你要做什么；\n");
    p.push_str("2. 危险动作（升级、烧录、写设备文件、复位）尽量先让用户确认；\n");
    p.push_str("3. 一条工具调用只做一件事，拿到结果再决定下一步；不要臆测输出；\n");
    p.push_str("4. 二进制内容用 HEX 描述，别贴乱码；\n");
    p.push_str("5. 收尾时用中文给一句结论 + 关键数据。\n\n");
    // /goal 设定的目标：一直生效，每轮都在这里带上
    if !goal.trim().is_empty() {
        p.push_str("本次会话的目标（用户用 /goal 设定，优先围绕它推进；完成后提醒用户可以 /goal clear 清掉）：\n");
        p.push_str(goal.trim());
        p.push_str("\n\n");
    }
    let idx = store::skills_index(app);
    p.push_str("已安装技能（任务匹配到某个技能时，先用 skill_read 读全文，再照它做；也可以自己 skill_create 新技能）：\n");
    p.push_str(&idx);
    p.push('\n');
    p.push_str(&always_skills_section(app));
    let instr = workspace.join(WORKSPACE_INSTRUCTIONS);
    if let Ok(text) = std::fs::read_to_string(&instr) {
        if !text.trim().is_empty() {
            p.push_str("\n工作区里的项目说明（AGENTS.md，优先遵守）：\n");
            p.push_str(&text);
            p.push('\n');
        }
    }
    p
}

/// 请求前"裁剪"：只影响**这一次请求**，不写文件（codex 里叫 for_prompt）。
/// 从摘要之后的第一条开始，按 token 预算丢掉最老的几轮；至少留最后两轮。
fn trim_for_request(messages: Vec<Value>, budget: usize) -> Vec<Value> {
    let target = budget * 8 / 10;
    if llm::estimate_messages_tokens(&messages) <= target {
        return messages;
    }
    // 第 0 条是系统提示，可能第 1 条是摘要 —— 这两个都不动
    let head = if messages.len() > 1
        && messages[1].get("role").and_then(|r| r.as_str()) == Some("user")
        && messages[1].get("content").and_then(|c| c.as_str()).map(|c| c.starts_with("<对话摘要>")).unwrap_or(false)
    {
        2
    } else {
        1
    };
    let mut cut = head;
    let mut cur = messages.clone();
    while llm::estimate_messages_tokens(&cur) > target {
        // 找下一个"轮次边界"（用户消息，或者没有 tool_calls 的助手消息）
        let mut next = cut;
        while next < messages.len() {
            let m = &messages[next];
            let is_user = m.get("role").and_then(|r| r.as_str()) == Some("user");
            let plain_assistant = m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                && m.get("tool_calls").is_none();
            if next > cut && (is_user || plain_assistant) {
                break;
            }
            next += 1;
        }
        if next >= messages.len() || messages.len() - next < 3 {
            break; // 再切就只剩系统提示了，别切
        }
        cut = next;
        cur = messages[head..].to_vec();
        cur.insert(0, messages[0].clone());
        if head == 2 {
            cur.insert(1, messages[1].clone());
        }
    }
    cur
}

fn tool_msg(id: &str, text: &str) -> Value {
    json!({ "role": "tool", "tool_call_id": id, "content": text })
}

/// 把会话事件翻译成 OpenAI 的 messages。
/// 两条硬规矩：
/// 1. tool_call 和它的 tool 结果必须成对、顺序不能乱；
/// 2. 推理模型（DeepSeek/GLM 的 thinking 档）在**带工具调用那一轮**，
///    必须把 reasoning_content 原样带回去，否则下一轮直接 HTTP 400。
fn events_to_messages(
    app: &AppHandle,
    events: &[Event],
    workspace: &std::path::Path,
    perm: &str,
    goal: &str,
    names: &str,
) -> Vec<Value> {
    fn flush(out: &mut Vec<Value>, text: &mut String) {
        let t = text.trim();
        if !t.is_empty() {
            out.push(json!({ "role": "assistant", "content": t }));
        }
        text.clear();
    }

    // 是不是"思考型"模型：整段历史里只要出现过 reasoning，就认为是要回传的那种。
    // （DeepSeek 的 thinking 档要求**每条带 tool_calls 的 assistant 消息**都必须有
    //  reasoning_content 字段——哪怕那一轮它没输出思考，也得给个空串，否则 400。）
    let thinking = events
        .iter()
        .any(|e| matches!(e, Event::Assistant { reasoning, .. } if !reasoning.trim().is_empty()));

    let mut out = vec![json!({ "role": "system", "content": system_prompt(app, workspace, perm, goal, names) })];

    // 压缩是"追加一条 summary + 跳过它覆盖的那段"，原文还在文件里（可以用 history_search 回查）。
    let skip = store::summary_upto(events).min(events.len());
    if let Some(sum) = store::summary_text(events) {
        out.push(json!({ "role": "user", "content": format!(
            "<对话摘要>\n下面是我们之前聊过的内容摘要（原始记录还在，要细节可以用 history_search 工具按关键词回查）：\n{sum}\n</对话摘要>"
        ) }));
    }

    let mut pend_text = String::new();
    let mut pend_reason = String::new();
    let mut i = skip;
    while i < events.len() {
        match &events[i] {
            Event::Summary { .. } => {
                i += 1;
            }
            Event::User { text, .. } => {
                flush(&mut out, &mut pend_text);
                pend_reason.clear();
                out.push(json!({ "role": "user", "content": text }));
                i += 1;
            }
            Event::Assistant { text, reasoning, .. } => {
                pend_text.push_str(text);
                pend_reason.push_str(reasoning);
                i += 1;
            }
            Event::ToolCall { .. } => {
                let mut calls: Vec<Value> = Vec::new();
                let mut ids: Vec<String> = Vec::new();
                while i < events.len() {
                    if let Event::ToolCall { id, name, args, .. } = &events[i] {
                        ids.push(id.clone());
                        calls.push(json!({
                            "id": id, "type": "function",
                            "function": { "name": name, "arguments": args.to_string() }
                        }));
                        i += 1;
                    } else {
                        break;
                    }
                }
                let mut msg = json!({
                    "role": "assistant",
                    "content": if pend_text.trim().is_empty() { Value::Null } else { json!(pend_text) },
                    "tool_calls": calls
                });
                if thinking {
                    msg["reasoning_content"] = json!(pend_reason.trim());
                }
                out.push(msg);
                pend_text.clear();
                pend_reason.clear();
                let mut answered: Vec<String> = Vec::new();
                while i < events.len() {
                    if let Event::ToolResult { id, text, ok, .. } = &events[i] {
                        let body = if *ok { text.clone() } else { format!("[工具失败] {text}") };
                        out.push(tool_msg(id, &body));
                        answered.push(id.clone());
                        i += 1;
                    } else {
                        break;
                    }
                }
                for id in ids {
                    if !answered.contains(&id) {
                        out.push(tool_msg(&id, "[这次调用没有结果：上一轮被中断]"));
                    }
                }
            }
            Event::ToolResult { .. } | Event::Note { .. } => {
                i += 1;
            }
        }
    }
    flush(&mut out, &mut pend_text);
    out
}

/// 历史太长就压缩：把靠前的部分交给模型总结成一段，然后重写会话文件
/// 估算/摘要用的事件文本：**不含 reasoning**（思考内容不回传，也就不占输入预算）
fn event_brief(e: &Event) -> String {
    match e {
        Event::Assistant { text, .. } => format!("assistant: {text}"),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn compact_if_needed(app: &AppHandle, provider: &Provider, key: &str, session_id: &str) -> Option<String> {
    let events = store::session_read(app, session_id);
    let ws = workspace_of(app, session_id);
    let perm = store::session_meta_of(app, session_id).map(|m| m.perm).unwrap_or_else(|| "ask".into());
    let goal = store::session_meta_of(app, session_id).map(|m| m.goal).unwrap_or_default();
    let messages = events_to_messages(app, &events, &ws, &perm, &goal, &names_line(app, session_id));
    let budget = provider.context_window.saturating_sub(provider.reserve_output) as usize;
    if budget == 0 {
        return None;
    }
    // 优先信 provider 上一次报的 prompt_tokens（比本地估算准得多），估算只当兜底
    let estimate = llm::estimate_messages_tokens(&messages) as u64;
    let reported = store::session_meta_of(app, session_id).map(|m| m.last_tokens).unwrap_or(0);
    let used = estimate.max(reported) as usize;
    // 留 20% 余量给这轮新增的东西
    if used * 10 < budget * 8 {
        return None;
    }
    // 要压多少？算出来的不是"压一半"，而是"这轮超出预算的部分 + 一点余量"：
    // 目标是把请求拉回预算的 80%。只有能腾出这么多，压缩才有意义。
    // 只算"还没被摘要覆盖"的那部分历史。
    // 注意口径：`used` 是 provider 报的（含系统提示 + 工具 schema），本地估算不含工具 schema，
    // 所以先把本地估算按观测到的比例换算到 provider 口径，否则阈值永远追不上。
    let covered = store::summary_upto(&events).min(events.len());
    let raw_history: usize = events[covered..]
        .iter()
        .filter(|e| !matches!(e, Event::Summary { .. }))
        .map(|e| llm::estimate_tokens(&event_brief(e)) + 4)
        .sum();
    let est_full = llm::estimate_messages_tokens(&messages).max(1) as f64;
    let ratio = ((used as f64) / est_full).clamp(0.5, 4.0);
    let history_tokens = ((raw_history as f64) * ratio) as usize;
    let keep_target = budget * 8 / 10;
    let need = used.saturating_sub(keep_target).max(200);
    if history_tokens < 400 {
        // 历史本来就没多少：大头是系统提示 + 工具定义（每个工具都带 schema），压历史救不了。
        // 这种话每个会话只说一次，别每轮刷屏。
        let note = format!(
            "这轮上下文 {used} tokens 超预算 {budget}，但可压的对话历史只有约 {history_tokens} tokens —— \
             大头是系统提示 + 工具定义，压历史救不了，换个上下文更大的模型最省事。"
        );
        // 诊断结论只弹一次 toast（不进对话、不落盘），别把对话刷满系统消息
        let already = store::session_meta_of(app, session_id).map(|m| m.warned_overhead).unwrap_or(true);
        if !already {
            if let Some(mut m) = store::session_meta_of(app, session_id) {
                m.warned_overhead = true;
                let _ = store::session_update_meta(app, &m);
            }
            emit(app, "agent://toast", json!({ "text": note.replace('\n', " ") }));
        }
        return None;
    }
    // **渐进式**：一次不用把欠的账全还清（欠太多时反而永远压不动）。
    // 按"需要腾出的量"和"现有历史的 60%"取小 —— 每轮都往前推一点，几轮就收敛了。
    let drop_want = need.min(history_tokens * 6 / 10).max(300);
    let need_local = ((drop_want as f64) / ratio).max(60.0) as usize;

    // 从后往前攒够 need 就切；两个硬约束：至少留最后两条（最新一问一答），
    // 切点不能落在 tool 结果中间（不然 tool_call / tool_result 被拆开，协议直接不合法）。
    let mut keep_from = events.len();
    let mut acc = 0usize;
    while keep_from > 0 && acc < need_local {
        acc += llm::estimate_tokens(&event_brief(&events[keep_from - 1])) + 4;
        keep_from -= 1;
    }
    if events.len() >= 2 && keep_from > events.len() - 2 {
        keep_from = events.len() - 2;
    }
    while keep_from < events.len() && matches!(events[keep_from], Event::ToolResult { .. }) {
        keep_from += 1;
    }
    if keep_from == 0 {
        return Some(format!("上下文估算 {used} tokens 超预算 {budget}，历史也凑不够一段可压的（这一轮先照常跑）"));
    }
    let dropped: Vec<&Event> = events[..keep_from].iter().collect();
    // 摘要请求也得塞得下：只取要丢掉那段的**后半截**（越近越重要），并留出预算
    let mut transcript = String::new();
    let mut rev: Vec<&Event> = dropped.clone();
    rev.reverse();
    let cap = (budget / 2).max(600);
    for e in rev {
        let line = event_brief(e);
        if llm::estimate_tokens(&transcript) + llm::estimate_tokens(&line) > cap {
            break;
        }
        transcript = format!("{line}\n{transcript}");
    }
    let prev = store::summary_text(&events).unwrap_or_default();
    let prompt = format!(
        "把下面这段设备调试对话压缩成一份**交接摘要**，用中文，按小节写，不要寒暄、不要复述原文：\n\
         ## 任务与背景\n## 已经确认的事实（设备/口径/版本号/路径/串口或 IP/命令）\n\
         ## 已完成与结论\n## 没做完 / 下一步\n## 失败过的做法和原因\n## 用户定下的约束和禁止项\n\n\
         只写确实出现过的信息，不确定就别写；不要贴大段原始日志。\n\
         {}\n\n---- 新增的对话（把它并进上面的摘要）----\n{}",
        if prev.trim().is_empty() { String::new() } else { format!("---- 之前的摘要（在此基础上补充，别丢信息）----\n{prev}") },
        transcript.chars().take(60_000).collect::<String>());
    let msgs = vec![
        json!({ "role": "system", "content": "你是负责压缩上下文的助手。直接输出摘要正文，不要输出思考过程、不要复述提示词。" }),
        json!({ "role": "user", "content": prompt }),
    ];
    // 摘要这条也要留足输出额度：推理模型会把小额度全花在思考上、正文为空
    let mut summary_text = String::new();
    let mut last_err = String::new();
    for budget in [provider.reserve_output.max(4000), 8000u32] {
        let mut big = provider.clone();
        big.reserve_output = budget;
        let stop = AtomicBool::new(false);
        match llm::chat(&big, key, &msgs, &[], &stop, &mut llm::NullSink) {
            Ok(o) if !o.content.trim().is_empty() => {
                summary_text = o.content.trim().to_string();
                break;
            }
            Ok(o) => {
                last_err = format!(
                    "模型没给正文（finish={}，正文 {} 字，思考 {} 字，额度 {}）",
                    if o.finish.is_empty() { "?" } else { &o.finish },
                    o.content.chars().count(),
                    o.reasoning.chars().count(),
                    budget
                );
            }
            Err(e) => last_err = e,
        }
    }
    match if summary_text.is_empty() { Err(last_err) } else { Ok(summary_text) } {
        Ok(summary) => {
            match store::session_mark_summary(app, session_id, keep_from, &summary) {
                Ok(()) => {
                    emit(app, "agent://note", json!({ "session": session_id,
                        "text": format!("已压缩上下文：前 {} 条收成摘要（{} -> 预算 {} tokens）", keep_from, used, budget) }));
                    Some(format!("已压缩：{} 条 -> 摘要", keep_from))
                }
                Err(e) => Some(format!("压缩后重写会话失败：{e}")),
            }
        }
        Err(e) => {
            // 摘要失败也要能继续：照样标记一段"已被丢弃"，但原文还在文件里（可回查）
            let marker = format!("（这段内容的自动摘要没生成成功：{e}。原文还在会话文件里，可以用 history_search 回查）");
            let _ = store::session_mark_summary(app, session_id, keep_from, &marker);
            Some(format!("摘要没成功（{e}），这一段先标记为已跳过"))
        }
    }
}

// ── 跑一轮 ──────────────────────────────────────────────────────────

/// host 工具：让前端去做，再把结果要回来
fn host_call(app: &AppHandle, st: &AgentState, tool: &str, args: &Value, timeout_ms: u64) -> Result<String, String> {
    let id = st.host_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = std::sync::mpsc::channel();
    st.host_waiters.lock().map_err(|_| "host mutex".to_string())?.insert(id, tx);
    emit(app, "agent://host_call", json!({ "id": id, "tool": tool, "args": args }));
    let result = rx.recv_timeout(Duration::from_millis(timeout_ms));
    if let Ok(mut map) = st.host_waiters.lock() {
        map.remove(&id);
    }
    match result {
        Ok(r) => r,
        Err(_) => Err(format!("前端没在 {}ms 内回这个工具的结果（{tool}）", timeout_ms)),
    }
}

/// perm=ask：把"要不要执行 xxx"推给前端，等用户点
fn ask_user(app: &AppHandle, st: &AgentState, session: &str, tool: &str, args: &Value) -> Result<bool, String> {
    let id = st.approve_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = std::sync::mpsc::channel();
    st.approve_waiters.lock().map_err(|_| "mutex".to_string())?.insert(id, tx);
    emit(app, "agent://approval", json!({
        "id": id, "session": session, "tool": tool, "args": args
    }));
    let r = rx.recv_timeout(Duration::from_secs(300));
    if let Ok(mut m) = st.approve_waiters.lock() {
        m.remove(&id);
    }
    match r {
        Ok(ok) => Ok(ok),
        Err(_) => Err("等你点允许/拒绝等太久了（5 分钟），这次先跳过".into()),
    }
}

/// 把"运行中补进来的话"落成正式的 user 事件（每一轮开始前调一次）。
/// 不打断正在进行的流式输出，只在"轮次边界"并入 —— 和 codex 的插入方式一致。
fn drain_pending(app: &AppHandle, st: &AgentState, session_id: &str) -> Result<usize, String> {
    let items: Vec<String> = {
        let mut g = st.pending.lock().map_err(|_| "pending mutex".to_string())?;
        std::mem::take(&mut *g)
    };
    for text in items.iter() {
        store::session_append(app, session_id, &Event::User { text: text.clone(), ts: 0 })?;
        emit(
            app,
            "agent://user",
            json!({ "session": session_id, "text": text, "queued": true }),
        );
    }
    Ok(items.len())
}

/// 第一轮聊完，把"新会话"改成一句像样的标题
fn maybe_auto_title(app: &AppHandle, session_id: &str, provider: &Provider, key: &str) {
    let Some(meta) = store::session_meta_of(app, session_id) else { return };
    let looks_new = meta.title.trim().is_empty() || meta.title == "新会话";
    if !looks_new || meta.turns > 1 {
        return;
    }
    let events = store::session_read(app, session_id);
    let first_user = events.iter().find_map(|e| match e {
        Event::User { text, .. } => Some(text.clone()),
        _ => None,
    });
    let Some(first) = first_user else { return };
    let fallback: String = {
        let one_line = first.split_whitespace().collect::<Vec<_>>().join(" ");
        one_line.chars().take(18).collect()
    };
    // 一次调用顺便把"会话内怎么称呼用户 / 怎么自称"也定下来（多要两行，几乎不加钱）。
    // 依据只有用户自称与技能里的身份；明确要求**不要编造或使用真实姓名**。
    let skills = store::skills_index(app);
    let sys = format!(
        "下面是一段对话的第一句。请输出**三行**，每行都不带引号、句号或序号：\n\
         第一行：给这段对话起的标题，不超过 12 个字。\n\
         第二行：在这个会话里怎么称呼「用户」，不超过 16 个字 —— 只根据用户自己的自称、或下面列出的\
         技能里的身份信息来定；没有依据就写「用户」；**不要猜测、编造或使用真实姓名**。\n\
         第三行：在这个会话里「你自己」叫什么，不超过 16 个字 —— 同样只根据用户的自称或技能里的身份\
         （比如某个身份/人格技能规定了名字就用它）；没有依据就写「Agent」；**不要编造真实姓名**。\n\
         只输出这三行，不要解释。\n\n已安装技能（仅供判断身份线索）：\n{skills}"
    );
    let msgs = vec![
        json!({"role":"system","content": sys}),
        json!({"role":"user","content": first.chars().take(600).collect::<String>()}),
    ];
    // 起名字这步要小心：GLM 这类"先想再答"的模型，max_tokens 给小了会**只输出思考、正文为空**，
    // 所以先给 512，还是空就再加到 2048 重试一次。
    let clean = |t: String| {
        t.trim()
            .trim_matches(|c: char| c == '"' || c == '\'' || c == '「' || c == '」' || c == '。' || c == '\n' || c == ' ')
            .to_string()
    };
    let mut title = String::new();
    let mut user_name = String::new();
    let mut agent_name = String::new();
    for budget in [512u32, 2048u32] {
        let mut tiny = provider.clone();
        tiny.reserve_output = budget;
        let stop = AtomicBool::new(false);
        match llm::chat(&tiny, key, &msgs, &[], &stop, &mut llm::NullSink) {
            Ok(o) => {
                // 三行：标题 / 用户称呼 / agent 称呼（模型只给一行也能用，后两个走默认）
                let mut lines = o.content.lines().map(|s| clean(s.to_string())).filter(|s| !s.is_empty());
                let t = lines.next().unwrap_or_default();
                let u = lines.next().unwrap_or_default();
                let a = lines.next().unwrap_or_default();
                let cut = |s: String, n: usize| s.chars().take(n).collect::<String>();
                if !t.is_empty() && t.chars().count() <= 24 {
                    title = t;
                    user_name = cut(u, 16);
                    agent_name = cut(a, 16);
                    break;
                }
            }
            Err(_) => continue,
        }
    }
    if title.is_empty() {
        title = fallback;
    }
    let mut meta = meta;
    meta.title = title.clone();
    if !user_name.trim().is_empty() {
        meta.user_name = user_name.trim().to_string();
    }
    if !agent_name.trim().is_empty() {
        meta.agent_name = agent_name.trim().to_string();
    }
    meta.updated = now_ms();
    if store::session_update_meta(app, &meta).is_ok() {
        // 只刷新标题，不往对话里塞系统消息（名字本来就显示在对话头上）
        emit(app, "agent://session", json!(meta));
    }
}

enum SinkMsg {
    Delta(String),
    /// 思考内容（推理模型才有）：前端拿它显示"思考过程"块
    Reasoning(String),
}

/// 把流式增量按 ~40ms 合批推给前端，避免一个字一个事件
struct BatchedSink {
    tx: Sender<SinkMsg>,
    buf: String,
    last: std::time::Instant,
    kind: &'static str,
}

impl BatchedSink {
    fn new(tx: Sender<SinkMsg>) -> Self {
        Self { tx, buf: String::new(), last: std::time::Instant::now(), kind: "content" }
    }
    fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.buf);
        let msg = if self.kind == "reason" { SinkMsg::Reasoning(text) } else { SinkMsg::Delta(text) };
        let _ = self.tx.send(msg);
        self.last = std::time::Instant::now();
    }
    /// 正文和思考共用一条通道：换种类时先把上一段冲出去（顺序不能乱）
    fn push(&mut self, text: &str, kind: &'static str) {
        if self.kind != kind {
            self.flush();
            self.kind = kind;
        }
        self.buf.push_str(text);
        if self.buf.len() >= 24 || self.last.elapsed() > Duration::from_millis(40) {
            self.flush();
        }
    }
}

impl llm::ChatSink for BatchedSink {
    fn delta(&mut self, text: &str) {
        self.push(text, "content");
    }
    fn reasoning(&mut self, text: &str) {
        self.push(text, "reason");
    }
}

fn run_turn(
    app: AppHandle,
    session_id: String,
    provider: Provider,
    key: String,
    text: String,
    stop: Arc<AtomicBool>,
) {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    STOPPED.store(false, Ordering::Relaxed); // 新一轮开始：清掉上一轮的停止标志
    let ws = workspace_of(&app, &session_id);
    let _ = std::fs::create_dir_all(&ws);
    emit(&app, "agent://state", json!({ "running": true, "session": session_id }));

    let perm = store::session_meta_of(&app, &session_id).map(|m| m.perm).unwrap_or_else(|| "ask".into());
    let goal = store::session_meta_of(&app, &session_id).map(|m| m.goal).unwrap_or_default();
    let result: Result<(), String> = (|| {
        store::session_append(&app, &session_id, &Event::User { text: text.clone(), ts: 0 })?;
        if let Some(meta) = store::session_touch(&app, &session_id) {
            emit(&app, "agent://session", json!(meta));
        }
        if let Some(note) = compact_if_needed(&app, &provider, &key, &session_id) {
            // 也写进会话文件：不然 done 时按文件重画，这条提示就没了
            let _ = store::session_append(&app, &session_id, &Event::Note { text: note.clone(), ts: 0 });
            emit(&app, "agent://note", json!({ "session": session_id, "text": note }));
        }
        let mut tools_schema = tools::schema_json(&tools::catalog(), true);
        // MCP 的工具是动态的，但**不能每轮都去 spawn 一遍问 tools/list**：
        // 一是慢（npx 握手好几秒），二是 tools 在 prompt 前缀里，清单一变前缀缓存就整段失效。
        // all_tool_schemas_cached 按"配置指纹 + 10 分钟"复用，并把顺序排死。
        let (mcp_schemas, mcp_refreshed) = mcp::all_tool_schemas_cached(&app);
        if mcp_refreshed && !mcp_schemas.is_empty() {
            emit(
                &app,
                "agent://log",
                json!({ "text": format!("MCP 工具清单已刷新并缓存（{} 个）\n", mcp_schemas.len()) }),
            );
        }
        if !mcp_schemas.is_empty() {
            tools_schema.extend(mcp_schemas);
        }
        for round in 0..MAX_ROUNDS {
            if stop.load(Ordering::Relaxed) {
                store::session_append(&app, &session_id, &Event::Note { text: "用户停止".into(), ts: 0 })?;
                return Ok(());
            }
            // 运行中用户补进来的话：在这个轮次边界并进去，下一轮模型就能看到
            drain_pending(&app, &st, &session_id)?;
            let events = store::session_read(&app, &session_id);
            let budget_now = provider.context_window.saturating_sub(provider.reserve_output) as usize;
            // 摘要之外的再裁一道（只影响这次请求）
            let messages = trim_for_request(
                events_to_messages(&app, &events, &ws, &perm, &goal, &names_line(&app, &session_id)),
                budget_now.max(1),
            );
            emit(&app, "agent://round", json!({ "session": session_id, "round": round + 1,
                "messages": messages.len(),
                "tokens": llm::estimate_messages_tokens(&messages) }));

            let (tx, rx) = std::sync::mpsc::channel::<SinkMsg>();
            let app2 = app.clone();
            let sid = session_id.clone();
            let pump = std::thread::spawn(move || {
                while let Ok(msg) = rx.recv() {
                    match msg {
                        SinkMsg::Delta(t) => emit(&app2, "agent://delta", json!({ "session": sid, "text": t })),
                        SinkMsg::Reasoning(t) => emit(&app2, "agent://reason", json!({ "session": sid, "text": t })),
                    }
                }
            });
            let mut sink = BatchedSink::new(tx.clone());
            let out = llm::chat(&provider, &key, &messages, &tools_schema, &stop, &mut sink);
            sink.flush();
            drop(sink);
            drop(tx);
            let _ = pump.join();
            let out = out.map_err(|e| format!("{e}"))?;

            // 有思考也要落盘：带工具调用的那一轮，下一轮必须把 reasoning_content 带回去
            if !out.content.trim().is_empty() || !out.reasoning.trim().is_empty() {
                store::session_append(&app, &session_id, &Event::Assistant {
                    text: out.content.clone(), reasoning: out.reasoning.clone(), ts: 0,
                    model: provider.model.clone() })?;
            }
            emit(&app, "agent://usage", json!({ "session": session_id,
                "prompt": out.usage.prompt_tokens, "completion": out.usage.completion_tokens,
                "total": out.usage.total_tokens,
                "cacheHit": out.usage.cache_hit_tokens, "cacheMiss": out.usage.cache_miss_tokens }));
            if out.usage.prompt_tokens > 0 || out.usage.completion_tokens > 0 {
                if let Some(mut meta) = store::session_meta_of(&app, &session_id) {
                    meta.last_tokens = out.usage.prompt_tokens;
                    // 会话级账本：Agent 信息面板用它算 token 消费 / 缓存命中率 / 花费
                    meta.total_prompt += out.usage.prompt_tokens;
                    meta.total_completion += out.usage.completion_tokens;
                    meta.total_cache_hit += out.usage.cache_hit_tokens;
                    meta.total_cache_miss += out.usage.cache_miss_tokens;
                    let _ = store::session_update_meta(&app, &meta);
                }
            }
            // 出字速度：只在"真的在出字"的那段算（gen_ms 是首字→末字，工具调用/空闲不计）。
            // token 数优先用厂商报的 completion_tokens，没有就按字数估（中英混排也能看）。
            if out.gen_ms > 0 {
                let toks = if out.usage.completion_tokens > 0 {
                    out.usage.completion_tokens
                } else {
                    (llm::estimate_tokens(&out.content) + llm::estimate_tokens(&out.reasoning)) as u64
                };
                record_speed(&app, &provider.id, toks, out.gen_ms);
            }

            if out.stopped {
                store::session_append(&app, &session_id, &Event::Note { text: "用户停止（模型流已断）".into(), ts: 0 })?;
                return Ok(());
            }
            if out.tool_calls.is_empty() {
                // 跑着的时候用户又补了话：别收尾，带着新要求继续
                if !st.pending.lock().map(|p| p.is_empty()).unwrap_or(true) {
                    continue;
                }
                return Ok(());
            }
            // 执行工具（逐个，串行 —— 设备类操作没必要并行，还容易打架）
            for call in out.tool_calls.iter() {
                let args = call.args();
                store::session_append(&app, &session_id, &Event::ToolCall {
                    id: call.id.clone(), name: call.name.clone(), args: args.clone(), ts: 0 })?;
                emit(&app, "agent://tool_call", json!({ "session": session_id, "round": round + 1,
                    "id": call.id, "name": call.name, "args": args }));
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let ctx = ToolCtx {
                    app: &app,
                    state: &st,
                    workspace: ws.clone(),
                    session: &session_id,
                    perm: &perm,
                    approve: &|tool: &str, a: &Value| ask_user(&app, &st, &session_id, tool, a),
                    host: &|tool: &str, a: &Value, t: u64| host_call(&app, &st, tool, a, t),
                    log: &|s: &str| emit(&app, "agent://log", json!({ "text": s })),
                };
                let (ok, text) = match tools::execute(&ctx, &call.name, &args) {
                    Ok(t) => (true, t),
                    Err(e) => (false, e),
                };
                let text = if text.chars().count() > 12_000 {
                    format!("{}…(结果太长，截断到 12000 字)", text.chars().take(12_000).collect::<String>())
                } else {
                    text
                };
                store::session_append(&app, &session_id, &Event::ToolResult {
                    id: call.id.clone(), name: call.name.clone(), ok, text: text.clone(), ts: 0 })?;
                emit(&app, "agent://tool_result", json!({ "session": session_id,
                    "id": call.id, "name": call.name, "args": args, "ok": ok, "text": text }));
            }
        }
        store::session_append(&app, &session_id, &Event::Note {
            text: format!("已经连续跑了 {MAX_ROUNDS} 轮工具，先停下；需要继续就说一声"), ts: 0 })?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = store::session_append(&app, &session_id, &Event::Note { text: format!("出错: {e}"), ts: 0 });
        emit(&app, "agent://error", json!({ "session": session_id, "text": e }));
    }
    if let Ok(mut g) = st.run.lock() {
        // 只清自己占的那个槽（理论上只会是自己，多一层保险）
        let mine = g.as_ref().map(|f| Arc::ptr_eq(f, &stop)).unwrap_or(false);
        if mine {
            *g = None;
        }
    }
    emit(&app, "agent://state", json!({ "running": false, "session": session_id }));
    emit(&app, "agent://done", json!({ "session": session_id }));
    // 起会话名**放在最后、另开线程**：它还要问一次模型，不能让用户在这儿干等
    {
        let app2 = app.clone();
        let sid = session_id.clone();
        let prov = provider.clone();
        let k = key.clone();
        std::thread::spawn(move || maybe_auto_title(&app2, &sid, &prov, &k));
    }
}

/// 发一条消息给 agent（后台跑，立刻返回）
#[tauri::command]
pub fn agent_send(app: AppHandle, session_id: String, text: String, provider_id: Option<String>) -> Result<Value, String> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    if text.trim().is_empty() {
        return Err("内容是空的".into());
    }
    let meta = store::session_meta_of(&app, &session_id).ok_or("找不到这个会话")?;
    let want = provider_id.filter(|s| !s.trim().is_empty()).or(Some(meta.provider_id.clone()));
    // **同步占坑**：这里必须锁着判断+占位一气呵成。
    // 之前是"先起线程、线程里再占"，两条消息同时进来会双双通过检查。
    // 正在跑的时候**不再拒绝**：排进 pending，等这一轮的下一个边界并进对话（边跑边改方向）。
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut g = st.run.lock().map_err(|_| "run mutex".to_string())?;
        if g.is_some() {
            drop(g);
            let mut pend = st.pending.lock().map_err(|_| "pending mutex".to_string())?;
            if pend.len() >= 8 {
                return Err("补充的消息排太多了（8 条），等这一轮跑完再发".into());
            }
            pend.push(text.clone());
            drop(pend);
            emit(
                &app,
                "agent://queued",
                json!({ "session": session_id, "text": text }),
            );
            return Ok(json!({ "ok": true, "queued": true }));
        }
        *g = Some(stop.clone());
    }
    // 占坑成功后再解析 provider/密钥：失败要把坑还回去
    let (provider, key) = match resolve_provider(&app, want.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            if let Ok(mut g) = st.run.lock() {
                *g = None;
            }
            return Err(e);
        }
    };
    let app2 = app.clone();
    std::thread::spawn(move || run_turn(app2, session_id, provider, key, text, stop));
    Ok(json!({ "ok": true }))
}

/// 前端可以用它确认"到底在不在跑"（事件丢了的兜底）
#[tauri::command]
pub async fn agent_running(app: AppHandle) -> Value {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    json!({
        "running": st.running(),
        "link": link_snapshot(&app),
        // 工具层看的就是这个标志（排查"停止没反应"时很有用）
        "stopRequested": stop_requested(),
    })
}

#[tauri::command]
pub fn agent_stop(app: AppHandle) -> Result<Value, String> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    if let Ok(g) = st.run.lock() {
        if let Some(flag) = g.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    STOPPED.store(true, Ordering::Relaxed); // 工具层里的长循环也靠它提前退出
    // 光置标志是不够的：如果这一轮正卡在"等你点允许/拒绝"上，它要等到 5 分钟超时才醒，
    // 用户看到的"停止"就等于没反应（实测：点停止 40 秒后仍在跑）。
    // 所以这里把等待中的审批直接判成"拒绝"、把前端 host 调用也判成失败，让这一轮立刻往下走。
    let approvals: Vec<(u64, Sender<bool>)> = st
        .approve_waiters
        .lock()
        .map_err(|_| "approve mutex".to_string())?
        .drain()
        .collect();
    let n = approvals.len();
    for (_id, tx) in approvals {
        let _ = tx.send(false);
    }
    let hosts: Vec<(u64, Sender<Result<String, String>>)> = st
        .host_waiters
        .lock()
        .map_err(|_| "host mutex".to_string())?
        .drain()
        .collect();
    for (_id, tx) in hosts {
        let _ = tx.send(Err("用户停止了这一轮".into()));
    }
    // 排队里还没并进去的也一起丢掉：用户按了停止，就是不想再继续了
    if let Ok(mut p) = st.pending.lock() {
        p.clear();
    }
    Ok(json!({ "ok": true, "approvalsResolved": n }))
}

/// 前端把 host 工具的结果送回来
#[tauri::command]
pub fn agent_host_result(app: AppHandle, id: u64, ok: bool, result: String) -> Result<Value, String> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    let tx = st.host_waiters.lock().map_err(|_| "host mutex".to_string())?.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(if ok { Ok(result) } else { Err(result) });
            Ok(json!({ "ok": true }))
        }
        None => Ok(json!({ "ok": false, "reason": "已经没有等这个 id 的调用了" })),
    }
}

/// 把文本页的内容写进当前会话的工作区（前端"存到工作区"用）
#[tauri::command]
pub fn agent_workspace_write(app: AppHandle, session_id: String, path: String, content: String) -> Result<String, String> {
    let ws = workspace_of(&app, &session_id);
    std::fs::create_dir_all(&ws).map_err(|e| format!("建工作区失败: {e}"))?;
    let target = store::resolve_in_workspace(&ws, &path)?;
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&target, content).map_err(|e| format!("写失败: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// 读工作区里的文件（文本页"打开工作区文件"用）
#[tauri::command]
pub fn agent_workspace_read(app: AppHandle, session_id: String, path: String) -> Result<String, String> {
    let ws = workspace_of(&app, &session_id);
    let target = store::resolve_in_workspace(&ws, &path)?;
    std::fs::read_to_string(&target).map_err(|e| format!("读失败: {e}"))
}

// ── 内置浏览器 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn browser_fetch(app: AppHandle, url: String) -> Result<browser::Page, String> {
    let page = browser::fetch(&url)?;
    let st = app.state::<Arc<AgentState>>().inner().clone();
    if let Ok(mut g) = st.page.lock() {
        if let Some(old) = g.replace(page.clone()) {
            if let Ok(mut h) = st.history.lock() {
                h.push(old);
                if h.len() > 30 {
                    h.remove(0);
                }
            }
        }
    }
    Ok(page)
}

#[tauri::command]
pub fn browser_back(app: AppHandle) -> Result<Option<browser::Page>, String> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    let prev = st.history.lock().map_err(|_| "mutex".to_string())?.pop();
    if let Some(p) = &prev {
        if let Ok(mut g) = st.page.lock() {
            *g = Some(p.clone());
        }
    }
    Ok(prev)
}

#[tauri::command]
pub fn browser_current(app: AppHandle) -> Option<browser::Page> {
    let st = app.state::<Arc<AgentState>>().inner().clone();
    st.page.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn browser_open_external(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!("这个平台上请自己打开：{path}"))
    }
}

// ── MCP ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mcp_list(app: AppHandle) -> Vec<mcp::McpServer> {
    mcp::load(&app)
}

#[tauri::command]
pub fn mcp_save(app: AppHandle, server: mcp::McpServer) -> Result<Value, String> {
    if server.id.trim().is_empty() {
        return Err("id 不能为空".into());
    }
    let mut list = mcp::load(&app);
    match list.iter().position(|s| s.id == server.id) {
        Some(i) => list[i] = server,
        None => list.push(server),
    }
    mcp::save(&app, &list)?;
    mcp::invalidate_cache(); // 配置变了：工具清单缓存作废
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn mcp_delete(app: AppHandle, id: String) -> Result<Value, String> {
    let mut list = mcp::load(&app);
    list.retain(|s| s.id != id);
    mcp::save(&app, &list)?;
    mcp::invalidate_cache();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn mcp_test(app: AppHandle, id: String) -> Result<String, String> {
    mcp::describe(&app, &id)
}

#[tauri::command]
pub fn mcp_tools(app: AppHandle, id: String) -> Result<Vec<Value>, String> {
    let srv = mcp::find(&app, &id).ok_or("找不到这个 MCP 服务")?;
    let (_info, tools) = mcp::probe(&srv)?;
    Ok(tools)
}

#[tauri::command]
pub fn mcp_path_hint(app: AppHandle) -> String {
    mcp::dir_hint(&app)
}

/// 手动压缩一次上下文
#[tauri::command]
pub fn agent_compact(app: AppHandle, session_id: String) -> Result<Value, String> {
    let meta = store::session_meta_of(&app, &session_id).ok_or("找不到这个会话")?;
    let (provider, key) = resolve_provider(&app, Some(&meta.provider_id))?;
    match compact_if_needed(&app, &provider, &key, &session_id) {
        Some(note) => Ok(json!({ "ok": true, "note": note })),
        None => Ok(json!({ "ok": true, "note": "上下文还很富裕，不用压缩" })),
    }
}

/// 查这个供应商的余额（目前只接了 DeepSeek 的 /user/balance，别的厂商返回 supported=false）
#[tauri::command]
pub fn agent_provider_balance(app: AppHandle, id: String) -> Result<Value, String> {
    let (provider, key) = resolve_provider(&app, Some(&id))?;
    llm::balance(&provider, &key)
}

// ── AMD Radeon Cloud（tokenfactory）实时负载 ─────────────────────────
// 页面上每个模型卡片下面那条 "Live capacity: N%"（该模型的并发额度用了多少）就是这份数据：
// 公开接口、不需要 key、也不要 cookie。跨域请求会被浏览器拦掉（响应里没有 CORS 头），
// 所以由后端去取，前端只拿结果。
// ⚠️ 这个接口**本身很慢**：实测连续几次都是 22~24 秒才回（curl/PowerShell 都一样，
//    不是 TLS 栈的问题，别再去怀疑 rustls 了）。所以超时给到 45 秒。
// 15 秒内重复调用直接给缓存：界面每 15 秒刷一次，别把人家接口打爆。
const AMD_LOAD_URL: &str = "https://developer.amd.com.cn/radeon/api/tokenfactory/load";

static AMD_LOAD_CACHE: std::sync::LazyLock<Mutex<Option<(std::time::Instant, Value)>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[tauri::command]
pub async fn amd_load(force: Option<bool>) -> Result<Value, String> {
    const TTL: Duration = Duration::from_secs(15);
    if !force.unwrap_or(false) {
        if let Ok(g) = AMD_LOAD_CACHE.lock() {
            if let Some((at, v)) = g.as_ref() {
                if at.elapsed() < TTL {
                    return Ok(v.clone());
                }
            }
        }
    }
    // ureq 是同步的：丢到阻塞线程池里，别占着 async 运行时
    let v = tauri::async_runtime::spawn_blocking(|| -> Result<Value, String> {
        let resp = ureq::get(AMD_LOAD_URL)
            .timeout(Duration::from_secs(45))
            .call()
            .map_err(|e| format!("请求 AMD 负载接口失败: {e}"))?;
        let text = resp.into_string().map_err(|e| format!("读响应失败: {e}"))?;
        serde_json::from_str::<Value>(&text).map_err(|e| format!("响应不是 JSON: {e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))??;
    if let Ok(mut g) = AMD_LOAD_CACHE.lock() {
        *g = Some((std::time::Instant::now(), v.clone()));
    }
    Ok(v)
}

/// 上下文成分分析：把"这一轮到底是谁在占 token"拆开 ——
/// system 提示 / 工具定义 schema / 摘要 / 用户消息 / 助手回复 / 工具调用与结果 / 剩余可用。
/// 口径跟真实请求尽量对齐：摘要顶掉的旧事件不再计入类目，单独报"被压缩掉的量"。
#[tauri::command]
pub fn agent_context_breakdown(app: AppHandle, session_id: String) -> Value {
    let meta = store::session_meta_of(&app, &session_id);
    let ws = workspace_of(&app, &session_id);
    let perm = meta
        .as_ref()
        .map(|m| m.perm.clone())
        .unwrap_or_else(|| "ask".into());
    let events = store::session_read(&app, &session_id);
    let est = |s: &str| llm::estimate_tokens(s);

    let goal = meta.as_ref().map(|m| m.goal.clone()).unwrap_or_default();
    let sys = est(&system_prompt(&app, &ws, &perm, &goal, &names_line(&app, &session_id)));
    // 常驻技能是系统提示的一部分（sys 里已经含了），这里单独报出来给界面标"其中"
    let skills_always = est(&always_skills_section(&app));
    let mut schema = tools::schema_json(&tools::catalog(), true);
    // 别漏掉 MCP 工具：它们也在 prompt 前缀里（用缓存的那份，不会为此再起进程）
    let (mcp_schemas, _) = mcp::all_tool_schemas_cached(&app);
    schema.extend(mcp_schemas);
    let tools_tok = est(&serde_json::to_string(&schema).unwrap_or_default());
    let covered = store::summary_upto(&events).min(events.len());
    let summary = est(&store::summary_text(&events).unwrap_or_default());

    let (mut user, mut assistant, mut tool, mut note) = (0usize, 0usize, 0usize, 0usize);
    let mut dropped = 0usize;
    for (i, e) in events.iter().enumerate() {
        let in_dropped = i < covered;
        let cost = match e {
            Event::Summary { .. } => 0,
            Event::User { text, .. } => est(text) + 4,
            Event::Assistant { text, .. } => est(text) + 4,
            Event::ToolCall { name, args, .. } => est(name) + est(&args.to_string()) + 8,
            Event::ToolResult { text, .. } => est(text) + 12,
            Event::Note { text, .. } => est(text),
        };
        if in_dropped {
            dropped += cost;
            continue;
        }
        match e {
            Event::User { .. } => user += cost,
            Event::Assistant { .. } => assistant += cost,
            Event::ToolCall { .. } | Event::ToolResult { .. } => tool += cost,
            Event::Note { .. } => note += cost,
            Event::Summary { .. } => {}
        }
    }

    let cfg = store::load_providers(&app);
    let prov = store::find_provider(&cfg, meta.as_ref().map(|m| m.provider_id.as_str()));
    let ctx = prov.as_ref().map(|p| p.context_window).unwrap_or(0);
    let reserve = prov.as_ref().map(|p| p.reserve_output).unwrap_or(0);
    let budget = ctx.saturating_sub(reserve) as usize;
    let used = sys + tools_tok + summary + user + assistant + tool;

    json!({
        "system": sys,
        "skillsAlways": skills_always,
        "tools": tools_tok,
        "summary": summary,
        "user": user,
        "assistant": assistant,
        "tool": tool,
        "note": note,
        "dropped": dropped,                 // 已被摘要顶掉、不再进请求的那部分
        "coveredEvents": covered,
        "used": used,
        "free": budget.saturating_sub(used),
        "contextWindow": ctx,
        "reserve": reserve,
        "budget": budget,
        "lastPromptTokens": meta.as_ref().map(|m| m.last_tokens).unwrap_or(0),
        "model": prov.as_ref().map(|p| p.model.clone()).unwrap_or_default(),
        "kind": prov.as_ref().map(|p| p.kind.clone()).unwrap_or_default(),
        "events": events.len(),
    })
}
