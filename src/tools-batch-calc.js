// ── 工具页：批量文本 / 计算器 ─────────────────────────────────────────
// 两个纯本地页（不进 agent、不需要设备）。main.js 只在切页时调 init。
import { save as dlgSave, open as dlgOpen } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { VB_FORMATS, VB_DEPTHS, VB_TIMINGS, VB_PRESETS, VB_IFACES, vbCompute, vbVerdict, vbState } from "./video-bandwidth.js";

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
  btLineNumbersSoon();
  const lines = btLines();
  btWords = lines;
  btRawLines = $id("bt-in").value.split(/\r?\n/);
  $id("bt-out").value = btFormat(lines, $id("bt-format").value);
  $id("bt-count").textContent = lines.length + T(" 行") + " · " + lines.reduce((a, l) => a + l.length, 0) + T(" 字");
  btUpdateCount();
  btStatusRender();
}

/* ============ 批量文本：行号栏 + 底部状态栏（跟 IDE 一样） ============ */
const BT_ED = ["bt-in", "bt-out"];        // 每个编辑器：textarea id（行号栏 id = textarea id + "-ln"）
let btEol = "";                          // 导入文件时记住它的行尾（textarea 的 value 会被规范化成 LF，看 value 看不出来）
let btLnTimer = null;
let btMeasure = null;

/** 行号栏：软换行的那一行要占多个视觉行的高度，不然行号会越跑越偏。
    高度用 canvas 按同一个字体量宽度算出来（中文这种双宽字符量得准）。 */
function btLineNumbers() {
  const cv = btMeasure || (btMeasure = document.createElement("canvas"));
  const ctx = cv.getContext("2d");
  for (const taId of BT_ED) {
    const ta = $id(taId), ln = $id(taId + "-ln");
    if (!ta || !ln) continue;
    const cs = getComputedStyle(ta);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const inner = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.55;
    const lines = ta.value.split("\n");
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      const w = inner > 8 ? ctx.measureText(lines[i].replace(/\t/g, "    ")).width : 0;
      const rows = Math.max(1, Math.ceil(w / inner));
      html += `<div style="height:${(rows * lh).toFixed(3)}px">${i + 1}</div>`;
    }
    ln.innerHTML = html;
    ln.scrollTop = ta.scrollTop;
  }
}
/** 敲字时别每一下都重量（几万行时量起来会卡），攒 90ms 再算 */
function btLineNumbersSoon() { clearTimeout(btLnTimer); btLnTimer = setTimeout(btLineNumbers, 90); }

/** 底部状态栏：行/列 · 选中 · 字符 · 字节 · 行数 · 编码 · 行尾（跟 IDE 底部那条一个意思） */
function btStatusRender() {
  for (const taId of BT_ED) {
    const ta = $id(taId), st = $id(taId + "-status");
    if (!ta || !st) continue;
    const v = ta.value;
    const pos = ta.selectionStart || 0, end = ta.selectionEnd || 0;
    const row = v.slice(0, pos).split("\n").length;
    const col = pos - v.lastIndexOf("\n", Math.max(0, pos - 1));
    const sel = Math.abs(end - pos);
    const lineCount = v.length ? v.split("\n").length : 1;
    const bytes = new TextEncoder().encode(v).length;
    const eol = taId === "bt-in" ? (btEol || "LF") : "";   // 行尾只有左边那个（输入）才有意义
    const bits = [
      T("行 {r}, 列 {c}").replace("{r}", row).replace("{c}", col),
      sel ? T("选中 {n}").replace("{n}", sel) : "",
      T("{n} 字符").replace("{n}", v.length),
      T("{n} 字节").replace("{n}", bytes),
      T("{n} 行").replace("{n}", lineCount),
      "UTF-8", eol,
    ].filter(Boolean);
    st.textContent = bits.join("  ·  ");
  }
}

/** 导入一个文件到左边输入框（按钮和拖文件都走这里）；path 给了就不弹选择框 */
async function btImportFile(path0) {
  try {
    let path = path0;
    if (!path) {
      const p = await dlgOpen({
        title: T("导入文本文件"), multiple: false, directory: false,
        filters: [{ name: T("文本 / 日志 / CSV"), extensions: ["txt", "log", "csv", "json", "md", "hex"] },
                  { name: T("所有文件"), extensions: ["*"] }],
      });
      path = typeof p === "string" ? p : (p && p.path);
    }
    if (!path) return;
    const r = await invoke("file_read_text", { path });
    const ta = $id("bt-in");
    ta.value = r.text;
    try { ta.setSelectionRange(0, 0); } catch (_) { /* 忽略 */ }
    ta.scrollTop = 0;
    btEol = r.eol || "";
    btRender();
    const name = String(path).split(/[\\/]/).pop();
    btMsg(T("已导入 {name}（{n} 字节{enc}）").replace("{name}", name).replace("{n}", r.bytes)
      .replace("{enc}", r.utf8 ? "" : T("，不是 UTF-8，已按替换字符显示")));
  } catch (e) {
    btMsg(T("导入失败：") + String(e && e.message ? e.message : e).slice(0, 90), true);
  }
}

/* ================== 批量文本：对输入框"选区优先"地改 ================== */

/** 作用范围（查找/替换 与 大小写/缩进 共用一处）：sel = 选中部分，line = 每一行，all = 整篇 */
const btScope = () => dcChipVal("bt-scope") || "all";

function btSelRange() {
  const ta = $id("bt-in");
  const s = ta.selectionStart || 0;
  const e = ta.selectionEnd || 0;
  return { ta, s, e, has: e > s };
}

