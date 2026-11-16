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

const profiles = [
  { name: "1500x950", width: 1500, height: 950, scale: 1 },
  { name: "1366x768", width: 1366, height: 768, scale: 1 },
  { name: "1024x768@125", width: 1024, height: 768, scale: 1.25 },
  { name: "900x600", width: 900, height: 600, scale: 1 },
  { name: "800x600@110", width: 800, height: 600, scale: 1.1 },
  { name: "1500x950@200", width: 1500, height: 950, scale: 2 },
];

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 1451;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/tests/help-ui.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.helpReady === "1");

  const results = [];
  for (const profile of profiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(({ width, height, scale }) => {
      const root = document.documentElement;
      root.style.setProperty("--ui-scale", String(scale));
      root.style.setProperty("--app-vw", `${width / scale / 100}px`);
      root.style.setProperty("--app-vh", `${height / scale / 100}px`);
      root.dataset.uiScale = scale.toFixed(3);
      document.getElementById("help-modal").hidden = false;
      window.__showHelpGroup(window.__helpGroups[0].title);
    }, profile);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const state = await page.evaluate(() => {
      const modal = document.getElementById("help-modal");
      const box = modal.querySelector(".helpbox");
      const nav = document.getElementById("help-nav");
      const content = modal.querySelector(".helpcontent");
      const boxRect = box.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        box: {
          left: boxRect.left,
          top: boxRect.top,
          right: boxRect.right,
          bottom: boxRect.bottom,
          width: boxRect.width,
          height: boxRect.height,
        },
        headerHeight: parseFloat(getComputedStyle(modal.querySelector(".helphead")).height),
        pageButtons: nav.querySelectorAll(".helppagebtn").length,
        groupCount: window.__helpGroups.length,
        firstGroupItems: window.__helpGroups[0].items.length,
        renderedItems: document.querySelectorAll("#help-body .helpitem").length,
        navDirection: getComputedStyle(nav).flexDirection,
        searchHeight: parseFloat(getComputedStyle(modal.querySelector(".helpsearch")).height),
        contentOverflow: content.scrollWidth - content.clientWidth,
        bodyOverflow: document.documentElement.scrollWidth - innerWidth,
        pageScrolls: document.querySelector(".helpdoc").scrollHeight >= document.querySelector(".helpdoc").clientHeight,
      };
    });
    const outside = state.box.left < -2 || state.box.top < -2
      || state.box.right > state.viewport.width + 2
      || state.box.bottom > state.viewport.height + 2;
    const shouldBeHorizontal = profile.width / profile.scale <= 760;
    assert.ok(!outside, `${profile.name}: help dialog is outside viewport: ${JSON.stringify(state)}`);
    assert.ok(Math.abs(state.headerHeight - 58) <= .1, `${profile.name}: header height changed`);
    assert.equal(state.pageButtons, state.groupCount, `${profile.name}: help nav must contain pages only`);
    assert.ok(state.pageButtons < 30, `${profile.name}: page navigation is too long`);
    assert.equal(state.renderedItems, state.firstGroupItems, `${profile.name}: page did not render all topics`);
    assert.equal(
      state.navDirection,
      shouldBeHorizontal ? "row" : "column",
      `${profile.name}: wrong help navigation direction`,
    );
    assert.ok(state.searchHeight >= 33, `${profile.name}: help search is too short`);
    assert.ok(state.contentOverflow <= 2 && state.bodyOverflow <= 2, `${profile.name}: help content overflows`);
    results.push({ profile: profile.name, ...state });
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--ui-scale", "1");
    root.style.setProperty("--app-vw", "13.66px");
    root.style.setProperty("--app-vh", "7.68px");
    root.dataset.uiScale = "1.000";
    window.__showHelpGroup(window.__helpGroups[0].title);
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  if (process.env.KDOCK_HELP_SHOT) {
    await page.screenshot({ path: resolve(root, process.env.KDOCK_HELP_SHOT) });
  }

  const pageNavigation = await page.evaluate(() => {
    const indexButtons = document.querySelectorAll("#test-help-index button");
    return {
      indexPages: indexButtons.length,
      groupCount: window.__helpGroups.length,
      firstPageText: document.querySelector("#help-nav .helppagebtn")?.textContent.trim() || "",
    };
  });
  assert.equal(pageNavigation.indexPages, pageNavigation.groupCount, "settings help index must be page-based");
  assert.ok(!pageNavigation.firstPageText.includes("Work with KDock"), "page nav still lists topic entries");

  const searchState = await page.evaluate(() => {
    const search = document.getElementById("help-search");
    const visible = () => [...document.querySelectorAll("#help-nav .helppagebtn")]
      .filter((button) => !button.hidden);
    search.value = "中控编排";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const matched = visible().map((button) => button.dataset.helpGroup);
    search.value = "definitely-not-a-help-page";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const emptyVisible = !document.getElementById("help-nav-empty").hidden;
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      matched,
      emptyVisible,
      restored: visible().length,
      total: document.querySelectorAll("#help-nav .helppagebtn").length,
    };
  });
  assert.ok(searchState.matched.includes("中控编排"), `page search did not find the target page: ${JSON.stringify(searchState)}`);
  assert.ok(searchState.matched.length < searchState.total, "page search did not filter the sidebar");
  assert.equal(searchState.emptyVisible, true);
  assert.equal(searchState.restored, searchState.total);

  const anchorState = await page.evaluate(async () => {
    const group = window.__helpGroups.find((entry) => entry.title === "运行结构");
    window.__showHelpGroup("运行结构", "help-runtime-chain", true);
    await new Promise((done) => setTimeout(done, 120));
    const target = document.querySelector('[data-help-item="help-runtime-chain"]');
    return {
      active: document.querySelector("#help-nav .helppagebtn.active")?.dataset.helpGroup,
      itemCount: document.querySelectorAll("#help-body .helpitem").length,
      groupItems: group.items.length,
      targetHighlighted: target?.classList.contains("target"),
      scrollTop: document.querySelector(".helpdoc").scrollTop,
      label: document.getElementById("help-page-label").textContent,
    };
  });
  assert.equal(anchorState.active, "运行结构");
  assert.equal(anchorState.itemCount, anchorState.groupItems);
  assert.equal(anchorState.targetHighlighted, true);
  assert.ok(anchorState.scrollTop > 20, `specific help anchor did not scroll: ${JSON.stringify(anchorState)}`);
  assert.ok(anchorState.label.includes("运行结构"));

  const pagerState = await page.evaluate(async () => {
    const before = window.__helpCurrent.group.title;
    document.getElementById("help-next").click();
    await new Promise((done) => requestAnimationFrame(done));
    return {
      before,
      after: window.__helpCurrent.group.title,
      position: document.getElementById("help-position").textContent,
    };
  });
  assert.equal(pagerState.before, "运行结构");
  assert.equal(pagerState.after, "文件管理");
  assert.match(pagerState.position, /^\d+ \/ \d+$/);

  const englishState = await page.evaluate(() => {
    window.__setHelpLanguage("en");
    return {
      active: document.querySelector("#help-nav .helppagebtn.active b")?.textContent || "",
      firstPage: document.querySelector("#help-nav .helppagebtn b")?.textContent || "",
      heading: document.querySelector("#help-body h2")?.textContent || "",
      chinesePageLabel: /[\u3400-\u9fff]/.test(document.querySelector("#help-page-label").textContent),
    };
  });
  assert.ok(!/[\u3400-\u9fff]/.test(englishState.firstPage), `help page nav was not translated: ${JSON.stringify(englishState)}`);
  assert.ok(!/[\u3400-\u9fff]/.test(englishState.heading), `help page heading was not translated: ${JSON.stringify(englishState)}`);
  assert.equal(englishState.chinesePageLabel, false);

  assert.deepEqual(errors, [], `help page errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({
    ok: true,
    profiles: results,
    pageNavigation,
    searchState,
    anchorState,
    pagerState,
    englishState,
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
