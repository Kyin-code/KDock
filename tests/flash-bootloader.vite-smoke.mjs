import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1434, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1434;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/flash-bootloader.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.flashTestReady === "1");

  const inspect = () => page.evaluate(() => ({
    tool: document.getElementById("fl-tool").value,
    probeVisible: [...document.querySelectorAll(".fl-probe-only")].some((el) => !el.hidden),
    serialRomVisible: !document.getElementById("fl-rom-serial-row").hidden,
    netOtaVisible: !document.getElementById("fl-netudp-row").hidden,
    dfuNoteVisible: !document.getElementById("fl-rom-dfu-note").hidden,
    addrLabel: document.getElementById("fl-addr-label").textContent,
    routeHint: document.getElementById("fl-route-hint").textContent,
    command: document.getElementById("fl-cmd").textContent,
  }));

  await page.evaluate(() => window.__flashShowTool("stm32dfu"));
  const dfu = await inspect();
  if (dfu.probeVisible || dfu.serialRomVisible || !dfu.dfuNoteVisible || !dfu.command.includes("port=USB1")) {
    throw new Error(`STM32 DFU UI mismatch: ${JSON.stringify(dfu)}`);
  }

  await page.evaluate(() => window.__flashShowTool("stm32uart"));
  const uart = await inspect();
  if (uart.probeVisible || !uart.serialRomVisible || !uart.command.includes("port=COM5")) {
    throw new Error(`STM32 UART UI mismatch: ${JSON.stringify(uart)}`);
  }

  await page.evaluate(() => window.__flashShowTool("esprom"));
  const esp = await inspect();
  if (esp.addrLabel !== "Flash 偏移" || !esp.command.includes("write_flash 0x0")) {
    throw new Error(`ESP ROM UI mismatch: ${JSON.stringify(esp)}`);
  }

  await page.evaluate(() => window.__flashShowTool("openocd"));
  const probe = await inspect();
  if (!probe.probeVisible || probe.serialRomVisible || probe.dfuNoteVisible) {
    throw new Error(`Probe UI mismatch: ${JSON.stringify(probe)}`);
  }

  await page.evaluate(() => window.__flashShowTool("netudp"));
  const ota = await inspect();
  if (
    !ota.netOtaVisible
    || ota.probeVisible
    || !ota.routeHint.includes("SVC1")
    || !ota.command.includes("KDock OTA")
  ) {
    throw new Error(`KDock OTA UI mismatch: ${JSON.stringify(ota)}`);
  }

  const upgradeNote = await page.locator("#upg-protocol-note").textContent();
  if (!upgradeNote.includes("YMODEM") || !upgradeNote.includes(".fw")) {
    throw new Error(`Upgrade protocol note is unclear: ${upgradeNote}`);
  }

  if (process.env.KDOCK_FLASH_SCREENSHOT) {
    await page.evaluate(() => window.__flashShowTool("stm32uart"));
    await page.screenshot({ path: resolve(root, process.env.KDOCK_FLASH_SCREENSHOT), fullPage: true });
  }
  console.log(JSON.stringify({ ok: true, dfu, uart, esp, probe, ota, upgradeNote }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
