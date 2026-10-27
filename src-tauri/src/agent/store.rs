//! Agent 的**存储层**：供应商配置 / API Key / 会话(JSONL) / 技能。
//!
//! 设计取舍（对着 juanx 那套抄结构、不抄重量）：
//! - 供应商 profile 和密钥**分开存**：profile 是普通 JSON（不含密钥，可以进 git、可以分享），
//!   密钥单独一个文件，Windows 上用 DPAPI 按当前用户加密（换用户/换机器解不开）。
//! - 会话不用数据库：一条事件一行 JSON（JSONL）**追加写**，崩了也只丢最后半行；
//!   元信息单独一个小 JSON（标题/时间/模型），列表就不用读全文。
//! - 技能就是一个目录一份 `SKILL.md`（YAML frontmatter: name/description），
//!   跟 Codex 一样：索引进上下文，正文按需读。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ── 目录 ────────────────────────────────────────────────────────────

/// `<app_data_dir>/agent`（Windows 通常是 %APPDATA%\com.kyin.kdock\agent）
pub fn agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录: {e}"))?;
    let dir = base.join("agent");
    for sub in ["", "sessions", "skills", "skills-off", "workspace"] {
        let p = if sub.is_empty() { dir.clone() } else { dir.join(sub) };
        std::fs::create_dir_all(&p).map_err(|e| format!("建目录 {} 失败: {e}", p.display()))?;
    }
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // 先写临时文件再改名：写到一半崩了不会把好文件弄坏
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("改名到 {} 失败: {e}", path.display()))
}

// ── 供应商 profile ──────────────────────────────────────────────────

fn default_temperature() -> f32 { 0.2 }
fn default_context_window() -> u32 { 128_000 }
fn default_reserve_output() -> u32 { 8_192 }
fn default_max_messages() -> u32 { 40 }
fn default_true() -> bool { true }
fn default_kind() -> String { "openai".into() }

/// 按百万 token 计价的模型价格。峰价 / 谷价分开存，币种由用户选。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelPricing {
    #[serde(default)]
    pub currency: String,
    /// 用户显式启用后才按峰谷切换；关闭时统一走谷价字段。
    #[serde(default = "default_true")]
    pub peak_enabled: bool,
    #[serde(default)]
    pub peak_hit: f64,
    #[serde(default)]
    pub peak_miss: f64,
    #[serde(default)]
    pub peak_out: f64,
    #[serde(default)]
    pub offpeak_hit: f64,
    #[serde(default)]
    pub offpeak_miss: f64,
    #[serde(default)]
    pub offpeak_out: f64,
}

impl ModelPricing {
    pub fn cost(&self, peak: bool, hit: u64, miss: u64, out: u64) -> f64 {
        let (h, m, o) = if peak {
            (self.peak_hit, self.peak_miss, self.peak_out)
        } else {
            (self.offpeak_hit, self.offpeak_miss, self.offpeak_out)
        };
        (hit as f64 / 1e6) * h + (miss as f64 / 1e6) * m + (out as f64 / 1e6) * o
    }
}

/// 一个模型供应商 profile。`api_key_ref` 只是**密钥的名字**，密钥本体在 secrets 文件里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// 目前只做 OpenAI 兼容的 `/chat/completions`；留字段是为了以后接别的协议
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 形如 `https://api.deepseek.com/v1`（不带 `/chat/completions`）
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key_ref: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 这个模型允许在对话里选择的思考强度。空列表表示不启用该选项。
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
    /// 默认思考强度：空=不发送；none/minimal/low/medium/high/xhigh/max/ultra。
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default = "default_reserve_output")]
    pub reserve_output: u32,
    #[serde(default = "default_max_messages")]
    pub max_messages: u32,
    #[serde(default = "default_true")]
    pub supports_tools: bool,
    #[serde(default = "default_true")]
    pub supports_stream: bool,
    /// 老配置没有这一段；缺省时界面会按模型名给一份默认价格，保存后以这里为准。
    #[serde(default)]
    pub pricing: Option<ModelPricing>,
}

impl Provider {
    pub fn chat_url(&self) -> String {
        let base = self.endpoint.trim().trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") || base.ends_with("/api/v3") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    }
    pub fn models_url(&self) -> String {
        let base = self.endpoint.trim().trim_end_matches('/');
        let cut = base.find("/chat/completions").unwrap_or(base.len());
        format!("{}/models", &base[..cut])
    }
    /// 迁移并规范化思考强度列表：去空白、去重、保持顺序；旧单值自动并入。
    pub fn normalize_efforts(&mut self) {
        let mut out: Vec<String> = Vec::new();
        for v in &self.reasoning_efforts {
            let s = v.trim();
            if !s.is_empty() && !out.iter().any(|x| x == s) { out.push(s.to_string()); }
        }
        let single = self.reasoning_effort.trim();
        if !single.is_empty() && !out.iter().any(|x| x == single) { out.push(single.to_string()); }
        self.reasoning_efforts = out;
        if self.reasoning_effort.trim().is_empty() {
            self.reasoning_effort = self.reasoning_efforts.first().cloned().unwrap_or_default();
        }
    }
    pub fn reasoning_effort(&self) -> Option<&str> {
        let s = self.reasoning_effort.trim();
        (!s.is_empty()).then_some(s)
    }
    /// Anthropic extended thinking 的预算（token）。none/空 表示不启用。
    pub fn anthropic_thinking_budget(&self) -> Option<u32> {
        let effort = self.reasoning_effort()?;
        if effort == "none" {
            return None;
        }
        let requested = match effort {
            "minimal" => 1_024,
            "low" => 2_048,
            "medium" => 4_096,
            "high" => 8_192,
            "xhigh" => 16_384,
            "max" => 24_576,
            "ultra" => 32_768,
            _ => 4_096,
        };
        let max_tokens = self.reserve_output.max(2_048);
        Some(requested.min(max_tokens.saturating_sub(1_024)).max(1_024))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<Provider>,
}

pub fn providers_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("providers.json"))
}

pub fn load_providers(app: &AppHandle) -> ProviderConfig {
    let path = match providers_path(app) {
        Ok(p) => p,
        Err(_) => return ProviderConfig::default(),
    };
    read_json(&path).unwrap_or_default()
}

pub fn save_providers(app: &AppHandle, cfg: &ProviderConfig) -> Result<(), String> {
    write_json(&providers_path(app)?, cfg)
}

pub fn find_provider(cfg: &ProviderConfig, id: Option<&str>) -> Option<Provider> {
    let want = id
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| cfg.active_id.clone())?;
    cfg.providers.iter().find(|p| p.id == want).cloned()
}

// ── 密钥（Windows 用 DPAPI 按用户加密） ─────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SecretsFile {
    /// name -> "dpapi:<b64>" 或 "plain:<b64>"
    #[serde(default)]
    entries: std::collections::BTreeMap<String, String>,
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("secrets.json"))
}

pub fn secret_get(app: &AppHandle, name: &str) -> Option<String> {
    let file: SecretsFile = read_json(&secrets_path(app).ok()?).unwrap_or_default();
    let raw = file.entries.get(name)?;
    decode_secret(raw)
}

pub fn secret_set(app: &AppHandle, name: &str, value: &str) -> Result<(), String> {
    let path = secrets_path(app)?;
    let mut file: SecretsFile = read_json(&path).unwrap_or_default();
    if value.is_empty() {
        file.entries.remove(name);
    } else {
        file.entries.insert(name.to_string(), encode_secret(value)?);
    }
    write_json(&path, &file)
}

pub fn secret_names(app: &AppHandle) -> Vec<String> {
    read_json::<SecretsFile>(&secrets_path(app).unwrap_or_default())
        .unwrap_or_default()
        .entries
        .keys()
        .cloned()
        .collect()
}

/// 密钥方案说明（给 UI 显示用）
pub fn secret_scheme() -> &'static str {
    if cfg!(windows) { "dpapi" } else { "plain" }
}

fn encode_secret(value: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let enc = dpapi::protect(value.as_bytes())?;
        return Ok(format!("dpapi:{}", crate::upgrade::b64_encode(&enc)));
    }
    #[cfg(not(windows))]
    {
        Ok(format!("plain:{}", crate::upgrade::b64_encode(value.as_bytes())))
    }
}

