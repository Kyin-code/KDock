/**
 * KDock 快捷键：动作清单、持久化、冲突检查、键盘分发和设置页编辑器。
 *
 * 设计取舍参考 JetBrains：动作而不是控件作为配置单位；显示默认值与自定义值；
 * 同一个组合键只能绑定一个动作；设置页可按名称搜索，并支持单项/全部恢复默认。
 * 导航类默认使用 Ctrl+Alt+数字，避免抢占输入框里的普通按键。
 */

export const SHORTCUT_STORAGE_KEY = "kdock_shortcuts";

export const SHORTCUT_GROUPS = [
  { id: "app", titleZh: "应用", titleEn: "Application" },
  { id: "nav", titleZh: "页面导航", titleEn: "Navigation" },
  { id: "tools", titleZh: "工作区动作", titleEn: "Workspace actions" },
];

export const SHORTCUT_DEFS = [
  {
    id: "app.settings", group: "app", defaultBinding: "Ctrl+,",
    titleZh: "打开设置", titleEn: "Open Settings",
    descZh: "打开设置窗口，并保留上次所在分类。", descEn: "Open Settings and keep the current section.",
  },
  {
    id: "app.shortcuts", group: "app", defaultBinding: "Ctrl+Alt+K",
    titleZh: "快捷键设置", titleEn: "Keyboard shortcuts",
    descZh: "直接打开设置里的快捷键动作清单。", descEn: "Open the keyboard shortcut action list.",
  },
  {
    id: "app.help", group: "app", defaultBinding: "F1",
    titleZh: "当前页帮助", titleEn: "Context help",
    descZh: "打开当前页面或当前设置分类的说明。", descEn: "Open help for the current page or settings section.",
  },
  {
    id: "nav.next", group: "nav", defaultBinding: "Ctrl+PageDown",
    titleZh: "下一个常用页面", titleEn: "Next primary page",
    descZh: "在左栏常用入口之间循环，不进入高级工具。", descEn: "Cycle through primary navigation entries, skipping Advanced tools.",
  },
  {
    id: "nav.prev", group: "nav", defaultBinding: "Ctrl+PageUp",
    titleZh: "上一个常用页面", titleEn: "Previous primary page",
    descZh: "在左栏常用入口之间反向循环。", descEn: "Cycle backwards through primary navigation entries.",
  },
  {
    id: "nav.link", group: "nav", defaultBinding: "Ctrl+Alt+1",
    titleZh: "转到传输", titleEn: "Go to Transfer",
    descZh: "打开主连接、收发日志和发送输入区。", descEn: "Open the main link, traffic log and send box.",
  },
  {
    id: "nav.monitor", group: "nav", defaultBinding: "Ctrl+Alt+2",
    titleZh: "转到监听", titleEn: "Go to Monitor",
    descZh: "打开 USB / 网络抓包与诊断。", descEn: "Open USB/network capture and diagnostics.",
  },
  {
    id: "nav.agent", group: "nav", defaultBinding: "Ctrl+Alt+3",
    titleZh: "转到 Agent", titleEn: "Go to Agent",
    descZh: "打开 Agent 会话和当前工作区信息。", descEn: "Open the Agent conversation and workspace information.",
  },
  {
    id: "nav.flash", group: "nav", defaultBinding: "Ctrl+Alt+4",
    titleZh: "转到烧录", titleEn: "Go to Flash",
    descZh: "打开调试探针、厂商 ROM 和 KDock OTA 烧录。", descEn: "Open probe, vendor ROM and KDock OTA flashing.",
  },
  {
    id: "nav.files", group: "nav", defaultBinding: "Ctrl+Alt+5",
    titleZh: "转到文件管理", titleEn: "Go to Files",
    descZh: "打开设备文件、FTP/TFTP 与本地取送。", descEn: "Open device files, FTP/TFTP and local transfers.",
  },
  {
    id: "nav.runtime", group: "nav", defaultBinding: "Ctrl+Alt+6",
    titleZh: "转到运行结构", titleEn: "Go to Runtime graph",
    descZh: "打开固件调用图、链路和函数搜索。", descEn: "Open firmware call graph, chains and function search.",
  },
  {
    id: "nav.env", group: "nav", defaultBinding: "Ctrl+Alt+7",
    titleZh: "转到环境配置", titleEn: "Go to Environment",
    descZh: "打开驱动、工具链和分析器状态。", descEn: "Open driver, toolchain and analyzer status.",
  },
  {
    id: "nav.upgrade", group: "nav", defaultBinding: "Ctrl+Alt+8",
    titleZh: "转到固件升级", titleEn: "Go to Firmware",
    descZh: "打开 KDock 固件包和版本升级。", descEn: "Open KDock firmware packages and version upgrade.",
  },
  {
    id: "transfer.clear", group: "tools", defaultBinding: "Ctrl+Alt+L",
    titleZh: "清空传输日志", titleEn: "Clear transfer log",
    descZh: "仅在传输页生效；同时清空界面日志和后端记录。", descEn: "Only on Transfer: clear both the visible log and backend history.",
  },
  {
    id: "transfer.focus", group: "tools", defaultBinding: "Ctrl+Alt+T",
    titleZh: "聚焦发送输入框", titleEn: "Focus send box",
    descZh: "转到传输页，并把光标放进发送输入框。", descEn: "Open Transfer and focus the send box.",
  },
  {
    id: "agent.new", group: "tools", defaultBinding: "Ctrl+Alt+N",
    titleZh: "新建 Agent 会话", titleEn: "New Agent session",
    descZh: "在当前 Agent 工作区里创建一个新会话。", descEn: "Create a new session in the current Agent workspace.",
  },
  {
    id: "agent.focus", group: "tools", defaultBinding: "Ctrl+Alt+A",
    titleZh: "聚焦 Agent 输入框", titleEn: "Focus Agent composer",
    descZh: "转到 Agent 页并聚焦对话输入框。", descEn: "Open Agent and focus the conversation composer.",
  },
  {
    id: "batch.nextDiff", group: "tools", defaultBinding: "F7",
    titleZh: "批量文本：下一处差异", titleEn: "Batch text: next difference",
    descZh: "仅在批量文本的比对视图已打开时生效。", descEn: "Works only while the Batch text comparison view is open.",
  },
  {
    id: "batch.prevDiff", group: "tools", defaultBinding: "Shift+F7",
    titleZh: "批量文本：上一处差异", titleEn: "Batch text: previous difference",
    descZh: "仅在批量文本的比对视图已打开时生效。", descEn: "Works only while the Batch text comparison view is open.",
  },
  {
    id: "capture.fullscreen", group: "tools", defaultBinding: "F11",
    titleZh: "屏幕共享：切换全屏", titleEn: "Screen share: toggle fullscreen",
    descZh: "仅在屏幕共享页生效；Esc 仍用于退出全屏。", descEn: "Only on Screen share; Esc still exits fullscreen.",
  },
];

