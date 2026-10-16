// ── 逻辑分析仪（第一版）：波形查看 + 协议解码 + 导入 ────────────────────────
// 参考 DSView / PulseView 的用法：左边通道列（名字 / 颜色 / 显示开关 / 当前电平），
// 右边波形区（滚轮缩放、拖动平移、点一下放光标 A、Shift+点放 B、双击适应窗口），
// 底下再按"解码器"各占一行画解码结果（UART / SPI）。
//
// 真机采集（fx2lafw / DSLogic 之类）这一版还没接 —— 先把查看/解码/导入这条链路做扎实，
// 接驱动时只要把 samples 换成本机采到的就行。数据来源：示例信号 / VCD / CSV / 原始二进制。

import { open as dlgOpen } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

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
  hover: null,                // 鼠标位置（秒）
  dec: [],                    // 解码器 [{ kind, opts... }]
  sel: 0,                     // 当前通道（测量用）
  drag: null,
};
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const COLORS = ["#4ea1ff", "#ffd166", "#7ee787", "#ff8fa3", "#c792ea", "#7fd1e0", "#f5a97f", "#c9d1d9"];
const ROW_H = 30;

/* ============================ 数据 ============================ */

function setChans(list, rate, src) {
  LA.chans = list;
  LA.rate = rate;
  LA.n = list.length ? list[0].bits.length : 0;
  LA.src = src;
  LA.cur = { a: null, b: null };
  LA.hover = null;
  fitView();
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

/* ---------- 示例信号：UART("KDock\n" @115200) + 1kHz PWM + SPI(读 JEDEC ID) ---------- */
function demoSignal() {
  const rate = 1e6, n = 20000;                       // 1 MHz × 20 ms
  const C = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: "CH" + i, color: COLORS[i], bits: new Uint8Array(n), on: true }));
  const seg = [];                                   // 逐段描述（电平/翻转），最后逐点填
  const put = (ch, i0, i1, v) => { for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) ch.bits[i] = v ? 1 : 0; };

  // CH0：UART 115200 8N1，空闲高；发 "KDock\n"
  const uartBits = [];
  for (const ch of [..."KDock\n"].map((c) => c.charCodeAt(0))) {
    uartBits.push(0);                                // start
    for (let k = 0; k < 8; k++) uartBits.push((ch >> k) & 1);
    uartBits.push(1);                                // stop
  }
  const bitN = rate / 115200;
  for (let i = 0; i < n; i++) C[0].bits[i] = 1;
  uartBits.forEach((b, k) => {
    const i0 = Math.round(0.5e-3 * rate + k * bitN);
    put(C[0], i0, Math.round(0.5e-3 * rate + (k + 1) * bitN), b);
  });

  // CH1：1 kHz / 25% PWM；CH6：100 kHz 方波；CH7：10 Hz 慢方波
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    C[1].bits[i] = (t * 1000) % 1 < 0.25 ? 1 : 0;
    C[6].bits[i] = (t * 100000) % 1 < 0.5 ? 1 : 0;
    C[7].bits[i] = (t * 10) % 1 < 0.5 ? 1 : 0;
  }

  // CH3=CS（低有效）CH4=CLK（模式0：空闲低、上升沿采样）CH5=MOSI：读 JEDEC ID 0x9F → EF 40 18
  const cs = C[3], clk = C[4], mosi = C[5];
  for (let i = 0; i < n; i++) { cs.bits[i] = 1; clk.bits[i] = 0; mosi.bits[i] = 0; }
  const clkT = 1 / 250000;                           // 250 kHz（1 MHz 采样 → 每个时钟 4 个点）
  const iT = (x) => Math.round(x * rate);
  let t = 6e-3;
  put(cs, iT(t - 2e-6), iT(t + 33 * clkT), 0);       // 整帧 CS 拉低（前面留一点建立时间）
  for (const byte of [0x9f, 0xef, 0x40, 0x18]) {
    for (let k = 0; k < 8; k++) {
      put(mosi, iT(t), iT(t + clkT), (byte >> (7 - k)) & 1);   // MOSI 整个时钟周期都稳定
      put(clk, iT(t + clkT / 2), iT(t + clkT), 1);             // 只有后半周期高 → 上升沿时 MOSI 一定已建立
      t += clkT;
    }
  }
  put(cs, iT(t), n, 1);

  if (!LA.dec.length) LA.dec = [{ kind: "uart", ch: 0, baud: 115200 }, { kind: "spi", cs: 3, clk: 4, mosi: 5 }];
  setChans(C, rate, T("示例信号（UART 115200 / 1kHz PWM / SPI 读 JEDEC ID）"));
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

