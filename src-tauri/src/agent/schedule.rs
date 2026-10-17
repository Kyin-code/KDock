//! Agent 定时任务：倒计时 / 指定本地时间，支持重复。
//! 任务写 agent/schedules.json，进程内一个轻量 ticker 每秒检查一次。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::store;

static SEQ: AtomicU64 = AtomicU64::new(1);
/// 前端命令和后台 ticker 都会改同一个文件：所有"读-改-写"串起来，避免互相覆盖。
static IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleTask {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    /// countdown / at
    pub kind: String,
    pub next_at_ms: i64,
    #[serde(default)]
    pub repeat_ms: i64,
    #[serde(default)]
    pub daily: bool,
    #[serde(default)]
    pub created_ms: i64,
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn tasks_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(store::agent_dir(app)?.join("schedules.json"))
}

fn load(app: &AppHandle) -> Vec<ScheduleTask> {
    let Ok(path) = tasks_path(app) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(app: &AppHandle, tasks: &[ScheduleTask]) -> Result<(), String> {
    let path = tasks_path(app)?;
    let text = serde_json::to_string_pretty(tasks).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写 {} 失败: {e}", path.display()))
}

/// 10s / 5m / 2h / 1d
#[cfg(test)]
pub fn parse_delay(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_lowercase();
    let (num, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit() && c != '.')?);
    let n: f64 = num.parse().ok()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let ms = match unit {
        "s" => n * 1000.0,
        "m" => n * 60_000.0,
        "h" => n * 3_600_000.0,
        "d" => n * 86_400_000.0,
        _ => return None,
    };
    Some(ms as i64)
}

fn parse_clock(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    NaiveTime::from_hms_opt(h, m, 0)
}

fn local_at(date: NaiveDate, time: NaiveTime) -> Result<i64, String> {
    Local
        .from_local_datetime(&NaiveDateTime::new(date, time))
        .single()
        .map(|dt| dt.timestamp_millis())
        .ok_or_else(|| "这个本地时间不存在（时区切换）".into())
}

fn next_daily(ts: i64) -> i64 {
    let Some(prev) = Local.timestamp_millis_opt(ts).single() else {
        return ts + 86_400_000;
    };
    let Some(date) = prev.date_naive().succ_opt() else {
        return ts + 86_400_000;
    };
    local_at(date, prev.time()).unwrap_or(ts + 86_400_000)
}

fn parse_at(s: &str) -> Result<i64, String> {
    let s = s.trim();
    let now = Local::now();
    // YYYY-MM-DD HH:MM 或 YYYY-MM-DDTHH:MM（小时可以只写一位）
    let full = s.replace('T', " ");
    if let Some((date, time)) = full.split_once(' ') {
        if let (Ok(date), Some(time)) = (
            NaiveDate::parse_from_str(date, "%Y-%m-%d"),
            parse_clock(time),
        ) {
            let next = local_at(date, time)?;
            if next <= now.timestamp_millis() {
                return Err("指定时间已经过去".into());
            }
            return Ok(next);
        }
    }
    // 只有 HH:MM：今天还没到就用今天，否则明天
    if let Some(t) = parse_clock(s) {
        let today = now.date_naive();
        let mut next = local_at(today, t)?;
        if next <= now.timestamp_millis() {
            next = local_at(today.succ_opt().ok_or("日期超出范围")?, t)?;
        }
        return Ok(next);
    }
    Err("时间格式要写 HH:MM 或 YYYY-MM-DD HH:MM".into())
}

#[tauri::command]
pub fn agent_schedule_add(
    app: AppHandle,
    session_id: String,
    prompt: String,
    kind: String,
    delay_ms: Option<i64>,
    at: Option<String>,
    repeat_ms: Option<i64>,
    daily: Option<bool>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("任务内容不能为空".into());
    }
    if store::session_meta_of(&app, &session_id).is_none() {
        return Err("找不到这个会话".into());
    }
    let now = now_ms();
    let (next, daily_flag) = match kind.as_str() {
        "countdown" => {
            let d = delay_ms.unwrap_or(0);
            if d < 0 {
                return Err("倒计时不能是负数".into());
            }
            (now + d.max(200), false)
        }
        "at" => (parse_at(&at.unwrap_or_default())?, daily.unwrap_or(false)),
        _ => return Err("kind 只能是 countdown 或 at".into()),
    };
    let task = ScheduleTask {
        id: format!("sch{now}-{}", SEQ.fetch_add(1, Ordering::Relaxed)),
        session_id,
        prompt,
        kind,
        next_at_ms: next,
        repeat_ms: repeat_ms.unwrap_or(0).max(0),
        daily: daily_flag,
        created_ms: now,
    };
    {
        let _guard = IO_LOCK.lock().map_err(|_| "定时任务锁失效".to_string())?;
        let mut tasks = load(&app);
        tasks.push(task.clone());
        tasks.sort_by_key(|t| t.next_at_ms);
        save(&app, &tasks)?;
    }
    Ok(json!({ "ok": true, "task": task }))
}

