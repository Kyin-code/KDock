// ── 逻辑分析仪：协议解码器库 ────────────────────────────────────────────────
// 纯计算：不碰 DOM、不 import Tauri —— 所以 Node 里能直接 import 进来跑测试。
//
// 每个解码器 decode(ctx, p) 返回一串"项"：
//   { i0, i1, cls, text, aux }
//     i0/i1  这一段占的采样下标（画在波形上就是一个方块）
//     cls    配色分类：start/stop/addr/data/ack/nak/err/ctrl/bit
//     text   画在方块里的字（窄了就自动省略）
//     aux    给 agent 看的细节（不进画面）
// 参数表 params 里每一项：
//   { k:键, t:类型, l:标签, d:默认值, ... }
//     t='ch'  选一条通道        t='ch0' 选通道或"无"（值 -1）
//     t='num' 数字（min/max/step）  t='enum' 下拉（vals）

export const CLS_COLOR = {
  start: "#f5a97f",
  stop: "#9aa4b2",
  addr: "#c792ea",
  data: "#4ea1ff",
  ack: "#7ee787",
  nak: "#ff8fa3",
  err: "#ff6b6b",
  ctrl: "#7fd1e0",
  bit: "#9aa4b2",
};

/* ============================ 公共小工具 ============================ */

/** 采样上下文：把"读某个通道第 i 个采样"包装好，解码器里就只管算法 */
export function mkCtx(rate, chans) {
  const n = chans.length ? chans[0].bits.length : 0;
  return {
    rate, n, chans,
    at(ch, i) { const c = chans[ch]; return c && i >= 0 && i < n && c.bits[i] ? 1 : 0; },
    t2i(t) { return Math.round(t * rate); },
    i2t(i) { return i / rate; },
  };
}

/** 一段区间里的跳变点 */
function edges(ctx, ch, i0, i1) {
  const out = [];
  if (i1 <= i0) return out;
  let prev = ctx.at(ch, i0);
  for (let i = i0 + 1; i <= i1; i++) {
    const v = ctx.at(ch, i);
    if (v !== prev) { out.push({ i, v, from: prev }); prev = v; }
  }
  return out;
}

/** 拆成"电平段"：每段 i0..i1 电平相同（脉宽解码全靠它） */
function runs(ctx, ch, i0, i1) {
  const out = [];
  if (i1 < i0) return out;
  let start = i0, prev = ctx.at(ch, i0);
  for (let i = i0 + 1; i <= i1; i++) {
    const v = ctx.at(ch, i);
    if (v !== prev) { out.push({ i0: start, i1: i - 1, v: prev }); start = i; prev = v; }
  }
  out.push({ i0: start, i1, v: prev });
  return out;
}

/** 一串"帧"级别的项：把一段下标 + 文字 + 分类 + 细节包起来 */
function it(i0, i1, cls, text, aux) { return { i0, i1, cls, text, aux }; }

const hx = (v, w) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(w || 2, "0");
const hexBytes = (arr) => arr.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
/** 可打印就带上字符，方便一眼看出是 ASCII 还是二进制 */
const chOf = (v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : "");

/** Dallas / 1-Wire / LIN 增强校验都用这个 CRC-8（poly 0x31 反射） */
function crc8_31(data) {
  let crc = 0;
  for (const b of data) {
    let x = b;
    for (let k = 0; k < 8; k++) {
      const mix = (crc ^ x) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      x >>= 1;
    }
  }
  return crc & 0xff;
}

/** Modbus RTU 的 CRC-16（poly 0xA001 反射） */
function crc16_modbus(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc & 0xffff;
}

/** UART 字节流抽取（modbus / lin 这些"跑在串口上"的协议复用） */
function uartBytes(ctx, p, from) {
  const ch = p.ch, baud = p.baud || 115200;
  const idle = p.polarity === "idle low" ? 0 : 1;
  const bit = (x) => (idle ? x : 1 - x);
  const db = Math.max(5, Math.min(9, p.dataBits || 8));
  const parity = p.parity || "none";
  const stop = p.stop === 0.5 ? 1.5 : (p.stop || 1);
  const out = [];
  let i = Math.max(1, Math.round(from || 0));
  while (i < ctx.n) {
    if (bit(ctx.at(ch, i - 1)) === 1 && bit(ctx.at(ch, i)) === 0) {
      const t0 = i / ctx.rate;
      const iEnd = ctx.t2i(t0 + (db + (parity === "none" ? 0 : 1) + stop + 1) / baud);
      let v = 0;
      for (let k = 0; k < db; k++) v |= bit(ctx.at(ch, ctx.t2i(t0 + (k + 1.5) / baud))) << k;
      const pIdx = parity === "none" ? null : ctx.t2i(t0 + (db + 1.5) / baud);
      const pBit = pIdx == null ? null : bit(ctx.at(ch, pIdx));
      const stopIdx = ctx.t2i(t0 + (db + (parity === "none" ? 0 : 1) + 1.5) / baud);
      const stopOk = bit(ctx.at(ch, stopIdx)) === 1;
      let parityOk = true;
      if (pBit != null) {
        let ones = 0, x = v;
        while (x) { ones += x & 1; x >>= 1; }
        ones += pBit;
        parityOk = parity === "even" ? ones % 2 === 0 : ones % 2 === 1;
      }
      if (stopOk && iEnd <= ctx.n) {
        out.push({ i0: i, i1: iEnd - 1, value: v, parityOk, t0: i / ctx.rate });
        i = Math.max(i + 1, iEnd - 1);
        continue;
      }
    }
    i++;
  }
  return out;
}

/* ============================ UART ============================ */

const uartDec = {
  name: "UART",
  cat: "串行",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "baud", t: "num", l: "波特率", d: 115200, min: 300, step: 100 },
    { k: "dataBits", t: "enum", l: "数据位", vals: [5, 6, 7, 8, 9], d: 8 },
    { k: "parity", t: "enum", l: "校验", vals: ["none", "even", "odd"], d: "none" },
    { k: "stop", t: "enum", l: "停止位", vals: [1, 1.5, 2], d: 1 },
    { k: "polarity", t: "enum", l: "极性", vals: ["idle high", "idle low"], d: "idle high" },
  ],
  // 每比特采样点数是小数（1MHz 采 115200 = 8.68），所以按"时间"算每个位的中心，
  // 不能用取整后的位宽累乘（误差会攒到第 3、4 个字节上）。
  decode(ctx, p) {
    const baud = p.baud || 115200;
    const idle = p.polarity === "idle low" ? 0 : 1;
    const bit = (x) => (idle ? x : 1 - x);
    const db = Math.max(5, Math.min(9, p.dataBits || 8));
    const parity = p.parity || "none";
    const nStop = p.stop === 0.5 ? 1.5 : (p.stop || 1);
    const frameBits = 1 + db + (parity === "none" ? 0 : 1) + nStop;
    const out = [];
    let i = 1;
    while (i < ctx.n) {
      if (bit(ctx.at(p.ch, i - 1)) === 1 && bit(ctx.at(p.ch, i)) === 0) {   // 起始位下降沿
        const t0 = i / ctx.rate;
        const iEnd = ctx.t2i(t0 + frameBits / baud);
        let v = 0;
        for (let k = 0; k < db; k++) v |= bit(ctx.at(p.ch, ctx.t2i(t0 + (k + 1.5) / baud))) << k;
        const pIdx = parity === "none" ? null : ctx.t2i(t0 + (db + 1.5) / baud);
        const pBit = pIdx == null ? null : bit(ctx.at(p.ch, pIdx));
        let parityOk = true;
        if (pBit != null) {
          let ones = pBit, x = v;
          while (x) { ones += x & 1; x >>= 1; }
          parityOk = parity === "even" ? ones % 2 === 0 : ones % 2 === 1;
        }
        let stopOk = true;
        for (let k = 0; k < Math.floor(nStop); k++) {
          if (bit(ctx.at(p.ch, ctx.t2i(t0 + (db + (parity === "none" ? 0 : 1) + 1.5 + k) / baud))) !== 1) stopOk = false;
        }
        if (stopOk && iEnd <= ctx.n) {
          const txt = (chOf(v) ? "'" + chOf(v) + "' " : "") + hx(v);
          out.push(it(i, iEnd - 1, "data", parityOk ? txt : txt + " 校验错",
            { hex: hx(v), ascii: chOf(v), baud, parityOk, t0_us: +(t0 * 1e6).toFixed(3) }));
          i = Math.max(i + 1, iEnd - 1);
          continue;
        }
      }
      i++;
    }
    return out;
  },
};

