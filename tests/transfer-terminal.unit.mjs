import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAsciiHistory, loadAsciiHistory, saveAsciiHistory } from "../src/ascii-history.js";
import {
  appendAsciiTxEntry,
  createLiveTimestampGuard,
  formatHexDump,
  joinTransferHex,
} from "../src/transfer-log.js";
import { termFeed, termModes, termNew, termText } from "../src/terminal.js";
import { terminalKeySequence, terminalPastePayload } from "../src/terminal-keys.js";

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
assert.doesNotMatch(
  mainSource,
  /local-echo["']\)\.checked\s*=\s*true/,
  "entering ASCII mode must not silently enable local echo",
);

function feed(text) {
  const state = termNew();
  termFeed(state, text);
  return state;
}

{
  const state = feed("abc\b\u001b[J");
  assert.equal(termText(state), "ab", "BS + CSI J must erase only from the cursor");
}

{
  const state = feed("line1\nline2\b\u001b[J");
  assert.equal(termText(state), "line1\nline", "default CSI J must preserve scrollback");
}

{
  const state = feed("abcdef\r\u001b[3C\u001b[K");
  assert.equal(termText(state), "abc", "CSI 0K erases from the cursor to line end");
}

{
  const state = feed("abcdef\r\u001b[3C\u001b[1K");
  assert.equal(termText(state), "    ef", "CSI 1K erases through the cursor without shifting text");
}

{
  const state = feed("abcdef\r\u001b[3C\u001b[2K");
  assert.equal(termText(state), "", "CSI 2K erases the whole line");
}

{
  const rows = Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n");
  const state = feed(`${rows}\u001b[H\u001b[2J`);
  assert.match(termText(state), /^row0\nrow1\nrow2\nrow3\nrow4\nrow5/,
    "CSI 2J must keep completed scrollback above the visible screen");
}

{
  const state = feed("hello\r\u001b[2C\u001b[1P");
  assert.equal(termText(state), "helo", "CSI P deletes at the cursor");
}

{
  const state = feed("\u001b[?1h\u001b[?2004h");
  assert.deepEqual(termModes(state), { applicationCursor: true, bracketedPaste: true });
  termFeed(state, "\u001b[?1l\u001b[?2004l");
  assert.deepEqual(termModes(state), { applicationCursor: false, bracketedPaste: false });
}

{
  assert.equal(terminalKeySequence({ key: "ArrowUp" }), "\u001b[A");
  assert.equal(terminalKeySequence({ key: "ArrowDown" }, { applicationCursor: true }), "\u001bOB");
  assert.equal(terminalKeySequence({ key: "ArrowLeft", shiftKey: true }), "\u001b[1;2D");
  assert.equal(terminalKeySequence({ key: "Home" }), "\u001b[H");
  assert.equal(terminalKeySequence({ key: "End" }, { applicationCursor: true }), "\u001bOF");
  assert.equal(terminalKeySequence({ key: "Delete" }), "\u001b[3~");
  assert.equal(terminalKeySequence({ key: "PageUp" }), "\u001b[5~");
  assert.equal(terminalKeySequence({ key: "Tab", shiftKey: true }), "\u001b[Z");
  assert.equal(terminalKeySequence({ key: "c", ctrlKey: true }), "\u0003");
  assert.equal(terminalKeySequence({ key: "d", ctrlKey: true }), "\u0004");
  assert.equal(terminalKeySequence({ key: " ", ctrlKey: true }), "\u0000");
  assert.equal(terminalKeySequence({ key: "[", ctrlKey: true }), "\u001b");
  assert.equal(terminalKeySequence({ key: "x", altKey: true }), "\u001bx");
  assert.equal(terminalKeySequence({ key: "F5" }), "\u001b[15~");
  assert.equal(terminalPastePayload("a\rb", { bracketedPaste: true }), "\u001b[200~a\rb\u001b[201~");
}

{
  const history = createAsciiHistory();
  history.commit("ifconfig -a");
  history.commit("ifconfig -a");
  assert.deepEqual(history.entries, ["ifconfig -a"], "duplicate adjacent commands are collapsed");
  assert.equal(history.previous("draft"), "ifconfig -a");
  assert.equal(history.next(), "draft");
}

{
  const history = createAsciiHistory(["one", "two"]);
  assert.equal(history.previous("current"), "two");
  assert.equal(history.previous("current"), "one");
  assert.equal(history.previous("current"), "one");
  assert.equal(history.next(), "two");
  assert.equal(history.next(), "current");
}

{
  const storage = new Map();
  const fake = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  saveAsciiHistory(fake, ["ls", "pwd", "pwd"]);
  assert.deepEqual(loadAsciiHistory(fake), ["ls", "pwd"]);
}

{
  const guard = createLiveTimestampGuard(() => 5000);
  assert.equal(guard(3000), 3000);
  assert.equal(guard(2999), 3000);
  assert.equal(guard(5001), 5001);
  assert.equal(guard(undefined), 5001);
}

{
  assert.deepEqual(formatHexDump("41 54 0D 0A"), [
    "00000000  41 54 0D 0A                                      |AT..|",
  ]);
  assert.equal(joinTransferHex("41 42", "43"), "41 42 43");
}

{
  const entries = [];
  assert.equal(appendAsciiTxEntry(entries, {
    dir: "TX", interactive: true, text: "i", hex: "69", ascii: "i", ts_ms: 10,
  }), false);
  assert.equal(appendAsciiTxEntry(entries, {
    dir: "TX", interactive: true, text: "p\r", hex: "70 0D", ascii: "p.", ts_ms: 11,
  }), true);
  assert.equal(appendAsciiTxEntry(entries, {
    dir: "TX", interactive: true, text: "x", hex: "78", ascii: "x", ts_ms: 12,
  }), false);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "ip\r");
  assert.equal(entries[0].hex, "69 70 0D");
  assert.equal(entries[1].text, "x");
}

console.log(JSON.stringify({ ok: true, terminal: "VT erase semantics", asciiHistory: true }));
