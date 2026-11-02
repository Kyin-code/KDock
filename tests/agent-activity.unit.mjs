import assert from "node:assert/strict";
import {
  buildActivityItems,
  partitionAgentEvents,
  summarizeActivity,
  summarizeToolArgs,
} from "../src/agent-activity.js";

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
assert.deepEqual(parts.map((part) => part.kind), ["event", "activity", "event", "event"]);
assert.equal(parts[0].event.type, "user");
assert.equal(parts[2].event.text, "发现一个问题");
assert.equal(parts[2].event.reasoning, "");
assert.equal(parts[3].event.text, "继续");

const activity = buildActivityItems(parts[1].events);
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

const longCommand = summarizeToolArgs("workspace_run", {
  cmd: "arm-none-eabi-gcc -c src/main.c -o build/main.o\r\narm-none-eabi-gcc -c src/next.c -o build/next.o",
  cwd: "build",
  timeout_ms: 120000,
});
assert.ok(longCommand.startsWith("cmd · "));
assert.ok(!longCommand.includes("\n"));
assert.ok(longCommand.includes("…"));
assert.ok(longCommand.length <= 96);

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

console.log(JSON.stringify({ ok: true, summary, longCommand }, null, 2));
