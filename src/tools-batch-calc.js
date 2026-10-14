// ── 工具页：批量文本 / 计算器 ─────────────────────────────────────────
// 两个纯本地页（不进 agent、不需要设备）。main.js 只在切页时调 init。
import { save as dlgSave, open as dlgOpen } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const $id = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 操作类提示（JSON 报错、正则报错、替换结果）单独一行显示 —— 不要塞进"找到 N 处"那个计数器，
 *  否则下一次重绘就把它冲掉了（踩过）。 */
function btMsg(text, bad) {
  const n = $id("bt-msg");
  if (!n) return;
  n.textContent = text || "";
  n.style.color = bad ? "hsl(var(--destructive))" : "";
}

/** main.js 把自己的 TX 记录函数塞进来（批量发送的每一行都要显示在主输出区） */
let btPushTx = () => {};

/* ========================= 批量文本：处理管线 ========================= */

let btSending = false;
let btWords = [];
let btRawLines = [];
let btFindCursor = 0;

const btUnescape = (s) =>
  String(s).replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
const btBytes = (s) => Array.from(new TextEncoder().encode(s));
const btHex2 = (b) => b.toString(16).padStart(2, "0").toUpperCase();

function btLines() {
  let lines = $id("bt-in").value.split(/\r?\n/);
  if ($id("bt-trim").checked) lines = lines.map((l) => l.trim());
  if ($id("bt-skip-empty").checked) lines = lines.filter((l) => l.length > 0);
  const pre = btUnescape($id("bt-prefix").value || "");
  const suf = btUnescape($id("bt-suffix").value || "");
  const cse = $id("bt-case").value;
  if (cse === "upper") lines = lines.map((l) => l.toUpperCase());
  if (cse === "lower") lines = lines.map((l) => l.toLowerCase());
  if (pre || suf) lines = lines.map((l) => pre + l + suf);
  if ($id("bt-number").checked) {
    const start = Number($id("bt-num-start").value) || 1;
    const w = String(start + lines.length - 1).length;
    lines = lines.map((l, i) => String(start + i).padStart(w, "0") + ". " + l);
  }
  if ($id("bt-dedupe").checked) {
    const seen = new Set();
    lines = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  }
  if ($id("bt-sort").checked) lines = lines.slice().sort((a, b) => a.localeCompare(b, "zh"));
  return lines;
}

function btFormat(lines, kind) {
  if (kind === "lines") return lines.join("\n");
  if (kind === "hexstr") return lines.map((l) => btBytes(l).map(btHex2).join("")).join("\n");
  if (kind === "hexarr") return lines.map((l) => btBytes(l).map((b) => "0x" + btHex2(b)).join(",")).join("\n");
  if (kind === "carray") {
    const all = [];
    for (const l of lines) all.push(...btBytes(l));
    const rows = [];
    for (let i = 0; i < all.length; i += 12) rows.push(all.slice(i, i + 12).map((b) => "0x" + btHex2(b)).join(","));
    return "{" + rows.join(",\n ") + "}";
  }
  if (kind === "json") return JSON.stringify(lines, null, 1);
  if (kind === "csv") return lines.join(",");
  return lines.join("\n");
}

function btRender() {
  const lines = btLines();
  btWords = lines;
  btRawLines = $id("bt-in").value.split(/\r?\n/);
  $id("bt-out").value = btFormat(lines, $id("bt-format").value);
  $id("bt-count").textContent = `${lines.length} 行 · ${lines.reduce((a, l) => a + l.length, 0)} 字`;
  btUpdateCount();
}

/* ================== 批量文本：对输入框"选区优先"地改 ================== */

function btSelRange() {
  const ta = $id("bt-in");
  const s = ta.selectionStart || 0;
  const e = ta.selectionEnd || 0;
  return { ta, s, e, has: e > s };
}

/** transform 只吃一段文本、还一段文本；有选区（且勾了"只处理选中"）就只改那段 */
function btApply(fn, forceSelection) {
  const { ta, s, e, has } = btSelRange();
  const only = forceSelection || $id("bt-selection-only").checked;
  if (has && (only || forceSelection)) {
    const out = fn(ta.value.slice(s, e));
    ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
    ta.setSelectionRange(s, s + out.length);
  } else {
    const all = ta.value;
    const caret = ta.selectionStart;
    ta.value = fn(all);
    const keep = Math.min(caret, ta.value.length);
    try { ta.setSelectionRange(keep, keep); } catch (_) { /* 忽略 */ }
  }
  btRender();
}

/* ======================= 批量文本：搜索 / 替换 ======================= */

function btPattern() {
  const raw = $id("bt-find").value;
  if (!raw) return null;
  const word = $id("bt-find-word").checked;
  const fuzzy = $id("bt-find-fuzzy").checked;
  const isRe = $id("bt-find-re").checked;
  let src = isRe ? raw : esc(raw);
  if (!isRe && fuzzy) src = src.replace(/\s+/g, "\\s+");   // 模糊：空格能匹配换行/多空格
  if (word) src = `\\b(?:${src})\\b`;
  const flags = "g" + (fuzzy && !isRe ? "i" : "");
  try {
    return { re: new RegExp(src, flags), isRe };
  } catch (e) {
    btMsg("正则写错了：" + String(e.message || e).slice(0, 80), true);
    return null;
  }
}