const MODIFIERS = ["Ctrl", "Alt", "Shift"];
const CODE_KEYS = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
  Space: "Space", Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace",
  Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
};

/** 把多种写法统一成 Ctrl+Alt+Key 的稳定排序；空字符串表示主动停用。 */
export function normalizeShortcut(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  const found = new Set();
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "meta" || lower === "cmd") found.add("Ctrl");
    else if (lower === "alt" || lower === "option") found.add("Alt");
    else if (lower === "shift") found.add("Shift");
    else key = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!key) return "";
  return [...MODIFIERS.filter((mod) => found.has(mod)), key].join("+");
}

export function eventToShortcut(event) {
  if (!event) return "";
  const k = String(event.key || "");
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(k)) return "";
  let key = "";
  const code = String(event.code || "");
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else if (k.length === 1) key = k.toUpperCase();
  else if (/^(?:Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right))$/.test(k)) key = k;
  if (!key) return "";

  const mods = [];
  if (event.ctrlKey || event.metaKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

export function isValidShortcut(value) {
  const normalized = normalizeShortcut(value);
  if (!normalized) return true; // 空值 = 主动停用
  const parts = normalized.split("+");
  const key = parts.at(-1);
  if (!key || MODIFIERS.includes(key)) return false;
  const hasModifier = parts.some((part) => MODIFIERS.includes(part));
  const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
  const navigationKey = /^(?:Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Space)$/.test(key);
  // 普通字母/数字必须带修饰键，避免一个按键就把输入抢走。
  return hasModifier || functionKey || navigationKey;
}

export function shortcutCanRunInText(value) {
  const normalized = normalizeShortcut(value);
  if (!normalized) return false;
  const parts = normalized.split("+");
  const key = parts.at(-1);
  return parts.some((part) => part === "Ctrl" || part === "Alt") || /^F\d{1,2}$/.test(key);
}

function readCustomMap(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SHORTCUT_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const known = new Set(SHORTCUT_DEFS.map((item) => item.id));
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([id, chord]) => known.has(id) && typeof chord === "string")
        .map(([id, chord]) => [id, normalizeShortcut(chord)])
        .filter(([, chord]) => !chord || isValidShortcut(chord)),
    );
  } catch (_) {
    return {};
  }
}

