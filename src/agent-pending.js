export function pendingBatchText(rows) {
  return (rows || [])
    .map((row) => String(row == null ? "" : row).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function agentRunPresentation({ running, stopping }) {
  if (stopping && running) {
    return {
      text: "正在停止…", kind: "err", stopVisible: true, stopDisabled: true,
      stopLabel: "正在停止…", composerLocked: true, sendLabel: "正在停止…",
    };
  }
  if (running) {
    return {
      text: "思考中…", kind: "ok", stopVisible: true, stopDisabled: false,
      stopLabel: "停止", composerLocked: false, sendLabel: "补充",
    };
  }
  return {
    text: "空闲", kind: "", stopVisible: false, stopDisabled: false,
    stopLabel: "停止", composerLocked: false, sendLabel: "发送",
  };
}
