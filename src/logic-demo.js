// ── 逻辑分析仪：示例信号 ────────────────────────────────────────────────────
// 三个场景，每个场景都是"按协议规范手工拼出来的真实波形"（不是随机数），
// 装上对应的解码器就能看到字节/字段。纯计算：不碰 DOM / Tauri，Node 里能直接 import 自测。

const COLORS = ["#4ea1ff", "#ffd166", "#7ee787", "#ff8fa3", "#c792ea", "#7fd1e0", "#f5a97f", "#c9d1d9", "#9d7bff", "#56d4a0"];

const mkChans = (n, names) => names.map((nm, i) => ({ name: nm, color: COLORS[i % COLORS.length], bits: new Uint8Array(n), on: true }));
const put = (c, i0, i1, v) => {
  const a = Math.max(0, Math.round(i0)), b = Math.min(c.bits.length, Math.round(i1));
  for (let i = a; i < b; i++) c.bits[i] = v ? 1 : 0;
};
const fill = (c, v) => c.bits.fill(v ? 1 : 0);

/* ---------- 各种"按规范拼波形"的小工具（时间单位都是秒） ---------- */

/** 串口 8N1（或指定校验/停止位），返回结束时间 */
function uartPut(c, rate, t0, bytes, baud, o) {
  o = o || {};
  const db = o.dataBits || 8, par = o.parity || "none", stop = o.stop || 1;
  const inv = !!o.inv, bt = 1 / baud;
  let t = t0;
  const lvl = (v, n) => { put(c, (t) * rate, (t + bt * n) * rate, inv ? !v : v); t += bt * n; };
  for (const b of bytes) {
    lvl(0, 1);
    for (let k = 0; k < db; k++) lvl((b >> k) & 1, 1);
    if (par !== "none") {
      let ones = 0, x = b; while (x) { ones += x & 1; x >>= 1; }
      const pb = par === "even" ? ones % 2 : (ones % 2 ? 0 : 1);
      lvl(pb, 1);
    }
    lvl(1, stop);
  }
  return t;
}

/** I2C：起始 / 停止 / 一个字节 + 应答（SCL 高时数据有效，MSB 先到） */
function i2cStart(scl, sda, rate, t0) {
  const T = 1 / 100000;
  put(scl, t0 * rate, (t0 + T) * rate, 1);
  put(sda, t0 * rate, (t0 + T / 4) * rate, 1);
  put(sda, (t0 + T / 4) * rate, (t0 + T) * rate, 0);
  return t0 + T;
}
function i2cStop(scl, sda, rate, t0) {
  const T = 1 / 100000;
  put(scl, t0 * rate, (t0 + T / 4) * rate, 1);
  put(sda, t0 * rate, (t0 + T / 4) * rate, 0);
  put(scl, (t0 + T / 4) * rate, (t0 + T) * rate, 0);
  put(sda, (t0 + T / 4) * rate, (t0 + T) * rate, 1);
  return t0 + T;
}
function i2cByte(scl, sda, rate, t0, v, ack) {
  const T = 1 / 100000;
  let t = t0;
  const step = (bit) => {
    put(scl, t * rate, (t + T / 2) * rate, 0);
    put(sda, t * rate, (t + T) * rate, bit);
    put(scl, (t + T / 2) * rate, (t + T) * rate, 1);
    t += T;
  };
  for (let k = 7; k >= 0; k--) step((v >> k) & 1);
  step(ack ? 0 : 1);
  return t;
}

