import { existsSync, mkdirSync } from "node:fs";
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
  const port = typeof address === "object" && address ? address.port : 1436;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://127.0.0.1:${port}/tests/all-pages.vite.html`);
  await page.waitForFunction(() => document.documentElement.dataset.allPagesReady === "1");

  const transferUi = await page.evaluate(() => {
    const more = document.getElementById("more-panel");
    const summary = more?.querySelector("summary");
    const mixed = document.querySelector('input[name="rx-mode"][value="mixed"]');
    const rxOnly = document.getElementById("rx-only");
    const lineEnding = document.getElementById("line-ending");
    const loop = document.getElementById("loop");
    const loopMs = document.getElementById("loop-ms");
    const resend = document.getElementById("ascii-resend");
    const localEcho = document.getElementById("local-echo");
    const sshRecent = document.getElementById("ssh-recent-list");
    const sshRemember = document.getElementById("ssh-remember");
    if (!more || !summary || !rxOnly || !lineEnding || !loop || !loopMs || !resend || !localEcho
        || !sshRecent || !sshRemember) {
      return { missing: true };
    }
    more.open = true;
    summary.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const insideStayedOpen = more.open;
    document.querySelector(".work").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const outsideClosed = !more.open;
    more.open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const escapedClosed = !more.open;
    return {
      mixedRemoved: !mixed,
      rxOnlyLabel: rxOnly.closest("label")?.textContent.trim(),
      movedToMore: [rxOnly, lineEnding, loop, loopMs].every((el) => more.contains(el)),
      sshHistoryUi: !!(sshRecent.closest('[data-mode="ssh"]') && sshRemember.closest('[data-mode="ssh"]')),
      resend: resend.textContent.trim(),
      localEchoDefault: !localEcho.checked,
      insideStayedOpen,
      outsideClosed,
      escapedClosed,
    };
  });
  if (transferUi.missing || !transferUi.mixedRemoved || !transferUi.movedToMore || !transferUi.sshHistoryUi
      || transferUi.rxOnlyLabel !== "仅 RX" || transferUi.resend !== "重发上一条"
      || !transferUi.localEchoDefault
      || !transferUi.insideStayedOpen || !transferUi.outsideClosed || !transferUi.escapedClosed) {
    throw new Error(`Transfer controls/popover regression: ${JSON.stringify(transferUi)}`);
  }

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

  await page.evaluate(() => window.__showAllPagesPage("agent"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const logGutter = await page.evaluate(() => {
    window.__showAllPagesPage("link");
    const rx = document.getElementById("rx");
    rx.classList.add("with-no");
    rx.innerHTML = '<div class="rxline"><span class="nox">1500</span><span class="rxtx">sample</span></div>';
    rx.style.setProperty("--rx-no-w", window.__logNumberColumnWidth(1500));
    const row = rx.querySelector(".rxline").getBoundingClientRect();
    const nox = rx.querySelector(".nox");
    const noxRect = nox.getBoundingClientRect();
    return {
      text: nox.textContent,
      width: Math.round(noxRect.width),
      rowHeight: Math.round(row.height),
      noxHeight: Math.round(noxRect.height),
      whiteSpace: getComputedStyle(nox).whiteSpace,
      wordBreak: getComputedStyle(nox).wordBreak,
    };
  });
  if (logGutter.text !== "1500" || logGutter.rowHeight > 24 || logGutter.noxHeight > 24
      || logGutter.whiteSpace !== "nowrap" || logGutter.wordBreak !== "normal") {
    throw new Error(`Log line numbers wrap digit-by-digit: ${JSON.stringify(logGutter)}`);
  }
  await page.evaluate(() => window.__showAllPagesPage("agent"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const agentLayout = await page.evaluate(() => {
    const grip = document.getElementById("ag-chat-grip");
    const box = document.getElementById("ag-box");
    const inputPane = grip.nextElementSibling;
    const work = document.querySelector('[data-work="agent"]');
    const drag = (from, to) => {
      grip.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 1, button: 0, clientY: from,
      }));
      grip.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, buttons: 1, clientY: to,
      }));
      grip.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 1, clientY: to,
      }));
    };
    const bounds = () => {
      const b = box.getBoundingClientRect();
      const i = inputPane.getBoundingClientRect();
      const w = work.getBoundingClientRect();
      return {
        chat: Math.round(b.height),
        input: Math.round(i.height),
        inputBottom: Math.round(i.bottom),
        workBottom: Math.round(w.bottom),
      };
    };

    const gripY = grip.getBoundingClientRect().top + 3;
    drag(gripY, gripY + 1600);
    const smallestInput = bounds();
    drag(gripY, gripY - 2200);
    const smallestChat = bounds();
    return {
      smallestInput,
      smallestChat,
      textareaResize: getComputedStyle(document.getElementById("ag-input")).resize,
    };
  });
  await page.setViewportSize({ width: 1180, height: 700 });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const agentAfterWindowShrink = await page.evaluate(() => {
    const work = document.querySelector('[data-work="agent"]').getBoundingClientRect();
    const input = document.querySelector('[data-work="agent"] .inpane').getBoundingClientRect();
    const chat = document.getElementById("ag-box").getBoundingClientRect();
    return {
      chat: Math.round(chat.height),
      input: Math.round(input.height),
      inputBottom: Math.round(input.bottom),
      workBottom: Math.round(work.bottom),
    };
  });
  if (agentLayout.textareaResize !== "none") {
    throw new Error(`Agent textarea still exposes its native resize handle: ${agentLayout.textareaResize}`);
  }
  if (agentLayout.smallestInput.input < 178 || agentLayout.smallestInput.chat < 138) {
    throw new Error(`Agent panes ignore their minimum sizes: ${JSON.stringify(agentLayout.smallestInput)}`);
  }
  if (agentLayout.smallestChat.chat < 138 || agentLayout.smallestChat.input < 178) {
    throw new Error(`Agent panes ignore their opposite minimums: ${JSON.stringify(agentLayout.smallestChat)}`);
  }
  for (const [name, value] of [
    ["dragged", agentLayout.smallestChat],
    ["shrunk-window", agentAfterWindowShrink],
  ]) {
    if (value.inputBottom > value.workBottom + 2) {
      throw new Error(`Agent composer is pushed outside the work area (${name}): ${JSON.stringify(value)}`);
    }
  }
  await page.setViewportSize({ width: 980, height: 800 });
  await page.evaluate(() => window.__showAllPagesPage("agent"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const navStability = await page.evaluate(() => {
    const root = document.documentElement;
    const title = document.getElementById("ag-title");
    const composer = document.querySelector('[data-work="agent"] .agcomposer');
    const oldTitle = title.textContent;
    title.textContent = "长会话标题用于验证左侧导航宽度变化时不会把 Agent 页面上下推动 ".repeat(3);
    const measure = () => {
      const header = document.querySelector('[data-work="agent"] > .trow:first-child').getBoundingClientRect();
      const box = document.getElementById("ag-box").getBoundingClientRect();
      const input = document.querySelector('[data-work="agent"] .inpane').getBoundingClientRect();
      return {
        headerTop: Math.round(header.top),
        headerHeight: Math.round(header.height),
        boxTop: Math.round(box.top),
        boxHeight: Math.round(box.height),
        inputTop: Math.round(input.top),
        inputHeight: Math.round(input.height),
      };
    };
    root.style.setProperty("--nav-w", "260px");
    const wideNav = measure();
    root.style.setProperty("--nav-w", "96px");
    const narrowNav = measure();
    const wraps = {
      header: getComputedStyle(document.querySelector('[data-work="agent"] > .trow:first-child')).flexWrap,
      composer: getComputedStyle(composer).flexWrap,
    };
    root.style.removeProperty("--nav-w");
    title.textContent = oldTitle;
    return { wideNav, narrowNav, wraps };
  });
  for (const key of ["headerTop", "headerHeight", "boxTop", "boxHeight", "inputTop", "inputHeight"]) {
    if (Math.abs(navStability.wideNav[key] - navStability.narrowNav[key]) > 1) {
      throw new Error(`Agent layout shifts when the nav width changes (${key}): ${JSON.stringify(navStability)}`);
    }
  }
  if (navStability.wraps.header !== "nowrap" || navStability.wraps.composer !== "nowrap") {
    throw new Error(`Agent critical rows must not wrap: ${JSON.stringify(navStability.wraps)}`);
  }
  const paramToggleStability = await page.evaluate(() => {
    const root = document.documentElement;
    const measure = () => {
      const split = document.querySelector(".split");
      const work = document.querySelector('[data-work="agent"]').getBoundingClientRect();
      const input = document.querySelector('[data-work="agent"] .inpane').getBoundingClientRect();
      const params = document.querySelector(".params").getBoundingClientRect();
      return {
        navWidth: getComputedStyle(split).gridTemplateColumns.split(/\s+/)[0],
        workHeight: Math.round(work.height),
        inputTop: Math.round(input.top),
        inputHeight: Math.round(input.height),
        inputBottom: Math.round(input.bottom),
        paramsHeight: Math.round(params.height),
      };
    };
    root.classList.remove("noparam");
    const shown = measure();
    root.classList.add("noparam");
    const hidden = measure();
    root.classList.remove("noparam");
    const shownAgain = measure();
    return { shown, hidden, shownAgain };
  });
  for (const key of ["navWidth", "workHeight", "inputTop", "inputHeight", "inputBottom"]) {
    if (paramToggleStability.shown[key] !== paramToggleStability.hidden[key]
      || paramToggleStability.shown[key] !== paramToggleStability.shownAgain[key]) {
      throw new Error(`Parameter toggle shifts Agent layout (${key}): ${JSON.stringify(paramToggleStability)}`);
    }
  }
  if (paramToggleStability.shown.paramsHeight < 100 || paramToggleStability.hidden.paramsHeight !== 0) {
    throw new Error(`Agent parameter overlay did not open/close correctly: ${JSON.stringify(paramToggleStability)}`);
  }
  await page.evaluate(() => {
    document.documentElement.classList.add("noparam");
    window.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const agentVisual = await page.evaluate(() => {
    const chat = document.getElementById("ag-chat");
    const user = document.createElement("div");
    user.className = "agmsg user";
    user.innerHTML = '<div class="head"><span class="who">你</span></div><div class="bubble">user sample</div>';
    const assistant = document.createElement("div");
    assistant.className = "agmsg assistant";
    assistant.innerHTML = '<div class="head"><span class="who">Agent</span></div><div class="bubble">assistant sample</div>';
    chat.append(user, assistant);
    const attach = document.getElementById("ag-attach").getBoundingClientRect();
    const permission = document.querySelector('[data-work="agent"] .agctl').getBoundingClientRect();
    const style = getComputedStyle(chat);
    const chatRect = chat.getBoundingClientRect();
    const userRect = user.getBoundingClientRect();
    const assistantRect = assistant.getBoundingClientRect();
    const split = document.querySelector(".split").getBoundingClientRect();
    const work = document.querySelector('[data-work="agent"]').getBoundingClientRect();
    const paramsVisible = !document.querySelector(".params").hidden &&
      getComputedStyle(document.querySelector(".params")).display !== "none";
    const splitStyle = getComputedStyle(document.querySelector(".split"));
    const result = {
      padLeft: parseFloat(style.paddingLeft),
      padRight: parseFloat(style.paddingRight),
      attachHeight: Math.round(attach.height),
      permissionHeight: Math.round(permission.height),
      contentCenterOffset: Math.round(
        ((userRect.left + userRect.right) / 2) - ((chatRect.left + chatRect.right) / 2)
      ),
      messageColumnWidthDelta: Math.round(Math.abs(userRect.width - assistantRect.width)),
      messageColumnLeftDelta: Math.round(Math.abs(userRect.left - assistantRect.left)),
      narrowWorkHeight: Math.round(work.height),
      narrowSplitHeight: Math.round(split.height),
      paramsVisible,
      gridRows: splitStyle.gridTemplateRows,
      splitHeight: Math.round(split.height),
    };
    user.remove();
    assistant.remove();
    return result;
  });
  if (Math.abs(agentVisual.padLeft - agentVisual.padRight) > 1) {
    throw new Error(`Agent conversation column is not horizontally symmetric: ${JSON.stringify(agentVisual)}`);
  }
  if (Math.abs(agentVisual.attachHeight - agentVisual.permissionHeight) > 1) {
    throw new Error(`Agent attachment and permission controls have different heights: ${JSON.stringify(agentVisual)}`);
  }
  if (Math.abs(agentVisual.contentCenterOffset) > 1 ||
      agentVisual.messageColumnWidthDelta > 1 ||
      agentVisual.messageColumnLeftDelta > 1) {
    throw new Error(`Agent message column is not centered: ${JSON.stringify(agentVisual)}`);
  }
  if (agentVisual.paramsVisible || Math.abs(agentVisual.narrowWorkHeight - agentVisual.narrowSplitHeight) > 1) {
    throw new Error(`Narrow Agent layout did not reclaim the right panel space: ${JSON.stringify(agentVisual)}`);
  }
  const turnVisual = await page.evaluate(() => {
    const chat = document.getElementById("ag-chat");
    const turnMarkup = `
      <div class="agturnblock">
        <div class="agmsg user">
          <div class="bubble">检查这一轮</div>
          <div class="agmeta">18:00:00</div>
        </div>
        <div class="agtoolgroup agturnprocess">
          <div class="ghead">
            <span class="gname">本轮过程</span>
            <span class="glist">3 次工具 · 思考×2</span>
            <span class="gst">12s</span>
          </div>
          <div class="gbody">folded details</div>
        </div>
        <div class="agmsg assistant">
          <div class="bubble">最终结果</div>
          <div class="agmeta">deepseek-flash · 18:00:12 · 本轮用时 12s</div>
        </div>
      </div>`;
    chat.innerHTML = turnMarkup.repeat(16);
    const think = document.createElement("div");
    think.className = "agthink";
    think.innerHTML =
      '<div class="th"><span class="lb">思考中…</span><span class="grow"></span><span class="chev">▾</span></div><div class="bd">thinking</div>';
    chat.appendChild(think);
    const turn = chat.querySelector(".agturnblock").getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const process = chat.querySelector(".agturnprocess").getBoundingClientRect();
    const body = chat.querySelector(".agturnprocess > .gbody");
    const userMeta = chat.querySelector(".agmsg.user .agmeta").getBoundingClientRect();
    const userBubble = chat.querySelector(".agmsg.user .bubble").getBoundingClientRect();
    const finalMeta = chat.querySelector(".agmsg.assistant .agmeta").textContent;
    const thinkRect = chat.querySelector(".agthink").getBoundingClientRect();
    const result = {
      processRatio: process.width / turn.width,
      processBodyDisplay: getComputedStyle(body).display,
      centerOffset: Math.round(Math.abs(
        (turn.left + turn.right) / 2 - (chatRect.left + chatRect.right) / 2,
      )),
      hasScroll: chat.scrollHeight > chat.clientHeight,
      thinkLeftDelta: Math.round(Math.abs(thinkRect.left - turn.left)),
      userMetaRightDelta: Math.round(Math.abs(userMeta.right - userBubble.right)),
      userMetaInside: userMeta.top >= userBubble.bottom - 1,
      finalMeta,
    };
    chat.innerHTML = "";
    return result;
  });
  if (turnVisual.processRatio > 0.72 || turnVisual.processBodyDisplay !== "none") {
    throw new Error(`Collapsed turn process is not compact: ${JSON.stringify(turnVisual)}`);
  }
  if (!turnVisual.hasScroll || turnVisual.centerOffset > 1) {
    throw new Error(`Agent conversation is not centered with a scrollbar: ${JSON.stringify(turnVisual)}`);
  }
  if (turnVisual.thinkLeftDelta > 1) {
    throw new Error(`Live thinking block is not aligned with the message column: ${JSON.stringify(turnVisual)}`);
  }
  if (turnVisual.userMetaRightDelta > 2 || !turnVisual.userMetaInside) {
    throw new Error(`User timestamp is not aligned under its bubble: ${JSON.stringify(turnVisual)}`);
  }
  if (!turnVisual.finalMeta.includes("本轮用时")) {
    throw new Error(`Final turn metadata lacks elapsed time: ${JSON.stringify(turnVisual)}`);
  }
  const railScroll = await page.evaluate(() => {
    window.__showAllPagesPage("agent");
    const rail = document.getElementById("ag-rail");
    rail.innerHTML = "";
    for (let i = 0; i < 60; i++) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "tick";
      if (i === 59) tick.classList.add("active");
      rail.appendChild(tick);
    }
    const active = rail.lastElementChild;
    const before = {
      clientHeight: rail.clientHeight,
      scrollHeight: rail.scrollHeight,
      direction: getComputedStyle(rail).flexDirection,
      scrollBehavior: getComputedStyle(rail).scrollBehavior,
      gap: parseFloat(getComputedStyle(rail).gap),
      tickHeight: parseFloat(getComputedStyle(rail.firstElementChild).height),
      markerHeight: parseFloat(getComputedStyle(rail.firstElementChild, "::after").height),
      activeBackground: getComputedStyle(active).backgroundColor,
      markerBackground: getComputedStyle(active, "::after").backgroundColor,
      activeMarkerHeight: parseFloat(getComputedStyle(active, "::after").height),
    };
    rail.scrollTo({ top: rail.scrollHeight, behavior: "instant" });
    const reachedBottom = rail.scrollTop > 0
      && Math.abs(rail.scrollTop + rail.clientHeight - rail.scrollHeight) <= 1;
    rail.innerHTML = "";
    return { ...before, reachedBottom };
  });
  if (railScroll.scrollHeight <= railScroll.clientHeight || !railScroll.reachedBottom
      || railScroll.direction !== "column" || railScroll.scrollBehavior !== "smooth"
      || railScroll.activeBackground !== "rgba(0, 0, 0, 0)"
      || railScroll.markerBackground === "rgba(0, 0, 0, 0)"
      || railScroll.gap !== 3 || railScroll.tickHeight !== 10
      || railScroll.markerHeight !== 2 || railScroll.activeMarkerHeight !== 2) {
    throw new Error(`Agent message rail cannot scroll through long histories: ${JSON.stringify(railScroll)}`);
  }
  const railHoverPoint = await page.evaluate(() => {
    const rail = document.getElementById("ag-rail");
    rail.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const tick = document.createElement("button");
      tick.className = "tick";
      rail.appendChild(tick);
    }
    const rect = rail.children[3].getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(railHoverPoint.x, railHoverPoint.y);
  await page.waitForTimeout(180);
  const railHover = await page.evaluate(() => {
    const rail = document.getElementById("ag-rail");
    const shapes = [...rail.children].map((tick) => {
      const style = getComputedStyle(tick, "::after");
      return [parseFloat(style.width), parseFloat(style.height)];
    });
    rail.innerHTML = "";
    return shapes;
  });
  const expectedHoverWidths = [12, 16, 20, 24, 20, 16, 12, 8, 8];
  if (railHover.some(([width], index) => width !== expectedHoverWidths[index])) {
    throw new Error(`Agent rail hover is not a neighbouring ripple: ${JSON.stringify(railHover)}`);
  }
  await page.evaluate(async () => {
    window.__showAllPagesPage("agent");
    const { buildAgentRail } = await import("/src/agent-rail.js");
    const box = document.getElementById("ag-chat");
    const rail = document.getElementById("ag-rail");
    box.innerHTML = "";
    const users = [];
    const events = [];
    for (let i = 0; i < 24; i++) {
      const message = document.createElement("div");
      message.className = "agmsg user";
      message.innerHTML = `<div class="bubble">第 ${i + 1} 条用户消息，这是一段用于检查超长文本省略和滚动行为的消息内容</div>`;
      box.appendChild(message);
      users.push(message);
      events.push({ type: "user", text: `第 ${i + 1} 条用户消息，这是一段用于检查超长文本省略和滚动行为的消息内容` });
    }
    buildAgentRail({ rail, box, users, userEvents: events });
  });
  const previewTick = await page.evaluate(() => {
    const rect = document.getElementById("ag-rail").children[2].getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(previewTick.x, previewTick.y);
  await page.waitForTimeout(340);
  const previewState = await page.evaluate(() => {
    const panel = document.querySelector("#ag-box .agrailpreview");
    const list = panel?.querySelector(".agrailpreview-list");
    if (!panel || !list) return { missing: true };
    const selected = panel.querySelector(".agrailpreview-item.active");
    const first = panel.querySelector(".agrailpreview-item");
    return {
      hidden: panel.hidden,
      count: panel.querySelectorAll(".agrailpreview-item").length,
      selected: selected?.textContent,
      listScrollable: list.scrollHeight > list.clientHeight,
      textAlign: getComputedStyle(first).textAlign,
      whiteSpace: getComputedStyle(first).whiteSpace,
      overflow: getComputedStyle(first).overflow,
    };
  });
  if (previewState.missing || previewState.hidden || previewState.count !== 24
      || !previewState.selected?.startsWith("第 3 条")
      || !previewState.listScrollable || previewState.textAlign !== "left"
      || previewState.whiteSpace !== "nowrap"
      || previewState.overflow !== "hidden") {
    throw new Error(`Agent rail hover preview is broken: ${JSON.stringify(previewState)}`);
  }
  const previewPanelPoint = await page.evaluate(() => {
    const rect = document.querySelector("#ag-box .agrailpreview").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(previewPanelPoint.x, previewPanelPoint.y);
  await page.waitForTimeout(260);
  const previewStayedOpen = await page.evaluate(
    () => !document.querySelector("#ag-box .agrailpreview")?.hidden,
  );
  await page.mouse.move(1, 1);
  await page.waitForTimeout(240);
  const previewClosed = await page.evaluate(
    () => document.querySelector("#ag-box .agrailpreview")?.hidden,
  );
  await page.evaluate(() => {
    document.getElementById("ag-chat").innerHTML = "";
    document.getElementById("ag-rail").innerHTML = "";
    document.querySelector("#ag-box .agrailpreview")?.remove();
  });
  if (!previewStayedOpen || !previewClosed) {
    throw new Error(`Agent rail preview cannot be entered or closed: ${previewStayedOpen}/${previewClosed}`);
  }
  const composerUi = await page.evaluate(async () => {
    window.__showAllPagesPage("agent");
    const { bindAgentComposer } = await import("/src/agent-composer.js");
    const meta = { id: "test-session", goal: "完成状态机重构", perm: "ask", sandbox_mode: "workspace", sandbox_network: true };
    const sent = [];
    const api = bindAgentComposer({
      en: (text) => text,
      toast: () => {},
      confirm: async () => true,
      getMeta: () => meta,
      getSessions: () => [meta],
      getLang: () => "zh",
      newSession: async () => {},
      updateHeader: () => {},
      sendText: async (text) => sent.push(text),
      sendPendingNow: () => {},
      uiScale: () => 1,
      setGoal: async (_id, value) => ({ ok: true, goal: value, cleared: !value }),
    });
    api.init();
    api.syncGoal(true);
    api.syncPolicy();
    api.renderPending(["第一条待发送", "第二条待发送"], false);
    const input = document.getElementById("ag-input");
    input.value = "/go";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const menu = document.getElementById("ag-cmd-hint");
    const goal = document.getElementById("ag-goal-card");
    const pending = document.getElementById("ag-pending");
    const policy = document.getElementById("ag-policy-hint");
    const composer = document.querySelector('[data-work="agent"] .agcomposer');
    const pane = document.querySelector('[data-work="agent"] > .inpane');
    const inputRect = input.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const result = {
      goalVisible: !goal.hidden,
      goalText: document.getElementById("ag-goal-text").value,
      policy: policy.textContent,
      policyLevel: policy.dataset.level,
      pendingFolded: !pending.querySelector("details")?.open,
      pendingSummary: pending.querySelector(".agpending-summary-text")?.textContent,
      pendingCount: pending.querySelector(".agpending-count")?.textContent,
      menuVisible: !menu.hidden,
      menuItems: [...menu.querySelectorAll(".agcmdrow")].map((row) => row.textContent),
      menuAboveInput: menu.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 1,
      inputVisible: inputRect.top >= paneRect.top && inputRect.bottom <= composerRect.top + 1,
      composerVisible: composerRect.bottom <= paneRect.bottom + 1,
      order: !!(goal.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING)
        && !!(pending.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING),
      consumed: api.handleKey(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
      inserted: input.value,
    };
    input.value = "/co";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    result.escapeConsumed = api.handleKey(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    result.menuClosed = menu.hidden;
    result.goalRunSaved = await api.saveGoal("新的可执行目标", { run: true });
    result.goalRunValue = meta.goal;
    result.sentAfterGoalRun = sent.slice();
    input.value = "";
    goal.hidden = true;
    pending.hidden = true;
    pending.innerHTML = "";
    return result;
  });
  if (!composerUi.goalVisible || composerUi.goalText !== "完成状态机重构"
      || !composerUi.policy.includes("允许") || composerUi.policyLevel !== "ask"
      || !composerUi.pendingFolded || !composerUi.pendingSummary?.startsWith("待发送")
      || composerUi.pendingCount !== "2" || !composerUi.menuVisible
      || composerUi.menuItems.length !== 1 || !composerUi.menuItems[0].includes("/goal")
      || !composerUi.menuAboveInput || !composerUi.inputVisible || !composerUi.composerVisible
      || !composerUi.order
      || !composerUi.consumed || composerUi.inserted !== "/goal "
      || !composerUi.escapeConsumed || !composerUi.menuClosed
      || !composerUi.goalRunSaved || composerUi.goalRunValue !== "新的可执行目标"
      || composerUi.sentAfterGoalRun?.[0] !== "开始执行当前目标。") {
    throw new Error(`Agent composer goal/slash/pending regression: ${JSON.stringify(composerUi)}`);
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove("noparam");
    window.dispatchEvent(new Event("resize"));
  });
  await page.setViewportSize({ width: 1500, height: 950 });

  // Resolution / UI zoom matrix. Representative pages cover the densest
  // layouts (Agent, runtime, scope, env, browser, USB and tools).
  const matrixPages = ["link", "agent", "kb", "env", "runtime", "scope", "logic", "usb", "calc"];
  const matrix = [
    { name: "1920x1080@100", width: 1920, height: 1080, scale: 1 },
    { name: "2560x1440@100", width: 2560, height: 1440, scale: 1 },
    { name: "3840x2160@150", width: 3840, height: 2160, scale: 1.5 },
    { name: "1366x768@100", width: 1366, height: 768, scale: 1 },
    { name: "1366x768@125", width: 1366, height: 768, scale: 1.25 },
    { name: "1280x720@150", width: 1280, height: 720, scale: 1.5 },
    { name: "1024x768@125", width: 1024, height: 768, scale: 1.25 },
    { name: "900x600@100", width: 900, height: 600, scale: 1 },
    { name: "1500x950@200", width: 1500, height: 950, scale: 2 },
  ];
  const matrixResults = [];
  for (const profile of matrix) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(({ scale, width, height }) => {
      const root = document.documentElement;
      root.style.setProperty("--ui-scale", String(scale));
      root.style.setProperty("--app-vw", `${width / scale / 100}px`);
      root.style.setProperty("--app-vh", `${height / scale / 100}px`);
      root.dataset.uiScale = scale.toFixed(3);
      root.dataset.lang = "en";
    }, profile);
    for (const tab of matrixPages) {
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
          navOverflow: (() => {
            const n = document.querySelector(".nav");
            return n ? n.scrollWidth - n.clientWidth : 0;
          })(),
        };
      }, tab);
      if (!state.work || state.workSize[0] < 80 || state.workSize[1] < 80) {
        throw new Error(`${profile.name}/${tab}: work pane collapsed ${JSON.stringify(state)}`);
      }
      if (!state.param) throw new Error(`${profile.name}/${tab}: parameter pane missing`);
      if (state.bodyOverflow > 2) {
        throw new Error(`${profile.name}/${tab}: body overflows by ${state.bodyOverflow}px`);
      }
      if (state.navOverflow > 2) {
        throw new Error(`${profile.name}/${tab}: nav overflows by ${state.navOverflow}px`);
      }
      matrixResults.push({ profile: profile.name, ...state });
    }
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
    logGutter,
    agentLayout,
    agentAfterWindowShrink,
    navStability,
    paramToggleStability,
    agentVisual,
    turnVisual,
    railScroll,
    railHover,
    railPreview: { ...previewState, stayedOpen: previewStayedOpen, closed: previewClosed },
    composerUi,
    responsiveMatrix: {
      profiles: matrix.length,
      pageChecks: matrixResults.length,
      maxBodyOverflow: Math.max(0, ...matrixResults.map((x) => x.bodyOverflow)),
      maxNavOverflow: Math.max(0, ...matrixResults.map((x) => x.navOverflow)),
    },
    advancedNav: { closedByDefault: advancedClosed, opens: advancedOpened, count: Number(advancedCount) },
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
