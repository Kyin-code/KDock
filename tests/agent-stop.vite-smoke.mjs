import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "error",
});
const executablePath = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
if (!executablePath) throw new Error("Microsoft Edge was not found");

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 1441;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(`http://127.0.0.1:${port}/tests/agent-stop.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.agentStopReady === "1");

  const states = await page.evaluate(() => window.__agentStopStates);
  assert.equal(states.running.text, "思考中…");
  assert.equal(states.running.composerLocked, false);
  assert.equal(states.running.sendLabel, "补充");
  assert.equal(states.running.stopLabel, "停止");

  assert.equal(states.stopping.text, "正在停止…");
  assert.equal(states.stopping.kind, "err");
  assert.equal(states.stopping.stopDisabled, true);
  assert.equal(states.stopping.composerLocked, true);
  assert.equal(states.stopping.sendLabel, "正在停止…");
  assert.equal(states.stopping.stopLabel, "正在停止…");

  assert.equal(states.idle.text, "空闲");
  assert.equal(states.idle.stopVisible, false);
  assert.equal(states.idle.composerLocked, false);
  assert.equal(states.staleStopping.text, "空闲", "a stale stopping flag must not lock an idle composer");

  const main = await readFile(resolve(root, "src/main.js"), "utf8");
  assert.match(
    main,
    /agStoppingSessions\.add\(sid\);[\s\S]{0,260}?await invoke\("agent_stop"/,
    "the stopping state must be visible before the backend call",
  );
  assert.match(
    main,
    /async function agSyncRunning\(\)[\s\S]{0,900}?agClearIdleStopping\(\);[\s\S]{0,100}?agPaintRunUi\(\);/,
    "backend polling must paint the stopping state instead of overwriting it with thinking",
  );
  assert.match(
    main,
    /p\.session !== agMeta\.id[\s\S]{0,500}?agStoppingSessions\.has\(p\.session\)/,
    "round/tool events must not overwrite a requested stop",
  );

  console.log(JSON.stringify({ ok: true, states }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
