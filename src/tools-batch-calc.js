// ── 工具页：批量文本 / 计算器 ─────────────────────────────────────────
// 两个纯本地页（不进 agent、不需要设备）。main.js 只在切页时调 init。
import { save as dlgSave, open as dlgOpen } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const $id = (id) => document.getElementById(id);
/** 翻译：main.js 把 en() 挂在 window 上（这个文件是独立模块，拿不到它的作用域） */
const T = (s) => (window.kdockT ? window.kdockT(s) : s);
const onLang = (fn) => { if (window.kdockOnLang) window.kdockOnLang(fn); };
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
  $id("bt-count").textContent = lines.length + T(" 行") + " · " + lines.reduce((a, l) => a + l.length, 0) + T(" 字");
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
    btMsg(T("正则写错了：") + String(e.message || e).slice(0, 80), true);
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
  if (!$id("bt-find").value) { info.textContent = T("没在找"); return; }
  const n = btMatches($id("bt-in").value).length;
  info.textContent = n ? T("找到 ") + n + T(" 处") : T("没找到");
}

function btFindStep(dir) {
  const ta = $id("bt-in");
  const ms = btMatches(ta.value);
  if (!ms.length) { $id("bt-find-count").textContent = T("没找到"); return; }
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
  btMsg(T("已全部替换"));
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
      if (m) btMsg(T("JSON 解析失败（第 ") + (Number(m[1]) + 1) + T(" 个字符）：") + e.message, true);
      else btMsg(T("JSON 解析失败：") + String(e.message || e).slice(0, 80), true);
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
  if (!pat) { btMsg(T("先写个正则"), true); return; }
  let re;
  try { re = new RegExp(pat, "g"); } catch (e) {
    btMsg(T("正则写错了：") + String(e.message || e).slice(0, 80), true);
    return;
  }
  const rep = $id("bt-re-rep").value;
  const scope = $id("bt-re-scope").value;
  btApply((text) => {
    if (scope === "line") return text.split("\n").map((l) => l.replace(re, rep)).join("\n");
    return text.replace(re, rep);
  });
  btMsg(T(scope === "line" ? "正则批量处理完成（每行单独）" : "正则批量处理完成（全文）"));
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
    $id("bt-state").textContent = T("发送中 ") + (i + 1) + "/" + lines.length;
    try {
      const ack = await invoke("write_data", { payload: lines[i], mode: "text", lineEnding: le });
      btPushTx({ dir: "TX", ts_ms: Date.now(), text: ack.text, hex: ack.hex, ascii: ack.ascii });
    } catch (e) {
      $id("bt-state").textContent = T("出错：") + String(e).slice(0, 60);
      break;
    }
    if (i < lines.length - 1 && gap) await new Promise((r) => setTimeout(r, gap));
  }
  btSending = false;
  $id("bt-send").classList.remove("primary");
  if ($id("bt-state").textContent.startsWith(T("发送中"))) $id("bt-state").textContent = T("发完了");
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
    $id("bt-state").textContent = T("结果已搬回输入");
  };

  // 清空 / 复制 / 另存为 / 发送
  $id("bt-clear").onclick = () => { box.value = ""; $id("bt-out").value = ""; btRender(); };
  $id("bt-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($id("bt-out").value); $id("bt-state").textContent = T("已复制"); }
    catch (e) { $id("bt-state").textContent = T("复制失败：") + String(e).slice(0, 40); }
  };
  $id("bt-download").onclick = async () => {
    try {
      const p = await dlgSave({ title: T("保存批量文本结果"), defaultPath: "batch.txt" });
      if (!p) return;
      await writeTextFile(p, $id("bt-out").value);
      $id("bt-state").textContent = T("已保存");
    } catch (e) { $id("bt-state").textContent = T("保存失败：") + String(e).slice(0, 40); }
  };
  $id("bt-send").onclick = btSendAll;
  btRender();
  // 切语言时把这一页里"运行时拼出来的"文字重画一遍
  onLang(() => { btRender(); btUpdateCount(); });
}

/* ============================== 计算器 ============================== */

let calcValue = 0;          // 当前值：显示区 / 位板 / 浮点区都读它
let calcEntry = "0";        // 传统计算器正在输入的数
let calcAcc = null;         // 累积值
let calcOp = null;          // 待执行的运算符
let calcFresh = true;       // 下一个数字是不是重新开始
let calcHexPad = false;     // 键盘按十六进制解释（跟着显示进制走）
let calcPadError = "";
let calcBase = "dec";       // 显示进制：dec / hex / oct / bin
let calcFloatShow = false;  // 显示区是不是在看 IEEE-754 单精度解释
const CALC_MARK_KEY = "kdock_calc_marked";   // 只有标记过的历史才写这里
const CALC_SPLIT_KEY = "kdock_calc_split";   // 上下比例

/** 历史：内存里是全部；只有 marked=true 的会写盘（没标记的关掉软件就没了） */
function calcHistLoad() {
  try {
    const a = JSON.parse(localStorage.getItem(CALC_MARK_KEY) || "[]");
    if (Array.isArray(a)) {
      return a.filter((x) => x && x.e != null).map((x) => ({ e: String(x.e), v: String(x.v), base: x.base || "dec", marked: true }));
    }
  } catch (_) {}
  return [];
}
function calcHistSave() {
  try {
    localStorage.setItem(CALC_MARK_KEY, JSON.stringify(calcHist.filter((h) => h.marked).map((h) => ({ e: h.e, v: h.v, base: h.base }))));
  } catch (_) {}
}
let calcHist = calcHistLoad();
/** 超长了先丢最老的没标记的（标记过的一律留着） */
function calcHistTrim() {
  while (calcHist.length > 200) {
    const i = calcHist.findLastIndex((h) => !h.marked);
    if (i < 0) break;
    calcHist.splice(i, 1);
  }
  if (calcHist.length > 400) calcHist = calcHist.slice(0, 400);
}