fn decode_secret(raw: &str) -> Option<String> {
    let (kind, body) = raw.split_once(':')?;
    let bytes = crate::upgrade::b64_decode(body);
    match kind {
        "plain" => String::from_utf8(bytes).ok(),
        "dpapi" => {
            #[cfg(windows)]
            {
                let out = dpapi::unprotect(&bytes).ok()?;
                String::from_utf8(out).ok()
            }
            #[cfg(not(windows))]
            {
                let _ = bytes;
                None
            }
        }
        _ => None,
    }
}

#[cfg(windows)]
mod dpapi {
    //! 直接用 crypt32 的 DPAPI：按**当前 Windows 用户**加密，别的用户/别的机器解不开。
    //! （跟本项目其它 Windows 调用一样走 `#[link] extern "system"`，不引新依赖。）
    use std::ffi::c_void;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            descr: *const u16,
            entropy: *const DataBlob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            descr: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    fn blob_of(data: &[u8]) -> (DataBlob, Vec<u8>) {
        let mut copy = data.to_vec();
        let blob = DataBlob { cb_data: copy.len() as u32, pb_data: copy.as_mut_ptr() };
        (blob, copy)
    }

    /// 附加熵：同一个用户下，别的程序拿不到这段数据（可选，但加上更稳）
    const ENTROPY: &[u8] = b"KDock.agent.v1";

