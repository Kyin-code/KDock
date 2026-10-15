//! 知识库页用的"内置浏览器"：往主窗口里贴 **WebView2 子视图**。
//!
//! 为什么要这么干：KDock 自己的界面是纯 HTML（CSP 里 `frame-src 'none'`），而 Dify 这种
//! 知识库/对话界面是重前端（React + JS 渲染），拿 `browser_fetch` 那条"抓正文"的路子只能
//! 拿到一个空壳。所以这里用 Tauri 的多 WebView 能力，把外部页面当成"窗口里的另一块画布"
//! 铺在指定矩形上 —— 位置与大小由前端按 DOM 里那块占位区的实际坐标算好传进来（CSS 像素，
//! 相对窗口客户区）。
//!
//! 注意：
//! - 子视图是**盖在** HTML 上的原生层，所以它盖住的区域里 HTML 收不到点击；工具条/地址栏
//!   要放在占位区之外。
//! - 弹出的浮层（设置弹窗等）也会被它盖住，所以浮层打开时前端会调 `kb_hide_all`。
//! - 这里只管"显示/移动/隐藏/刷新"，**不碰对方站点上的任何东西**。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl};

static KB: LazyLock<Mutex<HashMap<String, Webview>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn clamp_min(v: f64) -> f64 {
    if v.is_finite() && v > 1.0 {
        v
    } else {
        1.0
    }
}

/// 贴上一块（第一次会创建子 WebView；已经建过就只挪位置 / 换地址 / 显示出来）
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
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        let same = wv.url().map(|u| u.as_str() == parsed.as_str()).unwrap_or(false);
        if !same {
            wv.navigate(parsed).map_err(|e| format!("跳转失败：{e}"))?;
        }
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let win = app.get_window("main").ok_or("找不到主窗口")?;
    let wv = win
        .add_child(
            WebviewBuilder::new(format!("kb-{kind}"), WebviewUrl::External(parsed)),
            pos,
            size,
        )
        .map_err(|e| format!("建内置浏览器失败：{e}"))?;
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