// 7 列 × 8 行 = 56 个键。左边这坨 = 传统计算器该有的算式符号 + 程序员要的 A-F / 位运算 / 位板操作，
// 下面两行是"进制显示 + 浮点"这几个大键（2 格宽）。
const PAD_KEYS = [
  // 第 1 行：进制显示 + 浮点 —— 单独高亮一排，放最上面
  [["以 16 进制显示", "base:hex", "base hi", 2], ["以 10 进制显示", "base:dec", "base hi", 2], ["以 2 进制显示", "base:bin", "base hi", 2], ["→ 浮点", "float", "base hi"]],
  [["A", "d:A", "hexd"], ["B", "d:B", "hexd"], ["C", "d:C", "hexd"], ["D", "d:D", "hexd"], ["E", "d:E", "hexd"], ["F", "d:F", "hexd"], ["AC", "clear", "danger"]],
  [["<<", "op:<<", "op"], [">>", "op:>>", "op"], ["AND", "op:&", "op"], ["OR", "op:|", "op"], ["XOR", "op:^", "op"], ["NOT", "op:~", "op"], ["←", "back", "", 1, "退格（删一个字符）"]],
  [["7", "d:7", ""], ["8", "d:8", ""], ["9", "d:9", ""], ["÷", "op:/", "op"], ["×", "op:*", "op"], ["%", "pct", ""], ["±", "neg", ""]],
  [["4", "d:4", ""], ["5", "d:5", ""], ["6", "d:6", ""], ["−", "op:-", "op"], ["+", "op:+", "op"], ["x²", "sqr", "op"], ["√", "sqrt", ""]],
  [["1", "d:1", ""], ["2", "d:2", ""], ["3", "d:3", ""], ["xʸ", "op:**", "op"], ["1/x", "inv", ""], ["x³", "pow3", "op"], ["n!", "fact", "op"]],
  [["0", "d:0", ""], [".", "dot", ""], ["(", "ins:(", ""], [")", "ins:)", ""], ["字节交换", "bits:bswap", "base"], ["MOD", "op:%", "op"], ["CE", "ce", ""]],
  [["清零", "bits:zero", "bit"], ["取反", "bits:not", "bit"], ["<< 1", "bits:shl", "bit"], [">> 1", "bits:shr", "bit"], ["↺ 1", "bits:rol", "bit"], ["↻ 1", "bits:ror", "bit"], ["全反", "bits:not32", "bit"]],
];

/** 这个数字/字母键在当前进制下能不能按（跟 Windows 计算器一样：二进制只留 0/1） */
function calcDigitAllowed(ch) {
  if (/^[0-9]$/.test(ch)) return Number(ch) <= (calcBase === "bin" ? 1 : calcBase === "oct" ? 7 : 9);
  if (/^[A-F]$/.test(ch)) return calcBase === "hex";
  return true;
}

/** 从右往左每 n 个字符插一个分隔符："DEADBEEF" → "DEAD BEEF"、"1234567" → "1,234,567" */
function calcGroup(str, n, sep) {
  const raw = String(str).replace(/\s+/g, "");
  const sign = /^-/.test(raw) ? "-" : "";
  const a = sign ? raw.slice(1) : raw;
  let out = "";
  for (let i = 0; i < a.length; i++) {
    if (i && (a.length - i) % n === 0) out += sep;
    out += a[i];
  }
  return sign + out;
}
/** 这个值在当前（或指定）进制下人看的样子：10 进制 3 位一逗号，16/2 进制 4 位一空格，8 进制 3 位一空格 */
function calcFmt(v, base) {
  const b = base || calcBase;
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return String(v);
  const iv = Math.trunc(v);
  const sign = iv < 0 ? "-" : "";
  const a = Math.abs(iv);
  if (b === "hex") return sign + "0x" + calcGroup(a.toString(16).toUpperCase(), 4, " ");
  if (b === "oct") return sign + "0o" + calcGroup(a.toString(8), 3, " ");
  if (b === "bin") return sign + "0b" + calcGroup(a.toString(2), 4, " ");
  return sign + calcGroup(String(a), 3, ",");
}
/** 当前进制的基数 + 小数/整数字面"看着像几进制" */
const calcBaseRadix = () => (calcBase === "hex" ? 16 : calcBase === "bin" ? 2 : calcBase === "oct" ? 8 : 10);

const calcNum = (v) => {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  return String(Number(v.toFixed(10)));
};
const u32 = (v) => (Math.trunc(Number(v) || 0) >>> 0);
const u32hex = (v) => "0x" + u32(v).toString(16).toUpperCase().padStart(8, "0");

/** 位宽：跟着"敲进去的数位"或"这个值本身需要多少位"走，凑成 4 的倍数（8~64）。
 *  为什么要按数位：允许打 0036 这种前导零，数位本身就是用户想要的宽度。 */
function calcAutoBits(entryText, v) {
  const raw = String(entryText == null ? "" : entryText).trim();
  let radix = calcBaseRadix();
  if (/^-?0[xX]/.test(raw)) radix = 16;
  else if (/^-?0[bB]/.test(raw)) radix = 2;
  else if (/^-?0[oO]/.test(raw)) radix = 8;
  const txt = raw.replace(/^-?(0[xXbBoO])?/, "").replace(/[^0-9A-Fa-f]/g, "");
  let bits;
  if (txt) bits = Math.ceil((txt.length * Math.log2(radix)) / 4) * 4;
  else {
    const n = Math.abs(Math.trunc(Number(v) || 0));
    bits = Math.max(4, n.toString(2).length);
    bits = Math.ceil(bits / 4) * 4;
  }
  return Math.max(8, Math.min(64, bits));
}
/** 当前位宽（每次重画时按"正在敲的字面量/当前值"重算） */
let calcBits = 32;