/** UART：8N1，空闲高；找 start 下降沿，按位中心采样。
 *  每比特采样点数 = rate/baud 基本是小数（1 MHz 采 115200 → 8.68），
 *  所以不能用取整后的位宽去累乘 —— 误差会累积，解到第 3、4 个字节就飘了。 */
function decodeUart(chIdx, baud) {
  const ch = LA.chans[chIdx];
  if (!ch) return [];
  const out = [];
  let i = 1;
  while (i < LA.n) {
    if (at(ch, i - 1) === 1 && at(ch, i) === 0) {           // 起始位（下降沿）
      const t0 = i / LA.rate;
      const iEnd = t2i(t0 + 10 / baud);
      let v = 0;
      for (let k = 0; k < 8; k++) {
        const idx = t2i(t0 + (k + 1.5) / baud);            // 第 k 个数据位的中心（按时间算，避免取整漂移）
        v |= (idx < LA.n ? at(ch, idx) : 1) << k;
      }
      const stopOk = at(ch, t2i(t0 + 9.5 / baud)) === 1;   // 停止位必须是 1，否则当成噪声，重新同步
      if (stopOk && iEnd <= LA.n) {
        out.push({ i0: i, i1: iEnd - 1, value: v, ok: true });
        i = Math.max(i + 1, iEnd - 1);      // 往回退一格：位宽是小数时 round 出来的帧尾可能刚好跳过下一个起始位
        continue;
      }
    }
    i++;
  }
  return out;
}