    fn call(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let (in_blob, _keep) = blob_of(data);
        let (ent_blob, _keep2) = blob_of(ENTROPY);
        let mut out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let ok = unsafe {
            if protect {
                CryptProtectData(&in_blob, std::ptr::null(), &ent_blob, std::ptr::null(),
                                 std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&in_blob, std::ptr::null_mut(), &ent_blob, std::ptr::null(),
                                   std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 {
            return Err(format!("DPAPI 调用失败: {}", std::io::Error::last_os_error()));
        }
        let result = unsafe { std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec() };
        unsafe { LocalFree(out.pb_data as *mut c_void) };
        Ok(result)
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> { call(data, true) }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> { call(data, false) }
}

// ── 会话（JSONL 追加写） ────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 会话里的一条事件。**只追加**，不改旧行 —— 这样"改历史"是不可能的，也就不会写坏。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// 用户说的
    User { text: String, #[serde(default)] ts: i64 },
    /// 模型说的（可能是空文本 + 只有工具调用）。
    /// `reasoning` 是"思考"内容：DeepSeek/GLM 这类推理模型，**带工具调用时必须原样带回去**，
    /// 否则下一轮会直接 400（The `reasoning_content` in the thinking mode must be passed back）。
    /// `model` 是**当时**用的模型名（界面在每条回复下面显示"模型 · 完成时间"；
    /// 老会话没有这个字段，反序列化成空串 → 界面只显示时间）
    Assistant { text: String, #[serde(default)] reasoning: String, #[serde(default)] ts: i64, #[serde(default)] model: String },
    /// 模型要调一个工具
    ToolCall { id: String, name: String, args: serde_json::Value, #[serde(default)] ts: i64 },
    /// 工具跑完的结果
    ToolResult { id: String, name: String, ok: bool, text: String, #[serde(default)] ts: i64 },
    /// 上下文压缩后的摘要（老消息被它顶掉）
    Summary { text: String, upto: usize, #[serde(default)] ts: i64 },
    /// 系统提示/事件（比如"用户点了停止"）
    Note { text: String, #[serde(default)] ts: i64 },
    /// 会话状态注记（权限/目标/称呼这类"随时可能变"的东西）。
    /// 为什么不放系统提示里：系统提示是前缀，改一个字它后面的整段历史缓存全作废；
    /// 注记是**追加在尾部**的，只在变更那一轮多几十个 token。
    State { text: String, #[serde(default)] ts: i64 },
}

impl Event {
    /// 事件时间戳（落盘 JSON 里本来就有 `ts`，这里给 Rust 侧读同一份数据用）。
    #[allow(dead_code)]
    pub fn ts(&self) -> i64 {
        match self {
            Event::User { ts, .. }
            | Event::Assistant { ts, .. }
            | Event::ToolCall { ts, .. }
            | Event::ToolResult { ts, .. }
            | Event::Summary { ts, .. }
            | Event::Note { ts, .. }
            | Event::State { ts, .. } => *ts,
        }
    }
    pub fn stamp(mut self) -> Self {
        let t = now_ms();
        match &mut self {
            Event::User { ts, .. }
            | Event::Assistant { ts, .. }
            | Event::ToolCall { ts, .. }
            | Event::ToolResult { ts, .. }
            | Event::Summary { ts, .. }
            | Event::Note { ts, .. }
            | Event::State { ts, .. } => {
                if *ts == 0 { *ts = t; }
            }
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created: i64,
    pub updated: i64,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    /// 这次会话的工作区（文件工具的根）
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub turns: u32,
    /// 属于哪个工作区（workspaces.json 里的 id）
    #[serde(default)]
    pub ws: String,
    /// 上一次请求时 provider 自己报的 prompt_tokens —— 压缩判断以它为准（估算器太乐观）
    #[serde(default)]
    pub last_tokens: u64,
    /// 这个会话累计的 token 账（给"Agent 信息"面板算花费/缓存命中率用）
    #[serde(default)]
    pub total_prompt: u64,
    #[serde(default)]
    pub total_completion: u64,
    /// 命中前缀缓存的输入 token（DeepSeek: prompt_cache_hit_tokens）
    #[serde(default)]
    pub total_cache_hit: u64,
    /// 没命中缓存的输入 token（DeepSeek: prompt_cache_miss_tokens）
    #[serde(default)]
    pub total_cache_miss: u64,
    /// 本会话累计花费，按币种分开（请求发生时按当时的峰/谷价记账）。
    #[serde(default)]
    pub cost_total: std::collections::BTreeMap<String, f64>,
    /// 已经被 `cost_total` 覆盖的 token 数。用来识别升级前没有计费记账的旧 token。
    #[serde(default)]
    pub cost_prompt_tokens: u64,
    #[serde(default)]
    pub cost_completion_tokens: u64,
    /// 最近一次真实响应生成的模型指纹（短 ID）
    #[serde(default)]
    pub model_fingerprint: String,
    #[serde(default)]
    pub fingerprint_model: String,
    #[serde(default)]
    pub fingerprint_system: String,
    #[serde(default)]
    pub fingerprint_family: String,
    #[serde(default)]
    pub fingerprint_family_source: String,
    #[serde(default)]
    pub fingerprint_provider: String,
    #[serde(default)]
    pub fingerprint_at: i64,
    /// 已经提示过"大头是系统提示+工具定义"了（同一个会话只弹一次 toast）
    #[serde(default)]
    pub warned_overhead: bool,
    /// **冻结的上下文骨架**：本会话第一次请求时把系统提示定型存这儿，
    /// 之后每一轮原样复用 —— 磁盘上的技能/指导文件改了也不动它，前缀才能一直命中。
    /// （想让它重新生成：界面上点「刷新骨架」，代价是本会话缓存重置一次。）
    #[serde(default)]
    pub system_prompt: String,
    /// 本会话冻结的工具清单（名字，按顺序）。工具定义在请求最前面，一变全都作废，
    /// 所以也按会话冻住；新会话才吃新的开关。
    #[serde(default)]
    pub tools: Vec<String>,
    /// 最近几轮的用量（每轮：prompt / 命中 / 未命中 / 输出），给界面看命中率走势。
    /// 只留最近 40 轮，不做累积（累积看 total_* 那几个）。
    #[serde(default)]
    pub usage_recent: Vec<serde_json::Value>,
    /// 权限：read(只读) / ask(危险动作先问) / auto(自动)
    #[serde(default = "default_perm")]
    pub perm: String,
    /// 用户点过「本会话都允许」的工具名：这些不再弹审批（一次任务里点 20 多次太累）
    #[serde(default)]
    pub allow: Vec<String>,
    /// 细粒度命令白名单：`local_run`/`workspace_run`/`ssh_run` 允许的命令前缀
    #[serde(default)]
    pub allow_cmd: Vec<String>,
    /// 本会话的显式计划（plan_write 写入，供 plan_read/前端查看）
    #[serde(default)]
    pub plan: Vec<serde_json::Value>,
    /// 用户用 `/goal` 设定的目标（一直生效，每轮都会进系统提示）
    #[serde(default)]
    pub goal: String,
    /// 这个会话里怎么称呼用户（第一轮由模型从"用户自称 / 身份技能"里总结，≤16 字；空=用「你」）
    #[serde(default)]
    pub user_name: String,
    /// 这个会话里 agent 自称什么（同上；空=用「Agent」）
    #[serde(default)]
    pub agent_name: String,
}

fn default_perm() -> String {
    "ask".into()
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("sessions"))
}

fn session_jsonl(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(app)?.join(format!("{}.jsonl", safe_id(id))))
}
fn session_meta(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(app)?.join(format!("{}.meta.json", safe_id(id))))
}

fn session_tools_schema(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(app)?.join(format!("{}.tools.json", safe_id(id))))
}

/// 完整工具 schema 单独落一个会话文件：它只供请求与统计使用，不随 sessions_list
/// 重复传给前端，避免会话多时刷新会话树被几十 KB 的 schema 拖慢。
pub fn session_tool_schemas_get(app: &AppHandle, id: &str) -> Vec<serde_json::Value> {
    session_tools_schema(app, id)
        .ok()
        .and_then(|p| read_json(&p))
        .unwrap_or_default()
}

pub fn session_tool_schemas_save(app: &AppHandle, id: &str, schemas: &[serde_json::Value]) -> Result<(), String> {
    write_json(&session_tools_schema(app, id)?, &schemas)
}

/// 只允许字母数字和 `-_.`，防止拿 id 拼路径时跑到外面去
pub fn safe_id(id: &str) -> String {
    let s: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if s.is_empty() { "s".into() } else { s }
}

pub fn sessions_list(app: &AppHandle) -> Vec<SessionMeta> {
    let dir = match sessions_dir(app) { Ok(d) => d, Err(_) => return Vec::new() };
    // 会话一多，"每次都把所有 meta.json 读一遍"就很贵（agLoadTree 调用很频繁）。
    // 用 (文件名 + mtime) 当指纹缓存：目录没变就直接复用。
    let sig = dir_signature(&dir, ".meta.json");
    if let Some((s, v)) = SESSIONS_CACHE.lock().ok().and_then(|g| g.clone()) {
        if s == sig {
            return v;
        }
    }
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".meta.json") {
                if let Some(mut meta) = read_json::<SessionMeta>(&path) {
                    if meta.id.is_empty() { meta.id = id.to_string(); }
                    out.push(meta);
                }
            }
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    if let Ok(mut g) = SESSIONS_CACHE.lock() {
        *g = Some((sig, out.clone()));
    }
    out
}

/// 会话列表缓存：(目录指纹, 列表)
static SESSIONS_CACHE: std::sync::LazyLock<std::sync::Mutex<Option<(String, Vec<SessionMeta>)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// 目录指纹：只看"文件名 + 修改时间"，比把每个 JSON 读出来解析便宜得多
fn dir_signature(dir: &Path, suffix: &str) -> String {
    dir_signature_inner(dir, Some(suffix))
}

/// 同上，但不过滤后缀（技能目录那种"里面全是子目录"的场景用）
fn dir_signature_all(dir: &Path) -> String {
    dir_signature_inner(dir, None)
}

fn dir_signature_inner(dir: &Path, suffix: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(sfx) = suffix {
                if !n.ends_with(sfx) {
                    continue;
                }
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir && suffix.is_none() {
                // 不过滤后缀时只关心目录（技能就是子目录）
                continue;
            }
            let t = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            parts.push(format!("{n}:{t}"));
        }
    }
    parts.sort();
    parts.join("|")
}

pub fn session_new(app: &AppHandle, title: &str, workspace: &str) -> Result<SessionMeta, String> {
    let ts = now_ms();
    let meta = SessionMeta {
        id: format!("s{ts}-{}", (ts % 1000).abs()),
        title: if title.trim().is_empty() { "新会话".into() } else { title.trim().to_string() },
        created: ts,
        updated: ts,
        provider_id: String::new(),
        model: String::new(),
        workspace: workspace.to_string(),
        ws: String::new(),
        last_tokens: 0,
        total_prompt: 0,
        total_completion: 0,
        total_cache_hit: 0,
        total_cache_miss: 0,
        cost_total: std::collections::BTreeMap::new(),
        cost_prompt_tokens: 0,
        cost_completion_tokens: 0,
        model_fingerprint: String::new(),
        fingerprint_model: String::new(),
        fingerprint_system: String::new(),
        fingerprint_family: String::new(),
        fingerprint_family_source: String::new(),
        fingerprint_provider: String::new(),
        fingerprint_at: 0,
        warned_overhead: false,
        system_prompt: String::new(),
        tools: Vec::new(),
        usage_recent: Vec::new(),
        turns: 0,
        perm: default_perm(),
        allow: Vec::new(),
        allow_cmd: Vec::new(),
        plan: Vec::new(),
        goal: String::new(),
        user_name: String::new(),
        agent_name: String::new(),
    };
    std::fs::File::create(session_jsonl(app, &meta.id)?).map_err(|e| e.to_string())?;
    write_json(&session_meta(app, &meta.id)?, &meta)?;
    Ok(meta)
}

pub fn session_update_meta(app: &AppHandle, meta: &SessionMeta) -> Result<(), String> {
    write_json(&session_meta(app, &meta.id)?, meta)
}

pub fn session_meta_of(app: &AppHandle, id: &str) -> Option<SessionMeta> {
    let path = session_meta(app, id).ok()?;
    let mut meta: SessionMeta = read_json(&path)?;
    if meta.id.is_empty() { meta.id = id.to_string(); }
    Some(meta)
}

pub fn session_touch(app: &AppHandle, id: &str) -> Option<SessionMeta> {
    let mut meta = session_meta_of(app, id)?;
    meta.updated = now_ms();
    meta.turns += 1;
    let _ = session_update_meta(app, &meta);
    Some(meta)
}

/// 追加一条事件（一行 JSON）。**每次打开追加**，所以掉电最多丢最后一行。
pub fn session_append(app: &AppHandle, id: &str, event: &Event) -> Result<(), String> {
    let path = session_jsonl(app, id)?;
    let mut line = serde_json::to_string(&event.clone().stamp()).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开会话文件失败: {e}"))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("写会话失败: {e}"))?;
    let _ = f.flush();
    Ok(())
}

/// 原始 JSONL 文本（**包含已经被摘要覆盖的那部分**）—— history_search 用
pub fn session_raw(app: &AppHandle, id: &str) -> String {
    session_jsonl(app, id)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

pub fn session_read(app: &AppHandle, id: &str) -> Vec<Event> {
    let path = match session_jsonl(app, id) { Ok(p) => p, Err(_) => return Vec::new() };
    let text = match std::fs::read_to_string(&path) { Ok(t) => t, Err(_) => return Vec::new() };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Event>(l).ok())
        .collect()
}

pub fn session_delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(session_jsonl(app, id)?);
    let _ = std::fs::remove_file(session_meta(app, id)?);
    let _ = std::fs::remove_file(session_tools_schema(app, id)?);
    Ok(())
}

/// 压缩：**只追加**一条 summary 事件，标记"第 upto 条之前的内容已经被它顶替了"。
/// 原始事件一条都不删 —— 这跟 codex 的 rollout 一个意思：模型输入用摘要，
/// 但人（和 agent 自己用 history_search）还能翻到原文。
pub fn session_mark_summary(app: &AppHandle, id: &str, upto: usize, summary: &str) -> Result<(), String> {
    session_append(app, id, &Event::Summary { text: summary.to_string(), upto, ts: 0 })
}

/// 会话里"已经被摘要覆盖到第几条"（取最大值）
pub fn summary_upto(events: &[Event]) -> usize {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Summary { upto, .. } => Some(*upto),
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

/// 最后一条摘要的正文（拼起来：滚动摘要）
pub fn summary_text(events: &[Event]) -> Option<String> {
    let idx = events.iter().rposition(|e| matches!(e, Event::Summary { .. }))?;
    match &events[idx] {
        Event::Summary { text, .. } => Some(text.clone()),
        _ => None,
    }
}

// ── 工作区（像 Codex：工作区里装对话） ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// 这个工作区的根目录（agent 的文件工具都限制在里面）
    pub path: String,
    #[serde(default)]
    pub created: i64,
}

fn workspaces_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("workspaces.json"))
}

pub fn load_workspaces(app: &AppHandle) -> Vec<Workspace> {
    read_json(&workspaces_path(app).unwrap_or_default()).unwrap_or_default()
}

pub fn save_workspaces(app: &AppHandle, list: &[Workspace]) -> Result<(), String> {
    write_json(&workspaces_path(app)?, &list.to_vec())
}

/// 默认工作区（就是 <app_data>/agent/workspace）
pub fn default_workspace_entry(app: &AppHandle) -> Workspace {
    let p = default_workspace(app);
    let _ = std::fs::create_dir_all(&p);
    Workspace {
        id: "default".into(),
        name: "默认工作区".into(),
        path: p.to_string_lossy().to_string(),
        created: now_ms(),
    }
}

/// 从 serial tool 改名成 KDock 时留下的历史遗留：默认工作区还指在旧的数据目录
/// （`%APPDATA%\com.kyin.serialtool\agent\workspace`）里。
/// 只迁移"确实是老的默认工作区"这一种（路径里带旧 app id、尾巴正好是 `agent\workspace`），
/// 用户自己挑的目录一律不动；旧目录里的文件**复制**过来，不删原件。
fn migrate_legacy_default_workspace(app: &AppHandle, list: &mut [Workspace]) {
    let newp = default_workspace(app);
    let news = newp.to_string_lossy().to_string();
    let mut moved: Vec<std::path::PathBuf> = Vec::new();
    let mut changed = false;
    for w in list.iter_mut() {
        if w.path == news {
            continue;
        }
        let low = w.path.to_lowercase();
        let is_legacy = low.contains("serialtool")
            && (low.ends_with("\\agent\\workspace") || low.ends_with("/agent/workspace"));
        if !is_legacy {
            continue;
        }
        moved.push(std::path::PathBuf::from(&w.path));
        w.path = news.clone();
        changed = true;
    }
    if !changed {
        return;
    }
    let _ = std::fs::create_dir_all(&newp);
    for old in &moved {
        copy_tree(old, &newp);
    }
    // 会话里记的工作区路径也一起换过来（不然 agent 还往旧目录里写）
    for m in sessions_list(app) {
        let hit = moved.iter().any(|o| o.to_string_lossy() == m.workspace.as_str());
        if !hit {
            continue;
        }
        let mut m2 = m;
        m2.workspace = news.clone();
        if m2.ws.is_empty() {
            m2.ws = list.first().map(|w| w.id.clone()).unwrap_or_else(|| "default".into());
        }
        let _ = session_update_meta(app, &m2);
    }
}

/// 尽力而为地把一个目录树复制过去（同名文件已存在就跳过，绝不覆盖、绝不删除）
fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(from) else { return };
    for e in rd.flatten() {
        let src = e.path();
        let Some(name) = src.file_name() else { continue };
        let dst = to.join(name);
        if src.is_dir() {
            if std::fs::create_dir_all(&dst).is_ok() {
                copy_tree(&src, &dst);
            }
        } else if !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

/// 没有就建一个默认的；顺便把"还没有归属"的老会话挂到对应工作区上
pub fn ensure_workspaces(app: &AppHandle) -> Vec<Workspace> {
    let mut list = load_workspaces(app);
    if list.is_empty() {
        list.push(default_workspace_entry(app));
    }
    migrate_legacy_default_workspace(app, &mut list);
    let mut dirty = false;
    for m in sessions_list(app) {
        if !m.ws.is_empty() {
            continue;
        }
        let target = list
            .iter()
            .find(|w| !m.workspace.is_empty() && w.path == m.workspace)
            .cloned()
            .unwrap_or_else(|| list[0].clone());
        let mut m2 = m;
        m2.ws = target.id.clone();
        if m2.workspace.trim().is_empty() {
            m2.workspace = target.path.clone();
        }
        if session_update_meta(app, &m2).is_ok() {
            dirty = true;
        }
    }
    let _ = dirty;
    if save_workspaces(app, &list).is_err() {
        return list;
    }
    list
}

pub fn workspace_by_id(app: &AppHandle, id: &str) -> Option<Workspace> {
    ensure_workspaces(app).into_iter().find(|w| w.id == id)
}

pub fn new_workspace(path: &str, name: &str) -> Workspace {
    let ts = now_ms();
    let p = PathBuf::from(path);
    let fallback = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "工作区".into());
    Workspace {
        id: format!("w{ts}"),
        name: if name.trim().is_empty() { fallback } else { name.trim().to_string() },
        path: path.to_string(),
        created: ts,
    }
}

// ── 技能（一份 SKILL.md 一个技能，跟 Codex 一个路子） ───────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub size: u64,
    /// 开关：关掉的技能会挪到 `skills-off/`，不进口令索引，也不会被系统主动提及。
    pub enabled: bool,
    /// 哪一层的技能：global（用户级，agent/skills/） / workspace（项目级，<工作区>/.kdock_skill/）
    /// —— 界面按这个分三段显示，索引也分两段注入
    #[serde(default)]
    pub scope: String,
}

/// 工作区里的项目技能目录（跟 Codex 的工程约定一个思路：项目自己的东西放项目里）
pub const WORKSPACE_SKILL_DIR: &str = ".kdock_skill";

/// 工作区技能目录"按需创建"：**代码保证**它存在（不依赖 agent 记得去看）。
/// 顺手放一个内容为 `*` 的 .gitignore —— 否则用户的仓库 git status 会被这个目录污染。
pub fn ensure_workspace_skill_dir(ws: &std::path::Path) -> std::path::PathBuf {
    let d = ws.join(WORKSPACE_SKILL_DIR);
    let _ = std::fs::create_dir_all(&d);
    let gi = d.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, "*\n");
    }
    d
}

