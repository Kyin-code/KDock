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

const $ = (id) => document.getElementById(id);

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
let currentBaud = 115200;
let rxPaused = false;
let loopTimer = null;
let history = [];
let rxBuffer = [];
let rxMode = "text";
let tailEntry = null;      // "正在长的半行"（设备还没发换行），渲染在最后一行、就地更新
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
  rxPending.push(e);
  if (rxTimer !== null) return;
  // 攒 ~16ms 一帧再重绘；**不能只靠 requestAnimationFrame** ——
  // 窗口被遮挡/最小化时浏览器不给 rAF，日志就再也不刷新了（实测踩过），
  // 所以用 setTimeout 兜底、rAF 抢先（可见时更跟手）。
  rxTimer = setTimeout(flushRxPending, RX_FLUSH_MS);
  requestAnimationFrame(flushRxPending);
}

// 跟随最新：只有"本来就在底部"才自动滚；用户上翻时停下并亮出"↓ 最新"徽章
let stickBottom = true;
function maybeScrollBottom() {
  if ($("autoscroll").checked && stickBottom) $("rx").scrollTop = $("rx").scrollHeight;
}
function bindScrollFollow() {
  const el = $("rx");
  el.addEventListener("scroll", () => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (atBottom !== stickBottom) {
      stickBottom = atBottom;
      $("rx-jump").hidden = atBottom;
    }
  });
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
    return { mode: "tcp_client", host: $("tcp-client-host").value.trim(), port: num($("tcp-client-port").value) };
  }
  if (mode === "tcp_server") {
    return { mode: "tcp_server", host: $("tcp-server-host").value.trim(), port: num($("tcp-server-port").value) };
  }
  return {
    mode: "udp",
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
    if (!["serial", "tcp_client", "tcp_server", "udp"].includes(t)) return;
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
    } else if (t === "tcp_server") {
      $("tcp-server-host").value = ep.host || "0.0.0.0";
      $("tcp-server-port").value = ep.port ?? "";
    } else {
      $("udp-local-port").value = ep.local_port ?? "";
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
  // 剩下的非 SGR 转义（清屏、移动光标…）直接抹掉，纯文本流里不该出现
  return out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
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
      const m = /^\u001b\[([0-9;]*)([A-Za-z])/.exec(text.slice(i));
      if (!m) { i += 1; continue; }                      // 裸 ESC：丢掉
      const n = m[1] === "" ? 1 : (parseInt(m[1], 10) || 1);
      if (m[2] === "D") st.col = Math.max(0, st.col - n);
      else if (m[2] === "C") st.col += n;
      else if (m[2] === "A") st.row = Math.max(0, st.row - n);
      else if (m[2] === "B") { st.row += n; while (st.lines.length <= st.row) st.lines.push(""); }
      else if (m[2] === "K") st.lines[st.row] = (st.lines[st.row] ?? "").slice(0, st.col);
      else if (m[2] === "J") { st.lines = [""]; st.row = 0; st.col = 0; }
      else if (m[2] === "H") { st.row = 0; st.col = 0; }
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

function lineHtml(e) {
  const cls = e.dir === "TX" ? "tx" : e.dir === "SYS" ? "sys" : "rx-l";
  const tsOn = $("show-ts") && $("show-ts").checked;
  const dirOn = $("show-dir") && $("show-dir").checked;
  const dir = `<span class="${cls}">${e.dir}</span>`;
  // 方向标记跟时间戳绑在一起（一个方括号前缀，SSCOM 那样）；只有方向没时间戳时才单独占一个词
  let pfx = "";
  if (tsOn && dirOn) pfx = `<span class="ts">[${fmtTs(e.ts_ms)} ${dir}]</span> `;
  else if (tsOn) pfx = `<span class="ts">[${fmtTs(e.ts_ms)}]</span> `;
  else if (dirOn) pfx = dir + " ";
  return entryLines(e).map((l) => pfx + l).join("\n") + "\n";
}

function redrawRx() {
  const tail = tailEntry ? lineHtml(tailEntry) : "";
  if (asciiMode) $("rx").textContent = termRender();      // 终端就是纯文本，不走 HTML
  else $("rx").innerHTML = rxBuffer.map(lineHtml).join("") + tail;
  maybeScrollBottom();
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
    const opts = ports.length
      ? ports.map((p) => {
          const desc = p.friendly || p.description || "";
          return { value: p.port_name, label: desc ? `${p.port_name} — ${desc}` : p.port_name };
        })
      : [{ value: "", label: en("（没有检测到串口）") }];
    // 两个页面各有一份串口列表，内容保持一致
    for (const id of ["ports", "upg-ports", "fl-ports", "sq-ports"]) {
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
      if (opts.length && !sel.value) sel.selectedIndex = 0;   // 第一次进来直接选第一个
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

async function refreshStats() {
  try {
    const s = await invoke("get_stats");
    const state = en(s.connected ? "已连接" : s.listening ? "监听中" : "未连接");
    const chip = s.connected ? (s.label || en("已连接")) : state;
    $("status-chip").textContent = chip;
    $("status-chip").className = "chip" + (s.connected ? " ok" : "");
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

function txMode() {
  return document.querySelector('input[name="tx-mode"]:checked').value;
}

async function doSend() {
  const payload = $("tx").value;
  const txm = txMode();
  const le = $("line-ending").value;
  if (!payload && txm === "text") return toast("没有可发送的内容");
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
    toast(`已发送 ${ack.bytes} B`);
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
  rxBuffer = lines.map((l) => {
    const bytes = (l.data.match(/[0-9A-Fa-f]{2}/g) || []).map((h) => parseInt(h, 16));
    return {
      dir: l.dir,
      ts_ms: l.ts_ms,
      text: new TextDecoder().decode(new Uint8Array(bytes)),
      hex: bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
      ascii: bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join(""),
    };
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
    $("rx").innerHTML += lineHtml(snapshot[i]);
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
  document.querySelectorAll(`[data-${pfx}m]`).forEach((el) => {
    el.hidden = el.dataset[`${pfx}m`] !== m;
  });
}
/** 传输页 -> 这个页：切到该标签时同步一次，让用户看到当前连接参数 */
function syncPaneCtl(pfx) {
  const m = $("mode").value === "tcp_client" ? "tcp_client" : "serial";
  switchPaneMode(pfx, m);
  if (m === "serial") {
    if ($("ports").value) $(`${pfx}-ports`).value = $("ports").value;
    $(`${pfx}-baud`).value = $("baud").value;
  } else {
    $(`${pfx}-host`).value = $("tcp-client-host").value;
    $(`${pfx}-port`).value = $("tcp-client-port").value;
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
    } else {
      $("tcp-client-host").value = $(`${pfx}-host`).value.trim();
      $("tcp-client-port").value = $(`${pfx}-port`).value;
    }
    await doOpen();
  };
  $(`${pfx}-close`).onclick = doClose;
}
wirePaneLink("upg");
function syncUpgCtl() { syncPaneCtl("upg"); }

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
    const items = await invoke("device_list", { path: dir });
    if (my !== flSeq) return;          // 已经有更新的请求了，别拿旧结果覆盖
    flEntries = items;
    flDirOf = dir;
    const sel = $("fl-items");
    sel.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.name;
      if (it.is_dir) o.dataset.dir = "1";
      o.textContent = `${it.is_dir ? "DIR " : "FILE"}   ${String(it.size).padStart(10)}   ${it.name}`;
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
    const r = await invoke("device_pull", { path, saveTo: save });
    flState(`已保存到 ${save}   ${r.bytes} B   crc32=${hex8(r.crc32)}`, "ok");
    toast(`已保存到 ${save}（${r.bytes} B）`);
    pushSys(`[文件] 已保存到 ${save}   ${r.bytes} B   crc32=${hex8(r.crc32)}`);
  } catch (e) {
    flState("失败: " + e, "err");
    pushSys(`[文件] 取文件失败: ${e}`);
  }
}

// 文件页的连接块 + 发文件
wirePaneLink("fl");
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
  if (!flSendFile) { toast("先选一个本机文件"); return; }
  const path = $("fl-send-path").value.trim();
  if (!path) { toast("填一下设备上的目标路径"); return; }
  const n = flSendFile.bytes.length;
  flState(`发送中 ... ${path}`);
  try {
    const crc = await invoke("device_upload", { path, data: flSendFile.bytes });
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
  agent: "agent",
};

/** 切页：左导航高亮 + 中间换操作区 + 右边换参数区 */
function showPane(tab) {
  const btn = document.querySelector(`.navitem[data-tab="${tab}"]`);
  if (btn) document.querySelectorAll(".navitem").forEach((b) => b.classList.toggle("active", b === btn));
  const work = WORK_OF[tab] || tab;
  document.querySelectorAll("[data-work]").forEach((p) => { p.hidden = p.dataset.work !== work; });
  if (work === "agent") agUnreadClear();      // 切过来就算看过了，清掉未读角标
  document.querySelectorAll("[data-param]").forEach((p) => { p.hidden = p.dataset.param !== tab; });
  if (tab === "upgrade") syncUpgCtl();
  if (tab === "files") {
    syncPaneCtl("fl");
    if (!flEntries.length) flList();
  }
  const pg = $("tb-page");
  if (pg) { const p = TB_PAGES.find((x) => x[0] === tab); pg.textContent = p ? en(p[1]) : tab; }
  if (tab === "chart") { chDirty = true; chartResize(); }
  if (tab === "flash") { flashSync(); flashBootstrap(); }
  if (tab === "capture" && capRefresh) capRefresh();
  if (tab === "agent") agOnShow();
  if (tab === "batch") initBatch({ pushTx: pushEntry });
  if (tab === "calc") initCalc();
  if (tab === "scope") { scSetView(scView); scResizePlot(); }
  if (LANG === "en") langWalk();   // 这一页里"切过来才渲染"的文字（提示语/空态）再扫一遍
}

function bindTabs() {
  // 只绑带 data-tab 的；底部那个"设置"齿轮不是页面切换，别把它的 onclick 覆盖了
  document.querySelectorAll(".navitem[data-tab]").forEach((btn) => {
    btn.onclick = () => showPane(btn.dataset.tab);
  });
}

// ---------------- 实时图表（移植 MICU-OmniProbe 的波形思路，用 uPlot 画） ----------------
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
};

// ---- 烧录工具路径：换电脑时可以在界面上指定，存 localStorage ----
const FL_CFG_KEYS = ["openocd", "openocd_scripts", "jlink", "stm32cli"];
let FL_CFG = {};
function flCfgLoad() {
  try { FL_CFG = JSON.parse(localStorage.getItem("kdock_flash_tools") || "{}") || {}; } catch (_) { FL_CFG = {}; }
  for (const k of FL_CFG_KEYS) if (typeof FL_CFG[k] !== "string") FL_CFG[k] = "";
  $("fl-tool-openocd").value = FL_CFG.openocd;
  $("fl-tool-scripts").value = FL_CFG.openocd_scripts;
  $("fl-tool-jlink").value = FL_CFG.jlink;
  $("fl-tool-stm32").value = FL_CFG.stm32cli;
}
function flCfgSave() {
  FL_CFG = {
    openocd: $("fl-tool-openocd").value.trim(),
    openocd_scripts: $("fl-tool-scripts").value.trim(),
    jlink: $("fl-tool-jlink").value.trim(),
    stm32cli: $("fl-tool-stm32").value.trim(),
  };
  localStorage.setItem("kdock_flash_tools", JSON.stringify(FL_CFG));
}
/** 检测/校验烧录工具：结果回填到输入框，并把"找没找到/版本/来源"写到状态行 */
async function flDetectTools(clearFirst) {
  if (clearFirst) {
    for (const id of ["fl-tool-openocd", "fl-tool-scripts", "fl-tool-jlink", "fl-tool-stm32"]) $(id).value = "";
  }
  flCfgSave();
  $("fl-tool-state").textContent = "检测中…";
  try {
    const r = await invoke("flash_tools", { overrides: FL_CFG });
    const seg = [];
    const map = [["openocd", "fl-tool-openocd"], ["jlink", "fl-tool-jlink"], ["stm32cli", "fl-tool-stm32"]];
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
    jlinkDev: ($("fl-target").value.trim() || "STM32F407VG").toUpperCase(),
    file: $("fl-path").value.trim(),
    addr: $("fl-addr").value.trim(),
    action,
  };
}

let FL_DEVS = [];          // 合并后的器件清单：{name, desc, group, src, path?, vendor?, core?}
let FL_DEVS_SRC = "";
let FL_PICK = null;        // 当前选中的器件
let FL_JLINK_PATH = "";

const flBadge = (x) => (x.src === "jlink" ? "J-Link"
  : en(x.group === "target" ? "openocd 芯片" : x.group === "board" ? "openocd 开发板" : "openocd 适配器"));

async function flLoadDevs(quiet) {
  $("fl-dev-src").textContent = "读取中…";
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
  // 2) J-Link 的 JLinkDevices.xml
  try {
    const r = await invoke("flash_jlink_devices", { path: null, exe: FL_CFG.jlink || null });
    const devs = (r && r.devices) || [];
    for (const d of devs) {
      const desc = [d.vendor, d.core, d.ram_addr ? `RAM ${d.ram_addr}/${d.ram_size}` : ""].filter(Boolean).join(" · ");
      out.push({ name: d.name, desc, group: "jlink", src: "jlink", vendor: d.vendor, core: d.core });
    }
    FL_JLINK_PATH = (r && r.path) || "";
    srcTxt.push(`J-Link：${devs.length}（${(r && r.source) || "库"}）`);
    $("fl-dev-src").title = FL_JLINK_PATH ? `J-Link device DB: ${FL_JLINK_PATH}` : en("没找到 J-Link 器件库");
  } catch (e) {
    srcTxt.push(en("J-Link 器件库：没找到 JLinkDevices.xml"));
  }
  FL_DEVS = out;
  FL_DEVS_SRC = srcTxt.join("  |  ");
  $("fl-dev-src").textContent = FL_DEVS_SRC;
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
    box.appendChild(b);
  }
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
  let preview = "";
  if (o.tool === "jlink") preview = `${t.exe} -CommanderScript <临时脚本>\n脚本内容:\n${t.script(o)}`;
  else preview = `${t.exe} ${t.mk(o).join(" ") }`;
  $("fl-cmd").textContent = preview;
}

function flashLog(text) {
  const el = $("fl-log");
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

async function flashAction(action) {
  const o = flashOpts(action);
  const t = FL_TOOLS[o.tool];
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
      : (FL_CFG.stm32cli || t.exe);
    if (o.tool === "openocd" && FL_CFG.openocd_scripts) args = ["-s", FL_CFG.openocd_scripts, ...args];
    pushSys(`[烧录] ${o.tool} = ${exe}`);
    await invoke("flash_run", { exe, args });
  } catch (e) {
    flashLog(`启动失败: ${e}\n`);
    toast(String(e));
  }
}

function bindFlash() {
  const on = () => flashSync();
  ["fl-tool", "fl-iface", "fl-speed", "fl-target", "fl-path", "fl-addr"].forEach((id) => {
    const el = $(id);
    if (el) { el.onchange = on; el.oninput = on; }
  });
  $("fl-fw").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "选择固件（.hex / .elf / .bin）", multiple: false, directory: false,
        filters: [{ name: "固件", extensions: ["hex", "elf", "bin"] }, { name: "所有文件", extensions: ["*"] }] });
      if (!p) return;
      const path0 = typeof p === "string" ? p : p.path;
      $("fl-path").value = path0;
      if (/\.bin$/i.test(path0) && !$("fl-addr").value) $("fl-addr").value = "0x08000000";
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
    if (/\.bin$/i.test(p) && !$("fl-addr").value) $("fl-addr").value = "0x08000000";
  };
  $("fl-dev-filter").oninput = flRenderDevs;
  $("fl-src").onchange = flRenderDevs;
  $("fl-dev-reload").onclick = () => flLoadDevs(false);
  $("fl-log-clear").onclick = () => { $("fl-log").textContent = ""; };
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
  for (const id of ["fl-tool-openocd", "fl-tool-scripts", "fl-tool-jlink", "fl-tool-stm32"]) $(id).oninput = () => flCfgSave();
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
  flDetectTools(false).then(() => flLoadDevs(true));
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
  if (!el) return;
  el.textContent = t;
  el.className = "dot" + (cls ? " " + cls : "");
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
    const host = ($("sc-host").value || "").trim() || "192.168.1.23";
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
  if ($("sc-plot")) $("sc-plot").hidden = name !== "wave";
  if ($("sc-shot")) $("sc-shot").hidden = name !== "shot";
  if ($("sc-shot-bar")) $("sc-shot-bar").hidden = name !== "shot" || !scShotData;
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
let capRefresh = null;     // 枚举显示器的函数（第一次进「屏幕捕获」页才跑）

function capState(t, cls) {
  $("cap-state").textContent = t;
  $("cap-state").className = "dot" + (cls ? " " + cls : "");
}

function capApplyLatest() {
  if (!capImg || !capLatest) { capApplying = false; return; }
  const f = capLatest;
  capLatest = null;
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
        o.textContent = m.name;
        sel.appendChild(o);
      });
      if (!list.length) sel.innerHTML = '<option value="0">' + en("（没找到显示器）") + '</option>';
    } catch (e) {
      $("cap-mon").innerHTML = `<option value="0">${e}</option>`;
    }
  };
  $("cap-start").onclick = async () => {
    try {
      view.classList.toggle("fit", $("cap-mode").value === "fit");
      view.innerHTML = "";
      capImg = document.createElement("img");
      view.appendChild(capImg);
      capRunning = true;
      capFrames = 0; capFpsT0 = Date.now();
      // 会话号：后端每开一路捕获就给一个，帧/出错/停止事件都带着它。
      // 上一路线程退出时也会发 stopped，必须按会话过滤 —— 否则"先开 1 号屏、再开 2 号屏"
      // 时，1 号屏线程退出的那个 stopped 会把刚起来的 2 号屏顶成"已停止"（画面却还在刷）。
      capSession = 0;
      const sid = await invoke("capture_start", {
        monitor: Number($("cap-mon").value) || 0,
        fps: Number($("cap-fps").value) || 8,
        quality: Number($("cap-q").value) || 70,
      });
      capSession = Number(sid) || 0;
      capState("采集中…", "ok");
      pushSys(`[捕获] 开始（显示器 ${$("cap-mon").value}，${$("cap-fps").value}fps，画质 ${$("cap-q").value}）`);
    } catch (e) {
      capRunning = false;
      capState("启动失败", "err");
      toast(String(e));
    }
  };
  $("cap-stop").onclick = async () => {
    capRunning = false;
    capSession = 0;                       // 自己按的停：随后那个 stopped 事件不用再理
    await invoke("capture_stop").catch(() => {});
    capState("已停止");
    pushSys("[捕获] 已停止");
  };
  $("cap-mode").onchange = () => view.classList.toggle("fit", $("cap-mode").value === "fit");
  $("cap-reload").onclick = async () => { await refresh(); toast(`显示器列表已刷新（${$("cap-mon").options.length} 个）`); };
  // 枚举显示器要过 DXGI，启动时也要花点时间 —— 留到第一次进「屏幕捕获」页再列（见 showPane）
  capRefresh = refresh;
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

