import { invoke } from "@tauri-apps/api/core";
import { open as dlgOpen } from "@tauri-apps/plugin-dialog";

const $ = (id) => document.getElementById(id);
const SQ_NS = "http://www.w3.org/2000/svg";
const uiScaleValue = () => (window.kdockUiScale ? window.kdockUiScale() : 1);
const toast = (text) => (window.kdockToast ? window.kdockToast(text) : console.warn(text));
// ---------------- 固件运行结构：调用树 / 中断 / 自动布局 ----------------
// 数据来自随包分发的 pybingraph-native。KDock 只接收分析器 JSON，
// 布局、库函数折叠和交互都在本地完成，不嵌旧页面，也不依赖浏览器 localStorage 分组。
let rtData = null;
let rtFile = null;                 // 当前固件绝对路径
let rtRoot = "";                   // 固件目录（传给分析器）
let rtSel = null;
let rtChainAddr = "";
let rtView = { x: 46, y: 32, k: 1 };
let rtNodes = [];
let rtEdges = [];
let rtCollapsed = new Set();
let rtRunning = false;
let rtDrag = null;
let rtLogNo = 0;
let rtReady = false;
const rtPosCache = new Map();

const RT_LIB_RE = /^(?:__|_(?:exit|start|init|fini)|mem(?:cpy|move|set|cmp|chr)|str(?:cpy|ncpy|cat|ncat|cmp|ncmp|len|chr|rchr|str|tok|dup)|(?:v?sn?printf|printf|puts|putchar|fwrite|fread|fflush|stdio|exit|atexit|abort|raise|malloc|free|realloc|calloc|qsort|bsearch|rand|srand|atoi|atol|strtol|strtoul|abs|labs|div|ldiv|clock|time|getenv|sysconf)(?:$|_))/i;
const RT_HAL_RE = /^(HAL_|LL_|MX_|CMSIS|SystemInit|__libc|__aeabi|arm_|NVIC_|RCC_|GPIO_|USART_|SPI_|I2C_|DMA_|FLASH_|SysTick_)/;

function rtEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function rtLog(text, kind) {
  const box = $("rt-log");
  if (!box) return;
  const line = rtEl("div", "l" + (kind ? " " + kind : ""));
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  box.appendChild(line);
  while (box.children.length > 500) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function rtSetState(text, kind) {
  const e = $("rt-state");
  if (!e) return;
  e.textContent = text;
  e.className = "dot" + (kind ? " " + kind : "");
}
function rtIsLib(name) { return RT_LIB_RE.test(name || "") || RT_HAL_RE.test(name || ""); }
function rtAddrNode(addr) { return rtData && (rtData.nodes || []).find((n) => n.addr === addr); }
function rtShortAddr(a) { return a ? "0x" + String(a).replace(/^0x/i, "") : ""; }

async function rtRefreshAnalyzer() {
  try {
    const s = await invoke("runtime_analyzer_status");
    const el = $("rt-side-analyzer");
    if (el) {
      el.textContent = s.installed ? "便携分析器已就绪" : "未安装（去环境配置准备）";
      el.className = "rtbadge " + (s.installed ? "ok" : "off");
      el.title = s.path || "";
    }
    return s;
  } catch (e) {
    const el = $("rt-side-analyzer");
    if (el) { el.textContent = "检测失败"; el.className = "rtbadge bad"; }
    return null;
  }
}

async function rtPickFile() {
  try {
    const p = await dlgOpen({ multiple: false, directory: false, title: "选择固件", filters: [{ name: "固件", extensions: ["elf", "bin", "axf", "out", "hex"] }] });
    if (!p) return;
    const path = typeof p === "string" ? p : p.path;
    if (!path) return;
    rtFile = path.replace(/\//g, "\\");
    rtRoot = rtFile.replace(/[\\/][^\\/]*$/, "");
    localStorage.setItem("kdock_rt_last_file", rtFile);
    rtSetFileName();
    rtLog("已选择 " + rtFile);
    await rtAnalyze();
  } catch (e) { rtLog("选择固件失败：" + String(e), "err"); }
}
function rtSetFileName() {
  const base = rtFile ? rtFile.replace(/^.*[\\/]/, "") : "";
  if ($("rt-file-name")) $("rt-file-name").textContent = base || "还没有选择固件";
  if ($("rt-side-name")) $("rt-side-name").textContent = base || "未选择固件";
  if ($("rt-side-path")) $("rt-side-path").textContent = rtFile || "选择 ELF 后可按 main 生成运行结构；BIN 需要基址与架构。";
  const isBin = /\.bin$/i.test(base);
  if ($("rt-bin-box")) $("rt-bin-box").open = isBin;
}

function rtStatsText(visible, total, totalCalls) {
  if (rtScope() === "all") {
    const calls = totalCalls == null ? "" : ` · ${totalCalls} 调用边`;
    return `${visible} / ${total} 函数 · 全固件${calls}`;
  }
  if (rtScope() === "chain") {
    const dir = ({ down: "向下", up: "向上", both: "双向" })[rtChainDir()] || "向下";
    return `${visible} 函数 · ${dir}链路 · ${rtChainDepthLabel()}`;
  }
  return `${visible} 函数 · main 运行链`;
}

function rtRelPath() {
  if (!rtFile) return "";
  if (!rtRoot) return rtFile.replace(/^.*[\\/]/, "");
  return rtFile.slice(rtRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

async function rtAnalyze() {
  if (!rtFile) return rtPickFile();
  if (rtRunning) return;
  const status = await rtRefreshAnalyzer();
  if (!status || !status.installed) {
    rtSetState("分析器未安装", "bad");
    rtLog("未找到便携分析器。到「环境配置 → 固件运行结构分析器」点「一键准备」。", "err");
    return;
  }
  rtRunning = true;
  rtSetState("分析中…", "run");
  $("rt-run").disabled = true;
  const t0 = performance.now();
  const rel = rtRelPath();
  rtLog(`开始分析 ${rel || rtFile}（首次启动需要加载 angr，可能要几十秒）…`);
  try {
    const isBin = /\.bin$/i.test(rtFile);
    if (isBin) {
      const base = ($("rt-bin-base").value || "").trim();
      if (!base) throw new Error("BIN 需要填写基址（例如 0x08000000）");
    }
    // 链路模式需要完整调用图；先取全固件数据，再在本地裁出单条链路。
    const requestScope = rtScope() === "chain" ? "all" : rtScope();
    const data = await invoke("runtime_analyze", {
      root: rtRoot, filepath: rel, scope: requestScope,
      blobBase: isBin ? ($("rt-bin-base").value || "").trim() : "",
      blobArch: isBin ? (($("rt-bin-arch") && $("rt-bin-arch").value) || "ARMCortexM") : "",
      blobEntry: isBin ? ($("rt-bin-entry").value || "").trim() : "",
      vectorBase: isBin ? ($("rt-vector-base").value || "").trim() : "",
    });
    rtData = data;
    rtSel = null;
    rtCollapsed.clear();
    rtApplyFilterDefaults();
    rtBuildGraph();
    rtRender();
    rtFocusRoot();
    const root = rtDefaultRootNode();
    if (root) {
      rtSel = root.addr;
      rtRefreshSelection(root);
      rtRender();
      rtRenderEdges();
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const nodes = (rtNodes || []).filter((n) => !n.group).length;
    const irq = (data.interrupts || []).length;
    rtSetState(`就绪 · ${secs}s`, "ok");
    const total = data.totalFunctions || (data.nodes || []).length;
    const mode = rtScope() === "all" ? "全固件" : rtScope() === "chain" ? "调用链路" : "main 运行链";
    rtLog(`分析完成（${mode}）：显示 ${nodes} / ${total} 个函数，${irq} 个中断，用时 ${secs}s`, "ok");
    if (!rtNodes.length) {
      rtBuildGraph();
      rtRender();
      if (!rtNodes.length) throw new Error("分析已返回，但没有可显示的函数节点");
    }
  } catch (e) {
    rtData = null;
    rtNodes = []; rtEdges = [];
    rtRender();
    rtSetState("分析失败", "bad");
    rtLog("分析失败：" + String(e), "err");
    toast("运行结构分析失败：" + String(e));
  } finally {
    rtRunning = false;
    if ($("rt-run")) $("rt-run").disabled = false;
  }
}

function rtScope() {
  const el = $("rt-scope");
  return (el && el.value) || "all";
}
function rtChainDir() {
  return ($("rt-chain-dir") && $("rt-chain-dir").value) || "down";
}
function rtChainDepth() {
  const raw = Number(($("rt-chain-depth") && $("rt-chain-depth").value) || "3");
  return Number.isFinite(raw) ? raw : 3;
}
function rtChainDepthLabel() {
  const d = rtChainDepth();
  return d < 0 ? "全部深度" : `${d} 层`;
}
function rtHasFullData() {
  return !!(rtData && (rtData.totalFunctions || rtData.entryName === "FULL FIRMWARE"));
}
function rtChainRoot() {
  if (!rtData) return "";
  const has = (addr) => !!addr && (rtData.nodes || []).some((n) => n.addr === addr);
  if (has(rtChainAddr)) return rtChainAddr;
  if (has(rtSel) && rtSel !== "__kdock_lib__") return rtSel;
  if (has(rtData.entry)) return rtData.entry;
  const main = (rtData.nodes || []).find((n) => n.name === "main");
  return main ? main.addr : ((rtData.nodes || [])[0] || {}).addr || "";
}
function rtDefaultRootNode() {
  if (!rtNodes.length) return null;
  const chain = rtScope() === "chain";
  const wanted = chain ? rtChainRoot() : rtData && rtData.entry;
  return rtNodes.find((n) => n.addr === wanted) || rtNodes.find((n) => n.name === "main") || rtNodes[0];
}
function rtChainRootLabel() {
  const node = rtData && rtAddrNode(rtChainRoot());
  return node ? `${node.name} · 0x${node.addr}` : "未选择";
}
function rtSyncScope() {
  const main = rtScope() === "runtime";
  const chain = rtScope() === "chain";
  if ($("rt-main-only")) {
    $("rt-main-only").checked = main;
    $("rt-main-only").disabled = !main;
  }
  if ($("rt-show-interrupts")) $("rt-show-interrupts").disabled = !main;
  if ($("rt-scope-side")) $("rt-scope-side").value = rtScope();
  if ($("rt-chain-tools")) $("rt-chain-tools").hidden = !chain;
  if ($("rt-chain-root-side")) $("rt-chain-root-side").textContent = chain ? rtChainRootLabel() : "main";
  if ($("rt-color-scope")) $("rt-color-scope").disabled = chain;
}

function rtApplyFilterDefaults() {
  if ($("rt-hide-lib")) $("rt-hide-lib").checked = true;
  if ($("rt-lib-mode")) $("rt-lib-mode").value = "collapse";
  if ($("rt-show-interrupts")) $("rt-show-interrupts").checked = false;
  rtSyncScope();
}

/** 从分析器 JSON 生成 KDock 自己的可见图。
 *  all=全固件；runtime=main/中断；chain=以选中函数为根、按方向与深度裁剪。 */
function rtBuildGraph() {
  rtNodes = []; rtEdges = [];
  if (!rtData) return;
  const byAddr = new Map((rtData.nodes || []).map((n) => [n.addr, n]));
  const mainOnly = !!($("rt-main-only") && $("rt-main-only").checked);
  const showIrq = !!($("rt-show-interrupts") && $("rt-show-interrupts").checked);
  const libMode = ($("rt-lib-mode") && $("rt-lib-mode").value) || "collapse";
  const libOn = !!($("rt-hide-lib") && $("rt-hide-lib").checked);
  const mainSet = new Set(rtData.mainReachable || []);
  const irqSet = new Set(rtData.interruptReachable || []);
  const mode = rtScope();
  const allScope = mode === "all";
  const chainScope = mode === "chain";
  const include = new Set();
  const scopeOf = new Map();
  const add = (addr, scope) => {
    const n = byAddr.get(addr);
    if (!n) return false;
    if (libOn && libMode === "hide" && addr !== rtData.entry && rtIsLib(n.name)) return false;
    include.add(addr);
    if (scope) scopeOf.set(addr, scope);
    return true;
  };
  const callTargets = new Map();
  const callers = new Map();
  for (const n of rtData.nodes || []) {
    const outs = (n.calls || []).map((c) => c.addr).filter((a) => byAddr.has(a));
    callTargets.set(n.addr, outs);
    for (const a of outs) {
      if (!callers.has(a)) callers.set(a, []);
      callers.get(a).push(n.addr);
    }
  }
  const walkDown = (start, scope, allow, depthLimit) => {
    if (!start || !byAddr.has(start)) return;
    const queue = [[start, 0]];
    const seen = new Set([start]);
    add(start, scope);
    while (queue.length) {
      const [addr, depth] = queue.shift();
      if (depthLimit >= 0 && depth >= depthLimit) continue;
      for (const next of callTargets.get(addr) || []) {
        if (allow && !allow(next)) continue;
        if (!add(next, scope)) continue;
        if (!seen.has(next)) { seen.add(next); queue.push([next, depth + 1]); }
      }
    }
  };
  const walkUp = (start, scope, allow, depthLimit) => {
    if (!start || !byAddr.has(start)) return;
    const queue = [[start, 0]];
    const seen = new Set([start]);
    add(start, scope);
    while (queue.length) {
      const [addr, depth] = queue.shift();
      if (depthLimit >= 0 && depth >= depthLimit) continue;
      for (const prev of callers.get(addr) || []) {
        if (allow && !allow(prev)) continue;
        if (!add(prev, scope)) continue;
        if (!seen.has(prev)) { seen.add(prev); queue.push([prev, depth + 1]); }
      }
    }
  };
  if (chainScope) {
    const root = rtChainRoot();
    const dir = rtChainDir();
    const depth = rtChainDepth();
    const scope = "chain";
    rtChainAddr = root;
    if (dir === "up") walkUp(root, scope, null, depth);
    else if (dir === "both") {
      walkDown(root, scope, null, depth);
      walkUp(root, scope, null, depth);
    } else walkDown(root, scope, null, depth);
  } else if (allScope) {
    // 全固件模式没有“入口可达”这一层语义，所有节点都是普通函数。
    // 不能拿 mainReachable=false 推断成中断，否则整张图都会被误染成橙色。
    for (const n of rtData.nodes || []) add(n.addr, "function");
  } else {
    // ELF 从 main 开始；BIN 没有符号时分析器会返回一个明确的根函数。
    walkDown(rtData.entry, "main", (addr) => !mainOnly || mainSet.has(addr), -1);
    if (showIrq) for (const irq of rtData.interrupts || []) {
      walkDown(irq.addr, "irq", (addr) => irqSet.has(addr), -1);
    }
  }
  // 折叠模式用一个汇总节点表示所有库函数，而不是悄悄删掉它们。
  const libAddresses = [];
  const visible = new Set();
  for (const addr of include) {
    const n = byAddr.get(addr);
    if (!n) continue;
    if (libOn && libMode === "collapse" && addr !== rtData.entry && rtIsLib(n.name)) {
      libAddresses.push(addr);
      continue;
    }
    visible.add(addr);
  }
  for (const addr of include) {
    if (!visible.has(addr)) continue;
    const n = byAddr.get(addr);
    const pos = rtPosCache.get(addr) || { x: 0, y: 0 };
    const fallbackScope = allScope ? "function" : chainScope ? "chain" : irqSet.has(addr) && !mainSet.has(addr) ? "irq" : "main";
    rtNodes.push({ ...n, x: pos.x, y: pos.y, scope: scopeOf.get(addr) || fallbackScope });
  }
  const libGroup = "__kdock_lib__";
  if (libAddresses.length) {
    const scopeCount = { main: 0, irq: 0 };
    for (const addr of libAddresses) {
      const s = scopeOf.get(addr) || (allScope ? "function" : chainScope ? "chain" : irqSet.has(addr) && !mainSet.has(addr) ? "irq" : "main");
      if (s === "main" || s === "irq") scopeCount[s] += 1;
    }
    rtNodes.push({
      addr: libGroup, name: "库函数", group: true, x: 0, y: 0,
      scope: allScope || chainScope ? "function" : libAddresses.some((addr) => !mainSet.has(addr) && irqSet.has(addr)) ? "irq" : "main",
      libAddrs: libAddresses,
      size: libAddresses.reduce((sum, addr) => sum + ((byAddr.get(addr) || {}).size || 0), 0),
      blocks: libAddresses.reduce((sum, addr) => sum + ((byAddr.get(addr) || {}).blocks || 0), 0),
      calls: [], libCount: libAddresses.length,
      scopeCount,
    });
  }
  const targetOf = (addr) => (visible.has(addr) ? addr : libAddresses.includes(addr) ? libGroup : null);
  const edgeMap = new Map();
  for (const src of include) {
    const n = byAddr.get(src);
    for (const c of (n && n.calls) || []) {
      const from = targetOf(src), to = targetOf(c.addr);
      if (!from || !to || !byAddr.has(c.addr) || (!visible.has(src) && from !== libGroup)) continue;
      if (from === libGroup && to === libGroup) continue;
      // 同一对函数可能被调用很多次；画布上合成一条线，详情里仍保留全部调用点。
      const key = from + ">" + to;
      const edge = edgeMap.get(key);
      if (edge) edge.count += 1;
      else edgeMap.set(key, { from, to, site: c.site, order: c.order || 0, mnemonic: c.mnemonic || "", count: 1 });
    }
  }
  rtEdges = [...edgeMap.values()];
  rtLayout(true);
  rtNodes.forEach((n) => rtPosCache.set(n.addr, { x: n.x, y: n.y }));
}

function rtLayout(fresh) {
  if (!rtNodes.length) return;
  const layered = ($("rt-layout") && $("rt-layout").value) !== "compact";
  const by = new Map(rtNodes.map((n) => [n.addr, n]));
  const depth = new Map();
  const chainMode = rtScope() === "chain";
  const chainRoot = chainMode ? rtChainRoot() : "";
  let roots = rtNodes.filter((n) => !rtEdges.some((e) => e.to === n.addr));
  if (chainMode && by.has(chainRoot)) roots = [by.get(chainRoot)];
  const queue = roots.length ? roots : [rtNodes[0]];
  for (const n of queue) depth.set(n.addr, 0);
  const seen = new Set(queue.map((n) => n.addr));
  while (queue.length) {
    const n = queue.shift();
    for (const e of rtEdges.filter((x) => x.from === n.addr)) {
      const d = (depth.get(n.addr) || 0) + 1;
      if (!depth.has(e.to) || d < depth.get(e.to)) depth.set(e.to, d);
      if (by.has(e.to) && !seen.has(e.to)) { seen.add(e.to); queue.push(by.get(e.to)); }
    }
  }
  // Upstream callers must sit to the left of the chain root. Walk reverse
  // edges for the "up" / "both" chain modes instead of flattening them to row 0.
  if (chainMode && by.has(chainRoot)) {
    const upQueue = [chainRoot];
    const upSeen = new Set(upQueue);
    depth.set(chainRoot, 0);
    while (upQueue.length) {
      const addr = upQueue.shift();
      for (const e of rtEdges.filter((x) => x.to === addr)) {
        const d = depth.get(addr) - 1;
        if (!depth.has(e.from) || d < depth.get(e.from)) depth.set(e.from, d);
        if (!upSeen.has(e.from)) { upSeen.add(e.from); upQueue.push(e.from); }
      }
    }
  }
  for (const n of rtNodes) if (!depth.has(n.addr)) depth.set(n.addr, 0);
  if (!fresh) {
    for (const n of rtNodes) n.depth = depth.get(n.addr) || 0;
    return;
  }
  if (layered && rtNodes.length > 320) {
    // 全固件视图可能有数百个函数；先按稳定网格排开，保证首屏可读。
    const cols = Math.max(8, Math.ceil(Math.sqrt(rtNodes.length * 1.6)));
    const minDepth = Math.min(0, ...depth.values());
    rtNodes.forEach((n, i) => {
      n.depth = (depth.get(n.addr) || 0) - minDepth;
      n.x = 54 + (i % cols) * 224;
      n.y = 48 + Math.floor(i / cols) * 116;
    });
  } else if (layered) {
    // 与中控编排一致：调用层级从左到右，同层纵向排开。
    const minDepth = Math.min(0, ...depth.values());
    const cols = new Map();
    for (const n of rtNodes) {
      const d = (depth.get(n.addr) || 0) - minDepth;
      depth.set(n.addr, d);
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    let maxRows = 1;
    for (const list of cols.values()) maxRows = Math.max(maxRows, list.length);
    for (const [d, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => String(a.scope).localeCompare(String(b.scope)) || a.name.localeCompare(b.name));
      const rowGap = 104, total = (list.length - 1) * rowGap;
      const focus = (maxRows - 1) * rowGap / 2;
      list.forEach((n, i) => {
        n.depth = d;
        n.x = 54 + d * 244;
        n.y = Math.round(48 + focus - total / 2 + i * rowGap);
      });
    }
  } else {
    const cols = Math.max(1, Math.ceil(Math.sqrt(rtNodes.length)));
    rtNodes.forEach((n, i) => {
      n.depth = depth.get(n.addr) || 0;
      n.x = 54 + (i % cols) * 224;
      n.y = 48 + Math.floor(i / cols) * 116;
    });
  }
}

function rtRender() {
  const wrap = $("rt-nodes");
  if (!wrap) return;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const empty = $("rt-empty");
  if (empty) empty.hidden = !!rtNodes.length;
  for (const n of rtNodes) wrap.appendChild(rtNodeEl(n));
  rtRenderEdges();
  rtApplyView();
  const count = rtNodes.filter((n) => !n.group).length, edges = rtEdges.length;
  if ($("rt-stat")) $("rt-stat").textContent = rtStatsText(count, (rtData && rtData.totalFunctions) || (rtData && rtData.nodes ? rtData.nodes.length : count), rtData && rtData.totalCalls) + ` · ${edges} 条可见线`;
}

function rtRenderEdges() {
  const edgeG = $("rt-edges-g");
  if (!edgeG) return;
  while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);
  const by = new Map(rtNodes.map((n) => [n.addr, n]));
  let defs = edgeG.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SQ_NS, "defs");
    const marker = document.createElementNS(SQ_NS, "marker");
    marker.setAttribute("id", "rt-arrow");
    marker.setAttribute("viewBox", "0 0 8 8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(SQ_NS, "path");
    head.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
    head.setAttribute("class", "rtarrowhead");
    marker.appendChild(head);
    defs.appendChild(marker);
    edgeG.appendChild(defs);
  }
  const chainMode = rtScope() === "chain";
  const mode = ($("rt-edge-mode") && $("rt-edge-mode").value) || "selected";
  const focus = rtSel || (chainMode ? rtChainRoot() : "");
  for (const e of rtEdges) {
    const a = by.get(e.from), b = by.get(e.to);
    if (!a || !b) continue;
    const incident = !!(focus && (e.from === focus || e.to === focus));
    // A chain is already a focused subgraph; drawing only root-incident edges
    // would hide its internal dependencies. Draw every edge inside the chain.
    if (!chainMode && (mode === "none" || (mode === "selected" && !incident))) continue;
    const ax = a.x + 188, ay = a.y + 38, bx = b.x, byy = b.y + 38;
    const bend = Math.max(36, Math.abs(bx - ax) * 0.46);
    const d = `M ${ax} ${ay} C ${ax + bend} ${ay}, ${bx - bend} ${byy}, ${bx} ${byy}`;
    const p = document.createElementNS(SQ_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("marker-end", "url(#rt-arrow)");
    p.dataset.src = a.name;
    p.dataset.dst = b.name;
    if (e.count > 1) p.dataset.count = String(e.count);
    p.setAttribute("class", "seqedge rtlink" + (rtIsLib(a.name) || rtIsLib(b.name) || a.group || b.group ? " lib" : "") + (incident ? " focus" : ""));
    const tip = document.createElementNS(SQ_NS, "title");
    tip.textContent = `${a.name} → ${b.name}${e.count > 1 ? ` ×${e.count}` : ""}`;
    p.appendChild(tip);
    edgeG.appendChild(p);
  }
}

function rtNodeEl(n) {
  const el = rtEl("div", "seqnode rtfn" + (n.scope === "irq" ? " irq" : "") + (n.group ? " libgroup" : "") + (n.scope === "chain" ? " chainfn" : "") + (n.addr === rtChainRoot() && rtScope() === "chain" ? " chainroot" : "") + (rtSel === n.addr ? " sel" : ""));
  el.dataset.addr = n.addr;
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  const hd = rtEl("div", "nhd");
  hd.appendChild(rtEl("span", "nkind", n.group ? "LIB" : n.scope === "irq" ? "IRQ" : n.scope === "chain" ? "LINK" : "FUNC"));
  hd.appendChild(rtEl("span", "rtfn-name", n.name));
  el.appendChild(hd);
  const bd = rtEl("div", "nbd");
  if (n.group) {
    bd.appendChild(rtEl("div", "rtmeta", `${n.libCount} 个库函数 · ${n.blocks || 0} 块`));
    if (rtScope() === "all") bd.appendChild(rtEl("div", "rtmeta", "全固件库函数 · 自动汇总"));
    else if (rtScope() === "chain") bd.appendChild(rtEl("div", "rtmeta", "当前链路内的库函数 · 自动汇总"));
    else if (n.scopeCount) bd.appendChild(rtEl("div", "rtmeta", `运行链 ${n.scopeCount.main} · 中断 ${n.scopeCount.irq}`));
    bd.appendChild(rtEl("div", "rtmeta", "展开「库过滤 → 全部显示」查看明细"));
  } else {
    if ($("rt-show-addr") && $("rt-show-addr").checked) bd.appendChild(rtEl("div", "rtaddr", "0x" + n.addr));
    const childCount = rtEdges.filter((e) => e.from === n.addr).length;
    bd.appendChild(rtEl("div", "rtmeta", `${n.calls ? n.calls.length : 0} 调用 · ${n.blocks || 0} 块` + (childCount ? ` · 展开 ${childCount}` : "")));
  }
  el.appendChild(bd);
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    rtSel = n.addr;
    rtRefreshSelection(n);
    for (const old of document.querySelectorAll(".rtfn.sel")) old.classList.remove("sel");
    el.classList.add("sel");
    const w = rtScreenToWorld(e.clientX, e.clientY);
    rtDrag = { id: n.addr, dx: w.x - n.x, dy: w.y - n.y };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("click", () => {
    rtRefreshSelection(n);
    if (rtScope() === "chain" && !n.group) rtChainAddr = n.addr;
    rtSyncScope();
  });
  return el;
}

function rtApplyView() {
  const nodes = $("rt-nodes"), edges = $("rt-edges-g");
  if (!nodes || !edges) return;
  nodes.style.transform = `translate(${rtView.x}px, ${rtView.y}px) scale(${rtView.k})`;
  edges.setAttribute("transform", `translate(${rtView.x} ${rtView.y}) scale(${rtView.k})`);
}
function rtScreenToWorld(clientX, clientY) {
  const cv = $("rt-canvas"), r = cv.getBoundingClientRect(), ui = uiScaleValue();
  return { x: ((clientX - r.left) / ui - rtView.x) / rtView.k, y: ((clientY - r.top) / ui - rtView.y) / rtView.k };
}
function rtFit() {
  if (!rtNodes.length || !$("rt-canvas")) return;
  const x0 = Math.min(...rtNodes.map((n) => n.x)), x1 = Math.max(...rtNodes.map((n) => n.x)) + 210;
  const y0 = Math.min(...rtNodes.map((n) => n.y)), y1 = Math.max(...rtNodes.map((n) => n.y)) + 100;
  const cv = $("rt-canvas");
  rtView.k = Math.min(1.25, Math.max(0.12, Math.min(cv.clientWidth / (x1 - x0 + 100), cv.clientHeight / (y1 - y0 + 100))));
  rtView.x = 32 - x0 * rtView.k;
  rtView.y = 24 - y0 * rtView.k;
  rtApplyView();
}

function rtFocusRoot() {
  if (!rtNodes.length) return;
  const chain = rtScope() === "chain";
  const entry = rtScope() === "runtime" ? rtData && rtData.entry : chain ? rtChainRoot() : "";
  const root = rtNodes.find((n) => (entry && n.addr === entry) || (!chain && rtScope() === "all" && n.name === "main")) || rtNodes[0];
  const cv = $("rt-canvas");
  if (!cv) return;
  rtView.k = Math.min(0.86, Math.max(0.62, cv.clientWidth / 1180));
  rtView.x = cv.clientWidth / 2 - (root.x + 94) * rtView.k;
  rtView.y = cv.clientHeight / 2 - (root.y + 38) * rtView.k;
  rtApplyView();
}

function rtRefreshSelection(n) {
  const box = $("rt-fn-card");
  if (!box) return;
  box.textContent = "";
  if (!n) { box.appendChild(rtEl("p", "hint", "在中间点一个函数，这里显示地址、大小和调用点。")); return; }
  if (n.group) {
    box.appendChild(rtEl("div", "cardtitle", `库函数汇总 · ${n.libCount} 个`));
    box.appendChild(rtEl("div", "rtdet-row", `合计 ${n.size || 0} B · ${n.blocks || 0} 个基本块`));
    const list = rtEl("div", "rtcalls");
    for (const addr of (n.libAddrs || []).slice(0, 80)) {
      const item = rtAddrNode(addr);
      if (!item) continue;
      const row = rtEl("button", "rtcall");
      row.appendChild(rtEl("span", "rtcall-a", "0x" + item.addr));
      row.appendChild(rtEl("span", "rtcall-n", item.name));
      row.onclick = () => {
        const mode = $("rt-lib-mode"), hide = $("rt-hide-lib");
        if (mode) mode.value = "show";
        if (hide) hide.checked = false;
        rtBuildGraph(); rtRender();
        rtCenter(item.addr);
      };
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(rtEl("p", "hint", "已折叠 HAL / CMSIS / newlib 调用。点列表里的函数或切换「全部显示」可展开明细。"));
    return;
  }
  const top = rtEl("div", "rtdet-head");
  top.appendChild(rtEl("b", "rtdet-name", n.name));
  const scopeBadge = n.scope === "irq" ? ["warn", "中断"] : n.scope === "function" ? ["fn", "函数"] : n.scope === "chain" ? ["chain", "链路"] : ["ok", "main"];
  top.appendChild(rtEl("span", "rtbadge " + scopeBadge[0], scopeBadge[1]));
  box.appendChild(top);
  box.appendChild(rtEl("div", "rtdet-row", "地址 0x" + n.addr));
  box.appendChild(rtEl("div", "rtdet-row", `大小 ${n.size || 0} B · ${n.blocks || 0} 个基本块`));
  if (n.calls && n.calls.length) {
    box.appendChild(rtEl("div", "cardtitle", "调用点"));
    const list = rtEl("div", "rtcalls");
    for (const c of n.calls.slice(0, 24)) {
      const r = rtEl("button", "rtcall");
      r.appendChild(rtEl("span", "rtcall-a", "0x" + c.site));
      r.appendChild(rtEl("span", "rtcall-n", c.name));
      r.onclick = () => rtCenter(c.addr);
      list.appendChild(r);
    }
    box.appendChild(list);
  }
  const btns = rtEl("div", "btnrow");
  const b = rtEl("button", "btn small", "定位画布");
  b.onclick = () => rtCenter(n.addr);
  btns.appendChild(b);
  const cfg = rtEl("button", "btn small", "展开 CFG");
  cfg.onclick = () => rtShowCfg(n);
  btns.appendChild(cfg);
  const chain = rtEl("button", "btn small primary", "拉这条链路");
  chain.onclick = () => rtUseAsChain(n.addr);
  btns.appendChild(chain);
  box.appendChild(btns);
}
function rtUseAsChain(addr) {
  if (!rtData || !byAddrHas(addr)) return toast("先分析固件，再选择链路根函数");
  rtChainAddr = addr;
  if ($("rt-scope")) $("rt-scope").value = "chain";
  if ($("rt-scope-side")) $("rt-scope-side").value = "chain";
  rtSyncScope();
  const node = rtAddrNode(addr);
  rtLog(`链路分析：以 ${node ? node.name : addr} 为根，${({ down: "向下", up: "向上", both: "双向" })[rtChainDir()] || "向下"} ${rtChainDepthLabel()}`, "ok");
  // The runtime endpoint only contains main/interrupt reachable functions.
  // Chain mode is a slice of the full-firmware graph, so fetch it when needed.
  if (!rtHasFullData()) return rtAnalyze();
  rtBuildGraph();
  rtSel = addr;
  rtRender();
  rtRefreshSelection(rtNodes.find((n) => n.addr === addr) || rtAddrNode(addr));
  rtFocusRoot();
  rtRenderEdges();
}
function byAddrHas(addr) {
  return !!(rtData && addr && (rtData.nodes || []).some((n) => n.addr === addr));
}
function rtCenter(addr) {
  const n = rtNodes.find((x) => x.addr === addr);
  if (!n || !$("rt-canvas")) return;
  const cv = $("rt-canvas");
  rtView.x = cv.clientWidth / 2 - (n.x + 94) * rtView.k;
  rtView.y = cv.clientHeight / 2 - (n.y + 38) * rtView.k;
  rtSel = addr;
  rtRefreshSelection(rtAddrNode(addr) || n);
  rtRender();
  rtApplyView();
}
function rtShowCfg(n) {
  if (n.group) return toast("库函数已折叠；切换为「全部显示」后再展开单个 CFG");
  const detail = rtAddrNode(n.addr);
  if (!detail || !detail.block_nodes) return toast("这个函数没有 CFG 数据（BIN 无符号时常见）");
  rtSel = n.addr;
  rtCollapsed.clear();
  const blocks = detail.block_nodes || [];
  for (const b of blocks) {
    const key = n.addr + "@" + b.addr;
    rtCollapsed.delete(key);
  }
  rtLog(`展开 ${n.name} 的 ${blocks.length} 个基本块`);
  rtRenderCfgBlocks(detail);
}
function rtRenderCfgBlocks(n) {
  const box = $("rt-fn-card");
  if (!box) return;
  box.textContent = "";
  box.appendChild(rtEl("div", "cardtitle", `${n.name} · CFG`));
  for (const b of (n.block_nodes || []).slice(0, 40)) {
    const r = rtEl("div", "rtblock");
    r.appendChild(rtEl("b", "rtblock-a", "0x" + b.addr));
    r.appendChild(rtEl("span", "rtblock-i", String(b.first_insn || "")));
    r.appendChild(rtEl("span", "rtblock-m", `${b.instructions} 条`));
    box.appendChild(r);
  }
}

function rtBindCanvas() {
  const cv = $("rt-canvas");
  if (!cv || cv.dataset.bound) return;
  cv.dataset.bound = "1";
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), ui = uiScaleValue();
    const mx = (e.clientX - r.left) / ui, my = (e.clientY - r.top) / ui;
    const k0 = rtView.k, k = Math.min(1.8, Math.max(0.25, k0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    rtView.x = mx - (mx - rtView.x) * (k / k0);
    rtView.y = my - (my - rtView.y) * (k / k0);
    rtView.k = k;
    rtApplyView();
  }, { passive: false });
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(".seqnode")) return;
    const w = rtScreenToWorld(e.clientX, e.clientY);
    rtDrag = { pan: true, x: e.clientX, y: e.clientY, vx: rtView.x, vy: rtView.y };
    cv.classList.add("panning");
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!rtDrag) return;
    if (rtDrag.pan) {
      const ui = uiScaleValue();
      rtView.x = rtDrag.vx + (e.clientX - rtDrag.x) / ui;
      rtView.y = rtDrag.vy + (e.clientY - rtDrag.y) / ui;
      rtApplyView();
    } else {
      const n = rtNodes.find((x) => x.addr === rtDrag.id);
      if (!n) return;
      const w = rtScreenToWorld(e.clientX, e.clientY);
      n.x = Math.round(w.x - rtDrag.dx); n.y = Math.round(w.y - rtDrag.dy);
      const el = document.querySelector(`.rtfn[data-addr="${n.addr}"]`);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      rtPosCache.set(n.addr, { x: n.x, y: n.y });
      rtRenderEdges();
    }
  });
  const end = () => {
    if (rtDrag && !rtDrag.pan) rtRenderEdges();
    rtDrag = null;
    cv.classList.remove("panning");
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", (e) => {
    if (!e.target.closest || !e.target.closest(".seqnode")) rtFit();
  });
}

