// ── 视频带宽计算：时序 → 带宽 → 逐接口判定 ────────────────────────────────
// 输入一套"画面规格"（分辨率 / 刷新率 / 色深 / 色度格式），先算出它要吃掉多少链路带宽，
// 再逐条比对各种视频接口（DP / DP Alt on USB-C / HDMI）的各个版本扛不扛得住。
//
// 三块内容：
//   ① 时序：CVT / CVT-RB / CVT-RBv2 三条公式，或查 VESA DMT / CTA-861 标准表（见 vb-tables.js）
//   ② 带宽：峰值（Bandwidth，含消隐）/ Line（行内有效）/ Active（不含消隐）/ DSC 理论下限（固定 8 bpp）
//   ③ 判定：按"色度格式 → 色深 → 带宽"的顺序判；带宽不够时看 DSC 能不能救（bpp 越高压缩越轻）
//
// 只算带宽账，不做物理层仿真：判定"够"不等于"插上一定能点亮"（还要看 EDID、链路训练、线缆质量、
// DSC 切片结构等）。这套模型也不表达隔行扫描、1000/1001 时基、自定义 blanks、MST、HDR 元数据开销。
//
// 数值内部一律 Hz / bps，界面显示时才除 1e9。默认样例 3840x2160@144 / 8bit / RGB 4:4:4 / CVT-RBv2
// = 31.35 / 28.67 / 10.45 / 30.71 Gbps（像素时钟 1306.206 MHz、htotal/vtotal 3920/2314）。

import { VB_DMT, VB_CEA } from "./vb-tables.js";

/* ---------- 两张标准表解码成对象（列序见 vb-tables.js 顶部注释） ---------- */
const DMT = VB_DMT.map((r) => ({
  hActive: r[0], vActive: r[1], vFreq: r[2], type: r[3], clock: r[4],
  hTotal: r[5], vTotal: r[6], hBlank: r[7], vBlank: r[8],
  hFront: r[9], hSync: r[10], hBack: r[11], vFront: r[12], vSync: r[13], vBack: r[14],
  hPol: r[15], vPol: r[16], id: r[17], code2: r[18], code3: r[19], interlaced: r[20] === 1,
}));
const CEA = VB_CEA.map((r) => ({
  vic: r[0], hActive: r[1], vActive: r[2], vFreq: r[3], prog: r[4] === 1, clock: r[5],
  hTotal: r[6], vTotal: r[7], hBlank: r[8], vBlank: r[9],
  hFront: r[10], hSync: r[11], hBack: r[12], vFront: r[13], vSync: r[14], vBack: r[15],
  hPol: r[16], vPol: r[17],
}));

export const VB_FORMATS = [
  { id: "rgb444", name: "RGB 4:4:4", factor: 3 },
  { id: "yuv444", name: "YUV 4:4:4", factor: 3 },
  { id: "yuv422", name: "YUV 4:2:2", factor: 2 },
  { id: "yuv420", name: "YUV 4:2:0", factor: 1.5 },
];
export const VB_DEPTHS = [6, 8, 10, 12, 14, 16];
export const VB_TIMINGS = [
  ["cvt", "CVT"], ["cvt_rb", "CVT-RB"], ["cvt_rb2", "CVT-RBv2"], ["dmt", "DMT"], ["cea", "CEA-861"],
];
/** 常用规格：点一下就填进输入框（色度格式统一按 RGB 4:4:4） */
export const VB_PRESETS = [
  { label: "8K 60", width: 7680, height: 4320, refreshRate: 60, colorDepth: 10 },
  { label: "6K 60", width: 6016, height: 3384, refreshRate: 60, colorDepth: 10 },
  { label: "4K 144", width: 3840, height: 2160, refreshRate: 144, colorDepth: 10 },
  { label: "4K 120", width: 3840, height: 2160, refreshRate: 120, colorDepth: 10 },
  { label: "2K 165", width: 2560, height: 1440, refreshRate: 165, colorDepth: 10 },
  { label: "1080P 60", width: 1920, height: 1080, refreshRate: 60, colorDepth: 8 },
];