/** 拖输出框右下角那个小角手，改下面输入区的高度（存 localStorage，下次还记得） */
function bindInpaneResize() {
  const grip = $("rx-grip");
  const box = document.querySelector(".workpane.shell .inpane");
  if (!grip || !box) return;
  const saved = Number(localStorage.getItem("kdock_inpane_h") || 0);
  if (saved > 60) box.style.height = saved + "px";
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
    const pane = box.parentElement.getBoundingClientRect().height;
    const want = Math.max(84, Math.min(h0 - (e.clientY - sy), pane - 180));
    box.style.height = want + "px";
  });
  const done = () => {
    if (!grip.classList.contains("dragging")) return;
    grip.classList.remove("dragging");
    localStorage.setItem("kdock_inpane_h", String(Math.round(box.getBoundingClientRect().height)));
  };
  grip.addEventListener("pointerup", done);
  grip.addEventListener("pointercancel", done);
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
let sqTemp = null, sqRunNode = null, sqDrag = null;
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
const sqSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqNewId = () => "n" + (sqSeq++);
const sqNode = (id) => sqGraph.nodes.find((n) => n.id === id);
const sqKey = (e) => e.from + "|" + e.port + "|" + e.to;
function sqEdgesFrom(id, port) { return sqGraph.edges.filter((e) => e.from === id && e.port === port); }
function sqEdgeFrom(id, port) { return sqEdgesFrom(id, port)[0]; }
function sqEdgesInto(id) { return sqGraph.edges.filter((e) => e.to === id); }
function sqLog(text, cls) {
  const box = $("sq-log");
  const d = document.createElement("div");
  d.className = "l" + (cls ? " " + cls : "");
  d.textContent = text;
  box.appendChild(d);
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
  sqGraph.edges = (sqGraph.edges || []).filter((e) => e && ok.has(e.from) && ok.has(e.to));
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
  if (from === to) return toast("不能连到自己");
  const fn = sqNode(from);
  if (!fn || !sqOuts(fn).some((o) => o[0] === port)) return;
  const toNode = sqNode(to);
  if (!toNode || !SQ_KINDS[toNode.type].ins) return toast("这个节点没有输入口");
  // 一个节点可以像函数一样被多处调用（多入边）；一个出口也可以连多条线（扇出）
  if (sqGraph.edges.some((e) => e.from === from && e.port === port && e.to === to)) {
    return toast("这条线已经有了");
  }
  sqGraph.edges.push({ from, port, to });
  sqSave(); sqRender();
}