/** SPI 模式 0（CLK 空闲低、上升沿采样），一次 CS 拉低里连续搬几个字节 */
function spiPut(cs, clk, mosi, miso, rate, t0, mo, mi, hz) {
  const T = 1 / (hz || 250000);
  let t = t0;
  put(cs, t * rate, (t + mo.length * 8 * T) * rate, 0);
  for (let b = 0; b < mo.length; b++) for (let k = 0; k < 8; k++) {
    put(mosi, t * rate, (t + T) * rate, (mo[b] >> (7 - k)) & 1);
    if (miso) put(miso, t * rate, (t + T) * rate, ((mi[b] || 0) >> (7 - k)) & 1);
    put(clk, t * rate, (t + T / 2) * rate, 0);                  // 前半周期低（模式 0 的空闲电平）
    put(clk, (t + T / 2) * rate, (t + T) * rate, 1);
    t += T;
  }
  put(cs, t * rate, (t + 4 * T) * rate, 1);
  return t + 4 * T;
}

/** 1-Wire：复位 + 存在脉冲，然后按 LSB 先写一串字节 */
function owPut(c, rate, t0, bytes) {
  let t = t0;
  const lvl = (v, dur) => { put(c, t * rate, (t + dur) * rate, v); t += dur; };
  lvl(0, 480e-6); lvl(1, 70e-6);
  lvl(0, 120e-6); lvl(1, 30e-6);
  for (const b of bytes) for (let k = 0; k < 8; k++) {
    if ((b >> k) & 1) { lvl(0, 6e-6); lvl(1, 64e-6); }
    else { lvl(0, 60e-6); lvl(1, 10e-6); }
  }
  lvl(1, 60e-6);
  return t;
}

/** NEC 红外：9ms + 4.5ms 引导 + 32 位（地址/~地址/命令/~命令，LSB 先）；载波 = 低电平 */
function necPut(c, rate, t0, addr, cmd, repeat) {
  let t = t0;
  const lvl = (v, dur) => { put(c, t * rate, (t + dur) * rate, v); t += dur; };
  if (repeat) { lvl(0, 9000e-6); lvl(1, 2250e-6); lvl(1, 6e-3); return t; }
  const bits = [];
  const p8 = (v) => { for (let k = 0; k < 8; k++) bits.push((v >> k) & 1); };
  p8(addr); p8(addr ^ 0xff); p8(cmd); p8(cmd ^ 0xff);
  lvl(0, 9000e-6); lvl(1, 4500e-6);
  for (const b of bits) { lvl(0, 560e-6); lvl(1, b ? 1690e-6 : 560e-6); }
  lvl(1, 20e-3);
  return t;
}