/** transform 只吃一段文本、还一段文本；范围选"选中部分"（且有选区）就只改那段 */
function btApply(fn, forceSelection) {
  const { ta, s, e, has } = btSelRange();
  const only = forceSelection || btScope() === "sel";
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

/** 全部替换：按"范围"走 —— 选中部分 / 每一行 / 整篇（每行与整篇对 ^ $ 这类锚点的含义不同） */
function btReplaceAll() {
  const p = btPattern();
  if (!p) return;
  const repText = $id("bt-replace").value;
  const ta = $id("bt-in");
  const { s, e, has } = btSelRange();
  const scope = btScope();
  let hits = 0;
  const run = (text) => {
    if (scope === "line") {
      return text.split("\n").map((l) => {
        p.re.lastIndex = 0;
        hits += (l.match(p.re) || []).length;
        p.re.lastIndex = 0;
        return l.replace(p.re, repText);
      }).join("\n");
    }
    p.re.lastIndex = 0;
    hits = (text.match(p.re) || []).length;
    p.re.lastIndex = 0;
    return text.replace(p.re, repText);
  };
  if (scope === "sel" && has) {
    const out = run(ta.value.slice(s, e));
    ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
    ta.setSelectionRange(s, s + out.length);
  } else {
    ta.value = run(ta.value);
  }
  btRender();
  btMsg(hits ? T("已替换 ") + hits + T(" 处") : T("没找到要替换的"));
}

/* ==================== 批量文本：JSON / 正则 / 缩进 ==================== */

function btJsonFormat(min) {
  let produced = "";
  let linesDone = 0;
  let failed = false;
  btApply((text) => {
    const trimmed = text.trim();
    if (!trimmed) return text;
    const indent0 = Number(dcChipVal("bt-json-indent")) || 2;
    try {
      const v = JSON.parse(trimmed);
      produced = min ? JSON.stringify(v) : JSON.stringify(v, null, indent0);
      return produced;
    } catch (e) {
      // 整段不是一份 JSON：可能是"每行一份 JSON"（日志/多文档），一行一行试
      const rows = trimmed.split(/\r?\n/).filter((l) => l.trim());
      if (rows.length > 1) {
        const ok = [];
        let allOk = true;
        for (const row of rows) {
          try {
            const v = JSON.parse(row.trim());
            ok.push(min ? JSON.stringify(v) : JSON.stringify(v, null, indent0));
          } catch (_) { allOk = false; break; }
        }
        if (allOk && ok.length) {
          linesDone = ok.length;
          produced = ok.join("\n");
          return produced;
        }
      }
      // 真不是合法 JSON：退一步按花括号重排，好歹能看（并且明说"只是排版，没校验通过"）
      const m = /position (\d+)/.exec(String(e.message || ""));
      failed = true;
      if (m) btMsg(T("JSON 解析失败（第 ") + (Number(m[1]) + 1) + T(" 个字符）：") + e.message, true);
      else btMsg(T("JSON 解析失败：") + String(e.message || e).slice(0, 80), true);
      produced = min ? text.replace(/\s*\n\s*/g, "") : btFormatBrace(text);
      return produced;
    }
  });
  // 结果栏直接给排版结果：那一栏是按"行流水线"重算的（默认会去掉首尾空格），
  // 走一遍就会把 JSON 的缩进全吃掉 —— 这里绕开它。
  if (produced) {
    const out = $id("bt-out");
    if (out) out.value = produced;
    if (!failed) {
      if (linesDone) btMsg(T("按行整理了 ") + linesDone + T(" 份 JSON（结果栏直接给的排版结果）"));
      else btMsg(T("JSON 已排版（结果栏直接给的是排版后的内容，不过行处理那条流水线）"));
    }
  }
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
    if (c === "{") { out = out.replace(/[ \t]+$/, "") + " {"; indent++; nl(); i++; continue; }
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

const btCase = (mode) => (text) => {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text.replace(/(^|[\s\p{P}])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
};

function btIndentRun() {
  const kind = dcChipVal("bt-indent") || "brace";
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

/** 右栏那三组小选择器（作用范围 / JSON 缩进 / 缩进方式）：文字跟语言走，抽出来，切语言时重建一遍 */
function btInitChips() {
  dcChips("bt-scope", [["sel", T("选中部分")], ["line", T("每一行")], ["all", T("整篇")]], { onChange: btUpdateCount });
  dcChips("bt-json-indent", [["2", T("2 空格")], ["4", T("4 空格")], ["1", T("1 空格")]]);
  dcChips("bt-indent", [["brace", T("花括号自动")], ["tabs2", T("Tab → 2 空格")], ["tabs4", T("Tab → 4 空格")], ["strip", T("去掉行首缩进")]]);
}

/* ========================= 批量文本：文本比对（CLion 那种） ========================= */

/** Myers 的 O(ND) diff：返回 {t,a,b} 的编辑脚本（t = = / - / +）。
    两头先剥掉公共前后缀（真实场景差别通常只占一小段），中间太长时走「按行配对」兜底。 */
function btDiffOps(a, b, eq) {
  let head = 0;
  while (head < a.length && head < b.length && eq(a[head], b[head])) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && eq(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ t: "=", a: i, b: i });
  const na = a.slice(head, a.length - tail), nb = b.slice(head, b.length - tail);
  const mid = (na.length + nb.length) > 3000 ? btDiffByIndex(na, nb, eq) : btDiffMyers(na, nb, eq);
  for (const o of mid) ops.push({ t: o.t, a: o.a == null ? null : o.a + head, b: o.b == null ? null : o.b + head });
  for (let i = 0; i < tail; i++) ops.push({ t: "=", a: a.length - tail + i, b: b.length - tail + i });
  return ops;
}

/** 中间那段太大时的兜底：按行号硬配对（同 index 的两行算「改了」），结果仍然并排对齐 */
function btDiffByIndex(a, b, eq) {
  const ops = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const hasA = i < a.length, hasB = i < b.length;
    if (hasA && hasB) {
      if (eq(a[i], b[i])) ops.push({ t: "=", a: i, b: i });
      else { ops.push({ t: "-", a: i }); ops.push({ t: "+", b: i }); }
    } else if (hasA) ops.push({ t: "-", a: i });
    else ops.push({ t: "+", b: i });
  }
  return ops;
}

function btDiffMyers(a, b, eq) {
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N) return b.map((_, i) => ({ t: "+", b: i }));
  if (!M) return a.map((_, i) => ({ t: "-", a: i }));
  const max = N + M, off = max;
  const v = new Array(2 * max + 2).fill(0);
  const trace = [];
  let D = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && eq(a[x], b[y])) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { D = d; break outer; }
    }
  }
  const out = [];
  let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vPrev[off + k - 1] < vPrev[off + k + 1])) ? k + 1 : k - 1;
    const prevX = vPrev[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ t: "=", a: x - 1, b: y - 1 }); x--; y--; }
    if (x === prevX) { out.push({ t: "+", b: y - 1 }); y--; }
    else { out.push({ t: "-", a: x - 1 }); x--; }
  }
  while (x > 0 && y > 0) { out.push({ t: "=", a: x - 1, b: y - 1 }); x--; y--; }
  return out.reverse();
}

/** 右边那份文本（比对用）：结果栏，或者另外挑一个文件 */
async function btDiffPickRight() {
  try {
    const p = await dlgOpen({
      title: T("挑一个文件跟输入比"), multiple: false, directory: false,
      filters: [{ name: T("文本 / 日志 / CSV"), extensions: ["txt", "log", "csv", "json", "md", "hex"] },
                { name: T("所有文件"), extensions: ["*"] }],
    });
    const path = typeof p === "string" ? p : (p && p.path);
    if (!path) { dcChipSel["bt-diff-right"] = new Set(["out"]); $id("bt-diff-right").dataset.val = "out"; dcChipPaint("bt-diff-right"); return; }
    const r = await invoke("file_read_text", { path });
    btDiffRight = { mode: "file", text: r.text, name: String(path).split(/[\\/]/).pop() };
    btDiffRender();
  } catch (e) {
    btMsg(T("导入失败：") + String(e && e.message ? e.message : e).slice(0, 90), true);
  }
}

/** 把编辑脚本折成并排的行：- 和 + 成对时算「改了」（一行两边都显示，方便看差异） */
function btDiffRows(ops) {
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === "=") { rows.push({ t: "=", a: ops[i].a, b: ops[i].b }); i++; continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].t !== "=") {
      if (ops[i].t === "-") dels.push(ops[i].a); else adds.push(ops[i].b);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const da = dels[k] == null ? null : dels[k];
      const db = adds[k] == null ? null : adds[k];
      rows.push({ t: da != null && db != null ? "~" : (da != null ? "-" : "+"), a: da, b: db });
    }
  }
  return rows;
}

/** 一行以内的高亮：掐掉公共前后缀，把中间那段标出来 */
function btDiffInline(x, y) {
  const maxP = Math.min(x.length, y.length);
  let p = 0;
  while (p < maxP && x[p] === y[p]) p++;
  let t = 0;
  while (t < maxP - p && x[x.length - 1 - t] === y[y.length - 1 - t]) t++;
  return {
    aPre: x.slice(0, p), aMid: x.slice(p, x.length - t), aSuf: t ? x.slice(x.length - t) : "",
    bPre: y.slice(0, p), bMid: y.slice(p, y.length - t), bSuf: t ? y.slice(y.length - t) : "",
  };
}

let btDiffState = { rows: [], blocks: [], cur: -1 };
let btDiffRight = { mode: "out", text: "", name: "" };   // 右边比什么：结果栏，还是另外挑一个文件（CLion 那种两份文件对比）

function btDiffRender() {
  const box = $id("bt-diff-body");
  if (!box) return;
  const icase = $id("bt-diff-icase").checked;
  const iws = $id("bt-diff-iws").checked;
  const norm = (t) => (iws ? t.trim() : t);
  const eq = (x, y) => (icase ? norm(x).toLowerCase() === norm(y).toLowerCase() : norm(x) === norm(y));
  const A = $id("bt-in").value.split("\n");
  const rightText = btDiffRight.mode === "file" ? btDiffRight.text : $id("bt-out").value;
  const B = rightText.split("\n");
  const rows = btDiffRows(btDiffOps(A, B, eq));
  const blocks = [];
  rows.forEach((r, i) => {
    if (r.t === "=") return;
    if (!blocks.length || blocks[blocks.length - 1].end !== i - 1) blocks.push({ start: i, end: i });
    else blocks[blocks.length - 1].end = i;
  });
  let add = 0, del = 0, mod = 0;
  for (const r of rows) { if (r.t === "+") add++; else if (r.t === "-") del++; else if (r.t === "~") mod++; }
  const stat = $id("bt-diff-stat");
  if (stat) stat.textContent = blocks.length
    ? T("{n} 处不同").replace("{n}", blocks.length) + "　" + T("改 {m} · 加 {a} · 删 {d}").replace("{m}", mod).replace("{a}", add).replace("{d}", del)
      + (btDiffRight.mode === "file" ? "　·　" + T("右边：") + btDiffRight.name : "")
    : T("两边完全一样");
  const frag = document.createDocumentFragment();
  const mk = (cls, txt) => { const d = document.createElement("span"); d.className = cls; d.textContent = txt; return d; };
  const mkHl = (cls, pre, mid, suf) => {
    const d = document.createElement("span");
    d.className = cls;
    if (pre) d.appendChild(document.createTextNode(pre));
    if (mid) { const b = document.createElement("b"); b.className = "hl"; b.textContent = mid; d.appendChild(b); }
    if (suf) d.appendChild(document.createTextNode(suf));
    return d;
  };
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "btdiffrow " + (r.t === "~" ? "mod" : r.t === "-" ? "del" : r.t === "+" ? "add" : "");
    row.dataset.row = String(i);
    row.appendChild(mk("ln ln-l", r.a == null ? "" : String(r.a + 1)));
    row.appendChild(mk("tx tx-l", r.a == null ? "" : A[r.a]));
    row.appendChild(mk("ln ln-r", r.b == null ? "" : String(r.b + 1)));
    row.appendChild(mk("tx tx-r", r.b == null ? "" : B[r.b]));
    if (r.t === "~") {
      const hl = btDiffInline(A[r.a], B[r.b]);
      row.replaceChild(mkHl("tx tx-l", hl.aPre, hl.aMid, hl.aSuf), row.children[1]);
      row.replaceChild(mkHl("tx tx-r", hl.bPre, hl.bMid, hl.bSuf), row.children[3]);
    }
    if (r.a == null || r.b == null) {
      row.classList.add("blank");
      for (const c of [...row.children]) c.classList.add("blank");
    }
    frag.appendChild(row);
  });
  box.textContent = "";
  box.appendChild(frag);
  btDiffState = { rows, blocks, cur: blocks.length ? 0 : -1 };
  btDiffMark();
}