function calcEntryValue() {
  const radix = calcBaseRadix();
  if (radix !== 10) {
    const n = parseInt(String(calcEntry || "0").replace(/^0[xbo]/i, ""), radix);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(calcEntry);
  return Number.isFinite(n) ? n : 0;
}

/** 显示区（大字）= 小字算式下面那一行；按当前进制/浮点模式画 */
function calcRenderBig() {
  const out = $id("calc-out");
  if (!out) return;
  const v = calcValue;
  const tag = $id("calc-base");
  const typing = document.activeElement === out;
  if (calcFloatShow && Number.isFinite(v)) {
    if (!typing) out.value = String(Math.fround(v));
    if (tag) tag.textContent = "FLOAT32";
  } else {
    if (!typing) out.value = calcFmt(v);
    if (tag) tag.textContent = calcBase.toUpperCase();
  }
  const wt = $id("calc-width-tag");
  if (wt) wt.textContent = T("位宽") + " " + calcBits;
  const sub = $id("calc-sub");
  if (sub) {
    if (!Number.isFinite(v)) sub.textContent = "";
    else {
      const u = u32(v);
      sub.textContent = (calcFloatShow ? "FLOAT32 " + Math.fround(v) + " · " : "float " + Math.fround(v) + " · ") +
        "U32 " + calcFmt(u, "hex") + " · " + calcGroup(String(u), 3, ",");
    }
  }
}

/** 换显示进制（同时把键盘的输入进制、能用哪些数字键跟着换） */
function calcSetBase(base, silent) {
  calcBase = ["hex", "oct", "bin", "dec"].includes(base) ? base : "dec";
  calcHexPad = calcBase === "hex";
  document.querySelectorAll('[data-act^="base:"]').forEach((b) => b.classList.toggle("on", b.dataset.act === "base:" + calcBase));
  const pad = $id("calc-pad");
  if (pad) pad.classList.toggle("hexmode", calcHexPad);
  calcRenderPad();
  if (!silent) {
    const hint = $id("calc-pad-hint");
    if (hint) hint.textContent = T(calcBase === "hex" ? "0x（十六进制输入）" : calcBase === "bin" ? "二进制输入" : calcBase === "oct" ? "八进制输入" : "十进制输入");
    calcSetValue(calcValue, false);
  } else {
    calcRenderBig();
  }
}

/** 更新结果区 / 进制 / 位板 / IEEE 读数；writeExpr=true 时把值回填表达式 */
function calcSetValue(v, writeExpr) {
  calcValue = v;
  const out = $id("calc-out");
  if (out) {
    const bad = !Number.isFinite(v) && typeof v !== "string";
    out.classList.toggle("bad", bad);
    if (bad) out.value = typeof v === "string" ? v : calcNum(v);
  }
  if (Number.isFinite(v)) calcBits = calcAutoBits(calcFresh ? null : calcEntry, v);
  calcRenderBig();
  if (out && !Number.isFinite(v) && typeof v !== "string") return;   // 出错时别覆盖错误文字
  calcRenderRadix(v);
  calcRenderBits();
  ieeeRenderLive(v);
}

function calcError(msg) {
  const out = $id("calc-out");
  if (out) { out.classList.add("bad"); out.value = msg; }
}

function calcRenderPad() {
  const box = $id("calc-pad");
  if (!box) return;
  box.innerHTML = "";
  for (const row of PAD_KEYS) {
    for (const [label, act, cls, span, tip] of row) {
      const b = el("button", cls || "", label);
      b.type = "button";
      b.dataset.act = act;
      if (tip) b.title = T(tip);
      if (span) b.style.gridColumn = "span " + span;
      b.onclick = () => calcPadKey(act);
      box.appendChild(b);
    }
  }
  box.classList.toggle("hexmode", calcHexPad);
  // 当前进制用不上的数字键直接禁用（二进制里按 9 没意义）
  box.querySelectorAll("button").forEach((b) => {
    const act = b.dataset.act || "";
    const ch = act.startsWith("d:") ? act.slice(2) : "";
    if (ch.length === 1) b.disabled = !calcDigitAllowed(ch);
  });
}

function calcPadKey(act) {
  const [kind, arg] = act.split(":");
  if (kind === "bits") { calcBitsOp(arg); return; }
  if (kind === "mark") { $id("calc-pad-hint").textContent = calcMarkCurrent(); return; }
  if (kind === "base") { calcSetBase(arg); return; }
  if (kind === "float") {
    calcFloatShow = !calcFloatShow;
    const fb = $id("calc-to-float");
    if (fb) fb.classList.toggle("on", calcFloatShow);
    calcRenderBig();
    $id("calc-pad-hint").textContent = T(calcFloatShow ? "显示：IEEE-754 单精度解释" : "显示：整数");
    return;
  }
  if (kind === "ce") {                        // CE：只清当前输入，不动累积值
    calcEntry = "0";
    calcFresh = true;
    $id("calc-pad-hint").textContent = T("重新开始");
    calcSetValue(0, false);
    return;
  }
  if (kind === "pow3") {
    const v = calcEntryValue() ** 3;
    calcEntry = String(v);
    calcFresh = true;
    $id("calc-pad-hint").textContent = calcNum(v);
    calcSetValue(v, false);
    calcLogPush(T("立方") + " " + calcFmt(v), v);
    return;
  }
  if (kind === "fact") {
    const n0 = Math.trunc(calcEntryValue());
    if (n0 < 0 || n0 > 170) { $id("calc-pad-hint").textContent = T("阶乘只支持 0~170 的整数"); return; }
    let v = 1;
    for (let i = 2; i <= n0; i++) v *= i;
    calcEntry = String(v);
    calcFresh = true;
    $id("calc-pad-hint").textContent = calcNum(v);
    calcSetValue(v, false);
    calcLogPush(T("阶乘") + " " + n0 + "!", v);
    return;
  }
  if (kind === "sqr") {
    const v = calcEntryValue() ** 2;
    calcEntry = String(v);
    calcFresh = true;
    $id("calc-pad-hint").textContent = calcNum(v);
    calcSetValue(v, false);
    calcLogPush(T("平方") + " " + calcFmt(v), v);
    return;
  }
  if (kind === "hexmode") {                 // 切"键盘按十六进制解释"
    const cb = $id("calc-hexmode");
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
    return;
  }
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
    $id("calc-pad-hint").textContent = T("重新开始");
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
  if (kind === "sqrt") { const v = Math.sqrt(calcEntryValue()); if (v < 0 || !Number.isFinite(v)) return calcError(T("负数不能开平方")); calcEntry = String(v); calcFresh = true; $id("calc-pad-hint").textContent = calcEntry; calcSetValue(v, true); return; }
  if (kind === "inv") { const v = calcEntryValue(); if (v === 0) return calcError(T("0 没有倒数")); calcEntry = String(1 / v); calcFresh = true; $id("calc-pad-hint").textContent = calcEntry; calcSetValue(1 / v, true); return; }
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
    const label = calcOp === null
      ? (calcBaseRadix() === 10 ? calcNum(cur) : calcFmt(cur))
      : calcFmt(calcAcc) + " " + (calcOp === "**" ? "^" : calcOp) + " " + calcFmt(cur);
    calcAcc = null; calcOp = null; calcFresh = true;
    calcEntry = String(v);
    calcLogPush(label, v);
    calcExprSet(label);
    $id("calc-pad-hint").textContent = calcNum(v);
    calcSetValue(v, false);
  }
}

