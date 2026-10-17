//! 跟模型说话的那一层：OpenAI 兼容的 `/chat/completions`（流式 SSE）+ 模型列表。
//!
//! 为什么不用 reqwest/tokio：整个 KDock 后端是"std 线程 + 阻塞 IO"的风格（upgrade.rs 也是），
//! 这里用项目已有的 ureq（同步 HTTP）逐行读 SSE 就够了，不引新的异步运行时。

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::store::Provider;

/// 模型要调用一个工具
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// 原始 JSON 字符串（模型可能给半截，解析失败时保留原文好报错）
    pub raw_args: String,
}

impl ToolCall {
    pub fn args(&self) -> Value {
        serde_json::from_str::<Value>(&self.raw_args).unwrap_or(json!({}))
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    /// 命中"前缀缓存"的输入 token（DeepSeek: prompt_cache_hit_tokens；OpenAI: prompt_tokens_details.cached_tokens）
    pub cache_hit_tokens: u64,
    /// 没命中的那部分输入 token
    pub cache_miss_tokens: u64,
}

/// 从响应里的 `usage` 对象取值。各家字段名不完全一样，这里都认一遍。
fn usage_from(u: &Value) -> Usage {
    let num = |v: Option<&Value>| v.and_then(|x| x.as_u64()).unwrap_or(0);
    let prompt = num(u.get("prompt_tokens"));
    let completion = num(u.get("completion_tokens"));
    let total = num(u.get("total_tokens"));
    // DeepSeek 直接给 hit/miss；OpenAI 系给 prompt_tokens_details.cached_tokens
    let mut hit = num(u.get("prompt_cache_hit_tokens"));
    if hit == 0 {
        hit = num(u
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens")));
    }
    let mut miss = num(u.get("prompt_cache_miss_tokens"));
    if miss == 0 && prompt > 0 {
        miss = prompt.saturating_sub(hit);
    }
    Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
        cache_hit_tokens: hit,
        cache_miss_tokens: miss,
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatOut {
    pub content: String,
    pub reasoning: String,
    /// 厂商给的结束原因：stop / length / tool_calls …（length 说明是被 max_tokens 截断的）
    pub finish: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub stopped: bool,
    /// 这一轮"出字"花了多久（毫秒）：**首字 → 末字**，工具调用和等待都不算在内。
    /// 0 表示没测到（非流式、或一个 token 都没出）。
    pub gen_ms: u64,
    /// 首字延迟（毫秒）：请求发出 → 第一个增量到达。
    pub first_ms: u64,
    /// 厂商响应里声明的实际模型（为空表示没返回）
    pub response_model: String,
    /// 厂商的请求 ID，便于对账
    pub response_id: String,
    /// 后端配置指纹（OpenAI 兼容接口常见；不是模型权重哈希）
    pub system_fingerprint: String,
}

/// 流式回调：正文增量 / 思考增量
pub trait ChatSink {
    fn delta(&mut self, _text: &str) {}
    fn reasoning(&mut self, _text: &str) {}
}

/// 空实现（不想接流的时候用）
pub struct NullSink;
impl ChatSink for NullSink {}

/// 保守的 token 估算：ASCII 4 字符 1 token，非 ASCII 按 1 字符 1 token（宁可高估）
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut wide = 0usize;
    for c in text.chars() {
        if c.is_ascii() {
            ascii += 1
        } else {
            wide += 1
        }
    }
    ascii.div_ceil(4) + wide
}

pub fn estimate_messages_tokens(messages: &[Value]) -> usize {
    messages
        .iter()
        .map(|m| estimate_tokens(&m.to_string()) + 4)
        .sum()
}

fn auth_header(key: &str) -> String {
    format!("Bearer {}", key.trim())
}

/// 这个 profile 走 Anthropic Messages 协议吗（`kind` 留空/其它值都当作 OpenAI 兼容）
pub fn is_anthropic(provider: &Provider) -> bool {
    matches!(
        provider.kind.trim().to_ascii_lowercase().as_str(),
        "anthropic" | "claude" | "anthropic_messages"
    )
}

/// 拉模型列表（GET {base}/models）；拿不到就返回空，让用户手填
pub fn list_models(provider: &Provider, api_key: &str) -> Result<Vec<String>, String> {
    let base = provider.endpoint.trim().trim_end_matches('/');
    let mut urls: Vec<String> = Vec::new();
    if is_anthropic(provider) {
        urls.push(if base.ends_with("/v1") {
            format!("{base}/models")
        } else {
            format!("{base}/v1/models")
        });
        // Anthropic 兼容口通常不提供 /models：退回站点根上的 OpenAI 兼容列表（DeepSeek 就是这种）
        if let Some(root) = base.strip_suffix("/anthropic") {
            urls.push(format!("{root}/models"));
        }
    } else {
        urls.push(provider.models_url());
    }
    let mut last = String::new();
    for url in urls {
        let mut req = ureq::get(&url)
            .set("anthropic-version", "2023-06-01")
            .timeout(Duration::from_secs(20));
        if !api_key.trim().is_empty() {
            req = req.set("Authorization", &auth_header(api_key));
            if is_anthropic(provider) {
                req = req.set("x-api-key", api_key.trim());
            }
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(e) => {
                last = format!("请求 {} 失败: {}", url, e);
                continue;
            }
        };
        let text = resp.into_string().map_err(|e| format!("读响应失败: {e}"))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON: {e}"))?;
        let mut out = Vec::new();
        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    out.push(id.to_string());
                }
            }
        } else if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(id) = item
                    .get("name")
                    .or_else(|| item.get("id"))
                    .and_then(|i| i.as_str())
                {
                    out.push(id.to_string());
                }
            }
        }
        out.sort();
        return Ok(out);
    }
    Err(if last.is_empty() {
        "这个地址拿不到模型列表".into()
    } else {
        last
    })
}

