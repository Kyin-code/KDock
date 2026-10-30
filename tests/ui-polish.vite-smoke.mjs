import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1437, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1437;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/all-pages.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");

  await page.evaluate(() => window.__showAllPagesPage("scope"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scope = await page.evaluate(() => {
    const el = (selector) => document.querySelector(selector);
    const bounds = (node) => {
      const r = node?.getBoundingClientRect();
      return r ? {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        bottom: Math.round(r.bottom), right: Math.round(r.right),
      } : null;
    };
    return {
      work: bounds(el('[data-work="scope"]')),
      toolbar: bounds(el(".scopetoolbar")),
      stage: bounds(el(".scopestage")),
      plot: bounds(el(".scopeplotwrap")),
      empty: bounds(el("#sc-empty")),
      emptyHidden: el("#sc-empty")?.hidden,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (!scope.stage || scope.stage.height < 360) throw new Error(`Scope stage is too short: ${JSON.stringify(scope)}`);
  if (!scope.plot || scope.plot.height < 280 || scope.plot.width < 400) {
    throw new Error(`Scope plot area is collapsed: ${JSON.stringify(scope)}`);
  }
  if (scope.emptyHidden || !scope.empty || scope.empty.width < 300 || scope.empty.height < 200) {
    throw new Error(`Scope empty state is not filling the stage: ${JSON.stringify(scope)}`);
  }
  if (scope.overflow > 2) throw new Error(`Scope page overflows horizontally by ${scope.overflow}px`);
  if (process.env.KDOCK_UI_SCOPE_SHOT) {
    await page.screenshot({ path: resolve(root, process.env.KDOCK_UI_SCOPE_SHOT) });
  }

  await page.evaluate(() => window.__showAllPagesPage("batch"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const batch = await page.evaluate(() => {
    const el = (selector) => document.querySelector(selector);
    const bounds = (node) => {
      const r = node?.getBoundingClientRect();
      return r ? {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        bottom: Math.round(r.bottom), right: Math.round(r.right),
      } : null;
    };
    const cols = [...document.querySelectorAll('[data-work="batch"] .btcol')];
    const sendbar = el(".btsendbar");
    const grid = el(".btgrid");
    return {
      work: bounds(el('[data-work="batch"]')),
      hero: bounds(el(".batchhero")),
      grid: bounds(grid),
      cols: cols.map(bounds),
      editors: cols.map((col) => bounds(col.querySelector(".bted"))),
      arrow: bounds(el(".btarrow")),
      sendbar: bounds(sendbar),
      sendbarBelowGrid: !!sendbar && !!grid && sendbar.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (!batch.grid || batch.grid.height < 300 || batch.grid.width < 500) {
    throw new Error(`Batch editor grid is collapsed: ${JSON.stringify(batch)}`);
  }
  if (batch.cols.length !== 2 || batch.cols.some((item) => item.height < 280 || item.width < 220)) {
    throw new Error(`Batch editor columns have invalid geometry: ${JSON.stringify(batch)}`);
  }
  if (batch.editors.some((item) => item.height < 230)) {
    throw new Error(`Batch editors are too short: ${JSON.stringify(batch)}`);
  }
  if (!batch.sendbarBelowGrid) throw new Error(`Batch send bar overlaps the editor grid: ${JSON.stringify(batch)}`);
  if (batch.overflow > 2) throw new Error(`Batch page overflows horizontally by ${batch.overflow}px`);
  if (process.env.KDOCK_UI_BATCH_SHOT) {
    await page.screenshot({ path: resolve(root, process.env.KDOCK_UI_BATCH_SHOT) });
  }

  console.log(JSON.stringify({ ok: true, scope, batch }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
