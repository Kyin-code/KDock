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