function calcFold(a, b, op) {
  if (a === null) return b;
  let v;
  switch (op) {
    case "+": v = a + b; break;
    case "-": v = a - b; break;
    case "*": v = a * b; break;
    case "/": if (b === 0) return calcError(T("除数不能是 0")), null; v = a / b; break;
    case "**": v = Math.pow(a, b); break;
    case "&": v = a & b; break;
    case "|": v = a | b; break;
    case "^": v = a ^ b; break;
    case "~": v = ~a; break;
    case "<<": v = a << b; break;
    case ">>": v = a >> b; break;
    default: v = b;
  }
  // 位运算按当前位宽收口（算术 + - × ÷ 不动，免得 200*200 被掩成 64）
  if (["&", "|", "^", "~", "<<", ">>"].includes(op)) {
    const bits = calcBits || 32;
    v = Math.trunc(v) & (2 ** bits - 1);
  }
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
  if (!s) throw new Error(T("空表达式"));
  if (!/^[0-9a-fA-FxXbBoO_\s+\-*/().,%<>&|~]+$/.test(s)) {
    throw new Error(T("只能算数字和 + - * / % & | ~ << >> ** 这些"));
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
    if (!Number.isFinite(n)) throw new Error(T("认不出这个数字：") + t);
    return n;
  };
  const peek = () => toks[i];
  const eat = (t) => { if (toks[i] === t) { i++; return true; } return false; };
  const primary = () => {
    const t = peek();
    if (t === undefined) throw new Error(T("表达式没写完"));
    if (t === "(") { i++; const v = expr(); if (!eat(")")) throw new Error(T("括号没闭合")); return v; }
    if (t === "-") { i++; return -primary(); }
    if (t === "+") { i++; return primary(); }
    if (t === "~") { i++; return ~primary(); }
    if (!/^[0-9]/.test(t)) throw new Error(T("这里不该出现 ") + t);
    i++;
    return num(t);
  };
  const power = () => { const b = primary(); if (eat("**")) return Math.pow(b, power()); return b; };
  const mul = () => {
    let v = power();
    for (;;) {
      const t = peek();
      if (t === "*") { i++; v = v * power(); }
      else if (t === "/") { i++; const d = power(); if (d === 0) throw new Error(T("除数不能是 0")); v = v / d; }
      else if (t === "%") { i++; const d = power(); if (d === 0) throw new Error(T("取余的除数不能是 0")); v = v % d; }
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
  if (i < toks.length) throw new Error(T("多余的字符：") + toks.slice(i).join(" "));
  return val;
}

/** 上面那行小字 = 这一步的算式 */
function calcExprLineSet(text) {
  const el = $id("calc-expr-line");
  if (el) el.textContent = text || "";
}
/** 写/清表达式（两边一起：下面的输入框 + 上面的过程显示） */
function calcExprSet(text) {
  const inp = $id("calc-expr");
  if (inp) inp.value = text || "";
  calcExprLineSet(text);
}
function calcExprClear() {
  const inp = $id("calc-expr");
  if (inp) inp.value = "";
  calcExprLineSet("");
}

/** 算完一步：顶部"历史计算过程"加一行（6*8 = 48），顺手记进右侧历史 */
function calcLogPush(text, v) {
  calcExprLineSet(text);
  calcHistPush(text, v);
  const box = $id("calc-log");
  if (!box) return;
  box.appendChild(el("div", "l", text + " = " + calcFmt(v)));
  while (box.children.length > 8) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/** 大字结果那行可以直接键盘输入：按当前进制收数字，输入即视为"手改数据" → 原算式清空 */
function calcBindOutInput() {
  const out = $id("calc-out");
  if (!out || out.__bound) return;
  out.__bound = true;
  const apply = () => {
    const radix = calcBaseRadix();
    let t = String(out.value || "").replace(/[\s,]/g, "").replace(/^0[xbo]/i, "").replace(/^-/, "");
    t = t.replace(radix === 16 ? /[^0-9A-Fa-f]/g : radix === 10 ? /[^0-9]/g : radix === 8 ? /[^0-7]/g : /[^01]/g, "");
    if (!t) {
      calcEntry = "0";
      calcFresh = true;
      calcExprClear();
      calcSetValue(0, false);
      return;
    }
    calcEntry = t;
    calcFresh = false;
    const n = parseInt(t, radix);
    calcExprClear();
    calcSetValue(Number.isFinite(n) ? n : 0, false);
  };
  out.addEventListener("input", apply);
  out.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); out.blur(); }
  });
  out.addEventListener("blur", () => { calcFresh = true; calcRenderBig(); });
}

