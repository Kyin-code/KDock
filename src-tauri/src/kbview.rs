//! KDock 的共享内部浏览器：往主窗口里贴 **WebView2 子视图**。
//!
//! 为什么要这么干：KDock 自己的界面是纯 HTML（CSP 里 `frame-src 'none'`），而 Dify 这种
//! 现代网页通常是重前端（React + JS 渲染），拿 HTTP "抓正文"的路子只能
//! 拿到一个空壳。所以这里用 Tauri 的多 WebView 能力，把外部页面当成"窗口里的另一块画布"
//! 铺在指定矩形上 —— 位置与大小由前端按 DOM 里那块占位区的实际坐标算好传进来（CSS 像素，
//! 相对窗口客户区）。
//!
//! 注意：
//! - 子视图是**盖在** HTML 上的原生层，所以它盖住的区域里 HTML 收不到点击；工具条/地址栏
//!   要放在占位区之外。
//! - 弹出的浮层（设置弹窗等）也会被它盖住，所以浮层打开时前端会调 `kb_hide_all`。
//! - 这里只管理共享视图的显示、导航和只读 DOM 抽取。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
};

static KB: LazyLock<Mutex<HashMap<String, Webview>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LOADS: LazyLock<Mutex<HashMap<String, LoadState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TITLES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FAVICONS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// 每个页面独立串行，页面之间可以并行工作。两个会话操作同一页时，仍不能让
/// DOM 动作落到导航中的半成品页面上。
static BROWSER_OPS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Serialize "check whether the view exists, then create it". Without this,
/// the Browser page and a scheduled Agent run can both observe no view and one
/// of them can lose its initial URL.
static OPEN_GATE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static ACTIVE_PAGE: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("browser".into()));
static PAGE_SEQ: AtomicU64 = AtomicU64::new(1);