/// 查余额。目前只有 DeepSeek 有公开的 `GET /user/balance`；别的厂商返回 supported=false
/// （不是错误，UI 上显示"该厂商没有余额接口"就行）。
pub fn balance(provider: &Provider, api_key: &str) -> Result<Value, String> {
    let base = provider.endpoint.trim().trim_end_matches('/');
    let root = base
        .trim_end_matches("/v1")
        .trim_end_matches("/anthropic")
        .trim_end_matches('/');
    if !root.to_ascii_lowercase().contains("deepseek") {
        return Ok(json!({
            "supported": false,
            "note": "这个厂商没有通用的余额接口（目前只接了 DeepSeek 的 /user/balance）"
        }));
    }
    let url = format!("{root}/user/balance");
    let resp = ureq::get(&url)
        .set("Authorization", &auth_header(api_key))
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| format!("请求 {} 失败: {}", url, e))?;
    let text = resp.into_string().map_err(|e| format!("读响应失败: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON: {e}"))?;
    let infos: Vec<Value> = v
        .get("balance_infos")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .map(|b| {
                    json!({
                        "currency": b.get("currency").and_then(|c| c.as_str()).unwrap_or(""),
                        "total": b.get("total_balance").and_then(|c| c.as_str()).unwrap_or(""),
                        "granted": b.get("granted_balance").and_then(|c| c.as_str()).unwrap_or(""),
                        "toppedUp": b.get("topped_up_balance").and_then(|c| c.as_str()).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "supported": true,
        "available": v.get("is_available").and_then(|a| a.as_bool()).unwrap_or(false),
        "infos": infos,
        "url": url,
    }))
}

/// 计数器：包一层，用来知道"这一轮有没有真的吐过字"——吐过就不重试（免得界面出现两份）
struct Counting<'a> {
    inner: &'a mut dyn ChatSink,
    emitted: bool,
}

impl ChatSink for Counting<'_> {
    fn delta(&mut self, text: &str) {
        self.emitted = true;
        self.inner.delta(text);
    }
    fn reasoning(&mut self, text: &str) {
        self.emitted = true;
        self.inner.reasoning(text);
    }
}

