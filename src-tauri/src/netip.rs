//! 公网 IP 归属地（多源回退）与本地请求预算。
//!
//! - 顶栏只显示国家/地区，不保存、不展示实际公网 IP。
//! - 由 Windows 网络事件唤醒；网络指纹（网卡地址 + 默认路由 + 代理）变化后才探测。
//! - 每日请求计数跨进程持久化，硬上限 100 次。
//! - 网络事件先防抖，失败重试次数可配置，最大 10 次。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
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
const REQUEST_TIMEOUT_SECS: u64 = 6;
const AUTO_FAILURE_BACKOFF_MS: [i64; 6] = [0, 5_000, 15_000, 60_000, 180_000, 300_000];

static STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static MONITOR_WAKE: LazyLock<(Mutex<bool>, Condvar)> =
    LazyLock::new(|| (Mutex::new(false), Condvar::new()));
static PROBE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

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
    #[serde(default)] last_auto_failure_ms: i64,
    #[serde(default)] auto_failure_streak: u32,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            day: today_key(), requests: 0,
            debounce_ms: DEFAULT_DEBOUNCE_MS, retry_count: DEFAULT_RETRIES,
            last_snapshot: String::new(), last_attempt_snapshot: String::new(),
            location: None, updated_at: 0, last_error: String::new(), last_auto_failure_ms: 0, auto_failure_streak: 0,
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

/// 网络变化通知（Windows 原生 IP Helper）只写入一个"脏"标志；
/// 真正的 PowerShell 快照读取在后台线程里串行执行，不在 UI / 语言切换路径上。
#[cfg(windows)]
unsafe extern "system" fn on_network_changed(
    _context: *const std::ffi::c_void,
    _row: *const windows_sys::Win32::NetworkManagement::IpHelper::MIB_IPINTERFACE_ROW,
    _kind: windows_sys::Win32::NetworkManagement::IpHelper::MIB_NOTIFICATION_TYPE,
) {
    let (lock, cv) = &*MONITOR_WAKE;
    if let Ok(mut dirty) = lock.lock() {
        *dirty = true;
    }
    cv.notify_one();
}

fn poke_monitor() {
    let (lock, cv) = &*MONITOR_WAKE;
    if let Ok(mut dirty) = lock.lock() {
        *dirty = true;
    }
    cv.notify_one();
}

/// 读磁盘缓存是启动/设置页的热路径，不应每次都重写文件。
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
    // 状态查询只读缓存。旧版在这里顺手写盘，导致每次打开设置都多一次磁盘 I/O。
    status_value(&load(&app))
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
    poke_monitor();
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

fn request_json(url: &str) -> Result<Value, String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("{url} HTTP {code}: {}", body.chars().take(180).collect::<String>())
            }
            other => format!("{url} 请求失败: {other}"),
        })?;
    resp.into_json::<Value>().map_err(|e| format!("{url} 响应不是 JSON: {e}"))
}

fn json_str(v: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(x) = v.get(*key).and_then(|x| x.as_str()) {
            if !x.trim().is_empty() { return x.to_string(); }
        }
    }
    String::new()
}

fn parse_location(v: &Value) -> Option<Location> {
    let country = json_str(v, &["country", "country_code", "countryCode"]).to_uppercase();
    if country.len() != 2 { return None; }
    Some(Location {
        label: String::new(),
        country,
        city: json_str(v, &["city"]),
        region: json_str(v, &["region", "region_name"]),
        org: json_str(v, &["org", "organization", "isp", "asn_org"]),
    })
}

/// 多源并发竞速：任一源成功即可返回；全失败最多等一次 6 秒超时。
/// 这样不会因为首个源不可达而把后续源串行拖慢。
fn request_location() -> Result<Location, String> {
    use std::sync::mpsc;
    let sources = [
        "https://ipinfo.io/json",
        "https://api.ip.sb/geoip",
        "https://ipwho.is/",
        "https://get.geojs.io/v1/ip/geo.json",
    ];
    let (tx, rx) = mpsc::channel::<Result<Location, String>>();
    for url in sources {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let result = request_json(url)
                .ok()
                .and_then(|v| parse_location(&v))
                .ok_or_else(|| format!("{url} 未返回有效国家代码"));
            let _ = tx.send(result);
        });
    }
    drop(tx);
    let mut first_err = String::new();
    for _ in 0..sources.len() {
        match rx.recv() {
            Ok(Ok(loc)) => return Ok(loc),
            Ok(Err(e)) if first_err.is_empty() => first_err = e,
            Ok(Err(_)) => {}
            Err(_) => break,
        }
    }
    Err(if first_err.is_empty() { "IP 归属地查询失败".into() } else { first_err })
}