function btMatches(text) {
  const p = btPattern();
  if (!p) return [];
  const out = [];
  p.re.lastIndex = 0;
  let m;
  while ((m = p.re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (m[0].length === 0) p.re.lastIndex++;   // 空匹配防死循环
    if (out.length > 5000) break;
  }
  return out;
}

function btUpdateCount() {
  const info = $id("bt-find-count");
  if (!info) return;
  if (!$id("bt-find").value) { info.textContent = "没在找"; return; }
  const n = btMatches($id("bt-in").value).length;
  info.textContent = n ? `找到 ${n} 处` : "没找到";
}

function btFindStep(dir) {
  const ta = $id("bt-in");
  const ms = btMatches(ta.value);
  if (!ms.length) { $id("bt-find-count").textContent = "没找到"; return; }
  const from = dir > 0 ? (ta.selectionEnd || 0) : (ta.selectionStart || 0);
  let hit = null;
  if (dir > 0) hit = ms.find((m) => m.start >= from) || ms[0];
  else {
    const before = ms.filter((m) => m.end <= from);
    hit = before.length ? before[before.length - 1] : ms[ms.length - 1];
  }
  ta.focus();
  ta.setSelectionRange(hit.start, hit.end);
  // 滚动到可见处
  const before = ta.value.slice(0, hit.start).split("\n").length;
  const lines = ta.value.split("\n").length || 1;
  ta.scrollTop = Math.max(0, (before / lines) * ta.scrollHeight - ta.clientHeight / 2);
  const idx = ms.indexOf(hit) + 1;
  $id("bt-find-count").textContent = `第 ${idx} / ${ms.length} 处`;
}

function btReplaceOne() {
  const ta = $id("bt-in");
  const { s, e, has } = btSelRange();
  if (!has) { btFindStep(1); return; }
  const p = btPattern();
  if (!p) return;
  const sel = ta.value.slice(s, e);
  const rep = $id("bt-replace").value;
  let out = null;
  if (p.isRe) {
    p.re.lastIndex = 0;
    const m = p.re.exec(sel);
    if (m && m.index === 0) out = sel.replace(p.re, rep);
  } else {
    const re = new RegExp(esc(sel), $id("bt-find-fuzzy").checked ? "i" : "");
    if (re.test(sel)) out = rep;
  }
  if (out === null) { btFindStep(1); return; }
  ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
  ta.setSelectionRange(s, s + out.length);
  btRender();
  btFindStep(1);
}

function btReplaceAll() {
  const p = btPattern();
  if (!p) return;
  const rep = $id("bt-replace").value;
  const ta = $id("bt-in");
  const { s, e, has } = btSelRange();
  if (has && $id("bt-selection-only").checked) {
    const seg = ta.value.slice(s, e);
    p.re.lastIndex = 0;
    const out = seg.replace(p.re, rep);
    ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
    ta.setSelectionRange(s, s + out.length);
  } else {
    p.re.lastIndex = 0;
    ta.value = ta.value.replace(p.re, rep);
  }
  btRender();
  btMsg("已全部替换");
}

/* ==================== 批量文本：JSON / 正则 / 缩进 ==================== */

function btJsonFormat(min) {
  btApply((text) => {
    const trimmed = text.trim();
    if (!trimmed) return text;
    try {
      const v = JSON.parse(trimmed);
      if (min) return JSON.stringify(v);
      const n = Number($id("bt-json-indent").value) || 2;
      return JSON.stringify(v, null, n);
    } catch (e) {
      // 不是合法 JSON：退一步按花括号重排，好歹能看
      const m = /position (\d+)/.exec(String(e.message || ""));
      if (m) btMsg(`JSON 解析失败（第 ${Number(m[1]) + 1} 个字符）：${e.message}`, true);
      else btMsg("JSON 解析失败：" + String(e.message || e).slice(0, 80), true);
      return min ? text.replace(/\s*\n\s*/g, "") : btFormatBrace(text);
    }
  });
}

/** 花括号/C 风格自动缩进：尊重字符串、行注释、块注释，for(...) 里的分号不换行 */
function btFormatBrace(src) {
  let out = "";
  let indent = 0;
  let paren = 0;
  let i = 0;
  let quote = null;
  const pad = () => "  ".repeat(Math.max(0, indent));
  const nl = () => { out = out.replace(/[ \t]+$/, ""); if (!out.endsWith("\n")) out += "\n"; out += pad(); };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += src[i + 1] || ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += src[i]; i++; } continue; }
    if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i]; i++; }
      out += "*/";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "\n" || c === "\r") { nl(); i++; while (i < src.length && (src[i] === " " || src[i] === "\t")) i++; continue; }
    if (c === " " || c === "\t") {
      // 行内多空格压成一个；行首的缩进由 nl() 负责
      if (!/[ \t]$/.test(out) && !out.endsWith("\n")) out += " ";
      i++;
      while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
      continue;
    }
    if (c === "(") { paren++; out += c; i++; continue; }
    if (c === ")") { paren = Math.max(0, paren - 1); out += c; i++; continue; }
    if (c === "{") { out += " {"; indent++; nl(); i++; continue; }
    if (c === "}") { indent = Math.max(0, indent - 1); if (!out.endsWith("\n")) nl(); out += "}"; i++; continue; }
    if (c === ";") {
      out += ";";
      i++;
      if (paren === 0) nl();
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function btRegexRun() {
  const pat = $id("bt-re-pat").value;
  if (!pat) { btMsg("先写个正则", true); return; }
  let re;
  try { re = new RegExp(pat, "g"); } catch (e) {
    btMsg("正则写错了：" + String(e.message || e).slice(0, 80), true);
    return;
  }
  const rep = $id("bt-re-rep").value;
  const scope = $id("bt-re-scope").value;
  btApply((text) => {
    if (scope === "line") return text.split("\n").map((l) => l.replace(re, rep)).join("\n");
    return text.replace(re, rep);
  });
  btMsg(scope === "line" ? "正则批量处理完成（每行单独）" : "正则批量处理完成（全文）");
}

const btCase = (mode) => (text) => {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text.replace(/(^|[\s\p{P}])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
};

function btIndentRun() {
  const kind = $id("bt-indent").value;
  if (kind === "json") return btJsonFormat(false);
  if (kind === "brace") return btApply(btFormatBrace);
  if (kind === "tabs2") return btApply((t) => t.replace(/\t/g, "  "));
  if (kind === "tabs4") return btApply((t) => t.replace(/\t/g, "    "));
  if (kind === "strip") return btApply((t) => t.split("\n").map((l) => l.replace(/^[ \t]+/, "")).join("\n"));
}

/* =========================== 批量文本：发送 =========================== */

async function btSendAll() {
  if (btSending) { btSending = false; return; }      // 再点一次 = 停
  const lines = btWords.length ? btWords : btLines();
  if (!lines.length) return;
  btSending = true;
  const gap = Math.max(0, Number($id("bt-gap").value) || 0);
  const le = $id("bt-with-end").checked ? $id("line-ending").value : "none";
  $id("bt-send").classList.add("primary");
  for (let i = 0; i < lines.length; i++) {
    if (!btSending) break;
    $id("bt-state").textContent = `发送中 ${i + 1}/${lines.length}`;
    try {
      const ack = await invoke("write_data", { payload: lines[i], mode: "text", lineEnding: le });
      btPushTx({ dir: "TX", ts_ms: Date.now(), text: ack.text, hex: ack.hex, ascii: ack.ascii });
    } catch (e) {
      $id("bt-state").textContent = "出错：" + String(e).slice(0, 60);
      break;
    }
    if (i < lines.length - 1 && gap) await new Promise((r) => setTimeout(r, gap));
  }
  btSending = false;
  $id("bt-send").classList.remove("primary");
  if ($id("bt-state").textContent.startsWith("发送中")) $id("bt-state").textContent = "发完了";
}

export function initBatch(opts) {
  if (opts && typeof opts.pushTx === "function") btPushTx = opts.pushTx;
  const box = $id("bt-in");
  if (!box || box.__bound) return;
  box.__bound = true;

  for (const id of ["bt-trim", "bt-skip-empty", "bt-dedupe", "bt-sort", "bt-number", "bt-num-start",
                    "bt-prefix", "bt-suffix", "bt-case", "bt-format", "bt-find", "bt-find-word",
                    "bt-find-fuzzy", "bt-find-re"]) {
    const n = $id(id);
    if (!n) continue;
    n.oninput = btRender;
    n.onchange = btRender;
  }
  box.oninput = btRender;
  box.onclick = btUpdateCount;
  box.onkeyup = btUpdateCount;
  $id("bt-find").addEventListener("input", () => btMsg(""));   // 重新输关键词就把旧提示清掉

  // 搜索 / 替换
  $id("bt-find-next").onclick = () => btFindStep(1);
  $id("bt-find-prev").onclick = () => btFindStep(-1);
  $id("bt-replace-one").onclick = btReplaceOne;
  $id("bt-replace-all").onclick = btReplaceAll;
  $id("bt-find").onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); btFindStep(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); box.focus(); }
  };
  // Ctrl+F 直接跳到搜索框（F3 = 找下一个）
  document.addEventListener("keydown", (e) => {
    const pane = document.querySelector('.workpane[data-work="batch"]');
    if (!pane || pane.hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $id("bt-find").focus();
      $id("bt-find").select();
      btUpdateCount();
    } else if (e.key === "F3") {
      e.preventDefault();
      btFindStep(e.shiftKey ? -1 : 1);
    }
  });

  // JSON / 正则 / 大小写 / 缩进
  $id("bt-json-fmt").onclick = () => btJsonFormat(false);
  $id("bt-json-min").onclick = () => btJsonFormat(true);
  $id("bt-re-run").onclick = btRegexRun;
  document.querySelectorAll(".bt-case-btn").forEach((b) => { b.onclick = () => btApply(btCase(b.dataset.case)); });
  $id("bt-indent-run").onclick = btIndentRun;
  $id("bt-out-to-in").onclick = () => {
    box.value = $id("bt-out").value;
    btRender();
    $id("bt-state").textContent = "结果已搬回输入";
  };

  // 清空 / 复制 / 另存为 / 发送
  $id("bt-clear").onclick = () => { box.value = ""; $id("bt-out").value = ""; btRender(); };
  $id("bt-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($id("bt-out").value); $id("bt-state").textContent = "已复制"; }
    catch (e) { $id("bt-state").textContent = "复制失败：" + String(e).slice(0, 40); }
  };
  $id("bt-download").onclick = async () => {
    try {
      const p = await dlgSave({ title: "保存批量文本结果", defaultPath: "batch.txt" });
      if (!p) return;
      await writeTextFile(p, $id("bt-out").value);
      $id("bt-state").textContent = "已保存";
    } catch (e) { $id("bt-state").textContent = "保存失败：" + String(e).slice(0, 40); }
  };
  $id("bt-send").onclick = btSendAll;
  btRender();
}