/// 一次对话请求。**失败会重试**（429 / 5xx / 连接断 / 超时），但只在"还没吐字"的时候重试，
/// 免得界面上出现两份回答。（参考 opencode 的做法：网络抖动不该让一整轮白跑）
pub fn chat(
    provider: &Provider,
    api_key: &str,
    messages: &[Value],
    tools: &[Value],
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, String> {
    let mut attempt = 0usize;
    // 初值不需要（每一轮失败都会先赋值再 return），别为了"看着安全"先给个空串
    let mut last_err;
    loop {
        attempt += 1;
        let mut counted = Counting {
            inner: sink,
            emitted: false,
        };
        match chat_once(provider, api_key, messages, tools, stop, &mut counted) {
            Ok(out) => return Ok(out),
            Err((msg, retryable)) => {
                last_err = msg;
                if stop.load(Ordering::Relaxed) || !retryable || counted.emitted || attempt >= 3 {
                    return Err(last_err);
                }
                // 1.5s / 4s 退避
                std::thread::sleep(std::time::Duration::from_millis(if attempt == 1 {
                    1500
                } else {
                    4000
                }));
            }
        }
    }
}

fn chat_once(
    provider: &Provider,
    api_key: &str,
    messages: &[Value],
    tools: &[Value],
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, (String, bool)> {
    // 协议分派：Anthropic Messages / OpenAI 兼容
    if is_anthropic(provider) {
        return crate::agent::anthropic::chat_once(provider, api_key, messages, tools, stop, sink);
    }
    chat_once_openai(provider, api_key, messages, tools, stop, sink)
}

fn chat_once_openai(
    provider: &Provider,
    api_key: &str,
    messages: &[Value],
    tools: &[Value],
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, (String, bool)> {
    let url = provider.chat_url();
    let mut body = json!({
        "model": provider.model,
        "messages": messages,
        "temperature": provider.temperature,
    });
    if provider.reserve_output > 0 {
        body["max_tokens"] = json!(provider.reserve_output);
    }
    if !tools.is_empty() && provider.supports_tools {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    let stream = provider.supports_stream;
    body["stream"] = json!(stream);
    if stream {
        // 有的服务要显式要 usage 才会在最后一帧给
        body["stream_options"] = json!({ "include_usage": true });
    }

    let mut req = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set(
            "Accept",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .timeout(Duration::from_secs(300));
    if !api_key.trim().is_empty() {
        req = req.set("Authorization", &auth_header(api_key));
    }
    let payload = body.to_string();
    let resp = req
        .send_string(&payload)
        .map_err(|e| describe_http_error(&url, e, &payload))?;

    if stream {
        read_sse(resp.into_reader(), stop, sink).map_err(|e| (e, true))
    } else {
        let text = resp
            .into_string()
            .map_err(|e| (format!("读响应失败: {e}"), true))?;
        parse_plain(&text).map_err(|e| (e, false))
    }
}

/// 返回 (人话, 值不值得重试)
fn describe_http_error(url: &str, err: ureq::Error, payload: &str) -> (String, bool) {
    match err {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let brief: String = body.chars().take(600).collect();
            // 429 限流、5xx 网关抖动都值得重试；4xx（形状/鉴权错）重试也没用
            let retryable = code == 429 || (500..600).contains(&code);
            // 400/422 基本都是"请求形状不对"，把发出去的 body 落到临时文件里，方便对着看
            let mut hint = String::new();
            if code == 400 || code == 422 {
                let path = std::env::temp_dir().join("kdock-agent-last-request.json");
                if std::fs::write(&path, payload).is_ok() {
                    hint = format!(
                        "\n（发出去的请求已存到 {}，可以打开对着看）",
                        path.display()
                    );
                }
            }
            (
                format!("模型返回 HTTP {}：{}{}", code, brief.trim(), hint),
                retryable,
            )
        }
        // 连接断/超时这类一律重试
        other => (format!("连 {} 失败: {}", url, other), true),
    }
}

fn read_sse(
    reader: Box<dyn Read + Send + Sync + 'static>,
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, String> {
    let mut out = ChatOut::default();
    // 出字速度的两个时间点：第一个增量 / 最后一个增量。
    // 只在这两个点之间算速度 —— 工具调用、排队、空闲都不计入（用户要的就是这个口径）。
    let started = Instant::now();
    let mut first_at: Option<Instant> = None;
    let mut last_at: Option<Instant> = None;
    /// 收到一个增量：第一次记"首字"，每次刷新"末字"
    fn bump(first: &mut Option<Instant>, last: &mut Option<Instant>) {
        let now = Instant::now();
        if first.is_none() {
            *first = Some(now);
        }
        *last = Some(now);
    }
    // OpenAI 流式里 tool_calls 是**按 index 分片**过来的：id/name 只在第一片，arguments 要拼
    let mut slots: Vec<(String, String, String)> = Vec::new(); // (id, name, args)
    let mut br = BufReader::new(reader);
    let mut line = String::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            out.stopped = true;
            break;
        }
        line.clear();
        let n = br
            .read_line(&mut line)
            .map_err(|e| format!("读流失败: {e}"))?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        let Some(payload) = trimmed.strip_prefix("data:") else {
            continue; // 注释行/空行/event: 行都跳过
        };
        let payload = payload.trim();
        if payload.is_empty() {
            continue;
        }
        if payload == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        if out.response_model.is_empty() {
            if let Some(m) = chunk.get("model").and_then(|v| v.as_str()) {
                out.response_model = m.to_string();
            }
        }
        if out.response_id.is_empty() {
            if let Some(id) = chunk.get("id").and_then(|v| v.as_str()) {
                out.response_id = id.to_string();
            }
        }
        if out.system_fingerprint.is_empty() {
            if let Some(fp) = chunk.get("system_fingerprint").and_then(|v| v.as_str()) {
                out.system_fingerprint = fp.to_string();
            }
        }
        if let Some(err) = chunk.get("error") {
            return Err(format!("模型报错: {err}"));
        }
        if let Some(u) = chunk.get("usage").filter(|u| !u.is_null()) {
            out.usage = usage_from(u);
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        else {
            continue;
        };
        if let Some(f) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            if !f.is_empty() {
                out.finish = f.to_string();
            }
        }
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.content.push_str(text);
                bump(&mut first_at, &mut last_at);
                sink.delta(text);
            }
        }
        if let Some(text) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.reasoning.push_str(text);
                bump(&mut first_at, &mut last_at);
                sink.reasoning(text);
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for call in calls {
                let idx = call
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(slots.len() as u64) as usize;
                while slots.len() <= idx {
                    slots.push((String::new(), String::new(), String::new()));
                }
                let slot = &mut slots[idx];
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        slot.0 = id.to_string();
                    }
                }
                if let Some(f) = call.get("function") {
                    if let Some(name) = f.get("name").and_then(|v| v.as_str()) {
                        if !name.is_empty() {
                            slot.1 = name.to_string();
                        }
                    }
                    if let Some(args) = f.get("arguments").and_then(|v| v.as_str()) {
                        slot.2.push_str(args);
                    }
                }
            }
        }
    }
    for (i, (id, name, args)) in slots.into_iter().enumerate() {
        if name.is_empty() {
            continue;
        }
        out.tool_calls.push(ToolCall {
            id: if id.is_empty() {
                format!("call_{i}")
            } else {
                id
            },
            name,
            raw_args: if args.trim().is_empty() {
                "{}".into()
            } else {
                args
            },
        });
    }
    // 记下出字耗时：首字→末字（不含工具调用/等待），以及首字延迟
    if let (Some(f), Some(l)) = (first_at, last_at) {
        out.gen_ms = l.duration_since(f).as_millis() as u64;
        out.first_ms = f.duration_since(started).as_millis() as u64;
    }
    Ok(out)
}