/* ============================ SPI ============================ */

const spiDec = {
  name: "SPI",
  cat: "总线",
  params: [
    { k: "clk", t: "ch", l: "CLK" },
    { k: "mosi", t: "ch0", l: "MOSI", d: -1 },
    { k: "miso", t: "ch0", l: "MISO", d: -1 },
    { k: "cs", t: "ch0", l: "CS", d: -1 },
    { k: "mode", t: "enum", l: "模式", vals: [0, 1, 2, 3], d: 0 },
    { k: "order", t: "enum", l: "位序", vals: ["msb", "lsb"], d: "msb" },
    { k: "wordSize", t: "num", l: "字长", d: 8, min: 4, max: 32 },
  ],
  decode(ctx, p) {
    const cpol = p.mode >= 2 ? 1 : 0;
    const cpha = p.mode === 1 || p.mode === 3 ? 1 : 0;
    const onRise = cpol === cpha;                     // 采样沿：cpha=0 采前沿，cpha=1 采后沿
    const csOn = p.cs != null && p.cs >= 0;
    const on = (i) => (!csOn || ctx.at(p.cs, i) === 0);
    const words = Math.max(4, Math.min(32, p.wordSize || 8));
    const out = [];
    const wHex = words > 8 ? Math.ceil(words / 4) : 2;
    let mo = 0, mi = 0, cnt = 0, i0 = -1;
    const push = (iEnd) => {
      const parts = [], aux = { bits: words, order: p.order };
      if (p.mosi >= 0) { parts.push("MOSI " + hx(mo, wHex)); aux.mosi = hx(mo); }
      if (p.miso >= 0) { parts.push("MISO " + hx(mi, wHex)); aux.miso = hx(mi); }
      out.push(it(i0, iEnd, "data", parts.join(" ") || hx(mo, wHex), aux));
    };
    for (let i = 1; i < ctx.n; i++) {
      const c0 = ctx.at(p.clk, i - 1), c1 = ctx.at(p.clk, i);
      if (csOn && ctx.at(p.cs, i - 1) === 1 && ctx.at(p.cs, i) === 0) { mo = 0; mi = 0; cnt = 0; i0 = i; }   // CS 拉低
      if (csOn && ctx.at(p.cs, i - 1) === 0 && ctx.at(p.cs, i) === 1) {                                     // CS 抬起
        if (cnt) out.push(it(i0, i, "err", "半个字（CS 提前抬起）", { bits: cnt }));
        mo = 0; mi = 0; cnt = 0;
      }
      if (c0 === c1 || !on(i)) continue;
      if ((onRise && c0 === 0) || (!onRise && c0 === 1)) {
        if (cnt === 0) i0 = i;
        const mv = p.mosi >= 0 ? ctx.at(p.mosi, i) : 0;
        const sv = p.miso >= 0 ? ctx.at(p.miso, i) : 0;
        if (p.order === "lsb") { mo = (mo | (mv << cnt)) >>> 0; mi = (mi | (sv << cnt)) >>> 0; }
        else { mo = ((mo << 1) | mv) >>> 0; mi = ((mi << 1) | sv) >>> 0; }
        cnt++;
        if (cnt === words) { push(i); mo = 0; mi = 0; cnt = 0; }
      }
    }
    if (cnt) out.push(it(i0, ctx.n - 1, "err", "半个字（没凑满 " + words + " 位）", { bits: cnt }));
    return out;
  },
};
/* ============================ I2C ============================ */

const i2cDec = {
  name: "I2C",
  cat: "总线",
  params: [
    { k: "scl", t: "ch", l: "SCL" },
    { k: "sda", t: "ch", l: "SDA" },
  ],
  // 起始/停止靠"SCl 高时 SDA 跳变"认；数据位在 SCL 上升沿采（高电平期间数据有效），MSB 先来。
  decode(ctx, p) {
    const out = [];
    let bits = 0, cnt = 0, byteStart = -1, first = true, active = false;
    for (let i = 1; i < ctx.n; i++) {
      const sda0 = ctx.at(p.sda, i - 1), sda1 = ctx.at(p.sda, i);
      const scl0 = ctx.at(p.scl, i - 1), scl1 = ctx.at(p.scl, i);
      if (scl1 === 1 && scl0 === 1 && sda0 === 1 && sda1 === 0) {           // START
        out.push(it(i - 1, i + 2, "start", "START", {}));                    // 残留的半字节直接丢（见下）
        bits = 0; cnt = 0; first = true; active = true; continue;
      }
      // STOP / 重复 START 之前，主机会"先补一拍时钟再凑条件"，会留下不完整的字节 —— 丢掉不报错
      if (scl1 === 1 && scl0 === 1 && sda0 === 0 && sda1 === 1) {           // STOP
        out.push(it(i - 1, i + 2, "stop", "STOP", {}));
        bits = 0; cnt = 0; active = false; continue;
      }
      if (active && scl0 === 0 && scl1 === 1) {                             // SCL 上升沿
        if (cnt < 8) {
          if (cnt === 0) byteStart = i;
          bits = ((bits << 1) | sda1) & 0xff;
          cnt++;
        } else {                                                            // 第 9 位 = 应答
          const v = bits, ack = sda1 === 0;
          const txt = first ? hx(v >> 1) + (v & 1 ? " R" : " W") : hx(v);
          out.push(it(byteStart, i, first ? "addr" : "data", txt,
            { byte: hx(v), ack, addr: first, rw: first ? (v & 1 ? "read" : "write") : undefined }));
          out.push(it(i, i + 4, ack ? "ack" : "nak", ack ? "ACK" : "NACK", {}));
          first = false; bits = 0; cnt = 0; byteStart = -1;
        }
      }
    }
    return out;
  },
};

/* ============================ PWM（每个周期标一次频/占空） ============================ */

const hz = (f) => (f >= 1e6 ? (f / 1e6).toFixed(3) + " MHz" : f >= 1e3 ? (f / 1e3).toFixed(3) + " kHz" : f.toFixed(1) + " Hz");

const pwmDec = {
  name: "PWM",
  cat: "测量",
  params: [{ k: "ch", t: "ch", l: "通道" }],
  decode(ctx, p) {
    const out = [];
    let last = -1, hi = 0, len = 0;
    for (let i = 1; i < ctx.n; i++) {
      const v = ctx.at(p.ch, i);
      if (v) { hi++; len++; }
      else len++;
      if (ctx.at(p.ch, i - 1) === 1 && v === 0) { /* 下降沿 */ }
      if (ctx.at(p.ch, i - 1) === 0 && v === 1) {                            // 上升沿 = 一个周期结束
        if (last >= 0) {
          const n = len || 1, duty = hi / n, f = ctx.rate / n;
          out.push(it(last, i - 1, "data", hz(f) + " " + (duty * 100).toFixed(1) + "%", { freq: +f.toFixed(2), duty: +(duty * 100).toFixed(1) }));
        }
        last = i; hi = 0; len = 0;
        if (out.length > 4000) break;                                       // 别把一条 100kHz 的线画成上万项
      }
    }
    return out;
  },
};

/* ============================ 曼彻斯特 / 差分曼彻斯特 / Miller ============================ */