/* ---------- 输入校验 ----------
   口径与原页面一致：只拦"不是数"和 0，负号 / 小数 / 超大值都照算（那是它的定义，不做额外兜底）。 */
const fail = (code, msg, extra) => Object.assign(new Error(msg), { vbCode: code }, extra || {});
function guardNumber(v, name) {
  if (typeof v !== "number" || Number.isNaN(v)) throw fail("bad-number", `${name} must be a number`, { field: name });
  if (v === 0) throw fail("zero", `${name} must be greater than 0`, { field: name });
  return v;
}
function guardFinite(v, name) {
  if (typeof v !== "number" || !isFinite(v)) throw fail("not-finite", `timing calculation produced no valid ${name}`, { field: name });
  return v;
}

/* ---------- CVT 公共前置：有效像素 / 宽高比 / V_SYNC ---------- */
const GRAN = 8;                                   // CELL_GRAN：水平有效像素先向下取整到 8 的倍数
const L_H_PERIOD_MS = 550e-6;                     // 完整 CVT 的垂直同步 + 后肩最小时间预算（550 µs）
const ASPECTS = [
  ["4:3", 4 / 3], ["16:9", 16 / 9], ["16:10", 16 / 10], ["5:4", 5 / 4],
  ["15:9", 15 / 9], ["43:18", 43 / 18], ["64:27", 64 / 27], ["12:5", 12 / 5],
];
const VSYNC_FIX = { "4:3": 4, "16:9": 5, "16:10": 6, "5:4": 7, "15:9": 7 };

/** 宽高比反查：把 v_active 套到 8 个候选比例上，第一个等于 h_active 的就是它 */
function cvtAspect(hActive, vActive) {
  for (const [name, k] of ASPECTS) if (Math.round(k * vActive) === hActive) return name;
  return "Unknown";
}
/** V_SYNC 由宽高比决定；CVT-RBv2 固定 8 行 */
const cvtVSync = (aspect, mode) => (mode === "cvt_rb2" ? 8 : (VSYNC_FIX[aspect] || 10));

/* ---------- 三条 CVT 公式（只有常量不同） ---------- */
const CVT_KIND = {
  cvt: { q: 0.25, hpol: "-", vpol: "+" },
  cvt_rb: { q: 0.25, hBlankFix: 160, hSync: 32, hBack: 80, vFrontFix: 3, vsyncBpExtra: 3, hpol: "+", vpol: "-" },
  cvt_rb2: { q: 0.001, hBlankFix: 80, hSync: 32, hBack: 40, vBackFix: 6, vsyncBpExtra: 1, hpol: "+", vpol: "-" },
};

