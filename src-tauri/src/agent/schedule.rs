//! Agent 定时任务：倒计时 / 指定本地时间，支持重复。
//! 任务写 agent/schedules.json，进程内一个轻量 ticker 每秒检查一次。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager};

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
    /// Windows Task Scheduler 里的配套任务名。空 = 只依赖应用内 ticker。
    #[serde(default)]
    pub external_task: String,
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

fn external_task_name(id: &str) -> String {
    format!("KDock\\AgentSchedule-{id}")
}

fn register_external(task: &ScheduleTask) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("读取当前程序路径失败：{e}"))?;
    let task_name = external_task_name(&task.id);
    let Some(dt) = Local.timestamp_millis_opt(task.next_at_ms).single() else {
        return Err("定时任务时间无效".into());
    };
    let mut cmd = std::process::Command::new("schtasks.exe");
    cmd.arg("/Create")
        .arg("/TN")
        .arg(&task_name)
        .arg("/TR")
        .arg(format!("\"{}\" --automation-run {}", exe.display(), task.id))
        .arg("/ST")
        .arg(dt.format("%H:%M").to_string())
        .arg("/F")
        .arg("/IT")
        .creation_flags(0x0800_0000);
    if task.daily {
        cmd.arg("/SC").arg("DAILY");
    } else if task.repeat_ms > 0 {
        if task.repeat_ms < 60_000 {
            return Err("Windows 外部调度最小重复间隔是 1 分钟；当前任务仍可在 KDock 打开时执行"
                .into());
        }
        cmd.arg("/SC")
            .arg("MINUTE")
            .arg("/MO")
            .arg(((task.repeat_ms + 59_999) / 60_000).to_string());
    } else {
        cmd.arg("/SC")
            .arg("ONCE")
            .arg("/SD")
            .arg(dt.format("%m/%d/%Y").to_string());
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let out = crate::process_guard::spawn(&mut cmd)
        .map_err(|e| format!("启动 schtasks 失败：{e}"))?
        .wait_with_output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "注册 Windows 计划任务失败（{}）：{}",
            out.status.code().unwrap_or(-1),
            err.trim()
        ));
    }
    Ok(task_name)
}

fn delete_external(name: &str) {
    if name.trim().is_empty() {
        return;
    }
    let mut cmd = std::process::Command::new("schtasks.exe");
    cmd.args(["/Delete", "/TN", name, "/F"])
        .creation_flags(0x0800_0000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let _ = crate::process_guard::spawn(&mut cmd).and_then(|mut c| c.wait());
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
    let mut task = ScheduleTask {
        id: format!("sch{now}-{}", SEQ.fetch_add(1, Ordering::Relaxed)),
        session_id,
        prompt,
        kind,
        next_at_ms: next,
        repeat_ms: repeat_ms.unwrap_or(0).max(0),
        daily: daily_flag,
        created_ms: now,
        external_task: String::new(),
    };
    let external = match register_external(&task) {
        Ok(name) => {
            task.external_task = name;
            json!({ "ok": true })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    };
    {
        let _guard = IO_LOCK.lock().map_err(|_| "定时任务锁失效".to_string())?;
        let mut tasks = load(&app);
        tasks.push(task.clone());
        tasks.sort_by_key(|t| t.next_at_ms);
        save(&app, &tasks)?;
    }
    Ok(json!({ "ok": true, "task": task, "external": external }))
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
                ,"external_task": t.external_task
            })
        })
        .collect()
}

#[tauri::command]
pub fn agent_schedule_cancel(app: AppHandle, id: String) -> Result<Value, String> {
    let _guard = IO_LOCK.lock().map_err(|_| "定时任务锁失效".to_string())?;
    let mut tasks = load(&app);
    let before = tasks.len();
    let removed: Vec<ScheduleTask> = if id == "all" {
        let all = tasks.clone();
        tasks.clear();
        all
    } else {
        let all = tasks.iter().filter(|t| t.id == id).cloned().collect();
        tasks.retain(|t| t.id != id);
        all
    };
    for task in &removed {
        delete_external(&task.external_task);
    }
    save(&app, &tasks)?;
    Ok(json!({ "ok": true, "removed": before - tasks.len() }))
}