/* ---------- 场景 1：常用总线 ---------- */
function buildBus() {
  const rate = 1e6, n = 100000;                     // 1 MHz × 100ms
  const ch = mkChans(n, ["CH0 UART", "CH1 PWM", "CH2 SCL", "CH3 SDA", "CH4 CS", "CH5 CLK", "CH6 MOSI", "CH7 MISO", "CH8 DQ", "CH9 IR"]);
  for (const c of ch) fill(c, 1);
  ch[8].bits.fill(1);
  // CH0：UART 115200 发 "KDock\n"
  uartPut(ch[0], rate, 0.5e-3, [..."KDock\n"].map((c) => c.charCodeAt(0)), 115200);
  // CH1：1 kHz / 25% PWM
  for (let i = 0; i < n; i++) ch[1].bits[i] = (i % 1000) < 250 ? 1 : 0;
  // CH2/CH3：I2C —— 先写 0x50 的 0x10 寄存器 = 0xA5，再读回来 0x5A
  {
    let t = 10e-3;
    t = i2cStart(ch[2], ch[3], rate, t);
    t = i2cByte(ch[2], ch[3], rate, t, 0xa0, true);
    t = i2cByte(ch[2], ch[3], rate, t, 0x10, true);
    t = i2cByte(ch[2], ch[3], rate, t, 0xa5, true);
    t = i2cStop(ch[2], ch[3], rate, t);
    t = i2cStart(ch[2], ch[3], rate, t);
    t = i2cByte(ch[2], ch[3], rate, t, 0xa1, true);
    t = i2cByte(ch[2], ch[3], rate, t, 0x5a, false);
    i2cStop(ch[2], ch[3], rate, t);
  }
  // CH4-CH7：SPI 读 JEDEC ID（0x9F → EF 40 18），MISO 同步回数据
  spiPut(ch[4], ch[5], ch[6], ch[7], rate, 20e-3, [0x9f, 0xff, 0xff, 0xff], [0x00, 0xef, 0x40, 0x18]);
  // CH8：DS18B20 —— 复位 + 跳过 ROM + 读暂存器（25.0625°C）
  {
    const sp = [0x91, 0x01, 0x1f, 0xff, 0x07, 0x00, 0x00, 0x00];
    let crc = 0;
    for (const b of sp) { let x = b; for (let k = 0; k < 8; k++) { const m = (crc ^ x) & 1; crc >>= 1; if (m) crc ^= 0x8c; x >>= 1; } }
    owPut(ch[8], rate, 30e-3, [0xcc, 0xbe].concat(sp, [crc & 0xff]));
  }
  // CH9：NEC 红外（地址 0x00 命令 0x16 + 一次重复码）
  necPut(ch[9], rate, 1e-3, 0x00, 0x16, false);      // NEC 一帧 ~68ms，放最前面
  necPut(ch[9], rate, 72e-3, 0, 0, true);            // 再来一次重复码
  return {
    rate, chans: ch,
    decoders: [
      { kind: "uart", ch: 0, baud: 115200, dataBits: 8, parity: "none", stop: 1, polarity: "idle high" },
      { kind: "pwm", ch: 1 },
      { kind: "i2c", scl: 2, sda: 3 },
      { kind: "spi", clk: 5, mosi: 6, miso: 7, cs: 4, mode: 0, order: "msb", wordSize: 8 },
      { kind: "ds18b20", ch: 8 },
      { kind: "nec", ch: 9, active: "低（一体化接收头）" },
    ],
    note: "UART 115200 · 1 kHz PWM · I2C 读写 · SPI 读 JEDEC ID · DS18B20 温度 · NEC 红外",
  };
}

export const SCENARIOS = {
  bus: { label: "常用总线（UART / PWM / I2C / SPI / DS18B20 / NEC）", build: buildBus },
  more: { label: "调试与音频（CAN / JTAG / I2S / PS2）", build: buildMore },
  enc: { label: "编码与工业总线（Manchester / DHT / LIN / Modbus / SWD / DMX）", build: buildEnc },
};

export function scenarioList() {
  return Object.keys(SCENARIOS).map((k) => ({ id: k, label: SCENARIOS[k].label }));
}
export function buildScenario(id) {
  const s = SCENARIOS[id] || SCENARIOS[Object.keys(SCENARIOS)[0]];
  return s ? s.build() : null;
}
/* ---------- 场景 2 要用的编码：CAN / JTAG / I2S / PS/2 ---------- */

/** CAN：SOF..CRC 之间做位填充；CRC-15 用 0x4599 */
function canCrc15(bits) {
  let crc = 0;
  for (const b of bits) { const nxt = ((crc >> 14) & 1) ^ b; crc = (crc << 1) & 0x7fff; if (nxt) crc ^= 0x4599; }
  return crc & 0x7fff;
}
function canPut(c, rate, t0, bitrate, o) {
  const bits = [];
  const push = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push((v >> k) & 1); };
  bits.push(0);
  push(o.ext ? (o.id >>> 18) & 0x7ff : o.id & 0x7ff, 11);
  bits.push(o.rtr ? 1 : 0);
  bits.push(o.ext ? 1 : 0);
  if (o.ext) { push(o.id & 0x3ffff, 18); bits.push(o.rtr ? 1 : 0); bits.push(0, 0); }
  else bits.push(0);
  push(o.data.length, 4);
  for (const b of o.data) push(b, 8);
  push(canCrc15(bits), 15);
  const stuffEnd = bits.length;
  bits.push(1, o.ack === false ? 1 : 0, 1);
  for (let k = 0; k < 7; k++) bits.push(1);
  const out = [];
  let run = 0, last = -1;
  for (let k = 0; k < bits.length; k++) {
    const v = bits[k];
    if (k < stuffEnd) {
      if (v === last) run++; else { run = 1; last = v; }
      out.push(v);
      if (run === 5) { out.push(v ^ 1); run = 0; last = -1; }
    } else out.push(v);
  }
  const T = 1 / bitrate;
  out.forEach((b, k) => put(c, (t0 + k * T) * rate, (t0 + (k + 1) * T) * rate, b));
  return t0 + out.length * T;
}

