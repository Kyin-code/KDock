export const AGENT_CHAT_MIN = 140;
export const AGENT_INPUT_MIN = 180;
export const AGENT_INPUT_DEFAULT = 320;

const AGENT_INPUT_KEY = "kdock_agent_input_h";
const LEGACY_CHAT_KEY = "kdock_agent_chat_h";

export function clampAgentInputHeight(inputHeight, availableHeight) {
  const max = Math.max(AGENT_INPUT_MIN, availableHeight - AGENT_CHAT_MIN);
  return Math.round(Math.max(AGENT_INPUT_MIN, Math.min(inputHeight, max)));
}

/** Remember the first visible message and its screen position across a layout
 *  change. Expanding the workspace when the inspector closes makes message
 *  bubbles reflow; without an explicit anchor the browser can scroll the
 *  conversation to a different message, which looks like the output jumped. */
export function captureAgentChatAnchor(doc = document) {
  const chat = doc.getElementById("ag-chat");
  if (!chat || chat.getBoundingClientRect().height <= 0) return null;
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 2;
  const children = [...chat.children];
  if (atBottom) return { atBottom: true, scrollTop: chat.scrollTop };
  const viewTop = chat.getBoundingClientRect().top;
  const index = children.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewTop + 1;
  });
  if (index < 0) return { atBottom: false, index: -1, scrollTop: chat.scrollTop, top: 0 };
  return {
    atBottom: false,
    index,
    scrollTop: chat.scrollTop,
    top: children[index].getBoundingClientRect().top,
  };
}

export function restoreAgentChatAnchor(anchor, doc = document) {
  if (!anchor) return;
  const chat = doc.getElementById("ag-chat");
  if (!chat) return;
  if (anchor.atBottom) {
    chat.scrollTop = chat.scrollHeight;
    return;
  }
  const element = anchor.index >= 0 ? chat.children[anchor.index] : null;
  if (!element) {
    chat.scrollTop = anchor.scrollTop;
    return;
  }
  const delta = element.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > 0.5) chat.scrollTop += delta;
}

/** Resize the conversation/input split. The conversation flexes to fill what
 *  the input baseline leaves; the divider changes that baseline instead of
 *  setting the conversation to an unbounded pixel height. */
export function bindAgentResize(doc = document, storage = localStorage) {
  const grip = doc.getElementById("ag-chat-grip");
  const box = doc.getElementById("ag-box");
  const inputPane = grip?.nextElementSibling?.classList.contains("inpane")
    ? grip.nextElementSibling
    : null;
  const workpane = box?.closest('.workpane[data-work="agent"]');
  const split = workpane?.closest(".split");
  if (!grip || !box || !inputPane || !workpane) return;

  // The old implementation persisted an unbounded conversation height. It can
  // leave the composer outside the window, so discard that value exactly once.
  storage.removeItem(LEGACY_CHAT_KEY);

  const apply = (height) => {
    const rounded = Math.round(height);
    inputPane.style.flex = `0 1 ${rounded}px`;
    split?.style.setProperty("--agent-input-height", `${rounded}px`);
  };
  const saved = Number(storage.getItem(AGENT_INPUT_KEY) || 0);
  if (Number.isFinite(saved) && saved >= AGENT_INPUT_MIN) {
    apply(saved);
  } else {
    inputPane.style.removeProperty("flex");
  }

  let startY = 0;
  let startInput = 0;
  let active = false;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    startY = event.clientY;
    startInput = inputPane.getBoundingClientRect().height;
    active = true;
    grip.classList.add("dragging");
    try {
      grip.setPointerCapture(event.pointerId);
    } catch (_) {
      // Synthetic events and a few WebView2 versions do not support capture.
    }
    event.preventDefault();
  });
  grip.addEventListener("pointermove", (event) => {
    if (!active) return;
    const availableHeight = box.getBoundingClientRect().height
      + inputPane.getBoundingClientRect().height;
    const wanted = startInput - (event.clientY - startY);
    apply(clampAgentInputHeight(wanted, availableHeight));
    event.preventDefault();
  });
  const stop = () => {
    if (!active) return;
    active = false;
    grip.classList.remove("dragging");
    storage.setItem(
      AGENT_INPUT_KEY,
      String(Math.round(inputPane.getBoundingClientRect().height)),
    );
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
  grip.addEventListener("dblclick", () => {
    storage.removeItem(AGENT_INPUT_KEY);
    inputPane.style.removeProperty("flex");
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(clampSaved);
    else clampSaved();
  });

  const clampSaved = () => {
    if (workpane.getBoundingClientRect().height <= 0) return;
    const availableHeight = box.getBoundingClientRect().height
      + inputPane.getBoundingClientRect().height;
    const next = clampAgentInputHeight(
      inputPane.getBoundingClientRect().height,
      availableHeight,
    );
    apply(next);
  };
  window.addEventListener("resize", clampSaved);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(clampSaved).observe(workpane);
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(clampSaved);
  else clampSaved();
}