fn fetch_now(app: &AppHandle, force: bool, snapshot: String) -> Result<Value, String> {
    // FlClash 的单飞语义：同一时刻只允许一个探测；刷新期间保留缓存值。
    // 手动刷新允许等待，自动监测已经在后台线程，不会被这里阻塞。
    if PROBE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        let _guard = STATE_LOCK.lock().expect("netip lock");
        return Ok(status_value(&load(app)));
    }
    struct ProbeGuard;
    impl Drop for ProbeGuard {
        fn drop(&mut self) { PROBE_IN_FLIGHT.store(false, Ordering::SeqCst); }
    }
    let _probe_guard = ProbeGuard;

    // 只把“检查并占一次请求额度”放在锁内。真正的网络请求在锁外执行，
    // 否则一次慢请求会卡住 netip_status / 设置页和语言切换相关的状态读取。
    let (mut s, attempts) = {
        let _guard = STATE_LOCK.lock().expect("netip lock");
        let mut s = load(app);
        let remaining = DAILY_LIMIT.saturating_sub(s.requests);
        if remaining == 0 {
            return Err(format!("今日 IP 归属地请求已达上限 {DAILY_LIMIT} 次；明天会自动恢复"));
        }
        let backoff_elapsed = s.auto_failure_streak > 0 && now_ms() >= s.last_auto_failure_ms;
        let auto_needed = (s.last_snapshot != snapshot || s.location.is_none())
            && (s.last_attempt_snapshot != snapshot || backoff_elapsed);
        if !force && !auto_needed { return Ok(status_value(&s)); }
        let requested = if force { s.retry_count.min(MAX_RETRIES).saturating_add(1) } else { 1 };
        let attempts = requested.min(remaining as u32).max(1);
        s.last_attempt_snapshot = snapshot.clone();
        s.requests += 1;
        save(app, &s)?;
        (s, attempts)
    };

    let mut last_err = String::new();
    for attempt in 0..attempts {
        match request_location() {
            Ok(loc) => {
                let _guard = STATE_LOCK.lock().expect("netip lock");
                s.location = Some(loc);
                s.last_snapshot = snapshot;
                s.updated_at = now_ms();
                s.last_error.clear();
                s.last_auto_failure_ms = 0;
                s.auto_failure_streak = 0;
                save(app, &s)?;
                emit_status(app, &s);
                return Ok(status_value(&s));
            }
            Err(e) => {
                last_err = e;
                {
                    let _guard = STATE_LOCK.lock().expect("netip lock");
                    s.last_error = last_err.clone();
                    s.auto_failure_streak = s.auto_failure_streak.saturating_add(1);
                    let idx = (s.auto_failure_streak as usize).min(AUTO_FAILURE_BACKOFF_MS.len() - 1);
                    s.last_auto_failure_ms = now_ms() + AUTO_FAILURE_BACKOFF_MS[idx];
                    save(app, &s)?;
                }
                if attempt + 1 < attempts {
                    std::thread::sleep(Duration::from_millis(900 + attempt as u64 * 350));
                    let exhausted = {
                        let _guard = STATE_LOCK.lock().expect("netip lock");
                        if s.requests >= DAILY_LIMIT {
                            true
                        } else {
                            s.requests += 1;
                            save(app, &s)?;
                            false
                        }
                    };
                    if exhausted {
                        last_err = format!("今日 IP 归属地请求已达上限 {DAILY_LIMIT} 次；明天会自动恢复");
                        break;
                    }
                }
            }
        }
    }
    let _guard = STATE_LOCK.lock().expect("netip lock");
    emit_status(app, &s);
    Err(last_err)
}

#[tauri::command]
pub fn netip_refresh(app: AppHandle) -> Result<Value, String> {
    fetch_now(&app, true, network_snapshot())
}