/** JTAG：给一串 {tms,tdi,tdo}，逐拍打（TCK 上升沿在周期中间） */
function jtagPut(tck, tms, tdi, tdo, rate, t0, seq, halfUs) {
  const T = (halfUs || 1) * 2e-6;
  let t = t0;
  for (const s of seq) {
    put(tms, t * rate, (t + T) * rate, s.tms ? 1 : 0);
    put(tdi, t * rate, (t + T) * rate, s.tdi ? 1 : 0);
    put(tdo, t * rate, (t + T) * rate, s.tdo ? 1 : 0);
    put(tck, t * rate, (t + T / 2) * rate, 0);
    put(tck, (t + T / 2) * rate, (t + T) * rate, 1);
    t += T;
  }
  return t;
}
/** 拼一段"复位 → 选 DR → 移位 → 更新 → 选 IR → 移位 → 更新"的 TAP 走位 */
function jtagSequence(drBits, irBits) {
  const seq = [];
  for (let k = 0; k < 5; k++) seq.push({ tms: 1 });                 // 复位（TMS 拉高 5 拍）
  seq.push({ tms: 0 });                                            // 空闲
  seq.push({ tms: 1 }, { tms: 0 }, { tms: 0 });                     // 选 DR → 捕获 DR → 移位 DR
  for (const b of drBits) seq.push({ tms: 0, tdi: b, tdo: b });
  seq.push({ tms: 1 }, { tms: 1 }, { tms: 0 });                     // 退出1 → 更新 → 空闲
  seq.push({ tms: 1 }, { tms: 1 }, { tms: 0 }, { tms: 0 });          // 选 DR → 选 IR → 捕获 IR → 移位 IR
  for (const b of irBits) seq.push({ tms: 0, tdi: b, tdo: b });
  seq.push({ tms: 1 }, { tms: 1 }, { tms: 0 });
  return seq;
}

/** I2S（左对齐）：WS 低 = 左声道，每声道 bits 位，SCK 上升沿采样 */
function i2sPut(sck, ws, sd, rate, t0, samples, bits, hz) {
  const T = 1 / (hz || 500000);
  let t = t0;
  for (const [chn, v] of samples) {
    for (let k = 0; k < bits; k++) {
      put(sd, t * rate, (t + T) * rate, (v >> (bits - 1 - k)) & 1);
      put(ws, t * rate, (t + T) * rate, chn);
      put(sck, t * rate, (t + T / 2) * rate, 0);
      put(sck, (t + T / 2) * rate, (t + T) * rate, 1);
      t += T;
    }
  }
  return t;
}

/** PS/2：设备→主机，一帧 11 位（起始 0 + 8 数据 LSB 先 + 奇校验 + 停止 1），时钟下降沿有效 */
function ps2Put(clk, data, rate, t0, bytes, periodUs) {
  const T = (periodUs || 80) * 1e-6;
  let t = t0;
  for (const by of bytes) {
    const bits = [0];
    let ones = 0;
    for (let k = 0; k < 8; k++) { const v = (by >> k) & 1; bits.push(v); if (v) ones++; }
    bits.push(ones % 2 === 0 ? 1 : 0);
    bits.push(1);
    for (const b of bits) {
      put(data, t * rate, (t + T) * rate, b);
      put(clk, t * rate, (t + T / 4) * rate, 1);
      put(clk, (t + T / 4) * rate, (t + 3 * T / 4) * rate, 0);
      put(clk, (t + 3 * T / 4) * rate, (t + T) * rate, 1);
      t += T;
    }
    t += T;
  }
  return t;
}