// ---------- 视图 ----------
function sqApplyView() {
  $("sq-nodes").style.transform = "translate(" + sqView.x + "px, " + sqView.y + "px) scale(" + sqView.k + ")";
  $("sq-edges-g").setAttribute("transform", "translate(" + sqView.x + " " + sqView.y + ") scale(" + sqView.k + ")");
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
  const el = document.querySelector(".seqnode[data-id=\"" + id + "\"] .seqport[data-port=\"" + port + "\"]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = $("sq-canvas").getBoundingClientRect();
  return {
    x: (r.left + r.width / 2 - c.left - sqView.x) / sqView.k,
    y: (r.top + r.height / 2 - c.top - sqView.y) / sqView.k,
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
  if (n && old) { old.replaceWith(sqNodeEl(n)); sqRedrawEdges(); }
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
      if (n.conn === "udp") field("本地端口", num(n.localPort || 0, (v) => (n.localPort = v)));
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
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k0 = sqView.k;
    const k = Math.min(1.8, Math.max(0.45, k0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    sqView.x = mx - (mx - sqView.x) * (k / k0);
    sqView.y = my - (my - sqView.y) * (k / k0);
    sqView.k = k;
    sqApplyView(); sqRedrawEdges();
  }, { passive: false });

  cv.addEventListener("pointerdown", (e) => {
    const c0 = cv.getBoundingClientRect();
    const port = e.target.closest ? e.target.closest(".seqport.out") : null;
    const nodeEl = e.target.closest ? e.target.closest(".seqnode") : null;
    const pathEl = e.target.closest ? e.target.closest(".seqedgegrp") : null;
    if (port && nodeEl) {
      sqSel = { kind: "node", id: nodeEl.dataset.id };
      const a = sqPortPos(nodeEl.dataset.id, port.dataset.port);
      sqTemp = { from: nodeEl.dataset.id, port: port.dataset.port, a: a, b: a };
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
      sqDrag = { mode: "node", id: n.id,
        dx: (e.clientX - c0.left - sqView.x) / sqView.k - n.x,
        dy: (e.clientY - c0.top - sqView.y) / sqView.k - n.y };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      sqRenderCfg(); sqRender();
      e.preventDefault();
      return;
    }
    sqSel = null;
    sqDrag = { mode: "pan", sx: e.clientX - sqView.x, sy: e.clientY - sqView.y };
    cv.classList.add("panning");
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    sqRenderCfg(); sqRedrawEdges();
  });

  cv.addEventListener("pointermove", (e) => {
    if (!sqDrag) return;
    const c0 = cv.getBoundingClientRect();
    if (sqDrag.mode === "pan") {
      sqView.x = e.clientX - sqDrag.sx;
      sqView.y = e.clientY - sqDrag.sy;
      sqApplyView(); sqRedrawEdges();
    } else if (sqDrag.mode === "node") {
      const n = sqNode(sqDrag.id);
      if (!n) return;
      n.x = Math.round((e.clientX - c0.left - sqView.x) / sqView.k - sqDrag.dx);
      n.y = Math.round((e.clientY - c0.top - sqView.y) / sqView.k - sqDrag.dy);
      const el = document.querySelector(".seqnode[data-id=\"" + n.id + "\"]");
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      sqRedrawEdges();
    } else if (sqDrag.mode === "link" && sqTemp) {
      sqTemp.b = { x: (e.clientX - c0.left - sqView.x) / sqView.k, y: (e.clientY - c0.top - sqView.y) / sqView.k };
      sqRedrawEdges();
    }
  });

  const endDrag = (e) => {
    cv.classList.remove("panning", "linking");
    if (sqDrag && sqDrag.mode === "link" && sqTemp) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest ? under.closest(".seqnode") : null;
      if (target && target.dataset.id !== sqTemp.from) sqConnect(sqTemp.from, sqTemp.port, target.dataset.id);
    }
    if (sqDrag && sqDrag.mode === "node") sqSave();
    sqDrag = null; sqTemp = null;
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
    const key = n.conn + ":" + String(n.host || "") + ":" + String(n.port || 0);
    if (sqRunConns[key]) return sqRunConns[key];
    const ep = n.conn === "udp"
      ? { mode: "udp", local_port: Number(n.localPort) || 0, remote_host: n.host, remote_port: Number(n.port) }
      : { mode: "tcp_client", host: n.host, port: Number(n.port) };
    const r = await invoke("extra_open", { endpoint: ep });
    sqRunConns[key] = r.id;
    sqLog("临时 " + n.conn.toUpperCase() + " 已连接 #" + r.id + " " + r.label);
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
  $("sq-clear-log").onclick = () => { $("sq-log").innerHTML = ""; };
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

function qsRender() {
  const box = $("qs-list");
  box.innerHTML = "";
  qsItems.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = en(it.label || it.payload);
    b.title = (it.hex ? "HEX: " : "") + it.payload;
    b.onclick = () => sendPayload(it.payload, it.hex);
    const del = document.createElement("button");
    del.className = "qsdel";
    del.textContent = "✕";
    del.title = "删除这一条";
    del.onclick = (ev) => {
      ev.stopPropagation();
      qsItems.splice(i, 1);
      qsSave();
      qsRender();
    };
    const wrap = document.createElement("span");
    wrap.style.display = "inline-flex";
    wrap.appendChild(b);
    wrap.appendChild(del);
    box.appendChild(wrap);
  });
  if (!qsItems.length) box.innerHTML = '<span class="lb">（还没有快捷项，下面加一条）</span>';
}

function bindQuickSend() {
  qsRender();
  $("qs-add").onclick = () => {
    const payload = $("qs-payload").value;
    if (!payload.trim()) return toast("先填要发送的内容");
    qsItems.push({ label: $("qs-label").value.trim() || payload.slice(0, 12), payload, hex: $("qs-hex").checked });
    qsSave();
    qsRender();
    $("qs-label").value = "";
    $("qs-payload").value = "";
    $("qs-hex").checked = false;
  };
  $("qs-payload").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("qs-add").click(); }
  });
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
  const maxFor = () => {
    const total = (document.querySelector(".split") || document.body).clientWidth || window.innerWidth;
    const other = parseInt(getComputedStyle(root).getPropertyValue(otherVar)) || otherMin;
    return Math.max(min, total - Math.max(other, otherMin) - centerMin);
  };
  const saved = Number(localStorage.getItem(storeKey) || 0);
  if (saved >= min) root.style.setProperty(cssVar, Math.min(saved, maxFor()) + "px");
  const el = $(id);
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
// 配色方案取自 MICU-OmniProbe 的 themeSchemes.ts（MIT），只覆写主色/焦点色/点缀色/背景光斑，
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
// 缩放用 WebView 自己的"页面缩放"：它会**叠加**在系统显示缩放（DPI）之上，所以控件、文本、字号
// 一起按倍数变化，而不是只动文本。字号是其中一档（和放大倍数相乘），字体只替换正文那一族。
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
  invoke("window_set_zoom", { scale: uiScaleValue() }).catch(() => {});
  const id = localStorage.getItem("kdock_ui_font") || "system";
  const fam = (UI_FONTS.find((x) => x[0] === id) || UI_FONTS[0])[2];
  if (fam) document.documentElement.style.setProperty("--ui-font", fam);
  else document.documentElement.style.removeProperty("--ui-font");
}
function syncUiScaleControls() {
  const set = (id, v) => { const s = $(id); if (s && v != null) s.value = String(v); };
  set("ui-font-scale", localStorage.getItem("kdock_font_scale") || "normal");
  set("ui-zoom", String(Number(localStorage.getItem("kdock_ui_zoom") || "1")));
  set("ui-font", localStorage.getItem("kdock_ui_font") || "system");
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
  return {
    theme: localStorage.getItem("kdock_theme") || "dark",
    scheme: localStorage.getItem("kdock_scheme") || "ocean",
    lang: LANG,
    fontScale: localStorage.getItem("kdock_font_scale") || "normal",
    zoom: localStorage.getItem("kdock_ui_zoom") || "1",
    font: localStorage.getItem("kdock_ui_font") || "system",
  };
}
function uiPrefsSave() {
  if (!uiPrefsReady) return;
  const p = uiPrefsSnapshot();
  const key = [p.theme, p.scheme, p.lang, p.fontScale, p.zoom, p.font].join("|");
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
  uiPrefsReady = true;
  applyTheme(localStorage.getItem("kdock_theme") || "dark");   // 里面会带上 applyScheme
  applyScheme(localStorage.getItem("kdock_scheme") || "ocean");
  if (p.lang && p.lang !== LANG) applyLang(p.lang);
  applyUiScale();
  syncUiScaleControls();
  const s2 = uiPrefsSnapshot();
  uiPrefsLast = [s2.theme, s2.scheme, s2.lang, s2.fontScale, s2.zoom, s2.font].join("|");
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

// ---------------- 时间戳 / 方向标记开关 ----------------
function bindTimestamp() {
  $("show-ts").onchange = () => redrawRx();
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
      if (n.title) {
        const ti = EN[n.title] || EN[n.title.trim().replace(/\s+/g, " ")];
        if (LANG === "en" && ti) { n.dataset.zhTi = n.dataset.zhTi || n.title; n.title = ti; }
        else if (LANG === "zh" && n.dataset.zhTi) n.title = n.dataset.zhTi;
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
  if (section === "about") agLoadTools();
}

function closeSettings() {
  const m = document.getElementById("settings-modal");
  if (m) m.hidden = true;
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
      if (b.dataset.set === "about") agLoadTools();
      if (b.dataset.set === "cache") { cacheRender(); bindCache(); }
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
    if (e.key === "," && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openSettings("general"); }
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
    title.textContent = opts.title || "确认";
    text.textContent = opts.text || "";
    const wantInput = !!opts.input;
    input.hidden = !wantInput;
    input.value = opts.def || "";
    ok.textContent = opts.okText || "确定";
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
  nm.textContent = ev.name + "(" + (ev.args && Object.keys(ev.args).length ? Object.keys(ev.args).join(", ") : "") + ")";
  const st = document.createElement("span");
  st.className = "st";
  st.textContent = ev.ok === false ? en("失败") : ev.ok ? en("完成") : en("执行中…");
  head.appendChild(nm);
  head.appendChild(st);
  const bd = document.createElement("div");
  bd.className = "bd";
  const argPre = document.createElement("pre");
  argPre.textContent = en("参数：") + JSON.stringify(ev.args || {}, null, 2);
  bd.appendChild(argPre);
  if (ev.text != null) {
    const outPre = document.createElement("pre");
    outPre.textContent = ev.text;
    bd.appendChild(outPre);
  }
  head.onclick = () => wrap.classList.toggle("open");
  wrap.appendChild(head);
  wrap.appendChild(bd);
  if (ev.ok === false) wrap.classList.add("open");
  return wrap;
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
  if (agCfg && !(agCfg.providers || []).length) {
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
    b.textContent = "还没有可用的模型：点左下角「设置」（或 Ctrl+,）→ 模型与供应商 → 选一个厂家预设点「填入表单」，"
      + "粘上你的 API Key 保存，就能开始对话了。";
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
      tt.className = "t"; tt.textContent = x.title || en("（无标题）");
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
  if (t) t.textContent = agMeta ? (agMeta.title || en("（无标题）")) : en("（还没选对话）");
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

/* ── Agent 信息面板（参考 opencode 的状态栏）：上下文占用 / 工作区 git / token / 缓存命中 / 估算花费 ──
 * 价格表就在下面 AG_PRICE，单位是"元 / 百万 token"（命中缓存的输入便宜、未命中贵、输出最贵）。
 * 不是从接口拉的，改这里就能对上你自己买的价格；匹配不到的模型走最后那条兜底。 */
const AG_PRICE = [
  { match: /deepseek/i, hit: 0.5, miss: 2, out: 8 },
  { match: /glm|zhipu/i, hit: 0.5, miss: 2, out: 8 },
  { match: /qwen|dashscope/i, hit: 0.4, miss: 2, out: 8 },
  { match: /.*/, hit: 0.5, miss: 2, out: 8 },
];
const agPriceOf = (model) => AG_PRICE.find((p) => p.match.test(String(model || ""))) || AG_PRICE[AG_PRICE.length - 1];
const agCostOf = (model, hit, miss, out) => {
  const p = agPriceOf(model);
  return (hit / 1e6) * p.hit + (miss / 1e6) * p.miss + (out / 1e6) * p.out;
};
const agMoney = (y) => (!(y > 0) ? "¥0" : y < 0.01 ? "¥" + y.toFixed(4) : y < 1 ? "¥" + y.toFixed(3) : "¥" + y.toFixed(2));
const agK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K" : String(n || 0));

let agGit = null;      // 工作区 git 快照（workspace_git 的结果）
let agGitFor = "";     // 这份快照对应的目录
let agBalance = null;      // 余额（agent_provider_balance 的结果，格式化过的）
let agBalanceAt = 0;       // 上次查询时间（60 秒内不重复查）
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
  const hitRate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0;
  const model = (prov && prov.model) || (agMeta && agMeta.model) || "";
  const cost = agCostOf(model, hit, miss, outTok);
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
    row("缓存命中", hit + miss > 0 ? `${hitRate}%（${agK(hit)} / ${agK(hit + miss)}）` : "—", hitRate >= 50 ? "ok" : "") +
    (() => {
      // 速度按"实际跑的那条 profile"取：优先当前生效的（下一轮就是它跑），
      // 没有它的数据再退回这个会话记录的那条
      const activeId = agCfg && agCfg.activeId;
      const sp = agSpeed[activeId] || agSpeed[(prov && prov.id) || ""];
      if (!sp || !(sp.last > 0)) return row("出字速度", "—");
      return row("出字速度", `${fmtTps(sp.last)} ${en("最近")} · ${fmtTps(sp.avg)} ${en("平均")}`, "ok");
    })() +
    row("花费", `${agMoney(cost)}`, "") +
    (agBalance ? row("余额", agEscape(agBalance), "") : "") +
    `<div class="sub">${en("按")} ${agEscape(model || "?")} ${en("的价格估算（元/百万 token），可在 main.js 的 AG_PRICE 里改")}</div>` +
    `<div class="sub">${en("出字速度只算模型正在出字的那段（工具调用、等待不算）")}</div>`;
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
    ["tool", "工具调用/结果", "#ff6b6b"],
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
    (b.skillsAlways
      ? `<div class="sub">${en("其中常驻技能")}: ${agK(b.skillsAlways)} tokens · ${en("正文每轮注入，不会被压缩掉")}</div>`
      : "") +
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
    agRenderInfo();
    agRefreshGit();        // 每个会话的工作区可能不一样
    agRefreshBreakdown();
    agRefreshBalance();
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
      await invoke("agent_stop").catch(() => {});
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
    case "help": {
      const custom = await invoke("agent_slash_list").catch(() => []);
      const builtin = "/goal <目标>  设定长期目标（/goal clear 清除）\n/compact  压缩上下文\n" +
        "/new  新建会话\n" +
        "/model [名字]  看 / 切换当前模型\n/perm ask|auto|read  切换权限\n/stop  停止这一轮\n" +
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
  try {
    // **先发再上屏**：被拒的时候不要把用户的话弄丢
    const r = await invoke("agent_send", { sessionId: agMeta.id, text, providerId: agCfg ? agCfg.activeId : null });
    if (r && r.queued) {
      // 边跑边补充：先挂一个"排队中"的气泡；后端把它并进对话后会发 agent://user 换成正式的
      agEvents.push({ type: "user", text, queued: true });
      agAppendEvent({ type: "user", text, queued: true });
      agUpdateHeader();
      return;
    }
  } catch (e) {
    box.value = backup;
    agRunning = false;
    agState("空闲");
    agSyncRunning();
    toast(String(e));
    return;
  }
  agEvents.push({ type: "user", text, ts: Date.now() });
  agAppendEvent({ type: "user", text });
  agStreamText = "";
  agStreamNode = null;
  agRunning = true;
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
  await agLoadConfig();
  await agLoadTree();
  // 打开最近一个对话；一个都没有才新建
  if (!agMeta) {
    if (agSessions.length) await agOpenSession(agSessions[0].id);
    else await agNewSession(agWorkspaces[0] && agWorkspaces[0].id);
  }
  agLoadSkills();
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
      await invoke("agent_stop").catch(() => {});
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
    });
  }

  // 供应商：两个子页（使用 / 新增）
  document.querySelectorAll("#ag-prov-tabs .segtab").forEach((b) => {
    b.onclick = () => agProvTab(b.dataset.provtab);
  });
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
      if (agEl("ag-prov-new-title")) agEl("ag-prov-new-title").textContent = "新增供应商";
      if (agEl("ag-prov-cancel")) agEl("ag-prov-cancel").hidden = false;
      agEl("ag-p-id").value = p.id;
      agEl("ag-p-name").value = p.name;
      agEl("ag-p-endpoint").value = p.endpoint;
      agEl("ag-p-model").value = p.model;
      agEl("ag-p-ctx").value = p.ctx;
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
      const dl = agEl("ag-model-list");
      dl.innerHTML = "";
      for (const m of list) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); }
      toast(list.length ? `拉到 ${list.length} 个模型，点模型输入框选` : "这个服务没给模型列表，手填吧");
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
  if (agEl("ag-preset") && !agEl("ag-preset").options.length) {
    const ps = agEl("ag-preset");
    ps.innerHTML = '<option value="">— 选厂家 —</option>';
    for (const p of AG_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      ps.appendChild(o);
    }
  }
  agRenderProviders();
  // 用户正在「新增 / 编辑」页填表时，别被后台刷新把表单冲掉
  if (agCfg.providers.length && !agNewProfile && !agOnNewTab()) {
    agFillProvider(agCfg.activeId || (sel && sel.value) || agCfg.providers[0].id);
  }
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
  if (sid) {
    await invoke("agent_session_set_provider", { id: sid, providerId: id }).catch(() => {});
  }
  await agLoadConfig();
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
function agFormProvider() {
  return {
    id: (agEl("ag-p-id").value || "probe").trim(),
    name: (agEl("ag-p-name").value || "probe").trim(),
    kind: agEl("ag-p-kind") ? agEl("ag-p-kind").value : "openai",
    endpoint: agEl("ag-p-endpoint").value.trim(),
    model: agEl("ag-p-model").value.trim(),
    api_key_ref: (agEl("ag-p-id").value || "").trim(),
    temperature: Number(agEl("ag-p-temp").value) || 0.2,
    context_window: Number(agEl("ag-p-ctx").value) || 128000,
    reserve_output: Number(agEl("ag-p-res").value) || 8192,
    max_messages: 40,
    supports_tools: agEl("ag-p-tools").checked,
    supports_stream: agEl("ag-p-stream").checked,
  };
}