/// 工作区技能（项目级）：全都在用，没有启用/停用一说的那种 —— 存在即生效
pub fn workspace_skills(ws: &std::path::Path) -> Vec<SkillInfo> {
    let dir = ensure_workspace_skill_dir(ws);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let md = path.join("SKILL.md");
        let Ok(text) = std::fs::read_to_string(&md) else { continue };
        let (fm, _body) = parse_frontmatter(&text);
        let dir_name = entry.file_name().to_string_lossy().to_string();
        out.push(SkillInfo {
            slug: dir_name.clone(),
            name: fm.get("name").cloned().unwrap_or_else(|| dir_name.clone()),
            description: fm.get("description").cloned().unwrap_or_default(),
            path: md.to_string_lossy().to_string(),
            size: std::fs::metadata(&md).map(|m| m.len()).unwrap_or(0),
            enabled: true,
            scope: "workspace".into(),
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("skills"))
}

/// 停用的技能放这儿：目录位置本身就是"开关状态"，比在文件里记一个标记更直观
fn skills_off_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("skills-off"))
}

pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() { out.push(c.to_ascii_lowercase()); }
        else if c == '-' || c == '_' || c == ' ' || c == '.' { out.push('-'); }
        else if !c.is_ascii() { out.push(c); }   // 中文技能名也允许
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "skill".into() } else { out }
}

/// 极简 frontmatter 解析：只认开头 `---` 里的 `key: value`
pub(crate) fn parse_frontmatter(text: &str) -> (std::collections::BTreeMap<String, String>, String) {
    let mut map = std::collections::BTreeMap::new();
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    if let Some(rest) = t.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let head = &rest[..end];
            for line in head.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    map.insert(k.trim().to_lowercase(), v.trim().trim_matches('"').to_string());
                }
            }
            let body = rest[end + 4..].trim_start_matches(['\n', '\r']).to_string();
            return (map, body);
        }
    }
    (map, t.to_string())
}