function isTextEntry(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * 创建运行时分发器。handlers 的 key 与 SHORTCUT_DEFS[].id 一致。
 * canRun(id) 用于把动作限制在对应页面或上下文里。
 */
export function createShortcutManager(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const target = options.target || globalThis.document;
  const custom = readCustomMap(storage);
  const listeners = new Set();
  let suspended = false;
  let installed = false;

  const findDef = (id) => SHORTCUT_DEFS.find((item) => item.id === id);
  const bindingFor = (id) => (
    Object.prototype.hasOwnProperty.call(custom, id) ? custom[id] : (findDef(id)?.defaultBinding || "")
  );
  const save = () => {
    try { storage?.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(custom)); } catch (_) {}
    for (const fn of listeners) fn();
  };
  const conflicts = () => {
    const byBinding = new Map();
    for (const def of SHORTCUT_DEFS) {
      const chord = bindingFor(def.id);
      if (!chord) continue;
      byBinding.set(chord, [...(byBinding.get(chord) || []), def.id]);
    }
    return Object.fromEntries([...byBinding].filter(([, ids]) => ids.length > 1));
  };

  const manager = {
    defs: SHORTCUT_DEFS,
    groups: SHORTCUT_GROUPS,
    bindingFor,
    labelFor: (id) => bindingFor(id) || "—",
    hasCustom: (id) => Object.prototype.hasOwnProperty.call(custom, id),
    customCount: () => Object.keys(custom).length,
    customMap: () => ({ ...custom }),
    conflicts,
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSuspended(value) { suspended = !!value; },
    setBinding(id, value) {
      const def = findDef(id);
      if (!def) return { ok: false, error: "unknown-action" };
      const chord = normalizeShortcut(value);
      if (!isValidShortcut(chord)) return { ok: false, error: "invalid" };
      if (chord) {
        const conflict = SHORTCUT_DEFS.find((item) => item.id !== id && bindingFor(item.id) === chord);
        if (conflict) return { ok: false, error: "conflict", conflict };
      }
      if (chord === def.defaultBinding) delete custom[id];
      else custom[id] = chord;
      save();
      return { ok: true, binding: chord };
    },
    reset(id) {
      if (!Object.prototype.hasOwnProperty.call(custom, id)) return false;
      delete custom[id];
      save();
      return true;
    },
    resetAll() {
      const changed = Object.keys(custom).length > 0;
      for (const key of Object.keys(custom)) delete custom[key];
      if (changed) save();
      return changed;
    },
    run(id) {
      if (options.canRun && !options.canRun(id)) return false;
      const handler = options.handlers?.[id];
      if (typeof handler !== "function") return false;
      handler();
      return true;
    },
    handleEvent(event) {
      if (suspended || event?.isComposing || event?.repeat) return false;
      const chord = eventToShortcut(event);
      if (!chord) return false;
      const def = SHORTCUT_DEFS.find((item) => {
        const binding = bindingFor(item.id);
        return binding && binding === chord;
      });
      if (!def) return false;
      if (isTextEntry(event.target) && !shortcutCanRunInText(chord)) return false;
      if (options.canRun && !options.canRun(def.id)) return false;
      const handler = options.handlers?.[def.id];
      if (typeof handler !== "function") return false;
      event.preventDefault();
      event.stopPropagation();
      handler();
      return true;
    },
    install() {
      if (installed || !target?.addEventListener) return;
      target.addEventListener("keydown", manager.handleEvent);
      installed = true;
    },
    destroy() {
      if (installed && target?.removeEventListener) target.removeEventListener("keydown", manager.handleEvent);
      installed = false;
      listeners.clear();
    },
  };
  return manager;
}