/* ============================== 计算器 ============================== */

let calcHist = [];
let calcValue = 0;          // 当前值：结果区 / 位板 / 浮点区都读它
let calcEntry = "0";        // 传统计算器正在输入的数
let calcAcc = null;         // 累积值
let calcOp = null;          // 待执行的运算符
let calcFresh = true;       // 下一个数字是不是重新开始
let calcHexPad = false;
let calcPadError = "";

const PAD_KEYS = [
  ["AC", "clear", "danger"], ["⌫", "back", ""], ["(", "ins:((", ""], [")", "ins:)", ""], ["÷", "op:/", "op"],
  ["7", "d:7", ""], ["8", "d:8", ""], ["9", "d:9", ""], ["%", "pct", ""], ["×", "op:*", "op"],
  ["4", "d:4", ""], ["5", "d:5", ""], ["6", "d:6", ""], ["±", "neg", ""], ["−", "op:-", "op"],
  ["1", "d:1", ""], ["2", "d:2", ""], ["3", "d:3", ""], ["xʸ", "op:**", "op"], ["+", "op:+", "op"],
  ["0", "d:0", ""], [".", "dot", ""], ["=", "eq", "eq"], ["√", "sqrt", ""], ["1/x", "inv", ""],
  ["A", "d:A", "hexd"], ["B", "d:B", "hexd"], ["C", "d:C", "hexd"], ["D", "d:D", "hexd"], ["E", "d:E", "hexd"],
  ["F", "d:F", "hexd"],
];

