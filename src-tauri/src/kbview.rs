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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl};

static KB: LazyLock<Mutex<HashMap<String, Webview>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
    let parsed: tauri::Url = url
        .trim()
        .parse()
        .map_err(|e| format!("这个地址打不开（{url}）：{e}"))?;
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
    let wv = win
        .add_child(
            WebviewBuilder::new(format!("kb-{kind}"), WebviewUrl::External(parsed))
                .on_page_load(move |webview, _payload| {
                    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
                    if !url.is_empty() {
                        let _ = app_handle.emit("kb://page", serde_json::json!({ "url": url }));
                    }
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

/// 只挪位置 / 改大小（页面切换、拖分栏、改窗口大小时调）
pub fn bounds(app: &AppHandle, kind: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let _ = app;
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    if let Some(wv) = map.get(kind) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(clamp_min(w), clamp_min(h))).map_err(|e| e.to_string())?;
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
    let exists = {
        let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
        map.contains_key(kind)
    };
    if exists {
        navigate(kind, url)
    } else {
        show(app, kind, url, 0.0, 0.0, 0.0, 0.0)
    }
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
    let parsed: tauri::Url = url
        .trim()
        .parse()
        .map_err(|e| format!("这个地址打不开（{url}）：{e}"))?;
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
    wv.eval_with_callback("document.documentElement.outerHTML", move |s| {
        let _ = app.emit("kb://source", s);
    })
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
        html: document.documentElement.outerHTML || '',
        links: [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({text:(a.innerText||'').trim().slice(0,80), href:a.href}))
        };
        return JSON.stringify(page);
      })()
    "#;
    wv.eval_with_callback(js, move |s| {
        let _ = app.emit("kb://dom", s);
    })
    .map_err(|e| e.to_string())
}

/// 同步读取当前 WebView2 的 DOM。Agent 工具在命令线程里调用；回调通过 channel
/// 回来，避免为了读一次网页就复制一套浏览器/会话。
pub fn read_dom_json(kind: &str) -> Result<String, String> {
    let map = KB.lock().map_err(|_| "kb mutex".to_string())?;
    let wv = map.get(kind).ok_or("共享浏览器还没有打开页面")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let js = r#"
      (() => {
        const page = {
          url: location.href,
          title: document.title || '',
          text: (document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200000),
          html: document.documentElement.outerHTML || '',
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
    let raw = rx.recv_timeout(std::time::Duration::from_secs(8)).map_err(|e| format!("读取当前页超时：{e}"))?;
    // WebView2 会把 JS 返回的字符串再 JSON 编码一层；剥到真正的对象 JSON。
    if let Ok(serde_json::Value::String(inner)) = serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(inner)
    } else {
        Ok(raw)
    }
}