function calcRun(expr, record) {
  const src = expr !== undefined ? expr : $id("calc-expr").value;
  let v;
  try {
    v = calcEval(src);
  } catch (e) {
    return calcError(String(e.message || e));
  }
  if (record !== false) calcLogPush(src, v);
  calcEntry = String(v);
  calcFresh = true;
  calcSetValue(v, false);
  // 表达式就是纯数字字面量时，位宽按它的数位来（0x001C → 16 位、0036 → 16 位）。
  // 必须放在 calcSetValue 之后：那里会按"值需要多少位"重算一遍，放前面会被它覆盖掉。
  if (Number.isFinite(v)) {
    const srcTxt = String(src == null ? "" : src).trim();
    const isLit = /^-?(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$/.test(srcTxt);
    if (isLit) {
      const b = calcAutoBits(srcTxt, v);
      if (b !== calcBits) { calcBits = b; calcRenderBig(); calcRenderBits(); }
    }
  }
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
  // 右栏「各进制一览」：四种进制各一行，数值自带分隔符（10 进制 3 位一逗号、16/2 进制 4 位一空格）
  if (Number.isFinite(v)) {
    const iv = Math.trunc(v);
    push("HEX", calcFmt(iv, "hex"));
    push("DEC", calcFmt(iv, "dec"));
    push("OCT", calcFmt(iv, "oct"));
    push("BIN", calcFmt(iv, "bin"), "wrap");
    if (iv >= 0 && iv <= 0xffffffff) push(T("字节"), T(iv <= 0xff ? "1 字节" : iv <= 0xffff ? "2 字节" : "4 字节"));
    push(T("无符号 32 位"), `${u32hex(iv)}（${calcGroup(String(u32(iv)), 3, ",")}）`);
    push("float32", String(Math.fround(iv)));
  } else {
    push(T("值"), String(v), "bad");
  }
  const r2 = $id("calc-radix2");
  if (r2) { r2.innerHTML = ""; rows.forEach((r) => r2.appendChild(r)); }
}

/** 32 位控制板：**按半字节分组**（一个半字节 = 一个十六进制位），8 个半字节分两行、MSB 在左，
 *  读法就是 0xDEAD / 0xBEEF 那样两行四个十六进制位；每一组上面标这一组的十六进制值 + 序号，
 *  底下标位号。点一下就能翻那一位（组内 4 个位 MSB 在左）。 */
/** 位板按可用高度自动折叠：4 行（32 位）放不下时只留 2 行（低 16 位），高 16 位用小字标在上面。
 *  阈值 176px ≈ 4 行 × (位按钮最小 30 + 标号 + 半字节标 + 缝)。 */
function calcFitBits() {
  // 键卡高度由这里"算死"（见下面的 calcFitPad）—— 不靠浏览器的固有尺寸推导，
  // 因为那一套在窗口/缩放变化时会把整页顶出可视区（"有个控件在外面"就是这么来的）。
  const pane = document.querySelector('.workpane[data-work="calc"]');
  const ops = pane && pane.querySelector(".calcops");
  const pad = pane && pane.querySelector(".calcpadcard");
  if (pane && ops && pad) {
    const cs = getComputedStyle(pane);
    const inner = pane.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const outside = [...pane.children].filter((c) => c !== ops).reduce((a, c) => a + c.getBoundingClientRect().height, 0);
    const rows = [".calcexprctl", ".calcctl"].map((sel) => { const e = ops.querySelector(sel); return e ? e.getBoundingClientRect().height : 0; }).reduce((a, b) => a + b, 0);
    const gaps = parseFloat(getComputedStyle(ops).rowGap || "0") * 2;
    const h = Math.max(178, Math.floor(inner - outside - rows - gaps) - 20);
    if (Math.abs(pad.getBoundingClientRect().height - h) > 1) pad.style.height = h + "px";
  }
  const box = $id("calc-bits");
  const card = document.querySelector(".calcprog");
  if (!box || !card) return;
  const others = [...card.children].filter((c) => c !== box).reduce((a, c) => a + c.getBoundingClientRect().height, 0);
  const avail = card.getBoundingClientRect().height - others - 20;
  const fold = avail < 176;
  if (box.classList.contains("fold16") !== fold) box.classList.toggle("fold16", fold);
  const tag = $id("calc-fold-tag");
  if (tag) {
    if (fold) {
      const hi = u32(calcValue) >>> 16;
      tag.textContent = T("已折叠高 16 位") + " 0x" + hi.toString(16).toUpperCase().padStart(4, "0");
    } else {
      tag.textContent = T("32 位全显示");
    }
  }
}

function calcRenderBits() {
  const box = $id("calc-bits");
  if (!box) return;
  const v = u32(calcValue);
  if (!box.children.length) {
    const grid = el("div", "bitgrid");
    // 4 行 × 2 个半字节：一行就是一个字节（DE AD / BE EF 这么读），比横着铺 4 个更好认
    for (let row = 3; row >= 0; row--) {             // row 3 = 最高字节（bit 31..24）
      const brow = el("div", "bitrow2");
      for (let nb = 1; nb >= 0; nb--) {              // 每行 2 个半字节
        const g = row * 2 + nb;
        const cell = el("div", "bitcell");
        const nib = el("div", "bitnib");
        nib.dataset.nib = String(g);
        nib.title = `bit ${g * 4 + 3}..${g * 4}`;
        nib.append(el("span", "d", "0"));   // 只显示这个半字节的值，位号下面已经有了，不用再标一遍
        const grp = el("div", "bitgrp");
        const idxGrp = el("div", "bitidxgrp");
        for (let k = 3; k >= 0; k--) {
          const bit = g * 4 + k;
          const b = el("button", "bit", "0");
          b.type = "button";
          b.dataset.bit = String(bit);
          b.onclick = () => {
            const nv = (u32(calcValue) ^ (1 << bit)) >>> 0;
            calcEntry = String(nv >>> 0);
            calcFresh = true;
            calcExprClear();             // 手改了一位 = 原算式不成立了
            const prev = u32(calcValue);
            calcSetValue(nv, false);
            calcBitChanged(prev, u32(nv));
          };
          grp.appendChild(b);
          idxGrp.appendChild(el("span", "bi", String(bit)));
        }
        cell.append(nib, grp, idxGrp);
        brow.appendChild(cell);
      }
      grid.appendChild(brow);
    }
    box.appendChild(grid);
  }
  box.querySelectorAll(".bit").forEach((b) => {
    const bit = Number(b.dataset.bit);
    const on = (v >>> bit) & 1;
    b.textContent = on ? "1" : "0";
    b.classList.toggle("on", !!on);
    b.title = `bit ${bit}（${on ? "1" : "0"}）`;
  });
  // 半字节那行小标：把这一组的 4 位读成一个十六进制位（0xABCD 里那个 A）
  calcFitBits();
  box.querySelectorAll(".bitnib").forEach((x) => {
    const nb = Number(x.dataset.nib);
    const d = (v >>> (nb * 4)) & 0xf;
    x.querySelector(".d").textContent = d.toString(16).toUpperCase();
    x.classList.toggle("on", d !== 0);
    x.classList.toggle("out", nb * 4 >= calcBits);     // 这一组在位宽之外 → 压暗
  });
}

function calcBitsOp(kind) {
  const v = u32(calcValue);
  const bits = Math.max(1, Math.min(32, calcBits || 32));
  const mask = bits >= 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
  let nv = v;
  if (kind === "zero") nv = 0;
  else if (kind === "not") nv = (~v) & mask;                  // 取反：**只翻当前位宽**
  else if (kind === "not32") nv = (~v) >>> 0;                 // 全反：32 位都翻（面板上写的就是异或 0xFFFFFFFF）
  else if (kind === "shl") nv = ((v << 1) & mask) >>> 0;
  else if (kind === "shr") nv = (v >>> 1) & mask;
  else if (kind === "rol") nv = (((v << 1) | (v >>> (bits - 1))) & mask) >>> 0;
  else if (kind === "ror") nv = (((v >>> 1) | (v << (bits - 1))) & mask) >>> 0;
  else if (kind === "bitrev") {                                    // 位反转：本位宽内左右颠倒
    let x = 0;
    for (let i = 0; i < bits; i++) if ((v >>> i) & 1) x |= 1 << (bits - 1 - i);
    nv = x >>> 0;
  }
  else if (kind === "bswap") {                                     // 字节交换：本位宽内按字节反序
    let x = 0;
    const nbytes = Math.max(1, bits / 8);
    for (let i = 0; i < nbytes; i++) x |= ((v >>> (i * 8)) & 0xff) << ((nbytes - 1 - i) * 8);
    nv = x >>> 0;
  }
  else if (kind === "feed") { calcExprSet(u32hex(v)); calcRun(u32hex(v)); return; }
  if (kind !== "not32") nv = u32(nv) & (mask || 0xffffffff);   // 全反例外：它本来就是翻满 32 位
  calcEntry = String(nv);
  calcFresh = true;
  calcExprClear();                 // 手改过位 = 原算式不成立了，清掉
  const prev = u32(calcValue);
  calcSetValue(nv, false);
  calcBitChanged(prev, u32(nv));
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
  push(T("十进制"), String(v));
  push(T("科学计数"), Number.isFinite(v) ? v.toExponential(7) : String(v));
  if (width === 32) {
    // 注意：阶码/尾数是**按位**切的，不是按字节 —— 符号 1 位、阶码 8 位、尾数 23 位
    const raw = parseInt(bitsHex, 16) >>> 0;
    const sign = (raw >>> 31) & 1;
    const exp = (raw >>> 23) & 0xff;
    const mant = raw & 0x7fffff;
    push(T("符号"), T(sign ? "-1（负数）" : "+1（正数）"));
    push(T("阶码"), `${exp} - 127 = ${exp - 127} (0x${exp.toString(16).toUpperCase().padStart(2, "0")})`);
    push(T("尾数"), "0x" + mant.toString(16).toUpperCase().padStart(6, "0"));
    // 32 位二进制按字节隔开，肉眼好对
    push(T("二进制"), bitsHex.match(/../g).map((h) => parseInt(h, 16).toString(2).padStart(8, "0")).join(" "));
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
  box.appendChild(el("div", "sub", T("计算中…")));
  try {
    const r = await invoke("file_digest", {
      path: calcFile,
      offset: Number($id("calc-file-off").value) || 0,
      length: Number($id("calc-file-len").value) || 0,
    });
    if (!box) return;
    box.innerHTML = "";
    box.append(
      digestRow(T("文件大小"), `${Number(r.size).toLocaleString()} ${T("字节")}`),
      digestRow(T("算的范围"), `${r.offset} + ${r.length}`),
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
  if (!calcHist.length) return;   // 只记录，不留说明文字
  calcHist.forEach((h) => {
    const r = el("div", "r" + (h.marked ? " marked" : ""));
    const star = el("button", "star", h.marked ? "★" : "☆");
    star.type = "button";
    star.title = T(h.marked ? "取消标记（下次开机就不留了）" : "标记：高亮，并且保留到下次开机");
    star.onclick = (ev) => { ev.stopPropagation(); h.marked = !h.marked; calcHistSave(); calcRenderHist(); };
    r.append(star, el("span", "e", h.e || ""), el("span", "v", h.v));
    r.title = T("点一下填回算式");
    r.onclick = () => { $id("calc-expr").value = h.e; calcRun(h.e, false); };
    box.appendChild(r);
  });
  const c = $id("calc-hist-count");
  if (c) c.textContent = calcHist.length ? calcHist.length + " 条 · ★ " + calcHist.filter((x) => x.marked).length : "";
}

/** 位板/位运算变化：等 700ms 不再动了再记一条（只记 from → to，纯数据） */
let calcBitPend = null;      // {from, to, timer}
function calcBitChanged(from, to) {
  if (calcBitPend === null) calcBitPend = { from, timer: null };
  calcBitPend.to = to;
  if (calcBitPend.timer) clearTimeout(calcBitPend.timer);
  calcBitPend.timer = setTimeout(() => {
    const p = calcBitPend;
    calcBitPend = null;
    if (!p || p.from === p.to) return;
    const val = calcFmt(p.from) + " → " + calcFmt(p.to);
    calcHist.unshift({ e: val, v: "", base: calcBase, marked: false });
    calcHistTrim();
    calcRenderHist();
  }, 700);
}

/** 记一条历史（只有标记过才会落盘） */
function calcHistPush(e, v) {
  const val = calcNum(v);
  const dup = calcHist.find((h) => h.e === e && h.v === val && !h.marked);
  if (!dup) calcHist.unshift({ e: String(e), v: val, base: calcBase, marked: false });
  calcHistTrim();
  calcRenderHist();
}

/** 标记/取消标记"当前这条"（显示区的算式 + 结果） */
function calcMarkCurrent() {
  const e = ($id("calc-expr").value || "").trim();      // 没算式就只记值
  const val = calcNum(calcValue);
  if (!Number.isFinite(calcValue)) return T("现在这个值没法标记");
  const hit = calcHist.find((h) => h.e === e && h.v === val && (h.e || h.v));
  if (hit) {
    hit.marked = !hit.marked;
    hit.base = calcBase;
    calcHistSave(); calcRenderHist();
    return hit.marked ? T("已标记（会保留到下次开机）") : T("已取消标记");
  }
  calcHist.unshift({ e, v: val, base: calcBase, marked: true });
  toastMini(e ? T("已标记（会保留到下次开机）") : T("已标记（会保留到下次开机）"));
  calcHistTrim(); calcHistSave(); calcRenderHist();
  return T("已标记（会保留到下次开机）");
}

function calcRenderBaud() {
  const box = $id("calc-baud");
  if (!box) return;
  box.innerHTML = "";
  for (const b of [9600, 57600, 115200, 230400, 460800, 921600]) {
    const us = 1e6 / b;
    const r = el("div", "row");
    r.append(el("span", "k", String(b)), el("span", "v", `${us.toFixed(2)} µs/${T("位")} · ${T("一字节约")} ${(us * 10).toFixed(0)} µs`));
    box.appendChild(r);
  }
}


/* ============================== 数据计算（二级菜单） ==============================
   文件校验 / IEEE 浮点在下面各自的函数里；这里放：进制·字节序、AES、RSA。
   AES / RSA 走系统 WebCrypto —— 全在本机算，密钥只在这个框里，不写盘、不外发。 */

/** 点一行就把那一行的值复制走（各进制一览 / 换算结果都用它） */
function dcBindRowCopy(boxId) {
  const box = $id(boxId);
  if (!box) return;
  box.addEventListener("click", async (ev) => {
    const row = ev.target.closest(".row");
    if (!row) return;
    const v = (row.querySelector(".v") || {}).textContent || "";
    try { await navigator.clipboard.writeText(v); toastMini(T("已复制：") + v); } catch (_) { toastMini(v); }
  });
}
function toastMini(text) {
  const h = $id("calc-pad-hint");
  if (h) h.textContent = text;
}

/** 任意进制写法的数值字面量 → BigInt（0x / 0b / 0o / 逗号 / 下划线 / 空格 都认） */
function dcParse(str, defRadix) {
  let t = String(str == null ? "" : str).trim().replace(/[,\s_]/g, "");
  if (!t) throw new Error(T("先填一个数"));
  let radix = defRadix;
  if (/^0[xX]/.test(t)) { radix = 16; t = t.slice(2); }
  else if (/^0[bB]/.test(t)) { radix = 2; t = t.slice(2); }
  else if (/^0[oO]/.test(t)) { radix = 8; t = t.slice(2); }
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1);
  if (!t) throw new Error(T("先填一个数"));
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  let v = 0n;
  for (const ch of t.toLowerCase()) {
    const d = digits.indexOf(ch);
    if (d < 0 || d >= radix) throw new Error(radix + " " + T("进制里没有这个字符：") + ch);
    v = v * BigInt(radix) + BigInt(d);
  }
  return neg ? -v : v;
}

function dcGo() {
  const out = $id("dc-out");
  if (!out) return;
  out.innerHTML = "";
  const bits = Number($id("dc-bits").value) || 32;
  let v;
  try { v = dcParse($id("dc-num").value, 10); } catch (e) { out.append(digestRow(T("出错"), String(e.message || e))); return; }
  const mask = (1n << BigInt(bits)) - 1n;
  const u = v & mask;
  const signed = (u >> BigInt(bits - 1)) & 1n ? u - (1n << BigInt(bits)) : u;
  const hex = u.toString(16).toUpperCase().padStart(bits / 4, "0");
  const bin = u.toString(2).padStart(bits, "0");
  const oct = u.toString(8).padStart(Math.ceil(bits / 3), "0");
  const nbytes = bits / 8;
  const be = [];
  for (let i = nbytes - 1; i >= 0; i--) be.push(((u >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, "0"));
  const push = (k, val) => out.append(digestRow(k, val, true));
  push(bits + " " + T("位"), "0x" + calcGroup(hex, 4, " "));
  push("DEC（" + T("有符号") + "）", calcGroup(signed.toString(), 3, ","));
  push("DEC（" + T("无符号") + "）", calcGroup(u.toString(), 3, ","));
  push("OCT", calcGroup(oct, 3, " "));
  push("BIN", calcGroup(bin, 4, " "));
  const beUp = be.map((b) => b.toUpperCase());
  push(T("字节序") + "（大端）", "0x" + beUp.join(" "));
  push(T("字节序") + "（小端）", "0x" + beUp.slice().reverse().join(" "));
  // ASCII 可打印字符（不可打印用 .）
  const ascii = be.map((b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }).join("");
  push("ASCII", ascii);
}

/* ---------- AES（WebCrypto） ---------- */
const dcB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
function dcUnB64(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!t) throw new Error(T("先填内容"));
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function dcHexBytes(s) {
  const t = String(s || "").replace(/[^0-9a-fA-F]/g, "");
  if (!t || t.length % 2) throw new Error(T("hex 得是偶数个字符"));
  const u = new Uint8Array(t.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return u;
}
const dcBytesHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
/** 输入框里那坨：整段都是 hex 字符（可带空格/冒号）且长度为偶数 → 按 hex；否则按 base64 */
function dcBytes(s, what) {
  const t = String(s == null ? "" : s).trim();
  if (!t) throw new Error(T("先填") + what);
  const bare = t.replace(/[\s:]/g, "");
  if (/^[0-9a-fA-F]+$/.test(bare) && bare.length % 2 === 0) return dcHexBytes(bare);
  return dcUnB64(t);
}
const dcRandomBytes = (n) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return u; };

async function dcAes(dir) {
  const out = $id("aes-out"), hint = $id("aes-hint");
  if (!out) return;
  out.innerHTML = "";
  try {
    const mode = $id("aes-mode").value;                 // GCM / CBC
    const bits = Number($id("aes-bits").value) || 256;
    const keyBytes = dcBytes($id("aes-key").value, T("密钥"));
    if (keyBytes.length * 8 !== bits) throw new Error(T("密钥长度不对") + "：" + keyBytes.length * 8 + " bit ≠ " + bits);
    const iv = dcBytes($id("aes-iv").value, "IV");
    const okIv = mode === "GCM" ? [8, 12, 16] : [16];
    if (!okIv.includes(iv.length)) throw new Error("IV " + T("长度不对") + "：" + iv.length + " " + T("字节"));
    const alg = mode === "GCM" ? { name: "AES-GCM" } : { name: "AES-CBC" };
    const key = await crypto.subtle.importKey("raw", keyBytes, alg, false, [dir === "enc" ? "encrypt" : "decrypt"]);
    const params = mode === "GCM" ? { name: "AES-GCM", iv } : { name: "AES-CBC", iv };
    if (dir === "enc") {
      const data = new TextEncoder().encode($id("aes-in").value);
      const buf = await crypto.subtle.encrypt(params, key, data);
      out.append(digestRow("base64", dcB64(buf), true), digestRow("hex", dcBytesHex(new Uint8Array(buf)), true));
      if (hint) hint.textContent = T("加密完成") + "：" + data.length + " → " + buf.byteLength + " " + T("字节");
    } else {
      const buf = await crypto.subtle.decrypt(params, key, dcUnB64($id("aes-in").value));
      out.append(digestRow(T("明文"), new TextDecoder().decode(buf), true), digestRow("hex", dcBytesHex(new Uint8Array(buf)), true));
      if (hint) hint.textContent = T("解密完成") + "：" + buf.byteLength + " " + T("字节");
    }
  } catch (e) {
    const msg = String((e && e.name) === "OperationError" ? T("解密失败：密钥 / IV / 密文对不上，或者数据被改过") : (e.message || e));
    out.append(digestRow(T("出错"), msg, true));
    if (hint) hint.textContent = "";
  }
}

/* ---------- RSA（WebCrypto：OAEP 加解密 + PKCS1 签名验签） ---------- */
function dcPemToBuf(pem) {
  const m = String(pem).match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  const body = (m ? m[1] : String(pem)).replace(/[^A-Za-z0-9+/=]/g, "");
  if (!body) throw new Error(T("PEM 里没找到 base64 正文"));
  const bin = atob(body);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
async function dcRsaKey(which, use) {   // which: pub/prv；use: enc/sign
  const pem = $id("rsa-key").value;
  if (!String(pem).trim()) throw new Error(T("先把 PEM 密钥粘进来（或选文件）"));
  const fmt = which === "pub" ? "spki" : "pkcs8";
  if (use === "sign") {
    return crypto.subtle.importKey(fmt, dcPemToBuf(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false,
      [which === "pub" ? "verify" : "sign"]);
  }
  return crypto.subtle.importKey(fmt, dcPemToBuf(pem), { name: "RSA-OAEP", hash: "SHA-256" }, false,
    [which === "pub" ? "encrypt" : "decrypt"]);
}

async function dcRsa(op) {
  const out = $id("rsa-out"), hint = $id("rsa-hint");
  if (!out) return;
  out.innerHTML = "";
  try {
    const text = $id("rsa-in").value;
    if (op === "enc") {
      const k = await dcRsaKey("pub", "enc");
      const buf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, k, new TextEncoder().encode(text));
      out.append(digestRow("base64", dcB64(buf), true), digestRow("hex", dcBytesHex(new Uint8Array(buf)), true));
      if (hint) hint.textContent = T("加密完成") + "：" + buf.byteLength + " " + T("字节");
    } else if (op === "dec") {
      const k = await dcRsaKey("prv", "enc");
      const buf = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, k, dcUnB64(text));
      out.append(digestRow(T("明文"), new TextDecoder().decode(buf), true));
      if (hint) hint.textContent = T("解密完成") + "：" + buf.byteLength + " " + T("字节");
    } else if (op === "sign") {
      const k = await dcRsaKey("prv", "sign");
      const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, k, new TextEncoder().encode(text));
      out.append(digestRow("base64", dcB64(sig), true), digestRow("hex", dcBytesHex(new Uint8Array(sig)), true));
      if (hint) hint.textContent = T("签名完成") + "：" + sig.byteLength + " " + T("字节");
    } else {
      const k = await dcRsaKey("pub", "sign");
      const msg = new TextEncoder().encode($id("rsa-msg").value);
      const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, k, dcUnB64(text), msg);
      out.append(digestRow(T("验签结果"), ok ? T("✅ 通过（签名对得上）") : T("❌ 不通过（改了内容或不是这把公钥）"), true));
      if (hint) hint.textContent = "";
    }
  } catch (e) {
    out.append(digestRow(T("出错"), String(e.message || e), true));
    if (hint) hint.textContent = "";
  }
}

/** 数据计算页的绑定（跟计算器一起在 initCalc 里挂一次） */
function initDataCalc() {
  dcBindRowCopy("dc-out");
  dcBindRowCopy("calc-file-out");
  dcBindRowCopy("ieee-out");
  dcBindRowCopy("aes-out");
  dcBindRowCopy("rsa-out");
  if ($id("dc-go")) $id("dc-go").onclick = dcGo;
  if ($id("dc-num")) $id("dc-num").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); dcGo(); } };
  if ($id("dc-bits")) $id("dc-bits").onchange = dcGo;
  // AES
  if ($id("aes-enc")) $id("aes-enc").onclick = () => dcAes("enc");
  if ($id("aes-dec")) $id("aes-dec").onclick = () => dcAes("dec");
  if ($id("aes-key-gen")) $id("aes-key-gen").onclick = () => {
    const bits = Number($id("aes-bits").value) || 256;
    $id("aes-key").value = dcBytesHex(dcRandomBytes(bits / 8));
    toastMini(T("随机密钥已生成（hex）"));
  };
  if ($id("aes-iv-gen")) $id("aes-iv-gen").onclick = () => {
    const n = $id("aes-mode").value === "GCM" ? 12 : 16;
    $id("aes-iv").value = dcBytesHex(dcRandomBytes(n));
    toastMini(T("随机 IV 已生成（hex）"));
  };
  if ($id("aes-mode")) $id("aes-mode").onchange = () => { if ($id("aes-iv")) $id("aes-iv").value = ""; };
  // RSA
  for (const [id, op] of [["rsa-enc", "enc"], ["rsa-dec", "dec"], ["rsa-sign", "sign"], ["rsa-verify", "verify"]]) {
    if ($id(id)) $id(id).onclick = () => dcRsa(op);
  }
  if ($id("rsa-key-pick")) {
    $id("rsa-key-pick").onclick = async () => {
      try {
        const p = await dlgOpen({ title: T("选 PEM 密钥文件"), multiple: false, directory: false });
        const path = typeof p === "string" ? p : (p && p.path);
        if (!path) return;
        $id("rsa-key").value = await readTextFile(path);
        if ($id("rsa-key-file")) $id("rsa-key-file").value = path;
      } catch (e) {
        if ($id("rsa-hint")) $id("rsa-hint").textContent = String(e.message || e).slice(0, 80);
      }
    };
  }
}