const calcNum = (v) => {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  return String(Number(v.toFixed(10)));
};
const u32 = (v) => (Math.trunc(Number(v) || 0) >>> 0);
const u32hex = (v) => "0x" + u32(v).toString(16).toUpperCase().padStart(8, "0");

function calcEntryValue() {
  if (calcHexPad) {
    const n = parseInt(calcEntry || "0", 16);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(calcEntry);
  return Number.isFinite(n) ? n : 0;
}

/** 更新结果区 / 进制 / 位板 / IEEE 读数；writeExpr=true 时把值回填表达式 */
function calcSetValue(v, writeExpr) {
  calcValue = v;
  const out = $id("calc-out");
  if (out) {
    const bad = !Number.isFinite(v) && typeof v !== "string";
    out.classList.toggle("bad", bad);
    out.textContent = typeof v === "string" ? v : calcNum(v);
  }
  calcRenderRadix(v);
  calcRenderBits();
  ieeeRenderLive(v);
  if (writeExpr) {
    const inp = $id("calc-expr");
    if (inp && document.activeElement !== inp) inp.value = u32hex(v);
  }
}

function calcError(msg) {
  const out = $id("calc-out");
  if (out) { out.classList.add("bad"); out.textContent = msg; }
}

function calcRenderPad() {
  const box = $id("calc-pad");
  if (!box) return;
  box.innerHTML = "";
  for (const [label, act, cls] of PAD_KEYS) {
    const b = el("button", cls || "", label);
    b.type = "button";
    b.dataset.act = act;
    b.onclick = () => calcPadKey(act);
    box.appendChild(b);
  }
  box.classList.toggle("hexmode", calcHexPad);
}

function calcPadKey(act) {
  const [kind, arg] = act.split(":");
  if (kind === "d") {
    if (calcFresh) { calcEntry = ""; calcFresh = false; calcPadError = ""; }
    calcEntry += arg;
    $id("calc-pad-hint").textContent = (calcHexPad ? "0x" : "") + calcEntry;
    calcSetValue(calcEntryValue(), false);
    return;
  }
  if (kind === "dot") {
    if (calcHexPad) return;               // 十六进制没有小数点
    if (calcFresh) { calcEntry = "0"; calcFresh = false; }
    if (!calcEntry.includes(".")) calcEntry += ".";
    $id("calc-pad-hint").textContent = calcEntry;
    calcSetValue(calcEntryValue(), false);
    return;
  }
  if (kind === "clear") {
    calcAcc = null; calcOp = null; calcEntry = "0"; calcFresh = true; calcPadError = "";
    $id("calc-pad-hint").textContent = "重新开始";
    calcSetValue(0, true);
    return;
  }
  if (kind === "back") {
    calcEntry = calcEntry.slice(0, -1) || "0";
    $id("calc-pad-hint").textContent = (calcHexPad ? "0x" : "") + calcEntry;
    calcSetValue(calcEntryValue(), false);
    return;
  }
  if (kind === "neg") { calcEntry = String(-calcEntryValue()); $id("calc-pad-hint").textContent = calcEntry; calcSetValue(calcEntryValue(), false); return; }
  if (kind === "pct") { calcEntry = String(calcEntryValue() / 100); calcFresh = true; $id("calc-pad-hint").textContent = calcEntry; calcSetValue(calcEntryValue(), true); return; }
  if (kind === "sqrt") { const v = Math.sqrt(calcEntryValue()); if (v < 0 || !Number.isFinite(v)) return calcError("负数不能开平方"); calcEntry = String(v); calcFresh = true; $id("calc-pad-hint").textContent = calcEntry; calcSetValue(v, true); return; }
  if (kind === "inv") { const v = calcEntryValue(); if (v === 0) return calcError("0 没有倒数"); calcEntry = String(1 / v); calcFresh = true; $id("calc-pad-hint").textContent = calcEntry; calcSetValue(1 / v, true); return; }
  if (kind === "ins") { const inp = $id("calc-expr"); inp.value += arg; inp.focus(); return; }
  if (kind === "op") {
    const cur = calcEntryValue();
    if (calcAcc === null || calcOp === null) calcAcc = cur;
    else calcAcc = calcFold(calcAcc, cur, calcOp);
    if (calcAcc === null) return;
    calcOp = arg;
    calcFresh = true;
    $id("calc-pad-hint").textContent = `${calcNum(calcAcc)} ${arg}`;
    calcSetValue(calcAcc, false);
    return;
  }
  if (kind === "eq") {
    const cur = calcEntryValue();
    const v = calcOp === null ? cur : calcFold(calcAcc, cur, calcOp);
    if (v === null) return;
    calcAcc = null; calcOp = null; calcFresh = true;
    calcEntry = String(v);
    calcHist.unshift({ e: $id("calc-pad-hint").textContent, v: calcNum(v) });
    calcHist = calcHist.slice(0, 40);
    calcRenderHist();
    $id("calc-pad-hint").textContent = calcNum(v);
    calcSetValue(v, true);
  }
}

function calcFold(a, b, op) {
  if (a === null) return b;
  let v;
  switch (op) {
    case "+": v = a + b; break;
    case "-": v = a - b; break;
    case "*": v = a * b; break;
    case "/": if (b === 0) return calcError("除数不能是 0"), null; v = a / b; break;
    case "**": v = Math.pow(a, b); break;
    case "&": v = a & b; break;
    case "|": v = a | b; break;
    case "<<": v = a << b; break;
    case ">>": v = a >> b; break;
    default: v = b;
  }
  const width = Number($id("calc-width").value) || 0;
  if (width) v = Math.trunc(v) & (2 ** width - 1);
  return v;
}

/* ------------------------- 表达式（C 风格） ------------------------- */

/** 全角符号 → 半角；只允许数字/运算符/括号/空格，别的一律拒绝（不 eval 任意代码） */
function calcSanitize(src) {
  const s = String(src)
    .replace(/[＋]/g, "+").replace(/[－—–−]/g, "-").replace(/[×＊]/g, "*").replace(/[÷／]/g, "/")
    .replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[＾]/g, "^").replace(/[，]/g, ",")
    .replace(/\^/g, "**")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) throw new Error("空表达式");
  if (!/^[0-9a-fA-FxXbBoO_\s+\-*/().,%<>&|~]+$/.test(s)) {
    throw new Error("只能算数字和 + - * / % & | ~ << >> ** 这些");
  }
  return s;
}