fn page_gate(kind: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut gates = BROWSER_OPS.lock().map_err(|_| "浏览器操作锁不可用".to_string())?;
    Ok(gates
        .entry(kind.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

pub fn new_page_id() -> String {
    format!(
        "browser-{}-{}",
        std::process::id(),
        PAGE_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn active_page() -> String {
    ACTIVE_PAGE
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "browser".into())
}

pub fn activate(kind: &str) {
    if let Ok(map) = KB.lock() {
        for (id, wv) in map.iter() {
            if id != kind {
                let _ = wv.hide();
            }
        }
    }
    if let Ok(mut active) = ACTIVE_PAGE.lock() {
        *active = kind.to_string();
    }
}

#[derive(Debug, Clone, Default)]
struct LoadState {
    /// Changes on every top-level load event. A title query captures this value so
    /// a late callback from the previous page cannot overwrite the new one.
    revision: u64,
    loading: bool,
    last_url: String,
    /// Monotonic id for Agent-initiated navigations.
    request: u64,
    request_started: bool,
    request_finished: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub links: Vec<Link>,
    #[serde(default)]
    pub fetched_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub text: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub icon: String,
    pub loading: bool,
    pub active: bool,
}

fn clamp_min(v: f64) -> f64 {
    if v.is_finite() && v > 1.0 {
        v
    } else {
        1.0
    }
}

/// Agent may pass a bare domain. The shared view only accepts web URLs; explicit
/// non-web schemes such as `file:` or `javascript:` should not reach WebView2.
fn normalize_url(input: &str) -> Result<tauri::Url, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("网址是空的".into());
    }
    let lower = raw.to_ascii_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        raw.to_string()
    } else if lower.contains("://")
        || ["javascript:", "data:", "file:", "mailto:", "about:"]
            .iter()
            .any(|scheme| lower.starts_with(scheme))
    {
        return Err("共享浏览器只支持 http:// 和 https:// 网址".into());
    } else {
        format!("https://{raw}")
    };
    let parsed: tauri::Url = candidate
        .parse()
        .map_err(|e| format!("这个地址打不开（{raw}）：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("共享浏览器只支持 http:// 和 https:// 网址".into());
    }
    Ok(parsed)
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") || (url.scheme() == "about" && url.path() == "blank")
}

fn js_string_value(raw: String) -> String {
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or(raw)
}

fn begin_navigation(kind: &str) -> Result<u64, String> {
    let mut loads = LOADS.lock().map_err(|_| "load mutex".to_string())?;
    let state = loads.entry(kind.to_string()).or_default();
    state.request = state.request.wrapping_add(1);
    state.request_started = false;
    state.request_finished = false;
    Ok(state.request)
}

fn record_load(kind: &str, url: &str, event: PageLoadEvent) -> u64 {
    let mut loads = match LOADS.lock() {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let state = loads.entry(kind.to_string()).or_default();
    state.revision = state.revision.wrapping_add(1);
    state.last_url = url.to_string();
    state.loading = event == PageLoadEvent::Started;
    match event {
        PageLoadEvent::Started => {
            if state.request > 0 {
                state.request_started = true;
            }
            state.request_finished = false;
        }
        PageLoadEvent::Finished => {
            if state.request_started {
                state.request_finished = true;
            }
        }
    }
    state.revision
}

fn load_snapshot(kind: &str) -> Option<(bool, bool, bool, String)> {
    LOADS.lock().ok().and_then(|m| {
        m.get(kind).map(|s| {
            (
                s.loading,
                s.request_started,
                s.request_finished,
                s.last_url.clone(),
            )
        })
    })
}

fn timeout_message(kind: &str, timeout: Duration) -> String {
    let where_ = load_snapshot(kind)
        .map(|(_, _, _, url)| url)
        .filter(|s| !s.is_empty())
        .or_else(|| current_url(kind))
        .unwrap_or_else(|| "（还没有地址）".into());
    format!("等待页面加载超时（{} 秒）：{}", timeout.as_secs(), where_)
}

/// Wait until the current top-level document is not loading.
pub fn wait_for_load(kind: &str, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let ready = load_snapshot(kind)
            .map(|(loading, _, _, _)| !loading)
            .unwrap_or(false);
        if ready {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(timeout_message(kind, timeout));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Wait for the navigation request that was issued after `begin_navigation`.
/// A Finished event from the previously loading page is ignored until a new
/// Started event has been observed for this request. The final quiet window
/// absorbs common immediate client-side redirects.
fn wait_for_request(
    kind: &str,
    request: u64,
    quiet: Duration,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    let mut quiet_since: Option<Instant> = None;
    loop {
        let current = LOADS.lock().ok().and_then(|m| {
            m.get(kind).map(|s| {
                (
                    s.request == request,
                    s.request_started,
                    s.request_finished,
                    s.loading,
                )
            })
        });
        if let Some((matches, saw_start, saw_finish, loading)) = current {
            if matches && saw_start && saw_finish && !loading {
                let since = quiet_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= quiet {
                    return Ok(());
                }
            } else {
                quiet_since = None;
            }
        }
        if started.elapsed() >= timeout {
            return Err(timeout_message(kind, timeout));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn show_inner(
    app: &AppHandle,
    kind: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let parsed = normalize_url(url)?;
    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(clamp_min(w), clamp_min(h));
    let mut map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    if let Some(wv) = map.get(kind) {
        // Agent 用 0×0 只做跳转时不要把已隐藏的视图露出来；浏览器页随后
        // 会按真实占位区调用一次 show 把它放好。
        let placement_only = w <= 1.0 || h <= 1.0;
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        // show 只负责显示与布局；显式导航走 navigate，避免布局刷新把用户在
        // 站内跳转或登录后的页面拽回地址栏旧值。首次创建时 WebviewUrl 已加载 URL。
        if !placement_only {
            wv.show().map_err(|e| e.to_string())?;
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let win = app.get_window("main").ok_or("找不到主窗口")?;
    let app_handle = app.clone();
    let kind_for_load = kind.to_string();
    let app_title_change = app.clone();
    let kind_title_change = kind.to_string();
    let wv = win
        .add_child(
            WebviewBuilder::new(format!("kb-{kind}"), WebviewUrl::External(parsed))
                // A page must not be able to turn the embedded browser into a
                // local-file or custom-protocol viewer after the first load.
                .on_navigation(|url| navigation_allowed(url))
                .on_document_title_changed(move |webview, title| {
                    let loading = LOADS
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&kind_title_change).map(|s| s.loading))
                        .unwrap_or(false);
                    if loading {
                        return;
                    }
                    if let Ok(mut titles) = TITLES.lock() {
                        titles.insert(kind_title_change.clone(), title.clone());
                    }
                    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
                    if !url.is_empty() {
                        let _ = app_title_change.emit(
                            "kb://page",
                            serde_json::json!({
                                "page": kind_title_change,
                                "url": url,
                                "title": title,
                                "loading": false,
                            }),
                        );
                    }
                })
                .on_page_load(move |webview, payload| {
                    let url = payload.url().to_string();
                    let event = payload.event();
                    let revision = record_load(&kind_for_load, &url, event);
                    let _ = app_handle.emit(
                        "kb://page",
                        serde_json::json!({
                            "page": kind_for_load,
                            "url": url,
                            "loading": event == PageLoadEvent::Started,
                        }),
                    );
                    if event != PageLoadEvent::Finished {
                        return;
                    }
                    // Instrument fetch/XHR and runtime errors early enough for agent
                    // actions performed after the load to be observable.
                    let _ = webview.eval(BROWSER_PROBE_JS);

                    // The page-load hook only carries the URL. Query the real title
                    // after the document is ready and publish it to the Agent pane.
                    let app_title = app_handle.clone();
                    let kind_title = kind_for_load.clone();
                    let url_title = url.clone();
                    let _ = webview.eval_with_callback("document.title || ''", move |raw| {
                        let title = js_string_value(raw);
                        let still_current = LOADS
                            .lock()
                            .ok()
                            .and_then(|mut loads| {
                                loads.get_mut(&kind_title).map(|s| {
                                    if s.revision == revision {
                                        true
                                    } else {
                                        false
                                    }
                                })
                            })
                            .unwrap_or(false);
                        if still_current {
                            if let Ok(mut titles) = TITLES.lock() {
                                titles.insert(kind_title.clone(), title.clone());
                            }
                            let _ = app_title.emit(
                                "kb://page",
                                serde_json::json!({
                                    "page": kind_title,
                                    "url": url_title,
                                    "title": title,
                                    "loading": false,
                                }),
                            );
                        }
                    });
                    let app_icon = app_handle.clone();
                    let kind_icon = kind_for_load.clone();
                    let _ = webview.eval_with_callback(FAVICON_JS, move |raw| {
                        let icon = js_string_value(raw);
                        let icon = if icon.starts_with("data:image/")
                            || icon.starts_with("http://")
                            || icon.starts_with("https://")
                        {
                            icon
                        } else {
                            String::new()
                        };
                        if icon.is_empty() {
                            return;
                        }
                        if let Ok(mut icons) = FAVICONS.lock() {
                            icons.insert(kind_icon.clone(), icon.clone());
                        }
                        let _ = app_icon.emit(
                            "kb://favicon",
                            serde_json::json!({ "page": kind_icon, "icon": icon }),
                        );
                    });
                }),
            pos,
            size,
        )
        .map_err(|e| format!("建内置浏览器失败：{e}"))?;
    // 新建的原生子视图默认是可见的。Agent 用 0×0 建页时先藏起来，等浏览器页
    // 按真实占位区调用 show 再显示，避免窗口左上角闪过一块原生网页。
    if w <= 1.0 || h <= 1.0 {
        wv.hide().map_err(|e| e.to_string())?;
    }
    map.insert(kind.to_string(), wv);
    Ok(())
}

/// 贴上一块（第一次创建子 WebView；已经建过时只调整位置并显示）
pub fn show(
    app: &AppHandle,
    kind: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    activate(kind);
    let _gate = OPEN_GATE
        .lock()
        .map_err(|_| "浏览器创建锁不可用".to_string())?;
    show_inner(app, kind, url, x, y, w, h)
}

/// 只挪位置 / 改大小（页面切换、拖分栏、改窗口大小时调）
pub fn bounds(app: &AppHandle, kind: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let _ = app;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    if let Some(wv) = map.get(kind) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(clamp_min(w), clamp_min(h)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn hide(kind: &str) {
    if let Ok(map) = KB.lock() {
        if let Some(wv) = map.get(kind) {
            let _ = wv.hide();
        }
    }
}

pub fn hide_all() {
    if let Ok(map) = KB.lock() {
        for wv in map.values() {
            let _ = wv.hide();
        }
    }
}

/// 共享浏览器唯一入口：已有视图就导航，没有就创建一块隐藏视图。调用方不需要
/// 先猜视图是否存在，避免 Agent 刚建页、前端事件还没到时重复创建或只挪位置。
fn open_inner(app: &AppHandle, kind: &str, url: &str) -> Result<(), String> {
    let exists = {
        let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
        map.contains_key(kind)
    };
    let result = if exists {
        navigate_inner(kind, url)
    } else {
        show_inner(app, kind, url, 0.0, 0.0, 0.0, 0.0)
    };
    if result.is_ok() {
        if let Ok(mut active) = ACTIVE_PAGE.lock() {
            *active = kind.to_string();
        }
        let _ = app.emit("kb://active", serde_json::json!({ "page": kind }));
    }
    result
}

fn browser_page_url(url: String) -> Option<String> {
    if url.eq_ignore_ascii_case("about:blank") {
        None
    } else {
        Some(url)
    }
}

pub fn open(app: &AppHandle, kind: &str, url: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    let _gate = OPEN_GATE
        .lock()
        .map_err(|_| "浏览器创建锁不可用".to_string())?;
    open_inner(app, kind, url)
}

/// Navigation used by Agent tools. Calls are serialized because the browser is
/// a single shared page; each caller waits for its own navigation to settle.
pub fn open_and_wait(
    app: &AppHandle,
    kind: &str,
    url: &str,
    timeout: Duration,
) -> Result<String, String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    open_and_wait_locked(app, kind, url, timeout)
}

fn open_and_wait_locked(
    app: &AppHandle,
    kind: &str,
    url: &str,
    timeout: Duration,
) -> Result<String, String> {
    let request = begin_navigation(kind)?;
    {
        // Only the create-or-navigate decision needs OPEN_GATE. Holding it while
        // waiting for the network would also block harmless UI repositioning.
        let _gate = OPEN_GATE
            .lock()
            .map_err(|_| "浏览器创建锁不可用".to_string())?;
        open_inner(app, kind, url)?;
    }
    wait_for_request(kind, request, Duration::from_millis(300), timeout)?;
    current_url(kind).ok_or_else(|| "页面加载后没有可用地址".to_string())
}

/// Navigate and read in one serialized operation. This prevents another Agent
/// session from replacing the page between browser_read(url)'s navigation and
/// its DOM read.
pub fn open_and_read_json(
    app: &AppHandle,
    kind: &str,
    url: &str,
    timeout: Duration,
) -> Result<String, String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    open_and_wait_locked(app, kind, url, timeout)?;
    read_dom_json_inner(kind)
}

/// 刷新（重载当前地址）
pub fn reload(kind: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("这块还没打开过")?;
    let url = wv.url().map_err(|e| e.to_string())?;
    wv.navigate(url).map_err(|e| format!("刷新失败：{e}"))
}

/// 这块现在停在哪个地址（页面可能自己跳转过，比如登录后）—— 给地址栏回显用
pub fn current_url(kind: &str) -> Option<String> {
    let map = KB.lock().ok()?;
    let wv = map.get(kind)?;
    // WebView2 reports its initial document as about:blank. That is a
    // placeholder, not a navigable user page, and must not be sent back to the
    // address bar (it would later fail the http/https validation).
    wv.url().ok().map(|u| u.to_string()).and_then(browser_page_url)
}

pub fn pages() -> Vec<PageInfo> {
    let active = active_page();
    let titles = TITLES.lock().map(|m| m.clone()).unwrap_or_default();
    let icons = FAVICONS.lock().map(|m| m.clone()).unwrap_or_default();
    let loads = LOADS.lock().map(|m| m.clone()).unwrap_or_default();
    let ids: Vec<String> = KB
        .lock()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let mut out: Vec<PageInfo> = ids
        .into_iter()
        .map(|id| PageInfo {
            url: current_url(&id).unwrap_or_default(),
            title: titles.get(&id).cloned().unwrap_or_default(),
            icon: icons.get(&id).cloned().unwrap_or_default(),
            loading: loads.get(&id).map(|s| s.loading).unwrap_or(false),
            active: id == active,
            id,
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn close_page(kind: &str) -> Result<String, String> {
    let removed = KB
        .lock()
        .map_err(|_| "kb mutex".to_string())?
        .remove(kind);
    if let Some(view) = removed {
        let _ = view.close();
    }
    LOADS.lock().map_err(|_| "load mutex".to_string())?.remove(kind);
    TITLES.lock().map_err(|_| "title mutex".to_string())?.remove(kind);
    FAVICONS
        .lock()
        .map_err(|_| "favicon mutex".to_string())?
        .remove(kind);
    BROWSER_OPS
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?
        .remove(kind);
    let next = KB
        .lock()
        .ok()
        .and_then(|map| map.keys().next().cloned())
        .unwrap_or_else(|| "browser".into());
    if let Ok(mut active) = ACTIVE_PAGE.lock() {
        if active.as_str() == kind {
            *active = next.clone();
        }
    }
    Ok(next)
}

fn navigate_inner(kind: &str, url: &str) -> Result<(), String> {
    let parsed = normalize_url(url)?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    wv.navigate(parsed).map_err(|e| format!("跳转失败：{e}"))
}

pub fn navigate(kind: &str, url: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    navigate_inner(kind, url)
}

pub fn back(kind: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    wv.eval("history.back()").map_err(|e| e.to_string())
}

pub fn source(app: &AppHandle, kind: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    let app = app.clone();
    wv.eval_with_callback(
        "(() => (document.documentElement.outerHTML || '').slice(0, 1500000))()",
        move |s| {
            let _ = app.emit("kb://source", js_string_value(s));
        },
    )
    .map_err(|e| e.to_string())
}

pub fn read_dom(app: &AppHandle, kind: &str) -> Result<(), String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    let app = app.clone();
    let js = r#"
      (() => {
        const page = {
        url: location.href,
        title: document.title || '',
        text: (document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200000),
        html: (document.documentElement.outerHTML || '').slice(0, 1500000),
        links: [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({text:(a.innerText||'').trim().slice(0,80), href:a.href}))
        };
        return JSON.stringify(page);
      })()
    "#;
    wv.eval_with_callback(js, move |s| {
        let _ = app.emit("kb://dom", js_string_value(s));
    })
    .map_err(|e| e.to_string())
}

/// 同步读取当前 WebView2 的 DOM。Agent 工具在命令线程里调用；回调通过 channel
/// 回来，避免为了读一次网页就复制一套浏览器/会话。
pub fn read_dom_json(kind: &str) -> Result<String, String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    read_dom_json_inner(kind)
}

fn read_dom_json_inner(kind: &str) -> Result<String, String> {
    wait_for_load(kind, Duration::from_secs(8))?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("共享浏览器还没有打开页面")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let js = r#"
      (() => {
        const page = {
          url: location.href,
          title: document.title || '',
          text: (document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200000),
          html: (document.documentElement.outerHTML || '').slice(0, 1500000),
          links: [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({text:(a.innerText||'').trim().slice(0,80), href:a.href})),
          fetched_ms: Date.now()
        };
        return JSON.stringify(page);
      })()
    "#;
    wv.eval_with_callback(js, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|e| format!("读取当前页超时：{e}"))?;
    // WebView2 会把 JS 返回的字符串再 JSON 编码一层；剥到对象 JSON。
    Ok(js_string_value(raw))
}

fn eval_json(kind: &str, js: String) -> Result<String, String> {
    let gate = page_gate(kind)?;
    let _op = gate
        .lock()
        .map_err(|_| "浏览器操作锁不可用".to_string())?;
    wait_for_load(kind, Duration::from_secs(8))?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("共享浏览器还没有打开页面")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    wv.eval_with_callback(js, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(Duration::from_secs(8))
        .map_err(|e| format!("执行页面动作超时：{e}"))?;
    Ok(js_string_value(raw))
}

/// 按 CSS 选择器或可见文字点击页面元素。只执行一条明确的 DOM click，
/// 不开放任意 JavaScript，避免模型把浏览器变成脚本执行器。
pub fn click_json(kind: &str, selector: &str, text: &str) -> Result<String, String> {
    let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(text).map_err(|e| e.to_string())?;
    let js = format!(
        r#"(() => {{
          const selector = {selector};
          const wanted = ({text} || '').trim();
          const candidates = selector
            ? [...document.querySelectorAll(selector)]
            : [...document.querySelectorAll('a,button,input[type=button],input[type=submit],[role=button],label')];
          const target = candidates.find(el => {{
            if (!selector) return !!(wanted && ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim().includes(wanted)));
            return true;
          }});
          if (!target) return JSON.stringify({{ok:false,error:'没有找到可点击元素',selector,wanted}});
          target.scrollIntoView({{block:'center',inline:'center'}});
          target.click();
          return JSON.stringify({{
            ok:true,
            tag: target.tagName,
            text:(target.innerText || target.value || '').trim().slice(0,160),
            url: location.href
          }});
        }})()"#
    );
    eval_json(kind, js)
}

/// 填写 input / textarea / contenteditable，并触发 input 与 change。
pub fn fill_json(
    kind: &str,
    selector: &str,
    text: &str,
    value: &str,
) -> Result<String, String> {
    let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(text).map_err(|e| e.to_string())?;
    let value = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let js = format!(
        r#"(() => {{
          const selector = {selector};
          const wanted = ({text} || '').trim();
          const value = {value};
          const candidates = selector
            ? [...document.querySelectorAll(selector)]
            : [...document.querySelectorAll('input,textarea,[contenteditable=true]')];
          const target = candidates.find(el => {{
            if (!selector) {{
              const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
              return !!(wanted && label.includes(wanted));
            }}
            return true;
          }});
          if (!target) return JSON.stringify({{ok:false,error:'没有找到输入元素',selector,wanted}});
          target.focus();
          if (target.isContentEditable) {{
            target.textContent = value;
          }} else {{
            const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(target, value); else target.value = value;
          }}
          target.dispatchEvent(new Event('input', {{bubbles:true}}));
          target.dispatchEvent(new Event('change', {{bubbles:true}}));
          return JSON.stringify({{
            ok:true,
            tag:target.tagName,
            name:target.name || '',
            value:String(value).slice(0,160)
          }});
        }})()"#
    );
    eval_json(kind, js)
}

/// Compact, structured page state for Agent decisions. Unlike raw HTML this
/// keeps only visible/interactable elements and bounded text.
pub fn snapshot_json(kind: &str, max_chars: usize) -> Result<String, String> {
    let max_chars = max_chars.clamp(500, 60_000);
    let js = format!(
        r#"(() => {{
          const maxChars = {max_chars};
          const visible = (el) => {{
            if (!el || !(el instanceof Element)) return false;
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 1 && r.height > 1;
          }};
          const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
            el.getAttribute('title') || el.innerText || el.value || el.name || '').trim().replace(/\s+/g, ' ').slice(0,180);
          const node = (el) => {{
            const r = el.getBoundingClientRect();
            return {{
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || '',
              type: el.getAttribute('type') || '',
              name: el.getAttribute('name') || '',
              id: el.id || '',
              text: label(el),
              value: ('value' in el ? String(el.value || '') : '').slice(0,180),
              disabled: !!el.disabled,
              checked: ('checked' in el ? !!el.checked : undefined),
              x: Math.round(r.x), y: Math.round(r.y),
              width: Math.round(r.width), height: Math.round(r.height)
            }};
          }};
          const all = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')]
            .filter(visible);
          const interactive = all.slice(0,300).map(node);
          const forms = [...document.forms].slice(0,30).map((f, i) => ({{
            index:i, id:f.id || '', name:f.name || '', action:f.action || '', method:(f.method||'').toUpperCase(),
            fields:[...f.elements].filter(visible).slice(0,80).map(node)
          }}));
          return JSON.stringify({{
            ok:true,
            url:location.href,
            title:document.title || '',
            readyState:document.readyState,
            text:(document.body?.innerText || '').replace(/\n{{3,}}/g,'\n\n').trim().slice(0,maxChars),
            interactive,
            forms,
            counts:{{interactive:all.length, inputs:all.filter(e=>['INPUT','TEXTAREA','SELECT'].includes(e.tagName)).length, links:document.links.length}}
          }});
        }})()"#
    );
    eval_json(kind, js)
}

