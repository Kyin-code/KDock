//! 模型计费：DeepSeek 的峰谷时段 + 中国法定节假日。
//!
//! DeepSeek 按北京时间计费：周一至周五 09:00-12:00、14:00-18:00 为峰价，
//! 其余时段、周末和法定节假日为谷价。节假日表优先用 timor.tech，
//! 拉不到时用内置表，保证离线也能正确计费。

use std::collections::{BTreeMap, HashSet};

use chrono::{Datelike, FixedOffset, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::store;

const CACHE_MAX_AGE_MS: i64 = 30 * 86_400_000;
const CST_OFFSET_SECONDS: i32 = 8 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheYear {
    dates: Vec<String>,
    #[serde(default)]
    fetched_ms: i64,
    #[serde(default)]
    attempt_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HolidayCache {
    #[serde(default)]
    years: BTreeMap<String, CacheYear>,
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(store::agent_dir(app)?.join("holidays.json"))
}

fn load_cache(app: &AppHandle) -> HolidayCache {
    let Ok(path) = cache_path(app) else {
        return HolidayCache::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return HolidayCache::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_cache(app: &AppHandle, cache: &HolidayCache) {
    let Ok(path) = cache_path(app) else { return };
    let Ok(text) = serde_json::to_string_pretty(cache) else {
        return;
    };
    let _ = std::fs::write(path, text);
}

fn bundled(year: i32) -> Vec<String> {
    let dates: &[&str] = match year {
        2025 => &[
            "2025-01-01",
            "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
            "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
            "2025-04-04", "2025-04-05", "2025-04-06",
            "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
            "2025-05-31", "2025-06-01", "2025-06-02",
            "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
            "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
        ],
        2026 => &[
            "2026-01-01", "2026-01-02", "2026-01-03",
            "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18",
            "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
            "2026-04-04", "2026-04-05", "2026-04-06",
            "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
            "2026-06-19", "2026-06-20", "2026-06-21",
            "2026-09-25", "2026-09-26", "2026-09-27",
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
            "2026-10-05", "2026-10-06", "2026-10-07",
        ],
        _ => &[],
    };
    dates.iter().map(|s| (*s).to_string()).collect()
}

fn fetch_year(year: i32) -> Result<Vec<String>, String> {
    let url = format!("https://timor.tech/api/holiday/year/{year}");
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(4))
        .call()
        .map_err(|e| format!("拉取 {year} 年节假日失败: {e}"))?;
    let body: Value = resp
        .into_json()
        .map_err(|e| format!("解析 {year} 年节假日失败: {e}"))?;
    let Some(items) = body.get("holiday").and_then(|v| v.as_object()) else {
        return Err("节假日接口没有返回 holiday".into());
    };
    let mut dates = Vec::new();
    for item in items.values() {
        if item.get("holiday").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(date) = item.get("date").and_then(|v| v.as_str()) {
                dates.push(date.to_string());
            }
        }
    }
    dates.sort();
    dates.dedup();
    Ok(dates)
}

fn year_dates(app: &AppHandle, year: i32, fetch: bool) -> Vec<String> {
    let mut cache = load_cache(app);
    let key = year.to_string();
    let now = Utc::now().timestamp_millis();
    if let Some(item) = cache.years.get(&key) {
        let cache_fresh = now - item.fetched_ms < CACHE_MAX_AGE_MS;
        let recent_attempt = now - item.attempt_ms < CACHE_MAX_AGE_MS;
        if !fetch || cache_fresh || recent_attempt {
            return item.dates.clone();
        }
    }
    if fetch {
        if let Ok(dates) = fetch_year(year) {
            cache.years.insert(
                key,
                CacheYear {
                    dates: dates.clone(),
                    fetched_ms: now,
                    attempt_ms: now,
                },
            );
            save_cache(app, &cache);
            return dates;
        }
        // 失败也记一笔，半小时内不再反复联网；期间用上次缓存或内置表。
        let dates = cache
            .years
            .get(&key)
            .map(|x| x.dates.clone())
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| bundled(year));
        cache.years.insert(
            key,
            CacheYear {
                dates: dates.clone(),
                fetched_ms: 0,
                attempt_ms: now,
            },
        );
        save_cache(app, &cache);
        return dates;
    }
    cache
        .years
        .get(&key)
        .map(|x| x.dates.clone())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| bundled(year))
}

fn china_time(ts_ms: i64) -> Option<chrono::DateTime<FixedOffset>> {
    let offset = FixedOffset::east_opt(CST_OFFSET_SECONDS)?;
    Utc.timestamp_millis_opt(ts_ms).single().map(|t| t.with_timezone(&offset))
}

