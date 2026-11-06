export const ASCII_HISTORY_KEY = "kdock_ascii_history";

function normalizeEntries(entries, limit) {
  const out = [];
  for (const value of Array.isArray(entries) ? entries : []) {
    const text = typeof value === "string" ? value.replace(/[\r\n]+$/g, "") : "";
    if (!text.trim()) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.slice(-Math.max(1, limit));
}

/** Stateful Up/Down command history for the ASCII terminal. */
export function createAsciiHistory(initial = [], limit = 100) {
  const max = Math.max(1, Number(limit) || 100);
  let entries = normalizeEntries(initial, max);
  let cursor = entries.length;
  let draft = "";

  return {
    get entries() {
      return entries.slice();
    },
    get size() {
      return entries.length;
    },
    commit(text) {
      const command = String(text ?? "").replace(/[\r\n]+$/g, "");
      if (command.trim() && entries[entries.length - 1] !== command) {
        entries.push(command);
        if (entries.length > max) entries = entries.slice(-max);
      }
      cursor = entries.length;
      draft = "";
      return command;
    },
    previous(current = "") {
      if (!entries.length) return null;
      if (cursor >= entries.length) draft = String(current ?? "");
      if (cursor > 0) cursor -= 1;
      return entries[cursor];
    },
    next() {
      if (cursor >= entries.length) return null;
      cursor += 1;
      return cursor >= entries.length ? draft : entries[cursor];
    },
    reset() {
      cursor = entries.length;
      draft = "";
    },
  };
}

export function loadAsciiHistory(storage, key = ASCII_HISTORY_KEY) {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return normalizeEntries(value, 100);
  } catch (_) {
    return [];
  }
}

export function saveAsciiHistory(storage, entries, key = ASCII_HISTORY_KEY) {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(normalizeEntries(entries, 100)));
  } catch (_) {
    // A full/disabled localStorage must not break terminal input.
  }
}
