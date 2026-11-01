import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  const port = typeof address === "object" && address ? address.port : 1442;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/tests/lazy-pages.vite.html`);
  try {
    await page.waitForFunction(() => document.documentElement.dataset.lazyReady === "1", null, {
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(`lazy page smoke did not finish: ${errors.join("\n") || error.message}`);
  }

  const result = await page.evaluate(() => window.__lazyResult);
  assert.deepEqual(errors, [], `lazy page errors:\n${errors.join("\n")}`);
  assert.equal(result.helpShared, true, "help module was loaded more than once");
  assert.equal(result.helpItems, 102, "help module content is incomplete");
  assert.equal(result.runtimeReady, true, "runtime module did not initialize");
  assert.equal(result.toolsBound, true, "batch/calculator modules did not initialize");
  assert.equal(result.uplotReady, true, "uPlot module did not load");
  assert.equal(result.logicBound, true, "logic module did not initialize");

  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