/// 网络监测分两层（参考 FlClash 的 connectivity 事件 + route epoch）：
/// 1. Windows 原生 IP Helper 通知只唤醒后台线程，不轮询 PowerShell；
/// 2. 后台线程串行读取网络指纹，变化后防抖，再进入单飞 IP 探测。
///
/// 没有网络事件时，这里会阻塞等待，不产生任何 PowerShell 子进程。
pub fn start_monitor(app: AppHandle) {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut notify_handle: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::NetworkManagement::IpHelper::NotifyIpInterfaceChange;
            use windows_sys::Win32::Networking::WinSock::AF_INET;
            let r = NotifyIpInterfaceChange(
                AF_INET,
                Some(on_network_changed),
                std::ptr::null(),
                false,
                &mut notify_handle,
            );
            if r != 0 { notify_handle = std::ptr::null_mut(); }
            // 线程与进程同寿命；句柄在进程退出时由系统回收。
            let _ = notify_handle;
        }

        let mut first = true;
        let mut last_seen = String::new();
        // None = 空闲；Some((fingerprint, due)) = 防抖/退避后探测。
        let mut pending: Option<(String, Instant)> = None;

        loop {
            let now = Instant::now();
            let wait = if first {
                Duration::ZERO
            } else if let Some((_, due)) = pending.as_ref() {
                due.saturating_duration_since(now).min(Duration::from_secs(30))
            } else {
                Duration::from_secs(30)
            };

            let woke = {
                let (lock, cv) = &*MONITOR_WAKE;
                let mut dirty = lock.lock().expect("netip wake lock");
                if !*dirty && !wait.is_zero() {
                    let (guard, _) = cv.wait_timeout(dirty, wait).expect("netip wait");
                    dirty = guard;
                }
                std::mem::replace(&mut *dirty, false)
            };

            // 只有首次启动、网络事件或 30 秒兜底时才产生 PowerShell 快照；
            // 等待防抖/退避到期时不会再读网络。
            let should_snapshot = first || woke || wait >= Duration::from_secs(29);
            first = false;
            if should_snapshot {
                let fp = network_snapshot();
                if !fp.trim().is_empty() && fp != last_seen {
                    last_seen = fp.clone();
                    let debounce = {
                        let _guard = STATE_LOCK.lock().expect("netip lock");
                        load(&app).debounce_ms
                    };
                    pending = Some((fp, Instant::now() + Duration::from_millis(debounce)));
                }
            }

            let due_now = pending.as_ref().is_some_and(|(_, due)| Instant::now() >= *due);
            if !due_now { continue; }
            let (fingerprint, _) = pending.take().expect("pending fingerprint");

            let should_probe = {
                let _guard = STATE_LOCK.lock().expect("netip lock");
                let s = load(&app);
                let needs_value = s.last_snapshot != fingerprint || s.location.is_none();
                let cooldown_done = now_ms() >= s.last_auto_failure_ms;
                needs_value
                    && s.last_attempt_snapshot != fingerprint
                    && s.requests < DAILY_LIMIT
                    && cooldown_done
            };
            if !should_probe { continue; }

            match fetch_now(&app, false, fingerprint.clone()) {
                Ok(_) => {}
                Err(_) => {
                    // 失败后按已持久化的指数退避时间重新排队；不会在 250ms 轮询里
                    // 反复启动 PowerShell / 网络请求。
                    let next_ms = {
                        let _guard = STATE_LOCK.lock().expect("netip lock");
                        load(&app).last_auto_failure_ms
                    };
                    let delay = (next_ms.saturating_sub(now_ms()) as u64).max(1_000);
                    pending = Some((fingerprint, Instant::now() + Duration::from_millis(delay)));
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence_is_bounded_and_grows() {
        assert_eq!(AUTO_FAILURE_BACKOFF_MS[0], 0);
        for i in 1..AUTO_FAILURE_BACKOFF_MS.len() {
            assert!(AUTO_FAILURE_BACKOFF_MS[i] >= AUTO_FAILURE_BACKOFF_MS[i - 1]);
        }
        assert_eq!(*AUTO_FAILURE_BACKOFF_MS.last().unwrap(), 300_000);
    }

    #[test]
    fn parses_country_from_multiple_source_shapes() {
        let a = parse_location(&json!({"country":"CN","city":"Changsha"})).unwrap();
        assert_eq!(a.country, "CN");
        let b = parse_location(&json!({"country_code":"us"})).unwrap();
        assert_eq!(b.country, "US");
        assert!(parse_location(&json!({"country":""})).is_none());
    }

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
