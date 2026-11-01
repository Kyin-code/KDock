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
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
};

static KB: LazyLock<Mutex<HashMap<String, Webview>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LOADS: LazyLock<Mutex<HashMap<String, LoadState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Agent 的导航必须串行。共享页只有一个，两个会话同时打开不同 URL 时，
/// 旧调用不能把另一个会话的完成事件误当成自己的结果。
static NAV: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// Serialize "check whether the view exists, then create it". Without this,
/// the Browser page and a scheduled Agent run can both observe no view and one
/// of them can lose its initial URL.
static OPEN_GATE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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
                    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
                    if !url.is_empty() {
                        let _ = app_title_change.emit(
                            "kb://page",
                            serde_json::json!({
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
                            "url": url,
                            "loading": event == PageLoadEvent::Started,
                        }),
                    );
                    if event != PageLoadEvent::Finished {
                        return;
                    }

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
                            let _ = app_title.emit(
                                "kb://page",
                                serde_json::json!({
                                    "url": url_title,
                                    "title": title,
                                    "loading": false,
                                }),
                            );
                        }
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
pub fn open(app: &AppHandle, kind: &str, url: &str) -> Result<(), String> {
    let _gate = OPEN_GATE
        .lock()
        .map_err(|_| "浏览器创建锁不可用".to_string())?;
    let exists = {
        let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
        map.contains_key(kind)
    };
    if exists {
        navigate(kind, url)
    } else {
        show_inner(app, kind, url, 0.0, 0.0, 0.0, 0.0)
    }
}

/// Navigation used by Agent tools. Calls are serialized because the browser is
/// a single shared page; each caller waits for its own navigation to settle.
pub fn open_and_wait(
    app: &AppHandle,
    kind: &str,
    url: &str,
    timeout: Duration,
) -> Result<String, String> {
    let _nav = NAV.lock().map_err(|_| "浏览器导航锁不可用".to_string())?;
    let request = begin_navigation(kind)?;
    open(app, kind, url)?;
    wait_for_request(kind, request, Duration::from_millis(300), timeout)?;
    current_url(kind).ok_or_else(|| "页面加载后没有可用地址".to_string())
}

/// 刷新（重载当前地址）
pub fn reload(kind: &str) -> Result<(), String> {
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("这块还没打开过")?;
    let url = wv.url().map_err(|e| e.to_string())?;
    wv.navigate(url).map_err(|e| format!("刷新失败：{e}"))
}

/// 这块现在停在哪个地址（页面可能自己跳转过，比如登录后）—— 给地址栏回显用
pub fn current_url(kind: &str) -> Option<String> {
    let map = KB.lock().ok()?;
    let wv = map.get(kind)?;
    wv.url().ok().map(|u| u.to_string())
}

pub fn navigate(kind: &str, url: &str) -> Result<(), String> {
    let parsed = normalize_url(url)?;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    wv.navigate(parsed).map_err(|e| format!("跳转失败：{e}"))
}

pub fn back(kind: &str) -> Result<(), String> {
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("浏览器还没有打开页面")?;
    wv.eval("history.back()").map_err(|e| e.to_string())
}

pub fn source(app: &AppHandle, kind: &str) -> Result<(), String> {
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