/** 公式生成时序。dmtRow 只在"DMT 表命中 cvt / cvt-rb 类型的行"时给，用于回填 dmt_id 与两个编码 */
function generateCvt(mode, width, height, refreshRate, dmtRow) {
  const k = CVT_KIND[mode] || CVT_KIND.cvt;
  const hActive = Math.floor(width / GRAN) * GRAN;         // 1366 → 1360
  const vActive = Math.floor(height);
  const aspect = cvtAspect(hActive, vActive);
  const vSync = cvtVSync(aspect, mode);

  let vSyncBp, vBlank, vTotal, hBlank, hTotal, clockMHz;
  if (mode === "cvt") {
    // 完整 CVT：消隐比例按 H_PERIOD_EST 推；行同步固定占 h_total 的 8%（量化到 8）
    const hPeriodEst = (1 / refreshRate - L_H_PERIOD_MS) / (vActive + 3) * 1e6;   // µs
    vSyncBp = Math.floor(550 / hPeriodEst) + 1;
    if (vSyncBp < vSync + 6) vSyncBp = vSync + 6;
    vBlank = vSyncBp + 3;                                  // 末尾那 3 行是垂直前肩
    vTotal = vActive + vSyncBp + 3;
    const m = 30 - 300 * hPeriodEst / 1e3;                 // 消隐比例因子 M（%）
    hBlank = m < 20 ? 2 * GRAN * Math.floor(20 * hActive / 80 / (2 * GRAN))
                    : 2 * GRAN * Math.floor(hActive * m / (100 - m) / (2 * GRAN));
    hTotal = hActive + hBlank;
    clockMHz = k.q * Math.floor(hTotal / hPeriodEst / k.q);            // 量化到 0.25 MHz
  } else {
    // 简化消隐（CVT-RB / CVT-RBv2）：行消隐固定 160 / 80，垂直同步 + 后肩有下限
    const hPeriodEst = (1e6 / refreshRate - 460) / vActive;
    const minBp = k.vsyncBpExtra + vSync + 6;
    const est = Math.floor(460 / hPeriodEst) + 1;
    vSyncBp = est < minBp ? minBp : est;
    vBlank = vSyncBp;
    vTotal = vSyncBp + vActive;
    hBlank = k.hBlankFix;
    hTotal = hBlank + hActive;
    clockMHz = k.q * Math.floor(refreshRate * vTotal * hTotal / 1e6 / k.q);  // RB 量化 0.25 / RBv2 量化 0.001
  }
  const hSync = mode === "cvt" ? GRAN * Math.floor(0.08 * hTotal / GRAN) : k.hSync;
  const hBack = mode === "cvt" ? hBlank / 2 : k.hBack;
  const hFront = hBlank - hSync - hBack;
  const vFront = mode === "cvt" ? 3 : (mode === "cvt_rb" ? k.vFrontFix : vSyncBp - vSync - 6);
  const vBack = mode === "cvt" ? vSyncBp - vSync : (mode === "cvt_rb" ? vSyncBp - k.vFrontFix - vSync : k.vBackFix);

  return {
    source: mode, hActive, vActive, aspect, hBlank, hTotal, vBlank, vTotal, clockMHz,
    hSync, hFront, hBack, vSync, vFront, vBack, hpol: k.hpol, vpol: k.vpol,
    dmtId: dmtRow ? dmtRow.id : null, code2: dmtRow ? dmtRow.code2 : null, code3: dmtRow ? dmtRow.code3 : null,
  };
}

/** 查 VESA DMT 表：命中 cvt / cvt-rb 类型的行要转回公式重算（那几行只说明"这套组合是标准的"） */
function lookupDmt(width, height, refreshRate) {
  let row = null;
  for (const r of DMT) {                                   // 命中多行时以最后一条为准（跟原实现的全表扫描一致）
    if (r.hActive === width && r.vActive === height && r.vFreq.toFixed() === refreshRate.toFixed() && !r.interlaced) row = r;
  }
  if (!row) throw fail("no-dmt", `no DMT timing found for ${width}x${height}@${refreshRate}Hz`);
  if (row.type === 1) return generateCvt("cvt", width, height, refreshRate, row);
  if (row.type === 2) return generateCvt("cvt_rb", width, height, refreshRate, row);
  if (row.type === 3) return lookupCea(width, height, refreshRate, row);   // 这两行只是"转 CTA-861 表"，dmt_id 仍要带上
  return {
    source: "dmt", hActive: width, vActive: height, aspect: null,
    hBlank: row.hBlank, hTotal: row.hTotal, vBlank: row.vBlank, vTotal: row.vTotal, clockMHz: row.clock,
    hSync: row.hSync, hFront: row.hFront, hBack: row.hBack, vSync: row.vSync, vFront: row.vFront, vBack: row.vBack,
    hpol: row.hPol, vpol: row.vPol, dmtId: row.id, code2: row.code2, code3: row.code3,
  };
}

/** 查 CTA-861 表：只认逐行（表里那 21 行隔行永远匹配不上） */
function lookupCea(width, height, refreshRate, dmtRow) {
  let row = null;
  for (const r of CEA) {                                   // 同一规格在表里有多行（不同 VIC）时取最后一条
    if (r.hActive === width && r.vActive === height && r.vFreq.toFixed() === refreshRate.toFixed() && r.prog) row = r;
  }
  if (!row) throw fail("no-cea", `no CEA timing found for ${width}x${height}@${refreshRate}Hz`);
  return {
    source: "cea", hActive: width, vActive: height, aspect: null,
    hBlank: row.hBlank, hTotal: row.hTotal, vBlank: row.vBlank, vTotal: row.vTotal, clockMHz: row.clock,
    hSync: row.hSync, hFront: row.hFront, hBack: row.hBack, vSync: row.vSync, vFront: row.vFront, vBack: row.vBack,
    hpol: row.hPol, vpol: row.vPol, vic: row.vic,
    dmtId: dmtRow ? dmtRow.id : null, code2: dmtRow ? dmtRow.code2 : null, code3: dmtRow ? dmtRow.code3 : null,
  };
}

