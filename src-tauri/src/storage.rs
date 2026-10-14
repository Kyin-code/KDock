//! 持久化"家底"：指令表配置 + 缓存清单/删除 + 重启。
//!
//! 设计目标：用户在界面上看到的每一份持久化数据，都能在「设置 → 缓存」里
//! 看到它的**归类、路径、占用**，并且能按类删掉（删完重启，避免半截状态）。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::store::agent_dir;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| format!("拿不到应用数据目录: {e}"))?;
    std::fs::create_dir_all(&d).map_err(|e| format!("建目录 {} 失败: {e}", d.display()))?;
    Ok(d)
}

/// 指令表配置文件（用户自定义的指令组/指令就存这儿）
pub fn command_table_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(agent_dir(app)?.join("commands.json"))
}

/// 读指令表；没有文件就返回 null（前端会写入默认的 Linux 指令集）
#[tauri::command]
pub fn command_table_get(app: AppHandle) -> Value {
    command_table_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or(Value::Null)
}

/// 覆盖保存指令表
#[tauri::command]
pub fn command_table_save(app: AppHandle, table: Value) -> Result<(), String> {
    let path = command_table_path(&app)?;
    let text = serde_json::to_string_pretty(&table).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("改名到 {} 失败: {e}", path.display()))
}

/// 目录/文件的大小统计（文件数 + 字节数）
fn dir_stat(p: &std::path::Path) -> (u64, u64) {
    if !p.exists() {
        return (0, 0);
    }
    if p.is_file() {
        return (1, std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
    }
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let (f, b) = dir_stat(&e.path());
            files += f;
            bytes += b;
        }
    }
    (files, bytes)
}

/// 缓存清单：一行一个"能删的东西"
#[tauri::command]
pub fn cache_items(app: AppHandle) -> Vec<Value> {
    let data = app_data_dir(&app).ok();
    let agent = agent_dir(&app).ok();
    let mut out: Vec<Value> = Vec::new();

    let mut push = |key: &str, title: &str, path: Option<std::path::PathBuf>, kind: &str,
                    warn: &str, extra: Value| {
        let p = path.unwrap_or_default();
        let (files, bytes) = dir_stat(&p);
        let mut v = json!({
            "key": key,
            "title": title,
            "path": p.to_string_lossy(),
            "kind": kind,                    // file / dir / prefs / local
            "exists": p.exists(),
            "files": files,
            "bytes": bytes,
            "warn": warn,                    // 删了会丢什么（人话）
        });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e { o.insert(k.clone(), val.clone()); }
        }
        out.push(v);
    };

    if let Some(d) = &data {
        push("ui-prefs", "界面偏好（主题 / 配色 / 语言 / 栏宽）", Some(d.join("ui-prefs.json")),
             "file", "会回到默认外观（深色 + 海洋蓝 + 英文）", json!({}));
        push("window-state", "窗口位置与大小", Some(d.join(".window-state.json")),
             "file", "下次启动窗口回到屏幕中央的默认尺寸", json!({}));
        push("local", "浏览器本地存储（快捷发送 / 编排画布 / 编码 / 上次目录…）",
             Some(d.join("EBWebView")), "local", "由界面自己清空（WebView2 的本地存储）",
             json!({ "uiOnly": true }));
    }
    if let Some(d) = &agent {
        push("providers", "LLM 供应商配置（不含密钥）", Some(d.join("providers.json")),
             "file", "供应商列表与当前选择会清空，需要重新配置模型", json!({ "confirm": true }));
        push("secrets", "API 密钥（DPAPI 加密）", Some(d.join("secrets.json")),
             "file", "所有供应商的 Key 都会被删除，需要重新粘贴", json!({ "confirm": true }));
        push("sessions", "Agent 对话历史（含摘要与压缩前的原始记录）", Some(d.join("sessions")),
             "dir", "所有对话都会消失，不可恢复", json!({ "confirm": true }));
        push("skills", "技能（导入/新建的 SKILL.md 副本）", Some(d.join("skills")),
             "dir", "只删这个副本目录（你自己的原始 SKILL.md 不在里面）", json!({ "confirm": true }));
        push("skills-off", "已关闭的技能副本", Some(d.join("skills-off")),
             "dir", "同上，只删副本", json!({}));
        push("mcp", "MCP 服务配置", Some(d.join("mcp.json")), "file", "MCP 列表会清空", json!({}));
        push("commands", "指令表配置（指令组 / 指令）", Some(d.join("commands.json")),
             "file", "回到内置的标准 Linux 指令集", json!({}));
        push("workspaces", "工作区列表", Some(d.join("workspaces.json")), "file", "工作区记录清空（目录本身不动）", json!({}));
        push("workspace-files", "Agent 工作区文件（下载/导出的文件）", Some(d.join("workspace")),
             "dir", "里面有 agent 收发的文件，删了就没了", json!({ "confirm": true }));
        push("speed", "出字速度统计", Some(d.join("speed.json")), "file", "速度与平均速度重新累计", json!({}));
    }
    out
}

fn remove_path(p: &std::path::Path) -> Result<(), String> {
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("删目录 {} 失败: {e}", p.display()))
    } else {
        std::fs::remove_file(p).map_err(|e| format!("删文件 {} 失败: {e}", p.display()))
    }
}

/// 按 key 删除选中的缓存项。返回真正删掉的 key 列表。
#[tauri::command]
pub fn cache_delete(app: AppHandle, keys: Vec<String>) -> Result<Value, String> {
    let data = app_data_dir(&app)?;
    let agent = agent_dir(&app)?;
    let mut done: Vec<String> = Vec::new();
    for k in keys {
        let targets: Vec<std::path::PathBuf> = match k.as_str() {
            "ui-prefs" => vec![data.join("ui-prefs.json")],
            "window-state" => vec![data.join(".window-state.json")],
            "providers" => vec![agent.join("providers.json")],
            "secrets" => vec![agent.join("secrets.json")],
            "sessions" => vec![agent.join("sessions")],
            "skills" => vec![agent.join("skills")],
            "skills-off" => vec![agent.join("skills-off")],
            "mcp" => vec![agent.join("mcp.json")],
            "commands" => vec![agent.join("commands.json")],
            "workspaces" => vec![agent.join("workspaces.json")],
            "workspace-files" => vec![agent.join("workspace")],
            "speed" => vec![agent.join("speed.json")],
            _ => return Err(format!("不认识的缓存项: {k}")),
        };
        for t in targets {
            remove_path(&t)?;
        }
        done.push(k);
    }
    Ok(json!({ "ok": true, "deleted": done }))
}

/// 重启应用（删完缓存/改完配置之后用，保证内存里的旧状态不残留）
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}