/// Wait for one or more page conditions. Polling happens in Rust so each JS
/// round-trip remains a bounded state read rather than arbitrary script eval.
pub fn wait_for_json(
    kind: &str,
    selector: &str,
    text: &str,
    url_contains: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 30_000));
    let start = Instant::now();
    loop {
        let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let text = serde_json::to_string(text).map_err(|e| e.to_string())?;
        let url_contains = serde_json::to_string(url_contains).map_err(|e| e.to_string())?;
        let js = format!(
            r#"(() => {{
              const selector={selector}, wanted=({text}||'').trim(), urlWanted=({url_contains}||'').trim();
              const visible = (el) => {{
                if (!el) return false;
                const s=getComputedStyle(el), r=el.getBoundingClientRect();
                return s.display!=='none' && s.visibility!=='hidden' && r.width>1 && r.height>1;
              }};
              const node=selector ? document.querySelector(selector) : null;
              const body=(document.body?.innerText||'');
              const checks={{
                selector: !selector || !!node,
                visible: !selector || visible(node),
                text: !wanted || body.includes(wanted),
                url: !urlWanted || location.href.includes(urlWanted)
              }};
              return JSON.stringify({{ok:Object.values(checks).every(Boolean), checks, url:location.href, title:document.title||''}});
            }})()"#
        );
        let raw = eval_json(kind, js)?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("等待条件返回异常：{e}"))?;
        if value["ok"].as_bool().unwrap_or(false) {
            return Ok(raw);
        }
        if start.elapsed() >= timeout {
            return Err(format!(
                "等待页面条件超时 {}ms：{}",
                timeout.as_millis(),
                raw
            ));
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

pub fn assert_json(
    kind: &str,
    selector: &str,
    text: &str,
    url_contains: &str,
    value_equals: &str,
) -> Result<String, String> {
    let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(text).map_err(|e| e.to_string())?;
    let url_contains = serde_json::to_string(url_contains).map_err(|e| e.to_string())?;
    let value_equals = serde_json::to_string(value_equals).map_err(|e| e.to_string())?;
    let js = format!(
        r#"(() => {{
          const selector={selector}, wanted=({text}||'').trim(), urlWanted=({url_contains}||'').trim(), valueWanted={value_equals};
          const node=selector ? document.querySelector(selector) : null;
          const body=(document.body?.innerText||'');
          const checks={{
            selector: !selector || !!node,
            text: !wanted || body.includes(wanted),
            url: !urlWanted || location.href.includes(urlWanted),
            value: !valueWanted || (!!node && String(node.value ?? node.textContent ?? '') === valueWanted)
          }};
          return JSON.stringify({{ok:Object.values(checks).every(Boolean), checks, url:location.href, title:document.title||''}});
        }})()"#
    );
    eval_json(kind, js)
}

