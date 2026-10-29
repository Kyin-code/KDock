import { invoke } from "@tauri-apps/api/core";
import { open as dlgOpen } from "@tauri-apps/plugin-dialog";

const $ = (id) => document.getElementById(id);
const SQ_NS = "http://www.w3.org/2000/svg";
const uiScaleValue = () => (window.kdockUiScale ? window.kdockUiScale() : 1);
const toast = (text) => (window.kdockToast ? window.kdockToast(text) : console.warn(text));
const rtZh = (zh, en) => document.documentElement.dataset.lang === "en" ? en : zh;
// ---------------- 固件运行结构：调用树 / 中断 / 自动布局 ----------------
// 数据来自随包分发的 pybingraph-native。KDock 只接收分析器 JSON，
// 布局、库函数折叠和交互都在本地完成，不嵌旧页面，也不依赖浏览器 localStorage 分组。
let rtData = null;
let rtFile = null;                 // 当前固件绝对路径
let rtRoot = "";                   // 固件目录（传给分析器）
let rtSel = null;
let rtChainAddr = "";
let rtChainAddrs = [];
let rtSelection = new Set();
let rtView = { x: 46, y: 32, k: 1 };
let rtNodes = [];
let rtEdges = [];
let rtCollapsed = new Set();
let rtSkeletonOpen = new Set();
let rtSkeletonClosed = new Set();
let rtRunning = false;
let rtDrag = null;
let rtLogNo = 0;
let rtReady = false;
let rtLastReadySecs = "";
let rtCacheKeyValue = "";
let rtDataCache = { all: null, runtime: null };
let rtGroups = [];
let rtGroupEditId = null;
let rtSearchHits = [];
let rtSearchIndex = -1;
let rtFocusSets = { up: new Set(), down: new Set() };
const rtPosCache = new Map();

const RT_LIB_RE = /^(?:__|_(?:exit|start|init|fini)|mem(?:cpy|move|set|cmp|chr)|str(?:cpy|ncpy|cat|ncat|cmp|ncmp|len|chr|rchr|str|tok|dup)|(?:v?sn?printf|printf|puts|putchar|fwrite|fread|fflush|stdio|exit|atexit|abort|raise|malloc|free|realloc|calloc|qsort|bsearch|rand|srand|atoi|atol|strtol|strtoul|abs|labs|div|ldiv|clock|time|getenv|sysconf)(?:$|_))/i;
const RT_HAL_RE = /^(HAL_|LL_|MX_|CMSIS|SystemInit|__libc|__aeabi|arm_|NVIC_|RCC_|GPIO_|USART_|SPI_|I2C_|DMA_|FLASH_|SysTick_)/;
const RT_GROUP_KEY = "kdock_rt_groups_v1";

function rtDefaultGroups() {
  return [
    {
      id: "chip-hal", name: rtZh("STM32 HAL / CMSIS", "STM32 HAL / CMSIS"),
      mode: "regex", pattern: "^(HAL_|__NVIC_|NVIC_|DMA_|RCC|SPI_|TIM_|UART_|QSPI_|GPIO_)",
      enabled: true, builtin: true,
    },
    {
      id: "c-runtime", name: rtZh("C 库 / newlib / 运行时", "C library / newlib / runtime"),
      mode: "regex", pattern: "^(__|_|mem|str|snprintf$|vsnprintf$|abort$|raise$|std$|global_stdio|sysconf$|malloc|free|realloc)",
      enabled: true, builtin: true,
    },
  ];
}

function rtLoadGroups() {
  const defaults = rtDefaultGroups();
  try {
    const parsed = JSON.parse(localStorage.getItem(RT_GROUP_KEY) || "[]");
    if (!Array.isArray(parsed)) return defaults;
    const saved = new Map(parsed.filter((g) => g && g.id && g.name && g.pattern).map((g) => [g.id, g]));
    for (const base of defaults) {
      const old = saved.get(base.id);
      if (old) Object.assign(base, {
        name: String(old.name || base.name),
        mode: String(old.mode || base.mode),
        pattern: String(old.pattern || base.pattern),
        enabled: old.enabled !== false,
      });
    }
    const custom = parsed
      .filter((g) => g && g.id && !defaults.some((d) => d.id === g.id))
      .map((g) => ({
        id: String(g.id), name: String(g.name), mode: String(g.mode || "prefix"),
        pattern: String(g.pattern), enabled: g.enabled !== false, builtin: false,
      }));
    return [...defaults, ...custom];
  } catch (_) {
    return defaults;
  }
}

function rtSaveGroups() {
  try {
    localStorage.setItem(RT_GROUP_KEY, JSON.stringify(rtGroups.map((g) => ({
      id: g.id, name: g.name, mode: g.mode, pattern: g.pattern,
      enabled: g.enabled !== false, builtin: !!g.builtin,
    }))));
  } catch (_) {}
}

function rtMatchesGroup(node, group) {
  if (!node || !group || !group.pattern) return false;
  const name = String(node.name || "");
  try {
    if (group.mode === "prefix") return name.startsWith(group.pattern);
    if (group.mode === "contains") return name.includes(group.pattern);
    if (group.mode === "regex") return new RegExp(group.pattern).test(name);
    if (group.mode === "manual") {
      const names = group.pattern.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return names.includes(name.toLowerCase());
    }
    if (group.mode === "addr") {
      const [from, to] = group.pattern.split("-").map((s) => parseInt(s.trim().replace(/^0x/i, ""), 16));
      const value = parseInt(String(node.addr || "").replace(/^0x/i, ""), 16);
      return Number.isFinite(from) && Number.isFinite(to) && value >= from && value <= to;
    }
  } catch (_) {
    return false;
  }
  return false;
}

function rtGroupForNode(node) {
  return rtGroups.find((g) => g.enabled !== false && rtMatchesGroup(node, g)) || null;
}

rtGroups = rtLoadGroups();

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
      el.textContent = s.installed
        ? rtZh("便携分析器已就绪", "Portable analyzer ready")
        : rtZh("未安装（去环境配置准备）", "Not installed (prepare in Environment setup)");
      el.className = "rtbadge " + (s.installed ? "ok" : "off");
      el.title = s.path || "";
    }
    return s;
  } catch (e) {
    const el = $("rt-side-analyzer");
    if (el) { el.textContent = rtZh("检测失败", "Detection failed"); el.className = "rtbadge bad"; }
    return null;
  }
}