pub fn skills_list(app: &AppHandle) -> Vec<SkillInfo> {
    let dir = match skills_dir(app) { Ok(d) => d, Err(_) => return Vec::new() };
    let off = skills_off_dir(app).unwrap_or_else(|_| dir.clone());
    // 系统提示每轮都要用这份索引，而它要读每个 SKILL.md —— 会话/技能多了就贵。
    // 用目录指纹缓存。
    // 注意：技能目录里装的是"一个技能一个子目录"，不是文件 —— 签名要把所有条目都算上
    // （按 SKILL.md 后缀过滤会得到空签名，缓存就永远不失效了，实测踩过）。
    let sig = format!("{}||{}", dir_signature_all(&dir), dir_signature_all(&off));
    if let Some((s, v)) = SKILLS_CACHE.lock().ok().and_then(|g| g.clone()) {
        if s == sig {
            return v;
        }
    }
    let mut out = Vec::new();
    for (base, enabled) in [(&dir, true), (&off, false)] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for entry in rd.flatten() {
                let path = entry.path();
                if !path.is_dir() { continue; }
                let md = path.join("SKILL.md");
                let Ok(text) = std::fs::read_to_string(&md) else { continue };
                let (fm, _body) = parse_frontmatter(&text);
                let dir_name = entry.file_name().to_string_lossy().to_string();
                out.push(SkillInfo {
                    slug: dir_name.clone(),
                    name: fm.get("name").cloned().unwrap_or_else(|| dir_name.clone()),
                    description: fm.get("description").cloned().unwrap_or_default(),
                    path: md.to_string_lossy().to_string(),
                    size: std::fs::metadata(&md).map(|m| m.len()).unwrap_or(0),
                    enabled,
                    scope: "global".into(),
                });
            }
        }
    }
    // 启用的排前面，再按名字
    out.sort_by(|a, b| b.enabled.cmp(&a.enabled).then(a.slug.cmp(&b.slug)));
    if let Ok(mut g) = SKILLS_CACHE.lock() {
        *g = Some((sig, out.clone()));
    }
    out
}

/// 技能列表缓存：(目录指纹, 列表)
static SKILLS_CACHE: std::sync::LazyLock<std::sync::Mutex<Option<(String, Vec<SkillInfo>)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// 技能在哪个目录（启用的优先）；读/删/改都用它
fn skill_dir_of(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    let dir = skills_dir(app)?.join(slugify(slug));
    if dir.is_dir() {
        return Ok(dir);
    }
    let off = skills_off_dir(app)?.join(slugify(slug));
    if off.is_dir() {
        return Ok(off);
    }
    Ok(dir) // 不存在时返回"启用目录"下的路径，交给调用方报错
}

/// 开关一个技能：在两个目录之间搬（这就是"能不能用"的唯一事实）
pub fn skill_set_enabled(app: &AppHandle, slug: &str, on: bool) -> Result<String, String> {
    let s = slugify(slug);
    let (from, to) = if on {
        (skills_off_dir(app)?.join(&s), skills_dir(app)?.join(&s))
    } else {
        (skills_dir(app)?.join(&s), skills_off_dir(app)?.join(&s))
    };
    if !from.is_dir() {
        // 已经在目标状态里了
        if to.is_dir() {
            return Ok(to.to_string_lossy().to_string());
        }
        return Err(format!("找不到技能 {slug}"));
    }
    if to.exists() {
        let _ = std::fs::remove_dir_all(&to);
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("切换失败: {e}"))?;
    if !on {
        // 老版本把「常驻技能」正文搬进了 AGENTS.md；技能后来被关掉时，
        // 正文必须同步移除，否则 agent 每轮仍会在系统提示里看到它。
        let _ = prune_disabled_migrated_guidance(app);
    }
    Ok(to.to_string_lossy().to_string())
}

// ── 常驻技能（每轮把正文注入系统提示的技能）──────────────────────────
// 技能正文平时是"按需读"：系统提示里只有一行索引（见 skills_index），正文要模型自己 skill_read。
// 这对"身份 / 口吻 / 说话规则"这类技能不够用 —— 问"你是谁"时没有任何线索提示它去读，读了也会
// 随轮次被 trim、被摘要挤掉。所以单独记一份"常驻"清单：勾上的技能，正文每轮拼进系统提示
// （系统提示永远不被裁剪和压缩，人格才能一直生效）。
// 三个"不动"：不动 SKILL.md（用户的原始技能一个字不用改）、不动 skills/ 目录结构（enabled 照旧）、
// 不动系统提示里那句通用角色描述（优先级由注入段自己声明）。
//
// 存成一串 slug 的 JSON 数组，**写之前排序去重**：系统提示是要吃前缀缓存的，顺序一变前缀就废。
#[allow(dead_code)]
pub const SKILLS_ALWAYS_LIMIT: usize = 16 * 1024;

fn skills_always_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(agent_dir(app)?.join("skills-always.json"))
}

/// 给迁移用：老「常驻技能」清单文件的路径（已经不参与系统提示了）
pub fn skills_always_path_pub(app: &AppHandle) -> Option<std::path::PathBuf> {
    skills_always_path(app).ok()
}

/// 常驻技能的 slug 清单（没文件 / 文件坏了都当"没有"）。排序去重，读的是纯文件，好测。
fn skills_always_read(path: &std::path::Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let mut out: Vec<String> = v
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

#[allow(dead_code)]
fn skills_always_write_to(path: &std::path::Path, slugs: &[String]) -> Result<(), String> {
    let mut v: Vec<String> = slugs.to_vec();
    v.sort();
    v.dedup();
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("改名到 {} 失败: {e}", path.display()))
}

pub fn skills_always(app: &AppHandle) -> Vec<String> {
    match skills_always_path(app) {
        Ok(p) => skills_always_read(&p),
        Err(_) => Vec::new(),
    }
}

/// 从本机导入一个技能：给 `SKILL.md` 的路径，或者"装着 SKILL.md 的目录"
pub fn skill_import(app: &AppHandle, src: &str) -> Result<String, String> {
    let p = PathBuf::from(src.trim());
    let (md, folder) = if p.is_dir() {
        (p.join("SKILL.md"), p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "skill".into()))
    } else {
        let name = p
            .parent()
            .and_then(|d| d.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "skill".into()));
        (p.clone(), name)
    };
    let text = std::fs::read_to_string(&md).map_err(|e| format!("读 {} 失败: {e}", md.display()))?;
    if !text.contains("---") {
        return Err("这个文件不像 SKILL.md（缺少 frontmatter）".into());
    }
    let (fm, _) = parse_frontmatter(&text);
    let slug = slugify(fm.get("name").cloned().unwrap_or(folder).as_str());
    let target = skills_dir(app)?.join(&slug);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::write(target.join("SKILL.md"), text).map_err(|e| format!("写失败: {e}"))?;
    Ok(target.join("SKILL.md").to_string_lossy().to_string())
}

pub fn skill_read(app: &AppHandle, slug: &str) -> Result<String, String> {
    let path = skill_dir_of(app, slug)?.join("SKILL.md");
    std::fs::read_to_string(&path).map_err(|e| format!("读技能失败: {e}"))
}

