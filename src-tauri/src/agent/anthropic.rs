//! Anthropic Messages API（`/v1/messages`）——给 `kind = "anthropic"` 的供应商用。
//!
//! 为什么要单独一套：请求/响应形状和 OpenAI 完全不同 ——
//!   * 系统提示是**顶层 `system` 字段**，不是一条 message
//!   * 内容都是 **content block**（`text` / `tool_use` / `tool_result` / `thinking`）
//!   * 工具定义是 `{name, description, input_schema}`（不是 `{type:"function",function:{…}}`）
//!   * 鉴权头是 `x-api-key`，还要带 `anthropic-version`
//!   * 流式是 `event: xxx` + `data: {...}`，增量类型在 `delta.type` 里
//!
//! 上层（会话事件）仍然用 OpenAI 那套 messages 组装，这里负责**翻译过去**再翻译回来，
//! 所以 ToolCall / ChatOut / Usage 这些结构两边共用。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use super::llm::{ChatOut, ChatSink, ToolCall, Usage};
use super::store::Provider;

/// 把用户的 base_url 拼成 Messages 端点。
/// 认这几种写法：`https://api.deepseek.com/anthropic`（DeepSeek 的 Anthropic 兼容口）、
/// `https://api.anthropic.com`、以及直接给了 `/v1/messages` 的。
pub fn messages_url(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.ends_with("/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

/// OpenAI 风格 tools -> Anthropic 风格 tools
fn to_anthropic_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let f = t.get("function")?;
            Some(json!({
                "name": f.get("name")?.as_str()?,
                "description": f.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                "input_schema": f.get("parameters").cloned()
                    .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            }))
        })
        .collect()
}

/// OpenAI 风格 messages -> (system, Anthropic messages)
///
/// 两条硬规矩：
///   * `tool_result` 必须放在 **user** 角色里，而且同一轮的多个结果要**合并进同一条** user 消息；
///   * `reasoning_content` 不回传（Anthropic 的 thinking block 需要签名，跨轮带回去会 400）。
pub fn to_anthropic_messages(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system = String::new();
    let mut out: Vec<Value> = Vec::new();
    let is_tool_result_group = |m: &Value| -> bool {
        m.get("role").and_then(|r| r.as_str()) == Some("user")
            && m.get("content")
                .and_then(|c| c.as_array())
                .map(|a| {
                    !a.is_empty()
                        && a.iter().all(|b| {
                            b.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                        })
                })
                .unwrap_or(false)
    };
    for m in messages {
        match m.get("role").and_then(|r| r.as_str()).unwrap_or("") {
            "system" => {
                let t = m.get("content").and_then(|c| c.as_str()).unwrap_or("").trim();
                if !t.is_empty() {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(t);
                }
            }
            "user" => out.push(json!({
                "role": "user",
                "content": [{ "type": "text",
                              "text": m.get("content").and_then(|c| c.as_str()).unwrap_or("") }]
            })),
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(t) = m.get("content").and_then(|c| c.as_str()) {
                    if !t.trim().is_empty() {
                        blocks.push(json!({ "type": "text", "text": t }));
                    }
                }
                if let Some(calls) = m.get("tool_calls").and_then(|c| c.as_array()) {
                    for c in calls {
                        let f = c.get("function").cloned().unwrap_or_else(|| json!({}));
                        let raw = f.get("arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": c.get("id").and_then(|i| i.as_str()).unwrap_or("call"),
                            "name": f.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                            "input": serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({})),
                        }));
                    }
                }
                if blocks.is_empty() {
                    continue; // 空 assistant（有些轮次只有思考）没有意义，跳过
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            "tool" => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id").and_then(|i| i.as_str()).unwrap_or(""),
                    "content": [{ "type": "text",
                                  "text": m.get("content").and_then(|c| c.as_str()).unwrap_or("") }],
                });
                // 连续的工具结果并进同一条 user 消息（Anthropic 就是这么要求的）
                let append = out.last().map(is_tool_result_group).unwrap_or(false);
                if append {
                    if let Some(arr) = out
                        .last_mut()
                        .and_then(|l| l.get_mut("content"))
                        .and_then(|c| c.as_array_mut())
                    {
                        arr.push(block);
                    }
                } else {
                    out.push(json!({ "role": "user", "content": [block] }));
                }
            }
            _ => {}
        }
    }
    (system, out)
}