async function rtPickFile() {
  try {
    const p = await dlgOpen({
      multiple: false,
      directory: false,
      title: rtZh("选择固件", "Select firmware"),
      filters: [{ name: rtZh("固件", "Firmware"), extensions: ["elf", "bin", "axf", "out", "hex"] }],
    });
    if (!p) return;
    const path = typeof p === "string" ? p : p.path;
    if (!path) return;
    rtFile = path.replace(/\//g, "\\");
    rtRoot = rtFile.replace(/[\\/][^\\/]*$/, "");
    localStorage.setItem("kdock_rt_last_file", rtFile);
    rtResetDataCache();
    rtSetFileName();
    rtLog(rtZh("已选择 ", "Selected ") + rtFile);
    await rtAnalyze();
  } catch (e) { rtLog(rtZh("选择固件失败：", "Failed to select firmware: ") + String(e), "err"); }
}
function rtSetFileName() {
  const base = rtFile ? rtFile.replace(/^.*[\\/]/, "") : "";
  if ($("rt-file-name")) $("rt-file-name").textContent = base || rtZh("还没有选择固件", "No firmware selected");
  if ($("rt-side-name")) $("rt-side-name").textContent = base || rtZh("未选择固件", "No firmware selected");
  if ($("rt-side-path")) $("rt-side-path").textContent = rtFile || rtZh(
    "选择 ELF 后可按 main 生成运行结构；BIN 需要基址与架构。",
    "Choose an ELF to expand runtime structure from main; BIN requires base and architecture.",
  );
  const isBin = /\.bin$/i.test(base);
  if ($("rt-bin-box")) $("rt-bin-box").open = isBin;
}

function rtStatsText(visible, total, totalCalls) {
  if (rtScope() === "all") {
    const calls = totalCalls == null ? "" : rtZh(` · ${totalCalls} 调用边`, ` · ${totalCalls} calls`);
    return rtZh(`${visible} / ${total} 函数 · 全固件${calls}`, `${visible} / ${total} functions · full firmware${calls}`);
  }
  if (rtScope() === "chain") {
    const dir = rtChainDir() === "up" ? rtZh("向上", "upstream")
      : rtChainDir() === "both" ? rtZh("双向", "bidirectional") : rtZh("向下", "downstream");
    return rtZh(`${visible} 函数 · ${dir}链路 · ${rtChainDepthLabel()}`,
      `${visible} functions · ${dir} chain · ${rtChainDepthLabel()}`);
  }
  return rtZh(`${visible} 函数 · main 运行链`, `${visible} functions · main runtime chain`);
}

function rtRelPath() {
  if (!rtFile) return "";
  if (!rtRoot) return rtFile.replace(/^.*[\\/]/, "");
  return rtFile.slice(rtRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

function rtCurrentCacheKey() {
  const isBin = /\.bin$/i.test(rtFile || "");
  if (!isBin) return String(rtFile || "");
  return [
    rtFile,
    ($("rt-bin-base") && $("rt-bin-base").value.trim()) || "",
    ($("rt-bin-arch") && $("rt-bin-arch").value) || "",
    ($("rt-bin-entry") && $("rt-bin-entry").value.trim()) || "",
    ($("rt-vector-base") && $("rt-vector-base").value.trim()) || "",
  ].join("|");
}
function rtResetDataCache() {
  rtCacheKeyValue = rtCurrentCacheKey();
  rtDataCache = { all: null, runtime: null };
  rtPosCache.clear();
  rtData = null;
  rtNodes = [];
  rtEdges = [];
  rtSel = null;
  rtSelection = new Set();
  rtChainAddr = "";
  rtChainAddrs = [];
  rtCollapsed.clear();
  rtSkeletonOpen.clear();
  rtSkeletonClosed.clear();
  rtFocusSets = { up: new Set(), down: new Set() };
  rtSearchHits = [];
  rtSearchIndex = -1;
  if ($("rt-search-results")) $("rt-search-results").hidden = true;
}
function rtCachedData(scope) {
  if (rtCurrentCacheKey() !== rtCacheKeyValue) rtResetDataCache();
  return rtDataCache[scope] || null;
}
function rtStoreData(scope, data) {
  if (rtCurrentCacheKey() !== rtCacheKeyValue) rtResetDataCache();
  rtDataCache[scope] = data;
}

async function rtAnalyze() {
  if (!rtFile) return rtPickFile();
  if (rtRunning) return;
  const status = await rtRefreshAnalyzer();
  if (!status || !status.installed) {
    rtSetState(rtZh("分析器未安装", "Analyzer not installed"), "bad");
    rtLog(rtZh(
      "未找到便携分析器。到「环境配置 → 固件运行结构分析器」点「一键准备」。",
      "Portable analyzer not found. Open Environment setup → Firmware runtime analyzer and prepare it.",
    ), "err");
    return;
  }
  rtRunning = true;
  rtSetState(rtZh("分析中…", "Analyzing…"), "run");
  $("rt-run").disabled = true;
  const t0 = performance.now();
  const rel = rtRelPath();
  rtLog(rtZh(
    `开始分析 ${rel || rtFile}（首次启动需要加载 angr，可能要几十秒）…`,
    `Analyzing ${rel || rtFile} (first run loads angr and may take several seconds)…`,
  ));
  try {
    const isBin = /\.bin$/i.test(rtFile);
    if (isBin) {
      const base = ($("rt-bin-base").value || "").trim();
      if (!base) throw new Error(rtZh("BIN 需要填写基址（例如 0x08000000）", "BIN requires a base address (for example 0x08000000)"));
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
    rtStoreData(requestScope, data);
    rtData = data;
    rtSel = null;
    rtSelection = new Set();
    rtCollapsed.clear();
    rtApplyFilterDefaults();
    rtBuildGraph();
    rtRender();
    rtFocusRoot();
    const root = rtDefaultRootNode();
    const chainRoots = rtScope() === "chain" ? rtChainRoots().filter(byAddrHas) : [];
    const selectedRoots = chainRoots.length ? chainRoots : root ? [root.addr] : [];
    if (selectedRoots.length) {
      rtSetSelection(selectedRoots, selectedRoots[0]);
      rtRefreshSelection(rtNodes.find((n) => n.addr === selectedRoots[0]) || rtAddrNode(selectedRoots[0]));
      rtRender();
      rtRenderEdges();
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const nodes = (rtNodes || []).filter((n) => !n.group).length;
    const irq = (data.interrupts || []).length;
    rtLastReadySecs = secs;
    rtSetState(rtZh(`就绪 · ${secs}s`, `Ready · ${secs}s`), "ok");
    const total = data.totalFunctions || (data.nodes || []).length;
    const mode = rtScope() === "all" ? rtZh("全固件", "full firmware")
      : rtScope() === "chain" ? rtZh("调用链路", "call chain") : rtZh("main 运行链", "main runtime chain");
    rtLog(rtZh(
      `分析完成（${mode}）：显示 ${nodes} / ${total} 个函数，${irq} 个中断，用时 ${secs}s`,
      `Analysis complete (${mode}): ${nodes} / ${total} functions, ${irq} interrupts, ${secs}s`,
    ), "ok");
    if (!rtNodes.length) {
      rtBuildGraph();
      rtRender();
      if (!rtNodes.length) throw new Error(rtZh("分析已返回，但没有可显示的函数节点", "Analysis returned no displayable function nodes"));
    }
  } catch (e) {
    // Keep the last good graph visible. A failed refresh should not destroy
    // the user's current context and force another expensive analysis.
    if (!rtData) {
      rtNodes = []; rtEdges = [];
      rtRender();
    }
    rtSetState(rtZh("分析失败", "Analysis failed"), "bad");
    rtLog(rtZh("分析失败：", "Analysis failed: ") + String(e), "err");
    toast(rtZh("运行结构分析失败：", "Runtime graph analysis failed: ") + String(e));
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
  return d < 0 ? rtZh("全部深度", "all depths") : rtZh(`${d} 层`, `${d} levels`);
}
function rtHasFullData() {
  return !!(rtData && (rtData.totalFunctions || rtData.entryName === "FULL FIRMWARE"));
}
function rtShowScopeData(data) {
  rtData = data;
  rtSel = null;
  rtSelection = new Set();
  rtApplyFilterDefaults();
  rtBuildGraph();
  rtRender();
  rtFocusRoot();
  const root = rtDefaultRootNode();
  if (root) {
    rtSetSelection([root.addr], root.addr);
    rtRefreshSelection(root);
    rtRender();
    rtRenderEdges();
  }
}
function rtSwitchScope(value) {
  if ($("rt-scope")) $("rt-scope").value = value;
  if ($("rt-scope-side")) $("rt-scope-side").value = value;
  if (value !== "chain") {
    rtChainAddr = "";
    rtChainAddrs = [];
    rtSelection = new Set();
  }
  rtSyncScope();
  const needed = value === "chain" ? "all" : value;
  const cached = rtCachedData(needed);
  if (cached) {
    rtShowScopeData(cached);
    const label = value === "all" ? rtZh("全固件函数", "full firmware")
      : value === "runtime" ? rtZh("main 运行链", "main runtime chain") : rtZh("函数调用链路", "call chain");
    rtLog(rtZh(`切换到${label}（使用本地缓存，无需重新分析）`,
      `Switched to ${label} (using local cache, no re-analysis needed)`));
    return;
  }
  if (rtFile) rtAnalyze();
}
function rtChainRoots() {
  if (!rtData) return [];
  const has = (addr) => !!addr && (rtData.nodes || []).some((n) => n.addr === addr);
  const configured = rtChainAddrs.filter(has);
  if (configured.length) return configured;
  const selected = [...rtSelection].filter(has);
  if (selected.length) return selected;
  if (has(rtSel) && rtSel !== "__kdock_lib__") return [rtSel];
  if (has(rtData.entry)) return [rtData.entry];
  const main = (rtData.nodes || []).find((n) => n.name === "main");
  return [main ? main.addr : ((rtData.nodes || [])[0] || {}).addr || ""].filter(Boolean);
}
function rtChainRoot() {
  return rtChainRoots()[0] || "";
}
function rtIsChainRoot(addr) {
  return rtScope() === "chain" && rtChainRoots().includes(addr);
}
function rtDefaultRootNode() {
  if (!rtNodes.length) return null;
  const chain = rtScope() === "chain";
  const wanted = chain ? rtChainRoot() : rtData && rtData.entry;
  return rtNodes.find((n) => n.addr === wanted) || rtNodes.find((n) => n.name === "main") || rtNodes[0];
}
function rtChainRootLabel() {
  const roots = rtChainRoots();
  const node = rtData && rtAddrNode(roots[0]);
  if (!node) return rtZh("未选择", "not selected");
  return roots.length > 1
    ? `${node.name} + ${roots.length - 1} · 0x${node.addr}`
    : `${node.name} · 0x${node.addr}`;
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

function rtGroupName(group) {
  if (!group) return "";
  if (group.id === "chip-hal") return rtZh("STM32 HAL / CMSIS", "STM32 HAL / CMSIS");
  if (group.id === "c-runtime") return rtZh("C 库 / newlib / 运行时", "C library / newlib / runtime");
  return group.name;
}

function rtSyncElfHelpLang() {
  const mdk = $("rt-elf-mdk");
  const cmake = $("rt-elf-cmake");
  const note = $("rt-elf-note");
  if (mdk) mdk.innerHTML = rtZh(
    'Options for Target → Output 勾选 Create Executable，并保留 Debug Information。构建后的 <code>Objects\\&lt;target&gt;.axf</code> 本身就是 ELF，可直接选择；若必须命名为 <code>.elf</code>，执行：',
    'In Options for Target → Output, enable Create Executable and keep Debug Information. The generated <code>Objects\\&lt;target&gt;.axf</code> is already an ELF and can be selected directly. To produce a <code>.elf</code> name, run:',
  );
  if (cmake) cmake.innerHTML = rtZh(
    '构建链接器和 <code>.elf</code> 目标，不要只构建 <code>.bin</code>。保留 <code>-g</code> 调试符号；可在 CMake 中设置：',
    'Build the linker/ELF target, not only <code>.bin</code>. Keep <code>-g</code> debug symbols; in CMake you can set:',
  );
  if (note) note.innerHTML = rtZh(
    '生成的 <code>app.elf</code> 需与当前烧录固件来自同一次构建。',
    'The resulting <code>app.elf</code> must come from the same build as the firmware being flashed.',
  );
}

function rtHasDownstream(addr) {
  const node = rtAddrNode(addr);
  if (!node) return false;
  const byAddr = new Set((rtData && rtData.nodes || []).map((n) => n.addr));
  return (node.calls || []).some((c) => byAddr.has(c.addr) && c.addr !== addr);
}

function rtSkeletonEnabled() {
  return rtScope() === "all" && !!($("rt-skeleton") && $("rt-skeleton").checked);
}

function rtSkeletonMainAddr() {
  const main = rtData && (rtData.nodes || []).find((n) => n.name === "main");
  return main ? main.addr : (rtData && rtData.entry) || "";
}

function rtSkeletonNodeOpen(addr) {
  if (addr === rtSkeletonMainAddr()) return !rtSkeletonClosed.has(addr);
  return rtSkeletonOpen.has(addr);
}

function rtPrimaryWorkAddr() {
  if (!rtData) return "";
  const main = rtSkeletonMainAddr();
  const byAddr = new Map((rtData.nodes || []).map((n) => [n.addr, n]));
  const root = byAddr.get(main);
  if (!root) return "";
  const candidates = [...new Set((root.calls || []).map((c) => c.addr).filter((a) => byAddr.has(a)))];
  const subtreeSize = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const call of byAddr.get(current)?.calls || []) {
        if (!byAddr.has(call.addr) || seen.has(call.addr)) continue;
        seen.add(call.addr);
        queue.push(call.addr);
      }
    }
    return seen.size;
  };
  let best = "";
  let bestSize = -1;
  for (const addr of candidates) {
    const size = subtreeSize(addr);
    if (size > bestSize) { best = addr; bestSize = size; }
  }
  return best;
}

function rtNodeIsCollapsed(addr) {
  if (!rtHasDownstream(addr)) return false;
  if (rtSkeletonEnabled()) return !rtSkeletonNodeOpen(addr);
  return rtCollapsed.has(addr);
}

function rtApplyCollapseDefaults() {
  rtCollapsed.clear();
  rtSkeletonOpen.clear();
  rtSkeletonClosed.clear();
  if (!rtData) return;
  const primary = rtPrimaryWorkAddr();
  if (primary) rtSkeletonOpen.add(primary);
  const collapseBuiltins = !!($("rt-hide-lib") && $("rt-hide-lib").checked);
  for (const node of rtData.nodes || []) {
    const group = rtGroupForNode(node);
    if (!group || !rtHasDownstream(node.addr)) continue;
    if (group.builtin && !collapseBuiltins) continue;
    rtCollapsed.add(node.addr);
  }
}

function rtSetLibraryCollapse(enabled) {
  if ($("rt-hide-lib")) $("rt-hide-lib").checked = enabled;
  if (!rtData) return;
  for (const node of rtData.nodes || []) {
    const group = rtGroupForNode(node);
    if (!group || !group.builtin || !rtHasDownstream(node.addr)) continue;
    if (enabled) rtCollapsed.add(node.addr);
    else rtCollapsed.delete(node.addr);
  }
}

function rtToggleBranch(addr, force) {
  if (!addr || !rtHasDownstream(addr)) return;
  const shouldCollapse = force == null ? !rtNodeIsCollapsed(addr) : !!force;
  if (rtSkeletonEnabled()) {
    if (addr === rtSkeletonMainAddr()) {
      if (shouldCollapse) rtSkeletonClosed.add(addr);
      else rtSkeletonClosed.delete(addr);
    } else if (shouldCollapse) {
      rtSkeletonOpen.delete(addr);
    } else {
      rtSkeletonOpen.add(addr);
      rtSkeletonClosed.delete(addr);
    }
  } else if (shouldCollapse) {
    rtCollapsed.add(addr);
  } else {
    rtCollapsed.delete(addr);
  }
  rtSel = addr;
  rtBuildGraph();
  rtRender();
  const selected = rtNodes.find((n) => n.addr === addr) || rtAddrNode(addr);
  if (selected) rtRefreshSelection(selected);
  rtRenderEdges();
}

function rtCollapseBranches() {
  if (rtSel && rtHasDownstream(rtSel)) {
    rtToggleBranch(rtSel, true);
    return;
  }
  if (rtSkeletonEnabled()) {
    rtSkeletonOpen.clear();
    rtSkeletonClosed.clear();
    rtBuildGraph();
    rtRender();
    rtFocusRoot();
    return;
  }
  for (const n of rtNodes) if (rtHasDownstream(n.addr)) rtCollapsed.add(n.addr);
  rtBuildGraph();
  rtRender();
  rtFocusRoot();
}

function rtExpandEverything() {
  rtCollapsed.clear();
  rtSkeletonOpen.clear();
  rtSkeletonClosed.clear();
  if ($("rt-skeleton")) $("rt-skeleton").checked = false;
  if ($("rt-hide-lib")) $("rt-hide-lib").checked = false;
  if (rtData) {
    rtBuildGraph();
    rtRender();
    rtFit();
  }
}

function rtOpenGroupEditor(id) {
  const editor = $("rt-group-editor");
  if (!editor) return;
  rtGroupEditId = id || null;
  const group = rtGroups.find((g) => g.id === id) || null;
  $("rt-group-name").value = group ? group.name : "";
  $("rt-group-mode").value = group ? group.mode : "prefix";
  $("rt-group-pattern").value = group ? group.pattern : "";
  const del = $("rt-group-delete");
  if (del) del.textContent = group && group.builtin ? rtZh("恢复默认", "Reset") : rtZh("删除", "Delete");
  editor.hidden = false;
  $("rt-group-name").focus();
}

function rtCloseGroupEditor() {
  rtGroupEditId = null;
  if ($("rt-group-editor")) $("rt-group-editor").hidden = true;
}

function rtSaveGroupEditor() {
  const name = ($("rt-group-name").value || "").trim();
  const mode = ($("rt-group-mode").value || "prefix").trim();
  const pattern = ($("rt-group-pattern").value || "").trim();
  if (!name || !pattern) return toast(rtZh("分组名称和匹配规则不能为空", "Group name and pattern are required"));
  if (mode === "regex") {
    try { new RegExp(pattern); } catch (_) { return toast(rtZh("正则表达式无效", "Invalid regular expression")); }
  }
  let group = rtGroups.find((g) => g.id === rtGroupEditId);
  if (!group) {
    group = { id: "custom-" + Date.now().toString(36), builtin: false };
    rtGroups.push(group);
  }
  Object.assign(group, { name, mode, pattern, enabled: true });
  rtSaveGroups();
  rtCloseGroupEditor();
  rtApplyCollapseDefaults();
  rtRenderGroups();
  if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
}

function rtDeleteGroupEditor() {
  const group = rtGroups.find((g) => g.id === rtGroupEditId);
  if (!group) return rtCloseGroupEditor();
  if (group.builtin) {
    const reset = rtDefaultGroups().find((g) => g.id === group.id);
    if (reset) Object.assign(group, reset);
  } else {
    rtGroups = rtGroups.filter((g) => g !== group);
  }
  rtSaveGroups();
  rtCloseGroupEditor();
  rtApplyCollapseDefaults();
  rtRenderGroups();
  if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
}

function rtRenderGroups() {
  const box = $("rt-groups");
  if (!box) return;
  box.textContent = "";
  const nodes = rtData && rtData.nodes ? rtData.nodes : [];
  for (const group of rtGroups) {
    const row = rtEl("div", "rtgroupline");
    const label = rtEl("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = group.enabled !== false;
    cb.title = rtZh("启用后匹配的函数会默认收起下游分支", "Matched functions start with downstream branches collapsed");
    cb.onchange = () => {
      group.enabled = cb.checked;
      rtSaveGroups();
      rtApplyCollapseDefaults();
      rtRenderGroups();
      if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
    };
    label.appendChild(cb);
    label.appendChild(rtEl("b", "", rtGroupName(group)));
    const count = nodes.filter((n) => rtMatchesGroup(n, group)).length;
    row.appendChild(label);
    row.appendChild(rtEl("span", "", String(count)));
    const edit = rtEl("button", "", "✎");
    edit.title = rtZh("编辑分组", "Edit group");
    edit.onclick = () => rtOpenGroupEditor(group.id);
    row.appendChild(edit);
    box.appendChild(row);
  }
  if (!rtGroups.length) box.appendChild(rtEl("p", "hint", rtZh("还没有折叠分组", "No collapse groups yet")));
}

function rtApplyFilterDefaults() {
  if ($("rt-hide-lib")) $("rt-hide-lib").checked = true;
  if ($("rt-skeleton")) $("rt-skeleton").checked = true;
  if ($("rt-show-interrupts")) $("rt-show-interrupts").checked = false;
  if ($("rt-layout") && !$("rt-layout").value) $("rt-layout").value = "layered";
  rtSyncScope();
  rtApplyCollapseDefaults();
  rtRenderGroups();
}

/** 从分析器 JSON 生成 KDock 自己的可见图。
 *  all=全固件；runtime=main/中断；chain=以选中函数为根、按方向与深度裁剪。 */
function rtBuildGraph() {
  rtNodes = []; rtEdges = [];
  if (!rtData) return;
  const byAddr = new Map((rtData.nodes || []).map((n) => [n.addr, n]));
  const showIrq = !!($("rt-show-interrupts") && $("rt-show-interrupts").checked);
  const mainSet = new Set(rtData.mainReachable || []);
  const irqSet = new Set(rtData.interruptReachable || []);
  const mode = rtScope();
  const allScope = mode === "all";
  const chainScope = mode === "chain";
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
  const kindFilter = ($("rt-filter-kind") && $("rt-filter-kind").value) || "all";
  const kindOf = (addr) => {
    if (irqSet.has(addr)) return "irq";
    const node = byAddr.get(addr);
    if (rtGroupForNode(node)) return "library";
    if ((callTargets.get(addr) || []).length === 0 && (callers.get(addr) || []).length === 0) return "isolated";
    return "business";
  };
  const allowed = (addr) => {
    if (!byAddr.has(addr)) return false;
    if (!allScope && !chainScope && !mainSet.has(addr) && !irqSet.has(addr)) return false;
    return kindFilter === "all" || kindOf(addr) === kindFilter;
  };
  const visible = new Set();
  const walk = (start, reverse, depthLimit, stopAtCollapsed) => {
    if (!start || !allowed(start)) return;
    const queue = [[start, 0]];
    const seen = new Set([start]);
    while (queue.length) {
      const [addr, depth] = queue.shift();
      visible.add(addr);
      if (depthLimit >= 0 && depth >= depthLimit) continue;
      if (stopAtCollapsed && rtCollapsed.has(addr)) continue;
      for (const next of (reverse ? callers.get(addr) : callTargets.get(addr)) || []) {
        if (!allowed(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push([next, depth + 1]);
      }
    }
  };
  if (chainScope) {
    const roots = rtChainRoots();
    const dir = rtChainDir();
    const depth = rtChainDepth();
    rtChainAddr = roots[0] || "";
    for (const root of roots) {
      if (dir === "up") walk(root, true, depth, false);
      else if (dir === "both") {
        walk(root, false, depth, true);
        walk(root, true, depth, false);
      } else walk(root, false, depth, true);
    }
  } else if (allScope && rtSkeletonEnabled()) {
    const allowedNodes = (rtData.nodes || []).filter((n) => allowed(n.addr));
    const allowedSet = new Set(allowedNodes.map((n) => n.addr));
    const undirected = new Map(allowedNodes.map((n) => [n.addr, new Set()]));
    for (const addr of allowedSet) {
      for (const next of callTargets.get(addr) || []) {
        if (!allowedSet.has(next)) continue;
        undirected.get(addr).add(next);
        undirected.get(next).add(addr);
      }
    }
    const seenComponents = new Set();
    const starts = [];
    const preferredMain = allowedSet.has(rtSkeletonMainAddr())
      ? rtSkeletonMainAddr()
      : allowedNodes.find((n) => n.name === "main" || n.addr === (rtData && rtData.entry))?.addr || "";
    for (const node of allowedNodes) {
      if (seenComponents.has(node.addr)) continue;
      const members = [];
      const q = [node.addr];
      seenComponents.add(node.addr);
      while (q.length) {
        const addr = q.shift();
        members.push(addr);
        for (const next of undirected.get(addr) || []) {
          if (!seenComponents.has(next)) { seenComponents.add(next); q.push(next); }
        }
      }
      if (members.includes(preferredMain)) {
        starts.push(preferredMain);
      } else {
        const roots = members.filter((addr) => (callers.get(addr) || []).filter((a) => allowedSet.has(a)).length === 0);
        const candidates = roots.length ? roots : members;
        candidates.sort((a, b) => (callTargets.get(b) || []).length - (callTargets.get(a) || []).length);
        if (candidates.length) starts.push(candidates[0]);
      }
    }
    for (const addr of rtSkeletonOpen) {
      if (allowedSet.has(addr) && !starts.includes(addr)) starts.push(addr);
    }
    for (const start of starts) {
      const q = [start];
      const seen = new Set([start]);
      while (q.length) {
        const addr = q.shift();
        visible.add(addr);
        if (!rtSkeletonNodeOpen(addr)) continue;
        for (const next of callTargets.get(addr) || []) {
          if (!allowed(next) || seen.has(next)) continue;
          seen.add(next);
          q.push(next);
        }
      }
    }
  } else if (allScope) {
    const inboundAllowed = (addr) => (callers.get(addr) || []).filter(allowed).length;
    const roots = (rtData.nodes || [])
      .map((n) => n.addr)
      .filter((addr) => allowed(addr) && inboundAllowed(addr) === 0);
    for (const root of roots) walk(root, false, -1, true);
    // Cycles and caller-only islands have no indegree-zero root. Start only
    // those components explicitly instead of flattening them into the same row.
    const blocked = new Set();
    for (const addr of rtCollapsed) {
      if (!allowed(addr)) continue;
      const q = [...(callTargets.get(addr) || [])];
      while (q.length) {
        const next = q.shift();
        if (!allowed(next) || blocked.has(next) || visible.has(next)) continue;
        blocked.add(next);
        q.push(...(callTargets.get(next) || []));
      }
    }
    for (const n of rtData.nodes || []) {
      if (allowed(n.addr) && !visible.has(n.addr) && !blocked.has(n.addr)) walk(n.addr, false, -1, true);
    }
  } else {
    walk(rtData.entry, false, -1, true);
    if (showIrq) for (const irq of rtData.interrupts || []) walk(irq.addr, false, -1, true);
  }

  const hiddenFrom = (addr) => {
    const hidden = new Set();
    const q = [...(callTargets.get(addr) || [])];
    while (q.length) {
      const next = q.shift();
      if (!allowed(next) || hidden.has(next) || visible.has(next)) continue;
      hidden.add(next);
      q.push(...(callTargets.get(next) || []));
    }
    return hidden.size;
  };
  for (const addr of visible) {
    const n = byAddr.get(addr);
    if (!n) continue;
    const pos = rtPosCache.get(addr) || { x: 0, y: 0 };
    const fallbackScope = allScope ? "function" : chainScope ? "chain" : irqSet.has(addr) && !mainSet.has(addr) ? "irq" : "main";
    const group = rtGroupForNode(n);
    const canCollapse = (callTargets.get(addr) || []).some(allowed);
    rtNodes.push({
      ...n, x: pos.x, y: pos.y,
      scope: fallbackScope,
      kind: kindOf(addr),
      groupId: group ? group.id : "",
      groupName: group ? rtGroupName(group) : "",
      collapsed: canCollapse && rtNodeIsCollapsed(addr),
      hiddenCount: canCollapse ? hiddenFrom(addr) : 0,
    });
  }
  const edgeMap = new Map();
  for (const src of visible) {
    const n = byAddr.get(src);
    for (const c of (n && n.calls) || []) {
      if (!visible.has(c.addr)) continue;
      // 同一对函数可能被调用很多次；画布上合成一条线，详情里仍保留全部调用点。
      const key = src + ">" + c.addr;
      const edge = edgeMap.get(key);
      if (edge) edge.count += 1;
      else edgeMap.set(key, { from: src, to: c.addr, site: c.site, order: c.order || 0, mnemonic: c.mnemonic || "", count: 1 });
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
  const outgoing = new Map(rtNodes.map((n) => [n.addr, []]));
  const incoming = new Map(rtNodes.map((n) => [n.addr, []]));
  for (const e of rtEdges) {
    if (!by.has(e.from) || !by.has(e.to)) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }
  const depth = new Map();
  const chainMode = rtScope() === "chain";
  const chainRoot = chainMode ? rtChainRoot() : "";
  if (layered) {
    const undirected = new Map(rtNodes.map((n) => [n.addr, new Set()]));
    for (const e of rtEdges) {
      if (!by.has(e.from) || !by.has(e.to)) continue;
      undirected.get(e.from).add(e.to);
      undirected.get(e.to).add(e.from);
    }
    const seen = new Set();
    const components = [];
    for (const start of rtNodes) {
      if (seen.has(start.addr)) continue;
      const members = [];
      const queue = [start.addr];
      seen.add(start.addr);
      while (queue.length) {
        const addr = queue.shift();
        members.push(by.get(addr));
        for (const next of undirected.get(addr) || []) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      components.push(members);
    }
    // One weakly connected component is laid out as its own horizontal call
    // topology. Components are packed vertically so unrelated firmware trees
    // no longer collapse into one giant "depth 0" grid.
    components.sort((a, b) => {
      const am = a.some((n) => n.name === "main") || a.some((n) => n.addr === (rtData && rtData.entry));
      const bm = b.some((n) => n.name === "main") || b.some((n) => n.addr === (rtData && rtData.entry));
      return Number(bm) - Number(am) || b.length - a.length;
    });
    const cellW = 226, rowGap = 94, nodeH = 76, rankGap = 92, compGap = 110;
    const laidOut = [];
    components.forEach((members, componentIndex) => {
      const memberSet = new Set(members.map((n) => n.addr));
      const localIncoming = new Map(members.map((n) => [
        n.addr, (incoming.get(n.addr) || []).filter((a) => memberSet.has(a)),
      ]));
      const localOutgoing = new Map(members.map((n) => [
        n.addr, (outgoing.get(n.addr) || []).filter((a) => memberSet.has(a)),
      ]));
      const localDepth = new Map();
      const localSeen = new Set();
      const startAt = (addr) => {
        if (!addr || localSeen.has(addr)) return;
        const q = [[addr, 0]];
        localSeen.add(addr);
        while (q.length) {
          const [current, d] = q.shift();
          if (!localDepth.has(current) || d < localDepth.get(current)) localDepth.set(current, d);
          for (const next of localOutgoing.get(current) || []) {
            if (localSeen.has(next)) continue;
            localSeen.add(next);
            q.push([next, d + 1]);
          }
        }
      };
      let roots = members.filter((n) => localIncoming.get(n.addr).length === 0);
      if (chainMode && memberSet.has(chainRoot)) roots = [by.get(chainRoot)];
      if (!roots.length) {
        const preferred = members.find((n) => n.name === "main" || n.addr === (rtData && rtData.entry));
        roots = [preferred || [...members].sort((a, b) => localIncoming.get(a.addr).length - localIncoming.get(b.addr).length)[0]];
      }
      for (const root of roots) startAt(root.addr);
      for (const n of members) if (!localSeen.has(n.addr)) startAt(n.addr);

      const ranks = new Map();
      for (const n of members) {
        const d = localDepth.get(n.addr) || 0;
        depth.set(n.addr, d);
        if (!ranks.has(d)) ranks.set(d, []);
        ranks.get(d).push(n);
      }
      const score = new Map();
      const maxRows = members.length > 800 ? 16 : members.length > 300 ? 20 : 24;
      let localX = 0;
      let componentBottom = 0;
      for (const [d, list] of [...ranks.entries()].sort((a, b) => a[0] - b[0])) {
        list.sort((a, b) => {
          const av = localIncoming.get(a.addr).map((x) => score.get(x)).filter(Number.isFinite);
          const bv = localIncoming.get(b.addr).map((x) => score.get(x)).filter(Number.isFinite);
          const ay = av.length ? av.reduce((s, x) => s + x, 0) / av.length : Number.POSITIVE_INFINITY;
          const by2 = bv.length ? bv.reduce((s, x) => s + x, 0) / bv.length : Number.POSITIVE_INFINITY;
          const af = Number.isFinite(ay) ? ay : 1e12, bf = Number.isFinite(by2) ? by2 : 1e12;
          return af - bf || localOutgoing.get(b.addr).length - localOutgoing.get(a.addr).length || a.name.localeCompare(b.name);
        });
        const columns = Math.max(1, Math.ceil(list.length / maxRows));
        list.forEach((n, index) => {
          const col = Math.floor(index / maxRows);
          const row = index % maxRows;
          n.component = componentIndex;
          n.depth = d;
          n.x = localX + col * cellW;
          n.y = row * rowGap;
          score.set(n.addr, n.y);
          componentBottom = Math.max(componentBottom, n.y + nodeH);
        });
        localX += columns * cellW + rankGap;
      }
      laidOut.push({
        members, componentIndex,
        width: Math.max(188, localX - rankGap),
        height: Math.max(nodeH, componentBottom),
      });
    });
    // Keep the main call tree on its own row. Small disconnected roots are
    // shelf-packed instead of becoming a 60-row vertical strip.
    let rowY = 48;
    let shelfX = 54;
    let shelfY = 48;
    let shelfH = 0;
    laidOut.forEach((component, index) => {
      let baseX = 54;
      let baseY = 48;
      if (index === 0) {
        baseY = 48;
        rowY = 48 + component.height + compGap;
        shelfY = rowY;
        shelfX = 54;
        shelfH = 0;
      } else if (component.members.length > 8) {
        if (shelfX !== 54) rowY = Math.max(rowY, shelfY + shelfH + compGap);
        baseY = rowY;
        rowY += component.height + compGap;
        shelfY = rowY;
        shelfX = 54;
        shelfH = 0;
      } else {
        if (shelfX + component.width > 2200) {
          shelfX = 54;
          shelfY += shelfH + compGap;
          shelfH = 0;
          rowY = Math.max(rowY, shelfY);
        }
        baseY = shelfY;
        baseX = shelfX;
        shelfX += component.width + compGap;
        shelfH = Math.max(shelfH, component.height);
      }
      for (const n of component.members) {
        n.x += baseX;
        n.y += baseY;
      }
    });
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
  rtComputeFocusSets();
  rtApplyNodeFocusClasses();
  rtRenderEdges();
  rtApplyView();
  const count = rtNodes.filter((n) => !n.group).length, edges = rtEdges.length;
  if ($("rt-stat")) {
    $("rt-stat").textContent = rtStatsText(count, (rtData && rtData.totalFunctions) || (rtData && rtData.nodes ? rtData.nodes.length : count), rtData && rtData.totalCalls)
      + rtZh(` · ${edges} 条可见线`, ` · ${edges} visible edges`);
  }
}

function rtSetSelection(addrs, primary) {
  const unique = [...new Set((addrs || []).filter((addr) => byAddrHas(addr)))];
  rtSelection = new Set(unique);
  rtSel = primary && rtSelection.has(primary) ? primary : (unique[unique.length - 1] || null);
}

function rtToggleSelectedNode(addr) {
  if (!byAddrHas(addr)) return;
  if (rtSelection.has(addr)) {
    rtSelection.delete(addr);
    if (rtSel === addr) rtSel = [...rtSelection].at(-1) || null;
  } else {
    rtSelection.add(addr);
    rtSel = addr;
  }
}

function rtComputeFocusSets() {
  rtFocusSets = { up: new Set(), down: new Set() };
  const roots = [...rtSelection].filter((addr) => byAddrHas(addr));
  if (!roots.length && rtSel) roots.push(rtSel);
  if (!roots.length) return;
  const incoming = new Map(rtNodes.map((n) => [n.addr, []]));
  const outgoing = new Map(rtNodes.map((n) => [n.addr, []]));
  const known = new Set(rtNodes.map((n) => n.addr));
  for (const e of rtEdges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }
  const visit = (root, reverse, output) => {
    if (!known.has(root)) return;
    const q = [root];
    output.add(root);
    while (q.length) {
      const addr = q.shift();
      for (const next of (reverse ? incoming.get(addr) : outgoing.get(addr)) || []) {
        if (output.has(next)) continue;
        output.add(next);
        q.push(next);
      }
    }
  };
  for (const root of roots) {
    visit(root, true, rtFocusSets.up);
    visit(root, false, rtFocusSets.down);
  }
}

function rtApplyNodeFocusClasses() {
  const hasFocus = rtSelection.size > 0 && (rtFocusSets.up.size || rtFocusSets.down.size);
  for (const el of document.querySelectorAll("#rt-nodes .rtfn")) {
    const addr = el.dataset.addr;
    const selected = rtSelection.has(addr);
    el.classList.toggle("sel", selected);
    el.classList.toggle("primary-sel", selected && addr === rtSel && rtSelection.size > 1);
    el.classList.toggle("focus-up", hasFocus && !selected && rtFocusSets.up.has(addr));
    el.classList.toggle("focus-down", hasFocus && !selected && rtFocusSets.down.has(addr));
    const related = selected || rtFocusSets.up.has(addr) || rtFocusSets.down.has(addr);
    el.classList.toggle("dimmed", hasFocus && !related);
  }
}

function rtClearSelection() {
  rtSel = null;
  rtSelection = new Set();
  rtFocusSets = { up: new Set(), down: new Set() };
  for (const el of document.querySelectorAll("#rt-nodes .rtfn")) {
    el.classList.remove("sel", "primary-sel", "focus-up", "focus-down", "dimmed");
  }
  rtRenderEdges();
  rtRefreshSelection(null);
}

function rtRenderEdges() {
  const edgeG = $("rt-edges-g");
  if (!edgeG) return;
  while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);
  const by = new Map(rtNodes.map((n) => [n.addr, n]));
  let defs = edgeG.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SQ_NS, "defs");
    for (const [id, cls] of [["rt-arrow", ""], ["rt-arrow-up", "up"], ["rt-arrow-down", "down"], ["rt-arrow-focus", "focus"]]) {
      const marker = document.createElementNS(SQ_NS, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("viewBox", "0 0 8 8");
      marker.setAttribute("refX", "7");
      marker.setAttribute("refY", "4");
      marker.setAttribute("markerWidth", "6");
      marker.setAttribute("markerHeight", "6");
      marker.setAttribute("orient", "auto");
      const head = document.createElementNS(SQ_NS, "path");
      head.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
      head.setAttribute("class", "rtarrowhead" + (cls ? " " + cls : ""));
      marker.appendChild(head);
      defs.appendChild(marker);
    }
    edgeG.appendChild(defs);
  }
  const chainMode = rtScope() === "chain";
  const mode = ($("rt-edge-mode") && $("rt-edge-mode").value) || "selected";
  const focus = rtSel || (chainMode ? rtChainRoot() : "");
  const hasFocus = !!focus && rtFocusSets.up.has(focus);
  for (const e of rtEdges) {
    const a = by.get(e.from), b = by.get(e.to);
    if (!a || !b) continue;
    const incident = !!(focus && (e.from === focus || e.to === focus));
    const routeUp = hasFocus && rtFocusSets.up.has(e.from) && rtFocusSets.up.has(e.to);
    const routeDown = hasFocus && rtFocusSets.down.has(e.from) && rtFocusSets.down.has(e.to);
    // "Selected" means the complete upstream and downstream routes, not only
    // the two edges touching the selected node.
    if (mode === "none" || (!chainMode && mode === "selected" && hasFocus && !routeUp && !routeDown)) continue;
    const ax = a.x + 188, ay = a.y + 38, bx = b.x, byy = b.y + 38;
    const bend = Math.max(36, Math.abs(bx - ax) * 0.38);
    const d = bx >= ax
      ? `M ${ax} ${ay} C ${ax + bend} ${ay}, ${bx - bend} ${byy}, ${bx} ${byy}`
      : `M ${ax} ${ay} C ${ax + bend} ${ay - 70}, ${bx - bend} ${byy + 70}, ${bx} ${byy}`;
    const p = document.createElementNS(SQ_NS, "path");
    p.setAttribute("d", d);
    const markerId = incident ? "rt-arrow-focus" : routeUp ? "rt-arrow-up" : routeDown ? "rt-arrow-down" : "rt-arrow";
    p.setAttribute("marker-end", `url(#${markerId})`);
    p.dataset.src = a.name;
    p.dataset.dst = b.name;
    if (e.count > 1) p.dataset.count = String(e.count);
    const cls = "seqedge rtlink"
      + (rtIsLib(a.name) || rtIsLib(b.name) || a.group || b.group ? " lib" : "")
      + (routeUp ? " route-up" : "")
      + (routeDown ? " route-down" : "")
      + (incident ? " focus" : "")
      + (hasFocus && !routeUp && !routeDown ? " dim" : "");
    p.setAttribute("class", cls);
    const tip = document.createElementNS(SQ_NS, "title");
    tip.textContent = `${a.name} → ${b.name}${e.count > 1 ? ` ×${e.count}` : ""}`;
    p.appendChild(tip);
    edgeG.appendChild(p);
  }
}

function rtNodeEl(n) {
  const outCount = n.calls ? n.calls.filter((c) => rtAddrNode(c.addr)).length : 0;
  const el = rtEl("div", "seqnode rtfn"
    + (n.scope === "irq" ? " irq" : "")
    + (n.group ? " libgroup" : "")
    + (n.collapsed ? " collapsed" : "")
    + (n.scope === "chain" ? " chainfn" : "")
    + (rtIsChainRoot(n.addr) ? " chainroot" : "")
    + (rtSelection.has(n.addr) ? " sel" : "")
    + (n.addr === rtSel && rtSelection.size > 1 ? " primary-sel" : ""));
  el.dataset.addr = n.addr;
  el.dataset.kind = n.kind || "business";
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  const hd = rtEl("div", "nhd");
  hd.appendChild(rtEl("span", "nkind", n.group ? "LIB" : n.scope === "irq" ? "IRQ" : n.scope === "chain" ? "LINK" : "FUNC"));
  hd.appendChild(rtEl("span", "rtfn-name", n.name));
  if (outCount) {
    const fold = rtEl("button", "rtfold", n.collapsed ? "+" : "−");
    fold.title = n.collapsed
      ? rtZh(`展开下游（${n.hiddenCount || 0} 个函数）`, `Expand downstream (${n.hiddenCount || 0} functions)`)
      : rtZh("收起下游分支", "Collapse downstream branch");
    fold.onpointerdown = (e) => e.stopPropagation();
    fold.onclick = (e) => {
      e.stopPropagation();
      rtToggleBranch(n.addr);
    };
    hd.appendChild(fold);
  }
  el.appendChild(hd);
  const bd = rtEl("div", "nbd");
  if (n.group) {
    bd.appendChild(rtEl("div", "rtmeta", rtZh(`${n.libCount} 个库函数 · ${n.blocks || 0} 块`, `${n.libCount} library functions · ${n.blocks || 0} blocks`)));
    if (rtScope() === "all") bd.appendChild(rtEl("div", "rtmeta", rtZh("全固件库函数 · 自动汇总", "Full-firmware library functions · summarized")));
    else if (rtScope() === "chain") bd.appendChild(rtEl("div", "rtmeta", rtZh("当前链路内的库函数 · 自动汇总", "Library functions in this chain · summarized")));
    else if (n.scopeCount) bd.appendChild(rtEl("div", "rtmeta", rtZh(`运行链 ${n.scopeCount.main} · 中断 ${n.scopeCount.irq}`, `Runtime ${n.scopeCount.main} · interrupt ${n.scopeCount.irq}`)));
    bd.appendChild(rtEl("div", "rtmeta", rtZh("展开「库过滤 → 全部显示」查看明细", "Choose Library filter → Show all for details")));
  } else {
    if ($("rt-show-addr") && $("rt-show-addr").checked) bd.appendChild(rtEl("div", "rtaddr", "0x" + n.addr));
    const childCount = rtEdges.filter((e) => e.from === n.addr).length;
    bd.appendChild(rtEl("div", "rtmeta", rtZh(
      `${n.calls ? n.calls.length : 0} 调用 · ${n.blocks || 0} 块` + (childCount ? ` · 展开 ${childCount}` : ""),
      `${n.calls ? n.calls.length : 0} calls · ${n.blocks || 0} blocks` + (childCount ? ` · expands ${childCount}` : ""),
    )));
    if (n.collapsed) bd.appendChild(rtEl("div", "rtmeta rtfold-meta", rtZh(
      `已收起 ${n.hiddenCount || 0} 个下游函数`,
      `${n.hiddenCount || 0} downstream functions collapsed`,
    )));
  }
  el.appendChild(bd);
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) rtToggleSelectedNode(n.addr);
    else rtSetSelection([n.addr], n.addr);
    const primary = rtSel ? (rtNodes.find((item) => item.addr === rtSel) || rtAddrNode(rtSel)) : null;
    rtRefreshSelection(primary);
    rtComputeFocusSets();
    rtApplyNodeFocusClasses();
    rtRenderEdges();
    const w = rtScreenToWorld(e.clientX, e.clientY);
    rtDrag = { id: n.addr, dx: w.x - n.x, dy: w.y - n.y };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("click", () => {
    if (rtSelection.has(n.addr)) rtRefreshSelection(n);
    rtSyncScope();
  });
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (outCount) rtToggleBranch(n.addr);
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
  if (!n) { box.appendChild(rtEl("p", "hint", rtZh("在中间点一个函数，这里显示地址、大小和调用点。", "Select a function on the canvas to inspect address, size and call sites."))); return; }
  if (rtSelection.size > 1) {
    box.appendChild(rtEl("div", "cardtitle", rtZh(`已选 ${rtSelection.size} 个函数`, `${rtSelection.size} functions selected`)));
    const list = rtEl("div", "rtcalls");
    for (const addr of [...rtSelection].slice(0, 24)) {
      const node = rtAddrNode(addr);
      if (!node) continue;
      const row = rtEl("button", "rtcall" + (addr === rtSel ? " active" : ""));
      row.appendChild(rtEl("span", "rtcall-a", "0x" + addr));
      row.appendChild(rtEl("span", "rtcall-n", node.name));
      row.onclick = () => rtCenter(addr);
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(rtEl("p", "hint", rtZh(
      "Ctrl / Shift + 点击可增减选择；点“拉选中链路”会合并这些函数及其上下游。",
      "Use Ctrl / Shift + click to add or remove selections; Draw selected chain merges their upstream and downstream paths.",
    )));
  }
  if (n.group) {
    box.appendChild(rtEl("div", "cardtitle", rtZh(`库函数汇总 · ${n.libCount} 个`, `Library summary · ${n.libCount}`)));
    box.appendChild(rtEl("div", "rtdet-row", rtZh(`合计 ${n.size || 0} B · ${n.blocks || 0} 个基本块`, `Total ${n.size || 0} B · ${n.blocks || 0} basic blocks`)));
    const list = rtEl("div", "rtcalls");
    for (const addr of (n.libAddrs || []).slice(0, 80)) {
      const item = rtAddrNode(addr);
      if (!item) continue;
      const row = rtEl("button", "rtcall");
      row.appendChild(rtEl("span", "rtcall-a", "0x" + item.addr));
      row.appendChild(rtEl("span", "rtcall-n", item.name));
      row.onclick = () => {
        if ($("rt-hide-lib")) $("rt-hide-lib").checked = false;
        rtRevealNode(item.addr);
      };
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(rtEl("p", "hint", rtZh(
      "已折叠 HAL / CMSIS / newlib 调用。点列表里的函数或切换「全部显示」可展开明细。",
      "HAL / CMSIS / newlib calls are summarized. Click a function or choose Show all to expand them.",
    )));
    return;
  }
  const top = rtEl("div", "rtdet-head");
  top.appendChild(rtEl("b", "rtdet-name", n.name));
  const scopeBadge = n.scope === "irq" ? ["warn", rtZh("中断", "IRQ")]
    : n.scope === "function" ? ["fn", rtZh("函数", "FUNC")]
    : n.scope === "chain" ? ["chain", rtZh("链路", "LINK")] : ["ok", "main"];
  top.appendChild(rtEl("span", "rtbadge " + scopeBadge[0], scopeBadge[1]));
  box.appendChild(top);
  box.appendChild(rtEl("div", "rtdet-row", rtZh("地址 ", "Address ") + "0x" + n.addr));
  box.appendChild(rtEl("div", "rtdet-row", rtZh(`大小 ${n.size || 0} B · ${n.blocks || 0} 个基本块`, `Size ${n.size || 0} B · ${n.blocks || 0} basic blocks`)));
  if (n.groupName) box.appendChild(rtEl("div", "rtdet-row", rtZh("折叠分组：", "Collapse group: ") + n.groupName));
  const incoming = rtData && (rtData.nodes || [])
    .filter((item) => (item.calls || []).some((c) => c.addr === n.addr)).length;
  rtComputeFocusSets();
  box.appendChild(rtEl("div", "rtdet-row", rtZh(
    `上游 ${Math.max(0, rtFocusSets.up.size - 1)} · 下游 ${Math.max(0, rtFocusSets.down.size - 1)} · 直接调用者 ${incoming || 0}`,
    `Upstream ${Math.max(0, rtFocusSets.up.size - 1)} · downstream ${Math.max(0, rtFocusSets.down.size - 1)} · direct callers ${incoming || 0}`,
  )));
  if (n.calls && n.calls.length) {
    box.appendChild(rtEl("div", "cardtitle", rtZh("调用点", "Call sites")));
    const list = rtEl("div", "rtcalls");
    for (const c of n.calls.slice(0, 24)) {
      const r = rtEl("button", "rtcall");
      r.appendChild(rtEl("span", "rtcall-a", "0x" + c.site));
      r.appendChild(rtEl("span", "rtcall-n", c.name));
      r.onclick = () => rtRevealNode(c.addr);
      list.appendChild(r);
    }
    box.appendChild(list);
  }
  const btns = rtEl("div", "btnrow");
  const b = rtEl("button", "btn small", rtZh("定位画布", "Center on canvas"));
  b.onclick = () => rtCenter(n.addr);
  btns.appendChild(b);
  const cfg = rtEl("button", "btn small", rtZh("展开 CFG", "Open CFG"));
  cfg.onclick = () => rtShowCfg(n);
  btns.appendChild(cfg);
  if (rtHasDownstream(n.addr)) {
    const fold = rtEl("button", "btn small", n.collapsed
      ? rtZh(`展开下游 (${n.hiddenCount || 0})`, `Expand downstream (${n.hiddenCount || 0})`)
      : rtZh("收起下游分支", "Collapse downstream"));
    fold.onclick = () => rtToggleBranch(n.addr);
    btns.appendChild(fold);
  }
  const chain = rtEl("button", "btn small primary", rtZh("拉这条链路", "Draw this chain"));
  chain.onclick = () => rtUseAsChain(n.addr);
  btns.appendChild(chain);
  box.appendChild(btns);
}
function rtUseAsChain(addr) {
  return rtUseAsChainRoots([addr]);
}
function rtUseAsChainRoots(addrs) {
  const roots = [...new Set((addrs || []).filter(byAddrHas))];
  if (!rtData || !roots.length) {
    return toast(rtZh("先分析固件，再选择至少一个链路根函数", "Analyze firmware and select at least one chain root first"));
  }
  rtChainAddrs = roots;
  rtChainAddr = roots[0];
  if ($("rt-scope")) $("rt-scope").value = "chain";
  if ($("rt-scope-side")) $("rt-scope-side").value = "chain";
  rtSyncScope();
  const names = roots.map((addr) => {
    const node = rtAddrNode(addr);
    return node ? node.name : addr;
  });
  const chainDir = rtChainDir() === "up" ? rtZh("向上", "upstream")
    : rtChainDir() === "both" ? rtZh("双向", "both directions") : rtZh("向下", "downstream");
  rtLog(rtZh(
    `链路分析：以 ${names.join(" + ")} 为根，${chainDir} ${rtChainDepthLabel()}`,
    `Chain analysis: roots ${names.join(" + ")}, ${chainDir}, ${rtChainDepthLabel()}`,
  ), "ok");
  // The runtime endpoint only contains main/interrupt reachable functions.
  // Chain mode is a slice of the full-firmware graph, so fetch it when needed.
  const full = rtCachedData("all");
  if (!full) return rtAnalyze();
  rtData = full;
  rtBuildGraph();
  rtSetSelection(roots, roots[0]);
  rtRender();
  rtRefreshSelection(rtNodes.find((n) => n.addr === roots[0]) || rtAddrNode(roots[0]));
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
  if (rtSelection.has(addr)) rtSel = addr;
  else rtSetSelection([addr], addr);
  rtRefreshSelection(rtAddrNode(addr) || n);
  rtRender();
  rtApplyView();
}
function rtShowCfg(n) {
  if (n.group) return toast(rtZh("库函数已折叠；切换为「全部显示」后再展开单个 CFG", "Library functions are summarized; choose Show all before opening an individual CFG"));
  const detail = rtAddrNode(n.addr);
  if (!detail || !detail.block_nodes) return toast(rtZh("这个函数没有 CFG 数据（BIN 无符号时常见）", "No CFG data for this function (common for unsigned BIN)"));
  rtSel = n.addr;
  rtCollapsed.clear();
  const blocks = detail.block_nodes || [];
  for (const b of blocks) {
    const key = n.addr + "@" + b.addr;
    rtCollapsed.delete(key);
  }
  rtLog(rtZh(`展开 ${n.name} 的 ${blocks.length} 个基本块`, `Opened ${blocks.length} basic blocks for ${n.name}`));
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
    r.appendChild(rtEl("span", "rtblock-m", rtZh(`${b.instructions} 条`, `${b.instructions} insns`)));
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
    // Buttons/inputs inside the canvas (especially the empty-state file picker)
    // must receive their normal click instead of starting a canvas pan.
    if (e.target.closest && e.target.closest(".seqnode,button,a,input,select,textarea,.rtempty")) return;
    const w = rtScreenToWorld(e.clientX, e.clientY);
    rtDrag = { pan: true, moved: false, x: e.clientX, y: e.clientY, vx: rtView.x, vy: rtView.y };
    cv.classList.add("panning");
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!rtDrag) return;
    if (rtDrag.pan) {
      const ui = uiScaleValue();
      if (Math.abs(e.clientX - rtDrag.x) > 4 || Math.abs(e.clientY - rtDrag.y) > 4) rtDrag.moved = true;
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
    const clickCleared = !!(rtDrag && rtDrag.pan && !rtDrag.moved);
    if (rtDrag && !rtDrag.pan) rtRenderEdges();
    rtDrag = null;
    cv.classList.remove("panning");
    if (clickCleared) rtClearSelection();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", (e) => {
    if (!e.target.closest || !e.target.closest(".seqnode")) rtFit();
  });
  cv.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      rtSearchClose();
      rtClearSelection();
    }
  });
}

function rtFuzzyScore(node, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return -1;
  const name = String(node.name || "").toLowerCase();
  const addr = String(node.addr || "").toLowerCase().replace(/^0x/, "");
  const hex = q.replace(/^0x/, "");
  let score = -1;
  if (/^[0-9a-f]+$/i.test(hex)) {
    if (addr === hex) score = 1400;
    else if (addr.startsWith(hex)) score = 1100 - addr.length;
    else if (addr.includes(hex)) score = 850 - addr.indexOf(hex);
  }
  if (name === q) score = Math.max(score, 1300);
  else if (name.startsWith(q)) score = Math.max(score, 1000 - name.length);
  else if (name.includes(q)) score = Math.max(score, 760 - name.indexOf(q));
  const tokens = q.split(/[\s/]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => name.includes(t))) score = Math.max(score, 720);
  if (score < 0) {
    let pos = 0, gaps = 0;
    for (const ch of q) {
      if (/\s/.test(ch)) continue;
      const found = name.indexOf(ch, pos);
      if (found < 0) { pos = -1; break; }
      gaps += found - pos;
      pos = found + 1;
    }
    if (pos >= 0) score = Math.max(0, 520 - gaps * 5 - name.length);
  }
  return score;
}

function rtSearchClose() {
  const box = $("rt-search-results");
  if (box) box.hidden = true;
  rtSearchIndex = -1;
}

function rtRenderSearchResults(query) {
  const box = $("rt-search-results");
  if (!box || !rtData) return;
  const q = String(query || "").trim();
  if (!q) {
    rtSearchHits = [];
    box.hidden = true;
    return;
  }
  const degrees = new Map((rtData.nodes || []).map((n) => [n.addr, (n.calls || []).length]));
  rtSearchHits = (rtData.nodes || [])
    .map((n) => ({ node: n, score: rtFuzzyScore(n, q) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || degrees.get(b.node.addr) - degrees.get(a.node.addr) || a.node.name.localeCompare(b.node.name))
    .slice(0, 40);
  rtSearchIndex = rtSearchHits.length ? 0 : -1;
  box.textContent = "";
  if (!rtSearchHits.length) {
    box.appendChild(rtEl("div", "rtsearchempty", rtZh("没有匹配的函数", "No matching function")));
    box.hidden = false;
    return;
  }
  rtSearchHits.forEach((hit, index) => {
    const n = hit.node;
    const row = rtEl("button", "rtsearchhit" + (index === rtSearchIndex ? " active" : ""));
    row.appendChild(rtEl("b", "", n.name));
    row.appendChild(rtEl("small", "", "0x" + n.addr));
    const group = rtGroupForNode(n);
    const detail = [
      n.addr === (rtData.entry || "") ? "ENTRY" : "",
      group ? rtGroupName(group) : "",
      rtZh(`${(n.calls || []).length} 调用`, `${(n.calls || []).length} calls`),
    ].filter(Boolean).join(" · ");
    row.appendChild(rtEl("em", "", detail));
    row.onmouseenter = () => { rtSearchIndex = index; rtMarkSearchHit(); };
    row.onclick = () => rtJumpToNode(n.addr);
    box.appendChild(row);
  });
  box.hidden = false;
}

function rtMarkSearchHit() {
  const rows = [...document.querySelectorAll("#rt-search-results .rtsearchhit")];
  rows.forEach((row, index) => row.classList.toggle("active", index === rtSearchIndex));
  const active = rows[rtSearchIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function rtTakeSearch() {
  const hit = rtSearchHits[rtSearchIndex];
  if (!hit) {
    const q = ($("rt-search-input") && $("rt-search-input").value || "").trim();
    if (q) return toast(rtZh("没有找到：", "Not found: ") + q);
    if ($("rt-search-input")) $("rt-search-input").focus();
    return;
  }
  rtJumpToNode(hit.node.addr);
}

function rtRevealNode(addr) {
  if (!rtData || !addr) return;
  const target = rtAddrNode(addr);
  if (!target) return toast(rtZh("这个函数不在当前分析结果里", "This function is not in the current analysis"));
  if ($("rt-filter-kind") && $("rt-filter-kind").value !== "all") $("rt-filter-kind").value = "all";
  if (rtScope() === "chain" && rtCachedData("all")) {
    if ($("rt-scope")) $("rt-scope").value = "all";
    if ($("rt-scope-side")) $("rt-scope-side").value = "all";
    rtData = rtCachedData("all");
  }
  const callers = new Map((rtData.nodes || []).map((n) => [n.addr, []]));
  for (const n of rtData.nodes || []) {
    for (const c of n.calls || []) if (callers.has(c.addr)) callers.get(c.addr).push(n.addr);
  }
  const q = [addr];
  const seen = new Set(q);
  while (q.length) {
    const current = q.shift();
    rtCollapsed.delete(current);
    rtSkeletonOpen.add(current);
    rtSkeletonClosed.delete(current);
    for (const prev of callers.get(current) || []) {
      if (seen.has(prev)) continue;
      seen.add(prev);
      q.push(prev);
    }
  }
  rtSyncScope();
  rtBuildGraph();
  rtRender();
  const visible = rtNodes.find((n) => n.addr === addr);
  if (!visible) {
    toast(rtZh("函数被筛选或折叠规则隐藏，已尝试展开所在路径", "The function is hidden by a filter or collapse rule; its path was opened"));
    return;
  }
  rtCenter(addr);
}

function rtJumpToNode(addr) {
  rtRevealNode(addr);
  const n = rtAddrNode(addr);
  if (n) rtLog(rtZh(`已定位 ${n.name} · 0x${n.addr}`, `Located ${n.name} · 0x${n.addr}`));
  rtSearchClose();
}

async function rtFind() {
  if (!rtData) return toast(rtZh("先分析一个固件", "Analyze firmware first"));
  const input = $("rt-search-input");
  if (!input) return;
  const q = input.value.trim();
  if (!q) return input.focus();
  rtRenderSearchResults(q);
  rtTakeSearch();
}

async function rtInit() {
  if (rtReady) { rtRefreshAnalyzer(); return; }
  rtReady = true;
  const last = localStorage.getItem("kdock_rt_last_file") || "";
  if (last) { rtFile = last; rtRoot = last.replace(/[\\/][^\\/]*$/, ""); rtSetFileName(); }
  const st = await rtRefreshAnalyzer();
  if (st && st.installed) rtLog(rtZh("便携分析器就绪：", "Portable analyzer ready: ") + st.version);
  else rtLog(rtZh("未找到便携分析器：去环境配置 → 固件运行结构分析器 准备。", "Portable analyzer not found; prepare it in Environment setup → Firmware runtime analyzer."), "err");
  const pick = $("rt-file"), pick2 = $("rt-empty-pick"), pick3 = $("rt-pick-side"), run = $("rt-run");
  for (const b of [pick, pick2, pick3]) if (b) b.onclick = rtPickFile;
  if (run) run.onclick = rtAnalyze;
  if ($("rt-tidy")) $("rt-tidy").onclick = () => { rtLayout(true); rtNodes.forEach((n) => rtPosCache.set(n.addr, { x: n.x, y: n.y })); rtRender(); rtFocusRoot(); };
  if ($("rt-fit")) $("rt-fit").onclick = rtFit;
  if ($("rt-search-btn")) $("rt-search-btn").onclick = rtFind;
  const searchInput = $("rt-search-input");
  if (searchInput) {
    searchInput.oninput = () => rtRenderSearchResults(searchInput.value);
    searchInput.onfocus = () => { if (searchInput.value.trim()) rtRenderSearchResults(searchInput.value); };
    searchInput.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!rtSearchHits.length) return;
        e.preventDefault();
        rtSearchIndex = (rtSearchIndex + (e.key === "ArrowDown" ? 1 : -1) + rtSearchHits.length) % rtSearchHits.length;
        rtMarkSearchHit();
      } else if (e.key === "Enter") {
        e.preventDefault();
        rtTakeSearch();
      } else if (e.key === "Escape") {
        rtSearchClose();
        rtClearSelection();
      }
    };
  }
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest || !e.target.closest(".rtsearchbox")) rtSearchClose();
  });
  if (!document.documentElement.dataset.rtEscBound) {
    document.documentElement.dataset.rtEscBound = "1";
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      rtSearchClose();
      rtClearSelection();
    });
  }
  if ($("rt-expand")) $("rt-expand").onclick = rtExpandEverything;
  if ($("rt-collapse")) $("rt-collapse").onclick = rtCollapseBranches;
  if ($("rt-group-add")) $("rt-group-add").onclick = () => rtOpenGroupEditor(null);
  if ($("rt-group-save")) $("rt-group-save").onclick = rtSaveGroupEditor;
  if ($("rt-group-cancel")) $("rt-group-cancel").onclick = rtCloseGroupEditor;
  if ($("rt-group-delete")) $("rt-group-delete").onclick = rtDeleteGroupEditor;
  const useChain = () => {
    const selected = [...rtSelection].filter(byAddrHas);
    if (!selected.length && rtSel && !String(rtSel).startsWith("__")) selected.push(rtSel);
    if (!selected.length && rtChainRoot()) selected.push(rtChainRoot());
    if (!selected.length) return toast(rtZh("先分析固件并选择至少一个函数", "Analyze firmware and select at least one function first"));
    rtUseAsChainRoots(selected);
  };
  if ($("rt-chain-pick")) $("rt-chain-pick").onclick = useChain;
  if ($("rt-chain-pick-side")) $("rt-chain-pick-side").onclick = useChain;
  const returnToFull = () => rtSwitchScope("all");
  if ($("rt-chain-back")) $("rt-chain-back").onclick = returnToFull;
  if ($("rt-chain-back-side")) $("rt-chain-back-side").onclick = returnToFull;
  for (const id of ["rt-chain-dir", "rt-chain-depth"]) {
    const el = $(id); if (el) el.onchange = () => {
      if (rtScope() === "chain") {
        rtBuildGraph(); rtRender(); rtFocusRoot(); rtSyncScope();
      }
    };
  }
  if ($("rt-bin-arch")) $("rt-bin-arch").onchange = () => { rtResetDataCache(); rtSetFileName(); };
  for (const id of ["rt-bin-base", "rt-bin-entry", "rt-vector-base"]) {
    const el = $(id);
    if (el) el.oninput = () => rtResetDataCache();
  }
  if ($("rt-log-clear")) $("rt-log-clear").onclick = () => { $("rt-log").textContent = ""; rtLogNo = 0; };
  if ($("rt-hide-lib")) $("rt-hide-lib").onchange = () => {
    rtSetLibraryCollapse($("rt-hide-lib").checked);
    if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
  };
  if ($("rt-skeleton")) $("rt-skeleton").onchange = () => {
    if ($("rt-skeleton").checked) {
      rtApplyCollapseDefaults();
    } else {
      rtSkeletonOpen.clear();
      rtSkeletonClosed.clear();
    }
    if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
  };
  for (const id of ["rt-show-interrupts", "rt-main-only", "rt-show-addr", "rt-layout", "rt-filter-kind", "rt-edge-mode", "rt-color-scope"]) {
    const el = $(id); if (el) el.onchange = () => {
      if ($("rt-scope-side")) $("rt-scope-side").value = rtScope();
      if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
    };
  }
  for (const id of ["rt-scope", "rt-scope-side"]) {
    const el = $(id);
    if (el) el.onchange = () => rtSwitchScope(el.value);
  }
  rtSyncScope();
  rtSyncElfHelpLang();
  rtRenderGroups();
  rtBindCanvas();
  rtRender();
  if (window.kdockOnLang) window.kdockOnLang(() => {
    rtSyncScope();
    rtSyncElfHelpLang();
    rtRenderGroups();
    if (rtData) { rtBuildGraph(); rtRender(); rtFocusRoot(); }
    else rtRender();
    if (rtLastReadySecs) rtSetState(rtZh(`就绪 · ${rtLastReadySecs}s`, `Ready · ${rtLastReadySecs}s`), "ok");
    if (rtSel) {
      const selected = rtNodes.find((n) => n.addr === rtSel) || rtAddrNode(rtSel);
      if (selected) rtRefreshSelection(selected);
    }
  });
}


window.rtInit = rtInit;
window.rtAnalyze = rtAnalyze;
window.rtUseAsChain = rtUseAsChain;
window.rtUseAsChainRoots = rtUseAsChainRoots;