/* ---------- 场景 2：更多协议 ---------- */
function buildMore() {
  const rate = 4e6, n = 40000;                      // 4 MHz × 10ms
  const ch = mkChans(n, ["CH0 CAN", "CH1 TCK", "CH2 TMS", "CH3 TDI", "CH4 TDO", "CH5 SCK", "CH6 WS", "CH7 SD", "CH8 PS2CLK", "CH9 PS2DATA"]);
  for (const c of ch) fill(c, 1);
  fill(ch[1], 0); fill(ch[5], 0); fill(ch[8], 1);   // TCK / SCK 空闲低
  canPut(ch[0], rate, 0.3e-3, 250000, { id: 0x123, data: [0x11, 0x22, 0x33] });
  canPut(ch[0], rate, 1.2e-3, 250000, { id: 0x18daf110, ext: true, data: [1, 2, 3, 4, 5, 6, 7, 8] });
  jtagPut(ch[1], ch[2], ch[3], ch[4], rate, 3e-3, jtagSequence([1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1], [1, 1, 1, 0]));
  i2sPut(ch[5], ch[6], ch[7], rate, 5e-3, [[0, 0x1234], [1, 0x5678], [0, 0xfffe], [1, 0x0001]], 16);
  ps2Put(ch[8], ch[9], rate, 7e-3, [0x1c, 0xf0]);
  return {
    rate, chans: ch,
    decoders: [
      { kind: "can", ch: 0, bitrate: 250000 },
      { kind: "jtag", tck: 1, tms: 2, tdi: 3, tdo: 4 },
      { kind: "i2s", sck: 5, ws: 6, sd: 7, bits: 16, fmt: "左对齐", wsPol: "低=左" },
      { kind: "ps2", clk: 8, data: 9, dir: "设备→主机" },
    ],
    note: "CAN 250k（标准帧 + 扩展帧）· JTAG（IR 4 位 + DR 16 位）· I2S 16 位 · PS/2 键盘两帧",
  };
}
/* ---------- 场景 3 要用的编码：Manchester / Miller / DHT / LIN / Modbus / DMX / SWD ---------- */

/** 曼彻斯特（IEEE：1 = 前高后低；G.E. Thomas：1 = 前低后高） */
function manPut(c, rate, t0, bits, spb, conv) {
  let i = t0 * rate;
  for (const b of bits) {
    const a = conv === "G.E. Thomas" ? (b ? 0 : 1) : (b ? 1 : 0);
    put(c, i, i + (spb * rate) / 2, a);
    put(c, i + (spb * rate) / 2, i + spb * rate, 1 - a);
    i += spb * rate;
  }
  return i / rate;
}
/** 差分曼彻斯特：位起点必翻，中点为 0 时再翻 */
function dmanPut(c, rate, t0, bits, spb, lvl0) {
  let i = t0 * rate, lvl = lvl0 == null ? 1 : lvl0;      // 接上通道的空闲电平（示例里是 1）
  for (const b of bits) {
    lvl ^= 1;
    put(c, i, i + (spb * rate) / 2, lvl);
    if (b === 0) lvl ^= 1;
    put(c, i + (spb * rate) / 2, i + spb * rate, lvl);
    i += spb * rate;
  }
  return i / rate;
}
/** Miller：比特中点翻 = 1；连续两个 0 时在边界补翻 */
function millerPut(c, rate, t0, bits, spb, lvl0) {
  let i = t0 * rate, lvl = lvl0 == null ? 1 : lvl0;
  for (let k = 0; k < bits.length; k++) {
    if (bits[k]) { put(c, i, i + (spb * rate) / 2, lvl); lvl ^= 1; put(c, i + (spb * rate) / 2, i + spb * rate, lvl); }
    else { put(c, i, i + spb * rate, lvl); if (k + 1 < bits.length && bits[k + 1] === 0) lvl ^= 1; }
    i += spb * rate;
  }
  return i / rate;
}
const bitsMsb = (bytes, order) => {
  const out = [];
  for (const b of bytes) for (let k = 0; k < 8; k++) out.push(order === "lsb" ? (b >> k) & 1 : (b >> (7 - k)) & 1);
  return out;
};