pub fn network_json(kind: &str, clear: bool) -> Result<String, String> {
    let clear_js = if clear { "true" } else { "false" };
    let js = format!(
        r#"(() => {{
          const obs = window.__kdockObs || {{network:[],errors:[]}};
          const resources = performance.getEntriesByType('resource').slice(-300).map(r => ({{
            kind:'resource', name:String(r.name||'').slice(0,500), type:r.initiatorType||'',
            start:Math.round(r.startTime||0), duration:Math.round(r.duration||0),
            transfer:r.transferSize||0, encoded:r.encodedBodySize||0
          }}));
          const result={{ok:true,url:location.href,network:[...resources,...obs.network].slice(-500),errors:obs.errors.slice(-100)}};
          if ({clear_js}) {{ obs.network=[]; obs.errors=[]; window.__kdockObs=obs; }}
          return JSON.stringify(result);
        }})()"#
    );
    eval_json(kind, js)
}

const FAVICON_JS: &str = r#"(async () => {
  try {
    const links = [...document.querySelectorAll(
      'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
    )];
    let href = links.length ? links[links.length - 1].href : '';
    if (!href) href = new URL('/favicon.ico', location.origin).href;
    if (!href) return '';
    try {
      const response = await fetch(href, { credentials: 'include', cache: 'force-cache' });
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 0 && blob.size <= 512 * 1024) {
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve(href);
            reader.readAsDataURL(blob);
          });
        }
      }
    } catch (_) {}
    return href;
  } catch (_) {
    return '';
  }
})()"#;

