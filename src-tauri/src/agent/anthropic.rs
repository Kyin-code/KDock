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
                        && a.iter()
                            .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                })
                .unwrap_or(false)
    };
    for m in messages {
        match m.get("role").and_then(|r| r.as_str()).unwrap_or("") {
            "system" => {
                let t = m
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Anthropic 不做隐式缓存：system / tools / 倒数第二条消息必须都打了 cache_control，
    /// 否则每轮都是全价重算（这是"缓存命中率"最直接的开关）。
    #[test]
    fn cache_breaks_are_marked() {
        let provider: crate::agent::store::Provider = serde_json::from_value(json!({
            "id": "t", "name": "t", "endpoint": "https://example.invalid", "model": "claude-x",
            "supports_tools": true,
        }))
        .unwrap();
        let messages = vec![
            json!({"role": "system", "content": "你是助手"}),
            json!({"role": "user", "content": "第一句"}),
            json!({"role": "assistant", "content": "第一句的回复"}),
            json!({"role": "user", "content": "第二句"}),
        ];
        // 传进去的是 OpenAI 风格（和真实调用一致），内部会转成 Anthropic 的 input_schema
        let tools = vec![json!({
            "type": "function",
            "function": {"name": "t1", "description": "d", "parameters": {"type": "object", "properties": {}}}
        })];
        let body = request_body(&provider, &messages, &tools, false);

        assert_eq!(
            body["system"][0]["cache_control"]["type"], "ephemeral",
            "system 没打缓存点"
        );
        assert_eq!(
            body["tools"][0]["cache_control"]["type"], "ephemeral",
            "tools 没打缓存点"
        );
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "system 应该被抽到顶层了");
        assert_eq!(
            msgs[1]["content"][0]["cache_control"]["type"], "ephemeral",
            "历史尾巴没打缓存点"
        );
    }

    #[test]
    fn usage_counts_cache_creation_and_read_as_input() {
        let u = usage_from(&json!({
            "input_tokens": 120,
            "output_tokens": 30,
            "cache_read_input_tokens": 8000,
            "cache_creation_input_tokens": 500
        }));
        assert_eq!(u.prompt_tokens, 8620, "input_tokens 不包含缓存读写");
        assert_eq!(u.cache_hit_tokens, 8000);
        assert_eq!(u.cache_miss_tokens, 620);
        assert_eq!(u.cache_hit_tokens + u.cache_miss_tokens, u.prompt_tokens);
        assert_eq!(u.completion_tokens, 30);
    }
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
    // ── 前缀缓存（prompt caching）────────────────────────────────────────
    // Anthropic 不做隐式缓存：**不打 cache_control 命中率就是 0**。所以这里显式打点，而且只打在
    // "每次都一样"的地方：system（人设 + 技能索引 + AGENTS.md）、最后一个工具定义、以及最后一条
    // 消息之前的那个位置 —— 这样下一轮请求的这段前缀就能整段命中，只有新长出来的尾巴要重新算。
    // 破掉的常见原因（改这些会让整段前缀失效）：技能/常驻技能清单变化、MCP 工具清单刷新、工作区切换。
    if !system.trim().is_empty() {
        body["system"] = json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" }
        }]);
    }
    if provider.supports_tools {
        let mut t = to_anthropic_tools(tools);
        if let Some(last) = t.last_mut() {
            // 工具定义整体是稳定前缀，打在最后一个上就等于把整段 tools 都缓存了
            if let Some(obj) = last.as_object_mut() {
                obj.insert("cache_control".into(), json!({ "type": "ephemeral" }));
            }
        }
        if !t.is_empty() {
            body["tools"] = json!(t);
        }
    }
    // 最后一条消息之前的最后一个内容块：把对话历史也纳入缓存（每轮只新增尾巴）
    if let Some(msgs) = body["messages"].as_array_mut() {
        if let Some(prev) = msgs.len().checked_sub(1).and_then(|n| n.checked_sub(1)) {
            mark_cache_tail(&mut msgs[prev]);
        }
    }
    body
}

/// 给一条消息的最后一个内容块打缓存点（content 是字符串时先包成 block 数组）。
fn mark_cache_tail(msg: &mut Value) {
    let Some(obj) = msg.as_object_mut() else {
        return;
    };
    match obj.get_mut("content") {
        Some(Value::String(s)) => {
            let text = std::mem::take(s);
            obj.insert(
                "content".into(),
                json!([{ "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }]),
            );
        }
        Some(Value::Array(arr)) => {
            if let Some(last) = arr.last_mut().and_then(|v| v.as_object_mut()) {
                last.insert("cache_control".into(), json!({ "type": "ephemeral" }));
            }
        }
        _ => {}
    }
}

fn usage_from(u: &Value) -> Usage {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    // Anthropic 的 input_tokens **不包含**缓存读/写部分：
    //   total input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
    // 之前把 input_tokens 当 prompt、再减掉 hit/created，会把命中率算成 100%
    // 或者把输入总量算小一半。
    let fresh = num("input_tokens");
    let completion = num("output_tokens");
    let hit = num("cache_read_input_tokens");
    let created = num("cache_creation_input_tokens");
    let prompt = fresh + hit + created;
    Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        cache_hit_tokens: hit,
        // 没命中缓存 = 全新输入 + 为建立缓存付出的写入
        cache_miss_tokens: fresh + created,
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
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
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
                        hint = format!(
                            "\n（发出去的请求已存到 {}，可以打开对着看）",
                            path.display()
                        );
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
                    let id = b
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = b
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = b.get("input").cloned().unwrap_or_else(|| json!({}));
                    if !name.is_empty() {
                        out.tool_calls.push(ToolCall {
                            id: if id.is_empty() {
                                format!("call_{i}")
                            } else {
                                id
                            },
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
        let n = br
            .read_line(&mut line)
            .map_err(|e| format!("读流失败: {e}"))?;
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
                if let Some(m) = ev.get("message") {
                    if let Some(u) = m.get("usage") {
                        out.usage = usage_from(u);
                    }
                    if let Some(model) = m.get("model").and_then(|x| x.as_str()) {
                        out.response_model = model.to_string();
                    }
                    if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                        out.response_id = id.to_string();
                    }
                }
            }
            "content_block_start" => {
                let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let cb = ev
                    .get("content_block")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match cb.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "tool_use" => {
                        let id = cb
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = cb
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let start_args = cb.get("input").cloned().unwrap_or_else(|| json!({}));
                        tool_slot.insert(idx, out.tool_calls.len());
                        out.tool_calls.push(ToolCall {
                            id: if id.is_empty() {
                                format!("call_{idx}")
                            } else {
                                id
                            },
                            name,
                            // input 可能先到一部分（空对象），后面的 input_json_delta 再补
                            raw_args: if start_args
                                .as_object()
                                .map(|o| o.is_empty())
                                .unwrap_or(true)
                            {
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