function calcEval(src) {
  const s = calcSanitize(src);
  // 手写递归下降（不用 eval/Function）：<< >> ** 必须排在单字符之前，否则会被拆成两个 <
  const toks = s.match(/0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d+\.?\d*(?:[eE][+-]?\d+)?|<<|>>|\*\*|[+\-*/%()<>&|~,]|\S/g) || [];
  let i = 0;
  const num = (t) => {
    const v = String(t).replace(/_/g, "");
    const n = /^0[xX]/.test(v) ? parseInt(v, 16) : /^0[bB]/.test(v) ? parseInt(v.slice(2), 2)
      : /^0[oO]/.test(v) ? parseInt(v.slice(2), 8) : Number(v);
    if (!Number.isFinite(n)) throw new Error("认不出这个数字：" + t);
    return n;
  };
  const peek = () => toks[i];
  const eat = (t) => { if (toks[i] === t) { i++; return true; } return false; };
  const primary = () => {
    const t = peek();
    if (t === undefined) throw new Error("表达式没写完");
    if (t === "(") { i++; const v = expr(); if (!eat(")")) throw new Error("括号没闭合"); return v; }
    if (t === "-") { i++; return -primary(); }
    if (t === "+") { i++; return primary(); }
    if (t === "~") { i++; return ~primary(); }
    if (!/^[0-9]/.test(t)) throw new Error("这里不该出现 " + t);
    i++;
    return num(t);
  };
  const power = () => { const b = primary(); if (eat("**")) return Math.pow(b, power()); return b; };
  const mul = () => {
    let v = power();
    for (;;) {
      const t = peek();
      if (t === "*") { i++; v = v * power(); }
      else if (t === "/") { i++; const d = power(); if (d === 0) throw new Error("除数不能是 0"); v = v / d; }
      else if (t === "%") { i++; const d = power(); if (d === 0) throw new Error("取余的除数不能是 0"); v = v % d; }
      else return v;
    }
  };
  const sum = () => {
    let v = mul();
    for (;;) {
      const t = peek();
      if (t === "+") { i++; v = v + mul(); }
      else if (t === "-") { i++; v = v - mul(); }
      else return v;
    }
  };
  const shift = () => {
    let v = sum();
    for (;;) {
      const t = peek();
      if (t === "<<") { i++; v = v << sum(); }
      else if (t === ">>") { i++; v = v >> sum(); }
      else return v;
    }
  };
  const band = () => { let v = shift(); while (eat("&")) v = v & shift(); return v; };
  const bor = () => { let v = band(); while (eat("|")) v = v | band(); return v; };
  const expr = () => bor();
  const val = expr();
  if (i < toks.length) throw new Error("多余的字符：" + toks.slice(i).join(" "));
  return val;
}