/** 极性统一写 "+" / "-"（DMT 表里是 Pos/Neg，CTA-861 表里是 P/N，CVT 路径直接给符号） */
const polSign = (v) => { const s = String(v); if (s === "+" || s === "-") return s; return s.toLowerCase().startsWith("n") ? "-" : "+"; };

/** 时序汇总（页面上"时序明细"那一块）：这里才把 MHz 换成 Hz，并算出实际刷新率 / 行频 */
function timingInfo(raw, timingKey) {
  const pclock = guardFinite(raw.clockMHz * 1e6, "pixel clock");
  const hActive = guardFinite(raw.hActive, "hactive");
  const hTotal = guardFinite(raw.hTotal, "htotal");
  const vActive = guardFinite(raw.vActive, "vactive");
  const vTotal = guardFinite(raw.vTotal, "vtotal");
  const vBlank = guardFinite(raw.vBlank, "vblank");
  const hfreq = pclock / hTotal;
  const vfreq = pclock / (vTotal * hTotal);
  return {
    timing: timingKey, source: raw.source,
    pclock, hActive, vActive, hBlank: raw.hBlank, hTotal, vBlank, vTotal,
    hfreq, vfreq, vfreq100: Math.round(vfreq * 100) / 100, hperiod: 1 / hfreq, vperiod: 1 / vfreq,
    hSync: raw.hSync, hFront: raw.hFront, hBack: raw.hBack, hpol: polSign(raw.hpol),
    vSync: raw.vSync, vFront: raw.vFront, vBack: raw.vBack, vpol: polSign(raw.vpol),
    aspect: raw.aspect,
    dmtId: raw.dmtId == null ? null : raw.dmtId,
    code2: raw.code2 == null ? null : raw.code2,
    code3: raw.code3 == null ? null : raw.code3,
    vic: raw.vic == null ? null : raw.vic,
  };
}

/* ---------- 主计算：四个带宽数 ---------- */
export function vbCompute(input) {
  const width = guardNumber(input.width, "width");
  const height = guardNumber(input.height, "height");
  const refreshRate = guardNumber(input.refreshRate, "refreshRate");
  const colorDepth = guardNumber(input.colorDepth, "colorDepth");
  const format = VB_FORMATS.find((f) => f.id === input.colorFormat) || VB_FORMATS[0];
  const timingKey = input.timing || "cvt_rb2";
  const raw = timingKey === "dmt" ? lookupDmt(width, height, refreshRate)
    : timingKey === "cea" ? lookupCea(width, height, refreshRate)
      : generateCvt(timingKey, width, height, refreshRate, null);
  const t = timingInfo(raw, timingKey);

  const maximum = t.pclock * colorDepth * format.factor;                        // Bandwidth（含消隐）
  const line = maximum * t.hActive / t.hTotal;                                  // Line（只在行内有效像素上）
  const active = t.vfreq * colorDepth * t.hActive * t.vActive * format.factor;  // Active（不含消隐）
  const dsc = 8 * t.pclock;                                                     // DSC 理论下限（8 bpp）
  return {
    maximum, line, active, dsc, clock: t.pclock, timing: t,
    options: { width, height, refreshRate, colorDepth, format, timing: timingKey },
  };
}

/* ---------- 链路模式与接口版本 ----------
   有效带宽 = 链路速率 × lane 数 × 编码系数（8b/10b = 8/10、128b/132b = 128/132、FRL = 16/18；
   TMDS 便宜点：每个时钟 3 个数据通道 × 8 bit）。DP Alt on USB-C 固定按 2 lane 算（另外 2 lane 留给 USB）。 */