/**
 * 设置 → 快捷键。root 是 setpane 容器；会自己创建搜索框、分组和录制交互。
 */
export function mountShortcutSettings({ root, manager, getLang }) {
  if (!root || !manager) throw new Error("mountShortcutSettings needs root and manager");
  const lang = () => (typeof getLang === "function" ? getLang() : "zh");
  const pick = (zh, en) => (lang() === "en" ? en : zh);
  let query = "";
  let recording = null;
  let message = null;
  let messageTone = "";

  root.innerHTML = `
    <div class="sc-toolbar">
      <input class="dirinput sc-search" type="search" autocomplete="off" />
      <span class="grow"></span>
      <span class="sc-custom-count"></span>
      <button type="button" class="btn small sc-reset-all"></button>
    </div>
    <div class="sc-summary"></div>
    <div class="sc-message" role="status" aria-live="polite"></div>
    <div class="sc-groups"></div>
    <p class="hint sc-footnote"></p>
  `;
  const search = root.querySelector(".sc-search");
  const resetAll = root.querySelector(".sc-reset-all");
  const groups = root.querySelector(".sc-groups");
  const messageEl = root.querySelector(".sc-message");
  const countEl = root.querySelector(".sc-custom-count");

  const setMessage = (text, tone = "") => {
    message = text;
    messageTone = tone;
    messageEl.textContent = text;
    messageEl.className = "sc-message" + (tone ? " " + tone : "");
  };
  const stopRecording = () => {
    if (recording) window.removeEventListener("keydown", onRecordKey, true);
    recording = null;
    manager.setSuspended(false);
  };
  const onRecordKey = (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      setMessage(pick("已取消录制", "Recording cancelled"));
      stopRecording();
      render();
      return;
    }
    const chord = eventToShortcut(event);
    if (!chord) return;
    const disabling = !event.ctrlKey && !event.altKey && !event.shiftKey &&
      (event.key === "Backspace" || event.key === "Delete");
    const result = manager.setBinding(recording.id, disabling ? "" : chord);
    if (!result.ok) {
      if (result.error === "conflict") {
        const other = result.conflict;
        setMessage(
          pick(`与「${other.titleZh}」冲突（${manager.labelFor(other.id)}），未保存`,
            `Conflicts with “${other.titleEn}” (${manager.labelFor(other.id)}); not saved`),
          "err",
        );
      } else {
        setMessage(pick("这个组合键不能用于全局动作，请加 Ctrl 或 Alt", "This key needs Ctrl or Alt for a global action"), "err");
      }
      stopRecording();
      render();
      return;
    }
    setMessage(
      disabling
        ? pick("已停用这个动作的快捷键", "Shortcut disabled")
        : pick(`已保存 ${result.binding}`, `Saved ${result.binding}`),
      "ok",
    );
    stopRecording();
    render();
  };
  const startRecording = (def, button) => {
    stopRecording();
    recording = { id: def.id };
    manager.setSuspended(true);
    button.textContent = pick("按下组合键…", "Press shortcut…");
    button.classList.add("recording");
    button.focus();
    setMessage(pick("按 Esc 取消；按 Backspace / Delete 停用", "Press Esc to cancel; Backspace / Delete disables"), "recording");
    window.addEventListener("keydown", onRecordKey, true);
  };

  const makeRow = (def) => {
    const row = document.createElement("div");
    row.className = "sc-action";
    row.dataset.action = def.id;
    const copy = document.createElement("div");
    copy.className = "sc-action-copy";
    const title = document.createElement("b");
    title.textContent = lang() === "en" ? def.titleEn : def.titleZh;
    const desc = document.createElement("span");
    desc.textContent = lang() === "en" ? def.descEn : def.descZh;
    copy.append(title, desc);

    const bindingWrap = document.createElement("div");
    bindingWrap.className = "sc-binding";
    const key = document.createElement("button");
    key.type = "button";
    key.className = "shortcutkey";
    key.textContent = manager.labelFor(def.id);
    key.title = pick("点击后按下新的组合键", "Click, then press a new shortcut");
    key.addEventListener("click", () => startRecording(def, key));
    const defLabel = document.createElement("span");
    defLabel.className = "sc-default";
    const customized = manager.hasCustom(def.id);
    defLabel.textContent = customized
      ? pick(`默认 ${def.defaultBinding}`, `Default ${def.defaultBinding}`)
      : pick("默认", "Default");
    bindingWrap.append(key, defLabel);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn tiny sc-reset";
    reset.textContent = pick("恢复", "Reset");
    reset.disabled = !customized;
    reset.addEventListener("click", () => {
      manager.reset(def.id);
      setMessage(pick("已恢复默认快捷键", "Default shortcut restored"), "ok");
      render();
    });
    row.append(copy, bindingWrap, reset);
    return row;
  };

  function render() {
    if (recording) stopRecording();
    search.placeholder = pick("搜索动作、说明或组合键", "Search actions, descriptions or shortcuts");
    resetAll.textContent = pick("全部恢复默认", "Reset all");
    resetAll.disabled = manager.customCount() === 0;
    countEl.textContent = manager.customCount()
      ? pick(`${manager.customCount()} 项已自定义`, `${manager.customCount()} customized`)
      : pick("全部为默认值", "All defaults");
    root.querySelector(".sc-summary").textContent = pick(
      `${manager.defs.length} 个可配置动作。录制新组合键后立即生效；同一个组合键不能绑定两个动作。`,
      `${manager.defs.length} configurable actions. New shortcuts apply immediately; one chord cannot run two actions.`,
    );
    root.querySelector(".sc-footnote").textContent = pick(
      "导航默认使用 Ctrl+Alt+数字。为避免误触，普通字母或数字必须搭配 Ctrl / Alt；F1、F7、F11 等功能键可以单独使用。",
      "Navigation defaults use Ctrl+Alt+numbers. Plain letters/numbers require Ctrl or Alt; function keys such as F1, F7 and F11 may be used alone.",
    );
    if (message) setMessage(message, messageTone);
    groups.replaceChildren();
    const q = query.trim().toLowerCase();
    let visible = 0;
    for (const group of manager.groups) {
      const matches = manager.defs.filter((def) => {
        if (def.group !== group.id) return false;
        if (!q) return true;
        const title = `${def.titleZh} ${def.titleEn}`.toLowerCase();
        const desc = `${def.descZh} ${def.descEn}`.toLowerCase();
        return title.includes(q) || desc.includes(q) || manager.labelFor(def.id).toLowerCase().includes(q);
      });
      if (!matches.length) continue;
      visible += matches.length;
      const section = document.createElement("section");
      section.className = "sc-group";
      const heading = document.createElement("div");
      heading.className = "sc-group-title";
      heading.textContent = lang() === "en" ? group.titleEn : group.titleZh;
      section.appendChild(heading);
      for (const def of matches) section.appendChild(makeRow(def));
      groups.appendChild(section);
    }
    if (!visible) {
      const empty = document.createElement("div");
      empty.className = "sc-empty";
      empty.textContent = pick("没有匹配的动作", "No matching actions");
      groups.appendChild(empty);
    }
    root.dataset.shortcutsReady = "1";
  }

  search.addEventListener("input", () => {
    query = search.value;
    render();
    search.focus();
  });
  resetAll.addEventListener("click", () => {
    manager.resetAll();
    setMessage(pick("全部快捷键已恢复默认", "All shortcuts restored to defaults"), "ok");
    render();
  });
  render();
  return {
    refresh: render,
    destroy() {
      stopRecording();
      root.replaceChildren();
    },
  };
}