fn parse_plain(text: &str) -> Result<ChatOut, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("响应不是 JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!("模型报错: {err}"));
    }
    let msg = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .ok_or_else(|| {
            format!(
                "响应里没有 message: {}",
                text.chars().take(300).collect::<String>()
            )
        })?;
    let mut out = ChatOut::default();
    out.response_model = v
        .get("model")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    out.response_id = v
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    out.system_fingerprint = v
        .get("system_fingerprint")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    out.content = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
        for (i, call) in calls.iter().enumerate() {
            let id = call
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let f = call.get("function").cloned().unwrap_or(json!({}));
            out.tool_calls.push(ToolCall {
                id: if id.is_empty() {
                    format!("call_{i}")
                } else {
                    id
                },
                name: f
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                raw_args: f
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string(),
            });
        }
    }
    if let Some(u) = v.get("usage") {
        out.usage = usage_from(u);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_usage_keeps_reported_hit_and_miss() {
        let u = usage_from(&json!({
            "prompt_tokens": 1000,
            "completion_tokens": 20,
            "total_tokens": 1020,
            "prompt_cache_hit_tokens": 900,
            "prompt_cache_miss_tokens": 100
        }));
        assert_eq!(u.prompt_tokens, 1000);
        assert_eq!(u.cache_hit_tokens, 900);
        assert_eq!(u.cache_miss_tokens, 100);
        assert_eq!(u.cache_hit_tokens + u.cache_miss_tokens, u.prompt_tokens);
    }

    #[test]
    fn openai_cached_tokens_are_used_as_hit() {
        let u = usage_from(&json!({
            "prompt_tokens": 800,
            "completion_tokens": 10,
            "total_tokens": 810,
            "prompt_tokens_details": { "cached_tokens": 640 }
        }));
        assert_eq!(u.cache_hit_tokens, 640);
        assert_eq!(u.cache_miss_tokens, 160);
        assert_eq!(u.cache_hit_tokens + u.cache_miss_tokens, u.prompt_tokens);
    }

    #[test]
    fn plain_response_keeps_model_metadata() {
        let out = parse_plain(
            &json!({
                "id": "chatcmpl-test",
                "model": "deepseek-flash",
                "system_fingerprint": "fp_backend",
                "choices": [{ "message": { "content": "ok" } }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(out.response_model, "deepseek-flash");
        assert_eq!(out.response_id, "chatcmpl-test");
        assert_eq!(out.system_fingerprint, "fp_backend");
    }
}
