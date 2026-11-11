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
  const port = typeof address === "object" && address ? address.port : 1446;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/tests/all-pages.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");

  const result = await page.evaluate(async () => {
    const source = await fetch("/index.html").then((response) => response.text());
    const parsed = new DOMParser().parseFromString(source, "text/html");
    document.body.append(
      parsed.querySelector("header.titlebar"),
      parsed.querySelector("#app-update-dlg"),
    );

    const { createAppUpdateUi } = await import("/src/app-update-ui.js");
    const values = new Map();
    const storage = {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
    const info = {
      available: true,
      currentVersion: "0.3.25",
      currentBuild: "oldbuild",
      latestVersion: "0.3.26",
      latestBuild: "newbuild123",
      installerUrl: "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.26_x64-setup.exe",
      sha256: "a".repeat(64),
      notes: "Background update test",
    };
    let progressHandler = null;
    let downloadCalls = 0;
    let launchCalls = 0;
    let resolveDownload;
    const downloadPromise = new Promise((resolve) => {
      resolveDownload = resolve;
    });
    const makeUi = () => createAppUpdateUi({
      invoke: async (command, args) => {
        if (command === "app_update_download") {
          downloadCalls += 1;
          return downloadPromise;
        }
        if (command === "app_update_launch") {
          launchCalls += 1;
          return { command, args };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      listen: (name, handler) => {
        if (name === "app-update://progress") progressHandler = handler;
      },
      toast: () => {},
      translate: (text) => text,
      syncNativeView: () => {},
      storage,
    });
    const waitFor = async (predicate) => {
      for (let i = 0; i < 120; i += 1) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return false;
    };

    const ui = makeUi();
    ui.bind();
    ui.showForCheck(info, { manual: false, reason: "" });
    const updateButton = document.getElementById("tb-update");
    const dialog = document.getElementById("app-update-dlg");
    const downloadButton = document.getElementById("app-update-download");
    const startup = {
      indicatorVisible: !updateButton.hidden,
      dialogStayedClosed: dialog.hidden,
      state: updateButton.dataset.state,
    };

    ui.open(info);
    const dialogOpened = !dialog.hidden;
    downloadButton.click();
    await waitFor(() => updateButton.dataset.state === "downloading");
    const backgroundStarted = {
      dialogHidden: dialog.hidden,
      state: updateButton.dataset.state,
      downloadCalls,
    };

    progressHandler({ payload: { phase: "download", pct: 42, received: 420, total: 1000 } });
    ui.open(info);
    const progressUi = {
      visible: !dialog.hidden,
      text: document.getElementById("app-update-status").textContent,
      buttonText: downloadButton.textContent,
    };
    dialog.click();
    const backgroundClose = dialog.hidden;

    resolveDownload({
      path: "C:\\Users\\test\\AppData\\Local\\com.kyin.kdock\\updates\\KDock_0.3.26_x64-setup.exe",
      verified: true,
      silentUpdate: false,
      bytes: 1000,
    });
    await waitFor(() => updateButton.dataset.state === "ready");
    const ready = {
      state: updateButton.dataset.state,
      stored: JSON.parse(storage.getItem("kdock_update_ready") || "null"),
    };

    updateButton.click();
    const readyDialog = {
      visible: !dialog.hidden,
      buttonText: downloadButton.textContent,
    };
    downloadButton.click();
    await waitFor(() => launchCalls === 1);

    const restoredUi = makeUi();
    restoredUi.bind();
    restoredUi.showForCheck(info, { manual: false, reason: "" });
    restoredUi.open(info);
    const restored = {
      state: updateButton.dataset.state,
      buttonText: downloadButton.textContent,
      dialogVisible: !dialog.hidden,
      downloadCalls,
      launchCalls,
    };
    return {
      startup,
      dialogOpened,
      backgroundStarted,
      progressUi,
      backgroundClose,
      ready,
      readyDialog,
      restored,
    };
  });

  if (errors.length) throw new Error(`Update UI page errors: ${errors.join("; ")}`);
  if (!result.startup.indicatorVisible || !result.startup.dialogStayedClosed
      || result.startup.state !== "available" || !result.dialogOpened) {
    throw new Error(`Startup update entry is wrong: ${JSON.stringify(result)}`);
  }
  if (!result.backgroundStarted.dialogHidden || result.backgroundStarted.state !== "downloading"
      || result.backgroundStarted.downloadCalls !== 1) {
    throw new Error(`Background download did not start correctly: ${JSON.stringify(result)}`);
  }
  if (!result.progressUi.visible || !result.progressUi.text.includes("42%")
      || result.progressUi.buttonText !== "后台下载中…" || !result.backgroundClose) {
    throw new Error(`Background progress/reopen is wrong: ${JSON.stringify(result)}`);
  }
  if (result.ready.state !== "ready" || !result.ready.stored?.path
      || !result.readyDialog.visible || result.readyDialog.buttonText !== "启动安装程序") {
    throw new Error(`Downloaded state was lost: ${JSON.stringify(result)}`);
  }
  if (result.restored.state !== "ready" || result.restored.buttonText !== "启动安装程序"
      || !result.restored.dialogVisible || result.restored.downloadCalls !== 1
      || result.restored.launchCalls !== 1) {
    throw new Error(`Restored update state is wrong: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