/** 把一串 bit 按字长打包成方块 */
function packWords(ctx, p, ph, spb, bits) {
  const w = Math.max(1, Math.min(32, p.wordSize || 8));
  const out = [];
  for (let s = 0; s + w <= bits.length; s += w) {
    let v = 0;
    for (let k = 0; k < w; k++) v = p.order === "lsb" ? ((v | (bits[s + k] << k)) >>> 0) : (((v << 1) | bits[s + k]) >>> 0);
    out.push(it(Math.round(ph + s * spb), Math.round(ph + (s + w) * spb) - 1, "data",
      hx(v, Math.ceil(w / 4)), { bits: bits.slice(s, s + w).join(""), hex: hx(v) }));
  }
  return out;
}

/** 把一段"电平段"跟真实信号逐点比，返回吻合度（1 = 一模一样） */
function scoreRuns(ctx, ch, ph, runs) {
  let idx = Math.round(ph), ok = 0, tot = 0;
  for (const g of runs) {
    for (let q = 0; q < g[1]; q++, idx++) {
      if (idx >= ctx.n) return tot ? ok / tot : 0;
      tot++; if (ctx.at(ch, idx) === g[0]) ok++;
    }
  }
  return tot ? ok / tot : 0;
}

/** 自时钟编码（曼彻斯特这一类）挑相位：候选几个相位各解一遍、再按原样编回去跟信号比，
 *  谁最像认谁。分数打平取**最早**的那个 —— 位流就从最早能自洽的地方开始。
 *  非要这么做不可：第一个跳变可能是"位中心"也可能是"位边界"，差半个比特；
 *  而且整段两头的空闲电平会把"猜"出来的位流冲得没法看。 */
function bestPhase(ctx, ch, cands, mk) {
  let best = null;
  for (const c of cands) {
    if (!(c >= 0)) continue;
    const r = mk(Math.round(c));
    if (!r || r.bits.length < 2) continue;
    const sc = scoreRuns(ctx, ch, c, r.runs);
    if (!best || sc > best.score + 0.005) best = { ph: c, bits: r.bits, runs: r.runs, score: sc };
  }
  return best;
}

const manDec = {
  name: "Manchester",
  cat: "编码",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "bitrate", t: "num", l: "比特率", d: 1000000, min: 2 },
    { k: "conv", t: "enum", l: "约定", vals: ["IEEE 802.3", "G.E. Thomas"], d: "IEEE 802.3" },
    { k: "wordSize", t: "num", l: "字长", d: 8, min: 1, max: 32 },
    { k: "order", t: "enum", l: "位序", vals: ["msb", "lsb"], d: "msb" },
  ],
  // 每个比特中点必有一次跳变：IEEE 是"1 = 前高后低"，G.E. Thomas 是"1 = 前低后高"
  decode(ctx, p) {
    const spb = ctx.rate / (p.bitrate || 1);
    if (spb < 4) return [it(0, ctx.n - 1, "err", "采样率太低（每比特不足 4 点）", {})];
    let first = -1, lastEdge = -1;
    for (let i = 1; i < ctx.n; i++) if (ctx.at(p.ch, i - 1) !== ctx.at(p.ch, i)) { if (first < 0) first = i; lastEdge = i; }
    if (first < 0) return [it(0, ctx.n - 1, "err", "整段没有跳变", {})];
    const end = Math.min(ctx.n, lastEdge + Math.round(spb));      // 数据到最后一个跳变后一位为止
    const half = Math.max(1, Math.round(spb / 2)), rest = Math.max(1, Math.round(spb) - half);
    const oneLead = p.conv === "G.E. Thomas" ? 0 : 1;
    const mk = (ph) => {
      const bits = [], runs = [];
      for (let k = 0; ; k++) {
        const c0 = Math.round(ph + (k + 0.25) * spb), c1 = Math.round(ph + (k + 0.75) * spb);
        if (c1 >= end) break;
        const x = ctx.at(p.ch, c0), y = ctx.at(p.ch, c1);
        const v = (p.conv === "G.E. Thomas" ? x === 0 && y === 1 : x === 1 && y === 0) ? 1 : 0;
        bits.push(v);
        const lead = v ? oneLead : 1 - oneLead;
        runs.push([lead, half], [1 - lead, rest]);
      }
      return { bits, runs };
    };
    const best = bestPhase(ctx, p.ch, [first - spb, first - half, first, first + half], mk);
    if (!best) return [it(0, ctx.n - 1, "err", "找不到曼彻斯特时钟（比特率对不对？）", {})];
    return packWords(ctx, p, best.ph, spb, best.bits);
  },
};

const dmanDec = {
  name: "差分 Manchester",
  cat: "编码",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "bitrate", t: "num", l: "比特率", d: 1000000, min: 2 },
    { k: "conv", t: "enum", l: "约定", vals: ["IEEE 802.3", "G.E. Thomas"], d: "IEEE 802.3" },
    { k: "wordSize", t: "num", l: "字长", d: 8, min: 1, max: 32 },
    { k: "order", t: "enum", l: "位序", vals: ["msb", "lsb"], d: "msb" },
  ],
  // 差分曼彻斯特：每个比特开头必翻一次（天然位边界）；中点再翻一次表示 0（IEEE）
  decode(ctx, p) {
    const spb = ctx.rate / (p.bitrate || 1);
    if (spb < 4) return [it(0, ctx.n - 1, "err", "采样率太低（每比特不足 4 点）", {})];
    let first = -1, lastEdge = -1;
    for (let i = 1; i < ctx.n; i++) if (ctx.at(p.ch, i - 1) !== ctx.at(p.ch, i)) { if (first < 0) first = i; lastEdge = i; }
    if (first < 0) return [it(0, ctx.n - 1, "err", "整段没有跳变", {})];
    const end = Math.min(ctx.n, lastEdge + Math.round(spb));      // 数据到最后一个跳变后一位为止
    const half = Math.max(1, Math.round(spb / 2)), rest = Math.max(1, Math.round(spb) - half);
    const mk = (ph) => {
      const bits = [], runs = [];
      // 位边界上是"翻之前"的电平 —— 差分曼彻斯特每个位起点都会翻，所以起点电平要取 ph 前一个采样
      let lvl = ctx.at(p.ch, Math.max(0, ph - 1)) ? 1 : 0;
      for (let k = 0; ; k++) {
        const c0 = Math.round(ph + (k + 0.25) * spb), c1 = Math.round(ph + (k + 0.75) * spb);
        if (c1 >= end) break;
        const x = ctx.at(p.ch, c0), y = ctx.at(p.ch, c1);
        const same = x === y;
        const v = p.conv === "G.E. Thomas" ? (same ? 0 : 1) : (same ? 1 : 0);
        bits.push(v);
        lvl ^= 1;                       // 位起点必翻
        runs.push([lvl, half]);
        if (v === 0) lvl ^= 1;          // 中点再翻 = 0
        runs.push([lvl, rest]);
      }
      return { bits, runs };
    };
    const best = bestPhase(ctx, p.ch, [first - spb, first - half, first, first + half], mk);
    if (!best) return [it(0, ctx.n - 1, "err", "找不到差分曼彻斯特时钟", {})];
    return packWords(ctx, p, best.ph, spb, best.bits);
  },
};

