// ── 逻辑分析仪：波形查看 + 协议解码 + 导入导出 ──────────────────────────────
// 参考 DSView / PulseView 的用法：左边通道列（名字 / 颜色 / 显示开关 / 当前电平），
// 右边波形区（滚轮缩放、拖动平移、点一下放光标 A、Shift+点放 B、双击适应窗口），
// 底下按解码器各占一行，把解出来的字节/字段贴着波形画出来。
//
// 解码器在 logic-decoders.js（19 种，纯计算，Node 里能直接跑测试）；
// 示例信号在 logic-demo.js（三个场景，按协议规范手工拼的波形）。
// 真机采集（fx2lafw / DSLogic 这类 USB 逻辑分析仪）还没接驱动 —— 数据来源是
// 示例 / VCD / CSV / 原始二进制；接驱动时只要把采样换一下，其余链路不用动。
//
// agent 那边能：读状态、读解码结果、**改配置**（采样率 / 解码器 / 通道显隐 / 视图 / 光标）、
// 触发采集、存文件；**采集到的数据本身 agent 改不了**（只能重新采集或让用户导入）。

import { open as dlgOpen } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  DECODERS, DEC_CATS, CLS_COLOR, mkCtx, decList, decDefaults, normalizeDec, decBrief, decodeItems, fmtItems,
} from "./logic-decoders.js";
import { scenarioList, buildScenario } from "./logic-demo.js";

const $id = (id) => document.getElementById(id);
const T = (s) => (window.kdockT ? window.kdockT(s) : s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 全局状态：数据 + 视图 + 光标 + 解码器 */
const LA = {
  rate: 1e6,              // 采样率（Hz）
  chans: [],              // [{ name, color, bits: Uint8Array, on: true }]
  n: 0,                   // 采样点数
  src: "",                // 当前来源说明
  view: { t0: 0, span: 0 },   // 视图窗口（秒）
  cur: { a: null, b: null },  // 光标（秒）
  marks: [],                  // 额外标记 [{ name, t, color }]，A/B 仍是主光标
  activeMark: -1,
  rowScale: 1,                // 纵向倍率：波形太密时放大行高
  hover: null,                // 鼠标位置（秒）
  hoverDec: null,             // 鼠标下的解码项
  decHits: [],                // 解码项命中区（随每次重绘更新）
  dec: [],                    // 解码器 [{ kind, opts... }]
  sel: 0,                     // 当前通道（测量用）
  drag: null,
};
const COLORS = ["#4ea1ff", "#ffd166", "#7ee787", "#ff8fa3", "#c792ea", "#7fd1e0", "#f5a97f", "#c9d1d9"];
const MARK_COLORS = ["#ff9f43", "#ff6b9d", "#5ad1ff", "#b18cff", "#ffd166", "#4fd1a1"];

/* ============================ 数据 ============================ */

function setChans(list, rate, src) {
  LA.chans = list;
  LA.rate = rate;
  LA.n = list.length ? list[0].bits.length : 0;
  LA.src = src;
  LA.ctx = mkCtx(rate, list);
  LA.cur = { a: null, b: null };
  LA.marks = [];
  LA.activeMark = -1;
  LA.hover = null;
  LA.renderKey = "";
  autoView();
  renderAll();
}

const at = (ch, i) => (i >= 0 && i < LA.n ? (ch.bits[i] ? 1 : 0) : 0);
/** 时间（秒）→ 采样下标 */
const t2i = (t) => Math.round(t * LA.rate);

/** 适应窗口：整段数据铺满 */
function fitView() {
  LA.view.span = LA.n > 1 ? (LA.n - 1) / LA.rate : 1e-3;
  LA.view.t0 = 0;
}

/** 打开数据时的第一屏：最多铺 20k 个采样点，先让人看清边沿；
 *  想看整段再用「适应窗口」。整段直接铺满时每像素上百次跳变，再高的分辨率
 *  也只能显示成一条实心带。 */
function autoView() {
  const total = LA.n > 1 ? (LA.n - 1) / LA.rate : 1e-3;
  const readable = 20000 / Math.max(1, LA.rate);
  LA.view.span = Math.min(total, Math.max(1e-3, readable));
  LA.view.t0 = 0;
}

/* ---------- 示例信号：三个场景，见 logic-demo.js ---------- */
function loadScenario(id) {
  const r = buildScenario(id);
  if (!r) return;
  LA.dec = r.decoders.map((d) => (normalizeDec(d, r.chans.length).dec || d));
  setChans(r.chans, r.rate, T(r.note));
  LA.scenario = id;
  msg(T("已载入示例：") + T(r.note));
}

/* ============================ 导入 ============================ */

/** VCD：$timescale / $var / #time / 0! 1" bx ... 只认单比特标量 */
function parseVcd(text) {
  const lines = text.split(/\r?\n/);
  let scale = 1e-9, pend = null;
  const times = [], vals = [];                       // times[i] 秒；vals[i] = {id:0/1}
  const byId = new Map();
  const ids = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("$timescale")) {
      const m = l.match(/(\d+)\s*([fpnum]?s)/);
      if (m) scale = Number(m[1]) * ({ s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 }[m[2]] || 1e-9);
      continue;
    }
    if (l.startsWith("$var")) {
      const m = l.match(/\$var\s+\S+\s+\d+\s+(\S+)\s+([^\s$]+)/);
      if (m && !byId.has(m[1])) { byId.set(m[1], ids.length); ids.push({ id: m[1], name: m[2] }); }
      continue;
    }
    if (l[0] === "#") { const t = Number(l.slice(1)); if (Number.isFinite(t)) { pend = t * scale; times.push(pend); vals.push({}); } continue; }
    const m = l.match(/^([01xz])(\S+)$/);
    if (m && pend != null) { const k = byId.get(m[2]); if (k != null) vals[vals.length - 1][k] = m[1] === "1" ? 1 : 0; }
  }
  if (!times.length || !ids.length) throw new Error(T("VCD 里没找到信号（只支持单比特标量）"));
  // VCD 是"变化点"记录：展开成等间隔采样
  const tEnd = times[times.length - 1];
  const step = Math.max(scale, tEnd / 200000);
  const n = Math.max(2, Math.min(400000, Math.round(tEnd / step) + 1));
  const chans = ids.map((x, k) => ({ name: x.name, color: COLORS[k % COLORS.length], bits: new Uint8Array(n), on: true }));
  let gi = 0;
  const cur = ids.map(() => 0);
  for (let i = 0; i < n; i++) {
    const t = i * step;
    while (gi < times.length && times[gi] <= t + 1e-15) { for (const [k, v] of Object.entries(vals[gi])) cur[k] = v; gi++; }
    chans.forEach((c, k) => { c.bits[i] = cur[k] ? 1 : 0; });
  }
  setChans(chans, 1 / step, T("导入 VCD") + "：" + T("{n} 个信号 / {m} 点").replace("{n}", chans.length).replace("{m}", n));
}

