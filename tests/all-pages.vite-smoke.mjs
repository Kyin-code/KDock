import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1436, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1436;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/all-pages.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");

  const pages = await page.evaluate(() => window.__allPages);
  if (pages.length < 20) throw new Error(`Expected at least 20 pages, got ${pages.length}: ${pages.join(", ")}`);

  const screenshotDir = process.env.KDOCK_ALL_PAGES_DIR
    ? resolve(root, process.env.KDOCK_ALL_PAGES_DIR)
    : "";
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

  const results = [];
  for (const tab of pages) {
    await page.evaluate((name) => window.__showAllPagesPage(name), tab);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate((name) => {
      const work = [...document.querySelectorAll("[data-work]")].find((el) => !el.hidden);
      const param = [...document.querySelectorAll("[data-param]")].find((el) => !el.hidden);
      const w = work?.getBoundingClientRect();
      const p = param?.getBoundingClientRect();
      return {
        tab: name,
        work: work?.dataset.work || "",
        param: param?.dataset.param || "",
        workSize: w ? [Math.round(w.width), Math.round(w.height)] : [0, 0],
        paramSize: p ? [Math.round(p.width), Math.round(p.height)] : [0, 0],
        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, tab);
    if (!state.work || !state.param) throw new Error(`${tab}: missing work/param pane ${JSON.stringify(state)}`);
    if (state.workSize[0] < 80 || state.workSize[1] < 80) {
      throw new Error(`${tab}: work pane collapsed ${JSON.stringify(state)}`);
    }
    if (state.paramSize[0] < 120 || state.paramSize[1] < 40) {
      throw new Error(`${tab}: param pane collapsed ${JSON.stringify(state)}`);
    }
    if (state.bodyOverflow > 2) throw new Error(`${tab}: page overflows horizontally by ${state.bodyOverflow}px`);
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${tab}.png`) });
    results.push(state);
  }

  await page.evaluate(() => localStorage.removeItem("kdock_nav_advanced_open"));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");
  const advancedClosed = await page.locator("#nav-advanced").isHidden();
  await page.locator("#nav-advanced-toggle").click();
  const advancedOpened = await page.locator("#nav-advanced").isVisible();
  const advancedCount = await page.locator("#nav-advanced-count").textContent();
  if (!advancedClosed || !advancedOpened) throw new Error("Advanced navigation did not toggle correctly");
  if (Number(advancedCount) !== 11) throw new Error(`Advanced count should be 11, got ${advancedCount}`);

  console.log(JSON.stringify({
    ok: true,
    pageCount: pages.length,
    pages: results,
    advancedNav: { closedByDefault: advancedClosed, opens: advancedOpened, count: Number(advancedCount) },
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
