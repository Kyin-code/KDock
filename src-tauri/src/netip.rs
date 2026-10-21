//! 公网 IP 归属地（ipinfo.io）与本地请求预算。
//!
//! - 顶栏只显示国家/地区，不保存、不展示实际公网 IP。
//! - 只有本地网络指纹（网卡地址 + 默认路由 + 代理）变化后才请求 ipinfo。
//! - 每日请求计数跨进程持久化，硬上限 100 次。
//! - 网络事件先防抖，失败重试次数可配置，最大 10 次。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const DAILY_LIMIT: u64 = 100;
const DEFAULT_DEBOUNCE_MS: u64 = 2_500;
const MIN_DEBOUNCE_MS: u64 = 200;
const MAX_DEBOUNCE_MS: u64 = 60_000;
const DEFAULT_RETRIES: u32 = 2;
const MAX_RETRIES: u32 = 10;
const REQUEST_TIMEOUT_SECS: u64 = 12;
const MONITOR_TICK_SECS: u64 = 3;

static STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Location {
    pub country: String,
    #[serde(default)]
    pub label: String,
    pub city: String,
    pub region: String,
    pub org: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    #[serde(default)] day: String,
    #[serde(default)] requests: u64,
    #[serde(default = "default_debounce")] debounce_ms: u64,
    #[serde(default = "default_retries")] retry_count: u32,
    #[serde(default)] last_snapshot: String,
    #[serde(default)] last_attempt_snapshot: String,
    #[serde(default)] location: Option<Location>,
    #[serde(default)] updated_at: i64,
    #[serde(default)] last_error: String,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            day: today_key(), requests: 0,
            debounce_ms: DEFAULT_DEBOUNCE_MS, retry_count: DEFAULT_RETRIES,
            last_snapshot: String::new(), last_attempt_snapshot: String::new(),
            location: None, updated_at: 0, last_error: String::new(),
        }
    }
}

fn default_debounce() -> u64 { DEFAULT_DEBOUNCE_MS }
fn default_retries() -> u32 { DEFAULT_RETRIES }
fn today_key() -> String { chrono::Local::now().format("%Y-%m-%d").to_string() }
fn now_ms() -> i64 { chrono::Local::now().timestamp_millis() }

pub(crate) fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| format!("拿不到应用数据目录: {e}"))?;
    std::fs::create_dir_all(&d).map_err(|e| format!("建目录 {} 失败: {e}", d.display()))?;
    Ok(d.join("netip.json"))
}

fn load(app: &AppHandle) -> Stored {
    let mut s = store_path(app).ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Stored>(&t).ok())
        .unwrap_or_default();
    let today = today_key();
    if s.day != today {
        s.day = today;
        s.requests = 0;
        s.last_error.clear();
        s.last_attempt_snapshot.clear(); // 新的一天允许同一网络再次探测
    }
    s.debounce_ms = s.debounce_ms.clamp(MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS);
    s.retry_count = s.retry_count.min(MAX_RETRIES);
    s
}

fn save(app: &AppHandle, s: &Stored) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("改名到 {} 失败: {e}", path.display()))
}

fn status_value(s: &Stored) -> Value {
    let remaining = DAILY_LIMIT.saturating_sub(s.requests);
    let loc = s.location.as_ref();
    json!({
        "country": loc.map(|l| l.country.clone()).unwrap_or_default(),
        // label 仅为旧版 netip.json 的兼容字段；界面按 country code 本地化，不再依赖它。
        "label": loc.map(|l| l.label.clone()).unwrap_or_default(),
        "city": loc.map(|l| l.city.clone()).unwrap_or_default(),
        "region": loc.map(|l| l.region.clone()).unwrap_or_default(),
        "org": loc.map(|l| l.org.clone()).unwrap_or_default(),
        "todayRequests": s.requests, "dailyLimit": DAILY_LIMIT,
        "remaining": remaining, "blocked": remaining == 0,
        "retryCount": s.retry_count, "debounceMs": s.debounce_ms,
        "updatedAt": s.updated_at, "lastError": s.last_error, "day": s.day,
    })
}

fn emit_status(app: &AppHandle, s: &Stored) {
    let _ = app.emit("netip://changed", status_value(s));
}

#[tauri::command]
pub fn netip_status(app: AppHandle) -> Value {
    let _guard = STATE_LOCK.lock().expect("netip lock");
    let s = load(&app);
    let _ = save(&app, &s);
    status_value(&s)
}

#[tauri::command]
pub fn netip_settings(app: AppHandle, retry_count: u32, debounce_ms: u64) -> Result<Value, String> {
    let _guard = STATE_LOCK.lock().expect("netip lock");
    let mut s = load(&app);
    s.retry_count = retry_count.min(MAX_RETRIES);
    s.debounce_ms = debounce_ms.clamp(MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS);
    save(&app, &s)?;
    let v = status_value(&s);
    emit_status(&app, &s);
    Ok(v)
}