function calcRun(expr, record) {
  const src = expr !== undefined ? expr : $id("calc-expr").value;
  let v;
  try {
    v = calcEval(src);
  } catch (e) {
    return calcError(String(e.message || e));
  }
  const width = Number($id("calc-width").value) || 0;
  if (width && Number.isFinite(v)) v = Math.trunc(v) & (2 ** width - 1);
  if (record !== false) {
    calcHist.unshift({ e: src, v: calcNum(v) });
    calcHist = calcHist.slice(0, 40);
    calcRenderHist();
  }
  calcEntry = String(v);
  calcFresh = true;
  calcSetValue(v, false);
  return v;
}

/* --------------------------- 进制 / 位板 --------------------------- */

function calcRenderRadix(v) {
  const rows = [];
  const push = (k, val, cls) => {
    const r = el("div", "row");
    r.append(el("span", "k", k), el("span", "v" + (cls ? " " + cls : ""), val));
    rows.push(r);
  };
  if (Number.isFinite(v)) {
    const iv = Math.trunc(v);
    push("DEC", String(iv));
    push("HEX", (iv < 0 ? "-" : "") + "0x" + Math.abs(iv).toString(16).toUpperCase());
    push("BIN", (iv < 0 ? "-" : "") + "0b" + Math.abs(iv).toString(2));
    push("OCT", (iv < 0 ? "-" : "") + "0o" + Math.abs(iv).toString(8));
    if (iv >= 0 && iv <= 0xffffffff) push("字节", iv <= 0xff ? "1 字节" : iv <= 0xffff ? "2 字节" : "4 字节");
  } else {
    push("值", String(v), "bad");
  }
  const r1 = $id("calc-radix");
  if (r1) { r1.innerHTML = ""; rows.slice(0, 2).forEach((r) => r1.appendChild(r.cloneNode(true))); }
  const r2 = $id("calc-radix2");
  if (r2) { r2.innerHTML = ""; rows.slice(2).forEach((r) => r2.appendChild(r.cloneNode(true))); }
}

/** 32 位控制板：4 行（每行 8 位，MSB 在左），点一下就能翻那一位 */
function calcRenderBits() {
  const box = $id("calc-bits");
  if (!box) return;
  const v = u32(calcValue);
  if (!box.children.length) {
    for (let byte = 3; byte >= 0; byte--) {
      const row = el("div", "bitrow");
      row.append(el("span", "bl", `B${byte} [${byte * 8 + 7}..${byte * 8}]`));
      const bits = el("div", "bits");
      for (let k = 7; k >= 0; k--) {
        const bit = byte * 8 + k;
        const b = el("button", "bit", "0");
        b.type = "button";
        b.dataset.bit = String(bit);
        b.onclick = () => {
          const nv = (u32(calcValue) ^ (1 << bit)) >>> 0;
          calcEntry = String(nv >>> 0);
          calcFresh = true;
          calcSetValue(nv, true);      // 反馈到计算区
        };
        bits.appendChild(b);
      }
      row.append(bits);
      row.append(el("span", "bhex", "00"));
      box.appendChild(row);
    }
  }
  const rows = [...box.children];
  rows.forEach((row, idx) => {
    const byte = 3 - idx;
    const val = (v >>> (byte * 8)) & 0xff;
    [...row.querySelectorAll(".bit")].forEach((b) => {
      const bit = Number(b.dataset.bit);
      const on = (v >>> bit) & 1;
      b.textContent = on ? "1" : "0";
      b.classList.toggle("on", !!on);
      b.title = `bit ${bit}（${on ? "1" : "0"}）`;
    });
    const hx = row.querySelector(".bhex");
    if (hx) hx.textContent = "0x" + val.toString(16).toUpperCase().padStart(2, "0");
  });
}

function calcBitsOp(kind) {
  const v = u32(calcValue);
  let nv = v;
  if (kind === "zero") nv = 0;
  else if (kind === "not") nv = (~v) >>> 0;
  else if (kind === "shl") nv = (v << 1) >>> 0;
  else if (kind === "shr") nv = v >>> 1;
  else if (kind === "rol") nv = ((v << 1) | (v >>> 31)) >>> 0;
  else if (kind === "ror") nv = ((v >>> 1) | (v << 31)) >>> 0;
  else if (kind === "feed") { $id("calc-expr").value = u32hex(v); calcRun(u32hex(v)); return; }
  calcEntry = String(nv);
  calcFresh = true;
  calcSetValue(nv, true);
}

/* --------------------------- IEEE 754 --------------------------- */

const ieee32 = (() => {
  const b = new ArrayBuffer(4);
  return { view: new DataView(b), buf: new Uint8Array(b) };
})();
const ieee64 = (() => {
  const b = new ArrayBuffer(8);
  return { view: new DataView(b), buf: new Uint8Array(b) };
})();

const hex8 = (bytes, n) => [...bytes].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join("").slice(0, n * 2);
let ieeeManual = false;         // 用户手动转过 IEEE 面板：同一个值就别被"实时"覆盖
let ieeeManualValue = null;