pub fn skill_write(app: &AppHandle, slug: &str, content: &str) -> Result<String, String> {
    let dir = skills_dir(app)?.join(slugify(slug));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("SKILL.md");
    std::fs::write(&path, content).map_err(|e| format!("写技能失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn skill_delete(app: &AppHandle, slug: &str) -> Result<(), String> {
    let dir = skill_dir_of(app, slug)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删技能失败: {e}"))
}

/// 给系统提示用的技能索引（只有名字 + 描述，正文按需读）
pub fn skills_index(app: &AppHandle) -> String {
    // 只有**启用**的技能进口令索引（关掉的挪在 skills-off/ 里）
    let list: Vec<SkillInfo> = skills_list(app).into_iter().filter(|s| s.enabled).collect();
    if list.is_empty() {
        return "（还没有技能）".to_string();
    }
    list.iter()
        .map(|s| {
            let d = if s.description.is_empty() { "（无描述）".to_string() } else { s.description.clone() };
            format!("- {} — {}", s.slug, d)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/* ── 指导文件（AGENTS.md）："一直在场"的规则/人格走这里，而不是靠技能常驻 ─────────
   这是照 Codex 的分工来的：AGENTS.md 是**持久的、每轮都在**的项目/个人约定，
   技能（SKILL.md）是**按需读**的可复用流程。以前 KDock 用"常驻技能"把人格塞进系统提示，
   那是拿技能当指导文件用；现在把这条归位 —— 人格/身份/口吻写全局指导或工作区 AGENTS.md。 */

/// 全局指导：`agent/AGENTS.md`（个人级，一直在场）
pub fn global_guidance_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("AGENTS.md"))
}

/* ── 大工具结果的落盘（tool-output/）──────────────────────────────────────
   照 opencode 的做法：超过内联上限的工具结果**只截一段进上下文**，全文写到
   `agent/tool-output/` 下的文件里，并在结果里给出路径 —— 模型要看全量就用
   output_read 读那段文件。好处是"上下文里永远是小的"（Δ 小 → 缓存命中率高），
   信息又没丢。文件 7 天后自动清理（跟 opencode 的 RETENTION 一致）。 */

pub const TOOL_OUTPUT_KEEP_DAYS: u64 = 7;

pub fn tool_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = agent_dir(app)?.join("tool-output");
    std::fs::create_dir_all(&d).map_err(|e| format!("建 {} 失败: {e}", d.display()))?;
    Ok(d)
}

/// 把全文写进去，返回路径。顺手清掉过期文件（只在写的时候清，够用了，不用后台任务）。
pub fn tool_output_write(app: &AppHandle, tool: &str, text: &str) -> Result<String, String> {
    let dir = tool_output_dir(app)?;
    let name = format!("tool_{}_{}.txt", now_ms(), slugify(tool));
    let path = dir.join(&name);
    std::fs::write(&path, text).map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
    let cutoff = now_ms() - (TOOL_OUTPUT_KEEP_DAYS as i64) * 86_400_000;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let old = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| (d.as_millis() as i64) < cutoff)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(path.to_string_lossy().to_string())
}

/// 读回落盘的工具输出。**只允许读 tool-output 目录里的文件**（别的路径一律拒），
/// 免得这条路变成"绕过工作区限制读任意文件"的后门。
pub fn tool_output_read(app: &AppHandle, path: &str, offset: usize, limit: usize) -> Result<String, String> {
    let dir = tool_output_dir(app)?;
    let want = PathBuf::from(path.trim());
    // 允许传文件名，也允许传完整路径；但解析后必须在 tool-output 目录里
    let resolved = if want.is_absolute() { want } else { dir.join(want) };
    let canon_dir = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let canon = std::fs::canonicalize(&resolved).map_err(|e| format!("读不到 {}: {e}", resolved.display()))?;
    if !canon.starts_with(&canon_dir) {
        return Err("只能读 tool-output 目录里的文件".into());
    }
    let text = std::fs::read_to_string(&canon).map_err(|e| format!("读 {} 失败: {e}", canon.display()))?;
    let total = text.chars().count();
    let off = offset.min(total);
    let take = if limit == 0 { 8000 } else { limit.min(40000) };
    let body: String = text.chars().skip(off).take(take).collect();
    Ok(format!(
        "（{}/{} 字起，共 {} 字）\n{}",
        off, take, total, body
    ))
}

/* ── 工具清单开关：`agent/tools-off.json`（一串工具名）────────────────────────
   工具定义在请求的**最前面**，内容是十几个 KB 的大头。关掉用不上的工具能省 token，
   但**中途改会让整个前缀（含全部历史）作废** —— 所以开关按会话冻结：改了下一个新会话生效。 */

fn tools_off_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("tools-off.json"))
}

pub fn tools_off(app: &AppHandle) -> Vec<String> {
    let mut v: Vec<String> = tools_off_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    v.sort();
    v.dedup();
    v
}

pub fn tools_off_set(app: &AppHandle, name: &str, off: bool) -> Result<(), String> {
    tools_off_set_many(app, &[name.to_string()], off)
}

pub fn tools_off_set_many(app: &AppHandle, names: &[String], off: bool) -> Result<(), String> {
    let mut cur = tools_off(app);
    for name in names {
        if off {
            if !cur.contains(name) {
                cur.push(name.clone());
            }
        } else {
            cur.retain(|x| x != name);
        }
    }
    cur.sort();
    cur.dedup();
    let p = tools_off_path(app)?;
    let text = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("改名失败: {e}"))
}

pub fn read_global_guidance(app: &AppHandle) -> String {
    global_guidance_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

pub fn write_global_guidance(app: &AppHandle, text: &str) -> Result<String, String> {
    let p = global_guidance_path(app)?;
    std::fs::write(&p, text).map_err(|e| format!("写 {} 失败: {e}", p.display()))?;
    Ok(p.to_string_lossy().to_string())
}

/// 工作区指导：`<工作区>/AGENTS.md`
pub fn read_workspace_guidance(ws: &std::path::Path) -> String {
    std::fs::read_to_string(ws.join("AGENTS.md")).unwrap_or_default()
}

/* ── 技能归档（skill-archive/）：工作区技能的唯一备份 ──────────────────────
   为什么另开一个目录、不塞进 skills-off/：
     · skills_list() 会扫 skills/ 和 skills-off/ —— 放进去就会以"停用的全局技能"
       出现在全局列表里（还可能被误启用）。"全局停用"和"已下放到项目"是两回事。
     · 归档要额外记住"属于哪个工作区"，skills-off/ 那种"目录即状态"装不下。
     · 缓存页可以把归档单列一项，删除/还原都清楚。 */

pub fn skill_archive_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("skill-archive"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveInfo {
    pub slug: String,
    pub workspace: String,
    pub from: String,      // 从哪儿来的：global / workspace
    pub ts: i64,
    pub path: String,
    pub size: u64,
}

/// 把一份技能目录拷进归档（同名先删旧的），并写 meta.json 记来源
pub fn archive_skill(app: &AppHandle, src_dir: &std::path::Path, workspace: &str, from: &str) -> Result<String, String> {
    let slug = src_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("目录名拿不到")?;
    let dst = skill_archive_dir(app)?.join(&slug);
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| format!("清旧归档失败: {e}"))?;
    }
    copy_dir(src_dir, &dst)?;
    let meta = ArchiveInfo {
        slug: slug.clone(),
        workspace: workspace.to_string(),
        from: from.to_string(),
        ts: now_ms(),
        path: dst.to_string_lossy().to_string(),
        size: std::fs::metadata(dst.join("SKILL.md")).map(|m| m.len()).unwrap_or(0),
    };
    std::fs::write(dst.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap_or_default())
        .map_err(|e| format!("写 meta.json 失败: {e}"))?;
    Ok(dst.to_string_lossy().to_string())
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("建 {} 失败: {e}", dst.display()))?;
    for e in std::fs::read_dir(src).map_err(|e| format!("读 {} 失败: {e}", src.display()))?.flatten() {
        let p = e.path();
        let to = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &to)?;
        } else {
            std::fs::copy(&p, &to).map_err(|e| format!("拷 {} 失败: {e}", p.display()))?;
        }
    }
    Ok(())
}