fn is_peak_with(ts_ms: i64, holidays: &HashSet<String>) -> bool {
    let Some(t) = china_time(ts_ms) else { return false };
    let weekday = t.weekday().number_from_monday();
    if weekday >= 6 {
        return false;
    }
    let date = t.format("%Y-%m-%d").to_string();
    if holidays.contains(&date) {
        return false;
    }
    let minutes = t.hour() * 60 + t.minute();
    (9 * 60..12 * 60).contains(&minutes) || (14 * 60..18 * 60).contains(&minutes)
}

/// 当前是否峰价（只读本地缓存 / 内置表，不在计费热路径里发网络请求）。
pub fn is_peak_at(app: &AppHandle, ts_ms: i64) -> bool {
    let Some(t) = china_time(ts_ms) else { return false };
    let dates = year_dates(app, t.year(), false);
    let set: HashSet<String> = dates.into_iter().collect();
    is_peak_with(ts_ms, &set)
}

fn next_change(ts_ms: i64, holidays: &HashSet<String>) -> i64 {
    let Some(now) = china_time(ts_ms) else { return ts_ms + 60_000 };
    let minute = now.minute() as i64;
    let second = now.second() as i64;
    let next_minute = ts_ms - minute * 60_000 - second * 1_000
        + (minute + 1) * 60_000;
    if is_peak_with(next_minute, holidays) != is_peak_with(ts_ms, holidays) {
        return next_minute;
    }
    // 最多向前看 4 小时，避开逐个 1 分钟扫描。
    for step in 1..=240 {
        let t = next_minute + step * 60_000;
        if is_peak_with(t, holidays) != is_peak_with(ts_ms, holidays) {
            return t;
        }
    }
    next_minute
}

/// 给前端一次带齐当前状态和未来一年节假日；节假日只在这里按需联网并落盘缓存。
#[tauri::command]
pub fn agent_pricing_calendar(app: AppHandle, years: Option<Vec<i32>>) -> Value {
    let now = Utc::now().timestamp_millis();
    let this_year = china_time(now).map(|t| t.year()).unwrap_or(2026);
    let mut wanted = years.unwrap_or_else(|| vec![this_year]);
    wanted.push(this_year);
    wanted.sort_unstable();
    wanted.dedup();
    let mut out = BTreeMap::new();
    for year in wanted {
        out.insert(year, year_dates(&app, year, true));
    }
    let dates = out.get(&this_year).cloned().unwrap_or_default();
    let set: HashSet<String> = dates.into_iter().collect();
    json!({
        "timezone": "Asia/Shanghai",
        "years": out,
        "peak": is_peak_with(now, &set),
        "nextChangeMs": next_change(now, &set),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holidays() -> HashSet<String> {
        bundled(2026).into_iter().collect()
    }

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        chrono::FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn deepseek_peak_windows_in_china_time() {
        let h = holidays();
        assert!(is_peak_with(at(2026, 10, 12, 9, 0), &h));
        assert!(is_peak_with(at(2026, 10, 12, 11, 59), &h));
        assert!(!is_peak_with(at(2026, 10, 12, 12, 0), &h));
        assert!(is_peak_with(at(2026, 10, 12, 14, 0), &h));
        assert!(is_peak_with(at(2026, 10, 12, 17, 59), &h));
        assert!(!is_peak_with(at(2026, 10, 12, 18, 0), &h));
        assert!(!is_peak_with(at(2026, 10, 12, 8, 59), &h));
    }

    #[test]
    fn weekends_and_holidays_are_offpeak() {
        let h = holidays();
        assert!(!is_peak_with(at(2026, 10, 17, 10, 0), &h)); // 周六
        assert!(!is_peak_with(at(2026, 10, 7, 10, 0), &h));  // 国庆
        assert!(is_peak_with(at(2026, 10, 8, 10, 0), &h));   // 节后工作日
    }

    #[test]
    fn next_change_uses_window_boundary() {
        let h = holidays();
        let t = at(2026, 10, 12, 10, 30);
        assert_eq!(next_change(t, &h), at(2026, 10, 12, 12, 0));
    }

    #[test]
    fn cost_uses_the_selected_peak_window() {
        let p = store::ModelPricing {
            currency: "USD".into(),
            peak_hit: 0.006,
            peak_miss: 0.30,
            peak_out: 1.20,
            offpeak_hit: 0.003,
            offpeak_miss: 0.15,
            offpeak_out: 0.60,
        };
        assert!((p.cost(true, 1_000_000, 1_000_000, 1_000_000) - 1.506).abs() < 1e-9);
        assert!((p.cost(false, 1_000_000, 1_000_000, 1_000_000) - 0.753).abs() < 1e-9);
    }
}
