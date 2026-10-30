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