pub fn archive_list(app: &AppHandle) -> Vec<ArchiveInfo> {
    let mut out = Vec::new();
    let Ok(dir) = skill_archive_dir(app) else { return out };
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let slug = e.file_name().to_string_lossy().to_string();
        if slug.starts_with('.') {
            continue;
        }
        let meta: Option<ArchiveInfo> = std::fs::read_to_string(p.join("meta.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        out.push(match meta {
            Some(mut m) => {
                m.path = p.to_string_lossy().to_string();
                if m.size == 0 {
                    m.size = std::fs::metadata(p.join("SKILL.md")).map(|x| x.len()).unwrap_or(0);
                }
                m
            }
            None => ArchiveInfo {
                slug: slug.clone(),
                workspace: String::new(),
                from: String::new(),
                ts: 0,
                path: p.to_string_lossy().to_string(),
                size: std::fs::metadata(p.join("SKILL.md")).map(|x| x.len()).unwrap_or(0),
            },
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 从归档还原：scope = global（放回全局 skills/）或 workspace（放回指定工作区）
pub fn archive_restore(app: &AppHandle, slug: &str, scope: &str, workspace: &str) -> Result<String, String> {
    let src = skill_archive_dir(app)?.join(slugify(slug));
    if !src.is_dir() {
        return Err(format!("归档里没有这个技能：{slug}"));
    }
    if scope == "workspace" {
        if workspace.trim().is_empty() {
            return Err("还原到工作区要指定工作区".into());
        }
        let ws = PathBuf::from(workspace);
        std::fs::create_dir_all(&ws).map_err(|e| e.to_string())?;
        let dst = ensure_workspace_skill_dir(&ws).join(slugify(slug));
        if dst.exists() {
            std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
        }
        copy_dir(&src, &dst)?;
        return Ok(dst.to_string_lossy().to_string());
    }
    let dst = skills_dir(app)?.join(slugify(slug));
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir(&src, &dst)?;
    Ok(dst.to_string_lossy().to_string())
}

pub fn archive_delete(app: &AppHandle, slug: &str) -> Result<(), String> {
    let p = skill_archive_dir(app)?.join(slugify(slug));
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("删归档失败: {e}"))?;
    }
    Ok(())
}

/// 把全局技能"转为工作区专属"：复制到 <工作区>/.kdock_skill/ + 归档一份备份 + 从全局移除。
/// 反向的"提升为全局"用 archive_restore(scope="global") 就够了。
pub fn skill_convert_to_workspace(app: &AppHandle, slug: &str, workspace: &str) -> Result<String, String> {
    if workspace.trim().is_empty() {
        return Err("要指定一个工作区".into());
    }
    let ws = PathBuf::from(workspace);
    std::fs::create_dir_all(&ws).map_err(|e| format!("建工作区失败: {e}"))?;
    let src = skill_dir_of(app, slug)?;
    if !src.is_dir() {
        return Err(format!("没有这个技能：{slug}"));
    }
    // ① 先备份
    let backup = archive_skill(app, &src, workspace, "global")?;
    // ② 再复制到工作区
    let dst = ensure_workspace_skill_dir(&ws).join(slugify(slug));
    if dst.exists() {
        return Err(format!("工作区里已经有同名技能了：{}", dst.display()));
    }
    copy_dir(&src, &dst)?;
    // ③ 从全局移除（启用目录 / 停用目录都清）
    let _ = std::fs::remove_dir_all(skills_dir(app)?.join(slugify(slug)));
    let _ = std::fs::remove_dir_all(skills_off_dir(app)?.join(slugify(slug)));
    Ok(format!("{}（备份在 {}）", dst.to_string_lossy(), backup))
}

/// 三段一起的索引：内置之外的两段技能（全局 + 本项目），正文按需读。
/// 顺序**按 slug 排序**、文本里不含大小/时间 —— 系统提示要拿前缀缓存，稳字第一。
pub fn skills_index_for(app: &AppHandle, ws: &std::path::Path) -> String {
    let mut out = String::new();
    out.push_str(&skills_index_global(app));
    out.push_str(&skills_index_workspace(ws));
    out
}

/// 全局技能的索引段（**跟项目无关**：换个工作区这段也一模一样 ——
/// 系统提示里"先稳后变"的排序就是为了这个，跨工作区也能吃到同一段前缀缓存）
pub fn skills_index_global(app: &AppHandle) -> String {
    let global: Vec<SkillInfo> = skills_list(app).into_iter().filter(|s| s.enabled).collect();
    let mut out = String::new();
    out.push_str("全局技能（用户级：任务匹配到某个技能的描述时，先用 skill_read 读全文再照它做）：\n");
    if global.is_empty() {
        out.push_str("（还没有全局技能）\n");
    } else {
        for s in &global {
            let d = if s.description.is_empty() { "（无描述）".to_string() } else { s.description.clone() };
            out.push_str(&format!("- {} — {}\n", s.slug, d));
        }
    }
    out
}

/// 本项目技能的索引段（跟着工作区变，所以排在全局后面）
pub fn skills_index_workspace(ws: &std::path::Path) -> String {
    let local = workspace_skills(ws);
    let mut out = String::new();
    out.push_str("本项目技能（工作区里的 .kdock_skill；涉及本项目文件/流程时**必须先读**它）：\n");
    if local.is_empty() {
        out.push_str("（本项目还没有专属技能）\n");
    } else {
        for s in &local {
            let d = if s.description.is_empty() { "（无描述）".to_string() } else { s.description.clone() };
            out.push_str(&format!("- {} — {}\n", s.slug, d));
        }
    }
    out
}

/// 技能路径解析的纯函数版：工作区 > 全局启用 > 全局停用。
fn resolve_skill_dir(
    ws: &std::path::Path,
    enabled_dir: &std::path::Path,
    disabled_dir: &std::path::Path,
    slug: &str,
) -> PathBuf {
    let s = slugify(slug);
    let local = ws.join(WORKSPACE_SKILL_DIR).join(&s);
    if local.is_dir() {
        return local;
    }
    let enabled = enabled_dir.join(&s);
    if enabled.is_dir() {
        return enabled;
    }
    // 停用技能不进索引，也不会被系统提示提到；但用户明确点名时可以按名字读到。
    let disabled = disabled_dir.join(&s);
    if disabled.is_dir() {
        return disabled;
    }
    enabled
}

/// 技能在哪儿（**agent 读正文走这条**）：先工作区、再全局启用、最后全局停用。
/// 停用技能不会出现在索引里；只有用户明确说出名字、模型调用 `skill_read` 时才可能读到。
///
/// 注意别跟 `skill_dir_of()` 搞混：那个是**给界面编辑器用的**（设置 → 技能里点一行读进编辑框），
/// 它必须能读到停用的技能，否则用户关掉之后就再也打不开、改不回来了。
pub fn skill_dir_of_in(app: &AppHandle, ws: &std::path::Path, slug: &str) -> PathBuf {
    let enabled = skills_dir(app).unwrap_or_default();
    let disabled = skills_off_dir(app).unwrap_or_default();
    resolve_skill_dir(ws, &enabled, &disabled, slug)
}

fn skill_read_error_text(slug: &str) -> String {
    format!("没有名为「{slug}」的技能。名字可能写错了 —— 先用 skill_list 看看有哪些可用技能。")
}

/// 读技能正文（工作区优先）。停用技能不进口令索引，但用户明确点名时仍可按名读取。
pub fn skill_read_in(app: &AppHandle, ws: &std::path::Path, slug: &str) -> Result<String, String> {
    let p = skill_dir_of_in(app, ws, slug).join("SKILL.md");
    if p.is_file() {
        return std::fs::read_to_string(&p).map_err(|e| format!("读 {} 失败: {e}", p.display()));
    }
    Err(skill_read_error_text(slug))
}

fn migrated_always_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(agent_dir(app)?.join("skills-always.json.migrated"))
}

/// 用停用技能的原始正文精确移除旧迁移段。
/// 正文里可能自己就有 `## 1.` 这种标题，不能按“下一个 ##”粗暴截断。
fn remove_migrated_body(text: &str, slug: &str, body: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.as_str();
    let body = body.trim();
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    let body = body.as_str();
    if body.is_empty() {
        return text.to_string();
    }
    let with_heading = format!("## {slug}\n{body}");
    let mut joined = if text.contains(&with_heading) {
        text.replace(&with_heading, "")
    } else if text.contains(body) {
        // 兼容已经删过 slug 标题、但正文仍在的中间版本。
        text.replace(body, "")
    } else if let Some(pos) = body.find("\n## ") {
        // 兼容更早的中间版本：slug 标题和正文开头被误删，只剩正文里的后半段。
        let tail = &body[pos + 1..];
        if text.contains(tail) {
            text.replace(tail, "")
        } else {
            text.to_string()
        }
    } else {
        text.to_string()
    };
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    if joined.trim() == "# 全局指导（从常驻技能迁移而来）" {
        String::new()
    } else {
        joined.trim().to_string()
    }
}

