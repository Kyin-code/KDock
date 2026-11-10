import { invoke } from "@tauri-apps/api/core";

const COMMANDS = [
  {
    cmd: "goal",
    zh: "设定长期目标并开始执行",
    en: "Set a persistent goal and start working",
  },
  { cmd: "compact", zh: "压缩当前上下文", en: "Compact the current context" },
  { cmd: "new", zh: "新建会话", en: "Start a new session" },
  { cmd: "model", zh: "查看或切换模型", en: "View or switch models" },
  {
    cmd: "perm",
    zh: "切换权限：只读 / 需要批准 / 自动",
    en: "Switch permission: read-only / ask / auto",
  },
  { cmd: "stop", zh: "停止当前轮", en: "Stop the current turn" },
  { cmd: "rename", zh: "重命名当前会话", en: "Rename the current session" },
  { cmd: "skills", zh: "列出已启用技能", en: "List enabled skills" },
  { cmd: "timer", zh: "创建倒计时任务", en: "Create a countdown task" },
  { cmd: "at", zh: "创建定时任务", en: "Create a scheduled task" },
  { cmd: "help", zh: "查看全部命令", en: "Show all commands" },
];

let shared = null;

export function bindAgentComposer(deps) {
  if (shared) return shared;
  const {
    en, toast, confirm, getMeta, getSessions, getLang, newSession,
    updateHeader, sendText, sendPendingNow, uiScale, setGoal,
  } = deps;
  const el = (id) => document.getElementById(id);
  const l = (zh, english) => (getLang() === "en" ? english : zh);
  let custom = [];
  let matches = [];
  let active = 0;

  const syncPolicy = () => {
    const hint = el("ag-policy-hint");
    if (!hint) return;
    const meta = getMeta();
    const perm = (meta && meta.perm) || "ask";
    const mode = (meta && meta.sandbox_mode) || "workspace";
    const workspaceNet = !!(meta && meta.sandbox_network);
    const trusted = mode === "trusted";
    const network = trusted || workspaceNet;
    const permText = perm === "read" ? en("只读") : perm === "auto" ? en("自动") : en("需要批准");
    const sandboxText = trusted ? en("宿主权限") : workspaceNet ? en("工作区+网络") : en("工作区");
    const level = trusted || perm === "auto" ? "danger" : perm === "ask" || workspaceNet ? "ask" : "safe";
    hint.hidden = !meta;
    hint.dataset.level = level;
    hint.textContent = `${level === "danger" ? "⚠ " : ""}${en("权限")}：${permText} · ${en("沙箱")}：${sandboxText} · ${en("网络")}：${network ? en("允许") : en("禁止")}`;
    hint.title = level === "danger"
      ? l("高风险：危险动作可能自动执行或直接访问宿主环境", "High risk: risky tools may run automatically or access the host directly")
      : level === "ask"
        ? l("危险动作执行前会请求批准", "Risky tools ask for approval before running")
        : l("当前为低风险只读或断网工作区", "Current policy is low-risk read-only or an offline workspace");
    const permWrap = el("ag-perm-wrap");
    const sandboxWrap = el("ag-sandbox-wrap");
    if (permWrap) permWrap.dataset.level = perm === "auto" ? "danger" : perm === "ask" ? "ask" : "safe";
    if (sandboxWrap) sandboxWrap.dataset.level = trusted ? "danger" : workspaceNet ? "ask" : "safe";
    const permSelect = el("ag-perm");
    const sandboxSelect = el("ag-sandbox");
    if (permSelect) permSelect.value = perm;
    if (sandboxSelect) sandboxSelect.value = trusted ? "trusted" : workspaceNet ? "workspace-net" : "workspace";
  };

  const resizeGoal = () => {
    const text = el("ag-goal-text");
    if (!text) return;
    const expanded = el("ag-goal-card")?.classList.contains("expanded");
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight, expanded ? 210 : 88) + "px";
  };

  const syncGoal = (force = false) => {
    const card = el("ag-goal-card");
    const text = el("ag-goal-text");
    const count = el("ag-goal-count");
    const meta = getMeta();
    const goal = String((meta && meta.goal) || "");
    if (!card || !text) return;
    card.hidden = !goal;
    if (goal && (force || document.activeElement !== text)) text.value = goal;
    if (count) count.textContent = goal ? `${goal.length} ${en("字")}` : "";
    resizeGoal();
  };

  const saveGoal = async (goal, { run = false } = {}) => {
    let meta = getMeta();
    if (!meta) {
      await newSession();
      meta = getMeta();
      if (!meta) return false;
    }
    const value = String(goal || "").trim();
    try {
      const result = setGoal
        ? await setGoal(meta.id, value)
        : await invoke("agent_session_set_goal", { id: meta.id, goal: value });
      meta.goal = result.goal || "";
      const cached = (getSessions() || []).find((item) => item.id === meta.id);
      if (cached) cached.goal = meta.goal;
      syncGoal(true);
      updateHeader();
      if (run && meta.goal) await sendText("开始执行当前目标。");
      return true;
    } catch (error) {
      toast(String(error));
      return false;
    }
  };

  const hideSlash = () => {
    const pop = el("ag-cmd-hint");
    if (pop) pop.hidden = true;
  };

  const positionSlash = () => {
    const pop = el("ag-cmd-hint");
    const input = el("ag-input");
    const host = input && input.closest('.workpane[data-work="agent"]');
    if (!pop || !input || !host || pop.hidden) return;
    const hr = host.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    const scale = uiScale();
    pop.style.left = `${(ir.left - hr.left) / scale}px`;
    pop.style.width = `${ir.width / scale}px`;
    pop.style.bottom = `${(hr.bottom - ir.top) / scale + 6}px`;
  };

  const refreshSlash = () => {
    const pop = el("ag-cmd-hint");
    const input = el("ag-input");
    if (!pop || !input) return;
    const raw = input.value;
    const body = raw.startsWith("/") ? raw.slice(1) : "";
    if (!raw.startsWith("/") || /\s/.test(body)) {
      hideSlash();
      return;
    }
    const query = body.toLowerCase();
    const all = [
      ...COMMANDS,
      ...custom.map((item) => ({
        cmd: item.name,
        zh: item.description || "自定义指令",
        en: item.description || "Custom command",
      })),
    ];
    matches = all.filter((item) => item.cmd.toLowerCase().startsWith(query)).slice(0, 10);
    active = Math.min(active, Math.max(0, matches.length - 1));
    pop.innerHTML = "";
    pop.hidden = matches.length === 0;
    matches.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "agcmdrow" + (index === active ? " active" : "");
      const name = document.createElement("span");
      name.className = "agcmdname";
      name.textContent = "/" + item.cmd;
      const desc = document.createElement("span");
      desc.className = "agcmddesc";
      desc.textContent = getLang() === "en" ? item.en : item.zh;
      row.append(name, desc);
      row.onpointerdown = (event) => event.preventDefault();
      row.onclick = () => chooseSlash(index);
      pop.appendChild(row);
    });
    requestAnimationFrame(positionSlash);
  };

  const chooseSlash = (index = active) => {
    const item = matches[index];
    const input = el("ag-input");
    if (!item || !input) return;
    input.value = "/" + item.cmd + " ";
    hideSlash();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const handleKey = (event) => {
    const pop = el("ag-cmd-hint");
    const open = pop && !pop.hidden && matches.length > 0;
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      refreshSlash();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideSlash();
      return true;
    }
    if (!event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      chooseSlash();
      return true;
    }
    return false;
  };

  const renderPending = (rows, busy) => {
    const box = el("ag-pending");
    if (!box) return;
    const wasOpen = !!box.querySelector(".agpending-wrap")?.open;
    box.innerHTML = "";
    box.hidden = rows.length === 0;
    if (!rows.length) return;
    const wrap = document.createElement("details");
    wrap.className = "agpending-wrap";
    wrap.open = wasOpen;
    const summary = document.createElement("summary");
    summary.className = "agpending-summary";
    const preview = String(rows[rows.length - 1] || "").replace(/\s+/g, " ").trim();
    const label = document.createElement("span");
    label.className = "agpending-summary-text";
    label.textContent = `${en("待发送")}：${preview}`;
    const count = document.createElement("span");
    count.className = "agpending-count";
    count.textContent = String(rows.length);
    summary.append(label, count);
    wrap.appendChild(summary);
    const body = document.createElement("div");
    body.className = "agpending-body";
    for (const text of rows) {
      const row = document.createElement("div");
      row.className = "agpending-item";
      const textEl = document.createElement("span");
      textEl.className = "agpending-text";
      textEl.textContent = text;
      row.appendChild(textEl);
      body.appendChild(row);
    }
    const guide = document.createElement("div");
    guide.className = "agpending-guide";
    const hint = document.createElement("span");
    hint.textContent = en("下一步自动并入；也可以现在发送");
    const sendNow = document.createElement("button");
    sendNow.className = "btn small primary";
    sendNow.textContent = en(busy ? "正在中断…" : "全部立即发送");
    sendNow.title = en("停止当前轮，立即发送待发送区的全部内容");
    sendNow.disabled = busy;
    sendNow.onclick = () => sendPendingNow();
    guide.append(hint, sendNow);
    body.appendChild(guide);
    wrap.appendChild(body);
    box.appendChild(wrap);
  };

  const init = () => {
    el("ag-goal-text")?.addEventListener("input", () => {
      resizeGoal();
      const count = el("ag-goal-count");
      if (count) count.textContent = `${el("ag-goal-text").value.length} ${en("字")}`;
    });
    if (el("ag-goal-save")) el("ag-goal-save").onclick = () => saveGoal(el("ag-goal-text").value);
    if (el("ag-goal-run")) el("ag-goal-run").onclick = () => saveGoal(el("ag-goal-text").value, { run: true });
    if (el("ag-goal-clear")) {
      el("ag-goal-clear").onclick = async () => {
        if (await confirm(l("清除当前目标？", "Clear the current goal?"), l("清除目标", "Clear goal"))) {
          await saveGoal("");
        }
      };
    }
    if (el("ag-goal-expand")) {
      el("ag-goal-expand").onclick = () => {
        const card = el("ag-goal-card");
        card.classList.toggle("expanded");
        el("ag-goal-expand").textContent = card.classList.contains("expanded") ? l("收起", "Collapse") : l("展开", "Expand");
        resizeGoal();
      };
    }
    invoke("agent_slash_list").then((list) => {
      custom = Array.isArray(list) ? list : [];
    }).catch(() => {});
    const input = el("ag-input");
    const pop = el("ag-cmd-hint");
    const pane = document.querySelector('.workpane[data-work="agent"]');
    if (pane && pop && pop.parentElement !== pane) pane.appendChild(pop);
    input?.addEventListener("input", () => {
      active = 0;
      refreshSlash();
    });
    input?.addEventListener("blur", () => {
      setTimeout(() => {
        if (!document.activeElement?.closest?.(".aginputwrap, .agcmdpop")) hideSlash();
      }, 80);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".aginputwrap, .agcmdpop")) {
        hideSlash();
      }
    }, true);
    window.addEventListener("resize", positionSlash);
    syncGoal();
    syncPolicy();
  };

  shared = {
    syncGoal,
    syncPolicy,
    saveGoal,
    refreshSlash,
    hideSlash,
    chooseSlash,
    handleKey,
    renderPending,
    init,
  };
  return shared;
}