/** CSV：每行一个采样（首行可以是表头 time,ch0,... 或 ch0,ch1,...） */
function parseCsv(text) {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!rows.length) throw new Error(T("CSV 是空的"));
  const head = rows[0].split(/[,;\t]/).map((x) => x.trim());
  const headIsHeader = !head.every((x) => /^[01]$/.test(x));
  const hasTime = headIsHeader && /^(time|t|时间|时间戳|timestamp)$/i.test(head[0]);
  const body = headIsHeader ? rows.slice(1) : rows;
  const n = body.length;
  if (!n) throw new Error(T("CSV 里没有采样"));
  const ncol = body[0].split(/[,;\t]/).length;
  const nch = Math.max(1, Math.min(16, hasTime ? ncol - 1 : ncol));
  const chans = Array.from({ length: nch }, (_, k) => ({
    name: headIsHeader && head[k + (hasTime ? 1 : 0)] ? head[k + (hasTime ? 1 : 0)] : "CH" + k,
    color: COLORS[k % COLORS.length], bits: new Uint8Array(n), on: true,
  }));
  let rate = 1e6;
  const first = body[0].split(/[,;\t]/);
  const second = body[1] ? body[1].split(/[,;\t]/) : null;
  if (hasTime && second) { const dt = Number(second[0]) - Number(first[0]); if (dt > 0) rate = 1 / dt; }
  body.forEach((line, i) => {
    const p2 = line.split(/[,;\t]/);
    const off = hasTime ? 1 : 0;
    chans.forEach((c, k) => { c.bits[i] = Number(p2[k + off]) ? 1 : 0; });
  });
  setChans(chans, rate, T("导入 CSV") + "：" + T("{n} 个信号 / {m} 点").replace("{n}", chans.length).replace("{m}", n));
}
/** 原始二进制：一个字节 = 8 个通道的状态（bit0 = CH0），采样率用户给 */
function parseBin(bytes, rate) {
  const n = bytes.length;
  const chans = Array.from({ length: 8 }, (_, k) => ({ name: "CH" + k, color: COLORS[k], bits: new Uint8Array(n), on: true }));
  for (let i = 0; i < n; i++) { const b = bytes[i]; for (let k = 0; k < 8; k++) chans[k].bits[i] = (b >> k) & 1; }
  setChans(chans, rate, T("导入二进制") + "：" + T("{m} 点").replace("{m}", n));
}

/** 导入 VCD / CSV（给了 path 就不弹框，便于脚本化测试） */
async function importFile(path0) {
  try {
    let path = path0;
    if (!path) {
      const p = await dlgOpen({
      title: T("导入逻辑分析仪数据（VCD / CSV）"), multiple: false, directory: false,
      filters: [{ name: T("捕获文件"), extensions: ["vcd", "csv", "txt", "bin"] }, { name: T("所有文件"), extensions: ["*"] }],
    });
      path = typeof p === "string" ? p : (p && p.path);
    }
    if (!path) return;
    const name = String(path).split(/[\\/]/).pop();
    if (/\.bin$/i.test(name)) return importBin(path);
    const text = await invoke("file_read_text", { path });
    const body = text.text;
    if (/^\s*\$timescale|\$enddefinitions/m.test(body)) parseVcd(body);
    else parseCsv(body);
    msg(T("已导入 ") + name);
  } catch (e) { msg(String(e && e.message ? e.message : e), true); }
}

async function importBin(path0) {
  try {
    let path = path0;
    if (!path) {
      const p = await dlgOpen({ title: T("导入原始二进制（一个字节 = 8 个通道）"), multiple: false, directory: false,
        filters: [{ name: T("二进制"), extensions: ["bin", "dat", "raw"] }, { name: T("所有文件"), extensions: ["*"] }] });
      path = typeof p === "string" ? p : (p && p.path);
      if (!path) return;
    }
    const r = await invoke("file_read_bytes", { path });
    const arr = typeof r === "string" ? Uint8Array.from(atob(r), (c) => c.charCodeAt(0)) : Uint8Array.from(r.bytes || r);
    parseBin(arr, Number($id("la-rate").value) || 1e6);
  } catch (e) { msg(String(e && e.message ? e.message : e), true); }
}

/* ============================ 解码器 ============================ */

/** 当前数据 + 一个解码器配置 → 解出来的项（走 logic-decoders.js 的注册表） */
function decodeOf(d) {
  if (!LA.ctx) LA.ctx = mkCtx(LA.rate, LA.chans);
  return decodeItems(LA.ctx, d);
}

/** 测量：选中通道的频率 / 占空比 / 脉冲数（只看当前视图窗口） */
function measure(chIdx, i0, i1) {
  const ch = LA.chans[chIdx];
  if (!ch || i1 <= i0) return null;
  let rising = 0, high = 0, firstRise = -1, lastRise = -1;
  let minHi = Infinity, maxHi = 0, minLo = Infinity, maxLo = 0;
  let prev = at(ch, i0), runStart = i0;
  for (let i = i0; i <= i1; i++) {
    const v = at(ch, i);
    if (v) high++;
    if (i > i0 && v !== prev) {                     // 一次翻转：结算上一段
      const w = i - runStart;
      if (prev === 1) { if (w < minHi) minHi = w; if (w > maxHi) maxHi = w; }
      else { if (w < minLo) minLo = w; if (w > maxLo) maxLo = w; }
      if (prev === 0 && v === 1) { rising++; if (firstRise < 0) firstRise = i; lastRise = i; }
      runStart = i; prev = v;
    }
  }
  const span = (i1 - i0) / LA.rate;
  const freq = rising > 1 && lastRise > firstRise ? (rising - 1) / ((lastRise - firstRise) / LA.rate) : 0;
  return {
    freq, duty: high / Math.max(1, i1 - i0 + 1), pulses: rising, span,
    minHi: minHi === Infinity ? 0 : minHi / LA.rate, maxHi: maxHi / LA.rate,
    minLo: minLo === Infinity ? 0 : minLo / LA.rate, maxLo: maxLo / LA.rate,
  };
}
/* ============================ 绘制 ============================ */

/** 行数按"**全部**通道"算：隐藏的通道也占一行（左边灰掉、波形不画）。
 *  这样左边那个小眼睛能再点回来（以前一隐藏就从列表里消失，回不去了），
 *  而且左边通道列永远和右边波形行的行高对得上。
 *  返回值里 on/vis 都是"当前显示的那些"，测量/读数用它。 */
function rowsOut() {
  const vis = LA.chans.filter((c) => c.on);
  const dec = LA.dec.filter((d) => d.on !== false);
  return { vis, on: vis, dec, rows: LA.chans.length + dec.length };
}

