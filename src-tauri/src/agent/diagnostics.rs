use std::io::Write;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::store::{self, Provider};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn log_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = store::agent_dir(app)?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建诊断日志目录失败: {e}"))?;
    Ok(dir.join("context.jsonl"))
}

fn rotate_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_LOG_BYTES {
        return;
    }
    let rotated = path.with_file_name("context.1.jsonl");
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, rotated);
}

/// Append one structured context-management decision.
pub(super) fn context_event(
    app: &AppHandle,
    session_id: &str,
    provider: &Provider,
    event: &str,
    mut details: Value,
) {
    let Ok(path) = log_path(app) else {
        return;
    };
    rotate_if_needed(&path);
    let mut record = json!({
        "ts": chrono::Utc::now().timestamp_millis(),
        "source": "kdock",
        "event": event,
        "session": session_id,
        "provider": provider.id,
        "providerName": provider.name,
        "model": provider.model,
        "contextWindow": provider.context_window,
        "outputReserve": provider.max_output_tokens,
        "inputBudget": provider.input_budget(),
    });
    if let (Some(dst), Some(src)) = (record.as_object_mut(), details.as_object_mut()) {
        for (key, value) in std::mem::take(src) {
            dst.insert(key, value);
        }
    }
    let Ok(mut line) = serde_json::to_string(&record) else {
        return;
    };
    line.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}
