function isActivityEvent(event) {
  if (event?.type === "tool_call" || event?.type === "tool_result") return true;
  return event?.type === "assistant"
    && !String(event.text || "").trim()
    && !!String(event.reasoning || "").trim();
}

/**
 * Split a persisted conversation into normal messages and one activity block
 * per assistant turn. Reasoning-only events belong to the activity, so they no
 * longer cut a 100-tool run into 100 separate cards.
 */
export function partitionAgentEvents(events) {
  const parts = [];
  let activity = [];
  const flush = () => {
    if (!activity.length) return;
    parts.push({ kind: "activity", events: activity });
    activity = [];
  };

  for (const event of events) {
    if (isActivityEvent(event)) {
      activity.push(event);
      continue;
    }
    if (event?.type === "assistant" && String(event.text || "").trim()) {
      if (String(event.reasoning || "").trim()) {
        activity.push({ ...event, text: "" });
      }
      flush();
      parts.push({ kind: "event", event: { ...event, reasoning: "" } });
      continue;
    }
    if (event?.type === "assistant") continue;
    flush();
    parts.push({ kind: "event", event });
  }
  flush();
  return parts;
}

export function buildActivityItems(events) {
  const items = [];
  const tools = new Map();
  for (const event of events) {
    if (event.type === "assistant" && String(event.reasoning || "").trim()) {
      items.push({
        kind: "reasoning",
        text: String(event.reasoning).trim(),
        ts: Number(event.ts || 0),
      });
      continue;
    }
    if (event.type === "tool_call") {
      const item = {
        kind: "tool",
        id: event.id || "",
        name: event.name || "tool",
        args: event.args || {},
        callTs: Number(event.ts || 0),
        result: null,
      };
      items.push(item);
      if (item.id) tools.set(item.id, item);
      continue;
    }
    if (event.type === "tool_result") {
      const item = tools.get(event.id);
      if (item) {
        item.result = event;
      } else {
        items.push({
          kind: "tool",
          id: event.id || "",
          name: event.name || "tool",
          args: event.args || {},
          callTs: Number(event.ts || 0),
          result: event,
        });
      }
    }
  }
  return items;
}

export function summarizeActivity(items) {
  const names = new Map();
  let failures = 0;
  let pending = 0;
  let reasons = 0;
  let firstTs = 0;
  let lastTs = 0;
  const touch = (ts) => {
    const value = Number(ts || 0);
    if (!value) return;
    if (!firstTs || value < firstTs) firstTs = value;
    if (!lastTs || value > lastTs) lastTs = value;
  };

  for (const item of items) {
    touch(item.ts || item.callTs);
    if (item.kind === "reasoning") {
      reasons += 1;
      continue;
    }
    if (item.kind !== "tool") continue;
    names.set(item.name, (names.get(item.name) || 0) + 1);
    if (!item.result) pending += 1;
    if (item.result?.ok === false) failures += 1;
    touch(item.result?.ts);
  }

  const tools = [...names.values()].reduce((sum, count) => sum + count, 0);
  return {
    tools,
    reasons,
    failures,
    pending,
    durationMs: firstTs && lastTs ? Math.max(0, lastTs - firstTs) : 0,
    names: [...names.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function oneLine(value, max = 72) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function baseName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

function namesPreview(values, max = 2) {
  return (values || []).slice(0, max).map(baseName).join(", ");
}

/**
 * Turn arbitrary tool arguments into one compact, semantic line for the
 * collapsed card header. Raw JSON remains available in the expanded details.
 */
export function summarizeToolArgs(tool, args, limit = 96) {
  const value = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const keys = Object.keys(value);
  if (!keys.length) return "";
  const parts = [];
  const add = (text) => {
    const line = oneLine(text, limit);
    if (line) parts.push(line);
  };

  if (typeof value.cmd === "string" && value.cmd.trim()) {
    parts.push(`cmd · ${oneLine(value.cmd, 72)}`);
  } else if (Array.isArray(value.paths) && value.paths.length) {
    parts.push(`${value.paths.length} files`);
    const preview = namesPreview(value.paths);
    if (preview) parts.push(preview);
  } else if (Array.isArray(value.files) && value.files.length) {
    parts.push(`${value.files.length} files`);
    const preview = namesPreview(value.files.map((item) => item && item.path));
    if (preview) parts.push(preview);
  } else if (Array.isArray(value.edits) && value.edits.length) {
    parts.push(`${value.edits.length} edits`);
    const path = value.path || (value.edits.find((item) => item && item.path) || {}).path;
    if (path) parts.push(oneLine(path, 48));
  } else if (typeof value.path === "string" && value.path.trim()) {
    parts.push(oneLine(value.path, 72));
  }

  if (typeof value.pattern === "string" && value.pattern.trim()) {
    add(`"${oneLine(value.pattern, 42)}"`);
  }
  if (typeof value.url === "string" && value.url.trim()) {
    add(oneLine(value.url, 72));
  }
  if (typeof value.query === "string" && value.query.trim()) {
    add(`"${oneLine(value.query, 42)}"`);
  }
  if (typeof value.name === "string" && value.name.trim() && !parts.length) {
    add(value.name);
  }
  if (typeof value.id === "string" && value.id.trim() && !parts.length) {
    add(value.id);
  }
  if (typeof value.content === "string") {
    add(`${value.content.length} chars`);
  } else if (typeof value.text === "string") {
    add(`${value.text.length} chars`);
  }

  if (!parts.length) {
    const fields = [];
    for (const [key, item] of Object.entries(value)) {
      if (item == null) continue;
      if (Array.isArray(item)) fields.push(`${key}[${item.length}]`);
      else if (typeof item === "object") fields.push(`${key}{${Object.keys(item).length}}`);
      else fields.push(`${key}=${oneLine(item, 28)}`);
      if (fields.length >= 2) break;
    }
    if (fields.length) parts.push(fields.join(" · "));
  }

  const shown = new Set(["cmd", "paths", "files", "edits", "path", "pattern", "url", "query", "name", "id", "content", "text"]);
  const extra = keys.filter((key) => !shown.has(key)).length;
  if (extra && parts.length) parts.push(`+${extra}`);
  return oneLine(parts.join(" · "), limit);
}