const millerDec = {
  name: "Miller",
  cat: "编码",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "bitrate", t: "num", l: "比特率", d: 1000000, min: 2 },
    { k: "wordSize", t: "num", l: "字长", d: 8, min: 1, max: 32 },
    { k: "order", t: "enum", l: "位序", vals: ["msb", "lsb"], d: "msb" },
  ],
  // Miller：比特中点跳变 = 1；连续两个 0 的时候在边界补一次跳变（RFID 用得最多）
  decode(ctx, p) {
    const spb = ctx.rate / (p.bitrate || 1);
    if (spb < 4) return [it(0, ctx.n - 1, "err", "采样率太低（每比特不足 4 点）", {})];
    let first = -1, lastEdge = -1;
    for (let i = 1; i < ctx.n; i++) if (ctx.at(p.ch, i - 1) !== ctx.at(p.ch, i)) { if (first < 0) first = i; lastEdge = i; }
    if (first < 0) return [it(0, ctx.n - 1, "err", "整段没有跳变", {})];
    const end = Math.min(ctx.n, lastEdge + Math.round(spb));      // 数据到最后一个跳变后一位为止
    const half = Math.max(1, Math.round(spb / 2)), rest = Math.max(1, Math.round(spb) - half);
    const mk = (ph) => {
      const bits = [], runs = [];
      for (let k = 0; ; k++) {
        const c0 = Math.round(ph + (k + 0.35) * spb), c1 = Math.round(ph + (k + 0.65) * spb);
        if (c1 >= end) break;
        bits.push(ctx.at(p.ch, c0) !== ctx.at(p.ch, c1) ? 1 : 0);
      }
      let lvl = ctx.at(p.ch, ph) ? 1 : 0;
      for (let k = 0; k < bits.length; k++) {
        if (bits[k]) { runs.push([lvl, half]); lvl ^= 1; runs.push([lvl, rest]); }
        else {
          runs.push([lvl, half], [lvl, rest]);
          if (k + 1 < bits.length && bits[k + 1] === 0) lvl ^= 1;
        }
      }
      return { bits, runs };
    };
    const best = bestPhase(ctx, p.ch, [first - spb, first - half, first, first + half, first + spb], mk);
    if (!best) return [it(0, ctx.n - 1, "err", "找不到 Miller 位边界", {})];
    return packWords(ctx, p, best.ph, spb, best.bits);
  },
};

/* ============================ 1-Wire / DS18B20 ============================ */

/** 1-Wire 共用：扫出"复位 / 存在脉冲"事件 + 按比特槽解出的字节 */
function oneWireScan(ctx, ch, resetUs) {
  const rl = (resetUs || 200) * 1e-6;
  const rs = runs(ctx, ch, 0, ctx.n - 1);
  const ev = [], bytes = [];
  let slots = [];
  const flush = () => {
    for (let s = 0; s + 8 <= slots.length; s += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v |= slots[s + k].v << k;      // 1-Wire 一个字节是 LSB 先
      bytes.push({ value: v, i0: slots[s].i0, i1: slots[s + 7].i1 });
    }
    slots = [];
  };
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    const dur = (r.i1 - r.i0 + 1) / ctx.rate;
    if (r.v !== 0) continue;
    if (dur >= rl) {                                             // 复位脉冲（主机拉低 >= 200µs）
      flush();
      ev.push({ type: "reset", i0: r.i0, i1: r.i1, dur });
      for (let k = i + 1; k < rs.length && k <= i + 4; k++) {     // 之后设备会拉低一下 = 存在脉冲
        const r2 = rs[k];
        if ((r2.i0 - r.i1) / ctx.rate > 1.2e-3) break;
        if (r2.v === 0) { ev.push({ type: "presence", i0: r2.i0, i1: r2.i1, dur: (r2.i1 - r2.i0 + 1) / ctx.rate }); i = k; break; }
      }
      continue;
    }
    // 比特槽：低段起点后 20µs 处采样 —— 写 1 / 器件回 1 那时已经释放为高，写 0 / 回 0 还是低
    // 采样点要落在低段**之后**（写 1 的低段只有几个 µs），所以别夹到 r.i1 上
    const at20 = Math.min(r.i0 + ctx.t2i(20e-6), ctx.n - 1);
    slots.push({ i0: r.i0, i1: r.i1, v: ctx.at(ch, at20) ? 1 : 0 });
    if (slots.length >= 8) flush();
  }
  flush();
  return { ev, bytes };
}

const ROM_CMD = { 0x33: "读 ROM", 0xcc: "跳过 ROM", 0x55: "匹配 ROM", 0xf0: "搜索 ROM", 0xec: "告警搜索" };

const oneWireDec = {
  name: "1-Wire",
  cat: "总线",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "resetUs", t: "num", l: "复位低电平(µs)", d: 200, min: 50 },
  ],
  decode(ctx, p) {
    const { ev, bytes } = oneWireScan(ctx, p.ch, p.resetUs);
    const out = [];
    for (const e of ev) {
      out.push(e.type === "reset"
        ? it(e.i0, e.i1, "start", "复位", { us: +(e.dur * 1e6).toFixed(0) })
        : it(e.i0, e.i1, "ack", "存在脉冲", { us: +(e.dur * 1e6).toFixed(0) }));
    }
    let fresh = true;                                  // 复位后的第一个字节才是 ROM 命令
    for (const b of bytes) {
      const nm = fresh ? ROM_CMD[b.value] : null;
      fresh = false;
      out.push(it(b.i0, b.i1, "data", hx(b.value) + (nm ? " " + nm : ""), { byte: hx(b.value), romCmd: nm || null }));
    }
    return out.sort((a, b) => a.i0 - b.i0);
  },
};

const DF_CMD = { 0x44: "转换温度", 0xbe: "读暂存器", 0x4e: "写暂存器", 0x48: "复制暂存器", 0xb8: "召回 E2", 0xb4: "读电源" };

const ds18b20Dec = {
  name: "DS18B20",
  cat: "传感",
  params: [{ k: "ch", t: "ch", l: "通道" }],
  decode(ctx, p) {
    const { ev, bytes } = oneWireScan(ctx, p.ch, 200);
    const out = [];
    for (const e of ev) {
      out.push(e.type === "reset" ? it(e.i0, e.i1, "start", "复位", {}) : it(e.i0, e.i1, "ack", "存在脉冲", {}));
    }
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const nm = DF_CMD[b.value] || ROM_CMD[b.value];
      out.push(it(b.i0, b.i1, "data", hx(b.value) + (nm ? " " + nm : ""), { byte: hx(b.value), name: nm || null }));
      if (b.value === 0xbe && i + 9 < bytes.length) {                  // 读暂存器：9 个字节，前两个是温度
        const sp = bytes.slice(i + 1, i + 10).map((x) => x.value);
        const raw = ((sp[1] << 8) | sp[0]) & 0xffff;
        const temp = ((raw & 0x8000 ? raw - 0x10000 : raw) / 16);
        const crcOk = crc8_31(sp.slice(0, 8)) === sp[8];
        out.push(it(bytes[i + 1].i0, bytes[i + 9].i1, crcOk ? "ack" : "err",
          "温度 " + temp.toFixed(4) + " °C" + (crcOk ? " ✓" : " CRC 错"),
          { temp_c: +temp.toFixed(4), th: sp[2], tl: sp[3], config: hx(sp[4]), crcOk }));
        i += 9;
      }
    }
    return out.sort((a, b) => a.i0 - b.i0);
  },
};

/* ============================ DHT11 / DHT22 ============================ */

