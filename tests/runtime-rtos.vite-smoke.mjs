import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  process.argv[2]
    || process.env.KDOCK_RTOS_FIXTURE
    || resolve(root, "tests", "fixtures", "runtime-graph.rtos.json"),
);
if (!existsSync(fixturePath)) {
  throw new Error(`RTOS runtime fixture not found: ${fixturePath}`);
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const node = (name) => fixture.nodes.find((item) => item.name === name);
const startTask = node("start_task");
for (const name of ["start_task", "task1", "task2", "task3"]) {
  if (!node(name)) throw new Error(`RTOS fixture does not contain ${name}`);
}

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1432, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1432;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript((runtimeData) => {
    window.__KDOCK_RT_FIXTURE__ = runtimeData;
    window.__KDOCK_RT_RUNTIME__ = runtimeData;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === "runtime_analyzer_status") {
          return { installed: true, version: "vite-mock", path: "vite-mock" };
        }
        if (cmd === "runtime_analyze") return runtimeData;
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
  await page.evaluate((addr) => window.rtUseAsChain(addr), startTask.addr);
  await page.waitForFunction(() => document.querySelector("#rt-scope")?.value === "chain");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const names = await page.locator("#rt-nodes .rtfn-name").allTextContents();
  for (const expected of ["start_task", "task1", "task2", "task3"]) {
    if (!names.includes(expected)) {
      throw new Error(`RTOS chain is missing ${expected}: ${names.join(", ")}`);
    }
  }
  const taskBadges = await page.locator("#rt-nodes .nkind").allTextContents();
  if (taskBadges.filter((value) => value === "TASK").length < 3) {
    throw new Error(`RTOS entry badges were not rendered: ${taskBadges.join(", ")}`);
  }
  const registrationEdges = await page.locator("#rt-edges-g .rtlink.rtos").count();
  if (!registrationEdges) throw new Error("RTOS registration edges were not rendered");
  const detail = await page.locator("#rt-fn-card").textContent();
  if (!detail.includes("xTaskCreate 注册")) {
    throw new Error(`RTOS registration call site is not explained: ${detail}`);
  }

  console.log(JSON.stringify({
    ok: true,
    fixture: fixturePath,
    chainRoot: "start_task",
    visibleNodes: names,
    taskBadges: taskBadges.filter((value) => value === "TASK").length,
    registrationEdges,
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
