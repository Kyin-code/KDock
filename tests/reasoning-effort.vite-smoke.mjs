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
  const port = typeof address === "object" && address ? address.port : 1435;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 900, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/reasoning-effort.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.reasoningReady === "1");

  const chips = page.locator("#ag-p-reasoning-modes .effortchip");
  if ((await chips.count()) !== 8) throw new Error(`Expected 8 effort chips, got ${await chips.count()}`);
  if ((await page.locator("#ag-p-reasoning-modes input:checked").count()) !== 2) {
    throw new Error("Multi-effort selection did not render");
  }
  if ((await page.locator("#ag-p-reasoning").inputValue()) !== "high") {
    throw new Error("Default effort did not render");
  }
  if ((await page.locator("#ag-p-reason-result .reasonrow").count()) !== 2) {
    throw new Error("Reasoning probe result table did not render");
  }

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('[data-setpane="model"]');
    const ctx = document.getElementById("ag-p-ctx");
    const out = document.getElementById("ag-p-res");
    out.value = "10000";
    return {
      width: panel.getBoundingClientRect().width,
      overflow: panel.scrollWidth - panel.clientWidth,
      selected: [...document.querySelectorAll("#ag-p-reasoning-modes input:checked")].map((x) => x.value),
      ctxWidth: ctx.getBoundingClientRect().width,
      outWidth: out.getBoundingClientRect().width,
      outStep: out.step,
      outValidArbitraryInteger: out.validity.valid,
    };
  });
  if (layout.overflow > 1) throw new Error(`Reasoning panel overflows by ${layout.overflow}px`);
  if (layout.ctxWidth < 160 || layout.outWidth < 160) {
    throw new Error(`Token inputs are too narrow: ${JSON.stringify(layout)}`);
  }
  if (layout.outStep !== "1" || !layout.outValidArbitraryInteger) {
    throw new Error(`Arbitrary output token values are not accepted: ${JSON.stringify(layout)}`);
  }

  if (process.env.KDOCK_REASONING_SCREENSHOT) {
    await page.screenshot({ path: resolve(root, process.env.KDOCK_REASONING_SCREENSHOT), fullPage: true });
  }
  console.log(JSON.stringify({ ok: true, chips: 8, layout }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