const dhtDec = {
  name: "DHT11 / DHT22",
  cat: "传感",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "model", t: "enum", l: "型号", vals: ["DHT22", "DHT11"], d: "DHT22" },
  ],
  // 单总线：主机拉低 >=1ms → 器件应答（低 80µs + 高 80µs）→ 40 个比特（低 50µs + 高 26~28µs=0 / 70µs=1）
  decode(ctx, p) {
    const rs = runs(ctx, p.ch, 0, ctx.n - 1);
    let st = -1;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].v === 0 && (rs[i].i1 - rs[i].i0 + 1) / ctx.rate >= 0.8e-3) { st = i; break; }
    }
    if (st < 0) return [it(0, ctx.n - 1, "err", "没找到主机起始（>=1ms 低电平）", {})];
    let i = st + 1;
    while (i < rs.length && rs[i].v !== 0 && (rs[i].i0 - rs[st].i1) / ctx.rate < 1e-3) i++;   // 越过释放间隔
    const respLow = i < rs.length && rs[i].v === 0 ? rs[i++] : null;      // 器件应答：低
    const respHigh = i < rs.length && rs[i].v === 1 ? rs[i++] : null;     // 器件应答：高
    const bits = [];
    let last = null;
    for (; i < rs.length && bits.length < 40; i++) {
      if (rs[i].v !== 1) continue;
      const prev = rs[i - 1];
      if (!prev || prev.v !== 0) break;
      last = rs[i];
      bits.push((rs[i].i1 - rs[i].i0 + 1) / ctx.rate > 45e-6 ? 1 : 0);
    }
    if (bits.length < 40) return [it(rs[st].i0, last ? last.i1 : rs[st].i1, "err", "只收到 " + bits.length + "/40 位", {})];
    const by = [];
    for (let s = 0; s < 40; s += 8) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[s + k]; by.push(v); }
    const sum = (by[0] + by[1] + by[2] + by[3]) & 0xff;
    const crcOk = sum === by[4];
    let hum, temp;
    if (p.model === "DHT11") { hum = by[0] + by[1] / 10; temp = by[2] + by[3] / 10; }
    else {
      hum = ((by[0] << 8) | by[1]) / 10;
      const t = ((by[2] << 8) | by[3]);
      temp = (t & 0x8000 ? (t & 0x7fff) * -1 : t) / 10;
    }
    return [
      it(rs[st].i0, respHigh ? respHigh.i1 : rs[st].i1, "start", "主机起始", { us: +(((rs[st].i1 - rs[st].i0 + 1) / ctx.rate) * 1e6).toFixed(0) }),
      it(respLow ? respLow.i0 : rs[st].i1, last.i1, crcOk ? "ack" : "err",
        p.model + " 湿度 " + hum.toFixed(1) + "% 温度 " + temp.toFixed(1) + " °C" + (crcOk ? " ✓" : " 校验错"),
        { model: p.model, humidity: +hum.toFixed(1), temp_c: +temp.toFixed(1), crcOk, bytes: by.map((x) => hx(x)) }),
    ];
  },
};

/* ============================ PS/2 ============================ */

const ps2Dec = {
  name: "PS/2",
  cat: "总线",
  params: [
    { k: "clk", t: "ch", l: "CLK" },
    { k: "data", t: "ch", l: "DATA" },
    { k: "dir", t: "enum", l: "方向", vals: ["设备→主机", "主机→设备"], d: "设备→主机" },
  ],
  // 11 位一帧：起始 0 + 8 位数据（LSB 先）+ 奇校验 + 停止 1。设备发的是时钟下降沿有效，主机发的是上升沿。
  decode(ctx, p) {
    const out = [];
    let bits = [], i0 = -1;
    for (let i = 1; i < ctx.n; i++) {
      const c0 = ctx.at(p.clk, i - 1), c1 = ctx.at(p.clk, i);
      const edge = p.dir === "主机→设备" ? (c0 === 0 && c1 === 1) : (c0 === 1 && c1 === 0);
      if (!edge) continue;
      if (!bits.length) i0 = i;
      bits.push(ctx.at(p.data, i));
      if (bits.length === 11) {
        let v = 0, ones = 0;
        for (let k = 0; k < 8; k++) { v |= bits[1 + k] << k; if (bits[1 + k]) ones++; }
        const startOk = bits[0] === 0, stopOk = bits[10] === 1, parityOk = (ones + bits[9]) % 2 === 1;
        const ok = startOk && stopOk && parityOk;
        out.push(it(i0, i, ok ? "data" : "err",
          hx(v) + (chOf(v) ? " '" + chOf(v) + "'" : "") + (ok ? "" : " 帧错"),
          { byte: hx(v), startOk, stopOk, parityOk }));
        bits = [];
      }
    }
    return out;
  },
};

/* ============================ NEC 红外 ============================ */

const necDec = {
  name: "NEC 红外",
  cat: "红外",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "active", t: "enum", l: "载波电平", vals: ["低（一体化接收头）", "高"], d: "低（一体化接收头）" },
  ],
  // 引导 9ms + 4.5ms；数据位 = 560µs 载波 + 间隔（560µs=0 / 1690µs=1）；32 位 = 地址 + ~地址 + 命令 + ~命令（LSB 先）
  decode(ctx, p) {
    const mk = p.active === "高" ? 1 : 0;
    const rs = runs(ctx, p.ch, 0, ctx.n - 1);
    const out = [];
    let i = 0;
    while (i < rs.length) {
      const r = rs[i];
      const dur = (r.i1 - r.i0 + 1) / ctx.rate;
      if (r.v !== mk || dur < 100e-6 || i + 1 >= rs.length) { i++; continue; }
      const space = (rs[i + 1].i1 - rs[i + 1].i0 + 1) / ctx.rate;
      if (dur > 4e-3) {                                          // 引导码（一帧）或重复码（9ms + 2.25ms）
        const bits = [];
        let j = i + 2;
        while (bits.length < 32 && j + 1 < rs.length) {
          const m = rs[j], sp = rs[j + 1];
          if (m.v !== mk || sp.v === mk) break;
          const md = (m.i1 - m.i0 + 1) / ctx.rate;
          if (md < 200e-6 || md > 1.2e-3) break;
          bits.push((sp.i1 - sp.i0 + 1) / ctx.rate > 1.1e-3 ? 1 : 0);
          j += 2;
        }
        if (bits.length === 0) {                                 // 只有引导、没有数据位 = 重复码
          out.push(it(r.i0, rs[i + 1] ? rs[i + 1].i1 : r.i1, "ctrl", "重复码", { space_us: +(space * 1e6).toFixed(0) }));
          i += 2; continue;
        }
        const endI = rs[Math.min(j - 1, rs.length - 1)].i1;
        if (bits.length === 32) {
          const byte = (a) => { let v = 0; for (let k = 0; k < 8; k++) v |= a[k] << k; return v; };
          const addr = byte(bits.slice(0, 8)), naddr = byte(bits.slice(8, 16));
          const cmd = byte(bits.slice(16, 24)), ncmd = byte(bits.slice(24, 32));
          const ok = ((addr ^ naddr) === 0xff) && ((cmd ^ ncmd) === 0xff);
          out.push(it(r.i0, endI, ok ? "data" : "err",
            "NEC 地址 " + hx(addr) + " 命令 " + hx(cmd) + (ok ? "" : " 取反校验错"),
            { addr: hx(addr), cmd: hx(cmd), addrOk: (addr ^ naddr) === 0xff, cmdOk: (cmd ^ ncmd) === 0xff }));
        } else {
          out.push(it(r.i0, endI, "err", "位不全（" + bits.length + "/32）", {}));
        }
        i = j; continue;
      }
      i++;
    }
    return out;
  },
};

/* ============================ I2S ============================ */