/** DHT22：主机起始（低 1.2ms）→ 器件应答 → 40 位（高 27µs=0 / 70µs=1） */
function dhtPut(c, rate, t0, hum, temp) {
  let t = t0;
  const lvl = (v, dur) => { put(c, t * rate, (t + dur) * rate, v); t += dur; };
  lvl(1, 20e-6);
  lvl(0, 1200e-6);
  lvl(1, 30e-6);
  lvl(0, 80e-6); lvl(1, 80e-6);
  const h = Math.round(hum * 10), tp = Math.round(temp * 10);
  const bytes = [(h >> 8) & 0xff, h & 0xff, (tp >> 8) & 0xff, tp & 0xff];
  bytes.push((bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xff);
  for (const b of bitsMsb(bytes)) { lvl(0, 50e-6); lvl(1, b ? 70e-6 : 27e-6); }
  lvl(1, 40e-6);
  return t;
}

/** LIN：断帧 + 0x55 + PID + 数据 + 校验（ID<60 用经典和） */
function linPut(c, rate, t0, id, data, baud) {
  baud = baud || 19200;
  const bt = 1 / baud;
  put(c, t0 * rate, (t0 + 13 * bt) * rate, 0);            // 断帧
  put(c, (t0 + 13 * bt) * rate, (t0 + 14 * bt) * rate, 1); // 断帧分隔
  const p0 = (id & 1) ^ ((id >> 1) & 1) ^ ((id >> 2) & 1) ^ ((id >> 4) & 1);
  const p1 = !(((id >> 1) & 1) ^ ((id >> 3) & 1) ^ ((id >> 4) & 1) ^ ((id >> 5) & 1)) ? 1 : 0;
  const pid = id | (p0 << 6) | (p1 << 7);
  const ck = id < 60 ? (~data.reduce((a, b) => a + b, 0)) & 0xff
    : (() => { let crc = 0; for (const b of [pid].concat(data)) { let x = b; for (let k = 0; k < 8; k++) { const m = (crc ^ x) & 1; crc >>= 1; if (m) crc ^= 0x8c; x >>= 1; } } return crc & 0xff; })();
  return uartPut(c, rate, t0 + 14 * bt, [0x55, pid].concat(data, [ck]), baud);
}

/** Modbus RTU 响应帧（over 串口），自动补 CRC-16 */
function modbusPut(c, rate, t0, bytes, baud) {
  let crc = 0xffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; }
  return uartPut(c, rate, t0, bytes.concat([crc & 0xff, (crc >> 8) & 0xff]), baud || 9600);
}

/** DMX512：断帧 + mark + 起始码 + 各槽（250kbaud，8N2） */
function dmxPut(c, rate, t0, slots) {
  put(c, t0 * rate, (t0 + 120e-6) * rate, 0);
  put(c, (t0 + 120e-6) * rate, (t0 + 132e-6) * rate, 1);
  return uartPut(c, rate, t0 + 132e-6, [0x00].concat(slots), 250000, { stop: 2 });
}