fn network_snapshot() -> String {
    #[cfg(windows)]
    {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.Generic.List[string]
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
  Sort-Object InterfaceIndex,IPAddress |
  ForEach-Object { $out.Add("I|$($_.InterfaceIndex)|$($_.IPAddress)|$($_.PrefixLength)") }
Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
  Sort-Object InterfaceIndex,NextHop,RouteMetric,InterfaceMetric |
  ForEach-Object { $out.Add("R|$($_.InterfaceIndex)|$($_.NextHop)|$($_.RouteMetric)|$($_.InterfaceMetric)") }
$p = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$out.Add("P|$($p.ProxyEnable)|$($p.ProxyServer)|$($p.AutoConfigURL)")
[Console]::Out.Write(($out -join "`n"))
"#;
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        return cmd.output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "ip -4 addr show; ip -4 route show default"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
    }
}

fn request_ipinfo() -> Result<Location, String> {
    let resp = ureq::get("https://ipinfo.io/json")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("ipinfo HTTP {code}: {}", body.chars().take(300).collect::<String>())
            }
            other => format!("ipinfo 请求失败: {other}"),
        })?;
    let v = resp.into_json::<Value>().map_err(|e| format!("ipinfo 响应不是 JSON: {e}"))?;
    let country = v.get("country").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(Location {
        // 只持久化稳定的国家代码；显示名称由前端按当前语言生成。
        label: String::new(), country,
        city: v.get("city").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        region: v.get("region").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        org: v.get("org").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

fn fetch_now(app: &AppHandle, force: bool, snapshot: String) -> Result<Value, String> {
    let _guard = STATE_LOCK.lock().expect("netip lock");
    let mut s = load(app);
    let remaining = DAILY_LIMIT.saturating_sub(s.requests);
    if remaining == 0 {
        return Err(format!("今日 ipinfo 请求已达上限 {DAILY_LIMIT} 次；明天会自动恢复"));
    }
    let auto_needed = (s.last_snapshot != snapshot || s.location.is_none())
        && s.last_attempt_snapshot != snapshot;
    if !force && !auto_needed { return Ok(status_value(&s)); }

    s.last_attempt_snapshot = snapshot.clone();
    let attempts = s.retry_count.min(MAX_RETRIES).saturating_add(1);
    let mut last_err = String::new();
    for attempt in 0..attempts {
        if s.requests >= DAILY_LIMIT {
            last_err = format!("今日 ipinfo 请求已达上限 {DAILY_LIMIT} 次；明天会自动恢复");
            break;
        }
        s.requests += 1;
        save(app, &s)?;
        match request_ipinfo() {
            Ok(loc) => {
                s.location = Some(loc); s.last_snapshot = snapshot;
                s.updated_at = now_ms(); s.last_error.clear();
                save(app, &s)?; emit_status(app, &s);
                return Ok(status_value(&s));
            }
            Err(e) => {
                last_err = e; s.last_error = last_err.clone();
                save(app, &s)?;
                if attempt + 1 < attempts {
                    std::thread::sleep(Duration::from_millis(900 + attempt as u64 * 350));
                }
            }
        }
    }
    emit_status(app, &s);
    Err(last_err)
}

#[tauri::command]
pub fn netip_refresh(app: AppHandle) -> Result<Value, String> {
    fetch_now(&app, true, network_snapshot())
}

/// 后台只读本地网络指纹；只有指纹变更后才进入防抖和 ipinfo 请求。
pub fn start_monitor(app: AppHandle) {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        let mut last_seen = String::new();
        let mut pending: Option<(String, Instant)> = None;
        loop {
            let fp = network_snapshot();
            if !fp.trim().is_empty() && fp != last_seen {
                last_seen = fp.clone();
                pending = Some((fp, Instant::now()));
            }
            if let Some((pending_fp, since)) = pending.clone() {
                let debounce = {
                    let _guard = STATE_LOCK.lock().expect("netip lock");
                    load(&app).debounce_ms
                };
                if since.elapsed() >= Duration::from_millis(debounce) {
                    let should = {
                        let _guard = STATE_LOCK.lock().expect("netip lock");
                        let s = load(&app);
                        (s.last_snapshot != pending_fp || s.location.is_none())
                            && s.last_attempt_snapshot != pending_fp
                            && s.requests < DAILY_LIMIT
                    };
                    if should { let _ = fetch_now(&app, false, pending_fp); }
                    pending = None;
                }
            }
            std::thread::sleep(Duration::from_secs(MONITOR_TICK_SECS));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_never_contains_public_ip_field() {
        let s = Stored {
            location: Some(Location { country: "HK".into(), label: String::new(), city: "Hong Kong".into(), region: "HK".into(), org: "ISP".into() }),
            ..Stored::default()
        };
        let text = serde_json::to_string(&status_value(&s)).unwrap();
        assert!(text.contains("\"country\":\"HK\""));
        assert!(!text.contains("\"ip\""));
    }
}