const i2sDec = {
  name: "I2S",
  cat: "音频",
  params: [
    { k: "sck", t: "ch", l: "SCK" },
    { k: "ws", t: "ch", l: "WS" },
    { k: "sd", t: "ch", l: "SD" },
    { k: "bits", t: "enum", l: "位深", vals: [16, 24, 32], d: 16 },
    { k: "fmt", t: "enum", l: "格式", vals: ["I2S（标准）", "左对齐", "右对齐"], d: "I2S（标准）" },
    { k: "wsPol", t: "enum", l: "声道", vals: ["低=左", "高=左"], d: "低=左" },
  ],
  decode(ctx, p) {
    const bits = p.bits || 16;
    const leftLow = p.wsPol !== "高=左";
    const edges = [];
    for (let i = 1; i < ctx.n; i++) {
      const c0 = ctx.at(p.sck, i - 1), c1 = ctx.at(p.sck, i);
      if (c0 === 0 && c1 === 1) {
        const ws = ctx.at(p.ws, i);
        const chn = leftLow ? (ws === 0 ? "L" : "R") : (ws === 1 ? "L" : "R");
        edges.push({ i, chn, b: ctx.at(p.sd, i) });
      }
    }
    if (edges.length < bits * 2) return [it(0, ctx.n - 1, "err", "边沿太少（是不是没接 SCK？）", {})];
    // 按 WS 分组 = 一个声道一个槽；槽长取"完整槽"的众数
    const groups = [];
    for (const e of edges) {
      if (!groups.length || groups[groups.length - 1].chn !== e.chn) groups.push({ chn: e.chn, list: [] });
      groups[groups.length - 1].list.push(e);
    }
    const full = groups.filter((g) => g.list.length >= bits);
    const slotLen = full.length ? Math.min(...full.map((g) => g.list.length)) : bits;
    const out = [];
    for (const g of groups) {
      if (g.list.length < bits) continue;
      const off = p.fmt === "右对齐" ? g.list.length - bits : 0;
      let v = 0;
      for (let k = 0; k < bits; k++) v = ((v << 1) | g.list[off + k].b) >>> 0;
      const signed = bits === 32 ? (v | 0) : ((v & (1 << (bits - 1))) ? v - (1 << bits) : v);
      out.push(it(g.list[off].i, g.list[off + bits - 1].i, g.chn === "L" ? "data" : "addr",
        g.chn + " " + hx(v, bits / 4) + " (" + signed + ")",
        { ch: g.chn, value: v, signed, bits, slotBits: g.list.length }));
    }
    return out;
  },
};
/* ============================ CAN 2.0A/B ============================ */

/** CAN 的 CRC-15（poly 0x4599） */
function canCrc15(bits) {
  let crc = 0;
  for (const b of bits) {
    const nxt = ((crc >> 14) & 1) ^ b;
    crc = (crc << 1) & 0x7fff;
    if (nxt) crc ^= 0x4599;
  }
  return crc & 0x7fff;
}

const canDec = {
  name: "CAN 2.0",
  cat: "总线",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "bitrate", t: "num", l: "比特率", d: 250000, min: 1000, step: 1000 },
  ],
  // 空闲=隐性(1)，SOF 是显性(0)；SOF~CRC 之间做位填充（连续 5 个相同位后面跟一个填充位）
  decode(ctx, p) {
    const T = 1 / (p.bitrate || 250000);
    const out = [];
    let i = 1;
    while (i < ctx.n) {
      if (!(ctx.at(p.ch, i - 1) === 1 && ctx.at(p.ch, i) === 0)) { i++; continue; }
      const t0 = i / ctx.rate;
      const raw = (k) => ctx.at(p.ch, ctx.t2i(t0 + (k + 0.5) * T));
      let k = 0, run = 0, prev = -1, stuffing = true;
      const seq = [];                                        // 去过填充的位（含 SOF）
      const read = () => {
        let v = raw(k++);
        if (stuffing && run === 5) { v = raw(k++); run = 0; prev = -1; }      // 5 个相同位后面那位一定是填充位
        if (v === prev) run++; else { run = 1; prev = v; }
        seq.push(v);
        return v;
      };
      const readN = (n) => { let v = 0; for (let q = 0; q < n; q++) v = (v << 1) | read(); return v; };
      const sof = read();
      const idA = readN(11);
      const rtrA = read();
      const ide = read();
      let id = idA, rtr = rtrA, ext = !!ide;
      if (ide) { id = (idA * 0x40000 + readN(18)) >>> 0; rtr = read(); read(); read(); }
      else read();
      const dlc = Math.min(8, readN(4));
      const data = [];
      for (let q = 0; q < dlc; q++) data.push(readN(8));
      const seqLen = seq.length;
      const crc = readN(15);
      const crcCalc = canCrc15(seq.slice(0, seqLen));
      stuffing = false;
      const crcDelim = read(), ack = read(), ackDelim = read();
      const eof = readN(7);
      const formOk = sof === 0 && crcDelim === 1 && ackDelim === 1 && eof === 0x7f;
      const ackOk = ack === 0;
      const crcOk = crc === crcCalc;
      const endI = Math.min(ctx.n - 1, ctx.t2i(t0 + (k + 1) * T));
      const head = (ext ? "扩展 0x" + id.toString(16).toUpperCase() : "0x" + id.toString(16).toUpperCase().padStart(3, "0"));
      const txt = head + (rtr ? " RTR" : "") + " [" + dlc + "]" + (dlc ? " " + hexBytes(data.slice(0, 4)) + (dlc > 4 ? "…" : "") : "");
      out.push(it(i, endI, formOk && crcOk && ackOk ? "data" : "err",
        txt + (formOk ? "" : " 帧格式错") + (crcOk ? "" : " CRC 错") + (ackOk ? "" : " 无应答"),
        { id: "0x" + id.toString(16).toUpperCase(), ext, rtr: !!rtr, dlc, data: data.map((b) => hx(b)), crc: hx(crc, 4), crcOk, ack: ackOk, formOk }));
      i = Math.max(i + 1, endI);
    }
    return out;
  },
};

/* ============================ JTAG ============================ */

// IEEE 1149.1 TAP 状态机：[TMS=0 去哪, TMS=1 去哪]
const TAP = [
  [1, 0], [1, 2], [3, 9], [4, 5], [4, 5], [6, 8], [6, 7], [4, 8],
  [1, 2], [10, 0], [11, 12], [11, 12], [13, 15], [13, 14], [11, 15], [1, 2],
];
const TAP_NAME = ["复位", "空闲", "选 DR", "捕获 DR", "移位 DR", "退出1 DR", "暂停 DR", "退出2 DR", "更新 DR",
  "选 IR", "捕获 IR", "移位 IR", "退出1 IR", "暂停 IR", "退出2 IR", "更新 IR"];

const jtagDec = {
  name: "JTAG",
  cat: "调试",
  params: [
    { k: "tck", t: "ch", l: "TCK" },
    { k: "tms", t: "ch", l: "TMS" },
    { k: "tdi", t: "ch0", l: "TDI", d: -1 },
    { k: "tdo", t: "ch0", l: "TDO", d: -1 },
  ],
  // TCK 上升沿取 TMS 走状态机；在 Shift-DR / Shift-IR 里顺带把 TDI/TDO 移进来
  decode(ctx, p) {
    const out = [];
    let st = 0, shift = null;            // shift = { kind:'IR'|'DR', tdi:[], tdo:[], i0, bits }
    const finish = (endI) => {
      if (!shift) return;
      const n = shift.tdi.length;
      const val = (arr) => { let v = 0; for (let k = 0; k < arr.length && k < 32; k++) v = ((v << 1) | arr[k]) >>> 0; return v; };
      const parts = [];
      if (p.tdi >= 0) parts.push("TDI " + hx(val(shift.tdi), Math.ceil(n / 4)));
      if (p.tdo >= 0) parts.push("TDO " + hx(val(shift.tdo), Math.ceil(n / 4)));
      out.push(it(shift.i0, endI, shift.kind === "IR" ? "addr" : "data",
        "移位 " + shift.kind + " " + n + " 位 " + (parts.join(" ") || ""), { field: shift.kind, bits: n, tdi: parts[0] || null, tdo: parts[1] || null }));
      shift = null;
    };
    for (let i = 1; i < ctx.n; i++) {
      const c0 = ctx.at(p.tck, i - 1), c1 = ctx.at(p.tck, i);
      if (!(c0 === 0 && c1 === 1)) continue;                     // 上升沿
      const tms = ctx.at(p.tms, i);
      const prev = st;
      if (st === 0 && prev !== 0) { /* noop */ }
      st = TAP[st][tms ? 1 : 0];
      if (st === 0 && prev !== 0) out.push(it(i, i + 2, "start", "TAP 复位", {}));
      const wasShift = prev === 4 || prev === 11;       // 这一拍之前就在移位态，才搬数据
      const isShift = st === 4 || st === 11;
      const kind = st === 11 ? "IR" : "DR";
      if (isShift) {
        if (!shift || shift.kind !== kind) { finish(i); shift = { kind, tdi: [], tdo: [], i0: i }; }
        if (wasShift) {
          if (p.tdi >= 0) shift.tdi.push(ctx.at(p.tdi, i));
          if (p.tdo >= 0) shift.tdo.push(ctx.at(p.tdo, i));
        }
      } else if (shift) finish(i);
    }
    finish(ctx.n - 1);
    return out;
  },
};