function btDiffMark() {
  const box = $id("bt-diff-body");
  if (!box) return;
  for (const e of box.querySelectorAll(".cur")) e.classList.remove("cur");
  const b = btDiffState.blocks[btDiffState.cur];
  if (!b) return;
  for (let i = b.start; i <= b.end; i++) {
    const row = box.querySelector('[data-row="' + i + '"]');
    if (row) row.classList.add("cur");
  }
  const first = box.querySelector('[data-row="' + b.start + '"]');
  if (first) {
    const top = first.offsetTop - box.clientHeight / 2 + first.offsetHeight / 2;
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, top));
  }
}

function btDiffGo(dir) {
  const n = btDiffState.blocks.length;
  if (!n) return;
  btDiffState.cur = ((btDiffState.cur + dir) % n + n) % n;
  btDiffMark();
}

function btDiffOpen(on) {
  const diff = $id("bt-diff");
  const grid = document.querySelector('.workpane[data-work="batch"] .btgrid');
  if (!diff || !grid) return;
  diff.hidden = !on;
  grid.hidden = on;
  if (on) btDiffRender();
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

  btInitChips();
  // 右栏这几张卡也是可折叠的（各自记状态）
  const btPane = document.querySelector('.parampane[data-param="batch"]');
  bindSections(btPane ? [...btPane.querySelectorAll(".dcsection")] : [], BT_OPEN_KEY, "bt-expand-all", "bt-collapse-all");

  // JSON / 大小写 / 缩进
  $id("bt-json-fmt").onclick = () => btJsonFormat(false);
  $id("bt-json-min").onclick = () => btJsonFormat(true);
  document.querySelectorAll(".bt-case-btn").forEach((b) => { b.onclick = () => btApply(btCase(b.dataset.case)); });
  $id("bt-indent-run").onclick = btIndentRun;
  $id("bt-out-to-in").onclick = () => {
    box.value = $id("bt-out").value;
    btRender();
    $id("bt-state").textContent = T("结果已搬回输入");
  };

  // 清空 / 复制 / 另存为 / 发送
  $id("bt-clear").onclick = () => { box.value = ""; $id("bt-out").value = ""; btEol = ""; btRender(); };
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
  // 文本比对（左边输入 ↔ 右边结果）
  dcChips("bt-diff-right", [["out", T("结果")], ["file", T("文件…")]], {
    onChange: (v) => {
      const last = v;
      if (last === "file") { if (!btDiffRight.text) btDiffPickRight(); else btDiffRender(); }
      else { btDiffRight = { mode: "out", text: "", name: "" }; btDiffRender(); }
    },
  });
  $id("bt-diff-open").onclick = () => btDiffOpen(true);
  $id("bt-diff-close").onclick = () => btDiffOpen(false);
  $id("bt-diff-prev").onclick = () => btDiffGo(-1);
  $id("bt-diff-next").onclick = () => btDiffGo(1);
  for (const id of ["bt-diff-icase", "bt-diff-iws"]) {
    const n = $id(id);
    if (n) n.onchange = btDiffRender;
  }
  document.addEventListener("keydown", (e) => {
    const pane = document.querySelector('.workpane[data-work="batch"]');
    if (!pane || pane.hidden) return;
    if ($id("bt-diff").hidden) return;
    if (e.key === "F7") { e.preventDefault(); btDiffGo(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); btDiffOpen(false); }
  });
  // 导入 / 示例（导入也能直接把文件拖到左边那个框上）
  $id("bt-import").onclick = () => btImportFile("");
  $id("bt-sample").onclick = () => {
    box.value = ["AT", "AT+NAME=KDock", "AT+BAUD=115200", "AT+SAVE", "AT+RESET"].join("\n");
    btRender();
    btMsg(T("已填入示例（一行一条，像 AT 指令那样）"));
  };
  for (const taId of BT_ED) {
    const ta = $id(taId), ln = $id(taId + "-ln");
    if (!ta || !ln) continue;
    ta.addEventListener("scroll", () => { ln.scrollTop = ta.scrollTop; });
    for (const ev of ["input", "click", "keyup", "mouseup", "select"]) ta.addEventListener(ev, btStatusRender);
  }
  window.addEventListener("resize", btLineNumbersSoon);
  getCurrentWebview().onDragDropEvent((ev) => {
    const pane = document.querySelector('.workpane[data-work="batch"]');
    const col = $id("bt-in-col");
    if (!pane || pane.hidden || !col) return;
    const t = ev.payload && ev.payload.type;
    col.classList.toggle("dragover", t === "over" || t === "enter");
    if (t === "drop") {
      col.classList.remove("dragover");
      const paths = (ev.payload && ev.payload.paths) || [];
      if (paths.length) btImportFile(paths[0]);
    }
  });
  btRender();
  // 切语言时把这一页里"运行时拼出来的"文字重画一遍
  onLang(() => { btInitChips(); btRender(); btUpdateCount(); btStatusRender(); btMsg(""); $id("bt-state").textContent = ""; if ($id("bt-diff") && !$id("bt-diff").hidden) btDiffRender(); });   // 小标签重建成当前语言；旧提示/状态是上一门语言拼的，清掉
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
  // 最上面两行（单独高亮）：进制显示 + 浮点 + ☆ 标记 —— 英文标签也放得下
  [["以 16 进制显示", "base:hex", "base hi", 2], ["以 10 进制显示", "base:dec", "base hi", 2], ["以 2 进制显示", "base:bin", "base hi", 2], ["→ 浮点", "float", "base hi"]],
  [["☆ 标记这个数据", "mark", "base hi", 7]],
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

/* --------------------- 浮点 ↔ 数值（左右互转） ---------------------
   照"翻译页面"那种做法：两个框并排摆着，在哪边输入都行，另一边实时跟着变 ——
   不让人先选"我要哪个方向"，也没有模式下拉/复选框。
   位侧认 0x / 0b 前缀，也认纯十进制整数；宽度 32/64 决定这串位怎么解释。 */

const fd32 = new DataView(new ArrayBuffer(4));
const fd64 = new DataView(new ArrayBuffer(8));
let flBusy = false;               // 防止两边 input 事件互相触发打成死循环

const flHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join("");

/** 浮点侧输入 → 计算位、写回位侧/BIN/明细 */
function flFromFloat() {
  const inp = $id("fl-float"), bitsIn = $id("fl-bits"), binIn = $id("fl-bin"), out = $id("fl-out");
  if (!inp || !out) return;
  const raw = String(inp.value || "").trim();
  out.textContent = "";
  if (!raw) { if (bitsIn) bitsIn.value = ""; if (binIn) binIn.value = ""; return; }
  const low = raw.toLowerCase();
  const v = low === "nan" ? NaN
    : low === "inf" || low === "+inf" ? Infinity
    : low === "-inf" ? -Infinity
    : Number(raw.replace(/[,\s]/g, ""));
  if (!(Number.isFinite(v) || Number.isNaN(v))) {
    out.appendChild(el("div", "sub", T("这不是个数：") + raw));
    return;
  }
  const f32 = Math.fround(v);
  fd32.setFloat32(0, f32, false);
  fd64.setFloat64(0, v, false);
  const h32 = flHex(fd32.buffer), h64 = flHex(fd64.buffer);
  const width = Number(($id("fl-width") || {}).dataset ? $id("fl-width").dataset.val : 32) || 32;
  const h = width === 64 ? h64 : h32;
  if (bitsIn && document.activeElement !== bitsIn) bitsIn.value = "0x" + h;
  if (binIn) {
    const bits = bigFromHex(h).toString(2).padStart(width, "0");
    binIn.value = bits.replace(/(.{8})(?=.)/g, "$1 ");
  }
  flDetail(v, h32, h64);
}

/** 位侧输入 → 反推浮点，写回浮点侧 */
function flFromBits() {
  const inp = $id("fl-bits"), flIn = $id("fl-float"), binIn = $id("fl-bin"), out = $id("fl-out");
  if (!inp || !out) return;
  const raw = String(inp.value || "").trim().replace(/[\s_]/g, "");
  out.textContent = "";
  if (!raw) { if (flIn && document.activeElement !== flIn) flIn.value = ""; if (binIn) binIn.value = ""; return; }
  try {
    let hex, width;
    if (/^0b[01]+$/i.test(raw)) {
      const bits = raw.slice(2);
      width = bits.length > 32 ? 64 : 32;
      hex = bigFromBin(bits).toString(16).toUpperCase().padStart(width / 4, "0");
    } else if (/^0x[0-9a-f]+$/i.test(raw)) {
      const t = raw.slice(2);
      width = t.length > 8 ? 64 : 32;
      hex = t.toUpperCase().padStart(width / 4, "0");
    } else if (/^[0-9a-f]+$/i.test(raw) && raw.length === 8 || raw.length === 16) {
      width = raw.length === 16 ? 64 : 32;
      hex = raw.toUpperCase().padStart(width / 4, "0");
    } else {
      // 纯十进制整数：按它自己的位宽（≤32 用 32，否则 64）
      const n = dcParse(raw, 10);
      width = (n < 0n ? -n : n) > 0xffffffffn ? 64 : 32;
      hex = (n < 0n ? n + (1n << BigInt(width)) : n).toString(16).toUpperCase().padStart(width / 4, "0");
    }
    const bytes = new Uint8Array(width / 8);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const dv = new DataView(bytes.buffer);
    const v = width === 32 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
    if (flIn && document.activeElement !== flIn) flIn.value = String(v);
    if (binIn) binIn.value = bigFromHex(hex).toString(2).padStart(width, "0").replace(/(.{8})(?=.)/g, "$1 ");
    fd32.setFloat32(0, Math.fround(v), false);
    fd64.setFloat64(0, v, false);
    flDetail(v, flHex(fd32.buffer), flHex(fd64.buffer));
  } catch (e) {
    out.appendChild(el("div", "sub", String(e.message || e)));
  }
}

/** 下半边那块明细：两种精度都给，附符号/阶码/尾数 */
function flDetail(v, h32, h64) {
  const out = $id("fl-out");
  if (!out) return;
  out.textContent = "";
  const push = (k, val, cls) => {
    const r = el("div", "row");
    r.append(el("span", "k", k), el("span", "v" + (cls ? " " + cls : ""), val));
    out.appendChild(r);
    return r;
  };
  const row32 = push("float32", `0x${h32}  ·  ${Math.fround(v)}`, "calc-file-row");
  row32.title = T("点一下复制");
  const raw = parseInt(h32, 16) >>> 0;
  const sign = (raw >>> 31) & 1, exp = (raw >>> 23) & 0xff, mant = raw & 0x7fffff;
  push(T("符号"), sign ? T("-（负数）") : T("+（正数）"));
  push(T("阶码"), `${exp} − 127 = ${exp - 127}  (0x${exp.toString(16).toUpperCase().padStart(2, "0")})`);
  push(T("尾数"), "0x" + mant.toString(16).toUpperCase().padStart(6, "0"));
  const row64 = push("float64", `0x${h64}  ·  ${v}`, "calc-file-row");
  row64.title = T("点一下复制");
  push(T("科学计数"), Number.isFinite(v) ? v.toExponential(9) : String(v));
}

/** 十六进制串 → BigInt（不经过 Number，64 位也不丢精度） */
function bigFromHex(h) { return BigInt("0x" + (h || "0")); }
function bigFromBin(b) { return BigInt("0b" + (b || "0")); }

// 计算器里那个值也在实时喂过来（在计算器页按数字，这边跟着变）
function ieeeRenderLive(v) {
  const pane = document.querySelector('[data-work="datacalc"]');
  if (!pane || pane.hidden) return;
  const flIn = $id("fl-float"), bitsIn = $id("fl-bits");
  if (!flIn || !Number.isFinite(v)) return;
  if (document.activeElement === flIn || document.activeElement === bitsIn) return;
  flIn.value = String(v);
  flFromFloat();
}

/** 位侧/浮点侧互相喂的时候会各自触发 input，用 flBusy 掐掉回环 */
function flBindBoth() {
  const a = $id("fl-float"), b = $id("fl-bits");
  const guard = (fn) => () => {
    if (flBusy) return;
    flBusy = true;
    try { fn(); } finally { flBusy = false; }
  };
  if (a) a.addEventListener("input", guard(flFromFloat));
  if (b) b.addEventListener("input", guard(flFromBits));
}

/* ------------------------- 文件校验 / 哈希 ------------------------- */

let calcFile = "";
/** 能算的校验算法：key 与后端 file_digest 的字段同名，label 是显示名 */
const DC_ALGS = [
  ["crc32", "CRC32"],
  ["crc16ccitt", "CRC16/CCITT"],
  ["crc16modbus", "CRC16/MODBUS"],
  ["md5", "MD5"],
  ["sha1", "SHA1"],
  ["sha256", "SHA256"],
];
let dcFileRes = null;          // 最近一次算出来的结果（核对用）

function digestRow(k, v, mono) {
  const r = el("div", "row");
  r.append(el("span", "k", k), el("span", "v" + (mono ? " calc-file-row" : ""), v));
  return r;
}

/** 算完了往结果区写：只写选中的那几项 */
function dcFileRender(r, mark) {
  const box = $id("calc-file-out");
  if (!box) return;
  box.innerHTML = "";
  const picked = dcChipVal("dc-algs", true);
  const head = el("div", "row");
  head.append(el("span", "k", T("文件")), el("span", "v", `${r.path.split(/[\\/]/).pop()} · ${Number(r.size).toLocaleString()} ${T("字节")} · ${T("范围")} ${r.offset}+${r.length}`));
  head.title = r.path;
  box.appendChild(head);
  for (const [key, label] of DC_ALGS) {
    if (picked.length && !picked.includes(key)) continue;
    const val = String(r[key] == null ? "" : r[key]);
    const row = digestRow(label, val, true);
    if (mark) {
      const hit = mark.has(normHash(val));
      row.classList.add(hit ? "dchit" : "dcmiss");
      const flag = el("span", "flag", hit ? "✓" : "✗");
      row.appendChild(flag);
    }
    box.appendChild(row);
  }
  const line = el("div", "trow");
  const copyAll = el("button", "btn small", T("复制全部"));
  const toCalc = el("button", "btn small", T("→ 计算器"));
  line.append(copyAll, toCalc);
  box.appendChild(line);
  copyAll.onclick = async () => {
    const text = [...box.querySelectorAll(".row")].map((x) => x.textContent.replace(/[✓✗]$/, "")).join("\n");
    try { await navigator.clipboard.writeText(text); toastMini(T("已复制")); } catch (_) { toastMini(T("复制失败")); }
  };
  toCalc.onclick = () => {
    // 能当数看的（CRC32 / CRC16）才能进计算器
    const key = (picked.length ? picked : ["crc32"]).find((k) => k === "crc32" || k.startsWith("crc16")) || "crc32";
    const raw = String(r[key] == null ? "" : r[key]).replace(/[^0-9a-fA-Fx]/g, "");
    if (!raw) { toastMini(T("这一项没法当数算")); return; }
    calcExprSet(/^0x/i.test(raw) ? raw : "0x" + raw);
    calcRun(/^0x/i.test(raw) ? raw : "0x" + raw);
    toastMini(T("已填进计算器") + "：" + key);
  };
}

/** 归一化：小写、去掉 0x / 空格 / 冒号 / 横线，方便"粘一个值来核对" */
const normHash = (s) => String(s || "").toLowerCase().replace(/0x/g, "").replace(/[\s:\-]/g, "");

async function calcFileGo() {
  const box = $id("calc-file-out");
  const hint = $id("calc-file-hint");
  if (!box) return;
  // 路径可以直接粘（也可以点「选文件…」）
  const typed = ($id("calc-file-path") || {}).value;
  if (typed != null && String(typed).trim()) calcFile = String(typed).trim();
  if (!calcFile) { box.innerHTML = ""; return; }
  box.innerHTML = "";
  box.appendChild(el("div", "sub", T("计算中…")));
  try {
    const r = await invoke("file_digest", {
      path: calcFile,
      offset: Number($id("calc-file-off").value) || 0,
      length: Number($id("calc-file-len").value) || 0,
    });
    dcFileRes = r;
    if (!box) return;
    dcFileRender(r, dcVerifyMark());
    if (hint) hint.textContent = T("算完了") + " · " + new Date().toLocaleTimeString();
    if ($id("calc-file-into").checked) {
      const picked = dcChipVal("dc-algs", true);
      const key = (picked.length ? picked : ["crc32"]).find((k) => k === "crc32" || k.startsWith("crc16")) || "crc32";
      const raw = String(r[key] == null ? "" : r[key]).replace(/[^0-9a-fA-Fx]/g, "");
      if (raw) { const x = /^0x/i.test(raw) ? raw : "0x" + raw; calcExprSet(x); calcRun(x); }
    }
  } catch (e) {
    if (box) { box.innerHTML = ""; box.appendChild(el("div", "sub", String(e))); }
    if (hint) hint.textContent = "";
  }
}

/** 核对框里粘了个值 → 返回"匹配上的那些值的集合"（没填就 null） */
function dcVerifyMark() {
  const inp = $id("dc-verify");
  const want = normHash(inp && inp.value);
  if (!want) return null;
  const set = new Set();
  for (const [key] of DC_ALGS) {
    if (dcFileRes && normHash(dcFileRes[key]) === want) set.add(want);
  }
  return set;
}

function dcVerifyGo() {
  if (!dcFileRes) { toastMini(T("先点「计算」")); return; }
  const mark = dcVerifyMark();
  if (!mark) { toastMini(T("先粘一个期望值")); return; }
  dcFileRender(dcFileRes, mark);
  const names = DC_ALGS.filter(([k]) => normHash(dcFileRes[k]) === normHash($id("dc-verify").value)).map(([, l]) => l);
  toastMini(names.length ? `${T("对得上")}：${names.join(" / ")}` : T("六项都对不上 —— 文件或范围可能不对"));
}

/* --------------------------- JSON 整理 --------------------------- */

/** 键排序（递归） */
function dcSortKeys(v) {
  if (Array.isArray(v)) return v.map(dcSortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = dcSortKeys(v[k]);
    return out;
  }
  return v;
}

/** JSON 报错里那句 "at position 12 (line 3 column 4)" → 顺手把出错那一行也带出来 */
function dcJsonErrMsg(e, src) {
  const msg = String((e && e.message) || e);
  const m = /position (\d+)/.exec(msg);
  if (!m) return msg;
  const pos = Number(m[1]);
  const upto = src.slice(0, pos);
  const line = upto.split(/\r?\n/).length;
  const col = pos - upto.lastIndexOf("\n");
  const bad = src.split(/\r?\n/)[line - 1] || "";
  return `${msg}\n${T("第")} ${line} ${T("行第")} ${col} ${T("列")}${bad ? "：" + bad.trim().slice(0, 80) : ""}`;
}

function dcJson(mode) {
  const inp = $id("dc-json-in"), out = $id("dc-json-out"), hint = $id("dc-json-hint");
  if (!inp || !out) return;
  let src = String(inp.value || "");
  if (!src.trim()) { out.value = ""; if (hint) hint.textContent = T("先粘点 JSON"); return; }
  try {
    if (mode === "un") {                       // 反转义：把 \n \" \uXXXX 还原
      let t = src.trim();
      if (!/^["']/.test(t)) t = '"' + t.replace(/"/g, '\\"') + '"';
      out.value = JSON.parse(t);
      if (hint) hint.textContent = T("反转义完成");
      return;
    }
    if (mode === "esc") {                      // 转义：整段变成一个字符串字面量
      out.value = JSON.stringify(src.trim());
      if (hint) hint.textContent = T("已转义（可直接塞进代码）");
      return;
    }
    // 从代码里粘出来的往往整段是"字符串形式的 JSON"，先试着剥一层
    let text = src.trim();
    if (/^["']/.test(text) && text.includes("\\")) {
      try { const unwrapped = JSON.parse(text); if (typeof unwrapped === "string") text = unwrapped; } catch (_) {}
    }
    let data = JSON.parse(text);
    if ($id("dc-json-sort") && $id("dc-json-sort").checked) data = dcSortKeys(data);
    if (mode === "check") {
      out.value = "";
      if (hint) hint.textContent = T("✅ JSON 合法");
      return;
    }
    const indent = Number(($id("dc-json-indent") || {}).dataset ? $id("dc-json-indent").dataset.val : 2) || 0;
    out.value = mode === "min" ? JSON.stringify(data) : JSON.stringify(data, null, indent);
    if (hint) {
      const n = out.value.split(/\r?\n/).length;
      hint.textContent = (mode === "min" ? T("压缩完成") : T("格式化完成")) + ` · ${n} ${T("行")} · ${out.value.length} ${T("字符")}`;
    }
  } catch (e) {
    out.value = "";
    if (hint) hint.textContent = dcJsonErrMsg(e, src);
  }
}

/* --------------------------- 文本哈希 / HMAC --------------------------- */

async function dcHashGo() {
  const out = $id("hm-out");
  if (!out) return;
  out.innerHTML = "";
  const text = String(($id("hm-in") || {}).value || "");
  const key = String(($id("hm-key") || {}).value || "");
  const data = new TextEncoder().encode(text);
  try {
    for (const alg of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
      const buf = await crypto.subtle.digest(alg, data);
      const hex = dcBytesHex(new Uint8Array(buf));
      out.appendChild(digestRow(alg, hex, true));
    }
    if (key) {
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", k, data);
      out.appendChild(digestRow("HMAC-SHA256", dcBytesHex(new Uint8Array(sig)), true));
    }
    out.appendChild(el("div", "sub", T("点一行复制")));
  } catch (e) {
    out.appendChild(el("div", "sub", String(e.message || e)));
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
   文件校验 / IEEE 浮点在下面各自的函数里；这里放：进制·字节序、AES、RSA、视频带宽计算。
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

/* ---------- 小选择器（chips）：单选看着像"标签"，比下拉/复选框紧凑也好认 ---------- */
const dcChipSel = {};                    // id -> Set(选中的值)
function dcChips(id, items, opts) {
  const box = $id(id);
  if (!box) return;
  const multi = !!(opts && opts.multi);
  const def = box.dataset.val || (items[0] && items[0][0]);
  dcChipSel[id] = new Set(multi ? String(def).split(",").filter(Boolean) : [String(def)]);
  box.textContent = "";
  for (const [val, label] of items) {
    const b = el("button", "chip", label);
    b.type = "button";
    b.dataset.val = val;
    b.onclick = () => {
      const sel = dcChipSel[id];
      if (multi) { if (sel.has(val)) sel.delete(val); else sel.add(val); }
      else { sel.clear(); sel.add(val); box.dataset.val = val; }
      dcChipPaint(id);
      if (opts && opts.onChange) opts.onChange(dcChipVal(id, multi));
    };
    box.appendChild(b);
  }
  dcChipPaint(id);
}
function dcChipPaint(id) {
  const box = $id(id);
  if (!box) return;
  const sel = dcChipSel[id] || new Set();
  for (const b of box.querySelectorAll("button")) b.classList.toggle("on", sel.has(b.dataset.val));
}
function dcChipVal(id, multi) {
  const arr = [...(dcChipSel[id] || new Set())];
  return multi ? arr : (arr[0] || "");
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
/** 按用户选的格式解析输入；auto = 像 hex 就 hex、像 base64 就 base64、其余按文本 */
function dcParseBytes(s, fmt, what) {
  const t = String(s == null ? "" : s);
  if (!t.trim()) throw new Error(T("先填") + what);
  if (fmt === "hex") return dcHexBytes(t);
  if (fmt === "b64") return dcUnB64(t);
  if (fmt === "text") return new TextEncoder().encode(t);
  const bare = t.trim().replace(/[\s:]/g, "");
  if (/^[0-9a-fA-F]+$/.test(bare) && bare.length % 2 === 0 && bare.length >= 16) return dcHexBytes(bare);
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.trim().length % 4 === 0 && t.trim().length >= 16) {
    try { return dcUnB64(t); } catch (_) { /* 落回文本 */ }
  }
  return new TextEncoder().encode(t);
}
/** 密钥：HEX / Base64 / 正好那么长的文本都认（在线工具一般也这么干） */
function dcKeyBytes(s, nbytes) {
  const t = String(s == null ? "" : s).trim();
  if (!t) throw new Error(T("先填密钥"));
  const bare = t.replace(/[\s:]/g, "");
  if (/^[0-9a-fA-F]+$/.test(bare) && bare.length === nbytes * 2) return dcHexBytes(bare);
  try { const u = dcUnB64(t); if (u.length === nbytes) return u; } catch (_) {}
  const utf = new TextEncoder().encode(t);
  if (utf.length === nbytes) return utf;
  throw new Error(T("密钥长度不对") + `：要 ${nbytes} ${T("字节")}（HEX ${nbytes * 2} 个字符 / Base64 / 正好 ${nbytes} 字节的文本），现在是 HEX ${bare.length} 个字符或文本 ${utf.length} 字节`);
}
const dcRandomBytes = (n) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return u; };

async function dcAes(dir) {
  const out = $id("aes-out"), hint = $id("aes-hint");
  if (!out) return;
  out.innerHTML = "";
  try {
    const mode = dcChipVal("aes-mode") || "GCM";        // CBC / CTR / GCM
    const bits = Number(dcChipVal("aes-bits") || 256);
    const keyBytes = dcKeyBytes($id("aes-key").value, bits / 8);
    const iv = dcBytes($id("aes-iv").value, "IV");
    const okIv = mode === "GCM" ? [8, 12, 16] : [16];
    if (!okIv.includes(iv.length)) {
      throw new Error("IV " + T("长度不对") + "：" + iv.length + " " + T("字节") +
        (mode === "GCM" ? "（GCM 要 12 字节，8/16 也收）" : "（" + mode + " 要 16 字节）"));
    }
    const alg = { name: "AES-" + mode };
    const key = await crypto.subtle.importKey("raw", keyBytes, alg, false, [dir === "enc" ? "encrypt" : "decrypt"]);
    // 注意：CTR 的参数叫 counter（不是 iv），而且还要给 length —— 传错 WebCrypto 直接抛错
    const params = mode === "GCM" ? { name: "AES-GCM", iv, tagLength: 128 }
      : mode === "CTR" ? { name: "AES-CTR", counter: iv, length: 64 }
      : { name: "AES-CBC", iv };
    const infmt = dcChipVal("aes-infmt") || "auto";
    const outfmt = dcChipVal("aes-outfmt") || "both";
    if (dir === "enc") {
      const data = dcParseBytes($id("aes-in").value, infmt === "auto" ? "text" : infmt, T("明文"));
      const buf = await crypto.subtle.encrypt(params, key, data);
      dcAesOut(out, new Uint8Array(buf), outfmt);
      if (hint) hint.textContent = T("加密完成") + `：${data.length} → ${buf.byteLength} ${T("字节")}`;
    } else {
      const buf = await crypto.subtle.decrypt(params, key, dcParseBytes($id("aes-in").value, infmt, T("密文")));
      dcAesOut(out, new Uint8Array(buf), outfmt === "text" ? "text" : outfmt, true);
      if (hint) hint.textContent = T("解密完成") + `：${buf.byteLength} ${T("字节")}`;
    }
  } catch (e) {
    const msg = String((e && e.name) === "OperationError" ? T("解密失败：密钥 / IV / 密文对不上，或者数据被改过") : (e.message || e));
    out.append(digestRow(T("出错"), msg, true));
    if (hint) hint.textContent = "";
  }
}

/** 结果按选定的输出格式写（both = base64 + hex 都给；解密时还能给文本） */
function dcAesOut(out, u8, fmt, fromDecrypt) {
  if (fmt === "both" || fmt === "b64") out.appendChild(digestRow("base64", dcB64(u8), true));
  if (fmt === "both" || fmt === "hex") out.appendChild(digestRow("hex", dcBytesHex(u8), true));
  if (fmt === "text" || (fromDecrypt && fmt === "both")) {
    try { out.appendChild(digestRow(T("文本"), new TextDecoder().decode(u8), true)); } catch (_) {}
  }
  out.appendChild(el("div", "sub", T("点一行复制")));
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
    return crypto.subtle.importKey(fmt, dcPemToBuf(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true,
      [which === "pub" ? "verify" : "sign"]);
  }
  return crypto.subtle.importKey(fmt, dcPemToBuf(pem), { name: "RSA-OAEP", hash: "SHA-256" }, true,
    [which === "pub" ? "encrypt" : "decrypt"]);
}

/** 顺手报一下这把钥匙多少位（导入成功就拿得到 modulusLength） */
async function dcRsaKeyInfo() {
  const el2 = $id("rsa-keyinfo");
  if (!el2) return;
  const pem = String(($id("rsa-key") || {}).value || "");
  if (!pem.trim()) { el2.textContent = ""; return; }
  // 注意：私钥只能用 decrypt/sign 这类用途导入（拿 ["encrypt"] 导私钥会直接抛错）
  for (const [fmt, label, use] of [["spki", T("公钥"), "encrypt"], ["pkcs8", T("私钥"), "decrypt"]]) {
    try {
      const k = await crypto.subtle.importKey(fmt, dcPemToBuf(pem), { name: "RSA-OAEP", hash: "SHA-256" }, true, [use]);
      el2.textContent = `${label} · RSA ${k.algorithm.modulusLength} ${T("位")} · ${(k.algorithm.publicExponent ? "e=65537" : "")}`;
      return;
    } catch (_) {}
  }
  el2.textContent = T("这把钥匙认不出来（要 SPKI/PKCS#8 的 PEM 或 DER）");
}

/** 生成一对 RSA 密钥（同一个模数既能 OAEP 加密也能 PKCS#1 签名，跟在线工具一致） */
async function dcRsaGen() {
  const out = $id("rsa-out"), hint = $id("rsa-hint");
  if (!out) return;
  const bits = Number(dcChipVal("rsa-genbits") || 2048);
  out.innerHTML = "";
  if (hint) hint.textContent = T("正在生成…") + `（${bits} ${T("位")}，可能要一两秒）`;
  try {
    const kp = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["encrypt", "decrypt"],
    );
    const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const pubPem = dcPem("PUBLIC KEY", spki), prvPem = dcPem("PRIVATE KEY", pkcs8);
    $id("rsa-key").value = prvPem;          // 默认把私钥放进框里（签名/解密都要它）
    out.appendChild(el("div", "sub", T("密钥对已生成（框里放的是私钥；公钥在下面，复制给对方）")));
    for (const [label, pem] of [[T("公钥"), pubPem], [T("私钥"), prvPem]]) {
      const row = digestRow(label, pem.replace(/\r?\n/g, " ⏎ "), true);
      const b = el("button", "btn small", T("复制"));
      b.onclick = async (ev) => {
        ev.stopPropagation();
        try { await navigator.clipboard.writeText(pem); toastMini(T("已复制") + " " + label); } catch (_) { toastMini(T("复制失败")); }
      };
      row.appendChild(b);
      out.appendChild(row);
    }
    if (hint) hint.textContent = T("生成完成") + `：RSA ${bits}`;
    dcRsaKeyInfo();
  } catch (e) {
    out.appendChild(digestRow(T("出错"), String(e.message || e), true));
    if (hint) hint.textContent = "";
  }
}

/** 导出成 PEM（64 列换行） */
function dcPem(label, buf) {
  const b64 = dcB64(buf).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
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

/* ---------- 视频带宽计算（数据计算页第 8 块） ----------
   算法在 video-bandwidth.js 里（纯函数、不碰 DOM）：这里只负责输入框、四个带宽数、
   时序明细、以及"逐接口版本能不能扛住"那三条列表。 */
const VB_GROUPS = [["dp", "DisplayPort"], ["hdmi", "HDMI"], ["dpam", "DisplayPort Alt Mode on USB-C"]];   // 顺序跟参考页一致：两大接口在前，USB-C 上的 DP Alt 放最后
const VB_UNITS = { maximum: "带宽（峰值）", line: "Line", active: "Active", dsc: "DSC（8 bpp 下限）" };
const VB_STATE_TXT = { ok: "支持", light: "支持（轻度 DSC）", heavy: "支持（重度 DSC）", no: "不支持" };
const VB_STATE_EN = { ok: "Supported", light: "Supported, light DSC", heavy: "Supported, heavy DSC", no: "Not supported" };
/** 这一块的结论文案自带中英两份：公共词典里 "支持" 被别的地方占着（译成了 Formats），不能复用 */
const vbIsEn = () => document.documentElement.dataset.lang === "en";
const vbStateText = (st) => (vbIsEn() ? VB_STATE_EN[st] : VB_STATE_TXT[st]);

const vbFmtG = (v) => (v / 1e9).toFixed(2);
const vbMHz = (v) => (v / 1e6).toFixed(3) + " MHz";
const vbKHz = (v) => (v / 1e3).toFixed(2) + " kHz";

/** 输入框里现在这套规格 */
function vbInputs() {
  return {
    width: Number($id("vb-w").value),
    height: Number($id("vb-h").value),
    refreshRate: Number($id("vb-r").value),
    colorDepth: Number(dcChipVal("vb-depth")),
    colorFormat: dcChipVal("vb-format") || "rgb444",
    timing: dcChipVal("vb-timing") || "cvt_rb2",
  };
}

/** 算不出来时的说明：把"为什么"讲清楚（别学原页面那样一律 N/A） */
function vbProblemBox(e, inp) {
  const box = el("div", "vbblock bad");
  const head = el("div", "vbblock-head");
  const spec = `${inp.width}×${inp.height}@${inp.refreshRate}Hz`;
  const field = { width: T("宽度"), height: T("高度"), refreshRate: T("刷新率"), colorDepth: T("色深") }[e.field || ""] || "";
  let title = T("这套规格算不出来"), why = String(e.message || e);
  if (e.vbCode === "no-dmt") {
    title = T("DMT 表里没有这套时序");
    why = T("DMT 是标准分辨率表（最大 4096×2160），{spec} 不在里面 —— 表里没有 144Hz 这种高刷，也没有非标准分辨率。").replace("{spec}", spec);
  } else if (e.vbCode === "no-cea") {
    title = T("CTA-861 表里没有这套时序");
    why = T("CTA-861 只收广播视频模式（而且只认逐行），{spec} 不在里面。").replace("{spec}", spec);
  } else if (e.vbCode === "zero") {
    why = T("{f} 不能是 0。").replace("{f}", field);
  } else if (e.vbCode === "bad-number") {
    why = field ? T("{f} 得是个数字。").replace("{f}", field) : T("这几个输入都得是数字。");
  } else if (e.vbCode === "not-finite") {
    why = T("算出来的时序里有非法值（{f}）—— 换个规格再试。").replace("{f}", T(e.field || ""));
  }
  head.append(el("b", null, title), el("span", "grow"));
  box.append(head, el("div", "vbsub", why));
  if (e.vbCode === "no-dmt" || e.vbCode === "no-cea") {
    const row = el("div", "vbrow");
    const b1 = el("button", "btn tiny", T("改用 CVT-RBv2"));
    b1.onclick = () => { dcChipSel["vb-timing"] = new Set(["cvt_rb2"]); const c = $id("vb-timing"); if (c) c.dataset.val = "cvt_rb2"; dcChipPaint("vb-timing"); vbRender(); };
    const b2 = el("button", "btn tiny", T("改用 CVT"));
    b2.onclick = () => { dcChipSel["vb-timing"] = new Set(["cvt"]); const c = $id("vb-timing"); if (c) c.dataset.val = "cvt"; dcChipPaint("vb-timing"); vbRender(); };
    row.append(b1, b2);
    box.appendChild(row);
  }
  return box;
}

/** 四个带宽数 + 时序明细 */
function vbRenderOut(sig) {
  const box = $id("vb-out");
  box.innerHTML = "";
  const grid = el("div", "vbnums");
  for (const key of ["maximum", "line", "active", "dsc"]) {
    const t = el("div", "vbnum");
    t.append(el("span", "lb", T(VB_UNITS[key])));
    const line = el("div", "vbnum-line");
    line.append(el("b", null, vbFmtG(sig[key])), el("span", "u", "Gbps"));
    t.appendChild(line);
    t.title = key === "dsc"
      ? T("DSC 按固定 8 bpp 估的理论下限，跟输入的色深无关；实际压缩码率会更高。") + "\n" + T("点一下复制这个数")
      : T("点一下复制这个数");
    t.onclick = async () => {
      const v = vbFmtG(sig[key]) + " Gbps";
      try { await navigator.clipboard.writeText(v); toastMini(T("已复制：") + v); } catch (_) { toastMini(v); }
    };
    grid.appendChild(t);
  }
  box.appendChild(grid);

  const t = sig.timing;
  const rows = [];
  rows.push(["像素时钟", vbMHz(sig.clock)]);
  rows.push(["总像素（含消隐）", `${t.hTotal} × ${t.vTotal}`]);
  rows.push(["有效像素", `${t.hActive} × ${t.vActive}（消隐 ${t.hBlank} × ${t.vBlank}）`]);
  rows.push(["实际刷新率", `${t.vfreq.toFixed(3)} Hz` + (Math.abs(t.vfreq - sig.options.refreshRate) > 0.01 ? " · " + T("要的是 {r} Hz").replace("{r}", sig.options.refreshRate) : "")]);
  rows.push(["行频", vbKHz(t.hfreq)]);
  rows.push(["前后肩 / 极性", `H ${t.hFront}/${t.hSync}/${t.hBack}  V ${t.vFront}/${t.vSync}/${t.vBack}  ${t.hpol}${t.vpol}`]);
  const srcTxt = t.source === "dmt" && t.dmtId != null
    ? `DMT #${t.dmtId}${t.code2 ? "（" + t.code2 + "）" : ""}${t.code3 ? "（" + t.code3 + "）" : ""}`
    : t.source === "cea" && t.vic != null ? `CTA-861 VIC ${t.vic}`
      : t.aspect ? `${T(vbTimingLabel(t.source))} · ${t.aspect}` : T(vbTimingLabel(t.source));
  rows.push(["时序来源", srcTxt]);
  for (const [k, v] of rows) box.appendChild(digestRow(T(k), v, true));
  if (t.vfreq100 !== sig.options.refreshRate) {
    box.appendChild(el("div", "vbsub", T("查表按 ±0.5 Hz 取整匹配：请求 {a} Hz，命中的是 {b} Hz 那行。").replace("{a}", sig.options.refreshRate).replace("{b}", t.vfreq100)));
  }
}
const vbTimingLabel = (key) => ({ cvt: "完整 CVT", cvt_rb: "CVT-RB", cvt_rb2: "CVT-RBv2", dmt: "DMT 查表", cea: "CTA-861 查表" }[key] || key);

/** 逐接口判定列表：每行 = 版本 + 选中模式 + DSC + 结论 */
function vbRenderIfaces(sig) {
  const box = $id("vb-ifaces");
  box.innerHTML = "";
  for (const [g, label] of VB_GROUPS) {
    const card = el("div", "vbgroup");
    card.appendChild(el("div", "vbgroup-head", T(label)));
    for (const face of VB_IFACES.filter((f) => f.group === g)) {
      const v = vbVerdict(face, sig);
      const st = vbState(v);
      const row = el("div", "vbface");
      row.dataset.st = st;
      row.append(el("span", "vbver", face.version));
      const mid = el("span", "vbbadges");
      if (v.ok) {
        mid.appendChild(el("span", "vbbadge mode", v.mode.name));
        if (v.dscBPP > 0) mid.appendChild(el("span", "vbbadge dsc", `DSC ${v.dscBPP} bpp`));
      } else {
        mid.appendChild(el("span", "vbbadge none", v.reasonKey === "bandwidth" ? T("带宽不够") : T(v.reasonKey === "format" ? "色度格式不支持" : "色深超上限")));
      }
      row.appendChild(mid);
      const right = el("span", "vbst");
      right.appendChild(el("span", "st " + st, vbStateText(st)));
      if (v.ok) {
        const use = v.dscBPP > 0 ? "100" : (sig.maximum / v.mode.bandwidth * 100).toFixed(1);   // 走 DSC 的档位：用量按压缩后的 100% 记（跟参考页一致）
        right.appendChild(el("span", "vbuse", T("用量 {p}%").replace("{p}", use)));
      }
      row.appendChild(right);
      const tip = v.ok
        ? [T("模式：{m}").replace("{m}", `${v.mode.name} —— ${v.mode.desc}`),
           T("模式带宽 {b} Gbps").replace("{b}", vbFmtG(v.mode.bandwidth)),
           T("需要 {b} Gbps").replace("{b}", vbFmtG(sig.maximum)),
           v.dscBPP > 0
             ? T("DSC 可用 {n} bpp（压缩率约 {p}%）").replace("{n}", v.dscBPP).replace("{p}", ((1 - sig.options.colorDepth / v.dscBPP) * 100).toFixed(1))
             : T("这一档不用 DSC"),
           face.hdr && sig.options.colorDepth >= 10 ? T("这个版本支持 HDR") : ""].filter(Boolean).join("\n")
        : [T("原因：{r}").replace("{r}", v.reason),
           T("最高模式带宽 {b} Gbps").replace("{b}", vbFmtG(face.modeList[0].bandwidth)),
           T("需要 {b} Gbps").replace("{b}", vbFmtG(sig.maximum))].join("\n");
      row.title = tip;
      card.appendChild(row);   // 行要进这一组那张卡里，不是直接挂到列表上
    }
    box.appendChild(card);
  }
  const foot = el("div", "vbsub", T("只算带宽账：判定「支持」只代表链路带宽够，不代表插上一定能点亮（还要看 EDID、链路训练、线缆、DSC 切片）。DP Alt Mode 只按 2 lane 算，另外 2 lane 留给 USB。"));
  box.appendChild(foot);
}

function vbRender() {
  const out = $id("vb-out");
  if (!out) return;
  const inp = vbInputs();
  let sig = null, bad = null;
  try { sig = vbCompute(inp); } catch (e) { bad = e; }
  if (bad) {
    out.innerHTML = "";
    out.appendChild(vbProblemBox(bad, inp));
    const list = $id("vb-ifaces");
    if (list) list.innerHTML = "";
    return;
  }
  vbRenderOut(sig);
  vbRenderIfaces(sig);
}

/** 常用规格：点了就填进输入框（色深也一起切） */
function vbRenderPresets() {
  const box = $id("vb-preset");
  if (!box) return;
  box.innerHTML = "";
  for (const p of VB_PRESETS) {
    const b = el("button", "chip", p.label);
    b.type = "button";
    b.onclick = () => {
      $id("vb-w").value = p.width;
      $id("vb-h").value = p.height;
      $id("vb-r").value = p.refreshRate;
      dcChipSel["vb-depth"] = new Set([String(p.colorDepth)]);
      const dc = $id("vb-depth"); if (dc) dc.dataset.val = String(p.colorDepth);
      dcChipPaint("vb-depth");
      vbRender();
    };
    box.appendChild(b);
  }
}

function initVB() {
  if (!$id("vb-out")) return;
  dcChips("vb-depth", VB_DEPTHS.map((d) => [String(d), String(d) + " bit"]), { onChange: vbRender });
  dcChips("vb-format", VB_FORMATS.map((f) => [f.id, f.name]), { onChange: vbRender });
  dcChips("vb-timing", VB_TIMINGS, { onChange: vbRender });
  vbRenderPresets();
  for (const id of ["vb-w", "vb-h", "vb-r"]) {
    const i = $id(id);
    if (i) i.addEventListener("input", vbRender);
  }
  vbRender();
}


/** 数据计算页的绑定（跟计算器一起在 initCalc 里挂一次） */
function initDataCalc() {
  dcBindSections();
  for (const id of ["dc-out", "calc-file-out", "fl-out", "aes-out", "hm-out", "rsa-out", "vb-out"]) dcBindRowCopy(id);

  // 小选择器
  dcChips("dc-algs", DC_ALGS.map(([k, l]) => [k, l]), { multi: true });
  dcChips("dc-json-indent", [["0", T("不缩进")], ["2", "2 " + T("空格")], ["4", "4 " + T("空格")]]);
  dcChips("fl-width", [["32", "float32"], ["64", "float64"]], { onChange: () => flFromFloat() });
  dcChips("dc-bits", [["8", "8 位"], ["16", "16 位"], ["32", "32 位"], ["64", "64 位"]], { onChange: dcGo });
  dcChips("aes-mode", [["CBC", "CBC"], ["CTR", "CTR"], ["GCM", "GCM"]]);
  dcChips("aes-bits", [["128", "128 位"], ["192", "192 位"], ["256", "256 位"]], { onChange: () => dcAesIvHint() });
  dcChips("aes-infmt", [["auto", T("自动")], ["text", T("文本")], ["hex", "HEX"], ["b64", "Base64"]]);
  dcChips("aes-outfmt", [["both", T("都要")], ["b64", "Base64"], ["hex", "HEX"], ["text", T("文本")]]);
  dcChips("rsa-genbits", [["2048", "2048"], ["3072", "3072"], ["4096", "4096"]]);
  dcAesIvHint();

  // 文件校验
  if ($id("dc-go")) $id("dc-go").onclick = dcGo;
  if ($id("dc-num")) $id("dc-num").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); dcGo(); } };
  if ($id("calc-file-go")) $id("calc-file-go").onclick = calcFileGo;
  if ($id("calc-file-pick")) {
    $id("calc-file-pick").onclick = async () => {
      try {
        const p = await dlgOpen({ title: T("选要算 CRC / 哈希的文件"), multiple: false, directory: false });
        const path = typeof p === "string" ? p : (p && p.path);
        if (!path) return;
        calcFile = path;
        if ($id("calc-file-path")) $id("calc-file-path").value = path;
        if ($id("calc-file-off")) $id("calc-file-off").value = 0;
        if ($id("calc-file-len")) $id("calc-file-len").value = 0;
        calcFileGo();
      } catch (e) { toastMini(String(e).slice(0, 60)); }
    };
  }
  if ($id("calc-file-path")) {
    $id("calc-file-path").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); calcFileGo(); }
    });
  }
  if ($id("dc-verify-go")) $id("dc-verify-go").onclick = dcVerifyGo;
  if ($id("dc-verify")) $id("dc-verify").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); dcVerifyGo(); } };

  // JSON
  if ($id("dc-json-fmt")) $id("dc-json-fmt").onclick = () => dcJson("fmt");
  if ($id("dc-json-min")) $id("dc-json-min").onclick = () => dcJson("min");
  if ($id("dc-json-check")) $id("dc-json-check").onclick = () => dcJson("check");
  if ($id("dc-json-esc")) $id("dc-json-esc").onclick = () => dcJson("esc");
  if ($id("dc-json-un")) $id("dc-json-un").onclick = () => dcJson("un");
  if ($id("dc-json-copy")) {
    $id("dc-json-copy").onclick = async () => {
      const v = String(($id("dc-json-out") || {}).value || "");
      if (!v) { toastMini(T("结果还是空的")); return; }
      try { await navigator.clipboard.writeText(v); toastMini(T("已复制")); } catch (_) { toastMini(T("复制失败")); }
    };
  }
  if ($id("dc-json-toin")) {
    $id("dc-json-toin").onclick = () => {
      const v = String(($id("dc-json-out") || {}).value || "");
      if (v) $id("dc-json-in").value = v;
    };
  }

  // 浮点 ↔ 数值：两边互相喂
  flBindBoth();
  document.querySelectorAll(".dccopy").forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const t = $id(b.dataset.copy);
      const v = t ? (t.value != null ? t.value : t.textContent) : "";
      try { await navigator.clipboard.writeText(v); toastMini(T("已复制") + "：" + String(v).slice(0, 40)); } catch (_) {}
    };
  });
  if ($id("fl-use-calc")) {
    $id("fl-use-calc").onclick = () => {
      const flIn = $id("fl-float");
      if (flIn) flIn.value = calcNum(calcValue);
      flFromFloat();
      toastMini(T("已取计算器当前值") + "：" + calcNum(calcValue));
    };
  }

  // AES
  if ($id("aes-enc")) $id("aes-enc").onclick = () => dcAes("enc");
  if ($id("aes-dec")) $id("aes-dec").onclick = () => dcAes("dec");
  if ($id("aes-key-gen")) $id("aes-key-gen").onclick = () => {
    const bits = Number(dcChipVal("aes-bits") || 256);
    $id("aes-key").value = dcBytesHex(dcRandomBytes(bits / 8));
    toastMini(T("随机密钥已生成（hex）"));
  };
  if ($id("aes-iv-gen")) $id("aes-iv-gen").onclick = () => {
    const n = dcChipVal("aes-mode") === "GCM" ? 12 : 16;
    $id("aes-iv").value = dcBytesHex(dcRandomBytes(n));
    toastMini(T("随机 IV 已生成（hex）"));
  };

  // 视频带宽计算
  initVB();

  // 文本哈希 / HMAC
  if ($id("hm-go")) $id("hm-go").onclick = dcHashGo;

  // RSA
  for (const [id, op] of [["rsa-enc", "enc"], ["rsa-dec", "dec"], ["rsa-sign", "sign"], ["rsa-verify", "verify"]]) {
    if ($id(id)) $id(id).onclick = () => dcRsa(op);
  }
  if ($id("rsa-gen")) $id("rsa-gen").onclick = dcRsaGen;
  if ($id("rsa-key-clear")) {
    $id("rsa-key-clear").onclick = () => {
      $id("rsa-key").value = "";
      if ($id("rsa-key-file")) $id("rsa-key-file").value = "";
      const o = $id("rsa-out"); if (o) o.innerHTML = "";
      dcRsaKeyInfo();
    };
  }
  let rsaTimer = null;
  if ($id("rsa-key")) {
    $id("rsa-key").addEventListener("input", () => {
      if (rsaTimer) clearTimeout(rsaTimer);
      rsaTimer = setTimeout(() => dcRsaKeyInfo(), 500);
    });
  }
  if ($id("rsa-key-pick")) {
    $id("rsa-key-pick").onclick = async () => {
      try {
        const p = await dlgOpen({ title: T("选 PEM 密钥文件"), multiple: false, directory: false });
        const path = typeof p === "string" ? p : (p && p.path);
        if (!path) return;
        $id("rsa-key").value = await readTextFile(path);
        if ($id("rsa-key-file")) $id("rsa-key-file").value = path;
        dcRsaKeyInfo();
      } catch (e) {
        if ($id("rsa-hint")) $id("rsa-hint").textContent = String(e.message || e).slice(0, 80);
      }
    };
  }
}

