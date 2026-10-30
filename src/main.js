import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
// 原生文件对话框 / 文件读写：WebView 里 window.prompt 是空实现，路径类交互一律走这两个
import { open as dlgOpen, save as dlgSave } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
// 两个纯本地工具页（批量文本 / 计算器）——单独成文件，免得 main.js 再长下去
import { initBatch, initCalc } from "./tools-batch-calc.js";
import { initLogic, laAgentState, laAgentRead, laAgentDecoders, laAgentConfig, laAgentCapture, laAgentSave } from "./logic-analyzer.js";
import { HELP_GROUPS as HELP_GROUPS_CONTENT, HELP_TITLE_EN } from "./help-content.js";
import { FLASH_ROM_TOOLS, flashToolUi, isFlashRomTool, isSerialRomTool } from "./flash-rom.js";
import { ADVANCED_TABS, initAdvancedNav, openAdvancedNavFor } from "./nav-advanced.js";
import { createShortcutManager, mountShortcutSettings } from "./shortcuts.js";

const $ = (id) => document.getElementById(id);
window.kdockToast = (text) => toast(text);
window.kdockUiScale = () => uiScaleValue();

/* ── 悬停提示：自绘气泡（接管原生 title）─────────────────────────────────────
   原生 title 的气泡是系统画的：延迟 ~1 秒才出来、样式跟系统走（Windows 上是个
   发白的方框），而且卡片是 overflow:hidden 的，气泡还会被裁掉一半。
   这里统一接管，全项目照旧写 title 就行：
     · MutationObserver 盯着 title 属性 —— 读到就搬进 dataset.tip 并把 title 抹掉
       （抹掉只是为了让系统别再画那个丑框，文本一条不丢）
     · 真气泡是挂在 body 上的浮层（position:fixed），不受任何容器裁剪
     · 悬停 380ms 才出（"停一下才出来"）；移开 / 滚动 / 点击 / 按键立刻收
   翻译：langWalk 认 dataset.tip（见那里的注释）。 */
const TIP_DELAY = 380;
let tipBox = null, tipTimer = null, tipOwner = null;

function tipOf(el) {
  if (!el || el.nodeType !== 1) return "";
  const t = el.dataset.tip != null ? el.dataset.tip : el.getAttribute("title");
  return String(t == null ? "" : t).trim();
}
/** title → data-tip：抹掉给系统看的 title，文本转存到 dataset.tip */
function adoptTip(el) {
  if (!el || el.nodeType !== 1) return;
  const t = el.getAttribute("title");
  if (t === null) return;
  el.dataset.tip = t;
  el.removeAttribute("title");
}
function tipHide() {
  if (tipTimer !== null) { clearTimeout(tipTimer); tipTimer = null; }
  tipOwner = null;
  if (tipBox) { tipBox.classList.remove("on"); tipBox.hidden = true; }
}
function tipShow() {
  const el = tipOwner;
  if (!el) return;
  const text = tipOf(el);
  if (!text || !el.isConnected || !el.getClientRects().length) { tipHide(); return; }
  if (!tipBox) {
    tipBox = document.createElement("div");
    tipBox.className = "kdtip";
    tipBox.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipBox);
  }
  tipBox.textContent = text;
  tipBox.hidden = false;
  // 先摆位再淡入：量尺寸要它已经在文档里（hidden=false），但这时候别让人看见误差一帧
  const r = el.getBoundingClientRect();
  const b = tipBox.getBoundingClientRect();
  const gap = 8;
  let top = r.bottom + gap;
  if (top + b.height > window.innerHeight - 6 && r.top - gap - b.height > 6) top = r.top - gap - b.height;
  let left = r.width < 240 ? r.left + r.width / 2 - b.width / 2 : r.left;
  left = Math.max(6, Math.min(left, window.innerWidth - b.width - 6));
  tipBox.style.top = Math.max(6, Math.round(top)) + "px";
  tipBox.style.left = Math.round(left) + "px";
  tipBox.classList.add("on");
}
function bindTooltips() {
  document.querySelectorAll("[title]").forEach(adoptTip);   // 静态那一批
  // 运行时冒出来的两类都要认，不然它们还挂着系统那个原生 title：
  //   · attributes：JS 直接 el.title = "..."（模型名、状态、路径……）
  //   · childList ：innerHTML 拼出来的片段（里面写了 title="..."）—— 建节点不会触发属性变更
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === "attributes") { adoptTip(r.target); continue; }
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue;
        adoptTip(n);
        n.querySelectorAll("[title]").forEach(adoptTip);
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["title"], childList: true, subtree: true });

  document.addEventListener("pointerover", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-tip],[title]") : null;
    if (el === tipOwner) return;              // 在同一个元素内部挪动：别闪
    tipHide();
    if (!el || !tipOf(el)) return;
    tipOwner = el;
    tipTimer = setTimeout(() => { tipTimer = null; tipShow(); }, TIP_DELAY);
  });
  // 用户已经在干别的了：立刻把气泡收掉
  document.addEventListener("pointerdown", tipHide, true);
  document.addEventListener("keydown", tipHide, true);
  document.addEventListener("wheel", tipHide, true);
  document.addEventListener("scroll", tipHide, true);
  window.addEventListener("blur", tipHide);
}

/**
 * 一次性迁移：早期版本把本地设置存在 `h7test_*` 名下（那时项目还叫别的名字）。
 * 现在统一成 `kdock_*` —— 老用户升级上来时把值搬过去一次，别让人白设一遍主题/配色。
 */
function migrateLocalPrefs() {
  const keys = ["theme", "scheme", "le", "enc", "upg_url", "save_dir", "flash_tools", "inpane_h",
                "seq_graph", "quick", "tray", "reconnect", "lang"];
  try {
    for (const k of keys) {
      const oldV = localStorage.getItem("h7test_" + k);
      if (oldV !== null && localStorage.getItem("kdock_" + k) === null) {
        localStorage.setItem("kdock_" + k, oldV);
      }
    }
  } catch (_) { /* 本地存储不可用就算了 */ }
}

const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [["five", "5"], ["six", "6"], ["seven", "7"], ["eight", "8"]];
const STOP_BITS = [["one", "1"], ["two", "2"]];
const PARITY = [["none", "None"], ["odd", "Odd"], ["even", "Even"]];
const FLOW = [["none", "无"], ["hardware", "硬件 RTS/CTS"], ["software", "软件 XON/XOFF"]];
const LINE_ENDINGS = [["none", "无"], ["cr", "CR"], ["lf", "LF"], ["crlf", "CRLF"]];

// ── 传输模式：只有参数区随模式切换，收发消息框是同一个 ──
let mode = "serial";
let NET_IFACES = [];
let currentBaud = 115200;
let rxPaused = false;
let loopTimer = null;
let history = [];
let rxBuffer = [];
let rxMode = "text";
let tailEntry = null;      // "正在长的半行"（设备还没发换行），渲染在最后一行、就地更新
let rxEntryNo = 0;
let flLogNo = 0;            // 烧录日志的行号
let sqLogNo = 0;            // 编排运行日志的行号

/** 序号开关（默认开）：三处日志（传输 #rx / 烧录 #fl-log / 编排 #sq-log）和文件列表共用一个设置 */
const logNoOn = () => localStorage.getItem("kdock_show_no") !== "0";
/** 一行日志的 DOM 串：左边行号栏（不可选、复制不带）+ 右边正文 */
function logRowHtml(no, inner, cls) {
  return `<div class="rxline"><span class="nox" aria-hidden="true">${no == null ? "" : no}</span>` +
    `<span class="rxtx${cls ? " " + cls : ""}">${inner}</span></div>`;
}
/** 纯文本：从「一行一行」的结构里取正文（复制 / 统计用，不含行号） */
function logPlainText(boxId) {
  const box = $(boxId);
  if (!box) return "";
  const rows = [...box.querySelectorAll(".rxline .rxtx")];
  if (!rows.length) return box.textContent || "";
  return rows.map((r) => r.textContent).join("\n");
}          // 已经来了多少条日志 —— 给「序号」用（一条一个号；单调递增，裁掉老行或切显示模式都不会乱）
// 高数据量时的两条保护（参考 OxideSerial 的做法）：
//   1) 入队后不立刻重绘，攒到下一帧(RAF)一次性重绘 —— 否则每个分片都全量重刷 DOM
//   2) 日志上限，超了丢最老的 —— 之前是无上限，长时间跑会把内存和渲染都拖垮
const MAX_RX = 2000;
const RX_FLUSH_MS = 16;
let rxPending = [];
let rxTimer = null;

function flushRxPending() {
  if (rxTimer !== null) { clearTimeout(rxTimer); rxTimer = null; }
  if (!rxPending.length) return;
  for (const x of rxPending) rxBuffer.push(x);
  rxPending = [];
  if (rxBuffer.length > MAX_RX) rxBuffer = rxBuffer.slice(-MAX_RX);
  redrawRx();
}

function pushEntry(e) {
  if (rxPaused) return;
  if (e.no == null) e.no = ++rxEntryNo;              // 一条一个号（多行的话只在这一条的第一行显示）
  rxPending.push(e);
  if (rxTimer !== null) return;
  // 攒 ~16ms 一帧再重绘；**不能只靠 requestAnimationFrame** ——
  // 窗口被遮挡/最小化时浏览器不给 rAF，日志就再也不刷新了（实测踩过），
  // 所以用 setTimeout 兜底、rAF 抢先（可见时更跟手）。
  rxTimer = setTimeout(flushRxPending, RX_FLUSH_MS);
  requestAnimationFrame(flushRxPending);
}

// 跟随最新：只有"本来就在底部"才自动滚；用户上翻时停下并亮出"↓ 最新"徽章
// （贴底统一在 redrawRx 里做 —— 必须"重画完再滚"：先滚会被重画带回原位，
//   表现出来就是"数据一多滚轮滚不上去"，详见那里的注释）
let stickBottom = true;
function bindScrollFollow() {
  const el = $("rx");
  el.addEventListener("scroll", () => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (atBottom !== stickBottom) {
      stickBottom = atBottom;
      $("rx-jump").hidden = atBottom;
    }
  });
  // 滚轮往上翻：**立刻**停掉"跟随最新"。只等 scroll 事件是不够的 —— 数据还在流的时候，
  // 下一块先重画+贴底，手感就是"滚轮滚不上去，只能拉进度条"（实测反馈）。
  el.addEventListener("wheel", (e) => {
    if (e.deltaY < 0) {
      stickBottom = false;
      $("rx-jump").hidden = false;
    } else if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      stickBottom = true;
      $("rx-jump").hidden = true;
    }
  }, { passive: true });
  $("rx-jump").onclick = () => {
    stickBottom = true;
    $("rx-jump").hidden = true;
    el.scrollTop = el.scrollHeight;
  };
}
// ASCII 交互(终端)模式：直接在输出区敲键盘，收到的字节原样铺开
let asciiMode = false;

function toast(msg) {
  $("toast").textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => ($("toast").textContent = ""), 6000);
}

function fillSelect(el, items, selected) {
  el.innerHTML = "";
  for (const [value, label] of items) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (value === selected) o.selected = true;
    el.appendChild(o);
  }
}

function initControls() {
  // 传输页和升级页各一份波特率，内容一致
  for (const id of ["baud", "upg-baud", "fl-baud", "sq-baud"]) {
    const baudSel = $(id);
    baudSel.innerHTML = "";
    for (const b of BAUDS) {
      const o = document.createElement("option");
      o.value = String(b);
      o.textContent = String(b);
      if (b === currentBaud) o.selected = true;
      baudSel.appendChild(o);
    }
  }
  fillSelect($("data-bits"), DATA_BITS, "eight");
  fillSelect($("stop-bits"), STOP_BITS, "one");
  fillSelect($("parity"), PARITY, "none");
  fillSelect($("flow"), FLOW, "none");
  // 默认 CRLF：默认"无"的话，第一次点发送只会看到设备回显、不执行，像坏了一样
  const le0 = localStorage.getItem("kdock_le") || "crlf";
  fillSelect($("line-ending"), LINE_ENDINGS, le0);
  $("line-ending").onchange = () => localStorage.setItem("kdock_le", $("line-ending").value);
}

function serialConfig() {
  return {
    baud: currentBaud,
    data_bits: $("data-bits").value,
    stop_bits: $("stop-bits").value,
    parity: $("parity").value,
    flow_control: $("flow").value,
  };
}

/** 构造给后端的 Endpoint（mode 决定读哪些字段）。 */
function buildEndpoint() {
  if (mode === "serial") {
    const port = $("ports").value;
    if (!port) throw new Error("先选一个串口");
    return { mode: "serial", port, config: serialConfig() };
  }
  if (mode === "tcp_client") {
    return { mode: "tcp_client", host: $("tcp-client-host").value.trim(), port: num($("tcp-client-port").value),
      local_addr: $("tcp-client-iface") ? $("tcp-client-iface").value || null : null };
  }
  if (mode === "tcp_server") {
    const picked = $("tcp-server-iface") ? $("tcp-server-iface").value : "";
    return { mode: "tcp_server", host: picked || $("tcp-server-host").value.trim(), port: num($("tcp-server-port").value) };
  }
  if (mode === "ssh") {
    const host = $("ssh-host").value.trim();
    if (!host) throw new Error(en("填一下 SSH 主机"));
    return {
      mode: "ssh", host, port: num($("ssh-port").value) || 22,
      user: $("ssh-user").value.trim(), password: $("ssh-pass").value,
      extra: $("ssh-extra") ? $("ssh-extra").value.trim() : "",
    };
  }
  return {
    mode: "udp",
    local_addr: $("udp-iface") ? $("udp-iface").value || null : null,
    local_port: num($("udp-local-port").value),
    remote_host: $("udp-remote-host").value.trim(),
    remote_port: num($("udp-remote-port").value),
  };
}

/** agent 用 port_open 连上主连接后，把界面里的「方式 / 参数」也切到它用的那套
 *  （不然用户看到的参数和实际连接对不上；状态和按钮本来就是轮询 get_stats 的，会自动跟上）。 */
function applyEndpointToUi(ep) {
  try {
    const t = ep.mode;
    if (!["serial", "tcp_client", "tcp_server", "udp", "ssh"].includes(t)) return;
    const sel = $("mode");
    if (sel) sel.value = t;
    switchMode(t);
    const setSel = (id, v) => {
      const s = $(id);
      if (!s) return;
      const o = [...s.options].find((x) => x.value === String(v));
      if (o) s.value = String(v);
    };
    if (t === "serial") {
      setSel("ports", ep.port || "");
      if (ep.config) setSel("baud", ep.config.baud || "");
    } else if (t === "tcp_client") {
      $("tcp-client-host").value = ep.host || "";
      $("tcp-client-port").value = ep.port ?? "";
      if ($("tcp-client-iface")) $("tcp-client-iface").value = ep.local_addr || "";
    } else if (t === "tcp_server") {
      $("tcp-server-host").value = ep.host || "0.0.0.0";
      $("tcp-server-port").value = ep.port ?? "";
      if ($("tcp-server-iface")) $("tcp-server-iface").value = ep.host || "";
    } else if (t === "ssh") {
      $("ssh-host").value = ep.host || "";
      $("ssh-port").value = ep.port ?? 22;
      $("ssh-user").value = ep.user || "";
    } else {
      $("udp-local-port").value = ep.local_port ?? "";
      if ($("udp-iface")) $("udp-iface").value = ep.local_addr || "";
      $("udp-remote-host").value = ep.remote_host || "";
      $("udp-remote-port").value = ep.remote_port ?? "";
    }
  } catch (_) { /* 界面字段对不上就算了，别因为这个报错 */ }
}

function num(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`端口不合法: ${v}`);
  return n;
}

function switchMode(next) {
  mode = next;
  document.querySelectorAll("[data-mode]").forEach((el) => {
    el.hidden = el.dataset.mode !== next;
  });
  // 收发消息框不重置：切换模式后输入内容与显示历史都保留
  refreshStats();
}

function fmtTs(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// 解码：设备打印非 UTF-8(有些固件打的是 GB2312/GBK)时，切到 GBK 就从原始 hex 重新解码，
// 所以切编码对**历史记录**也立即生效（和它的 hex/ascii/gbk 三份都存在是一个思路）。
let encMode = localStorage.getItem("kdock_enc") || "utf-8";
const gbkCache = new Map();
function decodeEntry(e) {
  const raw = String(e.text ?? "");
  if (encMode !== "gbk" || !e.hex) return raw;
  if (gbkCache.has(e.hex)) return gbkCache.get(e.hex);
  let out = raw;
  try {
    const bytes = new Uint8Array((e.hex.match(/[0-9A-Fa-f]{2}/g) || []).map((h) => parseInt(h, 16)));
    out = new TextDecoder("gbk").decode(bytes);
  } catch (_) { /* 不支持就退回原文 */ }
  if (gbkCache.size > 4000) gbkCache.clear();
  gbkCache.set(e.hex, out);
  return out;
}
function bindEncoding() {
  const sel = $("encoding");
  sel.value = encMode;
  sel.onchange = () => {
    encMode = sel.value;
    localStorage.setItem("kdock_enc", encMode);
    gbkCache.clear();
    redrawRx();
    pushSys(`显示编码已切到 ${encMode.toUpperCase()}`);
  };
}

// ANSI 颜色（elog 的打印颜色控制）：`\033[31;22m...\033[0m`，还有 1m 加粗 / 4m 下划线，
// 级别色：ERROR 红 / WARN 黄 / INFO 青 / DEBUG 绿 / ASSERT 品红。
// 带色的话按 span 渲染；其它 CSI（清屏/移动光标）直接丢掉，别让它们跑到屏幕上。
const ANSI_FG = {
  30: "#5b6472", 31: "#ff6b6b", 32: "#3ddc97", 33: "#ffc857", 34: "#6ec6ff",
  35: "#b388ff", 36: "#4dd0e1", 37: "#dfe6ee",
  90: "#8b98a8", 91: "#ff9f9f", 92: "#8ef0c0", 93: "#ffdd8f",
  94: "#a5d8ff", 95: "#d0b8ff", 96: "#9ae8f0", 97: "#ffffff",
};
const ANSI_BG = {
  40: "#000000", 41: "#5c1f1f", 42: "#1f4d33", 43: "#5c4a1f",
  44: "#1f3357", 45: "#3f2050", 46: "#12494f", 47: "#3a4150",
};

function ansiToHtml(text) {
  const s = String(text);
  const re = /\u001b\[([0-9;]*)m/g;
  let out = "", last = 0, m, style = null;
  const close = () => { if (style) { out += "</span>"; style = null; } };
  const open = (st) => {
    close();
    if (!st) return;
    const parts = [];
    if (st.fg) parts.push(`color:${st.fg}`);
    if (st.bg) parts.push(`background:${st.bg};border-radius:3px;padding:0 3px`);
    if (st.bold) parts.push("font-weight:700");
    if (st.under) parts.push("text-decoration:underline");
    if (!parts.length) return;
    out += `<span style="${parts.join(";")}">`;
    style = st;
  };
  while ((m = re.exec(s))) {
    out += escapeHtml(s.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1].split(";").filter((x) => x !== "").map(Number);
    if (!codes.length || codes.includes(0)) { open(null); continue; }
    const st = style ? { ...style } : {};
    for (const c of codes) {
      if (c === 1) st.bold = true;
      else if (c === 22) st.bold = false;
      else if (c === 4) st.under = true;
      else if (c === 24) st.under = false;
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (ANSI_FG[c]) st.fg = ANSI_FG[c];
      else if (ANSI_BG[c]) st.bg = ANSI_BG[c];
    }
    open(st.fg || st.bg || st.bold || st.under ? st : null);
  }
  out += escapeHtml(s.slice(last));
  close();
  /* 剩下的非 SGR 转义一律抹掉 —— SSH 进去之后这些东西每行都在：
     · OSC（ESC ] 0;标题 BEL）：xterm 拿它设窗口标题，纯文本流里就是垃圾
     · 带中间字节的 CSI（ESC [ ?2004h 括号粘贴、ESC [ 2J 清屏…）
     · 两字节转义（ESC ( B 之类）
     不只是"难看"：不抹掉的话每行提示符后面都拖一串 ESC[…h/[…l，日志没法看也没法复制。 */
  return out
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?><!]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/** 一条记录里可能含好几行（设备一次吐一批），按行拆开显示，时间戳沿用这条记录的时间 */
function entryLines(e) {
  if (rxMode === "hex") {
    const hex = (e.hex || "").padEnd(48);
    return [escapeHtml(`${hex} |${e.ascii || ""}|`)];
  }
  const t = decodeEntry(e).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = t.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();  // 结尾换行不留空行
  return parts.map(ansiToHtml);
}

/* ── ASCII(终端)模式：极简终端模型 ─────────────────────────────
 * 直接把字节铺出来是不行的：cshell 退格/重绘发的是 ANSI（\r、\b、ESC[D、ESC[K），
 * 铺出来会看到"删掉的字还在"。所以这里维护一个极简屏幕模型，只支持
 * \r \n \b \t、ESC[D/C/A/B/H/J/K，够 cshell 用，也不需要引入 xterm.js。
 */
function termNew() { return { lines: [""], row: 0, col: 0 }; }

function termPut(st, ch) {
  const line = st.lines[st.row] ?? "";
  if (ch === "\n") { st.row += 1; st.col = 0; if (st.lines.length <= st.row) st.lines.push(""); return; }
  if (ch === "\r") { st.col = 0; return; }
  if (ch === "\b") { if (st.col > 0) st.col -= 1; return; }
  if (ch === "\t") { const n = 4 - (st.col % 4); for (let i = 0; i < n; i++) termPut(st, " "); return; }
  if (ch < " ") return;                                  // 其它控制字符直接丢
  st.lines[st.row] = st.col < line.length
    ? line.slice(0, st.col) + ch + line.slice(st.col + 1)
    : line + " ".repeat(st.col - line.length) + ch;
  st.col += 1;
}

function termFeed(st, text) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\u001b") {
      const rest = text.slice(i);
      // OSC（ESC ] … BEL / ESC \）：整段吞掉。SSH 的提示符每行都带一条（设窗口标题）
      const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/.exec(rest);
      if (osc) { i += osc[0].length; continue; }
      // CSI：参数里可能有 ? > ! 这类中间字节（如 ESC[?2004h 括号粘贴），都要整条吞掉，
      // 不能只丢 ESC 再把 "?2004h" 当正文铺出来
      const m = /^\u001b\[([0-9;?><!]*)[ -/]*([@-~])/.exec(rest);
      if (!m) { i += 1; continue; }                      // 裸 ESC：丢掉
      const n = m[1] === "" ? 1 : (parseInt(m[1], 10) || 1);
      const priv = /[?><!]/.test(m[1]);                  // 私有模式：只当"要忽略"，别照着光标动
      if (!priv && m[2] === "D") st.col = Math.max(0, st.col - n);
      else if (!priv && m[2] === "C") st.col += n;
      else if (!priv && m[2] === "A") st.row = Math.max(0, st.row - n);
      else if (!priv && m[2] === "B") { st.row += n; while (st.lines.length <= st.row) st.lines.push(""); }
      else if (!priv && m[2] === "K") st.lines[st.row] = (st.lines[st.row] ?? "").slice(0, st.col);
      else if (!priv && m[2] === "J") { st.lines = [""]; st.row = 0; st.col = 0; }
      else if (!priv && m[2] === "H") { st.row = 0; st.col = 0; }
      i += m[0].length;
      continue;
    }
    termPut(st, ch);
    i += 1;
  }
}

/* 本地回显 / 设备回显会**互相打架**：设备有时候先回显、有时候后回显(慢的时候好几秒)。
 *  所以两边都做"去重"：谁先到就先显示，后来那一个只在时间窗内被当成重复吃掉。
 *  按字符 + 时间戳配对，重复字符(比如连打两个 l)也不会被误吃。 */
const ECHO_WIN_MS = 3000;

/** 设备回显过滤：把我们自己已经显示过的那些字符吃掉；剩下的是真·设备输出 */
function filterDevEcho(text, ts, mine, devSeen) {
  prune(devSeen, ts);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\u001b") {                     // 转义序列原样留着
      const m = /^\u001b\[[0-9;]*[A-Za-z]/.exec(text.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; }
      continue;
    }
    const k = mine.findIndex((x) => x.ch === ch && ts - x.ts < ECHO_WIN_MS);
    if (k >= 0) { mine.splice(k, 1); continue; }   // 本地已经显示过了，别重复
    out += ch;
    devSeen.push({ ch, ts: ts + i });              // 记下来：万一 TX 那边还没记
  }
  return out;
}

/** 本地回显过滤：设备那边已经把同样的字符回显出来了，就别再显示一遍 */
function filterLocalEcho(text, ts, devSeen) {
  prune(devSeen, ts);
  let out = "";
  for (const ch of text) {
    const k = devSeen.findIndex((x) => x.ch === ch && ts - x.ts < ECHO_WIN_MS);
    if (k >= 0) { devSeen.splice(k, 1); continue; }
    out += ch;
  }
  return out;
}

function prune(q, ts) {
  while (q.length && ts - q[0].ts > ECHO_WIN_MS) q.shift();
}

/** 把整段日志重放成一块终端屏（RX 原样，SYS 补一个换行） */
function termRender() {
  const st = termNew();
  const mine = [];          // 本地回显里"设备还没回显"的字符
  const devSeen = [];       // 设备回显里"可能是我们自己敲的"字符
  for (const e of rxBuffer) {
    const t = e.dir === "RX" || e.dir === "TX" ? decodeEntry(e) : String(e.text);
    const ts = e.ts_ms || 0;
    if (e.dir === "TX") {
      const kept = filterLocalEcho(t, ts, devSeen);
      termFeed(st, kept);
      for (const ch of kept) mine.push({ ch, ts });
      continue;
    }
    if (e.dir === "RX") {
      termFeed(st, filterDevEcho(t, ts, mine, devSeen));
      continue;
    }
    termFeed(st, t);
    if (!t.endsWith("\n")) termFeed(st, "\r\n");
  }
  if (tailEntry) termFeed(st, decodeEntry(tailEntry));   // 半行接在最后，就地长出来
  return st.lines.slice(-1000).join("\n");              // 只渲染最后 1000 行
}

/** 一行日志的 HTML：左边一格是行号栏（不可选），右边是正文 —— 折行只缩进正文那一列 */
function lineRows(e) {
  const cls = e.dir === "TX" ? "tx" : e.dir === "SYS" ? "sys" : "rx-l";
  const tsOn = $("show-ts") && $("show-ts").checked;
  const dirOn = $("show-dir") && $("show-dir").checked;
  const dir = `<span class="${cls}">${e.dir}</span>`;
  // 方向标记跟时间戳绑在一起（一个方括号前缀，SSCOM 那样）；只有方向没时间戳时才单独占一个词
  let pfx = "";
  if (tsOn && dirOn) pfx = `<span class="ts">[${fmtTs(e.ts_ms)} ${dir}]</span> `;
  else if (tsOn) pfx = `<span class="ts">[${fmtTs(e.ts_ms)}]</span> `;
  else if (dirOn) pfx = dir + " ";
  const no = e.no != null ? e.no : rxEntryNo + 1;   // 半行（还没成整行）先按下一条的号显示
  return entryLines(e).map((l, i) => logRowHtml(i === 0 ? no : null, pfx + l)).join("");
}

/** 序号开关统一走这里：存本机、两个页面的勾选框同步、所有日志容器的列跟着显隐、文件列表重画 */
function logNoSet(on, silent) {
  localStorage.setItem("kdock_show_no", on ? "1" : "0");
  for (const id of ["show-no", "fl-no"]) { const c = $(id); if (c) c.checked = on; }
  for (const el of document.querySelectorAll(".lognum")) el.classList.toggle("with-no", on);
  if ($("rx")) redrawRx();
  if (!silent && $("fl-items")) flList();
}

function redrawRx() {
  const box = $("rx");
  // 重画会重建整段内容：先记住用户现在看的位置，画完再放回去（跟随最新时才跳到底部）
  const keepTop = box.scrollTop;
  const wasBottom = stickBottom || keepTop + box.clientHeight >= box.scrollHeight - 8;
  const tail = tailEntry ? lineRows(tailEntry) : "";
  box.classList.toggle("with-no", logNoOn());            // 只管左边那一列显不显示
  if (asciiMode) box.textContent = termRender();          // 终端就是纯文本，不走 HTML
  else box.innerHTML = rxBuffer.map(lineRows).join("") + tail;
  if (wasBottom && $("autoscroll").checked) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = keepTop;                              // 用户在上翻：原地不动，别跟人抢
  }
}

function pushSys(text) {
  // 设备/升级日志经常一次给好几行（还夹着空行）：拆成"一行一条"，
  // 否则输出框里会出现字面量 "\n" 和空行。
  if (rxPaused) return;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    pushEntry({ dir: "SYS", ts_ms: Date.now(), text: line, hex: "", ascii: "" });
  }
}

function applyPorts(ports) {
  {
    const preferred = ports.find((p) =>
      /Infineon DAS JDS|J-?Link/i.test(`${p.friendly || ""} ${p.description || ""}`));
    const opts = ports.length
      ? ports.map((p) => {
          const desc = p.friendly || p.description || "";
          return { value: p.port_name, label: desc ? `${p.port_name} — ${desc}` : p.port_name };
        })
      : [{ value: "", label: en("（没有检测到串口）") }];
    // 两个页面各有一份串口列表，内容保持一致
    for (const id of ["ports", "upg-ports", "fl-ports", "fl-rom-port", "sq-ports"]) {
      const sel = $(id);
      if (!sel) continue;
      const prev = sel.value;
      sel.innerHTML = "";
      for (const o of opts) {
        const n = document.createElement("option");
        n.value = o.value;
        n.textContent = o.label;
        if (o.value === prev) n.selected = true;
        sel.appendChild(n);
      }
      // 第一次进来优先选开发板的 DAS JDS 串口，否则选第一个。
      if (opts.length && !sel.value) {
        const pick = preferred && Array.from(sel.options).some((o) => o.value === preferred.port_name)
          ? preferred.port_name
          : opts[0].value;
        if (pick) sel.value = pick;
      }
    }
  }
}

async function refreshPorts() {
  try {
    applyPorts(await invoke("list_ports"));
  } catch (e) {
    toast(String(e));
  }
}

/** 多网卡选择：所有 .net-iface 下拉共用同一份实际 IPv4 列表。 */
let netIfacesAt = 0;
async function refreshNetIfaces(force) {
  if (!force && Date.now() - netIfacesAt < 10000) return;   // 切页时顺手刷新，10 秒内不重复跑
  netIfacesAt = Date.now();
  try {
    NET_IFACES = (await invoke("net_interfaces")) || [];
  } catch (_) {
    NET_IFACES = [];
  }
  const list = NET_IFACES.slice().sort((a, b) =>
    String(a.InterfaceAlias || "").localeCompare(String(b.InterfaceAlias || ""))
    || String(a.IPAddress || "").localeCompare(String(b.IPAddress || "")));
  document.querySelectorAll("select.net-iface").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = en("自动 / 全部网卡");
    sel.appendChild(auto);
    for (const it of list) {
      const ip = String(it.IPAddress || "");
      if (!ip) continue;
      const o = document.createElement("option");
      o.value = ip;
      o.textContent = `${it.InterfaceAlias || "网卡"} — ${ip}`;
      sel.appendChild(o);
    }
    if (Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
  });
}

/** 顶栏那个连接状态：文字 / 颜色 / 悬停提示一起更新。
 *  窄窗口（≤720px）它只剩一个点，全靠在 title 上挂全文。 */
function chipSet(text, ok) {
  const c = $("status-chip");
  if (!c) return;
  c.textContent = text;
  c.className = "chip" + (ok ? " ok" : "");
  c.title = text;
}

/* ── 公网 IP 归属地：后端只回国家/地区，顶栏绝不显示或保存公网 IP ── */
let agNetip = null;
// 国家/地区名不进后端持久化：只保存 country code，按当前界面语言现场生成。
// 这样切语言时不会残留上一次语言的国家名，也不会把中文写死进 netip.json。
const NETIP_REGION_ZH = {
  CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾",
  US: "美国", JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚", TH: "泰国",
  VN: "越南", PH: "菲律宾", ID: "印度尼西亚", IN: "印度", AU: "澳大利亚", NZ: "新西兰",
  GB: "英国", IE: "爱尔兰", DE: "德国", FR: "法国", NL: "荷兰", BE: "比利时", CH: "瑞士",
  AT: "奥地利", SE: "瑞典", NO: "挪威", DK: "丹麦", FI: "芬兰", PL: "波兰", CZ: "捷克",
  ES: "西班牙", PT: "葡萄牙", IT: "意大利", GR: "希腊", TR: "土耳其", RU: "俄罗斯", UA: "乌克兰",
  CA: "加拿大", MX: "墨西哥", BR: "巴西", AR: "阿根廷", CL: "智利", ZA: "南非", AE: "阿联酋",
  SA: "沙特阿拉伯", IL: "以色列", EG: "埃及", NG: "尼日利亚", PK: "巴基斯坦", BD: "孟加拉国",
  LK: "斯里兰卡", NP: "尼泊尔", KH: "柬埔寨", LA: "老挝", MM: "缅甸", MN: "蒙古",
  KZ: "哈萨克斯坦", IR: "伊朗", IQ: "伊拉克", QA: "卡塔尔", KW: "科威特", BH: "巴林",
  OM: "阿曼", JO: "约旦", LB: "黎巴嫩", HU: "匈牙利", RO: "罗马尼亚", BG: "保加利亚",
  HR: "克罗地亚", RS: "塞尔维亚", SK: "斯洛伐克", SI: "斯洛文尼亚",
};
function netipCountryLabel(code) {
  const cc = String(code || "").trim().toUpperCase();
  if (!cc) return en("未知");
  if (LANG === "zh") return NETIP_REGION_ZH[cc] || cc;
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(cc) || cc;
  } catch (_) {
    return cc;
  }
}
function netipPaint(st) {
  if (st) agNetip = st;
  const b = agNetip || {};
  const label = netipCountryLabel(b.country);
  const chip = $("ip-location-chip");
  if (chip) {
    chip.textContent = `${en("当前：")}${label}`;
    chip.title = b.updatedAt
      ? `${en("公网 IP 归属地")} · ${label}${b.city ? " · " + b.city : ""}`
      : en("公网 IP 归属地");
    chip.classList.toggle("blocked", !!b.blocked);
  }
  const summary = $("netip-summary");
  if (summary) {
    summary.innerHTML =
      `<div class="row"><span class="k">${en("归属地")}</span><span class="v">${label}</span></div>` +
      `<div class="row"><span class="k">${en("城市 / 地区")}</span><span class="v">${[b.city, b.region].filter(Boolean).join(" / ") || "—"}</span></div>` +
      `<div class="row"><span class="k">${en("网络组织")}</span><span class="v wrap">${b.org || "—"}</span></div>` +
      `<div class="row"><span class="k">${en("最后更新")}</span><span class="v">${b.updatedAt ? new Date(b.updatedAt).toLocaleString(LANG === "zh" ? "zh-CN" : "en-US") : "—"}</span></div>`;
  }
  const budget = $("netip-budget");
  if (budget) {
    const used = Number(b.todayRequests || 0), max = Number(b.dailyLimit || 100);
    const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
    budget.innerHTML =
      `<div class="row"><span class="k">${en("今日已请求")}</span><span class="v">${used} / ${max}</span></div>` +
      `<div class="row"><span class="k">${en("剩余")}</span><span class="v">${Math.max(0, max - used)}</span></div>` +
      `<div class="row"><span class="k">${en("统计日期")}</span><span class="v">${b.day || "—"}</span></div>` +
      `<div class="agctx-bar"><i style="width:${pct}%;background:hsl(var(--primary));display:block;height:100%"></i></div>` +
      (b.blocked ? `<div class="sub" style="color:hsl(var(--destructive))">${en("今日额度已用完，明天自动恢复。")}</div>` : "");
  }
  const stateEl = $("netip-state");
  if (stateEl) {
    if (b.refreshing) stateEl.textContent = en("后台更新中…");
    else if (b.nextRetryAt && Number(b.nextRetryAt) > Date.now()) {
      const sec = Math.max(1, Math.ceil((Number(b.nextRetryAt) - Date.now()) / 1000));
      stateEl.textContent = `${en("等待重试")} · ${sec}s`;
    } else if (b.lastError) stateEl.textContent = b.lastError;
    else if (b.updatedAt) stateEl.textContent = en("已刷新");
  }
  if ($("netip-retry") && b.retryCount != null) $("netip-retry").value = String(b.retryCount);
  if ($("netip-debounce") && b.debounceMs != null) $("netip-debounce").value = String(b.debounceMs);
}
async function netipLoad() {
  try { netipPaint(await invoke("netip_status")); } catch (_) { netipPaint(null); }
}
async function netipSave() {
  const retry = Math.max(0, Math.min(10, Number(($("netip-retry") || {}).value || 0)));
  const debounce = Math.max(200, Math.min(60000, Number(($("netip-debounce") || {}).value || 2500)));
  try {
    netipPaint(await invoke("netip_settings", { retryCount: retry, debounceMs: debounce }));
    toast(en("网络与代理设置已保存"));
  } catch (e) { toast(String(e)); }
}
async function netipRefresh() {
  const state = $("netip-state");
  if (state) state.textContent = en("正在查询…");
  try {
    netipPaint(await invoke("netip_refresh"));
    if (state) state.textContent = en("已刷新");
  } catch (e) {
    if (state) state.textContent = String(e);
    toast(String(e));
  }
}
function bindNetip() {
  netipLoad();
  if ($("netip-save")) $("netip-save").onclick = netipSave;
  if ($("netip-refresh")) $("netip-refresh").onclick = netipRefresh;
}
async function bindNetipEvents() {
  await listen("netip://changed", (ev) => netipPaint(ev.payload || null));
}
async function refreshStats() {
  try {
    const s = await invoke("get_stats");
    const state = en(s.connected ? "已连接" : s.listening ? "监听中" : "未连接");
    const chip = s.connected ? (s.label || en("已连接")) : state;
    chipSet(chip, s.connected);
    $("status").textContent = s.connected ? `${state} · ${s.label || ""}` : state;
    /* 只看收/发字符数(和字节数)，不要时长/速率 */
    $("stats").textContent =
      `${en("接收")} ${s.rx_chars ?? 0} ${en("字符")} / ${s.rx_bytes} B\n` +
      `${en("发送")} ${s.tx_chars ?? 0} ${en("字符")} / ${s.tx_bytes} B\n` +
      `${en("日志")} ${s.log_lines}${en(" 行")}`;
    // 升级页也看一眼"升级会挂在哪条连接上"
    $("upg-link").textContent = s.connected
      ? `${s.label || ""}`
      : s.listening ? en("监听中（等对端接入）") : en("未连接");
    $("upg-link").className = "dot" + (s.connected ? " ok" : "");
    $("fl-link").textContent = s.connected
      ? `${s.label || ""}`
      : s.listening ? en("监听中（等对端接入）") : en("未连接");
    $("fl-link").className = "dot" + (s.connected ? " ok" : "");
    // 「连接」按钮跟着**真实状态**走：连上（不管谁连的：用户点的还是 agent 的 port_open）就变成
    // 「已连接」并点不动，断开之后才回到「连接」。
    const openBtn = $("open");
    if (openBtn) {
      const busy = !!(s.connected || s.listening);
      const label = s.connected ? "已连接" : s.listening ? "监听中" : "连接";
      if (openBtn.textContent !== en(label)) openBtn.textContent = en(label);
      openBtn.className = busy ? "btn connected" : "btn primary";
      openBtn.disabled = busy;
      openBtn.title = busy ? en("已连上，要换连接先点「断开」") : "";
    }
    const closeBtn = $("close");
    if (closeBtn) closeBtn.disabled = !(s.connected || s.listening);
  } catch (_) {
    /* 还没连接时拿不到，忽略 */
  }
}

async function doOpen() {
  try {
    const endpoint = buildEndpoint();
    const msg = await invoke("open_transport", { endpoint });
    toast(msg);
    pushSys(msg);
  } catch (e) {
    toast(String(e));
  }
}

async function doClose() {
  try {
    const msg = await invoke("close_transport");
    toast(msg);
    pushSys(msg);
  } catch (e) {
    toast(String(e));
  }
}

/** 发送与输出共用同一个“显示”模式：不再维护第二套 文本/HEX 开关。 */
function txMode() {
  return rxMode === "hex" ? "hex" : "text";
}
async function doSend() {
  const payload = $("tx").value;
  const txm = txMode();
  const le = $("line-ending").value;
  if (!payload.trim()) return toast(en("没有可发送的内容"));
  try {
    // 后端返回真正写到线上的字节，TX 行直接用它渲染
    const ack = await invoke("write_data", { payload, mode: txm, lineEnding: le });
    if (!rxPaused) {
      pushEntry({ dir: "TX", ts_ms: Date.now(), text: ack.text, hex: ack.hex, ascii: ack.ascii });
    }

    if (payload && history[0] !== payload) {
      history.unshift(payload);
      history = history.slice(0, 30);
      const sel = $("history");
      sel.innerHTML = '<option value="">历史记录…</option>';
      history.forEach((h, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = h.length > 60 ? h.slice(0, 60) + "…" : h;
        sel.appendChild(o);
      });
    }
    toast(`${en("已发送")} ${ack.bytes} B`);
  } catch (e) {
    toast(String(e));
  }
}

function toggleLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if ($("loop").checked) {
    const ms = Math.max(10, Number($("loop-ms").value) || 1000);
    loopTimer = setInterval(doSend, ms);
  }
}

async function reloadFromBackend() {
  const lines = await invoke("get_log");
  rxEntryNo = 0;
  rxBuffer = lines.map((l) => {
    const bytes = (l.data.match(/[0-9A-Fa-f]{2}/g) || []).map((h) => parseInt(h, 16));
    const e = {
      dir: l.dir,
      ts_ms: l.ts_ms,
      text: new TextDecoder().decode(new Uint8Array(bytes)),
      hex: bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
      ascii: bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join(""),
    };
    e.no = ++rxEntryNo;
    return e;
  });
  redrawRx();
}

async function doReplay() {
  const speed = Number($("speed").value) || 1;
  const gaps = await invoke("replay_plan", { speed });
  const snapshot = rxBuffer.slice();
  let i = 0;
  $("rx").innerHTML = "";
  const step = () => {
    if (i >= snapshot.length) {
      toast("回放结束");
      return;
    }
    $("rx").innerHTML += lineRows(snapshot[i]);
    if ($("autoscroll").checked) $("rx").scrollTop = $("rx").scrollHeight;
    const delay = gaps[i] ?? 0;
    i += 1;
    setTimeout(step, delay);
  };
  toast(`回放 ${snapshot.length} 行，速度 x${speed}`);
  step();
}


// ---------------- 升级页：本页自己连 + 选版本 + 升级 ----------------
// 过程信息全部走右边输出窗口(upgrade://log -> SYS 行)，界面只占几行。
let upgSource = "local";
let upgLocal = null;   // { name, bytes, info }
let upgItems = [];     // 读到的候选包（喂给版本下拉框）
let upgRunning = false;

function upgState(text, cls) {
  const el = $("upg-state");
  el.textContent = en(text);
  el.className = "dot" + (cls ? " " + cls : "");
}

function hex8(v) {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

// ── 每页各自的连接块(升级页 / 文件页)：各有各的"方式 + 参数 + 连接/断开"，
//    但设备只有一条连接，所以最终都写回【传输】页那套控件上，只是三个入口 ──
function switchPaneMode(pfx, m) {
  $(`${pfx}-mode`).value = m;
  // data-<pfx>m 可以写多个值（空格隔开）：像"FTP / FTPS / TFTP 这一组字段"就共用一整块
  document.querySelectorAll(`[data-${pfx}m]`).forEach((el) => {
    el.hidden = !String(el.dataset[`${pfx}m`] || "").split(/\s+/).includes(m);
  });
}
/** 传输页 -> 这个页：切到该标签时同步一次，让用户看到当前连接参数 */
function syncPaneCtl(pfx) {
  const cur = $("mode").value;
  const m = ["serial", "tcp_client", "tcp_server", "udp"].includes(cur) ? cur : "serial";
  switchPaneMode(pfx, m);
  if (m === "serial") {
    if ($("ports").value) $(`${pfx}-ports`).value = $("ports").value;
    $(`${pfx}-baud`).value = $("baud").value;
  } else if (m === "tcp_client") {
    $(`${pfx}-host`).value = $("tcp-client-host").value;
    $(`${pfx}-port`).value = $("tcp-client-port").value;
    if ($(`${pfx}-iface`) && $("tcp-client-iface")) $(`${pfx}-iface`).value = $("tcp-client-iface").value;
  } else if (m === "udp") {
    $(`${pfx}-host`).value = $("udp-remote-host").value;
    $(`${pfx}-port`).value = $("udp-remote-port").value;
    if ($(`${pfx}-iface`) && $("udp-iface")) $(`${pfx}-iface`).value = $("udp-iface").value;
  }
}
function wirePaneLink(pfx) {
  $(`${pfx}-mode`).onchange = () => switchPaneMode(pfx, $(`${pfx}-mode`).value);
  if ($(`${pfx}-refresh`)) $(`${pfx}-refresh`).onclick = refreshPorts;
  $(`${pfx}-open`).onclick = async () => {
    const m = $(`${pfx}-mode`).value;
    $("mode").value = m;
    switchMode(m);
    if (m === "serial") {
      if ($(`${pfx}-ports`).value) $("ports").value = $(`${pfx}-ports`).value;
      if ($(`${pfx}-baud`).value) { $("baud").value = $(`${pfx}-baud`).value; currentBaud = Number($(`${pfx}-baud`).value); }
    } else if (m === "udp") {
      $("udp-local-port").value = "0";
      $("udp-remote-host").value = $(`${pfx}-host`).value.trim();
      $("udp-remote-port").value = $(`${pfx}-port`).value;
      if ($(`${pfx}-iface`) && $("udp-iface")) $("udp-iface").value = $(`${pfx}-iface`).value;
    } else {
      $("tcp-client-host").value = $(`${pfx}-host`).value.trim();
      $("tcp-client-port").value = $(`${pfx}-port`).value;
      if ($(`${pfx}-iface`) && $("tcp-client-iface")) $("tcp-client-iface").value = $(`${pfx}-iface`).value;
    }
    await doOpen();
  };
  $(`${pfx}-close`).onclick = doClose;
}
wirePaneLink("upg");
function syncUpgProtocol() {
  const el = $("upg-protocol-note");
  if (!el) return;
  const mode = $("upg-mode").value;
  el.textContent = en(mode === "serial"
    ? "串口：KDock 自有 cshell + YMODEM，只接受 .fw；不是 STM32/ESP 出厂 ROM 下载器。"
    : mode === "udp"
      ? "UDP：KDock 自有 SVC1 服务通道，按偏移写入 .fw；不是厂商 ROM Bootloader。"
      : "TCP：KDock 自有 SVC1 服务通道，按偏移写入 .fw；不是厂商 ROM Bootloader。");
}
$("upg-mode").addEventListener("change", syncUpgProtocol);
function syncUpgCtl() { syncPaneCtl("upg"); syncUpgProtocol(); }

// ── 版本下拉框 / 读版本 ──
function fillVersions(items) {
  upgItems = items || [];
  const sel = $("upg-version");
  sel.innerHTML = "";
  if (!upgItems.length) {
    sel.innerHTML = '<option value="">（还没有读版本）</option>';
    return;
  }
  upgItems.forEach((it) => {
    const o = document.createElement("option");
    o.value = it.url || "";
    o.textContent = `v${it.version}   ${it.name}${it.size ? `   ${it.size} B` : ""}`;
    sel.appendChild(o);
  });
  sel.selectedIndex = 0;
}

/** 版本内容也打到右边输出框 */
function printItems(src, items) {
  pushSys(`[升级] 读版本: ${src}`);
  if (!items.length) { pushSys("[升级]   没有可用固件"); return; }
  pushSys(`[升级]   共 ${items.length} 个（新的在上）:`);
  items.forEach((it) => {
    let s = `[升级]     v${it.version}   ${it.name}`;
    if (it.size) s += `   ${it.size} B`;
    if (it.crc32 != null) s += `   crc32=${hex8(it.crc32)}`;
    if (it.payload_crc32 != null) s += `   payload=${hex8(it.payload_crc32)}`;
    if (it.board) s += `   board=${it.board}`;
    pushSys(s);
  });
}

async function readVersions() {
  if (upgSource === "local") {
    if (!upgLocal) { toast("先选一个 .fw 文件"); return; }
    const it = {
      version: upgLocal.info.version, name: upgLocal.name, url: "", size: upgLocal.bytes.length,
      crc32: upgLocal.info.file_crc32, payload_crc32: upgLocal.info.payload_crc32, board: upgLocal.info.board,
    };
    fillVersions([it]);
    printItems(`本地文件 ${upgLocal.name}`, [it]);
    upgState(`${upgLocal.name}   v${it.version}`, "ok");
    return;
  }
  const url = $("upg-url").value.trim();
  if (!url) { toast("先填服务器地址"); return; }
  upgState("读取服务器 ...");
  try {
    const items = await invoke("server_fw_list", { url });
    fillVersions(items);
    printItems(url, items);
    upgState(`读到 ${items.length} 个版本`);
  } catch (e) {
    fillVersions([]);
    upgState("读版本失败: " + e, "err");
    pushSys(`[升级] 读版本失败: ${e}`);
  }
}
$("upg-read").onclick = readVersions;

// ── 来源：本地文件 / 服务器 ──
function switchUpgSource(v) {
  upgSource = v;
  $("upg-local-row").hidden = v !== "local";
  $("upg-url-row").hidden = v !== "server";
  upgLocal = null;
  fillVersions([]);
  if (v === "local") {
    upgState("未选择固件");
  } else if ($("upg-url").value.trim()) {
    readVersions();                 // 地址已经填好了就直接读，不用再点一下
  } else {
    upgState("填服务器地址后点【读版本】");
  }
}
$("upg-source").onchange = (e) => switchUpgSource(e.target.value);
$("upg-pick").onclick = async () => {
  try {
    const p = await dlgOpen({ title: "选择固件包", multiple: false, directory: false,
                              filters: [{ name: "固件包", extensions: ["fw"] }] });
    if (!p) return;
    const path0 = typeof p === "string" ? p : p.path;
    const name = path0.replace(/^.*[\\/]/, "");
    const buf = await readFile(path0);
    const bytes = Array.from(buf);
    const info = await invoke("fw_info_local", { name, data: bytes });
    upgLocal = { name, bytes, info };
    fillVersions([{
      version: info.version, name, url: "", size: bytes.length,
      crc32: info.file_crc32, payload_crc32: info.payload_crc32, board: info.board,
    }]);
    printItems(`本地文件 ${name}`, upgItems);
    upgState(`${name}   v${info.version}`, "ok");
  } catch (err) {
    upgLocal = null;
    fillVersions([]);
    upgState("这个文件不能用: " + err, "err");
  }
};

// 固件服务器地址直接填：给「目录」「manifest.json」或「单个 .fw 的 URL」都行
// （后端会自动补 /manifest.json，见 normalize_server_url / fetch_server_items）。
// 填过一次就记住，下次进来还在。
$("upg-url").value = (localStorage.getItem("kdock_upg_url") || "").replace(/\/manifest\.json$/i, "");
$("upg-url").onchange = () => {
  localStorage.setItem("kdock_upg_url", $("upg-url").value.trim());
  readVersions();
};
$("upg-url").onkeydown = (e) => { if (e.key === "Enter") readVersions(); };

// ── 升级 ──
$("upg-go").onclick = async () => {
  if (upgRunning) return;
  if (upgSource === "local") {
    if (!upgLocal) { toast("先选一个 .fw 固件"); return; }
  } else if (!$("upg-version").value) {
    toast("先点【读版本】选一个版本");
    return;
  }
  try {
    await invoke("start_upgrade", {
      source: upgSource,
      url: upgSource === "server" ? $("upg-version").value : "",
      name: upgLocal ? upgLocal.name : "",
      data: upgLocal ? upgLocal.bytes : [],
    });
    upgState("准备升级 ...");
  } catch (e) {
    upgState("启动失败: " + e, "err");
  }
};

async function refreshUpgState() {
  try {
    const st = await invoke("upgrade_state");
    upgRunning = st.running;
    $("upg-go").disabled = st.running;
    $("upg-go").textContent = st.running ? `${en("升级中")} ${Math.round(st.percent || 0)}%` : en("升级");
    // 升级状态只写升级页；左下角那行只显示"连接状态"，两边不再抢
    if (st.running) upgState(st.text || "");
    else if (st.text) upgState(st.text, st.text.includes("失败") ? "err" : st.percent >= 100 ? "ok" : "");
  } catch (e) { /* ignore */ }
}


// ---------------- 文件页：列设备目录 / 把文件拉回本机 ----------------
// 网口走服务通道(LIST/OPEN/READ/CLOSE)，串口走 cshell 的 ls / get -t base64
let flEntries = [];
let flDirOf = "";
let flSeq = 0;      // 列目录可能并发(切页自动列 + 手动点)，只认最后一次

function flState(text, cls) {
  const el = $("fl-state");
  el.textContent = en(text);
  el.className = "dot" + (cls ? " " + cls : "");
}

/** 拼一个本机路径：带盘符/反斜杠的就用反斜杠，其余用正斜杠 */
function joinFile(dir, name) {
  const dd = String(dir || "").replace(/[\\/]+$/, "");
  if (!dd) return name;
  const sep = /^[A-Za-z]:|\\/.test(dd) ? "\\" : "/";
  return `${dd}${sep}${name}`;
}

function joinPath(dir, name) {
  const d = (dir || "/").replace(/\/+$/, "");
  return `${d === "" ? "" : d}/${name}`;
}

async function flList() {
  const dir = $("fl-dir").value.trim() || "/";
  const my = ++flSeq;
  flState("读取目录 ...");
  try {
    // 网络盘（FTP/FTPS）用 netfs 那套；串口 / TCP 服务通道还是走设备的 cshell / 6666 服务
    const items = flIsNet() ? await flListNet(dir) : await invoke("device_list", { path: dir });
    if (my !== flSeq) return;          // 已经有更新的请求了，别拿旧结果覆盖
    flEntries = items;
    flDirOf = dir;
    const sel = $("fl-items");
    sel.innerHTML = "";
    let idx = 1;
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.name;
      if (it.is_dir) o.dataset.dir = "1";
      const noTxt = logNoOn() ? String(idx++).padStart(3) + "  " : "";      // 左边序号（跟日志同一开关）
      o.textContent = `${noTxt}${it.is_dir ? "DIR " : "FILE"}   ${String(it.size).padStart(10)}   ${it.name}`;
      sel.appendChild(o);
    }
    if (!items.length) sel.innerHTML = '<option value="">（空目录）</option>';
    else sel.selectedIndex = 0;      // 动态塞进去的 option 不会自动选中第一项
    flState(`${items.length} 项`);
    pushSys(`[文件] ${dir} 共 ${items.length} 项`);
    for (const it of items) {
      pushSys(`[文件]   ${it.is_dir ? "D" : "F"} ${String(it.size).padStart(10)}  ${it.name}`);
    }
  } catch (e) {
    if (my !== flSeq) return;
    flEntries = [];
    $("fl-items").innerHTML = '<option value="">' + en("（读不到）") + '</option>';
    flState("失败: " + e, "err");
    pushSys(`[文件] 列目录失败: ${e}`);
  }
}

async function flPull() {
  const name = $("fl-items").value;
  if (!name) {
    toast("先在列表里选一个文件（双击也能取）");
    return;
  }
  const it = flEntries.find((x) => x.name === name);
  const dir = flDirOf || ($("fl-dir").value.trim() || "/");
  if (it && it.is_dir) {                       // 目录就进去
    $("fl-dir").value = joinPath(dir, name);
    flList();
    return;
  }
  const path = joinPath(dir, name);
  const fname = name.replace(/\/+$/, "");
  const saveDir = $("fl-save-dir").value.trim();
  let save = joinFile(saveDir, fname);
  try {
    const picked = await dlgSave({
      title: `把设备上的 ${path} 保存到本机`,
      defaultPath: save,
    });
    if (!picked) { flState("已取消"); return; }
    save = picked;
    const d0 = picked.replace(/[\\/][^\\/]*$/, "");
    if (d0) $("fl-save-dir").value = d0;
  } catch (e) {
    pushSys(`[文件] 没弹出保存对话框(${e})，按默认路径存`);
  }
  localStorage.setItem("kdock_save_dir", $("fl-save-dir").value.trim());
  flState(`传输中 ... ${path}`);
  try {
    let r;
    if (flIsNet()) {
      // FTP 走 RETR；TFTP 走 RRQ（后端按 tftp_host 有没有值来分）
      const h = $("fl-net-host").value.trim();
      r = await invoke("netfs_get", {
        id: flNetId, path, saveTo: save,
        tftpHost: flNetProto() === "tftp" ? h : null,
        tftpPort: flNetPort(),
        tftpLocal: $("fl-iface") ? $("fl-iface").value || null : null,
      });
    } else {
      r = await invoke("device_pull", { path, saveTo: save });
    }
    flState(`已保存到 ${save}   ${r.bytes} B   crc32=${hex8(r.crc32)}`, "ok");
    toast(`已保存到 ${save}（${r.bytes} B）`);
    pushSys(`[文件] 已保存到 ${save}   ${r.bytes} B   crc32=${hex8(r.crc32)}`);
  } catch (e) {
    flState("失败: " + e, "err");
    pushSys(`[文件] 取文件失败: ${e}`);
  }
}

/* ── 文件页的"网络盘"：FTP / FTPS（显式 + 隐式）/ TFTP ─────────────────────────
   串口和 TCP Client 那两条老路走主连接（device_list / device_pull / device_upload），
   网络盘走 netfs_*（后端自己维护一条有状态的控制连接）；TFTP 没有会话，后端按次问。
   两者在界面上是同一套动作：列目录 / 取回本机 / 发到设备。 */
const FL_NET_MODES = ["ftp", "ftps", "ftps_implicit", "tftp"];
let flNetId = 0;
function flIsNet() { return FL_NET_MODES.includes($("fl-mode").value); }
function flNetProto() { return $("fl-mode").value; }
function flNetPort() {
  const v = $("fl-net-port").value.trim();
  if (v) return Number(v);
  return flNetProto() === "tftp" ? 69 : flNetProto() === "ftps_implicit" ? 990 : 21;
}

/** 列目录：网络盘走 netfs_list，返回同样的 {name,size,is_dir} */
async function flListNet(dir) {
  if (!flNetId) throw new Error(en("先点「连接」（FTP/FTPS 要登录；TFTP 只是记一下地址）"));
  const items = await invoke("netfs_list", { id: flNetId, path: dir });
  return items.map((x) => ({
    name: x.name,
    size: x.size,
    is_dir: x.is_dir,
    mtime: x.mtime || "",
  }));
}

async function flOpenNet() {
  const proto = flNetProto();
  const label = en("连接") + " " + proto.toUpperCase();
  flState(label + " …");
  try {
    const r = await invoke("netfs_open", {
      proto,
      host: $("fl-net-host").value.trim(),
      port: flNetPort(),
      user: $("fl-net-user").value.trim(),
      password: $("fl-net-pass").value,
      insecure: !!($("fl-net-insecure") && $("fl-net-insecure").checked),
      localAddr: $("fl-iface") ? $("fl-iface").value || null : null,
    });
    flNetId = Number(r.id) || 0;
    flState(`${r.label}  ${r.note || ""}`, "ok");
    pushSys(`[文件] 已连接 ${r.label}${r.note ? "（" + r.note + "）" : ""}`);
    localStorage.setItem("kdock_fl_net", JSON.stringify({
      proto, host: $("fl-net-host").value.trim(), port: $("fl-net-port").value.trim(),
      user: $("fl-net-user").value.trim(),
    }));
    if (proto === "tftp") {
      $("fl-items").innerHTML = '<option value="">' + en("（TFTP 没有列表：直接填路径取/送）") + '</option>';
      flEntries = [];
    } else {
      $("fl-dir").value = "/";
      flList();
    }
  } catch (e) {
    flNetId = 0;
    flState(en("失败: ") + e, "err");
    pushSys(`[文件] ${proto.toUpperCase()} 连接失败: ${e}`);
    toast(String(e));
  }
}

async function flCloseNet(silent) {
  if (flNetId) {
    await invoke("netfs_close", { id: flNetId }).catch(() => {});
    if (!silent) pushSys(`[文件] 已断开 ${flNetProto().toUpperCase()}（#${flNetId}）`);
    flNetId = 0;
  }
  flState(en("未连接"));
}

/** 内置 TFTP 服务端：把本机当 TFTP 服务器（设备来取固件 / 把日志写回来） */
let tftpSrvOn = false;
function tftpSrvState(text, cls) {
  const d = $("fl-tftp-state");
  if (d) { d.textContent = en(text); d.className = "dot" + (cls ? " " + cls : ""); }
  const b = $("fl-tftp-go"), s = $("fl-tftp-stop");
  if (b) b.disabled = tftpSrvOn;
  if (s) s.disabled = !tftpSrvOn;
}
function tftpSrvLog(text) {
  const box = $("fl-tftp-log");
  if (!box) return;
  box.textContent += `[${new Date().toLocaleTimeString()}] ${text}\n`;
  if (box.textContent.length > 40000) box.textContent = box.textContent.slice(-30000);
  box.scrollTop = box.scrollHeight;
}
async function tftpSrvStart() {
  const root = $("fl-tftp-root").value.trim();
  if (!root) { toast(en("先选一个 TFTP 根目录")); return; }
  try {
    const r = await invoke("tftp_server_start", {
      root, port: Number($("fl-tftp-port").value) || 69,
      allowWrite: !!($("fl-tftp-write") && $("fl-tftp-write").checked),
    });
    tftpSrvOn = true;
    localStorage.setItem("kdock_tftp", JSON.stringify({ root, port: r.port, write: !!$("fl-tftp-write").checked }));
    tftpSrvState(`已启动 · UDP ${r.port} · ${r.root}`, "ok");
    pushSys(`[TFTP] 服务端已启动：UDP ${r.port}，根目录 ${r.root}`);
  } catch (e) {
    tftpSrvOn = false;
    tftpSrvState(en("启动失败: ") + e, "err");
    toast(String(e));
  }
}
async function tftpSrvStop() {
  await invoke("tftp_server_stop").catch(() => {});
  tftpSrvOn = false;
  tftpSrvState("未启动");
}

/** 连接/断开：串口/TCP 走主连接，网络盘走 netfs */
async function flConnect() {
  const m = $("fl-mode").value;
  if (FL_NET_MODES.includes(m)) return flOpenNet();
  $("mode").value = m;
  switchMode(m);
  if (m === "serial") {
    if ($("fl-ports").value) $("ports").value = $("fl-ports").value;
    if ($("fl-baud").value) { $("baud").value = $("fl-baud").value; currentBaud = Number($("fl-baud").value); }
  } else {
    $("tcp-client-host").value = $("fl-host").value.trim();
    $("tcp-client-port").value = $("fl-port").value;
    if ($("fl-iface") && $("tcp-client-iface")) $("tcp-client-iface").value = $("fl-iface").value;
  }
  await doOpen();
}

$("fl-mode").onchange = () => switchPaneMode("fl", $("fl-mode").value);
$("fl-open").onclick = flConnect;
$("fl-close").onclick = async () => { await flCloseNet(); await doClose(); };
$("fl-refresh").onclick = refreshPorts;
if ($("fl-mkdir")) $("fl-mkdir").onclick = async () => {
  if (!flIsNet()) return toast(en("「新建目录」只在 FTP / FTPS 下可用"));
  const name = await agDialog({ title: en("新建目录"), text: en("目录名（建在当前路径下）"), input: true });
  if (!name.ok || !name.value) return;
  try {
    await invoke("netfs_mkdir", { id: flNetId, path: joinPath(flDirOf || $("fl-dir").value.trim() || "/", name.value.trim()) });
    flList();
  } catch (e) { flState(en("失败: ") + e, "err"); }
};
if ($("fl-del")) $("fl-del").onclick = async () => {
  if (!flIsNet()) return toast(en("「删除」只在 FTP / FTPS 下可用"));
  const name = $("fl-items").value;
  if (!name) return toast(en("先在列表里选一个"));
  const it = flEntries.find((x) => x.name === name);
  const path = joinPath(flDirOf || $("fl-dir").value.trim() || "/", name);
  const r = await agDialog({
    title: en("删除"),
    text: `确定删掉 ${path}${it && it.is_dir ? en("（目录）") : ""}？删了回不来。`,
  });
  if (!r.ok) return;
  try {
    await invoke("netfs_delete", { id: flNetId, path, isDir: !!(it && it.is_dir) });
    flList();
  } catch (e) { flState(en("失败: ") + e, "err"); }
};
if ($("fl-tftp-go")) $("fl-tftp-go").onclick = tftpSrvStart;
if ($("fl-tftp-stop")) $("fl-tftp-stop").onclick = tftpSrvStop;
if ($("fl-tftp-pick")) $("fl-tftp-pick").onclick = async () => {
  const p = await dlgOpen({ directory: true, multiple: false, title: en("选 TFTP 根目录") });
  if (p) { $("fl-tftp-root").value = typeof p === "string" ? p : p.path; }
};
if ($("fl-tftp-write")) $("fl-tftp-write").onchange = () => {
  if (tftpSrvOn) { tftpSrvStop().then(tftpSrvStart); }   // 开关改了要重启才生效
};

/** 文件页的持久化：上次用哪种方式 / FTP 服务器 / 内置 TFTP 服务端的根目录与端口 */
function flRestorePrefs() {
  try {
    const j = JSON.parse(localStorage.getItem("kdock_fl_net") || "null");
    if (j && j.proto) {
      $("fl-mode").value = j.proto;
      switchPaneMode("fl", j.proto);
      if (j.host) $("fl-net-host").value = j.host;
      if (j.port) $("fl-net-port").value = j.port;
      if (j.user) $("fl-net-user").value = j.user;
    }
  } catch (_) {}
  try {
    const t = JSON.parse(localStorage.getItem("kdock_tftp") || "null");
    if (t) {
      if (t.root) $("fl-tftp-root").value = t.root;
      if (t.port) $("fl-tftp-port").value = t.port;
      $("fl-tftp-write").checked = !!t.write;
    }
  } catch (_) {}
  tftpSrvState("未启动");
}

let flSendFile = null;   // { name, bytes }

$("fl-pick").onclick = async () => {
  try {
    const p = await dlgOpen({ title: "选择要发到设备的文件", multiple: false, directory: false });
    if (!p) return;
    const path0 = typeof p === "string" ? p : p.path;
    const name = path0.replace(/^.*[\\/]/, "");
    const buf = await readFile(path0);
    flSendFile = { name, bytes: Array.from(buf) };
    if (!$("fl-send-path").value.trim()) {
      const dir = flDirOf || ($("fl-dir").value.trim() || "/");
      $("fl-send-path").value = joinPath(dir, name);
    }
    flState(`待发送 ${name}   ${flSendFile.bytes.length} B`);
  } catch (e) { flState("选文件失败: " + e, "err"); }
};

$("fl-send").onclick = async () => {
  if (!flSendFile) { toast(en("先选一个本机文件")); return; }
  const path = $("fl-send-path").value.trim();
  if (!path) { toast(en("填一下设备上的目标路径")); return; }
  const n = flSendFile.bytes.length;
  flState(`发送中 ... ${path}`);
  try {
    let crc;
    if (flIsNet()) {
      const h = $("fl-net-host").value.trim();
      const r = await invoke("netfs_put", {
        id: flNetId, path, data: flSendFile.bytes,
        tftpHost: flNetProto() === "tftp" ? h : null,
        tftpPort: flNetPort(),
        tftpLocal: $("fl-iface") ? $("fl-iface").value || null : null,
      });
      crc = r.crc32;
    } else {
      crc = await invoke("device_upload", { path, data: flSendFile.bytes });
    }
    flState(`已发送 ${n} B  crc32=${hex8(crc)}`, "ok");
    pushSys(`[文件] 已发送 ${path}   ${n} B   crc32=${hex8(crc)}`);
    flList();                                  // 刷新列表，能马上看到
  } catch (e) {
    flState("失败: " + e, "err");
    pushSys(`[文件] 发送失败: ${e}`);
  }
};

$("fl-list").onclick = flList;
$("fl-pull").onclick = flPull;
$("fl-items").ondblclick = flPull;
$("fl-dir").onkeydown = (e) => { if (e.key === "Enter") flList(); };
$("fl-up").onclick = () => {
  const d = ($("fl-dir").value.trim() || "/").replace(/\/+$/, "");
  const i = d.lastIndexOf("/");
  $("fl-dir").value = i <= 0 ? "/" : d.slice(0, i);
  flList();
};

// ---------------- 左栏标签页：传输 / 升级 / 文件 ----------------
/** 导航 key -> 中间用哪块操作区（升级沿用输出/输入那块"壳"） */
const WORK_OF = {
  link: "shell", upgrade: "shell", files: "files", cmds: "shell",
  chart: "chart", seq: "seq", flash: "flash", scope: "scope", capture: "capture", logic: "logic",
  debug: "debug",
  agent: "agent",
  env: "env",
  usb: "usb",
  kb: "kb",
  adb: "adb",
};

/** 窄窗时参数区是「整行挪到下面」的一条：按当前这张面板的内容量决定它多高（30~55vh 之间），
    内容少就不占地方、内容多也别逼着用户在小窗口里滚。宽窗（右栏模式）下这条不起作用。 */
function syncParamStrip() {
  const scale = uiScaleValue();
  // 用 UI 根节点的逻辑尺寸，而不是窗口像素 / scale；前者在 CSS zoom 和系统 DPI
  // 叠加时才是真正参与布局的尺寸。
  const root = document.getElementById("ui-root");
  const layoutW = root ? root.clientWidth : window.innerWidth / scale;
  if (layoutW > 1180) { document.documentElement.style.removeProperty('--param-max'); return; }
  const box = document.querySelector('.params');
  if (!box) return;
  const pane = [...box.querySelectorAll('[data-param]')].find((p) => !p.hidden);
  if (!pane) { document.documentElement.style.removeProperty('--param-max'); return; }
  const need = pane.scrollHeight + 24;                    // 上下留点缝
  const layoutH = root ? root.clientHeight : window.innerHeight / scale;
  const lo = Math.round(layoutH * 0.3), hi = Math.round(layoutH * 0.45);   // 上限跟容器查询里的 45cqh 一致：工作区得留得住
  document.documentElement.style.setProperty('--param-max', Math.min(hi, Math.max(lo, need)) + 'px');
}

/** 切页：左导航高亮 + 中间换操作区 + 右边换参数区 */
function showPane(tab) {
  const btn = document.querySelector(`.navitem[data-tab="${tab}"]`);
  if (btn) document.querySelectorAll(".navitem").forEach((b) => b.classList.toggle("active", b === btn));
  const advToggle = document.getElementById("nav-advanced-toggle");
  if (advToggle) advToggle.classList.toggle("has-active", ADVANCED_TABS.has(tab));
  if (ADVANCED_TABS.has(tab)) openAdvancedNavFor(tab, true);
  const work = WORK_OF[tab] || tab;
  document.querySelectorAll("[data-work]").forEach((p) => { p.hidden = p.dataset.work !== work; });
  if (work === "agent") agUnreadClear();      // 切过来就算看过了，清掉未读角标
  document.querySelectorAll("[data-param]").forEach((p) => { p.hidden = p.dataset.param !== tab; });
  document.documentElement.dataset.tab = tab;      // 窄窗样式要按"当前这一页"决定收不收那条参数带（如计算器）
  document.documentElement.classList.toggle("kb-focus", tab === "kb" && kbFocus);
  if (tab === "runtime" && window.rtInit) window.rtInit();
  syncParamStrip();
  if (tab === "upgrade") syncUpgCtl();
  if (tab === "datacalc") initCalc();          // 折叠区块的初始化在 initCalc 里（只有一次）
  if (tab === "files") {
    // 网络盘模式（FTP/FTPS/TFTP）没连之前别去列目录：那会报"先点连接"
    if (!flIsNet()) {
      syncPaneCtl("fl");
      if (!flEntries.length) flList();
    }
  }
  if (tab === "adb") adbOnShow();
  const pg = $("tb-page");
  if (pg) { const p = TB_PAGES.find((x) => x[0] === tab); pg.textContent = p ? en(p[1]) : tab; }
  if (tab === "chart") { chDirty = true; chartResize(); }
  // 网卡可能在软件运行期间插拔（USB 网卡 / 切换 Wi-Fi），进这几个页面时顺手刷新一次
  if (["link", "flow", "upgrade", "flash", "files"].includes(tab)) refreshNetIfaces();
  if (tab === "flash") { flashSync(); flashBootstrap(); }
  if (tab === "capture" && capRefresh) capRefresh();
  if (tab === "agent") agOnShow();
  if (tab === "batch") initBatch({ pushTx: pushEntry });
  if (tab === "calc") initCalc();
  if (tab === "datacalc") initCalc();          // 折叠区块的初始化在 initCalc 里（只有一次）
  if (tab === "logic") initLogic();
  // 切页保持缓存，避免每次进入都重扫整套驱动/工具链；
  // 外部安装或卸载驱动后，用页面上的「扫描本机 / 重新扫描」强制同步。
  if (tab === "env") envRefresh();
  if (tab === "usb") usbOnShow();
  if (tab === "scope") { scSetView(scView); scResizePlot(); }
  kbSyncSoon();                                 // 知识库页：进来就贴、离开就收（详见 kbSync）
  if (LANG === "en") langWalk();   // 这一页里"切过来才渲染"的文字（提示语/空态）再扫一遍
}

/** 调试页（GDB/MI）暂时隐藏：代码全都在（页面、后端 debug.rs、解析都保留），
 *  把这一行改成 true 就能把左导航的「调试」重新放出来。 */
const DEBUG_UI = false;

/* ==========================================================================
   知识库页：中间 = 管理页面，右栏 = 对话页面
   两块都用**内置浏览器**渲染 —— 真身是后端 kbview.rs 贴在主窗口上的 WebView2 子视图，
   这里只负责：算占位区坐标、让子视图跟着布局走、没配地址时把人引到设置。
   两个地址只存本机（localStorage），不进仓库、不上传。
   ========================================================================== */
const KB_MGMT_KEY = "kdock_kb_mgmt";
const KB_CHAT_KEY = "kdock_kb_chat";
let kbLastPlace = {};            // kind -> "x,y,w,h|url"，用来判断"要不要真的动它"
let kbSyncing = false;

const kbGet = (key) => (localStorage.getItem(key) || "").trim();

/** 地址补全：没写协议就按 https 来（Dify 这类都是 https） */
function kbNorm(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
}

/** 知识库页现在露着吗（还得不是在弹窗后面 —— 子视图是原生层，会盖住弹窗） */
function kbVisible() {
  const pane = document.querySelector('[data-work="kb"]');
  if (!pane || pane.hidden) return false;
  const modal = document.getElementById("settings-modal");
  if (modal && !modal.hidden) return false;
  const help = document.getElementById("help-modal");
  if (help && !help.hidden) return false;
  const agdlg = document.getElementById("ag-dlg");
  if (agdlg && !agdlg.hidden) return false;
  return true;
}

/** 占位区（那块要被子视图盖住的矩形）在窗口客户区里的位置，CSS 像素 */
function kbRect(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  if (b.width < 60 || b.height < 60) return null;   // 没布局出来（页还没显示）就先不贴
  return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
}

async function kbPlace(kind, hostId, url, emptyId, force) {
  const empty = document.getElementById(emptyId);
  const r = kbRect(hostId);
  if (!url || !r) {
    if (kbLastPlace[kind]) { await invoke("kb_hide", { kind }).catch(() => {}); kbLastPlace[kind] = ""; }
    if (empty && !empty.hidden) { /* 空态文案由 kbEmptyText 管 */ }
    return;
  }
  if (empty) empty.hidden = true;
  const key = `${r.x},${r.y},${r.w},${r.h}|${url}`;
  if (!force && kbLastPlace[kind] === key) return;      // 位置和地址都没变：这条不折腾
  kbLastPlace[kind] = key;
  try {
    await invoke("kb_show", { kind, url, x: r.x, y: r.y, w: r.w, h: r.h });
    kbStateText("");
  } catch (e) {
    kbLastPlace[kind] = "";
    kbStateText(String(e).slice(0, 80), "err");
    toast(String(e));
  }
}

function kbStateText(t, cls) {
  const el = $("kb-state");
  if (!el) return;
  el.textContent = t || "";
  el.title = t || "";
  el.style.color = cls === "err" ? "hsl(var(--destructive))" : "";
}

/** 空态那块提示（没配地址 / 还没建起来） */
function kbEmptyText() {
  const mgmt = kbNorm(kbGet(KB_MGMT_KEY));
  const chat = kbNorm(kbGet(KB_CHAT_KEY));
  const el1 = $("kb-empty");
  if (el1) {
    el1.innerHTML = "";
    const a = document.createElement("div");
    a.textContent = mgmt
      ? en("打开管理页面")
      : en("在设置 → 知识库里配置管理页面");
    el1.append(a);
    el1.hidden = !!mgmt && !!kbLastPlace.mgmt;
  }
  const el2 = $("kb-chat-empty");
  if (el2) {
    el2.innerHTML = "";
    const a = document.createElement("div");
    a.textContent = chat
      ? en("打开对话页面")
      : en("在设置 → 知识库里配置对话页面");
    el2.append(a);
    el2.hidden = !!chat && !!kbLastPlace.chat;
  }
}

/** 贴 / 挪 / 收 —— 切页、改窗口大小、拖分栏都会调它（重复调不会重新加载页面） */
async function kbSync(force) {
  if (kbSyncing) return;
  kbSyncing = true;
  try {
    if (!kbVisible()) {
      if (kbLastPlace.mgmt || kbLastPlace.chat) {
        await invoke("kb_hide_all").catch(() => {});
        kbLastPlace = {};
      }
      return;
    }
    kbEmptyText();
    const mgmt = kbNorm($("kb-url") && $("kb-url").value ? $("kb-url").value : kbGet(KB_MGMT_KEY));
    const chat = kbNorm($("kb-chat-url") && $("kb-chat-url").value ? $("kb-chat-url").value : kbGet(KB_CHAT_KEY));
    await kbPlace("mgmt", "kb-host", mgmt, "kb-empty", force);
    await kbPlace("chat", "kb-chat-host", chat, "kb-chat-empty", force);
    if (force) kbEmptyText();
  } finally {
    kbSyncing = false;
  }
}

/** 下一帧再同步（切页那一刻 DOM 刚显隐，直接量坐标会拿到 0） */
function kbSyncSoon() {
  setTimeout(() => { kbSync(false).catch(() => {}); }, 60);
}

function bindKb() {
  if (!$("kb-url")) return;
  const urlIn = $("kb-url");
  const chatIn = $("kb-chat-url");
  urlIn.value = kbGet(KB_MGMT_KEY);
  if (chatIn) chatIn.value = kbGet(KB_CHAT_KEY);
  kbEmptyText();

  const open = async () => {
    const u = kbNorm(urlIn.value);
    if (!u) { toast(en("先填个地址：已经在设置 → 知识库里等你")); openSettings("kb"); return; }
    kbLastPlace = {};
    await kbSync(true);
    kbEmptyText();
  };
  const openChat = async () => {
    const u = kbNorm(chatIn && chatIn.value);
    if (!u) { toast(en("先填「对话页面」地址：已经在设置 → 知识库里等你")); openSettings("kb"); return; }
    kbLastPlace.chat = "";
    await kbSync(true);
    kbEmptyText();
  };
  $("kb-open").onclick = () => open().catch((e) => toast(String(e)));
  urlIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("kb-open").click(); }
  });
  if (chatIn) {
    chatIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); openChat().catch(() => {}); }
    });
  }
  const saveKey = (key, input, name) => {
    const u = kbNorm(input.value);
    if (!u) { toast(en("先填个地址")); return; }
    localStorage.setItem(key, u);
    input.value = u;
    if ($("set-kb-mgmt") && key === KB_MGMT_KEY) $("set-kb-mgmt").value = u;
    if ($("set-kb-chat") && key === KB_CHAT_KEY) $("set-kb-chat").value = u;
    toast(`${en(name)} ${en("地址已存为默认")}`);
  };
  // 每一块有自己的地址与自己的默认值（管理页 / 对话页各一份）
  if ($("kb-save")) $("kb-save").onclick = () => saveKey(KB_MGMT_KEY, urlIn, "管理页面");
  if ($("kb-chat-save")) $("kb-chat-save").onclick = () => saveKey(KB_CHAT_KEY, chatIn, "对话页面");
  $("kb-reload").onclick = () => {
    if (!kbLastPlace.mgmt) { toast(en("还没打开过")); return; }
    invoke("kb_reload", { kind: "mgmt" }).catch((e) => toast(String(e)));
  };
  $("kb-external").onclick = () => {
    const u = kbNorm(urlIn.value || kbGet(KB_MGMT_KEY));
    if (!u) { toast(en("先填个地址")); return; }
    invoke("browser_open_external", { path: u }).catch((e) => toast(String(e)));
  };
  const ce = $("kb-chat-empty");
  if (ce) ce.onclick = () => openSettings("kb");
  const me = $("kb-empty");
  if (me) {
    me.onclick = () => {
      // 配了地址就"打开"，没配就去设置
      if (kbNorm(urlIn.value || kbGet(KB_MGMT_KEY))) open().catch(() => {});
      else openSettings("kb");
    };
  }
  $("kb-chat-open").onclick = () => openChat().catch((e) => toast(String(e)));
  if ($("kb-chat-focus")) $("kb-chat-focus").onclick = () => kbSetFocus(!kbFocus);
  $("kb-chat-reload").onclick = () => {
    if (!kbLastPlace.chat) { toast(en("还没打开过")); return; }
    invoke("kb_reload", { kind: "chat" }).catch((e) => toast(String(e)));
  };
  // 设置页里的两个输入
  if ($("set-kb-mgmt")) $("set-kb-mgmt").value = kbGet(KB_MGMT_KEY);
  if ($("set-kb-chat")) $("set-kb-chat").value = kbGet(KB_CHAT_KEY);
  if ($("set-kb-save")) {
    $("set-kb-save").onclick = () => {
      const m = kbNorm($("set-kb-mgmt").value);
      const c = kbNorm($("set-kb-chat").value);
      if (m) localStorage.setItem(KB_MGMT_KEY, m); else localStorage.removeItem(KB_MGMT_KEY);
      if (c) localStorage.setItem(KB_CHAT_KEY, c); else localStorage.removeItem(KB_CHAT_KEY);
      $("set-kb-mgmt").value = m;
      $("set-kb-chat").value = c;
      urlIn.value = m;
      kbLastPlace = {};
      if ($("set-kb-state")) $("set-kb-state").textContent = en("已保存");
      toast(en("知识库地址已保存"));
    };
  }
  if ($("set-kb-go")) {
    $("set-kb-go").onclick = () => {
      closeSettings();
      showPane("kb");
    };
  }
  // 位置跟随：窗口缩放 / 拖分栏 / 抽屉式布局变化都算
  window.addEventListener("resize", () => { if (kbVisible()) kbSyncSoon(); syncParamStrip(); });
  // 参数区里的折叠卡展开/收起后，条带高度跟着变（toggle 不冒泡，用捕获接）
  document.addEventListener("toggle", (e) => { if (e.target && e.target.closest && e.target.closest(".params")) syncParamStrip(); }, true);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (kbVisible()) kbSyncSoon(); });
    for (const id of ["kb-host", "kb-chat-host"]) {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    }
  }
  kbSetFocus(kbFocus);
  // 兜底：有些变化（拖左栏/右栏的把手、改缩放）不会触发上面两个
  setInterval(() => { if (kbVisible()) kbSync(false).catch(() => {}); }, 700);
}

let kbFocus = localStorage.getItem("kdock_kb_focus") !== "0";
function kbSetFocus(on) {
  kbFocus = !!on;
  localStorage.setItem("kdock_kb_focus", kbFocus ? "1" : "0");
  document.documentElement.classList.toggle("kb-focus", kbFocus && helpCurrentPage() === "kb");
  const b = $("kb-chat-focus");
  if (b) {
    b.textContent = en(kbFocus ? "管理" : "全屏");
    b.title = en(kbFocus ? "显示知识库管理页面" : "全屏显示知识库对话页面");
  }
  kbLastPlace = {};
  syncParamStrip();
  kbSyncSoon();
}

function bindTabs() {
  // 只绑带 data-tab 的；底部那个"设置"齿轮不是页面切换，别把它的 onclick 覆盖了
  document.querySelectorAll(".navitem[data-tab]").forEach((btn) => {
    btn.onclick = () => showPane(btn.dataset.tab);
  });
  if (!DEBUG_UI) {
    // 只是藏起来：不显示入口，也就进不去（页面本体留着，重开时不用再写一遍）
    const b = document.querySelector('.navitem[data-tab="debug"]');
    if (b) b.hidden = true;
  }
  initAdvancedNav();
  // 开局先把右栏对到当前页 —— 以前只有"点一下左导航"才会调 showPane，
  // 所以冷启动时右边是空的（连接参数、统计全都不见），得先点别的页再点回来才出来。
  const act = document.querySelector(".navitem.active[data-tab]");
  if (act) showPane(act.dataset.tab);
}

// ---------------- 实时图表（波形交互参考，用 uPlot 画） ----------------
// 设备按 "1.23,4.56,7.89" 每行发一串数字（它就是这个数据格式），这里按行解析成多通道曲线。
let chart = null;
let chXs = [];
let chYs = [];
let chColors = [];
let chHidden = new Set();
let chDirty = false;
const CH_PALETTE = ["#4f8cff", "#3ddc97", "#ffc857", "#ff6b6b", "#b388ff", "#4dd0e1", "#ff9f43", "#7ed957"];

/** 从一段 RX 文本里挑出"纯数字行"喂给图表；非数字行忽略 */
function chartFeed(text) {
  const s = String(text);
  for (const raw of s.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.length > 512) continue;
    if (!/^[-+0-9.eE\s,;]+$/.test(t)) continue;
    const nums = t.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.some((n) => !Number.isFinite(n))) continue;
    if (!chYs.length || nums.length > chYs.length) {
      // 通道数变了（或第一次）：重建
      const n = nums.length;
      chYs = Array.from({ length: n }, (_, i) => chYs[i] || []);
      chColors = Array.from({ length: n }, (_, i) => CH_PALETTE[i % CH_PALETTE.length]);
      chHidden = new Set();
      rebuildChart();
      refreshChannelList();
    }
    chXs.push(chXs.length);
    nums.forEach((v, i) => { if (chYs[i]) chYs[i].push(v); });
    chDirty = true;
  }
  const keep = Math.max(100, Number($("ch-keep").value) || 2000);
  if (chXs.length > keep) {
    const cut = chXs.length - keep;
    chXs = chXs.slice(cut);
    chYs = chYs.map((a) => a.slice(cut));
    chXs = chXs.map((_, i) => i);          // x 轴用索引，省得越界
  }
}

function chartOptions() {
  const w = $("chart-box").clientWidth || 600;
  const h = $("chart-box").clientHeight || 320;
  return {
    width: w,
    height: h,
    series: [
      { label: "t" },
      ...chYs.map((_, i) => ({
        label: `CH${i + 1}`,
        stroke: chColors[i] || CH_PALETTE[i % CH_PALETTE.length],
        width: 1.6,
        show: !chHidden.has(i),
      })),
    ],
    axes: [
      { stroke: "#8b98a8", grid: { stroke: "rgba(139,152,168,.15)" } },
      { stroke: "#8b98a8", grid: { stroke: "rgba(139,152,168,.15)" } },
    ],
    legend: { show: true },
    cursor: { drag: { x: true, y: false } },
  };
}

function rebuildChart() {
  const box = $("chart-box");
  if (!box) return;
  if (chart) { chart.destroy(); chart = null; }
  if (!chYs.length || !box.clientWidth) return;
  chart = new uPlot(chartOptions(), [chXs, ...chYs], box);
}

function chartResize() {
  if (!chart) { rebuildChart(); return; }
  const box = $("chart-box");
  chart.setSize({ width: box.clientWidth || 600, height: box.clientHeight || 320 });
}

function refreshChannelList() {
  const sel = $("ch-channels");
  sel.innerHTML = "";
  chYs.forEach((_, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `CH${i + 1}`;
    o.selected = !chHidden.has(i);
    sel.appendChild(o);
  });
}

function bindChart() {
  $("ch-clear").onclick = () => {
    chXs = []; chYs = []; chColors = []; chHidden = new Set();
    if (chart) { chart.destroy(); chart = null; }
    refreshChannelList();
    toast("图表已清空");
  };
  $("ch-keep").onchange = () => { /* 下次 feed 生效 */ };
  $("ch-channels").onchange = () => {
    const on = new Set(Array.from($("ch-channels").selectedOptions).map((o) => Number(o.value)));
    chHidden = new Set(chYs.map((_, i) => i).filter((i) => !on.has(i)));
    if (chart) chart.setSeries(chYs.map((_, i) => ({ show: !chHidden.has(i) })));
  };
  window.addEventListener("resize", () => { if (!$("chart-box").closest("[hidden]")) chartResize(); });
  // 定期重绘（采样间隔可调），别每个数据点都重画
  setInterval(() => {
    if (!chDirty) return;
    const box = $("chart-box");
    if (box.closest("[hidden]")) return;      // 不在图表页就先不画（**别清 dirty**，切回来要补画）
    chDirty = false;
    $("ch-src").textContent = chYs.length + en(" 通道 / ") + chXs.length + en(" 点");
    if (!chart || chart.series.length - 1 !== chYs.length) rebuildChart();
    else chart.setData([chXs, ...chYs]);
  }, Math.max(30, Number($("ch-sample").value) || 4) * 5);
}

// ---------------- 烧录：拉外部烧录器（openocd / J-Link / STM32CubeProgrammer） ----------------
// 只负责拼命令行 + 把输出流回中间那块日志；烧录器自己会去连探针。
const FL_TOOLS = {
  openocd: {
    exe: "openocd",
    mk: (o) => {
      const a = ["-f", `interface/${o.adapter}.cfg`, "-c", `adapter speed ${o.speed}`, "-f", `target/${o.target}.cfg`];
      const file = o.file ? o.file.replace(/\\/g, "/") : "";
      // 地址只对裸 .bin 有意义（hex/elf 自带地址），没选文件时也不拼
      const addr = o.file && /\.bin$/i.test(o.file) && o.addr ? ` ${o.addr}` : "";
      if (o.action === "flash") a.push("-c", `program ${file}${addr} verify reset exit`);
      else if (o.action === "erase") a.push("-c", "reset halt", "-c", `flash erase_address ${o.addr} 0x200000`, "-c", "exit");
      else if (o.action === "verify") a.push("-c", `verify_image ${file}${addr}`, "-c", "exit");
      else a.push("-c", "reset run", "-c", "exit");
      return a;
    },
  },
  jlink: {
    // 标准安装位置；版本号目录各家不同，界面上可以直接改（存 localStorage）
    exe: "C:/Program Files/SEGGER/JLink/JLink.exe",
    script: (o) => {
      const isBin = /\.bin$/i.test(o.file || "");
      const lines = [`device ${o.jlinkDev}`, `si ${o.iface.toUpperCase()}`, `speed ${o.speed}`, "connect"];
      const file = o.file;
      if (o.action === "flash") {
        lines.push(`loadfile ${file}${isBin ? " " + o.addr : ""}`);
        // .hex/.elf 的 loadfile 本身就会读回比对；只有 .bin 需要单独 VerifyBin
        if (isBin) lines.push(`verifybin ${file}, ${o.addr}`);
      } else if (o.action === "erase") {
        lines.push("erase");
      } else if (o.action === "verify") {
        if (isBin) lines.push(`verifybin ${file}, ${o.addr}`);
        else lines.push(`// ${file} 是 hex/elf，LoadFile 会自带校验，无需单独 verify`);
      }
      lines.push(o.action === "reset" ? "r" : "r", "go", "qc");
      return lines.filter(Boolean).join("\n");
    },
  },
  stm32cli: {
    exe: "STM32_Programmer_CLI",
    mk: (o) => {
      const a = ["-c", `port=${o.iface.toUpperCase()} mode=UR`];
      if (o.action === "flash") a.push("-w", o.file);
      else if (o.action === "erase") a.push("-e", "all");
      else if (o.action === "verify") a.push("-v");
      a.push(o.action === "flash" ? "-v" : "-rst");
      return a;
    },
  },
  pyocd: {
    exe: "pyocd",
    mk: (o) => {
      const isBin = /\.bin$/i.test(o.file || "");
      const target = (o.jlinkDev || o.target || "").trim();
      if (!target) throw new Error("pyOCD 需要目标芯片型号（fl-target）");
      const a = ["flash", "-t", target];
      if (o.probe) a.push("-u", o.probe);
      if (isBin) a.push("-a", o.addr || "0x08000000");
      a.push(o.file);
      return a;
    },
  },
  netudp: {
    exe: "UDP 服务通道",
    mk: () => [],
  },
  wchlink: {
    exe: "wlink.exe",
    mk: (o) => {
      // wlink 的全局参数要放在子命令前面；--chip 可省略（自动识别）
      const chip = /^CH[0-9A-Z]+$/i.test(o.rawTarget || "") ? ["--chip", String(o.rawTarget).toUpperCase()] : [];
      if (o.action === "erase") return [...chip, "erase"];
      if (o.action === "reset") return [...chip, "reset"];
      if (o.action !== "flash") throw new Error("wlink 只支持烧录 / 擦除 / 复位");
      const a = [...chip, "flash"];
      if (/\.bin$/i.test(o.file)) a.push("-a", o.addr || "0x08000000");
      a.push(o.file);
      return a;
    },
  },
  aurix: {
    exe: "AURIXFlasher.exe",
    mk: (o) => {
      const a = ["-hex", o.file];
      if (o.target) a.push("-device", o.target);
      return a;
    },
  },
};
Object.assign(FL_TOOLS, FLASH_ROM_TOOLS);

// ---- 烧录工具路径：换电脑时可以在界面上指定，存 localStorage ----
const FL_CFG_KEYS = ["openocd", "openocd_scripts", "jlink", "stm32cli", "pyocd", "esptool", "wchlink", "aurix", "extra"];
let FL_CFG = {};
function flCfgLoad() {
  try { FL_CFG = JSON.parse(localStorage.getItem("kdock_flash_tools") || "{}") || {}; } catch (_) { FL_CFG = {}; }
  for (const k of FL_CFG_KEYS) if (typeof FL_CFG[k] !== "string") FL_CFG[k] = "";
  $("fl-tool-openocd").value = FL_CFG.openocd;
  $("fl-tool-scripts").value = FL_CFG.openocd_scripts;
  $("fl-tool-jlink").value = FL_CFG.jlink;
  $("fl-tool-stm32").value = FL_CFG.stm32cli;
  $("fl-tool-pyocd").value = FL_CFG.pyocd;
  $("fl-tool-esptool").value = FL_CFG.esptool;
  $("fl-tool-wch").value = FL_CFG.wchlink;
  $("fl-tool-aurix").value = FL_CFG.aurix;
  $("fl-extra").value = FL_CFG.extra;
}
function flCfgSave() {
  FL_CFG = {
    openocd: $("fl-tool-openocd").value.trim(),
    openocd_scripts: $("fl-tool-scripts").value.trim(),
    jlink: $("fl-tool-jlink").value.trim(),
    stm32cli: $("fl-tool-stm32").value.trim(),
    pyocd: $("fl-tool-pyocd").value.trim(),
    esptool: $("fl-tool-esptool").value.trim(),
    wchlink: $("fl-tool-wch").value.trim(),
    aurix: $("fl-tool-aurix").value.trim(),
    extra: $("fl-extra").value.trim(),
  };
  localStorage.setItem("kdock_flash_tools", JSON.stringify(FL_CFG));
}
/** 检测/校验烧录工具：结果回填到输入框，并把"找没找到/版本/来源"写到状态行 */
async function flDetectTools(clearFirst) {
  if (clearFirst) {
    for (const id of ["fl-tool-openocd", "fl-tool-scripts", "fl-tool-jlink", "fl-tool-stm32", "fl-tool-pyocd", "fl-tool-esptool", "fl-tool-wch", "fl-tool-aurix", "fl-extra"]) $(id).value = "";
  }
  flCfgSave();
  $("fl-tool-state").textContent = en("检测中…");
  try {
    flBootSet(30, "检测烧录器…");
    const r = await invoke("flash_tools", { overrides: FL_CFG });
    const seg = [];
    const map = [
      ["openocd", "fl-tool-openocd"], ["jlink", "fl-tool-jlink"], ["stm32cli", "fl-tool-stm32"],
      ["pyocd", "fl-tool-pyocd"], ["esptool", "fl-tool-esptool"], ["wchlink", "fl-tool-wch"], ["aurix", "fl-tool-aurix"],
    ];
    for (const pair of map) {
      const key = pair[0], id = pair[1];
      const t = r[key] || {};
      if (t.found) $(id).value = t.exe;
      const from = t.from === "manual" ? en("手动") : t.from === "path" ? "PATH" : en("自动找到");
      seg.push(key + (t.found ? " ✓ " + (t.version || "") + " (" + from + ")" : " ✗ " + en("没找到")));
    }
    const sc = (r.openocd || {}).scripts || "";
    if (sc) $("fl-tool-scripts").value = sc;
    seg.push("scripts" + (sc ? " ✓" : " ✗"));
    flBootSet(40, "枚举探针…");
    try {
      // 串口枚举和 pyOCD 探针查询互不依赖：并行跑，别让 Python 启动时间叠加
      const [ports, cmsis] = await Promise.all([
        invoke("list_ports").catch(() => []),
        invoke("cmsis_probe_detail").catch(() => null),
      ]);
      const das = (ports || []).find((p) => /Infineon DAS JDS/i.test(`${p.friendly || ""} ${p.description || ""}`));
      seg.push(das ? `DAS ✓ ${das.port_name}` : "DAS ✗");
      const jlink = (ports || []).find((p) => /J-?Link/i.test(`${p.friendly || ""} ${p.description || ""}`));
      seg.push(jlink ? `J-Link probe ✓ ${jlink.port_name}` : "J-Link probe ✗");
      seg.push(cmsis ? `CMSIS-DAP ✓ ${cmsis}` : "CMSIS-DAP ✗");
    } catch (_) {
      seg.push("DAS ✗");
    }
    flCfgSave();
    $("fl-tool-state").textContent = seg.join("  ·  ");
    pushSys("[烧录] 工具: " + seg.join(" | "));
  } catch (e) {
    $("fl-tool-state").textContent = "检测失败: " + e;
  }
}

function flashOpts(action) {
  return {
    tool: $("fl-tool").value,
    adapter: $("fl-adapter") ? $("fl-adapter").value : "cmsis-dap",
    iface: $("fl-iface").value,
    speed: Number($("fl-speed").value) || 4000,
    target: $("fl-target").value.trim() || "stm32f4x",
    rawTarget: $("fl-target").value.trim(),
    jlinkDev: ($("fl-target").value.trim() || "STM32F407VG").toUpperCase(),
    file: $("fl-path").value.trim(),
    addr: $("fl-addr").value.trim(),
    action,
    netHost: $("fl-netudp-host") ? $("fl-netudp-host").value.trim() : "",
    netPort: $("fl-netudp-port") ? Number($("fl-netudp-port").value) || 6666 : 6666,
    netIface: $("fl-netudp-iface") ? $("fl-netudp-iface").value || null : null,
    probe: $("fl-probe") ? $("fl-probe").value.trim() : "",
    extra: $("fl-extra") ? $("fl-extra").value.trim() : "",
    port: $("fl-rom-port") ? $("fl-rom-port").value : "",
    baud: $("fl-rom-baud") ? Number($("fl-rom-baud").value) || 460800 : 460800,
  };
}

let FL_DEVS = [];          // 合并后的器件清单：{name, desc, group, src, path?, vendor?, core?}
let FL_DEVS_SRC = "";
let FL_PICK = null;        // 当前选中的器件
let FL_JLINK_PATH = "";

const flBadge = (x) => (x.src === "jlink" ? "J-Link"
  : en(x.group === "target" ? "openocd 芯片" : x.group === "board" ? "openocd 开发板" : "openocd 适配器"));

async function flLoadDevs(quiet) {
  $("fl-dev-src").textContent = en("读取中…");
  flBootSet(50, "扫描 OpenOCD 器件库…");
  const out = [];
  const srcTxt = [];
  // 1) openocd scripts（芯片 / 开发板 / 适配器）
  try {
    const list = await invoke("flash_scripts", { kind: "all", scriptsDir: FL_CFG.openocd_scripts || null });
    const GORD = { target: 0, board: 1, interface: 2 };
    list.sort((a, b) => ((GORD[a.group] == null ? 9 : GORD[a.group]) - (GORD[b.group] == null ? 9 : GORD[b.group]))
      || String(a.name).localeCompare(String(b.name)));
    for (const x of list) out.push({ ...x, src: "openocd" });
    const n = { target: 0, board: 0, interface: 0 };
    list.forEach((x) => { n[x.group] = (n[x.group] || 0) + 1; });
    srcTxt.push(`${en("openocd：芯片")} ${n.target} / ${en("开发板")} ${n.board} / ${en("适配器")} ${n.interface}`);
    // 适配器下拉顺便用 interface 列表填
    const sel = $("fl-adapter");
    const cur = sel.value;
    sel.innerHTML = "";
    list.filter((x) => x.group === "interface").forEach((x) => {
      const o = document.createElement("option");
      o.value = x.name; o.textContent = x.name;
      sel.appendChild(o);
    });
    if (Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
  } catch (e) {
    if (!quiet) pushSys(`[烧录] openocd 器件库读取失败: ${e}`);
  }
  flBootSet(68, "枚举 J-Link / CMSIS-DAP…");
  // 2) J-Link 的 JLinkDevices.xml
  try {
    const r = await invoke("flash_jlink_devices", { path: null, exe: FL_CFG.jlink || null });
    const devs = (r && r.devices) || [];
    for (const d of devs) {
      const desc = [d.vendor, d.core, d.ram_addr ? `RAM ${d.ram_addr}/${d.ram_size}` : ""].filter(Boolean).join(" · ");
      out.push({ name: d.name, desc, group: "jlink", src: "jlink", vendor: d.vendor, core: d.core });
    }
    FL_JLINK_PATH = (r && r.path) || "";
    srcTxt.push(en("J-Link：") + devs.length + en("（") + en(String((r && r.source) || "库")) + en("）"));
    $("fl-dev-src").title = FL_JLINK_PATH ? `J-Link device DB: ${FL_JLINK_PATH}` : en("没找到 J-Link 器件库");
  } catch (e) {
    srcTxt.push(en("J-Link 器件库：没找到 JLinkDevices.xml"));
  }
  FL_DEVS = out;
  FL_DEVS_SRC = srcTxt.join("  |  ");
  flBootSet(88, "整理器件列表…");
  $("fl-dev-src").textContent = FL_DEVS_SRC;
  $("fl-dev-src").title = FL_DEVS_SRC;        // 窄窗会截断成省略号，悬停能看全
  if (!quiet) pushSys(`[烧录] ${FL_DEVS_SRC}`);
  flRenderDevs();
}

function flRenderDevs() {
  const box = $("fl-dev-list");
  if (!box) return;
  const kw = ($("fl-dev-filter").value || "").trim().toLowerCase();
  const src = $("fl-src").value;
  box.innerHTML = "";
  if (!FL_DEVS.length) {
    box.innerHTML = '<p class="hint">' + en("还没有器件库，点右上角「↻ 刷新」。") + '</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const x of FL_DEVS) {
    if (src === "jlink" ? x.src !== "jlink" : (src !== "all" && !(x.src === "openocd" && x.group === src))) continue;
    if (kw && !(x.name.toLowerCase().includes(kw) || (x.desc || "").toLowerCase().includes(kw))) continue;
    if (shown++ >= 600) break;
    const b = document.createElement("button");
    b.className = "devitem";
    b.title = x.desc || x.path || "";
    const n = document.createElement("span"); n.className = "dn"; n.textContent = x.name;
    const d = document.createElement("span"); d.className = "dd"; d.textContent = x.desc || (x.path || "");
    const g = document.createElement("span"); g.className = "badge" + (x.src === "jlink" ? " jlink" : " openocd"); g.textContent = flBadge(x);
    b.appendChild(n); b.appendChild(d); b.appendChild(g);
    b.onclick = () => flPickDev(x);
    frag.appendChild(b);
  }
  box.appendChild(frag);   // 一次性挂载，避免 600 次重排
  if (!shown) box.innerHTML = '<p class="hint">没匹配的型号（换个来源或关键字试试）。</p>';
}

/** 点器件：J-Link 器件 = 用 J-Link Commander 烧；openocd 芯片 = 目标芯片；开发板 = 读它的 cfg 反查 */
async function flPickDev(x) {
  FL_PICK = x;
  $("fl-dev-pick").textContent = x.src === "jlink" ? `J-Link · ${x.name}` : `${x.group} · ${x.name}`;
  if (x.src === "jlink") {
    $("fl-tool").value = "jlink";
    $("fl-target").value = x.name;
    flashSync();
    pushSys(`[烧录] 选 J-Link 器件：${x.name}${x.core ? " (" + x.core + ")" : ""}`);
    return toast(`J-Link 器件 = ${x.name}`);
  }
  if (x.group === "target") {
    $("fl-target").value = x.name;
    flashSync();
    pushSys(`[烧录] 选目标芯片：${x.name}`);
    return toast(`目标芯片 = ${x.name}`);
  }
  if (x.group === "interface") {
    $("fl-adapter").value = x.name;
    flashSync();
    return toast(`适配器 = ${x.name}`);
  }
  try {
    const txt = await invoke("flash_cfg_text", { path: x.path });
    const t = txt.match(/target\/([\w.\-]+)\.cfg/);
    const i = txt.match(/interface\/([\w.\-]+)\.cfg/);
    const got = [];
    if (t) { $("fl-target").value = t[1]; got.push(`芯片 ${t[1]}`); }
    if (i && Array.from($("fl-adapter").options).some((o) => o.value === i[1])) { $("fl-adapter").value = i[1]; got.push(`适配器 ${i[1]}`); }
    flashSync();
    pushSys(`[烧录] 开发板 ${x.name}：${got.join(" / ") || "里面没写 target/interface"}`);
    toast(got.length ? `开发板 ${x.name}: 已选 ${got.join(" / ")}` : `开发板 ${x.name} 里没写 target/interface，芯片得手选`);
  } catch (e) { toast("读板级 cfg 失败: " + e); }
}

function flashSync() {
  const o = flashOpts("flash");
  const t = FL_TOOLS[o.tool];
  const ui = flashToolUi(o.tool);
  for (const el of document.querySelectorAll(".fl-probe-only")) el.hidden = !ui.probe;
  if ($("fl-netudp-row")) $("fl-netudp-row").hidden = !ui.kdockOta;
  if ($("fl-rom-serial-row")) $("fl-rom-serial-row").hidden = !ui.serialRom;
  if ($("fl-rom-dfu-note")) $("fl-rom-dfu-note").hidden = !ui.dfu;
  if ($("fl-file-addr-row")) $("fl-file-addr-row").hidden = ui.kdockOta;
  if ($("fl-addr-label")) $("fl-addr-label").textContent = en(o.tool === "esprom" ? "Flash 偏移" : "地址");
  if ($("fl-rom-port")) $("fl-rom-port").disabled = !ui.serialRom;
  const hints = {
    stm32dfu: "STM32 系统 Bootloader · USB DFU：BOOT0=1 后复位/上电，使用 CubeProgrammer 的 USB1。",
    stm32uart: "STM32 系统 Bootloader · UART：BOOT0=1 后复位/上电，连接芯片指定的 USART。",
    esprom: "ESP32 / ESP8266 串口 ROM：拉低 GPIO0（BOOT）后复位；只烧 .bin，合并镜像通常从 0x0 开始。",
    netudp: "这是 KDock 自有 OTA（SVC1 + .fw），不是厂商出厂 ROM Bootloader。",
  };
  if ($("fl-route-hint")) $("fl-route-hint").textContent = en(hints[o.tool]
    || "调试探针直接通过 SWD/JTAG 写片上 Flash，不依赖设备里的 bootloader。");
  if ($("fl-fw-hint")) {
    $("fl-fw-hint").textContent = en(o.tool === "esprom"
      ? "ESP ROM 只接受 .bin；多镜像请先用 esptool merge_bin 合并，再填写合并后的起始偏移。"
      : ui.rom
        ? ".hex / .elf 自带地址；.bin 需要填写芯片 Flash 地址。此路径使用厂商出厂 ROM Bootloader。"
        : ".hex / .elf 自带地址；.bin 需填写起始地址。.fw 请在「固件升级」页使用。");
  }
  let preview = "";
  try {
    if (ui.kdockOta) preview = `KDock OTA · UDP ${o.netHost}:${o.netPort} · ${o.file || "<选择 .fw 固件>"}`;
    else if (o.tool === "jlink") preview = `${t.exe} -CommanderScript <临时脚本>\n脚本内容:\n${t.script(o)}`;
    else preview = `${t.exe} ${t.mk(o).join(" ") }`;
  } catch (e) {
    preview = `${en("配置未完成")}: ${e.message || e}`;
  }
  $("fl-cmd").textContent = preview;
}

/** 烧录日志：一行一行进，每行带行号（清空后从 1 重数） */
function flashLog(text) {
  const el = $("fl-log");
  if (!el) return;
  el.classList.toggle("with-no", logNoOn());
  const lines = String(text == null ? "" : text).split("\n");
  while (lines.length && lines[0] === "" && !el.childElementCount) lines.shift();   // 开头那个换行不留空行
  let html = "";
  for (const line of lines) html += line.trim() === "" ? logRowHtml(null, "") : logRowHtml(++flLogNo, escapeHtml(line));   // 空行不占号（跟传输页的多行日志一致）
  el.insertAdjacentHTML("beforeend", html);
  el.scrollTop = el.scrollHeight;
}

function flBootShow(text) {
  const box = $("fl-boot");
  if (!box) return;
  box.hidden = false;
  $("fl-boot-text").textContent = en(text);
  $("fl-boot-bar").style.width = "5%";
  if ($("fl-boot-pct")) $("fl-boot-pct").textContent = "5%";
}
function flBootSet(pct, text) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if ($("fl-boot-bar")) $("fl-boot-bar").style.width = `${p}%`;
  if ($("fl-boot-pct")) $("fl-boot-pct").textContent = `${p}%`;
  if ($("fl-boot-text") && text) $("fl-boot-text").textContent = en(text);
}
function flBootHide() {
  const box = $("fl-boot");
  if (box) box.hidden = true;
}
const flYield = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function flashAction(action) {
  const o = flashOpts(action);
  const t = FL_TOOLS[o.tool];
  if (isSerialRomTool(o.tool) && !o.port) return toast("先选择串口");
  if (o.tool === "esprom" && ["flash", "verify"].includes(action)) {
    if (!o.file) return toast("先选择固件文件");
    if (!/\.bin$/i.test(o.file)) return toast("ESP ROM 烧录只接受 .bin；多镜像请先合并");
  }
  if (o.tool === "netudp") {
    if (action !== "flash") return toast("UDP 网络设备只支持烧录");
    if (!o.file) return toast("先选 .fw 固件");
    if (!/\.fw$/i.test(o.file)) return toast("UDP 网络设备烧录只接受 .fw 包");
    if (!o.netHost) return toast("填目标 IP");
    $("mode").value = "udp";
    switchMode("udp");
    $("udp-local-port").value = "0";
    $("udp-remote-host").value = o.netHost;
    $("udp-remote-port").value = String(o.netPort);
    if ($("udp-iface") && o.netIface) $("udp-iface").value = o.netIface;
    await doOpen();
    const buf = await readFile(o.file);
    const name = o.file.replace(/^.*[\\/]/, "");
    pushSys(`[烧录] UDP 服务通道 ${o.netHost}:${o.netPort}，发送 ${name}`);
    await invoke("start_upgrade", { source: "local", url: "", name, data: Array.from(buf) });
    return;
  }
  if ((action === "flash" || action === "verify") && !o.file) return toast("先选固件文件");
  flashLog(`\n===== ${action} =====\n`);
  $("fl-log").classList.remove("err");
  try {
    let args = t.mk ? t.mk(o) : [];
    if (o.tool === "jlink") {
      const path0 = await invoke("write_temp_file", { name: "kdock.jlink", content: t.script(o) });
      args = ["-CommanderScript", path0, "-ExitOnError", "1"];
    }
    // 工具路径：界面上填了就用界面上的（换电脑时用），否则用默认/自动检测结果
    const exe = o.tool === "openocd" ? (FL_CFG.openocd || t.exe)
      : o.tool === "jlink" ? (FL_CFG.jlink || t.exe)
      : o.tool === "pyocd" ? (FL_CFG.pyocd || t.exe)
      : o.tool === "esprom" ? (FL_CFG.esptool || t.exe)
      : o.tool === "wchlink" ? (FL_CFG.wchlink || t.exe)
      : o.tool === "aurix" ? (FL_CFG.aurix || t.exe)
      : (FL_CFG.stm32cli || t.exe);
    if (o.tool === "openocd" && FL_CFG.openocd_scripts) args = ["-s", FL_CFG.openocd_scripts, ...args];
    if (o.extra) args = [...args, ...o.extra.split(/\s+/).filter(Boolean)];
    pushSys(`[烧录] ${o.tool} = ${exe}`);
    await invoke("flash_run", { exe, args });
  } catch (e) {
    flashLog(`启动失败: ${e}\n`);
    toast(String(e));
  }
}

function bindFlash() {
  const on = () => flashSync();
  ["fl-tool", "fl-iface", "fl-speed", "fl-target", "fl-probe", "fl-path", "fl-addr", "fl-extra", "fl-rom-port", "fl-rom-baud"].forEach((id) => {
    const el = $(id);
    if (el) { el.onchange = on; el.oninput = on; }
  });
  if ($("fl-tool")) $("fl-tool").onchange = () => {
    const tool = $("fl-tool").value;
    const addr = $("fl-addr").value.trim();
    if (tool === "esprom" && (!addr || addr === "0x08000000")) $("fl-addr").value = "0x0";
    else if (tool !== "esprom" && addr === "0x0") $("fl-addr").value = "0x08000000";
    const baud = Number($("fl-rom-baud").value) || 0;
    if (tool === "esprom" && (!baud || baud === 115200)) $("fl-rom-baud").value = "460800";
    else if (tool === "stm32uart" && (!baud || baud === 460800)) $("fl-rom-baud").value = "115200";
    if (isFlashRomTool(tool)) $("fl-dev-pick").textContent = en("ROM Bootloader");
    flashSync();
  };
  if ($("fl-rom-refresh")) $("fl-rom-refresh").onclick = refreshPorts;
  $("fl-fw").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "选择固件（.hex / .elf / .bin / .fw）", multiple: false, directory: false,
        filters: [{ name: "固件", extensions: ["hex", "elf", "bin", "fw"] }, { name: "所有文件", extensions: ["*"] }] });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      $("fl-path").value = path0;
      if (/\.bin$/i.test(path0) && !$("fl-addr").value) {
        $("fl-addr").value = $("fl-tool").value === "esprom" ? "0x0" : "0x08000000";
      }
      // 选完给个反馈：大小 + 需不需要地址
      invoke("file_size", { path: path0 }).then((n) => {
        const kb = (n / 1024).toFixed(1);
        const isBin = /\.bin$/i.test(path0);
        toast(`已选 ${path0.replace(/^.*[\\/]/, "")}（${kb} KB）${isBin ? " · bin 需要地址 " + $("fl-addr").value : " · 自带地址"}`);
        pushSys(`[烧录] 已选文件: ${path0} (${kb} KB)${isBin ? "，bin，起始地址 " + $("fl-addr").value : ""}`);
      }).catch(() => {
        toast("已选 " + path0);
        pushSys(`[烧录] 已选文件: ${path0}`);
      });
      flashSync();
    } catch (e) { toast("选文件失败: " + e); }
  };
  $("fl-do").onclick = () => flashAction("flash");
  $("fl-erase").onclick = () => flashAction("erase");
  $("fl-verify").onclick = () => flashAction("verify");
  $("fl-reset").onclick = () => flashAction("reset");
  $("fl-path").oninput = () => {
    const p = $("fl-path").value.trim();
    if (/\.bin$/i.test(p) && !$("fl-addr").value) {
      $("fl-addr").value = $("fl-tool").value === "esprom" ? "0x0" : "0x08000000";
    }
  };
  $("fl-dev-filter").oninput = flRenderDevs;
  $("fl-src").onchange = flRenderDevs;
  $("fl-dev-reload").onclick = async () => {
    flBootShow("刷新器件库…");
    try { await flLoadDevs(false); }
    finally { flBootHide(); }
  };
  $("fl-log-clear").onclick = () => { $("fl-log").innerHTML = ""; flLogNo = 0; };
  $("fl-dev-goto").onclick = () => { $("fl-dev-filter").focus(); $("fl-dev-filter").select(); };
  // 烧录工具路径：浏览 / 自动检测 / 清空
  const browseTool = (btnId, inputId, dir) => {
    $(btnId).onclick = async () => {
      try {
        const p = await dlgOpen({ title: dir ? "选择目录" : "选择可执行文件", multiple: false, directory: !!dir,
          filters: dir ? undefined : [{ name: "可执行文件", extensions: ["exe"] }, { name: "所有文件", extensions: ["*"] }] });
        if (!p) return;
        const path0 = typeof p === "string" ? p : p.path;
        $(inputId).value = path0;
        flCfgSave();
        await flDetectTools(false);
      } catch (e) { toast(String(e)); }
    };
  };
  browseTool("fl-browse-openocd", "fl-tool-openocd", false);
  browseTool("fl-browse-scripts", "fl-tool-scripts", true);
  browseTool("fl-browse-jlink", "fl-tool-jlink", false);
  browseTool("fl-browse-stm32", "fl-tool-stm32", false);
  browseTool("fl-browse-pyocd", "fl-tool-pyocd", false);
  browseTool("fl-browse-esptool", "fl-tool-esptool", false);
  browseTool("fl-browse-wch", "fl-tool-wch", false);
  browseTool("fl-browse-aurix", "fl-tool-aurix", false);
  for (const id of ["fl-tool-openocd", "fl-tool-scripts", "fl-tool-jlink", "fl-tool-stm32", "fl-tool-pyocd", "fl-tool-esptool", "fl-tool-wch", "fl-tool-aurix", "fl-extra"]) $(id).oninput = () => flCfgSave();
  $("fl-tool-detect").onclick = () => flDetectTools(false);
  $("fl-tool-clear").onclick = () => flDetectTools(true);
  flashSync();
  flCfgLoad();
  // 工具检测 + 器件库（要跑 `openocd --version`、甚至让 JLink.exe 导出器件库，很慢）
  // 改成**第一次打开「烧录」页**时才做，别拖慢启动 —— 见 flashBootstrap()
}

let flashBootstrapped = false;
/** 首次进「烧录」页时才做的重活：找烧录工具 → 拉器件库（J-Link 那步会真的起 JLink.exe） */
function flashBootstrap() {
  if (flashBootstrapped) return;
  flashBootstrapped = true;
  (async () => {
    flBootShow("准备烧录工具…");
    await flYield();
    flBootSet(18, "检测烧录器…");
    await flDetectTools(false);
    await flYield();
    flBootSet(48, "扫描 openocd 器件库…");
    await flYield();
    await flLoadDevs(true);
    flLoadPyocdTargets();            // 后台补 pyOCD 芯片名，不拖慢进度条
    flBootSet(92, "整理器件列表…");
    await flYield();
    flBootSet(100, "器件库就绪");
    await new Promise((r) => setTimeout(r, 250));
    flBootHide();
  })().catch((e) => {
    flBootSet(100, "加载失败: " + e);
    pushSys("[烧录] 器件库加载失败: " + e);
    setTimeout(flBootHide, 1200);
  });
}

let flPyocdLoaded = false;
/** pyOCD 的芯片名和 OpenOCD 的 cfg 名不是一套，挂成 datalist 供目标芯片输入联想。 */
async function flLoadPyocdTargets() {
  if (flPyocdLoaded) return;
  flPyocdLoaded = true;
  try {
    const list = await invoke("pyocd_targets", { exe: FL_CFG.pyocd || null });
    const dl = $("fl-pyocd-targets");
    if (!dl || !Array.isArray(list) || !list.length) return;
    const frag = document.createDocumentFragment();
    for (const t of list) {
      const o = document.createElement("option");
      o.value = t.name;
      o.label = t.vendor || "pyOCD";
      frag.appendChild(o);
    }
    dl.appendChild(frag);
  } catch (_) { flPyocdLoaded = false; }
}

// ---------------- 示波器：SCPI（Rigol DS1000Z 那套） ----------------
let scPlot = null;
let scWaves = {};           // ch -> { x: [], y: [] }
let scInfo = null;          // scope_info 的结果
let scShotData = null;      // 最近一次截屏 { path, dataUrl, bytes }
let scMeasTimer = null;
let scWaveTimer = null;
let scView = "wave";

const SC_COLORS = { 1: "#ffc857", 2: "#4f8cff", 3: "#3ddc97", 4: "#ff6b6b" };
const SC_SCALES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const SC_TB = [1e-9, 2e-9, 5e-9, 1e-8, 2e-8, 5e-8, 1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5,
               1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1];
// 测量项（短名 → 中文名）；单位/小数位统一在 scMeasValue 里定
const SC_MEAS_ITEMS = [["FREQ", "频率"], ["PER", "周期"], ["VPP", "峰峰值"], ["VMAX", "最大值"],
                       ["VMIN", "最小值"], ["VAVG", "平均值"], ["VRMS", "有效值"], ["VTOP", "顶电平"],
                       ["VBASE", "底电平"], ["RTIM", "上升时间"], ["FTIM", "下降时间"],
                       ["PDUT", "正占空"], ["NDUT", "负占空"]];

/** 秒 → 顺眼的单位（时基、周期、跨度都用它） */
function scFmtTime(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1) return v.toFixed(4) + " s";
  if (a >= 1e-3) return (v * 1e3).toFixed(4) + " ms";
  if (a >= 1e-6) return (v * 1e6).toFixed(4) + " µs";
  return (v * 1e9).toFixed(1) + " ns";
}

/** 伏 → 顺眼的单位（档位显示用） */
function scFmtV(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1) return (v === Math.round(v) ? v.toFixed(0) : v.toFixed(2)) + " V";
  return (v * 1e3).toFixed(0) + " mV";
}

/** 测量项的显示值；null = 这一路没信号 / 测不到 */
function scMeasValue(item, v) {
  if (v == null) return "—";
  switch (item) {
    case "FREQ": return v >= 1000 ? (v / 1e3).toFixed(4) + " kHz" : v.toFixed(4) + " Hz";
    case "PER": case "RTIM": case "FTIM": return scFmtTime(v);
    case "PDUT": case "NDUT": return v.toFixed(2) + " %";
    default: return v.toFixed(4) + " V";
  }
}

/** 这页现在露着吗（自动刷新只在露着的时候干活） */
function scPaneVisible() {
  const p = document.querySelector('[data-work="scope"]');
  return !!p && !p.hidden;
}

function scRow(k, v, cls) {
  const r = document.createElement("div");
  r.className = "row";
  const a = document.createElement("span");
  a.className = "k"; a.textContent = k;
  const b = document.createElement("span");
  b.className = "v" + (cls ? " " + cls : "");
  b.textContent = v;
  r.append(a, b);
  return r;
}

function scStatus(t, cls) {
  const el = $("sc-state");
  if (el) {
    el.textContent = t;
    el.className = "dot" + (cls ? " " + cls : "");
  }
  const stage = $("sc-stage-status");
  if (stage) {
    stage.textContent = t;
    stage.className = "scopelive" + (cls ? " " + cls : "");
  }
}

/** SCPI 控制台的记录（只留最后 80 条，免得越堆越多） */
let scLogLines = [];
function scLog(line) {
  scLogLines.push(line);
  if (scLogLines.length > 80) scLogLines = scLogLines.slice(-80);
  const box = $("sc-log");
  if (!box) return;
  box.textContent = scLogLines.join("\n");
  box.scrollTop = box.scrollHeight;
}

/** 通道下拉（测量通道 / 触发源）按机型能拿到几个通道就填几个 */
function scChannelNumbers() {
  const chs = (scInfo && scInfo.channels) || [];
  return chs.length ? chs.map((c) => c.n) : [1, 2];
}

function scFillSelects() {
  const chans = scChannelNumbers();
  const meas = $("sc-meas-ch");
  if (meas && scInfo) {
    const old = Number(meas.value) || 0;
    meas.innerHTML = "";
    for (const n of chans) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = "CH" + n;
      meas.appendChild(o);
    }
    const opened = (scInfo.channels || []).filter((c) => c.display).map((c) => c.n);
    const want = chans.includes(old) ? old : (opened[0] || chans[0]);
    meas.value = String(want);
  }
  const src = $("sc-trig-src");
  if (src && scInfo) {
    src.innerHTML = "";
    for (const n of chans) {
      const o = document.createElement("option");
      o.value = "CHAN" + n;
      o.textContent = "CH" + n;
      src.appendChild(o);
    }
    const cur = (scInfo.trigger && scInfo.trigger.source) || "";
    if (cur) src.value = cur;
  }
  const tb = $("sc-tb");
  if (tb && !tb.options.length) {
    for (const v of SC_TB) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = scFmtTime(v) + "/div";
      tb.appendChild(o);
    }
  }
  if (tb && scInfo && scInfo.timebase) {
    // 档位是 1-2-5 序列，浮点相等靠不住：挑对数上最近的那个
    let best = null, bestD = Infinity;
    for (const o of tb.options) {
      const d = Math.abs(Math.log(Number(o.value) / scInfo.timebase));
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best) tb.value = best.value;
  }
  const lev = $("sc-trig-lev");
  if (lev && scInfo && scInfo.trigger && scInfo.trigger.level != null && document.activeElement !== lev) {
    lev.value = String(Number(scInfo.trigger.level.toFixed(3)));
  }
}

function scRenderInfo() {
  const box = $("sc-info");
  if (!box) return;
  box.innerHTML = "";
  if (!scInfo) {
    box.appendChild(scRow(en("状态"), en("还没连上（点上面的「连接」）"), "warn"));
    if ($("sc-model")) $("sc-model").textContent = "";
    return;
  }
  if ($("sc-model")) $("sc-model").textContent = scInfo.model || "";
  box.appendChild(scRow(en("型号"), scInfo.idn || "?"));
  box.appendChild(scRow(en("时基"), scFmtTime(scInfo.timebase) + " /div"));
  box.appendChild(scRow(en("采样率"), scInfo.sample_rate ? scInfo.sample_rate.toExponential(3) + " Sa/s" : "—"));
  if (scInfo.memory_depth && String(scInfo.memory_depth).trim()) {
    box.appendChild(scRow(en("存储深度"), String(scInfo.memory_depth).trim()));
  }
  const t = scInfo.trigger || {};
  box.appendChild(scRow(en("触发"),
    `${t.source || "?"} · ${t.level != null ? t.level.toFixed(3) + " V" : "—"} · ${t.sweep || "?"} · ${t.status || "?"}`));
}

/** 通道卡片：显示开关 / 档位 / 偏移 / 应用 */
function scRenderChannels() {
  const box = $("sc-channels");
  if (!box) return;
  box.innerHTML = "";
  if (!scInfo) {
    box.innerHTML = '<p class="hint">' + en("连上之后这里会列出通道。") + "</p>";
    return;
  }
  for (const c of scInfo.channels) {
    const card = document.createElement("div");
    card.className = "scchan" + (c.display ? "" : " off");
    const head = document.createElement("div");
    head.className = "scchan-head";
    const nm = document.createElement("b");
    nm.textContent = "CH" + c.n;
    nm.style.color = SC_COLORS[c.n] || "";
    const state = document.createElement("span");
    state.className = "lb";
    state.textContent = c.display ? en("开") : en("关");
    const sp = document.createElement("span");
    sp.className = "grow";
    const cbx = document.createElement("input");
    cbx.type = "checkbox";
    cbx.checked = !!c.display;
    const lbl = document.createElement("label");
    lbl.className = "chk";
    lbl.append(cbx, document.createTextNode(en("显示")));
    head.append(nm, state, sp, lbl);
    card.appendChild(head);

    const row = document.createElement("div");
    row.className = "trow";
    const sel = document.createElement("select");
    sel.className = "tight grow";
    for (const v of SC_SCALES) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = scFmtV(v) + "/div";
      sel.appendChild(o);
    }
    if (c.scale) {
      sel.value = String(SC_SCALES.reduce((a, b) => (Math.abs(b - c.scale) < Math.abs(a - c.scale) ? b : a)));
    }
    const off = document.createElement("input");
    off.type = "number";
    off.className = "num";
    off.step = "0.1";
    off.style.width = "76px";
    off.value = c.offset != null ? c.offset : 0;
    off.title = en("垂直偏移（V）");
    const ap = document.createElement("button");
    ap.className = "btn small";
    ap.textContent = en("应用");
    row.append(sel, off, ap);
    card.appendChild(row);
    if (c.coupling || c.probe) {
      const extra = document.createElement("div");
      extra.className = "lb";
      extra.textContent = `${c.coupling || ""}${c.probe ? " · " + en("探头") + " " + c.probe.toFixed(0) + "x" : ""}`;
      card.appendChild(extra);
    }
    const apply = async () => {
      try {
        await invoke("scope_control", {
          args: { channel: c.n, display: cbx.checked, scale: Number(sel.value), offset: Number(off.value) },
        });
        await scRefreshInfo(true);
      } catch (e) { toast(String(e)); }
    };
    ap.onclick = apply;
    cbx.onchange = apply;
    box.appendChild(card);
  }
}

async function scRefreshInfo(silent) {
  if (!silent) scStatus(en("读取状态…"));
  try {
    scInfo = await invoke("scope_info");
    scStatus(scInfo.model || en("已连接"), "ok");
    scRenderInfo();
    scRenderChannels();
    scFillSelects();
  } catch (e) {
    scStatus(en("读不到状态"), "err");
    scLog(String(e));
    if (!silent) toast(String(e));
  }
}

/** 自动测量：一次读全 13 项（测不到的项显示 —） */
/** 示波器的 socket 同时只认一个客户端：被别人抢走、或者它自己把空闲连接断了，
 *  就会突然"还没连接"。这里自动连回去一次（用页面上填的 IP/端口）。 */
let scReconnecting = false;
async function scAutoReconnect() {
  if (scReconnecting) return false;
  scReconnecting = true;
  try {
    // 默认值只做占位，别写死某个具体机器（仓库是公开的）
    const host = ($("sc-host").value || "").trim() || "192.168.1.100";
    const port = Number($("sc-port").value) || 5555;
    const idn = await invoke("scope_open", { host, port });
    scLog(`自动重连 ${host}:${port} → ${idn}`);
    scStatus(idn || en("已连接"), "ok");
    return true;
  } catch (e) {
    scLog("自动重连失败：" + String(e));
    return false;
  } finally {
    scReconnecting = false;
  }
}

/** 掉线了就先连回来，再把这个动作重做一次 */
async function scRetryOnDrop(e, again) {
  if (!/还没连接|没连接/.test(String(e))) return false;
  if (!(await scAutoReconnect())) return false;
  try { await again(); return true; } catch (e2) { toast(String(e2)); return false; }
}

async function scMeasureNow() {
  const box = $("sc-meas-out");
  if (!box) return;
  if (window.__scMeasBusy) return;      // 连续模式 2 秒一次，别叠起来
  window.__scMeasBusy = true;
  const ch = Number($("sc-meas-ch").value) || 1;
  try {
    await scMeasureNow2(ch, box);
  } catch (e) {
    if (!(await scRetryOnDrop(e, () => scMeasureNow2(ch, box)))) {
      box.innerHTML = "";
      box.appendChild(scRow(en("出错"), String(e), "bad"));
    }
  } finally {
    window.__scMeasBusy = false;
  }
}

/** 测量渲染本体（单独拆出来，方便掉线重连后重做一次） */
async function scMeasureNow2(ch, box) {
  const items = SC_MEAS_ITEMS.map(([k]) => k);
  const r = await invoke("scope_measure", { channel: ch, items });
  const m = (r && r.items) || {};
  box.innerHTML = "";
  for (const [k, name] of SC_MEAS_ITEMS) {
    const key = k === "RTIM" ? "RIS" : k === "FTIM" ? "FALL" : k;
    const v = m[key];
    box.appendChild(scRow(en(name), scMeasValue(k, v == null ? null : Number(v)), v == null ? "" : "ok"));
  }
}

/** 读波形：开着的通道各读一份（点数 >1200 自动走深存储） */
async function scReadWave() {
  const st = $("sc-wave-state");
  if (window.__scWaveBusy) return;      // 自动刷新别和手点叠在一起
  window.__scWaveBusy = true;
  const points = Number($("sc-wave-points").value) || 1200;
  const mode = points > 1200 ? "RAW" : "NORM";
  const chans = scInfo && scInfo.channels ? scInfo.channels.filter((c) => c.display).map((c) => c.n) : [1];
  if (!chans.length) { window.__scWaveBusy = false; toast(en("示波器上现在没有打开的通道")); return; }
  if (st) st.textContent = en("读取中…");
  try {
    await scReadWave2(chans, points, mode, st);
  } catch (e) {
    if (!(await scRetryOnDrop(e, () => scReadWave2(chans, points, mode, st)))) {
      if (st) st.textContent = "";
      toast(String(e));
    }
    if (points > 1200) $("sc-wave-points").value = "1200";   // 深存储读不动就退回屏幕数据
  } finally {
    window.__scWaveBusy = false;
  }
}

/** 读波形的本体（掉线重连后要能重做一次，所以单独拆出来） */
async function scReadWave2(chans, points, mode, st) {
  const t0 = Date.now();
  const next = {};
  for (const n of chans) {
    const d = await invoke("scope_waveform", { channel: n, points, mode });
    next[n] = { x: d.x || [], y: d.y || [], acquired: d.acquired, stride: d.stride };
  }
  scWaves = next;
  scSetView("wave");
  scDraw();
  const first = next[chans[0]] || { y: [] };
  const acq = first.acquired || first.y.length;
  if (st) st.textContent = `${acq} ${en("点")} · ${Date.now() - t0} ms`;
  if (mode === "RAW" && acq < points) {
    // 存储深度是 AUTO 的时候，深存储也只给屏幕那 1200 点 —— 说清楚，别让人以为读坏了
    toast(`${en("示波器只给了")} ${acq} ${en("点（存储深度 AUTO）；想真深存储：先在示波器上按 STOP，把存储深度调大")}`);
  }
}

function scResizePlot() {
  const box = $("sc-plot");
  if (!scPlot || !box) return;
  scPlot.setSize({ width: box.clientWidth || 600, height: box.clientHeight || 300 });
}

/** 画波形：一个通道一条线（颜色跟通道卡片一致），鼠标悬停看读数 */
function scDraw() {
  const box = $("sc-plot");
  if (!box) return;
  const nums = Object.keys(scWaves).map(Number).sort((a, b) => a - b);
  const empty = $("sc-empty");
  if (empty) empty.hidden = nums.length > 0;
  if (!nums.length) return;
  const w = box.clientWidth || 600, h = box.clientHeight || 300;
  const base = scWaves[nums[0]];
  const data = [base.x];
  const series = [{ label: "t", value: (u, v) => (v == null ? "—" : scFmtTime(v)) }];
  for (const n of nums) {
    const d = scWaves[n];
    const y = new Array(base.x.length);
    for (let i = 0; i < base.x.length; i++) y[i] = d.y[i] == null ? null : d.y[i];
    data.push(y);
    series.push({
      label: "CH" + n,
      stroke: SC_COLORS[n] || "#4f8cff",
      width: 1.6,
      value: (u, v) => (v == null ? "—" : v.toFixed(4) + " V"),
    });
  }
  if (scPlot) scPlot.destroy();
  scPlot = new uPlot({
    width: w, height: h, series,
    axes: [
      { stroke: "#8b98a8", grid: { stroke: "rgba(139,152,168,.15)" }, values: (u, sp) => sp.map(scFmtTime) },
      { stroke: "#8b98a8", grid: { stroke: "rgba(139,152,168,.15)" }, size: 56,
        values: (u, sp) => sp.map((v) => v.toFixed(3)) },
    ],
    legend: { show: true, live: true },
    cursor: { points: { size: 6 } },
  }, data, box);
}

/** 波形 / 截屏 两个视图来回切 */
function scSetView(name) {
  scView = name;
  if ($("sc-plot-wrap")) $("sc-plot-wrap").hidden = name !== "wave";
  if ($("sc-plot")) $("sc-plot").hidden = name !== "wave";
  if ($("sc-shot")) $("sc-shot").hidden = name !== "shot";
  if ($("sc-shot-bar")) $("sc-shot-bar").hidden = name !== "shot" || !scShotData;
  if ($("sc-empty")) $("sc-empty").hidden = name !== "wave" || Object.keys(scWaves).length > 0;
  if ($("sc-view-wave")) $("sc-view-wave").classList.toggle("primary", name === "wave");
  if ($("sc-view-shot")) $("sc-view-shot").classList.toggle("primary", name === "shot");
  if (name === "wave") scResizePlot();
}

/** 截屏：后端读 TMC 里的二进制 PNG、存文件，这里直接显示（CSP 允许 data:） */
async function scShotGo() {
  try {
    const r = await invoke("scope_screenshot", {});
    scShotData = r;
    const img = $("sc-shot");
    img.src = r.dataUrl;
    img.hidden = false;
    // 只显示文件名（完整路径放 title）：界面上没必要铺一串本地路径
    const short = String(r.path || "").split(/[\\/]/).pop() || "(截图)";
    $("sc-shot-info").textContent = `${short} · ${(r.bytes / 1024).toFixed(1)} KB`;
    $("sc-shot-info").title = r.path || "";
    scSetView("shot");
    scLog(`截屏 → ${r.path}`);
  } catch (e) { toast(String(e)); }
}

async function scShotSave() {
  if (!scShotData) return;
  try {
    const p = await dlgSave({
      title: en("保存示波器截屏"), defaultPath: "scope.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!p) return;
    const saved = await invoke("scope_save_png", {
      path: typeof p === "string" ? p : p.path, dataUrl: scShotData.dataUrl,
    });
    toast(en("已保存：") + saved);
  } catch (e) { toast(String(e)); }
}

async function scAsk(cmd) {
  const r = await invoke("scope_cmd", { cmd });
  pushSys(`[示波器] ${cmd} -> ${r || "(无回复)"}`);
  return r;
}

function bindScope() {
  $("sc-open").onclick = async () => {
    const host = $("sc-host").value.trim();
    const port = Number($("sc-port").value) || 5555;
    scStatus(en("连接中…"));
    try {
      const idn = await invoke("scope_open", { host, port });
      scStatus(idn || en("已连接"), "ok");
      scLog(`已连接 ${host}:${port} → ${idn}`);
      pushSys(`[示波器] 已连接: ${idn}`);
      devHistRemember("sc-host", host);
      devHistRemember("sc-port", String(port));
      await new Promise((r) => setTimeout(r, 150));   // 让示波器把命令队列消化一下
      await scRefreshInfo(true);
      if (!scInfo) { await new Promise((r) => setTimeout(r, 500)); await scRefreshInfo(true); }
      if (!scInfo) toast(en("连上了，但状态没读到（示波器在忙？再点一次「连接」）"));
      await scMeasureNow();
    } catch (e) {
      scStatus(en("连接失败"), "err");
      toast(String(e));
      scLog(String(e));
      pushSys(`[示波器] ${e}`);
    }
  };
  $("sc-close").onclick = async () => {
    await invoke("scope_close").catch(() => {});
    scStatus(en("未连接"));
    scInfo = null;
    scWaves = {};
    if (scPlot) { scPlot.destroy(); scPlot = null; }
    scRenderInfo();
    scRenderChannels();
  };
  $("sc-idn").onclick = () => scAsk("*IDN?").catch((e) => toast(String(e)));
  $("sc-send").onclick = () => {
    const c = $("sc-cmd").value.trim();
    if (c) scAsk(c).catch((e) => { toast(String(e)); scLog(String(e)); });
  };
  $("sc-meas").onclick = () => scMeasureNow();
  $("sc-meas-auto").onchange = (e) => {
    if (scMeasTimer) { clearInterval(scMeasTimer); scMeasTimer = null; }
    if (e.target.checked) scMeasTimer = setInterval(() => { if (scPaneVisible()) scMeasureNow(); }, 2000);
  };
  $("sc-meas-ch").onchange = () => { if ($("sc-meas-auto").checked) scMeasureNow(); };
  $("sc-wave").onclick = () => scReadWave();
  $("sc-wave-auto").onchange = (e) => {
    if (scWaveTimer) { clearInterval(scWaveTimer); scWaveTimer = null; }
    if (e.target.checked) scWaveTimer = setInterval(() => { if (scPaneVisible()) scReadWave(); }, 2000);
  };
  $("sc-wave-points").onchange = () => { if (scWaveTimer) scReadWave(); };
  $("sc-view-wave").onclick = () => scSetView("wave");
  $("sc-view-shot").onclick = () => scSetView("shot");
  $("sc-shot-btn").onclick = () => scShotGo();
  $("sc-shot-save").onclick = () => scShotSave();
  $("sc-tb-apply").onclick = async () => {
    try {
      await invoke("scope_control", { args: { timebase: Number($("sc-tb").value) } });
      toast(en("时基已改"));
      await scRefreshInfo(true);
    } catch (e) { toast(String(e)); }
  };
  $("sc-trig-apply").onclick = async () => {
    try {
      await invoke("scope_control", {
        args: { trigger_source: $("sc-trig-src").value, trigger_level: Number($("sc-trig-lev").value) },
      });
      toast(en("触发已改"));
      await scRefreshInfo(true);
    } catch (e) { toast(String(e)); }
  };
  $("sc-run").onclick = () => invoke("scope_control", { args: { run: true } })
    .then(() => { toast("RUN"); return scRefreshInfo(true); }).catch((e) => toast(String(e)));
  $("sc-stop").onclick = () => invoke("scope_control", { args: { run: false } })
    .then(() => { toast("STOP"); return scRefreshInfo(true); }).catch((e) => toast(String(e)));
  $("sc-aut").onclick = async () => {
    try {
      toast(en("自动设置中…（示波器要几秒）"));
      await invoke("scope_control", { args: { autoset: true } });
      await scRefreshInfo(true);
      await scReadWave();
      await scMeasureNow();
    } catch (e) { toast(String(e)); }
  };
  scRenderInfo();
  scRenderChannels();
}

// ---------------- 屏幕捕获：DXGI 抓屏 → JPEG → 显示 ----------------
// 后端给的是**原始分辨率**的 JPEG；1:1 模式就让 img 用原始尺寸放在 overflow:hidden 的
// 容器里（窗口没那么大时自然只露左上角），"适应窗口"模式给容器加 .fit 让 img 缩放进窗口。
let capImg = null;
let capLatest = null;
let capApplying = false;
let capFrames = 0;
let capFpsT0 = 0;
let capFps = 0;
let capRunning = false;
let capSession = 0;        // 当前这一路捕获的会话号（后端每开一路给一个）
let capRefresh = null;     // 枚举显示器的函数（第一次进「屏幕共享」页才跑）
let capBackend = "desktop";     // desktop（DXGI）| rs（VNC / RTSP / RTMP / H.264）
let capWH = { w: 0, h: 0 };     // 最近一帧的原始尺寸（VNC 回传坐标要用它换算）
let capFs = false;              // 是不是全屏中
let capWanted = false;          // 这一次"开始"我们还在等后端把会话号给我们

/** 事件是不是属于"当前这一次"的？
 *  后端的线程一起就会发事件（错误/首帧），那时候 rs_open 的返回值还没回到 JS，
 *  我们手里的会话号还是 0 —— 所以"还没拿到号"的那一小段时间要**先收下**，
 *  否则第一个错误（比如 VNC 密码不对）会被当成旧会话丢掉，界面一直卡在"连接中…"。 */
function capEventMine(p) {
  if (!capWanted) return false;
  const sid = Number(p && p.session) || 0;
  if (!sid) return true;
  return !capSession || sid === capSession;
}

/** 当前的"来源"：desktop / vnc / rtsp / rtmp / h264 */
function capSrcName() { return $("cap-src").value; }
const CAP_SRC_LABEL = { desktop: "本机桌面", vnc: "VNC", rtsp: "RTSP", rtmp: "RTMP", h264: "H.264" };
const CAP_SRC_BACKEND = { desktop: "desktop", vnc: "rs", rtsp: "rs", rtmp: "rs", h264: "rs" };

/** 切来源：显示/隐藏各组字段，工具栏标签也跟着变 */
function capSetSrc(src) {
  capBackend = CAP_SRC_BACKEND[src] || "desktop";
  document.querySelectorAll("[data-caps]").forEach((el) => {
    el.hidden = !String(el.dataset.caps || "").split(/\s+/).includes(src);
  });
  if ($("cap-src-label")) $("cap-src-label").textContent = en(CAP_SRC_LABEL[src] || src);
  if ($("cap-ctl-wrap")) $("cap-ctl-wrap").hidden = src !== "vnc";
  const view = $("cap-view");
  if (view) view.classList.toggle("remote", capBackend === "rs" && src === "vnc");
}

/** rs_open 的参数（VNC / RTSP / RTMP / H.264 共用） */
function capRsArgs() {
  const src = capSrcName();
  const [sw, sh] = String($("cap-size").value || "1280x720").split("x").map(Number);
  const scale = Number($("cap-scale").value) || 1;
  const base = {
    kind: src === "vnc" ? "vnc" : src,
    fps: Number($("cap-fps").value) || 8,
    quality: Number($("cap-q").value) || 70,
    scale,
  };
  if (src === "vnc") {
    return { ...base, host: $("cap-vnc-host").value.trim(), port: Number($("cap-vnc-port").value) || 5900,
      password: $("cap-vnc-pass").value, viewOnly: !($("cap-ctl") && $("cap-ctl").checked) };
  }
  const url = src === "rtsp" ? $("cap-rtsp-url").value.trim()
    : src === "rtmp" ? $("cap-rtmp-url").value.trim()
    : $("cap-h264-url").value.trim();
  return { ...base, url, sizeW: sw || 1280, sizeH: sh || 720,
    transport: src === "rtsp" ? $("cap-rtsp-tr").value : "auto" };
}

function capState(t, cls) {
  $("cap-state").textContent = t;
  $("cap-state").className = "dot" + (cls ? " " + cls : "");
}

function capApplyLatest() {
  if (!capImg || !capLatest) { capApplying = false; return; }
  const f = capLatest;
  capLatest = null;
  capWH = { w: Number(f.w) || 0, h: Number(f.h) || 0 };
  capImg.src = "data:image/jpeg;base64," + f.data;
  capFrames += 1;
  const now = Date.now();
  if (now - capFpsT0 >= 500) {              // 半秒一算，别等一秒（首帧不至于显示 0.0）
    capFps = capFrames * 1000 / (now - capFpsT0);
    capFrames = 0;
    capFpsT0 = now;
  }
  const fpsTxt = capFps >= 0.1 ? `${capFps.toFixed(1)} fps` : "统计中…";
  if (capRunning) capState(`${f.w}x${f.h} · ${fpsTxt} · ${Math.round(f.bytes / 1024)} KB/帧`, "ok");
  // 下一帧用 rAF 应用：一来跟渲染节奏对齐，二来**自动丢旧帧**（抓得比画得快时不积压）
  requestAnimationFrame(() => { capApplying = false; if (capLatest) { capApplying = true; capApplyLatest(); } });
}

/** 统一入口：桌面捕获（capture://frame）和远端画面（rs://frame）都走这里 */
function capPushFrame(f) {
  capLatest = f;
  if (!capApplying && capImg) { capApplying = true; capApplyLatest(); }
}

/** 把当前这一帧另存为 PNG（走 canvas 转 PNG，复用后端那个"写 PNG"命令） */
async function capSaveShot() {
  const img = $("cap-view") && $("cap-view").querySelector("img");
  if (!img || !img.src.startsWith("data:")) { toast(en("还没有画面可存")); return; }
  const picked = await dlgSave({ title: en("把当前画面另存为"), defaultPath: "kdock-screen.png",
    filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!picked) return;
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth || capWH.w || 1;
  cv.height = img.naturalHeight || capWH.h || 1;
  cv.getContext("2d").drawImage(img, 0, 0);
  try {
    const path = await invoke("scope_save_png", { path: picked, dataUrl: cv.toDataURL("image/png") });
    toast(en("已保存：") + path);
    pushSys("[屏幕共享] 画面已保存：" + path);
  } catch (e) { toast(String(e)); }
}

/** 全屏：窗口级全屏 + 隐藏我们的标题栏/导航（Esc / F11 退出） */
async function capSetFullscreen(on) {
  capFs = !!on;
  try { await invoke("win_ctl", { action: on ? "fullscreen" : "unfullscreen" }); } catch (_) {}
  document.documentElement.dataset.fs = on ? "1" : "0";
  const hint = $("cap-fs-hint");
  if (hint) hint.hidden = !on;
  if ($("cap-fs")) $("cap-fs").textContent = on ? en("⛶ 退出全屏") : en("⛶ 全屏");
  setTimeout(() => { if (capRunning && capBackend === "desktop") capRefresh && 0; }, 50);
}

/** 画面上的鼠标 → VNC PointerEvent：把浏览器坐标换算成远端帧坐标 */
function capRemoteXY(ev) {
  const img = $("cap-view") && $("cap-view").querySelector("img");
  if (!img || !capWH.w || !capWH.h) return null;
  const box = img.getBoundingClientRect();
  const iw = capWH.w, ih = capWH.h;
  // object-fit: contain —— 先算出真实显示的内容区（可能有黑边）
  const k = Math.min(box.width / iw, box.height / ih);
  const cw = iw * k, ch = ih * k;
  const ox = box.left + (box.width - cw) / 2, oy = box.top + (box.height - ch) / 2;
  let x = Math.round((ev.clientX - ox) / k);
  let y = Math.round((ev.clientY - oy) / k);
  x = Math.max(0, Math.min(iw - 1, x));
  y = Math.max(0, Math.min(ih - 1, y));
  return { x, y };
}

/** 浏览器按键 → X11 keysym（VNC 键事件用） */
function capKeysym(e) {
  const k = e.key;
  const sp = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, " ": 0x20,
    Delete: 0xffff, Insert: 0xff63, Home: 0xff50, End: 0xff57,
    PageUp: 0xff55, PageDown: 0xff56, ArrowLeft: 0xff51, ArrowUp: 0xff52,
    ArrowRight: 0xff53, ArrowDown: 0xff54, Shift: 0xffe1, Control: 0xffe3,
    Alt: 0xffe9, Meta: 0xffeb, CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14,
    ContextMenu: 0xff67, PrintScreen: 0xff61, Pause: 0xff13,
  };
  if (sp[k] != null) return sp[k];
  if (/^F\d{1,2}$/.test(k)) return 0xffbe + (Number(k.slice(1)) - 1);
  if (k.length === 1) {
    const cp = k.codePointAt(0);
    return cp <= 0xff ? cp : cp <= 0xffff ? cp : 0x01000000 + cp;   // Unicode → keysym
  }
  return 0;
}

function capCtlOn() { return $("cap-ctl") && $("cap-ctl").checked; }
let capBtnMask = 0;
function capSendPointer(ev, mask) {
  if (!capRunning || capSrcName() !== "vnc" || !capCtlOn()) return;
  const p = capRemoteXY(ev);
  if (!p) return;
  invoke("rs_pointer", { id: capSession, x: p.x, y: p.y, mask: mask == null ? capBtnMask : mask }).catch(() => {});
}

async function capStopShared(quiet) {
  capRunning = false;
  capWanted = false;
  const sid = capSession;
  capSession = 0;
  if (capBackend === "desktop") await invoke("capture_stop").catch(() => {});
  else if (sid) await invoke("rs_stop", { id: sid }).catch(() => {});
  if (!quiet) { capState(en("已停止")); pushSys("[屏幕共享] 已停止"); }
}

async function bindCapture() {
  const view = $("cap-view");
  view.innerHTML = '<div class="placeholder">点右边【开始】后这里显示屏幕画面</div>';
  const refresh = async () => {
    try {
      const list = await invoke("capture_list");
      const sel = $("cap-mon");
      sel.innerHTML = "";
      list.forEach((m) => {
        const o = document.createElement("option");
        o.value = String(m.id);
        o.textContent = en("显示器 ") + (m.id + 1) + " · " + m.width + "x" + m.height;
        sel.appendChild(o);
      });
      if (!list.length) sel.innerHTML = '<option value="0">' + en("（没找到显示器）") + '</option>';
    } catch (e) {
      $("cap-mon").innerHTML = `<option value="0">${e}</option>`;      // e 已经过 en()
    }
  };
  $("cap-start").onclick = async () => {
    try {
      await capStopShared(true);                  // 先把上一路停干净（它的收尾事件不该串到这一次）
      await new Promise((r) => setTimeout(r, 150));
      view.classList.toggle("fit", $("cap-mode").value === "fit");
      view.innerHTML = "";
      capImg = document.createElement("img");
      view.appendChild(capImg);
      capRunning = true;
      capWanted = true;                           // 后端线程一启动就会推事件，先"开门收着"
      capFrames = 0; capFpsT0 = Date.now();
      // 会话号：后端每开一路捕获就给一个，帧/出错/停止事件都带着它。
      // 上一路线程退出时也会发 stopped，必须按会话过滤 —— 否则"先开 1 号屏、再开 2 号屏"
      // 时，1 号屏线程退出的那个 stopped 会把刚起来的 2 号屏顶成"已停止"（画面却还在刷）。
      capSession = 0;
      // 注意：capture_start 直接返回会话号；rs_open 返回的是 {id,label,…} 这个对象
      // （曾经这里统一按数字取，rs 那路取到 NaN → 会话号一直是 0 → 键鼠回传全被后端拒掉）
      const sid = capBackend === "desktop"
        ? await invoke("capture_start", {
            monitor: Number($("cap-mon").value) || 0,
            fps: Number($("cap-fps").value) || 8,
            quality: Number($("cap-q").value) || 70,
          })
        : (await invoke("rs_open", capRsArgs())).id;
      capSession = Number(sid) || 0;
      capState(capBackend === "desktop" ? "采集中…" : "连接中…", "ok");
      pushSys(capBackend === "desktop"
        ? `[屏幕共享] 桌面开始（显示器 ${$("cap-mon").value}，${$("cap-fps").value}fps，画质 ${$("cap-q").value}）`
        : `[屏幕共享] ${CAP_SRC_LABEL[capSrcName()]} 开始：${capRsArgs().url || $("cap-vnc-host").value}`);
    } catch (e) {
      capRunning = false;
      capState(en("启动失败: ") + e, "err");
      toast(String(e));
    }
  };
  $("cap-stop").onclick = () => capStopShared();
  $("cap-mode").onchange = () => view.classList.toggle("fit", $("cap-mode").value === "fit");
  $("cap-reload").onclick = async () => { await refresh(); toast(`显示器列表已刷新（${$("cap-mon").options.length} 个）`); };
  $("cap-src").onchange = () => capSetSrc($("cap-src").value);
  $("cap-ctl").onchange = () => { if (!capCtlOn()) capSetFullscreen(capFs); };
  $("cap-fs").onclick = () => capSetFullscreen(!capFs);
  $("cap-shot").onclick = capSaveShot;
  $("cap-h264-pick").onclick = async () => {
    const p = await dlgOpen({ title: en("选一个 H.264 / 视频文件"), multiple: false, directory: false,
      filters: [{ name: "视频 / 裸流", extensions: ["h264", "264", "hevc", "mp4", "ts", "mkv", "flv", "avi"] }, { name: "全部", extensions: ["*"] }] });
    if (p) $("cap-h264-url").value = typeof p === "string" ? p : p.path;
  };
  // 画面上的鼠标 / 键盘 → 被控端（只在 VNC + 打开「允许控制键鼠」时发）
  view.addEventListener("mousemove", (e) => capSendPointer(e));
  view.addEventListener("mousedown", (e) => {
    capBtnMask |= e.button === 0 ? 1 : e.button === 1 ? 2 : e.button === 2 ? 4 : 0;
    capSendPointer(e);
    if (capSrcName() === "vnc" && capCtlOn()) e.preventDefault();
  });
  view.addEventListener("mouseup", (e) => {
    capBtnMask &= ~(e.button === 0 ? 1 : e.button === 1 ? 2 : e.button === 2 ? 4 : 0);
    capSendPointer(e);
  });
  view.addEventListener("contextmenu", (e) => { if (capSrcName() === "vnc" && capCtlOn()) e.preventDefault(); });
  view.addEventListener("wheel", (e) => {
    if (capSrcName() !== "vnc" || !capCtlOn() || !capRunning) return;
    const bit = e.deltaY < 0 ? 8 : 16;                 // VNC：8=滚上，16=滚下
    const p = capRemoteXY(e);
    if (!p) return;
    invoke("rs_pointer", { id: capSession, x: p.x, y: p.y, mask: capBtnMask | bit }).catch(() => {});
    setTimeout(() => invoke("rs_pointer", { id: capSession, x: p.x, y: p.y, mask: capBtnMask }).catch(() => {}), 30);
    e.preventDefault();
  }, { passive: false });
  view.addEventListener("keydown", (e) => {
    if (capSrcName() !== "vnc" || !capCtlOn() || !capRunning) return;
    const ks = capKeysym(e);
    if (!ks) return;
    invoke("rs_key", { id: capSession, keysym: ks, down: true }).catch(() => {});
    if (e.key.length === 1 || ["Backspace", "Enter", "Tab"].includes(e.key)) e.preventDefault();
  });
  view.addEventListener("keyup", (e) => {
    if (capSrcName() !== "vnc" || !capCtlOn() || !capRunning) return;
    const ks = capKeysym(e);
    if (ks) invoke("rs_key", { id: capSession, keysym: ks, down: false }).catch(() => {});
  });
  // F11 / Esc：全屏切换（只在「屏幕共享」页生效，输入框里打字不抢键）
  document.addEventListener("keydown", (e) => {
    if (document.documentElement.dataset.tab !== "capture") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "Escape" && capFs) { e.preventDefault(); capSetFullscreen(false); }
  });
  capSetSrc($("cap-src").value);
  // 枚举显示器要过 DXGI，启动时也要花点时间 —— 留到第一次进「屏幕共享」页再列（见 showPane）
  capRefresh = refresh;
}

/* ══════════ 安卓 ADB：设备 / shell / 推拉 / APK / 投屏（内置轮询 + scrcpy）══════════
   后端（android.rs）只负责调 adb.exe / scrcpy.exe，这里只画界面、把命令拼出来。
   投屏帧走 adb://frame（和屏幕共享一个形状），画面里点一下 = adb shell input tap。 */
let adbDevs = [];
let adbSession = 0;          // 投屏会话号（后端每开一路给一个）
let adbMirroring = false;
let adbImg = null, adbLatest = null, adbApplying = false, adbFrames = 0, adbFpsT0 = 0, adbFps = 0;
let adbWH = { w: 0, h: 0 };
let adbReady = null;         // 第一次进这一页才去问 adb 在不在
let adbStCount = 1;          // 编号（adb push 能推出多台，这里给"多设备"留位置）

function adbState(text, cls) {
  const d = $("adb-state");
  if (d) { d.textContent = en(text); d.className = "dot" + (cls ? " " + cls : ""); }
  const dot = $("adb-dot");
  if (dot) dot.className = "dot" + (cls === "err" ? " err" : adbDevs.length ? " ok" : "");
}
function adbLog(text) {
  const box = $("adb-log");
  if (!box) return;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (const l of lines) {
    if (!l.trim() && lines.length > 1) continue;
    box.textContent += `[${new Date().toLocaleTimeString()}] ${l}\n`;
  }
  if (box.textContent.length > 200000) box.textContent = box.textContent.slice(-150000);
  box.scrollTop = box.scrollHeight;
}
function adbSerial() {
  const s = $("adb-dev");
  return s && s.value ? s.value : "";
}
const ADB_PAIRED_KEY = "kdock_adb_paired";
let adbMdnsLast = [];

function adbPairedAll() {
  try {
    const a = JSON.parse(localStorage.getItem(ADB_PAIRED_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => x && x.host) : [];
  } catch (_) { return []; }
}
function adbPairedSave(a) {
  localStorage.setItem(ADB_PAIRED_KEY, JSON.stringify((a || []).slice(0, 20)));
}
function adbPairedRemember(o) {
  const host = String(o.host || "").trim();
  if (!host) return;
  const guid = String(o.guid || "").trim();
  const port = Number(o.port) || 0;
  const a = adbPairedAll();
  const idx = a.findIndex((x) => (guid && x.guid === guid) || (!guid && x.host === host && Number(x.port) === port));
  const rec = { ...(idx >= 0 ? a[idx] : {}), ...o, host, guid, port, at: Date.now() };
  if (idx >= 0) a[idx] = rec; else a.unshift(rec);
  adbPairedSave(a);
}
function adbParseMdns(list) {
  const out = [];
  for (const raw of (list || [])) {
    const m = /^(.+?)\s+_(adb(?:-tls-connect|-tls-pairing)?)\._tcp\.\s+([0-9.]+):(\d+)/.exec(String(raw).trim());
    if (!m) continue;
    out.push({ name: m[1].replace(/\s+\(\d+\)$/, ""), kind: m[2], host: m[3], port: Number(m[4]) });
  }
  return out;
}
function adbWirelessTag(row, tag) {
  const x = document.createElement("span");
  x.className = "tag " + tag.cls;
  x.textContent = tag.text;
  row.appendChild(x);
}
function renderAdbWireless(services) {
  const box = $("adb-wl-found");
  if (!box) return;
  box.textContent = "";
  const devSerials = new Set((adbDevs || []).filter((d) => d.state === "device").map((d) => d.serial));
  const saved = adbPairedAll();
  const rows = [];
  const seen = new Set();
  for (const svc of (services || [])) {
    if (svc.kind !== "adb-tls-connect" && svc.kind !== "adb") continue;
    const hit = saved.find((x) => x.guid && x.guid === svc.name) || saved.find((x) => x.host === svc.host && Number(x.port) === svc.port);
    const target = svc.host + ":" + svc.port;
    const live = (adbDevs || []).find((d) => d.serial === target);
    rows.push({ ...svc, guid: svc.name, paired: !!hit, connected: devSerials.has(target), model: (hit && hit.model) || (live && live.model) || "", legacy: svc.kind === "adb" });
    seen.add(svc.name + "|" + target);
  }
  for (const x of saved) {
    const target = x.host + ":" + (Number(x.port) || 0);
    if (!x.port || seen.has((x.guid || "") + "|" + target) || seen.has("|" + target)) continue;
    rows.push({ name: x.guid || "saved", guid: x.guid || "", host: x.host, port: Number(x.port), paired: true, connected: devSerials.has(target), model: x.model || "", legacy: false, offline: true });
  }
  if ($("adb-paired-count")) $("adb-paired-count").textContent = rows.length ? rows.length + " " + T("台") : "";
  if (!rows.length) {
    const d = document.createElement("div");
    d.className = "adbfound-empty";
    d.textContent = T("还没发现无线调试设备。手机打开「无线调试」后点上面的「找设备」。");
    box.appendChild(d);
    return;
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "adbfound-row";
    const main = document.createElement("div"); main.className = "adbfound-main";
    const nm = document.createElement("div"); nm.className = "adbfound-name";
    nm.textContent = r.model || (r.legacy ? T("无线 ADB 设备") : T("无线调试设备"));
    const ad = document.createElement("div"); ad.className = "adbfound-addr"; ad.textContent = r.host + ":" + r.port;
    main.append(nm, ad); row.appendChild(main);
    if (r.connected) adbWirelessTag(row, { cls: "ok", text: T("已连接") });
    else if (r.paired) adbWirelessTag(row, { cls: "ok", text: T("已配对") });
    else adbWirelessTag(row, { cls: "warn", text: T("直接连接") });
    const btn = document.createElement("button");
    btn.className = "btn small " + (r.connected ? "" : "primary");
    btn.textContent = T(r.connected ? "断开" : "连接");
    btn.onclick = async () => {
      try {
        if (r.connected) await invoke("adb_disconnect", { host: r.host, port: r.port });
        else {
          const got = await invoke("adb_connect", { host: r.host, port: r.port });
          adbPairedRemember({ guid: r.guid, host: r.host, port: r.port, model: r.model });
          if ($("adb-wl-host")) $("adb-wl-host").value = r.host;
          if ($("adb-wl-port")) $("adb-wl-port").value = String(r.port);
          pushSys("[ADB] " + T("已连接") + " " + r.host + ":" + r.port);
          void got;
        }
        await adbRefreshDevices(true);
        await adbMdnsScan(true);
      } catch (e) {
        const m = String(e);
        if (/auth|unauthorized|pair/i.test(m)) {
          toast(T("这台设备可能还没配对：只有第一次需要配对，配对后再点连接"));
        } else toast(m);
      }
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}
async function adbMdnsScan(silent) {
  try {
    const r = await invoke("adb_mdns");
    adbMdnsLast = adbParseMdns(r.list || []);
    renderAdbWireless(adbMdnsLast);
    if (!silent) return r;
  } catch (e) {
    if (!silent) toast(String(e));
  }
  return null;
}
function adbPushFrame(f) {
  adbLatest = f;
  if (!adbApplying && adbImg) { adbApplying = true; adbApplyLatest(); }
}
function adbApplyLatest() {
  if (!adbImg || !adbLatest) { adbApplying = false; return; }
  const f = adbLatest;
  adbLatest = null;
  adbWH = { w: Number(f.srcW) || Number(f.w) || 0, h: Number(f.srcH) || Number(f.h) || 0 };
  adbImg.src = "data:image/jpeg;base64," + f.data;
  adbFrames += 1;
  const now = Date.now();
  if (now - adbFpsT0 >= 500) {
    adbFps = adbFrames * 1000 / (now - adbFpsT0);
    adbFrames = 0; adbFpsT0 = now;
  }
  if (adbMirroring) {
    $("adb-mir-state").textContent = `${f.w}x${f.h} · ${adbFps.toFixed(1)} fps · ${Math.round(f.bytes / 1024)} KB/帧`;
  }
  requestAnimationFrame(() => { adbApplying = false; if (adbLatest) { adbApplying = true; adbApplyLatest(); } });
}
/** 画面坐标 → 手机坐标（缩放后要乘回去） */
function adbRemoteXY(ev) {
  const img = $("adb-view") && $("adb-view").querySelector("img");
  if (!img || !adbWH.w || !adbWH.h) return null;
  const box = img.getBoundingClientRect();
  const k = Math.min(box.width / adbWH.w, box.height / adbWH.h);
  const cw = adbWH.w * k, ch = adbWH.h * k;
  const ox = box.left + (box.width - cw) / 2, oy = box.top + (box.height - ch) / 2;
  return {
    x: Math.max(0, Math.min(adbWH.w - 1, Math.round((ev.clientX - ox) / k))),
    y: Math.max(0, Math.min(adbWH.h - 1, Math.round((ev.clientY - oy) / k))),
  };
}
async function adbRefreshDevices(silent) {
  try {
    const list = await invoke("adb_devices");
    adbDevs = list;
    const sel = $("adb-dev");
    const keep = sel.value;
    sel.innerHTML = "";
    for (const d of list) {
      const o = document.createElement("option");
      o.value = d.serial;
      o.textContent = `${d.model || d.serial}  ·  ${d.serial}  ·  ${d.state}`;
      sel.appendChild(o);
    }
    if (!list.length) {
      sel.innerHTML = '<option value="">' + en("（没有设备：USB 调试开了吗？）") + '</option>';
      adbState("没有设备（打开手机上的 USB 调试，插线后允许本机）", "err");
    } else {
      const back = list.find((x) => x.serial === keep);
      if (back) sel.value = keep;
      const ok = list.filter((x) => x.state === "device").length;
      adbState(`${list.length} 台（${ok} 台可用）`, ok ? "ok" : "err");
    }
    renderAdbWireless(adbMdnsLast);
    if (!silent) pushSys(`[ADB] 设备 ${list.length} 台：${list.map((x) => x.serial + "(" + x.state + ")").join(", ") || "无"}`);
  } catch (e) {
    adbDevs = [];
    $("adb-dev").innerHTML = '<option value="">' + en("（adb 不可用）") + '</option>';
    adbState(String(e), "err");
    if ($("adb-hint")) $("adb-hint").textContent = String(e);
  }
}
async function adbMirrorStart() {
  const serial = adbSerial();
  if (!serial) { toast(en("先选一台设备")); return; }
  adbStopMirror(true);
  $("adb-view").innerHTML = "";
  adbImg = document.createElement("img");
  $("adb-view").appendChild(adbImg);
  adbMirroring = true;
  adbFrames = 0; adbFpsT0 = Date.now();
  try {
    const sid = await invoke("adb_mirror_start", {
      serial,
      fps: Number($("adb-fps").value) || 6,
      quality: Number($("adb-q").value) || 75,
      scale: Number($("adb-scale").value) || 1,
    });
    adbSession = Number(sid) || 0;
    adbState("投屏中（抓屏轮询）", "ok");
    pushSys(`[ADB] 开始投屏 ${serial}`);
  } catch (e) {
    adbMirroring = false;
    adbState(en("投屏失败: ") + e, "err");
    toast(String(e));
  }
}
async function adbStopMirror(quiet) {
  const had = adbMirroring;
  adbMirroring = false;
  adbSession = 0;
  await invoke("adb_mirror_stop").catch(() => {});
  if (had && !quiet) { adbState("投屏已停止"); pushSys("[ADB] 已停止投屏"); }
}
function adbOnShow() {
  if (!adbReady) adbReady = adbInit();
  else adbMdnsScan(true);
}
async function adbInit() {
  const st = await invoke("adb_status").catch((e) => ({ ok: false, path: "", version: String(e) }));
  if (!st.ok) {
    adbState("没找到 adb", "err");
    adbLog("没找到 adb.exe —— 到「环境配置 → Android Platform Tools（adb）」点一键安装。");
    if ($("adb-hint")) $("adb-hint").textContent = "没找到 adb.exe：到「环境配置」一键安装，或者把 platform-tools 目录加到 PATH。";
    return;
  }
  adbLog(`adb：${st.path}\n${st.version || ""}`);
  adbLog(st.scrcpy ? `scrcpy：${st.scrcpy}` : en("scrcpy：没找到（要丝滑投屏就到「环境配置」装一下）"));
  adbState("已找到 adb", "ok");
  await adbRefreshDevices(true);
  await adbMdnsScan(true);
}
function bindAdb() {
  adbOnShow();
  $("adb-refresh").onclick = () => adbRefreshDevices();
  // ── 无线调试（Android 11+）：配对 → 连接 ──
  const wlLog = (t) => {
    const box = $("adb-wl-log");
    if (!box) return;
    box.hidden = false;
    box.textContent += t + "\n";
  };
  const wlArgs = () => {
    const raw = $("adb-wl-host").value.trim();
    const port = Number($("adb-wl-port").value) || null;
    const [h, p] = raw.includes(":") ? raw.split(":") : [raw, ""];
    return { host: h, port: port || (p ? Number(p) : null) };
  };
  if ($("adb-mdns")) $("adb-mdns").onclick = async () => {
    wlLog("$ adb mdns services");
    const r = await adbMdnsScan(false);
    if (!r) { wlLog("扫描失败"); return; }
    wlLog((r.raw || "").trim() || en("（没发现广播：设备上要打开「无线调试」，两边要在同一网段）"));
    const first = adbMdnsLast.find((x) => x.kind === "adb-tls-connect") || adbMdnsLast.find((x) => x.kind === "adb");
    if (first && !$("adb-wl-host").value.trim()) {
      $("adb-wl-host").value = first.host;
      $("adb-wl-port").value = String(first.port);
    }
  };
  if ($("adb-pair")) $("adb-pair").onclick = async () => {
    const a = wlArgs();
    const code = $("adb-wl-code").value.trim();
    if (!a.host || !a.port || !code) { toast(en("配对要填 地址 + 配对端口 + 6 位配对码")); return; }
    wlLog(`$ adb pair ${a.host}:${a.port} ${code}`);
    try {
      const r = await invoke("adb_pair", { host: a.host, port: a.port, code });
      const text = r.text || "";
      const guid = (/\[guid=([^\]]+)\]/.exec(text) || [])[1] || "";
      adbPairedRemember({ guid, host: a.host });
      wlLog(text || en("配对成功"));
      wlLog(en("已记录为已配对设备。只有第一次需要配对；现在到「已配对 / 可连接设备」里点「连接」。"));
      pushSys("[ADB] " + en("配对成功，不需要再次配对；请在已配对设备列表里点连接"));
      await adbMdnsScan(true);
    } catch (e) {
      const m = String(e);
      if (/already|known|paired/i.test(m)) {
        adbPairedRemember({ host: a.host });
        wlLog(en("这台设备已经配对过，不需要再次配对；直接到「已配对 / 可连接设备」点连接。"));
        toast(en("已配对过，直接点连接"));
        await adbMdnsScan(true);
      } else {
        wlLog(en("配对失败：") + m);
        toast(m);
      }
    }
  };
  if ($("adb-connect")) $("adb-connect").onclick = async () => {
    const a = wlArgs();
    if (!a.host) { toast("要填设备地址"); return; }
    wlLog(`$ adb connect ${a.host}:${a.port || 5555}`);
    try {
      const r = await invoke("adb_connect", { host: a.host, port: a.port });
      wlLog(r.text || "已连接");
      adbPairedRemember({ host: a.host, port: a.port || 5555 });
      await adbRefreshDevices(true);
      await adbMdnsScan(true);
    } catch (e) { wlLog(en("连接失败：") + e); toast(String(e)); }
  };
  if ($("adb-disconnect")) $("adb-disconnect").onclick = async () => {
    const a = wlArgs();
    if (!a.host) { toast("要填设备地址"); return; }
    try {
      const r = await invoke("adb_disconnect", { host: a.host, port: a.port });
      wlLog(r.text || "已断开");
      await adbRefreshDevices(true);
    } catch (e) { wlLog(en("断开失败：") + e); }
  };
  $("adb-mir").onclick = adbMirrorStart;
  $("adb-mir-stop").onclick = () => adbStopMirror();
  $("adb-scrcpy").onclick = async () => {
    try {
      const r = await invoke("adb_scrcpy_run", { serial: adbSerial(), args: $("adb-scrcpy-args").value.trim() });
      adbLog(`scrcpy 已启动（pid ${r.pid}）：${r.exe}`);
      pushSys(`[ADB] scrcpy 已启动（pid ${r.pid}）`);
    } catch (e) { adbLog("scrcpy 启动失败：" + e); toast(String(e)); }
  };
  $("adb-scrcpy-stop").onclick = () => invoke("adb_scrcpy_stop").catch(() => {});
  $("adb-run").onclick = async () => {
    const cmd = $("adb-cmd").value.trim();
    if (!cmd) return;
    adbLog("$ " + cmd);
    try {
      const r = await invoke("adb_shell", { serial: adbSerial(), cmd });
      if (r.stdout) adbLog(r.stdout.replace(/\r\n/g, "\n").replace(/\n$/, ""));
      if (r.stderr) adbLog("[stderr] " + r.stderr.trim());
      adbLog(`（退出码 ${r.code}）`);
    } catch (e) { adbLog("执行失败：" + e); }
  };
  $("adb-cmd").onkeydown = (e) => { if (e.key === "Enter") $("adb-run").click(); };
  $("adb-clear").onclick = () => { $("adb-log").textContent = ""; };
  $("adb-key-back").onclick = () => adbKey(4);
  $("adb-key-home").onclick = () => adbKey(3);
  $("adb-key-apps").onclick = () => adbKey(187);
  $("adb-key-power").onclick = () => adbKey(26);
  $("adb-text-send").onclick = async () => {
    const t = $("adb-text").value;
    if (!t) return;
    try { await invoke("adb_input", { serial: adbSerial(), kind: "text", text: t }); adbLog(`input text ${t}`); }
    catch (e) { adbLog("输入失败：" + e); }
  };
  $("adb-text").onkeydown = (e) => { if (e.key === "Enter") $("adb-text-send").click(); };
  // 传文件
  $("adb-pick").onclick = async () => {
    const p = await dlgOpen({ title: en("选要推到设备的文件"), multiple: false, directory: false });
    if (!p) return;
    $("adb-push-to").dataset.local = String(p);
    $("adb-push-to").value = "/sdcard/Download/" + String(p).replace(/^.*[\\/]/, "");
    adbLog("选了：" + p);
  };
  $("adb-push").onclick = async () => {
    const local = ($("adb-push-to").dataset.local || "").trim();
    if (!local) { toast(en("先点「选择本机文件」")); return; }
    const to = $("adb-push-to").value.trim();
    adbLog(`push ${local} → ${to}`);
    try {
      const r = await invoke("adb_push", { serial: adbSerial(), local, remote: to });
      adbLog(r.text || "ok");
    } catch (e) { adbLog("推送失败：" + e); }
  };
  $("adb-pull").onclick = async () => {
    const from = $("adb-pull-from").value.trim();
    if (!from) { toast(en("先填设备上的路径")); return; }
    const save = await dlgSave({ title: en("存到本机"), defaultPath: from.replace(/^.*\//, "") });
    if (!save) return;
    adbLog(`pull ${from} → ${save}`);
    try {
      const r = await invoke("adb_pull", { serial: adbSerial(), remote: from, saveTo: save });
      adbLog(`${r.text || "ok"}（${r.bytes} B）`);
    } catch (e) { adbLog("取回失败：" + e); }
  };
  $("adb-shot-save").onclick = async () => {
    const save = await dlgSave({ title: en("把设备截图存到本机"), defaultPath: "android-shot.png",
      filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!save) return;
    try {
      const r = await invoke("adb_screenshot", { serial: adbSerial(), saveTo: save });
      adbLog(`截图已存：${r.path}（${r.bytes} B）`);
    } catch (e) { adbLog("截图失败：" + e); }
  };
  // APK
  $("adb-apk-pick").onclick = async () => {
    const p = await dlgOpen({ title: en("选 APK"), multiple: false, directory: false,
      filters: [{ name: "APK", extensions: ["apk"] }] });
    if (p) { $("adb-pkg").dataset.apk = p; adbLog("APK：" + p); }
  };
  $("adb-apk-go").onclick = async () => {
    const apk = ($("adb-pkg").dataset.apk || "").trim();
    if (!apk) { toast(en("先选一个 APK")); return; }
    adbLog(`install ${apk}`);
    try {
      const r = await invoke("adb_install", { serial: adbSerial(), apk, reinstall: $("adb-apk-r").checked });
      adbLog(r.text || "ok");
    } catch (e) { adbLog("安装失败：" + e); }
  };
  $("adb-pkg-list").onclick = async () => {
    try {
      const list = await invoke("adb_packages", { serial: adbSerial(), filter: $("adb-pkg").value.trim() });
      adbLog(`第三方包 ${list.length} 个：\n` + list.join("\n"));
      if (list.length && !$("adb-pkg").value.trim()) $("adb-pkg").value = list[0];
    } catch (e) { adbLog("列包失败：" + e); }
  };
  $("adb-pkg-rm").onclick = async () => {
    const pkg = $("adb-pkg").value.trim();
    if (!pkg) { toast(en("先填包名")); return; }
    const r = await agDialog({ title: en("卸载"), text: `确定卸载 ${pkg}？`, danger: true });
    if (!r.ok) return;
    try { adbLog((await invoke("adb_uninstall", { serial: adbSerial(), pkg })).text || "ok"); }
    catch (e) { adbLog("卸载失败：" + e); }
  };
  // 常用命令
  const QUICK = [
    ["型号", "getprop ro.product.model"],
    ["安卓版本", "getprop ro.build.version.release"],
    ["分辨率", "wm size"],
    ["电量", "dumpsys battery | grep -E 'level|status'"],
    ["存储占用", "df -h /data"],
    ["CPU 占用", "top -n 1 -b | head -n 12"],
    ["内存", "cat /proc/meminfo | head -n 3"],
    ["SD 卡目录", "ls -l /sdcard"],
    ["日志(最近 60 行)", "logcat -d -t 60"],
    ["进程列表", "ps -A | head -n 25"],
    ["IP 地址", "ip addr show | grep -E 'inet '"],
    ["重启", "reboot"],
  ];
  const box = $("adb-quick");
  box.textContent = "";
  for (const [name, cmd] of QUICK) {
    const b = document.createElement("button");
    b.className = "btn small"; b.textContent = en(name); b.title = cmd;
    b.onclick = () => { $("adb-cmd").value = cmd; $("adb-run").click(); };
    box.appendChild(b);
  }
  // 画面里点一下 = 点手机；拖动 = 滑动
  const view = $("adb-view");
  let down = null;
  view.addEventListener("mousedown", (e) => {
    if (!adbMirroring || !($("adb-ctl") && $("adb-ctl").checked)) return;
    const p = adbRemoteXY(e);
    if (!p) return;
    down = { ...p, t: Date.now() };
    e.preventDefault();
  });
  view.addEventListener("mouseup", async (e) => {
    if (!down) return;
    const p = adbRemoteXY(e);
    const d0 = down; down = null;
    if (!p) return;
    const dist = Math.hypot(p.x - d0.x, p.y - d0.y);
    const kind = dist > 12 ? "swipe" : "tap";
    try {
      if (kind === "swipe") {
        await invoke("adb_input", { serial: adbSerial(), kind: "swipe", a: d0.x, b: d0.y, c: p.x, d: p.y, duration: Math.max(120, Date.now() - d0.t) });
        adbLog(`swipe ${d0.x},${d0.y} → ${p.x},${p.y}`);
      } else {
        await invoke("adb_input", { serial: adbSerial(), kind: "tap", a: p.x, b: p.y });
        adbLog(`tap ${p.x},${p.y}`);
      }
    } catch (err) { adbLog("输入失败：" + err); }
  });
}
async function adbKey(code) {
  try { await invoke("adb_input", { serial: adbSerial(), kind: "key", text: String(code) }); adbLog(`keyevent ${code}`); }
  catch (e) { adbLog("按键失败：" + e); }
}

// ---------------- 传输页顶部那行：日志路径（面包屑）+ 对话时间 ----------------
// 输出框是"一整张卡片"里的中间那块，卡片顶部这行专门放"日志路径 + 时间"，
// 面包屑点一下直接在资源管理器里打开（跟文件管理器一个手感）。
const SESSION_T0 = Date.now();      // 本次打开软件的时间，用来算"已运行"
let outLogPath = "";                // 最近一次保存/导出的完整路径；没存过就显示默认目录
const dirOfPath = (p) => { const d = String(p).replace(/[\\/][^\\/]*$/, ""); return d || String(p); };
function outHeadRefresh() {
  const box = $("out-crumbs");
  if (!box) return;
  const p = outLogPath || $("sess-dir").value.trim() || $("fl-save-dir").value.trim();
  box.innerHTML = "";
  const push = (txt2, cls) => {
    const sp = document.createElement("span");
    sp.className = cls; sp.textContent = txt2;
    box.appendChild(sp);
  };
  if (!p) { push(en("未设置"), "crumb last"); }
  else {
    let parts = p.replace(/[\\/]+$/, "").split(/[\\/]+/);
    if (parts.length > 4) parts = ["…"].concat(parts.slice(-3));   // 太长只留最后几段（当前目录一定看得见）
    parts.forEach((seg, i) => {
      if (i) push("\u203a", "csep");
      push(seg, "crumb" + (i === parts.length - 1 ? " last" : ""));
    });
  }
  const btn = $("out-dir");
  if (btn) btn.title = (p ? p + "\n" : "") + en("点一下在资源管理器里打开这个目录");
}
function outPathSet(p) { if (p) outLogPath = String(p); outHeadRefresh(); }
function outClockTick() {
  const el = $("out-clock");
  if (!el) return;
  const p2 = (n) => String(n).padStart(2, "0");
  const d = new Date();
  el.textContent = p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  const s0 = new Date(SESSION_T0);
  const sec = Math.floor((Date.now() - SESSION_T0) / 1000);
  const up = p2(Math.floor(sec / 3600)) + ":" + p2(Math.floor(sec / 60) % 60) + ":" + p2(sec % 60);
  el.title = en("会话开始") + " " + p2(s0.getHours()) + ":" + p2(s0.getMinutes()) + ":" + p2(s0.getSeconds())
    + " · " + en("已运行") + " " + up;
}
function bindOutHead() {
  if ($("out-dir")) {
    $("out-dir").onclick = async () => {
      const p = outLogPath || $("sess-dir").value.trim() || $("fl-save-dir").value.trim();
      if (!p) return toast(LANG === "en" ? "Pick a folder first (Options \u2192 Session)" : "先设一个目录（⋯ \u2192 会话）");
      try { await invoke("open_folder", { path: dirOfPath(p) }); }
      catch (e) { toast(String(e)); }
    };
  }
  if ($("sess-dir")) $("sess-dir").addEventListener("input", outHeadRefresh);
  outHeadRefresh();
  outClockTick();
  setInterval(outClockTick, 1000);
}

/** 输入区能长到多高：整张卡的高度刨掉"固定的那几块"，再给输出区留出它的最小高度。
 *  OUT_MIN 必须跟 styles.css 里 .shellcard .outpane 的 min-height 一致（96px）—— 对不上的话，
 *  窗口一矮 / 工具行一换行，输出区就会被挤到 min-height 以下、整张卡溢出、输入框被裁。 */
const INPANE_MIN = 72;      // 跟 styles.css 里 .shellcard .inpane.txpane 的 min-height 一致
const OUTPANE_MIN = 96;      // 跟 .shellcard .outpane 的 min-height 一致（窄窗那个 64 是更松的下限）
function inpaneMaxH(box) {
  const card = box.parentElement;
  const h = (sel) => {
    const el = card.querySelector(sel);
    return el ? el.getBoundingClientRect().height : 0;
  };
  const rest = h(".outhead") + h(".toolbar") + h(".outfoot") + OUTPANE_MIN;
  return Math.max(INPANE_MIN, Math.round(card.getBoundingClientRect().height - rest));
}

/** 拖输出框右下角那个小角手，改下面输入区的高度（存 localStorage，下次还记得） */
function bindInpaneResize() {
  const grip = $("rx-grip");
  const box = document.querySelector(".workpane.shell .inpane");
  if (!grip || !box) return;
  // 记下来的高度在别的窗口尺寸下可能"太高"（会把输出区挤没、把输入框顶出去），
  // 所以每次都按当前卡片高度夹一下；窗口拉小 / 拖左右分栏 / 改缩放都会重新夹一遍。
  const clamp = () => {
    if (!box.style.height) return;
    const cur = parseFloat(box.style.height) || 0;
    const max = inpaneMaxH(box);
    if (cur > max) box.style.height = max + "px";
  };
  const saved = Number(localStorage.getItem("kdock_inpane_h") || 0);
  if (saved > 50) box.style.height = saved + "px";
  clamp();
  if (window.ResizeObserver) new ResizeObserver(clamp).observe(box.parentElement);
  else window.addEventListener("resize", clamp);
  let sy = 0, h0 = 0;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    sy = e.clientY; h0 = box.getBoundingClientRect().height;
    grip.classList.add("dragging");
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.classList.contains("dragging")) return;
    const want = Math.max(INPANE_MIN, Math.min(h0 - (e.clientY - sy), inpaneMaxH(box)));
    box.style.height = want + "px";
  });
  const done = () => {
    if (!grip.classList.contains("dragging")) return;
    grip.classList.remove("dragging");
    localStorage.setItem("kdock_inpane_h", String(Math.round(box.getBoundingClientRect().height)));
  };
  grip.addEventListener("pointerup", done);
  grip.addEventListener("pointercancel", done);
  // 双击复位（跟左栏 / 日志 / agent 那几条拖动条一个手感）；角手的提示语里写了这条
  grip.addEventListener("dblclick", () => {
    box.style.height = "";
    localStorage.removeItem("kdock_inpane_h");
  });
}

// ---------------- 中控编排：步骤节点画布 ----------------
// 一步 = 绑一个连接（主连接 / 中控连接 / 临时 TCP / 本机命令）+ 发什么 + (可选)发完等什么 + 发完延时，
// 失败、超时分别走不同出口。图数据：{nodes:[{id,type,x,y,...cfg}], edges:[{from,port,to}]}
let sqConns = [];                       // 中控自建连接 [{id,label}]
let sqGraph = { nodes: [], edges: [] };
let sqSel = null;
let sqView = { x: 60, y: 34, k: 1 };
let sqRunning = false, sqStop = false;
let sqSeq = 1;
let sqTemp = null, sqRunNode = null, sqDrag = null, sqSnap = null;
let sqRunConns = {};                    // 运行时临时开的 TCP 连接 {"host:port": id}
const sqRx = [];                        // 各连接收到的文本 {id,text}

const SQ_NS = "http://www.w3.org/2000/svg";
const SQ_KINDS = {
  start:  { name: "开始", cls: "k-start",  ins: 1 },   // 有输入口 -> 循环可以回到开始
  step:   { name: "步骤", cls: "k-step",   ins: 1 },
  delay:  { name: "延时", cls: "k-delay",  ins: 1 },
  branch: { name: "条件", cls: "k-branch", ins: 1 },
  end:    { name: "结束", cls: "k-end",    ins: 1 },
  fail:   { name: "失败", cls: "k-fail",   ins: 1 },
};
/** 每个节点的输出口（step 的"超时"口只有在勾了"发送后等待"时才出现） */
function sqOuts(n) {
  if (n.type === "start") return [["out", "开始"]];
  if (n.type === "step") {
    const o = [["ok", "成功"], ["err", "失败"]];
    if (n.wait) o.push(["timeout", "超时"]);
    return o;
  }
  if (n.type === "delay") return [["out", "继续"]];
  if (n.type === "branch") return [["true", "是"], ["false", "否"]];
  if (n.type === "end" || n.type === "fail") return [["out", "继续 / 回流"]];
  return [];
}
function sqHasOut(n, port) {
  return !!n && sqOuts(n).some((o) => o[0] === port);
}
const sqSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqNewId = () => "n" + (sqSeq++);
const sqNode = (id) => sqGraph.nodes.find((n) => n.id === id);
const sqKey = (e) => e.from + "|" + e.port + "|" + e.to;
function sqEdgesFrom(id, port) { return sqGraph.edges.filter((e) => e.from === id && e.port === port); }
function sqEdgeFrom(id, port) { return sqEdgesFrom(id, port)[0]; }
function sqEdgesInto(id) { return sqGraph.edges.filter((e) => e.to === id); }
function sqLog(text, cls) {
  const box = $("sq-log");
  box.classList.toggle("with-no", logNoOn());
  box.insertAdjacentHTML("beforeend", logRowHtml(++sqLogNo, escapeHtml(text), "l" + (cls ? " " + cls : "")));
  box.scrollTop = box.scrollHeight;
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
}
function sqSave() { localStorage.setItem("kdock_seq_graph", JSON.stringify(sqGraph)); }
/** 体检：丢掉不认识的节点类型（比如老版本存的 send/wait）、重复 id 和悬空连线 */
function sqSanitize() {
  const ok = new Set();
  sqGraph.nodes = (sqGraph.nodes || []).filter((n) => {
    if (!n || !n.id || !SQ_KINDS[n.type] || ok.has(n.id)) return false;
    ok.add(n.id);
    return true;
  });
  sqGraph.edges = (sqGraph.edges || []).filter((e) =>
    e && ok.has(e.from) && ok.has(e.to) && sqHasOut(sqNode(e.from), e.port)
  );
  if (sqSel && sqSel.kind === "node" && !ok.has(sqSel.id)) sqSel = null;
  if (sqSel && sqSel.kind === "edge" && !sqGraph.edges.some((e) => sqKey(e) === sqSel.id)) sqSel = null;
}
function sqLoadCfg() {
  try {
    const g = JSON.parse(localStorage.getItem("kdock_seq_graph") || "null");
    if (g && Array.isArray(g.nodes) && g.nodes.length) { sqGraph = { nodes: g.nodes, edges: g.edges || [] }; sqSanitize(); return; }
  } catch (_) {}
  sqGraph = { nodes: [], edges: [] };
}
function sqEnsureStart() {
  if (!sqGraph.nodes.some((n) => n.type === "start")) {
    sqGraph.nodes.unshift({ id: sqNewId(), type: "start", x: 70, y: 40 });
  }
}
function sqNewNode(type) {
  const n = { id: sqNewId(), type, x: 0, y: 0 };
  if (type === "step") {
    n.conn = "main"; n.payload = ""; n.hex = false;
    n.wait = false; n.expect = ""; n.timeout = 5000; n.after = 0;
    n.waitMode = "contains"; n.expectIc = false; n.maskMask = "";
    n.host = "192.168.1.100"; n.port = 23; n.localPort = 0;
    n.comPort = ""; n.comBaud = 115200; n.cmd = "ping -n 1 -w 1000 192.168.1.100";
    n.expectOut = ""; n.cmdTimeout = 4000;
    // 临时 SSH（conn === "ssh"）用这几个
    n.sshHost = "192.168.1.10"; n.sshPort = 22; n.sshUser = "root";
    n.sshPass = ""; n.sshExtra = ""; n.sshReady = 6000;
  }
  if (type === "delay") n.ms = 50;
  if (type === "branch") { n.mode = "contains"; n.value = ""; }
  return n;
}
/** 一键整理：按"从开始算的层数"分列，同层纵向排开，线短了就不乱了 */
function sqAutoLayout() {
  if (!sqGraph.nodes.length) return;
  const start = sqGraph.nodes.find((n) => n.type === "start");
  const level = {};
  if (start) level[start.id] = 0;
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (const e of sqGraph.edges) {
      if (level[e.from] == null) continue;
      const want = level[e.from] + 1;
      if (level[e.to] == null || level[e.to] < want) { level[e.to] = want; changed = true; }
    }
    if (!changed) break;
  }
  let maxLv = 0;
  for (const n of sqGraph.nodes) { if (level[n.id] == null) level[n.id] = 0; maxLv = Math.max(maxLv, level[n.id]); }
  const rowOf = {};
  for (const n of sqGraph.nodes) {
    const lv = level[n.id];
    rowOf[lv] = (rowOf[lv] || 0);
    n.x = 70 + lv * 250;
    n.y = 40 + rowOf[lv] * 130;
    rowOf[lv] += 1;
  }
  sqSave(); sqRender(); sqFit();
  sqLog("已按「从开始往下」分层整理：共 " + (maxLv + 1) + " 列", "ok");
}

function sqFreeSpot() {
  const colW = 240, rowH = 130;
  const left = -sqView.x / sqView.k, top = -sqView.y / sqView.k;
  const c0i = Math.ceil((left - 70) / colW), r0i = Math.ceil((top - 40) / rowH);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 70 + (c0i + c) * colW, y = 40 + (r0i + r) * rowH;
      if (!sqGraph.nodes.some((n) => Math.abs(n.x - x) < 215 && Math.abs(n.y - y) < 110)) return { x, y };
    }
  }
  return { x: 70, y: 40 };
}
function sqAddNode(type, x, y) {
  const n = sqNewNode(type);
  n.x = Math.round(x); n.y = Math.round(y);
  sqGraph.nodes.push(n);
  sqSel = { kind: "node", id: n.id };
  sqSave(); sqRender();
  return n;
}
function sqDeleteNode(id) {
  const n = sqNode(id);
  if (n && n.type === "start") return toast("开始节点不能删");
  sqGraph.nodes = sqGraph.nodes.filter((x) => x.id !== id);
  sqGraph.edges = sqGraph.edges.filter((e) => e.from !== id && e.to !== id);
  if (sqSel && sqSel.kind === "node" && sqSel.id === id) sqSel = null;
  sqSave(); sqRender();
}
function sqDeleteEdge(key) {
  sqGraph.edges = sqGraph.edges.filter((e) => sqKey(e) !== key);
  if (sqSel && sqSel.kind === "edge" && sqSel.id === key) sqSel = null;
  sqSave(); sqRender();
}
function sqConnect(from, port, to) {
  if (from === to) { toast("不能连到自己"); return false; }
  const fn = sqNode(from);
  if (!fn || !sqHasOut(fn, port)) return false;
  const toNode = sqNode(to);
  if (!toNode || !SQ_KINDS[toNode.type].ins) { toast("这个节点没有输入口"); return false; }
  // 一个节点可以像函数一样被多处调用（多入边）；一个出口也可以连多条线（扇出）
  if (sqGraph.edges.some((e) => e.from === from && e.port === port && e.to === to)) {
    toast("这条线已经有了");
    return false;
  }
  const edge = { from, port, to };
  sqGraph.edges.push(edge);
  // 新连线立即成为选中项：右侧直接显示两端，用户不用再回头点线。
  sqSel = { kind: "edge", id: sqKey(edge) };
  sqSave(); sqRender();
  return true;
}

// ---------- 视图 ----------
function sqApplyView() {
  $("sq-nodes").style.transform = "translate(" + sqView.x + "px, " + sqView.y + "px) scale(" + sqView.k + ")";
  $("sq-edges-g").setAttribute("transform", "translate(" + sqView.x + " " + sqView.y + ") scale(" + sqView.k + ")");
}
/** 屏幕坐标 → 画布世界坐标。CSS zoom 会先放大整个 #ui-root，必须一起除掉。 */
function sqScreenToWorld(clientX, clientY) {
  const cv = $("sq-canvas");
  const r = cv.getBoundingClientRect();
  const ui = uiScaleValue();
  return {
    x: ((clientX - r.left) / ui - sqView.x) / sqView.k,
    y: ((clientY - r.top) / ui - sqView.y) / sqView.k,
  };
}
function sqFit() {
  const cv = $("sq-canvas");
  if (!sqGraph.nodes.length) return;
  const xs = sqGraph.nodes.map((n) => n.x), ys = sqGraph.nodes.map((n) => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) + 220;
  const y0 = Math.min(...ys), y1 = Math.max(...ys) + 170;
  sqView.k = Math.min(1.4, Math.max(0.45, Math.min(cv.clientWidth / (x1 - x0 + 80), cv.clientHeight / (y1 - y0 + 80))));
  sqView.x = 40 - x0 * sqView.k;
  sqView.y = 30 - y0 * sqView.k;
  sqApplyView(); sqRedrawEdges();
}
function sqPortPos(id, port) {
  const n = sqNode(id);
  const el = document.querySelector(".seqnode[data-id=\"" + id + "\"] .seqport[data-port=\"" + port + "\"]");
  if (!n || !el) return null;
  // 用节点的世界坐标 + 端口相对节点的布局坐标，避开 CSS zoom / DPI / 边框带来的误差。
  return {
    x: n.x + el.offsetLeft + el.offsetWidth / 2,
    y: n.y + el.offsetTop + el.offsetHeight / 2,
  };
}
/** 折线路由：正向(目标在下面)走 S 形；回流(目标在上方/同排)绕到侧面，避免糊成一团 */
function sqRoutePoints(a, b) {
  const down = b.y - a.y;
  if (down > 40) {
    const mid = a.y + down / 2;
    return [[a.x, a.y], [a.x, mid], [b.x, mid], [b.x, b.y]];
  }
  const lane = a.y + 26;                    // 从源口先往下一小段
  const top = b.y - 26;                     // 从目标口上方一小段进
  const side = b.x >= a.x ? Math.max(a.x, b.x) + 34 : Math.min(a.x, b.x) - 34;
  return [[a.x, a.y], [a.x, lane], [side, lane], [side, top], [b.x, top], [b.x, b.y]];
}
/** 把折线拐角磨圆 */
function sqRoundPath(pts, r) {
  r = r || 10;
  let d = "M " + pts[0][0] + " " + pts[0][1];
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i - 1][0], py = pts[i - 1][1];
    const cx = pts[i][0], cy = pts[i][1];
    const nx = pts[i + 1][0], ny = pts[i + 1][1];
    const l1 = Math.hypot(cx - px, cy - py) || 1;
    const l2 = Math.hypot(nx - cx, ny - cy) || 1;
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
    const x1 = cx - (cx - px) / l1 * r1, y1 = cy - (cy - py) / l1 * r1;
    const x2 = cx + (nx - cx) / l2 * r2, y2 = cy + (ny - cy) / l2 * r2;
    d += " L " + x1 + " " + y1 + " Q " + cx + " " + cy + " " + x2 + " " + y2;
  }
  const last = pts[pts.length - 1];
  d += " L " + last[0] + " " + last[1];
  return d;
}
function sqPathD(a, b) { return sqRoundPath(sqRoutePoints(a, b), 10); }
function sqRedrawEdges() {
  const g = $("sq-edges-g");
  while (g.firstChild) g.removeChild(g.firstChild);
  // 当前选中的那条线（选中时压暗其它线、并把这条挪到最上层，免得被别的线盖住）
  const selEdge = (sqSel && sqSel.kind === "edge") ? sqGraph.edges.find((x) => sqKey(x) === sqSel.id) : null;
  // 每条线包成一个 <g>：里面先放**透明加宽命中区**（2px 的线缩放后只剩 1px 多，鼠标很难点中），
  // 再放看得见的线。这样整条 14px 宽的带子都能 hover/点击，而且两条线的 z 序不会被插花。
  let selGrp = null;
  for (const e of sqGraph.edges) {
    const a = sqPortPos(e.from, e.port), b = sqPortPos(e.to, "in");
    if (!a || !b) continue;
    const d = sqPathD(a, b);
    const isSel = selEdge === e;
    const grp = document.createElementNS(SQ_NS, "g");
    grp.setAttribute("class", "seqedgegrp" + (isSel ? " selgrp" : ""));
    grp.dataset.key = sqKey(e);
    const hit = document.createElementNS(SQ_NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "seqhit");
    const vis = document.createElementNS(SQ_NS, "path");
    vis.setAttribute("d", d);
    let cls = "seqedge";
    if (isSel) cls += " sel";
    else if (selEdge) cls += " dim";
    if (e.port === "err" || e.port === "timeout" || e.port === "false") cls += " warn";
    vis.setAttribute("class", cls);
    grp.appendChild(hit);
    grp.appendChild(vis);
    g.appendChild(grp);
    if (isSel) selGrp = grp;
  }
  if (selGrp) g.appendChild(selGrp);        // appendChild 已有节点 = 挪到最上面（别被其它线盖住）
  if (sqTemp) {
    const p = document.createElementNS(SQ_NS, "path");
    p.setAttribute("d", sqPathD(sqTemp.a, sqTemp.b));
    p.setAttribute("class", "seqedge");
    p.setAttribute("stroke-dasharray", "5 4");
    p.setAttribute("stroke", "hsl(217 92% 74%)");
    g.appendChild(p);
  }
}
/** 节点短标签，例如 "1 步骤"（起点/终点筹码用） */
function sqNodeLabel(n) {
  if (!n) return "?";
  const idx = sqGraph.nodes.filter((x) => x.type === "step").indexOf(n) + 1;
  return (idx ? idx + " " : "") + en(SQ_KINDS[n.type].name);
}
/** 在鼠标附近找端口；缩放后圆点很小，不能只依赖 e.target。 */
function sqPortHitAt(x, y, selector, extraPad = 5) {
  const cv = $("sq-canvas");
  let best = null;
  for (const el of cv.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    const pad = Math.max(10, r.width / 2 + extraPad);
    if (d <= pad && (!best || d < best.d)) {
      best = { el, nodeEl: el.closest(".seqnode"), d };
    }
  }
  return best;
}
function sqClearSnap() {
  document.querySelectorAll(".seqport.snap").forEach((el) => el.classList.remove("snap"));
  sqSnap = null;
}
/** 高亮鼠标附近可用的端口，作为“松手即连接”的可视提示。 */
function sqSetSnap(x, y, selector, excludeNode, extraPad) {
  const hit = sqPortHitAt(x, y, selector, extraPad);
  if (!hit || (excludeNode && hit.nodeEl?.dataset.id === excludeNode)) {
    sqClearSnap();
    return null;
  }
  if (sqSnap?.el !== hit.el) {
    sqClearSnap();
    hit.el.classList.add("snap");
    sqSnap = hit;
  }
  return sqSnap;
}
/** 把某个节点挪到画布正中间（点连线两端的筹码时用） */
function sqCenterOn(id) {
  const n = sqNode(id), cv = $("sq-canvas");
  if (!n || !cv) return;
  sqView.x = cv.clientWidth / 2 - (n.x + 93) * sqView.k;
  sqView.y = cv.clientHeight / 2 - (n.y + 40) * sqView.k;
  sqApplyView();
  sqRedrawEdges();
}
function sqConnLabel(id) {
  const s = String(id == null ? "main" : id);
  if (s === "main") return "主连接";
  const c = sqConns.find((x) => String(x.id) === s);
  return c ? ("#" + c.id + " " + c.label) : ("#" + s);
}
/** 这一步用的连接显示名 */
function sqConnText(n) {
  if (n.conn === "local") return "本机命令";
  if (n.conn === "tcp") return "TCP " + (n.host || "?") + ":" + (n.port || "?");
  if (n.conn === "udp") return "UDP " + (n.host || "?") + ":" + (n.port || "?");
  if (n.conn === "serial") return "串口 " + (n.comPort || "?") + " @" + (n.comBaud || 115200);
  if (n.conn === "ssh") return "SSH " + (n.sshUser ? n.sshUser + "@" : "") + (n.sshHost || "?") + ":" + (n.sshPort || 22);
  return sqConnLabel(n.conn);
}

// ---------- 渲染节点 ----------
function sqNodeEl(n) {
  const K = SQ_KINDS[n.type];
  if (!K) return null;
  const selEdge = (sqSel && sqSel.kind === "edge") ? sqGraph.edges.find((x) => sqKey(x) === sqSel.id) : null;
  const linked = !!selEdge && (selEdge.from === n.id || selEdge.to === n.id);
  const el = document.createElement("div");
  el.className = "seqnode " + K.cls + (sqSel && sqSel.kind === "node" && sqSel.id === n.id ? " sel" : "")
    + (linked ? " linked" : "")
    + (sqRunning && sqRunNode === n.id ? " running" : "");
  el.dataset.id = n.id;
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  const hd = document.createElement("div");
  hd.className = "nhd";
  const kd = document.createElement("span"); kd.className = "nkind"; kd.textContent = K.name;
  hd.appendChild(kd);
  const seqn = document.createElement("span"); seqn.className = "nseq";
  seqn.textContent = String(sqGraph.nodes.filter((x) => x.type === "step").indexOf(n) + 1) || "";
  if (n.type === "step") hd.appendChild(seqn);
  el.appendChild(hd);
  const body = document.createElement("div");
  body.className = "nbd";
  const add = (label, val) => {
    const d = document.createElement("div");
    d.className = "kv";
    const b = document.createElement("b"); b.textContent = label;
    const s = document.createElement("span"); s.className = "pv"; s.textContent = val;
    d.appendChild(b); d.appendChild(s);
    body.appendChild(d);
  };
  if (n.type === "step") {
    add("连接", sqConnText(n));
    if (n.conn === "local") {
      add("命令", n.cmd || "（空）");
      if (n.expectOut) add("看输出", n.expectOut);
    } else {
      add("发送", (n.hex ? "[HEX] " : "") + (n.payload || "（空）"));
      if (n.wait) add("等", sqExpectLabel(n) + " " + (n.timeout || 0) + "ms");
    }
    if (n.after) add("延时", n.after + "ms");
  } else if (n.type === "delay") { add("延时", (n.ms || 0) + "ms"); }
  else if (n.type === "branch") {
    const how = n.mode === "regex" ? "正则" : n.mode === "nonempty" ? "非空" : "包含";
    add("判断", how); add("值", n.value || "（空）");
  } else { body.textContent = n.type === "start" ? "流程入口" : n.type === "fail" ? "失败结束" : "正常结束"; }
  el.appendChild(body);
  if (K.ins) {
    const i = document.createElement("div");
    i.className = "seqport in"; i.dataset.port = "in";
    el.appendChild(i);
    const into = sqEdgesInto(n.id).length;
    const outN = sqGraph.edges.filter((e) => e.from === n.id).length;
    if (into > 1 || outN > 1 || n.type === "step" || n.type === "delay" || n.type === "branch") {
      const c = document.createElement("div");
      c.className = "ncount";
      c.textContent = (into > 1 ? "调用 ×" + into : "") + (outN > 1 ? (into > 1 ? " · " : "") + "出线 ×" + outN : "");
      if (c.textContent) el.appendChild(c);
    }
  }
  const outs = sqOuts(n);
  outs.forEach((o, idx) => {
    const left = (100 / (outs.length + 1)) * (idx + 1);
    const p = document.createElement("div");
    p.className = "seqport out" + (o[0] === "err" || o[0] === "timeout" ? " warn" : "");
    p.dataset.port = o[0];
    p.style.left = "calc(" + left + "% - 5px)";
    el.appendChild(p);
    const lb = document.createElement("div");
    lb.className = "seqport-lb";
    lb.style.left = "calc(" + left + "% - 30px)";
    lb.style.width = "60px"; lb.style.textAlign = "center";
    lb.textContent = o[1];
    el.appendChild(lb);
  });
  return el;
}
function sqRefreshNode(id) {
  const n = sqNode(id);
  const old = document.querySelector(".seqnode[data-id=\"" + id + "\"]");
  if (n && old) {
    const before = sqGraph.edges.length;
    sqSanitize();
    if (sqGraph.edges.length !== before) {
      sqSave();
      sqRender();
      return;
    }
    old.replaceWith(sqNodeEl(n));
    sqRedrawEdges();
  }
}
function sqRender() {
  const wrap = $("sq-nodes");
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  for (const n of sqGraph.nodes) { const el = sqNodeEl(n); if (el) wrap.appendChild(el); }
  sqApplyView();
  sqRedrawEdges();
  sqRenderCfg();
}

// ---------- 右侧：选中节点/连线的配置 ----------
// 面板是每次"重建"出来的，切语言那次 DOM 扫描扫不到后建的控件；
// 所以重建完补一次 applyLang（只在语言系统就绪之后补，避免初始化时乱套）。
function sqRenderCfg() {
  sqRenderCfgInner();
  // 注意别递归：applyLang 结尾也会重画画布，那时 __langBusy 为真，这里就跳过
  if (window.__langReady && !window.__langBusy) applyLang(LANG);
}
function sqRenderCfgInner() {
  const box = $("sq-node-cfg");
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!sqSel) { box.innerHTML = "<p class=\"hint\">在中间点一下节点或连线，这里改参数。</p>"; return; }
  if (sqSel.kind === "edge") {
    const e = sqGraph.edges.find((x) => sqKey(x) === sqSel.id);
    if (!e) { sqSel = null; return sqRenderCfg(); }
    const from = sqNode(e.from), to = sqNode(e.to);
    if (!from || !to) { sqSel = null; return sqRenderCfg(); }
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = LANG === "en"
      ? "Wire: " + en(SQ_KINDS[from.type].name) + " · " + e.port + " → " + en(SQ_KINDS[to.type].name)
      : "连线：" + SQ_KINDS[from.type].name + " · " + e.port + " → " + SQ_KINDS[to.type].name;
    box.appendChild(p);
    // 两端节点：画布上已经点亮了，这里再列出来，点一下就能选中并居中
    const ends = document.createElement("div"); ends.className = "edgeends";
    const chip = (node, tag) => {
      const b = document.createElement("button");
      b.className = "echip"; b.title = en("点一下选中并居中");
      const t1 = document.createElement("b"); t1.textContent = en(tag);
      const t2 = document.createElement("span"); t2.textContent = sqNodeLabel(node);
      b.appendChild(t1); b.appendChild(t2);
      b.onclick = () => { sqSel = { kind: "node", id: node.id }; sqCenterOn(node.id); sqRender(); };
      return b;
    };
    ends.appendChild(chip(from, "起点"));
    const ar = document.createElement("span"); ar.className = "earrow"; ar.textContent = "→";
    ends.appendChild(ar);
    ends.appendChild(chip(to, "终点"));
    box.appendChild(ends);
    const row = document.createElement("div"); row.className = "btnrow";
    const del = document.createElement("button");
    del.className = "btn danger"; del.textContent = "删除这条线";
    del.onclick = () => sqDeleteEdge(sqSel.id);
    row.appendChild(del);
    box.appendChild(row);
    return;
  }
  const n = sqNode(sqSel.id);
  if (!n) { sqSel = null; return sqRenderCfg(); }
  const K = SQ_KINDS[n.type];
  const t = document.createElement("p");
  t.className = "hint";
  t.textContent = LANG === "en" ? "Node: " + en(K.name) + " (" + n.id + ")" : "节点：" + K.name + "（" + n.id + "）";
  box.appendChild(t);
  const field = (label, el) => {
    const d = document.createElement("div"); d.className = "field";
    const l = document.createElement("label"); l.textContent = label;
    d.appendChild(l); d.appendChild(el); box.appendChild(d);
  };
  const txt = (v, ph, on) => {
    const i = document.createElement("input");
    i.value = v == null ? "" : v; i.placeholder = ph || "";
    i.oninput = () => { on(i.value); sqSave(); sqRefreshNode(n.id); };
    return i;
  };
  const num = (v, on) => {
    const i = document.createElement("input"); i.type = "number"; i.value = v;
    i.oninput = () => { on(Number(i.value) || 0); sqSave(); sqRefreshNode(n.id); };
    return i;
  };
  const chk = (label, val, on) => {
    const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!val;
    c.onchange = () => { on(c.checked); sqSave(); sqRenderCfg(); sqRefreshNode(n.id); };
    const l = document.createElement("label"); l.className = "chk";
    l.appendChild(c); l.appendChild(document.createTextNode(" " + label));
    box.appendChild(l);
    return c;
  };
  if (n.type === "step") {
    // 1) 连接：每步都绑一个连接
    const sel = document.createElement("select");
    const add = (v, t2) => { const o = document.createElement("option"); o.value = v; o.textContent = t2; sel.appendChild(o); };
    add("main", "主连接（传输页）");
    for (const c of sqConns) add(String(c.id), "#" + c.id + " " + c.label);
    add("tcp", "临时 TCP（本步指定 IP:端口）");
    add("udp", "临时 UDP（本步指定 IP:端口）");
    add("serial", "临时串口（本步指定 COM 口）");
    add("ssh", "临时 SSH（本步指定主机/账号）");
    add("local", "本机命令（ping 等）");
    sel.value = n.conn || "main";
    sel.onchange = () => { n.conn = sel.value; sqSave(); sqRenderCfg(); sqRefreshNode(n.id); };
    field("连接", sel);
    if (n.conn === "serial") {
      const psel = document.createElement("select");
      const opts = Array.from($("ports").options).map((o) => [o.value, o.textContent]).filter((p2) => p2[0]);
      if (!opts.length) opts.push(["", "（没扫到串口）"]);
      for (const pair of opts) { const o = document.createElement("option"); o.value = pair[0]; o.textContent = pair[1]; psel.appendChild(o); }
      if (!n.comPort) n.comPort = opts[0][0];
      psel.value = n.comPort;
      psel.onchange = () => { n.comPort = psel.value; sqSave(); sqRefreshNode(n.id); };
      field("串口", psel);
      const bsel = document.createElement("select");
      for (const b of BAUDS) { const o = document.createElement("option"); o.value = String(b); o.textContent = String(b); bsel.appendChild(o); }
      if (!Array.from(bsel.options).some((o) => Number(o.value) === Number(n.comBaud))) {
        const o = document.createElement("option"); o.value = String(n.comBaud); o.textContent = String(n.comBaud); bsel.appendChild(o);
      }
      bsel.value = String(n.comBaud || 115200);
      bsel.onchange = () => { n.comBaud = Number(bsel.value) || 115200; sqSave(); sqRefreshNode(n.id); };
      field("波特率", bsel);
    }
    if (n.conn === "tcp" || n.conn === "udp") {
      field("目标 IP", txt(n.host, "192.168.1.100", (v) => (n.host = v)));
      field("端口", num(n.port || 0, (v) => (n.port = v)));
      const nsel = document.createElement("select");
      const a0 = document.createElement("option"); a0.value = ""; a0.textContent = "自动 / 全部网卡"; nsel.appendChild(a0);
      for (const it of NET_IFACES) {
        const ip = String(it.IPAddress || "");
        if (!ip) continue;
        const o = document.createElement("option"); o.value = ip; o.textContent = `${it.InterfaceAlias || "网卡"} — ${ip}`; nsel.appendChild(o);
      }
      nsel.value = n.localAddr || "";
      nsel.onchange = () => { n.localAddr = nsel.value; sqSave(); sqRefreshNode(n.id); };
      field("网卡", nsel);
      if (n.conn === "udp") field("本地端口", num(n.localPort || 0, (v) => (n.localPort = v)));
    }
    if (n.conn === "ssh") {
      field("主机", txt(n.sshHost, "192.168.1.10", (v) => (n.sshHost = v)));
      field("端口", num(n.sshPort || 22, (v) => (n.sshPort = v)));
      field("用户名", txt(n.sshUser, "root", (v) => (n.sshUser = v)));
      field("密码", txt(n.sshPass, "留空=密钥/自己敲", (v) => (n.sshPass = v)));
      field("附加参数", txt(n.sshExtra, "-i C:\\keys\\id_ed25519", (v) => (n.sshExtra = v)));
      field("登录取 Prompt 超时(ms)", num(n.sshReady || 6000, (v) => (n.sshReady = v)));
    }
    if (n.conn === "local") {
      field("命令（cmd /C）", txt(n.cmd, "ping -n 1 -w 1000 192.168.1.100", (v) => (n.cmd = v)));
      field("要求输出包含", txt(n.expectOut, "留空=只看退出码 0", (v) => (n.expectOut = v)));
      field("命令超时(ms)", num(n.cmdTimeout || 4000, (v) => (n.cmdTimeout = v)));
    } else {
      field("发送内容", txt(n.payload, n.hex ? "如 a0000028d000" : "要发出去的文本", (v) => (n.payload = v)));
      chk("HEX（内容按十六进制解析）", n.hex, (v) => (n.hex = v));
      chk("发送后等待数据", n.wait, (v) => (n.wait = v));
      if (n.wait) {
        const wm = document.createElement("select");
        for (const pair of [["contains", "包含文本"], ["regex", "正则表达式"],
                            ["mask", "位判断(HEX)"], ["any", "任意数据"]]) {
          const o = document.createElement("option"); o.value = pair[0]; o.textContent = pair[1]; wm.appendChild(o);
        }
        wm.value = n.waitMode || "contains";
        wm.onchange = () => { n.waitMode = wm.value; sqSave(); sqRenderCfg(); sqRefreshNode(n.id); };
        field("期待方式", wm);
        const wmod = n.waitMode || "contains";
        if (wmod === "contains") {
          field("期待文本", txt(n.expect, "留空=收到任意数据就算成功", (v) => (n.expect = v)));
        } else if (wmod === "regex") {
          field("正则表达式", txt(n.expect, "如 ^SVR1 或 Directory", (v) => (n.expect = v)));
          chk("忽略大小写", n.expectIc, (v) => (n.expectIc = v));
        } else if (wmod === "mask") {
          field("期望值(HEX)", txt(n.expect, "如 A0000028D000", (v) => (n.expect = v)));
          field("掩码(HEX)", txt(n.maskMask, "同长度，留空=逐字节比较；如 F00000000000", (v) => (n.maskMask = v)));
          const h2 = document.createElement("p"); h2.className = "hint";
          h2.textContent = "在收到的字节流里找一段，使 (数据 & 掩码) == (期望值 & 掩码)。";
          box.appendChild(h2);
        }
        field("超时(ms)", num(n.timeout || 5000, (v) => (n.timeout = v)));
      }
    }
    field("发送后延时(ms)", num(n.after || 0, (v) => (n.after = v)));
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = n.wait ? "出口：成功 / 失败(发送错) / 超时(等不到)。" : "出口：成功 / 失败。";
    box.appendChild(p);
  } else if (n.type === "delay") {
    field("延时(ms)", num(n.ms || 0, (v) => (n.ms = v)));
  } else if (n.type === "branch") {
    const sel = document.createElement("select");
    for (const pair of [["contains", "包含"], ["regex", "正则匹配"], ["nonempty", "不为空"]]) {
      const o = document.createElement("option"); o.value = pair[0]; o.textContent = pair[1]; sel.appendChild(o);
    }
    sel.value = n.mode || "contains";
    sel.onchange = () => { n.mode = sel.value; sqSave(); sqRenderCfg(); sqRefreshNode(n.id); };
    field("判断方式", sel);
    field("值", txt(n.value, "要匹配的文本 / 正则", (v) => (n.value = v)));
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = "对最近 600 字符的接收内容判断；是 / 否 分别从两个底部圆点引出。";
    box.appendChild(p);
  } else {
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = n.type === "start" ? "流程入口，只能有一个。"
      : n.type === "fail" ? "失败结束（流程以失败收尾）。" : "正常结束。";
    box.appendChild(p);
  }
  if (n.type !== "start") {
    const row = document.createElement("div"); row.className = "btnrow";
    const del = document.createElement("button");
    del.className = "btn danger"; del.textContent = "删除这个节点";
    del.onclick = () => sqDeleteNode(n.id);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function sqRenderConns() {
  const box = $("sq-conns");
  box.innerHTML = "";
  if (!sqConns.length) box.innerHTML = "<span class=\"lb\">（还没有中控连接；用「主连接」也可以）</span>";
  sqConns.forEach((c) => {
    const row = document.createElement("div");
    row.className = "connrow";
    row.innerHTML = "<span class=\"cdot\"></span><span class=\"clabel\"></span>";
    row.querySelector(".clabel").textContent = "#" + c.id + " " + c.label;
    const del = document.createElement("button");
    del.className = "btn small"; del.textContent = "断开";
    del.onclick = async () => {
      await invoke("extra_close", { id: c.id }).catch(() => {});
      sqConns = sqConns.filter((x) => x.id !== c.id);
      sqRenderConns(); sqRender();
      sqLog("连接 #" + c.id + " 已断开");
    };
    row.appendChild(del);
    box.appendChild(row);
  });
}

// ---------- 画布交互 ----------
function sqBindCanvas() {
  const cv = $("sq-canvas");
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const ui = uiScaleValue();
    const mx = (e.clientX - r.left) / ui, my = (e.clientY - r.top) / ui;
    const k0 = sqView.k;
    const k = Math.min(1.8, Math.max(0.45, k0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    sqView.x = mx - (mx - sqView.x) * (k / k0);
    sqView.y = my - (my - sqView.y) * (k / k0);
    sqView.k = k;
    sqApplyView(); sqRedrawEdges();
  }, { passive: false });

  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const port = e.target.closest ? e.target.closest(".seqport.out") : null;
    const nodeEl = e.target.closest ? e.target.closest(".seqnode") : null;
    const pathEl = e.target.closest ? e.target.closest(".seqedgegrp") : null;
    const portHit = (port && nodeEl) ? { el: port, nodeEl } : sqPortHitAt(e.clientX, e.clientY, ".seqport.out");
    if (portHit && portHit.nodeEl) {
      const outPort = portHit.el;
      sqSel = { kind: "node", id: portHit.nodeEl.dataset.id };
      const a = sqPortPos(portHit.nodeEl.dataset.id, outPort.dataset.port);
      sqTemp = { from: portHit.nodeEl.dataset.id, port: outPort.dataset.port, a: a, b: a };
      sqDrag = { mode: "link" };
      cv.classList.add("linking");
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      sqRenderCfg();
      e.preventDefault();
      return;
    }
    if (pathEl) {
      sqSel = { kind: "edge", id: pathEl.dataset.key };
      sqRenderCfg(); sqRedrawEdges();
      e.preventDefault();
      return;
    }
    if (nodeEl) {
      const n = sqNode(nodeEl.dataset.id);
      if (!n) return;
      sqSel = { kind: "node", id: n.id };
      const w = sqScreenToWorld(e.clientX, e.clientY);
      sqDrag = { mode: "node", id: n.id, dx: w.x - n.x, dy: w.y - n.y };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      sqRenderCfg(); sqRender();
      e.preventDefault();
      return;
    }
    sqSel = null;
    sqDrag = { mode: "pan", lastX: e.clientX, lastY: e.clientY };
    cv.classList.add("panning");
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    sqRenderCfg(); sqRedrawEdges();
  });

  cv.addEventListener("pointermove", (e) => {
    if (!sqDrag) {
      sqSetSnap(e.clientX, e.clientY, ".seqport.out", null, 10);
      return;
    }
    if (sqDrag.mode === "pan") {
      const ui = uiScaleValue();
      sqView.x += (e.clientX - sqDrag.lastX) / ui;
      sqView.y += (e.clientY - sqDrag.lastY) / ui;
      sqDrag.lastX = e.clientX;
      sqDrag.lastY = e.clientY;
      sqApplyView(); sqRedrawEdges();
    } else if (sqDrag.mode === "node") {
      const n = sqNode(sqDrag.id);
      if (!n) return;
      const w = sqScreenToWorld(e.clientX, e.clientY);
      n.x = Math.round(w.x - sqDrag.dx);
      n.y = Math.round(w.y - sqDrag.dy);
      const el = document.querySelector(".seqnode[data-id=\"" + n.id + "\"]");
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      sqRedrawEdges();
    } else if (sqDrag.mode === "link" && sqTemp) {
      const snap = sqSetSnap(e.clientX, e.clientY, ".seqport.in", sqTemp.from, 12);
      sqTemp.b = snap
        ? sqPortPos(snap.nodeEl.dataset.id, "in")
        : sqScreenToWorld(e.clientX, e.clientY);
      sqRedrawEdges();
    }
  });

  cv.addEventListener("pointerleave", () => {
    if (!sqDrag) sqClearSnap();
  });

  const endDrag = (e) => {
    cv.classList.remove("panning", "linking");
    if (sqDrag && sqDrag.mode === "link" && sqTemp) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const snapped = sqSetSnap(e.clientX, e.clientY, ".seqport.in", sqTemp.from, 12);
      const target = snapped?.nodeEl
        || (under && under.closest ? under.closest(".seqnode") : null)
        || (sqPortHitAt(e.clientX, e.clientY, ".seqport.in") || {}).nodeEl
        || null;
      if (target && target.dataset.id !== sqTemp.from) sqConnect(sqTemp.from, sqTemp.port, target.dataset.id);
    }
    if (sqDrag && sqDrag.mode === "node") sqSave();
    sqDrag = null; sqTemp = null;
    sqClearSnap();
    sqRedrawEdges();
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("dblclick", (e) => {
    if (e.target.closest && e.target.closest(".seqnode")) return;
    const c0 = cv.getBoundingClientRect();
    sqAddNode("step", (e.clientX - c0.left - sqView.x) / sqView.k - 93, (e.clientY - c0.top - sqView.y) / sqView.k - 20);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if ($("sq-canvas").closest("[hidden]") || !sqSel) return;
    const ae = document.activeElement;
    if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return;
    if (sqSel.kind === "node") sqDeleteNode(sqSel.id); else sqDeleteEdge(sqSel.id);
    e.preventDefault();
  });
}

// ---------- 运行 ----------
function sqMark(id) {
  sqRunNode = id;
  document.querySelectorAll(".seqnode").forEach((el) => el.classList.toggle("running", sqRunning && el.dataset.id === id));
}
function sqRxText() { return sqRx.map((x) => x.text).join(""); }
/** 从第 i 条收包起拼文本：base 用"第几条收包"当下标，比用字符长度稳 */
function sqRxTextFrom(i) { return sqRx.slice(i).map((x) => x.text).join(""); }
/** 同上，拼的是十六进制流（设备回二进制帧时用它做位判断/找帧头） */
function sqRxHexFrom(i) { return sqRx.slice(i).map((x) => x.hex || "").join(""); }

/** "A0 00 28" / "a00028" / "0xA0,0x00" 都当十六进制串解；解不出或者奇数位返回 null */
function sqHexBytes(str) {
  const t = String(str == null ? "" : str).replace(/0[xX]/g, "").replace(/[^0-9a-fA-F]/g, "");
  if (!t.length || t.length % 2) return null;
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}

/**
 * 期待匹配。模式 n.waitMode：
 *   contains —— 收到的文本里包含 expect（默认）
 *   regex    —— expect 当正则表达式（expectIc = 忽略大小写）
 *   any      —— 收到任意数据就算命中
 *   mask     —— 位判断：在收到的**字节流**里找一段，使 (数据 & 掩码) == (期望值 & 掩码)；
 *               期望值 = expect（HEX），掩码 = maskMask（HEX，留空 = 全 F，即逐字节比较）
 * 返回 "hit" / null / "bad"（参数写错了）
 */
function sqMatch(n, text, hexText) {
  const mode = n.waitMode || "contains";
  if (mode === "any") return (text.length || hexText.length) ? "hit" : null;
  if (mode === "regex") {
    let re;
    try { re = new RegExp(n.expect || "", n.expectIc ? "i" : ""); }
    catch (_) { return "bad"; }
    return re.test(text) ? "hit" : null;
  }
  if (mode === "mask") {
    const v = sqHexBytes(n.expect);
    if (!v || !v.length) return "bad";
    const m = n.maskMask ? sqHexBytes(n.maskMask) : null;
    if (n.maskMask && (!m || m.length !== v.length)) return "bad";
    const data = sqHexBytes(hexText);
    if (!data || data.length < v.length) return null;
    for (let i = 0; i + v.length <= data.length; i++) {
      let ok = true;
      for (let j = 0; j < v.length; j++) {
        const mk = m ? m[j] : 0xff;
        if ((data[i + j] & mk) !== (v[j] & mk)) { ok = false; break; }
      }
      if (ok) return "hit";
    }
    return null;
  }
  const pat = n.expect || "";
  if (!pat) return (text.length || hexText.length) ? "hit" : null;   // 留空 = 任意数据
  return text.includes(pat) ? "hit" : null;
}

/** 给日志/节点正文用的一行描述 */
function sqExpectLabel(n) {
  const m = n.waitMode || "contains";
  if (m === "any") return en("任意数据");
  if (m === "regex") return en("正则") + " “" + (n.expect || "(空)") + "”";
  if (m === "mask") return en("位判断") + " " + (n.expect || "?") + " & " + (n.maskMask || "FF");
  return n.expect ? "“" + n.expect + "”" : en("任意数据");
}

/** 等数据；返回 "hit" | "timeout" | "stopped" | "bad" */
async function sqWaitFor(n, timeoutMs, base) {
  const t0 = Date.now();
  while (!sqStop) {
    const r = sqMatch(n, sqRxTextFrom(base), sqRxHexFrom(base));
    if (r === "bad") return "bad";
    if (r === "hit") return "hit";
    if (Date.now() - t0 >= timeoutMs) return "timeout";
    await sqSleep(50);
  }
  return "stopped";
}
/** 拿这一步要用的连接；临时 TCP 按需开一条并缓存 */
async function sqResolveConn(n) {
  if (n.conn === "serial") {
    const skey = "serial:" + String(n.comPort || "");
    if (sqRunConns[skey]) return sqRunConns[skey];
    const r = await invoke("extra_open", { endpoint: { mode: "serial", port: n.comPort,
      config: { baud: Number(n.comBaud) || 115200, data_bits: "eight", stop_bits: "one", parity: "none", flow_control: "none" } } });
    sqRunConns[skey] = r.id;
    sqLog("临时串口已打开 #" + r.id + " " + r.label);
    return r.id;
  }
  if (n.conn === "tcp" || n.conn === "udp") {
    const key = n.conn + ":" + String(n.localAddr || "") + ":" + String(n.host || "") + ":" + String(n.port || 0);
    if (sqRunConns[key]) return sqRunConns[key];
    const ep = n.conn === "udp"
      ? { mode: "udp", local_addr: n.localAddr || null, local_port: Number(n.localPort) || 0, remote_host: n.host, remote_port: Number(n.port) }
      : { mode: "tcp_client", local_addr: n.localAddr || null, host: n.host, port: Number(n.port) };
    const r = await invoke("extra_open", { endpoint: ep });
    sqRunConns[key] = r.id;
    sqLog("临时 " + n.conn.toUpperCase() + " 已连接 #" + r.id + " " + r.label);
    return r.id;
  }
  if (n.conn === "ssh") {
    const key = "ssh:" + String(n.sshHost || "") + ":" + String(n.sshPort || 22) + ":" + String(n.sshUser || "");
    if (sqRunConns[key]) return sqRunConns[key];
    const r = await invoke("extra_open", { endpoint: {
      mode: "ssh", host: n.sshHost || "", port: Number(n.sshPort) || 22,
      user: n.sshUser || "", password: n.sshPass || "", extra: n.sshExtra || "",
    } });
    sqRunConns[key] = r.id;
    sqLog("临时 SSH 已连接 #" + r.id + " " + r.label);
    // 等远端 shell 就绪（提示符 / banner）：不然第一条命令会赶在 shell 起来之前发出去，白丢
    const base0 = sqRx.length;
    const t0 = Date.now();
    const budget = Number(n.sshReady) || 6000;
    while (!sqStop && Date.now() - t0 < budget) {
      const txt = sqRxTextFrom(base0);
      if (/[$#>%]\s*$/.test(txt.trim()) || /\n/.test(txt)) break;
      await sqSleep(100);
    }
    if (sqRxTextFrom(base0)) sqLog("   远端已就绪（" + (Date.now() - t0) + "ms）");
    return r.id;
  }
  return n.conn || "main";
}
function sqSendBy(id, payload, mode) {
  const lineEnding = $("line-ending").value;
  if (id === "main") return invoke("write_data", { payload, mode, lineEnding });
  return invoke("extra_write", { id: Number(id), payload, mode, lineEnding });
}
/** 跑一步，返回走哪个出口端口 */
async function sqRunStep(n, idx) {
  if (n.conn === "local") {
    sqLog(idx + ". 本机命令：" + n.cmd);
    let r;
    try { r = await invoke("local_run", { cmd: n.cmd, timeoutMs: Number(n.cmdTimeout) || 4000 }); }
    catch (e) { sqLog("命令失败：" + e, "err"); return "err"; }
    const out = String(r.stdout || "");
    const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0] || "";
    const hit = !n.expectOut || out.includes(n.expectOut);
    sqLog("   退出码 " + r.code + (tail ? " · " + tail.trim() : ""), r.code === 0 && hit ? "ok" : "err");
    return (r.code === 0 && hit) ? "ok" : "err";
  }
  let conn;
  try { conn = await sqResolveConn(n); }
  catch (e) {
    const s = String(e);
    if (s.includes("10061") || s.toLowerCase().includes("refused")) {
      sqLog("   连不上：" + s + "  → 对端没在监听这个端口（设备上对应服务没起来 / 端口不对）", "err");
    } else {
      sqLog("   连不上：" + s, "err");
    }
    return "err";
  }
  const base = sqRx.length;
  sqLog(idx + ". 发送 → " + sqConnText(n) + "：" + JSON.stringify(n.payload || "") + (n.hex ? " [HEX]" : ""));
  try { await sqSendBy(conn, n.payload || "", n.hex ? "hex" : "text"); }
  catch (e) { sqLog("   发送失败：" + e, "err"); return "err"; }
  let port = "ok";
  if (n.wait) {
    sqLog("   等 " + sqExpectLabel(n) + "（" + (n.timeout || 0) + "ms）");
    const r = await sqWaitFor(n, Number(n.timeout) || 5000, base);
    if (r === "stopped") return "stopped";
    if (r === "bad") {
      sqLog("   期待匹配写错了（正则不合法 / HEX 位数不对 / 掩码长度不一致），这一步按失败处理", "err");
      return "err";
    }
    sqLog(r === "hit" ? "   收到数据" : "   超时没等到", r === "hit" ? "ok" : "err");
    if (r === "timeout") port = "timeout";
  }
  if (n.after) {
    sqLog("   延时 " + n.after + " ms");
    await sqSleep(n.after);
  }
  return port;
}
async function sqRunGraph() {
  if (sqRunning) return;
  const start = sqGraph.nodes.find((n) => n.type === "start");
  if (!start) return toast("画布上没有「开始」节点");
  sqRunning = true; sqStop = false; sqRunConns = {};
  $("sq-run").disabled = true;
  $("sq-state").textContent = "运行中";
  sqLog("──── 开始运行（" + sqGraph.nodes.length + " 节点 / " + sqGraph.edges.length + " 连线）", "ok");
  sqMark(start.id);
  const queue = sqEdgesFrom(start.id, "out").map((e) => e.to);
  if (!queue.length) sqLog("「开始」没有连线，流程结束");
  let guard = 0;
  try {
    while (queue.length && !sqStop && guard++ < 400) {
      const cur = queue.shift();
      const n = sqNode(cur);
      if (!n) continue;
      sqMark(n.id);
      if (n.type === "end" || n.type === "fail") {
        sqLog(n.type === "end" ? "✔ 正常结束" : "✘ 失败结束", n.type === "end" ? "ok" : "err");
        const backs = sqEdgesFrom(n.id, "out");
        if (!backs.length) {
          if (!queue.length) break;          // 这条分支到这儿完了；还有别的分支就继续
          continue;
        }
        if (guard > 200) { sqLog("   已经跑了 200 步，像是死循环，先停下", "err"); break; }
        sqLog("   ↻ 回流：从「" + SQ_KINDS[n.type].name + "」继续（第 " + guard + " 步）");
        queue.push(...backs.map((e) => e.to));
        continue;
      }
      let port = "out";
      if (n.type === "delay") {
        sqLog("延时 " + (n.ms || 0) + " ms");
        await sqSleep(n.ms || 0);
      } else if (n.type === "branch") {
        const tail = sqRxText().slice(-600);
        let ok = false;
        if (n.mode === "nonempty") ok = !!tail.trim();
        else if (n.mode === "regex") { try { ok = new RegExp(n.value || "").test(tail); } catch (_) { ok = false; } }
        else ok = tail.includes(n.value || "");
        port = ok ? "true" : "false";
        sqLog("条件判断 → " + (ok ? "是" : "否"), "ok");
      } else if (n.type === "step") {
        port = await sqRunStep(n, guard);
        if (port === "stopped") break;
      }
      const nx = sqEdgesFrom(n.id, port);
      if (!nx.length) {
        sqLog("「" + SQ_KINDS[n.type].name + "」的「" + port + "」没有连线 —— 这条分支结束");
        continue;                             // 别把整轮停掉：其它分支/队列里还有事
      }
      if (nx.length > 1) sqLog("   扇出 " + nx.length + " 条 → 依次执行");
      queue.push(...nx.map((e) => e.to));
    }
    if (sqStop) sqLog("已停止", "err");
  } catch (err) {
    sqLog("运行出错：" + err, "err");
  } finally {
    sqRunning = false; sqStop = false;
    $("sq-run").disabled = false;
    $("sq-state").textContent = "空闲";
    sqMark(null);
    for (const k of Object.keys(sqRunConns)) {
      invoke("extra_close", { id: sqRunConns[k] }).catch(() => {});
      sqLog("临时连接已断开 " + k);
    }
    sqRunConns = {};
  }
}

/** 示例：本机 ping 设备 →(通) TCP 23 发一串 HEX →(有回) 串口发命令 → 结束；
 *          ping 不通 → TCP 服务端口发一帧 HEX → 有回=结束 / 没回=失败结束 */
function sqLoadExample() {
  sqGraph = { nodes: [], edges: [] };
  sqSeq = 1;
  const mk = (type, x, y, cfg) => { const n = sqNewNode(type); n.x = x; n.y = y; Object.assign(n, cfg || {}); sqGraph.nodes.push(n); return n; };
  const start = mk("start", 70, 40);
  const ping = mk("step", 70, 160, { conn: "local", cmd: "ping -n 1 -w 1000 192.168.1.100", cmdTimeout: 4000 });
  const d1 = mk("delay", 330, 250, { ms: 50 });
  const s23 = mk("step", 70, 300, { conn: "tcp", host: "192.168.1.100", port: 23, payload: "48 65 6C 6C 6F 0D 0A", hex: true, wait: true, expect: "", timeout: 3000, after: 200 });
  const sCom = mk("step", 70, 450, { conn: "main", payload: "ls", wait: true, expect: "", timeout: 5000, after: 50 });
  // 服务端口那条路：发一帧自定义 HEX 协议，等设备回一帧
  const sSvc = mk("step", 620, 300, { conn: "tcp", host: "192.168.1.100", port: 6666,
    payload: "53 56 43 31 00 07 00 02 00 00 00 01 C3", hex: true,
    wait: true, expect: "", timeout: 5000, after: 100 });
  const e1 = mk("end", 330, 600);
  const e2 = mk("end", 620, 470);
  const e3 = mk("fail", 880, 470);
  const link = (a, p, b) => sqGraph.edges.push({ from: a.id, port: p, to: b.id });
  link(start, "out", ping);
  link(ping, "ok", d1);
  link(d1, "out", s23);
  link(ping, "err", sSvc);
  link(s23, "ok", sCom);
  link(s23, "err", sSvc);
  link(s23, "timeout", sSvc);
  link(sCom, "ok", e1);
  link(sCom, "timeout", e3);
  link(sCom, "err", e3);
  link(sSvc, "ok", e2);
  link(sSvc, "timeout", e3);
  link(sSvc, "err", e3);
  sqSel = null;
  sqSave(); sqRender(); sqFit();
  sqLog("已载入示例：本机 ping → TCP 23 发一段 HEX → 串口发一条命令；ping 不通走服务端口（6666）发一帧 HEX", "ok");
  toast("示例编排已载入");
}

// ---------- 绑定 ----------
function bindSeq() {
  sqLoadCfg();
  sqEnsureStart();
  fillSelect($("sq-ports"), Array.from($("ports").options).map((o) => [o.value, o.textContent]), $("ports").value);
  fillSelect($("sq-baud"), BAUDS.map((b) => [String(b), String(b)]), String(currentBaud));
  const swMode = () => {
    document.querySelectorAll("[data-sqm]").forEach((e) => { e.hidden = e.dataset.sqm !== $("sq-mode").value; });
  };
  $("sq-mode").onchange = swMode; swMode();
  $("sq-add-conn").onclick = async () => {
    const m = $("sq-mode").value;
    const ep = m === "serial"
      ? { mode: "serial", port: $("sq-ports").value, config: { baud: Number($("sq-baud").value), data_bits: "eight", stop_bits: "one", parity: "none", flow_control: "none" } }
      : { mode: "tcp_client", host: $("sq-host").value.trim(), port: Number($("sq-port").value) };
    try {
      const r = await invoke("extra_open", { endpoint: ep });
      sqConns.push({ id: r.id, label: r.label });
      sqRenderConns(); sqRender();
      sqLog("连接已建立 #" + r.id + " " + r.label);
    } catch (e) { toast("添加连接失败: " + e); }
  };
  document.querySelectorAll("[data-add]").forEach((b) => {
    b.onclick = () => { const s2 = sqFreeSpot(); sqAddNode(b.dataset.add, s2.x, s2.y); };
  });
  $("sq-example").onclick = sqLoadExample;
  $("sq-fit").onclick = sqFit;
  $("sq-tidy").onclick = sqAutoLayout;
  $("sq-run").onclick = sqRunGraph;
  $("sq-stop").onclick = () => { sqStop = true; sqLog("收到停止请求"); };
  $("sq-clear-log").onclick = () => { $("sq-log").innerHTML = ""; sqLogNo = 0; };
  $("sq-clear").onclick = () => {
    sqGraph = { nodes: [], edges: [] };
    sqEnsureStart(); sqSel = null; sqSave(); sqRender();
    sqLog("画布已清空");
  };
  $("sq-save").onclick = async () => {
    try {
      const p = await dlgSave({ title: "导出编排", defaultPath: "workflow.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!p) return;
      await writeTextFile(p, JSON.stringify(sqGraph, null, 2));
      toast("已导出到 " + p);
    } catch (e) { toast(String(e)); }
  };
  $("sq-load").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "导入编排", multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      const txt = new TextDecoder().decode(await readFile(path0));
      const v = JSON.parse(txt);
      if (!Array.isArray(v.nodes)) throw new Error("不是编排文件");
      sqGraph = { nodes: v.nodes, edges: v.edges || [] };
      sqSanitize();
      sqSel = null; sqSeq = sqGraph.nodes.length + 1;
      sqEnsureStart(); sqSave(); sqRender(); sqFit();
      toast("已导入 " + sqGraph.nodes.length + " 节点 / " + sqGraph.edges.length + " 连线");
    } catch (e) { toast(String(e)); }
  };
  sqBindCanvas();
  sqRenderConns();
  sqRender();
  $("sq-state").textContent = "空闲";
  sqLog("画布就绪：加「步骤」节点，每步绑一个连接；发完可以勾「发送后等待数据」。");
}


// ---------------- 命令表：标准 Linux 命令速查（点名字填进输入框，点 ▶ 直接发） ----------------
// 面向"设备上跑的是 Linux 类 shell"的通用场景：这里是**标准命令**，没有项目私有命令。
// 说明文字按 "名字 | 参数模板 | 说明 | 分组" 组织；参数模板里的 <> 是占位。
const CSHELL_CMDS = [
  // 文件
  ["ls", "[-l] [dir]", "列目录", "文件"],
  ["cd", "<dir>", "切换目录", "文件"],
  ["pwd", "", "显示当前目录", "文件"],
  ["cat", "<file>", "打印文件内容", "文件"],
  ["less", "<file>", "分页查看文件", "文件"],
  ["head", "<file> [-n 10]", "看前 n 行", "文件"],
  ["tail", "<file> [-n 10]", "看后 n 行", "文件"],
  ["mkdir", "[-p] <dir>", "建目录", "文件"],
  ["rm", "[-rf] <path>", "删除文件/目录", "文件"],
  ["cp", "[-r] <src> <dst>", "复制", "文件"],
  ["mv", "<src> <dst>", "移动 / 改名", "文件"],
  ["touch", "<file>", "建空文件 / 改时间", "文件"],
  ["ln", "-s <target> <link>", "建软链接", "文件"],
  ["find", "<dir> -name '<pat>'", "按名字找文件", "文件"],
  ["stat", "<path>", "看类型 / 大小 / 时间", "文件"],
  ["du", "-sh <dir>", "统计占用", "文件"],
  ["df", "-h", "文件系统占用", "文件"],
  ["tree", "[-L 2] [dir]", "递归列目录（需已安装）", "文件"],
  ["file", "<file>", "猜文件类型", "文件"],
  // 文本
  ["echo", "<text>", "回显 / 重定向", "文本"],
  ["grep", "[-rn] '<pat>' <path>", "搜索文本", "文本"],
  ["sed", "-n '<range>p' <file>", "流编辑", "文本"],
  ["awk", "'{print $1}' <file>", "按列处理", "文本"],
  ["cut", "-d: -f1 <file>", "按分隔符取列", "文本"],
  ["sort", "<file>", "排序", "文本"],
  ["uniq", "-c", "去重（配合 sort）", "文本"],
  ["wc", "-l <file>", "统计行/字/字节", "文本"],
  ["tr", "'a-z' 'A-Z'", "字符替换", "文本"],
  ["diff", "<a> <b>", "比较两个文件", "文本"],
  ["xxd", "<file> | head", "十六进制查看", "文本"],
  // 系统
  ["uname", "-a", "内核 / 架构信息", "系统"],
  ["date", "", "系统时间", "系统"],
  ["uptime", "", "运行时长 / 负载", "系统"],
  ["free", "-h", "内存占用", "系统"],
  ["ps", "aux", "进程列表", "系统"],
  ["top", "-b -n 1", "进程快照", "系统"],
  ["kill", "[-9] <pid>", "结束进程", "系统"],
  ["dmesg", "| tail -n 20", "内核日志", "系统"],
  ["env", "", "环境变量", "系统"],
  ["export", "KEY=value", "设置环境变量", "系统"],
  ["sync", "", "刷写缓存到存储", "系统"],
  ["mount", "", "查看挂载", "系统"],
  ["reboot", "", "重启设备", "系统"],
  ["sleep", "1", "等待 1 秒", "系统"],
  ["which", "<cmd>", "命令路径", "系统"],
  // 网络
  ["ip", "addr", "网卡地址", "网络"],
  ["ifconfig", "", "网卡信息（旧写法）", "网络"],
  ["ping", "-c 4 <host>", "连通性测试", "网络"],
  ["netstat", "-ant", "连接 / 端口", "网络"],
  ["ss", "-ant", "连接 / 端口（新写法）", "网络"],
  ["curl", "-s <url>", "HTTP 请求", "网络"],
  ["wget", "<url>", "下载文件", "网络"],
  ["nc", "-zv <host> <port>", "端口探测", "网络"],
  // 权限
  ["chmod", "755 <path>", "改权限", "权限"],
  ["chown", "root:root <path>", "改属主", "权限"],
  ["id", "", "当前用户 / 组", "权限"],
  ["whoami", "", "当前用户名", "权限"],
  ["sudo", "<cmd>", "提权执行", "权限"],
];

/* ── 指令表：可编辑、可持久化 ─────────────────────────────────────────
 * 结构：{ groups: [ { name, items: [ { name, args, desc } ] } ] }
 * 内置的那份（CSHELL_CMDS，标准 Linux 指令）只是"默认值"：第一次运行写进
 * agent/commands.json，之后用户加/改/删都以文件为准（设置 → 缓存 里能看到/删掉它）。 */
let CMD_TABLE = { groups: [] };

const cmdDefaults = () => {
  const groups = [];
  for (const [name, args, desc, grp] of CSHELL_CMDS) {
    let g = groups.find((x) => x.name === grp);
    if (!g) { g = { name: grp, items: [] }; groups.push(g); }
    g.items.push({ name, args, desc });
  }
  return { groups };
};

async function cmdTableLoad() {
  let t = null;
  try { t = await invoke("command_table_get"); } catch (_) { t = null; }
  if (!t || !Array.isArray(t.groups) || !t.groups.length) {
    CMD_TABLE = cmdDefaults();
    await cmdTableSave();          // 首次运行：把默认指令集落盘
  } else {
    CMD_TABLE = t;
  }
  buildCmdTable();
}

async function cmdTableSave() {
  try { await invoke("command_table_save", { table: CMD_TABLE }); }
  catch (e) { toast(en("指令表保存失败：") + String(e)); }
}

function buildCmdTable() {
  const box = $("cmd-table");
  const kw = ($("cmd-filter").value || "").trim().toLowerCase();
  box.innerHTML = "";
  for (const g of CMD_TABLE.groups) {
    const items = (g.items || []).filter((it) => {
      if (!kw) return true;
      const line = `${it.name} ${it.args || ""}`.toLowerCase();
      return line.includes(kw) || String(it.desc || "").toLowerCase().includes(kw);
    });
    if (!items.length && kw) continue;
    const h = document.createElement("div");
    h.className = "navgroup cmdgrp";
    const gt = document.createElement("span");
    gt.textContent = en(g.name) + `（${(g.items || []).length}）`;
    h.append(gt);
    box.appendChild(h);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "cmdrow";
      const btn = document.createElement("button");
      btn.className = "cname";
      btn.textContent = it.name;
      btn.title = en("填进输入框");
      btn.onclick = () => {
        $("tx").value = it.args ? `${it.name} ${it.args}` : it.name;
        $("tx").focus();
        toast(en("已填入：") + $("tx").value);
      };
      const d2 = document.createElement("div");
      d2.className = "cdesc";
      const descShow = en(it.desc || "");
      d2.innerHTML = it.args ? `<code>${escapeHtml(it.args)}</code> — ${escapeHtml(descShow)}` : escapeHtml(descShow);
      const go = document.createElement("button");
      go.className = "btn small cgo";
      go.textContent = "▶";
      go.title = en("直接发送");
      go.onclick = async () => {
        if (it.args) {                 // 带参数的不直接发，先填进去让用户改
          $("tx").value = `${it.name} ${it.args}`;
          $("tx").focus();
          toast(en("这条要带参数，已填进输入框"));
          return;
        }
        await sendPayload(it.name, false);
      };
      row.append(btn, d2, go);
      box.appendChild(row);
    }
  }
  if (!box.children.length) box.innerHTML = '<p class="hint">' + en("没匹配的命令") + '</p>';
}

/* ── 指令表编辑器：加组 / 加指令 / 改名 / 删除 / 恢复默认，全在这个弹窗里 ── */
/** 新增一条指令（选组 + 填名字/参数/说明） */
async function cmdEditCommand(presetGroup) {
  if (!CMD_TABLE.groups.length) CMD_TABLE.groups.push({ name: en("自定义"), items: [] });
  const v = await kdForm({
    title: en("新增指令"),
    fields: [
      { id: "group", label: en("指令组"), value: presetGroup || CMD_TABLE.groups[0].name, ph: en("可以填新组名，会自动创建") },
      { id: "name", label: en("名字"), ph: "reboot" },
      { id: "args", label: en("参数模板"), ph: "[-f]" },
      { id: "desc", label: en("说明"), ph: en("这条是干什么的") },
    ],
  });
  if (!v || !v.name.trim()) return false;
  const gname = v.group.trim() || en("自定义");
  let g = CMD_TABLE.groups.find((x) => x.name === gname);
  if (!g) { g = { name: gname, items: [] }; CMD_TABLE.groups.push(g); }
  g.items.push({ name: v.name.trim(), args: v.args.trim(), desc: v.desc.trim() });
  await cmdTableSave(); buildCmdTable();
  toast(en("已加入指令表：") + v.name.trim());
  return true;
}

/** 改一条已有指令 */
async function cmdEditOne(g, it) {
  const v = await kdForm({
    title: en("编辑指令"),
    fields: [
      { id: "name", label: en("名字"), value: it.name },
      { id: "args", label: en("参数模板"), value: it.args || "", ph: "[-l] [dir]" },
      { id: "desc", label: en("说明"), value: it.desc || "", ph: "(optional)" },
    ],
  });
  if (!v) return false;
  it.name = v.name.trim() || it.name;
  it.args = v.args.trim();
  it.desc = v.desc.trim();
  await cmdTableSave(); buildCmdTable();
  return true;
}

/** 主页面那个「✎ 编辑指令表」打开的弹窗：所有增删改都在这儿 */
function cmdOpenEditor() {
  const mask = document.createElement("div");
  mask.className = "kdmodal";
  const box = document.createElement("div");
  box.className = "kdbox wide cmdedit";
  const head = document.createElement("div");
  head.className = "kdttl";
  head.textContent = en("指令表编辑器");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = en("主页面只管用：点名字填进输入框、▶ 直接发。加 / 改 / 删都在这里做，改完立刻存进 agent/commands.json。");

  const mkBtn = (label, cls, title) => {
    const b = document.createElement("button");
    b.className = "btn small" + (cls ? " " + cls : "");
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };
  const bar = document.createElement("div");
  bar.className = "trow cmdbar";
  const addGrp = mkBtn(en("+ 新增指令组"), "");
  const addCmd = mkBtn(en("+ 新增指令"), "primary");
  const sp = document.createElement("span");
  sp.className = "grow";
  const reset = mkBtn(en("恢复默认"), "danger", en("回到内置的标准 Linux 指令集"));
  const close = mkBtn(en("关闭"), "");
  bar.append(addGrp, addCmd, sp, reset, close);

  const list = document.createElement("div");
  list.className = "cmdlistscroll scrollable";

  // ── 拖动排序（HTML5 DnD）：指令组之间能拖动排顺序，组内的指令也能 ──
  // 只在行首的抓手「⋮⋮」上起拖：整行可拖会和"点名字填进输入框 / 选中代码"打架。
  let drag = null;                      // { kind: "group", g } | { kind: "item", g, it }
  const clearDrop = () => list.querySelectorAll(".dropb,.dropa").forEach((e) => e.classList.remove("dropb", "dropa"));
  const mkGrip = (title, target, onStart) => {
    const el = document.createElement("span");
    el.className = "grip";
    el.textContent = "⋮⋮";
    el.title = title;
    el.draggable = true;
    el.ondragstart = (e) => {
      onStart();
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setDragImage(target, 10, 10); } catch (_) { /* 某些环境不给设拖影 */ }
      target.classList.add("dragging");
    };
    el.ondragend = () => { drag = null; target.classList.remove("dragging"); clearDrop(); };
    return el;
  };
  /** 只接"同类"的拖动：拖组时高亮组头，拖指令时只高亮同组的指令行 */
  const dragOver = (e, node, kind, g) => {
    if (!drag || drag.kind !== kind) return;
    if (kind === "item" && drag.g !== g) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    node.classList.toggle("dropb", !after);
    node.classList.toggle("dropa", after);
  };
  const dropOn = async (e, node, kind, g, it) => {
    if (!drag || drag.kind !== kind) return;
    if (kind === "item" && drag.g !== g) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (kind === "group") {
      const from = CMD_TABLE.groups.indexOf(drag.g);
      if (from < 0 || drag.g === g) { clearDrop(); return; }
      CMD_TABLE.groups.splice(from, 1);
      const to = CMD_TABLE.groups.indexOf(g) + (after ? 1 : 0);
      CMD_TABLE.groups.splice(to, 0, drag.g);
    } else {
      const items = g.items || (g.items = []);
      const from = items.indexOf(drag.it);
      if (from < 0 || drag.it === it) { clearDrop(); return; }
      items.splice(from, 1);
      const to = items.indexOf(it) + (after ? 1 : 0);
      items.splice(to, 0, drag.it);
    }
    drag = null; clearDrop();
    await cmdTableSave(); buildCmdTable(); redraw();
  };

  const closeMask = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeMask(); } };
  document.addEventListener("keydown", onKey);
  close.onclick = closeMask;
  mask.onclick = (e) => { if (e.target === mask) closeMask(); };

  const redraw = () => {
    list.innerHTML = "";
    if (!CMD_TABLE.groups.length) {
      list.innerHTML = '<p class="hint">' + en("（空的：点「+ 新增指令组」或者「恢复默认」）") + '</p>';
      return;
    }
    for (const g of CMD_TABLE.groups) {
      const gh = document.createElement("div");
      gh.className = "cmdeditgrp";
      const gt = document.createElement("b");
      gt.textContent = en(g.name);
      const gn = document.createElement("span");
      gn.className = "lb";
      gn.textContent = `${(g.items || []).length} ${en("条")}`;
      const gSp = document.createElement("span");
      gSp.className = "grow";
      const gRen = mkBtn("✎", "", en("改组名"));
      const gDel = mkBtn("✕", "danger", en("删掉这个组（连同组里的指令）"));
      const addHere = mkBtn(en("+ 加一条到本组"), "", en("往这个组里加一条指令"));
      const gGrip = mkGrip(en("拖动排序（整个指令组）"), gh, () => { drag = { kind: "group", g }; });
      gh.ondragover = (e) => dragOver(e, gh, "group", null);
      gh.ondragleave = () => gh.classList.remove("dropb", "dropa");
      gh.ondrop = (e) => dropOn(e, gh, "group", g, null);
      gh.append(gGrip, gt, gn, gSp, addHere, gRen, gDel);
      list.appendChild(gh);
      gRen.onclick = async () => {
        const v = await kdForm({ title: en("改指令组名"), fields: [{ id: "name", label: en("组名"), value: g.name }] });
        if (!v) return;
        g.name = v.name.trim() || g.name;
        await cmdTableSave(); buildCmdTable(); redraw();
      };
      gDel.onclick = async () => {
        if (!(await agConfirm(`${en("删掉指令组")}「${g.name}」${en("连同里面的")} ${(g.items || []).length} ${en("条指令？")}`, en("删除指令组"), true))) return;
        CMD_TABLE.groups = CMD_TABLE.groups.filter((x) => x !== g);
        await cmdTableSave(); buildCmdTable(); redraw();
      };
      addHere.onclick = async () => { if (await cmdEditCommand(g.name)) redraw(); };

      for (const it of g.items || []) {
        const row = document.createElement("div");
        row.className = "cmdrow ed";
        const nm = document.createElement("button");
        nm.className = "cname";
        nm.textContent = it.name;
        nm.title = en("点一下填进输入框并关掉这个弹窗");
        nm.onclick = () => {
          $("tx").value = it.args ? `${it.name} ${it.args}` : it.name;
          $("tx").focus();
          closeMask();
        };
        const d2 = document.createElement("div");
        d2.className = "cdesc";
        d2.innerHTML = it.args
          ? `<code>${escapeHtml(it.args)}</code> — ${escapeHtml(en(it.desc || ""))}`
          : escapeHtml(en(it.desc || ""));
        const ed = mkBtn("✎", "", en("编辑这条指令"));
        ed.onclick = async () => { if (await cmdEditOne(g, it)) redraw(); };
        const del = mkBtn("✕", "danger", en("删掉这条指令"));
        del.onclick = async () => {
          g.items = (g.items || []).filter((x) => x !== it);
          await cmdTableSave(); buildCmdTable(); redraw();
        };
        const grip = mkGrip(en("拖动排序（同一组内）"), row, () => { drag = { kind: "item", g, it }; });
        row.ondragover = (e) => dragOver(e, row, "item", g);
        row.ondragleave = () => row.classList.remove("dropb", "dropa");
        row.ondrop = (e) => dropOn(e, row, "item", g, it);
        row.append(grip, nm, d2, ed, del);
        list.appendChild(row);
      }
      const hr = document.createElement("div");
      hr.className = "cmdedithr";
      list.appendChild(hr);
    }
  };

  addGrp.onclick = async () => {
    const v = await kdForm({ title: en("新增指令组"), fields: [{ id: "name", label: en("组名"), ph: en("例：我的板子专用") }] });
    if (!v || !v.name.trim()) return;
    if (CMD_TABLE.groups.some((x) => x.name === v.name.trim())) return toast(en("这个组已经存在"));
    CMD_TABLE.groups.push({ name: v.name.trim(), items: [] });
    await cmdTableSave(); buildCmdTable(); redraw();
  };
  addCmd.onclick = async () => { if (await cmdEditCommand()) redraw(); };
  reset.onclick = async () => {
    if (!(await agConfirm(en("恢复成内置的标准 Linux 指令集？你自己加的组和指令会丢掉。"), en("恢复默认指令表"), true))) return;
    CMD_TABLE = cmdDefaults();
    await cmdTableSave(); buildCmdTable(); redraw();
    toast(en("已恢复默认指令表"));
  };

  box.append(head, hint, bar, list);
  mask.appendChild(box);
  document.body.appendChild(mask);
  redraw();
}

function bindCmdTable() {
  cmdTableLoad();                  // 后端那份为准（没有就写默认）
  $("cmd-filter").oninput = buildCmdTable;
  if ($("cmd-help")) $("cmd-help").onclick = cmdHelp;
  if ($("cmd-edit")) $("cmd-edit").onclick = () => cmdOpenEditor();
}

/** 指令表帮助 */
function cmdHelp() {
  toast([
    en("点名字=填进发送框；▶=直接发（带参数的会先填进去让你补）"),
    en("要加 / 改 / 删就点「✎ 编辑指令表」：组和指令都在那个弹窗里管，组名可以随便起"),
    en("改完立刻存进 agent/commands.json，下次开机还在（「设置 → 缓存」里能看到、也能删）"),
    en("弹窗里的「恢复默认」= 回到内置的标准 Linux 指令集"),
  ].join("\n"));
}

// ---------------- 快捷发送：常用命令一键发 ----------------
// 默认给几条最常敲的通用命令；用户可以在右边自己改（存在 localStorage 里）
const QS_DEFAULT = [
  { label: "ls", payload: "ls", hex: false },
  { label: "pwd", payload: "pwd", hex: false },
  { label: "空间", payload: "df -h", hex: false },
  { label: "内存", payload: "free -h", hex: false },
  { label: "时间", payload: "date", hex: false },
  { label: "进程", payload: "ps aux", hex: false },
];
function qsLoad() {
  try {
    const v = JSON.parse(localStorage.getItem("kdock_quick") || "null");
    if (Array.isArray(v) && v.length) return v;
  } catch (_) {}
  return QS_DEFAULT.slice();
}
let qsItems = qsLoad();
function qsSave() { localStorage.setItem("kdock_quick", JSON.stringify(qsItems)); }

async function sendPayload(payload, hex) {
  if (!payload) return;
  try {
    const le = $("line-ending").value;
    const ack = await invoke("write_data", { payload, mode: hex ? "hex" : "text", lineEnding: le });
    if (!rxPaused) pushEntry({ dir: "TX", ts_ms: Date.now(), text: ack.text, hex: ack.hex, ascii: ack.ascii });
    if ($("history") && !hex && history[0] !== payload) {
      history.unshift(payload);
      history = history.slice(0, 30);
      refreshHistory();
    }
  } catch (e) { toast(String(e)); }
}

function refreshHistory() {
  const sel = $("history");
  sel.innerHTML = '<option value="">历史…</option>';
  history.forEach((h, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = h.length > 60 ? h.slice(0, 60) + "…" : h;
    sel.appendChild(o);
  });
}

/* ── 快捷发送：主页面只管"点一下发"，增 / 改 / 删都在弹窗里（跟指令表一个路子） ── */
function qsCell(cls, text, tip) {
  const e = document.createElement("span");
  e.className = "c " + cls;
  e.textContent = text;
  if (tip) e.title = tip;
  return e;
}
function qsActBtn(icon, tip, fn, cls) {
  const b = document.createElement("button");
  b.className = "qsic" + (cls ? " " + cls : "");
  b.textContent = icon;
  b.title = en(tip);
  b.onclick = (ev) => { ev.stopPropagation(); fn(); };
  return b;
}

/** 一条快捷项的编辑器（新增传 -1，改传下标）：名称 / 内容 / HEX */
async function qsEditEntry(i) {
  const cur = i >= 0 ? qsItems[i] : null;
  const v = await kdForm({
    title: en(cur ? "编辑快捷发送" : "新增快捷发送"),
    okText: en(cur ? "保存" : "添加"),
    fields: [
      { id: "label", label: en("名称"), value: cur ? cur.label || "" : "", ph: en("列表里显示的名字（留空就用内容前几个字）") },
      { id: "payload", label: en("内容"), value: cur ? cur.payload || "" : "", ph: en("文本直接写；HEX 形如 41 54 0D 0A") },
      { id: "hex", label: en("HEX"), type: "checkbox", value: !!(cur && cur.hex) },
    ],
  });
  if (!v) return false;
  const payload = String(v.payload == null ? "" : v.payload).trim();
  if (!payload) { toast(en("先填要发送的内容")); return false; }
  const one = { label: String(v.label == null ? "" : v.label).trim() || payload.slice(0, 12), payload, hex: !!v.hex };
  if (i >= 0) { qsItems[i] = one; toast(en("已保存")); }
  else { qsItems.push(one); toast(en("已加入快捷发送")); }
  qsSave();
  qsRender();
  return true;
}

/** 「✎ 编辑」打开的弹窗：整张表都能在这儿增删改（样式借指令表编辑器那套） */
function qsOpenEditor() {
  const mask = document.createElement("div");
  mask.className = "kdmodal";
  const box = document.createElement("div");
  box.className = "kdbox cmdedit";
  box.style.width = "min(620px, 94vw)";
  box.style.maxWidth = "min(620px, 94vw)";
  const t = document.createElement("div");
  t.className = "kdttl";
  t.textContent = en("快捷发送编辑器");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = en("主页面点一行就直接发出去；加 / 改 / 删都在这里做，改完立刻存到本地。");
  const bar = document.createElement("div");
  bar.className = "trow cmdbar";
  const add = document.createElement("button");
  add.className = "btn small primary";
  add.textContent = en("＋ 新增一条");
  const sp = document.createElement("span");
  sp.className = "grow";
  const close = document.createElement("button");
  close.className = "btn small";
  close.textContent = en("关闭");
  bar.append(add, sp, close);
  const list = document.createElement("div");
  list.className = "cmdlistscroll scrollable";
  const redraw = () => {
    list.innerHTML = "";
    if (!qsItems.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = en("（还没有快捷项，点上面「＋ 新增一条」）");
      list.appendChild(p);
      return;
    }
    qsItems.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "qsrow";
      row.append(qsCell("lab", it.label || it.payload), qsCell("pay", it.payload), qsCell("kind", it.hex ? "HEX" : en("文本")));
      const acts = document.createElement("span");
      acts.className = "acts";
      acts.append(
        qsActBtn("▶", "直接发送", () => sendPayload(it.payload, it.hex)),
        qsActBtn("✎", "改这一条", async () => { if (await qsEditEntry(i)) redraw(); }),
        qsActBtn("✕", "删除这一条", () => { qsItems.splice(i, 1); qsSave(); qsRender(); redraw(); }, "del"),
      );
      row.appendChild(acts);
      list.appendChild(row);
    });
  };
  redraw();
  add.onclick = async () => { if (await qsEditEntry(-1)) redraw(); };
  close.onclick = () => mask.remove();
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
  box.append(t, hint, bar, list);
  mask.appendChild(box);
  document.body.appendChild(mask);
  if (LANG === "en") langWalk();
}

function qsRender() {
  const box = $("qs-list");
  if (!box) return;
  const q = ($("qs-filter").value || "").trim().toLowerCase();
  const hit = (it) => !q || (it.label + " " + it.payload).toLowerCase().includes(q);
  const shown = qsItems.map((it, i) => ({ it, i })).filter((x) => hit(x.it));
  box.innerHTML = "";
  if (!shown.length) {
    box.appendChild(qsCell("muted", en(qsItems.length ? "没有匹配的条目" : "（还没有快捷项，点上面的「✎ 编辑」加一条）")));
  }
  for (const { it, i } of shown) {
    const row = document.createElement("div");
    row.className = "qsrow";
    row.title = en("点这一行 = 直接发出去");
    row.append(
      qsCell("lab", en(it.label || it.payload)),
      qsCell("pay", it.payload, (it.hex ? "HEX: " : "") + it.payload),
      qsCell("kind", it.hex ? "HEX" : en("文本")),
    );
    const acts = document.createElement("span");
    acts.className = "acts";
    acts.append(
      qsActBtn("▶", "直接发送", () => sendPayload(it.payload, it.hex)),
      qsActBtn("✎", "改这一条", () => qsEditEntry(i)),
      qsActBtn("✕", "删除这一条", () => qsDelItem(i), "del"),
    );
    row.appendChild(acts);
    row.onclick = () => sendPayload(it.payload, it.hex);
    box.appendChild(row);
  }
  if ($("qs-count")) {
    $("qs-count").textContent = q ? shown.length + " / " + qsItems.length : (qsItems.length ? String(qsItems.length) : "");
  }
  if (LANG === "en") langWalk();       // 行是现拼的，英文界面下补翻一次
}
function qsDelItem(i) {
  qsItems.splice(i, 1);
  qsSave();
  qsRender();
}

function bindQuickSend() {
  qsRender();
  if ($("qs-edit")) $("qs-edit").onclick = () => qsOpenEditor();
  if ($("qs-filter")) $("qs-filter").oninput = () => qsRender();
}

/* ══════════ USB 诊断：设备树 / 描述符 / 热插拔（免驱，不装过滤驱动） ══════════
   SetupAPI 列设备（普通权限即可）；Hub IOCTL 读端口拓扑 + 设备/配置/接口/端点描述符
   （Windows 要求管理员 —— 点「以管理员读取端口」会拉起自己（--usb-dump）读一次再返回）。 */
/** 这个模块沿用 T() 的写法；en 在文件后面才定义，所以这里包一层惰性调用 */
const T = (s) => en(s);
let usbData = null;
let usbBusy = false;
let usbSel = null;          // { kind: "port" | "dev", key }
let usbAutoTimer = null;

/** Windows 设备问题码（CM_PROB_*）的常见几项 */
const USB_PROBLEM = { 1: "设备未配置", 10: "无法启动", 22: "已停用", 24: "设备未安装", 28: "没有驱动", 31: "驱动加载失败", 43: "驱动故障" };
const usbProblemText = (c) => (c ? (USB_PROBLEM[c] ? T(USB_PROBLEM[c]) : T("问题码") + " " + c) : "");

function usbMsg(t, bad) {
  const n = $("usb-sum");
  if (!n) return;
  n.textContent = t || "";
  n.style.color = bad ? "hsl(var(--destructive))" : "";
}

async function usbRefresh() {
  if (usbBusy) return;
  usbBusy = true;
  try {
    usbData = await invoke("usb_diag");
    usbRenderAll();
  } catch (e) {
    usbMsg(String(e && e.message ? e.message : e), true);
  } finally { usbBusy = false; }
}

async function usbElevate() {
  if (usbBusy) return;
  usbBusy = true;
  usbMsg(T("等待 UAC 授权…"));
  try {
    usbData = await invoke("usb_diag_elevated");
    usbRenderAll();
    toast(T("已读到端口 / 描述符"));
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    usbMsg(m, true);
    toast(m);
  } finally { usbBusy = false; }
}

function usbRenderSummary() {
  if (!usbData) return;
  const devs = usbData.devices || [];
  const hubs = usbData.hubs || [];
  const ports = hubs.reduce((n, h) => n + ((h.ports || []).length), 0);
  let text = T("USB 设备 {n} · 端口设备 {m} · 串口 {s}")
    .replace("{n}", devs.length)
    .replace("{m}", ports)
    .replace("{s}", ((usbData.serial || []).length));
  if (!usbData.admin) text += " · " + T("只读设备列表");
  const warns = (usbData.warnings || []).length;
  if (warns) text += " · " + T("警告 {n}").replace("{n}", warns);
  usbMsg(text);
}

/** 设备类型标签：COM / Hub / 蓝牙 / HID / 存储 / 网络 / 调试器 … */
function usbKindTags(d, coms) {
  const out = [];
  const add = (cls, text) => {
    if (text && !out.some((x) => x.cls === cls && x.text === text)) out.push({ cls, text });
  };
  if (coms && coms.length) add("com", coms.join("/"));
  const cls = String(d.class || "").toLowerCase();
  const service = String(d.service || "").toLowerCase();
  const name = String(d.name || "").toLowerCase();
  const inst = String(d.instance || "").toLowerCase();
  const all = name + " " + inst;
  if (all.includes("hub") || inst.includes("root_hub")) add("hub", T("Hub"));
  if (cls.includes("bluetooth") || name.includes("bluetooth")) add("bt", "BT");
  else if (cls.includes("hid") || name.includes("input device")) add("hid", "HID");
  else if (cls.includes("usbstor") || name.includes("mass storage")) add("storage", T("存储"));
  else if (cls.includes("net") || name.includes("ethernet") || name.includes("wi-fi")) add("net", T("网络"));
  else if (cls.includes("audio")) add("audio", T("音频"));
  else if (cls.includes("image") || name.includes("camera")) add("cam", T("相机"));
  else if (cls.includes("printer")) add("prn", T("打印机"));
  if (name.includes("j-link") || name.includes("st-link") || name.includes("cmsis-dap") || name.includes("debug probe")) add("debug", T("调试器"));
  if (name.includes("host controller")) add("host", "HOST");
  if (service === "usbccgp" || name.includes("composite device")) add("composite", T("复合"));
  return out;
}
/** 右侧设备管理器：串口 / Hub 端口树 / SetupAPI 设备列表 */
function usbRenderList() {
  const box = $("usb-list");
  if (!box) return;
  const keepTop = box.scrollTop;
  box.textContent = "";
  const serials = (usbData && usbData.serial) || [];
  if (serials.length) {
    const sh = document.createElement("div");
    sh.className = "usbhub";
    sh.textContent = T("串口（COM）");
    box.appendChild(sh);
    for (const sp of serials) {
      const row = document.createElement("div");
      const sel = usbSel && usbSel.kind === "com" && usbSel.key === sp.port;
      row.className = "usbrow usbcom" + (sel ? " sel" : "");
      row.title = sp.product || sp.port;
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = sp.port;
      const id = document.createElement("span"); id.className = "id";
      id.textContent = sp.vid ? sp.vid + ":" + sp.pid : T("非 USB");
      row.append(nm, id);
      row.onclick = () => { usbSel = { kind: "com", key: sp.port }; usbRenderList(); };
      box.appendChild(row);
    }
  }
  const hubs = (usbData && usbData.hubs) || [];
  if (hubs.length) {
    for (const h of hubs) {
      const head = document.createElement("div");
      head.className = "usbhub";
      head.textContent = T("Hub") + " · " + (h.instance || "");
      box.appendChild(head);
      for (const p of (h.ports || [])) {
        const key = (h.instance || "") + "#" + p.port;
        const row = document.createElement("div");
        row.className = "usbrow usbport" + (usbSel && usbSel.kind === "port" && usbSel.key === key ? " sel" : "");
        row.title = T("端口 {n} · {s}").replace("{n}", p.port).replace("{s}", p.speed);
        const nm = document.createElement("span"); nm.className = "nm";
        nm.textContent = "Port " + p.port + (p.isHub ? " · " + T("Hub") : "");
        const id = document.createElement("span"); id.className = "id";
        id.textContent = p.vid + ":" + p.pid;
        row.append(nm, id);
        row.onclick = () => { usbSel = { kind: "port", key }; usbRenderList(); };
        box.appendChild(row);
      }
    }
  } else {
    const d = document.createElement("p"); d.className = "hint";
    d.textContent = T("端口拓扑要管理员权限：点上面的「以管理员读取端口」。");
    box.appendChild(d);
  }
  const head2 = document.createElement("div");
  head2.className = "usbhub";
  head2.textContent = T("所有 USB 设备（SetupAPI）");
  box.appendChild(head2);
  const comMap = new Map();
  for (const sp of ((usbData && usbData.serial) || [])) {
    if (!sp.vid || !sp.pid) continue;
    const k = sp.vid + ":" + sp.pid;
    comMap.set(k, (comMap.get(k) || []).concat([sp.port]));
  }
  for (const d of ((usbData && usbData.devices) || [])) {
    const row = document.createElement("div");
    const sel = usbSel && usbSel.kind === "dev" && usbSel.key === d.instance;
    const bad = !!d.problem;
    row.className = "usbrow" + (sel ? " sel" : "") + (bad ? " problem" : "");
    row.title = d.instance;
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = d.name || d.instance;
    const id = document.createElement("span"); id.className = "id";
    id.textContent = (d.vid || "----") + ":" + (d.pid || "----");
    row.append(nm, id);
    const coms = comMap.get((d.vid || "") + ":" + (d.pid || ""));
    for (const tagInfo of usbKindTags(d, coms)) {
      const tag = document.createElement("span");
      tag.className = "tag " + tagInfo.cls;
      tag.textContent = tagInfo.text;
      row.appendChild(tag);
    }
    if (bad) {
      const tag = document.createElement("span");
      tag.className = "tag bad";
      tag.textContent = usbProblemText(d.problem);
      row.appendChild(tag);
    }
    row.onclick = () => { usbSel = { kind: "dev", key: d.instance }; usbRenderList(); };
    box.appendChild(row);
  }
  box.scrollTop = keepTop;
}

function usbRenderAll() {
  usbRenderList();
  usbCapFillTargets();
  usbRenderSummary();
}
/* ────────── USBPcap 抓包：解析 pcap 里的 USB 传输 ────────── */
let usbCapInit = false;
let usbCapRunning = false;
let usbCapStopTimer = null;
let usbCapSeq = 0;
let usbCapFilter = "";
let usbCapFull = localStorage.getItem("kdock_usb_full_data") === "1";
let usbCapDevices = [];
const usbCapRecords = [];     // 原始记录（保存用）
const USB_CAP_MAX = 50000;

function usbCapState(kind, text) {
  const n = $("usb-cap-state");
  if (!n) return;
  n.textContent = text || "";
  n.style.color = kind === "on" ? "hsl(var(--success))" : kind === "bad" ? "hsl(var(--destructive))" : "";
}

function usbCapTargets() {
  const out = [];
  for (const h of ((usbData && usbData.hubs) || [])) {
    for (const p of (h.ports || [])) {
      if (!p.addr) continue;
      const dev = ((usbData.devices || []).find((d) => d.vid === p.vid && d.pid === p.pid));
      const sp = ((usbData.serial || []).find((x) => x.vid === p.vid && x.pid === p.pid));
      out.push({ addr: p.addr, vid: p.vid, pid: p.pid, name: dev ? dev.name : "", com: sp ? sp.port : "" });
    }
  }
  return out;
}

/** 设备下拉：默认选 COM 对应的那个 USB 节点 */
function usbCapFillTargets() {
  const sel = $("usb-cap-target");
  if (!sel) return;
  const cur = sel.value;
  sel.textContent = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = T("全部设备"); sel.appendChild(all);
  for (const t of usbCapTargets()) {
    const o = document.createElement("option");
    o.value = String(t.addr);
    o.textContent = T("地址") + " " + t.addr + " · " + t.vid + ":" + t.pid
      + (t.com ? " · " + t.com : "") + (t.name ? " · " + t.name : "");
    sel.appendChild(o);
  }
  const com = [...sel.options].find((o) => /COM\d+/.test(o.textContent));
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  else if (com) sel.value = com.value;
}

function usbTraceMark(text) {
  const box = $("usb-trace");
  if (!box) return;
  const row = document.createElement("div");
  row.className = "trmark";
  row.textContent = text;
  box.appendChild(row);
  if ($("usb-autoscroll") && $("usb-autoscroll").checked) box.scrollTop = box.scrollHeight;
}

function usbHexStr(u8, max) {
  const n = Math.min(u8.length, max);
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = u8[i].toString(16).padStart(2, "0");
  let s = parts.join(" ");
  if (u8.length > n) s += " … (+" + (u8.length - n) + ")";
  return s;
}

function usbAsciiStr(u8, max) {
  const n = Math.min(u8.length, max);
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = (u8[i] >= 32 && u8[i] < 127) ? String.fromCharCode(u8[i]) : ".";
  return parts.join("");
}

function usbCapTime(us) {
  const d = new Date(Math.floor(us / 1000));
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(Math.floor((us % 1000000) / 1000)).padStart(3, "0");
  return hh + ":" + mm + ":" + ss + "." + ms;
}

function usbCapRow(r) {
  const row = document.createElement("div");
  row.className = "trrow cap " + (r.dir === "IN" ? "in" : "out") + (usbCapFilter ? "" : " all-dev");
  const u8 = Uint8Array.from(atob(r.data || ""), (c) => c.charCodeAt(0));
  const no = document.createElement("span"); no.className = "no"; no.textContent = r.n == null ? "" : r.n;
  const t = document.createElement("span"); t.className = "t"; t.textContent = usbCapTime(r.t);
  const epAddr = parseInt(r.ep, 16);
  const epNo = Number.isFinite(epAddr) ? (epAddr & 0x0F) : r.ep;
  const ep = document.createElement("span"); ep.className = "ep"; ep.textContent = "EP" + epNo;
  ep.title = T("端点") + " " + r.ep;
  const ty = document.createElement("span"); ty.className = "ty"; ty.textContent = r.dir;
  ty.title = ({ ctl: "Control", bulk: "Bulk", int: "Interrupt", iso: "Isochronous" }[r.xfer] || r.xfer) + " " + r.dir;
  const st = document.createElement("span"); st.className = "st" + (r.status ? " bad" : "");
  st.textContent = r.status ? "✕" : "✓";
  st.title = r.status ? T("传输失败") + " · status 0x" + r.status.toString(16).toUpperCase() : T("传输成功") + " · status 0";
  const limit = usbCapFull ? Infinity : 128;
  const h = document.createElement("span"); h.className = "h"; h.textContent = usbHexStr(u8, limit);
  const a = document.createElement("span"); a.className = "a";
  if (r.setup) {
    a.textContent = r.setup.type + " " + r.setup.dir
      + " bm=" + r.setup.bmRequestType + " bReq=" + r.setup.bRequest
      + " wV=" + r.setup.wValue + " wI=" + r.setup.wIndex + " wL=" + r.setup.wLength;
  } else {
    a.textContent = usbAsciiStr(u8, limit);
  }
  row.title = T("总线") + " " + r.bus + " · " + T("设备") + " " + r.dev + " · " + T("端点") + " " + r.ep
    + " · " + (r.xfer || "") + " " + r.dir
    + (r.status ? " · status 0x" + r.status.toString(16).toUpperCase() : " · status 0");
  if (usbCapFilter) {
    row.append(no, t, ep, ty, st, h, a);
  } else {
    const dev = document.createElement("span"); dev.className = "dev"; dev.textContent = r.bus + "." + r.dev;
    row.append(no, t, dev, ep, ty, st, h, a);
  }
  return row;
}

function usbCapAddMany(list) {
  if (!list || !list.length) return;
  for (const r of list) { if (r.n == null) r.n = ++usbCapSeq; usbCapRecords.push(r); }
  if (usbCapRecords.length > USB_CAP_MAX) usbCapRecords.splice(0, usbCapRecords.length - USB_CAP_MAX);
  const box = $("usb-trace");
  if (!box) return;
  const onlyCtl = $("usb-ctl-only") && $("usb-ctl-only").checked;
  const frag = document.createDocumentFragment();
  for (const r of list) {
    if (onlyCtl && r.xfer !== "ctl") continue;
    frag.appendChild(usbCapRow(r));
  }
  box.appendChild(frag);
  // DOM 只保留最近 2000 行（记录本身保留，用于保存 / 过滤重绘）
  while (box.children.length > 2000) box.firstChild.remove();
  if ($("usb-autoscroll") && $("usb-autoscroll").checked) box.scrollTop = box.scrollHeight;
}

function usbCapRedraw() {
  const box = $("usb-trace");
  if (!box) return;
  box.textContent = "";
  const onlyCtl = $("usb-ctl-only") && $("usb-ctl-only").checked;
  const list = usbCapRecords.filter((r) => !onlyCtl || r.xfer === "ctl");
  for (const r of list.slice(-2000)) box.appendChild(usbCapRow(r));
  box.scrollTop = box.scrollHeight;
}

async function usbCapInfo() {
  try {
    const d = await invoke("usbpcap_info");
    usbCapDevices = d.devices || [];
    if (!d.commandInstalled && !d.installed) {
      usbCapState("bad", T("未安装 USBPcap"));
      if ($("usb-cap-start")) $("usb-cap-start").disabled = true;
      return;
    }
    // 驱动是否加载要看设备节点，不要看系统级“有待重启的更新”：
    // 那个标志与 USBPcap 无关，重启后也可能被别的更新重新种上。
    if (!d.driverReady && d.driverState === "missing") {
      usbCapState("bad", T("已安装 · 需要重启一次"));
      if ($("usb-cap-start")) $("usb-cap-start").disabled = true;
      return;
    }
    if (!d.driverReady) {
      usbCapState("bad", T("USBPcap 驱动状态未知，请重新插拔设备或重启电脑"));
      if ($("usb-cap-start")) $("usb-cap-start").disabled = true;
      return;
    }
    if (!usbCapDevices.length) {
      usbCapState("bad", T("没有可用的根 Hub"));
      if ($("usb-cap-start")) $("usb-cap-start").disabled = true;
      return;
    }
    if ($("usb-cap-start")) $("usb-cap-start").disabled = false;
    // elevation-required 是正常状态：控制设备存在，但当前进程没提权，
    // 真正开始抓包时会弹一次 UAC。不要把它当成故障拦下来。
    usbCapState("off", d.driverState === "elevation-required"
      ? T("已就绪（开始抓包时会请求管理员权限）")
      : T("已就绪"));
  } catch (e) {
    usbCapState("bad", String(e && e.message ? e.message : e));
  }
}

async function usbCapStart() {
  const dev = usbCapDevices[0];
  if (!dev) return toast(T("没有可抓包的根 Hub"));
  if (usbCapRunning) return;
  usbCapState("off", T("正在启动抓包…"));
  try {
    const target = $("usb-cap-target") && $("usb-cap-target").value;
    await invoke("usbpcap_start", { device: dev, devices: target || null });
    usbCapRunning = true;
    const nextFilter = target || "";
    if (nextFilter !== usbCapFilter) { usbCapFilter = nextFilter; usbCapRedraw(); }
    usbCapState("on", T("抓包中 · 实时"));
    usbTraceMark(T("—— 开始抓包 ") + dev + " ——");
  } catch (e) {
    usbCapRunning = false;
    usbCapState("bad", String(e && e.message ? e.message : e));
    toast(String(e && e.message ? e.message : e));
  }
}

async function usbCapStop() {
  if (!usbCapRunning) return;
  usbCapRunning = false;
  usbCapState("off", T("正在停止…"));
  if (usbCapStopTimer) clearTimeout(usbCapStopTimer);
  usbCapStopTimer = setTimeout(() => {
    usbCapStopTimer = null;
    usbCapState("bad", T("停止超时（看 %TEMP% 下 kdock-usbpcap-*.err）"));
  }, 10000);
  try { await invoke("usbpcap_stop"); } catch (e) {
    if (usbCapStopTimer) clearTimeout(usbCapStopTimer);
    usbCapStopTimer = null;
    usbCapState("bad", String(e));
  }
  usbTraceMark(T("—— 已停止抓包 ——"));
}

function usbCapClear() {
  usbCapRecords.length = 0;
  usbCapSeq = 0;
  const box = $("usb-trace");
  if (box) box.textContent = "";
}

async function usbCapSave() {
  if (!usbCapRecords.length) return toast(T("还没有数据"));
  const p = await dlgSave({
    defaultPath: "usb-capture.txt",
    filters: [{ name: T("文本"), extensions: ["txt"] }],
  });
  const path = typeof p === "string" ? p : (p && p.path);
  if (!path) return;
  let out = "KDock USB capture — " + new Date().toLocaleString() + "\n";
  out += "# time            bus.dev ep     type      status data | ascii/setup\n";
  const hexLimit = usbCapFull ? Infinity : 128;
  const asciiLimit = usbCapFull ? Infinity : 256;
  for (const r of usbCapRecords) {
    const u8 = Uint8Array.from(atob(r.data || ""), (c) => c.charCodeAt(0));
    const extra = r.setup
      ? r.setup.type + " " + r.setup.dir + " bm=" + r.setup.bmRequestType + " bReq=" + r.setup.bRequest
        + " wValue=" + r.setup.wValue + " wIndex=" + r.setup.wIndex + " wLength=" + r.setup.wLength
      : usbAsciiStr(u8, asciiLimit);
    out += usbCapTime(r.t) + "  " + (r.bus + "." + r.dev).padEnd(7) + " " + r.ep.padEnd(6) + " "
      + (r.xfer + " " + r.dir).padEnd(9) + " " + (r.status ? "0x" + r.status.toString(16) : "OK").padEnd(6)
      + " " + usbHexStr(u8, hexLimit) + " |" + extra + "|\n";
  }
  try {
    await invoke("file_write_text", { path, content: out });
    toast(T("已保存：") + path);
  } catch (e) { toast(String(e)); }
}

/* ────────── 网络抓包（tshark） ────────── */
let monMode = "local";
let netInit = false;
const netRecords = [];
const NET_MAX = 4000;

function netState(kind, text) {
  const n = $("net-state");
  if (!n) return;
  n.textContent = text || "";
  n.style.color = kind === "on" ? "hsl(var(--success))" : kind === "bad" ? "hsl(var(--destructive))" : "";
}

function netRow(r) {
  const row = document.createElement("div");
  row.className = "trrow net";
  const no = document.createElement("span"); no.className = "no"; no.textContent = r.n == null ? "" : r.n;
  const t = document.createElement("span"); t.className = "t"; t.textContent = usbCapTime(r.t);
  const src = document.createElement("span"); src.className = "src"; src.textContent = r.src || "";
  const dst = document.createElement("span"); dst.className = "dst"; dst.textContent = r.dst || "";
  const proto = document.createElement("span"); proto.className = "proto"; proto.textContent = r.proto || "";
  const len = document.createElement("span"); len.className = "len"; len.textContent = r.len || "";
  const info = document.createElement("span"); info.className = "info"; info.textContent = r.info || "";
  row.append(no, t, src, dst, proto, len, info);
  return row;
}

function netAdd(r) {
  r.n = ++netSeq;
  netRecords.push(r);
  if (netRecords.length > NET_MAX) netRecords.shift();
  const box = $("net-trace");
  if (!box) return;
  box.appendChild(netRow(r));
  while (box.children.length > NET_MAX) box.firstChild.remove();
  if ($("usb-autoscroll") && $("usb-autoscroll").checked) box.scrollTop = box.scrollHeight;
}

function netClear() {
  netRecords.length = 0;
  netSeq = 0;
  const box = $("net-trace");
  if (box) box.textContent = "";
}

function netSave() {
  if (!netRecords.length) return toast(T("还没有数据"));
  dlgSave({ defaultPath: "net-capture.txt", filters: [{ name: T("文本"), extensions: ["txt"] }] }).then(async (p) => {
    const path = typeof p === "string" ? p : (p && p.path);
    if (!path) return;
    let out = "KDock network capture — " + new Date().toLocaleString() + "\n";
    out += "# time            src                          dst                          proto   len  info\n";
    for (const r of netRecords) {
      out += usbCapTime(r.t) + "  " + String(r.src || "").padEnd(28) + " " + String(r.dst || "").padEnd(28)
        + " " + String(r.proto || "").padEnd(7) + " " + String(r.len || "").padStart(5) + "  " + (r.info || "") + "\n";
    }
    try {
      await invoke("file_write_text", { path, content: out });
      toast(T("已保存：") + path);
    } catch (e) { toast(String(e)); }
  });
}

async function netInfo() {
  const sel = $("net-iface");
  if (!sel) return;
  try {
    const d = await invoke("tshark_info");
    sel.textContent = "";
    if (!d.installed) {
      const o = document.createElement("option"); o.textContent = T("未安装 tshark"); sel.appendChild(o);
      netState("bad", T("未安装 tshark"));
      if ($("net-start")) $("net-start").disabled = true;
      return;
    }
    if (!d.interfaces.length) {
      const o = document.createElement("option"); o.textContent = T("没有网卡"); sel.appendChild(o);
      netState("bad", T("没有网卡"));
      return;
    }
    for (const it of d.interfaces) {
      const o = document.createElement("option");
      o.value = it.device;
      o.textContent = it.name || it.device;
      sel.appendChild(o);
    }
    if ($("net-start")) $("net-start").disabled = false;
    netState("off", T("未抓包"));
  } catch (e) {
    netState("bad", String(e && e.message ? e.message : e));
  }
}

async function netStart() {
  const dev = $("net-iface") && $("net-iface").value;
  if (!dev) return toast(T("没有网卡"));
  try {
    await invoke("tshark_start", { iface: dev });
    netState("on", T("抓包中"));
  } catch (e) {
    netState("bad", String(e && e.message ? e.message : e));
    toast(String(e && e.message ? e.message : e));
  }
}

async function netStop() {
  try { await invoke("tshark_stop"); } catch (_) {}
  netState("off", T("未抓包"));
}

function monSetMode(m) {
  monMode = m === "net" ? "net" : "local";
  if ($("usb-local-bar")) $("usb-local-bar").hidden = monMode !== "local";
  if ($("net-bar")) $("net-bar").hidden = monMode !== "net";
  if ($("usb-trace")) $("usb-trace").hidden = monMode !== "local";
  if ($("net-trace")) $("net-trace").hidden = monMode !== "net";
  if (monMode === "net" && !netInit) { netInit = true; netInfo(); }
}

function usbOnShow() {
  if (!usbData) usbRefresh();
  if (!usbCapInit) { usbCapInit = true; usbCapInfo(); }
  if (usbAutoTimer) clearInterval(usbAutoTimer);
  usbAutoTimer = setInterval(() => {
    if (document.documentElement.dataset.tab !== "usb") return;
    const auto = $("usb-auto");
    if (auto && !auto.checked) return;
    usbRefresh();
  }, 3000);
}

// 便于自测 / 排障：手动触发一次设备管理器与概要重绘
window.__usbRender = () => usbRenderAll();
window.__usbRefresh = () => usbRefresh();
window.__usbTimer = () => usbAutoTimer;

function bindUsb() {
  if ($("usb-refresh")) $("usb-refresh").onclick = () => usbRefresh();
  if ($("usb-rescan2")) $("usb-rescan2").onclick = () => usbRefresh();
  if ($("usb-elev2")) $("usb-elev2").onclick = () => usbElevate();
  if ($("usb-cap-start")) $("usb-cap-start").onclick = () => usbCapStart();
  if ($("usb-cap-stop")) $("usb-cap-stop").onclick = () => usbCapStop();
  if ($("usb-ctl-only")) $("usb-ctl-only").onchange = () => usbCapRedraw();
  const fullData = $("usb-full-data");
  if (fullData) {
    fullData.checked = usbCapFull;
    fullData.onchange = () => {
      usbCapFull = fullData.checked;
      localStorage.setItem("kdock_usb_full_data", usbCapFull ? "1" : "0");
      usbCapRedraw();
    };
  }
  if ($("usb-trace-clear")) $("usb-trace-clear").onclick = () => (monMode === "net" ? netClear() : usbCapClear());
  if ($("usb-trace-save")) $("usb-trace-save").onclick = () => (monMode === "net" ? netSave() : usbCapSave());
  if ($("net-start")) $("net-start").onclick = () => netStart();
  if ($("net-stop")) $("net-stop").onclick = () => netStop();
  document.querySelectorAll('#mon-mode input').forEach((i) => { i.onchange = () => monSetMode(i.value); });
  monSetMode("local");
  listen("usb://cap", (ev) => {
    const list = (ev.payload && ev.payload.records) || [];
    usbCapAddMany(list);
  });
  listen("usb://cap-end", (ev) => {
    if (usbCapStopTimer) clearTimeout(usbCapStopTimer);
    usbCapStopTimer = null;
    usbCapRunning = false;
    const err = ev.payload && ev.payload.error;
    if (err) {
      usbCapState("bad", String(err));
      toast(String(err));
    } else {
      usbCapState("off", T("已停止 · {n} 条").replace("{n}", usbCapRecords.length));
    }
  });
  listen("net://cap", (ev) => {
    const r = ev.payload && ev.payload.record;
    if (r) netAdd(r);
  });
  listen("net://cap-end", () => netState("off", T("未抓包")));
}

/* ══════════ 环境配置：驱动 / 工具链 的检测与一键安装 ══════════
   后端（env_setup.rs）负责真干活：扫描（PATH / 注册表 / pnputil / 各盘常见目录）、
   下载（到"下载"文件夹）、解包 / 装 MSI / 跑安装器 / winget / git clone，进度走 env://progress 事件。
   前端只做：列出来、给按钮、把日志和进度画出来。 */
let envData = null;                 // env_scan 的结果
let envKind = "全部";               // 类别过滤
let envBusy = null;                 // 正在装的组件 id

/** 这一块元素多，抽个建元素的小工具（main.js 其它页是手搓 document.createElement） */
function envEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const envDirPref = () => (localStorage.getItem("kdock_env_dir") || "").trim();
function envSyncDirInputs() {
  const v = envDirPref();
  for (const id of ["env-dir", "env-dir2"]) {
    const e = $(id);
    if (e && document.activeElement !== e) e.value = v;
  }
}
/** 后端（env_setup.rs）的日志是中文的。英文界面下按模式过一遍：整行是拼出来的，查不到字典。
    顺序有讲究：越具体的放前面（"（模拟）会跑 winget…" 要在通用的 "（模拟）…" 之前）。 */
const ENV_LOG_EN = [
  [/^准备安装 (.+)$/, (m) => "Preparing to install " + en(m[1])],
  [/^已存在，直接用：(.+)$/, (m) => "Already there, reusing: " + m[1]],
  [/^开始下载 (.+)$/, (m) => "Starting download " + m[1]],
  [/^下载中 (\d+)%$/, (m) => "Downloading " + m[1] + "%"],
  [/^下载完成：(\d+) MB$/, (m) => "Download finished: " + m[1] + " MB"],
  [/^下载失败[:：]?\s*(.*)$/, (m) => "Download failed" + (m[1] ? ": " + m[1] : "")],
  [/^等待 UAC 授权 \/ 安装中…$/, "Waiting for UAC / installing…"],
  [/^安装中…$/, "Installing…"],
  [/^安装命令已执行$/, "Install command finished"],
  [/^PowerShell 没返回输出（可能被 UAC 拒绝）$/, "PowerShell returned nothing (UAC may have been denied)"],
  [/^不认识的组件：(.+)$/, (m) => "Unknown component: " + m[1]],
  [/^内置驱动：(.+)$/, (m) => "Bundled driver: " + m[1]],
  [/^用了内置驱动：$/, "Used the bundled driver:"],
  [/^已执行：(.+)$/, (m) => "Ran: " + m[1]],
  [/^（模拟）会跑 winget install --id (.+) --silent$/, (m) => "(dry run) would run: winget install --id " + m[1] + " --silent"],
  [/^（模拟）会在 (.+) 里跑 git pull$/, (m) => "(dry run) would run git pull in " + m[1]],
  [/^（模拟）会 git clone (\S+) (\S+)$/, (m) => "(dry run) would git clone " + m[1] + " " + m[2]],
  [/^（模拟）会解压 (.+) → (.+)（strip (\d+) 层）$/, (m) => "(dry run) would unzip " + m[1] + " → " + m[2] + " (strip " + m[3] + " levels)"],
  [/^（模拟）下载到 (.+)，会执行：(.+)$/, (m) => "(dry run) would download to " + m[1] + ", then run: " + m[2]],
  [/^（模拟）会执行 (.+)$/, (m) => "(dry run) would run " + m[1]],
  [/^（模拟）(.+)$/, (m) => "(dry run) " + m[1]],
  [/^已有仓库，执行 git pull$/, "Repo already there — running git pull"],
  [/^git clone 失败（PATH 里有 git 吗？）$/, "git clone failed (is git on PATH?)"],
  [/^已注册驱动 (.+)$/, (m) => "Driver registered " + m[1]],
  [/^注册表 (.+)$/, (m) => "Registry " + m[1]],
  [/^完成$/, "Done"],
  [/^「(.+)」没有直接的自动下载地址（要登录\/授权），请到官网下载安装：(.+)$/,
    (m) => "\u201c" + en(m[1]) + "\u201d has no direct download (needs login / consent) — get it from: " + m[2]],
];
function envLogLine(line) {
  if (LANG !== "en") return line;
  for (const [re, to] of ENV_LOG_EN) {
    const m = line.match(re);
    if (!m) continue;
    return typeof to === "function" ? to(m) : line.replace(re, to);
  }
  return en(line);
}
function envLog(text) {
  const box = $("env-log");
  if (!box) return;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (const l of lines) {
    if (!l.trim() && lines.length > 1) continue;
    box.textContent += `[${new Date().toLocaleTimeString()}] ${envLogLine(l)}\n`;
  }
  box.scrollTop = box.scrollHeight;
}
function envProg(pct, name) {
  const bar = $("env-bar"), nm = $("env-prog-name");
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (nm && name != null) nm.textContent = en(name);
}

async function envRefresh(force) {
  const box = $("env-grid");
  if (!box) return;
  envSyncDirInputs();
  if (!envData || force) {
    if (!envData) { box.textContent = ""; box.appendChild(envEl("p", "hint", en("正在扫描本机…"))); }
    try {
      envData = await invoke("env_scan", { force: !!force, dir: envDirPref() || null });
    } catch (e) {
      box.textContent = "";
      box.appendChild(envEl("p", "hint", en("扫描失败：") + String(e)));
      return;
    }
  }
  envRenderGrid();
  envRenderFirst();
}

function envRenderGrid() {
  const box = $("env-grid");
  if (!box || !envData) return;
  const all = envData.items || [];
  const onlyMissing = $("env-only-missing") && $("env-only-missing").checked;
  const kinds = ["全部", ...new Set(all.map((x) => x.kind))];
  const seg = $("env-kinds");
  const wantKey = LANG + "|" + kinds.join("|");      // 语言也要算进 key：切语言时标签得重画
  if (seg && seg.dataset.built !== wantKey) {
    seg.dataset.built = wantKey;
    seg.textContent = "";
    for (const k of kinds) {
      const label = envEl("label");
      const inp = document.createElement("input");
      inp.type = "radio"; inp.name = "env-kind"; inp.value = k;
      inp.checked = k === envKind;
      inp.onchange = () => { envKind = k; envRenderGrid(); };
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + en(k)));
      seg.appendChild(label);
    }
  }
  const items = all.filter((x) =>
    (envKind === "全部" || x.kind === envKind) && (!onlyMissing || !x.installed || x.outdated));
  if ($("env-sum")) {
    const ok = all.filter((x) => x.installed).length;
    const bad = all.filter((x) => !x.installed).length;
    const up = all.filter((x) => x.outdated).length;
    $("env-sum").textContent = en("已装 ") + ok + "/" + all.length +
      (bad ? en(" · 未装 ") + bad : "") + (up ? en(" · 可更新 ") + up : "");
  }
  if ($("env-hint-line")) {
    const miss = (envData.missingRequired || []).map((k) => {
      const it = all.find((x) => x.id === k);
      return en(it ? it.name : k);
    });
    $("env-hint-line").textContent = miss.length ? en("缺必需项：") + miss.join("、") : en("必需项都齐了");
  }
  box.textContent = "";
  if (!items.length) { box.appendChild(envEl("p", "hint", en("没有符合条件的组件"))); return; }
  for (const it of items) {
    const card = envEl("div", "envcard" + (it.installed ? (it.outdated ? "" : " ok") : " bad"));
    const top = envEl("div", "ktop");
    top.appendChild(envEl("span", "kname", en(it.name)));
    const issue = it.installed && !!it.warning;
    top.appendChild(envEl("span", "kbadge" + (it.installed ? (it.outdated || issue ? " warn" : " ok") : ""),
      it.installed
        ? (issue ? en("已装") + " · " + en(it.warning) : (it.outdated ? en("可更新") : (it.version ? "v" + it.version : en("已装"))))
        : en("未安装")));
    top.appendChild(envEl("span", "kbadge kind", en(it.kind)));
    card.appendChild(top);
    card.appendChild(envEl("div", "kmeta", it.path || envLogLine(it.detail || "")));
    card.appendChild(envEl("div", "kdesc", en(it.desc)));
    const acts = envEl("div", "kacts");
    if (it.autoInstall) {
      const installedCheck = it.id === "usbpcap" && it.installed;
      const b = envEl("button", "btn small" + (it.installed ? "" : " primary"),
        en(installedCheck ? "检查状态" : (it.installed ? "更新 / 重装" : "一键安装")));
      b.onclick = () => envInstall(it.id);
      acts.appendChild(b);
    } else {
      const b = envEl("button", "btn small", en("打开官网"));
      b.title = en("这个要登录 / 同意条款才能下：官网下完，把安装包丢进内置目录就能一键装。");
      b.onclick = () => openExternal(it.url);
      acts.appendChild(b);
      const b2 = envEl("button", "btn small", en("我下好了，用本地的装"));
      b2.title = en("把安装包放进 <exe 同目录>\\drivers\\<组件id>\\ 之后再点这个");
      b2.onclick = () => envInstall(it.id);
      acts.appendChild(b2);
    }
    if (it.path) {
      const b3 = envEl("button", "btn small", en("定位"));
      b3.onclick = () => invoke("open_folder", { path: String(it.path).replace(/[\\/][^\\/]*$/, "") }).catch(() => {});
      acts.appendChild(b3);
    }
    card.appendChild(acts);
    box.appendChild(card);
  }
  if (LANG === "en") langWalk();
  syncParamStrip();
}

function envRenderFirst() {
  const box = $("env-first");
  if (!box || !envData) return;
  const all = envData.items || [];
  const miss = all.filter((x) => x.required && !x.installed);
  const up = all.filter((x) => x.outdated);
  box.textContent = "";
  const row = (k, v, cls) => {
    const d = envEl("div", "row");
    d.appendChild(envEl("span", "k", k));
    d.appendChild(envEl("span", "v" + (cls ? " " + cls : ""), v));
    box.appendChild(d);
  };
  row(en("必需项"), miss.length ? miss.map((x) => en(x.name)).join("、") : en("齐了"), miss.length ? "err" : "");
  row(en("可更新"), up.length ? up.map((x) => en(x.name) + " " + x.version + " → " + (x.minVersion || "")).join("、") : en("无"), "");
  row(en("上次扫描"), new Date().toLocaleTimeString(), "");
}

/** 装 / 更新一项。opts.throw = 出错时抛出（agent 走这条路，好让它知道失败原因）；
    返回值是给 agent 看的文本小结（界面上的日志/进度照旧画）。 */
async function envInstall(id, opts) {
  if (envBusy) {
    const m = en("先等这个装完：") + envBusy;
    toast(m);
    if (opts && opts.throw) throw new Error(m);
    return null;
  }
  const it = envData && (envData.items || []).find((x) => x.id === id);
  const dry = localStorage.getItem("kdock_env_dry") === "1";
  envBusy = id;
  envProg(2, it ? en(it.name) : id);
  envLog(`=== ${en("开始")} ${it ? en(it.name) : id}${dry ? en("（模拟，不真装）") : ""} ===`);
  try {
    const log = await invoke("env_install", {
      id,
      dir: envDirPref() || null,
      dry,
      // USBPcap 永远先检测；只有“未安装”时后端才允许真正拉起安装器。
      force: id !== "usbpcap" && !!(it && it.installed && !it.warning),
    });
    if (log) envLog(String(log));
    envLog(en("完成，重新扫描…"));
    envData = null;
    await envRefresh(true);
    const all = (envData && envData.items) || [];
    const miss = (envData && envData.missingRequired) || [];
    return `${it ? it.name : id}：${log ? String(log) : "ok"}\n` +
      `重扫：已装 ${all.filter((x) => x.installed).length}/${all.length}；` +
      (miss.length ? `仍缺必需项 ${miss.join(", ")}` : "必需项齐了");
  } catch (e) {
    envLog(en("失败：") + String(e));
    toast(String(e));
    if (opts && opts.throw) throw new Error(String(e));
    return null;
  } finally {
    envBusy = null;
    envProg(0, "");
  }
}

/** 首次运行：缺必需驱动就提示一次（只提示，不自动装；用户点了「去看看」才进环境配置页） */
async function envFirstRunCheck() {
  if (localStorage.getItem("kdock_env_skip") === "1") return;
  try {
    const d = await invoke("env_scan", { dir: envDirPref() || null });
    if (!envData) envData = d;
    if (d.missingRequired && d.missingRequired.length) {
      const names = d.missingRequired.map((k) => {
        const it = (d.items || []).find((x) => x.id === k);
        return en(it ? it.name : k);
      }).join("、");
      const msg = en("环境检查：有必需驱动没装") + "\n" + names + (LANG === "en" ? ".\n" : "。\n") +
        en("现在去「环境配置」一键安装？（需要提权的会弹一次 UAC）");
      agDialog({ title: en("环境配置"), text: msg, okText: en("去看看") }).then((r) => {
        if (r.ok) showPane("env");
        else localStorage.setItem("kdock_env_skip", "1");    // 以后不再啰嗦
      });
    } else if (d.outdated && d.outdated.length) {
      toast(en("有 ") + d.outdated.length + en(" 个组件可以更新（环境配置页）"));
    }
  } catch (_) {}
}

async function __envRuntimeRefresh() {
  const el = $("env-rt-state");
  if (!el) return null;
  try {
    const s = await invoke("runtime_analyzer_status");
    el.textContent = s.installed ? "已就绪" : "未准备";
    el.className = "rtbadge " + (s.installed ? "ok" : "bad");
    el.title = s.path || "点击「准备 / 更新分析器」";
    if ($("env-rt-open")) $("env-rt-open").disabled = !s.installed;
    return s;
  } catch (e) {
    el.textContent = "检测失败";
    el.className = "rtbadge bad";
    el.title = String(e);
    return null;
  }
}
async function __envRuntimePrepare() {
  const btn = $("env-rt-prepare"), state = $("env-rt-state");
  if (!btn) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "准备中…（首次需下载 ~500 MB）";
  if (state) { state.textContent = "准备中…"; state.className = "rtbadge warn"; }
  envLog("开始准备固件运行结构分析器。KDock 会自带 Python 3.13，不使用系统 Python。");
  try {
    const r = await invoke("runtime_prepare");
    envLog(r.message || "分析器已准备完成");
    envLog("完成后可以在「运行结构」页选择 ELF/BIN 并直接分析。");
    await __envRuntimeRefresh();
  } catch (e) {
    envLog("分析器准备失败：" + String(e));
    toast(String(e));
    if (state) { state.textContent = "准备失败"; state.className = "rtbadge bad"; }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
function __envRuntimeBind() {
  const b = $("env-rt-prepare");
  if (b) b.onclick = __envRuntimePrepare;
  const o = $("env-rt-open");
  if (o) o.onclick = async () => {
    const s = await __envRuntimeRefresh();
    if (s && s.path) invoke("open_folder", { path: s.path.replace(/[\\/][^\\/]*$/, "") }).catch(() => {});
  };
  __envRuntimeRefresh();
}
function bindEnv() {
  envSyncDirInputs();
  const setDir = (v) => { localStorage.setItem("kdock_env_dir", v || ""); envSyncDirInputs(); };
  if ($("env-scan")) $("env-scan").onclick = async () => { envLog(en("开始扫描本机…")); await envRefresh(true); envLog(en("扫描完成")); };
  if ($("env-rescan")) $("env-rescan").onclick = () => envRefresh(true);
  if ($("env-fix-required")) $("env-fix-required").onclick = async () => {
    const miss = (envData ? envData.items || [] : []).filter((x) => x.required && !x.installed && x.autoInstall);
    if (!miss.length) return toast(en("必需项没有能一键装的（点卡片上的官网入口自己去装）"));
    for (const m of miss) await envInstall(m.id);
  };
  for (const [btn, inp] of [["env-dir-pick", "env-dir"], ["env-dir-pick2", "env-dir2"]]) {
    if ($(btn)) $(btn).onclick = async () => {
      const p = await dlgOpen({ directory: true, multiple: false, title: en("选一个统一的安装位置") });
      const dir = typeof p === "string" ? p : (p && p.path);
      if (dir) setDir(dir);
    };
  }
  for (const id of ["env-dir", "env-dir2"]) if ($(id)) $(id).onchange = (e) => setDir(e.target.value.trim());
  if ($("env-only-missing")) $("env-only-missing").onchange = () => envRenderGrid();
  // 后端装东西时的进度：下载百分比 / 解包 / 装驱动 / git clone
  __envRuntimeBind();
  listen("env://progress", (ev) => {
    const p = ev.payload || {};
    if (p.pct != null) envProg(p.pct, p.text || "");
    if (p.text) envLog(p.text);
  });
  // 切语言时这一页是运行时画的，得自己重画一遍
  window.kdockOnLang(() => { if (envData) { envRenderGrid(); envRenderFirst(); } });
  envRefresh();
}

// ---------------- 全局错误兜底：出错别白屏、也别悄悄不干活 ----------------
function bindErrorBanner() {
  const show = (msg) => {
    const el = $("errbar");
    el.textContent = "出错了：" + msg;
    el.hidden = false;
    el.title = msg;
    pushSys("内部错误: " + msg);
  };
  window.addEventListener("error", (e) => show(e.message || String(e.error || e)));
  window.addEventListener("unhandledrejection", (e) => show(String((e.reason && e.reason.message) || e.reason)));
}

// ---------------- 左右分栏可拖动 ----------------
/** 只保留**最小**限制：左中右各自不能被拖到 min 以下；除此之外不封顶（能一直拉大），
 *  上限只由"另外两栏还得留出自己的最小宽度"算出来 —— 不再有写死的 max。 */
function bindOneGutter(id, cssVar, storeKey, min, otherVar, otherMin, centerMin, fromLeft) {
  const root = document.documentElement;
  /** 窄窗（≤1180px）里参数区被挪到第二行、不再占横向空间 —— 网格轨道从 5 条变 3 条。
   *  判错了会怎样：继续减掉参数区的 min，左栏能拉的上限就被算小一大截（900px 窗口只剩 220px，
   *  而窄窗的默认宽度就是 260px，一拖反而变窄），而且媒体查询里写的是 --left-w，JS 写的是
   *  --nav-w，两边对不上 —— 干脆拖了没反应。 */
  const stacked = () => {
    const sp = document.querySelector(".split");
    if (!sp) return false;
    return getComputedStyle(sp).gridTemplateColumns.trim().split(/\s+/).length <= 3;
  };
  const maxFor = () => {
    const sp = document.querySelector(".split");
    const cs = sp ? getComputedStyle(sp) : null;
    const total = sp
      ? sp.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      : window.innerWidth;
    const other = parseInt(cs ? cs.getPropertyValue(otherVar) : "") || otherMin;
    const reserve = stacked() ? 0 : Math.max(other, otherMin);   // 并排时才需要给另一栏留位置
    // 别忘了中间那条分隔条自己也有宽度，漏掉它中间栏就会差几个像素被压到 min 以下
    const gutter = el ? el.getBoundingClientRect().width : 0;
    return Math.max(min, Math.floor(total - reserve - gutter - centerMin));
  };
  const el = $(id);
  const saved = Number(localStorage.getItem(storeKey) || 0);
  if (saved >= min) root.style.setProperty(cssVar, Math.min(saved, maxFor()) + "px");
  if (!el) return;
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const raw = fromLeft ? e.clientX - 10 : window.innerWidth - e.clientX - 10;
    const w = Math.max(min, Math.min(maxFor(), raw));
    root.style.setProperty(cssVar, Math.round(w) + "px");
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    const v = parseInt(getComputedStyle(root).getPropertyValue(cssVar)) || min;
    localStorage.setItem(storeKey, String(v));
    document.body.style.cursor = "";
  };
  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  el.addEventListener("dblclick", () => {
    root.style.removeProperty(cssVar);
    localStorage.removeItem(storeKey);
  });
}

function bindGutter() {
  // (id, cssVar, storeKey, min, 另一侧的 cssVar, 另一侧 min, 中间栏 min, 从左边拖)
  bindOneGutter("gutter", "--nav-w", "kdock_nav_w", 96, "--param-w", 260, 420, true);
  bindOneGutter("gutter-r", "--param-w", "kdock_param_w", 260, "--nav-w", 96, 420, false);
}

// ---------------- 工具选项：关闭到托盘 / 开机自启 ----------------
async function bindToolOptions() {
  const trayOn = localStorage.getItem("kdock_tray") === "1";
  $("opt-tray").checked = trayOn;
  try { await invoke("set_close_to_tray", { v: trayOn }); } catch (_) {}
  $("opt-tray").onchange = async () => {
    const on = $("opt-tray").checked;
    localStorage.setItem("kdock_tray", on ? "1" : "0");
    try {
      await invoke("set_close_to_tray", { v: on });
      toast(on ? "已开启关闭到托盘（托盘图标右键可退出）" : "关闭窗口即退出");
    } catch (e) { toast(String(e)); }
  };

  const rcOn = localStorage.getItem("kdock_reconnect") !== "0";
  $("opt-reconnect").checked = rcOn;
  try { await invoke("set_auto_reconnect", { v: rcOn }); } catch (_) {}
  $("opt-reconnect").onchange = async () => {
    const on = $("opt-reconnect").checked;
    localStorage.setItem("kdock_reconnect", on ? "1" : "0");
    try { await invoke("set_auto_reconnect", { v: on }); toast(on ? "已开启断线自动重连" : "已关闭断线自动重连"); }
    catch (e) { toast(String(e)); }
  };

  try {
    const { isEnabled, enable, disable } = await import("@tauri-apps/plugin-autostart");
    $("opt-autostart").checked = await isEnabled();
    $("opt-autostart").onchange = async () => {
      const want = $("opt-autostart").checked;
      try {
        if (want) await enable(); else await disable();
        toast(want ? "已设置开机自启" : "已关闭开机自启");
      } catch (e) {
        toast("自启设置失败: " + e);
        $("opt-autostart").checked = !want;
      }
    };
  } catch (e) {
    $("opt-autostart").disabled = true;
    $("opt-autostart").title = "自启插件不可用: " + e;
  }
}

// ---------------- 外观：主题(暗/亮/跟随) + 配色 ----------------
// 配色方案为 KDock 自有主题，只覆写主色/焦点色/点缀色/背景光斑，
// 其余令牌继承主题，所以暗色和亮色都能用同一套配色。
const SCHEMES = [
  { id: "slate", name: "石墨", h: 220, sd: 26, sl: 20 },
  { id: "ocean", name: "海洋蓝", h: 205, sd: 72, sl: 48 },
  { id: "mint", name: "薄荷青", h: 167, sd: 58, sl: 44 },
  { id: "forest", name: "森林绿", h: 128, sd: 46, sl: 34 },
  { id: "twilight", name: "暮光紫", h: 255, sd: 62, sl: 42 },
  { id: "amber", name: "琥珀橙", h: 35, sd: 88, sl: 78 },
  { id: "sakura", name: "樱花粉", h: 338, sd: 60, sl: 46 },
];
const themeIsLight = () =>
  document.documentElement.dataset.theme === "light" ||
  (document.documentElement.dataset.theme === "auto" && matchMedia("(prefers-color-scheme: light)").matches);

function applyScheme(id) {
  const s = SCHEMES.find((x) => x.id === id) || SCHEMES[1];
  const light = themeIsLight();
  const primary = light ? `${s.h} ${s.sl}% 46%` : `${s.h} ${s.sd}% 72%`;
  const r = document.documentElement.style;
  r.setProperty("--primary", primary);
  r.setProperty("--ring", primary);
  r.setProperty("--accent", light ? `${s.h} 60% 92%` : `${s.h} 20% 20%`);
  r.setProperty("--tint-h", String(s.h));   // 面层阶梯跟着配色走
  r.setProperty("--bg-spot-1", `hsl(${s.h} 70% 60% / 0.18)`);
  r.setProperty("--bg-spot-2", `hsl(${(s.h + 60) % 360} 62% 55% / 0.13)`);
  // 深色底也跟着配色走：原来是写死的 224（蓝黑），配琥珀/樱花这种就成了"蓝底配橙字"。
  // 亮度/饱和度压得比主色低很多，只是"稍微混一点"，不是把背景染成彩色。
  if (light) {
    r.setProperty("--background", "220 43% 97%");
    r.setProperty("--card", "0 0% 100%");
  } else {
    r.setProperty("--background", `${s.h} 24% 10%`);
    r.setProperty("--card", `${s.h} 22% 13.5%`);
  }
  localStorage.setItem("kdock_scheme", s.id);
  uiPrefsSave();
  document.querySelectorAll("#scheme-row .sw").forEach((b) => b.classList.toggle("active", b.dataset.id === s.id));
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem("kdock_theme", mode);
  uiPrefsSave();
  const seg = document.querySelector(`#theme-seg input[value="${mode}"]`);
  if (seg) seg.checked = true;
  applyScheme(localStorage.getItem("kdock_scheme") || "ocean");   // 亮/暗切换后主色要重算
}

// ── 字号 / 放大 / 字体 ─────────────────────────────────────────────
// 字号是 UI 逻辑尺寸的一档，放大倍数是第二档；两者相乘后写到 #ui-root 的 zoom，
// 所以控件、文字、间距和布局会一起变化，而不是只改字号。
const UI_FONT_STEPS = [["small", "小", 0.9], ["normal", "标准", 1.0], ["large", "大", 1.12], ["xlarge", "特大", 1.25]];
const UI_ZOOM_STEPS = [["0.8", "80%"], ["0.9", "90%"], ["1", "100%"], ["1.1", "110%"], ["1.25", "125%"], ["1.4", "140%"], ["1.6", "160%"]];
const UI_FONTS = [
  ["system", "系统默认", ""],
  ["segoe", "Segoe UI Variable", '"Segoe UI Variable", "Segoe UI"'],
  ["yahei", "微软雅黑", '"Microsoft YaHei UI", "Microsoft YaHei"'],
  ["noto", "思源黑体 / Noto", '"Noto Sans SC", "Source Han Sans SC", "HarmonyOS Sans SC"'],
  ["inter", "Inter / 系统无衬线", 'Inter, "Segoe UI Variable", system-ui'],
];
function uiScaleValue() {
  const f = (UI_FONT_STEPS.find((x) => x[0] === (localStorage.getItem("kdock_font_scale") || "normal")) || UI_FONT_STEPS[1])[2];
  const z = Number(localStorage.getItem("kdock_ui_zoom") || "1") || 1;
  return Math.min(3, Math.max(0.5, Math.round(f * z * 1000) / 1000));
}
function applyUiScale() {
  const scale = uiScaleValue();
  const root = document.documentElement;
  // 用 CSS zoom 缩放整个工作台，而不是 WebView2 的页面 zoom：后者在当前 WebView2 版本里
  // 返回成功但不会改变布局。container query 会按缩放后的逻辑宽度触发响应式断点。
  root.style.setProperty("--ui-scale", String(scale));
  root.style.setProperty("--app-vw", (window.innerWidth / scale / 100) + "px");
  root.style.setProperty("--app-vh", (window.innerHeight / scale / 100) + "px");
  root.dataset.uiScale = scale.toFixed(3);
  const id = localStorage.getItem("kdock_ui_font") || "system";
  const fam = (UI_FONTS.find((x) => x[0] === id) || UI_FONTS[0])[2];
  if (fam) root.style.setProperty("--ui-font", `${fam}, var(--font-ui)`);
  else root.style.removeProperty("--ui-font");
  syncParamStrip();
}
function syncUiScaleControls() {
  const set = (id, v) => { const s = $(id); if (s && v != null) s.value = String(v); };
  set("ui-font-scale", localStorage.getItem("kdock_font_scale") || "normal");
  set("ui-zoom", String(Number(localStorage.getItem("kdock_ui_zoom") || "1")));
  set("ui-font", localStorage.getItem("kdock_ui_font") || "system");
  if (agNetip) {
    set("netip-retry", agNetip.retryCount);
    set("netip-debounce", agNetip.debounceMs);
  }
}
function bindUiScale() {
  const fs = $("ui-font-scale"), zm = $("ui-zoom"), fm = $("ui-font");
  if (fs) {
    fillSelect(fs, UI_FONT_STEPS.map((x) => [x[0], x[1]]), localStorage.getItem("kdock_font_scale") || "normal");
    fs.onchange = () => { localStorage.setItem("kdock_font_scale", fs.value); applyUiScale(); uiPrefsSave(); };
  }
  if (zm) {
    fillSelect(zm, UI_ZOOM_STEPS.map((x) => [x[0], x[1]]), String(Number(localStorage.getItem("kdock_ui_zoom") || "1")));
    zm.onchange = () => { localStorage.setItem("kdock_ui_zoom", zm.value); applyUiScale(); uiPrefsSave(); };
  }
  if (fm) {
    fillSelect(fm, UI_FONTS.map((x) => [x[0], x[1]]), localStorage.getItem("kdock_ui_font") || "system");
    fm.onchange = () => { localStorage.setItem("kdock_ui_font", fm.value); applyUiScale(); uiPrefsSave(); };
  }
  syncUiScaleControls();
  applyUiScale();
  // 换显示器 / 改系统缩放到 WebView 会重排：把用户那份再下发一次，保证是"叠加"而不是被顶掉
  let t = 0;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(applyUiScale, 200); });
}

function bindTheme() {
  const row = $("scheme-row");
  for (const s of SCHEMES) {
    const b = document.createElement("button");
    b.className = "sw";
    b.dataset.id = s.id;
    b.title = s.name;
    b.style.background = `hsl(${s.h} 62% 55%)`;
    b.onclick = () => applyScheme(s.id);
    row.appendChild(b);
  }
  document.querySelectorAll("#theme-seg input").forEach((el) => {
    el.onchange = () => applyTheme(el.value);
  });
  applyTheme(localStorage.getItem("kdock_theme") || "dark");
  // 标题栏那个「◐」要跟着"恢复出来的主题"走：bindTitleBar 可能先跑（那时还没有主题），
  // 不补这一下的话，重启后按钮图标会和实际主题对不上，看着像"主题没保存"
  tbSyncTheme();
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if ((document.documentElement.dataset.theme || "dark") === "auto") applyScheme(localStorage.getItem("kdock_scheme") || "ocean");
  });
  bindUiScale();
}

/* ── 界面偏好落一份到后端 ─────────────────────────────────────────
 * 主题/配色/语言除了 localStorage 再存一份 JSON（后端 app_data 目录）：
 * localStorage 按 origin 隔离（dev 是 localhost:1420、exe 是 tauri.localhost），
 * 只存 localStorage 的话，开发时挑的配色换成 exe 就"没了"。启动时以文件为准。
 */
let uiPrefsReady = false;     // 读完之后才允许往回写，免得启动时用旧值把文件覆盖掉
let uiPrefsLast = "";
function uiPrefsSnapshot() {
  let shortcuts = {};
  try {
    const parsed = JSON.parse(localStorage.getItem("kdock_shortcuts") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) shortcuts = parsed;
  } catch (_) {}
  return {
    theme: localStorage.getItem("kdock_theme") || "dark",
    scheme: localStorage.getItem("kdock_scheme") || "ocean",
    lang: LANG,
    fontScale: localStorage.getItem("kdock_font_scale") || "normal",
    zoom: localStorage.getItem("kdock_ui_zoom") || "1",
    font: localStorage.getItem("kdock_ui_font") || "system",
    shortcuts,
  };
}
function uiPrefsSave() {
  if (!uiPrefsReady) return;
  const p = uiPrefsSnapshot();
  const key = [p.theme, p.scheme, p.lang, p.fontScale, p.zoom, p.font, JSON.stringify(p.shortcuts)].join("|");
  if (key === uiPrefsLast) return;      // 没变就不写盘
  uiPrefsLast = key;
  invoke("ui_prefs_set", { prefs: p }).catch(() => {});
}
async function uiPrefsLoad() {
  let p = null;
  try { p = await invoke("ui_prefs_get"); } catch (_) { uiPrefsReady = true; return; }
  if (!p || (typeof p !== "object") || (!p.theme && !p.scheme && !p.lang)) {
    // 第一次跑这个版本：把已有的选择（localStorage 里那份）迁上去
    uiPrefsReady = true;
    uiPrefsSave();
    return;
  }
  if (p.theme) localStorage.setItem("kdock_theme", p.theme);
  if (p.scheme) localStorage.setItem("kdock_scheme", p.scheme);
  if (p.lang) localStorage.setItem("kdock_lang", p.lang);
  if (p.fontScale) localStorage.setItem("kdock_font_scale", p.fontScale);
  if (p.zoom) localStorage.setItem("kdock_ui_zoom", p.zoom);
  if (p.font) localStorage.setItem("kdock_ui_font", p.font);
  if (p.shortcuts && typeof p.shortcuts === "object" && !Array.isArray(p.shortcuts)) {
    localStorage.setItem("kdock_shortcuts", JSON.stringify(p.shortcuts));
  }
  uiPrefsReady = true;
  applyTheme(localStorage.getItem("kdock_theme") || "dark");   // 里面会带上 applyScheme
  applyScheme(localStorage.getItem("kdock_scheme") || "ocean");
  if (p.lang && p.lang !== LANG) applyLang(p.lang);
  applyUiScale();
  syncUiScaleControls();
  const s2 = uiPrefsSnapshot();
  uiPrefsLast = [s2.theme, s2.scheme, s2.lang, s2.fontScale, s2.zoom, s2.font, JSON.stringify(s2.shortcuts)].join("|");
}

/** Agent 对话区高度：拖动它上面那条把手（和传输页的输出框一个路子），双击复位。 */
function bindAgentResize() {
  const grip = $("ag-chat-grip"), box = $("ag-box");
  if (!grip || !box) return;
  const KEY = "kdock_agent_chat_h";
  const apply = (h) => {
    box.style.height = h ? h + "px" : "";
    box.style.flex = h ? "0 0 auto" : "";      // 有显式高度时别让 flex 把它拉回满高
  };
  const saved = Number(localStorage.getItem(KEY) || 0);
  if (saved > 80) apply(Math.round(saved));
  let sy = 0, h0 = 0;
  grip.addEventListener("pointerdown", (e) => {
    sy = e.clientY; h0 = box.getBoundingClientRect().height;
    grip.classList.add("dragging");
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 某些环境不支持 */ }
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.classList.contains("dragging")) return;
    const pane = box.parentElement.getBoundingClientRect().height;
    const want = Math.max(120, Math.min(h0 - (e.clientY - sy), Math.round(pane * 0.9)));
    apply(Math.round(want));
  });
  const stop = () => {
    if (!grip.classList.contains("dragging")) return;
    grip.classList.remove("dragging");
    localStorage.setItem(KEY, String(Math.round(box.getBoundingClientRect().height)));
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
  grip.addEventListener("dblclick", () => { localStorage.removeItem(KEY); apply(0); });
}

// ---------------- 内嵌调试（GDB/MI + GDB Server） ----------------
// 前端负责：把 gdb 的 MI 输出解成人看的文本、认领面板查询的应答、记住路径与参数。
// 后端只负责起进程和转发（见 src-tauri/src/debug.rs）。
const miPairs = (s, key) => {
  const out = [];
  const re = new RegExp(key + "=\\{([^}]*)\\}", "g");
  let m;
  while ((m = re.exec(s))) {
    const o = {};
    const re2 = /([a-zA-Z_-]+)="((?:[^"\\]|\\.)*)"/g;
    let x;
    while ((x = re2.exec(m[1]))) o[x[1]] = x[2].replace(/\\(.)/g, "$1");
    out.push(o);
  }
  return out;
};
// MI 里还有一类结果是没有逐项 key 的数组：
//   variables=[{name="a",value="1"},…] / register-values=[{number="0",value="0x…"},…]
// （真机验过：J-Link + arm-none-eabi-gdb 就是这么回的，所以这两种必须单独解）
const miArray = (s, key) => {
  const i = s.indexOf(key + "=[");
  if (i < 0) return [];
  const inner = s.slice(i + key.length + 2).split("]")[0];
  const out = [];
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(inner))) {
    const o = {};
    const re2 = /([a-zA-Z_-]+)="((?:[^"\\]|\\.)*)"/g;
    let x;
    while ((x = re2.exec(m[1]))) o[x[1]] = x[2].replace(/\\(.)/g, "$1");
    out.push(o);
  }
  return out;
};
// register-names=["r0","r1",…]：纯字符串数组
const miNames = (s, key) => {
  const i = s.indexOf(key + "=[");
  if (i < 0) return [];
  return s.slice(i + key.length + 2).split("]")[0].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
};
let dbgRegNames = [];
const dbgRows = (box, rows, fmt) => {
  const el = $(box);
  if (!el) return;
  el.innerHTML = rows.length
    ? rows.map((r) => `<div class="r">${fmt(r)}</div>`).join("")
    : '<div class="none">（空）</div>';
};
function dbgPrint(text) {
  const o = $("dbg-out");
  if (!o) return;
  o.textContent += text;
  o.scrollTop = o.scrollHeight;
}
function bindDebug() {
  if (!$("dbg-out")) return;
  const saved = (k, d) => localStorage.getItem("kdock_dbg_" + k) || d || "";
  const wire = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.value = saved(key, el.value);
    el.oninput = () => localStorage.setItem("kdock_dbg_" + key, el.value);
  };
  [["dbg-gdb-path", "gdb-path"], ["dbg-gdb-args", "gdb-args"], ["dbg-server-prog", "server-prog"],
   ["dbg-server-args", "server-args"], ["dbg-elf", "elf"]].forEach(([id, k]) => wire(id, k));
  const send = (line) => invoke("debug_gdb_cmd", { line }).catch((e) => dbgPrint(`\n[kdock] ${e}\n`));
  const args = (v) => (v || "").match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
  const paintState = (running) => {
    const el = $("dbg-state");
    if (!el) return;
    el.textContent = running ? en("运行中…") : en("已停下");
    el.className = "dot" + (running ? " ok" : "");
  };
  const refreshAll = () => {
    if (!dbgRegNames.length) send("-data-list-register-names");
    ["-stack-list-frames", "-stack-list-variables --simple-values", "-data-list-register-values x", "-break-list"]
      .forEach((mi) => send(mi));
  };
  const onGdb = (raw) => {
    const m = /^([~@&])"(.*)"$/.exec(raw);
    if (m) { dbgPrint(m[2].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")); return; }
    if (raw.startsWith("*running")) { paintState(true); return; }
    if (raw.startsWith("*stopped")) {
      paintState(false);
      if ($("dbg-auto") && $("dbg-auto").checked) setTimeout(refreshAll, 120);
      return;
    }
    if (raw.startsWith("^done")) {
      if (raw.includes("stack=[")) {
        const rows = miPairs(raw, "frame");
        dbgRows("dbg-stack", rows, (r) => `<span class="k">#${r.level || "?"}</span><span class="v">${r.func || "?"} ${r.addr || ""} ${r.file ? r.file + ":" + (r.line || "") : ""}</span>`);
      }
      if (raw.includes("bkpt=")) {
        const rows = miPairs(raw, "bkpt");
        dbgRows("dbg-bkpt", rows, (r) => `<span class="k">${r.number}</span><span class="v">${r.enabled === "n" ? "（停用）" : ""}${r.func || r.addr || ""} ${r.file ? r.file + ":" + (r.line || "") : ""} · ${r.times || 0} 次</span>`);
      }
      if (raw.includes("variables=[")) {
        const rows = miArray(raw, "variables");
        dbgRows("dbg-vars", rows, (r) => `<span class="k">${r.name}</span><span class="v">${r.value || r.type || ""}</span>`);
      }
      if (raw.includes("register-names=[")) {
        dbgRegNames = miNames(raw, "register-names");
      }
      if (raw.includes("register-values=[")) {
        const rows = miArray(raw, "register-values");
        dbgRows("dbg-regs", rows, (r) => {
          const n = dbgRegNames[Number(r.number)];
          return `<span class="k">${n || "#" + r.number}</span><span class="v">${r.value || ""}</span>`;
        });
      }
      return;
    }
    if (raw.startsWith("^error")) { dbgPrint(`\n[kdock] gdb 报错：${raw.slice(6).trim()}\n`); return; }
    dbgPrint(raw + "\n");
  };
  window.__dbgOnGdb = onGdb;
  paintState(false);

  if ($("dbg-gdb-start")) $("dbg-gdb-start").onclick = async () => {
    try { await invoke("debug_gdb_start", { path: $("dbg-gdb-path").value.trim(), args: args($("dbg-gdb-args").value), cwd: "" }); }
    catch (e) { dbgPrint(`\n[kdock] ${e}\n`); }
  };
  if ($("dbg-gdb-stop")) $("dbg-gdb-stop").onclick = () => invoke("debug_gdb_stop").catch(() => {});
  if ($("dbg-server-start")) $("dbg-server-start").onclick = async () => {
    try { await invoke("debug_server_start", { program: $("dbg-server-prog").value.trim(), args: args($("dbg-server-args").value), cwd: "" }); }
    catch (e) { dbgPrint(`\n[kdock] ${e}\n`); }
  };
  if ($("dbg-server-stop")) $("dbg-server-stop").onclick = () => invoke("debug_server_stop").catch(() => {});
  if ($("dbg-elf-pick")) $("dbg-elf-pick").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "选择 ELF / axf", multiple: false, directory: false,
        filters: [{ name: "固件", extensions: ["elf", "axf", "out", "bin"] }, { name: "全部", extensions: ["*"] }] });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      $("dbg-elf").value = path0;
      localStorage.setItem("kdock_dbg_elf", path0);
    } catch (e) { toast(String(e)); }
  };
  if ($("dbg-load")) $("dbg-load").onclick = async () => {
    const f = $("dbg-elf").value.trim();
    if (!f) return toast("先选一个 ELF");
    await send(`file ${f}`);
    await send("load");
  };
  [["dbg-cont", "-exec-continue"], ["dbg-halt", "-exec-interrupt"], ["dbg-step", "-exec-step"],
   ["dbg-next", "-exec-next"], ["dbg-finish", "-exec-finish"], ["dbg-reset", "monitor reset halt"]]
    .forEach(([id, mi]) => { if ($(id)) $(id).onclick = () => send(mi); });
  if ($("dbg-send")) $("dbg-send").onclick = async () => {
    const v = $("dbg-in").value.trim();
    if (!v) return;
    $("dbg-in").value = "";
    await send(v);
  };
  if ($("dbg-in")) $("dbg-in").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("dbg-send").click(); }
  });
  if ($("dbg-clear")) $("dbg-clear").onclick = () => { $("dbg-out").textContent = ""; };
  if ($("dbg-refresh")) $("dbg-refresh").onclick = () => refreshAll();
  if ($("dbg-bkpt-add")) $("dbg-bkpt-add").onclick = async () => {
    const v = await kdForm({ title: en("加断点"), fields: [{ id: "at", label: en("位置"), ph: "main / 文件:行号 / 地址" }] });
    if (!v || !v.at.trim()) return;
    await send(`break ${v.at.trim()}`);
    await send("-break-list");
  };
}
// ---------------- 时间戳 / 方向标记开关 ----------------
function bindTimestamp() {
  $("show-ts").onchange = () => redrawRx();
  if ($("show-no")) {
    $("show-no").checked = logNoOn();
    $("show-no").onchange = () => logNoSet($("show-no").checked);
  }
  if ($("fl-no")) {
    $("fl-no").checked = logNoOn();
    $("fl-no").onchange = () => logNoSet($("fl-no").checked);
  }
  logNoSet(logNoOn(), true);      // 开机就把行号栏的显隐定下来（默认开）
  if ($("show-dir")) {
    $("show-dir").checked = localStorage.getItem("kdock_show_dir") === "1";
    $("show-dir").onchange = () => {
      localStorage.setItem("kdock_show_dir", $("show-dir").checked ? "1" : "0");
      redrawRx();
    };
  }
}

// ---------------- ASCII 交互：直接在输出区敲键盘跟设备对话 ----------------
async function sendRawText(text) {
  if (!text) return;
  try {
    // raw:true —— 后端不做任何行尾加工，敲什么发什么（回车就是一个 \r）
    const ack = await invoke("write_data", {
      payload: text, mode: "text", lineEnding: "none", raw: true,
    });
    if ($("local-echo").checked && !rxPaused) {
      pushEntry({ dir: "TX", ts_ms: Date.now(), text, hex: ack.hex, ascii: ack.ascii });
    }
  } catch (e) {
    toast(String(e));
  }
}

function bindAsciiMode() {
  $("ascii-mode").onchange = (e) => {
    asciiMode = e.target.checked;
    $("rx").classList.toggle("typing", asciiMode);
    $("rx-hint").hidden = !asciiMode;         // 顶栏那个小标只在真开着的时候亮
    if (asciiMode) {
      $("rx").focus();
      if (!$("local-echo").checked) {
        // 设备有时候要好几秒才回显，先本地把敲的字打出来，不然像"没反应"
        $("local-echo").checked = true;
        pushSys("已自动打开「本地回显」：设备回显有时会慢几秒，先看你敲的字，设备回显到了会跟在后面");
      }
      pushSys("ASCII 交互已打开：点住上面这块直接敲键盘 → 设备；Enter 发送回车，Backspace 发送 0x08");
    } else {
      pushSys("ASCII 交互已关闭");
    }
  };
  // 输出区顶栏那个小标：点一下就退出 ASCII 交互（不用再翻「更多」面板找开关）
  $("rx-hint").onclick = () => {
    const cb = $("ascii-mode");
    if (!cb.checked) return;
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
  };
  // ASCII 交互时，点右边这块任意空白也把焦点还给输出区（不然点完按钮就敲不动了）
  document.querySelector(".work").addEventListener("mousedown", (ev) => {
    if (!asciiMode) return;
    if (ev.target.closest("input, textarea, button, select")) return;
    $("rx").focus();
  });
  $("rx").addEventListener("keydown", async (ev) => {
    if (!asciiMode) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;   // 组合键留给系统
    if (ev.key === "Enter") {
      ev.preventDefault();
      // cshell 认 CR；"行尾=无"在终端模式下也按 CR 走，否则回车发不出任何东西
      const le = $("line-ending").value;
      const end = le === "crlf" ? "\r\n" : le === "lf" ? "\n" : "\r";
      await sendRawText(end);
      return;
    }
    if (ev.key === "Backspace") {
      ev.preventDefault();
      await sendRawText("\b");
      return;
    }
    if (ev.key.length === 1) {          // 可打印字符
      ev.preventDefault();
      await sendRawText(ev.key);
    }
    // 其它键(方向键/PageUp…)保持默认，方便翻页看日志
  });
}

// ---------------- Ctrl+Enter 发送 ----------------
function bindSendShortcut() {
  $("tx").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      doSend();
    }
  });
}

/** 拖把手调"下面这块"的高度（相对地挤压上面），高度记在 localStorage */
function bindLogResize(gripId, boxId, key) {
  const grip = $(gripId), box = $(boxId);
  if (!grip || !box) return;
  const saved = Number(localStorage.getItem(key) || 0);
  if (saved > 40) box.style.height = saved + "px";
  let sy = 0, h0 = 0;
  grip.addEventListener("pointerdown", (e) => {
    sy = e.clientY; h0 = box.getBoundingClientRect().height;
    grip.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.classList.contains("dragging")) return;
    const pane = box.parentElement.getBoundingClientRect().height;
    const want = Math.max(66, Math.min(h0 - (e.clientY - sy), Math.round(pane * 0.7)));
    box.style.height = want + "px";
  });
  const done = () => {
    if (!grip.classList.contains("dragging")) return;
    grip.classList.remove("dragging");
    localStorage.setItem(key, String(Math.round(box.getBoundingClientRect().height)));
    sqRedrawEdges && sqRedrawEdges();
    chartResize && chartResize();
  };
  grip.addEventListener("pointerup", done);
  grip.addEventListener("pointercancel", done);
}

/** 按字典扫一遍 DOM：元素看 placeholder/title，文本节点按 (中文 -> 英文) 替换。
 *  运行时拼出来的控件重建完再扫一遍就行，所以单独抽出来。*/
function langWalk() {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 1) {
      if (n.placeholder) {
        const ph = EN[n.placeholder] || EN[n.placeholder.trim().replace(/\s+/g, " ")];
        if (LANG === "en" && ph) { n.dataset.zhPh = n.dataset.zhPh || n.placeholder; n.placeholder = ph; }
        else if (LANG === "zh" && n.dataset.zhPh) n.placeholder = n.dataset.zhPh;
      }
      // 提示文本：bindTooltips 把 title 搬进了 dataset.tip（为了不让系统画那个丑气泡），
      // 两个地方都要认，不然切语言时提示会漏翻
      const tipRaw = n.dataset.tip || n.getAttribute("title");
      if (tipRaw) {
        const ti = EN[tipRaw] || EN[tipRaw.trim().replace(/\s+/g, " ")];
        if (LANG === "en" && ti) { n.dataset.zhTi = n.dataset.zhTi || tipRaw; n.dataset.tip = ti; }
        else if (LANG === "zh" && n.dataset.zhTi) n.dataset.tip = n.dataset.zhTi;
      }
      continue;
    }
    const t = (n.nodeValue || "").trim();
    if (!t) continue;
    // HTML 里换行+缩进会被算进文本节点；查表时把空白规范化再试一次
    const key = t.replace(/\s+/g, " ");
    if (LANG === "en") {
      const tr = EN[t] || EN[key];
      if (tr) { if (n.__zh == null) n.__zh = n.nodeValue; n.nodeValue = n.nodeValue.replace(t, tr); }
    } else if (n.__zh != null) {
      n.nodeValue = n.__zh; n.__zh = null;
    }
  }
}

// ---------------- 上下文帮助（F1 / 标题栏 / 设置 / 各分区的 ?） ----------------
const HELP_PAGE_LABEL = {
  link: "传输", cmds: "命令表", agent: "Agent", kb: "知识库",
  upgrade: "固件升级", runtime: "运行结构", flash: "烧录", files: "文件管理", adb: "安卓 ADB",
  env: "环境配置", chart: "实时图表", seq: "中控编排", scope: "示波器",
  capture: "屏幕共享", logic: "逻辑分析仪", usb: "监听", batch: "批量文本",
  calc: "计算器", datacalc: "数据计算", debug: "调试",
};
const HELP_PAGE_ROOT = {
  link: "help-transfer-start", cmds: "help-cmds", agent: "help-agent-chat",
  kb: "help-kb-chat", upgrade: "help-upgrade-start", runtime: "help-runtime-start", flash: "help-flash-programmer",
  files: "help-files-start", adb: "help-adb-device", env: "help-env-first",
  chart: "help-chart-main", seq: "help-seq-links", scope: "help-scope-connect",
  capture: "help-capture-source", logic: "help-logic-source", usb: "help-usb-local",
  batch: "help-batch-main", calc: "help-calc-history", datacalc: "help-datacalc-main",
  debug: "help-debug-gdb",
};
const HELP_SETTINGS_ROOT = {
  general: "help-settings-general",
  theme: "help-settings-theme",
  shortcuts: "help-settings-shortcuts",
  model: "help-settings-model",
  skills: "help-settings-skills",
  tools: "help-settings-tools",
  mcp: "help-settings-mcp",
  kb: "help-settings-kb",
  netip: "help-settings-netip",
  cache: "help-settings-cache",
  help: "help-settings-help",
};

const HELP_GROUPS = HELP_GROUPS_CONTENT;

const HELP_HEADING_MAP = {
  link: { "从这里开始": "help-transfer-start", "统计": "help-transfer-stats", "快捷发送": "help-transfer-quick" },
  agent: { "Agent 信息": "help-agent-info", "上下文成分": "help-agent-context", "技能": "help-agent-skills", "MCP 服务": "help-agent-mcp", "页面里的链接": "help-agent-links" },
  kb: { "对话页面": "help-kb-chat", "管理页面": "help-kb-admin" },
  upgrade: { "从这里开始": "help-upgrade-start", "固件": "help-upgrade-firmware" },
  flash: { "烧录器": "help-flash-programmer", "固件": "help-flash-firmware", "命令预览": "help-flash-preview" },
  files: { "从这里开始": "help-files-start", "目录": "help-files-dir", "取回本机": "help-files-pull", "发到设备": "help-files-push" },
  adb: { "设备": "help-adb-device", "无线调试": "help-adb-wireless", "投屏": "help-adb-mirror", "传文件": "help-adb-transfer", "APK": "help-adb-apk", "常用命令": "help-adb-commands" },
  env: { "首次运行检查": "help-env-first", "安装位置": "help-env-location", "安装进度": "help-env-progress" },
  chart: { "图表": "help-chart-main", "通道": "help-chart-channels" },
  seq: { "中控连接": "help-seq-links", "选中节点": "help-seq-node", "编排文件": "help-seq-file" },
  scope: { "连接": "help-scope-connect", "机器状态": "help-scope-status", "通道": "help-scope-channels", "自动测量": "help-scope-measure", "时基 / 触发": "help-scope-timebase", "SCPI": "help-scope-scpi" },
  capture: { "来源": "help-capture-source", "画面": "help-capture-view" },
  logic: { "数据来源": "help-logic-source", "解码器": "help-logic-decoder", "测量": "help-logic-measure" },
  usb: { "本机 USB": "help-usb-local", "网络": "help-usb-network", "设备管理器": "help-usb-manager" },
  runtime: { "分析目标": "help-runtime-start", "显示策略": "help-runtime-mode", "链路分析": "help-runtime-chain", "选中函数": "help-runtime-mode" },
  calc: { "历史记录": "help-calc-history", "各进制一览": "help-calc-bases" },
  datacalc: { "串口常用换算": "help-datacalc-main", "说明": "help-datacalc-main" },
  debug: { "GDB Server": "help-debug-server", "固件 / 运行控制": "help-debug-firmware", "GDB": "help-debug-gdb" },
};

const HELP_SUMMARY_MAP = {
  flash: { "烧录工具路径": "help-flash-tools" },
  files: { "内置 TFTP 服务端": "help-files-tftp" },
};

const helpItemById = new Map(HELP_GROUPS.flatMap((g) => g.items.map((it) => [it.id, { ...it, group: g.title }])));
let helpCurrent = "help-work";

function helpLang() { return LANG === "en" ? "en" : "zh"; }
function helpTitle(it) { return helpLang() === "en" ? (it.enTitle || HELP_TITLE_EN[it.title] || en(it.title)) : it.title; }
function helpText(it) { return helpLang() === "en" ? it.en : it.zh; }

function helpPageOf(el) {
  const pane = el.closest("[data-param]");
  if (pane) return pane.dataset.param;
  const work = el.closest("[data-work]");
  return work ? work.dataset.work : "";
}

function helpHeadingText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll(".help-f1, .btn, .grow, label.chk, input, select").forEach((n) => n.remove());
  return (c.textContent || "").replace(/\s+/g, " ").trim();
}

function helpAnchorFor(page, label, map) {
  const m = map[page] || {};
  for (const [key, anchor] of Object.entries(m)) {
    if (label === key || label.startsWith(key)) return anchor;
  }
  return "";
}

function decorateHelpHeadings() {
  for (const el of document.querySelectorAll(".cardtitle, .adv > summary")) {
    if (el.querySelector(":scope > .help-f1")) continue;
    const page = helpPageOf(el);
    const label = helpHeadingText(el);
    const anchor = el.matches("summary")
      ? helpAnchorFor(page, label, HELP_SUMMARY_MAP)
      : helpAnchorFor(page, label, HELP_HEADING_MAP);
    if (!anchor) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "help-f1";
    b.dataset.help = anchor;
    b.textContent = "?";
    b.title = en("帮助（F1）");
    b.setAttribute("aria-label", en("帮助（F1）"));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openHelp(anchor);
    });
    el.appendChild(b);
  }
}

function helpCurrentPage() {
  return document.documentElement.dataset.tab || "link";
}

function helpSyncPageLabel() {
  const page = helpCurrentPage();
  const el = $("set-help-current");
  if (el) el.textContent = en(HELP_PAGE_LABEL[page] || "");
}

function buildHelpNav() {
  const nav = $("help-nav");
  if (!nav) return;
  nav.innerHTML = "";
  for (const g of HELP_GROUPS) {
    const h = document.createElement("div");
    h.className = "helpnav-page";
    h.textContent = en(g.title);
    nav.appendChild(h);
    for (const it of g.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.help = it.id;
      b.textContent = helpTitle(it);
      b.onclick = () => showHelpItem(it.id);
      nav.appendChild(b);
    }
  }
}

function buildHelpIndex() {
  const box = $("set-help-list");
  if (!box) return;
  box.innerHTML = "";
  for (const g of HELP_GROUPS) {
    const h = document.createElement("div");
    h.className = "helpindex-page";
    h.textContent = en(g.title);
    box.appendChild(h);
    for (const it of g.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.help = it.id;
      const t = document.createElement("span");
      t.textContent = helpTitle(it);
      const d = document.createElement("small");
      d.textContent = helpText(it);
      b.append(t, d);
      b.onclick = () => openHelp(it.id);
      box.appendChild(b);
    }
  }
  helpSyncPageLabel();
}

function showHelpItem(id) {
  const it = helpItemById.get(id) || helpItemById.get("help-work");
  if (!it) return;
  helpCurrent = it.id;
  document.querySelectorAll("#help-nav button").forEach((b) => b.classList.toggle("active", b.dataset.help === it.id));
  const active = document.querySelector(`#help-nav button[data-help="${it.id}"]`);
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  const crumb = $("help-crumb");
  if (crumb) crumb.textContent = `${en(it.group)} / ${helpTitle(it)}`;
  const label = $("help-page-label");
  if (label) label.textContent = en(it.group);
  const body = $("help-body");
  if (!body) return;
  body.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = helpTitle(it);
  body.appendChild(h);
  let ul = null;
  for (const raw of helpText(it).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("### ")) {
      ul = null;
      const h3 = document.createElement("h3");
      const heading = line.slice(4);
      h3.textContent = heading;
      if (/^(联动|Relationships?|Relationship)$/i.test(heading)) h3.classList.add("help-related");
      body.appendChild(h3);
    } else if (line.startsWith("- ")) {
      if (!ul) { ul = document.createElement("ul"); body.appendChild(ul); }
      const li = document.createElement("li");
      li.textContent = line.slice(2);
      ul.appendChild(li);
    } else {
      ul = null;
      const p = document.createElement("p");
      p.textContent = line;
      body.appendChild(p);
    }
  }
  const content = body.closest(".helpcontent");
  if (content) content.scrollTop = 0;
}

function openHelp(anchor) {
  const m = $("help-modal");
  if (!m) return;
  const sm = $("settings-modal");
  const settingsPane = sm && !sm.hidden
    ? (sm.querySelector(".modaltab.active")?.dataset.set || "general")
    : "";
  const id = anchor || HELP_SETTINGS_ROOT[settingsPane] || HELP_PAGE_ROOT[helpCurrentPage()] || "help-work";
  if (sm && !sm.hidden) closeSettings();
  m.hidden = false;
  buildHelpNav();
  showHelpItem(id);
  kbSyncSoon();
}

function closeHelp() {
  const m = $("help-modal");
  if (m) m.hidden = true;
  kbSyncSoon();
}

function bindHelp() {
  const m = $("help-modal");
  if (!m) return;
  const close = $("help-close");
  if (close) close.onclick = closeHelp;
  m.addEventListener("click", (e) => { if (e.target === m) closeHelp(); });
  if ($("set-help-open")) $("set-help-open").onclick = () => openHelp();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !m.hidden) {
      e.preventDefault();
      closeHelp();
    }
  });
  decorateHelpHeadings();
  buildHelpIndex();
  window.kdockOnLang(() => {
    buildHelpIndex();
    if (!m.hidden) {
      buildHelpNav();
      showHelpItem(helpCurrent);
    }
  });
}

// ---------------- 可配置快捷键：动作 → 组合键 → 设置页编辑器 ----------------
const PRIMARY_SHORTCUT_PAGES = ["link", "usb", "agent", "upgrade", "flash", "files", "runtime", "env"];
let shortcutManager = null;
let shortcutSettingsUi = null;

function shortcutCurrentTab() {
  return document.documentElement.dataset.tab || "link";
}

function shortcutCyclePage(delta) {
  const current = shortcutCurrentTab();
  const index = PRIMARY_SHORTCUT_PAGES.indexOf(current);
  const base = index >= 0 ? index : (delta > 0 ? -1 : 0);
  const next = (base + delta + PRIMARY_SHORTCUT_PAGES.length) % PRIMARY_SHORTCUT_PAGES.length;
  showPane(PRIMARY_SHORTCUT_PAGES[next]);
}

function syncShortcutHints() {
  if (!shortcutManager) return;
  const setElementTip = (el, text) => {
    if (!el) return;
    el.title = text;
    el.dataset.tip = text;
  };
  const setTip = (id, text) => setElementTip($(id), text);
  const settingsKey = shortcutManager.labelFor("app.settings");
  const helpKey = shortcutManager.labelFor("app.help");
  const nextDiff = shortcutManager.labelFor("batch.nextDiff");
  const prevDiff = shortcutManager.labelFor("batch.prevDiff");
  const fullscreen = shortcutManager.labelFor("capture.fullscreen");
  setTip("tb-settings", `${en("设置")} (${settingsKey})`);
  setTip("nav-settings", `${en("设置")} (${settingsKey})`);
  setTip("bt-diff-open", en("跟 IDE 一样把左右两份文本并排比对") + ` (${nextDiff} / ${prevDiff})`);
  setTip("bt-diff-prev", `${en("上一处")} (${prevDiff})`);
  setTip("bt-diff-next", `${en("下一处")} (${nextDiff})`);
  setTip("cap-fs", en("全屏") + ` (${fullscreen})`);
  document.querySelectorAll(".help-f1").forEach((el) => setElementTip(el, `${en("帮助")} (${helpKey})`));
  document.documentElement.dataset.shortcutHelp = helpKey;
}

function bindShortcuts() {
  shortcutManager = createShortcutManager({
    handlers: {
      "app.settings": () => openSettings("general"),
      "app.shortcuts": () => openSettings("shortcuts"),
      "app.help": () => openHelp(),
      "nav.next": () => shortcutCyclePage(1),
      "nav.prev": () => shortcutCyclePage(-1),
      "nav.link": () => showPane("link"),
      "nav.monitor": () => showPane("usb"),
      "nav.agent": () => showPane("agent"),
      "nav.flash": () => showPane("flash"),
      "nav.files": () => showPane("files"),
      "nav.runtime": () => showPane("runtime"),
      "nav.env": () => showPane("env"),
      "nav.upgrade": () => showPane("upgrade"),
      "transfer.clear": () => $("clear").click(),
      "transfer.focus": () => {
        showPane("link");
        setTimeout(() => $("tx").focus(), 0);
      },
      "agent.new": () => {
        showPane("agent");
        agNewSession().catch((e) => toast(String(e)));
      },
      "agent.focus": () => {
        showPane("agent");
        setTimeout(() => agEl("ag-input").focus(), 0);
      },
      "batch.nextDiff": () => $("bt-diff-next").click(),
      "batch.prevDiff": () => $("bt-diff-prev").click(),
      "capture.fullscreen": () => capSetFullscreen(!capFs),
    },
    canRun: (id) => {
      const tab = shortcutCurrentTab();
      if (id === "transfer.clear") return tab === "link";
      if (id === "batch.nextDiff" || id === "batch.prevDiff") {
        return tab === "batch" && !!$("bt-diff") && !$("bt-diff").hidden;
      }
      if (id === "capture.fullscreen") return tab === "capture";
      return true;
    },
  });
  shortcutManager.install();
  shortcutManager.subscribe(uiPrefsSave);
  shortcutSettingsUi = mountShortcutSettings({
    root: $("set-shortcuts"),
    manager: shortcutManager,
    getLang: () => LANG,
  });
  syncShortcutHints();
  window.kdockOnLang(() => {
    shortcutSettingsUi?.refresh();
    syncShortcutHints();
  });
}

// ---------------- 设置弹窗（供应商/模型、主题配色、通用、关于） ----------------
function openSettings(section) {
  const m = document.getElementById("settings-modal");
  if (!m) return;
  m.hidden = false;
  if (section) {
    document.querySelectorAll(".modaltab").forEach((b) => b.classList.toggle("active", b.dataset.set === section));
    document.querySelectorAll(".setpane").forEach((p) => { p.hidden = p.dataset.setpane !== section; });
  }
  if (section === "model" && !agNewProfile) agLoadConfig();
  // 打开模型页先落在「使用」面板；实时负载**不主动拉**（等用户展开免费模型那块再拉）
  if (section === "model") agProvTab("use");
  if (section === "shortcuts" && shortcutSettingsUi) shortcutSettingsUi.refresh();
  if (section === "about") agLoadTools();
  if (section === "help") buildHelpIndex();
  if (section === "netip") { bindNetip(); netipLoad(); }
  kbSyncSoon();      // 知识库页那块是原生子视图，会盖住弹窗 —— 开设置就先收起来
}

function closeSettings() {
  const m = document.getElementById("settings-modal");
  if (m) m.hidden = true;
  kbSyncSoon();      // 关掉设置再贴回来
}

function bindSettings() {
  const m = document.getElementById("settings-modal");
  if (!m) return;
  document.querySelectorAll(".modaltab").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".modaltab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".setpane").forEach((p) => { p.hidden = p.dataset.setpane !== b.dataset.set; });
      if (b.dataset.set === "model" && !agNewProfile) agLoadConfig();
      if (b.dataset.set === "model") agProvTab("use");
      if (b.dataset.set === "shortcuts" && shortcutSettingsUi) shortcutSettingsUi.refresh();
      if (b.dataset.set === "about") agLoadTools();
      if (b.dataset.set === "cache") { cacheRender(); bindCache(); }
      // 技能页：**重新扫一遍再画** —— 用户可能是"打开技能目录、往里丢了一个 SKILL.md"
      // 才切回来的，只重画旧快照就会看不见新技能（后端的目录指纹缓存很便宜）
      if (b.dataset.set === "skills") { agLoadSkills(); }
      if (b.dataset.set === "tools") { agToolRows = []; renderToolsPage(); }
      if (b.dataset.set === "help") buildHelpIndex();
      if (b.dataset.set === "netip") { bindNetip(); netipLoad(); }
      if (b.dataset.set === "theme") tbSyncTheme();
      if (b.dataset.set === "about" || b.dataset.set === "general") agRenderAbout();
      if (LANG === "en") setTimeout(() => langWalk(), 0);   // 这一页里运行时拼出来的文字
    };
  });
  const close = document.getElementById("settings-close");
  if (close) close.onclick = closeSettings;
  // 关于本软件那几个按钮：GitHub 仓库 / 作者主页 / 更新日志 / 跳到完整关于页
  if (document.getElementById("set-open-github")) {
    document.getElementById("set-open-github").onclick = () => openExternal(KDOCK_REPO);
  }
  if (document.getElementById("set-open-author")) {
    document.getElementById("set-open-author").onclick = () => openExternal(KDOCK_AUTHOR);
  }
  if (document.getElementById("set-open-changelog")) {
    document.getElementById("set-open-changelog").onclick = () => openExternal(KDOCK_REPO + "/blob/main/CHANGELOG.md");
  }
  if (document.getElementById("set-about-github")) {
    document.getElementById("set-about-github").onclick = () => openExternal(KDOCK_REPO);
  }
  if (document.getElementById("set-about-more")) {
    document.getElementById("set-about-more").onclick = () => {
      document.querySelectorAll(".modaltab").forEach((x) => x.classList.toggle("active", x.dataset.set === "about"));
      document.querySelectorAll(".setpane").forEach((p) => { p.hidden = p.dataset.setpane !== "about"; });
      agLoadTools();
      agRenderAbout();
    };
  }
  agLoadVersion();
  m.addEventListener("click", (e) => { if (e.target === m) closeSettings(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !m.hidden) closeSettings();
  });
  const zh = document.getElementById("set-lang-zh");
  const enb = document.getElementById("set-lang-en");
  if (zh) zh.onclick = () => { applyLang("zh"); toast("语言：中文"); };
  if (enb) enb.onclick = () => { applyLang("en"); toast("Language: English"); };
  amdBind();
  invoke("agent_config_get").then((c) => {
    const el = document.getElementById("set-datadir");
    if (el) {
      const scheme = c.secretScheme === "dpapi"
        ? "Windows DPAPI" + en("（按当前用户加密）")
        : en("明文（非 Windows）");
      el.textContent =
        `${en("数据目录：")}${c.dataDir}\n` +
        `${en("密钥存储：")}${scheme}\n` +
        `${en("供应商")} ${c.providers.length} ${en("个 · 已存密钥")} ${(c.secrets || []).length}`;
    }
  }).catch(() => {});
}

// ==================== Agent：会自己动手的调试助手 ====================
// 后端一个回合的流程：组装上下文(必要时压缩) -> 流式调模型 -> 有工具调用就执行 -> 回填再问。
// 这里负责：会话列表、对话渲染(含工具卡片)、供应商/技能编辑、以及 host 工具（编排/切页/截屏）。

let agCfg = null;                 // agent_config_get 的结果
let agSessions = [];
let agMeta = null;                // 当前会话元信息
let agEvents = [];                // 当前会话事件
let agStreamNode = null;          // 正在流式写入的正文节点
let agStreamText = "";
let agThinkNode = null;           // 正在流式写入的"思考过程"块
let agReasonText = "";
let agRunning = false;
const agRunSessions = new Set();
let agSkills = [];
let agAlways = { slugs: [], bytes: 0, limit: 16384 };   // 常驻技能：正文每轮注入系统提示的那些
const agIsAlways = (slug) => (agAlways.slugs || []).includes(slug);
let agTools = [];
let agToolCards = {};             // call id -> 卡片元素
let agToolArgs = {};              // call id -> 参数（结果事件不带参数，替换卡片时要沿用）

const agEl = (id) => document.getElementById(id);

/**
 * 自绘确认/输入弹窗。
 * 为什么不用 window.confirm / window.prompt：WebView2 里它们是**桩实现**，
 * confirm 恒返回 true、prompt 直接返回默认值 —— 表现出来就是"还没点确认，东西已经删了"。
 */
function agDialog(opts) {
  return new Promise((resolve) => {
    const box = agEl("ag-dlg");
    const title = agEl("ag-dlg-title");
    const text = agEl("ag-dlg-text");
    const input = agEl("ag-dlg-input");
    const ok = agEl("ag-dlg-ok");
    const cancel = agEl("ag-dlg-cancel");
    if (!box) { resolve({ ok: false, value: "" }); return; }
    title.textContent = opts.title || en("确认");
    text.textContent = opts.text || "";
    const wantInput = !!opts.input;
    input.hidden = !wantInput;
    input.value = opts.def || "";
    ok.textContent = opts.okText || en("确定");
    ok.className = "btn small " + (opts.danger ? "danger" : "primary");
    box.hidden = false;
    const finish = (v) => {
      box.hidden = true;
      document.removeEventListener("keydown", onKey, true);
      ok.onclick = null; cancel.onclick = null; box.onclick = null;
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish({ ok: false, value: "" }); }
      if (e.key === "Enter" && wantInput) { e.stopPropagation(); finish({ ok: true, value: input.value }); }
    };
    document.addEventListener("keydown", onKey, true);
    ok.onclick = () => finish({ ok: true, value: wantInput ? input.value : "" });
    cancel.onclick = () => finish({ ok: false, value: "" });
    box.onclick = (e) => { if (e.target === box) finish({ ok: false, value: "" }); };
    if (wantInput) setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
const agConfirm = (text, title, danger) =>
  agDialog({ text, title, danger }).then((r) => r.ok);
const agAsk = (text, def, title) =>
  agDialog({ text, title, input: true, def }).then((r) => (r.ok ? r.value : null));

/**
 * 厂家预设：都是"OpenAI 兼容"的写法（能填 base_url 的服务）。
 * 不是 OpenAI 格式的（Anthropic / Gemini 官方）只能走网关，所以这里不假装支持。
 */
const AG_PRESETS = [
  { id: "deepseek", name: "DeepSeek（OpenAI 兼容）", endpoint: "https://api.deepseek.com", model: "deepseek-flash", ctx: 128000,
    note: "DeepSeek 官方 OpenAI 兼容口（地址填 https://api.deepseek.com，会自动接 /v1/chat/completions）。可用模型：deepseek-flash / deepseek-v4-pro / deepseek-chat / deepseek-reasoner。" },
  { id: "deepseek-anthropic", name: "DeepSeek（Anthropic 格式）", endpoint: "https://api.deepseek.com/anthropic", model: "deepseek-flash", ctx: 128000, kind: "anthropic",
    note: "DeepSeek 的 Anthropic 兼容口：走 /v1/messages + x-api-key 那套。给只认 Anthropic 协议的工具用；本工具两种协议都支持。" },
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", ctx: 128000,
    note: "官方 API（国内直连不通，要代理）。" },
  { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", ctx: 128000,
    note: "一个 Key 调很多家模型，模型名带厂商前缀。" },
  { id: "moonshot", name: "Moonshot (Kimi)", endpoint: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", ctx: 128000,
    note: "月之暗面，OpenAI 兼容。" },
  { id: "zhipu", name: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", ctx: 128000,
    note: "智谱 AI。注意地址是 /api/paas/v4，不是 /v1。" },
  { id: "dashscope", name: "阿里通义 DashScope", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", ctx: 131072,
    note: "必须用 compatible-mode 这个地址才是 OpenAI 兼容。" },
  { id: "siliconflow", name: "硅基流动", endpoint: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", ctx: 65536,
    note: "国内聚合，便宜；模型名要带厂商前缀。" },
  { id: "volc", name: "火山方舟（豆包）", endpoint: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-32k", ctx: 32000,
    note: "模型名要填你自己的接入点 ID（ep-xxxxxxxx）。" },
  { id: "groq", name: "Groq", endpoint: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", ctx: 128000,
    note: "很快的推理服务，国内要代理。" },
  { id: "xai", name: "xAI Grok", endpoint: "https://api.x.ai/v1", model: "grok-2-latest", ctx: 131072,
    note: "国内要代理。" },
  { id: "xiaomi-mimo-pro", name: "小米 MiMo V2.6 Pro（Token Plan）",
    endpoint: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.6-pro", ctx: 1048576,
    note: "小米 MiMo Token Plan 国内入口，OpenAI 兼容；1M 上下文、支持工具调用。" },
  { id: "xiaomi-mimo-flash", name: "小米 MiMo V2.6 Flash（Token Plan）",
    endpoint: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.6-flash", ctx: 1048576,
    note: "小米 MiMo Token Plan 国内入口，OpenAI 兼容；1M 上下文、支持工具调用。" },
  { id: "ollama", name: "Ollama（本机）", endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b", ctx: 32768,
    note: "本机跑模型：先 `ollama serve`；API Key 随便填一个（例如 ollama），本机不校验。" },
  { id: "lmstudio", name: "LM Studio（本机）", endpoint: "http://127.0.0.1:1234/v1", model: "local-model", ctx: 32768,
    note: "本机 LM Studio 的 OpenAI 兼容口；Key 随便填。" },
  { id: "amd-free", name: "AMD Radeon Cloud（免费额度）",
    endpoint: "https://developer.amd.com.cn/radeon/api/v1", model: "DeepSeek-V4-Flash", ctx: 128000,
    note: "AMD 的免费额度，同一个 Key 下有十几个模型（DeepSeek / Qwen / GLM / MiniCPM / Gemma…）。" +
          "这些模型已经内置在「已配置」列表里（AMD 免费 · xxx），删了可以去设置里点「+ AMD 免费模型」加回来。" +
          "注意：这个服务很挑时间，选模型时下拉里会显示当前是空闲还是满载；Key 在 AMD 后台拿。" },
  { id: "gateway", name: "自定义 / 自建网关", endpoint: "", model: "", ctx: 128000,
    note: "OneAPI / NewAPI / vLLM / 企业内网网关：填它的 base_url（看到 /v1 为止）。Claude、Gemini 官方不是这个格式，也得走这类网关。" },
];

/** 预设列表不能等配置接口回来才填；否则刚打开「高级」时下拉是空的。 */
function agEnsurePresets() {
  const ps = agEl("ag-preset");
  if (!ps) return;
  if (ps.options.length <= 1) {
    ps.innerHTML = '<option value="">— 选厂家 —</option>';
    for (const p of AG_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = en(p.name);
      ps.appendChild(o);
    }
  }
  if (!ps.value && AG_PRESETS.length) ps.value = AG_PRESETS[0].id;
}

/* ── models.dev 精简目录 ─────────────────────────────────────────────────────
   这里不复制 opencode 的运行时模型实现，只读同一份公开目录：provider 的 api / npm
   与模型的 context、output、tool_call、cost。KDock 目前只直连 OpenAI 兼容和
   Anthropic Messages 两类协议，所以目录里只保留后端真正能调用的厂商。
   原始 api.json 约 5.7MB；压缩成“文本 + 工具调用”模型后缓存到 localStorage。 */
const MD_URL = "https://models.dev/api.json";
const MD_CACHE_KEY = "kdock_modelsdev_catalog_v3";
const MD_TTL = 24 * 60 * 60 * 1000;
const MD_POPULAR = [
  "deepseek", "anthropic", "openai", "moonshotai", "moonshotai-cn",
  "zhipuai", "zai", "alibaba", "alibaba-cn", "minimax", "minimax-cn",
  "xai", "groq", "xiaomi", "xiaomi-token-plan-cn", "openrouter", "siliconflow", "siliconflow-cn",
  "volcengine", "mistral", "cerebras", "ollama-cloud", "lmstudio", "github-copilot",
];
/** 目录用英文名检索；中文界面下这些别名让“输入厂商中文名”也能搜到。 */
const MD_ALIASES = {
  deepseek: ["深度求索", "深度"],
  anthropic: ["克劳德", "claude"],
  openai: ["开放智能", "gpt"],
  google: ["谷歌", "gemini", "双子座"],
  moonshotai: ["月之暗面", "月暗", "kimi"],
  "moonshotai-cn": ["月之暗面", "月暗", "kimi"],
  zhipuai: ["智谱", "glm"],
  zai: ["智谱", "glm"],
  alibaba: ["阿里", "通义", "千问", "qwen"],
  "alibaba-cn": ["阿里", "通义", "千问", "qwen"],
  minimax: ["稀宇", "海螺"],
  "minimax-cn": ["稀宇", "海螺"],
  xai: ["马斯克", "grok"],
  xiaomi: ["小米", "米", "mimo"],
  "xiaomi-token-plan-cn": ["小米", "米", "mimo", "token plan"],
  volcengine: ["火山", "豆包", "方舟"],
  siliconflow: ["硅基流动"],
  "siliconflow-cn": ["硅基流动"],
};
/** models.dev 对官方 SDK 供应商不给 api；补上 KDock 能直连的默认入口。 */
const MD_DEFAULT_API = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};
const MD_OPENAI_IDS = new Set([
  ...MD_POPULAR, "deepinfra", "togetherai", "fireworks-ai", "perplexity",
  "openrouter", "requesty", "novita-ai", "hyperbolic", "nebius", "sambanova",
]);
let mdCatalog = null;
let mdLoading = false;
let mdProviderId = "";
let mdModelKey = "";
let mdQuery = "";
let mdShowAll = false;

function mdKind(p) {
  const npm = String(p.npm || "").toLowerCase();
  if (npm.includes("anthropic")) return "anthropic";
  if (npm.includes("openai") || MD_OPENAI_IDS.has(String(p.id))) return "openai";
  return "";
}

function mdCached() {
  try {
    const c = JSON.parse(localStorage.getItem(MD_CACHE_KEY) || "null");
    return c && Array.isArray(c.providers) && c.providers.length ? c : null;
  } catch (_) { return null; }
}

function mdCompact(raw) {
  const providers = [];
  for (const p of Object.values(raw || {})) {
    const kind = mdKind(p);
    const api = p && (p.api || MD_DEFAULT_API[p.id]);
    if (!kind || !api) continue;
    const models = [];
    for (const m of Object.values(p.models || {})) {
      if (!m || !m.id || !m.tool_call) continue;
      if (!(m.modalities && Array.isArray(m.modalities.output) && m.modalities.output.includes("text"))) continue;
      const ctx = Number(m.limit && m.limit.context) || 0;
      const out = Number(m.limit && m.limit.output) || 0;
      if (!ctx) continue;
      const c = m.cost || {};
      models.push({
        id: String(m.id),
        name: String(m.name || m.id),
        ctx,
        out,
        input: Number(c.input) || 0,
        output: Number(c.output) || 0,
        cache: Number(c.cache_read) || 0,
        reasoning: !!m.reasoning,
        status: m.status || "",
        release: m.release_date || "",
      });
    }
    if (!models.length) continue;
    models.sort((a, b) =>
      (a.status === "deprecated" ? 1 : 0) - (b.status === "deprecated" ? 1 : 0) ||
      String(b.release).localeCompare(String(a.release)) || a.name.localeCompare(b.name));
    providers.push({
      id: String(p.id), name: String(p.name || p.id), api: String(api || ""),
      doc: String(p.doc || ""), npm: String(p.npm || ""), kind, models,
    });
  }
  const rank = (id) => { const i = MD_POPULAR.indexOf(id); return i < 0 ? 999 : i; };
  providers.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  return providers;
}

async function mdEnsure(force) {
  if (mdLoading) return;
  const cached = mdCached();
  if (!force && mdCatalog) { mdRender(); return; }
  if (!force && cached && Date.now() - Number(cached.at || 0) < MD_TTL) {
    mdCatalog = cached;
    mdRender();
    return;
  }
  mdLoading = true;
  if (mdCatalog) mdRender();
  if ($("md-state")) $("md-state").textContent = en("读取 models.dev…");
  try {
    const r = await fetch(MD_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    const providers = mdCompact(raw);
    if (!providers.length) throw new Error(en("目录里没有可用模型"));
    mdCatalog = { at: Date.now(), providers };
    try { localStorage.setItem(MD_CACHE_KEY, JSON.stringify(mdCatalog)); }
    catch (_) {
      // 配额不够就只缓存热门厂商，目录仍可在本次运行里用
      const hot = providers.filter((p) => MD_POPULAR.includes(p.id));
      try { localStorage.setItem(MD_CACHE_KEY, JSON.stringify({ at: Date.now(), providers: hot })); } catch (_) {}
    }
  } catch (e) {
    if (cached) mdCatalog = cached;
    if ($("md-state")) $("md-state").textContent = en("目录读取失败：") + String(e && e.message ? e.message : e);
  } finally {
    mdLoading = false;
    mdRender();
  }
}

const mdTrim0 = (s) => String(s).includes(".") ? String(s).replace(/0+$/, "").replace(/\.$/, "") : String(s);
const mdK = (n) => n >= 1e6 ? mdTrim0((n / 1e6).toFixed(n % 1e6 ? 1 : 0)) + "M"
  : n >= 1000 ? mdTrim0((n / 1000).toFixed(n % 1000 ? 1 : 0)) + "K" : String(n || 0);
const mdMoney = (n) => n > 0 ? "$" + mdTrim0(Number(n).toFixed(n < 1 ? 4 : 2)) : "—";

function mdCurrent() {
  return (mdCatalog && mdCatalog.providers || []).find((p) => p.id === mdProviderId) || null;
}
function mdCurrentModel() {
  const p = mdCurrent();
  return p ? p.models.find((m) => m.id === mdModelKey) || null : null;
}

function mdRender() {
  const pbox = $("md-providers");
  const mbox = $("md-models");
  if (!pbox || !mbox) return;
  const q = mdQuery.trim().toLowerCase();
  const all = (mdCatalog && mdCatalog.providers) || [];
  let ps = all.filter((p) => !q ||
    `${p.name} ${p.id} ${(MD_ALIASES[p.id] || []).join(" ")}`.toLowerCase().includes(q) ||
    p.models.some((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)));
  if (!q && !mdShowAll) ps = ps.filter((p) => MD_POPULAR.includes(p.id));
  if (mdProviderId && !ps.some((p) => p.id === mdProviderId)) mdProviderId = "";
  if (!mdProviderId && ps.length) mdProviderId = ps[0].id;
  if (mdProviderId && !ps.some((p) => p.id === mdProviderId)) mdProviderId = ps.length ? ps[0].id : "";
  pbox.textContent = "";
  for (const p of ps) {
    const b = document.createElement("button");
    b.className = "mdprovider" + (p.id === mdProviderId ? " active" : "");
    const n = document.createElement("span"); n.className = "n"; n.textContent = p.name;
    const c = document.createElement("span"); c.className = "c";
    c.textContent = `${p.models.length} ${en("个模型")}`;
    b.append(n, c);
    b.onclick = () => { mdProviderId = p.id; mdModelKey = ""; mdRender(); };
    pbox.appendChild(b);
  }
  if (!q && !mdShowAll && all.length > ps.length) {
    const more = document.createElement("button");
    more.className = "mdprovider mdmore";
    more.textContent = `${en("显示全部")} ${all.length} ${en("家供应商")}`;
    more.onclick = () => { mdShowAll = true; mdRender(); };
    pbox.appendChild(more);
  } else if (!q && mdShowAll) {
    const less = document.createElement("button");
    less.className = "mdprovider mdmore";
    less.textContent = en("只看常用");
    less.onclick = () => { mdShowAll = false; mdRender(); };
    pbox.appendChild(less);
  }
  if (!ps.length) pbox.appendChild(mdEmpty(en("没有匹配的供应商")));

  const p = mdCurrent();
  mbox.textContent = "";
  if (!p) {
    mbox.appendChild(mdEmpty(mdCatalog ? en("没有匹配的模型") : en("目录还没加载")));
  } else {
    const models = p.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    const MAX = 400;
    for (const m of models.slice(0, MAX)) {
      const b = document.createElement("button");
      b.className = "mdmodel";
      const n = document.createElement("span"); n.className = "mn"; n.textContent = m.name;
      const meta = document.createElement("span"); meta.className = "mm";
      meta.textContent = `${mdK(m.ctx)} ctx · ${mdMoney(m.input)}/${mdMoney(m.output)}`;
      const id = document.createElement("span"); id.className = "mi"; id.textContent = m.id;
      const tags = document.createElement("span"); tags.className = "mm";
      tags.textContent = `${m.reasoning ? en("推理") + " · " : ""}${m.status === "deprecated" ? en("旧版") : en("工具")}`;
      b.append(n, meta, id, tags);
      b.onclick = () => {
        mdModelKey = m.id;
        mdRenderPick(true);
        mdRender();
      };
      mbox.appendChild(b);
    }
    if (models.length > MAX) mbox.appendChild(mdEmpty(`${en("还有")} ${models.length - MAX} ${en("个，继续搜索缩小范围")}`));
    if (!models.length) mbox.appendChild(mdEmpty(en("这个供应商下没有匹配模型")));
  }
  if ($("md-state")) {
    $("md-state").textContent = mdCatalog
      ? `${all.length} ${en("家供应商")} · ${all.reduce((n, x) => n + x.models.length, 0)} ${en("个模型")}`
      : en("尚未加载");
  }
  mdRenderPick(false);
}

function mdEmpty(text) {
  const d = document.createElement("div"); d.className = "mdempty"; d.textContent = text; return d;
}

function mdRenderPick(reset) {
  const box = $("md-pick");
  if (!box) return;
  const p = mdCurrent(), m = mdCurrentModel();
  box.hidden = !(p && m);
  if (!p || !m) return;
  if ($("md-pick-title")) $("md-pick-title").textContent = `${p.name} · ${m.name}`;
  if ($("md-pick-badges")) {
    const tags = [p.kind === "anthropic" ? "Anthropic" : "OpenAI", `${mdK(m.ctx)} ctx`, `${mdK(m.out)} out`];
    if (m.reasoning) tags.push(en("推理"));
    $("md-pick-badges").textContent = tags.join(" · ");
  }
  if ($("md-pick-meta")) {
    $("md-pick-meta").textContent = `${m.id} · ${en("输入")} ${mdMoney(m.input)} / ${en("缓存命中")} ${mdMoney(m.cache)} / ${en("输出")} ${mdMoney(m.output)} · ${en("每百万 token，美元")}`;
  }
  if (reset) {
    if ($("md-endpoint")) $("md-endpoint").value = p.api;
    const id = ("md-" + p.id + "-" + m.id).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
    if ($("md-id")) $("md-id").value = id;
    if ($("md-key")) $("md-key").value = "";
  }
  const id = ($("md-id") && $("md-id").value || "").trim();
  const exists = !!(agCfg && (agCfg.providers || []).some((x) => x.id === id));
  const hasSecret = !!(agCfg && (agCfg.secrets || []).includes(id));
  if ($("md-key")) $("md-key").placeholder = exists && hasSecret ? en("已保存，留空即可") : en("粘贴 Key");
  if ($("md-pick-state")) $("md-pick-state").textContent = exists ? en("已有同名配置，保存会更新它") : "";
}

async function mdAddModel() {
  const p = mdCurrent(), m = mdCurrentModel();
  if (!p || !m) return;
  const id = ($("md-id") && $("md-id").value || "").trim();
  const endpoint = ($("md-endpoint") && $("md-endpoint").value || "").trim();
  if (!id) return toast(en("ID 不能空"));
  if (!endpoint) return toast(en("地址不能空"));
  const provider = {
    id,
    name: `${p.name} · ${m.name}`,
    kind: p.kind,
    endpoint,
    model: m.id,
    api_key_ref: id,
    temperature: 0.2,
    reasoning_efforts: agRecommendedEfforts(m.id, m.reasoning),
    reasoning_effort: m.reasoning ? "medium" : "",
    context_window: m.ctx,
    reserve_output: Math.max(1024, Math.min(m.out || 8192, 65536)),
    max_messages: 40,
    supports_tools: true,
    supports_stream: true,
    pricing: {
      currency: "USD", peak_enabled: false,
      peak_hit: m.cache, peak_miss: m.input, peak_out: m.output,
      offpeak_hit: m.cache, offpeak_miss: m.input, offpeak_out: m.output,
    },
  };
  try {
    await invoke("agent_provider_save", { provider, makeActive: true });
    const key = ($("md-key") && $("md-key").value || "").trim();
    if (key) await invoke("agent_secret_set", { name: id, value: key });
    toast(en("已添加：") + m.name);
    await agLoadConfig();
    agProvTab("use");
  } catch (e) { toast(String(e)); }
}

function agEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** GFM 表格：表头行 + `|---|:--:|` 分隔行才算表格，之后跟着的带 `|` 的行都是表体。
 *  只在纯文本行上生效（代码块在这之前已经被抽成占位符了，所以不会误伤代码里的 `|`）。
 *  单元内容不在这里做行内语法 —— 后面 `code` / `**粗体**` 的替换是在整串上做的，会一起处理。 */
function agMdTable(s) {
  const lines = s.split("\n");
  const out = [];
  // 分隔行必须带 `|`：否则单独一行 `---`（分隔线）会被当成单列表格
  const isDelim = (ln) =>
    ln.includes("-") && ln.includes("|") && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(ln);
  const cells = (ln) => {
    // 先保护 `\|`（表格里写命令时经常有），再按 | 切
    const t = ln.trim().replace(/^\|/, "").replace(/\|$/, "").replace(/\\\|/g, "\u0000P\u0000");
    return t.split("|").map((c) => c.trim().replace(/\u0000P\u0000/g, "|"));
  };
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const delim = lines[i + 1];
    if (!head.includes("|") || delim == null || !isDelim(delim)) { out.push(head); continue; }
    const hcells = cells(head);
    const aligns = cells(delim).map((d) =>
      d.startsWith(":") && d.endsWith(":") ? "md-c" : d.endsWith(":") ? "md-r" : "");
    let j = i + 2;
    const rows = [];
    for (; j < lines.length; j++) {
      if (!lines[j].includes("|") || isDelim(lines[j])) break;
      rows.push(cells(lines[j]));
    }
    const al = (n) => (aligns[n] ? ' class="' + aligns[n] + '"' : "");
    let html = "<table><thead><tr>";
    hcells.forEach((c, n) => { html += "<th" + al(n) + ">" + c + "</th>"; });
    html += "</tr></thead><tbody>";
    for (const r of rows) {
      html += "<tr>";
      for (let n = 0; n < hcells.length; n++) html += "<td" + al(n) + ">" + (r[n] || "") + "</td>";
      html += "</tr>";
    }
    html += "</tbody></table>";
    out.push(html);            // 整段合成一行：bubble 是 white-space:pre-wrap，换行会变成空行
    i = j - 1;                 // 表体已经吃掉
  }
  return out.join("\n");
}

/** 极简 markdown：代码块 / 表格 / 行内代码 / 粗体。其余按纯文本，绝不直接 innerHTML 模型输出 */
function agMd(text) {
  let s = agEscape(text);
  const blocks = [];
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return "\u0000B" + (blocks.length - 1) + "\u0000";
  });
  s = agMdTable(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/\u0000B(\d+)\u0000/g, (_m, i) => "<pre>" + blocks[Number(i)] + "</pre>");
  return s;
}

/** 运行中**不再禁用**输入：这时候发出去 = "补充"，后端排队、在这一轮的下一个步骤并入（和 codex 一样）。
 *  函数名保留（调用点多）。 */
function agSetSendDisabled(on) {
  const b = agEl("ag-send");
  if (!b) return;
  b.disabled = false;                                   // 永远可点
  b.textContent = en(on ? "补充" : "发送");
  b.title = on ? "agent 正在跑：发出去不会打断输出，会在这一轮的下一个步骤并入" : "";
  const t = agEl("ag-input");
  if (t) t.disabled = false;
}

// 状态灯：空闲 = 绿灯，思考中/跑工具 = 转圈，出错 = 红点，等你批准 = 黄点。
// 文字不再显示，改成 tooltip（详细信息仍然能看）；后面还能挂一个"未读回复"的灰色角标。
let agStateText = "";
let agStateKind = "";
let agUnread = 0;
function agStatePaint() {
  const el = agEl("ag-state");
  if (!el) return;
  el.className = "agst" + (agStateKind ? " " + agStateKind : "");
  el.title = agStateText;
  el.innerHTML = '<span class="led"></span><span class="spin"></span>' +
    (agUnread ? `<span class="badge" title="${en("有未读回复")}">${agUnread > 9 ? "9+" : agUnread}</span>` : "");
}
function agState(text, cls) {
  agStateText = text ? en(text) : "";
  agStateKind = cls === "ok" ? "busy" : cls === "err" ? "err" : cls === "wait" ? "wait" : "";
  agStatePaint();
}
/** agent 页现在是不是可见（用户有没有可能正看着它） */
const agAgentVisible = () => { const p = document.querySelector('.workpane[data-work="agent"]'); return !!p && !p.hidden; };
const agWatching = () => agAgentVisible() && !document.hidden && document.hasFocus();
function agUnreadBump() { agUnread = Math.min(99, agUnread + 1); agStatePaint(); }
function agUnreadClear() { if (!agUnread) return; agUnread = 0; agStatePaint(); }

// ---- 4a：思考过程块（像 Codex：思考时展开、正文开始后自动收起）----
function agThinkPaint() {
  const n = agThinkNode;
  if (!n || !n.isConnected) return;
  const lb = n.querySelector(".lb");
  const n2 = agReasonText.trim().length;
  if (lb) lb.textContent = n2 ? `${en("已思考")} ${n2} 字` : en("思考中…");
  const bd = n.querySelector(".bd");
  if (bd) bd.textContent = agReasonText;
}
function agThinkBind(node) {
  const th = node.querySelector(".th");
  if (th) th.onclick = () => {
    node.classList.toggle("open");
    const c = node.querySelector(".chev");
    if (c) c.textContent = node.classList.contains("open") ? "▾" : "▸";
  };
}
function agThinkEnsure() {
  if (agThinkNode && agThinkNode.isConnected) return agThinkNode;
  const box = agEl("ag-chat");
  if (!box) return null;
  const node = document.createElement("div");
  node.className = "agthink open busy";
  node.innerHTML =
    '<div class="th"><span class="spin"></span><span class="lb"></span><span class="grow"></span><span class="chev">▾</span></div>' +
    '<div class="bd"></div>';
  agThinkBind(node);
  box.appendChild(node);
  agThinkNode = node;
  agThinkPaint();
  return node;
}
/** 正文开始 / 这一段结束：收起思考块（没内容的直接删掉） */
function agThinkSettle() {
  const n = agThinkNode;
  agThinkNode = null;
  agReasonText = "";
  if (!n || !n.isConnected) return;
  const bd = n.querySelector(".bd");
  const text = bd ? bd.textContent.trim() : "";
  if (!text) { n.remove(); return; }
  n.classList.remove("busy", "open");
  const c = n.querySelector(".chev");
  if (c) c.textContent = "▸";
  const lb = n.querySelector(".lb");
  if (lb) lb.textContent = `${en("已思考")} ${text.length} 字`;
}
/** 历史里的思考过程：渲染成一个默认收起的块 */
function agThinkNodeFrom(text) {
  const node = document.createElement("div");
  node.className = "agthink";
  node.innerHTML =
    '<div class="th"><span class="lb"></span><span class="grow"></span><span class="chev">▸</span></div><div class="bd"></div>';
  const t = String(text).trim();
  node.querySelector(".lb").textContent = `${en("思考过程")} · ${t.length} 字`;
  node.querySelector(".bd").textContent = t;
  agThinkBind(node);
  return node;
}

function agScrollTail(force) {
  const box = agEl("ag-chat");
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

/** 每条回复下面那行小字：**当时**用的模型 + 回复完成时间。
 *  模型是后端往会话里记的（`Event::Assistant.model`），所以翻历史也准；
 *  老会话没这个字段就只显示时间（时间取事件落盘时的 ts）。 */
function agMsgMetaText(ev) {
  const parts = [];
  if (ev && ev.model) parts.push(String(ev.model));
  const ts = Number((ev && ev.ts) || 0);
  if (ts > 0) {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const sameDay = d.toDateString() === new Date().toDateString();
    parts.push(sameDay ? `${hm}:${p2(d.getSeconds())}` : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`);
  }
  return parts.join(" · ");
}

function agMsgNode(kind, text, ev) {
  const wrap = document.createElement("div");
  wrap.className = "agmsg " + kind;
  const head = document.createElement("div");
  head.className = "head";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = kind === "user" ? ((agMeta && agMeta.user_name) || "你")
    : kind === "assistant" ? ((agMeta && agMeta.agent_name) || "Agent")
    : kind === "err" ? "出错" : "系统";
  head.appendChild(who);
  const body = document.createElement("div");
  body.className = "bubble";
  if (kind === "assistant") body.innerHTML = agMd(text);
  else body.textContent = text;
  wrap.appendChild(head);
  wrap.appendChild(body);
  if (kind === "assistant") {
    const mt = agMsgMetaText(ev);
    if (mt) {
      const meta = document.createElement("div");
      meta.className = "agmeta";
      meta.textContent = mt;
      meta.title = en("模型") + " · " + en("回复完成时间");
      wrap.appendChild(meta);
    }
  }
  return wrap;
}

function agToolNode(ev) {
  const wrap = document.createElement("div");
  wrap.className = "agtool" + (ev.ok === false ? " bad" : ev.ok ? " ok" : "");
  const head = document.createElement("div");
  head.className = "th";
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = ev.name + (ev.args && Object.keys(ev.args).length ? " · " + agArgSummary(ev.args) : "");
  const st = document.createElement("span");
  st.className = "st";
  st.textContent = ev.ok === false ? en("失败") : ev.ok ? en("完成") : en("执行中…");
  head.appendChild(nm);
  head.appendChild(st);
  const bd = document.createElement("div");
  bd.className = "bd";
  const args = ev.args || {};
  if (Object.keys(args).length) {
    const argBox = document.createElement("details");
    argBox.className = "agargs";
    const argSum = document.createElement("summary");
    argSum.textContent = en("参数") + " · " + agArgSummary(args);
    const argPre = document.createElement("pre");
    argPre.textContent = JSON.stringify(args, null, 2);
    argBox.appendChild(argSum);
    argBox.appendChild(argPre);
    bd.appendChild(argBox);
  }
  if (ev.text != null) {
    bd.appendChild(agToolResult(ev.text, ev.ok === false));
  }
  head.onclick = () => wrap.classList.toggle("open");
  wrap.appendChild(head);
  wrap.appendChild(bd);
  if (ev.ok === false) wrap.classList.add("open");
  return wrap;
}

/** 参数摘要：只露 3 个关键值，避免一长串 JSON 占屏 */
function agArgSummary(args) {
  const keys = Object.keys(args || {});
  if (!keys.length) return en("无");
  const one = (v) => {
    if (typeof v === "string") {
      const s = v.replace(/\s+/g, " ").trim();
      return s.length > 48 ? s.slice(0, 48) + "…" : s;
    }
    if (Array.isArray(v)) return `[${v.length}]`;
    if (v && typeof v === "object") return "{…}";
    return String(v);
  };
  let s = keys.slice(0, 3).map((k) => `${k}=${one(args[k])}`).join(" · ");
  if (keys.length > 3) s += ` · +${keys.length - 3}`;
  return s;
}

function agExitBadge(text) {
  const m = String(text).match(/(?:^|\n)(?:exit=|退出码\s*)(-?\d+)/);
  if (!m) return null;
  const el = document.createElement("span");
  el.className = "agcode " + (Number(m[1]) === 0 ? "ok" : "bad");
  el.textContent = `${en("退出码")} ${m[1]} · ${Number(m[1]) === 0 ? en("成功") : en("失败")}`;
  return el;
}

function agParseBinary(text) {
  const m = String(text).match(/^\(二进制\s+(\d+)\s*字节\)\s*\nHEX:\s*([0-9A-Fa-f\s]+)/);
  if (!m) return null;
  const hex = m[2].replace(/\s+/g, "");
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return { count: Number(m[1]), bytes };
}

function agHexView(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const hx = row.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ").padEnd(47, " ");
    const asc = row.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hx}  |${asc}|`);
  }
  return lines.join("\n");
}

function agTextView(bytes) {
  let s = "";
  try {
    s = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch (_) {
    s = bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
  }
  return s.replace(/[^\x09\x0a\x0d\x20-\x7e\u0080-\uffff]/g, ".");
}

/** 把路径从工具输出里拣出来，提供“打开文件/目录”按钮 */
function agToolPaths(text) {
  const s = String(text || "");
  const re = /([A-Za-z]:\\[^\r\n"'<>|]+|\/(?:[^\s"'<>|]+\/)*[^\s"'<>|]+)/g;
  const out = [];
  for (const m of s.matchAll(re)) {
    let p = m[1].replace(/[，。；,;:：)）\]】]+$/, "").trim();
    if (p.length < 4 || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 3) break;
  }
  return out;
}

function agToolbar(raw) {
  const bar = document.createElement("div");
  bar.className = "agtoolbar";
  const copy = document.createElement("button");
  copy.className = "btn tiny";
  copy.textContent = en("复制");
  copy.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(raw); toast(en("已复制")); }
    catch (_) { toast(en("复制失败")); }
  };
  bar.appendChild(copy);
  for (const p of agToolPaths(raw)) {
    const b = document.createElement("button");
    b.className = "btn tiny";
    b.textContent = /tool-output/i.test(p) ? en("打开全文") : en("打开路径");
    b.title = p;
    b.onclick = (e) => {
      e.stopPropagation();
      invoke("browser_open_external", { path: p }).catch((err) => toast(String(err)));
    };
    bar.appendChild(b);
  }
  return bar;
}

function agParseTable(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|")) continue;
    if (!/^\s*\|?[\s:|-]+\|/.test(lines[i + 1]) || !lines[i + 1].includes("|")) continue;
    const head = lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].includes("|"); j++) {
      rows.push(lines[j].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim()));
    }
    if (head.length && rows.length) return { head, rows };
  }
  return null;
}

function agDiffNode(raw) {
  const pre = document.createElement("pre");
  pre.className = "agdiff";
  for (const line of raw.split(/\r?\n/)) {
    const span = document.createElement("span");
    span.textContent = line + "\n";
    if (/^diff --git|^index |^--- |^\+\+\+ /.test(line)) span.className = "meta";
    else if (/^@@/.test(line)) span.className = "hunk";
    else if (line.startsWith("+")) span.className = "add";
    else if (line.startsWith("-")) span.className = "del";
    pre.appendChild(span);
  }
  return pre;
}

function agToolResult(text, forceOpen) {
  const raw = String(text == null ? "" : text);
  const box = document.createElement("div");
  box.className = "agresult";
  const code = agExitBadge(raw);
  if (code) box.appendChild(code);
  const bin = agParseBinary(raw);
  if (bin) {
    const bar = document.createElement("div");
    bar.className = "agtoolbar";
    const hexBtn = document.createElement("button");
    const textBtn = document.createElement("button");
    hexBtn.className = "btn tiny on";
    textBtn.className = "btn tiny";
    hexBtn.textContent = "HEX";
    textBtn.textContent = en("文本");
    const pre = document.createElement("pre");
    pre.className = "agbinary";
    const paint = (mode) => {
      hexBtn.classList.toggle("on", mode === "hex");
      textBtn.classList.toggle("on", mode === "text");
      pre.textContent = mode === "hex"
        ? `${en("二进制")} ${bin.count} ${en("字节")} / HEX\n${agHexView(bin.bytes)}`
        : `${en("二进制")} ${bin.count} ${en("字节")} / ${en("文本预览（仅可打印字符）")}\n${agTextView(bin.bytes)}`;
    };
    hexBtn.onclick = (e) => { e.stopPropagation(); paint("hex"); };
    textBtn.onclick = (e) => { e.stopPropagation(); paint("text"); };
    bar.append(hexBtn, textBtn);
    for (const b of [...agToolbar(raw).children]) bar.appendChild(b);
    box.append(bar, pre);
    paint("hex");
    return box;
  }
  box.appendChild(agToolbar(raw));
  const long = raw.length > 700;
  const details = document.createElement("details");
  details.className = "agout";
  details.open = forceOpen || !long;
  const sum = document.createElement("summary");
  sum.textContent = `${en("输出")} · ${raw.length} ${en("字符")}${long ? " · " + en("点击展开") : ""}`;
  details.appendChild(sum);

  const isDiff = /^diff --git/m.test(raw) || (/^--- /m.test(raw) && /^\+\+\+ /m.test(raw) && /^@@/m.test(raw));
  const table = !isDiff && agParseTable(raw);
  if (isDiff) {
    details.appendChild(agDiffNode(raw));
  } else if (table) {
    const t = document.createElement("table");
    t.className = "agtable";
    const tr = document.createElement("tr");
    for (const h of table.head) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
    t.appendChild(tr);
    for (const row of table.rows) {
      const rr = document.createElement("tr");
      for (const cell of row) { const td = document.createElement("td"); td.textContent = cell; rr.appendChild(td); }
      t.appendChild(rr);
    }
    details.appendChild(t);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = raw;
    details.appendChild(pre);
  }
  box.appendChild(details);
  return box;
}

/**
 * 连续的若干次工具调用合成一张"工具调用 ×N"卡（点开才看细节）—— 跟 codex 一样。
 * 只要中间隔了一条有正文的消息，就会被拆成两组（因为 agRender 只在连续区间里成组）。
 */
function agToolGroupNode(group) {
  const items = [];
  const byId = {};
  for (const ev of group) {
    if (ev.type === "tool_call") {
      const it = { call: ev, result: null };
      byId[ev.id] = it;
      items.push(it);
    } else {
      const it = byId[ev.id];
      if (it) it.result = ev;
      else items.push({ call: { id: ev.id, name: ev.name, args: ev.args || {} }, result: ev });
    }
  }
  const cards = items.map((it) => agToolNode({
    name: it.call.name,
    args: it.call.args || {},
    ok: it.result ? it.result.ok : undefined,
    text: it.result ? it.result.text : undefined,
  }));
  if (items.length === 1) return cards[0];
  const wrap = document.createElement("div");
  wrap.className = "agtoolgroup";
  const head = document.createElement("div");
  head.className = "ghead";
  const nm = document.createElement("span");
  nm.className = "gname";
  nm.textContent = `${en("工具调用")} ×${items.length}`;
  const list = document.createElement("span");
  list.className = "glist";
  list.textContent = items.map((it) => it.call.name).join(" · ");
  const st = document.createElement("span");
  st.className = "gst";
  const bad = items.filter((it) => it.result && it.result.ok === false).length;
  const pending = items.filter((it) => !it.result).length;
  st.textContent = pending ? `${en("执行中")} ${pending}` : (bad ? `${bad} ${en("个失败")}` : en("全部完成"));
  if (bad) st.classList.add("bad");
  head.appendChild(nm); head.appendChild(list); head.appendChild(st);
  const body = document.createElement("div");
  body.className = "gbody";
  for (const c of cards) body.appendChild(c);
  head.onclick = () => wrap.classList.toggle("open");
  wrap.appendChild(head);
  wrap.appendChild(body);
  if (bad) wrap.classList.add("open");
  return wrap;
}

function agWelcomeNode() {
  const welcome = document.createElement("div");
  welcome.className = "agwelcome";
  const title = document.createElement("div");
  title.className = "agwelcome-title";
  title.textContent = "Work with KDock";
  const sub = document.createElement("div");
  sub.className = "agwelcome-sub";
  sub.textContent = en("把目标说出来，KDock 会和你一起推进。");
  welcome.append(title, sub);
  if (agCfg && !(agCfg.providers || []).length) {
    const hint = document.createElement("div");
    hint.className = "agwelcome-hint";
    hint.textContent = en("先在设置里选择一个模型。");
    welcome.appendChild(hint);
  }
  return welcome;
}

function agWelcomeHide() {
  const box = agEl("ag-chat") || agChatEl;
  if (!box) return;
  box.querySelectorAll(".agwelcome").forEach((n) => n.remove());
}

/** 欢迎页只在“这个会话还没有任何消息”时出现。
 *  以前还看输入框有没有内容：打字打到一半欢迎页就没了，删光又冒回来 —— 那是抖的。
 *  现在只认消息本身：第一条消息发出去（agEvents 有内容）才收起来。 */
function agSyncWelcome() {
  const box = agEl("ag-chat") || agChatEl;
  if (!box) return;
  if (!agEvents.length) {
    if (!box.querySelector(".agwelcome")) box.appendChild(agWelcomeNode());
  } else {
    agWelcomeHide();
  }
}

function agRender() {
  const box = agEl("ag-chat");
  if (!box) return;
  const keepTop = box.scrollTop;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = "";
  agChatEl = box;
  agToolCards = {};
  agToolArgs = {};
  let i = 0;
  while (i < agEvents.length) {
    if (agEvents[i].type === "tool_call" || agEvents[i].type === "tool_result") {
      const group = [];
      while (i < agEvents.length
             && (agEvents[i].type === "tool_call" || agEvents[i].type === "tool_result")) {
        group.push(agEvents[i]);
        i += 1;
      }
      box.appendChild(agToolGroupNode(group));
      continue;
    }
    agAppendEvent(agEvents[i], false);
    i += 1;
  }
  agSyncWelcome();
  if (agCfg && !(agCfg.providers || []).length && agEvents.length) {
    const hint = document.createElement("div");
    hint.className = "agmsg note";
    const h = document.createElement("div");
    h.className = "head";
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = "提示";
    h.appendChild(w);
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = en("先在设置里选择一个模型。");
    hint.appendChild(h);
    hint.appendChild(b);
    box.appendChild(hint);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = keepTop;
  agUpdateHeader();
  agBuildRail();
}

let streamed = false;
let agChatEl = null;

function agAppendEvent(ev, scroll = true) {
  const box = agEl("ag-chat") || agChatEl;
  if (!box) return;
  agWelcomeHide();
  const t = ev.type || ev;
  if (t === "user") {
    const node = agMsgNode("user", ev.text);
    if (ev.queued) node.classList.add("queued");     // 跑着的时候补充的那条：标"排队中"
    box.appendChild(node);
  }
  else if (t === "assistant") {
    if (String(ev.reasoning || "").trim()) box.appendChild(agThinkNodeFrom(ev.reasoning));
    if (String(ev.text || "").trim()) box.appendChild(agMsgNode("assistant", ev.text, ev));
  } else if (t === "tool_call") {
    agToolArgs[ev.id] = ev.args || {};
    const node = agToolNode({ name: ev.name, args: ev.args });
    agToolCards[ev.id] = node;
    box.appendChild(node);
  } else if (t === "tool_result") {
    const old = agToolCards[ev.id];
    const args = ev.args || agToolArgs[ev.id] || {};
    agToolArgs[ev.id] = args;
    const node = agToolNode({ name: ev.name, args, ok: ev.ok, text: ev.text });
    if (old && old.parentNode) old.parentNode.replaceChild(node, old);
    else box.appendChild(node);
    agToolCards[ev.id] = node;
  } else if (t === "note") box.appendChild(agMsgNode("note", ev.text));
  else if (t === "summary") box.appendChild(agMsgNode("note", "（已压缩） " + ev.text));
  if (scroll) agScrollTail(false);
}

// ---------- 工作区 / 对话（像 Codex：左栏是 工作区 -> 对话） ----------
let agWorkspaces = [];
/** 谁在什么时候换了"当前对话"——出问题时一看便知（window.__agMeta） */
function agSetMeta(m, why) {
  window.__agMeta = (window.__agMeta || []).concat([why + ":" + (m && m.id ? String(m.id).slice(-6) : "null")]);
  if (window.__agMeta.length > 50) window.__agMeta.shift();
  agMeta = m;
  agRunning = !!(m && agRunSessions.has(m.id));
  if (agEl("ag-stop")) agEl("ag-stop").hidden = !agRunning;
  agSetSendDisabled(agRunning);
}
let agOpenWs = {};          // 哪些工作区是展开的
let agSessShown = {};       // 每个工作区先渲染多少个会话（会话多了别一次铺满 DOM）

async function agLoadTree() {
  agWorkspaces = await invoke("agent_workspaces").catch(() => []);
  agSessions = await invoke("agent_sessions").catch(() => []);
  if (!agWorkspaces.length) agWorkspaces = [{ id: "default", name: "默认工作区", path: "" }];
  if (!Object.keys(agOpenWs).length) agOpenWs[agWorkspaces[0].id] = true;
  agRenderTree();
  agUpdateHeader();
}

function agRenderTree() {
  const box = agEl("ag-nav-tree");
  if (!box) return;
  box.innerHTML = "";
  for (const w of agWorkspaces) {
    const kids = agSessions.filter((x) => (x.ws || "default") === w.id);
    const open = !!agOpenWs[w.id] || (agMeta && (agMeta.ws || "default") === w.id);
    const row = document.createElement("div");
    // current = 当前会话就在这个工作区里：给它一层和 Agent 行同色系的高亮，
    // 免得看着跟 Agent 那一行"不是一套 UI"
    const isCurrent = !!agMeta && (agMeta.ws || "default") === w.id;
    row.className = "wsrow" + (open ? " open" : "") + (isCurrent ? " current" : "");
    const caret = document.createElement("span");
    caret.className = "caret"; caret.textContent = open ? "▾" : "▸";
    const t = document.createElement("span");
    t.className = "t"; t.textContent = (w.name === "默认工作区" ? en("默认工作区") : (w.name || en("工作区")));
    const p = document.createElement("span");
    p.className = "p"; p.textContent = String(w.path || "").replace(/.*[\\/]/, "");
    p.title = w.path || "";
    const plus = document.createElement("button");
    plus.className = "plus"; plus.textContent = "＋"; plus.title = en("在这个工作区里新开一个对话");
    plus.onclick = async (e) => {
      e.stopPropagation();
      agFocus();                 // 同上：新会话建好就直接切过去看
      await agNewSession(w.id);
    };
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕"; del.title = "删除工作区（对话不会删）";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (w.id === "default") return toast("默认工作区不能删");
      if (!(await agConfirm(`从列表里移除工作区「${w.name}」？（里面的对话还在）`, "移除工作区"))) return;
      await invoke("agent_workspace_delete", { id: w.id }).catch((err) => toast(String(err)));
      await agLoadTree();
    };
    t.onclick = () => { agOpenWs[w.id] = !open; agRenderTree(); };
    caret.onclick = () => { agOpenWs[w.id] = !open; agRenderTree(); };
    caret.style.cursor = "pointer";
    row.appendChild(caret); row.appendChild(t); row.appendChild(p);
    if (w.id !== "default") row.appendChild(del);
    row.appendChild(plus);
    box.appendChild(row);
    if (!open) continue;
    // 会话多的时候别一次性铺满 DOM（几百个按钮会明显拖慢切页/打字）——
    // 先渲染最近 40 个，剩下的点一下"还有 N 个"再放出来（参考 codex/opencode 的做法）
    const shownN = agSessShown[w.id] || 40;
    for (const x of kids.slice(0, shownN)) {
      const b = document.createElement("button");
      b.className = "sess" + (agMeta && agMeta.id === x.id ? " active" : "");
      const tt = document.createElement("span");
      tt.className = "t"; tt.textContent = en(x.title || "（无标题）");   // 后端给新会话的默认名就是"新会话"（存的是数据），显示时过一遍
      tt.title = (x.title || "") + " · " + new Date(x.updated).toLocaleString();
      b.appendChild(tt);
      // 点会话：先确保中间已经切到 Agent 页再加载
      // （原来只加载、不切页 —— 在「传输」页点会话会看着没反应，必须先点一下 Agent）
      b.onclick = (e) => { e.stopPropagation(); agFocus(); agOpenSession(x.id); };
      b.oncontextmenu = async (e) => {
        e.preventDefault();
        if (!(await agConfirm(`删掉对话「${x.title || "无标题"}」？`, "删除对话", true))) return;
        await invoke("agent_session_delete", { id: x.id }).catch(() => {});
        if (agMeta && agMeta.id === x.id) { agSetMeta(null, "deleted"); agEvents = []; agRender(); }
        agLoadTree();
      };
      b.title = en("右键可以删除");
      box.appendChild(b);
    }
    if (!kids.length) {
      const e0 = document.createElement("div");
      e0.className = "sess";
      const tt = document.createElement("span");
      tt.className = "t"; tt.textContent = en("（还没对话，点 ＋）");
      e0.appendChild(tt);
      box.appendChild(e0);
    }
    if (kids.length > shownN) {
      const more = document.createElement("button");
      more.className = "sess more";
      more.textContent = en("… 还有 ") + (kids.length - shownN) + en(" 个对话（点开）");
      more.onclick = (e) => {
        e.stopPropagation();
        agSessShown[w.id] = shownN + 100;
        agRenderTree();
      };
      box.appendChild(more);
    }
  }
}

async function agNewWorkspace() {
  const p = await dlgOpen({ title: "选一个目录作为工作区（agent 的文件读写都限制在里面）", multiple: false, directory: true });
  const path0 = typeof p === "string" ? p : (p && p.path);
  if (!path0) return;
  try {
    const w = await invoke("agent_workspace_new", { path: path0, name: null });
    agOpenWs[w.id] = true;
    await agLoadTree();
    toast("工作区已建好：" + w.name);
  } catch (e) { toast(String(e)); }
}

/** 对话头：名字 + 本会话完成了多少轮正常对话 */
function agUpdateHeader() {
  const t = agEl("ag-title");
  if (t) t.textContent = agMeta ? en(agMeta.title || "（无标题）") : "Work with KDock";
  const n = agEvents.filter((e) => e.type === "assistant" && String(e.text || "").trim()).length;
  const g = agEl("ag-turns");
  if (g) g.textContent = agMeta ? n + en(" 轮") : "";
  // /goal 设的长期目标：钉在头上，随时能看见（也能看出它还生效着）
  const goalEl = agEl("ag-goal");
  if (goalEl) {
    const goal = agMeta && agMeta.goal;
    goalEl.hidden = !goal;
    goalEl.textContent = goal ? `目标：${goal}` : "";
    goalEl.title = goal || "";
  }
  if (agEl("ag-m-wsname")) agEl("ag-m-wsname").textContent = agMeta ? (agMeta.workspace || en("（默认）")) : en("（无）");
  if (agEl("ag-stop")) agEl("ag-stop").hidden = !agRunning;
}

/* ── Agent 信息面板（参考 opencode 的状态栏）：上下文占用 / 工作区 git / token / 缓存命中 / 花费 ── */
const AG_PRICE_FLASH = {
  currency: "USD",
  peak_enabled: false,
  peak_hit: 0.006, peak_miss: 0.30, peak_out: 1.20,
  offpeak_hit: 0.003, offpeak_miss: 0.15, offpeak_out: 0.60,
};
const AG_PRICE_V4_PRO = {
  currency: "USD",
  peak_enabled: false,
  peak_hit: 0.044, peak_miss: 1.32, peak_out: 3.96,
  offpeak_hit: 0.022, offpeak_miss: 0.66, offpeak_out: 1.98,
};
const AG_PRICE_FIXED = {
  currency: "CNY",
  peak_enabled: false,
  peak_hit: 0.5, peak_miss: 2, peak_out: 8,
  offpeak_hit: 0.5, offpeak_miss: 2, offpeak_out: 8,
};
const AG_PEAK_WINDOWS = "09:00–12:00 / 14:00–18:00";
const agPriceFallback = (model) => {
  const m = String(model || "").toLowerCase();
  if (/deepseek-v4-pro/.test(m)) return { ...AG_PRICE_V4_PRO };
  if (/deepseek/.test(m)) return { ...AG_PRICE_FLASH };
  return { ...AG_PRICE_FIXED };
};
const agEffectivePricing = (prov) => {
  const saved = prov && prov.pricing;
  if (saved && Object.keys(saved).length) return {
    currency: String(saved.currency || "CNY").toUpperCase(),
    peak_enabled: !!saved.peak_enabled,
    peak_hit: Number(saved.peak_hit) || 0,
    peak_miss: Number(saved.peak_miss) || 0,
    peak_out: Number(saved.peak_out) || 0,
    offpeak_hit: Number(saved.offpeak_hit) || 0,
    offpeak_miss: Number(saved.offpeak_miss) || 0,
    offpeak_out: Number(saved.offpeak_out) || 0,
  };
  return agPriceFallback(prov && prov.model);
};
const agMoney = (y, currency) => {
  const sym = String(currency || "CNY").toUpperCase() === "USD" ? "$" : "¥";
  const n = Number(y) || 0;
  if (n === 0) return sym + "0";
  if (n < 0.01) return sym + n.toFixed(4);
  if (n < 1) return sym + n.toFixed(3);
  return sym + n.toFixed(2);
};
const agCostText = (totals, approx) => {
  const rows = Object.entries(totals || {}).filter(([, v]) => Number(v) > 0);
  if (!rows.length) return "";
  const text = rows.map(([cur, v]) => agMoney(v, cur)).join(" / ");
  return approx ? "≈" + text : text;
};
const agK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K" : String(n || 0));

let agGit = null;      // 工作区 git 快照（workspace_git 的结果）
let agGitFor = "";     // 这份快照对应的目录
let agBalance = null;      // 余额（agent_provider_balance 的结果，格式化过的）
let agBalanceAt = 0;       // 上次查询时间（60 秒内不重复查）
let agPricingStatus = null; // 峰谷状态 + 节假日表（后端统一按北京时间算）
let agPricingAt = 0;
async function agRefreshGit() {
  const ws = (agMeta && agMeta.workspace) || (agCfg && agCfg.workspace) || "";
  if (!ws) return;
  try {
    agGit = await invoke("workspace_git", { path: ws });
    agGitFor = ws;
  } catch (e) {
    agGit = { repo: false, error: String(e) };
    agGitFor = ws;
  }
  agRenderInfo();
}

async function agRefreshPricing(force) {
  if (!force && agPricingStatus && Date.now() - agPricingAt < 20000) {
    agRenderInfo();
    return;
  }
  try {
    const year = new Date().getFullYear();
    agPricingStatus = await invoke("agent_pricing_calendar", { years: [year] });
    agPricingAt = Date.now();
  } catch (_) {
    agPricingStatus = agPricingStatus || null;
  }
  agRenderInfo();
}

/** 老会话没有逐轮 cost 字段时，用最近留档和当前价格补一个可视估算。 */
function agRecentCost(prov) {
  const totals = {};
  const providers = (agCfg && agCfg.providers) || [];
  for (const row of (agMeta && agMeta.usage_recent) || []) {
    let cost = Number(row.cost);
    let cur = row.currency;
    if (!(cost >= 0) || !cur) {
      const rp = providers.find((x) => x.id === row.provider) || prov;
      if (!rp) continue;
      const price = agEffectivePricing(rp);
      const peak = price.peak_enabled &&
        (typeof row.peak === "boolean" ? row.peak : !!(agPricingStatus && agPricingStatus.peak));
      const hit = Number(row.hit) || 0, miss = Number(row.miss) || 0, out = Number(row.out) || 0;
      cost = peak
        ? (hit / 1e6) * price.peak_hit + (miss / 1e6) * price.peak_miss + (out / 1e6) * price.peak_out
        : (hit / 1e6) * price.offpeak_hit + (miss / 1e6) * price.offpeak_miss + (out / 1e6) * price.offpeak_out;
      cur = price.currency;
    }
    if (!(cost > 0)) continue;
    const key = String(cur || "CNY").toUpperCase();
    totals[key] = (totals[key] || 0) + cost;
  }
  return totals;
}

/** 精确账本覆盖不到的旧 token 只补一次当前价估算，避免升级后花费突然变小。 */
function agSessionCost(prov) {
  const stored = { ...((agMeta && agMeta.cost_total) || {}) };
  const coveredPrompt = Number(agMeta && agMeta.cost_prompt_tokens) || 0;
  const coveredCompletion = Number(agMeta && agMeta.cost_completion_tokens) || 0;
  const totalPrompt = Number(agMeta && agMeta.total_prompt) || 0;
  const totalCompletion = Number(agMeta && agMeta.total_completion) || 0;
  const missingPrompt = Math.max(0, totalPrompt - coveredPrompt);
  const missingCompletion = Math.max(0, totalCompletion - coveredCompletion);
  if (!Object.keys(stored).length) {
    return { totals: agRecentCost(prov), approx: missingPrompt > 0 || missingCompletion > 0 };
  }
  let approx = false;
  if ((missingPrompt > 0 || missingCompletion > 0) && prov) {
    const price = agEffectivePricing(prov);
    const peak = price.peak_enabled && !!(agPricingStatus && agPricingStatus.peak);
    const hit = Number(agMeta.total_cache_hit) || 0;
    const miss = Number(agMeta.total_cache_miss) || 0;
    const hitRatio = hit + miss > 0 ? hit / (hit + miss) : 0;
    const missingHit = missingPrompt * hitRatio;
    const missingMiss = missingPrompt - missingHit;
    const cost = peak
      ? (missingHit / 1e6) * price.peak_hit + (missingMiss / 1e6) * price.peak_miss +
        (missingCompletion / 1e6) * price.peak_out
      : (missingHit / 1e6) * price.offpeak_hit + (missingMiss / 1e6) * price.offpeak_miss +
        (missingCompletion / 1e6) * price.offpeak_out;
    if (cost > 0) {
      const cur = String(price.currency || "CNY").toUpperCase();
      stored[cur] = (stored[cur] || 0) + cost;
      approx = true;
    }
  }
  return { totals: stored, approx };
}

/** 把信息面板重画一遍（同步，用缓存的 git 快照） */
function agRenderInfo() {
  const box = agEl("ag-info");
  if (!box) return;
  const providers = (agCfg && agCfg.providers) || [];
  const prov = providers.find((p) => p.id === ((agMeta && agMeta.provider_id) || "")) || providers[0] || null;
  const ctxWin = (prov && prov.context_window) || 0;
  const budget = Math.max(0, ctxWin - ((prov && prov.reserve_output) || 0));
  const used = (agMeta && agMeta.last_tokens) || 0;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const inTok = (agMeta && agMeta.total_prompt) || 0;
  const outTok = (agMeta && agMeta.total_completion) || 0;
  const hit = (agMeta && agMeta.total_cache_hit) || 0;
  const miss = (agMeta && agMeta.total_cache_miss) || 0;
  const hitRate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 1000) / 10 : 0;
  const pricing = agEffectivePricing(prov);
  const sessionCost = agSessionCost(prov);
  const costText = agCostText(sessionCost.totals, sessionCost.approx);
  const fp = (prov && agMeta && agMeta.model_fingerprint &&
    (!agMeta.fingerprint_provider || agMeta.fingerprint_provider === prov.id))
    ? agMeta.model_fingerprint : "";
  const fpTitle = fp
    ? [
        agMeta.fingerprint_family
          ? `${agMeta.fingerprint_family}${agMeta.fingerprint_family_source ? " (" + agMeta.fingerprint_family_source + ")" : ""}`
          : "",
        agMeta.fingerprint_model,
        agMeta.fingerprint_system,
      ].filter(Boolean).join(" · ")
    : "";
  const reasonEffort = (agMeta && agMeta.reasoning_effort) || (prov && prov.reasoning_effort) || "";
  const reasonText = reasonEffort
    ? en(agReasoningName(reasonEffort) || reasonEffort)
    : en("模型默认");
  const showRateColor = pricing.peak_enabled && !!agPricingStatus && !!costText;
  const costHtml = !costText ? "—" : showRateColor
    ? `<span class="costpill ${agPricingStatus.peak ? "peak" : "offpeak"}" title="${en("北京时间")} ${AG_PEAK_WINDOWS}；${en("周末与法定节假日为谷价")}">${costText}</span>`
    : costText;
  const ws = (agMeta && agMeta.workspace) || (agCfg && agCfg.workspace) || "";
  const wsShort = ws ? ws.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : en("（默认）");

  const row = (k, v, cls) => `<div class="row"><span class="k">${en(k)}</span><span class="v ${cls || ""}">${v}</span></div>`;
  const git = agGit;
  let gitLine;
  if (!git) gitLine = `<span class="sub">${en("读取中…")}</span>`;
  else if (!git.repo) gitLine = `<span class="sub">${en("不是 git 仓库")}</span>`;
  else {
    const cls = git.dirty > 0 ? "warn" : "ok";
    gitLine =
      `<span class="v ${cls}" title="${agEscape(git.path || "")}">${agEscape(git.branch || "?")}` +
      (git.dirty ? ` · ${git.dirty} 处改动` : en(" · 干净")) +
      (git.head ? ` · ${agEscape(git.head)}` : "") +
      `</span>`;
  }
  box.innerHTML =
    row("上下文", `${agK(used)} / ${agK(budget)}（${pct}%）`, pct >= 90 ? "bad" : pct >= 70 ? "warn" : "") +
    `<div class="bar${pct >= 70 ? " hot" : ""}"><i style="width:${pct}%"></i></div>` +
    row("工作区", `<span title="${agEscape(ws)}">${agEscape(wsShort)}</span>`) +
    `<div class="row"><span class="k">Git</span>${gitLine}</div>` +
    `<div class="sep"></div>` +
    row("Token", `${en("输入")} ${agK(inTok)} / ${en("输出")} ${agK(outTok)}`) +
    row("思考强度", reasonText) +
    row("缓存命中", hit + miss > 0 ? `${hitRate}%（${agK(hit)} / ${agK(hit + miss)}）` : "—", hitRate >= 50 ? "ok" : "") +
    row("模型指纹", fp
      ? `<span title="${agEscape(fpTitle)}">${en("当前为")} ${agEscape(fp)}</span>`
      : en("未采样")) +
    (() => {
      // 速度按"实际跑的那条 profile"取：优先当前生效的（下一轮就是它跑），
      // 没有它的数据再退回这个会话记录的那条
      const activeId = agCfg && agCfg.activeId;
      const sp = agSpeed[activeId] || agSpeed[(prov && prov.id) || ""];
      if (!sp || !(sp.last > 0)) return row("出字速度", "—");
      return row("出字速度", `${fmtTps(sp.last)} ${en("最近")} · ${fmtTps(sp.avg)} ${en("平均")}`, "ok");
    })() +
    row("花费", costHtml, "") +
    (agBalance ? row("余额", agEscape(agBalance), "") : "");
  // 上面那两个按钮是每次重画都新建的，绑一次就行
}

/* ── 上下文成分分析（参考 opencode 的 context 面板）：把占 token 的东西按类目拆开 ── */
let agBreak = null;
async function agRefreshBreakdown() {
  if (!agMeta) { agBreak = null; agRenderBreakdown(); return; }
  try {
    agBreak = await invoke("agent_context_breakdown", { sessionId: agMeta.id });
  } catch (_) {
    return;
  }
  agRenderBreakdown();
}
function agRenderBreakdown() {
  const box = agEl("ag-ctx");
  if (!box) return;
  const b = agBreak;
  if (!b) { box.innerHTML = `<div class="sub">${en("读取中…")}</div>`; return; }
  const items = [
    ["system", "系统提示", "#8b98a8"],
    ["tools", "工具定义", "#4f8cff"],
    ["summary", "摘要", "#b388ff"],
    ["user", "用户消息", "#3ddc97"],
    ["assistant", "助手回复", "#ffc857"],
    ["tool", "内置工具结果", "#ff6b6b"],
    ["mcpTool", "MCP 工具结果", "#d977ff"],
  ];
  const total = Math.max(1, (b.used || 0) + (b.free || 0));
  const bar = items
    .map(([k, n, c]) => `<i style="width:${((b[k] || 0) / total) * 100}%;background:${c}" title="${en(n)}"></i>`)
    .join("");
  const legend = items
    .map(([k, n, c]) => {
      const v = b[k] || 0;
      const pct = (v / total) * 100;
      return `<div class="r"><span class="dot" style="background:${c}"></span><span class="n">${en(n)}</span>` +
        `<span class="v">${agK(v)} · ${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%</span></div>`;
    })
    .join("");
  const freePct = ((b.free || 0) / total) * 100;
  box.innerHTML =
    `<div class="agctx-bar">${bar}<i style="width:${freePct}%;background:var(--surface-3)" title="${en("剩余可用")}"></i></div>` +
    `<div class="agctx-legend">${legend}` +
    `<div class="r"><span class="dot" style="background:var(--surface-3)"></span><span class="n">${en("剩余可用")}</span>` +
    `<span class="v">${agK(b.free || 0)} · ${freePct.toFixed(0)}%</span></div></div>` +
    // 只报"你自己的东西"占多少：指导文件（AGENTS.md）与技能索引都是用户能看见/能改的
    `<div class="sub">${en("其中指导文件")} ${agK(b.systemGuidance || 0)} · ${en("技能索引")} ${agK(b.systemSkills || 0)}</div>` +
    (b.dropped
      ? `<div class="sub">${en("已被摘要压掉")}: ${agK(b.dropped)} tokens · ${b.coveredEvents} ${en("条旧事件；原文仍在会话文件里，可用 history_search 回查")}</div>`
      : "") +
    `<div class="sub">${en("本机估算")} ${agK(b.used)} · ${en("模型上报")} ${agK(b.lastPromptTokens)} · ${en("窗口预算")} ${agK(b.budget)}</div>`;
}

/** 余额（DeepSeek 有 /user/balance；其它厂商返回"无接口"）。60 秒内不重复查。 */
async function agRefreshBalance(force) {
  const id = (agCfg && agCfg.activeId) || (agMeta && agMeta.provider_id) || "";
  if (!id) { agBalance = null; agRenderInfo(); return; }
  if (!force && agBalance && Date.now() - agBalanceAt < 60000) { agRenderInfo(); return; }
  try {
    const b = await invoke("agent_provider_balance", { id });
    agBalance = !b.supported
      ? "该厂商没有余额接口"
      : ((b.infos || []).map((i) => `${i.currency} ${i.total}`).join(" / ") || "—");
  } catch (e) {
    agBalance = "查询失败";
  }
  agBalanceAt = Date.now();
  agRenderInfo();
}

async function agOpenSession(id) {
  try {
    const data = await invoke("agent_session_load", { id });
    agSetMeta(data.meta, "open:" + String(id).slice(-6));
    agEvents = data.events || [];
    agToolCards = {};
    agToolArgs = {};
    agRender();
    if (agEl("ag-usage")) agEl("ag-usage").textContent = "";
    if (agEl("ag-perm")) agEl("ag-perm").value = agMeta.perm || "ask";
    agOpenWs[agMeta.ws || "default"] = true;
    agUpdateHeader();
    agBuildRail();
    agRenderTree();
    agSyncReasoningControl();
    agRenderInfo();
    agRefreshGit();        // 每个会话的工作区可能不一样
    agRefreshBreakdown();
    agRefreshBalance();
    agRefreshPricing();
  } catch (e) {
    toast(String(e));
  }
}

async function agNewSession(wsId) {
  try {
    const ws = wsId || (agMeta && agMeta.ws) || (agWorkspaces[0] && agWorkspaces[0].id) || "default";
    agSetMeta(await invoke("agent_session_new", {
      title: null, providerId: agCfg ? agCfg.activeId : null, wsId: ws,
    }), "new");
    agEvents = [];
    agToolCards = {};
    agRender();
    agOpenWs[ws] = true;
    await agLoadTree();
    await agOpenSession(agMeta.id);
    agSyncReasoningControl();
    agEl("ag-input").focus();
    toast("新对话已建好");
  } catch (e) {
    toast(String(e));
  }
}

// ---------- 消息导航竖条 ----------
/**
 * 重建右侧刻度：**等间距一条挨一条**列出（不按内容真实位置——那样消息多了会散得很开），
 * 整列在右侧上下居中；悬停放大、点击跳过去。
 */
function agBuildRail() {
  const rail = agEl("ag-rail");
  const box = agEl("ag-chat");
  if (!rail || !box) return;
  rail.innerHTML = "";
  const users = [...box.children].filter((n) => n.classList.contains("agmsg") && n.classList.contains("user"));
  const userEvs = agEvents.filter((e) => e.type === "user");
  // 消息多了就把间距压小，保证一条都不被裁掉（最多压到 1px）
  const TICK_H = 20;
  const avail = Math.max(120, box.clientHeight * 0.84) - 8;
  const gap = users.length > 1
    ? Math.max(1, Math.min(5, Math.floor((avail - users.length * TICK_H) / (users.length - 1))))
    : 5;
  rail.style.gap = gap + "px";
  users.forEach((dom, k) => {
    const tick = document.createElement("div");
    tick.className = "tick";
    const preview = String((userEvs[k] && userEvs[k].text) || "").replace(/\s+/g, " ").slice(0, 30);
    tick.title = preview;
    tick.onmouseenter = () => {
      const tip = document.createElement("div");
      tip.className = "tip";
      tip.textContent = preview || "（空消息）";
      tip.style.top = (tick.offsetTop + tick.offsetHeight / 2) + "px";
      rail.appendChild(tip);
    };
    tick.onmouseleave = () => {
      const tip = rail.querySelector(".tip");
      if (tip) tip.remove();
    };
    tick.onclick = () => {
      box.scrollTo({ top: Math.max(0, dom.offsetTop - box.clientHeight / 3), behavior: "smooth" });
      dom.classList.add("hl");
      setTimeout(() => dom.classList.remove("hl"), 1200);
    };
    rail.appendChild(tick);
  });
}

/* ── 斜杠命令（参考 codex）：/goal 等直接在本地处理，不走模型 ── */
/** 权限切到"自动"时，后端会把正在等待的审批直接放行 —— 聊天里那几张卡片也要跟着改，
 *  否则它们还挂着"允许/拒绝"两个已经没人接的按钮（用户会以为还得再点一下）。 */
function agMarkPendingApprovalsAuto() {
  document.querySelectorAll("#ag-chat .agapprove .acts").forEach((a) => {
    if (a.querySelector("button")) a.innerHTML = '<span class="hint">已自动放行（权限已切到「自动」）</span>';
  });
}

function agParseDelay(s) {
  const m = String(s || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return Math.round(n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]);
}

function agDur(ms) {
  const n = Number(ms) || 0;
  if (n % 86_400_000 === 0) return `${n / 86_400_000} 天`;
  if (n % 3_600_000 === 0) return `${n / 3_600_000} 小时`;
  if (n % 60_000 === 0) return `${n / 60_000} 分钟`;
  return `${Math.round(n / 1000)} 秒`;
}

async function agScheduleNote(note) {
  const rows = await invoke("agent_schedule_list").catch(() => []);
  if (!rows.length) return note("（没有定时任务）");
  note(`定时任务（${rows.length}）：\n` + rows.map((r) => {
    const when = new Date(r.next_at_ms).toLocaleString();
    const rep = r.daily ? " · 每日" : r.repeat_ms > 0 ? ` · 每 ${agDur(r.repeat_ms)}` : "";
    return `${r.id}  ${when}${rep}  ${String(r.prompt || "").replace(/\s+/g, " ").slice(0, 50)}`;
  }).join("\n"));
}

async function agSlash(text) {
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const note = (t) => {
    agEvents.push({ type: "note", text: t });
    agAppendEvent({ type: "note", text: t });
  };
  if (!agMeta) { await agNewSession(); if (!agMeta) return true; }
  switch ((cmd || "").toLowerCase()) {
    case "goal": {
      if (!arg) {
        // 先看当前打开的这个会话（agMeta 是活的），再退回列表缓存 ——
        // 只查 agSessions 会读到旧快照：刚设完目标再敲 /goal 会误报"还没设定目标"（实测踩过）
        const cached = (agSessions || []).find((m) => m.id === agMeta.id) || {};
        const cur = (agMeta && agMeta.goal) || cached.goal || "";
        note(cur ? `当前目标：${cur}` : "还没设定目标。用法：/goal 你的目标（/goal clear 清除）");
        return true;
      }
      try {
        const r = await invoke("agent_session_set_goal", { id: agMeta.id, goal: arg });
        agMeta.goal = r.goal || "";
        // 列表缓存也一起更新（左侧树 / 之后再查都读它）
        const cached = (agSessions || []).find((m) => m.id === agMeta.id);
        if (cached) cached.goal = agMeta.goal;
        agUpdateHeader();
        note(r.cleared ? "已清除本次会话的目标。" : `目标已设定：${r.goal}\n（每轮都会带上它，直到 /goal clear）`);
      } catch (e) { toast(String(e)); }
      return true;
    }
    case "compact": {
      const r = await invoke("agent_compact", { sessionId: agMeta.id }).catch((e) => ({ note: String(e) }));
      note(r.note || "完成");
      return true;
    }
    case "new":
      await agNewSession();
      return true;
    case "perm": {
      const p = (arg || "").toLowerCase();
      if (!["read", "ask", "auto"].includes(p)) { note("用法：/perm read | ask | auto"); return true; }
      try {
        const r = await invoke("agent_session_set_perm", { id: agMeta.id, perm: p });
        agMeta.perm = r.perm;
        if (agEl("ag-perm")) agEl("ag-perm").value = r.perm;
        if (r.perm === "auto") agMarkPendingApprovalsAuto();
        note(`权限已切到「${r.perm === "read" ? "只读" : r.perm === "auto" ? "自动" : "需要批准"}」` +
             (r.autoApproved ? `（顺手放行了 ${r.autoApproved} 个待批准的调用）` : ""));
      } catch (e) { toast(String(e)); }
      return true;
    }
    case "stop":
      await invoke("agent_stop", { session: agMeta ? agMeta.id : null }).catch(() => {});
      note("已请求停止这一轮。");
      return true;
    case "model": {
      const list = (agCfg && agCfg.providers) || [];
      if (!arg) {
        note("当前模型：" + ((list.find((x) => x.id === ((agCfg && agCfg.activeId) || "")) || {}).name || "（没选）") +
             "\n用法：/model <名字或 id 的一部分>（可用的见输入框右边下拉）");
        return true;
      }
      const q = arg.toLowerCase();
      const hit = list.find((x) => x.id.toLowerCase() === q)
        || list.find((x) => [x.id, x.name, x.model].join(" ").toLowerCase().includes(q));
      if (!hit) { note(`没找到匹配「${arg}」的模型（可用：${list.map((x) => x.name || x.id).join(" / ") || "无"}）`); return true; }
      await agUseProvider(hit.id);
      note(`已切到模型：${hit.name || hit.id}`);
      return true;
    }
    case "rename": {
      if (!arg) { note(`用法：/rename 新标题（当前：${(agMeta && agMeta.title) || ""}）`); return true; }
      try {
        await invoke("agent_session_rename", { id: agMeta.id, title: arg });
        agMeta.title = arg;
        agUpdateHeader();
        agLoadTree();
        note(`标题已改为：${arg}`);
      } catch (e) { toast(String(e)); }
      return true;
    }
    case "skills": {
      const on = (agSkills || []).filter((s) => s.enabled);
      note("已启用的技能：" + (on.length
        ? "\n" + on.map((s) => `- ${s.slug}${s.description ? " — " + s.description.slice(0, 40) : ""}`).join("\n")
        : "（没有）") + "\n\n（在「设置 → 技能」里导入 / 开关；勾「常驻」的会每轮注入）");
      return true;
    }
    case "timer":
    case "at": {
      const want = (cmd || "").toLowerCase();
      const raw = arg.trim();
      if (!raw || raw === "list" || raw === "ls") {
        await agScheduleNote(note);
        return true;
      }
      if (raw.startsWith("cancel ")) {
        const id = raw.slice(7).trim();
        const r = await invoke("agent_schedule_cancel", { id }).catch((e) => ({ error: String(e) }));
        note(r.error || `已取消 ${r.removed || 0} 个任务`);
        return true;
      }
      let kind, delayMs = 0, at = "", repeatMs = 0, daily = false, prompt = "";
      if (want === "timer") {
        const tok = raw.split(/\s+/);
        delayMs = agParseDelay(tok.shift());
        if (!delayMs) {
          note("用法：/timer 10m [repeat 30m] 任务内容\n/timer list | /timer cancel <id>");
          return true;
        }
        if ((tok[0] || "").toLowerCase() === "repeat") {
          tok.shift();
          repeatMs = agParseDelay(tok.shift()) || 0;
          if (!repeatMs) { note("repeat 后面要写间隔，例如 30m"); return true; }
        }
        prompt = tok.join(" ").trim();
        kind = "countdown";
      } else {
        const tok = raw.split(/\s+/);
        const first = tok.shift() || "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
          at = `${first} ${tok.shift() || ""}`.trim();
        } else {
          at = first;
        }
        if ((tok[0] || "").toLowerCase() === "daily" || tok[0] === "每天") {
          daily = true; tok.shift();
        }
        prompt = tok.join(" ").trim();
        kind = "at";
        if (!/^\d{1,2}:\d{2}$/.test(at) && !/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/.test(at)) {
          note("用法：/at 09:30 [daily] 任务内容\n/at 2026-10-18 09:30 任务内容");
          return true;
        }
      }
      if (!prompt) { note("任务内容不能为空"); return true; }
      try {
        const r = await invoke("agent_schedule_add", {
          sessionId: agMeta.id, prompt, kind, delayMs, at, repeatMs, daily,
        });
        const t = r.task || {};
        note(`已创建定时任务 ${t.id}\n下次：${new Date(t.next_at_ms).toLocaleString()}` +
          (kind === "at" && daily ? "（每日）" : repeatMs ? `（每 ${agDur(repeatMs)}）` : ""));
      } catch (e) { note(String(e)); }
      return true;
    }
    case "help": {
      const custom = await invoke("agent_slash_list").catch(() => []);
      const builtin = "/goal <目标>  设定长期目标（/goal clear 清除）\n/compact  压缩上下文\n" +
        "/new  新建会话\n" +
        "/model [名字]  看 / 切换当前模型\n/perm ask|auto|read  切换权限\n/stop  停止这一轮\n" +
        "/timer 10m [repeat 30m] <任务>  倒计时任务（可重复）\n" +
        "/at 09:30 [daily] <任务>  指定时间任务（可每日重复）\n" +
        "/timer list · /at list · /timer cancel <id>  查看 / 取消\n" +
        "/rename <标题>  改会话标题\n/skills  列出已启用技能\n/help  这条帮助";
      const mine = custom.length
        ? "\n\n你自己加的（放在 agent/slash/ 下的 .md）：\n" +
          custom.map((c) => `/${c.name}${c.description ? "  " + c.description : ""}`).join("\n")
        : "\n\n（想在 / 里加自己的指令：设置 → 技能 → 打开指令目录，放一个 .md 进去）";
      note("可用命令：\n" + builtin + mine);
      return true;
    }
    default: {
      // 自定义斜杠指令（agent/slash/*.md）：正文是提示词模板，{{args}} 换成参数
      const custom = await invoke("agent_slash_list").catch(() => []);
      const hit = custom.find((c) => c.name.toLowerCase() === (cmd || "").toLowerCase());
      if (!hit) {
        toast(`未知命令 /${cmd} —— 输入 /help 看有哪些`);
        return true;
      }
      let text = hit.body || "";
      if (text.includes("{{args}}")) text = text.split("{{args}}").join(arg);
      else if (arg) text = text + "\n" + arg;
      toast(`/${hit.name} → 已展开成提示词发出`);
      const box = agEl("ag-input");
      if (box) box.value = text;
      await agSend();
      return true;
    }
  }
}

// ---------- 发送 / 流 ----------
async function agSend() {
  const box = agEl("ag-input");
  const text = (box.value || "").trim();
  if (!text) return toast("先写点东西");
  if (!agMeta) { await agNewSession(); if (!agMeta) return; }
  // 斜杠命令：本地处理，不走模型
  if (text.startsWith("/")) {
    box.value = "";
    await agSlash(text);
    return;
  }
  const backup = box.value;
  box.value = "";
  // **先把用户这条上屏，再发**：后端一进 run_turn 就会推 agent://state / agent://reason，
  // 那个"思考中"块是直接 append 到对话底部的；以前是先 invoke 再上屏，等 Promise 回来时
  // 思考块已经在了 —— 第一轮就会看到「agent 在上面、用户的提问在下面」的错位（实测）。
  // 被拒时不能让用户的话丢掉，所以下面 catch 里回滚这一条。
  agEvents.push({ type: "user", text, ts: Date.now() });
  agAppendEvent({ type: "user", text });
  agUpdateHeader();
  try {
    // 先发再上屏的老顾虑（被拒时话丢了）靠上面的回滚兜住
    const r = await invoke("agent_send", { sessionId: agMeta.id, text, providerId: agCfg ? agCfg.activeId : null });
    if (r && r.queued) {
      // 边跑边补充：这条已经在屏上了，只把它标成"排队中"；后端并进对话后会发
      // agent://user 把它换成正式的（见那个监听）。
      const last = agEvents[agEvents.length - 1];
      if (last && last.type === "user" && last.text === text) last.queued = true;
      agRender();
      return;
    }
  } catch (e) {
    // 回滚刚上屏的那一条
    const i = agEvents.length - 1;
    if (i >= 0 && agEvents[i].type === "user" && agEvents[i].text === text) agEvents.splice(i, 1);
    agRender();
    box.value = backup;
    agRunning = false;
    agState("空闲");
    agSyncRunning();
    toast(String(e));
    return;
  }
  agStreamText = "";
  agStreamNode = null;
  agRunning = true;
  if (agMeta) agRunSessions.add(agMeta.id);
  agState("思考中…", "ok");
  agSetSendDisabled(true);
  agUpdateHeader();
}

function agEnsureStreamNode() {
  if (agStreamNode) return agStreamNode;
  const box = agEl("ag-chat");
  const node = agMsgNode("assistant", "");
  node.classList.add("streaming");
  box.appendChild(node);
  agStreamNode = node;
  return node;
}

function agFlushStream() {
  if (!agStreamNode) return;
  const bubble = agStreamNode.querySelector(".bubble");
  if (bubble) bubble.innerHTML = agMd(agStreamText);
  agScrollTail(false);
}

async function bindAgent() {
  if (!agEl("ag-chat")) return;
  agInitReasoningModes();
  await agLoadConfig();
  await agLoadTree();
  // 打开最近一个对话；一个都没有才新建
  if (!agMeta) {
    if (agSessions.length) await agOpenSession(agSessions[0].id);
    else await agNewSession(agWorkspaces[0] && agWorkspaces[0].id);
  }
  agLoadSkills();
  // 老版「常驻技能」一次性迁移到全局指导（AGENTS.md）：保行为不变，只是换了载体
  invoke("agent_migrate_always_skills").then((r) => {
    if (r && r.migrated) {
      toast(en("已把常驻技能迁移到「全局指导」：") + (r.slugs || []).join(", "));
      agLoadSkills();
    }
  }).catch(() => {});
  agLoadMcps();
  agLoadTools();
  bindAgentPanes();
  bindQuickModels();
  // 事件可能丢/可能晚到，这里做兜底：agent 页可见时每 1.5 秒跟后端对一次"在不在跑"
  setInterval(() => {
    const pane = document.querySelector('[data-work="agent"]');
    if (!pane || pane.hidden) return;
    agSyncRunning();
  }, 1500);

  agEl("ag-send").onclick = agSend;
  if (agEl("ag-perm")) {
    agEl("ag-perm").onchange = async () => {
      if (!agMeta) return toast("先建一个会话");
      const perm = agEl("ag-perm").value;
      try {
        const r = await invoke("agent_session_set_perm", { id: agMeta.id, perm });
        agMeta.perm = perm;
        // 切成"自动"时后端会把正等着的审批直接放行 —— 前端那张卡片也得跟着改成"已放行"，
        // 不然它挂着"允许/拒绝"两个已经没用的按钮（点下去也没人接）
        if (perm === "auto") agMarkPendingApprovalsAuto();
        toast(perm === "read" ? "只读：写设备/写文件/烧录都会被拒" :
              perm === "auto" ? `自动：危险动作直接执行${r && r.autoApproved ? `（顺手放行 ${r.autoApproved} 个待批准）` : ""}` :
              "需要批准：危险动作会先弹给你点");
      } catch (e) { toast(String(e)); }
    };
  }
  if (agEl("ag-attach")) {
    agEl("ag-attach").onclick = async () => {
      if (!agMeta) await agNewSession();
      const p = await dlgOpen({ title: "选要附给 agent 的文件", multiple: false, directory: false });
      const path0 = typeof p === "string" ? p : (p && p.path);
      if (!path0) return;
      try {
        const buf = await readFile(path0);
        const name = path0.replace(/.*[\\/]/, "");
        const saved = await invoke("agent_workspace_write_bytes", {
          sessionId: agMeta.id, path: name, data: Array.from(buf),
        });
        const box = agEl("ag-input");
        box.value = (box.value ? box.value.replace(/\s*$/, "") + "\n\n" : "") +
          `（附件：${name}，已经放进会话工作区，你可以用 workspace_read 读它）`;
        box.focus();
        toast("已附上 " + name + "\n" + saved);
      } catch (e) { toast(String(e)); }
    };
  }
  if (agEl("ag-ws-new")) agEl("ag-ws-new").onclick = agNewWorkspace;
  if (agEl("ag-more")) {
    agEl("ag-more").onclick = (e) => {
      e.stopPropagation();
      const pop = agEl("ag-more-pop");
      pop.hidden = !pop.hidden;
      agUpdateHeader();
    };
  }
  document.addEventListener("click", (e) => {
    const pop = agEl("ag-more-pop");
    if (pop && !pop.hidden && !e.target.closest(".aghistwrap")) pop.hidden = true;
  });
  if (agEl("ag-m-compact")) {
    agEl("ag-m-compact").onclick = async () => {
      agEl("ag-more-pop").hidden = true;
      if (!agMeta) return;
      const r = await invoke("agent_compact", { sessionId: agMeta.id }).catch((e) => ({ note: String(e) }));
      toast(r.note || "完成");
      await agOpenSession(agMeta.id);
    };
  }
  if (agEl("ag-m-rename")) {
    agEl("ag-m-rename").onclick = async () => {
      agEl("ag-more-pop").hidden = true;
      if (!agMeta) return;
      const name = await agAsk("给这个对话起个名字", agMeta.title || "", "重命名对话");
      if (!name) return;
      await invoke("agent_session_rename", { id: agMeta.id, title: name }).catch((e) => toast(String(e)));
      agMeta.title = name;
      agUpdateHeader();
      agLoadTree();
    };
  }
  if (agEl("ag-m-del")) {
    agEl("ag-m-del").onclick = async () => {
      agEl("ag-more-pop").hidden = true;
      if (!agMeta || !(await agConfirm("删掉这个对话？", "删除对话", true))) return;
      await invoke("agent_session_delete", { id: agMeta.id }).catch((e) => toast(String(e)));
      agMeta = null; agEvents = []; agRender();
      await agLoadTree();
    };
  }
  if (agEl("ag-stop")) {
    agEl("ag-stop").onclick = async () => {
      // 后端除了置停止标志，还会把"等你点允许"的审批直接判成拒绝 —— 否则这一轮要等到
      // 5 分钟审批超时才动，用户看到的就是"点了停止没反应"
      await invoke("agent_stop", { session: agMeta ? agMeta.id : null }).catch(() => {});
      agState("正在停止…", "err");
      const acts = document.querySelector("#ag-chat .agapprove .acts");
      if (acts) acts.innerHTML = '<span class="hint">已停止</span>';
    };
  }
  agEl("ag-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // Enter 直接发（跟传输页、其它 agent 工具一致）；Shift+Enter 才是换行。
    // 跑着的时候也发：算"补充"，后端排队并入下一轮。
    if (e.shiftKey) return;
    e.preventDefault();
    agSend();
  });
  // 打 "/" 时把可用命令提示出来
  if (agEl("ag-input") && agEl("ag-cmd-hint")) {
    agEl("ag-input").addEventListener("input", () => {
      agEl("ag-cmd-hint").hidden = !agEl("ag-input").value.startsWith("/");
      agSyncWelcome();
    });
  }

  // 供应商：两个子页（使用 / 新增）
  document.querySelectorAll("#ag-prov-tabs .segtab").forEach((b) => {
    b.onclick = () => agProvTab(b.dataset.provtab);
  });
  agEnsurePresets();
  if (agEl("md-search")) {
    agEl("md-search").addEventListener("input", () => { mdQuery = agEl("md-search").value || ""; mdRender(); });
  }
  if (agEl("md-refresh")) agEl("md-refresh").onclick = () => mdEnsure(true);
  if (agEl("md-add")) agEl("md-add").onclick = () => mdAddModel();
  if (agEl("md-id")) agEl("md-id").addEventListener("input", () => mdRenderPick(false));
  if (agEl("ag-model-pick")) {
    agEl("ag-model-pick").onchange = () => {
      const v = agEl("ag-model-pick").value;
      if (v && agEl("ag-p-model")) agEl("ag-p-model").value = v;
    };
  }
  if (agEl("ag-p-endpoint")) agEl("ag-p-endpoint").addEventListener("input", agClearModelPicker);
  if (agEl("ag-p-kind")) agEl("ag-p-kind").addEventListener("change", agClearModelPicker);
  agEl("ag-provider").onchange = () => {
    const id = agEl("ag-provider").value;
    if (!id) return;
    agUseProvider(id);
  };
  if (agEl("ag-free-toggle")) {
    agEl("ag-free-toggle").onclick = () => {
      const wrap = agEl("ag-prov-free");
      if (!wrap) return;
      wrap.hidden = !wrap.hidden;
      agSyncFreeSection();
      // 展开那一刻才去取实时负载（用户手动 show more 才发请求）
      if (!wrap.hidden) amdLoadPull(false);
    };
  }
  if (agEl("ag-prov-cancel")) {
    agEl("ag-prov-cancel").onclick = async () => {
      agNewProfile = false;
      agProvTab("use");
      await agLoadConfig();
    };
  }
  if (agEl("ag-preset-fill")) {
    agEl("ag-preset-fill").onclick = () => {
      const p = AG_PRESETS.find((x) => x.id === (agEl("ag-preset") ? agEl("ag-preset").value : ""));
      if (!p) return toast("先选一个厂家");
      agNewProfile = true;
      agClearModelPicker();
      if (agEl("ag-prov-new-title")) agEl("ag-prov-new-title").textContent = "新增供应商";
      if (agEl("ag-prov-cancel")) agEl("ag-prov-cancel").hidden = false;
      agEl("ag-p-id").value = p.id;
      agEl("ag-p-name").value = p.name;
      agEl("ag-p-endpoint").value = p.endpoint;
      agEl("ag-p-model").value = p.model;
      agEl("ag-p-ctx").value = p.ctx;
      agSetReasoningModes(agRecommendedEfforts(p.model, false),
        agRecommendedEfforts(p.model, false).includes("medium") ? "medium" : "");
      agFillPricingForm(agPriceFallback(p.model));
      if (agEl("ag-p-peak-enabled")) agEl("ag-p-peak-enabled").checked = /deepseek/i.test(p.model);
      if (agEl("ag-p-kind")) agEl("ag-p-kind").value = p.kind || "openai";
      if (agEl("ag-preset-note")) agEl("ag-preset-note").textContent = p.note;
      agEl("ag-p-key").focus();
      toast("已填入（" + (p.kind === "anthropic" ? "Anthropic 格式" : "OpenAI 兼容") + "），只差 API Key");
    };
  }
  document.querySelectorAll("#ag-ctx-presets .chipbtn").forEach((b) => {
    b.onclick = () => { agEl("ag-p-ctx").value = b.dataset.ctx; };
  });
  agEl("ag-prov-save").onclick = agSaveProvider;
  if (agEl("ag-prov-import")) agEl("ag-prov-import").onclick = agImportProviders;
  if (agEl("ag-prov-export")) agEl("ag-prov-export").onclick = agExportProviders;
  if (agEl("ag-prov-testall")) agEl("ag-prov-testall").onclick = agTestAllProviders;
  if (agEl("ag-p-reason-test")) {
    agEl("ag-p-reason-test").onclick = async () => {
      const probe = agFormProvider();
      const efforts = probe.reasoning_efforts || [];
      const state = agEl("ag-p-reason-test-state");
      const box = agEl("ag-p-reason-result");
      if (!probe.endpoint || !probe.model) return toast("先填地址和模型名");
      if (!efforts.length) return toast("先在「可用思考强度」里至少勾一个档位");
      agEl("ag-p-reason-test").disabled = true;
      if (state) state.textContent = en("测试中…每个档位会真实请求一次");
      if (box) { box.hidden = true; box.innerHTML = ""; }
      try {
        const r = await invoke("agent_probe_reasoning", {
          provider: probe, apiKey: agFormKey(), efforts,
        });
        if (state) state.textContent = `${r.results.length} ${en("个档位完成")}`;
        if (box) {
          box.hidden = false;
          const head = document.createElement("div");
          head.className = "reasonhead";
          head.textContent = en("真实请求观察（不是隐藏 CoT 的绝对证明）");
          box.appendChild(head);
          for (const item of r.results) {
            const row = document.createElement("div");
            row.className = "reasonrow" + (item.ok ? "" : " bad");
            row.innerHTML =
              `<b>${agEscape(agReasoningName(item.effort) || item.effort)}</b>` +
              (item.ok
                ? `<span>${en("思考")} ${item.reasoning_chars} ${en("字")} · ${en("首字")} ${item.first_ms}ms · ${en("出字")} ${item.gen_ms}ms · ${item.completion_tokens} tok</span>` +
                  (item.reasoning_preview ? `<small>${agEscape(item.reasoning_preview)}</small>` : `<small>${en("接口未暴露思考正文")}</small>`)
                : `<span>${agEscape(item.error || "失败")}</span>`);
            box.appendChild(row);
          }
        }
      } catch (e) {
        if (state) state.textContent = en("测试失败");
        if (box) { box.hidden = false; box.textContent = String(e); }
        toast(String(e));
      } finally {
        agEl("ag-p-reason-test").disabled = false;
      }
    };
  }
  if (agEl("ag-prov-amd-add")) {
    agEl("ag-prov-amd-add").onclick = async () => {
      try {
        const r = await invoke("agent_amd_reseed");
        await agLoadConfig();
        toast(`AMD 免费模型：加了 ${r.added} 个（一共 ${r.total} 个）`);
      } catch (e) { toast(String(e)); }
    };
  }
  agEl("ag-p-models").onclick = async () => {
    const probe = agFormProvider();
    if (!probe.endpoint) return toast("先填地址（endpoint）");
    try {
      const list = await invoke("agent_probe_models", { provider: probe, apiKey: agFormKey() });
      agSetModelOptions(list);
      toast(list.length ? `拉到 ${list.length} 个模型，右侧下拉直接选` : "这个服务没给模型列表，手填吧");
    } catch (e) { toast(String(e)); }
  };
  agEl("ag-p-ping").onclick = async () => {
    const probe = agFormProvider();
    if (!probe.endpoint) return toast("先填地址（endpoint）");
    toast("正在请求…");
    try { toast(await invoke("agent_probe_chat", { provider: probe, apiKey: agFormKey() })); }
    catch (e) { toast(String(e)); }
  };

  // 技能 / MCP 的"管理"都在「设置」里的两个页面（Agent 信息页只留开关）
  bindSkillsPage();
  bindMcpPage();
  if (agEl("ag-skill-refresh")) agEl("ag-skill-refresh").onclick = () => agLoadSkills();
  if (agEl("ag-mcp-refresh")) agEl("ag-mcp-refresh").onclick = () => agLoadMcps();
  // 「＋」：技能 / MCP 的导入与新增都在设置页，直接跳过去（这一页只管开关）
  if (agEl("ag-skill-add")) agEl("ag-skill-add").onclick = () => openSettings("skills");
  if (agEl("ag-mcp-add")) agEl("ag-mcp-add").onclick = () => openSettings("mcp");
}

async function agLoadConfig() {
  try { agCfg = await invoke("agent_config_get"); } catch (_) { return; }
  try { agSpeed = await invoke("agent_speed_get"); } catch (_) { agSpeed = agSpeed || {}; }
  agNewProfile = false;
  const sel = agEl("ag-provider");
  if (sel) {
    sel.innerHTML = "";
    if (!agCfg.providers.length) sel.innerHTML = '<option value="">' + en("（还没有，点新增）") + '</option>';
    for (const p of agCfg.providers) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = agTrName(p.name) + " · " + p.model;
      sel.appendChild(o);
    }
    if (agCfg.activeId) sel.value = agCfg.activeId;
  }
  if (agEl("ag-key-hint")) {
    const scheme = agCfg.secretScheme === "dpapi"
      ? "Windows DPAPI" + en("（按当前用户加密）")
      : en("明文（非 Windows 平台）");
    agEl("ag-key-hint").textContent = `${en("密钥存储：")}${scheme}　${en("数据目录：")}${agCfg.dataDir}`;
  }
  await agLoadQuickModels();
  agEnsurePresets();
  agRenderProviders();
  // 用户正在「新增 / 编辑」页填表时，别被后台刷新把表单冲掉
  if (agCfg.providers.length && !agNewProfile && !agOnNewTab()) {
    agFillProvider(agCfg.activeId || (sel && sel.value) || agCfg.providers[0].id);
  }
  if (agMeta) agRenderInfo();
}

let agNewProfile = false;

/* ── 供应商面板：两个子页（使用 / 新增）──────────────────────────────── */
/** 现在是不是停在「新增 / 编辑」那一页（后台刷新时别把用户正在填的表单冲掉） */
function agOnNewTab() {
  const p = document.querySelector('.provtab[data-provtab-pane="new"]');
  return !!p && !p.hidden;
}

function agProvTab(name) {
  document.querySelectorAll("#ag-prov-tabs .segtab").forEach((b) =>
    b.classList.toggle("active", b.dataset.provtab === name));
  document.querySelectorAll(".provtab").forEach((p) => { p.hidden = p.dataset.provtabPane !== name; });
  if (name === "use") {
    agSyncFreeSection();
    if (amdNeedsData()) amdLoadPull(false);
  }
  if (name === "catalog") mdEnsure(false);
  if (name === "new") agEnsurePresets();
  if (LANG === "en") langWalk();
}

/** 「编辑」= 带着这条的数据跳到「新增 / 编辑」那一页 */
function agProvToEdit(p) {
  if (agEl("ag-prov-new-title")) agEl("ag-prov-new-title").textContent = en("编辑：") + agTrName(p.name || p.id);
  if (agEl("ag-prov-cancel")) agEl("ag-prov-cancel").hidden = false;
  agProvTab("new");
}

/** 免费模型那一块是"卷起来的"：默认收起；不收起来就不去发实时负载请求 */
function agSyncFreeSection() {
  const wrap = agEl("ag-prov-free");
  const btn = agEl("ag-free-toggle");
  const cnt = agEl("ag-free-count");
  const n = ((agCfg && agCfg.providers) || []).filter(isAmdProfile).length;
  if (cnt) cnt.textContent = n ? n + " " + en("个免费模型") : "";
  const open = !!wrap && !wrap.hidden;
  if (btn) {
    btn.textContent = open ? en("收起免费模型 ▴") : en("显示免费模型 ▾");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

/** 切"当前用哪个模型"：全局 active + 当前会话记住的 profile 一起换 */
async function agUseProvider(id, silent) {
  if (!id) return;
  const before = (agCfg && agCfg.activeId) || "";
  try {
    await invoke("agent_provider_set_active", { id });
  } catch (e) { toast(String(e)); return; }
  // 会话自己也有"用哪个 profile"的记忆，不一起改的话上下文面板/压缩判断还是旧模型的口径
  const sid = agMeta && agMeta.id;
  let switched = null;
  if (sid) {
    switched = await invoke("agent_session_set_provider", { id: sid, providerId: id }).catch(() => null);
    if (switched && agMeta) {
      agMeta.provider_id = switched.provider || agMeta.provider_id;
      agMeta.model = switched.model || agMeta.model;
      agMeta.reasoning_effort = switched.reasoning_effort || "";
    }
  }
  await agLoadConfig();
  agSyncReasoningControl();
  agRefreshPricing(true);
  if (!silent) {
    const p = (agCfg.providers || []).find((x) => x.id === id);
    toast(en("后面这轮用：") + (p ? agTrName(p.name) : id));
  }
  if (before !== id) await agGuardContextFit();
}

/** 半路换成上下文更小的模型：旧会话可能已经装不进新窗口 → 主动压一次。
 *  注意口径：预算要按**新** profile 的窗口算（`agent_context_breakdown` 报的是会话当前记的那个，
 *  换模型那一刻还是旧的）；用量取"后端报的 prompt_tokens"和本地估算里的大者。 */
async function agGuardContextFit() {
  const sid = agMeta && agMeta.id;
  if (!sid || !agCfg) return;
  if (agRunning) return;                       // 正在跑就交给后端这一轮的边界处理
  const np = (agCfg.providers || []).find((x) => x.id === agCfg.activeId);
  if (!np) return;
  const budget = Math.max(0, (Number(np.context_window) || 0) - (Number(np.reserve_output) || 0));
  if (!budget) return;
  let b;
  try { b = await invoke("agent_context_breakdown", { sessionId: sid }); } catch (_) { return; }
  const used = Math.max(Number(b.used) || 0, Number(b.lastPromptTokens) || 0);
  if (!used) return;
  if (used * 10 < budget * 8) return;          // 跟后端一个口径：留 20% 余量
  toast(`${en("新模型窗口更小：当前约")} ${used} tokens${en("，预算")} ${budget} —— ${en("先压一次上下文")}`);
  try {
    await invoke("agent_compact", { sessionId: sid });
    await agRefreshBreakdown();
  } catch (e) { toast(en("压缩失败：") + String(e)); }
}

/** 表单现在填的是什么（探针用，不用先保存） */
function agFormNum(id, fallback) {
  const el = agEl(id);
  if (!el || el.value === "") return fallback;
  const n = Number(el.value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function agPricingFromForm() {
  const fallback = agPriceFallback(agEl("ag-p-model") ? agEl("ag-p-model").value : "");
  return {
    currency: agEl("ag-p-price-cur") ? agEl("ag-p-price-cur").value : fallback.currency,
    peak_enabled: !!(agEl("ag-p-peak-enabled") && agEl("ag-p-peak-enabled").checked),
    peak_hit: agFormNum("ag-p-peak-hit", fallback.peak_hit),
    peak_miss: agFormNum("ag-p-peak-miss", fallback.peak_miss),
    peak_out: agFormNum("ag-p-peak-out", fallback.peak_out),
    offpeak_hit: agFormNum("ag-p-offpeak-hit", fallback.offpeak_hit),
    offpeak_miss: agFormNum("ag-p-offpeak-miss", fallback.offpeak_miss),
    offpeak_out: agFormNum("ag-p-offpeak-out", fallback.offpeak_out),
  };
}

function agFillPricingForm(pricing) {
  const p = pricing || AG_PRICE_FIXED;
  if (agEl("ag-p-price-cur")) agEl("ag-p-price-cur").value = String(p.currency || "CNY").toUpperCase();
  if (agEl("ag-p-peak-enabled")) agEl("ag-p-peak-enabled").checked = !!p.peak_enabled;
  agEl("ag-p-peak-hit").value = p.peak_hit;
  agEl("ag-p-peak-miss").value = p.peak_miss;
  agEl("ag-p-peak-out").value = p.peak_out;
  agEl("ag-p-offpeak-hit").value = p.offpeak_hit;
  agEl("ag-p-offpeak-miss").value = p.offpeak_miss;
  agEl("ag-p-offpeak-out").value = p.offpeak_out;
}

function agFormProvider() {
  return {
    id: (agEl("ag-p-id").value || "probe").trim(),
    name: (agEl("ag-p-name").value || "probe").trim(),
    kind: agEl("ag-p-kind") ? agEl("ag-p-kind").value : "openai",
    endpoint: agEl("ag-p-endpoint").value.trim(),
    model: agEl("ag-p-model").value.trim(),
    api_key_ref: (agEl("ag-p-id").value || "").trim(),
    temperature: Number(agEl("ag-p-temp").value) || 0.2,
    reasoning_efforts: agSelectedReasoningEfforts(),
    reasoning_effort: agEl("ag-p-reasoning") ? agEl("ag-p-reasoning").value : "",
    context_window: Number(agEl("ag-p-ctx").value) || 128000,
    reserve_output: Number(agEl("ag-p-res").value) || 8192,
    max_messages: 40,
    supports_tools: agEl("ag-p-tools").checked,
    supports_stream: agEl("ag-p-stream").checked,
    pricing: agPricingFromForm(),
  };
}

function agFormKey() {
  const k = (agEl("ag-p-key").value || "").trim();
  return k ? k : null;      // 空的话后端会回退到密钥库里存的那把
}

function agClearModelPicker() {
  const pick = agEl("ag-model-pick");
  if (pick) {
    pick.innerHTML = "";
    pick.hidden = true;
  }
  if (agEl("ag-model-list")) agEl("ag-model-list").innerHTML = "";
}

/** 「拉模型列表」之后同时填 datalist 和可点选下拉；输入框已有文字也能直接选。 */
function agSetModelOptions(list) {
  const dl = agEl("ag-model-list");
  const pick = agEl("ag-model-pick");
  const models = [...new Set((list || []).map((x) => String(x)).filter(Boolean))];
  if (dl) {
    dl.innerHTML = "";
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      dl.appendChild(o);
    }
  }
  if (!pick) return;
  pick.innerHTML = "";
  if (!models.length) {
    pick.hidden = true;
    return;
  }
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = en("选择模型…");
  pick.appendChild(ph);
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    pick.appendChild(o);
  }
  const cur = (agEl("ag-p-model") && agEl("ag-p-model").value || "").trim();
  if (models.includes(cur)) pick.value = cur;
  pick.hidden = false;
}

/** 对话页那个"模型"下拉：切当前生效的 profile */
/** 这条 profile 是不是"AMD Radeon Cloud 内置"那批（id 形如 amd-xxx） */
const isAmdProfile = (p) => !!p && /^amd-/.test(String(p.id || ""));

/** 内置 profile 名字里带中文前缀（"AMD 免费 · xxx"）；英文界面下把它换掉。
 *  用户自己改过的名字不动。 */
function agTrName(name) {
  const s = String(name || "");
  if (LANG !== "en") return s;
  // 内置/预设名字：先按整名查词典（"DeepSeek（Anthropic 格式）" 这种），再换 AMD 前缀
  return (EN[s] || s).replace(/^AMD 免费 · /, "AMD Free · ");
}

/** 出字速度：每个 profile 一条 {last, avg, tokens, ms, samples} */
let agSpeed = {};
const fmtTps = (v) => (v > 0 ? (v >= 100 ? Math.round(v) : v.toFixed(1)) + " tok/s" : "");
const AG_REASONING_OPTIONS = [
  ["none", "关闭思考"], ["minimal", "极低"], ["low", "低"], ["medium", "中"],
  ["high", "高"], ["xhigh", "极高"], ["max", "最大"], ["ultra", "超强"],
];
const AG_REASONING_NAMES = Object.fromEntries(AG_REASONING_OPTIONS);
const agReasoningName = (v) => AG_REASONING_NAMES[String(v || "")] || "";

function agSelectedReasoningEfforts() {
  return [...document.querySelectorAll("#ag-p-reasoning-modes input:checked")]
    .map((el) => el.value)
    .filter(Boolean);
}

function agSyncReasoningDefaultOptions(selected) {
  const sel = agEl("ag-p-reasoning");
  const modes = agSelectedReasoningEfforts();
  if (!sel) return;
  const want = selected == null ? sel.value : selected;
  sel.innerHTML = '<option value="">跟随模型默认</option>';
  for (const mode of modes) {
    const o = document.createElement("option");
    o.value = mode;
    o.textContent = en(agReasoningName(mode) || mode);
    sel.appendChild(o);
  }
  sel.value = modes.includes(want) ? want : "";
}

function agSetReasoningModes(modes, selected) {
  const box = agEl("ag-p-reasoning-modes");
  if (!box) return;
  const chosen = new Set((modes || []).filter((v) => AG_REASONING_NAMES[v]));
  box.innerHTML = "";
  for (const [value, label] of AG_REASONING_OPTIONS) {
    const lb = document.createElement("label");
    lb.className = "effortchip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = value;
    cb.checked = chosen.has(value);
    cb.onchange = () => agSyncReasoningDefaultOptions(value);
    lb.append(cb, document.createTextNode(en(label)));
    box.appendChild(lb);
  }
  agSyncReasoningDefaultOptions(selected || "");
}

function agInitReasoningModes() {
  const box = agEl("ag-p-reasoning-modes");
  if (!box || box.dataset.ready) return;
  box.dataset.ready = "1";
  agSetReasoningModes([], "");
}

function agRecommendedEfforts(model, knownReasoning) {
  if (knownReasoning) return ["low", "medium", "high"];
  return /(?:reason|thinking|deepseek|glm|kimi|qwen3|o[134](?:-|$)|gpt-5)/i.test(String(model || ""))
    ? ["low", "medium", "high"]
    : [];
}

/** 模型名 → 那一行的状态短标签（只有 AMD 的模型有；其它厂商没有状态可查） */
function agModelStatus(p) {
  if (!isAmdProfile(p)) return "";
  const m = amdLoadData && amdLoadData.models ? amdLoadData.models[p.model] : null;
  // 没这份数据就不标状态（负载只在「设置 → 模型」里手动展开时才取，别在这儿骗人说"取状态中"）
  if (!m) return "";
  const label = en(m.state === "full" ? "满载" : m.state === "busy" ? "繁忙" : "空闲");
  return m.utilization != null ? `${label} ${Math.round(m.utilization)}%` : label;
}

function agModelOptionText(p) {
  const bits = [agTrName(p.name)];
  // 名字里已经带了模型名（AMD 那批就是 "AMD 免费 · <模型>"）就别再重复一遍
  if (p.model && !String(p.name || "").includes(p.model)) bits.push(p.model);
  const st = agModelStatus(p);
  if (st) bits.push(st);
  const tps = fmtTps((agSpeed[p.id] || {}).last);
  if (tps) bits.push(tps);
  const reasoning = agReasoningName(p.reasoning_effort);
  if (reasoning) bits.push(reasoning);
  return bits.join(" · ");
}

function agActiveProvider() {
  const id = (agCfg && agCfg.activeId)
    || (agMeta && agMeta.provider_id)
    || "";
  return ((agCfg && agCfg.providers) || []).find((p) => p.id === id) || null;
}

function agSyncReasoningControl() {
  const wrap = agEl("ag-reasoning-wrap");
  const sel = agEl("ag-reasoning");
  const p = agActiveProvider();
  if (!wrap || !sel) return;
  const modes = (p && p.reasoning_efforts) || [];
  if (!modes.length) {
    wrap.hidden = true;
    sel.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  const current = agMeta ? (agMeta.reasoning_effort || "") : "";
  const defaultText = p.reasoning_effort
    ? `${en("供应商默认")} · ${en(agReasoningName(p.reasoning_effort) || p.reasoning_effort)}`
    : en("供应商默认");
  sel.innerHTML = `<option value="">${agEscape(defaultText)}</option>`;
  for (const mode of modes) {
    const o = document.createElement("option");
    o.value = mode;
    o.textContent = en(agReasoningName(mode) || mode);
    sel.appendChild(o);
  }
  sel.value = modes.includes(current) ? current : "";
  sel.disabled = agRunning;
}

async function agLoadQuickModels() {
  const sel = agEl("ag-quick-model");
  if (!sel || !agCfg) return;
  sel.innerHTML = "";
  if (!agCfg.providers.length) {
    sel.innerHTML = '<option value="">（去设置里加一个）</option>';
    return;
  }
  for (const p of agCfg.providers) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = agModelOptionText(p);
    sel.appendChild(o);
  }
  const more = document.createElement("option");
  more.value = "__settings__"; more.textContent = en("＋ 新增/编辑…");
  sel.appendChild(more);
  sel.value = agCfg.activeId || agCfg.providers[0].id;
  agSyncModelBusy();
  agSyncReasoningControl();
}

/** 正在取 AMD 状态时，下拉旁边转圈（其它厂商不发这个请求，也就不转） */
function agSyncModelBusy() {
  const el = agEl("ag-model-busy");
  if (el) el.hidden = !window.__amdLoading;
}

function bindQuickModels() {
  const sel = agEl("ag-quick-model");
  if (!sel) return;
  // 点开下拉就先刷一次状态（后端有 15 秒缓存，不会每次都真发请求）；转圈由 agSyncModelBusy 管
  sel.onmousedown = () => amdLoadPull(false);
  sel.onfocus = () => amdLoadPull(false);
  sel.onchange = async () => {
    if (sel.value === "__settings__") {
      openSettings("model");
      return;
    }
    await agUseProvider(sel.value);
  };
  const reasoning = agEl("ag-reasoning");
  if (reasoning) {
    reasoning.onchange = async () => {
      if (!agMeta) return toast("先建一个会话");
      try {
        const r = await invoke("agent_session_set_reasoning", {
          id: agMeta.id, effort: reasoning.value,
        });
        agMeta.reasoning_effort = r.reasoning_effort || "";
        toast(`${en("本会话思考强度：")}${agReasoningName(agMeta.reasoning_effort) || en("供应商默认")}`);
      } catch (e) {
        toast(String(e));
        agSyncReasoningControl();
      }
    };
  }
}

function agFillProvider(id) {
  const p = agCfg && agCfg.providers.find((x) => x.id === id);
  if (!p) return;
  agClearModelPicker();
  agEl("ag-p-id").value = p.id;
  agEl("ag-p-name").value = p.name;
  agEl("ag-p-endpoint").value = p.endpoint;
  if (agEl("ag-p-kind")) agEl("ag-p-kind").value = p.kind || "openai";
  agEl("ag-p-model").value = p.model;
  agEl("ag-p-key").value = "";
  agEl("ag-p-key").placeholder = en((agCfg.secrets || []).includes(p.api_key_ref) ? "已在密钥库里（留空=不改）" : "粘贴 API Key");
  agEl("ag-p-ctx").value = p.context_window;
  agEl("ag-p-res").value = p.reserve_output;
  agEl("ag-p-temp").value = p.temperature;
  agSetReasoningModes(p.reasoning_efforts || [], p.reasoning_effort || "");
  agEl("ag-p-tools").checked = !!p.supports_tools;
  agEl("ag-p-stream").checked = !!p.supports_stream;
  agFillPricingForm(agEffectivePricing(p));
}

async function agSaveProvider() {
  let id = agEl("ag-p-id").value.trim();
  if (!id) {
    // 没填 ID 就用名字兜底（只给程序用，用户不用关心）
    const nm = agEl("ag-p-name").value.trim();
    id = (nm || "provider").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
    agEl("ag-p-id").value = id;
  }
  if (!agEl("ag-p-endpoint").value.trim()) return toast("地址（endpoint）不能空");
  if (!agEl("ag-p-model").value.trim()) return toast("模型名不能空");
  const provider = {
    id,
    name: agEl("ag-p-name").value.trim() || id,
    kind: agEl("ag-p-kind") ? agEl("ag-p-kind").value : "openai",
    endpoint: agEl("ag-p-endpoint").value.trim(),
    model: agEl("ag-p-model").value.trim(),
    api_key_ref: id,
    temperature: Number(agEl("ag-p-temp").value) || 0.2,
    reasoning_efforts: agSelectedReasoningEfforts(),
    reasoning_effort: agEl("ag-p-reasoning") ? agEl("ag-p-reasoning").value : "",
    context_window: Number(agEl("ag-p-ctx").value) || 128000,
    reserve_output: Number(agEl("ag-p-res").value) || 8192,
    max_messages: 40,
    supports_tools: agEl("ag-p-tools").checked,
    supports_stream: agEl("ag-p-stream").checked,
    pricing: agPricingFromForm(),
  };
  try {
    await invoke("agent_provider_save", { provider, makeActive: true });
    const key = agEl("ag-p-key").value.trim();
    if (key) await invoke("agent_secret_set", { name: id, value: key });
    agNewProfile = false;
    toast("已保存");
    await agLoadConfig();
    agProvTab("use");            // 存完回「使用」面板
  } catch (e) { toast(String(e)); }
}

/* ── 已配置的供应商：使用面板一行一个 —— 点行=切到它，行尾只有「编辑 / 删除」── */
let agProvTest = {};      // id -> { ok, text }  最近一次"测一测"的结果

function agProvRow(p, secrets) {
  const row = document.createElement("div");
  const active = !!(agCfg && agCfg.activeId === p.id);
  row.className = "provrow" + (active ? " active" : "");
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = (active ? "● " : "") + agTrName(p.name || p.id);
  nm.title = active ? en("当前在用") : en("点一下切到它");
  const kind = document.createElement("span");
  const isAnth = (p.kind || "openai") === "anthropic";
  kind.className = "kind" + (isAnth ? " anthropic" : "");
  kind.textContent = isAnth ? "Anthropic" : "OpenAI";
  kind.title = isAnth ? "Anthropic /v1/messages" : en("OpenAI 兼容 /chat/completions");
  const meta = document.createElement("span");
  meta.className = "meta";
  const hasKey = secrets.includes(p.api_key_ref || p.id);
  const reasoning = agReasoningName(p.reasoning_effort);
  meta.textContent = `${p.model}${reasoning ? " · " + reasoning : ""} · ${p.endpoint}${hasKey ? "" : " · " + en("⚠ 没密钥")}`;
  meta.title = meta.textContent;
  const mk = (label, title, fn) => {
    const b = document.createElement("button");
    b.className = "btn small"; b.textContent = label; b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  row.append(nm, kind, meta);
  row.appendChild(mk(en("编辑"), en("在这条的基础上改（跳到「新增 / 编辑」）"), () => {
    agNewProfile = false;
    agFillProvider(p.id);
    agProvToEdit(p);
  }));
  row.appendChild(mk(en("删除"), en("删掉这个 profile（密钥一起删）"), async () => {
    const q = `${en("确定删掉")}「${agTrName(p.name || p.id)}」？${en("它的 API Key 也一起删。")}`;
    if (!(await agConfirm(q, en("删除供应商"), true))) return;
    await invoke("agent_provider_delete", { id: p.id }).catch((e) => toast(String(e)));
    agProvTest[p.id] = undefined;
    await agLoadConfig();
  }));
  row.onclick = () => { if (!active) agUseProvider(p.id); };
  return row;
}

function agRenderProviders() {
  const box = agEl("ag-prov-list");
  const freeBox = agEl("ag-prov-amd");
  if (!box) return;
  const list = (agCfg && agCfg.providers) || [];
  const secrets = (agCfg && agCfg.secrets) || [];
  const draw = (container, arr, emptyText) => {
    if (!container) return;
    container.innerHTML = "";
    if (!arr.length) { container.innerHTML = '<div class="empty">' + emptyText + '</div>'; return; }
    for (const p of arr) container.appendChild(agProvRow(p, secrets));
  };
  draw(box, list.filter((p) => !isAmdProfile(p)), en("（还没有自建供应商：去「新增 / 编辑」加一个）"));
  draw(freeBox, list.filter(isAmdProfile), en("（没有免费模型：展开后点「+ AMD 免费模型」加回来）"));
  agSyncFreeSection();
}

async function agTestAllProviders() {
  const list = (agCfg && agCfg.providers) || [];
  if (!list.length) return toast("还没有供应商");
  toast(`开始逐个测 ${list.length} 个…`);
  let ok = 0;
  for (const p of list) {
    try {
      const r = await invoke("agent_ping_provider", { id: p.id });
      agProvTest[p.id] = { ok: true, text: r }; ok++;
    } catch (e) {
      agProvTest[p.id] = { ok: false, text: String(e) };
    }
    agRenderProviders();
  }
  toast(`${ok}/${list.length} 个可用`);
}

/** 导出 profile（**不含密钥**：密钥是 DPAPI 按用户加密的，本来也带不到别的机器） */
async function agExportProviders() {
  try {
    const data = { app: "KDock", kind: "providers", version: 1, providers: (agCfg && agCfg.providers) || [] };
    const p = await dlgSave({
      title: "导出供应商配置（不含密钥）", defaultPath: "kdock-providers.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!p) return;
    await writeTextFile(p, JSON.stringify(data, null, 2));
    toast("已导出（密钥不在文件里，导过去要重新粘一次）");
  } catch (e) { toast(String(e)); }
}

/** 导入 profile（按 id 合并；缺密钥的下次用时会提示补） */
async function agImportProviders() {
  try {
    const p = await dlgOpen({
      title: "导入供应商配置", multiple: false, directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!p) return;
    const path0 = typeof p === "string" ? p : p.path;
    const v = JSON.parse(new TextDecoder().decode(await readFile(path0)));
    const list = Array.isArray(v) ? v : (v.providers || []);
    if (!Array.isArray(list) || !list.length) return toast("这个文件里没有 providers");
    let n = 0;
    for (const it of list) {
      if (!it || !it.id || !it.endpoint || !it.model) continue;
      await invoke("agent_provider_save", { provider: it, makeActive: false }).catch((e) => toast(`${it.id}: ${e}`));
      n++;
    }
    await agLoadConfig();
    toast(`导入 ${n} 个供应商（记得补 API Key）`);
  } catch (e) { toast(String(e)); }
}

async function agLoadSkills() {
  agSkills = await invoke("agent_skills").catch(() => []);
  agAlways = { slugs: [], bytes: 0, limit: 0 };        // 「常驻技能」已经取消了，留着这个变量只为兼容旧引用
  agRenderSkillTable();   // Agent 信息页：只展示 + 开关
  renderSkillsPage();     // 设置 → 技能：全部管理
}

/* ── Agent 信息页：技能 / MCP 只做"展示 + 开关" ───────────────────── */
function agRenderSkillTable() {
  const box = agEl("ag-skill-table");
  if (!box) return;
  box.innerHTML = "";
  if (!agSkills.length) {
    box.innerHTML = '<div class="agrow empty">' + en("（还没有技能）· 去「设置 → 技能」导入") + '</div>';
    return;
  }
  for (const s of agSkills) {
    const row = document.createElement("div");
    row.className = "agrow" + (s.enabled ? "" : " off");
    const nm = document.createElement("b");
    nm.textContent = s.slug;
    nm.title = s.path || "";
    const d = document.createElement("span");
    d.className = "d"; d.textContent = s.description || "（无描述）";
    const sz = document.createElement("span");
    sz.className = "sz"; sz.textContent = (s.size / 1024).toFixed(1) + " KB";
    const sw = document.createElement("input");
    sw.type = "checkbox"; sw.className = "sw"; sw.checked = !!s.enabled;
    sw.title = en(s.enabled ? "已启用（关掉后不进索引，只能由你点名读取）" : "已停用（不进索引，可点名读取）");
    sw.onchange = async () => {
      try {
        await invoke("agent_skill_set_enabled", { name: s.slug, on: sw.checked });
        toast(sw.checked ? `已启用 ${s.slug}` : `已停用 ${s.slug}`);
      } catch (e) {
        toast(String(e)); sw.checked = !sw.checked;
      }
      await agLoadSkills();
    };
    // 这一页只管"展示 + 开关"：使用/不使用；正文按需读（不再有"常驻"这回事）
    row.appendChild(nm); row.appendChild(d); row.appendChild(sz);
    row.appendChild(sw);
    box.appendChild(row);
  }
  const foot = document.createElement("div");
  foot.className = "agrow empty";
  foot.textContent = en("技能在这里只管开关：正文不进上下文，模型需要时自己读");
  box.appendChild(foot);
}

function agRenderMcpTable() {
  const box = agEl("ag-mcp-table");
  if (!box) return;
  box.innerHTML = "";
  if (!agMcps.length) {
    box.innerHTML = '<div class="agrow empty">' + en("（还没有 MCP 服务）· 去「设置 → MCP」新增") + '</div>';
    return;
  }
  for (const m of agMcps) {
    const row = document.createElement("div");
    row.className = "agrow" + (m.enabled ? "" : " off");
    const nm = document.createElement("b");
    nm.textContent = m.name || m.id;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = [m.command, ...(m.args || [])].join(" ");
    d.title = d.textContent;
    const sw = document.createElement("input");
    sw.type = "checkbox"; sw.className = "sw"; sw.checked = !!m.enabled;
    sw.title = en(m.enabled ? "已启用（工具会挂给 agent）" : "已停用");
    sw.onchange = async () => {
      try {
        await invoke("mcp_save", { server: { ...m, enabled: sw.checked } });
        toast(sw.checked ? `已启用 ${m.id}` : `已停用 ${m.id}`);
      } catch (e) {
        toast(String(e)); sw.checked = !sw.checked;
      }
      agLoadMcps();
    };
    row.appendChild(nm); row.appendChild(d); row.appendChild(sw);
    box.appendChild(row);
  }
}

/* ── 设置 → 技能：本机技能的全部管理（列表 / 导入 / 新建 / 编辑 / 删除 / 打开目录）── */
function renderSkillsPage() {
  const box = agEl("set-skill-list");
  if (!box) return;
  box.innerHTML = "";
  if (!agSkills.length) {
    box.innerHTML = '<div class="empty">' + en("（还没有技能：点「导入…」选一个 SKILL.md，或「新建」）") + '</div>';
  }
  for (const s of agSkills) {
    const row = document.createElement("div");
    row.className = "row" + (s.enabled ? "" : " off");
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = s.slug;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = (s.enabled ? en("使用中") : en("不使用")) + " · "
      + (s.size + 0 === s.size ? (s.size / 1024).toFixed(1) + " KB" : "");
    row.appendChild(nm); row.appendChild(tag);
    row.title = (s.description || "") + "\n" + (s.path || "");
    row.onclick = async () => {
      agEl("set-skill-name").value = s.slug;
      agEditSkill = { scope: "global", workspace: "" };
      if (agEl("set-skill-scope")) agEl("set-skill-scope").textContent = en("正在编辑：全局技能");
      try {
        agEl("set-skill-body").value = await invoke("agent_skill_read", { name: s.slug });
      } catch (e) { toast(String(e)); }
    };
    box.appendChild(row);
  }
  invoke("agent_skills_dir").then((p) => {
    const el = agEl("set-skill-dir");
    if (el) el.textContent = p || "（未知）";
  }).catch(() => {});
  renderWorkSkillsPage();
  renderArchivePage();
  renderToolsPage();
}

/* ── 工作区技能（项目级）＋ 归档 ─────────────────────────────────── */
let agWsList = [];
/// 编辑器现在在改哪一层（点全局技能行 = global；点项目技能行 = workspace + 那个工作区）
let agEditSkill = { scope: "global", workspace: "" };
async function renderWorkSkillsPage() {
  const sel = agEl("set-wsskill-ws");
  const box = agEl("set-wsskill-list");
  if (!box) return;
  // 工作区下拉：没建过就去问后端要一次
  if (sel && !agWsList.length) {
    agWsList = await invoke("agent_workspaces").catch(() => []);
    sel.innerHTML = "";
    for (const w of agWsList) {
      const o = document.createElement("option");
      o.value = w.path; o.textContent = w.name || w.path;
      sel.appendChild(o);
    }
    // 默认看**当前会话所在的工作区**（列表第一项往往是"默认工作区"，看着像"没有技能"）
    const cur = (agMeta && agMeta.workspace) || "";
    if (cur && agWsList.some((w) => w.path === cur)) sel.value = cur;
    const cv = agEl("set-skill-convert-ws");
    if (cv) {
      cv.innerHTML = "";
      for (const w of agWsList) {
        const o = document.createElement("option");
        o.value = w.path; o.textContent = w.name || w.path;
        cv.appendChild(o);
      }
      if (cur && agWsList.some((w) => w.path === cur)) cv.value = cur;
    }
  }
  const ws = (sel && sel.value) || (agMeta && agMeta.workspace) || "";
  box.innerHTML = '<div class="empty">' + en("读取中…") + '</div>';
  const list = ws ? await invoke("agent_skills_workspace", { workspace: ws }).catch(() => []) : [];
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + en("这个工作区还没有专属技能（导入的技能默认落在全局，可用上面的「转为工作区专属」下放）") + '</div>';
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "row";
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = s.slug;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = ((s.size || 0) / 1024).toFixed(1) + " KB · " + en("存在即生效（每轮进索引）");
    const del = document.createElement("button");
    del.className = "btn small danger"; del.textContent = en("删除");
    del.onclick = async (e) => {
      e.stopPropagation();
      const r = await agConfirm(`删掉工作区技能 ${s.slug}？（会先归档一份到 skill-archive）`, en("删除技能"), true);
      if (!r) return;
      try {
        await invoke("agent_skill_delete", { name: s.slug, scope: "workspace", workspace: ws });
        await renderWorkSkillsPage(); renderArchivePage();
      } catch (err) { toast(String(err)); }
    };
    // 点行 = 读进下面的编辑器（编辑器要知道自己在改哪一层）
    row.onclick = async () => {
      agEl("set-skill-name").value = s.slug;
      agEditSkill = { scope: "workspace", workspace: ws };
      if (agEl("set-skill-scope")) agEl("set-skill-scope").textContent = en("正在编辑：本项目技能（") + ws + "）";
      try {
        agEl("set-skill-body").value = await invoke("agent_skill_read", { name: s.slug, scope: "workspace", workspace: ws });
      } catch (e) { toast(String(e)); }
    };
    row.appendChild(nm); row.appendChild(tag); row.appendChild(del);
    row.title = s.path || "";
    box.appendChild(row);
  }
}

async function renderArchivePage() {
  const box = agEl("set-archive-list");
  if (!box) return;
  const list = await invoke("agent_skill_archive").catch(() => []);
  const cnt = agEl("set-archive-count");
  if (cnt) cnt.textContent = list.length ? `${list.length}` : "";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + en("（没有归档：把全局技能转为工作区专属、或删掉工作区技能时，会自动在这儿留一份备份）") + '</div>';
    return;
  }
  for (const a of list) {
    const row = document.createElement("div");
    row.className = "row";
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = a.slug;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = ((a.size || 0) / 1024).toFixed(1) + " KB · " + (a.from === "workspace" ? en("来自工作区") : en("来自全局"));
    row.title = (a.workspace || "") + "\n" + (a.path || "");
    const b1 = document.createElement("button");
    b1.className = "btn small"; b1.textContent = en("还原到全局");
    b1.onclick = async (e) => { e.stopPropagation();
      try { await invoke("agent_skill_archive_restore", { name: a.slug, scope: "global" }); toast(en("已还原到全局技能")); await agLoadSkills(); }
      catch (err) { toast(String(err)); } };
    row.appendChild(nm); row.appendChild(tag); row.appendChild(b1);
    if (a.workspace) {
      const b2 = document.createElement("button");
      b2.className = "btn small"; b2.textContent = en("还原到工作区");
      b2.onclick = async (e) => { e.stopPropagation();
        try { await invoke("agent_skill_archive_restore", { name: a.slug, scope: "workspace", workspace: a.workspace }); toast(en("已还原到工作区")); renderWorkSkillsPage(); }
        catch (err) { toast(String(err)); } };
      row.appendChild(b2);
    }
    const b3 = document.createElement("button");
    b3.className = "btn small danger"; b3.textContent = en("删归档");
    b3.onclick = async (e) => { e.stopPropagation();
      const r = await agConfirm(`删掉归档 ${a.slug}？删了就真没备份了。`, en("删除归档"), true);
      if (!r) return;
      try { await invoke("agent_skill_archive_delete", { name: a.slug }); renderArchivePage(); }
      catch (err) { toast(String(err)); } };
    row.appendChild(b3);
    box.appendChild(row);
  }
}

/* ── 设置 → 工具：只读清单 + 使用/不使用（对新会话生效）───────────── */
let agToolRows = [];
async function renderToolsPage() {
  const box = agEl("set-tool-list");
  if (!box) return;
  if (!agToolRows.length) agToolRows = await invoke("agent_tools_list").catch(() => []);
  const kw = ((agEl("set-tool-filter") || {}).value || "").trim().toLowerCase();
  const rows = agToolRows.filter((t) => !kw || (t.name + " " + (t.description || "")).toLowerCase().includes(kw));
  box.innerHTML = "";
  let onBytes = 0;
  for (const t of agToolRows) if (t.enabled) onBytes += t.bytes || 0;
  const sum = agEl("set-tool-sum");
  if (sum) sum.textContent = `${agToolRows.filter((x) => x.enabled).length}/${agToolRows.length} · ${(onBytes / 1024).toFixed(1)} KB`;
  const order = ["通信", "工作区与执行", "设备与固件", "安卓调试", "仪器与固件分析", "屏幕与图像", "中控编排", "技能与环境", "界面与上下文", "其他"];
  const groups = new Map();
  for (const t of rows) {
    const cat = t.category || "其他";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(t);
  }
  const bulk = async (cat, on) => {
    try {
      const r = await invoke("agent_tools_bulk_set", { category: cat, on });
      toast(String((r && r.note) || ""));
      agToolRows = [];
      renderToolsPage();
    } catch (e) { toast(String(e)); }
  };
  for (const cat of [...order, ...groups.keys()].filter((v, i, a) => a.indexOf(v) === i)) {
    const items = groups.get(cat);
    if (!items || !items.length) continue;
    const head = document.createElement("div");
    head.className = "trow toolgrouphead";
    const title = document.createElement("span");
    title.className = "cardtitle";
    title.textContent = en(cat);
    const state = document.createElement("span");
    state.className = "lb";
    state.textContent = `${items.filter((x) => x.enabled).length}/${items.length}`;
    const grow = document.createElement("span"); grow.className = "grow";
    const allOn = document.createElement("button"); allOn.className = "btn small"; allOn.textContent = en("全开");
    allOn.onclick = () => bulk(cat, true);
    const allOff = document.createElement("button"); allOff.className = "btn small"; allOff.textContent = en("全关");
    allOff.onclick = () => bulk(cat, false);
    head.appendChild(title); head.appendChild(state); head.appendChild(grow); head.appendChild(allOn); head.appendChild(allOff);
    box.appendChild(head);
    for (const t of items) {
      const row = document.createElement("div");
      row.className = "row" + (t.enabled ? "" : " off") + (t.core ? " core" : "");
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = t.name;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = (t.host ? en("界面") + " · " : "") + (t.danger ? en("需批准") + " · " : "") + ((t.bytes || 0) / 1024).toFixed(1) + " KB";
      row.title = (LANG === "en" && TOOL_DESC_EN[t.name]) || t.description || "";
      const sw = document.createElement("input");
      sw.type = "checkbox"; sw.className = "sw"; sw.checked = !!t.enabled;
      sw.disabled = !!t.core;
      if (t.core) row.title += "\n" + en("基本工具，不可关闭");
      sw.onchange = async () => {
        try {
          const r = await invoke("agent_tool_set", { name: t.name, on: sw.checked });
          toast(String((r && r.note) || ""));
          agToolRows = [];
          renderToolsPage();
        } catch (e) { toast(String(e)); sw.checked = !sw.checked; }
      };
      row.appendChild(nm); row.appendChild(tag); row.appendChild(sw);
      box.appendChild(row);
    }
  }
}

/* ── 设置 → MCP：全部管理（列表 / 新增 / 编辑 / 测试 / 删除 / 打开配置目录）── */
function renderMcpPage() {
  const box = agEl("set-mcp-list");
  if (!box) return;
  box.innerHTML = "";
  if (!agMcps.length) {
    box.innerHTML = '<div class="empty">' + en("（还没有 MCP 服务：填下面的 ID / 命令 / 参数，点保存）") + '</div>';
  }
  for (const m of agMcps) {
    const row = document.createElement("div");
    row.className = "row" + (m.enabled ? "" : " off");
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = m.id;
    const tag = document.createElement("span");
    tag.className = "tag";
    const endpoint = m.command ? [m.command, ...(m.args || [])].join(" ") : (m.url || "");
    tag.textContent = en(m.enabled ? "已启用" : "已停用") + " · " + endpoint.slice(0, 48);
    row.title = endpoint;
    row.appendChild(nm); row.appendChild(tag);
    row.onclick = () => {
      agEl("set-mcp-id").value = m.id;
      agEl("set-mcp-url").value = m.url || "";
      agEl("set-mcp-cmd").value = m.command || "";
      agEl("set-mcp-args").value = (m.args || []).join(" ");
      agEl("set-mcp-env").value = Object.entries(m.headers && Object.keys(m.headers).length ? m.headers : (m.env || {})).map(([k, v]) => `${k}=${v}`).join("\n");
    };
    box.appendChild(row);
  }
  invoke("mcp_path_hint").then((p) => {
    const el = agEl("set-mcp-path");
    if (el) el.textContent = p || "（未知）";
  }).catch(() => {});
}

function bindSkillsPage() {
  if (!agEl("set-skill-save")) return;
  // 全局指导（AGENTS.md）：人格/口吻/通用规矩写这儿 —— 每轮都在场，不再靠"常驻技能"
  const loadGuidance = async () => {
    try {
      const g = await invoke("agent_guidance_get", { workspace: null });
      if (agEl("set-guidance")) agEl("set-guidance").value = g.global || "";
      if (agEl("set-guidance-path")) {
        agEl("set-guidance-path").textContent = (g.globalPath || "").replace(/[\\/][^\\/]*$/, "");
        agEl("set-guidance-path").title = g.globalPath || "";
      }
    } catch (_) {}
  };
  loadGuidance();
  if (agEl("set-guidance-save")) agEl("set-guidance-save").onclick = async () => {
    try {
      const r = await invoke("agent_guidance_set", { text: agEl("set-guidance").value, workspace: false });
      toast(en("已保存：") + r.path);
    } catch (e) { toast(String(e)); }
  };
  if (agEl("set-guidance-open")) agEl("set-guidance-open").onclick = async () => {
    try {
      const g = await invoke("agent_guidance_get", { workspace: null });
      await invoke("open_folder", { path: String(g.globalPath || "").replace(/[\\/][^\\/]*$/, "") });
    } catch (e) { toast(String(e)); }
  };
  if (agEl("set-skill-convert")) agEl("set-skill-convert").onclick = async () => {
    const name = (agEl("set-skill-name") || {}).value && agEl("set-skill-name").value.trim();
    const ws = (agEl("set-skill-convert-ws") || {}).value;
    if (!name) return toast(en("先在下面的「编辑技能」里点一个技能（或填名字），再转"));
    if (!ws) return toast(en("没有可选的工作区（先在左边栏建一个）"));
    const r = await agConfirm(`把 ${name} 转为 ${ws} 的工作区专属？\n（会先归档一份到 skill-archive，再从全局移除）`, en("转为工作区专属"), false);
    if (!r) return;
    try {
      const out = await invoke("agent_skill_convert", { name, workspace: ws });
      toast(en("已转换：") + (out.detail || ""));
      agEl("set-skill-body").value = "";
      agEl("set-skill-name").value = "";
      agWsList = [];
      await agLoadSkills();
    } catch (e) { toast(String(e)); }
  };
  if (agEl("set-wsskill-ws")) agEl("set-wsskill-ws").onchange = () => renderWorkSkillsPage();
  if (agEl("set-wsskill-open")) agEl("set-wsskill-open").onclick = async () => {
    const ws = (agEl("set-wsskill-ws") || {}).value;
    if (!ws) return;
    try { await invoke("open_folder", { path: ws + "\\.kdock_skill" }); } catch (e) { toast(String(e)); }
  };
  if (agEl("set-tool-filter")) agEl("set-tool-filter").oninput = () => renderToolsPage();
  agEl("set-skill-save").onclick = async () => {
    const n = agEl("set-skill-name").value.trim();
    if (!n) return toast("先填技能名");
    try {
      // 按编辑器当前所在的层保存（全局 / 本项目）
      await invoke("agent_skill_save", {
        name: n, content: agEl("set-skill-body").value,
        scope: agEditSkill.scope, workspace: agEditSkill.workspace || null,
      });
      toast("技能已保存");
      await agLoadSkills();
    } catch (e) { toast(String(e)); }
  };
  agEl("set-skill-new").onclick = () => {
    const n = agEl("set-skill-name").value.trim() || "new-skill";
    agEl("set-skill-name").value = n;
    agEl("set-skill-body").value =
      `---\nname: ${n}\ndescription: 什么时候用这个技能\n---\n\n（在这里写步骤 / 命令 / 注意事项）\n`;
  };
  agEl("set-skill-del").onclick = async () => {
    const n = agEl("set-skill-name").value.trim();
    const where = agEditSkill.scope === "workspace" ? "本项目（删前会自动归档一份）" : "全局";
    if (!n || !(await agConfirm(`删掉技能 ${n}？（${where}，目录会一起删）`, "删除技能", true))) return;
    await invoke("agent_skill_delete", {
      name: n, scope: agEditSkill.scope, workspace: agEditSkill.workspace || null,
    }).catch((e) => toast(String(e)));
    agEl("set-skill-body").value = "";
    await agLoadSkills();
  };
  agEl("set-skill-import").onclick = async () => {
    try {
      const p = await dlgOpen({
        title: "导入技能：选 SKILL.md（或技能目录里的那个文件）", multiple: false, directory: false,
        filters: [{ name: "技能", extensions: ["md"] }, { name: "所有文件", extensions: ["*"] }],
      });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      const r = await invoke("agent_skill_import", { path: path0 });
      toast("已导入 → " + r.path);
      await agLoadSkills();
    } catch (e) { toast(String(e)); }
  };
  agEl("set-skill-open").onclick = async () => {
    try {
      const p = await invoke("agent_skills_dir");
      await invoke("open_folder", { path: p });
    } catch (e) { toast(String(e)); }
  };
  // 斜杠指令目录（自定义指令放这儿）
  invoke("agent_slash_dir").then((p) => {
    const el = agEl("set-slash-dir");
    if (el) { el.textContent = p || "（未知）"; el.title = p || ""; }
  }).catch(() => {});
  if (agEl("set-slash-open")) agEl("set-slash-open").onclick = async () => {
    try {
      const p = await invoke("agent_slash_dir");
      await invoke("open_folder", { path: p });
    } catch (e) { toast(String(e)); }
  };
}

function bindMcpPage() {
  if (!agEl("set-mcp-save")) return;
  agEl("set-mcp-save").onclick = async () => {
    const id = agEl("set-mcp-id").value.trim();
    if (!id) return toast("MCP 的 ID 不能空");
    const url = agEl("set-mcp-url").value.trim();
    const command = agEl("set-mcp-cmd").value.trim();
    if (!url && !command) return toast("远程模式填 URL，本地模式填命令");
    const old = (agMcps || []).find((m) => m.id === id);
    const pairs = agEl("set-mcp-env").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const extra = {};
    for (const line of pairs) { const i = line.indexOf("="); if (i > 0) extra[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const server = {
      id,
      name: old ? old.name : id,
      command,
      args: command ? agEl("set-mcp-args").value.split(/\s+/).filter(Boolean) : [],
      env: command ? extra : ((old && old.env) || {}),
      url: url || undefined,
      headers: command ? ((old && old.headers) || {}) : extra,
      enabled: old ? !!old.enabled : true,
    };
    try {
      await invoke("mcp_save", { server });
      toast("MCP 服务已保存");
      await agLoadMcps();
    } catch (e) { toast(String(e)); }
  };
  agEl("set-mcp-test").onclick = async () => {
    const id = agEl("set-mcp-id").value.trim();
    if (!id) return toast("先填 ID（或点列表里的一项）");
    toast("正在起进程握手…");
    try { toast(await invoke("mcp_test", { id })); } catch (e) { toast(String(e)); }
  };
  agEl("set-mcp-del").onclick = async () => {
    const id = agEl("set-mcp-id").value.trim();
    if (!id || !(await agConfirm(`删掉 MCP 服务 ${id}？`, "删除 MCP 服务", true))) return;
    await invoke("mcp_delete", { id }).catch((e) => toast(String(e)));
    await agLoadMcps();
  };
  agEl("set-mcp-open").onclick = async () => {
    try {
      const p = await invoke("mcp_path_hint");
      const dir = String(p).replace(/[\\/][^\\/]*$/, "");
      await invoke("open_folder", { path: dir });
    } catch (e) { toast(String(e)); }
  };
}

/**
 * Agent 工具说明的英文对照。后端返回的是中文说明（那份同时给模型看），
 * 界面按工具名查这张表显示英文；查不到就用原文。
 */
const TOOL_DESC_EN = {
  link_open: "Open the agent's own link (serial/network). Any previous link is closed first.",
  link_close: "Close the agent's link.",
  link_status: "Check whether the agent's link is up.",
  link_send: "Write data to the link (text or HEX).",
  link_read: "Read from the link (until the silence timeout or an `until` hit).",
  device_list: "List a directory on the device (serial uses cshell ls, network uses the port 6666 service channel).",
  device_pull: "Pull a file from the device (verified with CRC32).",
  device_push: "Push a local file to the device.",
  firmware_info: "Read version / size / CRC32 of a .fw package.",
  firmware_upgrade: "Upgrade the device with a .fw package (serial or network). **Reboots the device** — verify the version afterwards.",
  local_run: "Run a command on this PC (cmd /C) and return the exit code and output.",
  flash: "Flash the chip with an external programmer (J-Link / openocd / STM32CubeProgrammer).",
  scope: "Send a SCPI command to the oscilloscope (Rigol) and return its reply.",
  scope_connect: "Connect to the oscilloscope (RIGOL DS1000Z series, SCPI over TCP). Returns *IDN?.",
  scope_info: "Read the scope state: model, channels (on/off, scale, offset, coupling, probe), timebase, sample rate, trigger.",
  scope_measure: "Auto-measure one channel: Vpp / frequency / period / RMS / average / min / max / rise / fall / duty. Items with no signal come back null.",
  scope_waveform: "Read a waveform: a summary (points, span, min/max, Vpp, average, estimated frequency) plus an ASCII plot.",
  scope_screenshot: "Screenshot the scope as a PNG and report where it was saved.",
  scope_control: "Change scope settings: channel scale/offset/display/coupling/probe, timebase, trigger source & level, sweep, RUN/STOP, autoset.",
  workspace_list: "List files in the agent workspace.",
  workspace_read: "Read a text file from the workspace.",
  workspace_write: "Write a file into the workspace (creates directories).",
  workspace_mkdir: "Create a directory in the workspace.",
  skill_list: "List installed skills (name + description).",
  skill_read: "Read the full SKILL.md of a skill.",
  skill_create: "Create a skill (a SKILL.md with frontmatter).",
  skill_update: "Overwrite a skill's SKILL.md.",
  skill_delete: "Delete a skill.",
  browser_open: "Open a page in the built-in browser (extracts the main text; also shown in the Browser pane).",
  browser_read: "Read the main text of the current page (omit url to use the current page).",
  browser_find: "Find a snippet in the current page text and return the surrounding context.",
  history_search: "Search this session's raw log by keyword (including parts already compacted away).",
  ui_show_text: "Show a block of text in the Text pane on the right.",
  ui_goto: "Switch the UI to a page (transfer/upgrade/flash/files/runtime/chart/flow/capture/scope).",
  runtime_graph_analyze: "Analyze a local ELF/PE/AXF/OUT/BIN firmware and cache its function/call graph for the Agent. BIN requires a load base and architecture; files are not uploaded.",
  runtime_graph_query: "Query the last analyzed runtime graph by function name or address. Returns calls, callers, call sites, block counts and interrupt metadata.",
  flow_run: "Run the flow (the current canvas when no graph is given).",
  flow_status: "Check flow progress / the tail of its log.",
  flow_stop: "Stop the running flow.",
  capture_save: "Grab a screenshot (saved into the workspace).",
  // 主连接（用户在传输页开的那条）—— 2026-10 补
  port_list: "List the serial ports on this PC (with friendly names / VID:PID). Use this instead of scanning with PowerShell.",
  port_state: "Read the state of the **user's main link** (the one opened on the transfer page): type / parameters / connected / bytes.",
  port_write: "Send data to the **main link** (text or HEX). What is sent shows up live on the user's transfer page (TX lines), so the user can watch it.",
  port_read: "Read the recent TX/RX of the **main link** (the very log the user sees): direction + ms timestamp + content per line.",
  port_open: "Open the **main link** (serial / TCP client / TCP server / UDP). The mode and parameters sync to the UI so the user sees them. Call port_close first if it is already open.",
  port_close: "Close the **main link**.",
  net_local_ips: "List this PC's IPv4 addresses — which local address to bind (TCP server / UDP) and which one to hand to the user (0.0.0.0 = all NICs).",
  // 逻辑分析仪
  la_state: "Read the logic analyzer state: source, sample rate, channels/points/duration, view window, cursors A/B and Δt, channel list (with current level), decoders, and the selected channel's measurements. Read-only.",
  la_read: "Read the decoded results (read-only): every item each decoder produced (protocol bytes/fields + start/end time + CRC/parity/ACK verdicts) plus per-channel frequency/duty/pulses in the current view window.",
  la_decoders: "List which protocols are supported, what parameters each takes (channel / baud / mode / bit order …) and their defaults, plus the built-in demo scenario ids. Call this before la_config so you do not guess parameter names. Read-only.",
  la_config: "Change the logic-analyzer **configuration** (never the captured samples): sample rate, replace the whole decoder list (19 protocols: uart/spi/i2c/can/1wire/ds18b20/dht/ps2/nec/i2s/jtag/swd/modbus/lin/dmx512/manchester/diff_manchester/miller/pwm — see la_decoders), channel visibility, selected channel, view window, cursors.",
  la_capture: "Start a capture. source=demo loads a built-in demo scenario (scenario: bus = UART/PWM/I2C/SPI/DS18B20/NEC, more = CAN/JTAG/I2S/PS2, enc = Manchester/DHT/LIN/Modbus/SWD/DMX); source=device captures from a real analyzer through sigrok-cli (fx2lafw / Saleae / DSLogic…) — optional device / rate / samples / channels.",
  la_save: "Save the current logic-analyzer data to a file (path required). format=csv (time + channels) or vcd (opens in PulseView / DSView / GTKWave); only the first 200k points are saved beyond that.",
  // 中控编排（画布读写）
  flow_get: "Read the flow currently on the canvas: nodes (with params and coordinates) + edges (from/port/to) + the available node kinds (and each kind's ports).",
  flow_add_node: "Add a node to the existing canvas (leaves everything else alone). type comes from flow_get kinds; x/y default to the right of the rightmost node; params are merged onto the node.",
  flow_connect: "Connect from.port → to on the existing canvas. Port names come from flow_get kinds[type].outs; self-loops, duplicates and unknown ports are rejected.",
  flow_delete: "Delete a node or an edge from the canvas (pass a node id or an edge key; the start node cannot be deleted).",
  flow_set: "Import a whole flow onto the canvas (**replaces what is there** and saves it; the user sees/edits/runs it right away). Format: {nodes:[{id,type,x,y,...}],edges:[{from,port,to}]}; unknown kinds and dangling edges are dropped and reported.",
  workspace_edit: "Structured file edit: replace old_text with new_text and return a unified diff. Supports an edits array for batch edits across positions/files; old_text must be unique (unless replace_all=true).",
  workspace_diff: "Review workspace changes: git status + unified diff inside a git repo (optional path to narrow it down); non-git folders return a clear error.",
  workspace_search: "Substring search in the workspace (skips .git/target/node_modules), returns path:line: text. Safer and faster than running grep through local_run.",
  workspace_run: "Run a local command (cmd /C) inside the workspace, returning exit code and output. The command still has full local privileges; needs approval.",
  workspace_test: "Run project tests: auto-detects Cargo.toml / package.json / pytest, or takes an explicit cmd; runs in the workspace and returns the exit code plus the tail of the output.",
  workspace_context: "One-shot context: directory listing + optional search hits + file contents. Use it to look around before editing instead of many workspace_list/search/read calls.",
  workspace_check: "One-shot verification: git status/diff + project tests (auto-detected or explicit cmd) returned as two sections. Prefer this after edits over separate diff + test calls.",
  plan_write: "Update the current session plan/todos. items is an array of {id?, title, status}; status is pending / in_progress / completed. List a plan first for multi-step work, then update it each step.",
  plan_read: "Read the current session plan/todos.",
  subagent_spawn: "Spawn a subsession to run an independent task in the background (inherits the workspace and permissions; returns the subsession id). Good for parallel independent investigations; use subagent_wait for the result.",
  subagent_wait: "Wait for a subsession to finish (up to timeout_ms) and return its status and last reply.",
  subagent_result: "Read a subsession's final reply and tool-call summary (does not wait).",
  parallel_read: "Run several read-only tools in parallel (workspace_read / workspace_list / workspace_search / output_read / port_list / port_state / port_read / net_local_ips / adb_devices / adb_mdns / screen_list / skill_list / history_search) and return all results at once. Cuts model round-trips when reading many files.",
  adb_devices: "List Android devices (USB plus already-connected wireless debugging). Start here for anything Android.",
  adb_mdns: "List wireless-debugging advertisements (Android 11+ `adb mdns services`): see the device name and IP:port before pairing.",
  adb_connect: "Connect to a wireless-debugging device (`adb connect`). Requires Developer options → Wireless debugging to be on and the device to be paired already.",
  adb_pair: "Pair a new device (Android 11+ \"Pair device with pairing code\"): pass the IP:port and 6-digit code shown on the device. Afterwards use adb_connect with the port shown on the Wireless debugging screen.",
  adb_shell: "Run a shell command on the Android device (getprop / dumpsys / pm list packages / ls /sdcard / screencap …) and return exit code and output. Get the serial from adb_devices.",
  adb_screenshot: "Screenshot the Android device (adb exec-out screencap) and save it as a PNG, by default into this session's workspace.",
  adb_push: "Local file → Android device.",
  adb_pull: "Android device file → local machine (by default into this session's workspace).",
  adb_install: "Install an APK on the Android device (reinstall=true overwrites).",
  screen_open: "Open a screen session and get a session id. kind=vnc lets you send mouse/keyboard back (screen_pointer / screen_key / screen_type); kind=desktop/rtsp/rtmp/h264 is view-only (for rtsp/rtmp/h264 width/height is the decode canvas, not the source resolution). Sessions stay alive — close them with screen_close.",
  screen_list: "List live screen sessions (id / kind / label).",
  screen_shot: "Save the current frame of a screen session as PNG (into the workspace by default); the reply includes a coarse ASCII preview: @ = bright/white, space = dark/black. The preview only shows layout (where windows are, whether the picture changed) — it cannot read text; use screen_ocr or a vision model for that.",
  screen_ocr: "Run Windows built-in OCR on the current screen capture and return the recognized text (needs the system OCR language pack). Adds text reading on top of screen_shot's ASCII preview; it does not replace a vision model.",
  image_ocr: "Run Windows built-in OCR on an image in the workspace (PNG/JPG) and return the text. Put a screenshot/image in the workspace first.",
  screen_pointer: "Move the mouse on the remote screen to (x,y); click=true clicks the left button. Really operates the remote machine; only works on kind=vnc sessions.",
  screen_key: "Press one key: enter / tab / esc / backspace / delete / space / up / down / left / right / home / end / pgup / pgdn / insert / f1…",
  screen_type: "Type text into the remote screen character by character (VNC; case preserved, use screen_key enter for a newline). Really types on the remote machine.",
  screen_close: "Close a screen session (omit session to close all).",
  output_read: "Read the full text of a truncated tool output (large outputs are spilled to the tool-output folder and the result carries the path). offset/limit are in characters, default 0/1200; read the next slice if it does not fit instead of pasting everything back. Read only what you need (for logs, look at head/tail first) — this is what keeps cache hits high.",
  ssh_run: "Run one command on a remote machine over SSH and return the exit code and output. Password login goes through PuTTY plink (Windows' built-in ssh.exe only prompts in a console); without a password it uses ssh.exe with a key (pass key). The host fingerprint is remembered on first connect and mismatches are refused. Set background=true when starting a daemon/service (the tool detaches it and returns started); redirect logs to a file in cmd. Do not set background for ordinary commands.",
  // 环境配置（驱动 / 工具链）
  env_scan: "Scan this PC for drivers and toolchains (read-only): CH34x/CH340, FTDI FT2232/D2XX, Infineon TriBoard/DAS JDS, SEGGER J-Link/J-Link OB, CMSIS-DAP/DAPLink, GNU Arm toolchain, OpenOCD, logic analyzer (PulseView/sigrok), RT-Thread Env, ST-Link driver, Zadig. Reports installed/version/path per item and which **required** ones are missing. Same data the Environment setup page shows.",
  env_install: "Install / update one item (really downloads and installs, may raise one UAC prompt). id comes from env_scan. The UI switches to the Environment setup page so the user watches the progress.",
};

// ── 关于本软件：作者 / 仓库 / 版本 ────────────────────────────────
// 开源信息集中在「设置 → 通用（简短）」和「设置 → 关于与数据（完整）」两处；
// 版本管理的约定写在关于页（应用版本走 semver，固件包版本是另一套）。
const KDOCK_REPO = "https://github.com/Kyin-code/KDock";
const KDOCK_AUTHOR = "https://github.com/Kyin-code";
let appVersion = "0.1.0";

function openExternal(url) {
  invoke("browser_open_external", { path: url }).catch((e) => toast(String(e)));
}

function aboutRow(box, k, v, cls, title) {
  const r = document.createElement("div");
  r.className = "row";
  const a = document.createElement("span");
  a.className = "k"; a.textContent = k;
  const b = document.createElement("span");
  b.className = "v" + (cls ? " " + cls : "");
  b.textContent = v;
  if (title) b.title = title;
  r.append(a, b);
  box.appendChild(r);
}

function agRenderAbout() {
  const full = document.getElementById("set-about");
  if (full) {
    full.textContent = "";
    aboutRow(full, en("版本"), "v" + appVersion, "ok");
    aboutRow(full, en("作者"), "Kyin (任开炎)", "", KDOCK_AUTHOR);
    aboutRow(full, en("仓库"), KDOCK_REPO, "", KDOCK_REPO);
    aboutRow(full, en("协议"), en("Apache-2.0（见仓库里的 LICENSE / NOTICE）"));
    aboutRow(full, en("构建"), "Tauri 2 · Rust + 原生 JS");
  }
  const mini = document.getElementById("set-about-mini");
  if (mini) {
    mini.textContent = "";
    aboutRow(mini, en("版本"), "v" + appVersion, "ok");
    aboutRow(mini, en("作者"), "Kyin (任开炎)");
    aboutRow(mini, en("仓库"), KDOCK_REPO, "", KDOCK_REPO);
  }
  const ver = document.getElementById("set-versioning");
  if (ver) {
    ver.textContent = "";
    aboutRow(ver, en("当前版本"), "v" + appVersion, "ok");
    aboutRow(ver, en("版本号来源"), en("tauri.conf.json · Cargo.toml · package.json（三处保持一致）"));
    aboutRow(ver, en("变更记录"), en("CHANGELOG.md（每次发版追加一段）"));
    aboutRow(ver, en("发版约定"), en("打 tag：") + "v" + appVersion);
    aboutRow(ver, en("固件包版本"), en("三段式 PD_HW.PD_SW.PD_FIX（写在 .fw 包头里，与应用版本无关）"));
  }
}

async function agLoadVersion() {
  try { appVersion = await getVersion(); } catch (_) { /* 拿不到就用默认 */ }
  agRenderAbout();
}

/* ── 通用小表单弹窗（新增/编辑指令、组名等用） ─────────────────────────
 * 返回 { id: value } 或 null（取消）。样式复用 .kdmodal。 */
function kdForm({ title, fields, okText }) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "kdmodal";
    const box = document.createElement("div");
    box.className = "kdbox";
    const t = document.createElement("div");
    t.className = "kdttl"; t.textContent = title || "";
    box.appendChild(t);
    const inputs = {};
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "kdfield";
      const lb = document.createElement("label");
      lb.textContent = f.label || f.id;
      const inp = document.createElement("input");
      if (f.type === "checkbox") {
        inp.type = "checkbox";
        inp.checked = !!f.value;
      } else {
        inp.value = f.value == null ? "" : String(f.value);
        if (f.ph) inp.placeholder = f.ph;
      }
      inputs[f.id] = inp;
      row.append(lb, inp);
      box.appendChild(row);
    }
    const acts = document.createElement("div");
    acts.className = "kdacts";
    const cancel = document.createElement("button");
    cancel.className = "btn small"; cancel.textContent = en("取消");
    const ok = document.createElement("button");
    ok.className = "btn small primary"; ok.textContent = okText || en("确定");
    acts.append(cancel, ok);
    box.appendChild(acts);
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = (val) => { mask.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
    const collect = () => {
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === "checkbox" ? el.checked : el.value;
      return out;
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && document.activeElement && document.activeElement.tagName === "INPUT" &&
          document.activeElement.type !== "checkbox") {
        e.preventDefault(); close(collect());
      }
    };
    document.addEventListener("keydown", onKey);
    cancel.onclick = () => close(null);
    ok.onclick = () => close(collect());
    mask.onclick = (e) => { if (e.target === mask) close(null); };
    (Object.values(inputs)[0] || ok).focus();
  });
}

/* ── 设置 → 缓存：列出全部持久化数据，按类删除 ─────────────────────── */
let cacheRows = [];

async function cacheRender() {
  const box = document.getElementById("cache-list");
  if (!box) return;
  box.innerHTML = "";
  let items = [];
  try { items = await invoke("cache_items"); } catch (e) { box.innerHTML = '<p class="hint">' + String(e) + '</p>'; return; }
  cacheRows = items;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "agentrow cacherow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.key = it.key;
    cb.onchange = cacheSum;
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("div");
    t.className = "nm"; t.textContent = en(it.title);
    const p = document.createElement("div");
    p.className = "meta cmdp";
    p.textContent = (it.exists ? "" : en("（不存在）")) + it.path +
      (it.files ? `  ·  ${it.files} ${en("个文件")} / ${fmtBytes(it.bytes)}` : "");
    p.title = it.path;
    const w = document.createElement("div");
    w.className = "warn";
    w.textContent = en(it.warn || "");
    info.append(t, p, w);
    row.append(cb, info);
    box.appendChild(row);
  }
  cacheSum();
}

const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : (b || 0) + " B");

function cacheSum() {
  const n = [...document.querySelectorAll("#cache-list input[type=checkbox]")].filter((c) => c.checked).length;
  const sum = document.getElementById("cache-sum");
  if (sum) sum.textContent = n ? `${en("已选")} ${n} ${en("项")}` : "";
}

/** 删除确认：把选中的项列出来，每一项都能再勾一次（危险项默认勾上但要求显式确认） */
function kdConfirmDelete(items) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "kdmodal";
    const box = document.createElement("div");
    box.className = "kdbox wide";
    const t = document.createElement("div");
    t.className = "kdttl"; t.textContent = en("确认删除这些缓存？");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = en("勾选框里的会被删掉；删完软件会自动重启。带 ⚠ 的会丢数据（对话、密钥、供应商配置、技能副本），请确认你不需要它们。");
    box.append(t, hint);
    const list = document.createElement("div");
    list.className = "kdlist";
    const boxes = [];
    for (const it of items) {
      const r = document.createElement("label");
      r.className = "kditem";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = true; cb.dataset.key = it.key;
      const span = document.createElement("span");
      span.innerHTML = (it.confirm ? "⚠ " : "") + escapeHtml(en(it.title)) +
        `<br><code>${escapeHtml(it.path)}</code>` +
        (it.warn ? `<br><span class="mhint">${escapeHtml(en(it.warn))}</span>` : "");
      boxes.push(cb);
      r.append(cb, span);
      list.appendChild(r);
    }
    box.appendChild(list);
    const acts = document.createElement("div");
    acts.className = "kdacts";
    const cancel = document.createElement("button");
    cancel.className = "btn small"; cancel.textContent = en("取消");
    const ok = document.createElement("button");
    ok.className = "btn small danger"; ok.textContent = en("删除并重启");
    acts.append(cancel, ok);
    box.appendChild(acts);
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = (v) => { mask.remove(); resolve(v); };
    cancel.onclick = () => close(null);
    ok.onclick = () => {
      const keys = boxes.filter((b) => b.checked).map((b) => b.dataset.key);
      if (!keys.length) { toast(en("一个都没勾")); return; }
      close(keys);
    };
    mask.onclick = (e) => { if (e.target === mask) close(null); };
  });
}

async function cacheDeleteFlow() {
  const picked = [...document.querySelectorAll("#cache-list input[type=checkbox]")]
    .filter((c) => c.checked)
    .map((c) => cacheRows.find((x) => x.key === c.dataset.key))
    .filter(Boolean);
  if (!picked.length) return toast(en("先勾选要删的项"));
  const keys = await kdConfirmDelete(picked);
  if (!keys) return;
  // "浏览器本地存储"这一项由前端清（后端只负责文件）
  const clearLocal = keys.includes("local");
  const fileKeys = keys.filter((k) => k !== "local");
  try {
    if (fileKeys.length) await invoke("cache_delete", { keys: fileKeys });
    if (clearLocal) {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("kdock_") || k.startsWith("h7test_")) localStorage.removeItem(k);
      }
    }
    toast(en("已删除，正在重启…"));
    await new Promise((r) => setTimeout(r, 600));
    await invoke("app_restart");
  } catch (e) { toast(String(e)); }
}

function bindCache() {
  const reload = document.getElementById("cache-reload");
  if (!reload) return;
  reload.onclick = cacheRender;
  document.getElementById("cache-all").onclick = () => {
    document.querySelectorAll("#cache-list input[type=checkbox]").forEach((c) => { c.checked = true; });
    cacheSum();
  };
  document.getElementById("cache-none").onclick = () => {
    document.querySelectorAll("#cache-list input[type=checkbox]").forEach((c) => { c.checked = false; });
    cacheSum();
  };
  document.getElementById("cache-del").onclick = cacheDeleteFlow;
}

/* ── 设备 IP / 端口 历史：下次输入时给提示 ─────────────────────────── */
const DEV_HIST_IDS = ["tcp-client-host", "tcp-client-port", "upg-host", "upg-port",
                      "fl-host", "fl-port", "sq-host", "sq-port", "sc-host",
                      // SSH / FTP / VNC / 流地址这几处也记一份（下次输入直接下拉）
                      "ssh-host", "ssh-user", "fl-net-host", "fl-net-user",
                      "cap-vnc-host", "cap-rtsp-url", "cap-rtmp-url", "cap-h264-url"];
let devHist = {};

function devHistLoad() {
  try { devHist = JSON.parse(localStorage.getItem("kdock_dev_hist") || "{}") || {}; } catch (_) { devHist = {}; }
}

function devHistRemember(id, val) {
  const v = String(val || "").trim();
  if (!v) return;
  const arr = (devHist[id] || []).filter((x) => x !== v);
  arr.unshift(v);
  devHist[id] = arr.slice(0, 12);
  localStorage.setItem("kdock_dev_hist", JSON.stringify(devHist));
}

function devHistRefresh(id) {
  const inp = document.getElementById(id);
  if (!inp) return;
  let dl = document.getElementById(id + "-hist");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = id + "-hist";
    document.body.appendChild(dl);
    inp.setAttribute("list", id + "-hist");
  }
  dl.textContent = "";
  for (const v of devHist[id] || []) {
    const o = document.createElement("option");
    o.value = v;
    dl.appendChild(o);
  }
}

function bindDevHistory() {
  devHistLoad();
  // 除了写死的那批 id，还认 HTML 里的 data-hist="历史键"（新加的输入框用这个更清楚）
  const nodes = [
    ...DEV_HIST_IDS.map((id) => document.getElementById(id)),
    ...document.querySelectorAll("[data-hist]"),
  ].filter(Boolean);
  const seen = new Set();
  for (const inp of nodes) {
    const id = inp.dataset.hist || inp.id;
    if (!id || seen.has(inp)) continue;
    seen.add(inp);
    devHistRefresh(id);
    inp.addEventListener("focus", () => devHistRefresh(id));
    inp.addEventListener("change", () => { devHistRemember(id, inp.value); devHistRefresh(id); });
    inp.addEventListener("blur", () => { devHistRemember(id, inp.value); });
  }
}

async function agLoadTools() {
  agTools = await invoke("agent_tools").catch(() => []);
  const box = agEl("ag-tool-list");
  if (!box) return;
  box.innerHTML = "";
  for (const t of agTools) {
    const row = document.createElement("div");
    row.className = "row";
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = t.name;
    const tag = document.createElement("span");
    tag.className = "tag"; tag.textContent = en(t.host ? "界面" : "本机");
    row.title = (LANG === "en" && TOOL_DESC_EN[t.name]) || t.description;
    row.appendChild(nm); row.appendChild(tag);
    box.appendChild(row);
  }
}

// ---------- 右侧三页：浏览器 / 技能与 MCP / 文本 ----------
let agMcps = [];
let agBrPage = null;        // 浏览器当前页
let agBrSource = false;     // 是否显示源码

function agShowPane(name) {
  document.querySelectorAll(".agptab").forEach((b) => b.classList.toggle("active", b.dataset.agp === name));
  document.querySelectorAll(".agppane").forEach((p) => { p.hidden = p.dataset.agpane !== name; });
  if (LANG === "en") langWalk();
}

/* ── AMD Radeon Cloud（tokenfactory）实时负载 ─────────────────────────
 * 数据源是页面上每条 "Live capacity: N%"（该模型并发额度用了多少）的那份公开 JSON；
 * 响应里没有 CORS 头，浏览器直连会被拦，所以走后端 `amd_load`。
 * 刷新**由代码定时做**（15 秒一次），而且只在页面真的露着的时候才请求 ——
 * 两个显示位置（设置→模型、Agent 信息页）都关着就不打扰人家接口。 */
let amdLoadData = null;
const amdTone = (s) => (s === "full" ? "bad" : s === "busy" ? "warn" : "ok");
const amdLabel = (m) => (m && m.label) || (m && m.state === "full" ? "At capacity" : m && m.state) || "";

async function amdLoadPull(force) {
  if (window.__amdLoading) return;
  window.__amdLoading = true;
  agSyncModelBusy();   // ⚠️ 这里就要转起来（放 finally 里等于"取完了才转"）
  // 这个接口本身要 20 多秒才回（实测 22~24s），没数据的时候先说明白，别让人以为坏了
  if (!amdLoadData) {
    for (const id of ["amd-load-list", "ag-amd"]) {
      const box = document.getElementById(id);
      if (box) box.textContent = en("正在取（这个接口本身要 20 多秒）…");
    }
  }
  try {
    amdLoadData = await invoke("amd_load", { force: !!force });
    const at = document.getElementById("amd-load-at");
    if (at) at.textContent = en("上次更新 ") + new Date().toLocaleTimeString();
  } catch (e) {
    const at = document.getElementById("amd-load-at");
    if (at) at.textContent = "取不到：" + String(e).slice(0, 90);
  } finally {
    window.__amdLoading = false;
    agSyncModelBusy();
    amdRenderLoad();
    agRefreshModelLabels();
  }
}

/** 只改下拉里每条文案（速度 / AMD 状态），不重建整个 select —— 免得把当前选中项弄丢 */
function agRefreshModelLabels() {
  const sel = agEl("ag-quick-model");
  if (!sel || !agCfg || !agCfg.providers) return;
  for (const o of Array.from(sel.options)) {
    const p = agCfg.providers.find((x) => x.id === o.value);
    if (p) o.textContent = agModelOptionText(p);
  }
}

function amdRenderLoad() {
  const models = (amdLoadData && amdLoadData.models) || null;
  const entries = models
    ? Object.entries(models).map(([name, v]) => [name, v || {}]).sort((a, b) => (a[1].utilization || 0) - (b[1].utilization || 0))
    : [];
  const box = document.getElementById("amd-load-list");
  if (box) {
    box.textContent = "";
    if (!entries.length) {
      const d = document.createElement("div");
      d.className = "agrow empty";
      d.textContent = "（还没拿到数据）";
      box.appendChild(d);
    }
    for (const [name, m] of entries) {
      const row = document.createElement("div");
      row.className = "agrow";
      const b = document.createElement("b");
      b.textContent = name;
      const d = document.createElement("span");
      d.className = "d " + amdTone(m.state);
      d.textContent = amdLabel(m);
      const sz = document.createElement("span");
      sz.className = "sz";
      sz.textContent = (m.utilization != null ? m.utilization + "%" : "-");
      row.append(b, d, sz);
      box.appendChild(row);
    }
  }
  // 注：AMD 的状态**不放在 Agent 信息页**（那里只放 token 速度这类"这一轮自己的数据"），
  // 状态只出现在两处：设置 → 模型 的那张表，以及选模型的下拉里（见 agModelOptionText）。
}

/// 现在有没有"露着"的地方需要这份数据：
/// 只有「设置 → 模型 → 使用」面板里那块免费模型**被用户展开**了才去取。
function amdNeedsData() {
  const modal = document.getElementById("settings-modal");
  const modelPane = document.querySelector('.setpane[data-setpane="model"]');
  if (!modal || modal.hidden || !modelPane || modelPane.hidden) return false;
  const wrap = document.getElementById("ag-prov-free");
  if (!wrap || wrap.hidden) return false;      // 免费那块收着：一个请求都不发
  const useTab = document.querySelector('.provtab[data-provtab-pane="use"]');
  return !!useTab && !useTab.hidden;
}

function amdBind() {
  const btn = document.getElementById("amd-load-refresh");
  if (btn) btn.onclick = () => amdLoadPull(true);
  // 代码定时刷：15 秒一拍，只在看得见的时候发请求
  setInterval(() => { if (amdNeedsData()) amdLoadPull(false); }, 15000);
}

function agRenderPage(page) {
  if (!page) return;
  agBrPage = page;
  const t = agEl("ag-br-title");
  if (t) t.textContent = (page.title || "(无标题)") + "  ·  " + page.url;
  const body = agEl("ag-br-body");
  if (body) {
    body.textContent = agBrSource ? (page.html || "") : (page.text || "(正文是空的)");
    body.scrollTop = 0;
  }
  const st = agEl("ag-br-state");
  if (st) st.textContent = `${(page.text || "").length} 字 · ${(page.links || []).length} 链接`;
  if (agEl("ag-br-url")) agEl("ag-br-url").value = page.url || "";
  const links = agEl("ag-br-links");
  if (links) {
    links.innerHTML = "";
    const list = (page.links || []).slice(0, 60);
    if (!list.length) links.innerHTML = '<div class="empty">（没抓到链接）</div>';
    for (const l of list) {
      const row = document.createElement("div");
      row.className = "row";
      const nm = document.createElement("span");
      nm.className = "nm lnk"; nm.textContent = l.text || l.href;
      nm.title = l.href;
      nm.onclick = async (e) => { e.stopPropagation(); await agBrowserOpen(l.href); };
      row.appendChild(nm);
      links.appendChild(row);
    }
  }
}

async function agBrowserOpen(url) {
  const u = (url || (agEl("ag-br-url") ? agEl("ag-br-url").value : "")).trim();
  if (!u) return toast("先填个网址");
  const st = agEl("ag-br-state");
  if (st) st.textContent = "打开中…";
  try {
    const page = await invoke("browser_fetch", { url: u });
    agBrSource = false;
    if (agEl("ag-br-src")) agEl("ag-br-src").classList.remove("primary");
    agRenderPage(page);
  } catch (e) {
    if (st) st.textContent = "";
    toast(String(e));
  }
}

async function agLoadMcps() {
  agMcps = await invoke("mcp_list").catch(() => []);
  agRenderMcpTable();    // Agent 信息页：只展示 + 开关
  renderMcpPage();       // 设置 → MCP：全部管理
}

function bindAgentPanes() {
  document.querySelectorAll(".agptab").forEach((b) => { b.onclick = () => agShowPane(b.dataset.agp); });
  if (agEl("ag-br-go")) agEl("ag-br-go").onclick = () => agBrowserOpen();
  if (agEl("ag-br-url")) {
    agEl("ag-br-url").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); agBrowserOpen(); }
    });
  }
  if (agEl("ag-br-back")) {
    agEl("ag-br-back").onclick = async () => {
      const prev = await invoke("browser_back").catch(() => null);
      if (prev) agRenderPage(prev);
      else toast("没有上一页了");
    };
  }
  if (agEl("ag-br-ext")) {
    agEl("ag-br-ext").onclick = async () => {
      const url = agBrPage ? agBrPage.url : (agEl("ag-br-url") ? agEl("ag-br-url").value.trim() : "");
      if (!url) return toast("没有网址");
      await invoke("browser_open_external", { path: url }).catch((e) => toast(String(e)));
    };
  }
  if (agEl("ag-br-src")) {
    agEl("ag-br-src").onclick = () => {
      if (!agBrPage) return;
      agBrSource = !agBrSource;
      agEl("ag-br-src").classList.toggle("primary", agBrSource);
      agRenderPage(agBrPage);
    };
  }
  if (agEl("ag-tx-open")) {
    agEl("ag-tx-open").onclick = async () => {
      const p = await dlgOpen({ title: "打开文本文件", multiple: false, directory: false });
      const path0 = typeof p === "string" ? p : (p && p.path);
      if (!path0) return;
      try {
        const buf = await readFile(path0);
        agEl("ag-tx-body").value = new TextDecoder().decode(buf);
        agEl("ag-tx-name").value = path0.replace(/.*[\\/]/, "");
        agEl("ag-tx-hint").textContent = "已打开：" + path0;
      } catch (e) { toast(String(e)); }
    };
  }
  if (agEl("ag-tx-save")) {
    agEl("ag-tx-save").onclick = async () => {
      const p = await dlgSave({ title: "另存为", defaultPath: agEl("ag-tx-name").value || "note.txt" });
      if (!p) return;
      try {
        await writeTextFile(p, agEl("ag-tx-body").value);
        toast("已保存到 " + p);
      } catch (e) { toast(String(e)); }
    };
  }
  if (agEl("ag-tx-ws")) {
    agEl("ag-tx-ws").onclick = async () => {
      if (!agMeta) return toast("先建一个会话");
      const name = (agEl("ag-tx-name").value || "note.txt").replace(/[\\/]/g, "_");
      try {
        const r = await agWriteWorkspace(name, agEl("ag-tx-body").value);
        toast(r);
      } catch (e) { toast(String(e)); }
    };
  }
  if (agEl("ag-tx-clear")) {
    agEl("ag-tx-clear").onclick = () => {
      agEl("ag-tx-body").value = "";
      agEl("ag-tx-name").value = "";
      agEl("ag-tx-hint").textContent = "「存到工作区」会写进当前会话的工作区。";
    };
  }
}

/** 把文本推到"文本"页（agent 的 ui_show_text 和本地按钮都用它） */
function agShowText(title, text) {
  if (agEl("ag-tx-name")) agEl("ag-tx-name").value = title || "";
  if (agEl("ag-tx-body")) agEl("ag-tx-body").value = text || "";
  if (agEl("ag-tx-hint")) agEl("ag-tx-hint").textContent = title ? ("来自 agent：" + title) : "";
  agShowPane("text");
}

/** 把"文本"页的内容写进当前会话的工作区 */
const agWriteWorkspace = (path0, text) =>
  invoke("agent_workspace_write", { sessionId: agMeta ? agMeta.id : "", path: path0, content: text })
    .then((p) => "已存到工作区：" + p);

/** 切到 agent 页时把该刷的刷一遍 */
/** 后端才是"在不在跑"的唯一事实来源：切页/重连后同步一次 */
async function agSyncRunning() {
  try {
    const c = await invoke("agent_running", { session: agMeta ? agMeta.id : null });
    agRunSessions.clear();
    for (const sid of c.sessions || []) agRunSessions.add(sid);
    agRunning = !!(agMeta && agRunSessions.has(agMeta.id));
    agState(agRunning ? en("思考中…") : en("空闲"), agRunning ? "ok" : "");
    if (agEl("ag-stop")) agEl("ag-stop").hidden = !agRunning;
    agSetSendDisabled(agRunning);
    agSyncReasoningControl();
  } catch (_) {}
}

function agOnShow() {
  agSyncRunning();
  agLoadConfig();
  agLoadTree();
  agLoadSkills();
  agLoadMcps();
  agLoadTools();
  agRenderInfo();
  agRefreshGit();
  agRefreshBreakdown();
  agRefreshBalance();
  if (!agBrPage) invoke("browser_current").then((p) => { if (p) agRenderPage(p); }).catch(() => {});
}

/** 左栏点了「会话 / 新建会话」时先把中间切到 Agent 页。
 *  页已经在了就不动（免得白白重跑一遍 agOnShow 里的那堆拉取）。 */
function agFocus() {
  const pane = document.querySelector('[data-work="agent"]');
  if (pane && pane.hidden) showPane("agent");
}

// ---------- host 工具（后端让前端干活） ----------
const AG_HOST = {
  // 逻辑分析仪：读结果（只读）+ 改配置（不动数据）+ 采集 + 存盘
  async la_state() { initLogic(); return laAgentState(); },
  async la_read(a) { initLogic(); return laAgentRead(a || {}); },
  async la_decoders() { return laAgentDecoders(); },
  async la_config(a) { initLogic(); return laAgentConfig(a || {}); },
  async la_capture(a) { initLogic(); return laAgentCapture(a || {}); },
  async la_save(a) { initLogic(); return laAgentSave(a || {}); },
  // 环境配置：扫本机（只读）+ 装 / 更新（要审批；装的时候切到环境页让用户看着）
  async env_scan(a) {
    const d = await invoke("env_scan", { force: !!(a && a.force) });
    envData = d;
    envRenderGrid();
    envRenderFirst();
    const items = d.items || [];
    const line = (x) => {
      const st = x.installed
        ? (x.outdated ? `可更新（当前 ${x.version || "?"} → 至少 ${x.minVersion || "?"}）` : `已装${x.version ? " " + x.version : ""}`)
        : "未安装";
      return `- ${x.id}  ${x.name} [${x.kind}]：${st}` + (x.path ? `\n    ${x.path}` : (x.detail ? `\n    ${x.detail}` : ""));
    };
    return `已装 ${items.filter((x) => x.installed).length}/${items.length}；必需项缺失：${(d.missingRequired || []).length ? (d.missingRequired || []).join(", ") : "无"}\n` +
      items.map(line).join("\n");
  },
  async env_install(a) {
    showPane("env");                       // 用户得看得见进度和日志
    if (!envData) await envRefresh(true);
    return (await envInstall(a.id, { throw: true })) || "（没有返回）";
  },
  async ui_goto(a) {
    const map = { transfer: "link", firmware: "upgrade", flow: "seq", files: "files", flash: "flash",
                  runtime: "runtime", chart: "chart", capture: "capture", scope: "scope", logic: "logic", commands: "cmds",
                  batch: "batch", calculator: "calc", datacalc: "datacalc", env: "env", kb: "kb",
                  knowledge: "kb", agent: "agent", debug: "debug" };
    const tab = map[a.page] || a.page;
    // 左导航里没有的（比如调试页被藏起来）就别切了，省得切到一片空白
    const btn = document.querySelector(`.navitem[data-tab="${tab}"]`);
    if (!btn || btn.hidden) return `没有「${a.page}」这个页面（可用：传输/命令表/固件升级/烧录/文件管理/运行结构/Agent/实时图表/中控编排/示波器/屏幕捕获/逻辑分析仪/批量文本/计算器/数据计算/环境配置/知识库）`;
    showPane(tab);
    return "已切到「" + tab + "」页";
  },
  /** 把节点类型注册表整理成"给 agent 看的格式说明"：每种类型有哪些输入/输出端口。
   *  这样它不用猜字段名，而且这份清单是跟着 SQ_KINDS 走的，代码改了它自动跟着变。 */
  flowKindsBrief() {
    const out = {};
    for (const [k, v] of Object.entries(SQ_KINDS || {})) {
      if (!v) continue;
      // step 的 timeout 口只有勾了“发送后等待”才存在，所以这里给全量端口，
      // 让模型能一次看清所有可连的输出。
      const sample = { type: k, wait: true };
      out[k] = {
        label: v.label || v.name || k,
        ins: v.ins ? ["in"] : [],
        outs: sqOuts(sample).map((x) => x[0]),
      };
    }
    return out;
  },
  async flow_get() {
    return JSON.stringify({
      graph: sqGraph,
      kinds: this.flowKindsBrief(),
      note: "edges 是 {from:'节点id',port:'输出端口名',to:'节点id'}；端口名取自上面 kinds 里各类型的 outs。",
    });
  },
  async flow_set(a) {
    const g = a && a.graph;
    if (!g || !Array.isArray(g.nodes)) return "graph.nodes 必须是数组";
    const before = sqGraph;
    sqGraph = { nodes: g.nodes, edges: Array.isArray(g.edges) ? g.edges : [] };
    sqSanitize();                                  // 已有体检：丢掉不认识的类型、重复 id、悬空连线
    if (!sqGraph.nodes.length) { sqGraph = before; return "导入失败：没有一个节点是认识的类型（可以先 flow_get 看 kinds）"; }
    showPane("seq");
    sqSave(); sqRender(); sqFit();
    return `已导入画布：${sqGraph.nodes.length} 个节点 / ${sqGraph.edges.length} 条连线（不认识的类型和悬空连线已丢掉），已经切到「中控编排」页，用户可以直接改或跑。`;
  },
  async flow_add_node(a) {
    const type = String((a && a.type) || "").trim();
    if (!type) return "缺少 type（先 flow_get 看 kinds 里有哪些类型）";
    if (!(SQ_KINDS || {})[type]) return `不认识的节点类型：${type}（可用：${Object.keys(SQ_KINDS || {}).join(", ")}）`;
    const n = sqNewNode(type);
    const xs = sqGraph.nodes.map((x) => Number(x.x) || 0);
    n.x = Math.round(a && a.x != null ? Number(a.x) : (xs.length ? Math.max(...xs) + 260 : 40));
    n.y = Math.round(a && a.y != null ? Number(a.y) : 60);
    if (a && a.params && typeof a.params === "object") Object.assign(n, a.params);
    sqGraph.nodes.push(n);
    sqSel = { kind: "node", id: n.id };
    sqSave(); sqRender(); showPane("seq");
    return `已新增节点 ${n.id}（type=${type}）坐标 ${n.x},${n.y}；连它用 flow_connect(from/port/to)`;
  },
  async flow_connect(a) {
    const from = String((a && a.from) || "").trim();
    const to = String((a && a.to) || "").trim();
    const port = String((a && a.port) || "").trim();
    if (!from || !to || !port) return "需要 from / port / to（端口名见 flow_get 的 kinds[type].outs）";
    const fn = sqNode(from);
    if (!fn) return `没有这个节点：${from}`;
    if (!sqNode(to)) return `没有这个节点：${to}`;
    const outs = sqOuts(fn).map((o) => o[0]);
    if (!outs.includes(port)) return `节点 ${from} 没有输出端口「${port}」（它有：${outs.join(" / ") || "无"}）`;
    if (sqGraph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return "这条线已经存在（没重复加）";
    const edge = { from, port, to };
    sqGraph.edges.push(edge);
    sqSel = { kind: "edge", id: sqKey(edge) };
    sqSanitize(); sqSave(); sqRender(); showPane("seq");
    return `已连上：${from}.${port} → ${to}`;
  },
  async flow_delete(a) {
    const id = String((a && a.id) || "").trim();
    if (!id) return "需要 id（节点 id 或连线 key）";
    const n = sqNode(id);
    if (n) {
      if (n.type === "start") return "开始节点不能删";
      sqDeleteNode(id);
      return `已删掉节点 ${id}`;
    }
    const e = sqGraph.edges.find((x) => sqKey(x) === id);
    if (e) { sqDeleteEdge(id); return `已删掉连线 ${id}`; }
    return `没找到 ${id}（节点 id 或连线 key 都可以；可以 flow_get 看现有的）`;
  },
  async flow_run(a) {
    if (a && a.graph) {
      const backup = JSON.stringify(sqGraph);
      try {
        sqGraph = a.graph;
        sqSanitize();
        sqRender();
        await sqRunGraph();
      } finally {
        sqGraph = JSON.parse(backup);
        sqSanitize();
        sqRender();
      }
    } else {
      await sqRunGraph();
    }
    const log = document.getElementById("sq-log");
    const lines = (log ? log.textContent : "").split("\n").filter((l) => l.trim()).slice(-14).join("\n");
    return "编排跑完（结果 " + document.getElementById("sq-state").textContent + "）\n--- 日志尾巴 ---\n" + lines;
  },
  async flow_status() {
    const log = document.getElementById("sq-log");
    const lines = (log ? log.textContent : "").split("\n").filter((l) => l.trim()).slice(-14).join("\n");
    return "状态：" + document.getElementById("sq-state").textContent + "\n" + lines;
  },
  async ui_show_text(a) {
    agShowText(a.title || "（agent 推来的文本）", a.text || "");
    return "已显示到右侧「文本」页";
  },
  async ui_pane(a) {
    agShowPane(a.pane || "browser");
    return "右栏已切到「" + (a.pane || "browser") + "」";
  },
  async flow_stop() {
    sqStop = true;
    return "已发停止";
  },
  async capture_save(a) {
    const monitor = Number(a.monitor) || 0;
    const rel = (a.save_as || "shot.png").replace(/[\\/]/g, "/");
    await invoke("capture_start", { monitor, fps: 6, quality: 80 });
    await new Promise((r) => setTimeout(r, 1400));
    const img = document.querySelector("#cap-view img");
    const src = img && img.src ? img.src : "";
    await invoke("capture_stop").catch(() => {});
    if (!src.startsWith("data:")) return "抓屏没拿到帧";
    const bin = atob(src.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const root = (agMeta && agMeta.workspace) || (agCfg && agCfg.workspace) || "";
    if (!root) return "不知道工作区在哪";
    const sep = root.includes("\\") ? "\\" : "/";
    const path0 = root + sep + rel.replace(/\//g, sep);
    await writeFile(path0, bytes);
    return "已存 " + path0 + `（${bytes.length} 字节）`;
  },
};

// 便于自测 / 排障：直接调某个 host 工具（跟 agent://host_call 走的是同一张表）
window.__agHost = AG_HOST;

async function agHostCall(p) {
  const fn = AG_HOST[p.tool];
  if (!fn) {
    await invoke("agent_host_result", { id: p.id, ok: false, result: `前端没有实现工具 ${p.tool}` }).catch(() => {});
    return;
  }
  try {
    // host 工具是 AG_HOST 上的方法；先取出来再 fn(...) 会丢失 this，
    // flow_get 这类用 this 复用其它方法的工具会直接抛 TypeError。
    const r = await fn.call(AG_HOST, p.args || {});
    await invoke("agent_host_result", { id: p.id, ok: true, result: String(r == null ? "ok" : r) });
  } catch (e) {
    await invoke("agent_host_result", { id: p.id, ok: false, result: String(e) }).catch(() => {});
  }
}

// ---------- 后端事件 ----------
/** 事件处理出错不要静默吞掉：既不显示也不报错，最难查 */
function agOn(name, fn) {
  return listen(name, async (ev) => {
    window.__agEv = window.__agEv || {};
    window.__agEv[name] = (window.__agEv[name] || 0) + 1;
    try {
      await fn(ev);
    } catch (e) {
      window.__agErr = (window.__agErr || []).concat([name + ": " + (e && e.message ? e.message : String(e))]);
      pushSys(`[agent] 事件 ${name} 处理失败：${e}`);
    }
  });
}

async function bindAgentEvents() {
  if (!agEl("ag-chat")) return;
  await agOn("agent://state", (ev) => {
    const p = ev.payload || {};
    if (p.session) {
      if (p.running) agRunSessions.add(p.session);
      else agRunSessions.delete(p.session);
    }
    const mine = !!(agMeta && p.session === agMeta.id);
    if (!mine) return;
    agRunning = !!p.running;
    if (agRunning) {
      agState("思考中…", "ok");
      agThinkEnsure();          // 先摆一个"思考中…"；模型真吐思考就往上长
    } else {
      agState("空闲");
      agFlushStream();
      agStreamNode = null;
      agThinkSettle();
    }
  });
  // 思考过程（推理模型会发）：往那个"思考块"里长，正文一开始它就收起来
  await agOn("agent://reason", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    agThinkEnsure();
    agReasonText += p.text || "";
    agThinkPaint();
    agScrollTail(false);
  });
  await agOn("agent://delta", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    if (agThinkNode) agThinkSettle();      // 正文开始了：把思考块收起来
    agStreamText += p.text || "";
    const node = agEnsureStreamNode();
    node.querySelector(".bubble").innerHTML = agMd(agStreamText);
    agScrollTail(false);
  });
  await agOn("agent://round", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    if (agRunning) agState(`思考中…（第 ${p.round} 轮）`, "ok");
  });
  await agOn("agent://tool_call", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    if (agRunning) agState(`正在跑工具：${p.name}`, "ok");
    agThinkSettle();                          // 这一段结束了：思考块收起来
    // 有工具调用说明这一轮的正文结束了
    if (agStreamNode) { agStreamNode.classList.remove("streaming"); agStreamNode = null; }
    // 这一轮的正文结束了（后面还有工具调用）：本地这条也带上模型和时间，别等 done 才显示
    if (agStreamText.trim()) {
      agEvents.push({ type: "assistant", text: agStreamText, model: (agMeta && agMeta.model) || "", ts: Date.now() });
    }
    agStreamText = "";
    agEvents.push({ type: "tool_call", id: p.id, name: p.name, args: p.args });
    agRender();
  });
  await agOn("agent://tool_result", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    agEvents.push({ type: "tool_result", id: p.id, name: p.name, ok: p.ok, text: p.text });
    agRender();
  });
  await agOn("agent://note", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    agAppendEvent({ type: "note", text: p.text });
  });
  await agOn("agent://error", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    agAppendEvent({ type: "err", text: p.text });
    agState("出错", "err");
    if (!agWatching()) agUnreadBump();
  });
  await agOn("agent://usage", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    const el = agEl("ag-usage");
    const cache = p.cacheHit || p.cacheMiss ? ` · ${en("缓存命中")} ${agK(p.cacheHit || 0)}` : "";
    if (el) el.textContent =
      `${en("输入")} ${agK(p.prompt || 0)} · ${en("输出")} ${agK(p.completion || 0)} tokens${cache}`;
    agRefreshPricing();
    agRenderInfo();
  });
  // 出字速度（后端算好推过来）：信息页那一行 + 模型下拉里的 "xxx tok/s"
  await agOn("agent://speed", (ev) => {
    const p = ev.payload || {};
    if (p.all && typeof p.all === "object") agSpeed = p.all;
    if (p.id && p.stat) agSpeed[p.id] = p.stat;
    agRenderInfo();
    agRefreshModelLabels();
  });
  // 边跑边补充：排队的消息（后端会在这一轮的下一个边界并入）
  await agOn("agent://queued", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    agEvents.push({ type: "user", text: p.text, queued: true });
    agAppendEvent({ type: "user", text: p.text, queued: true });
    agUpdateHeader();
  });
  // 排队的那条真的并进对话了：把"排队中"的临时气泡换掉
  await agOn("agent://user", (ev) => {
    const p = ev.payload || {};
    if (agMeta && p.session !== agMeta.id) return;
    const i = agEvents.findIndex((e) => e.type === "user" && e.queued && e.text === p.text);
    if (i >= 0) agEvents.splice(i, 1);
    agEvents.push({ type: "user", text: p.text });
    agRender();
  });
  await agOn("agent://session", () => { agLoadTree(); });
  await agOn("agent://toast", (ev) => {
    const t = (ev.payload && ev.payload.text) || "";
    if (t) toast(t);
  });
  await agOn("agent://log", (ev) => {
    const t = (ev.payload && ev.payload.text) || "";
    if (t) pushSys(t.replace(/\n$/, ""));
  });
  await agOn("agent://host_call", (ev) => { agHostCall(ev.payload || {}); });
  await agOn("agent://approval", (ev) => {
    const p = ev.payload || {};
    const box = agEl("ag-chat");
    const card = document.createElement("div");
    card.className = "agapprove";
    const ttl = document.createElement("div");
    ttl.className = "ttl";
    ttl.textContent = `要执行「${p.tool}」，允许吗？`;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(p.args || {}, null, 2);
    const acts = document.createElement("div");
    acts.className = "acts";
    const yes = document.createElement("button");
    yes.className = "btn small primary"; yes.textContent = "允许";
    const no = document.createElement("button");
    no.className = "btn small danger"; no.textContent = "拒绝";
    // 「本会话都允许」：一次任务里同一个工具能弹十几次，点烦了 —— 给一条"别再问了"的路
    const always = document.createElement("button");
    always.className = "btn small";
    always.textContent = "本会话都允许";
    always.title = `这个会话里再遇到「${p.tool}」就直接放行，不再问`;
    const done = async (ok, alwaysValue) => {
      acts.innerHTML = `<span class="hint">${ok ? (alwaysValue ? `已允许（本会话内不再问 ${alwaysValue.replace(/^cmd:/, "命令 ")}）` : "已允许") : "已拒绝"}</span>`;
      await invoke("agent_approval_result", {
        id: p.id, ok, always: alwaysValue || null, session: alwaysValue ? (p.session || (agMeta && agMeta.id) || null) : null,
      }).catch(() => {});
    };
    yes.onclick = () => done(true, null);
    always.onclick = () => done(true, p.tool);
    no.onclick = () => done(false, null);
    acts.appendChild(yes); acts.appendChild(always); acts.appendChild(no);
    const cmd = String((p.args && p.args.cmd) || "").trim();
    if (cmd && ["local_run", "workspace_run", "workspace_test", "ssh_run"].includes(p.tool)) {
      const prefix = cmd.split(/\s+/).slice(0, 2).join(" ");
      const cmdAlways = document.createElement("button");
      cmdAlways.className = "btn small";
      cmdAlways.textContent = "允许这类命令";
      cmdAlways.title = `本会话里以「${prefix}」开头的命令不再问`;
      cmdAlways.onclick = () => done(true, "cmd:" + prefix);
      acts.appendChild(cmdAlways);
    }
    card.appendChild(ttl); card.appendChild(pre); card.appendChild(acts);
    box.appendChild(card);
    agScrollTail(true);
    agState("等你批准…", "wait");
    if (!agWatching()) agUnreadBump();
  });
  await agOn("agent://browser", (ev) => {
    const p = ev.payload || {};
    agRenderPage(p.page || p);     // agent 打开网页时，右侧「浏览器」跟着显示
  });
  await agOn("agent://done", async (ev) => {
    const sid = ev.payload && ev.payload.session;
    if (sid) agRunSessions.delete(sid);
    if (agMeta && sid === agMeta.id) {
      agRunning = false;
      agState("空闲");
      agThinkSettle();
    }
    if (!agWatching()) agUnreadBump();         // 没在看这一页 → 挂个"有未读"角标
    if (agMeta && sid === agMeta.id) agSetSendDisabled(false);
    if (agStreamNode) agStreamNode.classList.remove("streaming");
    agStreamNode = null;
    agFlushStream();
    if (agMeta) {
      // 收尾：按"落盘的事实"重画一遍（流式那棵树是临时的，跟会话文件对齐）
      const data = await invoke("agent_session_load", { id: agMeta.id }).catch(() => null);
      if (data && agMeta && data.meta.id === agMeta.id) { agSetMeta(data.meta, "done"); agEvents = data.events || []; }
      agToolCards = {};
      agToolArgs = {};
      if (agEl("ag-stop")) agEl("ag-stop").hidden = true;
      agRender();
      agLoadTree();
      agRenderInfo();
      agRefreshGit();
      agRefreshBreakdown();
      agRefreshBalance();
      agRefreshPricing();
    }
  });
  setInterval(() => {
    if (agMeta && agEl("ag-info") && !agEl("ag-info").hidden) agRefreshPricing(true);
  }, 30000);
  // 状态灯上的未读角标：点一下跳回对话；窗口重新获得焦点且正看着 agent 页时自动清掉
  if (agEl("ag-state")) {
    agEl("ag-state").onclick = () => { agUnreadClear(); showPane("agent"); };
    window.addEventListener("focus", () => { if (agWatching()) agUnreadClear(); });
    document.addEventListener("visibilitychange", () => { if (agWatching()) agUnreadClear(); });
  }
}
// ---------------- 中英文切换 ----------------
// 说明：按"元素文本(中文) -> 英文"的字典做替换（叶子元素/placeholder/title），
// 覆盖导航、标题栏、菜单、各页卡片标题与常用按钮/字段；字典里没有的保持中文（可随时补）。
// 没配置过就默认英文（用户要的是"如无配置默认英语"）
let LANG = localStorage.getItem("kdock_lang") === "zh" ? "zh" : "en";
const EN = {
  "调试": "Debug", "设备": "Device", "工具": "Tools",
  // 安卓 ADB：无线调试（Android 11+）
  "无线调试": "Wireless debugging", "无线调试（Android 11+）": "Wireless debugging (Android 11+)",
  "找设备": "Find devices",
  "列出局域网里正在广播的无线调试设备（adb mdns services）": "List wireless-debugging devices advertising on the LAN (adb mdns services)",
  "配对": "Pair", "配对码": "Pairing code",
  "手机「使用配对码配对设备」里那 6 位": "the 6 digits from “Pair device with pairing code”",
  "192.168.1.37 或 192.168.1.37:37000": "192.168.1.37 or 192.168.1.37:37000",
  "adb pair（只用一次；配对成功后再点「连接」）": "adb pair (one-off; then hit Connect)",
  "adb connect：连到无线调试页面上显示的那个端口": "adb connect: use the port shown on the device's wireless-debugging screen",
  "重新列设备（新插的线 / 新开的无线调试点这个）": "Re-list devices (after plugging in a cable or enabling wireless debugging)",
  "没看到设备？两条路：① USB：手机打开「开发者选项 → USB 调试」，插线后在手机上允许这台电脑；② 无线调试（Android 11+）：手机打开「开发者选项 → 无线调试」，先用下面的「配对」填手机弹窗上的地址和配对码，再「连接」到无线调试页面上显示的那个端口。":
    "No device? Two ways: (1) USB — enable Developer options → USB debugging and allow this PC on the phone; (2) Wireless debugging (Android 11+) — enable Developer options → Wireless debugging, use Pair below with the address and pairing code shown on the phone, then Connect to the port shown on the phone's wireless-debugging screen.",
  "（没发现广播：设备上要打开「无线调试」，两边要在同一网段）": "(no advertisement found: enable Wireless debugging on the device and keep both on the same subnet)",
  "配对要填 地址 + 配对端口 + 6 位配对码": "Pairing needs the address, the pairing port and the 6-digit code",
  "配对成功，接着点「连接」（端口通常和配对端口不同）": "Paired. Now hit Connect (the connect port usually differs from the pairing port)",
  "配对失败：": "Pairing failed: ", "连接失败：": "Connect failed: ", "断开失败：": "Disconnect failed: ", "失败：": "Failed: ",
  // 审批卡
  "本会话都允许": "Allow for this session",
  "已允许": "Allowed", "已拒绝": "Denied",
  "传输": "Transfer", "命令表": "Commands", "固件升级": "Firmware", "烧录": "Flash",
  "高级工具": "Advanced tools", "开发": "Develop", "效率": "Productivity",
  "文件管理": "Files", "实时图表": "Charts", "中控编排": "Flow", "示波器": "Scope",
  "屏幕捕获": "Capture", "逻辑分析仪": "Logic",
  "批量文本": "Batch text", "计算器": "Calculator",
  "文件": "File", "编辑": "Edit", "视图": "View", "窗口": "Window", "帮助": "Help",
  "概览": "Overview", "其它页面": "More pages", "管理": "Manage", "全屏": "Full width",
  "连接": "Connect", "断开": "Disconnect", "发送": "Send", "清空": "Clear", "清空日志": "Clear log",
  "开始": "Start", "停止": "Stop", "暂停接收": "Pause RX", "自动滚动": "Auto scroll",
  "ASCII 交互": "ASCII mode", "复制全部输出": "Copy output", "清空发送区": "Clear input",
  "主题": "Theme", "配色": "Accent", "暗色": "Dark", "亮色": "Light", "跟随": "System",
  "暗色主题": "Dark theme", "亮色主题": "Light theme", "跟随系统": "Follow system",
  "配色与设置…": "Accent & settings…", "最小化": "Minimize", "最大化 / 还原": "Maximize / Restore",
  "关闭到托盘": "Close to tray", "开机自启": "Run at startup", "断线自动重连": "Auto reconnect",
  "快捷键": "Shortcuts", "功能帮助": "Help", "功能帮助…": "Context help…", "功能帮助（F1）": "Help (F1)",
  "关于 KDock": "About KDock", "退出 KDock": "Quit KDock",
  "保存会话日志…": "Save session…", "加载会话日志…": "Load session…", "导出 CSV…": "Export CSV…",
  "回放会话": "Replay session", "导入编排 JSON…": "Import flow JSON…", "导出编排 JSON…": "Export flow JSON…",
  "从这里开始": "Start here", "帮助（F1）": "Help (F1)",
  "连接设备": "Device link", "方式": "Mode", "串口": "Port", "波特率": "Baud", "目标 IP": "Host",
  "端口": "Port", "路径": "Path", "地址": "Address", "文件": "File", "速度": "Speed",
  "接口": "Interface", "适配器": "Adapter", "工具": "Tool", "目标芯片": "Target chip",
  "器件库": "Device library", "固件": "Firmware", "命令预览": "Command preview",
  "烧录器": "Programmer", "烧录工具路径": "Tool paths",
  "自动检测": "Auto detect", "清空重填": "Reset & detect", "到中间选型号": "Pick a model →",
  "选择固件文件": "Choose firmware", "擦除": "Erase", "校验": "Verify", "复位": "Reset",
  "目录": "Directory", "列出目录": "List", "上级": "Up", "取回本机": "Pull to PC",
  "下载到": "Save to", "传回本机": "Pull", "发到设备": "Send to device", "选择本机文件": "Choose file",
  "写到": "Write to", "发送到设备": "Send to device",
  "暂存": "Staging", "版本": "Version", "升级": "Upgrade", "读取版本": "Read version",
  "中控连接": "Flow links", "添加连接": "Add link", "选中节点": "Selected node", "编排文件": "Flow file",
  "导入 JSON": "Import JSON", "导出 JSON": "Export JSON", "清空画布": "Clear canvas",
  "加节点": "Add node", "步骤": "Step", "延时": "Delay", "条件": "Branch", "结束": "End",
  "失败结束": "Fail", "示例": "Example", "整理": "Tidy", "适应": "Fit", "运行": "Run",
  "查找": "Find", "展开全部": "Expand all", "收起分支": "Collapse branches",
  "搜索函数名 / 地址": "Search function / address",
  "分析运行结构": "Analyze runtime", "选择固件": "Select firmware",
  "拉选中链路": "Draw selected chain", "返回全固件": "Back to full firmware",
  "用当前选中的全部函数作为链路根；Ctrl / Shift 点击可多选": "Use all selected functions as chain roots; Ctrl / Shift + click to multi-select",
  "链路中隐藏 HAL / CMSIS / C 库等系统函数，优先显示应用逻辑": "Hide HAL / CMSIS / C-library functions in chains to prioritize application logic",
  "选择 ELF / BIN…": "Select ELF / BIN…", "分析目标": "Analysis target",
  "全固件函数": "Full firmware", "main 运行链": "main runtime chain", "函数调用链路": "Call chain",
  "运行结构": "Runtime graph",
  "向下调用": "Downstream calls", "向上调用者": "Upstream callers", "双向": "Both directions",
  "深度": "Depth", "1 层": "1 level", "2 层": "2 levels", "3 层": "3 levels",
  "5 层": "5 levels", "8 层": "8 levels", "选择一个固件，查看运行结构": "Select firmware to inspect runtime structure",
  "全固件函数一览、main 调用链、中断作用域和单函数链路；库函数自动折叠。": "Full-firmware functions, main runtime chains, interrupt scopes and focused call chains; libraries are summarized.",
  "滚轮缩放 · 拖动画布 · 点击空白或按 Esc 取消高亮 · 点击函数看详情": "Wheel to zoom · drag to pan · click empty space or press Esc to clear highlighting · select a function for details",
  "入口骨架": "Entry skeleton",
  "应用逻辑": "Application logic",
  "分析日志": "Analysis log", "分析器": "Analyzer", "BIN 参数": "BIN parameters",
  "裸机 BIN 必须填写": "Required for bare-metal BIN", "基址": "Base address", "架构": "Architecture",
  "入口": "Entry", "向量表": "Vector table",
  "BIN 没有符号表时无法可靠找到 main。优先使用 ELF；只有 BIN 时请在符号表中按地址查看 CFG。": "BIN without symbols cannot reliably locate main. Prefer ELF; for BIN, inspect CFG by address.",
  "分析范围": "Scope", "布局": "Layout", "按调用分层": "Call topology", "紧凑网格": "Compact grid",
  "函数筛选": "Function filter", "全部函数": "All functions", "仅业务函数": "Business only",
  "仅库函数": "Libraries only", "仅中断": "Interrupts only", "仅孤立函数": "Isolated only",
  "连线": "Edges", "全部调用线": "All call edges",
  "选中上下游": "Selected upstream/downstream", "不画线": "No edges",
  "折叠分组": "Collapse groups", "＋ 新建": "+ New",
  "启用的分组会按名称或地址识别函数，并默认收起其下游分支；设置保存在本机。": "Enabled groups match functions by name or address and collapse their downstream branches by default. Settings are stored locally.",
  "名称": "Name", "匹配": "Match", "规则": "Pattern", "名称前缀": "Name prefix",
  "名称包含": "Name contains", "正则表达式": "Regular expression",
  "精确名称（逗号分隔）": "Exact names (comma separated)", "地址范围（十六进制）": "Address range (hex)",
  "例如：日志模块": "For example: logging", "例如：LOG_ 或 0x08010000-0x0801ffff": "For example: LOG_ or 0x08010000-0x0801ffff",
  "如何生成 ELF（MDK / CMake）": "How to produce an ELF (MDK / CMake)",
  "在全固件或运行链里点击函数；Ctrl / Shift 点击可多选。链路内点其他节点只查看详情，不会改变根。": "Click a function in Full firmware or Runtime chain; use Ctrl / Shift + click to multi-select. Selecting another node inside a chain only inspects it and does not change the root.",
  "函数": "Function", "调用点": "Call sites", "定位画布": "Center on canvas",
  "展开 CFG": "Open CFG", "拉这条链路": "Draw this chain",
  "未分析": "Not analyzed", "在中间点一个函数，这里显示地址、大小和调用点。": "Select a function on the canvas to inspect address, size and call sites.",
  "运行日志": "Run log", "节点": "Node",
  "图表": "Chart", "数据源": "Source", "通道": "Channels", "采样": "Sample",
  "捕获": "Capture", "显示器": "Monitor", "帧率": "FPS", "画质": "Quality",
  "一键读取": "Quick read", "自动测量": "Auto measure", "读波形": "Read waveform", "截屏": "Screenshot",
  "连接": "Connect", "未连接": "Disconnected", "已连接": "Connected", "就绪": "Ready",
  "统计": "Stats", "高级参数": "Advanced", "自定义": "Custom",
  // ---- 补齐：提示语 / 卡片内文 / 命令表说明 / 占位符 / 悬停提示 ----
  "1:1（窗口小就裁左上角）": "1:1 (crops top-left when small)",
  "<文字> [> file]": "<text> [> file]",
  "[NAME=值]": "[NAME=value]",
  "DXGI 桌面复制 → JPEG → 界面显示；帧率越高占 CPU 越多，调试看画面 5~10fps 够用。": "DXGI desktop duplication → JPEG → UI. Higher FPS costs more CPU; 5-10 fps is enough for debugging.",
  "J-Link 器件库": "J-Link device DB",
  "常用命令（Linux）": "Common commands (Linux)",
  "openocd · 开发板": "openocd · board", "openocd · 芯片": "openocd · chip", "openocd · 适配器": "openocd · adapter",
  "openocd 开发板": "openocd board", "openocd 芯片": "openocd chip",
  "— PC→设备 传文件": "— PC → device: send file",
  "— YMODEM 收文件到区域": "— receive a file into an area (YMODEM)",
  "— 不带参数=列出并校验 /firmware 里的包": "— no args: list & verify packages in /firmware",
  "— 写自定义属性": "— write a custom attribute",
  "— 切换目录": "— change directory",
  "— 切换设备端提示语言": "— switch the device prompt language",
  "— 列区域 / YMODEM 发文件": "— list areas / send a file (YMODEM)",
  "— 列目录": "— list directory",
  "— 删自定义属性": "— delete a custom attribute",
  "— 删除变量": "— unset a variable",
  "— 删除文件/目录": "— remove file/dir",
  "— 十六进制查看": "— hex dump",
  "— 卸载文件系统": "— unmount filesystem",
  "— 回显 / 重定向到文件": "— echo / redirect to file",
  "— 复制": "— copy",
  "— 建 N 字节测试文件": "— create an N-byte test file",
  "— 建目录": "— make directory",
  "— 建空文件": "— create empty file",
  "— 打印文件": "— print file",
  "— 执行脚本文件": "— run a script file",
  "— 改名 / 移动": "— rename / move",
  "— 改文件长度": "— resize file",
  "— 格式化（危险）": "— format (dangerous)",
  "— 看前 n 行": "— head (first n lines)",
  "— 看后 n 行": "— tail (last n lines)",
  "— 看类型/大小": "— stat (type/size)",
  "— 算文件 CRC32": "— file CRC32",
  "— 设备→PC 取文件": "— device → PC: fetch file",
  "— 设置或列出变量": "— set / list variables",
  "— 读自定义属性": "— read a custom attribute",
  "— 递归列目录": "— recursive list",
  "↓ 最新": "↓ Latest", "↻ 刷新": "↻ Refresh", "⌗ 整理": "⌗ Tidy", "⏹ 停止": "⏹ Stop",
  "▶ 运行": "▶ Run", "⤢ 适应": "⤢ Fit",
  "主连接": "Main link", "交互": "Interactive", "会话": "Session", "保存日志": "Save log",
  "保留": "Keep", "停止位": "Stop bits", "数据位": "Data bits", "校验位": "Parity", "流控": "Flow control",
  "硬件 RTS/CTS": "Hardware RTS/CTS", "软件 XON/XOFF": "Software XON/XOFF",
  "先占位：等确定型号/接口（USB 还是网络、采样率、通道数）再实现。": "Placeholder: implement once the model/interface (USB or network, sample rate, channels) is decided.",
  "全部来源": "All sources", "分区变大后扩容量": "Grow partition", "加载日志": "Load log",
  "区域": "Area", "升级": "Upgrade", "卸载+挂载（测持久化）": "Unmount + mount (persistence test)",
  "历史…": "History…", "命令": "Command", "回放": "Replay",
  "在中间点一下节点或连线，这里改参数。": "Click a node or a link on the canvas to edit it here.",
  "失败": "Fail", "成功": "OK", "导出 CSV": "Export CSV", "开始回放": "Start replay",
  "强制一致性检查": "Force consistency check", "当前目录": "Current directory", "循环": "Loop",
  "快捷": "Quick", "挂载文件系统": "Mount filesystem", "支持": "Formats", "文件系统": "Filesystem",
  "文件系统几何信息": "Filesystem geometry", "文件系统占用": "Filesystem usage",
  "文本": "Text", "无": "None", "时间戳": "Timestamp", "显示": "Show", "显示帮助": "Show help",
  "暂停": "Pause", "服务器": "Server", "未开始": "Idle", "未选": "none", "未选择固件": "No firmware",
  "本地回显": "Local echo", "本地文件": "Local file", "本地端口": "Local port", "本机命令": "Local command",
  "来源": "Source", "树": "Tree", "正常结束": "Finished",
  "每个「步骤」绑一个连接（主连接 / 中控连接 / 临时串口 / 临时 TCP·UDP / 本机命令），发完可勾「等待数据」；拖底部圆点连线，滚轮缩放，Delete 删除选中项": "Each step binds one link (Main / flow link / temp serial / temp TCP·UDP / local command) and can wait for data after sending. Drag from the bottom dot to connect, wheel to zoom, Delete to remove.",
  "每行发一串数字即可。": "Send one line of numbers per sample.",
  "流程入口": "Flow entry", "添加": "Add", "清屏": "Clear screen", "清屏（设备端）": "Clear screen (device)",
  "滚动": "Scroll", "点": "pt", "点右边【开始】后这里显示屏幕画面": "Press Start on the right to see the screen here",
  "烧录日志": "Flash log",
  "画布就绪：加「步骤」节点，每步绑一个连接；发完可以勾「发送后等待数据」。": "Canvas ready: add Step nodes; each binds a link and can wait for data after sending.",
  "监听地址": "Listen address", "空闲": "Idle", "空间": "Space", "等": "wait", "系统": "System",
  "统计已用块": "Count used blocks", "继续": "Continue", "继续 / 回流": "Continue / loop back",
  "编码": "Encoding", "英文": "English", "行尾": "Line ending", "设备文件": "Device files",
  "读取目录 ...": "Reading directory …", "读版本": "Read version", "超时": "Timeout",
  "跑一次垃圾回收": "Run GC once", "远端 IP": "Remote host", "远端端口": "Remote port",
  "适应窗口": "Fit window", "选择 .fw 文件": "Choose .fw file", "逻辑分析仪": "Logic analyzer",
  "逻辑分析仪：先留空，等你定型号/协议再接": "Logic analyzer: placeholder until the model/protocol is decided.",
  "（读不到）": "(unreadable)",
  "（还没有中控连接；用「主连接」也可以）": "(no flow links yet; Main link works too)",
  "（还没有读版本）": "(version not read yet)",
  ".hex / .elf 自带地址；.bin 需填写起始地址。.fw 请在「固件升级」页使用。":
    ".hex / .elf carry their own addresses; .bin needs a start address. Use .fw on the Firmware upgrade page.",
  // 占位符
  "JLink.exe 路径": "JLink.exe path",
  "openocd 的 scripts 目录（可留空）": "openocd scripts dir (optional)",
  "例如 250000": "e.g. 250000", "名字": "name",
  "搜型号，如 stm32f4 / nrf52 / rp2040": "Search a model, e.g. stm32f4 / nrf52 / rp2040",
  "搜索命令 / 说明": "Search command / description",
  "文本直接输入；HEX 形如 41 54 0D 0A（Enter 发送 / Shift+Enter 换行）": "Plain text, or HEX like 41 54 0D 0A (Enter to send / Shift+Enter for newline)",
  "文本直接输入（Enter 发送 / Shift+Enter 换行）": "Plain text (Enter to send / Shift+Enter for newline)",
  "HEX 模式：41 54 0D 0A（Enter 发送 / Shift+Enter 换行）": "HEX mode: 41 54 0D 0A (Enter to send / Shift+Enter for newline)",
  "本机目录": "Local folder", "没找到就手动选 openocd.exe": "Pick openocd.exe manually if not found",
  "目录或 .fw 地址": "Directory or .fw path", "要发送的内容": "Payload",
  "选文件后自动填": "Filled after picking a file", "默认目录": "Default folder",
  // 悬停提示
  "关闭（按设置可收进托盘）": "Close (may go to tray)",
  "删除这一条": "Delete this row",
  "名称": "Name", "内容": "Payload", "类型": "Kind",
  // ── 计算器（重排）/ 数据计算 ──
  "程序员计算器：表达式、32 位控制板、历史记录": "Programmer calculator: expressions, 32-bit bit board, history",
  "文件校验 / 哈希、浮点、进制字节序、AES / RSA": "Checksums / hashes, float, radix & byte order, AES / RSA",
  "数据计算": "Data calcs",
  "位宽": "Width", "算式": "Expression",
  "字节交换": "Byte swap", "位反转": "Bit reverse", "→ 浮点": "→ Float", "平方": "Square",
  "已折叠高 16 位": "high 16 bits folded:", "32 位全显示": "all 32 bits shown",
  "点一位就能翻": "click a bit to toggle",
  "点任意一位就能翻它；结果会立刻同步到上面的显示区。": "Click any bit to flip it; the display above updates immediately.",
  "位宽按你敲进去的数位自动定：如 0036 = 4 位十进制 → 16 位": "Width follows the digits you type: e.g. 0036 = 4 decimal digits → 16 bits", "以 16 进制显示": "Show as hex", "以 10 进制显示": "Show as decimal", "以 2 进制显示": "Show as binary",
  "→ 浮点数": "→ Float", "☆ 标记这个数据": "☆ Mark this value", "历史记录": "History",
  "清未标记": "Clear unmarked", "各进制一览": "All bases", "拖动调整上下比例（双击回到 1/3）": "Drag to resize (double-click resets to 1/3)",
  "点任意一位就能翻它；结果会立刻同步到上面的显示区和右侧历史。": "Click any bit to flip it; the display and the history on the right update immediately.",
  "→ 算式": "→ Expression", "全反": "NOT all", "取反 ~": "NOT ~", "零算": "zero",
  "文件校验（CRC16 / CRC32 / MD5 / SHA-1 / SHA-256）": "File checksum (CRC16 / CRC32 / MD5 / SHA-1 / SHA-256)",
  "进制 / 字节序": "Radix / byte order", "换算": "Convert", "有符号": "signed", "无符号": "unsigned", "字节序": "Byte order",
  "随便哪种进制：0x1F · 0b1010 · 0o17 · 1234 或 1,234": "Any radix: 0x1F · 0b1010 · 0o17 · 1234 or 1,234",
  "按多少位解释（影响有符号/无符号与翻转）": "Interpret as this width (affects sign and byte reversal)",
  "AES 加解密（WebCrypto）": "AES encrypt / decrypt (WebCrypto)", "密钥": "Key", "随机": "Random",
  "hex（32 / 64 个十六进制字符）或 base64": "hex (32 / 64 hex chars) or base64",
  "GCM 12 字节 / CBC 16 字节，hex 或 base64": "GCM 12 bytes / CBC 16 bytes, hex or base64",
  "要加密的明文，或要解密的 base64 密文": "Plain text to encrypt, or base64 ciphertext to decrypt",
  "加密 → base64": "Encrypt → base64", "base64 解密": "Decrypt base64",
  "RSA（RSA-OAEP-SHA256 / RSASSA-PKCS1-SHA256）": "RSA (RSA-OAEP-SHA256 / RSASSA-PKCS1-SHA256)",
  "用公钥": "public key", "用私钥": "private key", "PEM/BER 文件路径，或直接粘在下面": "PEM/BER file path, or paste the key below",
  "明文 / base64 密文 / 待签名文本 / base64 签名": "plain text / base64 ciphertext / text to sign / base64 signature",
  "验签用的原文（只验签时填）": "Original message for verify (only when verifying)",
  "公钥加密": "Encrypt (public)", "私钥解密": "Decrypt (private)", "私钥签名": "Sign (private)", "公钥验签": "Verify (public)",
  "选 PEM 密钥文件": "Pick a PEM key file", "说明": "Notes",
  "（还没算过）": "(nothing yet)", "点一下填回算式": "Click to load it back into the expression",
  "标记：高亮，并且保留到下次开机": "Mark: highlight it and keep it after a restart",
  "取消标记（下次开机就不留了）": "Unmark (won't survive a restart)",
  "现在这个值没法标记": "This value can't be marked", "已标记（会保留到下次开机）": "Marked (kept after a restart)",
  "已取消标记": "Mark removed", "已复制：": "Copied: ",
  "先填一个数": "Enter a number first", "先填内容": "Enter the content first", "先填": "Enter the ",
  "字节": "bytes", "字节。": "bytes.", "有符号": "signed", "无符号": "unsigned",
  "密钥长度不对": "Key length mismatch", "长度不对": "Bad length",
  "加密完成": "Encrypted", "解密完成": "Decrypted", "签名完成": "Signed", "明文": "Plain text", "出错": "Error",
  "随机密钥已生成（hex）": "Random key generated (hex)", "随机 IV 已生成（hex）": "Random IV generated (hex)",
  "解密失败：密钥 / IV / 密文对不上，或者数据被改过": "Decryption failed: key / IV / ciphertext mismatch (or the data was modified)",
  "验签结果": "Verify result", "✅ 通过（签名对得上）": "✅ OK (signature matches)",
  "❌ 不通过（改了内容或不是这把公钥）": "❌ Failed (content changed or wrong public key)",
  "PEM 里没找到 base64 正文": "No base64 body found in the PEM",
  "先把 PEM 密钥粘进来（或选文件）": "Paste the PEM key first (or pick a file)",
  "十六进制输入": "hex input", "十进制输入": "decimal input", "八进制输入": "octal input", "二进制输入": "binary input",
  "显示：IEEE-754 单精度解释": "Showing the IEEE-754 single-precision reading", "显示：整数": "Showing integers",
  "进制里没有这个字符：": " is not a digit in this radix: ",
  "内容（HEX 形如 41 54 0D 0A）": "Payload (HEX like 41 54 0D 0A)",
  "搜索…": "Search…", "没有匹配的条目": "no match", "（还没有快捷项，下面加一条）": "(no quick-send items yet — add one below)",
  "点这一行 = 直接发出去": "Click a row to send it right away",
  "改这一条": "Edit this one",
  "点某一行=直接发出去；✎ 改、✕ 删（改的时候上面那行变成编辑框，改完点「保存」）。":
    "Click a row to send it; ✎ edit, ✕ delete (the row above turns into an edit box — press Save when done).",
  "回到最新（上翻时自动停住跟随）": "Jump to latest (auto-follow stops when you scroll up)",
  "填进输入框": "Fill into the input", "怎么用": "How to use",
  "打开后可以直接在右边输出区敲键盘跟设备交互": "Type in the output area to talk to the device",
  "拖动调整参数区宽度（双击复位）": "Drag to resize the params column (double-click to reset)",
  "拖动调整左栏宽度（双击复位）": "Drag to resize the nav (double-click to reset)",
  "按流程分层自动排版（线就不乱了）": "Auto-layout by flow level (keeps wires tidy)",
  "更多：编码 / 滚动 / 暂停 / ASCII 交互 / 快捷命令 / 会话": "More: encoding / scroll / pause / ASCII / quick cmds / session",
  "每行前面显示时间戳": "Show a timestamp per line",
  "点这里；打开「ASCII 交互」后可以直接敲键盘跟设备对话": "Click here; with ASCII mode you can type to the device",
  "直接发送": "Send now", "缩放到合适大小": "Zoom to fit",
  "设备不回显时打开": "Turn on when the device does not echo",
  "设备打印非 UTF-8（比如 GB2312）时切到 GBK": "Switch to GBK when the device prints non-UTF-8 (e.g. GB2312)",
  "读取可用版本，明细打到中间输出": "Read available versions; details go to the output",
  "载入 ping + TCP + 串口 的示例编排": "Load the ping + TCP + serial example flow",
  "选 JLink.exe": "Pick JLink.exe", "选 STM32_Programmer_CLI.exe": "Pick STM32_Programmer_CLI.exe",
  "选 openocd.exe": "Pick openocd.exe", "选 scripts 目录": "Pick the scripts dir",
  "配色与设置": "Accent & settings", "设置": "Settings", "重新扫描串口": "Rescan ports",
  "重新枚举显示器（新接入的显示器点这个）": "Re-enumerate monitors (click after plugging one in)",
  "暮光紫": "Twilight", "森林绿": "Forest", "樱花粉": "Sakura", "海洋蓝": "Ocean",
  "琥珀橙": "Amber", "石墨": "Graphite", "薄荷青": "Mint",
  "拖动调整日志高度": "Drag to resize the log",
  // 传输页顶部那行
  "点一下在资源管理器里打开这个目录": "Click to open this folder in Explorer",
  "当前时间": "Current time", "会话开始": "session started", "已运行": "elapsed",
  "直接在输出区敲键盘，会按原始字节发给设备（Enter 发 CR、Backspace 发 0x08、Ctrl+C 发 0x03）；点这里关掉":
    "Type right in the output area; bytes go to the device as-is (Enter = CR, Backspace = 0x08, Ctrl+C = 0x03). Click to turn off",
  "未设置": "not set",
  // 编排：节点配置面板
  "HEX（内容按十六进制解析）": "HEX (parse content as hex)",
  "发送内容": "Payload", "发送后等待数据": "Wait for data after send",
  "发送后延时(ms)": "Delay after send (ms)", "超时(ms)": "Timeout (ms)",
  "命令超时(ms)": "Command timeout (ms)", "命令（cmd /C）": "Command (cmd /C)",
  "要求输出包含": "Output must contain", "留空=只看退出码 0": "empty = exit code 0 only",
  "留空=收到任意数据就算成功": "empty = any data counts", "要发出去的文本": "Text to send",
  "如 a0000028d000": "e.g. a0000028d000", "本机命令（ping 等）": "Local command (ping etc.)",
  "主连接（传输页）": "Main link (Transfer page)",
  "临时 TCP（本步指定 IP:端口）": "Temp TCP (this step's host:port)",
  "临时 UDP（本步指定 IP:端口）": "Temp UDP (this step's host:port)",
  "临时串口（本步指定 COM 口）": "Temp serial (this step's COM port)",
  "（没扫到串口）": "(no serial port found)",
  "（还没有中控连接；用「主连接」也可以）": "(no flow link yet; Main link works too)",
  "延时(ms)": "Delay (ms)", "判断方式": "Test", "包含": "Contains", "不为空": "Not empty",
  "正则匹配": "Regex", "要匹配的文本 / 正则": "Text / regex to match", "值": "Value",
  "对最近 600 字符的接收内容判断；是 / 否 分别从两个底部圆点引出。":
    "Tests the last 600 received chars; yes / no leave from the two bottom dots.",
  "流程入口，只能有一个。": "Flow entry, only one allowed.",
  "正常结束。": "Normal end.", "失败结束（流程以失败收尾）。": "Fail end (the flow ends as failed).",
  "删除这个节点": "Delete this node", "删除这条线": "Delete this wire",
  "起点": "From", "终点": "To", "点一下选中并居中": "Click to select and center",
  "拖动调整输入区高度（双击复位）": "Drag to resize the input area (double-click to reset)",
  "出口：成功 / 失败。": "Exits: ok / fail.",
  "出口：成功 / 失败(发送错) / 超时(等不到)。": "Exits: ok / fail(send error) / timeout(no data).",
  // 编排：期待匹配
  // 设置弹窗
  "设置": "Settings", "通用": "General", "主题与配色": "Theme & accent", "网络与代理": "Network & proxy",
  "模型与供应商": "Model & provider", "关于与数据": "About & data", "界面": "Appearance",
  "行为": "Behaviour", "数据目录": "Data folder", "主题": "Theme", "配色": "Accent",
  "agent 能用的工具": "Tools the agent can use", "当前": "Current",
  // Agent 右栏三页
  "浏览器": "Browser", "技能 / MCP": "Skills / MCP", "文本": "Text",
  "Agent 信息": "Agent info", "上下文": "Context", "工作区": "Workspace",
  "Token": "Tokens", "缓存命中": "Cache hit", "花费": "Cost",
  "输入": "in", "输出": "out", "补充": "Add",
  "上下文成分": "Context breakdown", "系统提示": "System", "工具定义": "Tools",
  "当前：": "Current: ", "未知": "Unknown", "公网 IP 归属地": "Public IP location", "归属地": "Location", "城市 / 地区": "City / region",
  "网络组织": "Network organization", "最后更新": "Last updated", "今日已请求": "Requests today",
  "剩余": "remaining", "统计日期": "Statistics date", "今日额度已用完，明天自动恢复。": "Today's quota is exhausted; it resets tomorrow.",
  "后台更新中…": "Refreshing in background…", "等待重试": "Retry in",
  "摘要": "Summary", "用户消息": "User msgs", "助手回复": "Assistant", "内置工具结果": "Built-in tool results", "MCP 工具结果": "MCP tool results",
  "剩余可用": "Free", "余额": "Balance", "已配置": "Configured", "接口格式": "API format",
  "本机估算": "local estimate", "模型上报": "provider-reported", "窗口预算": "budget",
  "已被摘要压掉": "compressed away by the summary", "回复完成时间": "replied at",
  "已思考": "thought", "思考过程": "reasoning", "有未读回复": "unread reply",
  "方向标记": "Direction", "agent 连上了主连接：": "the agent connected the main link: ",
  "字号 / 放大 / 字体": "Text size / zoom / font", "字号": "Text size", "放大": "Zoom", "字体": "Font",
  "系统默认": "System default", "整体按倍数缩放（控件 / 文本 / 字号一起变），并自动叠加系统的显示缩放；字体只替换正文那一族。":
    "Everything scales by this factor (controls, text and font size together) on top of the system display scaling; the font only replaces the UI text family.",
  "常驻": "Always on", "常驻技能": "Always-on skills", "其中常驻技能": "of which always-on skills",
  "先启用这个技能": "Enable the skill first",
  "常驻：技能正文每轮注入系统提示（身份 / 口吻类技能用这个）":
    "Always on: inject the skill body into the system prompt every turn (use this for identity / tone skills)",
  "每轮注入系统提示，一直占上下文": "injected every turn (always occupies context)",
  "正文每轮注入，不会被压缩掉": "injected every turn, never trimmed away",
  "不是 git 仓库": "not a git repo", " · 干净": " · clean", "读取中…": "loading…",
  "打开": "Open", "源码": "Source", "页面里的链接": "Links on page",
  "MCP 服务": "MCP servers", "命令": "Command", "参数": "Args", "保存": "Save",
  "测一测": "Test", "删除": "Delete", "打开文件": "Open file", "另存为": "Save as",
  "存到工作区": "Save to workspace", "清空": "Clear", "标题": "Title",
  "会话历史": "Session history", "上一个页面": "Previous page",
  "用系统浏览器打开": "Open in system browser", "看 HTML 源码": "View HTML source",
  "改工作区": "Change workspace", "删除当前": "Delete current",
  "agent 打开网页后这里会同步显示；也可以自己填网址打开":
    "Pages the agent opens show up here; you can also type a URL yourself",
  "只读展示 + 编辑；「存到工作区」会写进当前会话的工作区。":
    "View / edit text; \"Save to workspace\" writes into the current session workspace.",
  "技能 = 一份 SKILL.md（YAML frontmatter 里的 name/description 会进 agent 的系统提示，正文按需读）。agent 自己也能 skill_create / skill_update / skill_delete。":
    "A skill is one SKILL.md (name/description from the YAML frontmatter go into the agent system prompt; the body is read on demand). The agent can also skill_create / skill_update / skill_delete.",
  "stdio 方式：保存后按「测一测」会真的起进程握手一次；启用中的服务，工具会以 mcp__<id>__<tool> 挂给 agent。":
    "stdio transport: \"Test\" really spawns the process and handshakes; enabled servers expose their tools to the agent as mcp__<id>__<tool>.",
  // Agent
  "模型与供应商": "Model & provider", "供应商": "Provider", "新增": "Add",
  "保存": "Save", "删除": "Delete", "地址": "Endpoint", "模型": "Model",
  "上下文": "Context", "预留输出": "Reserve out", "温度": "Temp",
  "支持工具": "Tools", "流式": "Stream", "拉模型列表": "Fetch models",
  "测一测": "Test", "技能": "Skills", "工具": "Tools", "会话": "Sessions",
  "新会话": "New session", "压缩上下文": "Compact", "停止": "Stop",
  "说点什么": "Say something", "发送": "Send", "保存技能": "Save skill",
  "改工作区": "Change workspace", "删除当前会话": "Delete session",
  "期待方式": "Match mode", "包含文本": "Contains text", "正则表达式": "Regex",
  "位判断(HEX)": "Bit test (HEX)", "任意数据": "any data", "忽略大小写": "Ignore case",
  "期望值(HEX)": "Expected (HEX)", "掩码(HEX)": "Mask (HEX)", "正则": "Regex", "位判断": "bit test",
  "如 A0000028D000": "e.g. A0000028D000", "如 ^SVR1 或 Directory": "e.g. ^SVR1 or Directory",
  "同长度，留空=逐字节比较；如 F00000000000": "Same length; empty = byte-by-byte, e.g. F00000000000",
  "在收到的字节流里找一段，使 (数据 & 掩码) == (期望值 & 掩码)。":
    "Find a run in the received bytes where (data & mask) == (expected & mask).",

  // ============ 状态栏 / 对话框 / 通用 ============
  "未连接": "Disconnected", "空闲": "Idle", "确认": "Confirm", "取消": "Cancel", "确定": "OK",
  "语言": "Language", "运行时长 / 负载": "Uptime / load", "系统时间": "System time",
  "环境变量": "Environment", "查看挂载": "Mounts", "刷写缓存到存储": "Flush caches",
  "重启设备": "Reboot", "复制": "Copy", "编辑": "Edit", "设为当前": "Use this",
  "loading…": "loading…",
  "（读不到）": "(unavailable)",

  // ============ 工具页：批量文本 ============
  "输入（一行一条）": "Input (one per line)", "结果": "Result",
  "逐行发送": "Send line by line", "按下面的间隔，一行一行发到串口": "Send each line to the serial port with the delay below",
  "每行带走当前行尾": "Append the current line ending", "间隔": "Delay",
  "搜索 / 替换": "Find / replace", "查找": "Find", "要查找的内容": "Text to find",
  "全词": "Whole word", "模糊": "Fuzzy",
  "忽略大小写 + 空白灵活（空格可以匹配换行/多空格）": "Case-insensitive; whitespace matches any run of spaces/newlines",
  "替换成": "Replace with", "留空 = 删除匹配": "Empty = delete matches",
  "↑": "↑", "↓ 找下一个": "↓ Find next",
  "上一个（Shift+Enter）": "Previous (Shift+Enter)", "下一个（Enter / F3）": "Next (Enter / F3)",
  "替换": "Replace", "全部替换": "Replace all", "没在找": "idle",
  "JSON 整理": "JSON tools", "格式化": "Format", "压缩成一行": "Minify",
  "缩进 2": "indent 2", "缩进 4": "indent 4", "缩进 1（Tab 宽）": "indent 1 (tab)",
  "按标准 JSON 解析后再排版；解析失败会告诉你错在第几个字符。":
    "Parses as standard JSON before formatting; on failure it tells you the offending character position.",
  "正则批量处理": "Regex batch", "替换为": "Replace with",
  "每行单独": "per line", "全文一起": "whole text", "批量处理": "Run",
  "选中一段就只处理那段；没选就按下面的\"范围\"处理。用": "With a selection only that part is processed; otherwise the scope below applies. Use",
  "引用捕获组。": "for capture groups.",
  "大小写 / 缩进": "Case / indent", "大写": "UPPER", "小写": "lower", "首字母大写": "Title Case",
  "JSON 自动": "JSON auto", "花括号自动（C/JS）": "Braces auto (C/JS)",
  "Tab → 2 空格": "Tab → 2 spaces", "Tab → 4 空格": "Tab → 4 spaces", "去掉行首缩进": "Strip leading indent",
  "只处理选中部分（没选就整篇）": "Only the selection (whole text if none)",
  "把右边结果搬回左边输入，继续往下处理": "Move the result back to the input to keep processing",
  "结果 → 输入": "Result → input",
  "逐行处理": "Per-line processing", "去掉首尾空白": "Trim each line", "丢掉空行": "Drop empty lines",
  "去重（保留首次出现）": "De-duplicate (keep first)", "排序": "Sort", "加行号": "Number lines",
  "起": "start at", "前缀": "Prefix", "例：AT+": "e.g. AT+", "后缀": "Suffix", "例：\\r\\n": "e.g. \\r\\n",
  "大小写": "Case", "不改": "keep", "转大写": "UPPER", "转小写": "lower",
  "输出格式": "Output format", "原样（一行一条）": "as-is (one per line)",
  "HEX 数组 0x41,0x42…": "HEX array 0x41,0x42…", "HEX 字符串 4142…": "HEX string 4142…",
  "JSON 数组": "JSON array", "逗号连接": "comma joined", "C 数组 {0x41,0x42}": "C array {0x41,0x42}",
  "十六进制那几种是按": "The HEX formats encode", "UTF-8 字节": "UTF-8 bytes",
  "转的，中文也行。": "; CJK text works too.",
  "「逐行发送」按上面的间隔一条条发到当前串口，发完自动停；中途再点一次就停。":
    "\"Send line by line\" pushes each line to the current serial port with the delay above and stops when done; click again to abort.",

  // ============ 工具页：计算器 ============
  "表达式": "Expression", "C 风格：0x1F & (0x0F << 2)  ·  1.5e3 * 2  ·  (1<<16)-1  ·  ~0 & 0xFF":
    "C style: 0x1F & (0x0F << 2)  ·  1.5e3 * 2  ·  (1<<16)-1  ·  ~0 & 0xFF",
  "键盘按十六进制解释：打 1F 就是 0x1F，A-F 也算数字":
    "Keypad enters hex: typing 1F means 0x1F, A-F count as digits",
  "32 位控制板": "32-bit bit board", "清零": "Zero", "取反 ~": "NOT ~",
  "左移一位": "Shift left by one", "右移一位": "Shift right by one",
  "循环左移": "Rotate left", "循环右移": "Rotate right",
  "反相（异或 0xFFFFFFFF）": "Invert (XOR 0xFFFFFFFF)", "全反": "Invert",
  "把这一行的值写进上面的表达式": "Write this value into the expression above",
  "→ 计算区": "→ Calc",
  "点任意一位就能改；改完的值会同时出现在上面的结果区，并（在你没在输入框里打字时）回填到表达式。":
    "Click any bit to flip it; the value updates the result area and is written back into the expression (unless you are typing there).",
  "传统计算器": "Keypad",
  "直接按数字和运算符，= 出结果；结果和上面的控制板实时同步。":
    "Tap digits and operators; = evaluates. The result stays in sync with the bit board above.",
  "十六进制": "Hex", "把结果填进串口发送框": "Put the result into the send box", "→ 发送框": "→ Send box",
  "历史": "History", "（还没算过）": "(nothing yet)", "常用": "Quick",
  "把结果送进右边的浮点/IEEE 转换": "Feed the result into the IEEE panel on the right",
  "→ 浮点转换": "→ IEEE",
  "文件校验（CRC / 哈希）": "File checksum (CRC / hash)", "选文件…": "Choose file…",
  "（还没选）": "(none)", "偏移": "Offset", "长度": "Length", "计算": "Compute",
  "CRC32 填进计算区": "Put CRC32 into the calc area",
  "长度填 0 = 从偏移算到文件末尾。固件查分段有没有被改过时很好用。":
    "Length 0 = from the offset to EOF. Handy to check whether a firmware region changed.",
  "IEEE 754 浮点": "IEEE 754", "浮点 → 位": "float → bits", "位 → 浮点": "bits → float",
  "3.14 或 0x4048F5C3": "3.14 or 0x4048F5C3", "转换": "Convert",
  "拿计算区当前的值来转": "Convert the current calc value", "用计算区当前值": "Use calc value",
  "进制换算": "Radix", "位宽": "Width", "不限（任意精度）": "unbounded", "8 位（掩到 0xFF）": "8-bit (mask 0xFF)",
  "16 位": "16-bit", "32 位": "32-bit", "串口常用换算": "Serial timing",
  "位时间 = 1 / 波特率。开 8N1 时一个字节 10 位，所以 115200 下发一个字节约 86.8 µs。":
    "Bit time = 1 / baud. With 8N1 a byte takes 10 bits, so one byte at 115200 is about 86.8 µs.",
  "十进制": "decimal", "科学计数": "sci", "符号": "sign", "阶码": "exponent",
  "尾数": "mantissa", "二进制": "binary", "字节": "byte", "1 字节": "1 byte",
  "2 字节": "2 bytes", "4 字节": "4 bytes", "+1（正数）": "+1 (positive)", "-1（负数）": "-1 (negative)",

  // ============ Agent 信息 / 工作区 / 会话 ============
  "出字速度": "Throughput", "最近": "last", "平均": "avg",
  "价格": "Pricing", "峰价": "Peak", "谷价": "Off-peak",
  "启用峰谷计费": "Enable peak/off-peak billing",
  "模型指纹": "Model fingerprint", "当前为": "Current", "未采样": "Not sampled",
  "美元 / 百万 token": "USD / 1M tokens", "人民币 / 百万 token": "CNY / 1M tokens",
  "缓存命中": "Cache hit", "缓存未命中": "Cache miss", "输出": "Output",
  "当前峰价": "Peak rate now", "当前谷价": "Off-peak rate now",
  "北京时间": "Beijing time", "周末与法定节假日为谷价":
    "Weekends and statutory holidays use the off-peak rate",
  "更多": "More", "工作区：": "Workspace:", "重命名对话": "Rename session",
  "删除这个对话": "Delete session", "你": "You",
  "会自己动手的调试助手": "A debugging assistant that can actually do things",
  "新建工作区（选一个目录）": "New workspace (pick a folder)",
  "在这个工作区里新开一个对话": "Start a new session in this workspace",
  "右键可以删除": "Right-click to delete", "默认工作区": "Default workspace",
  "3.14 或 0x4048F5C3 ": "3.14 or 0x4048F5C3 ",
  "上一轮的 token 用量": "token usage of the last round",
  "例：看一下设备根目录里有什么，再把 /config/config.bin 取回来":
    "e.g. look at the device root, then pull back /config/config.bin",
  "/goal <目标>": "/goal <text>", "设定长期目标（每轮都带上，": "set a standing goal (injected every round, ",
  "清除）·": " clears it) · ", "压缩上下文 ·": "compact · ", "新会话 ·": " new · ",
  "切权限 ·": "permission · ", "停止 ·": "stop · ",
  "附上本机文件：复制进会话工作区，agent 就能读它": "Attach a local file: copied into the session workspace so the agent can read it",
  "📎 文件": "📎 File",
  "agent 的权限：只读 / 危险动作先问 / 全自动": "Agent permission: read-only / ask before risky actions / fully automatic",
  "只读": "Read-only", "需要批准": "Ask", "自动": "Auto",
  "思考强度": "Reasoning effort", "跟随模型默认": "Use model default",
  "可用思考强度": "Available reasoning efforts",
  "只勾选这个供应商/模型确认支持的档位。Agent 面板会按这里列出可选值；不同厂商未支持的档位可能返回 400。":
    "Select only the efforts this provider/model supports. The Agent panel lists these values; unsupported values may return HTTP 400.",
  "默认思考强度": "Default reasoning effort",
  "测试真实思考强度": "Test real reasoning efforts",
  "测试中…每个档位会真实请求一次": "Testing… each effort sends one real request",
  "个档位完成": "efforts completed",
  "真实请求观察（不是隐藏 CoT 的绝对证明）": "Observed from real requests (not proof of hidden CoT volume)",
  "测试会对每个已勾选档位真实发一次小请求（会产生少量 token 费用），记录接口可见的思考正文、首字延迟、出字耗时和 token。隐藏 CoT 的厂商可能显示 0 字；这只能说明未暴露，不代表没有思考。":
    "The test sends one small real request per selected effort (a small token charge) and records exposed reasoning, first-token latency, generation time and tokens. A hidden-CoT API showing 0 chars only means it was not exposed.",
  "思考": "thought", "字": "chars", "首字": "first token", "出字": "generation", "接口未暴露思考正文": "API did not expose reasoning text",
  "供应商默认": "Provider default", "本会话思考强度：": "Session reasoning effort: ",
  "测试失败": "test failed", "模型默认": "model default",
  "关闭思考": "Disable thinking", "极低": "Minimal", "低": "Low", "中": "Medium",
  "高": "High", "极高": "Extra high", "最大": "Max", "超强": "Ultra",
  "OpenAI 兼容发 reasoning_effort；Anthropic 转成 thinking budget":
    "OpenAI-compatible providers receive reasoning_effort; Anthropic maps it to a thinking budget",
  "正在取模型状态（AMD 那边约 20 秒）": "Fetching model status (takes ~20 s for AMD)",
  "这轮用哪个模型（参数去设置里改）": "Model to use (edit parameters in Settings)",
  "＋ 新增/编辑…": "＋ Add / edit…", "取状态中…": "fetching status…",
  "状态未知": "status unknown", "满载": "full", "繁忙": "busy",
  "（还没有技能）· 去「设置 → 技能」导入": "(no skills yet) · import one in Settings → Skills",
  "（还没有 MCP 服务）· 去「设置 → MCP」新增": "(no MCP servers yet) · add one in Settings → MCP",
  "这里只管**开关**（关掉的技能不进口令索引，也不会被主动提及）。": "This page only shows toggles (disabled skills are not indexed or suggested automatically).",
  "路径 / 导入 / 编辑都在": "Paths, import and editing live in",
  "设置 → 技能": "Settings → Skills",
  "这里只管**开关**。新增 / 参数 / 测试都在": "This page only shows toggles. Adding, parameters and tests live in",
  "设置 → MCP": "Settings → MCP",
  "（来自文件名 / agent）": "(from file name / agent)",
  "这里可以看文本：打开文件、或者让 agent 用 ui_show_text 推过来。":
    "Show text here: open a file, or let the agent push one with ui_show_text.",

  // ============ 设置：模型与供应商 ============
  "厂家预设": "Vendor preset", "— 选厂家 —": "— pick a vendor —", "填入表单": "Fill form",
  "选择模型…": "Choose a model…", "从已获取的模型列表中选择": "Choose from the fetched model list",
  "添加模型": "Add model", "高级": "Advanced",
  "搜索模型或供应商，例如 claude / deepseek / glm": "Search models or providers, e.g. claude / deepseek / glm",
  "刷新目录": "Refresh catalog", "读取 models.dev…": "Loading models.dev…",
  "显示全部": "Show all", "只看常用": "Popular only",
  "目录来自 models.dev，只显示当前后端可直连的 OpenAI 兼容 / Anthropic 模型。":
    "Catalog data comes from models.dev; only OpenAI-compatible and Anthropic models this backend can call directly are shown.",
  "目录里没有可用模型": "No usable models in the catalog",
  "目录读取失败：": "Catalog failed to load: ", "个模型": "models",
  "家供应商": "providers", "没有匹配的供应商": "No matching provider",
  "没有匹配的模型": "No matching model", "目录还没加载": "Catalog not loaded",
  "推理": "reasoning", "旧版": "deprecated", "工具": "tools",
  "还有": "Showing first 400; ", "个，继续搜索缩小范围": "more — keep typing to narrow it down",
  "这个供应商下没有匹配模型": "No matching model for this provider",
  "尚未加载": "not loaded", "缓存命中": "cache hit", "输出": "output",
  "每百万 token，美元": "USD per million tokens",
  "已保存，留空即可": "saved — leave blank to keep it", "粘贴 Key": "Paste key",
  "已有同名配置，保存会更新它": "A profile with this ID exists and will be updated",
  "ID 不能空": "ID cannot be empty", "地址不能空": "Endpoint cannot be empty",
  "已添加：": "Added: ",
  "DeepSeek（OpenAI 兼容）": "DeepSeek (OpenAI-compatible)",
  "DeepSeek（Anthropic 格式）": "DeepSeek (Anthropic format)",
  "智谱 GLM": "Zhipu GLM", "阿里通义 DashScope": "Alibaba DashScope", "硅基流动": "SiliconFlow",
  "火山方舟（豆包）": "Volcano Ark (Doubao)", "Ollama（本机）": "Ollama (local)",
  "LM Studio（本机）": "LM Studio (local)", "AMD Radeon Cloud（免费额度）": "AMD Radeon Cloud (free tier)",
  "自定义 / 自建网关": "Custom / self-hosted gateway",
  "选一个预设 -> 填入表单 -> 只补 API Key 就能用。都是 OpenAI 兼容写法（能填 base_url 的服务）。":
    "Pick a preset → fill the form → only the API key is missing. All of them are OpenAI-compatible (any service with a base_url).",
  "导入…": "Import…", "导出…": "Export…", "全部测一测": "Test all",
  "+ AMD 免费模型": "+ AMD free models",
  "把 AMD Radeon Cloud 那批免费模型加回列表（删掉之后不会自己回来，点这里加）":
    "Add the AMD Radeon Cloud free models back to the list (deleted ones do not come back by themselves)",
  "导入/导出的是 profile（**不含密钥**：密钥按用户 DPAPI 加密，换机器本来也带不走，导过去重新粘一次）。":
    "Import/export covers profiles only (**no API keys**: keys are DPAPI-encrypted per user, so paste them again on another machine).",
  "这个 profile 的参数": "Parameters of this profile",
  "deepseek（只给程序用，随便起）": "deepseek (internal id, any name works)",
  "OpenAI 兼容（/chat/completions）": "OpenAI-compatible (/chat/completions)",
  "OpenAI 兼容 /chat/completions": "OpenAI-compatible /chat/completions",
  "按这个 profile 发一句最短的话，验证地址/密钥/模型": "Send a one-line request with this profile to verify endpoint/key/model",
  "查余额（DeepSeek 有 /user/balance）": "Check balance (DeepSeek exposes /user/balance)",
  "填进下面的表单": "Fill the form below", "后面这些轮都用它": "Use it for the next rounds",
  "DeepSeek 两种都支持：OpenAI 兼容填": "DeepSeek supports both: OpenAI-compatible uses",
  "，\n                Anthropic 格式填": " , Anthropic format uses",
  "已在密钥库里（留空=不改）": "already in the key store (empty = keep)",
  "上下文窗口": "Context window", "这个模型最多能记多少 token": "How many tokens this model can remember",
  "不知道填多少就看服务商文档；填小了会频繁触发\"压缩上下文\"，填大了没坏处（超了服务端会报错）。":
    "Check the vendor docs if unsure. Too small triggers compaction often; too large is harmless (the server will error out if exceeded).",
  "最多回复": "Max reply", "单次回复最多多少 token": "Max tokens per reply",
  "留 2048~8192 就行": "2048–8192 is fine", "高级": "Advanced",
  "温度 = 回答的\"随机性\"：0 最稳（每次几乎一样，调试/工具调用建议 0~0.3）；\n                越高越发散（0.7~1.0 适合写东西）。这个助手要调工具、要准，建议 0.2。":
    "Temperature = randomness: 0 is most stable (debugging/tool calls prefer 0–0.3); higher is more creative (0.7–1.0 suits prose). For an assistant that calls tools, 0.2 is a good default.",
  "支持工具调用": "Tool calls", "流式输出": "Streaming",
  "这两个直接用上面**当前填的值**试，不用先保存": "Both use the values currently typed above — no need to save first",
  "AMD Radeon Cloud 实时负载": "AMD Radeon Cloud live load",
  "这些是 AMD Radeon Cloud（tokenfactory）各模型当前的并发占用，来自他们页面上\n                \"Live capacity\" 那份公开数据（后端去取，绕开跨域）。":
    "Current concurrency usage per AMD Radeon Cloud (tokenfactory) model — the same public data as the \"Live capacity\" line on their page (fetched by the backend to bypass CORS).",
  "只在打开这个页面时才刷新": "refreshed only while this page is open", "，\n                每 15 秒一次。": ", every 15 s.",

  // ============ 设置：技能 / MCP ============
  "本机技能": "Local skills", "（还没有技能：点「导入…」选一个 SKILL.md，或「新建」）":
    "(no skills yet: use Import… to pick a SKILL.md, or New)",
  "打开技能目录": "Open skills folder", "新建": "New",
  "技能名（会 slug 化；中文也能用）": "Skill name (slugified; CJK works too)",
  "---\nname: xxx\ndescription: 什么时候用它\n---\n\n正文": "---\nname: xxx\ndescription: when to use it\n---\n\nbody",
  "技能 = 一份": "A skill is one",
  "（frontmatter 的 name/description 进系统提示，正文按需读）。\n                点列表里的一项可以读出来编辑；「导入」支持选一个": "(name/description from the frontmatter go into the system prompt, the body is read on demand). Click a list item to edit it; Import accepts a",
  "或装着它的目录。\n                技能目录：": "or a folder containing it. Skills folder:",
  "（还没有 MCP 服务：填下面的 ID / 命令 / 参数，点保存）": "(no MCP servers yet: fill in ID / command / args below and save)",
  "npx / node / 你的 mcp server.exe": "npx / node / your mcp server.exe",
  "打开配置目录": "Open config folder",
  "stdio 方式：保存后按「测一测」会真的起进程握手一次（不响应会在 20 秒内报超时）。\n                启用中的服务，工具会以": "stdio transport: \"Test\" really spawns the process and handshakes (times out in 20 s if it stays silent). Enabled servers expose their tools to the agent as",
  "挂给 agent；\n                配置文件：": " . Config file:",

  // ============ 升级 / 烧录 / 图表 零星文案 ============
  "自有 Bootloader / App 升级": "KDock bootloader / app upgrade",
  "串口：KDock 自有 cshell + YMODEM，只接受 .fw；不是 STM32/ESP 出厂 ROM 下载器。":
    "Serial: KDock cshell + YMODEM, .fw only; not the STM32/ESP factory ROM loader.",
  "UDP：KDock 自有 SVC1 服务通道，按偏移写入 .fw；不是厂商 ROM Bootloader。":
    "UDP: KDock SVC1 service channel, offset-writes .fw; not a vendor ROM bootloader.",
  "TCP：KDock 自有 SVC1 服务通道，按偏移写入 .fw；不是厂商 ROM Bootloader。":
    "TCP: KDock SVC1 service channel, offset-writes .fw; not a vendor ROM bootloader.",
  "调试探针（SWD / JTAG）": "Debug probe (SWD / JTAG)",
  "厂商 ROM Bootloader（芯片系统区）": "Vendor ROM bootloader (chip system area)",
  "KDock 自有 OTA": "KDock OTA",
  "STM32 · USB DFU（BOOT0=1）": "STM32 · USB DFU (BOOT0=1)",
  "STM32 · UART ROM（BOOT0=1）": "STM32 · UART ROM (BOOT0=1)",
  "ESP32 / ESP8266 · 串口 ROM": "ESP32 / ESP8266 · serial ROM",
  "网络设备 · SVC1 / .fw": "Network device · SVC1 / .fw",
  "调试探针直接通过 SWD/JTAG 写片上 Flash，不依赖设备里的 bootloader。":
    "The debug probe writes on-chip Flash over SWD/JTAG without relying on a device bootloader.",
  "STM32 系统 Bootloader · USB DFU：BOOT0=1 后复位/上电，使用 CubeProgrammer 的 USB1。":
    "STM32 system bootloader · USB DFU: set BOOT0=1 then reset/power-cycle; CubeProgrammer uses USB1.",
  "STM32 系统 Bootloader · UART：BOOT0=1 后复位/上电，连接芯片指定的 USART。":
    "STM32 system bootloader · UART: set BOOT0=1 then reset/power-cycle; connect the chip's designated USART.",
  "ESP32 / ESP8266 串口 ROM：拉低 GPIO0（BOOT）后复位；只烧 .bin，合并镜像通常从 0x0 开始。":
    "ESP32 / ESP8266 serial ROM: pull GPIO0 low, then reset; flash .bin only, merged images usually start at 0x0.",
  "这是 KDock 自有 OTA（SVC1 + .fw），不是厂商出厂 ROM Bootloader。":
    "This is KDock OTA (SVC1 + .fw), not a vendor factory ROM bootloader.",
  "STM32 USB DFU 不需要串口；BOOT0=1 后复位/上电，进入系统 Bootloader。":
    "STM32 USB DFU does not use a serial port; set BOOT0=1 and reset/power-cycle to enter the system bootloader.",
  "ESP ROM 只接受 .bin；多镜像请先用 esptool merge_bin 合并，再填写合并后的起始偏移。":
    "ESP ROM accepts .bin only; merge multiple images with esptool merge_bin and enter the merged start offset.",
  ".hex / .elf 自带地址；.bin 需要填写芯片 Flash 地址。此路径使用厂商出厂 ROM Bootloader。":
    ".hex / .elf carry addresses; .bin needs the chip Flash address. This path uses the vendor factory ROM bootloader.",
  "Flash 偏移": "Flash offset",
  "配置未完成": "Configuration incomplete",
  "固件目录 / manifest.json / 单个 .fw 的地址": "firmware folder / manifest.json / a single .fw URL",
  "显示当前目录": "show current directory",
  "等待数据…": "waiting for data…", "设备按": "The device sends",
  "读取中…": "reading…",
  "openocd 芯片": "openocd chip", "openocd 开发板": "openocd board",
  "（没有检测到串口）": "(no serial port found)",
  "（还没对话，点 ＋）": "(no sessions yet — click ＋)", "（无标题）": "(untitled)",
  "（还没选对话）": "(no session selected)", " 轮": " turns",
  "把目标说出来，KDock 会和你一起推进。": "Tell KDock what you want to get done.",
  "给 Agent": "To Agent",
  "运行概览": "Runtime overview",
  "先在设置里选择一个模型。": "Choose a model in Settings first.",
  "说明目标、现象或贴一段日志；Enter 发送，Shift+Enter 换行": "Describe the goal, symptom or paste a log; Enter sends, Shift+Enter adds a line",
  "显示知识库管理页面": "Show the knowledge-base admin page",
  "全屏显示知识库对话页面": "Show the knowledge-base chat page full width",
  "… 还有 ": "… ", " 个对话（点开）": " more sessions (click to show)",
  "⚠ 没密钥": "⚠ no key", "正在请求…": "requesting…",
  "该厂商没有余额接口": "this vendor has no balance endpoint",
  "（余额字段为空）": "(balance fields empty)", "（账号不可用）": " (account unavailable)",
  "还没有供应商": "no providers yet", "开始逐个测": "testing",
  "openocd 适配器": "openocd adapter",
  "openocd：芯片": "openocd: chips", "开发板": "boards", "适配器": "adapters",
  "J-Link 器件库：没找到 JLinkDevices.xml": "J-Link device DB: JLinkDevices.xml not found",
  "还没有器件库，点右上角「↻ 刷新」。": "No device DB yet — click ↻ Refresh.",
  " 行": " lines", " 字": " chars", " 通道 / ": " channels / ", " 点": " points",
  "接收": "Receive", "发送": "Transmit", "字符": "chars", "日志": "log",
  "（还没有技能）": "(no skills)",
  "监听中（等对端接入）": "listening (waiting for peer)", "监听中": "listening",

  // ============ 批量文本 / 计算器：运行时提示 ============
  "找到 ": "found ", " 处": " matches", "没找到": "not found",
  "正则写错了：": "bad regex: ", "JSON 解析失败：": "JSON parse failed: ",
  "JSON 解析失败（第 ": "JSON parse failed (at char ", " 个字符）：": "): ",
  "先写个正则": "enter a regex first", "已全部替换": "replaced all",
  "正则批量处理完成（每行单独）": "regex batch done (per line)",
  "正则批量处理完成（全文）": "regex batch done (whole text)",
  "出错：": "error: ", "发送中 ": "sending ", "发完了": "done",
  "结果已搬回输入": "result moved back to the input", "已复制": "copied",
  "复制失败：": "copy failed: ", "保存批量文本结果": "Save batch text result", "已保存": "saved",
  "保存失败：": "save failed: ", "重新开始": "cleared", "0x（十六进制输入）": "0x (hex input)",
  "十进制输入": "decimal input", "负数不能开平方": "cannot take the square root of a negative number",
  "0 没有倒数": "0 has no reciprocal", "除数不能是 0": "division by zero",
  "空表达式": "empty expression", "只能算数字和 + - * / % & | ~ << >> ** 这些":
    "only numbers and + - * / % & | ~ << >> ** are supported",
  "认不出这个数字：": "unrecognized number: ", "表达式没写完": "incomplete expression",
  "括号没闭合": "unmatched parenthesis", "这里不该出现 ": "unexpected token ",
  "取余的除数不能是 0": "modulo by zero", "多余的字符：": "trailing characters: ",
  "值": "value", "位": "bit", "一字节约": "per byte ~",
  "计算中…": "computing…", "文件大小": "Size", "算的范围": "Range",
  "保存技能": "Save skill", "加行号": "Number lines",
  // 运行时写进去的（词典查表管不到，源码里用 en() 包）
  "已连接": "Connected", "主题：": "Theme: ", "（点一下切换）": " (click to cycle)",
  "暗色": "Dark", "亮色": "Light", "跟随系统": "Follow system",
  "直接发送": "Send now", "（默认）": "(default)", "（无）": "(none)",
  "（先读版本）": "(read versions first)",
  "下载文件": "download a file", "端口探测": "probe a port",
  "粘贴 Key（已保存的会留空）": "paste the key (empty keeps the saved one)",
  "多行文本批量处理 / 逐行发到串口": "Batch-process multi-line text / send line by line",
  "表达式计算：进制、位运算、常用换算": "Expression calculator: radix, bitwise, conversions",
  "用户消息：悬停看前几个字，点一下跳过去": "User messages: hover to preview, click to jump",
  "https:// 或直接输域名": "https:// or a bare domain",
  "（agent 打开网页后这里会同步显示；也可以自己填网址打开）":
    "(pages the agent opens show up here; you can also type a URL yourself)",
  "在中间点一下节点或连线，这里改参数。": "Click a node or an edge in the middle to edit its parameters here.",
  "这里只管**开关**（关掉的技能不进口令索引，也不会被主动提及）。 路径 / 导入 / 编辑都在":
    "This page only shows toggles (disabled skills are not indexed or suggested automatically). Paths, import and editing live in",
  "例：^(\\w+)=(\\d+)$": "e.g. ^(\\w+)=(\\d+)$",
  "例：$1 -> $2": "e.g. $1 -> $2",
  "思考中…": "thinking…", "思考中": "thinking",
  "（还没有，点新增）": "(none yet — click Add)", "（没找到显示器）": "(no monitor found)",
  "还没有对话，点 ＋ 新建": "No sessions yet — click ＋ to create one",
  "还没有器件库，点右上角「↻ 刷新」。": "No device DB yet — click ↻ Refresh.",
  "没找到 J-Link 器件库": "J-Link device DB not found",
  "正在取（这个接口本身要 20 多秒）…": "fetching (this endpoint takes ~20 s)…",
  "工作区": "Workspace", "界面": "UI tools", "本机": "local",
  "手动": "manual", "自动找到": "auto-detected",
  // 关于本软件 / 版本管理
  "版本": "Version", "作者": "Author", "仓库": "Repository", "协议": "License",
  "构建": "Build", "当前版本": "Current version", "版本号来源": "Version sources",
  "变更记录": "Changelog", "发版约定": "Release convention", "固件包版本": "Firmware package version",
  "关于本软件": "About", "打开 GitHub 仓库": "Open GitHub repo", "作者主页": "Author profile",
  "更新日志": "Changelog", "更多（版本管理 / 数据目录）…": "More (versioning / data folder)…",
  "版本管理": "Versioning",
  "Apache-2.0（见仓库里的 LICENSE / NOTICE）": "Apache-2.0 (see LICENSE / NOTICE in the repo)",
  "tauri.conf.json · Cargo.toml · package.json（三处保持一致）":
    "tauri.conf.json · Cargo.toml · package.json (kept in sync)",
  "CHANGELOG.md（每次发版追加一段）": "CHANGELOG.md (a new section per release)",
  "打 tag：": "tag it: ",
  "三段式 PD_HW.PD_SW.PD_FIX（写在 .fw 包头里，与应用版本无关）":
    "three-segment PD_HW.PD_SW.PD_FIX, stored in the .fw header (unrelated to the app version)",
  "内存": "Memory", "时间": "Time", "进程": "Processes", "GitHub 仓库": "GitHub repo",
  "Tauri 2 · Rust + 原生 JS": "Tauri 2 · Rust + vanilla JS",
  "KDock 以": "KDock is released under",
  "开源，欢迎 issue / PR。第三方组件与借鉴声明见仓库里的": "— issues and PRs are welcome. Third-party notices live in",
  "应用版本": "App version", "遵循": " follows ",
  "语义化版本": "Semantic Versioning",
  "：不兼容改动升 MAJOR，加功能升 MINOR，修 bug 升 PATCH。 版本号在":
    ": breaking changes bump MAJOR, features bump MINOR, fixes bump PATCH. The version is kept in sync across",
  "三处保持一致，每次发版写进": ", and every release is recorded in",
  "， 并打一个": ", plus a", "的 git tag。": " git tag.",
  "是另一套：": " is a separate scheme: ",
  // ============ 传输页「更多」面板 ============
  "更多 ⋯": "More ⋯", "显示": "Display", "编码": "Encoding",
  "设备打印的不是 UTF-8（例如 GB2312/GBK）时切过去，原始字节不会丢":
    "Switch when the device prints non-UTF-8 text (e.g. GB2312/GBK); raw bytes are kept either way",
  "中文乱码就切 GBK；编码只影响显示，日志里存的还是原始字节。":
    "Garbled CJK? switch to GBK. Encoding only affects the view — logs keep raw bytes.",
  "自动滚动": "Auto scroll", "新数据到达时自动滚到底部": "Scroll to the bottom as new data arrives",
  "暂停接收": "Pause RX", "先冻住界面看历史，设备数据照收（不丢）": "Freeze the view to read history; data keeps arriving",
  "「暂停」只是不刷新界面，串口照样在收；取消暂停会把攒下的数据补上。":
    "Pause only stops repainting — the port keeps receiving, and resuming shows everything buffered.",
  "交互": "Interaction", "ASCII 交互": "ASCII mode",
  "打开后可以直接在输出区敲键盘跟设备对话": "Type directly in the output area to talk to the device",
  "设备不回显时打开，自己敲的字会先显示出来": "Enable when the device does not echo; your keystrokes are shown",
  "本地回显": "Local echo",
  "打开「ASCII 交互」后点输出区就能直接打字（Enter 发送、Ctrl+C 发送 0x03）；适合对着 shell 交互。":
    "With ASCII mode on, click the output area and type (Enter sends, Ctrl+C sends 0x03) — handy for shell sessions.",
  "快捷发送": "Quick send", "按钮名": "Button label",
  "要发送的内容（HEX 形如 41 54 0D 0A）": "Payload (HEX looks like 41 54 0D 0A)",
  "勾上后按 HEX 发送": "Send as HEX", "加进去的按钮常驻在输出区上方，点一下就发；右键按钮可以删除。":
    "Added buttons stay above the output area and send with one click; right-click a button to delete it.",
  "会话日志": "Session log", "默认目录（留空=文档目录）": "Default folder (empty = Documents)",
  "保存的是完整会话（含时间戳/方向/原始字节），加载后可以回放。":
    "The saved file contains the whole session (timestamps, direction, raw bytes) and can be replayed.",
  "回放": "Replay", "先「加载日志」再回放；1x 按原始时间轴，2x 就是两倍速。":
    "Load a log first, then replay: 1x follows the original timeline, 2x is twice as fast.",
  "0x": "0x (hex input)",

  // ============ 指令表：编辑 ============
  "新增一个指令组（比如：我的板子专用）": "Add a command group (e.g. my board)",
  "往当前组新增一条指令": "Add a command to a group",
  "恢复到内置的标准 Linux 指令集": "Restore the built-in standard Linux command set",
  "指令表是**可编辑**的：加了什么就存在": "The command table is editable: whatever you add is stored in",
  "，下次开机还在（「设置 → 缓存」里能看到它、也能删）。行尾的 ✎ / ✕ 用来改或删那一条。":
    " and survives restarts (visible and deletable in Settings → Cache). The ✎ / ✕ buttons at the line end edit or delete that entry.",
  "没匹配的命令": "no matching command", "这条要带参数，已填进输入框": "This one takes arguments — filled into the send box",
  "改指令组名": "Rename group", "组名": "Group name", "删掉这个组（连同组里的指令）": "Delete this group and its commands",
  "删掉指令组": "Delete group", "连同里面的": "and its", " 条指令？": " commands?",
  "编辑这条指令": "Edit command", "删掉这条指令": "Delete command",
  "名字": "Name", "参数模板": "Arguments", "说明": "Description",
  "新增指令": "New command", "指令组": "Group", "可以填新组名，会自动创建": "a new name creates the group",
  "这条是干什么的": "what it does", "自定义": "Custom", "新增指令组": "New group",
  "例：我的板子专用": "e.g. my board", "这个组已经存在": "that group already exists",
  "恢复成内置的标准 Linux 指令集？你自己加的组和指令会丢掉。":
    "Restore the built-in standard Linux set? Your own groups and commands will be lost.",
  "恢复默认指令表": "Restore default table", "已恢复默认指令表": "default command table restored",
  "已加入指令表：": "added to the command table: ", "指令表保存失败：": "saving the command table failed: ",
  "点名字=填进发送框；▶=直接发（带参数的会先填进去让你补）":
    "Click a name to fill the send box; ▶ sends right away (entries with arguments are filled in for you to edit)",
  "+ 组 / + 指令：自己加；组名可以随便起（例：我的板子专用）":
    "+ group / + command: add your own; group names are free-form (e.g. my board)",
  "行尾 ✎ 改、✕ 删；改完立刻存进 agent/commands.json，下次开机还在":
    "✎ edits, ✕ deletes; every change is written to agent/commands.json immediately",
  "恢复默认：回到内置的标准 Linux 指令集": "Restore default: back to the built-in standard Linux set",
  "怎么用 / 怎么自定义": "How to use / customise",
  "取消": "Cancel", "确定": "OK",

  // ============ 设置 → 缓存 ============
  "缓存": "Cache", "持久化数据（缓存）": "Persisted data (cache)", "↻ 刷新": "↻ Refresh",
  "这里是本软件在你这台机器上留下的**全部**数据：界面偏好、窗口状态、LLM 供应商与密钥、 对话历史、技能副本、MCP 配置、指令表、工作区文件…… 每一项都标了路径，可以单独删。 删除后软件会自动重启（避免半截状态）。":
    "Everything this app leaves on your machine: UI preferences, window state, LLM providers and keys, chat history, skill copies, MCP config, command table, workspace files… Each row shows its path and can be deleted on its own. The app restarts afterwards to avoid half-deleted state.",
  "全选": "Select all", "全不选": "Select none", "删除选中…": "Delete selected…",
  "已选": "selected", " 项": " item(s)", "（不存在）": "(missing)",
  "确认删除这些缓存？": "Delete these cache items?",
  "勾选框里的会被删掉；删完软件会自动重启。带 ⚠ 的会丢数据（对话、密钥、供应商配置、技能副本），请确认你不需要它们。":
    "Checked items are deleted and the app restarts. Items marked ⚠ lose real data (chats, keys, provider config, skill copies) — make sure you do not need them.",
  "删除并重启": "Delete and restart", "已删除，正在重启…": "deleted, restarting…",
  "先勾选要删的项": "tick something first", "一个都没勾": "nothing selected",
  // 后端返回的缓存项文案
  "界面偏好（主题 / 配色 / 语言；栏宽那些存在浏览器本地存储里）":
    "UI preferences (theme / accent / language; pane widths live in browser local storage)",
  "会回到默认外观（深色 + 海洋蓝 + 英文）": "resets the look to the default (dark, ocean blue, English)",
  "窗口位置与大小": "Window position and size",
  "下次启动窗口回到屏幕中央的默认尺寸": "next launch uses the default size, centred",
  "浏览器本地存储（快捷发送 / 编排画布 / 编码 / 上次目录…）":
    "Browser local storage (quick send / flow canvas / encoding / last folders…)",
  "由界面自己清空（WebView2 的本地存储）": "cleared by the UI itself (WebView2 local storage)",
  "LLM 供应商配置（不含密钥）": "LLM provider profiles (no keys)",
  "供应商列表与当前选择会清空，需要重新配置模型": "the provider list and current selection are wiped — configure a model again",
  "API 密钥（DPAPI 加密）": "API keys (DPAPI encrypted)",
  "所有供应商的 Key 都会被删除，需要重新粘贴": "all provider keys are deleted; paste them again",
  "Agent 对话历史（含摘要与压缩前的原始记录）": "Agent chat history (summaries and pre-compaction records)",
  "所有对话都会消失，不可恢复": "every chat disappears — unrecoverable",
  "技能（导入/新建的 SKILL.md 副本）": "Skills (imported/created SKILL.md copies)",
  "只删这个副本目录（你自己的原始 SKILL.md 不在里面）": "only this copy directory is removed (your original SKILL.md files live elsewhere)",
  "已关闭的技能副本": "Disabled skill copies", "同上，只删副本": "same as above — copies only",
  "MCP 服务配置": "MCP server config", "MCP 列表会清空": "the MCP list is cleared",
  "指令表配置（指令组 / 指令）": "Command table config (groups / commands)",
  "回到内置的标准 Linux 指令集": "falls back to the built-in standard Linux set",
  "工作区列表": "Workspace list", "工作区记录清空（目录本身不动）": "workspace records are cleared (the folders themselves stay)",
  "Agent 工作区文件（下载/导出的文件）": "Agent workspace files (downloaded / exported)",
  "里面有 agent 收发的文件，删了就没了": "files the agent sent and received — gone once deleted",
  "出字速度统计": "Throughput stats", "速度与平均速度重新累计": "last and average throughput start over",
  "包头里的三段式版本号（PD_HW.PD_SW.PD_FIX）， 由设备端规则决定是否允许升级/降级，和上面的应用版本无关。":
    " header (three segments) that the device uses to accept or reject an upgrade — unrelated to the app version.",
  "未选择固件": "no firmware selected", "升级中…": "upgrading…", "升级完成": "upgrade finished",
  "读取服务器 ...": "reading server …", "填服务器地址后点【读版本】": "fill in the server address, then click Read version",
  "开始升级": "start upgrade", "取消升级": "cancel",
  "设置（Ctrl+, ）": "Settings (Ctrl+, )",
  "切换主题：暗色 / 亮色 / 跟随系统": "Switch theme: dark / light / system",

  // ============ 命令表：分组 + 说明 + 交互 ============
  "系统": "System", "网络": "Network", "权限": "Permissions",
  "填进输入框": "Put into the send box", "已填入：": "filled in: ",
  "列目录": "list directory", "切换目录": "change directory", "显示当前目录": "show current directory",
  "打印文件内容": "print file content", "分页查看文件": "page through a file",
  "看前 n 行": "first n lines", "看后 n 行": "last n lines", "建目录": "create directory",
  "删除文件/目录": "remove files/dirs", "复制": "copy", "移动 / 改名": "move / rename",
  "建空文件 / 改时间": "create empty file / touch", "建软链接": "create symlink",
  "按名字找文件": "find by name", "看类型 / 大小 / 时间": "type / size / mtime",
  "统计占用": "disk usage of a path", "文件系统占用": "filesystem usage",
  "递归列目录（需已安装）": "recursive listing (if installed)", "猜文件类型": "guess file type",
  "回显 / 重定向": "echo / redirect", "搜索文本": "search text", "流编辑": "stream edit",
  "按列处理": "process columns", "按分隔符取列": "cut by delimiter", "排序": "Sort",
  "去重（配合 sort）": "de-duplicate (after sort)", "统计行/字/字节": "count lines/words/bytes",
  "字符替换": "translate characters", "比较两个文件": "diff two files", "十六进制查看": "hex view",
  "内核 / 架构信息": "kernel / arch info", "内存占用": "memory usage", "进程列表": "process list",
  "进程快照": "process snapshot", "结束进程": "kill a process", "内核日志": "kernel log",
  "设置环境变量": "set an env var", "等待 1 秒": "wait one second", "命令路径": "command path",
  "网卡地址": "interface addresses", "网卡信息（旧写法）": "interface info (legacy)",
  "连通性测试": "reachability test", "连接 / 端口": "connections / ports",
  "连接 / 端口（新写法）": "connections / ports (modern)", "HTTP 请求": "HTTP request",
  "改权限": "change mode", "改属主": "change owner", "当前用户 / 组": "current user / groups",
  "当前用户名": "current user name", "提权执行": "run as root",

  // ============ 设置 → 模型：供应商面板（使用 / 新增）============
  "使用": "Use", "新增 / 编辑": "Add / Edit",
  "当前模型": "Current model",
  "选中的这个模型，agent 后面几轮就用它。点下面任意一条也能直接切过去。":
    "The selected model is what the agent uses from now on. Clicking any row below switches to it.",
  "自建 / 自己编辑的模型": "Your own / hand-edited models",
  "显示免费模型 ▾": "Show free models ▾", "收起免费模型 ▴": "Hide free models ▴",
  "个免费模型": "free models", "实时负载": "Live load",
  "立刻取一次（这个接口本身要 20 多秒）": "Fetch now (this endpoint takes ~20s)",
  "AMD Radeon Cloud（tokenfactory）各模型当前的并发占用，来自他们页面上 \"Live capacity\" 那份公开数据（后端去取，绕开跨域）。":
    "Current concurrency usage of the AMD Radeon Cloud (tokenfactory) models, taken from the public \"Live capacity\" data on their page (fetched by the backend to avoid CORS).",
  "只有你把这块展开时才去取": "It is fetched only while you keep this section expanded",
  "，展开期间每 15 秒一次。": ", once every 15 seconds while expanded.",
  "其它": "Other",
  "（还没有自建供应商：去「新增 / 编辑」加一个）": "(no custom provider yet — add one under Add / Edit)",
  "（没有免费模型：展开后点「+ AMD 免费模型」加回来）": "(no free model — expand this and click “+ AMD free models”)",
  "把 AMD Radeon Cloud 那批免费模型加回列表（删掉之后不会自己回来，点这里加）":
    "Add the AMD Radeon Cloud free models back to the list (they do not come back on their own)",
  "在这条的基础上改（跳到「新增 / 编辑」）": "Edit this entry (jumps to Add / Edit)",
  "删掉这个 profile（密钥一起删）": "Delete this profile (its key is deleted too)",
  "密钥也一起删。": "Its API key is deleted too.",
  "点一下切到它": "Click to switch to it", "当前在用": "in use",
  "后面这轮用：": "Using for the next turn: ",
  "新模型窗口更小：当前约": "The new model has a smaller window: about",
  "，预算": " tokens used, budget",
  "先压一次上下文": "compressing the context first",
  "压缩失败：": "compression failed: ",
  "使用默认模版": "Use default template",
  "把选中预设的地址 / 模型 / 上下文填进下面": "Fill the selected preset's endpoint / model / context into the form below",
  "取消编辑": "Cancel edit", "编辑：": "Editing: ",
  "新增供应商": "Add a provider",
  "把这条 profile 删掉？": "Delete this profile?",

  // ============ 计算器：位控制板 / 显示区 ============
  "表达式（C 风格）": "Expression (C style)",
  "0x / 0b / 0o · 位移 · 位与或 · 乘方 **": "0x / 0b / 0o · shifts · bitwise and/or · power **",
  "插入": "Insert",
  "不限位宽": "unbounded width", "8 位": "8-bit", "16 位": "16-bit", "32 位": "32-bit",
  "取反 ~": "NOT ~", "全反": "Invert all", "→ 表达式": "→ expression",
  "点任意一位就能翻它；结果会立刻同步到下面的显示区、表达式和右边的进制明细。":
    "Click any bit to flip it; the value syncs to the display below, the expression and the radix detail on the right.",
  "十六进制输入": "Hex input",
  "进制明细": "Radix detail",
  "无符号 32 位": "unsigned 32-bit",
  "点一下复制这一行的值": "Click to copy this line",
  "已复制：": "copied: ",

  // ============ 设置 → 技能：编辑卡片 ============
  "编辑技能": "Edit skill", "点上面列表里的一项读进来": "click an item above to load it",
  "删除这个技能": "Delete this skill",

  // ============ 指令表编辑器 ============
  "指令表编辑器": "Command table editor",
  "主页面只管用：点名字填进输入框、▶ 直接发。加 / 改 / 删都在这里做，改完立刻存进 agent/commands.json。":
    "The main page is for use only: click a name to fill the send box, ▶ to send. Add / edit / delete here; changes are saved to agent/commands.json right away.",
  "（空的：点「+ 新增指令组」或者「恢复默认」）": "(empty — click “+ new group” or “restore defaults”)",
  "点一下填进输入框并关掉这个弹窗": "Click to fill the send box and close this dialog",
  "✎ 编辑指令表": "✎ Edit command table",
  "打开指令表编辑器：加组 / 加指令 / 改名 / 删除 / 恢复默认":
    "Open the command table editor: add groups / commands, rename, delete, restore defaults",
  "+ 新增指令组": "+ New group", "+ 新增指令": "+ New command",
  "恢复默认": "Restore defaults", "关闭": "Close",
  "+ 加一条到本组": "+ Add command here", "条": "items",
  "改组名": "Rename group", "往这个组里加一条指令": "Add a command to this group",
  "编辑指令": "Edit command",

  // ============ 补齐：多行文本节点的规范化写法 / 说明文字 ============
  "限定位宽：结果会被掩到这么多位": "Limit the width: results are masked to this many bits",
  "， 展开期间每 15 秒一次。": ", once every 15 seconds while expanded.",
  "选一个预设 → 使用默认模版 → 只补 API Key 就能用。都是 OpenAI 兼容写法（能填 base_url 的服务）。":
    "Pick a preset → Use default template → then just add the API key. All of them are OpenAI-compatible (any service with a base_url).",
  "， Anthropic 格式填": ", and for the Anthropic format use",
  "导入 / 导出的是 profile（**不含密钥**：密钥用 Windows DPAPI 按当前用户加密， 换机器本来就带不走，导过去重新粘一次）。":
    "Import / export covers profiles only (**no keys**: keys are encrypted with Windows DPAPI per user, so they cannot travel to another machine — paste them again there).",
  "点命令名 = 填进输入框；行尾 ▶ = 直接发。要加 / 改 / 删就点上面的":
    "Clicking a command name fills the send box; ▶ sends it right away. To add / edit / delete, use the",
  "（在弹窗里改，主页只管用）。加了什么存在": "button above (everything is edited in a dialog; the main page is for use only). What you add is stored in",
  "， 下次开机还在（「设置 → 缓存」里能看到它、也能删）。":
    ", and it survives a restart (you can see and delete it under Settings → Cache).",
  "密钥存储：": "Key storage: ",
  "（按当前用户加密）": " (encrypted for the current user)",
  "明文（非 Windows 平台）": "plain text (non-Windows)",
  "数据目录：": "Data directory: ",
  "明文（非 Windows）": "plain text (non-Windows)",
  "供应商": "Providers", "个 · 已存密钥": "· stored keys",
  "删除供应商": "Delete provider", "确定删掉": "Delete",
  "它的 API Key 也一起删。": "Its API key is deleted as well.",
  "已启用": "enabled", "已停用": "disabled",
  "已启用（关掉后不进索引，只能由你点名读取）": "enabled (turn off = not indexed; read only when named by you)",
  "已停用（不进索引，可点名读取）": "disabled (not indexed; can be read when named)",
  "已启用（工具会挂给 agent）": "enabled (tools are exposed to the agent)",
  "失败": "failed", "完成": "done", "执行中…": "running…",
  "参数：": "args: ",
  "工具调用": "Tool calls", "执行中": "running", "个失败": "failed", "全部完成": "all done",
  "条旧事件；原文仍在会话文件里，可用 history_search 回查":
    "old events; the raw text is still in the session file — search it with history_search",
  "温度 = 回答的\"随机性\"：0 最稳（每次几乎一样，调试/工具调用建议 0~0.3）； 越高越发散（0.7~1.0 适合写东西）。这个助手要调工具、要准，建议 0.2。":
    "Temperature = how \"random\" the answer is: 0 is the steadiest (almost identical every time; 0–0.3 is right for debugging and tool calls); higher is more exploratory (0.7–1.0 for writing). This assistant calls tools and needs accuracy, so 0.2 is recommended.",
  "个文件": "file(s)",
  "上次更新 ": "updated ",
  "显示 / 交互 / 快捷发送 / 会话日志 / 回放": "Display / interaction / quick send / session log / replay",

  // ============ 示波器页 ============
  "机器状态": "Instrument", "测一次": "Measure once", "连续": "continuous",
  "时基 / 触发": "Timebase / Trigger", "时基": "Timebase",
  "触发源": "Trigger source", "电平 V": "Level V", "自动设置": "Autoset",
  "自动设置中…（示波器要几秒）": "Autoset running… (the scope takes a few seconds)",
  "SCPI（想发什么发什么）": "SCPI (send whatever you like)",
  "波形": "Waveform", "屏幕 1200 点": "screen, 1200 pts",
  "深存储 12k": "deep memory, 12k", "深存储 120k": "deep memory, 120k",
  "自动刷新": "auto refresh", "另存为…": "Save as…",
  "型号": "Model", "采样率": "Sample rate", "存储深度": "Memory depth",
  "触发": "Trigger", "状态": "State", "应用": "Apply", "探头": "probe",
  "开": "on", "关": "off",
  "还没连上（点上面的「连接」）": "not connected yet (click Connect above)",
  "连上之后这里会列出通道。": "Channels show up here once connected.",
  "读取状态…": "reading state…", "读不到状态": "cannot read state",
  "连接中…": "connecting…", "连接失败": "connect failed", "出错": "error",
  "时基已改": "timebase updated", "触发已改": "trigger updated",
  "已保存：": "saved: ", "保存示波器截屏": "Save scope screenshot",
  "示波器上现在没有打开的通道": "no channel is turned on in the scope",
  "频率": "Frequency", "周期": "Period", "峰峰值": "Vpp", "最大值": "Vmax",
  "最小值": "Vmin", "平均值": "Vavg", "有效值": "Vrms", "顶电平": "Vtop",
  "底电平": "Vbase", "上升时间": "Rise time", "下降时间": "Fall time",
  "正占空": "Duty+", "负占空": "Duty-",
  "点数：1200 = 屏幕上的数据（快）；更大的走深存储（慢）":
    "Point count: 1200 = on-screen data (fast); larger values use deep memory (slow)",
  "每 2 秒自动重读一次": "re-read every 2 seconds", "每 2 秒重测一次": "re-measure every 2 seconds",
  "让示波器自己找档位和时基（:AUT）": "let the scope find scale and timebase itself (:AUT)",
  "探头 ": "probe ",
  "示波器只给了": "the scope only returned",
  "点（存储深度 AUTO）；想真深存储：先在示波器上按 STOP，把存储深度调大":
    "points (memory depth is AUTO); for real deep memory, press STOP on the scope and raise the memory depth",
  "连上了，但状态没读到（示波器在忙？再点一次「连接」）":
    "connected, but the state could not be read (scope busy? click Connect again)",
  "已重连": "reconnected",

  // ============ 知识库页（中间管理页面 + 右栏对话页面，内置浏览器渲染）============
  "知识库": "Knowledge base",
  "知识库：中间是管理页面、右边是对话页面（两个地址在设置里配）":
    "Knowledge base: the admin page in the middle, the chat page on the right (both URLs are set in Settings)",
  "管理页面地址（留空 = 用设置里配的那个）":
    "Admin page URL (empty = the one from Settings)",
  "重新加载": "Reload",
  "用系统浏览器打开（登录 / 下载这类它更顺手）":
    "Open in the system browser (handier for logins and downloads)",
  "对话": "Chat", "知识库页面": "Knowledge base pages",
  "管理页面": "Admin page", "对话页面": "Chat page",
  "去知识库页": "Go to the knowledge base page",
  "打开管理页面": "Open admin page",
  "在设置 → 知识库里配置管理页面": "Set the admin page in Settings → Knowledge base",
  "在设置 → 知识库里配置对话页面": "Set the chat page in Settings → Knowledge base",
  "还没配「知识库管理页面」地址 —— 点这里去设置里填":
    "No \"admin page\" URL yet — click here to set it in Settings",
  "还没配「知识库对话页面」地址 —— 点这里去设置里填":
    "No \"chat page\" URL yet — click here to set it in Settings",
  "还没打开：上面地址栏点「打开」，或者直接点这里":
    "Not opened yet: press Open above, or just click here",
  "还没打开：上面点「打开」，或者直接点这里":
    "Not opened yet: press Open above, or just click here",
  "还没打开过": "it has not been opened yet",
  "先填个地址": "fill in a URL first",
  "先填个地址：已经在设置 → 知识库里等你":
    "Fill in a URL first — Settings → Knowledge base is waiting for you",
  "先填「对话页面」地址：已经在设置 → 知识库里等你":
    "Fill in the \"chat page\" URL first — Settings → Knowledge base is waiting for you",
  "知识库地址已保存": "Knowledge base URLs saved",
  "已保存（只在本机）": "saved (this machine only)",
  "已打开：": "opened: ",

  // ============ 数据计算页：折叠区块 ============
  "全部展开": "Expand all", "全部折叠": "Collapse all",
  "浮点 ↔ 位，含符号/阶码/尾数拆解": "float ↔ bits, with sign/exponent/mantissa breakdown",
  "任意进制互转、有符号/无符号、大小端翻转":
    "any radix, signed/unsigned and endianness flipping",

  // ============ 知识库：两块各自的地址栏 ============
  "存为默认": "Save as default", "↻ 重新加载": "↻ Reload",
  "把这个地址存成「管理页面」默认（设置 → 知识库）": "Save this as the admin-page default (Settings → Knowledge base)",
  "把这个地址存成「对话页面」默认（设置 → 知识库）": "Save this as the chat-page default (Settings → Knowledge base)",
  "地址已存为默认": "saved as default",

  // ============ 数据计算：新一批标签/按钮 ============
  "文件校验 / 哈希": "Checksums / hashes", "算法": "Algorithms", "范围": "Range",
  "核对": "Verify", "长度 0 = 算到文件末尾": "length 0 = to end of file",
  "选中的结果填进计算器": "Send the selected result to the calculator",
  "文件": "File", "计算": "Compute", "算完了": "done", "对得上": "matches", "先点「计算」": "press Compute first",
  "先粘一个期望值": "paste an expected value first",
  "六项都对不上 —— 文件或范围可能不对": "none of them match — wrong file or range?",
  "→ 计算器": "→ Calculator", "已填进计算器": "sent to the calculator",
  "这一项没法当数算": "this one is not a number", "点一行复制": "click a row to copy", "点一下复制": "click to copy",
  "JSON 整理": "JSON tidy", "缩进": "Indent", "不缩进": "no indent", "空格": "spaces",
  "输入": "Input", "结果": "Result", "格式化": "Format", "压缩": "Minify", "只校验": "Validate only",
  "键排序": "Sort keys", "转义": "Escape", "反转义": "Unescape", "复制结果": "Copy result",
  "结果搬回输入": "Result → input", "已转义（可直接塞进代码）": "escaped (ready to paste into code)",
  "反转义完成": "unescaped", "✅ JSON 合法": "✅ valid JSON", "格式化完成": "formatted", "压缩完成": "minified",
  "行": "lines", "字符": "chars", "先粘点 JSON": "paste some JSON first", "结果还是空的": "the result is still empty",
  "第": "line", "行第": "col", "列": "",
  "按行整理了 ": "formatted ", " 份 JSON（结果栏直接给的排版结果）": " JSON documents line by line (the result pane shows it directly)",
  "JSON 已排版（结果栏直接给的是排版后的内容，不过行处理那条流水线）":
    "JSON formatted — the result pane shows it directly, bypassing the line pipeline",
  "浮点 ↔ 数值": "Float ↔ value", "宽度": "Width", "浮点（十进制）": "Float (decimal)", "位（HEX）": "Bits (HEX)",
  "明细": "Details", "复制": "Copy", "用计算器当前值": "Use the calculator value",
  "已取计算器当前值": "took the calculator value: ",
  "位侧支持 0x / 0b / 十进制整数；宽度 32/64 会同时给出两种精度":
    "the bits side accepts 0x / 0b / decimal integers; both precisions are always shown",
  "-（负数）": "−(negative)", "+（正数）": "+(positive)",
  "AES 加解密": "AES", "模式": "Mode", "密钥": "Key", "格式": "Format", "输出": "Output",
  "自动": "auto", "都要": "both", "随机": "Random", "加密": "Encrypt", "解密": "Decrypt",
  "GCM：IV 12 字节，密文自带 16 字节认证标签": "GCM: 12-byte IV, ciphertext carries a 16-byte auth tag",
  "CBC：IV 16 字节，密文长度是 16 的整数倍": "CBC: 16-byte IV, ciphertext is a multiple of 16 bytes",
  "CTR：IV 16 字节，密文长度是 16 的整数倍": "CTR: 16-byte IV, ciphertext is a multiple of 16 bytes",
  "文本哈希 / HMAC": "Text hashes / HMAC", "文本": "Text", "HMAC 密钥": "HMAC key",
  "留空就只算普通哈希（填了会多算一行 HMAC-SHA256）":
    "leave empty for plain hashes (a key adds an HMAC-SHA256 row)",
  "生成": "Generate", "生成密钥对": "Generate key pair", "清空": "Clear", "验签原文": "Signed text",
  "生成的私钥只在你本机内存/框里，自己存好": "the private key stays in this box on your machine — keep it safe",
  "密钥对已生成（框里放的是私钥；公钥在下面，复制给对方）":
    "key pair generated (the box holds the private key; copy the public key below to the other side)",
  "公钥": "Public key", "私钥": "Private key", "正在生成…": "generating…", "生成完成": "generated",
  "算的范围": "Range", "先填密钥": "fill in the key first", "先填内容": "fill in the content first",
  "hex 得是偶数个字符": "hex needs an even number of digits",
  "先把 PEM 密钥粘进来（或选文件）": "paste the PEM key first (or pick a file)",
  "这把钥匙认不出来（要 SPKI/PKCS#8 的 PEM 或 DER）":
    "cannot read this key (needs an SPKI/PKCS#8 PEM or DER)",
  "解密失败：密钥 / IV / 密文对不上，或者数据被改过":
    "decryption failed: wrong key / IV / ciphertext, or the data was modified",
  "这不是个数：": "not a number: ", "位": "bits", "字节": "bytes", "要": "needs",
  "长度不对": "bad length", "先填": "fill in the ", "用计算器当前值": "Use the calculator value",
  "RIGOL DS1000Z 系标配的网口口子（TCP 5555，SCPI 文本）。连上之后 agent":
    "The standard LAN port on RIGOL DS1000Z series scopes (TCP 5555, SCPI text). Once connected the agent",
  "工具干同样的事。": "can do the same things with the same tools.",
  // 逻辑分析仪
  "导入 VCD / CSV…": "Import VCD / CSV…",
  "原始二进制…": "Raw binary…",
  "光标": "Cursors",
  "清光标": "Clear cursors",
  "点一下放 A · Shift+点放 B · 滚轮缩放 · 拖动平移 · 双击适应": "click = cursor A · Shift+click = B · wheel = zoom · drag = pan · double-click = fit",
  "点 A · Shift 点 B · Alt 点/「＋标记」加标记 · 拖标记线 · 点解码块选中区间":
    "click = A · Shift-click = B · Alt-click / +mark = add marker · drag a marker line · click a decoded block to select its span",
  "行 −": "Rows −", "行 ＋": "Rows +", "降低行高，多看几路": "Reduce row height to see more channels",
  "增大行高，波形更清楚": "Increase row height for clearer waveforms",
  "＋标记": "+ marker", "点击设为 A；Shift+点击设为 B；拖动标记线可移动":
    "Click to set A, Shift-click to set B, drag the marker line to move it",
  "删除这个标记": "Delete this marker",
  "点通道名选中它；点波形放 A，Shift 点放 B，Alt 点加标记。":
    "Click a channel name to select it; click the waveform for A, Shift-click for B, Alt-click to add a marker.",
  "缩小时波形上的标签会自动避让；完整结果始终在这里。":
    "Labels on the waveform avoid overlapping as you zoom out; the full decoded list stays here.",
  "数据来源": "Source",
  "解码器": "Decoders",
  "测量（当前视图窗口 · 选中的通道）": "Measure (current view · selected channel)",
  "占空比": "Duty",
  "脉冲数": "Pulses",
  "高 / 低脉宽": "High / low pulse width",
  "在左边通道名上点一下 = 选中它（测的就是它）。": "Click a channel name on the left to select it (that is what gets measured).",
  "显示 / 隐藏这一路": "Show / hide this channel",
  "显示全部通道": "Show all channels",
  "删掉这个解码器": "Remove this decoder",
  "还没加解码器：上面点 + UART / + SPI": "No decoder yet: click + UART / + SPI above",
  "还没加解码器：上面选个协议点「＋」": "No decoder yet: pick a protocol above and hit +",
  "已加解码器：": "Decoder added: ",
  "载入示例": "Load demo",
  "应用菜单": "App menu",
  // 快捷发送（弹窗版）
  "编辑快捷发送": "Edit quick-send",
  "新增快捷发送": "New quick-send",
  "快捷发送编辑器": "Quick-send editor",
  "主页面点一行就直接发出去；加 / 改 / 删都在这里做，改完立刻存到本地。": "Clicking a row on the main pane sends it right away; add / edit / delete here — saved locally right after.",
  "＋ 新增一条": "+ New entry",
  "（还没有快捷项，点上面「＋ 新增一条」）": "(no entries yet — hit \"+ New entry\" above)",
  "（还没有快捷项，点上面的「✎ 编辑」加一条）": "(no entries yet — use ✎ Edit above)",
  "显示在列表里的名字（留空就用内容前几个字）": "Name shown in the list (blank = first few chars of the payload)",
  "先填要发送的内容": "Fill in the payload first",
  "已加入快捷发送": "Added to quick-send",
  "已保存": "Saved",
  "新增一条": "New entry",
  "收起参数区": "Hide params panel",
  "显示参数区": "Show params panel",
  "展开 / 收起导航（窄窗口下只显示图标）": "Expand / collapse the nav (icons only in narrow windows)",
  "示例场景": "Demo scenario",
  "协议": "Protocol",
  "（无）": "(none)",
  "已载入示例：": "Demo loaded: ",
  "串行": "Serial", "总线": "Bus", "编码": "Encoding", "调试": "Debug", "现场总线": "Field bus",
  "差分 Manchester": "Differential Manchester", "NEC 红外": "NEC IR",
  "低（一体化接收头）": "Low (IR receiver module)", "高": "High",
  "设备→主机": "Device → host", "主机→设备": "Host → device",
  "I2S（标准）": "I2S (standard)", "左对齐": "Left justified", "右对齐": "Right justified",
  "低=左": "Low = left", "高=左": "High = left",
  "现在能吃：内置示例场景、VCD、CSV、原始二进制（一个字节 = 8 个通道，采样率按上面填）。真机采集（fx2lafw / DSLogic 这类 USB 逻辑分析仪）要加驱动，下一版接。":
    "Sources: built-in demo scenarios, VCD, CSV, raw binary (one byte = 8 channels, sample rate from the field above). Real device capture (fx2lafw / DSLogic USB analyzers) needs a driver — next version.",
  "传感": "Sensor", "音频": "Audio", "红外": "IR", "测量": "Measure",
  "数据位": "Data bits", "校验": "Parity", "停止位": "Stop bits", "极性": "Polarity",
  "模式": "Mode", "位序": "Bit order", "字长": "Word size", "约定": "Convention",
  "位深": "Bit depth", "格式": "Format", "声道": "Channels", "型号": "Model",
  "载波电平": "Carrier level", "方向": "Direction", "比特率": "Bitrate", "波特率": "Baud",
  "复位低电平(µs)": "Reset low (µs)", "显示前几个槽": "Show first slots",
  "常用总线（UART / PWM / I2C / SPI / DS18B20 / NEC）": "Common buses (UART / PWM / I2C / SPI / DS18B20 / NEC)",
  "调试与音频（CAN / JTAG / I2S / PS2）": "Debug & audio (CAN / JTAG / I2S / PS2)",
  "编码与工业总线（Manchester / DHT / LIN / Modbus / SWD / DMX）": "Encoding & fieldbus (Manchester / DHT / LIN / Modbus / SWD / DMX)",
  "UART 115200 · 1 kHz PWM · I2C 读写 · SPI 读 JEDEC ID · DS18B20 温度 · NEC 红外": "UART 115200 · 1 kHz PWM · I2C read/write · SPI JEDEC ID · DS18B20 temperature · NEC IR",
  "CAN 250k（标准帧 + 扩展帧）· JTAG（IR 4 位 + DR 16 位）· I2S 16 位 · PS/2 键盘两帧": "CAN 250k (standard + extended) · JTAG (IR 4 bit + DR 16 bit) · I2S 16 bit · PS/2 keyboard frames",
  "Manchester · 差分 Manchester · Miller · DHT22 · 1-Wire ROM · LIN · Modbus RTU · SWD · DMX512": "Manchester · differential Manchester · Miller · DHT22 · 1-Wire ROM · LIN · Modbus RTU · SWD · DMX512",
  "（无）通道": "(none)",
  "示例信号（UART 115200 / 1kHz PWM / SPI 读 JEDEC ID）": "Demo signal (UART 115200 / 1 kHz PWM / SPI JEDEC ID read)",
  "已载入示例信号": "Demo signal loaded",
  "通道": "Channel",
  "二进制": "Binary",
  "采样率已改为 ": "Sample rate set to ",
  "{n} 路 / {m} 点 / {t}": "{n} ch / {m} samples / {t}",
  "每屏 ": "per screen ",
  "窗口 {a} ~ {b}": "window {a} ~ {b}",
  "导入 VCD": "Imported VCD",
  "导入 CSV": "Imported CSV",
  "导入二进制": "Imported binary",
  "{n} 个信号 / {m} 点": "{n} signals / {m} samples",
  "{m} 点": "{m} samples",
  "捕获文件": "Capture files",
  "所有文件": "All files",
  "导入逻辑分析仪数据（VCD / CSV）": "Import logic data (VCD / CSV)",
  "导入原始二进制（一个字节 = 8 个通道）": "Import raw binary (one byte = 8 channels)",
  "已导入 ": "Imported ",
  "VCD 里没找到信号（只支持单比特标量）": "no signals found in that VCD (single-bit scalars only)",
  "CSV 是空的": "the CSV is empty",
  "CSV 里没有采样": "the CSV has no samples",
  "现在能吃：示例信号、VCD、CSV、原始二进制（一个字节 = 8 个通道，采样率按上面填）。 真机采集（fx2lafw / DSLogic 这类 USB 逻辑分析仪）要加驱动，下一版接。": "Sources: demo signal, VCD, CSV, raw binary (one byte = 8 channels, sample rate as above). Live capture (fx2lafw / DSLogic USB analyzers) needs a driver and lands next version.",

  // 传输页：序号列
  "序号": "Line no.",
  "每行前面显示行号（从 1 开始；清屏后重新数，上翻看历史时也对得上）": "Show a line number on each line (starts at 1, restarts after clearing, and stays stable when you scroll back)",

  // 批量文本：比对箭头
  "跟随输入": "Follow input",
  "右边改过之后就不再跟着输入走了，点这个恢复跟随": "Once the right side is edited it stops following the input; click to follow again",
  "把这一处搬到右边": "Move this block to the right",
  "把这一处写回左边输入": "Write this block back to the input",
  "已把这一处搬到右边": "Moved this block to the right",
  "（右边已固定，不再跟着输入走）": " (right side pinned, no longer following the input)",
  "已把这一处写回左边输入": "Wrote this block back to the input",
  "右边已固定（不跟随输入）": "right side pinned (not following input)",
  "右边恢复跟随输入": "the right side follows the input again",

  // 批量文本：比对右边来源
  "挑一个文件跟输入比": "Pick a file to compare with the input",
  "右边：": "right: ",

  // 批量文本：文本比对
  "比对": "Compare",
  "跟 IDE 一样把左右两份文本并排比对（F7 / Shift+F7 跳差异，Esc 退出）": "Side-by-side compare of the two texts, like an IDE (F7 / Shift+F7 jump, Esc exits)",
  "比对：输入 ↔ 结果": "Compare: input ↔ result",
  "忽略首尾空白": "Ignore outer spaces",
  "上一处": "Previous",
  "下一处": "Next",
  "上一处（Shift+F7）": "Previous (Shift+F7)",
  "下一处（F7）": "Next (F7)",
  "↑ 上一处": "↑ Previous",
  "↓ 下一处": "↓ Next",
  "返回编辑": "Back to editing",
  "退出比对（Esc）": "Exit compare (Esc)",
  "{n} 处不同": "{n} differences",
  "改 {m} · 加 {a} · 删 {d}": "changed {m} · added {a} · removed {d}",
  "两边完全一样": "the two sides are identical",

  // 批量文本：行号栏 / 状态栏 / 导入文件
  "从文件读进来；也可以把文件直接拖到下面这个框上": "Read from a file; you can also drop a file on the box below",
  "导入文本文件": "Import a text file",
  "文本 / 日志 / CSV": "Text / log / CSV",
  "所有文件": "All files",
  "已导入 {name}（{n} 字节{enc}）": "Imported {name} ({n} bytes{enc})",
  "，不是 UTF-8，已按替换字符显示": ", not UTF-8 - shown with replacement characters",
  "导入失败：": "Import failed: ",
  "已填入示例（一行一条，像 AT 指令那样）": "Sample filled in (one per line, AT-command style)",
  "行 {r}, 列 {c}": "Ln {r}, Col {c}",
  "选中 {n}": "{n} selected",
  "{n} 字符": "{n} chars",
  "{n} 字节": "{n} bytes",
  "{n} 行": "{n} lines",

  // 批量文本：缩进那几个小标签
  "2 空格": "2 spaces",
  "4 空格": "4 spaces",
  "1 空格": "1 space",

  // 批量文本（补）
  "格式化 · 压缩": "Format · minify",
  "原样 · HEX · JSON · CSV": "As-is · HEX · JSON · CSV",
  "一行一行发到当前串口（每行按上面的行尾设置），发完自动停；发送中再点一次就停下。": "Sends one line at a time on the current port (each line uses the line ending above) and stops when done; click again while sending to stop.",

  // 批量文本右栏（重排后的那几张卡）
  "查找 / 替换 / 改写": "Find / replace / rewrite",
  "Ctrl+F 找 · F3 下一个": "Ctrl+F to find · F3 next",
  "匹配": "Match",
  "选中部分": "Selection",
  "每一行": "Each line",
  "整篇": "Whole text",
  "留空 = 删掉匹配": "empty = delete the match",
  "已替换 ": "replaced ",
  "没找到要替换的": "nothing to replace",
  "这一卡改的是": "This card edits the ",
  "左边输入框": "left input box",
  "；范围选「选中部分」时只改选中的那段；正则里的 ^ $ 在「每一行」和「整篇」下含义不同。": "; with Selection it only touches the selected part. In regex mode ^ and $ differ between Each line and Whole text.",
  "按标准 JSON 解析后再排版（看不懂就告诉你错在第几个字符，并退一步按花括号重排）。一行一份 JSON 的日志也认。": "Parses it as real JSON, then re-indents (on failure it tells you the character position and falls back to brace re-indenting). One JSON per line also works.",
  "实时作用在结果与发送": "applies live to the result and to sending",
  "按行": "Lines",
  "行号": "Numbering",
  "从几开始": "start at",
  "去首尾空白": "Trim",
  "去重": "Dedupe",
  "每行大小写": "Line case",
  "前缀 / 后缀里可以写": "Prefix / suffix accept ",
  "（按控制字符发）。": " (sent as control characters).",
  "HEX 那几种按 UTF-8 字节转（中文也行）": "The HEX ones use UTF-8 bytes (Chinese included)",
  "花括号自动": "Auto braces",

  // 视频带宽计算（第二组：明细/悬停提示）
  "色深": "Color depth",
  "时序": "Timing",
  "像素时钟": "Pixel clock",
  "常用规格": "Presets",
  "模式：{m}": "Mode: {m}",
  "模式带宽 {b} Gbps": "Mode bandwidth {b} Gbps",
  "需要 {b} Gbps": "Requires {b} Gbps",
  "DSC 可用 {n} bpp（压缩率约 {p}%）": "DSC offers {n} bpp (~{p}% compression)",
  "这一档不用 DSC": "no DSC needed on this mode",
  "这个版本支持 HDR": "this version supports HDR",
  "原因：{r}": "Reason: {r}",
  "最高模式带宽 {b} Gbps": "Top mode bandwidth {b} Gbps",

  // 视频带宽计算（数据计算页）
  "视频带宽计算": "Video bandwidth",
  "分辨率 · 刷新率 · 色深 · 色度 → 峰值 / Line / Active / DSC + 各接口能不能扛": "resolution · refresh · depth · chroma → peak / Line / Active / DSC + per-interface verdicts",
  "画面": "Signal",
  "色度": "Chroma",
  "点一下填进上面": "click one to fill the fields above",
  "CVT 系会把宽度向下取整到 8 的倍数（1366 → 1360）": "CVT rounds the width down to a multiple of 8 (1366 → 1360)",
  "带宽（峰值）": "Bandwidth (peak)",
  "DSC（8 bpp 下限）": "DSC (8 bpp floor)",
  "点一下复制这个数": "click to copy this number",
  "DSC 按固定 8 bpp 估的理论下限，跟输入的色深无关；实际压缩码率会更高。": "DSC is the theoretical 8 bpp floor and ignores the color depth above; a real compressed bitrate is higher.",
  "总像素（含消隐）": "Total pixels (with blanking)",
  "有效像素": "Active pixels",
  "实际刷新率": "Actual refresh rate",
  "行频": "Line rate",
  "前后肩 / 极性": "Porches / polarity",
  "时序来源": "Timing source",
  "完整 CVT": "Full CVT",
  "DMT 查表": "DMT lookup",
  "CTA-861 查表": "CTA-861 lookup",
  "支持（轻度 DSC）": "Supported, requires light DSC compression",
  "支持（重度 DSC）": "Supported, requires heavy DSC compression",
  "带宽不够": "not enough bandwidth",
  "色度格式不支持": "chroma format not supported",
  "色深超上限": "color depth above limit",
  "用量 {p}%": "Usage {p}%",
  "要的是 {r} Hz": "asked for {r} Hz",
  "查表按 ±0.5 Hz 取整匹配：请求 {a} Hz，命中的是 {b} Hz 那行。": "Lookup rounds to the nearest Hz (±0.5 Hz): asked {a} Hz, matched the {b} Hz row.",
  "这套规格算不出来": "cannot compute this signal",
  "DMT 表里没有这套时序": "not in the DMT table",
  "CTA-861 表里没有这套时序": "not in the CTA-861 table",
  "DMT 是标准分辨率表（最大 4096×2160），{spec} 不在里面 —— 表里没有 144Hz 这种高刷，也没有非标准分辨率。": "DMT only lists standard resolutions (up to 4096x2160); {spec} is not there - no high refresh like 144 Hz, no non-standard sizes.",
  "CTA-861 只收广播视频模式（而且只认逐行），{spec} 不在里面。": "CTA-861 only lists broadcast video modes (progressive only); {spec} is not there.",
  "{f} 不能是 0。": "{f} must not be 0.",
  "{f} 得是个数字。": "{f} must be a number.",
  "这几个输入都得是数字。": "these inputs must be numbers.",
  "算出来的时序里有非法值（{f}）—— 换个规格再试。": "the timing came out invalid ({f}) - try another signal.",
  "高度": "height",
  "刷新率": "refresh rate",
  "改用 CVT-RBv2": "use CVT-RBv2",
  "改用 CVT": "use CVT",
  "只算带宽账：判定「支持」只代表链路带宽够，不代表插上一定能点亮（还要看 EDID、链路训练、线缆、DSC 切片）。DP Alt Mode 只按 2 lane 算，另外 2 lane 留给 USB。": "Bandwidth arithmetic only: Supported means the link has the bandwidth, not that it will light up (EDID, link training, cable and DSC slicing are out of scope). DP Alt Mode counts 2 lanes only; the other 2 stay with USB.",

  // ── 补齐（英文模式全站扫漏出来的：调试页 / 设置 / 数据计算 / 快捷发送 / 拖动手柄 等）──
  "清空输出": "Clear output",
  "行号（序号）": "Line numbers",
  "显示 / 发送用 HEX": "Display / send as HEX",
  "没有可发送的内容": "Nothing to send", "已发送": "Sent",
  "设置…": "Settings…",
  "✎ 编辑": "✎ Edit",
  "打开快捷发送编辑器：新增 / 改 / 删": "Open the quick-send editor: add / edit / delete",
  "点某一行 = 直接发出去；行尾 ✎ 改、✕ 删；新增 / 批量整理点上面的「✎ 编辑」。": "Click a row = send it right away; ✎ edit / ✕ delete at the row end; add or bulk-edit via ✎ Edit above.",
  "连接方式：串口 / TCP 客户端 / TCP 服务端 / UDP": "Link mode: serial / TCP client / TCP server / UDP",
  "串口（窄窗口下这一排的标签会收起来）": "Serial port (labels collapse in narrow windows)",
  "波特率": "Baud",
  "用右边这个自定义波特率（窄窗口下「自定义」三个字会收起来）": "Use the custom baud rate on the right (the label collapses in narrow windows)",
  "自定义波特率（左边那个勾打开才生效）": "Custom baud rate (tick the checkbox on the left first)",
  "忽略大小写；空格还能匹配换行 / 多个空格": "Case-insensitive; a space also matches newlines / runs of spaces",
  "把右边结果搬回左边输入，接着往下处理": "Move the right-hand result back into the left input and keep editing",
  "只清没标记的（★ 的留下）": "Clear unstarred only (★ entries stay)",
  "连标记的一起清掉": "Clear everything, including starred",
  "算一次（回车同效）": "Evaluate (Enter works too)",
  "退格（删一个字符）": "Backspace (delete one character)",
  "取反": "NOT",
  "打开文件": "Open file",
  "调试控制台": "Debug console",
  "已停下": "Stopped",
  "停下就刷新面板": "Refresh panels when stopped",
  "刷新面板": "Refresh panels",
  "断点": "Breakpoints",
  "加断点": "Add breakpoint",
  "调用栈": "Call stack",
  "局部变量": "Locals",
  "寄存器": "Registers",
  "gdb 路径": "gdb path",
  "附加参数": "Extra args",
  "启动 gdb": "Start gdb",
  "关闭 gdb": "Stop gdb",
  "可执行文件": "Executable",
  "启动 Server": "Start server",
  "停 Server": "Stop server",
  "固件 / 运行控制": "Firmware / run control",
  "载入固件": "Load firmware",
  "▶ 继续": "▶ Continue",
  "⏸ 暂停": "⏸ Halt",
  "单步": "Step",
  "下一行": "Next line",
  "跳出函数": "Finish",
  "每次 gdb 停下来（断点/单步/异常）就自动刷新右侧面板": "Auto-refresh the side panels whenever gdb stops (breakpoint / step / fault)",
  "gdb 命令（回车发送）：target extended-remote :3333 / break main / continue …": "gdb commands (Enter sends): target extended-remote :3333 / break main / continue …",
  "arm-none-eabi-gdb（留空=用 PATH 里的 gdb）": "arm-none-eabi-gdb (blank = gdb from PATH)",
  "openocd（也可以 JLinkGDBServerCL / pyocd）": "openocd (JLinkGDBServerCL / pyocd also work)",
  "选一个 .elf（file + load）": "Pick an .elf (file + load)",
  "选择文件": "Choose file",
  "monitor reset halt（openocd 语法；J-Link 用 monitor reset）": "monitor reset halt (openocd syntax; use monitor reset for J-Link)",
  "缩小": "Zoom out",
  "去设置里导入 / 新建技能": "Import / create skills in Settings",
  "去设置里新增 MCP 服务": "Add an MCP server in Settings",
  "拖动排序（同一组内）": "Drag to reorder (within the group)",
  "拖动排序（整个指令组）": "Drag to reorder (whole group)",
  "拖动调整对话区高度（双击复位）": "Drag to resize the chat area (double-click resets)",
  "列表左边显示行号（跟传输页的「序号」是同一个开关）": "Show line numbers on the left (same switch as \"No.\" on the transfer page)",
  "中文": "中文",
  "小": "Small",
  "标准": "Normal",
  "大": "Large",
  "特大": "Extra large",
  "微软雅黑": "Microsoft YaHei",
  "思源黑体 / Noto": "Noto Sans",
  "Inter / 系统无衬线": "Inter / system sans",
  "粘贴 API Key": "Paste API key",
  "斜杠指令（/xxx）": "Slash commands (/xxx)",
  "打开指令目录": "Open commands folder",
  "常驻技能清单（哪几个技能的正文每轮注入系统提示）": "Always-on skills (their body is injected into the system prompt every turn)",
  "只清「常驻」标记，技能文件本身不动": "Only clears the \"always-on\" mark; skill files stay untouched",
  "https://…（知识库后台 / 数据集管理页）": "https://… (knowledge-base admin / dataset page)",
  "https://…（问答 / 聊天页）": "https://… (Q&A / chat page)",
  "↗ 系统浏览器": "↗ System browser",
  "显示器 1 · 1920x1080": "Monitor 1 · 1920x1080",
  "显示器 2 · 3840x2160": "Monitor 2 · 3840x2160",
  "数值": "Value",
  "64 位": "64-bit",
  "128 位": "128-bit",
  "192 位": "192-bit",
  "256 位": "256-bit",
  "格式化 / 压缩 / 校验 / 排序键 / 转义": "Format / minify / validate / sort keys / escape",
  "左右随便在哪边输入，另一边实时跟着变": "Type on either side — the other follows live",
  "CBC / CTR / GCM · 128 / 192 / 256 · 本地 WebCrypto": "CBC / CTR / GCM · 128 / 192 / 256 · local WebCrypto",
  "OAEP-SHA256 加解密 · PKCS#1-SHA256 签名验签 · 可生成密钥对": "OAEP-SHA256 encrypt/decrypt · PKCS#1-SHA256 sign/verify · key-pair generation",
  "把 \\n 之类的转义还原成真内容": "Turn \\n-style escapes back into real content",
  "转成一行一字符串（便于塞进代码 / 配置）": "One string per line (easy to paste into code / config)",
  "把计算器当前的值拿过来": "Pull in the calculator's current value",
  "文件路径（直接粘也行，或者点右边「选文件…」）": "File path (paste it, or use \"Choose file…\" on the right)",
  "粘一个期望值，我告诉你它跟哪一项对得上（不分大小写、空格无所谓）": "Paste an expected value; I'll tell you which entry matches (case-insensitive, spaces ignored)",
  "HEX 或 Base64（长度跟位数对上）": "HEX or Base64 (length must match the bit width)",
  "CBC 16 字节 / CTR 16 字节 / GCM 12 字节（HEX 或 Base64）": "CBC 16 bytes / CTR 16 bytes / GCM 12 bytes (HEX or Base64)",
  "要加密的明文；解密时粘密文（按下面选的格式解析）": "Plaintext to encrypt; paste ciphertext when decrypting (parsed per the format below)",
  "要算哈希的文本（UTF-8）": "Text to hash (UTF-8)",
  "PEM/DER 文件路径，或直接粘在下面": "PEM/DER file path, or paste it below",
  "加密：明文；解密：base64 密文；签名：待签文本；验签：base64 签名": "Encrypt: plaintext; decrypt: base64 ciphertext; sign: text; verify: base64 signature",
  "只验签时填": "Only needed when verifying",
  "Kyin (任开炎)": "Kyin",
  "J-Link：": "J-Link: ",
  "（": " (",
  "）": ")",
  "库": "lib",
  "(DLL 内置库)": "(DLL, built-in lib)",
  "文件…": "File…",
  "失败: 还没有连接：先连上设备": "Error: not connected yet — connect to the device first",
  "每行前面标出 RX/TX/SYS 方向；开着时间戳时会并进同一个方括号里（SSCOM 那种一个前缀）": "Tag each line with RX/TX/SYS; when timestamps are on they share one bracket (a single prefix like SSCOM)",
  "{a} × {b}（消隐 {c} × {d}）": "{a} × {b} (blanking {c} × {d})",
  "显示器 ": "Monitor ",
  "一条 .md 一条指令：frontmatter 里写 name / description，正文就是提示词模板（里面的 {{args}} 会换成命令后面跟的参数）。把文件丢进下面的目录就行 —— 技能作者也能随技能一起分发。": "One .md = one command: frontmatter holds name / description, the body is the prompt template ({{args}} becomes whatever follows the command). Drop files into the folder below — skill authors can ship them with a skill.",
  "左边是「文件校验 / 浮点 / 进制字节序 / AES / RSA」。AES 与 RSA 走系统的 WebCrypto（浏览器内实现，不发到网上）；密钥只在你本机的框里，不写盘。": "Left column: file hashing / floating point / byte order / AES / RSA. AES and RSA use the system WebCrypto (in-browser, nothing leaves the machine); keys stay in the boxes here and are never written to disk.",
  "RIGOL DS1000Z 系标配的网口口子（TCP 5555，SCPI 文本）。连上之后 agent 也能用同一套 scope_* 工具干同样的事。": "The LAN port that ships with RIGOL DS1000Z series (TCP 5555, SCPI text). Once connected the agent can do the same things through the same scope_* tools.",
  "{\"b\":1,\"a\":[1,2,{\"c\":true}]}  或  \\\"{\\\\\\\"a\\\\\\\":1}\\\"（转义过的也行）": "{\"b\":1,\"a\":[1,2,{\"c\":true}]}  or  \"{\\\"a\\\":1}\" (escaped also works)",
  "可留空；例：-ex \"target extended-remote :3333\"": "Optional; e.g. -ex \"target extended-remote :3333\"",
  "JLink.exe (DLL 内置库)": "JLink.exe (built-in DLL)",
  "环境": "Environment",
  "环境配置": "Environment setup",
  "驱动 / 工具链的一键检测与安装": "Detect and one-click install drivers / toolchains",
  "安装位置（留空 = 默认）": "Install folder (blank = default)",
  "选一个目录当统一安装位置": "Pick one folder as the shared install location",
  "选目录": "Pick folder",
  "扫描会读 PATH / 注册表 / pnputil 的驱动列表和各盘常见目录": "Reads PATH, the registry, pnputil driver list and common folders on each drive",
  "只看缺失": "Missing only",
  "扫描本机": "Scan this PC",
  "刷新同步": "Refresh & sync",
  "强制重新检测驱动 / 工具链并刷新列表": "Force rescan drivers/toolchains and refresh the list",
  "类别": "Category",
  "全部": "All",
  "小驱动可以内置：把安装包丢进 ": "Small drivers can be bundled: drop the installer into ",
  "（exe / msi / inf 都认），点安装时会优先用本地的，不走网络。": " (exe / msi / inf all work); installing then prefers the local copy and skips the network.",
  "首次运行检查": "First-run check",
  "装齐必需项": "Install required",
  "重新扫描": "Rescan",
  "「必需项」指的是认不出设备就没法干活的那几个（比如 CH340 串口驱动）。缺了会在启动后提示一次，随时可以在这里补。": "\"Required\" means the items you cannot work without (the CH340 serial driver, say). If one is missing you get one prompt after startup; you can always add it here.",
  "安装位置": "Install folder",
  "例如 F:\\ENV": "e.g. F:\\ENV",
  "便携类（工具链 zip / git 仓库）解到这儿；winget 装的走系统默认位置。留空 = 自动（优先 F:\\ENV，没有就用用户目录下 KDock\\env）。": "Portable items (toolchain zips / git repos) unpack here; winget installs use the system default. Blank = auto (F:\\ENV if present, otherwise KDock\\env in your user folder).",
  "安装进度": "Install progress",
  "去看看": "Open it",
  "小驱动可以内置：把安装包丢进": "Small drivers can be bundled: drop the installer into ",
  "drivers\\<组件id>\\": "drivers\\<item id>\\",
  "检测中…": "Detecting…",
  "全部设备": "All devices",
  "地址": "Addr",
  "只抓这个设备节点（USB 地址来自 Hub 端口信息）": "Capture only this device node (USB address from hub port info)",
  "抓包中 · 实时": "Capturing · live",
  "正在启动抓包…": "Starting capture…",
  "正在停止…": "Stopping…",
  "停止超时（看 %TEMP% 下 kdock-usbpcap-*.err）": "Stop timed out (check kdock-usbpcap-*.err in %TEMP%)",
  "已停止 · {n} 条": "Stopped · {n} records",
  "监听": "Monitor",
  "tshark 列的网卡": "Interfaces listed by tshark",
  "tshark（Wireshark 命令行 + Npcap）": "tshark (Wireshark CLI + Npcap)",
  "Wireshark 自带的命令行抓包工具，KDock 的「监听 → 网络」用它。安装包同时带 Npcap（WinPcap 兼容驱动）。GPLv2；KDock 只调用，不打包、不链接。": "The command-line capture tool bundled with Wireshark, used by Monitor → Network. The installer also brings Npcap (a WinPcap-compatible driver). GPLv2; KDock only invokes it — no bundling, no linking.",
  "本机": "Local",
  "本机 USB": "Local USB",
  "未安装 tshark": "tshark not installed",
  "没有网卡": "No interface",
  "监听：本机 USB（USBPcap）/ 网络（tshark）原始数据": "Monitor: local USB (USBPcap) / network (tshark) raw data",
  "USBPcap（USB 抓包驱动 + 命令行）": "USBPcap (USB capture driver + CLI)",
  "开源的 USB 抓包过滤驱动：被动抓取所有设备的控制/批量/中断传输，不干扰原有逻辑。驱动 GPLv2、命令行工具 BSD-2-Clause；KDock 只调用你安装的组件，不打包、不链接它的代码。装完需要重启一次。": "Open-source USB capture filter driver: passively captures control / bulk / interrupt transfers of every device without disturbing normal operation. Driver is GPLv2, the command-line tool is BSD-2-Clause; KDock only invokes the component you install — it does not bundle or link its code. Reboot once after installing.",
  "设备视图：谁挂在哪个端口、VID/PID、速度、接口和端点、绑定到哪个驱动。原始传输（每一笔 IN/OUT 的 payload）由 USBPcap 抓取，需要先在「环境配置」里安装并重启一次。": "Device view: what sits on which port, VID/PID, speed, interfaces and endpoints, which driver it binds to. Raw transfers (the payload of every IN/OUT) come from USBPcap — install it from Environment setup and reboot once.",
  "需要重启一次": "Reboot once",
  "已安装 · 需要重启一次": "Installed · reboot once",
  "抓包": "Capture",
  "开始抓包": "Start capture",
  "停止抓包": "Stop capture",
  "未抓包": "Not capturing",
  "抓包中": "Capturing",
  "完整数据": "Full data",
  "显示/保存完整 HEX/ASCII（关闭时每行最多 128 字节；大包会让表格变长）": "Show/save full HEX/ASCII (max 128 bytes per row when off; large packets make rows longer)",
  "只看控制传输": "Control only",
  "只看控制传输：设备枚举和 RNDIS 握手都在这里": "Control transfers only: enumeration and the RNDIS handshake live here",
  "USBPcap 根 Hub（每个根 Hub 一个）": "USBPcap root hub (one per root hub)",
  "没有可抓包的根 Hub": "No root hub available",
  "未安装 USBPcap": "USBPcap not installed",
  "需要重启一次（驱动刚装）": "Reboot once (driver just installed)",
  "USBPcap 驱动状态未知，请重新插拔设备或重启电脑": "USBPcap driver state is unknown; reconnect the device or reboot",
  "已就绪": "Ready",
  "已就绪（开始抓包时会请求管理员权限）": "Ready (administrator permission is requested when capture starts)",
  "没有可用的根 Hub": "No root hub available",
  "—— 开始抓包 ": "—— capture started ",
  "—— 已停止抓包 ——": "—— capture stopped ——",
  "串口节点（也可以直接在左边列表里点一个设备）": "Serial node (or click a device in the list)",
  "监听目标": "Monitor target",
  "开始监听": "Start monitoring",
  "停止监听": "Stop monitoring",
  "未监听": "Not monitoring",
  "等待设备…": "Waiting for device…",
  "监听中": "Monitoring",
  "等待设备重连…": "Waiting for the device to reconnect…",
  "先选一个设备或串口": "Pick a device or serial port first",
  "—— 开始监听 ": "—— monitoring ",
  "—— 已连接 ": "—— connected ",
  "—— 设备断开，等待重连 ——": "—— device disconnected, waiting for reconnect ——",
  "—— 已停止监听 ——": "—— monitoring stopped ——",
  "保存…": "Save…",
  "要抓原始数据的串口": "Serial port to capture",
  "发送内容（文本或 HEX，回车发送）": "Data to send (text or HEX; Enter to send)",
  "抓取中": "capturing",
  "未打开": "closed",
  "先选一个串口": "Pick a serial port first",
  "没有串口": "No serial port",
  "还没有数据": "No data yet",
  "串口读取失败：": "Serial read failed: ",
  "存储": "Storage", "音频": "Audio", "相机": "Camera", "打印机": "Printer", "复合": "Composite",
  "设备管理器": "Device manager",
  "管理员读取": "Read as admin",
  "警告 {n}": "Warnings: {n}",
  "需要管理员权限才能读取 Hub 端口和描述符": "Administrator rights are required to read hub ports and descriptors",
  "设备详情": "Device details",
  "串口（COM）": "Serial ports (COM)",
  "USB 设备 {n} · 端口设备 {m} · 串口 {s}": "USB devices {n} · port devices {m} · serial {s}",
  "非 USB": "not USB",
  "序列号": "Serial number",
  "产品": "Product",
  "设备未配置": "Not configured",
  "无法启动": "Cannot start",
  "已停用": "Disabled",
  "设备未安装": "Not installed",
  "没有驱动": "No driver",
  "驱动加载失败": "Driver failed to load",
  "驱动故障": "Driver failure",
  "问题码": "Problem code",
  "新插入": "new",
  "已拔出": "removed",
  "已拔出（{n}）": "Removed ({n})",
  " · 新插入 {n}": " · new {n}",
  " · 已拔出 {n}": " · removed {n}",
  "设备列表不需要权限；端口拓扑、设备描述符、配置/接口/端点要打开 Hub 句柄，Windows 要求管理员 —— 点上面按钮会弹一次 UAC，子进程读完就退出，主程序不提权。": "The device list needs no privileges; port topology and descriptors require opening the hub handle, which Windows only allows to administrators — the button above raises one UAC prompt, a child process reads once and exits, and the main app stays unelevated.",
  "刷新": "Refresh",
  "USB 设备": "USB devices",
  "端口 / 描述符可读": "Ports / descriptors readable",
  "只读设备列表": "Device list only",
  "USB 诊断": "USB",
  "USB 设备树 / 描述符 / 端口（免驱，不装过滤驱动）": "USB device tree / descriptors / ports (driver-free)",
  "每 3 秒重扫一次，热插拔会记到下面的日志": "Rescan every 3 s; hot-plug events land in the log below",
  "端口拓扑 / 设备描述符需要管理员权限（弹一次 UAC）": "Port topology / descriptors need admin (one UAC prompt)",
  "以管理员读取端口": "Read ports as admin",
  "点左边一个设备看描述符": "Pick a device on the left to see its descriptors",
  "热插拔": "Hot-plug",
  "以管理员读取端口 / 描述符": "Read ports / descriptors as admin",
  "说明": "Notes",
  "警告": "Warnings",
  "等待 UAC 授权…": "Waiting for UAC…",
  "已读到端口 / 描述符": "Ports / descriptors loaded",
  "读取权限": "Access",
  "管理员（端口 / 描述符可读）": "Administrator (ports / descriptors readable)",
  "普通（只读设备列表）": "Standard (device list only)",
  "端口拓扑要管理员权限：点上面的「以管理员读取端口」。": "Port topology needs administrator rights: click \"Read ports as admin\" above.",
  "所有 USB 设备（SetupAPI）": "All USB devices (SetupAPI)",
  "端口设备": "Port device",
  "设备类": "Class",
  "配置数": "Configurations",
  "配置描述符": "Configuration descriptor",
  "接口数": "Interfaces",
  "自供电": "Self-powered",
  "最大电流": "Max power",
  "接口 {n}": "Interface {n}",
  "端点": "Endpoint", "传输成功": "Transfer succeeded", "传输失败": "Transfer failed",
  "方向": "Dir",
  "类型": "Type",
  "包大小": "Max packet",
  "间隔": "Interval",
  "这个端口没读到配置描述符（设备可能需要先被驱动认领，或读取被拒绝）。": "No configuration descriptor for this port (the device may need a driver bound first, or the read was refused).",
  "设备实例": "Instance",
  "驱动服务": "Driver service",
  "厂商": "Manufacturer",
  "位置": "Location",
  "USB 设备 {n} · 端口设备 {m}": "USB devices {n} · port devices {m}",
  "端口 {n} · {s}": "Port {n} · {s}",
  "Hub 数": "Hubs",
  "端口上的设备": "Devices on ports",
  "网络": "Network",
  "蓝牙": "Bluetooth",
  "Silicon Labs CP210x 串口驱动": "Silicon Labs CP210x serial driver",
  "CP2102 / CP2104 / CP2105 / CP2108 —— 开发板最常见的 USB 转串口之一。装完才会出现 COM 口。": "CP2102 / CP2104 / CP2105 / CP2108 — one of the most common USB-to-serial chips on dev boards. No COM port until this is installed.",
  "Prolific PL2303 串口驱动": "Prolific PL2303 serial driver",
  "老款 USB 转串口，工业设备和老开发板很多。注意新版 Windows 上老芯片会被官方驱动拒认，必要时用内置的旧版安装包。": "An older USB-to-serial chip, common in industrial gear and older boards. Note that on recent Windows the official driver rejects some old chips — use a bundled older installer if needed.",
  "Microchip MCP2200 / MCP2221 驱动": "Microchip MCP2200 / MCP2221 driver",
  "USB 转串口 + GPIO / I2C 的桥接芯片，Microchip 官方 CDC 驱动。": "USB-to-serial plus GPIO / I2C bridge chip; installs Microchip's official CDC driver.",
  "Infineon / Cypress USB-Serial 驱动": "Infineon / Cypress USB-Serial driver",
  "CY7C65211 / CY7C65215 这类 USB-Serial 桥接（也带 GPIO / I2C / SPI）。": "CY7C65211 / CY7C65215 USB-Serial bridges (also expose GPIO / I2C / SPI).",
  "Infineon TriBoard / DAS JDS": "Infineon TriBoard / DAS JDS",
  "AURIX TC3xx TriBoard 的板载 DAS JDS 调试口与串口。识别到后会同时出现 Infineon DAS JDS Debug 和 Infineon DAS JDS COM。": "On-board DAS JDS debug and serial interfaces on AURIX TC3xx TriBoards. A working connection exposes both Infineon DAS JDS Debug and Infineon DAS JDS COM.",
  "SEGGER J-Link / J-Link OB 探针": "SEGGER J-Link / J-Link OB probe",
  "当前接入的 J-Link / J-Link OB 调试探针（USB VID 1366）。J-Link OB 常见于开发板板载调试器，可能同时提供 JLink CDC UART 串口。": "Connected J-Link / J-Link OB probe (USB VID 1366). J-Link OB is often the on-board debugger on a development board and may also expose a JLink CDC UART port.",
  "CMSIS-DAP / DAPLink 调试探针": "CMSIS-DAP / DAPLink debug probe",
  "通过 pyOCD 动态枚举任意厂商的 CMSIS-DAP / DAPLink 探针；型号、唯一 ID 和可选 CDC 串口都从实际设备读取，不绑定 VID/PID。": "Dynamically enumerate CMSIS-DAP / DAPLink probes from any vendor through pyOCD. Model, unique ID and optional CDC port come from the connected device, with no VID/PID binding.",
  "WCH-Link / WCH-LinkE 驱动": "WCH-Link / WCH-LinkE driver",
  "沁恒 RISC-V / Cortex-M 调试器（WCH-Link、WCH-LinkE）。用 WCH-LinkUtility 或 MounRiver 时会装。": "WCH RISC-V / Cortex-M debug probes (WCH-Link, WCH-LinkE). Installed together with WCH-LinkUtility or MounRiver.",
  "TI XDS110 / XDS100 驱动": "TI XDS110 / XDS100 driver",
  "TI MSP430 / C2000 / Sitara 的 XDS110、XDS100 调试探针驱动（CCS 里带，也可以单独装）。": "Driver for TI XDS110 / XDS100 probes (MSP430 / C2000 / Sitara). Ships with CCS or can be installed separately.",
  "自动 / 全部网卡": "Auto / all interfaces",
  "网卡": "Interface",
  "探针 UID": "Probe UID",
  "网络设备（UDP 服务，.fw）": "Network device (UDP service, .fw)",
  "pyOCD（CMSIS-DAP / WCH-Link / ST-Link）": "pyOCD (CMSIS-DAP / WCH-Link / ST-Link)",
  "Infineon AURIX Flasher": "Infineon AURIX Flasher",
  "Python 3": "Python 3",
  "脚本与工具依赖：pyOCD、esptool、pyserial、intelhex 这些都要它。装完记得勾 Add to PATH（winget 默认会加）。": "Needed for pyOCD, esptool, pyserial, intelhex and other scripting tools. Keep \"Add to PATH\" checked (winget does by default).",
  "Git（含 Git LFS 可用）": "Git (Git LFS available)",
  "版本控制；RT-Thread Env 拉包、很多 SDK 的 submodule 都靠它。": "Version control; RT-Thread Env package fetching and many SDK submodules rely on it.",
  "CMake": "CMake",
  "跨平台构建系统：STM32Cube / ESP-IDF / Zephyr / 大多数现代嵌入式工程都用它生成 Ninja / Make 工程。": "Cross-platform build system: STM32Cube / ESP-IDF / Zephyr and most modern embedded projects use it to generate Ninja / Make projects.",
  "Ninja": "Ninja",
  "CMake 最常用的后端：比 Make 快很多，几乎所有嵌入式 IDE 的默认选择。": "The usual CMake backend: much faster than Make and the default in most embedded IDEs.",
  "Meson": "Meson",
  "另一套现代构建系统（Zephyr / 部分开源 BSP 在用），配合 Ninja。": "Another modern build system (used by Zephyr and some open BSPs), paired with Ninja.",
  "LLVM / Clang + lld": "LLVM / Clang + lld",
  "替代 GCC 的编译器，部分工程（RISC-V / 嵌入式 Rust / 某些 SDK）需要；也自带 lld 链接器。": "A GCC alternative needed by some projects (RISC-V / embedded Rust / certain SDKs); includes the lld linker.",
  "OpenSSL": "OpenSSL",
  "生成密钥 / 证书 / 摘要，固件签名和 TLS 调试都会用到。": "Generate keys / certificates / digests; used for firmware signing and TLS debugging.",
  "QEMU": "QEMU",
  "仿真运行：没有板子时跑 ARM / RISC-V Linux、跑 U-Boot 验证镜像。": "Emulation: run ARM / RISC-V Linux or boot U-Boot images without hardware.",
  "Renode": "Renode",
  "无板仿真：整块板子（CPU + 外设 + 网络）都能模拟，适合 CI 里跑固件。": "Board-level emulation (CPU + peripherals + networking) — good for running firmware in CI.",
  "Device Tree Compiler（dtc）": "Device Tree Compiler (dtc)",
  "编译 / 反编译设备树（.dts ↔ .dtb），Linux BSP 和 U-Boot 常用。": "Compile / decompile device trees (.dts ↔ .dtb); common in Linux BSPs and U-Boot.",
  "UsbDk Runtime": "UsbDk Runtime",
  "USB 设备重定向 / 抓包用的通用运行时（Wireshark 的 USBPcap、部分虚拟化工具依赖）。": "Generic runtime for USB device redirection / capture (used by USBPcap in Wireshark and some virtualisation tools).",
  "Wireshark": "Wireshark",
  "网络 / USB / BLE / CAN 抓包分析。配合 USBPcap、nRF Sniffer 用。": "Network / USB / BLE / CAN capture analysis. Works with USBPcap and the nRF Sniffer.",
  "MobaXterm": "MobaXterm",
  "终端 + 串口 + X11 + SFTP 的多合一工具（A 核 / Linux 板子常用）。": "Terminal + serial + X11 + SFTP in one (common for Cortex-A / Linux boards).",
  "DAPLink / CMSIS-DAP（pyOCD）": "DAPLink / CMSIS-DAP (pyOCD)",
  "DAPLink、CMSIS-DAP、ST-Link、J-Link 的调试与烧录 CLI。装好后可运行 pyocd list 检查烧录器；DAPLink 设备通常还需要在 Windows 上正确绑定 HID/WinUSB 驱动。": "Debug and flash CLI for DAPLink, CMSIS-DAP, ST-Link and J-Link. After installing, run pyocd list to check the probe; DAPLink usually also needs the correct HID/WinUSB driver binding on Windows.",
  "STM32CubeProgrammer（ST-Link / USB DFU / UART ROM）": "STM32CubeProgrammer (ST-Link / USB DFU / UART ROM)",
  "ST 官方烧录 CLI。KDock 用它走 ST-Link，也用它连接 STM32 出厂系统 Bootloader：USB DFU（BOOT0=1）或 UART（BOOT0=1，接芯片指定 USART）。": "ST's official flashing CLI. KDock uses it with ST-Link and to connect the STM32 factory system bootloader over USB DFU (BOOT0=1) or UART (BOOT0=1 on the documented USART).",
  "esptool（ESP32 烧录）": "esptool (ESP32 flashing)",
  "ESP32 / ESP8266 的烧录、读 MAC、擦除、读 Flash。需要先装 Python。": "Flash, read MAC, erase and read flash on ESP32 / ESP8266. Requires Python.",
  "ESP-IDF（安装管理器）": "ESP-IDF (installation manager)",
  "乐鑫官方 ESP-IDF 安装管理器 CLI：装工具链、拉 SDK、切版本都在它里面。": "Espressif's official ESP-IDF installation manager CLI: installs the toolchain, fetches the SDK and switches versions.",
  "nRF Util（Nordic CLI）": "nRF Util (Nordic CLI)",
  "Nordic 的通用 CLI：nRF52 系列 DFU 打包 / 烧录、BLE 调试辅助（nrfutil device / dfu）。": "Nordic's general CLI: nRF52 DFU packaging / flashing and BLE debugging helpers (nrfutil device / dfu).",
  "nRF Connect for Desktop（BLE 调试）": "nRF Connect for Desktop (BLE debugging)",
  "Nordic 的 BLE 桌面工具：扫广播、连 GATT、读写特征值、看 RSSI，配 nRF Sniffer 还能抓 BLE 包。Windows 自带蓝牙协议栈，不用另装驱动。": "Nordic's BLE desktop tool: scan advertisements, connect to GATT, read/write characteristics, watch RSSI; with the nRF Sniffer it can capture BLE packets. Windows already ships the Bluetooth stack, so no extra driver is needed.",
  "人格 / 口吻 / 通用规矩写这儿（等价于 Codex 的全局 AGENTS.md）。\n例：\n# 身份\n- 说话简短，先给结论。\n- 做事前先看现状，改设备状态前先说明。": "Persona / tone / general rules go here (the equivalent of Codex's global AGENTS.md).\nExample:\n# Identity\n- Be brief, lead with the conclusion.\n- Look at the current state first; explain before changing device state.",
  "倒计时 ·": "Countdown ·",
  "定时 ·": "Scheduled ·",
  "<工作区>/.kdock_skill/<名字>/SKILL.md": "<workspace>/.kdock_skill/<name>/SKILL.md",
  "需批准": "needs approval",
  "连接设置": "Connection",
  "添加并使用": "Add and use",
  "按 F1 打开当前页面的帮助，或从下面选择。": "Press F1 to open help for the current page, or pick one below.",
  "打开当前页帮助": "Open help for this page",
  "示波器连接": "Scope connection",
  "两层分工（照 Codex 的规矩）：": "Two layers (the Codex way):",
  "是按需读的流程 —— 上下文里只有一行 「名字 — 什么时候用」，正文要模型自己读；": "is on-demand: the context only carries one line \"name — when to use it\"; the model reads the body itself;",
  "是一直播在场的东西 （人格 / 口吻 / 通用规矩 / 项目规矩）。程序自带的行为规则不在这里，也不对外开放。": "is always present (persona / tone / general rules / project rules). Built-in behaviour rules are not here and are not exposed.",
  "指导文件 AGENTS.md": "Guidance file AGENTS.md",
  "转到哪个工作区": "Target workspace",
  "把列表里选中的技能复制到该工作区，再从全局移除（自动在 skill-archive 留一份备份）": "Copy the selected skill into that workspace and remove it from global (a backup is kept in skill-archive)",
  "看哪个工作区的技能": "Workspace whose skills to show",
  "放在": "lives at",
  "，随项目走": ", travels with the project",
  "这里是": "This is where",
  "只读清单 + 使用/不使用": "Read-only list + enable/disable",
  "：关掉用不上的工具，模型会少被无关工具干扰、少误调。 开关对": ": turn off tools you do not need so the model is less distracted and makes fewer wrong calls. The switch applies to",
  "生效（工具清单按会话固定，这样前面的上下文才好复用缓存）。": "is effective (the tool list is fixed per session so earlier context stays cache-friendly).",
  "/timer 10m 任务": "/timer 10m <task>",
  "倒计时 · ": "Countdown · ",
  "/at 09:30 任务": "/at 09:30 <task>",
  "定时 · ": "Scheduled · ",
  "全屏（F11）；退出按 Esc 或再按一次": "Full screen (F11); Esc or click again to exit",
  "把当前这一帧存成 PNG": "Save the current frame as PNG",
  "内置投屏：抓屏轮询，画面可直接点（反向控制）": "Built-in mirroring: polls screenshots; click directly on the picture (reverse control)",
  "用 scrcpy 投屏（独立窗口，更丝滑；需要先装 scrcpy）": "Mirror with scrcpy (separate window, smoother; requires scrcpy)",
  "scrcpy：没找到（要丝滑投屏就到「环境配置」装一下）": "scrcpy: not found (install it from Environment setup for smooth mirroring)",
  "内网设备大多是自签名证书；不勾就一直用系统信任根校验": "LAN devices usually use self-signed certs; leave unchecked to keep the system trust roots",
  "在设备/服务器上新建目录": "Create a directory on the device/server",
  "删掉列表里选中的那一个（目录也能删，非空目录会被拒绝）": "Delete the selected entry (directories too; non-empty ones are refused)",
  "打开后允许设备把文件写进来（慎用：会落到根目录下）": "When on, the device may write files in (careful: they land in the root)",
  "自带地址；": "comes with an address;",
  "需填写起始地址。": "An address is required.",
  "请在「固件升级」页使用。": "Use this on the Firmware page.",
  "示波器 IP，例如 192.168.1.100": "Scope IP, e.g. 192.168.1.100",
  "本机桌面走 DXGI；VNC 能控制键鼠；RTSP / RTMP / H.264 交给 FFmpeg 解码": "Local desktop uses DXGI; VNC can control mouse/keyboard; RTSP / RTMP / H.264 are decoded by FFmpeg",
  "打开后：画面里点一下 = 点手机；拖动 = 滑动；上面那行还能直接发按键和文字": "When on: click = tap, drag = swipe; the row above can also send keys and text",
  "已装过就覆盖安装（adb install -r）": "Overwrite if already installed (adb install -r)",
  "列出第三方包（点一下填进来）": "List third-party packages (click to fill in)",
  "解码结果": "Decode results",
  "NEC 地址 ": "NEC address ",
  " 命令 ": " command ",
  " 取反校验错": " inverted check failed",
  "sigrok-cli（逻辑分析仪的采集后端）": "sigrok-cli (logic analyzer capture backend)",
  "PulseView 同门的命令行采集工具。KDock 的「逻辑分析仪 → 真机」就是调它：fx2lafw（Saleae Logic / 各种 FX2 板）、saleae-logic16、DSLogic 这些都能用。装完不用配置，回到页面点 ↻ 就能看到设备。": "The command-line capture tool from the PulseView project. KDock's logic analyzer uses it for real-device capture: fx2lafw (old Saleae Logic / generic FX2 boards), saleae-logic16 and DSLogic all work. No configuration needed — reopen the page and click ↻.",
  "DSLogic（梦源）固件": "DSLogic (DreamSourceLab) firmware",
  "梦源 DSLogic 系列（Basic / Plus / Pro / U2 / U3）在 sigrok 里要这两样固件：FX2 固件 + FPGA 位流。没有它们，插上 DSLogic 也扫不到设备（sigrok-cli 会报找不到固件）。装到 sigrok-cli 的 share\\sigrok-firmware 下。": "DreamSourceLab DSLogic (Basic / Plus / Pro / U2 / U3) needs two firmware pieces under sigrok: the FX2 firmware and the FPGA bitstream. Without them a plugged-in DSLogic is not even detected (sigrok-cli reports missing firmware). Installs into sigrok-cli's share\\sigrok-firmware.",
  "真机": "Device",
  "点数": "Samples",
  "采集": "Capture",
  "扫描设备中…": "Scanning devices…",
  "没有找到设备": "No device found",
  "不可用": "Unavailable",
  "没找到逻辑分析仪（接了设备的话检查驱动）": "No logic analyzer found (check the driver if one is plugged in)",
  "先选一台设备（没列出来的话点 ↻）": "Pick a device first (click ↻ if it is not listed)",
  "至少勾一个通道": "Tick at least one channel",
  "采集中…": "Capturing…",
  "上一次采集还没结束": "The previous capture has not finished",
  "找到 {n} 台设备": "Found {n} device(s)",
  "采到 {n} 点 · {ms} ms": "Captured {n} samples · {ms} ms",
  "采到 {n} 点（{r}）": "Captured {n} samples ({r})",
  "sigrok 看到的设备（fx2lafw / Saleae / DSLogic…）": "Devices sigrok can see (fx2lafw / Saleae / DSLogic…)",
  "重新扫描设备": "Rescan devices",
  "设备支持的采样率": "Sample rates the device supports",
  "这次采多少个点": "How many samples to capture",
  "需要装 USB 驱动的会弹一次 UAC 授权（驱动必须提权，我们不做静默绕过）。WCH / FTDI / SEGGER 官网的下载要点勾选同意，所以那几项只给官网入口 —— 或者把安装包丢进上面的\"内置\"目录，一键装。": "Installing a USB driver raises one UAC prompt (drivers need elevation and we never bypass it silently). WCH / FTDI / SEGGER gate their downloads behind a consent checkbox, so those items only link to the official site — or drop the installer into the bundled folder above and use the one-click install.",
  "正在扫描本机…": "Scanning this PC…",
  "扫描失败：": "Scan failed: ",
  "没有符合条件的组件": "No component matches the filter",
  "已装 ": "Installed ",
  " · 未装 ": " · missing ",
  " · 可更新 ": " · updatable ",
  "缺必需项：": "Missing required: ",
  "必需项都齐了": "All required items present",
  "可更新": "Update available",
  "已装": "installed",
  "未安装": "Not installed",
  "检查状态": "Check status",
  "驱动未加载": "driver not loaded",
  "通信": "Communication",
  "工作区与执行": "Workspace & execution",
  "设备与固件": "Devices & firmware",
  "安卓调试": "Android debugging",
  "仪器与固件分析": "Instruments & firmware analysis",
  "屏幕与图像": "Screen & images",
  "中控编排": "Workflow",
  "技能与环境": "Skills & environment",
  "界面与上下文": "UI & context",
  "其他": "Other",
  "全开": "Enable all",
  "全关": "Disable all",
  "基本工具，不可关闭": "Core tool; cannot be disabled",
  "更新 / 重装": "Update / reinstall",
  "一键安装": "Install",
  "打开官网": "Open website",
  "这个要登录 / 同意条款才能下：官网下完，把安装包丢进内置目录就能一键装。": "Needs a login / consent click to download: grab it from the site, drop the installer into the bundled folder, then one-click install.",
  "我下好了，用本地的装": "I downloaded it — install from local",
  "把安装包放进 <exe 同目录>\\drivers\\<组件id>\\ 之后再点这个": "Put the installer in <exe folder>\\drivers\\<item id>\\ first, then click this",
  "定位": "Locate",
  "必需项": "Required",
  "齐了": "All set",
  "上次扫描": "Last scan",
  "先等这个装完：": "Wait for this one to finish: ",
  "（模拟，不真装）": " (dry run, nothing is installed)",
  "完成，重新扫描…": "Done, rescanning…",
  "失败：": "Failed: ",
  "环境检查：有必需驱动没装": "Environment check: required drivers are missing",
  "现在去「环境配置」一键安装？（需要提权的会弹一次 UAC）": "Open Environment setup and install now? (anything needing elevation raises one UAC prompt)",
  "有 ": "There are ",
  " 个组件可以更新（环境配置页）": " components with updates (Environment setup page)",
  "开始扫描本机…": "Scanning this PC…",
  "扫描完成": "Scan finished",
  "选一个统一的安装位置": "Pick a shared install location",
  "必需项没有能一键装的（点卡片上的官网入口自己去装）": "The required items have no one-click install (use their website link on the card)",
  "USB 驱动": "USB driver",
  "调试器": "Debugger",
  "工具链": "Toolchain",
  "运行时": "Runtime",
  // 本轮新增的类别（环境配置页的分类按钮）
  "GUI": "GUI", "MQTT": "MQTT", "总线": "Fieldbus",
  // Rust 工具链 / MSVC / probe-rs
  "Rust 工具链（rustup + cargo）": "Rust toolchain (rustup + cargo)",
  "Rust 编译器与包管理器。装嵌入式 Rust 时用它加目标架构（rustup target add thumbv7em-none-eabihf）。默认用 MSVC 链接器，所以 MSVC 生成工具也要装。":
    "The Rust compiler and package manager. For embedded Rust you add a target with rustup target add thumbv7em-none-eabihf. It links with MSVC by default, so the MSVC build tools are needed too.",
  "MSVC 生成工具（Visual Studio Build Tools 2022）": "MSVC build tools (Visual Studio Build Tools 2022)",
  "微软的 C/C++ 编译器与链接器（cl.exe / link.exe）。Rust 的 MSVC 目标、部分 SDK 和 CMake 工程都要它；只装 Build Tools，不装整个 VS IDE。":
    "Microsoft's C/C++ compiler and linker (cl.exe / link.exe). Needed by Rust's MSVC target, some SDKs and CMake projects. Installs only the Build Tools, not the whole VS IDE.",
  "probe-rs（嵌入式 Rust 烧录 / 调试）": "probe-rs (embedded Rust flashing / debugging)",
  "Rust 生态的通用烧录与调试器：一条命令烧 .elf、开 RTT 日志、起 GDB Server。支持 CMSIS-DAP / J-Link / ST-Link / ESP32 等。用 cargo install 装（需要先装 Rust）。":
    "The general-purpose flasher and debugger of the Rust ecosystem: flash an .elf, stream RTT logs and start a GDB server with one command. Supports CMSIS-DAP / J-Link / ST-Link / ESP32. Installed via cargo install (Rust required first).",
  // GUI
  "LVGL（含 Windows 模拟器工程）": "LVGL (with Windows simulator project)",
  "开源嵌入式图形库，配 lv_port_win_visual_studio 能在 Windows 上直接跑模拟器调界面，不用先上板。装完到安装目录打开 LvglWindowsSimulator，用 Visual Studio 编译（需要 MSVC 生成工具）。":
    "Open-source embedded graphics library. With lv_port_win_visual_studio you can run the simulator on Windows and tune the UI without touching the board. After installing, open LvglWindowsSimulator in the install folder and build it with Visual Studio (MSVC build tools required).",
  "SquareLine Studio（LVGL 可视化设计器）": "SquareLine Studio (LVGL visual designer)",
  "LVGL 官方向导式拖拽设计器：画好界面直接导出 C 代码。个人试用免费，但下载要注册账号，所以这里只给官网入口。":
    "The LVGL drag-and-drop designer: draw the UI and export C code. The personal trial is free, but the download requires an account, so this entry only links to the official site.",
  "SEGGER AppWizard（emWin 界面设计器）": "SEGGER AppWizard (emWin UI designer)",
  "SEGGER emWin 的官方可视化设计器，生成 emWin 代码。试用版免费但要填表下载，官网入口在这里。":
    "SEGGER's official visual designer for emWin that generates emWin code. The trial is free but requires a form, so this entry links to the official site.",
  "TouchGFX Designer（ST 图形框架）": "TouchGFX Designer (ST graphics framework)",
  "ST 的 MCU 图形框架与设计器，配 STM32 + LTDC / Chrom-ART 用。随 STM32CubeMX 或 X-CUBE-TOUCHGFX 包分发，要先有 ST 账号。":
    "ST's MCU graphics framework and designer for STM32 with LTDC / Chrom-ART. Distributed with STM32CubeMX or the X-CUBE-TOUCHGFX package and requires an ST account.",
  "NXP GUI Guider（LVGL 设计器）": "NXP GUI Guider (LVGL designer)",
  "NXP 免费提供的 LVGL 图形界面设计器，支持多家芯片（不只 NXP）。导出 LVGL 代码，带模拟器预览。下载需要 NXP 账号。":
    "NXP's free LVGL UI designer that also supports other vendors' chips. Exports LVGL code and includes a simulator preview. The download requires an NXP account.",
  // MQTT
  "Eclipse Mosquitto（MQTT Broker）": "Eclipse Mosquitto (MQTT broker)",
  "最常用的开源 MQTT broker：本机起一个就能让设备连上来联调，不用连公网服务器。装完到服务里启动 mosquitto。":
    "The most widely used open-source MQTT broker: run one locally and let the device connect to it instead of a public server. Start the mosquitto service after installing.",
  "MQTTX（MQTT 5.0 客户端）": "MQTTX (MQTT 5.0 client)",
  "EMQ 出的 MQTT 客户端：多连接、订阅发布、看消息流、支持 MQTT 5.0 属性，调设备上报和下发很顺手。":
    "The MQTT client by EMQ: multiple connections, subscribe/publish, message stream, MQTT 5.0 properties. Handy for testing what a device reports and receives.",
  "MQTT Explorer（MQTT 拓扑浏览）": "MQTT Explorer (MQTT topic browser)",
  "按主题树浏览 MQTT 上的全部消息，适合排查「设备到底发到哪个 topic 了」。比纯客户端更适合摸清别人的 broker。":
    "Browse every message on a broker as a topic tree. Good for finding out which topic a device actually publishes to, and for exploring a broker you did not set up.",
  "paho-mqtt（Python MQTT 库）": "paho-mqtt (Python MQTT library)",
  "Python 的 MQTT 客户端库，写自动化测试脚本、批量造数据时用。装完 import paho.mqtt.client 可用。":
    "The Python MQTT client library, for automation scripts and generating test traffic. After installing, import paho.mqtt.client works.",
  // CAN / Modbus
  "PEAK PCAN 驱动与工具（CAN / CAN FD）": "PEAK PCAN drivers and tools (CAN / CAN FD)",
  "PEAK-System 的 PCAN 系列驱动包：USB 转 CAN / CAN FD 适配器的驱动、PCAN-View 收发工具、PCAN-Basic API（含 CAN FD）。C++ / Python 调 PCAN-Basic 都要先装它。":
    "PEAK-System's PCAN driver pack: drivers for USB-to-CAN / CAN FD adapters, the PCAN-View send/receive tool and the PCAN-Basic API (CAN FD included). Required before calling PCAN-Basic from C++ or Python.",
  "Cangaroo（开源 CAN / CAN FD 分析仪）": "Cangaroo (open-source CAN / CAN FD analyzer)",
  "开源 CAN 分析工具：支持 candleLight（CANable / CANable2 这类廉价适配器）、SocketCAN，带 DBC 解析、报文时间差视图。Windows 版在 GitHub Releases，需要自己下。":
    "Open-source CAN analysis tool supporting candleLight (cheap adapters like CANable / CANable2) and SocketCAN, with DBC parsing and a time-delta view. The Windows build is on GitHub Releases, so download it yourself.",
  "python-can + cantools（CAN 脚本与 DBC 解析）": "python-can + cantools (CAN scripting and DBC parsing)",
  "python-can 提供统一接口（PCAN / Vector / SocketCAN / SLCAN 都能接），cantools 解析 .dbc 报文定义。写 CAN / CAN FD 自动化测试最常用的两个库。":
    "python-can gives one interface over PCAN / Vector / SocketCAN / SLCAN, and cantools parses .dbc message definitions. The two libraries most used for CAN / CAN FD test automation.",
  "ModbusTool（Modbus 主站 / 从站调试）": "ModbusTool (Modbus master / slave testing)",
  "开源 Modbus 主站和从站模拟器，支持 TCP / UDP / RTU，能导入导出寄存器表。测 Modbus RTU 从机（485）和 TCP 服务端都用它。":
    "Open-source Modbus master and slave simulator supporting TCP / UDP / RTU, with register-table import and export. Used for testing Modbus RTU slaves (RS-485) and TCP servers alike.",
  "pymodbus（Python Modbus 库）": "pymodbus (Python Modbus library)",
  "Python 的 Modbus 客户端 / 服务端库，支持串口 RTU 与 TCP。做寄存器扫描、批量读写、自动化回归时用。":
    "The Python Modbus client and server library for serial RTU and TCP. Used for register scanning, bulk reads and automated regressions.",
  "CH34x / CH340 串口驱动": "CH34x / CH340 serial driver",
  "FTDI FT2232 / D2XX 驱动": "FTDI FT2232 / D2XX driver",
  "SEGGER J-Link（含 JFlash / GDB Server / RTT）": "SEGGER J-Link (JFlash / GDB Server / RTT included)",
  "GNU Arm Embedded Toolchain（arm-none-eabi-gcc）": "GNU Arm Embedded Toolchain (arm-none-eabi-gcc)",
  "逻辑分析仪：PulseView / sigrok": "Logic analyzer: PulseView / sigrok",
  "RT-Thread Env 工具": "RT-Thread Env tools",
  "ST-Link USB 驱动": "ST-Link USB driver",
  "Zadig（给逻辑分析仪装 WinUSB）": "Zadig (WinUSB for the logic analyzer)",
  "WCH 的 USB 转串口（CH340/CH341/CH343/CH9102）。插上板子认不出 COM 口、或者出现带感叹号的未知设备，就是它没装。": "WCH USB-to-serial (CH340/CH341/CH343/CH9102). If the board shows up as an unknown device with a warning triangle instead of a COM port, this is what is missing.",
  "FTDI 的 FT2232H/FT232H 双通道芯片（CMSIS-DAP 调试器、FT2232 逻辑分析仪都用它）。装了才有 COM 口和 D2XX 通道。": "FTDI dual-channel FT2232H/FT232H (used by CMSIS-DAP debuggers and FT2232 logic analyzers). Without it you get neither a COM port nor the D2XX channel.",
  "J-Link 的软件包与 USB 驱动：JLink.exe / JFlash.exe / JLinkGDBServerCL.exe / JLinkRTTViewer.exe 都在里面，烧录页与调试页都用它。": "The J-Link software pack and USB driver: JLink.exe / JFlash.exe / JLinkGDBServerCL.exe / JLinkRTTViewer.exe all live here, and both the Flash and Debug pages use it.",
  "编译 ARM 工程的 gcc/g++/gdb/newlib。装完把 bin 目录加到用户 PATH，命令行和本软件的调试页就能直接用。": "gcc/g++/gdb/newlib for ARM projects. Once its bin folder is on your user PATH, both the shell and this app's Debug page can use it right away.",
  "开源调试/烧录器（0.12 起自带 CMSIS-DAP、ST-Link、J-Link 驱动）。烧录页选 OpenOCD 时用的就是它。": "Open-source debugger/flasher (0.12+ bundles CMSIS-DAP, ST-Link and J-Link drivers). This is what the Flash page uses when you pick OpenOCD.",
  "就是你那台开源逻辑分析仪用的软件（FX2 芯片 + fx2lafw 固件，sigrok 出的 PulseView）。装完插上设备就能抓波形。": "The software for that open-source logic analyzer of yours (FX2 chip + fx2lafw firmware, PulseView by sigrok). Install it, plug the device in and capture.",
  "RT-Thread 的命令行环境（env.exe / env.bat，来自 RT-ThreadStudio 或官方 env 仓库）：scons、menuconfig、pkgs 都靠它。": "RT-Thread's command-line environment (env.exe / env.bat, from RT-ThreadStudio or the official env repo): scons, menuconfig and pkgs all rely on it.",
  "ST-Link / ST-Link V2-1 调试器的 WinUSB 驱动（OpenOCD 走它）。用 ST 官方 CUBE 或驱动包安装。": "WinUSB driver for ST-Link / ST-Link V2-1 debuggers (OpenOCD goes through it). Install it from ST's official CUBE or driver pack.",
  "开源逻辑分析仪（FX2 / fx2lafw）在 Windows 上要用 WinUSB 驱动，Zadig 就是干这个的：跑一次、选设备、装 WinUSB。": "The open-source logic analyzer (FX2 / fx2lafw) needs a WinUSB driver on Windows and Zadig is the tool for that: run it once, pick the device, install WinUSB.",

  // ── 本轮新增：安卓 ADB / 屏幕共享 / 文件管理（FTP·TFTP）/ SSH / 环境配置新增项 ──
  "安卓 ADB": "Android ADB", "屏幕共享": "Screen share",
  "安卓": "Android", "音视频": "Audio/video", "网络服务": "Network services",
  "安卓设备": "Android device", "投屏": "Mirror", "停止投屏": "Stop mirror", "scrcpy 投屏": "scrcpy mirror",
  "关 scrcpy": "Close scrcpy", "执行": "Run", "推送": "Push", "截图存盘": "Save screenshot…",
  "选择 APK": "Choose APK", "覆盖安装": "Reinstall (overwrite)", "安装": "Install", "卸载": "Uninstall",
  "卸载包名": "Package name", "列表": "List", "常用命令": "Common commands", "当前设备": "Current device",
  "已配对 / 可连接设备": "Paired / connectable devices",
  "已配对": "Paired", "直接连接": "Direct connect", "台": "device(s)",
  "无线调试设备": "Wireless debugging device", "无线 ADB 设备": "Wireless ADB device",
  "还没发现无线调试设备。手机打开「无线调试」后点上面的「找设备」。": "No wireless debugging device found yet. Turn on Wireless debugging on the phone, then click Find devices above.",
  "已经配对过的设备会显示在上面，直接点「连接」即可，不需要再次配对。地址变了也没关系，以这里扫描到的为准。": "Devices that are already paired appear above. Just click Connect — do not pair them again. If the address changed, use the one discovered here.",
  "这台设备可能还没配对：只有第一次需要配对，配对后再点连接": "This device may not be paired yet: pairing is needed only the first time; after pairing, click Connect.",
  "已记录为已配对设备。只有第一次需要配对；现在到「已配对 / 可连接设备」里点「连接」。": "Remembered as a paired device. Pairing is only needed the first time; now click Connect under Paired / connectable devices.",
  "配对成功，不需要再次配对；请在已配对设备列表里点连接": "Paired successfully. Do not pair again; click Connect in the paired-device list.",
  "这台设备已经配对过，不需要再次配对；直接到「已配对 / 可连接设备」点连接。": "This device is already paired. Do not pair again; click Connect under Paired / connectable devices.",
  "已配对过，直接点连接": "Already paired — just click Connect",
  "首次配对 / 手动连接（只做一次）": "First-time pairing / manual connect (once only)",
  "首次配对码": "First-time pairing code",
  "scrcpy 投屏（外置）": "scrcpy mirror (external)",
  "内置投屏是「抓屏轮询」（约 3~10 fps），直接嵌在 KDock 里；scrcpy 使用自己的 SDL 窗口（性能更好，所以作为外置窗口运行）。": "The built-in mirror uses screencap polling (~3-10 fps) and is embedded in KDock. scrcpy uses its own SDL window (better performance), so it runs as an external window.",
  "传文件": "File transfer", "本机 → 设备": "PC → device", "写到设备": "Write to device",
  "设备上的路径": "Path on device", "安装包": "Package", "返回": "Back", "主屏": "Home",
  "多任务": "Recents", "电源键": "Power", "安装并保存": "Install & save",
  "反向控制（点画面 = 点手机）": "Remote control (click the view = tap the device)",
  "内置投屏是「抓屏轮询」（约 3~10 fps，够看状态）；要丝滑就用上面的": "The built-in mirror is screencap polling (~3-10 fps, fine for watching state); for smoothness use",
  "（独立窗口）。": " (its own window).",
  "选一台设备 → 点【投屏】；画面里点一下就是点手机（在右栏打开「反向控制」）": "Pick a device, then hit Mirror; clicking inside the view taps the device (enable Remote control in the right panel)",
  "adb shell 命令：getprop ro.product.model / ls -l /sdcard / dumpsys battery …": "adb shell command: getprop ro.product.model / ls -l /sdcard / dumpsys battery …",
  "要输入的文字（走 input text）": "Text to type (adb shell input text)",
  "没看到设备？手机要先打开「开发者选项 → USB 调试」，插线后在手机上允许这台电脑。": "No device? Enable Developer options → USB debugging on the phone and allow this PC when prompted.",
  "（没有设备：USB 调试开了吗？）": "(no device — is USB debugging on?)",
  "没有设备（打开手机上的 USB 调试，插线后允许本机）": "No device (turn on USB debugging, then allow this PC)",
  "型号": "Model", "安卓版本": "Android version", "分辨率": "Resolution", "电量": "Battery",
  "存储占用": "Storage", "CPU 占用": "CPU usage", "内存": "Memory", "SD 卡目录": "SD card",
  "日志(最近 60 行)": "Logcat (last 60)", "进程列表": "Processes", "IP 地址": "IP addresses", "重启": "Reboot",
  "Android Platform Tools（adb）": "Android Platform Tools (adb)",
  "Google 官方的 adb（含 fastboot）。「安卓 ADB」页要靠它连手机/平板/开发板：列设备、跑 shell、装卸 APK、推拉文件、抓屏投屏。": "Google's official adb (with fastboot). The Android ADB page uses it to talk to phones/tablets/boards: list devices, run shell, install/uninstall APKs, push/pull files, mirror the screen.",
  "scrcpy（安卓投屏 / 反向控制）": "scrcpy (Android mirroring + control)",
  "把安卓设备画面投到电脑上、还能用鼠标键盘反向控制（走 adb，不需要装手机端 App）。「安卓 ADB」页的「用 scrcpy 投屏」调的就是它。": "Puts an Android screen on your PC with mouse/keyboard control (over adb, no app needed on the phone). The \"scrcpy mirror\" button on the Android ADB page runs it.",
  "FFmpeg（H.264 / RTSP / RTMP 解码）": "FFmpeg (H.264 / RTSP / RTMP decoding)",
  "「屏幕共享」页的 RTSP / RTMP / H.264 流全靠它解码（拉流交给 ffmpeg 子进程，KDock 不链接它的库，规避 GPL/LGPL 传染）。": "The Screen share page decodes RTSP / RTMP / H.264 with it (pulling is done by an ffmpeg child process — KDock never links its libraries, so no GPL/LGPL entanglement).",
  "Tftpd64（TFTP 服务端）": "Tftpd64 (TFTP server)",
  "独立的 TFTP 服务器（Tftpd64，含客户端/服务端/SNTP）。KDock 的「文件管理」页自带 TFTP 客户端与内置服务端，这个装不装都能用；要更全的功能（DHCP、日志、多网卡绑定）就装它。": "Standalone TFTP server (Tftpd64, with client/server/SNTP). The Files page already has a TFTP client and a built-in server, so this is optional — install it for the extras (DHCP, logging, binding to a specific NIC).",
  "OpenSSH 客户端（ssh / scp / sftp）": "OpenSSH client (ssh / scp / sftp)",
  "Windows 自带的 OpenSSH 客户端。「传输」页选 SSH 方式、「中控编排」的 SSH 步骤、命令表里的远程命令都靠它；一条命令就能装（DISM 可选组件，不联网）。": "Windows' built-in OpenSSH client. The SSH mode on the Transfer page, SSH steps in Flow and remote commands in the command table all use it; one DISM command installs it (no download needed).",
  "PuTTY plink（SSH 密码登录用）": "PuTTY plink (for SSH password login)",
  "Windows 自带的 ssh.exe 在「密码」这一步只认控制台、不认管道，所以纯密码登录（大多数开发板/设备）要它 —— KDock 的 SSH 连接在填了密码时会优先用 plink。密钥登录用不着它。": "Windows' ssh.exe only reads passwords from a console, never from a pipe, so password-only logins (most boards and devices) need plink. KDock prefers it whenever a password is filled in; key-based logins don't need it.",
  "OpenSSH 服务端（sshd，可选）": "OpenSSH server (sshd, optional)",
  "把本机变成 SSH 服务器（别人/别的设备 scp、ssh 进来取日志、传固件）。装完自动配好密钥、设成开机自启并启动；不想要就在服务里停掉 sshd。": "Turns this PC into an SSH server (so other machines can ssh/scp in to grab logs or firmware). It generates host keys, sets the service to automatic and starts it; stop the sshd service if you don't want it.",
  "SSH（远程 shell）": "SSH (remote shell)",
  "主机": "Host", "用户名": "User", "密码": "Password", "缩放": "Scale", "原始": "Original",
  "留空 = 用密钥 / 自己在这儿敲": "empty = key auth",
  // 带 <code> 的整句会被拆成碎片：langWalk 查表前会 trim + 把内部空白压成一个空格，
  // 所以这些键必须是"去首尾空白、内部空白压成一个空格"的样子，否则永远查不中（踩过）。
  "密钥登录：密码留空 + 这里填": "Key auth: leave the password empty and put",
  "-i <私钥路径>": "-i <private key>",
  "；端口转发在右边照原样写（如": "here; port forwards go here verbatim (e.g.",
  "填了密码 → 用 PuTTY 的": "With a password → PuTTY's",
  "scrcpy 参数": "scrcpy args",
  "（Windows 自带的": " is used (Windows'",
  "只在控制台里读密码，管道喂不进去， 所以密码登录必须靠它；首次连接会把主机指纹记下来，之后就对不上了会拒绝）。密码留空 → 走": " only reads passwords from a console, never from a pipe, so password logins need it; the host key fingerprint is remembered on first connect and later mismatches are refused). Empty password →",
  "+ 密钥。 连上之后，下面输入框里敲的就是远端 shell，输出直接显示在输出区；「命令表」的指令、「中控编排」里选 SSH 的步骤也用这条连接。": " with key auth. Once connected, the input box below is the remote shell and its output goes to the output pane; the command table and SSH steps in Flow share this link.",
  "临时 SSH（本步指定主机/账号）": "Ad-hoc SSH (host/account per step)",
  "登录取 Prompt 超时(ms)": "Login prompt timeout (ms)",
  "FTPS（显式 TLS）": "FTPS (explicit TLS)", "FTPS（隐式 990）": "FTPS (implicit, 990)",
  "默认 21 / 990 / 69": "default 21 / 990 / 69",
  "不校验证书（自签名）": "Skip certificate check (self-signed)",
  "FTP 的列表优先用": "FTP listings prefer",
  "（带大小/时间），老服务器退回": " (with size/time), falling back to",
  "；传输一律二进制（TYPE I）。": " on older servers; transfers are always binary (TYPE I).",
  "TFTP 没有目录/列表这一说：直接填要取或送的文件路径（相对根目录即可），端口默认 69。": "TFTP has no directories or listings: just type the file path to get/send (relative to the root is fine); port defaults to 69.",
  "新建目录": "New folder", "删除选中": "Delete selection",
  "内置 TFTP 服务端": "Built-in TFTP server", "根目录": "Root folder",
  "要给出去的文件放这儿": "files you want to serve go here",
  "允许写入": "Allow writes", "启动": "Start", "未启动": "not running",
  "示例：": "Example: ",
  "tftp -i 本机IP GET kdock.bin": "tftp -i <this PC> GET kdock.bin",
  "本机桌面（DXGI）": "This PC's desktop (DXGI)", "VNC（可控制键鼠）": "VNC (with keyboard/mouse control)",
  "RTSP（FFmpeg）": "RTSP (FFmpeg)", "RTMP（FFmpeg）": "RTMP (FFmpeg)",
  "H.264 文件 / 裸流（FFmpeg）": "H.264 file / raw stream (FFmpeg)",
  "VNC 密码（没设就留空）": "VNC password (empty if none)",
  "TCP（推荐，穿透好）": "TCP (recommended)", "UDP（低延迟）": "UDP (lower latency)",
  "文件 / 流": "File / stream",
  "D:\\x.h264 或 tcp://0.0.0.0:5000?listen=1": "D:\\x.h264 or tcp://0.0.0.0:5000?listen=1",
  "原始（1:1）": "Original (1:1)", "50%（省带宽）": "50% (less bandwidth)", "25%（只看大概）": "25% (rough only)",
  "适应窗口（默认）": "Fit window (default)", "解码尺寸": "Decode size",
  "FFmpeg 负责解码（含 H.264），按上面这个尺寸等比缩放 + 黑边填充；没装 FFmpeg 就到「环境配置」一键安装。": "FFmpeg does the decoding (H.264 included), scaled to the size above with letterboxing; install FFmpeg from Environment setup if it's missing.",
  "全屏：点上面的【⛶ 全屏】或按 F11；退出按 Esc 或 F11。VNC 全屏后鼠标键盘直接作用到被控端（「允许控制键鼠」打开时）。": "Fullscreen: the ⛶ button above or F11; Esc or F11 leaves it. In fullscreen VNC the mouse and keyboard go straight to the remote machine (when \"allow keyboard/mouse control\" is on).",
  "⛶ 全屏": "⛶ Fullscreen", "⛶ 退出全屏": "⛶ Exit fullscreen",
  "保存画面…": "Save frame…", "全屏中 · 按 F11 或 Esc 退出": "Fullscreen · press F11 or Esc to exit",
  "允许控制键鼠": "Allow keyboard/mouse", "本机桌面": "Desktop",
  "选一个 H.264 / 视频文件": "Choose an H.264 / video file",
  "选要推到设备的文件": "Choose a file to push", "先点「选择本机文件」": "Pick a local file first",
  "先填设备上的路径": "Fill in the device path first", "存到本机": "Save to this PC",
  "把设备截图存到本机": "Save the device screenshot", "先选一个 APK": "Choose an APK first",
  "先填包名": "Fill in the package name first", "还没有画面可存": "No frame to save yet",
  "把当前画面另存为": "Save the current frame as", "已保存：": "Saved: ",
  "已停止": "Stopped", "采集中…": "Capturing…", "连接中…": "Connecting…",
  "选一台设备": "Pick a device", "投屏中（抓屏轮询）": "Mirroring (screencap polling)",
  "投屏已停止": "Mirror stopped", "投屏失败: ": "Mirror failed: ",
  "没找到 adb": "adb not found", "已找到 adb": "adb found",
  "没找到 adb.exe：到「环境配置」一键安装，或者把 platform-tools 目录加到 PATH。": "adb.exe not found: install it from Environment setup, or add the platform-tools folder to PATH.",
  "先点「连接」（FTP/FTPS 要登录；TFTP 只是记一下地址）": "Hit Connect first (FTP/FTPS log in; for TFTP it just remembers the address)",
  "（TFTP 没有列表：直接填路径取/送）": "(TFTP has no listing: type a path to get/send)",
  "「新建目录」只在 FTP / FTPS 下可用": "\"New folder\" only works over FTP / FTPS",
  "「删除」只在 FTP / FTPS 下可用": "\"Delete\" only works over FTP / FTPS",
  "先在列表里选一个": "Pick one in the list first", "删除": "Delete", "（目录）": " (folder)",
  "先选一个 TFTP 根目录": "Pick a TFTP root folder first", "选 TFTP 根目录": "Choose the TFTP root folder",
  "未连接": "Disconnected", "先选一个本机文件": "Choose a local file first",
  "填一下设备上的目标路径": "Fill in the target path on the device",

  // ── 上下文分层（技能 / 指导文件）+ 命中率 ──
  "工具": "Tools",
  "全局指导（每轮都在场）": "Global guidance (always in context)",
  "保存指导": "Save guidance", "打开所在目录": "Open folder",
  "以前的「常驻技能」已迁到这里": "The old \"always-on skills\" moved here",
  "全局技能（用户级：使用 / 不使用）": "Global skills (user level: on / off)",
  "工作区技能（项目级：存在即生效）": "Workspace skills (project level: present = active)",
  "技能归档（skill-archive：工作区技能的备份）": "Skill archive (backups of workspace skills)",
  "转为工作区专属": "Move to workspace", "还原到全局": "Restore to global",
  "还原到工作区": "Restore to workspace", "删归档": "Delete archive",
  "使用中": "in use", "不使用": "off",
  "读取中…": "Loading…", "来自工作区": "from workspace", "来自全局": "from global",
  "存在即生效（每轮进索引）": "present = active (indexed every turn)",
  "这个工作区还没有专属技能（导入的技能默认落在全局，可用上面的「转为工作区专属」下放）":
    "This workspace has no project skills yet (imports land in global skills; use \"Move to workspace\" to push one down)",
  "（没有归档：把全局技能转为工作区专属、或删掉工作区技能时，会自动在这儿留一份备份）":
    "(no archive entries: moving a global skill into a workspace, or deleting a workspace skill, leaves a backup here)",
  "（还没有技能：点「导入…」选一个 SKILL.md，或「新建」）": "(no skills yet: use Import… to pick a SKILL.md, or New)",
  "先在下面的「编辑技能」里点一个技能（或填名字），再转": "Click a skill in the editor below (or type a name) first",
  "没有可选的工作区（先在左边栏建一个）": "No workspace to choose (create one in the left sidebar first)",
  "转为工作区专属": "Move to workspace", "打开 .kdock_skill 目录": "Open .kdock_skill folder",
  "删除技能": "Delete skill", "删除归档": "Delete archive", "已还原到全局技能": "Restored to global skills",
  "已还原到工作区": "Restored to the workspace", "已转换：": "Moved: ",
  "关掉就不再带上这条（对新会话生效）": "Turns this block off (applies to new sessions)",
  "已打开 ": "Enabled ", "已关闭 ": "Disabled ",
  "技能索引": "skill index", "指导文件": "guidance", "其中指导文件": "of which guidance",
  "技能在这里只管开关：正文不进上下文，模型需要时自己读":
    "Skills here are on/off only: the body never enters the context unless the model reads it",
  "已把常驻技能迁移到「全局指导」：": "Migrated always-on skills into global guidance: ",
  "agent 能用的工具": "Tools the agent can use",
  "搜索工具名 / 说明": "Search tool name / description",
  "（没有技能：点「导入…」选一个 SKILL.md，或「新建」）": "(no skills: use Import… or New)",
  "命中率": "Cache hit", "缓存命中": "Cache hit",
};
const en = (t) => (LANG === "en" && EN[t]) ? EN[t] : t;
// 分文件写的小模块（批量文本/计算器）也要能翻译 + 切语言时重画
const langHooks = [];
window.kdockT = en;
window.kdockOnLang = (fn) => { if (typeof fn === "function") langHooks.push(fn); };
function applyLang(lang) {
  LANG = lang === "en" ? "en" : "zh";
  localStorage.setItem("kdock_lang", LANG);
  uiPrefsSave();
  document.documentElement.dataset.lang = LANG;
  langWalk();
  // 菜单栏那 5 个按钮的文字（它们是 bind 时写进去的，切语言要跟着刷）
  const labels = ["文件", "编辑", "视图", "窗口", "帮助"];
  document.querySelectorAll("#tb-menu .tb-menu-btn").forEach((b, i) => { if (labels[i]) b.textContent = en(labels[i]); });
  const active = document.querySelector(".navitem.active");
  const pg = $("tb-page");
  if (active && pg) { const p = TB_PAGES.find((x) => x[0] === active.dataset.tab); pg.textContent = p ? en(p[1]) : active.dataset.tab; }
  document.title = "KDock";
  // 下面这些都是"运行时拼出来的"文字，DOM 扫描扫不到它们，切语言要主动重画一次
  window.__langBusy = true;          // 重画时会走到 sqRenderCfg，靠这个标志避免反复进 applyLang
  // 每步单独兜底：任何一步抛错都不该让"最后那次 DOM 扫描"被跳过
  // （踩过：以前没有兜底，一处报错 → 那批"运行时才渲染"的文案全留着中文）
  const safe = (fn, tag) => {
    try { fn(); } catch (e) {
      window.__langErr = (window.__langErr || []).concat(tag + ": " + (e && e.message ? e.message : String(e)));
      if (window.__langErr.length > 20) window.__langErr.shift();
    }
  };
  try {
    safe(outHeadRefresh, "outHeadRefresh");
    safe(outClockTick, "outClockTick");
    safe(sqRender, "sqRender");            // 画布节点正文 + 右侧配置面板，都是运行时拼的
    safe(netipPaint, "netipPaint"); // 顶栏归属地 / 设置摘要按当前语言重画
    safe(buildCmdTable, "buildCmdTable");  // 命令表（说明文字按当前语言重画）
    safe(agRenderTree, "agRenderTree");    // 工作区/会话树里的固定文案
    safe(agRenderInfo, "agRenderInfo");    // Agent 信息面板
    safe(agRefreshBreakdown, "agRefreshBreakdown");
    safe(() => { if (usbData) { usbRenderList(); usbCapFillTargets(); usbRenderSummary(); } }, "usb");
    for (const fn of langHooks) safe(fn, "hook");
  } finally {
    window.__langBusy = false;
  }
  langWalk();                        // 刚重画出来的那些控件再扫一遍
  window.__langReady = true;
}

// ---------------- 自绘标题栏：菜单栏 + 窗口按钮 ----------------
const TB_PAGES = [["link", "传输"], ["cmds", "命令表"], ["upgrade", "固件升级"], ["flash", "烧录"],
  ["runtime", "运行结构"],
  ["agent", "Agent"],
  ["files", "文件管理"], ["adb", "安卓 ADB"], ["chart", "实时图表"], ["seq", "中控编排"], ["scope", "示波器"],
  ["capture", "屏幕共享"], ["logic", "逻辑分析仪"],
  ["batch", "批量文本"], ["calc", "计算器"], ["datacalc", "数据计算"], ["env", "环境配置"], ["usb", "USB 诊断"],
  ["kb", "知识库"], ["debug", "调试"]];
const TB_THEME_NAME = { dark: "暗色", light: "亮色", auto: "跟随系统" };
function tbCmd(action) { return invoke("win_ctl", { action }).catch((e) => toast("窗口操作失败: " + e)); }
function tbCloseMenus() {
  document.querySelectorAll(".tb-menu-pop").forEach((p) => p.remove());
  document.querySelectorAll(".tb-menu-btn").forEach((b) => b.classList.remove("active"));
}
function tbShow(page) { const b = document.querySelector(`.navitem[data-tab="${page}"]`); if (b) b.click(); }
function tbToggle(id) {
  const e = $(id);
  if (e) { e.checked = !e.checked; e.dispatchEvent(new Event("change", { bubbles: true })); }
}

/** 切一组单选（显示 / 发送的 文本↔HEX）。窄窗下那两行工具收起来了，菜单里得能切。 */
function tbSetRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
}

function tbCopyRx() {
  const t = logPlainText("rx");
  navigator.clipboard.writeText(t).then(() => toast(`已复制 ${t.length} 字符`)).catch(() => toast("复制失败"));
}
function tbSyncTheme() {
  // 右上角主题按钮已撤掉；设置 → 主题与配色仍是唯一入口。
  void (document.documentElement.dataset.theme || "dark");
}
function tbSetTheme(m) { applyTheme(m); tbSyncTheme(); toast("主题：" + (TB_THEME_NAME[m] || m)); }
function tbMenuDefs() {
  return [
    { label: "文件", items: [
      { t: "保存会话日志…", run: () => $("save").click() },
      { t: "加载会话日志…", run: () => $("load").click() },
      { t: "导出 CSV…", run: () => $("export").click() },
      { t: "回放会话", run: () => $("replay").click() },
      { sep: 1 },
      { t: "导入编排 JSON…", run: () => $("sq-load").click() },
      { t: "导出编排 JSON…", run: () => $("sq-save").click() },
      { sep: 1 },
      { t: "退出 KDock", k: "Alt+F4", run: () => tbCmd("close") },
    ]},
    { label: "编辑", items: [
      { t: "清空输出", run: () => $("clear").click() },
      { t: "复制全部输出", run: tbCopyRx },
      { t: "清空发送区", run: () => { $("tx").value = ""; } },
      { sep: 1 },
      { t: "暂停接收", chk: () => $("pause") && $("pause").checked, run: () => tbToggle("pause") },
      { t: "自动滚动", chk: () => $("autoscroll") && $("autoscroll").checked, run: () => tbToggle("autoscroll") },
      { t: "ASCII 交互", chk: () => $("ascii-mode") && $("ascii-mode").checked, run: () => tbToggle("ascii-mode") },
      { sep: 1 },
      // 这几个开关在窄窗口下跟着"显示那一行"一起收起来了（见 styles.css 里 .workpane.shell 那几条），
      // 所以菜单里必须留一份，不然小窗口里就没法切了
      { t: "时间戳", chk: () => $("show-ts") && $("show-ts").checked, run: () => tbToggle("show-ts") },
      { t: "行号（序号）", chk: () => $("show-no") && $("show-no").checked, run: () => tbToggle("show-no") },
      { t: "方向标记", chk: () => $("show-dir") && $("show-dir").checked, run: () => tbToggle("show-dir") },
      { t: "显示 / 发送用 HEX", chk: () => rxMode === "hex", run: () => tbSetRadio("rx-mode", rxMode === "hex" ? "text" : "hex") },
    ]},
    { label: "视图", items: [
      ...TB_PAGES.map((p) => ({ t: p[1], run: () => tbShow(p[0]) })),
      { sep: 1 },
      { t: "暗色主题", chk: () => (document.documentElement.dataset.theme || "dark") === "dark", run: () => tbSetTheme("dark") },
      { t: "亮色主题", chk: () => document.documentElement.dataset.theme === "light", run: () => tbSetTheme("light") },
      { t: "跟随系统", chk: () => document.documentElement.dataset.theme === "auto", run: () => tbSetTheme("auto") },
      { sep: 1 },
      { t: "设置…", k: "Ctrl+,", run: () => openSettings("general") },
    ]},
    { label: "窗口", items: [
      { t: "最小化", run: () => tbCmd("min") },
      { t: "最大化 / 还原", run: () => tbCmd("toggle_max") },
      { sep: 1 },
      { t: "关闭到托盘", chk: () => $("opt-tray").checked, run: () => tbToggle("opt-tray") },
      { t: "开机自启", chk: () => $("opt-autostart").checked, run: () => tbToggle("opt-autostart") },
      { t: "断线自动重连", chk: () => $("opt-reconnect").checked, run: () => tbToggle("opt-reconnect") },
    ]},
    { label: "帮助", items: [
      { t: "功能帮助…", k: "F1", run: () => openHelp(HELP_PAGE_ROOT[helpCurrentPage()]) },
    { t: "快捷键", run: () => { pushSys("[帮助] F1 当前页帮助 / Ctrl+, 设置 / Ctrl+Alt+K 快捷键设置 / Ctrl+PageUp·PageDown 切常用页 / Ctrl+Alt+L 清屏 / F7·Shift+F7 文本差异 / F11 屏幕全屏；完整清单和自定义见设置 → 快捷键"); toast("快捷键已写到输出区"); } },
      { t: "关于 KDock", run: () => { pushSys("[关于] KDock · 串口/网络调试 + openocd/J-Link 烧录 + 中控编排（Tauri 2 + Rust）"); toast("KDock"); } },
    ]},
  ];
}
function bindTitleBar() {
  const bar = $("titlebar");
  if (!bar) return;
  // 拖窗口 + 双击最大化（点在按钮/菜单/弹层上不算）
  // 拖标题栏移动窗口：自己算位移调 win_move（无边框窗口 start_dragging 不靠谱，而且这样能自测）
  let dragWin = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, summary, input, a, .tb-menu, .morebox, .chip, .rsz")) return;
    dragWin = { x: e.screenX, y: e.screenY };
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!dragWin) return;
    const dpr = window.devicePixelRatio || 1;
    const dx = Math.round((e.screenX - dragWin.x) * dpr);
    const dy = Math.round((e.screenY - dragWin.y) * dpr);
    if (!dx && !dy) return;
    dragWin.x = e.screenX; dragWin.y = e.screenY;
    invoke("win_move", { dx, dy }).catch(() => {});
  });
  const endWinDrag = () => { dragWin = null; };
  bar.addEventListener("pointerup", endWinDrag);
  bar.addEventListener("pointercancel", endWinDrag);
  bar.addEventListener("dblclick", (e) => {
    if (e.target.closest("button, summary, input, a, .tb-menu, .morebox, .chip, .rsz")) return;
    tbCmd("toggle_max");
  });
  // 8 个缩放把手
  document.querySelectorAll(".rsz").forEach((h) => {
    let st = null;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      st = { x: e.screenX, y: e.screenY, edge: h.dataset.edge };
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    h.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dpr = window.devicePixelRatio || 1;
      const dx = Math.round((e.screenX - st.x) * dpr);
      const dy = Math.round((e.screenY - st.y) * dpr);
      if (!dx && !dy) return;
      st.x = e.screenX; st.y = e.screenY;
      invoke("win_resize", { edge: st.edge, dx, dy }).catch(() => {});
    });
    const end = () => { st = null; };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  });
  $("win-min").onclick = () => tbCmd("min");
  $("win-max").onclick = () => tbCmd("toggle_max");
  $("win-close").onclick = () => tbCmd("close");
  if ($("nav-settings")) $("nav-settings").addEventListener("click", (e) => { e.stopPropagation(); openSettings("general"); });
  if ($("tb-settings")) $("tb-settings").onclick = () => openSettings("theme");
  // 主题 / 翻译 / 帮助改由设置页和 F1 提供，右上角留给连接状态和 IP 归属地。
  tbSyncTheme();
  // 菜单栏
  const wrap = $("tb-menu");
  let openIdx = -1;
  const menu = tbMenuDefs();
  /** 把一批菜单项填进弹层（单个菜单和窄窗那个「☰」合集都用它） */
  const fillItems = (pop, items) => {
    for (const it of items) {
      if (it.sep) { const sp = document.createElement("div"); sp.className = "tb-menu-sep"; pop.appendChild(sp); continue; }
      const b = document.createElement("button");
      b.className = "tb-menu-item";
      const left = document.createElement("span");
      left.textContent = (it.chk && it.chk() ? "✓ " : "") + en(it.t);
      b.appendChild(left);
      if (it.k) { const k = document.createElement("span"); k.className = "kbd"; k.textContent = it.k; b.appendChild(k); }
      b.onclick = (ev) => { ev.stopPropagation(); tbCloseMenus(); try { it.run(); } catch (e) { toast(String(e)); } };
      pop.appendChild(b);
    }
  };
  menu.forEach((sec, idx) => {
    const root = document.createElement("div");
    root.className = "tb-menu-root";
    const btn = document.createElement("button");
    btn.className = "tb-menu-btn";
    btn.textContent = en(sec.label);
    const open = () => {
      tbCloseMenus();
      btn.classList.add("active");
      const pop = document.createElement("div");
      pop.className = "tb-menu-pop";
      fillItems(pop, sec.items);
      root.appendChild(pop);
      openIdx = idx;
    };
    btn.onclick = (e) => { e.stopPropagation(); if (btn.classList.contains("active")) { tbCloseMenus(); openIdx = -1; } else open(); };
    btn.onmouseenter = () => { if (openIdx >= 0 && openIdx !== idx) open(); };
    root.appendChild(btn);
    wrap.appendChild(root);
  });
  // 窄窗口（≤1120px）里五个菜单折进这个「☰」：一次把五个菜单的内容都列出来
  {
    const root = document.createElement("div");
    root.className = "tb-menu-root tb-menu-more";
    const btn = document.createElement("button");
    btn.className = "tb-menu-btn";
    btn.textContent = "☰";
    btn.title = en("应用菜单");
    const open = () => {
      tbCloseMenus();
      btn.classList.add("active");
      const pop = document.createElement("div");
      pop.className = "tb-menu-pop";
      menu.forEach((sec) => {
        const g = document.createElement("div");
        g.className = "tb-menu-group";
        const h = document.createElement("div");
        h.className = "tb-menu-sec";
        h.textContent = en(sec.label);
        g.appendChild(h);
        fillItems(g, sec.items);
        pop.appendChild(g);
      });
      root.appendChild(pop);
      openIdx = menu.length;
    };
    btn.onclick = (e) => { e.stopPropagation(); if (btn.classList.contains("active")) { tbCloseMenus(); openIdx = -1; } else open(); };
    root.appendChild(btn);
    wrap.appendChild(root);
  }
  // 左导航：窄窗口下变纯图标条，那个「☰」把它临时展开（记住选择）
  const navExpand = $("nav-expand");
  if (navExpand) {
    if (localStorage.getItem("kdock_railopen") === "1") document.documentElement.classList.add("railopen");
    navExpand.onclick = () => {
      const on = document.documentElement.classList.toggle("railopen");
      localStorage.setItem("kdock_railopen", on ? "1" : "0");
      window.dispatchEvent(new Event("resize"));
    };
  }
  // 参数区折叠（窄窗口下特别有用：整行挪到下面那条能直接收掉）
  const tbParams = $("tb-params");
  if (tbParams) {
    const paint = () => {
      const off = document.documentElement.classList.contains("noparam");
      tbParams.classList.toggle("on", off);
      tbParams.title = off ? en("显示参数区") : en("收起参数区");
    };
    if (localStorage.getItem("kdock_noparam") === "1") document.documentElement.classList.add("noparam");
    paint();
    tbParams.onclick = () => {
      const off = document.documentElement.classList.toggle("noparam");
      localStorage.setItem("kdock_noparam", off ? "1" : "0");
      paint();
      syncParamStrip();
      window.dispatchEvent(new Event("resize"));     // 中栏变宽了：让图表 / 画布跟着重排
    };
  }
  // 图标条里文字都收起来了，悬停提示得有（没有的就用它的功能名补一个）
  document.querySelectorAll(".navitem").forEach((b) => {
    if (!b.title) { const sp = b.querySelector("span"); if (sp) b.title = sp.textContent.trim(); }
  });
  document.addEventListener("click", () => { tbCloseMenus(); openIdx = -1; });
}

async function main() {
  migrateLocalPrefs();          // 老版本的 h7test_* 设置搬成 kdock_*（只搬一次）
  // 启动画面这会儿**早就顶上去了**（tauri.conf.json 里声明、后端 setup 里显示，比这里早得多）；
  // 这一下只是兜底：窗口还在就把它再顶到最前，启动阶段已经收尾则什么都不做。
  invoke("splash_show").catch(() => {});
  initControls();
  bindTooltips();               // 悬停提示改自绘（原生 title 的气泡又慢又丑）
  decorateHelpHeadings();       // 先把中文标题与帮助锚点对上，再切语言
  switchMode("serial");

  applyLang(LANG);
  bindTitleBar();
  bindLogResize("sq-log-grip", "sq-logbox", "kdock_seq_log_h");
  bindLogResize("fl-log-grip", "fl-logbox", "kdock_flash_log_h");
  bindTheme();
  await uiPrefsLoad();          // 后端那份偏好优先（dev / exe 两个 origin 共用）
  await bindToolOptions();
  bindEncoding();
  bindQuickSend();
  bindCmdTable();
  bindChart();
  bindSeq();
  bindErrorBanner();
  bindGutter();
  bindAgentResize();
  bindDevHistory();             // 设备 IP / 端口历史（datalist 提示）
  bindFlash();
  flRestorePrefs();             // 文件页：上次用的方式 / FTP 服务器 / 内置 TFTP 服务端参数
  bindCapture();
  bindAdb();                    // 安卓 ADB：设备 / shell / 推拉 / APK / 投屏
  bindSettings();
  bindNetip();
  bindNetipEvents();
  bindHelp();
  bindShortcuts();
  bindCache();
  bindAgent();
  bindAgentEvents();
  bindScope();
  bindKb();
  bindDebug();
  bindEnv();                    // 环境配置：驱动 / 工具链
  bindUsb();                    // USB 诊断
  setTimeout(envFirstRunCheck, 900);       // 首次运行检查：缺必需驱动才提示一次（不挡启动）
  listen("debug://gdb", (ev) => { if (window.__dbgOnGdb) window.__dbgOnGdb(String(ev.payload || "")); });
  listen("debug://server", (ev) => { dbgPrint("[server] " + String(ev.payload || "") + "\n"); });
  bindScrollFollow();
  bindTabs();
  bindTimestamp();
  bindAsciiMode();
  bindSendShortcut();
  $("mode").onchange = (e) => {
    switchMode(e.target.value);
    if (document.getElementById("upg-mode")) syncUpgCtl();
  };
  $("refresh").onclick = refreshPorts;
  $("open").onclick = doOpen;
  $("close").onclick = doClose;
  $("send").onclick = doSend;
  $("clear").onclick = async () => {
    rxBuffer = [];
    rxEntryNo = 0;         // 清屏后序号从 1 重数
    await invoke("clear_log");
    redrawRx();
    if (asciiMode) $("rx").focus();     // ASCII 交互时别把焦点丢在按钮上，否则敲不动
  };
  $("pause").onchange = (e) => {
    rxPaused = e.target.checked;
    if (!rxPaused) redrawRx();
  };
  $("loop").onchange = toggleLoop;
  $("loop-ms").onchange = toggleLoop;

  // 自定义波特率：勾上才让填；取消勾选就回到之前那个标准波特率
  // (不这样做的话，取消勾选后下拉里还选中着自定义那一项，看着是标准值、实际发的还是自定义)
  let lastStdBaud = currentBaud;
  $("baud-custom-chk").onchange = () => {
    const on = $("baud-custom-chk").checked;
    $("baud-custom").disabled = !on;
    $("baud").disabled = on;
    if (on) {
      lastStdBaud = BAUDS.includes(Number($("baud").value)) ? Number($("baud").value) : lastStdBaud;
      $("baud-custom").focus();
      return;
    }
    $("baud-custom").value = "";
    currentBaud = lastStdBaud;
    for (const id of ["baud", "upg-baud", "fl-baud", "sq-baud"]) {
      const sel = $(id);
      Array.from(sel.options).forEach((o) => {
        if (!BAUDS.includes(Number(o.value))) o.remove();   // 去掉"自定义"那一项
      });
      const o = Array.from(sel.options).find((x) => Number(x.value) === lastStdBaud);
      if (o) o.selected = true;
    }
  };
  $("baud-custom").oninput = () => {
    if (!$("baud-custom-chk").checked) return;
    const v = Number($("baud-custom").value);
    if (!(v > 0)) return;
    currentBaud = v;
    for (const id of ["baud", "upg-baud", "fl-baud", "sq-baud"]) {
      const sel = $(id);
      let o = Array.from(sel.options).find((x) => Number(x.value) === v);
      if (!o) {
        o = document.createElement("option");
        o.value = String(v);
        o.textContent = `${v}（自定义）`;
        sel.appendChild(o);
      }
      o.selected = true;
    }
  };

  $("history").onchange = (e) => {
    if (e.target.value !== "") $("tx").value = history[Number(e.target.value)] ?? "";
  };

  // Enter 发送 / Shift+Enter 换行（和主流串口工具一致）
  $("tx").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  document.querySelectorAll('input[name="rx-mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      rxMode = r.value;
      redrawRx();
      // 显示模式也是发送模式：这里同步输入提示，避免用户以为还要再切一次。
      if ($("tx")) $("tx").placeholder = rxMode === "hex"
        ? en("HEX 模式：41 54 0D 0A（Enter 发送 / Shift+Enter 换行）")
        : en("文本直接输入（Enter 发送 / Shift+Enter 换行）");
    })
  );


  // 会话：保存/加载/导出 —— 都用系统原生对话框选路径（目录输入框只当"默认目录"）
  const sessFile = (name) => joinFile($("sess-dir").value.trim() || $("fl-save-dir").value.trim(), name);
  const rememberDir = (p) => {
    const d0 = String(p).replace(/[\\/][^\\/]*$/, "");
    if (d0) localStorage.setItem("kdock_sess_dir", d0);
  };
  $("save").onclick = async () => {
    try {
      const p = await dlgSave({ title: "保存会话日志", defaultPath: sessFile("session.jsonl") });
      if (!p) return;
      rememberDir(p);
      const n = await invoke("save_session", { path: p });
      outPathSet(p);
      toast(`已保存 ${n} 行到 ${p}`);
      pushSys(`[会话] 已保存 ${n} 行到 ${p}`);
    } catch (e) { toast(String(e)); }
  };
  $("load").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "加载会话日志", multiple: false, directory: false,
                                filters: [{ name: "日志", extensions: ["jsonl", "json", "txt"] }] });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      rememberDir(path0);
      const n = await invoke("load_session", { path: path0 });
      outPathSet(path0);
      toast(`已从 ${path0} 加载 ${n} 行`);
      pushSys(`[会话] 已从 ${path0} 加载 ${n} 行`);
      await reloadFromBackend();
    } catch (e) { toast(String(e)); }
  };
  $("export").onclick = async () => {
    try {
      const p = await dlgSave({ title: "导出 CSV", defaultPath: sessFile("session.csv") });
      if (!p) return;
      rememberDir(p);
      const n = await invoke("export_csv", { path: p });
      outPathSet(p);
      toast(`已导出 ${n} 行到 ${p}`);
      pushSys(`[会话] 已导出 ${n} 行到 ${p}`);
    } catch (e) { toast(String(e)); }
  };
  $("replay").onclick = doReplay;

  // 设备的日志是**一个字节一个事件**抛上来的，直接一行一条会刷屏；
  // 这里攒到换行为止(或 80ms)再落一行。
  let upgBuf = "";
  let upgTimer = null;
  const flushUpg = () => {
    if (upgTimer) { clearTimeout(upgTimer); upgTimer = null; }
    if (!upgBuf) return;
    const one = upgBuf.replace(/^[\r\n]+|[\r\n]+$/g, "");
    upgBuf = "";
    if (!one) return;
    pushSys(one);
    if (!rxPaused) redrawRx();
    $("rx").scrollTop = $("rx").scrollHeight;
  };
  await listen("upgrade://log", (ev) => {
    upgBuf += String(ev.payload);
    if (/[\r\n]/.test(upgBuf)) flushUpg();
    else if (!upgTimer) upgTimer = setTimeout(flushUpg, 80);
  });
  await listen("upgrade://state", (ev) => {
    const s = ev.payload || {};
    $("upg-state").textContent = s.text || "";
    $("upg-state").className = "dot" + (s.running ? "" : s.percent >= 100 ? " ok" : "");
    $("upg-go").disabled = !!s.running;
    $("upg-go").textContent = s.running ? `${en("升级中")} ${Math.round(s.percent || 0)}%` : en("升级");
    upgRunning = !!s.running;
  });

  // 端口插拔由后端推事件，前端不再 1 秒轮询
  await listen("capture://frame", (ev) => {
    capPushFrame(ev.payload);                    // 只留最新的一帧
  });
  await listen("capture://error", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;                 // 旧会话的错误，忽略
    capRunning = false;
    capState("出错: " + (p.msg != null ? p.msg : p), "err");
    pushSys(`[捕获] ${p.msg != null ? p.msg : p}`);
  });
  await listen("capture://stopped", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;                 // 旧会话线程退出的收尾事件，别动新会话的状态
    capRunning = false;
    capState("已停止");
  });
  // 远端画面（VNC / RTSP / RTMP / H.264）：帧和错误走自己的事件，形状和 capture 一样
  await listen("rs://frame", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;
    capPushFrame(p);
  });
  await listen("rs://info", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;
    if (p.w) capWH = { w: Number(p.w) || 0, h: Number(p.h) || 0 };
    if (p.name) pushSys(`[屏幕共享] ${p.name} · ${p.w}x${p.h}`);
  });
  await listen("rs://clipboard", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p) || !p.text) return;
    pushSys("[VNC] 被控端剪贴板：" + String(p.text).slice(0, 200));
  });
  await listen("rs://error", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;
    capRunning = false;
    capWanted = false;
    capState("出错: " + (p.msg != null ? p.msg : p), "err");
    pushSys(`[屏幕共享] ${p.msg != null ? p.msg : p}`);
  });
  await listen("rs://stopped", (ev) => {
    const p = ev.payload || {};
    if (!capEventMine(p)) return;
    capRunning = false;
    capWanted = false;
    capState("已停止");
  });
  // 安卓投屏
  await listen("adb://frame", (ev) => {
    const p = ev.payload || {};
    if (Number(p.session) !== adbSession) return;
    adbPushFrame(p);
  });
  await listen("adb://error", (ev) => {
    const p = ev.payload || {};
    if (Number(p.session) !== adbSession) return;
    adbState("投屏出错: " + (p.msg != null ? p.msg : p), "err");
    adbLog(String(p.msg != null ? p.msg : p));
  });
  await listen("adb://stopped", (ev) => {
    const p = ev.payload || {};
    if (Number(p.session) !== adbSession) return;
    adbMirroring = false;
    adbState("投屏已停止");
  });
  await listen("tftp://log", (ev) => {
    const p = ev.payload || {};
    if (p.text) tftpSrvLog(String(p.text));
  });
  await listen("tftp://state", (ev) => {
    const p = ev.payload || {};
    tftpSrvOn = !!p.running;
    tftpSrvState(p.running ? `已启动 · UDP ${p.port} · ${p.root || ""}` : "未启动", p.running ? "ok" : "");
  });
  await listen("flash://log", (ev) => {
    const s = String(ev.payload || "");
    pushSys(s.replace(/[\r\n]+$/, ""));
    if (!$("fl-log").closest("[hidden]")) flashLog(s);
  });
  await listen("flash://done", (ev) => {
    // 常见坑：openocd(libusb 版) 认不到用 SEGGER 驱动的 J-Link —— 给一句可操作的提示
    const lw = logPlainText("fl-log");
    if (lw.includes("No J-Link device found") || lw.includes("LIBUSB_ERROR_NOT_SUPPORTED")) {
      pushSys("[烧录] 提示：这个 openocd 是 libusb 版，认不到用 SEGGER 驱动的 J-Link；用 J-Link 探头时请把「工具」切成 J-Link Commander（openocd 适合 CMSIS-DAP / ST-Link 探头）");
    }
    const code = ev.payload;
    const okk = code === 0;
    flashLog(`\n===== 结束，退出码 ${code} =====\n`);
    pushSys(`[烧录] 结束，退出码 ${code}${okk ? "（成功）" : "（失败）"}`);
    $("fl-log").classList.toggle("err", !okk);
    toast(okk ? "烧录器正常结束" : `烧录器退出码 ${code}`);
  });
  await listen("seq://data", (ev) => {
    const p = ev.payload || {};
    sqRx.push({ id: p.id, text: p.text || "", hex: p.hex || "" });
    if (sqRx.length > 4000) sqRx.splice(0, 1000);
  });
  window.__sqRx = sqRx;      // 便于自测/排障看中控收包
  await listen("seq://closed", (ev) => {
    pushSys(`[中控] 连接 #${ev.payload} 已断开`);
  });
  await listen("ports-changed", (ev) => {
    const list = ev.payload || [];
    applyPorts(list);
  });
  await listen("ports-changed-note", (ev) => {
    const list = ev.payload || [];
    pushSys(`串口列表变化: ${list.length ? list.join(", ") : "（无串口）"}`);
  });
  await listen("link://data", (ev) => {
    const p = ev.payload;
    // 中控的步骤可以用"主连接"发；主连接的收包走 link://data，这里同步进 sqRx，
    // 否则主连接上写的 expect 永远等不到（只有中控自建的 extra 连接在推 seq://data）。
    sqRx.push({ id: "main", text: p.text || "", hex: p.hex || "" });
    if (sqRx.length > 4000) sqRx.splice(0, 1000);
    chartFeed(p.text);                                    // 数值行顺便喂给图表
    tailEntry = null;                                     // 整行已经来了，半行作废
    if (!rxPaused) {
      pushEntry({ dir: "RX", ts_ms: p.ts_ms, text: p.text, hex: p.hex, ascii: p.ascii });
    } else {
      redrawRx();
    }
  });
  // agent 用 port_open 连上了主连接：界面里的连接参数也跟着切过去
  await listen("main://opened", (ev) => {
    const p = ev.payload || {};
    if (p.by !== "agent" || !p.endpoint) return;
    applyEndpointToUi(p.endpoint);
    toast(en("agent 连上了主连接：") + (p.endpoint.mode || ""));
  });
  // agent 用 port_write 往"主连接"里发的东西：也补一条 TX 行进用户的日志（不然用户不知道它发了啥）
  await listen("log://tx", (ev) => {
    const p = ev.payload || {};
    if (rxPaused) return;
    pushEntry({ dir: "TX", ts_ms: p.ts_ms || Date.now(), text: p.text || "", hex: p.hex || "", ascii: p.ascii || "" });
  });
  await listen("link://tail", (ev) => {
    let p = ev.payload;
    if (!p) { tailEntry = null; }
    else {
      if (typeof p === "string") { try { p = JSON.parse(p); } catch (_) { p = null; } }
      tailEntry = p ? { dir: "RX", ts_ms: p.ts_ms, text: p.text, hex: p.hex, ascii: p.ascii } : null;
    }
    if (!rxPaused) redrawRx();
  });
  await listen("link://reconnecting", (ev) => {
    chipSet(`重连中 ${ev.payload}/20`, false);
    pushSys(`[链路] 连接断了，1.5s 后重连（第 ${ev.payload} 次）...`);
  });
  await listen("link://reconnected", (ev) => {
    toast(`断线后自动重连成功（第 ${ev.payload} 次）`);
    pushSys(`[链路] 重连成功（第 ${ev.payload} 次）`);
    refreshStats();
  });
  await listen("link://error", (ev) => {
    toast(String(ev.payload));
    pushSys(String(ev.payload));
  });
  await listen("link://state", (ev) => {
    const s = String(ev.payload);
    if (s === "connected") pushSys("TCP 客户端已接入");
    else if (s === "closed") pushSys("对端已断开");
    else if (s === "reconnect-failed") { pushSys("[链路] 自动重连失败，请手动重连"); toast("自动重连失败，请手动重连"); }
    else pushSys(`[链路] ${s}`);
    refreshStats();
  });

  // 默认保存目录：优先记住上次用的，否则问后端要（一般是"下载"文件夹）
  let defDir = localStorage.getItem("kdock_save_dir") || "";
  if (!defDir) {
    try { defDir = await invoke("default_save_dir"); } catch (_) { defDir = ""; }
  }
  $("fl-save-dir").value = defDir;
  $("sess-dir").value = localStorage.getItem("kdock_sess_dir") || defDir;
  bindOutHead();
  bindInpaneResize();

  syncUpgCtl();
  switchUpgSource("local");
  await refreshPorts();
  await refreshNetIfaces();
  await refreshStats();
  // 这两个都是纯展示用的轮询：窗口收进托盘/最小化时没人看，就别一直去问后端
  // （周期本身不动，免得切回来时数字更新变慢；恢复可见时立刻补一次）
  const pollVisible = (fn, ms) => setInterval(() => { if (!document.hidden) fn(); }, ms);
  pollVisible(refreshStats, 500);
  pollVisible(refreshUpgState, 800);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshStats(); refreshUpgState(); }
  });
  // 所有 bind 跑完再刷一次语言：很多 title/placeholder 是 JS 里后设的，第一次扫不到
  applyLang(LANG);
  // 第一屏画完了：让后端关掉启动画面、把主窗口放出来（后端另有 6 秒兜底）
  invoke("ui_ready").catch(() => {});
}

main();
