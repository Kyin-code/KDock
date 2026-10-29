import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  process.argv[2]
    || process.env.KDOCK_RT_FIXTURE
    || resolve(root, "tests", "fixtures", "runtime-graph.small.json"),
);
if (!existsSync(fixturePath)) {
  throw new Error(`Runtime fixture not found: ${fixturePath}`);
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const chainTarget = fixture.nodes.find((node) => node.name === "lfs_init");
if (!chainTarget) throw new Error("Fixture does not contain lfs_init");
const multiRootNames = [
  ["fsm_init", "XC7K160T_FSM"],
  ["fifo_Analysis", "it6263_handle"],
].find(([a, b]) => fixture.nodes.some((n) => n.name === a) && fixture.nodes.some((n) => n.name === b));
if (!multiRootNames) throw new Error("Fixture does not contain a multi-root test pair");
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1431, strictPort: false },
  logLevel: "error",
});

const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = edgeCandidates.find(existsSync);
if (!executablePath) throw new Error("Microsoft Edge was not found");

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 1431;

  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript((runtimeFixture) => {
    window.__KDOCK_RT_FIXTURE__ = runtimeFixture;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === "runtime_analyzer_status") {
          return { installed: true, version: "vite-mock", path: "vite-mock" };
        }
        if (cmd === "runtime_analyze") return window.__KDOCK_RT_FIXTURE__;
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
    };
  }, fixture);

  await page.goto(`http://127.0.0.1:${port}/tests/runtime-graph.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.viteTestReady === "1", null, {
    timeout: 30_000,
  });

  const nodeNames = () => page.locator("#rt-nodes .rtfn-name").allTextContents();
  const initialNames = await nodeNames();
  if (!initialNames.includes("main")) throw new Error("main is missing from the initial graph");
  if (!initialNames.includes("MainLoop")) throw new Error("MainLoop is missing from the initial graph");
  if (!initialNames.includes("fifo_Analysis")) {
    throw new Error("MainLoop work function fifo_Analysis is missing from the initial graph");
  }

  const initialCount = initialNames.length;
  const firstRoot = page.locator("#rt-nodes .rtfn").filter({ hasText: multiRootNames[0] }).first();
  const secondRoot = page.locator("#rt-nodes .rtfn").filter({ hasText: multiRootNames[1] }).first();
  await firstRoot.click();
  await secondRoot.click({ modifiers: ["Control"] });
  if ((await page.locator("#rt-nodes .rtfn.sel").count()) !== 2) {
    throw new Error("Ctrl-click multi-select did not select two roots");
  }
  await page.locator("#rt-chain-pick-side").click();
  await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "chain");
  const multiChainNames = await nodeNames();
  if (multiChainNames.includes("main")) {
    throw new Error("Multi-root chain kept unrelated main-chain nodes");
  }
  for (const expected of multiRootNames) {
    if (!multiChainNames.includes(expected)) {
      throw new Error(`Multi-root chain is missing ${expected}`);
    }
  }
  const multiRootLabel = await page.locator("#rt-chain-root-side").textContent();
  if (!multiRootLabel.includes("+ 1")) {
    throw new Error(`Multi-root label is incorrect: ${multiRootLabel}`);
  }
  await page.locator("#rt-chain-back-side").click();
  await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "all");

  await page.evaluate((addr) => window.rtUseAsChain(addr), chainTarget.addr);
  await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "chain");
  const chainNames = await nodeNames();
  if (chainNames.includes("main")) {
    throw new Error("Chain mode still contains unrelated main-chain nodes");
  }
  await page.locator("#rt-nodes .rtfn:not(.chainroot)").first().click();
  const chainRoot = await page.locator("#rt-chain-root-side").textContent();
  if (!chainRoot.includes("lfs_init")) {
    throw new Error(`Selecting a child changed the chain root: ${chainRoot}`);
  }
  await page.locator("#rt-chain-back").click();
  await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "all");
  const returnedNames = await nodeNames();
  if (
    returnedNames.length !== initialNames.length
    || returnedNames.some((name) => !initialNames.includes(name))
  ) {
    throw new Error(
      `Returning to full firmware did not restore the graph `
      + `(initial=${initialNames.length}, chain=${chainNames.length}, returned=${returnedNames.length})`,
    );
  }
  for (const scopeSelector of ["#rt-scope", "#rt-scope-side"]) {
    await page.evaluate((addr) => window.rtUseAsChain(addr), chainTarget.addr);
    await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "chain");
    await page.locator(scopeSelector).selectOption("all");
    await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "all");
    const names = await nodeNames();
    if (names.length !== initialNames.length || names.some((name) => !initialNames.includes(name))) {
      throw new Error(
        `${scopeSelector} did not restore the full graph `
        + `(initial=${initialNames.length}, returned=${names.length})`,
      );
    }
  }

  const mainLoop = page.locator("#rt-nodes .rtfn").filter({ hasText: "MainLoop" }).first();
  await mainLoop.locator(".rtfold").click();
  const collapsedCount = await page.locator("#rt-nodes .rtfn").count();
  if (collapsedCount >= initialCount) {
    throw new Error(`MainLoop collapse did not reduce nodes (${initialCount} -> ${collapsedCount})`);
  }
  await mainLoop.locator(".rtfold").click();
  const expandedCount = await page.locator("#rt-nodes .rtfn").count();
  if (expandedCount <= collapsedCount) {
    throw new Error(`MainLoop expansion did not restore nodes (${collapsedCount} -> ${expandedCount})`);
  }

  await page.locator("#rt-search-input").fill("lfs_init");
  const result = page.locator("#rt-search-results .rtsearchhit").filter({ hasText: "lfs_init" }).first();
  await result.waitFor({ state: "visible" });
  await result.click();
  await page.waitForFunction(() => document.querySelector("#rt-fn-card")?.textContent.includes("lfs_init"));

  const canvas = page.locator("#rt-canvas");
  const blankPoint = await page.evaluate(() => {
    const cv = document.querySelector("#rt-canvas");
    const box = cv.getBoundingClientRect();
    for (let y = 20; y < box.height - 20; y += 30) {
      for (let x = 20; x < box.width - 20; x += 30) {
        const hit = document.elementFromPoint(box.left + x, box.top + y);
        if (hit === cv) return { x, y };
      }
    }
    return null;
  });
  if (!blankPoint) throw new Error("Could not find empty canvas space");
  await canvas.click({ position: blankPoint });
  const selectedAfterBlank = await page.locator("#rt-nodes .rtfn.sel").count();
  if (selectedAfterBlank !== 0) {
    const debug = await page.evaluate(() => {
      const cv = document.querySelector("#rt-canvas");
      const box = cv.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + 24, box.top + 24);
      return {
        className: target?.className || "",
        selected: [...document.querySelectorAll("#rt-nodes .rtfn.sel")].map((el) => el.dataset.addr),
      };
    });
    throw new Error(`Clicking blank canvas did not clear selection: ${JSON.stringify(debug)}`);
  }

  await page.locator("#rt-search-input").fill("HAL_Init");
  const halResult = page.locator("#rt-search-results .rtsearchhit").filter({ hasText: "HAL_Init" }).first();
  await halResult.waitFor({ state: "visible" });
  await halResult.click();
  if ((await page.locator("#rt-nodes .rtfn.sel").count()) !== 1) {
    throw new Error("Node selection was not visible");
  }
  await page.keyboard.press("Escape");
  if ((await page.locator("#rt-nodes .rtfn.sel").count()) !== 0) {
    throw new Error("Escape did not clear selection");
  }

  console.log(JSON.stringify({
    ok: true,
    fixture: fixturePath,
    functions: fixture.totalFunctions,
    initialVisible: initialCount,
    afterMainLoopCollapse: collapsedCount,
    afterMainLoopExpand: expandedCount,
    chainTarget: "lfs_init",
    multiSelectRoots: multiRootNames,
    multiChainVisible: multiChainNames.length,
    chainVisible: chainNames.length,
    returnedToFullVisible: returnedNames.length,
    searchTarget: "lfs_init",
    clearMethods: ["blank-canvas", "Escape"],
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
