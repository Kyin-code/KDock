import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildActivityItems,
  partitionAgentEvents,
  partitionAgentTurns,
  summarizeActivity,
  summarizeToolArgs,
} from "../src/agent-activity.js";
import { pendingBatchText } from "../src/agent-pending.js";

const events = [
  { type: "user", text: "检查项目", ts: 1 },
  { type: "assistant", text: "", reasoning: "先看目录", ts: 2 },
  { type: "tool_call", id: "a", name: "workspace_list", args: { path: "." }, ts: 3 },
  { type: "tool_result", id: "a", name: "workspace_list", ok: true, text: "D src/", ts: 4 },
  { type: "assistant", text: "", reasoning: "再读文件", ts: 5 },
  { type: "tool_call", id: "b", name: "workspace_read", args: { path: "src/main.c" }, ts: 6 },
  { type: "tool_result", id: "b", name: "workspace_read", ok: false, text: "拒绝", ts: 7 },
  { type: "assistant", text: "发现一个问题", reasoning: "整理结论", ts: 8 },
  { type: "user", text: "继续", ts: 9 },
];

const parts = partitionAgentEvents(events);
assert.deepEqual(parts.map((part) => part.kind), [
  "event", "activity", "activity", "activity", "event", "event",
]);
assert.equal(parts[0].event.type, "user");
assert.equal(parts[4].event.text, "发现一个问题");
assert.equal(parts[4].event.reasoning, "");
assert.equal(parts[5].event.text, "继续");

const activityParts = parts.filter((part) => part.kind === "activity");
assert.deepEqual(
  activityParts.map((part) => buildActivityItems(part.events).map((item) => item.kind)),
  [["reasoning", "tool"], ["reasoning", "tool"], ["reasoning"]],
);
const activity = activityParts.flatMap((part) => buildActivityItems(part.events));
assert.deepEqual(activity.map((item) => item.kind), ["reasoning", "tool", "reasoning", "tool", "reasoning"]);
assert.equal(activity[3].result.ok, false);

const summary = summarizeActivity(activity);
assert.equal(summary.tools, 2);
assert.equal(summary.reasons, 3);
assert.equal(summary.failures, 1);
assert.equal(summary.pending, 0);
assert.equal(summary.durationMs, 6);
assert.deepEqual(summary.names, [
  ["workspace_list", 1],
  ["workspace_read", 1],
]);

const turns = partitionAgentTurns(events, true);
assert.deepEqual(turns.map((part) => part.kind), ["turn", "turn"]);
assert.equal(turns[0].complete, true);
assert.equal(turns[0].finalEvent.text, "发现一个问题");
assert.equal(turns[0].finalEvent.reasoning, "");
assert.equal(turns[0].durationMs, 7);
assert.ok(turns[0].processEvents.some((event) => event.reasoning === "整理结论"));
assert.ok(turns[0].processEvents.some((event) => event.type === "tool_call"));
assert.equal(
  turns[0].processParts.filter((part) => part.kind === "activity").length,
  3,
);
assert.equal(turns[1].complete, false);
assert.equal(turns[1].finalEvent, null);

const singleAnswer = partitionAgentTurns([
  { type: "user", text: "只回答", ts: 10 },
  { type: "assistant", text: "最终答案", ts: 20 },
], false);
assert.equal(singleAnswer[0].processEvents.length, 0);
assert.equal(singleAnswer[0].finalEvent.text, "最终答案");
assert.equal(singleAnswer[0].durationMs, 10);

const interruptedTurn = partitionAgentTurns([
  { type: "user", text: "先看一下", ts: 10 },
  { type: "assistant", text: "我先看一下项目结构", ts: 20 },
  { type: "tool_call", id: "x", name: "workspace_read", args: {}, ts: 30 },
  { type: "tool_result", id: "x", name: "workspace_read", ok: true, text: "ok", ts: 40 },
  { type: "state", text: "下一轮状态", ts: 100 },
], false);
assert.equal(interruptedTurn[0].finalEvent, null);
assert.equal(interruptedTurn[0].durationMs, 30);
assert.ok(interruptedTurn[0].processParts.some((part) =>
  part.kind === "event" && part.event.text === "我先看一下项目结构"));

const longCommand = summarizeToolArgs("workspace_run", {
  cmd: "arm-none-eabi-gcc -c src/main.c -o build/main.o\r\narm-none-eabi-gcc -c src/next.c -o build/next.o",
  cwd: "build",
  timeout_ms: 120000,
});
assert.ok(longCommand.startsWith("cmd · "));
assert.ok(!longCommand.includes("\n"));
assert.ok(longCommand.includes("…"));
assert.ok(longCommand.length <= 96);

const inlineScript = summarizeToolArgs("workspace_run", {
  script: "Get-PnpDevice | Where-Object { $_.Status -eq 'OK' }\nWrite-Output done",
  shell: "powershell",
});
assert.ok(inlineScript.includes("chars script"));
assert.ok(inlineScript.includes("Get-PnpDevice"));
assert.ok(inlineScript.length <= 96);

const desktopAction = summarizeToolArgs("desktop_action", {
  action: "menu",
  command_id: 32788,
  hwnd: 4525530,
});
assert.ok(desktopAction.includes("menu"));
assert.ok(desktopAction.includes("32788"));

assert.equal(
  summarizeToolArgs("workspace_read", { paths: ["src/a.c", "src/b.c", "inc/c.h"] }),
  "3 files · a.c, b.c",
);
assert.equal(
  summarizeToolArgs("workspace_edit", {
    path: "src/a.c",
    edits: [{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "d" }],
    replace_all: false,
  }),
  "2 edits · src/a.c · +1",
);
assert.equal(
  pendingBatchText(["  先检查驱动 ", "", "再复测烧录"]),
  "先检查驱动\n\n再复测烧录",
);
assert.equal(pendingBatchText([]), "");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = await readFile(resolve(root, "src/main.js"), "utf8");
assert.match(main, /agpending-guide/);
assert.match(main, /全部立即发送/);
assert.match(
  main,
  /invoke\("agent_stop", \{ session: sid \}\)[\s\S]{0,160}?await stopped/,
  "Send all now must wait for the current run to stop before starting a new turn",
);
assert.match(main, /agResolveDone\(sid\)/);

console.log(JSON.stringify({ ok: true, summary, longCommand }, null, 2));