#[tauri::command]
pub fn agent_schedule_list(app: AppHandle) -> Vec<Value> {
    let Ok(_guard) = IO_LOCK.lock() else {
        return Vec::new();
    };
    let now = now_ms();
    let mut tasks = load(&app);
    tasks.sort_by_key(|t| t.next_at_ms);
    tasks
        .into_iter()
        .map(|t| {
            json!({
                "id": t.id, "session": t.session_id, "prompt": t.prompt, "kind": t.kind,
                "next_at_ms": t.next_at_ms, "in_ms": (t.next_at_ms - now).max(0),
                "repeat_ms": t.repeat_ms, "daily": t.daily
            })
        })
        .collect()
}

#[tauri::command]
pub fn agent_schedule_cancel(app: AppHandle, id: String) -> Result<Value, String> {
    let _guard = IO_LOCK.lock().map_err(|_| "定时任务锁失效".to_string())?;
    let mut tasks = load(&app);
    let before = tasks.len();
    if id == "all" {
        tasks.clear();
    } else {
        tasks.retain(|t| t.id != id);
    }
    save(&app, &tasks)?;
    Ok(json!({ "ok": true, "removed": before - tasks.len() }))
}

fn tick_once(app: &AppHandle) {
    let now = now_ms();
    let mut due = Vec::new();
    {
        let Ok(_guard) = IO_LOCK.lock() else { return };
        let tasks = load(app);
        let mut changed = false;
        let mut keep = Vec::new();
        for mut t in tasks {
            if t.next_at_ms > now {
                keep.push(t);
                continue;
            }
            if store::session_meta_of(app, &t.session_id).is_none() {
                let _ = app.emit(
                    "agent://toast",
                    json!({ "text": format!("定时任务 {} 的会话已不存在，已取消", t.id) }),
                );
                changed = true;
                continue;
            }
            due.push(t.clone());
            // 先推进下一次并落盘，再发消息：进程如果恰好在这中间退出，也不会重复触发。
            if t.daily {
                while t.next_at_ms <= now {
                    t.next_at_ms = next_daily(t.next_at_ms);
                }
                changed = true;
                keep.push(t);
            } else if t.repeat_ms > 0 {
                while t.next_at_ms <= now {
                    t.next_at_ms += t.repeat_ms;
                }
                changed = true;
                keep.push(t);
            } else {
                changed = true;
            }
        }
        if changed {
            if let Err(e) = save(app, &keep) {
                let _ = app.emit("agent://toast", json!({ "text": format!("保存定时任务失败：{e}") }));
                due.clear();
            }
        }
    }
    for t in due {
        match super::agent_send(app.clone(), t.session_id.clone(), t.prompt.clone(), None) {
            Ok(_) => {
                let _ = app.emit("agent://toast", json!({ "text": format!("定时任务 {} 已触发", t.id) }));
            }
            Err(e) => {
                let _ = app.emit(
                    "agent://toast",
                    json!({ "text": format!("定时任务 {} 触发失败：{e}", t.id) }),
                );
            }
        }
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        tick_once(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations() {
        assert_eq!(parse_delay("10s"), Some(10_000));
        assert_eq!(parse_delay("5m"), Some(300_000));
        assert_eq!(parse_delay("2h"), Some(7_200_000));
        assert_eq!(parse_delay("1d"), Some(86_400_000));
        assert_eq!(parse_delay("0m"), None);
        assert_eq!(parse_delay("abc"), None);
    }

    #[test]
    fn parses_clock_and_daily_rollover() {
        assert_eq!(parse_clock("9:30"), Some(NaiveTime::from_hms_opt(9, 30, 0).unwrap()));
        assert_eq!(parse_clock("23:59"), Some(NaiveTime::from_hms_opt(23, 59, 0).unwrap()));
        assert_eq!(parse_clock("24:00"), None);
        let t = Local
            .with_ymd_and_hms(2026, 10, 12, 9, 30, 0)
            .single()
            .unwrap();
        let n = Local.timestamp_millis_opt(next_daily(t.timestamp_millis())).single().unwrap();
        assert_eq!(n.date_naive(), NaiveDate::from_ymd_opt(2026, 10, 13).unwrap());
        assert_eq!(n.time(), NaiveTime::from_hms_opt(9, 30, 0).unwrap());
    }
}
