import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1439, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1439;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`http://127.0.0.1:${port}/tests/agent-session.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.agentSessionReady === "1");

  const result = await page.evaluate(() => ({
    title: document.getElementById("ag-title").textContent,
    turns: document.getElementById("ag-turns").textContent,
    speakers: [...document.querySelectorAll("#ag-chat .agmsg .who")].map((el) => el.textContent),
    meta: window.__agentSessionMeta,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));

  if (result.title !== "修复首轮会话标题" || result.turns !== "1 轮") {
    throw new Error(`Session title/turn did not update immediately: ${JSON.stringify(result)}`);
  }
  if (result.speakers[0] !== "任工" || result.speakers[1] !== "KDock") {
    throw new Error(`Session speaker names did not update immediately: ${JSON.stringify(result)}`);
  }
  if (!result.meta.changed || result.meta.unchanged) {
    throw new Error(`Session display change detection is wrong: ${JSON.stringify(result.meta)}`);
  }
  if (result.meta.other.title !== "修复首轮会话标题") {
    throw new Error(`A late event from another session overwrote the current meta: ${JSON.stringify(result.meta.other)}`);
  }
  if (result.overflow > 2) throw new Error(`Agent session test overflows horizontally by ${result.overflow}px`);

  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