/** SWD：请求 8 位 + 附加位 + 3 位 ACK + 32 位数据 + 校验 */
function swdPut(clk, dio, rate, t0, o) {
  const T = 2e-6;
  const req = [1, o.apndp ? 1 : 0, o.rnw ? 1 : 0, (o.addr >> 2) & 1, (o.addr >> 3) & 1, 0, 0, 1];
  req[5] = req[1] ^ req[2] ^ req[3] ^ req[4];
  const ack = o.ack == null ? 1 : o.ack;
  const ackBits = [ack & 1, (ack >> 1) & 1, (ack >> 2) & 1];
  const stream = req.concat([0]).concat(ackBits);
  let ones = 0;
  if (ack === 1 && o.rnw && o.data != null) {
    const db = [];
    for (let k = 31; k >= 0; k--) { const b = (o.data >>> k) & 1; db.push(b); if (b) ones++; }
    stream.push.apply(stream, db);
    stream.push(ones % 2);
  }
  let t = t0;
  for (const b of stream) {
    put(dio, t * rate, (t + T) * rate, b);
    put(clk, t * rate, (t + T / 2) * rate, 0);
    put(clk, (t + T / 2) * rate, (t + T) * rate, 1);
    t += T;
  }
  return t;
}

/* ---------- 场景 3：编码与工业总线 ---------- */
function buildEnc() {
  const rate = 1e6, n = 40000;                      // 1 MHz × 40ms
  const ch = mkChans(n, ["CH0 MAN", "CH1 DMAN", "CH2 MILLER", "CH3 DHT", "CH4 LIN", "CH5 MODBUS", "CH6 DMX", "CH7 SWCLK", "CH8 SWDIO", "CH9 DQ"]);
  for (const c of ch) fill(c, 1);
  const spb = 1 / 100000;                            // 100 kbit/s 的每比特时间
  manPut(ch[0], rate, 1e-3, bitsMsb([0x35, 0xa5, 0x0f, 0x78]), spb, "IEEE 802.3");
  dmanPut(ch[1], rate, 1.5e-3, bitsMsb([0x35, 0xa5, 0x0f, 0x78]), spb);
  millerPut(ch[2], rate, 2e-3, bitsMsb([0x35, 0xa5, 0x0f, 0x78]), spb);
  dhtPut(ch[3], rate, 5e-3, 55.0, 23.5);
  owPut(ch[9], rate, 12e-3, [0x33].concat([0x28, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01]));   // 读 ROM
  linPut(ch[4], rate, 15e-3, 0x12, [0x01, 0x02, 0x03, 0x04]);
  modbusPut(ch[5], rate, 20e-3, [0x01, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44], 9600);
  swdPut(ch[7], ch[8], rate, 25e-3, { apndp: false, rnw: true, addr: 0, data: 0x1ba01477 });
  swdPut(ch[7], ch[8], rate, 25.3e-3, { apndp: false, rnw: false, addr: 4, data: 0x12345678 });
  dmxPut(ch[6], rate, 30e-3, [0x80, 0x40, 0xff, 0x00, 0x7f, 0x20]);
  return {
    rate, chans: ch,
    decoders: [
      { kind: "manchester", ch: 0, bitrate: 100000, conv: "IEEE 802.3", wordSize: 8, order: "msb" },
      { kind: "diff_manchester", ch: 1, bitrate: 100000, conv: "IEEE 802.3", wordSize: 8, order: "msb" },
      { kind: "miller", ch: 2, bitrate: 100000, wordSize: 8, order: "msb" },
      { kind: "dht", ch: 3, model: "DHT22" },
      { kind: "onewire", ch: 9, resetUs: 200 },
      { kind: "lin", ch: 4, baud: 19200 },
      { kind: "modbus", ch: 5, baud: 9600, parity: "none", stop: 1 },
      { kind: "swd", clk: 7, dio: 8 },
      { kind: "dmx512", ch: 6, slots: 6 },
    ],
    note: "Manchester · 差分 Manchester · Miller · DHT22 · 1-Wire ROM · LIN · Modbus RTU · SWD · DMX512",
  };
}