/** SPI：模式0（CLK 空闲低、上升沿采样），CS 低有效 */
function decodeSpi(csI, clkI, mosiI) {
  const cs = LA.chans[csI], clk = LA.chans[clkI], mo = LA.chans[mosiI];
  if (!cs || !clk || !mo) return [];
  const out = [];
  let bits = [], start = -1;
  for (let i = 1; i < LA.n; i++) {
    if (at(cs, i - 1) === 1 && at(cs, i) === 0) { bits = []; start = i; }        // CS 拉低
    if (at(cs, i) === 0 && at(clk, i - 1) === 0 && at(clk, i) === 1) {           // 上升沿
      if (bits.length === 0) start = i;
      bits.push(at(mo, i));
      if (bits.length === 8) { out.push({ i0: start, i1: i, value: bits.reduce((a, b) => (a << 1) | b, 0) }); bits = []; }
    }
    if (at(cs, i - 1) === 0 && at(cs, i) === 1) { bits = []; }
  }
  return out;
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

function renderWave() {
  const c = cv();
  if (!c) return;
  const box = c.getBoundingClientRect();
  if (box.width < 4 || box.height < 4) return;          // 还没布局好（隐藏中）就别画，否则画布被压成 0×0
  const dpr = DPR();
  if (c.width !== Math.round(box.width * dpr) || c.height !== Math.round(box.height * dpr)) {
    c.width = Math.round(box.width * dpr);
    c.height = Math.round(box.height * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  const css = getComputedStyle(document.documentElement);
  const fg = `hsl(${css.getPropertyValue("--foreground") || "210 20% 92%"})`;
  const muted = `hsl(${css.getPropertyValue("--muted-foreground") || "215 15% 65%"} / .9)`;
  const line = `hsl(${css.getPropertyValue("--surface-line") || "220 15% 28%"})`;
  g.clearRect(0, 0, W, H);
  g.font = "11px ui-monospace, Consolas, monospace";
  g.textBaseline = "middle";

  const AXIS = 22, PAD = 6;
  const { dec, rows } = rowsOut();
  const rowH = Math.max(16, Math.min(ROW_H, (H - AXIS - PAD) / Math.max(1, rows)));
  const x2t = (x) => LA.view.t0 + (x / W) * LA.view.span;
  const t2x = (t) => (t - LA.view.t0) / LA.view.span * W;

  // 时间轴
  g.fillStyle = muted;
  const step = niceStep(LA.view.span, Math.max(2, Math.round(W / 110)));
  const first = Math.ceil(LA.view.t0 / step) * step;
  for (let t = first; t <= LA.view.t0 + LA.view.span; t += step) {
    const x = t2x(t);
    g.strokeStyle = line; g.globalAlpha = .55;
    g.beginPath(); g.moveTo(x, AXIS); g.lineTo(x, H); g.stroke();
    g.globalAlpha = 1;
    g.fillText(fmtT(t, LA.view.span), Math.max(2, Math.min(W - 44, x + 3)), AXIS / 2);
  }

  // 波形：按像素列聚合（每列看这一段采样是"恒定"还是"有跳变"）
  const x0i = Math.max(0, Math.floor(LA.view.t0 * LA.rate));
  const x1i = Math.min(LA.n - 1, Math.ceil((LA.view.t0 + LA.view.span) * LA.rate));
  LA.chans.forEach((ch, r) => {
    if (!ch.on) return;                                 // 隐藏的占行但不画波形
    const top = AXIS + r * rowH, h = rowH - 5;
    const yHi = top + 3, yLo = top + h;
    g.strokeStyle = ch.color; g.lineWidth = 1.6;
    g.beginPath();
    let prevY = null;
    for (let px = 0; px < W; px++) {
      const i0 = Math.max(x0i, Math.floor(x2t(px) * LA.rate));
      const i1p = Math.min(x1i, Math.floor(x2t(px + 1) * LA.rate));
      let lo = null, hi = null;
      for (let i = i0; i <= i1p; i++) { const v = at(ch, i); if (lo === null || v < lo) lo = v; if (hi === null || v > hi) hi = v; }
      if (lo === null) { prevY = null; continue; }
      if (lo === hi) {
        const y = lo ? yHi : yLo;
        if (prevY != null && prevY !== y) { g.moveTo(px, prevY); g.lineTo(px, y); }   // 竖直过渡
        g.moveTo(px, y); g.lineTo(px + 1, y);
        prevY = y;
      } else {                                       // 这一列里有跳变：上下顶满（"忙"的样子）
        g.moveTo(px, yHi); g.lineTo(px, yLo);
        if (prevY != null) { g.moveTo(px, prevY); g.lineTo(px, prevY === yHi ? yLo : yHi); }
        prevY = null;
      }
    }
    g.stroke();
  });
  // 解码器行
  dec.forEach((d, k) => {
    const top = AXIS + (LA.chans.length + k) * rowH, h = rowH - 5;
    const res = d.kind === "uart" ? decodeUart(d.ch, d.baud)
      : d.kind === "spi" ? decodeSpi(d.cs, d.clk, d.mosi)
        : [];
    g.font = "10px ui-monospace, Consolas, monospace";
    for (const it of res) {
      const xa = t2x(it.i0 / LA.rate), xb = t2x(it.i1 / LA.rate);
      if (xb < -20 || xa > W + 20) continue;
      const w = Math.max(10, xb - xa);
      g.fillStyle = d.kind === "uart" ? "rgba(78,161,255,.22)" : "rgba(126,231,135,.22)";
      g.strokeStyle = d.kind === "uart" ? "#4ea1ff" : "#7ee787";
      g.beginPath(); g.rect(xa, top + 3, w, h); g.fill(); g.stroke();
      const label = d.kind === "uart"
        ? (it.value >= 32 && it.value < 127 ? `'${String.fromCharCode(it.value)}' 0x${it.value.toString(16).toUpperCase().padStart(2, "0")}` : "0x" + it.value.toString(16).toUpperCase().padStart(2, "0"))
        : "0x" + it.value.toString(16).toUpperCase().padStart(2, "0");
      if (w > 34) { g.fillStyle = fg; g.fillText(label, xa + 3, top + h / 2 + 3); }
    }
  });

  // 光标 + 悬停线
  const drawCur = (t, color, dash, name) => {
    if (t == null) return;
    const x = t2x(t);
    if (x < -10 || x > W + 10) return;
    g.strokeStyle = color; g.setLineDash(dash ? [4, 3] : []); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(x, AXIS - 4); g.lineTo(x, H); g.stroke();
    g.setLineDash([]);
    g.fillStyle = color; g.fillText(name, Math.max(2, Math.min(W - 12, x + 3)), 8);
  };
  drawCur(LA.cur.a, "#ffd166", false, "A");
  drawCur(LA.cur.b, "#7ee787", true, "B");
  if (LA.hover != null) { g.strokeStyle = muted; g.globalAlpha = .5; drawCur(LA.hover, muted, true, ""); g.globalAlpha = 1; }
}

function renderLabels() {
  const box = $id("la-labels");
  if (!box) return;
  const { on } = rowsOut();
  const c = cv();
  const H = c ? c.getBoundingClientRect().height : 300;
  const rows = rowsOut().rows;
  const rowH = Math.max(16, Math.min(ROW_H, (H - 22 - 6) / Math.max(1, rows)));
  box.textContent = "";
  const pad = el("div", "lalabel-h"); pad.style.height = "22px"; pad.textContent = T("通道");
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
    r.append(del, el("span", "laname", d.kind === "uart" ? `UART ${d.baud}` : d.kind === "spi" ? "SPI" : d.kind));
    box.appendChild(r);
  });
}

/** 解码器参数列表（右栏）：每条一行，能改通道/波特率、能删 */
function renderDecList() {
  const box = $id("la-dec-list");
  if (!box) return;
  box.textContent = "";
  if (!LA.dec.length) { box.appendChild(el("p", "hint", T("还没加解码器：上面点 + UART / + SPI"))); return; }
  const chSel = (val, onPick) => {
    const s = document.createElement("select");
    s.className = "tight";
    LA.chans.forEach((c, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = c.name; if (i === val) o.selected = true; s.appendChild(o); });
    s.onchange = () => { onPick(Number(s.value)); renderAll(); };
    return s;
  };
  LA.dec.forEach((d, i) => {
    const row = el("div", "ladecrow");
    const del = el("button", "btn tiny", "✕");
    del.title = T("删掉这个解码器");
    del.onclick = () => { LA.dec.splice(i, 1); renderAll(); };
    row.appendChild(el("span", "laname", d.kind === "uart" ? "UART" : "SPI"));
    if (d.kind === "uart") {
      row.appendChild(el("span", "lb", T("通道")));
      row.appendChild(chSel(d.ch, (v) => { d.ch = v; }));
      const b = document.createElement("input");
      b.type = "number"; b.className = "num"; b.value = String(d.baud);
      b.onchange = () => { d.baud = Math.max(50, Number(b.value) || 115200); renderAll(); };
      row.appendChild(b); row.appendChild(el("span", "lb", "baud"));
    } else {
      row.appendChild(el("span", "lb", "CS")); row.appendChild(chSel(d.cs, (v) => { d.cs = v; }));
      row.appendChild(el("span", "lb", "CLK")); row.appendChild(chSel(d.clk, (v) => { d.clk = v; }));
      row.appendChild(el("span", "lb", "MOSI")); row.appendChild(chSel(d.mosi, (v) => { d.mosi = v; }));
    }
    row.appendChild(el("span", "grow"));
    row.appendChild(del);
    box.appendChild(row);
  });
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
  c.addEventListener("pointerdown", (e) => { LA.drag = { x: e.offsetX, t0: LA.view.t0, moved: false }; c.setPointerCapture(e.pointerId); });
  c.addEventListener("pointermove", (e) => {
    LA.hover = x2t(e.offsetX);
    if (LA.drag) {
      const W = c.getBoundingClientRect().width;
      const dt = -((e.offsetX - LA.drag.x) / W) * LA.view.span;
      if (Math.abs(e.offsetX - LA.drag.x) > 2) LA.drag.moved = true;
      LA.view.t0 = LA.drag.t0 + dt;
      clampView(); renderWave();
    } else renderWave();
    renderLabels(); renderReadout();
  });
  c.addEventListener("pointerup", (e) => {
    if (LA.drag && !LA.drag.moved) {
      const t = x2t(e.offsetX);
      if (e.shiftKey) LA.cur.b = t; else LA.cur.a = t;
      renderAll();
    }
    LA.drag = null;
  });
  c.addEventListener("pointerleave", () => { LA.hover = null; renderAll(); });
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
  e.textContent = text || "";
  e.style.color = bad ? "hsl(var(--destructive))" : "";
}

/* ============================ 初始化 ============================ */

/* ============================ agent 接口 ============================ */
// agent 那边能：读状态、读解码结果、**改配置**（解码器/采样率/视图/光标/通道显隐）、
// 触发一次采集（现在只有示例信号）、把数据存成文件。
// 数据本身（samples）agent 改不了 —— 只能通过"重新采集 / 导入"来换。

const fmtHz = (f) => (f >= 1e6 ? (f / 1e6).toFixed(3) + " MHz" : f >= 1e3 ? (f / 1e3).toFixed(3) + " kHz" : f.toFixed(2) + " Hz");
const decBrief = (d) => (d.kind === "uart" ? `UART 通道${d.ch}@${d.baud}` : `SPI CS=${d.cs} CLK=${d.clk} MOSI=${d.mosi}`);
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
    const items = dd.kind === "uart" ? decodeUart(dd.ch, dd.baud) : dd.kind === "spi" ? decodeSpi(dd.cs, dd.clk, dd.mosi) : [];
    const shown = items.slice(-tail).map((x) => ({
      t0_us: +(x.i0 / LA.rate * 1e6).toFixed(3), t1_us: +(x.i1 / LA.rate * 1e6).toFixed(3),
      hex: "0x" + x.value.toString(16).toUpperCase().padStart(2, "0"),
      ...(dd.kind === "uart" ? { ch: x.value >= 32 && x.value < 127 ? String.fromCharCode(x.value) : "", ok: x.ok } : {}),
    }));
    out.解码器.push({ "#": i, 类型: dd.kind, 配置: decBrief(dd), 共: items.length, 本次返回: shown.length, 项: shown });
  });
  const i0 = Math.max(0, Math.floor(LA.view.t0 * LA.rate)), i1 = Math.min(LA.n - 1, Math.ceil((LA.view.t0 + LA.view.span) * LA.rate));
  out.测量 = LA.chans.map((c, i) => {
    const m = measure(i, i0, i1);
    return { 通道: c.name, 频率_Hz: m && m.freq ? +m.freq.toFixed(2) : 0, 占空比: m ? +(m.duty * 100).toFixed(1) : 0, 脉冲数: m ? m.pulses : 0 };
  });
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
      if (d.kind === "uart") {
        const ch = Number(d.ch); if (!(ch >= 0 && ch < LA.chans.length)) return `UART 的 ch 越界：${d.ch}（有 ${LA.chans.length} 路）`;
        next.push({ kind: "uart", ch, baud: Math.max(50, Number(d.baud) || 115200), on: d.on !== false });
      } else if (d.kind === "spi") {
        for (const k of ["cs", "clk", "mosi"]) if (!(Number(d[k]) >= 0 && Number(d[k]) < LA.chans.length)) return `SPI 的 ${k} 越界：${d[k]}`;
        next.push({ kind: "spi", cs: Number(d.cs), clk: Number(d.clk), mosi: Number(d.mosi), on: d.on !== false });
      } else return `不认识的解码器类型：${d.kind}（现在支持 uart / spi）`;
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
  renderAll();
  return done.length ? "已改：" + done.join("；") + "\n（采集数据没动）" : "没有可改的字段（能改：sampleRate / decoders / channels / select / view / cursors）";
}