export function initCalc() {
  const box = $id("calc-expr");
  if (!box || box.__bound) return;
  box.__bound = true;

  calcRenderPad();
  initDataCalc();
  box.oninput = () => calcRun(box.value, false);
  box.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); calcRun(box.value); } };
  $id("calc-go").onclick = () => calcRun(box.value);
  // 显示进制那三个按钮：换进制 = 换显示 + 换键盘输入进制（跟 Windows 计算器一个逻辑）
  document.querySelectorAll(".calcbasebtn").forEach((b) => { b.onclick = () => calcSetBase(b.dataset.base); });
  // → 浮点数：把当前结果按 IEEE-754 单精度解释一次（再点回到整数显示）
  const floatBtn = $id("calc-to-float");            // 老位置（已搬进键盘），有就还绑上
  if (floatBtn) {
    floatBtn.onclick = () => {
      calcFloatShow = !calcFloatShow;
      floatBtn.classList.toggle("on", calcFloatShow);
      calcRenderBig();
      $id("calc-pad-hint").textContent = T(calcFloatShow ? "显示：IEEE-754 单精度解释" : "显示：整数");
    };
  }
  // ☆ 标记这个数据：右侧历史高亮 + 写进本机（没标记的不写盘）
  const markBtn = $id("calc-mark");                 // 老位置（已搬进键盘），有就还绑
  if (markBtn) markBtn.onclick = () => { $id("calc-pad-hint").textContent = calcMarkCurrent(); };
  // 上下比例（默认 1/3，拖动改、双击复位）
  (function bindCalcSplit() {
    const view = $id("calc-view"), grip = $id("calc-split");
    if (!view || !grip) return;
    const saved = Number(localStorage.getItem(CALC_SPLIT_KEY) || 0);
    if (saved >= 18 && saved <= 70) view.style.flexBasis = saved + "%";
    let drag = false;
    grip.addEventListener("pointerdown", (e) => { drag = true; try { grip.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
    grip.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = view.parentElement.getBoundingClientRect();
      const pct = Math.max(18, Math.min(70, ((e.clientY - r.top) / r.height) * 100));
      view.style.flexBasis = Math.round(pct * 10) / 10 + "%";
    });
    const done = () => {
      if (!drag) return;
      drag = false;
      const pct = parseFloat(view.style.flexBasis) || 0;
      if (pct) localStorage.setItem(CALC_SPLIT_KEY, String(Math.round(pct * 10) / 10));
    };
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
    grip.addEventListener("dblclick", () => { view.style.flexBasis = ""; localStorage.removeItem(CALC_SPLIT_KEY); });
  })();
  // 各进制一览：点一行复制那一行的值
  if ($id("calc-radix2")) {
    $id("calc-radix2").addEventListener("click", async (ev) => {
      const row = ev.target.closest(".row");
      if (!row) return;
      const v = (row.querySelector(".v") || {}).textContent || "";
      try { await navigator.clipboard.writeText(v); $id("calc-pad-hint").textContent = T("已复制：") + v; } catch (_) { $id("calc-pad-hint").textContent = v; }
    });
  }
  document.querySelectorAll(".calc-quick").forEach((b) => {
    b.onclick = () => { box.value += b.dataset.q || ""; box.focus(); calcRun(box.value, false); };
  });
  // 显示区那四行：点一下就把那一行的值复制走（HEX/DEC/OCT/BIN 想抄哪个抄哪个）
  document.querySelectorAll(".radixrow").forEach((r) => {
    r.title = T("点一下复制这一行的值");
    r.onclick = async () => {
      const v = (r.querySelector(".v") || {}).textContent || "";
      try {
        await navigator.clipboard.writeText(v);
        const h = $id("calc-pad-hint");
        if (h) h.textContent = T("已复制：") + v;
      } catch (_) {
        const h = $id("calc-pad-hint");
        if (h) h.textContent = v;
      }
    };
  });
  // 位板的操作都在键盘里（data-act="bits:xxx"）
  calcBindOutInput();
  if (window.ResizeObserver) new ResizeObserver(() => calcFitBits()).observe(document.querySelector(".calcprog") || document.body);
  window.addEventListener("resize", calcFitBits);
  $id("calc-hist-clear").onclick = () => {                 // 只清没标记的
    calcHist = calcHist.filter((h) => h.marked);
    calcRenderHist();
  };
  $id("calc-hist-clear-all").onclick = () => {             // 连标记一起清（连本机那份一起删）
    calcHist = [];
    calcHistSave();
    calcRenderHist();
  };
  // 「→ 发送框」已删（直接复制结果就行）
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
  calcSetBase("dec", true);
  calcRun(box.value, false);
  calcExprLineSet(box.value);
  calcRenderHist();
  calcRenderBaud();
  calcRenderBits();
  onLang(() => {
    calcRenderHist();
    calcRenderBaud();
    calcRenderBits();
    calcRenderRadix(calcValue);
    ieeeManual = false;                     // 切语言后让"实时"那份重画一次（纯显示，无副作用）
    ieeeRenderLive(calcValue);
    $id("calc-pad-hint").textContent = T("直接按数字和运算符，= 出结果；结果和上面的控制板实时同步。");
  });
}