/// 清理旧版“常驻技能 → AGENTS.md”迁移留下的已停用技能正文。
/// 只处理迁移清单里记录过的 slug，不动用户手写的其它章节。
pub fn prune_disabled_migrated_guidance(app: &AppHandle) -> Result<usize, String> {
    let migrated = migrated_always_path(app)?;
    let slugs = skills_always_read(&migrated);
    if slugs.is_empty() {
        return Ok(0);
    }
    let enabled = skills_dir(app)?;
    let mut text = read_global_guidance(app);
    if text.trim().is_empty() {
        return Ok(0);
    }
    let mut removed = 0;
    for slug in slugs {
        if enabled.join(slugify(&slug)).is_dir() {
            continue;
        }
        let md = skills_off_dir(app)?.join(slugify(&slug)).join("SKILL.md");
        let Ok(source) = std::fs::read_to_string(md) else {
            continue;
        };
        let (_, body) = parse_frontmatter(&source);
        let next = remove_migrated_body(&text, &slug, &body);
        if next != text {
            text = next;
            removed += 1;
        }
    }
    if removed > 0 {
        write_global_guidance(app, &text)?;
    }
    Ok(removed)
}

/// 写技能：scope = global（默认）或 workspace
pub fn skill_write_in(app: &AppHandle, ws: &std::path::Path, scope: &str, slug: &str, content: &str) -> Result<String, String> {
    if scope == "workspace" {
        let dir = ensure_workspace_skill_dir(ws).join(slugify(slug));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let p = dir.join("SKILL.md");
        std::fs::write(&p, content).map_err(|e| format!("写 {} 失败: {e}", p.display()))?;
        return Ok(p.to_string_lossy().to_string());
    }
    skill_write(app, slug, content)
}

/// 删技能：工作区技能删之前先归档一份（回收站语义）
pub fn skill_delete_in(app: &AppHandle, ws: &std::path::Path, scope: &str, slug: &str) -> Result<(), String> {
    if scope == "workspace" {
        let dir = ws.join(WORKSPACE_SKILL_DIR).join(slugify(slug));
        if !dir.is_dir() {
            return Err(format!("工作区里没有这个技能：{slug}"));
        }
        let _ = archive_skill(app, &dir, &ws.to_string_lossy(), "workspace");
        return std::fs::remove_dir_all(&dir).map_err(|e| format!("删技能失败: {e}"));
    }
    skill_delete(app, slug)
}

// ── 工作区 ──────────────────────────────────────────────────────────

pub fn default_workspace(app: &AppHandle) -> PathBuf {
    agent_dir(app).map(|d| d.join("workspace")).unwrap_or_else(|_| PathBuf::from("."))
}

/// 把相对路径钉在工作区内（拒绝绝对路径和 `..` 逃逸）—— 文件工具的守门人
pub fn resolve_in_workspace(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') {
        return Err("只接受工作区内的相对路径".into());
    }
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("路径里不允许 ..".into()),
            other => out.push(other),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kdock-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn always_list_round_trips_sorts_and_tolerates_garbage() {
        let d = tmp_dir("always");
        let p = d.join("skills-always.json");
        assert!(skills_always_read(&p).is_empty(), "没文件就该是空");
        skills_always_write_to(&p, &["b".into(), "a".into(), "a".into()]).unwrap();
        assert_eq!(skills_always_read(&p), vec!["a".to_string(), "b".to_string()], "要排序去重");
        std::fs::write(&p, "这不是 json").unwrap();
        assert!(skills_always_read(&p).is_empty(), "坏了当空，不能炸");
        std::fs::write(&p, r#"["a", 7, {"x":1}, null]"#).unwrap();
        assert_eq!(skills_always_read(&p), vec!["a".to_string()], "非字符串项跳过");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 两段索引：全局只有启用的进，工作区存在即进；顺序按 slug（前缀缓存要稳）
    #[test]
    fn workspace_skill_dir_is_created_with_gitignore() {
        let d = tmp_dir("wsskill");
        let dir = ensure_workspace_skill_dir(&d);
        assert!(dir.is_dir(), "目录要由代码建出来");
        assert!(dir.join(".gitignore").exists(), "自带 .gitignore，别污染用户的仓库");
        // 放一个项目技能进去，能读出来、能按名字找到
        std::fs::create_dir_all(dir.join("proj-rules")).unwrap();
        std::fs::write(dir.join("proj-rules").join("SKILL.md"),
            "---\nname: proj-rules\ndescription: 本项目的规矩\n---\n正文").unwrap();
        let list = workspace_skills(&d);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].slug, "proj-rules");
        assert_eq!(list[0].scope, "workspace");
        assert!(list[0].enabled, "项目技能存在即生效");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 停用技能不进索引，但用户明确点名时仍能按名字读到正文。
    #[test]
    fn disabled_skill_can_be_read_by_explicit_name_but_not_indexed() {
        let base = tmp_dir("skilloff");
        let enabled = base.join("skills");
        let disabled = base.join("skills-off");
        let ws = base.join("workspace");
        for d in [&enabled, &disabled, &ws] {
            std::fs::create_dir_all(d).unwrap();
        }
        // 同一个 slug 只存在于"停用"目录里
        std::fs::create_dir_all(disabled.join("secret")).unwrap();
        std::fs::write(disabled.join("secret").join("SKILL.md"), "停用的内容").unwrap();

        // 1) 按名读取会回退到停用目录
        let got = resolve_skill_dir(&ws, &enabled, &disabled, "secret");
        assert_eq!(got, disabled.join("secret"), "按名读取应回退到 skills-off");
        assert_eq!(std::fs::read_to_string(got.join("SKILL.md")).unwrap(), "停用的内容");

        // 2) 启用的能正常解析
        std::fs::create_dir_all(enabled.join("active")).unwrap();
        std::fs::write(enabled.join("active").join("SKILL.md"), "启用的内容").unwrap();
        let got = resolve_skill_dir(&ws, &enabled, &disabled, "active");
        assert_eq!(got, enabled.join("active"));

        // 3) 工作区技能优先于全局同名的
        let wsdir = ensure_workspace_skill_dir(&ws).join("active");
        std::fs::create_dir_all(&wsdir).unwrap();
        std::fs::write(wsdir.join("SKILL.md"), "项目里的同名技能").unwrap();
        let got = resolve_skill_dir(&ws, &enabled, &disabled, "active");
        assert_eq!(got, wsdir, "工作区技能要盖过全局的");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_skill_message_points_to_list() {
        let missing = skill_read_error_text("no-such-skill");
        assert!(missing.contains("没有名为"), "要说清是不存在：{missing}");
        assert!(missing.contains("skill_list"), "要引导它去核对名字：{missing}");
    }

    #[test]
    fn migration_section_can_be_removed_without_touching_other_guidance() {
        let body = "## 1. 身份\n秘密正文\n\n## 2. 其它\n更多正文";
        let text = format!("# 全局指导（从常驻技能迁移而来）\n\n## kyin-identity\n{body}\n\n## keep\n用户手写\n");
        let got = remove_migrated_body(&text, "kyin-identity", body);
        assert!(!got.contains("秘密正文"));
        assert!(!got.contains("更多正文"));
        assert!(got.contains("## keep"));
        assert!(got.contains("用户手写"));

        // 中间版本曾只删掉第一段，只剩 `## 1.` 之后的正文。
        let broken = format!("# 全局指导（从常驻技能迁移而来）\n\n## 1. 身份\n秘密正文\n\n## 2. 其它\n更多正文\n\n## keep\n用户手写\n");
        let repaired = remove_migrated_body(&broken, "kyin-identity", body);
        assert!(!repaired.contains("秘密正文"));
        assert!(!repaired.contains("更多正文"));
        assert!(repaired.contains("## keep"));

        let crlf = text.replace('\n', "\r\n");
        let crlf_body = body.replace('\n', "\r\n");
        let normalized = remove_migrated_body(&crlf, "kyin-identity", &crlf_body);
        assert!(!normalized.contains("秘密正文"));
        assert!(normalized.contains("## keep"));
    }
}
