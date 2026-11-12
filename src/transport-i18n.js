/**
 * Translate transport SYS lines at render time. Keeping the source text raw
 * means switching languages can redraw both live and reloaded session logs.
 * This module is loaded on demand so its parameterized rules do not inflate
 * the initial application bundle.
 */
export function translateTransportText(text, translate = (value) => value) {
  const source = String(text ?? "");
  const exact = translate(source);
  if (exact != null && exact !== source) return exact;

  const rules = [
    [/^重连中 (\d+)\/20$/, (_, n) => `Reconnecting ${n}/20`],
    [/^\[链路\] 连接断了，1\.5s 后重连（第 (\d+) 次）\.\.\.$/, (_, n) => `[Link] Connection lost; reconnecting in 1.5s (attempt ${n})...`],
    [/^\[链路\] 重连成功（第 (\d+) 次）$/, (_, n) => `[Link] Reconnected (attempt ${n})`],
    [/^\[链路\] 自动重连失败，请手动重连$/, () => "[Link] Automatic reconnect failed; reconnect manually"],
    [/^\[链路\] 读取失败: (.+)$/, (_, error) => `[Link] Read failed: ${error}`],
    [/^读取失败: (.+)$/, (_, error) => `Read failed: ${error}`],
    [/^连接失败: (.+)$/, (_, error) => `Connection failed: ${error}`],
    [/^已连接 (.+?)（本地端口 (\d+)）$/, (_, target, port) => `Connected to ${target} (local port ${port})`],
    [/^已连接 (.+)$/, (_, target) => `Connected to ${target}`],
    [/^正在监听，端口 (\d+)（可反复接入）$/, (_, port) => `Listening on port ${port} (repeated connections allowed)`],
    [/^已断开 (.+)$/, (_, target) => `Disconnected: ${target}`],
    [/^listen (.+)$/, (_, target) => `Listening on ${target}`],
    [/^open (.+)$/, (_, target) => `Opened ${target}`],
    [/^close (.+)$/, (_, target) => `Closed ${target}`],
    [/^客户端接入 (.+)$/, (_, target) => `Client connected: ${target}`],
    [/^客户端断开 (.+)$/, (_, target) => `Client disconnected: ${target}`],
    [/^TCP 客户端已接入$/, () => "TCP client connected"],
    [/^对端已断开$/, () => "Peer disconnected"],
    [/^串口列表变化: (.+)$/, (_, ports) => `Serial ports changed: ${ports === "（无串口）" ? "(none)" : ports}`],
    [/^\[会话\] 已保存 (\d+) 行到 (.+)$/, (_, count, path) => `[Session] Saved ${count} lines to ${path}`],
    [/^\[会话\] 已从 (.+) 加载 (\d+) 行$/, (_, path, count) => `[Session] Loaded ${count} lines from ${path}`],
    [/^\[会话\] 已导出 (\d+) 行到 (.+)$/, (_, count, path) => `[Session] Exported ${count} lines to ${path}`],
    [/^\[中控\] 连接 #(\d+) 已断开$/, (_, id) => `[Control] Connection #${id} closed`],
    [/^显示编码已切到 (.+)$/, (_, mode) => `Display encoding changed to ${mode}`],
  ];
  for (const [pattern, replace] of rules) {
    const match = source.match(pattern);
    if (match) return source.replace(pattern, (...args) => replace(...args));
  }
  return source;
}