function agFormKey() {
  const k = (agEl("ag-p-key").value || "").trim();
  return k ? k : null;      // 空的话后端会回退到密钥库里存的那把
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
  return bits.join(" · ");
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
}

function agFillProvider(id) {
  const p = agCfg && agCfg.providers.find((x) => x.id === id);
  if (!p) return;
  agEl("ag-p-id").value = p.id;
  agEl("ag-p-name").value = p.name;
  agEl("ag-p-endpoint").value = p.endpoint;
  if (agEl("ag-p-kind")) agEl("ag-p-kind").value = p.kind || "openai";
  agEl("ag-p-model").value = p.model;
  agEl("ag-p-key").value = "";
  agEl("ag-p-key").placeholder = (agCfg.secrets || []).includes(p.api_key_ref) ? "已在密钥库里（留空=不改）" : "粘贴 API Key";
  agEl("ag-p-ctx").value = p.context_window;
  agEl("ag-p-res").value = p.reserve_output;
  agEl("ag-p-temp").value = p.temperature;
  agEl("ag-p-tools").checked = !!p.supports_tools;
  agEl("ag-p-stream").checked = !!p.supports_stream;
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
    context_window: Number(agEl("ag-p-ctx").value) || 128000,
    reserve_output: Number(agEl("ag-p-res").value) || 8192,
    max_messages: 40,
    supports_tools: agEl("ag-p-tools").checked,
    supports_stream: agEl("ag-p-stream").checked,
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
  meta.textContent = `${p.model} · ${p.endpoint}${hasKey ? "" : " · " + en("⚠ 没密钥")}`;
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
  agAlways = await invoke("agent_skills_always").catch(() => ({ slugs: [], bytes: 0, limit: 16384 }));
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
    sw.title = en(s.enabled ? "已启用（关掉=不进口令索引）" : "已停用");
    sw.onchange = async () => {
      try {
        await invoke("agent_skill_set_enabled", { name: s.slug, on: sw.checked });
        toast(sw.checked ? `已启用 ${s.slug}` : `已停用 ${s.slug}`);
      } catch (e) {
        toast(String(e)); sw.checked = !sw.checked;
      }
      await agLoadSkills();
    };
    // 「常驻」：勾上就每轮把技能正文注入系统提示（身份 / 口吻 / 说话规则这类技能用这个）。
    // 技能没启用时不给勾 —— 后端也拦（常驻只对启用的技能生效）。
    const awLbl = document.createElement("span");
    awLbl.className = "swtag" + (agIsAlways(s.slug) ? " on" : "");
    awLbl.textContent = en("常驻");
    const aw = document.createElement("input");
    aw.type = "checkbox"; aw.className = "sw"; aw.checked = agIsAlways(s.slug);
    aw.disabled = !s.enabled;
    aw.title = !s.enabled
      ? en("先启用这个技能")
      : en("常驻：技能正文每轮注入系统提示（身份 / 口吻类技能用这个）");
    aw.onchange = async () => {
      // 先在前端拦一道上限（按"常驻技能字节合计"算），后端还会再拦一次
      if (aw.checked && agAlways.bytes + (s.size || 0) > agAlways.limit) {
        aw.checked = false;
        return toast(`常驻技能合计不能超过 ${(agAlways.limit / 1024).toFixed(0)} KB（已用 ${(agAlways.bytes / 1024).toFixed(1)} KB）`);
      }
      try {
        await invoke("agent_skill_set_always", { name: s.slug, on: aw.checked });
        toast(aw.checked ? `已常驻 ${s.slug}（正文每轮注入）` : `已取消常驻 ${s.slug}`);
      } catch (e) {
        toast(String(e)); aw.checked = !aw.checked;
      }
      await agLoadSkills();
    };
    row.appendChild(nm); row.appendChild(d); row.appendChild(sz);
    row.appendChild(awLbl); row.appendChild(aw); row.appendChild(sw);
    box.appendChild(row);
  }
  if (agAlways.slugs.length) {
    const foot = document.createElement("div");
    foot.className = "agrow empty";
    foot.textContent = en("常驻技能") + ": " + agAlways.slugs.join(", ") + " · " +
      (agAlways.bytes / 1024).toFixed(1) + " / " + (agAlways.limit / 1024).toFixed(0) + " KB · " +
      en("每轮注入系统提示，一直占上下文");
    box.appendChild(foot);
  }
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
    tag.textContent = (s.enabled ? "" : "停用 · ") + (agIsAlways(s.slug) ? en("常驻") + " · " : "")
      + (s.size + 0 === s.size ? (s.size / 1024).toFixed(1) + " KB" : "");
    row.appendChild(nm); row.appendChild(tag);
    row.title = (s.description || "") + "\n" + (s.path || "");
    row.onclick = async () => {
      agEl("set-skill-name").value = s.slug;
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
    tag.textContent = en(m.enabled ? "已启用" : "已停用") + " · " + [m.command, ...(m.args || [])].join(" ").slice(0, 40);
    row.title = [m.command, ...(m.args || [])].join(" ");
    row.appendChild(nm); row.appendChild(tag);
    row.onclick = () => {
      agEl("set-mcp-id").value = m.id;
      agEl("set-mcp-cmd").value = m.command;
      agEl("set-mcp-args").value = (m.args || []).join(" ");
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
  agEl("set-skill-save").onclick = async () => {
    const n = agEl("set-skill-name").value.trim();
    if (!n) return toast("先填技能名");
    try {
      await invoke("agent_skill_save", { name: n, content: agEl("set-skill-body").value });
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
    if (!n || !(await agConfirm(`删掉技能 ${n}？（目录会一起删）`, "删除技能", true))) return;
    await invoke("agent_skill_delete", { name: n }).catch((e) => toast(String(e)));
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
    const command = agEl("set-mcp-cmd").value.trim();
    if (!command) return toast("要填命令（npx / node / exe）");
    const old = (agMcps || []).find((m) => m.id === id);
    const server = {
      id,
      name: old ? old.name : id,
      command,
      args: agEl("set-mcp-args").value.split(/\s+/).filter(Boolean),
      env: (old && old.env) || {},
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
  ui_goto: "Switch the UI to a page (transfer/upgrade/flash/files/chart/flow/capture/scope).",
  flow_run: "Run the flow (the current canvas when no graph is given).",
  flow_status: "Check flow progress / the tail of its log.",
  flow_stop: "Stop the running flow.",
  capture_save: "Grab a screenshot (saved into the workspace).",
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
      inp.value = f.value == null ? "" : String(f.value);
      if (f.ph) inp.placeholder = f.ph;
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
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
      return out;
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && document.activeElement && document.activeElement.tagName === "INPUT") {
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
                      "fl-host", "fl-port", "sq-host", "sq-port", "sc-host"];
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
  for (const id of DEV_HIST_IDS) {
    const inp = document.getElementById(id);
    if (!inp) continue;
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
    const c = await invoke("agent_config_get");
    agRunning = !!c.running;
    agState(agRunning ? en("思考中…") : en("空闲"), agRunning ? "ok" : "");
    if (agEl("ag-stop")) agEl("ag-stop").hidden = !agRunning;
    agSetSendDisabled(agRunning);
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
  async ui_goto(a) {
    const map = { transfer: "link", firmware: "upgrade", flow: "seq", files: "files", flash: "flash",
                  chart: "chart", capture: "capture", scope: "scope", logic: "logic", commands: "cmds" };
    const tab = map[a.page] || a.page;
    showPane(tab);
    return "已切到「" + tab + "」页";
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

async function agHostCall(p) {
  const fn = AG_HOST[p.tool];
  if (!fn) {
    await invoke("agent_host_result", { id: p.id, ok: false, result: `前端没有实现工具 ${p.tool}` }).catch(() => {});
    return;
  }
  try {
    const r = await fn(p.args || {});
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
    agRunning = !!(ev.payload && ev.payload.running);
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
    const cache = p.cacheHit || p.cacheMiss ? ` · ${en("缓存命中")} ${p.cacheHit || 0}` : "";
    if (el) el.textContent = `in ${p.prompt} / out ${p.completion} tokens${cache}`;
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
    const done = async (ok) => {
      acts.innerHTML = `<span class="hint">${ok ? "已允许" : "已拒绝"}</span>`;
      await invoke("agent_approval_result", { id: p.id, ok }).catch(() => {});
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    acts.appendChild(yes); acts.appendChild(no);
    card.appendChild(ttl); card.appendChild(pre); card.appendChild(acts);
    box.appendChild(card);
    agScrollTail(true);
    agState("等你批准…", "wait");
    if (!agWatching()) agUnreadBump();
  });
  await agOn("agent://browser", (ev) => {
    agRenderPage(ev.payload);     // agent 打开网页时，右侧「浏览器」跟着显示
  });
  await agOn("agent://done", async () => {
    agRunning = false;
    agState("空闲");
    agThinkSettle();
    if (!agWatching()) agUnreadBump();         // 没在看这一页 → 挂个"有未读"角标
    agSetSendDisabled(false);
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
    }
  });
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
  "传输": "Transfer", "命令表": "Commands", "固件升级": "Firmware", "烧录": "Flash",
  "文件管理": "Files", "实时图表": "Charts", "中控编排": "Flow", "示波器": "Scope",
  "屏幕捕获": "Capture", "逻辑分析仪": "Logic",
  "批量文本": "Batch text", "计算器": "Calculator",
  "文件": "File", "编辑": "Edit", "视图": "View", "窗口": "Window", "帮助": "Help",
  "连接": "Connect", "断开": "Disconnect", "发送": "Send", "清空": "Clear", "清空日志": "Clear log",
  "开始": "Start", "停止": "Stop", "暂停接收": "Pause RX", "自动滚动": "Auto scroll",
  "ASCII 交互": "ASCII mode", "复制全部输出": "Copy output", "清空发送区": "Clear input",
  "主题": "Theme", "配色": "Accent", "暗色": "Dark", "亮色": "Light", "跟随": "System",
  "暗色主题": "Dark theme", "亮色主题": "Light theme", "跟随系统": "Follow system",
  "配色与设置…": "Accent & settings…", "最小化": "Minimize", "最大化 / 还原": "Maximize / Restore",
  "关闭到托盘": "Close to tray", "开机自启": "Run at startup", "断线自动重连": "Auto reconnect",
  "快捷键": "Shortcuts", "关于 KDock": "About KDock", "退出 KDock": "Quit KDock",
  "保存会话日志…": "Save session…", "加载会话日志…": "Load session…", "导出 CSV…": "Export CSV…",
  "回放会话": "Replay session", "导入编排 JSON…": "Import flow JSON…", "导出编排 JSON…": "Export flow JSON…",
  "连接设备": "Device link", "方式": "Mode", "串口": "Port", "波特率": "Baud", "目标 IP": "Host",
  "端口": "Port", "路径": "Path", "地址": "Address", "文件": "File", "速度": "Speed",
  "接口": "Interface", "适配器": "Adapter", "工具": "Tool", "目标芯片": "Target chip",
  "器件库": "Device library", "固件": "Firmware", "命令预览": "Command preview",
  "烧录器": "Programmer", "烧录工具路径（换电脑时用）": "Tool paths (for a new PC)",
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
  "hex/elf 自带地址；bin 要填下面的起始地址（STM32 一般是": "hex/elf carry their own addresses; for bin fill the start address below (usually",
  "是 OTA 升级包，请到「固件升级」页用。": "is an OTA package — use the Firmware page.",
  // 占位符
  "JLink.exe 路径": "JLink.exe path",
  "openocd 的 scripts 目录（可留空）": "openocd scripts dir (optional)",
  "例如 250000": "e.g. 250000", "名字": "name",
  "搜型号，如 stm32f4 / nrf52 / rp2040": "Search a model, e.g. stm32f4 / nrf52 / rp2040",
  "搜索命令 / 说明": "Search command / description",
  "文本直接输入；HEX 形如 41 54 0D 0A（Enter 发送 / Shift+Enter 换行）": "Plain text, or HEX like 41 54 0D 0A (Enter to send / Shift+Enter for newline)",
  "本机目录": "Local folder", "没找到就手动选 openocd.exe": "Pick openocd.exe manually if not found",
  "目录或 .fw 地址": "Directory or .fw path", "要发送的内容": "Payload",
  "选文件后自动填": "Filled after picking a file", "默认目录": "Default folder",
  // 悬停提示
  "关闭（按设置可收进托盘）": "Close (may go to tray)",
  "删除这一条": "Delete this row",
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
  "拖动调整输入区高度": "Drag to resize the input area",
  "出口：成功 / 失败。": "Exits: ok / fail.",
  "出口：成功 / 失败(发送错) / 超时(等不到)。": "Exits: ok / fail(send error) / timeout(no data).",
  // 编排：期待匹配
  // 设置弹窗
  "设置": "Settings", "通用": "General", "主题与配色": "Theme & accent",
  "模型与供应商": "Model & provider", "关于与数据": "About & data", "界面": "Appearance",
  "行为": "Behaviour", "数据目录": "Data folder", "主题": "Theme", "配色": "Accent",
  "agent 能用的工具": "Tools the agent can use", "当前": "Current",
  // Agent 右栏三页
  "浏览器": "Browser", "技能 / MCP": "Skills / MCP", "文本": "Text",
  "Agent 信息": "Agent info", "上下文": "Context", "工作区": "Workspace",
  "Token": "Tokens", "缓存命中": "Cache hit", "花费": "Cost",
  "输入": "in", "输出": "out", "补充": "Add",
  "上下文成分": "Context breakdown", "系统提示": "System", "工具定义": "Tools",
  "摘要": "Summary", "用户消息": "User msgs", "助手回复": "Assistant", "工具调用/结果": "Tool calls/results",
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
  "按": "estimated with", "的价格估算（元/百万 token），可在 main.js 的 AG_PRICE 里改":
    "pricing (CNY per 1M tokens); edit AG_PRICE in main.js",
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
  "期望值(HEX)": "Expected (HEX)", "掩码(HEX)": "Mask (HEX)", "正则": "regex", "位判断": "bit test",
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
  "出字速度只算模型正在出字的那段（工具调用、等待不算）":
    "Throughput counts only the time the model spends emitting tokens (tool calls and waiting are excluded).",
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
  "正在取模型状态（AMD 那边约 20 秒）": "Fetching model status (takes ~20 s for AMD)",
  "这轮用哪个模型（参数去设置里改）": "Model to use (edit parameters in Settings)",
  "＋ 新增/编辑…": "＋ Add / edit…", "取状态中…": "fetching status…",
  "状态未知": "status unknown", "满载": "full", "繁忙": "busy",
  "（还没有技能）· 去「设置 → 技能」导入": "(no skills yet) · import one in Settings → Skills",
  "（还没有 MCP 服务）· 去「设置 → MCP」新增": "(no MCP servers yet) · add one in Settings → MCP",
  "这里只管**开关**（关掉的技能不进口令索引，agent 也看不到）。": "This page only shows toggles (a disabled skill is not indexed and stays invisible to the agent).",
  "路径 / 导入 / 编辑都在": "Paths, import and editing live in",
  "设置 → 技能": "Settings → Skills",
  "这里只管**开关**。新增 / 参数 / 测试都在": "This page only shows toggles. Adding, parameters and tests live in",
  "设置 → MCP": "Settings → MCP",
  "（来自文件名 / agent）": "(from file name / agent)",
  "这里可以看文本：打开文件、或者让 agent 用 ui_show_text 推过来。":
    "Show text here: open a file, or let the agent push one with ui_show_text.",

  // ============ 设置：模型与供应商 ============
  "厂家预设": "Vendor preset", "— 选厂家 —": "— pick a vendor —", "填入表单": "Fill form",
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
  "固件目录 / manifest.json / 单个 .fw 的地址": "firmware folder / manifest.json / a single .fw URL",
  "显示当前目录": "show current directory",
  "等待数据…": "waiting for data…", "设备按": "The device sends",
  "读取中…": "reading…",
  "openocd 芯片": "openocd chip", "openocd 开发板": "openocd board",
  "（没有检测到串口）": "(no serial port found)",
  "（还没对话，点 ＋）": "(no sessions yet — click ＋)", "（无标题）": "(untitled)",
  "（还没选对话）": "(no session selected)", " 轮": " turns",
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
  "接收": "RX", "发送": "TX", "字符": "chars", "日志": "log",
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
  "这里只管**开关**（关掉的技能不进口令索引，agent 也看不到）。 路径 / 导入 / 编辑都在":
    "This page only shows toggles (a disabled skill is not indexed and stays invisible to the agent). Paths, import and editing live in",
  "： hex/elf 自带地址；bin 要填下面的起始地址（STM32 一般是":
    ": hex/elf carry their own address; a .bin needs the start address below (usually",
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
  "按列处理": "process columns", "按分隔符取列": "cut by delimiter", "排序": "sort",
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
  "已启用（关掉=不进口令索引）": "enabled (turn off = not indexed)",
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
  "RIGOL DS1000Z 系标配的网口口子（TCP 5555，SCPI 文本）。连上之后 agent":
    "The standard LAN port on RIGOL DS1000Z series scopes (TCP 5555, SCPI text). Once connected the agent",
  "工具干同样的事。": "can do the same things with the same tools.",
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
  const btn = $("tb-lang");
  if (btn) { btn.textContent = LANG === "en" ? "EN" : "中"; btn.title = LANG === "en" ? "Switch to 中文" : "Switch to English"; }
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
    safe(buildCmdTable, "buildCmdTable");  // 命令表（说明文字按当前语言重画）
    safe(agRenderTree, "agRenderTree");    // 工作区/会话树里的固定文案
    safe(agRenderInfo, "agRenderInfo");    // Agent 信息面板
    safe(agRefreshBreakdown, "agRefreshBreakdown");
    for (const fn of langHooks) safe(fn, "hook");
  } finally {
    window.__langBusy = false;
  }
  langWalk();                        // 刚重画出来的那些控件再扫一遍
  window.__langReady = true;
}

// ---------------- 自绘标题栏：菜单栏 + 窗口按钮 ----------------
const TB_PAGES = [["link", "传输"], ["cmds", "命令表"], ["upgrade", "固件升级"], ["flash", "烧录"],
  ["agent", "Agent"],
  ["files", "文件管理"], ["chart", "实时图表"], ["seq", "中控编排"], ["scope", "示波器"],
  ["capture", "屏幕捕获"], ["logic", "逻辑分析仪"],
  ["batch", "批量文本"], ["calc", "计算器"]];
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
function tbCopyRx() {
  const t = $("rx").textContent || "";
  navigator.clipboard.writeText(t).then(() => toast(`已复制 ${t.length} 字符`)).catch(() => toast("复制失败"));
}
function tbSyncTheme() {
  const cur = document.documentElement.dataset.theme || "dark";
  $("tb-theme-btn").textContent = cur === "light" ? "☀" : cur === "auto" ? "◐" : "☾";
  $("tb-theme-btn").title = `${en("主题：")}${en(TB_THEME_NAME[cur] || cur)}${en("（点一下切换）")}`;
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
      { t: "快捷键", run: () => { pushSys("[帮助] Enter 发送 / Shift+Enter 换行 · Ctrl+L 清屏 · 中控里 Delete 删选中节点或连线 · 画布滚轮缩放 · 标题栏双击最大化"); toast("快捷键已写到输出区"); } },
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
  $("tb-theme-btn").onclick = () => {
    const cur = document.documentElement.dataset.theme || "dark";
    tbSetTheme(cur === "dark" ? "light" : cur === "light" ? "auto" : "dark");
  };
  $("tb-lang").onclick = () => {
    applyLang(LANG === "zh" ? "en" : "zh");
    tbCloseMenus();
    toast(LANG === "en" ? "Language: English" : "语言：中文");
  };
  tbSyncTheme();
  // 菜单栏
  const wrap = $("tb-menu");
  let openIdx = -1;
  const menu = tbMenuDefs();
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
      for (const it of sec.items) {
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
      root.appendChild(pop);
      openIdx = idx;
    };
    btn.onclick = (e) => { e.stopPropagation(); if (btn.classList.contains("active")) { tbCloseMenus(); openIdx = -1; } else open(); };
    btn.onmouseenter = () => { if (openIdx >= 0 && openIdx !== idx) open(); };
    root.appendChild(btn);
    wrap.appendChild(root);
  });
  $("tb-lang").onclick = () => { applyLang(LANG === "zh" ? "en" : "zh"); tbCloseMenus(); toast(LANG === "en" ? "Language: English" : "语言：中文"); };
  document.addEventListener("click", () => { tbCloseMenus(); openIdx = -1; });
}

async function main() {
  migrateLocalPrefs();          // 老版本的 h7test_* 设置搬成 kdock_*（只搬一次）
  // 启动画面这会儿**早就顶上去了**（tauri.conf.json 里声明、后端 setup 里显示，比这里早得多）；
  // 这一下只是兜底：窗口还在就把它再顶到最前，启动阶段已经收尾则什么都不做。
  invoke("splash_show").catch(() => {});
  initControls();
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
  bindCapture();
  bindSettings();
  bindCache();
  bindAgent();
  bindAgentEvents();
  bindScope();
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
    })
  );
  document.querySelectorAll('input[name="tx-mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      $("tx").placeholder = txMode() === "hex" ? "HEX 模式：41 54 0D 0A" : "文本模式直接输入";
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
    capLatest = ev.payload;                      // 只留最新的一帧
    if (!capApplying && capImg) { capApplying = true; capApplyLatest(); }
  });
  await listen("capture://error", (ev) => {
    const p = ev.payload || {};
    const sid = Number(p.session) || 0;
    if (sid && sid !== capSession) return;        // 旧会话的错误，忽略
    capRunning = false;
    capState("出错: " + (p.msg != null ? p.msg : p), "err");
    pushSys(`[捕获] ${p.msg != null ? p.msg : p}`);
  });
  await listen("capture://stopped", (ev) => {
    const p = ev.payload || {};
    const sid = Number(p.session) || 0;
    if (sid && sid !== capSession) return;        // 旧会话线程退出的收尾事件，别动新会话的状态
    capRunning = false;
    capState("已停止");
  });
  await listen("flash://log", (ev) => {
    const s = String(ev.payload || "");
    pushSys(s.replace(/[\r\n]+$/, ""));
    if (!$("fl-log").closest("[hidden]")) flashLog(s);
  });
  await listen("flash://done", (ev) => {
    // 常见坑：openocd(libusb 版) 认不到用 SEGGER 驱动的 J-Link —— 给一句可操作的提示
    const lw = $("fl-log").textContent;
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
    $("status-chip").textContent = `重连中 ${ev.payload}/20`;
    $("status-chip").className = "chip";
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