function ieeeRows(label, v, bitsHex, width) {
  const rows = [];
  const push = (k, val, cls) => {
    const r = el("div", "row");
    r.append(el("span", "k", k), el("span", "v" + (cls ? " " + cls : ""), val));
    rows.push(r);
  };
  push(label + " HEX", bitsHex);
  push("十进制", String(v));
  push("科学计数", Number.isFinite(v) ? v.toExponential(7) : String(v));
  if (width === 32) {
    // 注意：阶码/尾数是**按位**切的，不是按字节 —— 符号 1 位、阶码 8 位、尾数 23 位
    const raw = parseInt(bitsHex, 16) >>> 0;
    const sign = (raw >>> 31) & 1;
    const exp = (raw >>> 23) & 0xff;
    const mant = raw & 0x7fffff;
    push("符号", sign ? "-1（负数）" : "+1（正数）");
    push("阶码", `${exp} - 127 = ${exp - 127}（0x${exp.toString(16).toUpperCase().padStart(2, "0")}）`);
    push("尾数", "0x" + mant.toString(16).toUpperCase().padStart(6, "0"));
    // 32 位二进制按字节隔开，肉眼好对
    push("二进制", bitsHex.match(/../g).map((h) => parseInt(h, 16).toString(2).padStart(8, "0")).join(" "));
  }
  return rows;
}

function ieeeRenderRows(rows, boxId) {
  const box = $id(boxId);
  if (!box) return;
  box.innerHTML = "";
  rows.forEach((r) => box.appendChild(r));
}

function ieeeRenderLive(v) {
  // 结果区一变，顺手把"当前值的 float32 位"显示出来（不用按转换）
  const box = $id("ieee-out");
  if (!box || !Number.isFinite(v)) return;
  if (ieeeManual && v === ieeeManualValue) return;   // 刚手动转过这个值，别覆盖
  ieeeManual = false;
  const f = Math.fround(v);
  ieee32.view.setFloat32(0, f, false);
  const cur = hex8(ieee32.buf, 4);
  ieeeRenderRows(ieeeRows("float32", f, cur, 32), "ieee-out");
}

function ieeeConvert() {
  const mode = $id("ieee-mode").value;
  const raw = ($id("ieee-in").value || "").trim();
  if (!raw) return;
  ieeeManual = true;
  ieeeManualValue = calcValue;
  try {
    if (mode === "f2b") {
      const v = Number(raw.startsWith("0x") ? parseInt(raw, 16) : raw);
      if (!Number.isFinite(v)) throw new Error("这不是个数：" + raw);
      const f = Math.fround(v);
      ieee32.view.setFloat32(0, f, false);
      ieee64.view.setFloat64(0, v, false);
      const rows = [
        ...ieeeRows("float32（单精度）", f, hex8(ieee32.buf, 4), 32),
        ...ieeeRows("float64（双精度）", v, hex8(ieee64.buf, 8), 64),
      ];
      ieeeRenderRows(rows, "ieee-out");
    } else {
      const hex = raw.replace(/^0x/i, "").replace(/\s+/g, "").toUpperCase();
      if (!/^[0-9A-F]{8}$|^[0-9A-F]{16}$/.test(hex)) throw new Error("位模式下要填 8 位（float32）或 16 位（float64）十六进制");
      const width = hex.length * 4;
      const bytes = new Uint8Array(width / 8);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const view = new DataView(bytes.buffer);
      const v = width === 32 ? view.getFloat32(0, false) : view.getFloat64(0, false);
      ieeeRenderRows(ieeeRows(`float${width}`, v, hex, width), "ieee-out");
      calcSetValue(v, true);
    }
  } catch (e) {
    ieeeRenderRows([el("div", "sub", String(e.message || e))], "ieee-out");
  }
}

/* ------------------------- 文件校验（右栏） ------------------------- */

let calcFile = "";

function digestRow(k, v, mono) {
  const r = el("div", "row");
  r.append(el("span", "k", k), el("span", "v" + (mono ? " calc-file-row" : ""), v));
  return r;
}

async function calcFileGo() {
  const box = $id("calc-file-out");
  if (!box) return;
  if (!calcFile) { box.innerHTML = ""; return; }
  box.innerHTML = "";
  box.appendChild(el("div", "sub", "计算中…"));
  try {
    const r = await invoke("file_digest", {
      path: calcFile,
      offset: Number($id("calc-file-off").value) || 0,
      length: Number($id("calc-file-len").value) || 0,
    });
    if (!box) return;
    box.innerHTML = "";
    box.append(
      digestRow("文件大小", `${Number(r.size).toLocaleString()} 字节`),
      digestRow("算的范围", `${r.offset} + ${r.length}`),
      digestRow("CRC32", r.crc32),
      digestRow("CRC16/CCITT", r.crc16Ccitt),
      digestRow("CRC16/MODBUS", r.crc16Modbus),
      digestRow("MD5", r.md5, true),
      digestRow("SHA1", r.sha1, true),
      digestRow("SHA256", r.sha256, true),
    );
    const copy = el("button", "btn small", "复制全部");
    const line = el("div", "trow");
    line.appendChild(copy);
    copy.onclick = async () => {
      const text = [
        `文件: ${r.path}`, `大小: ${r.size}`, `范围: ${r.offset}+${r.length}`,
        `CRC32: ${r.crc32}`, `CRC16/CCITT: ${r.crc16Ccitt}`, `CRC16/MODBUS: ${r.crc16Modbus}`,
        `MD5: ${r.md5}`, `SHA1: ${r.sha1}`, `SHA256: ${r.sha256}`,
      ].join("\n");
      try { await navigator.clipboard.writeText(text); copy.textContent = "已复制"; }
      catch (_) { copy.textContent = "复制失败"; }
    };
    box.appendChild(line);
    if ($id("calc-file-into").checked) {
      const v = Number(r.crc32Int) >>> 0;
      $id("calc-expr").value = u32hex(v);
      calcRun(u32hex(v));
    }
  } catch (e) {
    if (box) { box.innerHTML = ""; box.appendChild(el("div", "sub", String(e))); }
  }
}