/* ============================ SWD ============================ */

const swdDec = {
  name: "SWD",
  cat: "调试",
  params: [
    { k: "clk", t: "ch", l: "SWCLK" },
    { k: "dio", t: "ch", l: "SWDIO" },
  ],
  // 8 位请求：起始1 / APnDP / RnW / A[2] / A[3] / 偶校验 / 停止0 / 停放1；回一个 turnaround + 3 位 ACK
  decode(ctx, p) {
    const ed = [];
    for (let i = 1; i < ctx.n; i++) {
      if (ctx.at(p.clk, i - 1) === 0 && ctx.at(p.clk, i) === 1) ed.push({ i, v: ctx.at(p.dio, i) });
    }
    const out = [];
    let s = 0;
    while (s + 8 <= ed.length) {
      const b = ed.slice(s, s + 8).map((x) => x.v);
      const parOk = (b[1] ^ b[2] ^ b[3] ^ b[4]) === b[5];
      if (!(b[0] === 1 && b[6] === 0 && b[7] === 1 && parOk)) { s++; continue; }
      const apndp = b[1], rnw = b[2], a = ((((b[4] << 1) | b[3]) & 3) << 2);   // A[3:2] → 字节地址
      let e = s + 9;                                     // 跳过 turnaround
      const ackBits = [];
      for (let k = 0; k < 3 && e < ed.length; k++, e++) ackBits.push(ed[e].v);
      const ack = (ackBits[0] | (ackBits[1] << 1) | (ackBits[2] << 2)) & 7;
      const ackTxt = ack === 1 ? "OK" : ack === 2 ? "WAIT" : ack === 4 ? "FAULT" : "ACK 无效";
      const parts = [(apndp ? "AP" : "DP"), (rnw ? "读" : "写"), "A=" + hx(a, 2), ackTxt];
      let val = null;
      if (ack === 1 && rnw) {                            // 读：32 位数据 + 校验
        const db = [];
        for (let k = 0; k < 33 && e < ed.length; k++, e++) db.push(ed[e].v);
        if (db.length === 33) {
          let v = 0, ones = 0;
          for (let k = 0; k < 32; k++) { v = ((v << 1) | db[k]) >>> 0; if (db[k]) ones++; }
          val = v;
          parts.push("→ " + hx(v, 8) + ((ones % 2) === db[32] ? "" : " 校验错"));
        }
      }
      out.push(it(ed[s].i, ed[Math.min(e - 1, ed.length - 1)].i, ack === 1 ? "data" : "err", parts.join(" "),
        { apndp: apndp ? "AP" : "DP", rw: rnw ? "read" : "write", addr: a, ack: ackTxt, value: val == null ? null : hx(val, 8) }));
      s = e;
    }
    return out;
  },
};

/* ============================ Modbus RTU（跑在串口上） ============================ */

const MB_FC = { 0x01: "读线圈", 0x02: "读离散量", 0x03: "读保持寄存器", 0x04: "读输入寄存器", 0x05: "写单线圈", 0x06: "写单寄存器", 0x0f: "写多线圈", 0x10: "写多寄存器" };

const modbusDec = {
  name: "Modbus RTU",
  cat: "现场总线",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "baud", t: "num", l: "波特率", d: 9600, min: 1200 },
    { k: "parity", t: "enum", l: "校验", vals: ["none", "even", "odd"], d: "none" },
    { k: "stop", t: "enum", l: "停止位", vals: [1, 2], d: 1 },
  ],
  // Modbus RTU：帧之间靠 >=3.5 个字符时间的静默分隔，最后两个字节是 CRC-16
  decode(ctx, p) {
    const baud = p.baud || 9600;
    const gap = Math.round(3.5 / baud * ctx.rate);
    const bytes = uartBytes(ctx, Object.assign({ polarity: "idle high", dataBits: 8 }, p));
    const out = [];
    let frame = [];
    const flush = () => {
      if (frame.length >= 4) {
        const body = frame.map((x) => x.value);
        const data = body.slice(0, -2);
        const crcGot = body[body.length - 2] | (body[body.length - 1] << 8);
        const crcOk = crc16_modbus(data) === crcGot;
        const addr = body[0], fc = body[1];
        let detail = "";
        if ((fc === 1 || fc === 2) && body.length >= 8) detail = "线圈 " + ((body[2] << 8) | body[3]) + " ×" + ((body[4] << 8) | body[5]);
        else if (fc === 3 || fc === 4) {
          if (body.length === 8) detail = "寄 " + ((body[2] << 8) | body[3]) + " 值 " + ((body[4] << 8) | body[5]);
          else if (body.length >= 5 && body[2] === (body.length - 5)) {
            const vals = [];
            for (let k = 3; k + 1 < body.length - 2; k += 2) vals.push("0x" + (((body[k] << 8) | body[k + 1]).toString(16).toUpperCase()));
            detail = vals.join(" ");
          }
        } else if (fc === 6 || fc === 5) detail = "寄 " + ((body[2] << 8) | body[3]) + " ← " + ("0x" + (((body[4] << 8) | body[5]).toString(16).toUpperCase()));
        else if (fc === 0x10) detail = "写 " + ((body[4] << 8) | body[5]) + " 个寄存器";
        out.push(it(frame[0].i0, frame[frame.length - 1].i1, crcOk ? "data" : "err",
          "从站 " + addr + " " + (MB_FC[fc] || "FC" + hx(fc, 2)) + (detail ? " " + detail : "") + (crcOk ? "" : " CRC 错"),
          { slave: addr, fc: MB_FC[fc] || hx(fc, 2), bytes: body.map((b) => hx(b)), crcOk, detail }));
      }
      frame = [];
    };
    for (const b of bytes) {
      if (frame.length && b.i0 - frame[frame.length - 1].i1 > gap) flush();
      frame.push(b);
    }
    flush();
    return out;
  },
};

/* ============================ LIN ============================ */

