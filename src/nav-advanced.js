export const ADVANCED_TABS = new Set([
  "cmds", "kb", "adb", "debug", "scope", "logic", "capture",
  "chart", "seq", "batch", "calc", "datacalc",
]);

const STORAGE_KEY = "kdock_nav_advanced_open";
let toggleEl = null;
let panelEl = null;

function refreshCount() {
  const count = document.getElementById("nav-advanced-count");
  if (!count || !panelEl) return;
  count.textContent = String(
    [...panelEl.querySelectorAll(".navitem[data-tab]")].filter((el) => !el.hidden).length,
  );
}

export function setAdvancedNavOpen(open, persist = true) {
  if (!toggleEl || !panelEl) return;
  panelEl.hidden = !open;
  toggleEl.classList.toggle("open", open);
  toggleEl.setAttribute("aria-expanded", open ? "true" : "false");
  const chev = toggleEl.querySelector(".navchev");
  if (chev) chev.textContent = open ? "▾" : "▸";
  if (persist) localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  refreshCount();
}

export function openAdvancedNavFor(tab, persist = true) {
  if (!ADVANCED_TABS.has(tab)) return;
  setAdvancedNavOpen(true, persist);
  toggleEl?.classList.add("has-active");
}

export function initAdvancedNav() {
  toggleEl = document.getElementById("nav-advanced-toggle");
  panelEl = document.getElementById("nav-advanced");
  if (!toggleEl || !panelEl) return null;
  toggleEl.onclick = () => setAdvancedNavOpen(panelEl.hidden, true);
  setAdvancedNavOpen(localStorage.getItem(STORAGE_KEY) === "1", false);
  refreshCount();
  return {
    setOpen: setAdvancedNavOpen,
    openFor: openAdvancedNavFor,
    refreshCount,
  };
}
