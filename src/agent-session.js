/** 只把同一会话的新 meta 合进当前视图，避免迟到事件把用户切到的另一个会话覆盖掉。 */
export function mergeSessionMeta(current, incoming) {
  if (!current || !incoming || typeof incoming !== "object") return current;
  if (!incoming.id || incoming.id !== current.id) return current;
  return { ...current, ...incoming };
}

/** 会话标题或两个称呼变化时，当前对话需要立即重画。 */
export function sessionMetaDisplayChanged(before, after) {
  if (!before || !after || before.id !== after.id) return false;
  return ["title", "user_name", "agent_name"].some((key) => (before[key] || "") !== (after[key] || ""));
}

export function sessionSpeaker(meta, kind) {
  if (kind === "user") return (meta && meta.user_name) || "你";
  if (kind === "assistant") return (meta && meta.agent_name) || "Agent";
  if (kind === "err") return "出错";
  return "系统";
}

export function agentDisplayName(meta) {
  const name = String((meta && meta.agent_name) || "").trim();
  return name && name !== "Agent" ? name : "";
}

export function countUserTurns(events) {
  return (Array.isArray(events) ? events : []).reduce(
    (count, event) => count + (event && event.type === "user" ? 1 : 0),
    0,
  );
}

/** Model/time is turn-finish metadata. Intermediate assistant segments emitted
 *  before tools run must not show it while the turn is still in progress. */
export function assistantMetaText(ev, running = false) {
  if (running) return "";
  const parts = [];
  if (ev && ev.model) parts.push(String(ev.model));
  const ts = Number((ev && ev.ts) || 0);
  if (ts > 0) {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const sameDay = d.toDateString() === new Date().toDateString();
    parts.push(sameDay ? `${hm}:${p2(d.getSeconds())}` : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`);
  }
  return parts.join(" · ");
}