/* ------------------------------ 初始化 ------------------------------ */

function calcRenderHist() {
  const box = $id("calc-hist");
  if (!box) return;
  box.innerHTML = "";
  if (!calcHist.length) { box.appendChild(el("div", "sub", "（还没算过）")); return; }
  for (const h of calcHist) {
    const r = el("div", "r");
    r.append(el("span", "e", h.e), el("span", "v", h.v));
    r.title = "点一下填回输入框";
    r.onclick = () => { $id("calc-expr").value = h.e; calcRun(h.e, false); };
    box.appendChild(r);
  }
}

function calcRenderBaud() {
  const box = $id("calc-baud");
  if (!box) return;
  box.innerHTML = "";
  for (const b of [9600, 57600, 115200, 230400, 460800, 921600]) {
    const us = 1e6 / b;
    const r = el("div", "row");
    r.append(el("span", "k", String(b)), el("span", "v", `${us.toFixed(2)} µs/位 · 一字节约 ${(us * 10).toFixed(0)} µs`));
    box.appendChild(r);
  }
}

export function initCalc() {
  const box = $id("calc-expr");
  if (!box || box.__bound) return;
  box.__bound = true;

  calcRenderPad();
  box.oninput = () => calcRun(box.value, false);
  box.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); calcRun(box.value); } };
  $id("calc-go").onclick = () => calcRun(box.value);
  $id("calc-hexmode").onchange = (e) => {
    calcHexPad = e.target.checked;
    if ($id("calc-pad-hex")) $id("calc-pad-hex").checked = calcHexPad;
    calcEntry = calcHexPad ? u32(calcEntryValue()).toString(16).toUpperCase() : String(calcEntryValue());
    calcRenderPad();
    $id("calc-pad-hint").textContent = (calcHexPad ? "0x（十六进制输入）" : "十进制输入");
  };
  if ($id("calc-pad-hex")) {
    $id("calc-pad-hex").onchange = (e) => {
      $id("calc-hexmode").checked = e.target.checked;
      $id("calc-hexmode").dispatchEvent(new Event("change"));
    };
  }
  document.querySelectorAll(".calc-quick").forEach((b) => {
    b.onclick = () => { box.value += b.dataset.q || ""; box.focus(); calcRun(box.value, false); };
  });
  for (const [id, kind] of [["bit-zero", "zero"], ["bit-not", "not"], ["bit-shl", "shl"], ["bit-shr", "shr"],
                            ["bit-rol", "rol"], ["bit-ror", "ror"], ["bit-byte-not", "not"], ["bit-feed", "feed"]]) {
    const n = $id(id);
    if (n) n.onclick = () => calcBitsOp(kind);
  }
  $id("calc-width").onchange = () => calcRun(box.value, false);
  $id("calc-hist-clear").onclick = () => { calcHist = []; calcRenderHist(); };
  $id("calc-insert").onclick = () => {
    const v = Number.isFinite(calcValue) ? calcNum(calcValue) : $id("calc-out").textContent;
    const tx = $id("tx");
    if (tx) { tx.value = v; tx.focus(); }
  };
  $id("calc-result-to-support").onclick = () => {
    $id("ieee-mode").value = "f2b";
    $id("ieee-in").value = Number.isFinite(calcValue) ? String(calcValue) : "";
    ieeeConvert();
  };

  // IEEE
  $id("ieee-go").onclick = ieeeConvert;
  $id("ieee-in").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ieeeConvert(); } };
  $id("ieee-use-calc").onclick = () => {
    $id("ieee-mode").value = Number.isInteger(calcValue) ? "b2f" : "f2b";
    $id("ieee-in").value = Number.isInteger(calcValue) ? u32hex(calcValue) : String(calcValue);
    ieeeConvert();
  };

  // 文件校验
  $id("calc-file-pick").onclick = async () => {
    try {
      const p = await dlgOpen({ title: "选要算 CRC/哈希的文件", multiple: false, directory: false });
      const path = typeof p === "string" ? p : (p && p.path);
      if (!path) return;
      calcFile = path;
      const nm = $id("calc-file-name");
      nm.textContent = path.replace(/.*[\\/]/, "");
      nm.title = path;
      calcFileGo();
    } catch (e) {
      $id("calc-file-name").textContent = "选文件失败：" + String(e).slice(0, 50);
    }
  };
  $id("calc-file-go").onclick = calcFileGo;

  box.value = "0x1F & 0x0F << 2";
  calcRun(box.value, false);
  calcRenderHist();
  calcRenderBaud();
  calcRenderBits();
}
