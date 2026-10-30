import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 1433, strictPort: false },
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
  const port = typeof address === "object" && address ? address.port : 1433;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/agent-typography.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.typographyReady === "1");

  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--ui-font",
      '"KDock Audit UI", "Microsoft YaHei UI", sans-serif',
    );
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const style = async (selector, pseudo = null) => page.locator(selector).first().evaluate(
    (el, p) => {
      const s = getComputedStyle(el, p);
      return {
        family: s.fontFamily,
        size: parseFloat(s.fontSize),
        lineHeight: parseFloat(s.lineHeight),
        color: s.color,
      };
    },
    pseudo,
  );

  const body = await style("body");
  const input = await style("#ag-input");
  const placeholder = await style("#ag-input", "::placeholder");
  const infoValue = await style("#ag-info .v");
  const infoLabel = await style("#ag-info .k");
  const controlLabel = await style(".agctl-label");
  const cardTitle = await style(".agentpane .cardtitle");
  const usage = await style("#ag-usage");
  const code = await style(".agmsg .bubble code");
  const editor = await style("#ag-tx-body");

  for (const [name, value] of Object.entries({ body, input, placeholder, infoValue, infoLabel, controlLabel, cardTitle, usage })) {
    if (!value.family.includes("KDock Audit UI")) {
      throw new Error(`${name} did not inherit the selected UI font: ${value.family}`);
    }
  }
  if (input.size < 14 || input.lineHeight < 21) {
    throw new Error(`Agent input typography is too cramped: ${JSON.stringify(input)}`);
  }
  if (infoValue.size < 12.5 || infoLabel.size < 11.5 || usage.size < 11) {
    throw new Error(`Agent information typography is too small: ${JSON.stringify({ infoValue, infoLabel, usage })}`);
  }
  if (!/Cascadia|Consolas|monospace/i.test(code.family)) {
    throw new Error(`Code block should keep the mono font: ${code.family}`);
  }
  if (!/Cascadia|Consolas|monospace/i.test(editor.family)) {
    throw new Error(`Text editor should keep the mono font: ${editor.family}`);
  }

  const layout = await page.evaluate(() => {
    const input = document.querySelector("#ag-input");
    const composer = document.querySelector(".agcomposer");
    const labels = [...document.querySelectorAll(".agctl-label")].map((el) => el.textContent.trim());
    return {
      inputHeight: input.getBoundingClientRect().height,
      placeholder: input.placeholder,
      composerOverflow: composer.scrollWidth - composer.clientWidth,
      labels,
    };
  });
  if (layout.inputHeight < 90) throw new Error(`Agent input is too short: ${layout.inputHeight}`);
  if (layout.composerOverflow > 1) throw new Error(`Agent composer overflows by ${layout.composerOverflow}px`);
  if (!layout.placeholder.includes("Shift+Enter")) throw new Error("Agent input placeholder lost keyboard guidance");
  if (!layout.labels.includes("权限") || !layout.labels.includes("模型")) {
    throw new Error(`Agent composer labels are incomplete: ${layout.labels.join(", ")}`);
  }
  if (!layout.labels.includes("思考") || await page.locator("#ag-reasoning").isHidden()) {
    throw new Error(`Agent reasoning selector is missing: ${layout.labels.join(", ")}`);
  }

  const fontAudit = await page.evaluate(() => {
    const mono = "code, pre, .agtext, .agskill, .agtool .nm";
    const offenders = [];
    for (const el of document.querySelectorAll("#test-root *")) {
      if (el.closest(mono) || el.tagName === "SVG" || el.tagName === "PATH") continue;
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue;
      const hasText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!hasText && !el.getAttribute("placeholder")) continue;
      const family = getComputedStyle(el).fontFamily;
      if (!family.includes("KDock Audit UI")) {
        offenders.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}: ${family}`);
      }
    }
    return [...new Set(offenders)];
  });
  if (fontAudit.length) {
    throw new Error(`Visible UI text bypassed the selected font:\n${fontAudit.join("\n")}`);
  }

  if (process.env.KDOCK_AGENT_SCREENSHOT) {
    await page.screenshot({ path: resolve(root, process.env.KDOCK_AGENT_SCREENSHOT), fullPage: true });
  }
  console.log(JSON.stringify({
    ok: true,
    selectedFont: body.family,
    input,
    placeholder,
    infoValue,
    infoLabel,
    cardTitle,
    usage,
    monoBoundary: { code: code.family, editor: editor.family },
    fontAudit: "all visible Agent UI text uses the selected font",
    layout,
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