fn claim_external(app: &AppHandle, id: &str) -> Result<ScheduleTask, String> {
    let _guard = IO_LOCK.lock().map_err(|_| "定时任务锁失效".to_string())?;
    let mut tasks = load(app);
    let now = now_ms();
    let Some(mut task) = tasks.iter().find(|t| t.id == id).cloned() else {
        return Err(format!("找不到定时任务 {id}"));
    };
    if task.next_at_ms > now + 2_000 {
        return Err(format!("定时任务 {id} 还不到执行时间（可能已由应用内调度领取）"));
    }
    if task.daily {
        while task.next_at_ms <= now {
            task.next_at_ms = next_daily(task.next_at_ms);
        }
        for item in tasks.iter_mut() {
            if item.id == id {
                item.next_at_ms = task.next_at_ms;
            }
        }
    } else if task.repeat_ms > 0 {
        while task.next_at_ms <= now {
            task.next_at_ms += task.repeat_ms;
        }
        for item in tasks.iter_mut() {
            if item.id == id {
                item.next_at_ms = task.next_at_ms;
            }
        }
    } else {
        tasks.retain(|t| t.id != id);
    }
    save(app, &tasks)?;
    Ok(task)
}

/// Windows Task Scheduler 拉起 KDock 时调用。
pub fn handle_cli_argv(app: &AppHandle, argv: &[String]) -> bool {
    let Some(pos) = argv.iter().position(|x| x == "--automation-run") else {
        return false;
    };
    let Some(id) = argv.get(pos + 1).cloned() else {
        return false;
    };
    let app2 = app.clone();
    std::thread::spawn(move || {
        let exit_after = std::env::var("KDOCK_AUTOMATION_RUN").ok().as_deref() == Some(id.as_str());
        let task = match claim_external(&app2, &id) {
            Ok(t) => t,
            Err(e) => {
                let _ = app2.emit("agent://toast", json!({ "text": e }));
                if exit_after { app2.exit(1); }
                return;
            }
        };
        if let Err(e) = super::agent_send(
            app2.clone(),
            task.session_id.clone(),
            task.prompt.clone(),
            None,
        ) {
            let _ = app2.emit(
                "agent://toast",
                json!({ "text": format!("外部定时任务 {} 触发失败：{e}", task.id) }),
            );
            if exit_after { app2.exit(1); }
            return;
        }
        let _ = app2.emit(
            "agent://toast",
            json!({ "text": format!("外部定时任务 {} 已触发", task.id) }),
        );
        if !exit_after {
            return;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3600);
        let start_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let st = app2.state::<std::sync::Arc<super::AgentState>>().inner().clone();
            if !st.running(Some(&task.session_id)) && std::time::Instant::now() < start_deadline {
                continue;
            }
            if !st.running(Some(&task.session_id)) {
                app2.exit(0);
                return;
            }
            if std::time::Instant::now() >= deadline {
                app2.exit(2);
                return;
            }
        }
    });
    true
}

pub fn handle_startup_cli(app: &AppHandle) {
    if let Ok(id) = std::env::var("KDOCK_AUTOMATION_RUN") {
        let argv = vec!["kdock".to_string(), "--automation-run".to_string(), id];
        let _ = handle_cli_argv(app, &argv);
    }
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
                delete_external(&t.external_task);
                let _ = app.emit(
                    "agent://toast",
                    json!({ "text": format!("定时任务 {} 的会话已不存在，已取消", t.id) }),
                );
                changed = true;
                continue;
            }
            due.push(t.clone());
            if !t.daily && t.repeat_ms <= 0 {
                delete_external(&t.external_task);
            }
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
    fn external_tasks_are_namespaced_per_schedule() {
        assert_eq!(
            external_task_name("sch123-1"),
            "KDock\\AgentSchedule-sch123-1"
        );
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
