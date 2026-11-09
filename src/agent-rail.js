/**
 * Build the Agent message rail and its hover preview.
 * Kept out of the initial bundle because it is only needed on the Agent page.
 */
export function buildAgentRail({ rail, box, users, userEvents }) {
  const host = rail.parentElement;
  if (!host) return;
  rail.innerHTML = "";
  host.querySelectorAll(".agrailpreview").forEach((node) => node.remove());

  const texts = userEvents.map((event) => String(event?.text || ""));
  const ticks = [];
  const items = [];
  let panel = null;
  let selected = -1;
  let showTimer = 0;
  let hideTimer = 0;

  const clearTimers = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
  };

  const jump = (index) => {
    const dom = users[index];
    if (!dom) return;
    const top = dom.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
    dom.classList.add("hl");
    setTimeout(() => dom.classList.remove("hl"), 1200);
  };

  const select = (index) => {
    if (!panel || index < 0 || index >= items.length) return;
    selected = index;
    items.forEach((item, i) => item.classList.toggle("active", i === index));
    const item = items[index];
    const list = panel.querySelector(".agrailpreview-list");
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  };

  const ensurePanel = () => {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "agrailpreview";
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-label", "用户消息");
    panel.hidden = true;
    const list = document.createElement("div");
    list.className = "agrailpreview-list";
    texts.forEach((text, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agrailpreview-item";
      item.setAttribute("role", "option");
      item.textContent = text.replace(/\s+/g, " ") || "（空消息）";
      item.onmouseenter = () => select(index);
      item.onclick = () => {
        jump(index);
        hide();
      };
      items.push(item);
      list.appendChild(item);
    });
    panel.appendChild(list);
    panel.onpointerenter = () => clearTimeout(hideTimer);
    panel.onpointerleave = scheduleHide;
    host.appendChild(panel);
    return panel;
  };

  const show = (index) => {
    clearTimers();
    const node = ensurePanel();
    select(index);
    node.hidden = false;
  };

  const scheduleShow = (index) => {
    clearTimeout(hideTimer);
    if (panel && !panel.hidden) {
      show(index);
      return;
    }
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(index), 280);
  };

  const hide = () => {
    clearTimers();
    if (panel) panel.hidden = true;
    selected = -1;
  };

  const scheduleHide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 180);
  };

  users.forEach((dom, index) => {
    const preview = String(userEvents[index]?.text || "").replace(/\s+/g, " ").slice(0, 30);
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = "tick";
    tick.setAttribute("aria-label", preview || "用户消息");
    tick.onclick = () => jump(index);
    tick.onpointerenter = () => scheduleShow(index);
    tick.onfocus = () => show(index);
    tick.onblur = scheduleHide;
    rail.appendChild(tick);
    ticks.push(tick);
  });
  rail.onpointerleave = scheduleHide;

  const updateActive = () => {
    if (!ticks.length) return;
    const cutoff = box.getBoundingClientRect().top + box.clientHeight * 0.36;
    let active = 0;
    users.forEach((dom, index) => {
      if (dom.getBoundingClientRect().top <= cutoff) active = index;
    });
    ticks.forEach((tick, index) => tick.classList.toggle("active", index === active));
    const tick = ticks[active];
    if (tick.offsetTop < rail.scrollTop) {
      rail.scrollTo({ top: tick.offsetTop, behavior: "smooth" });
    } else if (tick.offsetTop + tick.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTo({
        top: tick.offsetTop + tick.offsetHeight - rail.clientHeight,
        behavior: "smooth",
      });
    }
  };
  box.onscroll = updateActive;
  requestAnimationFrame(updateActive);
}
