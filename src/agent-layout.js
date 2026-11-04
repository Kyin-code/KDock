export const AGENT_CHAT_MIN = 140;
export const AGENT_INPUT_MIN = 180;
export const AGENT_INPUT_DEFAULT = 220;

const AGENT_INPUT_KEY = "kdock_agent_input_h";
const LEGACY_CHAT_KEY = "kdock_agent_chat_h";

export function clampAgentInputHeight(inputHeight, availableHeight) {
  const max = Math.max(AGENT_INPUT_MIN, availableHeight - AGENT_CHAT_MIN);
  return Math.round(Math.max(AGENT_INPUT_MIN, Math.min(inputHeight, max)));
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
  if (!grip || !box || !inputPane || !workpane) return;

  // The old implementation persisted an unbounded conversation height. It can
  // leave the composer outside the window, so discard that value exactly once.
  storage.removeItem(LEGACY_CHAT_KEY);

  const apply = (height) => {
    inputPane.style.flex = `0 1 ${Math.round(height)}px`;
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
}