async function rtFind() {
  if (!rtData) return toast("先分析一个固件");
  const q = prompt("查找函数名或地址（支持部分匹配）", "");
  if (!q || !q.trim()) return;
  const s = q.trim().toLowerCase(), hex = s.replace(/^0x/, "");
  const hit = rtNodes.find((n) => n.name.toLowerCase().includes(s) || n.addr.toLowerCase().includes(hex));
  if (!hit) return toast("没有找到： " + q);
  rtCenter(hit.addr);
}

async function rtInit() {
  if (rtReady) { rtRefreshAnalyzer(); return; }
  rtReady = true;
  const last = localStorage.getItem("kdock_rt_last_file") || "";
  if (last) { rtFile = last; rtRoot = last.replace(/[\\/][^\\/]*$/, ""); rtSetFileName(); }
  const st = await rtRefreshAnalyzer();
  if (st && st.installed) rtLog("便携分析器就绪：" + st.version);
  else rtLog("未找到便携分析器：去环境配置 → 固件运行结构分析器 准备。", "err");
  const pick = $("rt-file"), pick2 = $("rt-empty-pick"), pick3 = $("rt-pick-side"), run = $("rt-run");
  for (const b of [pick, pick2, pick3]) if (b) b.onclick = rtPickFile;
  if (run) run.onclick = rtAnalyze;
  if ($("rt-tidy")) $("rt-tidy").onclick = () => { rtLayout(true); rtNodes.forEach((n) => rtPosCache.set(n.addr, { x: n.x, y: n.y })); rtRender(); rtFocusRoot(); };
  if ($("rt-fit")) $("rt-fit").onclick = rtFit;
  if ($("rt-search-btn")) $("rt-search-btn").onclick = rtFind;
  if ($("rt-expand")) $("rt-expand").onclick = () => {
    if (!rtData) return;
    rtCollapsed.clear(); rtBuildGraph(); rtRender(); rtFit();
  };
  if ($("rt-collapse")) $("rt-collapse").onclick = () => toast("叶子节点会在下次整理时收起");
  const useChain = () => {
    const root = (rtSel && !String(rtSel).startsWith("__")) ? rtSel : rtChainRoot();
    if (!root) return toast("先分析固件并选择一个函数");
    rtUseAsChain(root);
  };
  if ($("rt-chain-pick")) $("rt-chain-pick").onclick = useChain;
  if ($("rt-chain-pick-side")) $("rt-chain-pick-side").onclick = useChain;
  for (const id of ["rt-chain-dir", "rt-chain-depth"]) {
    const el = $(id); if (el) el.onchange = () => {
      if (rtScope() === "chain") {
        rtBuildGraph(); rtRender(); rtFocusRoot(); rtSyncScope();
      }
    };
  }
  if ($("rt-bin-arch")) $("rt-bin-arch").onchange = rtSetFileName;
  if ($("rt-log-clear")) $("rt-log-clear").onclick = () => { $("rt-log").textContent = ""; rtLogNo = 0; };
  for (const id of ["rt-hide-lib", "rt-show-interrupts", "rt-main-only", "rt-show-addr", "rt-layout", "rt-lib-mode", "rt-edge-mode"]) {
    const el = $(id); if (el) el.onchange = () => {
      if ($("rt-scope-side")) $("rt-scope-side").value = rtScope();
      if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
    };
  }
  for (const id of ["rt-scope", "rt-scope-side"]) {
    const el = $(id);
    if (el) el.onchange = () => {
      const value = el.value;
      if ($("rt-scope")) $("rt-scope").value = value;
      if ($("rt-scope-side")) $("rt-scope-side").value = value;
      rtSyncScope();
      // Chain mode reuses the full-firmware payload already in memory.
      if (value === "chain" && rtHasFullData()) {
        rtBuildGraph(); rtSel = rtChainRoot(); rtRender(); rtRefreshSelection(rtAddrNode(rtSel)); rtFocusRoot();
        return;
      }
      if (rtFile) rtAnalyze();
    };
  }
  rtSyncScope();
  rtBindCanvas();
  rtRender();
}


window.rtInit = rtInit;
window.rtAnalyze = rtAnalyze;
window.rtUseAsChain = rtUseAsChain;