/** 时间轴的"好看刻度"：1/2/5 × 10^k */
function niceStep(span, want) {
  const raw = span / Math.max(1, want);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
/** 去掉小数末尾多余的 0（只动小数点后面，别把 "1000" 变成 "1"） */
function trim0(s) {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
function fmtT(t, span) {
  const a = Math.abs(t);
  // 单位按"整屏跨度"选，保证同一屏里的刻度用同一个单位；但门槛取 1（1 ms 就是 "1 ms"，不是 "1000 µs"）
  const u = span >= 1 ? ["s", 1] : span >= 1e-3 ? ["ms", 1e3] : span >= 1e-6 ? ["µs", 1e6] : ["ns", 1e9];
  const v = a * u[1];
  return trim0(v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(3)) + " " + u[0];
}

function renderAll() { renderWave(); renderLabels(); renderReadout(); renderDecList(); }

function cv() { return $id("la-canvas"); }

function svgEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 波形与左侧通道列共用这一套行高，避免两边错位。 */
function laGeom(H) {
  const rows = Math.max(1, rowsOut().rows);
  const AXIS = 28, PAD = 8;
  const minRow = 20 * LA.rowScale, maxRow = 36 * LA.rowScale;
  const rowH = Math.max(minRow, Math.min(maxRow, (H - AXIS - PAD) / rows));
  return { AXIS, PAD, rows, rowH };
}
function renderWave() {
  const c = cv();
  const wrap = $id("la-wrap");
  const base = $id("la-wave-svg");
  const overlay = $id("la-overlay-svg");
  if (!c || !wrap || !base || !overlay) return;
  // 行多了（10 路 + 一堆解码器）就别硬挤：给画布一个下限，让整页滚，也不要把下面的解码行裁掉
  const rowsWant = LA.chans.length + LA.dec.filter((d) => d.on !== false).length;
  const minH = Math.max(260, rowsWant * 25 * LA.rowScale + 48);
  if (wrap.style.minHeight !== minH + "px") wrap.style.minHeight = minH + "px";
  const box = c.getBoundingClientRect();
  if (box.width < 4 || box.height < 4) return;          // 还没布局好（隐藏中）就别画，否则画布被压成 0×0
  // 画布现在只负责接收鼠标/键盘事件；真正的波形由 SVG 按最终设备像素绘制。
  if (c.width !== 1 || c.height !== 1) { c.width = 1; c.height = 1; }
  const W = box.width, H = box.height;
  const css = getComputedStyle(document.documentElement);
  const fg = `hsl(${css.getPropertyValue("--foreground") || "210 20% 92%"})`;
  const muted = `hsl(${css.getPropertyValue("--muted-foreground") || "215 15% 65%"} / .9)`;
  const line = `hsl(${css.getPropertyValue("--surface-line") || "220 15% 28%"})`;
  const { AXIS, rowH } = laGeom(H);
  const { dec } = rowsOut();
  const x2t = (x) => LA.view.t0 + (x / W) * LA.view.span;
  const t2x = (t) => (t - LA.view.t0) / LA.view.span * W;

  const key = [
    W.toFixed(3), H.toFixed(3), LA.view.t0, LA.view.span, LA.n, LA.rate, LA.rowScale,
    LA.chans.map((ch) => `${ch.name}:${ch.color}:${ch.on ? 1 : 0}`).join("|"),
    JSON.stringify(LA.dec),
  ].join("~");
  if (LA.renderKey !== key) {
    const out = [];
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${line}" fill-opacity="0.025"/>`);
    // 行底色 + 分隔线
    const allRows = LA.chans.length + dec.length;
    for (let r = 0; r < allRows; r++) {
      const y = AXIS + r * rowH;
      if (r % 2) out.push(`<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${line}" fill-opacity="0.10"/>`);
      out.push(`<line x1="0" y1="${y + rowH}" x2="${W}" y2="${y + rowH}" stroke="${line}" stroke-opacity="0.42" shape-rendering="crispEdges"/>`);
    }
    // 时间轴
    const step = niceStep(LA.view.span, Math.max(2, Math.round(W / 110)));
    const first = Math.ceil(LA.view.t0 / step) * step;
    for (let t = first; t <= LA.view.t0 + LA.view.span; t += step) {
      const x = Math.round(t2x(t)) + 0.5;
      out.push(`<line x1="${x}" y1="${AXIS}" x2="${x}" y2="${H}" stroke="${line}" stroke-opacity="0.50" shape-rendering="crispEdges"/>`);
      out.push(`<text class="la-timelabel" x="${Math.max(2, Math.min(W - 60, x + 4))}" y="${AXIS / 2 + 1}" fill="${muted}" font-size="11.5" dominant-baseline="middle">${svgEsc(fmtT(t, LA.view.span))}</text>`);
    }
    out.push(`<line x1="0" y1="${AXIS}" x2="${W}" y2="${AXIS}" stroke="${line}" stroke-opacity="0.8" shape-rendering="crispEdges"/>`);

    // 波形：确定电平走实线，一列内多次跳变只画半透明活动带。
    const x0i = Math.max(0, Math.floor(LA.view.t0 * LA.rate));
    const x1i = Math.min(LA.n - 1, Math.ceil((LA.view.t0 + LA.view.span) * LA.rate));
    LA.chans.forEach((ch, r) => {
      if (!ch.on) return;
      const top = AXIS + r * rowH, h = Math.max(8, rowH - 7);
      const yHi = Math.round(top + 4), yLo = Math.round(top + h);
      let ds = "", db = "", prevY = null;
      for (let px = 0; px < W; px++) {
        const i0 = Math.max(x0i, Math.floor(x2t(px) * LA.rate));
        const i1p = Math.min(x1i, Math.floor(x2t(px + 1) * LA.rate));
        let lo = null, hi = null;
        for (let i = i0; i <= i1p; i++) { const v = at(ch, i); if (lo === null || v < lo) lo = v; if (hi === null || v > hi) hi = v; }
        if (lo === null) { prevY = null; continue; }
        const x = px + 0.5;
        if (lo === hi) {
          const y = lo ? yHi : yLo;
          if (prevY != null && prevY !== y) ds += `M${x} ${prevY}V${y}`;
          ds += `M${x} ${y}H${x + 1}`;
          prevY = y;
        } else {
          db += `M${x} ${yHi}V${yLo}`;
          prevY = null;
        }
      }
      if (ds) out.push(`<path d="${ds}" fill="none" stroke="${ch.color}" stroke-width="1.15" stroke-linecap="butt" shape-rendering="crispEdges"/>`);
      if (db) out.push(`<path d="${db}" fill="none" stroke="${ch.color}" stroke-opacity="0.30" stroke-width="1" stroke-linecap="butt" shape-rendering="crispEdges"/>`);
    });

    // 解码器行
    LA.decHits = [];
    dec.forEach((d, k) => {
      const top = AXIS + (LA.chans.length + k) * rowH, h = Math.max(9, rowH - 7);
      let lastLabelRight = -Infinity;
      for (const it of decodeOf(d)) {
        const xa = t2x(it.i0 / LA.rate), xb = t2x(it.i1 / LA.rate);
        if (xb < -20 || xa > W + 20) continue;
        const w = Math.max(9, xb - xa);
        const col = CLS_COLOR[it.cls] || "#4ea1ff";
        const label = String(it.text);
        const need = Math.max(22, label.length * 6.1 + 8);
        out.push(`<g><rect x="${Math.round(xa) + 0.5}" y="${Math.round(top + 4) + 0.5}" width="${Math.round(w)}" height="${h}" rx="2" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-width="1" shape-rendering="crispEdges"/><title>${svgEsc(label)}</title></g>`);
        let tx = null;
        if (w >= need + 6) tx = Math.round(xa) + 4;
        else if (w >= 10 && xa >= lastLabelRight + 6) tx = Math.round(xa + w) + 4;
        else if (xa >= lastLabelRight + need + 8) tx = Math.round(xa) + 4;
        if (tx != null && tx < W - 6) {
          out.push(`<text class="la-declabel" x="${tx}" y="${top + h / 2 + 3}" fill="${fg}" stroke="var(--surface-0)" stroke-width="2.5" paint-order="stroke" font-size="10.5" dominant-baseline="middle">${svgEsc(label)}</text>`);
          lastLabelRight = tx + need;
        }
        LA.decHits.push({ x0: xa, x1: xa + w, y0: top + 4, y1: top + 4 + h, it, kind: d.kind, col });
      }
    });
    base.setAttribute("viewBox", `0 0 ${W} ${H}`);
    base.setAttribute("width", String(W));
    base.setAttribute("height", String(H));
    base.innerHTML = out.join("");
    LA.renderKey = key;
  }
  renderOverlay(overlay, W, H, AXIS, rowH, t2x, fg, muted);
}

function renderOverlay(svg, W, H, AXIS, rowH, t2x, fg, muted) {
  const out = [];
  if (LA.hoverDec) {
    const h = LA.hoverDec;
    out.push(`<rect x="${Math.round(h.x0) + 0.5}" y="${Math.round(h.y0) + 0.5}" width="${Math.round(h.x1 - h.x0)}" height="${Math.round(h.y1 - h.y0)}" rx="2" fill="${h.col}" fill-opacity="0.18" stroke="${h.col}" stroke-width="1.5" shape-rendering="crispEdges"/>`);
  }
  const drawCur = (t, color, dash, name, alpha) => {
    if (t == null) return;
    const x = Math.round(t2x(t)) + 0.5;
    if (x < -10 || x > W + 10) return;
    out.push(`<line x1="${x}" y1="${AXIS - 4}" x2="${x}" y2="${H}" stroke="${color}" stroke-opacity="${alpha == null ? 1 : alpha}" stroke-width="1.2" ${dash ? 'stroke-dasharray="5 4"' : ""} shape-rendering="crispEdges"/>`);
    if (name) out.push(`<text x="${Math.max(2, Math.min(W - 24, x + 4))}" y="9" fill="${color}" font-size="10.5" font-weight="600" dominant-baseline="middle">${svgEsc(name)}</text>`);
  };
  drawCur(LA.cur.a, "#ffd166", false, "A", 1);
  drawCur(LA.cur.b, "#7ee787", true, "B", 1);
  LA.marks.forEach((m, i) => drawCur(m.t, m.color, false, String(i + 1), 1));
  if (LA.hover != null) drawCur(LA.hover, muted, true, "", 0.55);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.innerHTML = out.join("");
}

function renderLabels() {
  const box = $id("la-labels");
  if (!box) return;
  const { on } = rowsOut();
  const c = cv();
  const H = c ? c.getBoundingClientRect().height : 300;
  const { AXIS, rowH } = laGeom(H);
  box.textContent = "";
  const pad = el("div", "lalabel-h"); pad.style.height = AXIS + "px"; pad.textContent = T("通道");
  box.appendChild(pad);
  LA.chans.forEach((ch, i) => {
    const r = el("div", "lalabel" + (i === LA.sel ? " sel" : "") + (ch.on ? "" : " off"));
    r.style.height = rowH + "px";
    const eye = el("button", "laeye", ch.on ? "◉" : "○");
    eye.title = T("显示 / 隐藏这一路");
    eye.onclick = (e) => { e.stopPropagation(); ch.on = !ch.on; renderAll(); };
    const dot = el("span", "ladot");
    dot.style.background = ch.color;
    const val = LA.hover != null ? String(at(ch, t2i(LA.hover))) : "";
    r.append(eye, dot, el("span", "laname", ch.name), el("span", "laval", val));
    r.onclick = () => { LA.sel = i; renderAll(); };
    box.appendChild(r);
  });
  if (LA.chans.some((c2) => !c2.on)) {
    const b = el("button", "btn tiny", T("显示全部通道"));
    b.style.margin = "4px 0";
    b.onclick = () => { LA.chans.forEach((c2) => { c2.on = true; }); renderAll(); };
    box.appendChild(b);
  }
  LA.dec.forEach((d, i) => {
    const r = el("div", "lalabel ladec");
    r.style.height = rowH + "px";
    const del = el("button", "laeye", "✕"); del.title = T("删掉这个解码器");
    del.onclick = () => { LA.dec.splice(i, 1); renderAll(); };
    const spec = DECODERS[d.kind];
    r.append(del, el("span", "laname", spec ? T(spec.name) : String(d.kind)));
    box.appendChild(r);
  });
}

/** 解码器参数列表（右栏）：参数怎么排完全由 logic-decoders.js 里那份 params 决定 ——
 *  加一个新协议不用动这里，加个 t='ch'/'num'/'enum' 的条目就行。 */
function renderDecList() {
  const box = $id("la-dec-list");
  if (!box) return;
  box.textContent = "";
  if (!LA.dec.length) { box.appendChild(el("p", "hint", T("还没加解码器：上面选个协议点「＋」"))); return; }
  const chSel = (val, optional, onChange) => {
    const sel = document.createElement("select");
    sel.className = "tight";
    if (optional) {
      const o0 = document.createElement("option");
      o0.value = "-1"; o0.textContent = T("（无）");
      if (val == null || val < 0) o0.selected = true;
      sel.appendChild(o0);
    }
    LA.chans.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = String(i); o.textContent = c.name;
      if (i === val) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => { onChange(Number(sel.value)); renderAll(); };
    return sel;
  };
  LA.dec.forEach((d, i) => {
    const spec = DECODERS[d.kind];
    const row = el("div", "ladecrow");
    row.appendChild(el("span", "laname", spec ? T(spec.name) : String(d.kind)));
    if (spec) {
      for (const p of spec.params) {
        row.appendChild(el("span", "lb", T(p.l)));
        if (p.t === "ch" || p.t === "ch0") {
          row.appendChild(chSel(d[p.k], p.t === "ch0", (v) => { d[p.k] = v; }));
        } else if (p.t === "num") {
          const inp = document.createElement("input");
          inp.type = "number"; inp.className = "num"; inp.value = String(d[p.k]);
          if (p.step) inp.step = String(p.step);
          inp.onchange = () => {
            let v = Number(inp.value);
            if (!isFinite(v)) v = p.d != null ? p.d : 0;
            if (p.min != null && v < p.min) v = p.min;
            if (p.max != null && v > p.max) v = p.max;
            d[p.k] = v;
            renderAll();
          };
          row.appendChild(inp);
        } else if (p.t === "enum") {
          const sel = document.createElement("select");
          sel.className = "tight";
          for (const v of p.vals || []) {
            const o = document.createElement("option");
            o.value = String(v); o.textContent = T(String(v));      // 存的是原值，显示的是译文
            if (String(d[p.k]) === String(v)) o.selected = true;
            sel.appendChild(o);
          }
          sel.onchange = () => {
            const raw = sel.value;
            const want = (p.vals || []).find((v) => String(v) === raw);
            d[p.k] = want != null ? want : raw;
            renderAll();
          };
          row.appendChild(sel);
        }
      }
    }
    row.appendChild(el("span", "grow"));
    const del = el("button", "btn tiny", "✕");
    del.title = T("删掉这个解码器");
    del.onclick = () => { LA.dec.splice(i, 1); renderAll(); };
    row.appendChild(del);
    box.appendChild(row);
  });
  renderDecResults();
}

/** 右栏完整解码结果：波形上放不下的文字仍能逐条读，点一条把 A/B 放到它的起止位置。 */
function renderDecResults() {
  const box = $id("la-dec-results");
  if (!box) return;
  box.textContent = "";
  const t0 = LA.view.t0, t1 = LA.view.t0 + LA.view.span;
  let total = 0, shown = 0;
  for (const d of LA.dec) {
    if (d.on === false) continue;
    const spec = DECODERS[d.kind];
    const name = spec ? T(spec.name) : String(d.kind);
    const items = decodeOf(d).filter((it) => it.i1 / LA.rate >= t0 && it.i0 / LA.rate <= t1);
    total += items.length;
    for (const it of items) {
      if (shown >= 300) continue;
      const b = el("button", "ladecresult");
      b.append(
        el("span", "dc-kind", name),
        el("span", "dc-val", String(it.text)),
        el("span", "dc-t", fmtT(it.i0 / LA.rate, LA.view.span)),
      );
      b.title = `${name}: ${it.text}`;
      b.onclick = () => {
        LA.cur.a = it.i0 / LA.rate;
        LA.cur.b = it.i1 / LA.rate;
        renderAll();
      };
      box.appendChild(b);
      shown += 1;
    }
  }
  if (!shown) box.appendChild(el("p", "hint", T("当前窗口没有解码结果")));
  if ($id("la-dec-count")) $id("la-dec-count").textContent = total > shown ? `${shown} / ${total}` : String(total);
}

/** 工具行/参数区的读数 */
function renderReadout() {
  const { on } = rowsOut();
  const set = (id, v) => { const e = $id(id); if (e) e.textContent = v; };
  const rEl = $id("la-rate");
  if (rEl && document.activeElement !== rEl) rEl.value = String(Math.round(LA.rate));
  set("la-info", T("{n} 路 / {m} 点 / {t}").replace("{n}", LA.chans.length).replace("{m}", LA.n).replace("{t}", fmtT(LA.n / LA.rate, LA.n / LA.rate)));
  set("la-src", LA.src);
  set("la-span", T("每屏 ") + fmtT(LA.view.span, LA.view.span));
  const t0 = LA.view.t0, t1 = LA.view.t0 + LA.view.span;
  set("la-zoomspan", T("窗口 {a} ~ {b}").replace("{a}", fmtT(t0, LA.view.span)).replace("{b}", fmtT(t1, LA.view.span)));
  set("la-a", LA.cur.a == null ? "—" : fmtT(LA.cur.a, LA.view.span));
  set("la-b", LA.cur.b == null ? "—" : fmtT(LA.cur.b, LA.view.span));
  set("la-hover", LA.hover == null ? "—" : fmtT(LA.hover, LA.view.span));
  if ($id("la-hoverv")) {
    const hv = LA.hover != null && LA.chans[LA.sel] ? String(at(LA.chans[LA.sel], t2i(LA.hover))) : "—";
    set("la-hoverv", hv);
  }
  const d = LA.cur.a != null && LA.cur.b != null ? Math.abs(LA.cur.b - LA.cur.a) : null;
  set("la-dt", d == null ? "—" : fmtT(d, d));
  set("la-freq", d ? (1 / d >= 1000 ? (1 / d / 1000).toFixed(3) + " kHz" : (1 / d).toFixed(1) + " Hz") : "—");
  // 选中通道的测量
  const i0 = Math.max(0, Math.floor(LA.view.t0 * LA.rate)), i1 = Math.min(LA.n - 1, Math.ceil((LA.view.t0 + LA.view.span) * LA.rate));
  const m = measure(LA.sel, i0, i1);
  set("la-msel", LA.chans[LA.sel] ? LA.chans[LA.sel].name : "—");
  set("la-mfreq", m && m.freq ? (m.freq >= 1000 ? (m.freq / 1000).toFixed(3) + " kHz" : m.freq.toFixed(1) + " Hz") : "—");
  set("la-mduty", m ? (m.duty * 100).toFixed(1) + "%" : "—");
  set("la-mpulse", m ? String(m.pulses) : "—");
  set("la-mw", m && m.pulses
    ? fmtT(m.minHi, m.minHi) + " ~ " + fmtT(m.maxHi, m.maxHi) + " / " + fmtT(m.minLo, m.minLo) + " ~ " + fmtT(m.maxLo, m.maxLo)
    : "—");
  renderMarks();
}

function addMark(t) {
  if (t == null || !isFinite(t)) return -1;
  const tt = Math.max(0, Math.min(LA.n / LA.rate, Number(t)));
  const idx = LA.marks.length;
  LA.marks.push({ t: tt, color: MARK_COLORS[idx % MARK_COLORS.length] });
  LA.activeMark = idx;
  return idx;
}

function markerAt(x, W) {
  let best = -1, dist = 6;
  LA.marks.forEach((m, i) => {
    const dx = Math.abs((m.t - LA.view.t0) / LA.view.span * W - x);
    if (dx < dist) { dist = dx; best = i; }
  });
  return best;
}

function cursorAt(x, W) {
  let best = "", dist = 6;
  for (const key of ["a", "b"]) {
    const t = LA.cur[key];
    if (t == null) continue;
    const dx = Math.abs((t - LA.view.t0) / LA.view.span * W - x);
    if (dx < dist) { dist = dx; best = key; }
  }
  return best;
}

function renderMarks() {
  const box = $id("la-marks");
  if (!box) return;
  box.textContent = "";
  LA.marks.forEach((m, i) => {
    const b = el("button", "lamark" + (i === LA.activeMark ? " active" : ""));
    b.style.setProperty("--lamark", m.color);
    b.title = T("点击设为 A；Shift+点击设为 B；拖动标记线可移动");
    b.append(el("span", "lamark-no", String(i + 1)), el("span", "lamark-t", fmtT(m.t, LA.view.span)));
    b.onclick = (e) => {
      LA.activeMark = i;
      if (e.shiftKey) LA.cur.b = m.t; else LA.cur.a = m.t;
      renderAll();
    };
    const x = el("span", "lamark-x", "×");
    x.title = T("删除这个标记");
    x.onclick = (e) => {
      e.stopPropagation();
      LA.marks.splice(i, 1);
      LA.activeMark = Math.min(LA.activeMark, LA.marks.length - 1);
      renderAll();
    };
    b.appendChild(x);
    box.appendChild(b);
  });
}

/* ============================ 交互 ============================ */

function bindInteract() {
  const c = cv();
  if (!c || c.__bound) return;
  c.__bound = true;
  const x2t = (x) => { const W = c.getBoundingClientRect().width; return LA.view.t0 + (x / W) * LA.view.span; };
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const W = c.getBoundingClientRect().width;
    if (e.shiftKey) { LA.view.t0 += (e.deltaY > 0 ? 1 : -1) * LA.view.span * 0.1; }
    else {
      const t = x2t(e.offsetX);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.min(LA.n / LA.rate, Math.max(1 / LA.rate * 4, LA.view.span * k));
      LA.view.t0 = t - (e.offsetX / W) * span;
      LA.view.span = span;
    }
    clampView(); renderWave(); renderReadout();
  }, { passive: false });
  c.addEventListener("pointerdown", (e) => {
    const W = c.getBoundingClientRect().width;
    const ck = cursorAt(e.offsetX, W);
    const mi = markerAt(e.offsetX, W);
    if (ck) {
      LA.drag = { kind: "cur", key: ck, x: e.offsetX, moved: false };
    } else if (mi >= 0) {
      LA.activeMark = mi;
      LA.drag = { kind: "mark", index: mi, x: e.offsetX, moved: false };
    } else {
      const hit = LA.decHits.find((h) => e.offsetX >= h.x0 && e.offsetX <= h.x1 && e.offsetY >= h.y0 && e.offsetY <= h.y1);
      LA.drag = hit
        ? { kind: "dec", hit, x: e.offsetX, moved: false }
        : { kind: "pan", x: e.offsetX, t0: LA.view.t0, moved: false };
    }
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener("pointermove", (e) => {
    LA.hover = x2t(e.offsetX);
    const hit = LA.decHits.find((h) => e.offsetX >= h.x0 && e.offsetX <= h.x1 && e.offsetY >= h.y0 && e.offsetY <= h.y1);
    LA.hoverDec = hit || null;
    const W = c.getBoundingClientRect().width;
    const onLine = !!cursorAt(e.offsetX, W) || markerAt(e.offsetX, W) >= 0;
    c.style.cursor = hit ? "pointer" : onLine ? "ew-resize" : "";
    if ($id("la-msg")) $id("la-msg").textContent = hit
      ? `${DECODERS[hit.kind] ? T(DECODERS[hit.kind].name) : hit.kind}: ${hit.it.text}`
      : (LA.msgText || "");
    if (LA.drag && LA.drag.kind === "cur") {
      if (Math.abs(e.offsetX - LA.drag.x) > 1) LA.drag.moved = true;
      LA.cur[LA.drag.key] = Math.max(0, Math.min(LA.n / LA.rate, x2t(e.offsetX)));
      renderWave(); renderReadout();
    } else if (LA.drag && LA.drag.kind === "mark") {
      if (Math.abs(e.offsetX - LA.drag.x) > 1) LA.drag.moved = true;
      LA.marks[LA.drag.index].t = Math.max(0, Math.min(LA.n / LA.rate, x2t(e.offsetX)));
      renderWave(); renderReadout();
    } else if (LA.drag && LA.drag.kind === "pan") {
      const dt = -((e.offsetX - LA.drag.x) / W) * LA.view.span;
      if (Math.abs(e.offsetX - LA.drag.x) > 2) LA.drag.moved = true;
      LA.view.t0 = LA.drag.t0 + dt;
      clampView(); renderWave();
    } else renderWave();
    renderLabels(); renderReadout();
  });
  c.addEventListener("pointerup", (e) => {
    if (LA.drag && LA.drag.kind === "cur") {
      renderAll();
    } else if (LA.drag && LA.drag.kind === "mark") {
      LA.activeMark = LA.drag.index;
      renderAll();
    } else if (LA.drag && LA.drag.kind === "dec" && !LA.drag.moved) {
      const it = LA.drag.hit.it;
      LA.cur.a = it.i0 / LA.rate;
      LA.cur.b = it.i1 / LA.rate;
      renderAll();
    } else if (LA.drag && LA.drag.kind === "pan" && !LA.drag.moved) {
      const t = x2t(e.offsetX);
      if (e.altKey) addMark(t);
      else if (e.shiftKey) LA.cur.b = t;
      else LA.cur.a = t;
      renderAll();
    }
    LA.drag = null;
  });
  c.addEventListener("pointerleave", () => {
    LA.hover = null; LA.hoverDec = null;
    if ($id("la-msg")) $id("la-msg").textContent = LA.msgText || "";
    renderAll();
  });
  c.addEventListener("dblclick", () => { fitView(); renderAll(); });
  // 键盘：← → 平移，+ - 缩放，Home 回起点
  c.tabIndex = 0;
  c.addEventListener("keydown", (e) => {
    const W = c.getBoundingClientRect().width;
    const pan = (dir) => { LA.view.t0 += dir * LA.view.span * 0.2; clampView(); renderWave(); renderReadout(); };
    if (e.key === "ArrowLeft") pan(-1);
    else if (e.key === "ArrowRight") pan(1);
    else if (e.key === "+" || e.key === "=") { zoomAt(W / 2, 0.8); }
    else if (e.key === "-") { zoomAt(W / 2, 1.25); }
    else if (e.key === "Home") { LA.view.t0 = 0; renderWave(); renderReadout(); }
    else if (e.key === "m" || e.key === "M") { addMark(LA.hover != null ? LA.hover : LA.view.t0 + LA.view.span / 2); renderAll(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && LA.activeMark >= 0 && LA.marks[LA.activeMark]) {
      LA.marks.splice(LA.activeMark, 1); LA.activeMark = -1; renderAll();
    }
    else return;
    e.preventDefault();
  });
}

function zoomAt(x, k) {
  const c = cv(); const W = c.getBoundingClientRect().width;
  const t = LA.view.t0 + (x / W) * LA.view.span;
  const span = Math.min(LA.n / LA.rate, Math.max(1 / LA.rate * 4, LA.view.span * k));
  LA.view.t0 = t - (x / W) * span;
  LA.view.span = span;
  clampView(); renderAll();
}
function clampView() {
  const total = LA.n / LA.rate;
  LA.view.span = Math.max(1 / LA.rate * 4, Math.min(total, LA.view.span));
  LA.view.t0 = Math.max(0, Math.min(Math.max(0, total - LA.view.span), LA.view.t0));
}

function msg(text, bad) {
  const e = $id("la-msg");
  if (!e) return;
  LA.msgText = text || "";
  e.textContent = LA.msgText;
  e.style.color = bad ? "hsl(var(--destructive))" : "";
}

/* ============================ 初始化 ============================ */

/* ============================ agent 接口 ============================ */
// agent 那边能：读状态、读解码结果、看支持哪些协议（la_decoders）、**改配置**
// （解码器 / 采样率 / 视图 / 光标 / 通道显隐）、触发采集（示例场景）、把数据存成文件。
// 数据本身（samples）agent 改不了 —— 只能通过"重新采集 / 导入"来换。

const fmtHz = (f) => (f >= 1e6 ? (f / 1e6).toFixed(3) + " MHz" : f >= 1e3 ? (f / 1e3).toFixed(3) + " kHz" : f.toFixed(2) + " Hz");
const hasData = () => LA.n > 0 && LA.chans.length > 0;

/** agent：当前状态摘要（只读） */
export function laAgentState() {
  if (!hasData()) return "逻辑分析仪还没有数据（可以先 la_capture {source:\"demo\"} 载入示例，或让用户导入 VCD/CSV）。";
  const { on } = rowsOut();
  const t0 = LA.view.t0, t1 = LA.view.t0 + LA.view.span;
  const L = [];
  L.push(`数据来源：${LA.src}`);
  L.push(`采样率：${fmtHz(LA.rate)}　点数：${LA.n}　时长：${fmtT(LA.n / LA.rate, LA.n / LA.rate)}　通道：${LA.chans.length}（显示 ${on.length}）`);
  L.push(`视图窗口：${fmtT(t0, LA.view.span)} ~ ${fmtT(t1, LA.view.span)}（每屏 ${fmtT(LA.view.span, LA.view.span)}）`);
  const d = LA.cur.a != null && LA.cur.b != null ? Math.abs(LA.cur.b - LA.cur.a) : null;
  L.push(`光标：A=${LA.cur.a == null ? "—" : fmtT(LA.cur.a, LA.view.span)}　B=${LA.cur.b == null ? "—" : fmtT(LA.cur.b, LA.view.span)}` +
    (d ? `　Δt=${fmtT(d, d)}　1/Δt=${fmtHz(1 / d)}` : ""));
  if (LA.marks.length) L.push("标记：" + LA.marks.map((m, i) => `${i + 1}=${fmtT(m.t, LA.view.span)}`).join("　"));
  const ht = LA.hover != null ? t2i(LA.hover) : null;
  L.push("通道：" + LA.chans.map((c, i) => `${c.name}${c.on ? "" : "(隐藏)"}${ht != null ? "=" + at(c, ht) : ""}`).join("  "));
  L.push("解码器：" + (LA.dec.length ? LA.dec.map((x, i) => `#${i} ${decBrief(x)}`).join("；") : "（无）"));
  const m = measure(LA.sel, Math.max(0, Math.floor(t0 * LA.rate)), Math.min(LA.n - 1, Math.ceil(t1 * LA.rate)));
  if (m) L.push(`测量（${LA.chans[LA.sel] ? LA.chans[LA.sel].name : "-"}，当前窗口）：频率 ${m.freq ? fmtHz(m.freq) : "—"}　占空比 ${(m.duty * 100).toFixed(1)}%　脉冲 ${m.pulses}　高/低脉宽 ${fmtT(m.minHi, m.minHi)}~${fmtT(m.maxHi, m.maxHi)} / ${fmtT(m.minLo, m.minLo)}~${fmtT(m.maxLo, m.maxLo)}`);
  L.push("（数据本身 agent 不能改；要换数据用 la_capture 或让用户导入）");
  return L.join("\n");
}

/** agent：解码结果 + 每路测量（只读）。args.tail 只取最后 N 项（默认 200，最多 2000） */
export function laAgentRead(args) {
  if (!hasData()) return "逻辑分析仪还没有数据。";
  const tail = Math.max(1, Math.min(2000, Number((args && args.tail) || 200)));
  const out = { 来源: LA.src, 采样率_Hz: LA.rate, 点数: LA.n, 解码器: [] };
  LA.dec.forEach((dd, i) => {
    const items = decodeOf(dd);
    const shown = fmtItems(items, LA.rate, tail);
    out.解码器.push({ "#": i, 类型: dd.kind, 配置: decBrief(dd), 共: items.length, 本次返回: shown.length, 项: shown });
  });
  const i0 = Math.max(0, Math.floor(LA.view.t0 * LA.rate)), i1 = Math.min(LA.n - 1, Math.ceil((LA.view.t0 + LA.view.span) * LA.rate));
  out.测量 = LA.chans.map((c, i) => {
    const m = measure(i, i0, i1);
    return { 通道: c.name, 频率_Hz: m && m.freq ? +m.freq.toFixed(2) : 0, 占空比: m ? +(m.duty * 100).toFixed(1) : 0, 脉冲数: m ? m.pulses : 0 };
  });
  out.标记 = LA.marks.map((m, i) => ({ "#": i + 1, 时间_s: +m.t.toFixed(12) }));
  return JSON.stringify(out, null, 1);
}

/** agent：改配置（不碰数据）。args: { sampleRate?, decoders?, view?, cursors?, channels?, select? } */
export async function laAgentConfig(args) {
  const a = args || {};
  const done = [];
  if (a.sampleRate != null) { const r = Number(a.sampleRate); if (!(r > 0)) return "sampleRate 要正数"; LA.rate = r; done.push(`采样率=${fmtHz(r)}`); }
  if (Array.isArray(a.decoders)) {
    const next = [];
    for (const d of a.decoders) {
      if (!d || typeof d !== "object") return "decoders 里每一项都要是对象";
      const r = normalizeDec(d, LA.chans.length);
      if (r.err) return r.err;
      r.dec.on = d.on !== false;
      next.push(r.dec);
    }
    LA.dec = next;
    done.push(`解码器=${LA.dec.map(decBrief).join("；") || "（清空）"}`);
  }
  if (Array.isArray(a.channels)) {
    for (const c of a.channels) {
      const i = Number(c && c.i);
      if (LA.chans[i]) { LA.chans[i].on = c.on !== false; }
    }
    done.push("通道显隐已改");
  }
  if (a.select != null && LA.chans[Number(a.select)]) { LA.sel = Number(a.select); done.push(`选中通道=${LA.chans[LA.sel].name}`); }
  if (a.view && typeof a.view === "object") {
    if (a.view.t0 != null) LA.view.t0 = Number(a.view.t0) || 0;
    if (a.view.span != null) LA.view.span = Number(a.view.span) || LA.view.span;
    clampView(); done.push(`视图=${fmtT(LA.view.t0, LA.view.span)}~${fmtT(LA.view.t0 + LA.view.span, LA.view.span)}`);
  }
  if (a.cursors && typeof a.cursors === "object") {
    LA.cur.a = a.cursors.a == null ? null : Number(a.cursors.a);
    LA.cur.b = a.cursors.b == null ? null : Number(a.cursors.b);
    done.push("光标已设");
  }
  if (Array.isArray(a.markers)) {
    LA.marks = a.markers.map((m, i) => ({
      t: Math.max(0, Math.min(LA.n / LA.rate, Number(m && m.t != null ? m.t : m) || 0)),
      color: MARK_COLORS[i % MARK_COLORS.length],
    }));
    LA.activeMark = LA.marks.length ? 0 : -1;
    done.push(`标记=${LA.marks.length} 个`);
  }
  renderAll();
  return done.length ? "已改：" + done.join("；") + "\n（采集数据没动）" : "没有可改的字段（能改：sampleRate / decoders / channels / select / view / cursors / markers）";
}

/** agent：开始一次采集。source=demo 载入示例场景（scenario 可选）；真机要等驱动 */
export async function laAgentCapture(args) {
  const a = args || {};
  const src = String(a.source || "demo");
  if (src === "demo" || src === "scenario") {
    const want = String(a.scenario || "");
    const ids = scenarioList().map((x) => x.id);
    if (want && !ids.includes(want)) return `没有这个示例场景：${want}（可用：${ids.join(" / ")}）`;
    loadScenario(want || ids[0]);
    return "已载入示例：" + LA.src + "\n" + laAgentState();
  }
  if (src === "device" || src === "usb") {
    return "真机采集（fx2lafw / DSLogic 这类 USB 逻辑分析仪）这一版还没接驱动，采不了 —— 现在能用的来源是示例场景（source=demo）/ 导入 VCD / CSV / 原始二进制。";
  }
  return `不认识的 source：${src}（可用：demo）`;
}

/** agent：看支持哪些协议（只读）—— 每个协议能设哪些参数都在这 */
export function laAgentDecoders() {
  const L = [];
  L.push("支持的协议（kind / 名称 / 分类 / 参数）：");
  for (const cat of DEC_CATS) {
    const list = decList().filter((x) => x.cat === cat);
    if (!list.length) continue;
    L.push("【" + cat + "】");
    for (const x of list) {
      const ps = x.params.map((p) => {
        if (p.t === "ch") return p.l + "=通道号(必填)";
        if (p.t === "ch0") return p.l + "=通道号或-1(不接)";
        if (p.t === "num") return p.l + "=数字" + (p.d != null ? "(默认" + p.d + ")" : "");
        return p.l + "=" + (p.vals || []).join("|") + (p.d != null ? "(默认" + p.d + ")" : "");
      });
      L.push("  · " + x.kind + " — " + x.name + "：" + ps.join("，"));
    }
  }
  L.push("");
  L.push("用法：la_config { decoders: [ {kind:'i2c', scl:2, sda:3}, {kind:'can', ch:0, bitrate:250000} ] } —— 整份替换。");
  L.push("示例场景（la_capture {source:'demo', scenario:'…'}）：");
  for (const x of scenarioList()) L.push("  · " + x.id + " — " + x.label);
  return L.join("\n");
}

/** agent：把当前数据存成文件（CSV / VCD）。args: { path, format } */
export async function laAgentSave(args) {
  if (!hasData()) return "没有数据可存。";
  const path = String((args && args.path) || "").trim();
  if (!path) return "要给 path（存到哪）";
  const format = String((args && args.format) || (/\.vcd$/i.test(path) ? "vcd" : "csv")).toLowerCase();
  const cap = 200000;
  const n = Math.min(LA.n, cap);
  let text = "";
  if (format === "vcd") {
    const ps = Math.max(1, Math.round(1e12 / LA.rate));       // 每个采样多少 ps
    const idOf = (i) => String.fromCharCode(33 + i);          // ! " # ...
    text += `$timescale 1ps $end\n$scope module logic $end\n`;
    LA.chans.forEach((c, i) => { text += `$var wire 1 ${idOf(i)} ${c.name} $end\n`; });
    text += `$upscope $end\n$enddefinitions $end\n`;      // 第一个 #0 由下面循环自己写，别重复
    let prev = null;
    for (let i = 0; i < n; i++) {
      const cur = LA.chans.map((c) => at(c, i));
      if (prev && cur.every((v, k) => v === prev[k])) continue;
      text += `#${i * ps}\n`;
      cur.forEach((v, k) => { text += `${v}${idOf(k)}\n`; });
      prev = cur;
    }
  } else {
    text = "time," + LA.chans.map((c) => c.name).join(",") + "\n";
    for (let i = 0; i < n; i++) text += (i / LA.rate).toFixed(9) + "," + LA.chans.map((c) => at(c, i)).join(",") + "\n";
  }
  await invoke("file_write_text", { path, content: text });
  return `已存 ${path}（${format.toUpperCase()}，${n} 点${LA.n > cap ? `，只存了前 ${cap} 点` : ""}，共 ${text.length} 字节）`;
}

let laBound = false;

export function initLogic() {
  if (!$id("la-canvas")) return;
  if (laBound) {                       // 每次切回这一页都要重画：隐藏时画布尺寸是 0，只靠 window resize 补不回来
    requestAnimationFrame(() => renderAll());
    return;
  }
  laBound = true;
  LA.rowScale = Math.max(0.75, Math.min(1.8, Number(localStorage.getItem("kdock_la_row_scale") || "1") || 1));
  const btn = (id, fn) => { const b = $id(id); if (b) b.onclick = fn; };
  // 示例场景（下拉选一个，或按「载入」）
  const scn = $id("la-scn");
  if (scn) {
    scn.textContent = "";
    for (const x of scenarioList()) {
      const o = document.createElement("option");
      o.value = x.id; o.textContent = T(x.label);
      scn.appendChild(o);
    }
  }
  btn("la-demo", () => loadScenario(scn ? scn.value : undefined));
  const rateEl = $id("la-rate");
  if (rateEl) rateEl.onchange = () => {                      // 只改"怎么解释"，不动采集到的数据
    const r = Number(rateEl.value);
    if (r > 0) { LA.rate = r; clampView(); renderAll(); msg(T("采样率已改为 ") + fmtHz(r)); }
    else renderAll();
  };
  btn("la-import", () => importFile());
  btn("la-bin", () => importBin(""));
  btn("la-fit", () => { fitView(); renderAll(); });
  btn("la-zin", () => zoomAt(cv().getBoundingClientRect().width / 2, 0.8));
  btn("la-zout", () => zoomAt(cv().getBoundingClientRect().width / 2, 1.25));
  btn("la-row-dec", () => {
    LA.rowScale = Math.max(0.75, Math.round((LA.rowScale - 0.15) * 100) / 100);
    localStorage.setItem("kdock_la_row_scale", String(LA.rowScale));
    renderAll();
  });
  btn("la-row-inc", () => {
    LA.rowScale = Math.min(1.8, Math.round((LA.rowScale + 0.15) * 100) / 100);
    localStorage.setItem("kdock_la_row_scale", String(LA.rowScale));
    renderAll();
  });
  btn("la-add-mark", () => {
    addMark(LA.hover != null ? LA.hover : LA.view.t0 + LA.view.span / 2);
    renderAll();
  });
  btn("la-clr-cur", () => { LA.cur = { a: null, b: null }; renderAll(); });
  // 协议下拉：按分类分组，19 种都在里面
  const proto = $id("la-proto");
  if (proto) {
    proto.textContent = "";
    const all = decList();
    for (const cat of DEC_CATS) {
      const list = all.filter((x) => x.cat === cat);
      if (!list.length) continue;
      const grp = document.createElement("optgroup");
      grp.label = T(cat);
      for (const x of list) {
        const o = document.createElement("option");
        o.value = x.kind; o.textContent = x.name;
        grp.appendChild(o);
      }
      proto.appendChild(grp);
    }
    if (proto.options.length && !proto.value) proto.value = all[0].kind;
  }
  btn("la-add-dec", () => {
    const kind = proto && proto.value ? proto.value : "uart";
    const d = decDefaults(kind, LA.sel, LA.chans.length || 1);
    if (!d) return;
    LA.dec.push(normalizeDec(d, LA.chans.length || 1).dec || d);
    renderAll();
    msg(T("已加解码器：") + (DECODERS[kind] ? DECODERS[kind].name : kind));
  });
  window.addEventListener("resize", () => { if (!$id("la-canvas").closest("[hidden]")) renderAll(); });
  /* 有效 DPR 变了（换个缩放的显示器、改软件的"放大"）但不一定伴随 resize：
     用 matchMedia 监听"当前这个 dppx"，命中一次就重画并重新挂一次监听。
     不补这一步，画布会保持旧的位图被拉伸贴上去 —— 表现就是"页面突然糊了"。 */
  const watchDpr = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => { renderAll(); watchDpr(); };
    if (mq.addEventListener) mq.addEventListener("change", on, { once: true });
    else if (mq.addListener) mq.addListener(function h() { mq.removeListener(h); on(); });
  };
  watchDpr();
  bindInteract();
  loadScenario(scn ? scn.value : undefined);   // 进页面先给一段示例，省得对着空屏
  if (window.kdockOnLang) window.kdockOnLang(() => { renderAll(); });
  requestAnimationFrame(() => renderAll());
}