const dp8b10b = (rate, lanes) => rate * lanes * 8 / 10;
const dp128b132 = (rate, lanes) => rate * lanes * 128 / 132;
const frl = (rate, lanes) => rate * lanes * 16 / 18;
const tmds = (mhz) => mhz * 1e6 * 3 * 8;

const dpMode = (key, name, rate, enc, lanes) => ({
  key: lanes === 4 ? key : "dpam_" + key,
  name,
  bandwidth: enc === "128b132b" ? dp128b132(rate, lanes) : dp8b10b(rate, lanes),
  desc: `${name} ${rate / 1e9}Gbps × ${lanes} lanes`,
});
const DP_RATES = [["RBR", 1.62e9, "8b10b"], ["HBR", 2.7e9, "8b10b"], ["HBR2", 5.4e9, "8b10b"],
  ["HBR3", 8.1e9, "8b10b"], ["UHBR10", 1e10, "128b132b"], ["UHBR13.5", 1.35e10, "128b132b"], ["UHBR20", 2e10, "128b132b"]];
const dpKey = (name) => ({ RBR: "dp_rbr", HBR: "dp_hbr", HBR2: "dp_hbr2", HBR3: "dp_hbr3",
  UHBR10: "dp_ubr10", "UHBR13.5": "dp_ubr13", UHBR20: "dp_ubr20" })[name];
const DP_MODES = DP_RATES.map(([n, r, e]) => dpMode(dpKey(n), n, r, e, 4));
const DPAM_MODES = DP_RATES.map(([n, r, e]) => dpMode(dpKey(n), n, r, e, 2));
const HDMI_MODES = [
  { key: "tmds_165", name: "165MHz", bandwidth: tmds(165), desc: "TMDS 165MHz" },
  { key: "tmds_340", name: "340MHz", bandwidth: tmds(340), desc: "TMDS 340MHz" },
  { key: "tmds_600", name: "600MHz", bandwidth: tmds(600), desc: "TMDS 600MHz" },
  { key: "frl_3", name: "FRL3", bandwidth: frl(6e9, 4), desc: "FRL 6Gbps × 4 lanes (24Gbps)" },
  { key: "frl_4", name: "FRL4", bandwidth: frl(8e9, 4), desc: "FRL 8Gbps × 4 lanes (32Gbps)" },
  { key: "frl_5", name: "FRL5", bandwidth: frl(1e10, 4), desc: "FRL 10Gbps × 4 lanes (40Gbps)" },
  { key: "frl_6", name: "FRL6", bandwidth: frl(12e9, 4), desc: "FRL 12Gbps × 4 lanes (48Gbps)" },
  { key: "frl2_64", name: "FRL 64G", bandwidth: frl(16e9, 4), desc: "FRL2 16Gbps × 4 lanes (64Gbps)" },
  { key: "frl2_80", name: "FRL 80G", bandwidth: frl(2e10, 4), desc: "FRL2 20Gbps × 4 lanes (80Gbps)" },
  { key: "frl2_96", name: "FRL 96G", bandwidth: frl(24e9, 4), desc: "FRL2 24Gbps × 4 lanes (96Gbps)" },
];

const F444 = ["rgb444", "yuv444", "yuv422", "yuv420"];
const F422 = ["rgb444", "yuv444", "yuv422"];
/** 从模式列表里按名字取（顺序 = 能力递增），判定时会再按带宽降序排一次 */
const pick = (list, names) => names.map((n) => list.find((m) => m.name === n));
const DP_ALL = ["RBR", "HBR", "HBR2", "HBR3", "UHBR10", "UHBR13.5", "UHBR20"];

