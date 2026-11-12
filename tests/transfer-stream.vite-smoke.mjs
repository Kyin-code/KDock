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
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/tests/transfer-stream.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.transferStreamReady === "1");
  assert.deepEqual(errors, []);

  const state = await page.evaluate(() => window.__transferStream);
  assert.deepEqual(state.order, ["complete RX", "tx one", "tx two"],
    "RX/TX must render in arrival order instead of moving all RX to the bottom");
  assert.equal(
    state.translated,
    "Connected to UDP 192.168.2.48:9001 <-> 192.168.2.178:23 (local port 9001)",
  );
  assert.equal(state.selection, "text");
  assert.equal(state.gutter, "none");
  assert.equal(state.cleared, true);

  const main = await readFile(resolve(root, "src/main.js"), "utf8");
  assert.match(main, /completeTransferTail\(\{ pending: rxPending, buffer: rxBuffer, tail: tailEntry, entry \}\)/);
  assert.match(main, /await listen\("link:\/\/tail"[\s\S]{0,260}?setRxTail\(p\)/);
  assert.match(main, /\$\("clear"\)\.onclick = async \(\) => \{[\s\S]{0,500}?clearRxView\(\);[\s\S]{0,300}?await invoke\("clear_log"\)[\s\S]{0,300}?clearRxView\(\)/);

  console.log(JSON.stringify({ ok: true, ...state }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