/** IV 长度的提示跟着模式走 */
function dcAesIvHint() {
  const el2 = $id("aes-ivhint");
  if (!el2) return;
  const mode = dcChipVal("aes-mode") || "GCM";
  el2.textContent = mode === "GCM" ? T("GCM：IV 12 字节，密文自带 16 字节认证标签") : T(mode + "：IV 16 字节，密文长度是 16 的整数倍");
}

/** 折叠区块的公共绑定：状态记在本机；标题里的按钮/下拉只干活，不顺手把这块收起来。
    key 是 localStorage 的键，secs 里每块用 dataset 里的名字当家（dcsec / btsec）。 */
function bindSections(secs, key, expandId, collapseId) {
  if (!secs.length) return;
  const name = (s) => s.dataset.dcsec || s.dataset.btsec || "";
  let open = [];
  try { open = JSON.parse(localStorage.getItem(key) || "[]") || []; } catch (_) { open = []; }
  // 第一次用（没有记录）就打开第一块，别让整页看着是空的
  const first = !localStorage.getItem(key);
  const list = open.map(String);
  secs.forEach((s, i) => { s.open = first ? i === 0 : list.includes(name(s)); });
  const save = () => { localStorage.setItem(key, JSON.stringify(secs.filter((s) => s.open).map(name))); };
  for (const s of secs) {
    s.addEventListener("toggle", save);
    const sum = s.querySelector("summary");
    if (sum) {
      sum.addEventListener("click", (e) => {
        // 点在按钮/下拉/输入框上：这一下别触发折叠
        if (e.target.closest("button, select, input, textarea, a")) e.preventDefault();
      });
    }
  }
  const all = (v) => { secs.forEach((s) => { s.open = v; }); save(); };
  if ($id(expandId)) $id(expandId).onclick = () => all(true);
  if ($id(collapseId)) $id(collapseId).onclick = () => all(false);
}

const DC_OPEN_KEY = "kdock_dc_open";
const BT_OPEN_KEY = "kdock_bt_open";
/** 数据计算页那 8 块（只认这一页里的，别把批量文本右栏的卡也一起收进去） */
function dcBindSections() {
  const pane = document.querySelector('.workpane[data-work="datacalc"]');
  bindSections(pane ? [...pane.querySelectorAll(".dcsection")] : [], DC_OPEN_KEY, "dc-expand-all", "dc-collapse-all");
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
  // （浮点转换 / 文件校验都搬到「数据计算」页了，绑定见 initDataCalc）

  box.value = "0x1F & 0x0F << 2";
  calcSetBase("dec", true);
  calcRun(box.value, false);
  calcExprLineSet(box.value);
  calcRenderHist();
  calcRenderBaud();
  calcRenderBits();
  onLang(() => {
    vbRenderPresets();
    vbRender();
    calcRenderHist();
    calcRenderBaud();
    calcRenderBits();
    calcRenderRadix(calcValue);
    ieeeRenderLive(calcValue);
    $id("calc-pad-hint").textContent = T("直接按数字和运算符，= 出结果；结果和上面的控制板实时同步。");
  });
}