pub fn request_body(
    provider: &Provider,
    messages: &[Value],
    tools: &[Value],
    stream: bool,
) -> Value {
    let (system, msgs) = to_anthropic_messages(messages);
    let mut body = json!({
        "model": provider.model,
        "max_tokens": if provider.reserve_output > 0 { provider.reserve_output } else { 4096 },
        "temperature": provider.temperature,
        "messages": msgs,
        "stream": stream,
    });
    if !system.trim().is_empty() {
        body["system"] = json!(system);
    }
    if provider.supports_tools {
        let t = to_anthropic_tools(tools);
        if !t.is_empty() {
            body["tools"] = json!(t);
        }
    }
    body
}

fn usage_from(u: &Value) -> Usage {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let prompt = num("input_tokens");
    let completion = num("output_tokens");
    let hit = num("cache_read_input_tokens");
    let created = num("cache_creation_input_tokens");
    Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        cache_hit_tokens: hit,
        cache_miss_tokens: prompt.saturating_sub(hit).saturating_sub(created),
    }
}

/// 一次请求（流式/非流式都走这里）；返回值第二个元素是"值不值得重试"
pub fn chat_once(
    provider: &Provider,
    api_key: &str,
    messages: &[Value],
    tools: &[Value],
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, (String, bool)> {
    let url = messages_url(&provider.endpoint);
    let stream = provider.supports_stream;
    let payload = request_body(provider, messages, tools, stream).to_string();
    let req = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("x-api-key", api_key.trim())
        .set("anthropic-version", "2023-06-01")
        .set(
            "Accept",
            if stream { "text/event-stream" } else { "application/json" },
        )
        .timeout(Duration::from_secs(300));
    let resp = req.send_string(&payload).map_err(|e| {
        // 复用手写的错误说明（含 400/422 落盘请求体的便利）
        let (msg, retry) = match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                let brief: String = body.chars().take(600).collect();
                let mut hint = String::new();
                if code == 400 || code == 422 {
                    let path = std::env::temp_dir().join("kdock-agent-last-request.json");
                    if std::fs::write(&path, &payload).is_ok() {
                        hint = format!("\n（发出去的请求已存到 {}，可以打开对着看）", path.display());
                    }
                }
                (
                    format!("模型返回 HTTP {}：{}{}", code, brief.trim(), hint),
                    code == 429 || (500..600).contains(&code),
                )
            }
            other => (format!("连 {} 失败: {}", url, other), true),
        };
        (msg, retry)
    })?;
    if stream {
        read_sse(resp.into_reader(), stop, sink).map_err(|e| (e, true))
    } else {
        let text = resp
            .into_string()
            .map_err(|e| (format!("读响应失败: {e}"), true))?;
        parse_plain(&text).map_err(|e| (e, false))
    }
}