const linDec = {
  name: "LIN",
  cat: "现场总线",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "baud", t: "num", l: "波特率", d: 19200, min: 1000 },
  ],
  // 断帧（>=11 位低） + 同步 0x55 + PID（6 位 ID + 2 位奇偶），后面是数据 + 校验（ID<60 用经典和，>=60 用 CRC-8）
  decode(ctx, p) {
    const baud = p.baud || 19200;
    const bt = 1 / baud;
    const rs = runs(ctx, p.ch, 0, ctx.n - 1);
    const out = [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (r.v !== 0) continue;
      const dur = (r.i1 - r.i0 + 1) / ctx.rate;
      if (dur < 11 * bt) continue;                                   // 断帧
      out.push(it(r.i0, r.i1, "start", "断帧 " + (dur * 1e6 / 1e6 * 1000).toFixed(2) + " ms", {}));
      const bytes = uartBytes(ctx, { ch: p.ch, baud, dataBits: 8, parity: "none", stop: 1, polarity: "idle high" }, r.i1 + Math.round(bt * 2) * 0);
      const seg = bytes.filter((b) => b.i0 > r.i1);
      if (seg.length < 3) continue;
      const sync = seg[0].value, pid = seg[1].value;
      if (sync !== 0x55) { out.push(it(seg[0].i0, seg[1].i1, "err", "同步字不是 0x55（" + hx(sync) + "）", {})); i++; continue; }
      const id = pid & 0x3f;
      const p0 = (id & 1) ^ ((id >> 1) & 1) ^ ((id >> 2) & 1) ^ ((id >> 4) & 1);
      const p1 = !(((id >> 1) & 1) ^ ((id >> 3) & 1) ^ ((id >> 4) & 1) ^ ((id >> 5) & 1));
      const pidOk = ((pid >> 6) & 1) === p0 && ((pid >> 7) & 1) === (p1 ? 1 : 0);
      const body = seg.slice(2);
      const data = body.slice(0, -1).map((x) => x.value), ck = body[body.length - 1].value;
      const calc = id < 60
        ? (~data.reduce((a, b) => a + b, 0)) & 0xff
        : crc8_31([pid].concat(data));
      const ckOk = calc === ck;
      out.push(it(seg[1].i0, body[body.length - 1].i1, ckOk && pidOk ? "data" : "err",
        "ID " + hx(id, 2) + " 数据 " + (data.length ? hexBytes(data) : "—") + (pidOk ? "" : " PID 校验错") + (ckOk ? "" : " 校验错"),
        { id: "0x" + id.toString(16).toUpperCase(), data: data.map((b) => hx(b)), pidOk, checksumOk: ckOk, checksum: id < 60 ? "classic" : "enhanced" }));
      i++;
    }
    return out;
  },
};

/* ============================ DMX512 ============================ */

const dmxDec = {
  name: "DMX512",
  cat: "现场总线",
  params: [
    { k: "ch", t: "ch", l: "通道" },
    { k: "slots", t: "num", l: "显示前几个槽", d: 8, min: 1, max: 64 },
  ],
  // 250kbaud 8N2：断帧（>=88µs 低） + 起始码 + 最多 512 个槽，每槽 44µs
  decode(ctx, p) {
    const baud = 250000;
    const rs = runs(ctx, p.ch, 0, ctx.n - 1);
    const out = [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (r.v !== 0 || (r.i1 - r.i0 + 1) / ctx.rate < 88e-6) continue;
      out.push(it(r.i0, r.i1, "start", "断帧", {}));
      const bytes = uartBytes(ctx, { ch: p.ch, baud, dataBits: 8, parity: "none", stop: 2, polarity: "idle high" }).filter((b) => b.i0 > r.i1);
      if (!bytes.length) continue;
      const show = Math.max(1, Math.min(64, p.slots || 8));
      out.push(it(bytes[0].i0, bytes[0].i1, "ctrl", "起始码 " + hx(bytes[0].value), { startCode: hx(bytes[0].value) }));
      for (let k = 1; k < bytes.length && k <= show; k++) {
        out.push(it(bytes[k].i0, bytes[k].i1, "data", "CH" + k + "=" + bytes[k].value, { slot: k, value: bytes[k].value }));
      }
      if (bytes.length > show + 1) {
        const last = bytes[bytes.length - 1];
        out.push(it(bytes[show].i1, last.i1, "ctrl", "… 共 " + (bytes.length - 1) + " 个槽", { slots: bytes.length - 1 }));
      }
      i++;
    }
    return out;
  },
};
/* ============================ 注册表 + 对外接口 ============================ */

export const DECODERS = {
  uart: uartDec,
  spi: spiDec,
  i2c: i2cDec,
  pwm: pwmDec,
  manchester: manDec,
  diff_manchester: dmanDec,
  miller: millerDec,
  onewire: oneWireDec,
  ds18b20: ds18b20Dec,
  dht: dhtDec,
  ps2: ps2Dec,
  nec: necDec,
  i2s: i2sDec,
  can: canDec,
  jtag: jtagDec,
  swd: swdDec,
  modbus: modbusDec,
  lin: linDec,
  dmx512: dmxDec,
};

/** 下拉里的分组顺序 */
export const DEC_CATS = ["串行", "总线", "编码", "调试", "现场总线", "传感", "音频", "红外", "测量"];

/** 协议清单（UI 下拉 + agent 的 la_decoders 都用它） */
export function decList() {
  return Object.keys(DECODERS).map((k) => ({
    kind: k, name: DECODERS[k].name, cat: DECODERS[k].cat,
    params: DECODERS[k].params.map((p) => ({ k: p.k, t: p.t, l: p.l, d: p.d, min: p.min, max: p.max, vals: p.vals })),
  }));
}

/** 新建一个解码器时的默认参数（sel = 当前选中的通道，拿来当默认通道） */
export function decDefaults(kind, sel, nch) {
  const spec = DECODERS[kind];
  if (!spec) return null;
  const n = nch || 1;
  const d = { kind };
  let auto = Math.max(0, Math.min(n - 1, sel || 0));
  for (const p of spec.params) {
    if (p.t === "ch") d[p.k] = p.d != null ? p.d : auto++;
    else if (p.t === "ch0") d[p.k] = p.d != null ? p.d : -1;
    else if (p.t === "num") d[p.k] = p.d != null ? p.d : (p.min != null ? p.min : 0);
    else if (p.t === "enum") d[p.k] = p.d != null ? p.d : (p.vals ? p.vals[0] : null);
  }
  return d;
}

/** 校验 + 补齐一份解码器配置（agent 传进来的东西不可信） */
export function normalizeDec(d, nch) {
  const spec = DECODERS[d && d.kind];
  if (!spec) return { err: "不认识的解码器：" + (d && d.kind) + "（用 la_decoders 看支持哪些）" };
  const out = { kind: d.kind };
  for (const p of spec.params) {
    const v = d[p.k];
    if (p.t === "ch" || p.t === "ch0") {
      const n = Number(v);
      if (p.t === "ch0" && (v == null || v === "" || !(n >= 0))) { out[p.k] = -1; continue; }
      if (!(n >= 0 && n < nch)) return { err: p.l + " 通道越界：" + JSON.stringify(v) + "（有 " + nch + " 路，0~" + (nch - 1) + "）" };
      out[p.k] = n;
    } else if (p.t === "num") {
      let n = Number(v);
      if (!isFinite(n)) n = p.d != null ? p.d : 0;
      if (p.min != null && n < p.min) n = p.min;
      if (p.max != null && n > p.max) n = p.max;
      out[p.k] = n;
    } else {
      const vals = p.vals || [];
      out[p.k] = vals.indexOf(v) >= 0 ? v : (p.d != null ? p.d : vals[0]);
    }
  }
  return { dec: out };
}

/** 一行话描述一个解码器的配置（界面 + agent 都显示） */
export function decBrief(d) {
  const spec = DECODERS[d.kind];
  if (!spec) return String(d.kind);
  const parts = spec.params.map((p) => {
    const v = d[p.k];
    if (p.t === "ch0") return v == null || v < 0 ? null : p.l + "=CH" + v;
    if (p.t === "ch") return p.l + "=CH" + v;
    return p.l + "=" + v;
  }).filter(Boolean);
  return spec.name + " " + parts.join(" ");
}

/** 跑一个解码器；出错不让它把整页带崩 */
export function decodeItems(ctx, d) {
  const spec = DECODERS[d.kind];
  if (!spec) return [];
  let items;
  try { items = spec.decode(ctx, d) || []; } catch (e) {
    return [it(0, ctx.n - 1, "err", "解码出错：" + (e && e.message ? e.message : e), {})];
  }
  return items.sort((a, b) => a.i0 - b.i0);
}

/** 给 agent 的 JSON 形式（带 aux 里的细节） */
export function fmtItems(items, rate, tail) {
  const n = tail || items.length;
  return items.slice(-n).map((x) => Object.assign({
    t0_us: +((x.i0 / rate) * 1e6).toFixed(3),
    t1_us: +((x.i1 / rate) * 1e6).toFixed(3),
    cls: x.cls,
    text: x.text,
  }, x.aux || {}));
}