/** agent：开始一次采集。现在只有示例信号；真机要等驱动 */
export async function laAgentCapture(args) {
  const src = String((args && args.source) || "demo");
  if (src === "demo") { demoSignal(); return "已载入示例信号（UART 115200 / 1kHz PWM / SPI 读 JEDEC ID）。" + laAgentState(); }
  if (src === "device" || src === "usb") {
    return "真机采集（fx2lafw / DSLogic 这类 USB 逻辑分析仪）这一版还没接驱动，采不了 —— 现在能用的来源是 demo / 导入 VCD / CSV / 原始二进制。";
  }
  return `不认识的 source：${src}（可用：demo）`;
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
  const btn = (id, fn) => { const b = $id(id); if (b) b.onclick = fn; };
  btn("la-demo", () => { demoSignal(); msg(T("已载入示例信号")); });
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
  btn("la-clr-cur", () => { LA.cur = { a: null, b: null }; renderAll(); });
  btn("la-add-uart", () => { LA.dec.push({ kind: "uart", ch: Math.max(0, LA.sel), baud: 115200 }); renderAll(); });
  btn("la-add-spi", () => { LA.dec.push({ kind: "spi", cs: 3, clk: 4, mosi: 5 }); renderAll(); });
  window.addEventListener("resize", () => { if (!$id("la-canvas").closest("[hidden]")) renderAll(); });
  bindInteract();
  demoSignal();                       // 进页面先给一段示例，省得对着空屏
  if (window.kdockOnLang) window.kdockOnLang(() => { renderAll(); });
  requestAnimationFrame(() => renderAll());
}