fn parse_plain(text: &str) -> Result<ChatOut, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("响应不是 JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!("模型报错: {err}"));
    }
    let mut out = ChatOut::default();
    if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
        for (i, b) in arr.iter().enumerate() {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => out
                    .content
                    .push_str(b.get("text").and_then(|t| t.as_str()).unwrap_or("")),
                "thinking" => out
                    .reasoning
                    .push_str(b.get("thinking").and_then(|t| t.as_str()).unwrap_or("")),
                "tool_use" => {
                    let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let args = b.get("input").cloned().unwrap_or_else(|| json!({}));
                    if !name.is_empty() {
                        out.tool_calls.push(ToolCall {
                            id: if id.is_empty() { format!("call_{i}") } else { id },
                            name,
                            raw_args: args.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(r) = v.get("stop_reason").and_then(|x| x.as_str()) {
        out.finish = r.to_string();
    }
    if let Some(u) = v.get("usage") {
        out.usage = usage_from(u);
    }
    Ok(out)
}

fn read_sse(
    reader: Box<dyn Read + Send + Sync + 'static>,
    stop: &AtomicBool,
    sink: &mut dyn ChatSink,
) -> Result<ChatOut, String> {
    let mut out = ChatOut::default();
    // block index -> tool_calls 下标
    let mut tool_slot: HashMap<usize, usize> = HashMap::new();
    let mut br = BufReader::new(reader);
    let mut line = String::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            out.stopped = true;
            break;
        }
        line.clear();
        let n = br.read_line(&mut line).map_err(|e| format!("读流失败: {e}"))?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        // 只吃 data: 行；`event:` / 空行 / ping 都跳过
        let Some(payload) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "error" => {
                let msg = ev
                    .get("error")
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| ev.to_string());
                return Err(format!("模型报错: {msg}"));
            }
            "message_start" => {
                if let Some(u) = ev.get("message").and_then(|m| m.get("usage")) {
                    out.usage = usage_from(u);
                }
            }
            "content_block_start" => {
                let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let cb = ev.get("content_block").cloned().unwrap_or_else(|| json!({}));
                match cb.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "tool_use" => {
                        let id = cb.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let name = cb.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let start_args = cb.get("input").cloned().unwrap_or_else(|| json!({}));
                        tool_slot.insert(idx, out.tool_calls.len());
                        out.tool_calls.push(ToolCall {
                            id: if id.is_empty() { format!("call_{idx}") } else { id },
                            name,
                            // input 可能先到一部分（空对象），后面的 input_json_delta 再补
                            raw_args: if start_args.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                                String::new()
                            } else {
                                start_args.to_string()
                            },
                        });
                    }
                    "thinking" => {
                        if let Some(t) = cb.get("thinking").and_then(|x| x.as_str()) {
                            out.reasoning.push_str(t);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let d = ev.get("delta").cloned().unwrap_or_else(|| json!({}));
                match d.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = d.get("text").and_then(|x| x.as_str()) {
                            if !t.is_empty() {
                                out.content.push_str(t);
                                sink.delta(t);
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = d.get("thinking").and_then(|x| x.as_str()) {
                            if !t.is_empty() {
                                out.reasoning.push_str(t);
                                sink.reasoning(t);
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let (Some(p), Some(&slot)) = (
                            d.get("partial_json").and_then(|x| x.as_str()),
                            tool_slot.get(&idx),
                        ) {
                            if let Some(tc) = out.tool_calls.get_mut(slot) {
                                tc.raw_args.push_str(p);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(r) = ev
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|x| x.as_str())
                {
                    out.finish = r.to_string();
                }
                if let Some(u) = ev.get("usage") {
                    let more = usage_from(u);
                    // message_delta 只带 output_tokens（有时也带最终 input），别把 input 覆盖没了
                    if more.prompt_tokens > 0 {
                        out.usage.prompt_tokens = more.prompt_tokens;
                        out.usage.cache_hit_tokens = more.cache_hit_tokens;
                        out.usage.cache_miss_tokens = more.cache_miss_tokens;
                    }
                    if more.completion_tokens > 0 {
                        out.usage.completion_tokens = more.completion_tokens;
                    }
                    out.usage.total_tokens = out.usage.prompt_tokens + out.usage.completion_tokens;
                }
            }
            "message_stop" => break,
            _ => {}
        }
    }
    for tc in out.tool_calls.iter_mut() {
        if tc.raw_args.trim().is_empty() {
            tc.raw_args = "{}".into();
        }
    }
    Ok(out)
}
