//! 内置浏览器工具（"类 Codex"那味儿）：拿 URL -> 抓下来 -> 抽正文 -> 存成"当前页"。
//!
//! 不嵌 WebView 引擎（那对一个小上位机太重）：抓 + 抽正文 + 给 agent 读，
//! 面板上显示正文/源码，链接可点。需要真渲染时用系统默认浏览器打开。

use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub url: String,
    pub title: String,
    /// 抽出来的正文（纯文本，带换行）
    pub text: String,
    pub html: String,
    pub links: Vec<Link>,
    pub fetched_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub text: String,
    pub href: String,
}

pub fn fetch(url: &str) -> Result<Page, String> {
    let url = normalize(url)?;
    let resp = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KDock/0.1")
        .set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
        .timeout(Duration::from_secs(25))
        .call()
        .map_err(|e| format!("打开 {} 失败: {}", url, e))?;
    let ctype = resp.content_type().to_string();
    let status = resp.status();
    let mut body = Vec::new();
    resp.into_reader()
        .take(8 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|e| format!("读页面失败: {e}"))?;
    let raw = String::from_utf8_lossy(&body).to_string();
    let is_html = ctype.contains("html") || raw.trim_start().starts_with('<');
    let (title, text, links) = if is_html {
        let (t, body) = html_to_text(&raw);
        (t, body, collect_links(&raw))
    } else {
        (url.clone(), raw.clone(), Vec::new())
    };
    Ok(Page {
        url,
        title: if title.trim().is_empty() { format!("(无标题 · HTTP {status})") } else { title },
        text,
        html: raw,
        links: links.into_iter().take(200).collect(),
        fetched_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    })
}

fn normalize(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("URL 是空的".into());
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return Ok(s.to_string());
    }
    if s.contains(' ') || s.contains('：') {
        return Err("网址里不能有空格；要搜索的话先自己拼好 URL".into());
    }
    Ok(format!("https://{s}"))
}

/// 极简 HTML -> 文本：不追求完美，够 agent 读、够人看
pub fn html_to_text(html: &str) -> (String, String) {
    let lower = html.to_lowercase();
    // 标题
    let mut title = String::new();
    if let Some(a) = lower.find("<title") {
        if let Some(b) = lower[a..].find('>') {
            let start = a + b + 1;
            if let Some(end) = lower[start..].find("</title") {
                title = decode_entities(&html[start..start + end]).trim().to_string();
            }
        }
    }
    // 去掉 script/style/noscript/svg 整块
    let mut body = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "head"] {
        body = strip_block(&body, tag);
    }
    let mut out = String::with_capacity(body.len() / 2);
    let bytes = body.as_bytes();
    let mut i = 0usize;
    let mut pending_space = false;
    while i < body.len() {
        if bytes[i] == b'<' {
            let Some(rel_end) = body[i..].find('>') else { break };
            let tag_end = i + rel_end + 1;
            let tag = body[i..tag_end].to_lowercase();
            let name: String = tag
                .trim_start_matches('<')
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            let block = matches!(
                name.as_str(),
                "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    | "section" | "article" | "header" | "footer" | "table" | "ul" | "ol" | "blockquote" | "pre"
            );
            if block {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
                if name == "li" && !tag.starts_with("</") {
                    out.push_str("· ");
                }
            } else {
                pending_space = true;
            }
            i = tag_end;
            continue;
        }
        // 实体
        if bytes[i] == b'&' {
            if let Some(semi) = body[i..].find(';') {
                if semi <= 10 {
                    let ent = &body[i..i + semi + 1];
                    let dec = decode_entities(ent);
                    if dec != ent {
                        out.push_str(&dec);
                        i += semi + 1;
                        continue;
                    }
                }
            }
        }
        if pending_space && !out.is_empty() && !out.ends_with(['\n', ' ']) {
            out.push(' ');
        }
        pending_space = false;
        let ch = body[i..].chars().next().unwrap();
        if ch == '\n' || ch == '\r' || ch == '\t' {
            out.push(' ');
        } else if ch.is_whitespace() {
            out.push(' ');
        } else {
            out.push(ch);
        }
        i += ch.len_utf8();
    }
    // 压掉多余空行和行首尾空格
    let mut lines: Vec<String> = Vec::new();
    for line in out.lines() {
        let t = line.trim().trim_end().to_string();
        if t.is_empty() {
            if matches!(lines.last(), Some(l) if l.is_empty()) {
                continue;
            }
            lines.push(String::new());
        } else {
            lines.push(t);
        }
    }
    let text = lines.join("\n").trim().to_string();
    (title, text)
}

fn strip_block(html: &str, tag: &str) -> String {
    let lower = html.to_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::with_capacity(html.len());
    let mut pos = 0usize;
    while let Some(rel) = lower[pos..].find(&open) {
        let start = pos + rel;
        out.push_str(&html[pos..start]);
        match lower[start..].find(&close) {
            Some(crel) => {
                let cend = start + crel;
                match lower[cend..].find('>') {
                    Some(gt) => pos = cend + gt + 1,
                    None => break,
                }
            }
            None => {
                pos = html.len();
                break;
            }
        }
    }
    if pos < html.len() {
        out.push_str(&html[pos..]);
    }
    out
}

fn collect_links(html: &str) -> Vec<Link> {
    let lower = html.to_lowercase();
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = lower[pos..].find("<a ") {
        let start = pos + rel;
        let Some(gt_rel) = lower[start..].find('>') else { break };
        let tag_end = start + gt_rel + 1;
        let tag = &html[start..tag_end];
        let href = attr(tag, "href").unwrap_or_default();
        let text_end = lower[tag_end..].find("</a").map(|e| tag_end + e).unwrap_or(tag_end);
        let text = decode_entities(&strip_tags(&html[tag_end..text_end]));
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !href.is_empty() && !href.starts_with("javascript:") {
            out.push(Link { text: text.chars().take(80).collect(), href });
        }
        pos = tag_end;
    }
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{name}=");
    let idx = lower.find(&key)?;
    let rest = &tag[idx + key.len()..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let inner = &rest[1..];
        let end = inner.find(quote)?;
        Some(inner[..end].to_string())
    } else {
        let end = rest.find([' ', '>']).unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(semi) = tail.find(';') else { out.push_str(tail); return out };
        if semi > 12 {
            out.push_str("&");
            rest = &tail[1..];
            continue;
        }
        let ent = &tail[1..semi];
        let dec = match ent {
            "amp" => Some("&"),
            "lt" => Some("<"),
            "gt" => Some(">"),
            "quot" => Some("\""),
            "apos" | "#39" => Some("'"),
            "nbsp" | "#160" => Some(" "),
            "mdash" => Some("—"),
            "ndash" => Some("–"),
            "hellip" => Some("…"),
            "copy" => Some("©"),
            "middot" => Some("·"),
            _ => {
                if let Some(num) = ent.strip_prefix('#') {
                    let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    };
                    code.and_then(char::from_u32).map(|c| {
                        // 字符引用是临时的，直接塞进去
                        out.push(c);
                        ""
                    })
                } else {
                    None
                }
            }
        };
        match dec {
            Some(text) => out.push_str(text),
            None => {
                out.push_str("&");
                out.push_str(ent);
                out.push(';');
            }
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

use std::io::Read;