const ARROWS = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
};

const TILDE_KEYS = {
  Insert: "2",
  Delete: "3",
  PageUp: "5",
  PageDown: "6",
  F5: "15",
  F6: "17",
  F7: "18",
  F8: "19",
  F9: "20",
  F10: "21",
  F11: "23",
  F12: "24",
};

const FUNCTION_KEYS = { F1: "P", F2: "Q", F3: "R", F4: "S" };

function modifierNumber({ shiftKey = false, altKey = false, ctrlKey = false }) {
  return 1 + Number(shiftKey) + Number(altKey) * 2 + Number(ctrlKey) * 4;
}

function modified(final, modifier, base = "") {
  if (modifier === 1) return base ? `\u001b[${base}${final}` : `\u001b[${final}`;
  return base ? `\u001b[${base};${modifier}${final}` : `\u001b[1;${modifier}${final}`;
}

function controlByte(key) {
  if (key === " " || key === "@") return 0x00;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0) - 64;
  return { "[": 0x1b, "\\": 0x1c, "]": 0x1d, "^": 0x1e, "_": 0x1f, "?": 0x7f }[key] ?? null;
}

/**
 * Translate a browser KeyboardEvent-shaped object into the byte sequence sent
 * by xterm-family clients. This intentionally only maps keys; line history and
 * focus remain UI concerns.
 */
export function terminalKeySequence(event, modes = {}) {
  const {
    key = "",
    ctrlKey = false,
    altKey = false,
    shiftKey = false,
    metaKey = false,
  } = event || {};
  if (metaKey) return "";

  if (ARROWS[key]) {
    const suffix = ARROWS[key];
    const modifier = modifierNumber({ shiftKey, altKey, ctrlKey });
    if (modifier !== 1) return modified(suffix, modifier);
    return modes.applicationCursor ? `\u001bO${suffix}` : `\u001b[${suffix}`;
  }

  if (key === "Home" || key === "End") {
    const suffix = key === "Home" ? "H" : "F";
    const modifier = modifierNumber({ shiftKey, altKey, ctrlKey });
    if (modifier !== 1) return modified(suffix, modifier);
    return modes.applicationCursor ? `\u001bO${suffix}` : `\u001b[${suffix}`;
  }

  if (TILDE_KEYS[key]) {
    return modified("~", modifierNumber({ shiftKey, altKey, ctrlKey }), TILDE_KEYS[key]);
  }

  if (FUNCTION_KEYS[key]) {
    const modifier = modifierNumber({ shiftKey, altKey, ctrlKey });
    return modifier === 1
      ? `\u001bO${FUNCTION_KEYS[key]}`
      : modified(FUNCTION_KEYS[key], modifier);
  }

  if (key === "Tab") return shiftKey ? "\u001b[Z" : "\t";
  if (key === "Enter") return "\r";
  if (key === "Backspace") return "\b";
  if (key === "Escape") return "\u001b";

  if (key.length !== 1) return "";

  let out = key;
  if (ctrlKey) {
    const byte = controlByte(key);
    if (byte == null) return "";
    out = String.fromCharCode(byte);
  }
  if (altKey) out = `\u001b${out}`;
  return out;
}

export function terminalPastePayload(text, modes = {}) {
  const value = String(text || "");
  if (!value) return "";
  return modes.bracketedPaste
    ? `\u001b[200~${value}\u001b[201~`
    : value;
}
