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
  const port = typeof address === "object" && address ? address.port : 1450;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/tests/all-pages.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");
  await page.evaluate(async () => {
    const source = await fetch("/index.html").then((response) => response.text());
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const root = document.getElementById("ui-root");
    root.prepend(parsed.querySelector("header.titlebar"));
    root.appendChild(parsed.querySelector("#settings-modal"));
    root.appendChild(parsed.querySelector("#ag-dlg"));
    root.appendChild(parsed.querySelector("#app-update-dlg"));
    document.getElementById("settings-modal").hidden = false;
  });

  const results = [];
  for (const profile of profiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(({ scale, width, height }) => {
      const root = document.documentElement;
      root.style.setProperty("--ui-scale", String(scale));
      root.style.setProperty("--app-vw", `${width / scale / 100}px`);
      root.style.setProperty("--app-vh", `${height / scale / 100}px`);
      root.dataset.uiScale = scale.toFixed(3);
      document.getElementById("settings-modal").hidden = false;
      document.querySelectorAll(".setpane").forEach((pane) => {
        pane.hidden = pane.dataset.setpane !== "general";
      });
    }, profile);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const state = await page.evaluate(() => {
      const box = document.querySelector("#settings-modal .modalbox");
      const body = document.querySelector("#settings-modal .modalbody");
      const nav = document.querySelector("#settings-modal .modalnav");
      const content = document.querySelector("#settings-modal .modalcontent");
      const panes = document.querySelector("#settings-modal .settings-panes");
      const firstTab = document.querySelector("#settings-modal .modaltab");
      const firstField = document.querySelector('#settings-modal .setpane[data-setpane="general"] > .field');
      const firstInput = document.getElementById("set-output-dir");
      const rect = box.getBoundingClientRect();
      const tabStyle = getComputedStyle(firstTab);
      const fieldStyle = firstField ? getComputedStyle(firstField) : null;
      const inputStyle = firstInput ? getComputedStyle(firstInput) : null;
      return {
        box: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        viewport: { width: innerWidth, height: innerHeight },
        navGroups: document.querySelectorAll(".modalnav-group").length,
        tabs: document.querySelectorAll(".modaltab").length,
        navFlex: getComputedStyle(nav).flexDirection,
        tabMinHeight: tabStyle.minHeight,
        navIconWidth: parseFloat(getComputedStyle(document.querySelector(".modalnavico")).width),
        appNavIconWidth: parseFloat(getComputedStyle(document.querySelector(".navitem .navico")).width),
        topbarIconWidth: parseFloat(getComputedStyle(document.querySelector(".tbs-svg")).width),
        updateIconWidth: parseFloat(getComputedStyle(document.querySelector(".tb-update-ico")).width),
        actionIconWidth: parseFloat(getComputedStyle(document.querySelector(".btn-ico")).width),
        fieldDisplay: fieldStyle?.display || "",
        fieldColumns: fieldStyle?.gridTemplateColumns || "",
        fieldHeight: firstField ? Math.round(firstField.getBoundingClientRect().height) : 0,
        inputHeight: firstInput ? Math.round(firstInput.getBoundingClientRect().height) : 0,
        inputComputedHeight: inputStyle ? parseFloat(inputStyle.height) : 0,
        contentOverflow: content.scrollWidth - content.clientWidth,
        panesOverflow: panes.scrollWidth - panes.clientWidth,
      };
    });
    const outside = state.box.left < -2 || state.box.top < -2
      || state.box.right > state.viewport.width + 2 || state.box.bottom > state.viewport.height + 2;
    const shouldStack = profile.width / profile.scale <= 760;
    const expectedTabMinHeight = shouldStack ? "48px" : "54px";
    if (outside || state.navGroups !== 3 || state.tabs !== 12
        || state.tabMinHeight !== expectedTabMinHeight
        || Math.abs(state.navIconWidth - 18) > .1
        || Math.abs(state.appNavIconWidth - 20) > .1
        || Math.abs(state.topbarIconWidth - 15) > .1 || Math.abs(state.updateIconWidth - 15) > .1
        || Math.abs(state.actionIconWidth - 15) > .1
        || state.fieldDisplay !== "grid" || !state.fieldColumns || state.fieldHeight < 50
        || Math.abs(state.inputComputedHeight - 38) > .1 || state.inputHeight < 34
        || state.contentOverflow > 2 || state.panesOverflow > 2
        || (shouldStack ? state.navFlex !== "row" : state.navFlex !== "column")) {
      throw new Error(`${profile.name}: settings layout failed ${JSON.stringify(state)}`);
    }
    results.push({ profile: profile.name, ...state });
    if (process.env.KDOCK_SETTINGS_SHOT && profile === profiles[0]) {
      await page.screenshot({ path: resolve(root, process.env.KDOCK_SETTINGS_SHOT) });
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  const settingsPages = await page.evaluate(() => {
    const modal = document.getElementById("settings-modal");
    const show = (name) => {
      modal.hidden = false;
      document.querySelectorAll(".setpane").forEach((pane) => {
        pane.hidden = pane.dataset.setpane !== name;
      });
      const content = document.querySelector("#settings-modal .settings-panes");
      if (content) content.scrollTop = 0;
    };
    show("model");
    const tabs = [...document.querySelectorAll("#ag-prov-tabs .segtab")];
    const current = document.querySelector(".provcurrent");
    const pick = document.getElementById("ag-prov-step-pick");
    const form = document.getElementById("ag-prov-step-form");
    const model = {
      tabs: tabs.map((tab) => tab.textContent.trim()),
      currentDisplay: current ? getComputedStyle(current).display : "",
      presetGridColumns: getComputedStyle(document.getElementById("ag-preset-grid")).gridTemplateColumns,
      pickerVisible: !!pick && !pick.hidden,
      formHidden: !!form && form.hidden,
      addButton: !!document.getElementById("ag-prov-add"),
      advancedCollapsed: !document.querySelector(".provadvanced")?.open,
      capacityVisible: !document.getElementById("ag-p-ctx")?.closest("details"),
      toolsVisible: !document.getElementById("ag-p-tools")?.closest("details"),
      advancedSections: document.querySelectorAll(".provadvanced").length,
      freeControls: document.querySelectorAll(
        "#ag-free-toggle, #ag-prov-free, #ag-prov-amd, #amd-load-list, #ag-model-busy",
      ).length,
      catalogEntry: !!document.getElementById("ag-open-catalog"),
    };
    show("cache");
    const cache = {
      hero: !!document.querySelector(".cachehero"),
      toolbar: !!document.querySelector(".cachetoolbar"),
      listClass: document.getElementById("cache-list")?.className || "",
    };
    const settingsZ = Number.parseInt(getComputedStyle(modal).zIndex, 10);
    const confirm = document.getElementById("ag-dlg");
    const update = document.getElementById("app-update-dlg");
    confirm.hidden = false;
    update.hidden = false;
    const layer = {
      settingsZ,
      confirmZ: Number.parseInt(getComputedStyle(confirm).zIndex, 10),
      updateZ: Number.parseInt(getComputedStyle(update).zIndex, 10),
      cacheZ: 0,
    };
    const kd = document.createElement("div");
    kd.className = "kdmodal";
    document.body.appendChild(kd);
    layer.cacheZ = Number.parseInt(getComputedStyle(kd).zIndex, 10);
    kd.remove();
    confirm.hidden = true;
    update.hidden = true;
    return { model, cache, layer };
  });
  if (settingsPages.model.tabs.join("|") !== "已配置|添加模型"
      || settingsPages.model.currentDisplay !== "grid"
      || !settingsPages.model.presetGridColumns
      || !settingsPages.model.pickerVisible
      || !settingsPages.model.formHidden
      || !settingsPages.model.addButton
      || !settingsPages.model.advancedCollapsed
      || !settingsPages.model.capacityVisible
      || !settingsPages.model.toolsVisible
      || settingsPages.model.advancedSections !== 2
      || settingsPages.model.freeControls !== 0
      || !settingsPages.model.catalogEntry
      || !settingsPages.cache.hero
      || !settingsPages.cache.toolbar
      || !settingsPages.cache.listClass.includes("cache-list")
      || settingsPages.layer.confirmZ <= settingsPages.layer.settingsZ
      || settingsPages.layer.updateZ <= settingsPages.layer.settingsZ
      || settingsPages.layer.cacheZ <= settingsPages.layer.settingsZ) {
    throw new Error(`Settings pages failed: ${JSON.stringify(settingsPages)}`);
  }
  if (errors.length) throw new Error(`Settings page errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ ok: true, profiles: results, settingsPages }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
