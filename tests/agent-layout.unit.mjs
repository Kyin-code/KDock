import assert from "node:assert/strict";
import {
  AGENT_CHAT_MIN,
  AGENT_INPUT_MIN,
  clampAgentInputHeight,
} from "../src/agent-layout.js";
import { logNumberColumnWidth } from "../src/log-gutter.js";

assert.equal(
  clampAgentInputHeight(999, 500),
  500 - AGENT_CHAT_MIN,
  "the composer must leave the minimum conversation height available",
);
assert.equal(
  clampAgentInputHeight(120, 500),
  AGENT_INPUT_MIN,
  "the composer must keep its usable minimum height",
);
assert.equal(
  clampAgentInputHeight(220, 500),
  220,
  "a valid composer height should stay unchanged",
);
assert.equal(
  clampAgentInputHeight(999, 300),
  AGENT_INPUT_MIN,
  "very short layouts should still return a bounded composer height",
);
assert.equal(logNumberColumnWidth(9), "calc(3ch + 1.6rem)");
assert.equal(logNumberColumnWidth(1500), "calc(4ch + 1.6rem)");
assert.equal(logNumberColumnWidth(1234567), "calc(7ch + 1.6rem)");

console.log(JSON.stringify({ ok: true, suite: "agent-layout" }));