const BROWSER_PROBE_JS: &str = r#"(() => {
  if (window.__kdockProbeInstalled) return;
  window.__kdockProbeInstalled = true;
  const obs = window.__kdockObs = window.__kdockObs || { network: [], errors: [] };
  const push = (kind, data) => {
    if (kind === 'error') {
      obs.errors.push({ kind, message: String(data?.message || data || '').slice(0, 800), at: Date.now() });
      if (obs.errors.length > 100) obs.errors.shift();
      return;
    }
    obs.network.push({ kind, ...data, at: Date.now() });
    if (obs.network.length > 400) obs.network.shift();
  };
  const oldError = console.error;
  console.error = function(...args) {
    try { push('error', args.map(x => x?.message || String(x)).join(' ')); } catch (_) {}
    return oldError.apply(this, args);
  };
  addEventListener('error', e => push('error', e.error || e.message));
  addEventListener('unhandledrejection', e => push('error', e.reason || 'unhandled rejection'));
  const oldFetch = window.fetch;
  if (oldFetch) {
    window.fetch = async function(input, init) {
      const start = performance.now();
      const url = String(input?.url || input || '');
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      try {
        const res = await oldFetch.apply(this, arguments);
        push('network', { method, url: url.slice(0,500), status: res.status, duration: Math.round(performance.now()-start) });
        return res;
      } catch (e) {
        push('network', { method, url: url.slice(0,500), status: 0, error: String(e).slice(0,300), duration: Math.round(performance.now()-start) });
        throw e;
      }
    };
  }
  const oldOpen = XMLHttpRequest.prototype.open;
  const oldSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__kdockReq = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), start: 0 };
    return oldOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    const req = this.__kdockReq || {};
    req.start = performance.now();
    this.addEventListener('loadend', () => push('network', {
      method: req.method || 'GET', url: String(req.url || '').slice(0,500), status: Number(this.status || 0),
      duration: Math.round(performance.now() - (req.start || performance.now()))
    }), { once: true });
    return oldSend.apply(this, arguments);
  };
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_accept_bare_domains_and_reject_non_web_schemes() {
        assert_eq!(
            normalize_url("example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_url("localhost:1420").unwrap().as_str(),
            "https://localhost:1420/"
        );
        assert_eq!(
            normalize_url("http://127.0.0.1:1420/a").unwrap().as_str(),
            "http://127.0.0.1:1420/a"
        );
        assert!(normalize_url("file:///C:/secret.txt").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("   ").is_err());
        assert!(navigation_allowed(&"https://example.com/".parse().unwrap()));
        assert!(navigation_allowed(&"about:blank".parse().unwrap()));
        assert!(!navigation_allowed(
            &"file:///C:/secret.txt".parse().unwrap()
        ));
        assert!(!navigation_allowed(&"data:text/html,hi".parse().unwrap()));
    }

    #[test]
    fn eval_callback_string_is_decoded_once() {
        assert_eq!(js_string_value("\"<p>hi</p>\"".into()), "<p>hi</p>");
        assert_eq!(
            js_string_value("\"{\\\"url\\\":\\\"https://x\\\"}\"".into()),
            "{\"url\":\"https://x\"}"
        );
    }

    #[test]
    fn blank_placeholder_is_not_reported_as_a_page_url() {
        assert_eq!(browser_page_url("about:blank".into()), None);
        assert_eq!(
            browser_page_url("https://kyin.top/".into()),
            Some("https://kyin.top/".into())
        );
    }

    #[test]
    fn browser_pages_get_unique_ids_and_operation_gates() {
        let a = new_page_id();
        let b = new_page_id();
        assert_ne!(a, b);
        let ga = page_gate(&a).unwrap();
        let gb = page_gate(&b).unwrap();
        assert!(!Arc::ptr_eq(&ga, &gb), "different pages must not share the global operation lock");
        assert!(Arc::ptr_eq(&ga, &page_gate(&a).unwrap()));
    }

    #[test]
    fn previous_page_finish_does_not_complete_new_navigation() {
        let kind = format!("race-{}", std::process::id());
        let request = begin_navigation(&kind).unwrap();

        // The old page may finish after the new request starts but before
        // WebView2 emits Started for the new URL.
        record_load(&kind, "https://old.example/", PageLoadEvent::Finished);
        let snapshot = load_snapshot(&kind).unwrap();
        assert!(!snapshot.1, "new request must not have Started yet");
        assert!(!snapshot.2, "old Finished must not satisfy the new request");

        record_load(&kind, "https://new.example/", PageLoadEvent::Started);
        record_load(&kind, "https://new.example/", PageLoadEvent::Finished);
        wait_for_request(
            &kind,
            request,
            Duration::from_millis(1),
            Duration::from_secs(1),
        )
        .unwrap();
    }
}
