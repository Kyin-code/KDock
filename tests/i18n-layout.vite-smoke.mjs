import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = await readFile(resolve(root, "src/main.js"), "utf8");
const start = main.indexOf("const EN = {");
const end = main.indexOf("\nconst appI18n", start);
assert.ok(start >= 0 && end > start, "EN dictionary block not found");
const objectSource = main.slice(main.indexOf("{", start), end).trim().replace(/;\s*$/, "");
const dictionary = new Function(`return (${objectSource});`)();

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

const profiles = [
  { name: "900x600@100", width: 900, height: 600, scale: 1 },
  { name: "1024x768@125", width: 1024, height: 768, scale: 1.25 },
  { name: "1366x768@100", width: 1366, height: 768, scale: 1 },
  { name: "1366x768@125", width: 1366, height: 768, scale: 1.25 },
  { name: "1920x1080@100", width: 1920, height: 1080, scale: 1 },
  { name: "1500x950@200", width: 1500, height: 950, scale: 2 },
];
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 1441;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.addInitScript((en) => {
    window.__I18N_EN__ = en;
  }, dictionary);
  await page.goto(`http://127.0.0.1:${port}/tests/i18n-layout.vite.html`);
  try {
    await page.waitForFunction(() => document.documentElement.dataset.i18nReady === "1");
  } catch (error) {
    throw new Error(`i18n layout page did not initialize: ${pageErrors.join("\n") || error.message}`);
  }
  const pages = await page.evaluate(() =>
    window.__i18nPages.filter((tab) => tab !== "debug"),
  );
  const settingsPanes = await page.evaluate(() =>
    [...document.querySelectorAll(".modaltab[data-set]")].map((tab) => tab.dataset.set),
  );

  const initial = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, label, .navitem, .modaltab, .cardtitle")]
      .filter((element) => element.getClientRects().length && element.textContent.trim())
      .slice(0, 120)
      .map((element) => element.textContent.trim());
    const placeholders = [...document.querySelectorAll("[placeholder]")]
      .slice(0, 40)
      .map((element) => element.placeholder);
    const tips = [...document.querySelectorAll("[data-tip], [title]")]
      .slice(0, 40)
      .map((element) => element.dataset.tip || element.getAttribute("title") || "");
    return { controls, placeholders, tips };
  });

  await page.evaluate(() => window.__setI18nLanguage("en"));
  const english = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, label, .navitem, .modaltab, .cardtitle")]
      .filter((element) => element.getClientRects().length && element.textContent.trim())
      .slice(0, 120)
      .map((element) => element.textContent.trim());
    const placeholders = [...document.querySelectorAll("[placeholder]")]
      .slice(0, 40)
      .map((element) => element.placeholder);
    const tips = [...document.querySelectorAll("[data-tip], [title]")]
      .slice(0, 40)
      .map((element) => element.dataset.tip || element.getAttribute("title") || "");
    return { controls, placeholders, tips };
  });
  await page.evaluate(() => window.__setI18nLanguage("zh"));
  const roundTrip = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, label, .navitem, .modaltab, .cardtitle")]
      .filter((element) => element.getClientRects().length && element.textContent.trim())
      .slice(0, 120)
      .map((element) => element.textContent.trim());
    const placeholders = [...document.querySelectorAll("[placeholder]")]
      .slice(0, 40)
      .map((element) => element.placeholder);
    const tips = [...document.querySelectorAll("[data-tip], [title]")]
      .slice(0, 40)
      .map((element) => element.dataset.tip || element.getAttribute("title") || "");
    return { controls, placeholders, tips };
  });
  assert.deepEqual(roundTrip, initial, "ZH -> EN -> ZH did not restore all sampled copy");

  const results = [];
  for (const profile of profiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(({ width, height, scale }) => {
      const root = document.documentElement;
      root.style.setProperty("--ui-scale", String(scale));
      root.style.setProperty("--app-vw", `${width / scale / 100}px`);
      root.style.setProperty("--app-vh", `${height / scale / 100}px`);
      root.dataset.uiScale = scale.toFixed(3);
    }, profile);

    for (const language of ["zh", "en"]) {
      await page.evaluate((lang) => window.__setI18nLanguage(lang), language);
      for (const tab of pages) {
        await page.evaluate((name) => {
          window.__hideI18nSettings();
          window.__showI18nPage(name);
        }, tab);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const state = await page.evaluate(({ tab, lang }) => {
          const visible = (element) => element.getClientRects().length > 0;
          const clipped = [];
          const critical = "button, .navitem, .modaltab, .cardtitle, label, .field > label, .agctl-label, #status-chip, #ip-location-chip";
          for (const element of document.querySelectorAll(critical)) {
            if (!visible(element) || !element.textContent.trim()) continue;
            const style = getComputedStyle(element);
            if (!["hidden", "clip"].includes(style.overflowX)) continue;
            const horizontal = element.scrollWidth - element.clientWidth;
            if (horizontal > 2) {
              clipped.push({
                tag: element.tagName.toLowerCase(),
                id: element.id,
                cls: String(element.className || "").slice(0, 80),
                text: element.textContent.trim().slice(0, 100),
                overflow: horizontal,
              });
            }
          }
          const collisions = [];
          const containers = document.querySelectorAll(
            ".btnrow, .trow, .kacts, .modaltabs, .agcontrols, .agcomposer, .kbadressbar, .scopetoolbar",
          );
          for (const container of containers) {
            if (!visible(container)) continue;
            const children = [...container.children].filter((element) =>
              visible(element)
              && (element.matches("button, .btn, .chip, .seg, select, input")
                || element.querySelector(":scope > button, :scope > .btn")),
            );
            for (let i = 0; i < children.length; i++) {
              for (let j = i + 1; j < children.length; j++) {
                const a = children[i].getBoundingClientRect();
                const b = children[j].getBoundingClientRect();
                const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (overlapX > 2 && overlapY > 2) {
                  collisions.push({
                    container: String(container.className || container.tagName),
                    first: children[i].textContent.trim().slice(0, 60),
                    second: children[j].textContent.trim().slice(0, 60),
                    overlap: [Math.round(overlapX), Math.round(overlapY)],
                  });
                }
              }
            }
          }
          const untranslated = lang !== "en" ? [] : [
            ...[...document.querySelectorAll(
              "button, .navitem, .modaltab, .cardtitle, label, .field > label, .agctl-label",
            )].map((element) => ({ kind: "text", element })),
            ...[...document.querySelectorAll("[placeholder]")].map((element) => ({ kind: "placeholder", element })),
            ...[...document.querySelectorAll("[data-tip], [title]")].map((element) => ({ kind: "tip", element })),
          ].filter(({ kind, element }) => {
            if (!visible(element)) return false;
            const value = kind === "placeholder"
              ? element.placeholder
              : kind === "tip"
                ? element.dataset.tip || element.getAttribute("title") || ""
                : element.textContent.trim();
            if (!value || value === "中文") return false;
            return /[\u3400-\u9fff]/.test(value);
          }).map(({ kind, element }) => ({
            kind,
            id: element.id,
            cls: String(element.className || "").slice(0, 80),
            text: (kind === "placeholder"
              ? element.placeholder
              : kind === "tip"
                ? element.dataset.tip || element.getAttribute("title") || ""
                : element.textContent.trim()).slice(0, 120),
          }));
          const agentProblem = tab !== "agent" ? null : (() => {
            const work = document.querySelector('[data-work="agent"]');
            const chat = document.querySelector("#ag-chat");
            const params = document.querySelector(".params");
            const workRect = work.getBoundingClientRect();
            const paramsRect = params.getBoundingClientRect();
            const overlapX = Math.min(workRect.right, paramsRect.right) - Math.max(workRect.left, paramsRect.left);
            const overlapY = Math.min(workRect.bottom, paramsRect.bottom) - Math.max(workRect.top, paramsRect.top);
            return {
              chatHeight: chat.clientHeight,
              workBottom: Math.round(workRect.bottom),
              paramsTop: Math.round(paramsRect.top),
              overlap: overlapX > 2 && overlapY > 2 ? Math.round(overlapY) : 0,
            };
          })();
          return {
            tab,
            language: lang,
            bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
            navOverflow: (() => {
              const nav = document.querySelector(".nav");
              return nav ? nav.scrollWidth - nav.clientWidth : 0;
            })(),
            clipped: clipped.slice(0, 30),
            collisions: collisions.slice(0, 20),
            untranslated: untranslated.slice(0, 30),
            agentProblem,
          };
        }, { tab, lang: language });
        results.push({ profile: profile.name, ...state });
      }

      for (const pane of settingsPanes) {
        await page.evaluate((name) => window.__showI18nSettings(name), pane);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const state = await page.evaluate(({ pane, lang }) => {
          const modal = document.querySelector("#settings-modal .modalbox");
          const clipped = [];
          for (const element of modal.querySelectorAll(
            ".modaltab, .setpane button, .setpane label, .setpane .cardtitle",
          )) {
            if (!element.getClientRects().length || !element.textContent.trim()) continue;
            const style = getComputedStyle(element);
            if (!["hidden", "clip"].includes(style.overflowX)) continue;
            const horizontal = element.scrollWidth - element.clientWidth;
            if (horizontal > 2) {
              clipped.push({
                tag: element.tagName.toLowerCase(),
                id: element.id,
                cls: String(element.className || "").slice(0, 80),
                text: element.textContent.trim().slice(0, 100),
                overflow: horizontal,
              });
            }
          }
          const untranslated = lang !== "en" ? [] : [...modal.querySelectorAll(
            ".modaltab, .setpane button, .setpane label, .setpane .cardtitle, .setpane [placeholder], .setpane [title], .setpane [data-tip]",
          )].filter((element) => {
            if (!element.getClientRects().length) return false;
            const value = element.placeholder || element.dataset.tip || element.getAttribute("title") || element.textContent.trim();
            if (!value || value === "中文") return false;
            return /[\u3400-\u9fff]/.test(value);
          }).map((element) => ({
            kind: element.placeholder ? "placeholder" : element.dataset.tip || element.getAttribute("title") ? "tip" : "text",
            id: element.id,
            cls: String(element.className || "").slice(0, 80),
            text: (element.placeholder || element.dataset.tip || element.getAttribute("title") || element.textContent.trim()).slice(0, 120),
          }));
          return {
            pane,
            language: lang,
            boxOverflow: modal.scrollWidth - modal.clientWidth,
            contentOverflow: (() => {
              const content = modal.querySelector(".modalcontent");
              return content ? content.scrollWidth - content.clientWidth : 0;
            })(),
            clipped: clipped.slice(0, 30),
            untranslated: untranslated.slice(0, 30),
          };
        }, { pane, lang: language });
        results.push({ profile: profile.name, settings: true, ...state });
      }
    }
  }

  const failures = results.filter((item) =>
    item.bodyOverflow > 2
    || item.navOverflow > 2
    || item.boxOverflow > 2
    || item.contentOverflow > 2
    || item.clipped?.length
    || item.collisions?.length
    || item.untranslated?.length
    || (item.agentProblem && (item.agentProblem.chatHeight < 55 || item.agentProblem.overlap > 2)),
  );
  assert.deepEqual(
    failures,
    [],
    `i18n layout failures (${failures.length}/${results.length}):\n${JSON.stringify(failures.slice(0, 12), null, 2)}`,
  );

  console.log(JSON.stringify({
    ok: true,
    dictionaryEntries: Object.keys(dictionary).length,
    profiles: profiles.length,
    checks: results.length,
    englishCopySamples: english.controls.filter((text) => text !== initial.controls[english.controls.indexOf(text)]).slice(0, 12),
    maxBodyOverflow: Math.max(0, ...results.map((item) => item.bodyOverflow || 0)),
    maxNavOverflow: Math.max(0, ...results.map((item) => item.navOverflow || 0)),
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