/** 版本表：允许的模式 + 是否支持 DSC + 最大色深 + 允许的色度格式（DP / DP Alt / HDMI 各一组） */
export const VB_IFACES = [
  { group: "dp", key: "dp_21", version: "2.1", modes: pick(DP_MODES, DP_ALL), dsc: true, maxColorDepth: 16, format: F444, hdr: true },
  { group: "dp", key: "dp_14", version: "1.4", modes: pick(DP_MODES, DP_ALL.slice(0, 4)), dsc: true, maxColorDepth: 16, format: F444, hdr: true },
  { group: "dp", key: "dp_13", version: "1.3", modes: pick(DP_MODES, DP_ALL.slice(0, 4)), dsc: false, maxColorDepth: 16, format: F444 },
  { group: "dp", key: "dp_12", version: "1.2", modes: pick(DP_MODES, DP_ALL.slice(0, 3)), dsc: false, maxColorDepth: 16, format: F422 },
  { group: "dp", key: "dp_10", version: "1.0-1.1a", modes: pick(DP_MODES, DP_ALL.slice(0, 2)), dsc: false, maxColorDepth: 16, format: F422 },
  { group: "dpam", key: "dpam_2", version: "2.0", modes: pick(DPAM_MODES, DP_ALL), dsc: true, maxColorDepth: 16, format: F444 },
  { group: "dpam", key: "dpam_1", version: "1.0", modes: pick(DPAM_MODES, DP_ALL.slice(0, 4)), dsc: true, maxColorDepth: 16, format: F444 },
  { group: "hdmi", key: "hdmi_22", version: "2.2", modes: HDMI_MODES.slice(3), dsc: true, maxColorDepth: 16, format: F444, hdr: true },
  { group: "hdmi", key: "hdmi_21", version: "2.1", modes: HDMI_MODES.slice(3, 7), dsc: true, maxColorDepth: 16, format: F444, hdr: true },
  { group: "hdmi", key: "hdmi_20", version: "2.0", modes: HDMI_MODES.slice(0, 3), dsc: false, maxColorDepth: 16, format: F444, hdr: true },
  { group: "hdmi", key: "hdmi_14", version: "1.4", modes: HDMI_MODES.slice(0, 2), dsc: false, maxColorDepth: 16, format: F422 },
  { group: "hdmi", key: "hdmi_13", version: "1.3", modes: HDMI_MODES.slice(0, 2), dsc: false, maxColorDepth: 16, format: F422 },
  { group: "hdmi", key: "hdmi_10", version: "1.0-1.2", modes: HDMI_MODES.slice(0, 1), dsc: false, maxColorDepth: 12, format: F422 },
];
for (const f of VB_IFACES) f.modeList = f.modes.slice().sort((a, b) => b.bandwidth - a.bandwidth);

/** 单个接口版本能不能扛住这套规格（判定顺序：格式 → 色深 → 带宽） */
export function vbVerdict(face, sig) {
  if (!face.format.includes(sig.options.format.id)) {
    return { ok: false, reasonKey: "format", reason: `color format ${sig.options.format.name} not supported` };
  }
  if (face.maxColorDepth < sig.options.colorDepth) {
    return { ok: false, reasonKey: "depth", reason: `color depth ${sig.options.colorDepth} not supported` };
  }
  let mode = null, bpp = -1;
  for (const m of face.modeList) {
    if (sig.maximum > m.bandwidth) {
      // 这一档扛不住：不支持 DSC / 已经选中"不用压缩"的高档 / 连 8 bpp 都不够 → 换下一档
      if (!face.dsc || (mode && bpp === -1) || sig.dsc > m.bandwidth) continue;
      const a = Math.round(m.bandwidth / sig.clock * 4) / 4;      // 该档能给的 bpp，量化到 0.25
      if (bpp === -1 || a > bpp) { mode = m; bpp = a; }
      continue;
    }
    mode = m; bpp = -1;                                           // 带宽够，直接选它
  }
  if (!mode) return { ok: false, reasonKey: "bandwidth", reason: "not enough bandwidth" };
  return { ok: true, mode, dscBPP: bpp };
}

/** 结论分档：绿色 = 不用压缩，浅绿 = 轻度 DSC，琥珀 = 重度 DSC，红色 = 不支持 */
export function vbState(v) {
  if (!v.ok) return "no";
  if (v.dscBPP <= 0) return "ok";
  return v.dscBPP >= 24 ? "light" : "heavy";
}




