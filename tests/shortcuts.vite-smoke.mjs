import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1438, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1438;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  await page.goto(`http://127.0.0.1:${port}/tests/shortcuts.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.shortcutsReady === "1");

  const initial = await page.evaluate(() => ({
    definitions: window.__shortcutManager.defs.length,
    rows: document.querySelectorAll(".sc-action").length,
    groups: document.querySelectorAll(".sc-group").length,
    search: !!document.querySelector(".sc-search"),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  if (initial.definitions !== 20 || initial.rows !== 20) {
    throw new Error(`Shortcut action list is incomplete: ${JSON.stringify(initial)}`);
  }
  if (initial.groups !== 3 || !initial.search) throw new Error(`Shortcut editor structure is invalid: ${JSON.stringify(initial)}`);
  if (initial.overflow > 2) throw new Error(`Shortcut editor overflows horizontally by ${initial.overflow}px`);

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "1", code: "Digit1", ctrlKey: true, altKey: true, bubbles: true,
    }));
  });
  let calls = await page.evaluate(() => window.__shortcutCalls);
  if (calls.at(-1) !== "nav.link") throw new Error(`Default Ctrl+Alt+1 did not dispatch: ${JSON.stringify(calls)}`);

  const conflict = await page.evaluate(() => {
    const result = window.__shortcutManager.setBinding("nav.link", "Ctrl+Alt+2");
    return { ...result, binding: window.__shortcutManager.bindingFor("nav.link") };
  });
  if (conflict.ok || conflict.error !== "conflict" || conflict.conflict?.id !== "nav.monitor") {
    throw new Error(`Shortcut conflict was not rejected correctly: ${JSON.stringify(conflict)}`);
  }
  if (conflict.binding !== "Ctrl+Alt+1") throw new Error("Conflicting binding changed the active shortcut");

  const navRow = page.locator('.sc-action[data-action="nav.link"]');
  await navRow.locator(".shortcutkey").click();
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "9", code: "Digit9", ctrlKey: true, altKey: true, bubbles: true,
    }));
  });
  const customized = await page.evaluate(() => ({
    binding: window.__shortcutManager.bindingFor("nav.link"),
    label: document.querySelector('.sc-action[data-action="nav.link"] .shortcutkey')?.textContent,
    stored: JSON.parse(localStorage.getItem("kdock_shortcuts") || "{}"),
    message: document.querySelector(".sc-message")?.textContent,
  }));
  if (customized.binding !== "Ctrl+Alt+9" || customized.label !== "Ctrl+Alt+9") {
    throw new Error(`Recording a custom shortcut failed: ${JSON.stringify(customized)}`);
  }
  if (customized.stored["nav.link"] !== "Ctrl+Alt+9" || !customized.message.includes("已保存")) {
    throw new Error(`Custom shortcut was not persisted or confirmed: ${JSON.stringify(customized)}`);
  }

  await page.evaluate(() => {
    window.__shortcutCalls.length = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "9", code: "Digit9", ctrlKey: true, altKey: true, bubbles: true,
    }));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "1", code: "Digit1", ctrlKey: true, altKey: true, bubbles: true,
    }));
  });
  calls = await page.evaluate(() => window.__shortcutCalls);
  if (calls.length !== 1 || calls[0] !== "nav.link") {
    throw new Error(`Custom binding did not replace the old binding: ${JSON.stringify(calls)}`);
  }

  await navRow.locator(".sc-reset").click();
  const reset = await page.evaluate(() => ({
    binding: window.__shortcutManager.bindingFor("nav.link"),
    customCount: window.__shortcutManager.customCount(),
  }));
  if (reset.binding !== "Ctrl+Alt+1" || reset.customCount !== 0) {
    throw new Error(`Single shortcut reset failed: ${JSON.stringify(reset)}`);
  }

  await page.locator(".sc-search").fill("屏幕共享");
  const filtered = await page.evaluate(() => ({
    rows: document.querySelectorAll(".sc-action").length,
    actions: [...document.querySelectorAll(".sc-action")].map((el) => el.dataset.action),
  }));
  if (!filtered.actions.includes("capture.fullscreen") || filtered.rows >= initial.rows) {
    throw new Error(`Shortcut search did not filter the action list: ${JSON.stringify(filtered)}`);
  }

  if (process.env.KDOCK_SHORTCUT_SHOT) {
    await page.locator(".sc-search").fill("");
    await page.screenshot({ path: resolve(root, process.env.KDOCK_SHORTCUT_SHOT) });
  }

  console.log(JSON.stringify({ ok: true, initial, customized, reset, filtered }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
