export function transferBytes(hex, text = "") {
  const pairs = String(hex || "").match(/[0-9A-Fa-f]{2}/g);
  if (pairs?.length) return pairs.map((pair) => Number.parseInt(pair, 16));
  if (!text) return [];
  return [...new TextEncoder().encode(String(text))];
}

export function formatHexDump(hex, options = {}) {
  const bytes = transferBytes(hex, options.text);
  const perLine = Math.max(1, Number(options.bytesPerLine) || 16);
  const startOffset = Math.max(0, Number(options.offset) || 0);
  const lines = [];
  for (let at = 0; at < bytes.length; at += perLine) {
    const row = bytes.slice(at, at + perLine);
    const hexPart = row.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    const ascii = row.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    const offset = (startOffset + at).toString(16).padStart(8, "0").toUpperCase();
    lines.push(`${offset}  ${hexPart.padEnd(perLine * 3 - 1)}  |${ascii}|`);
  }
  return lines;
}

export function joinTransferHex(...hexes) {
  return hexes
    .filter(Boolean)
    .flatMap((hex) => String(hex).match(/[0-9A-Fa-f]{2}/g) || [])
    .map((part) => part.toUpperCase())
    .join(" ");
}

/**
 * Live events must never move backward relative to an earlier live event.
 * Loaded/replayed history bypasses this guard and keeps its recorded stamps.
 */
export function createLiveTimestampGuard(now = Date.now) {
  let last = 0;
  return (requested) => {
    const value = Number(requested);
    const safe = Number.isFinite(value) && value > 0 ? Math.trunc(value) : now();
    last = Math.max(last, safe);
    return last;
  };
}

export function appendAsciiTxEntry(entries, entry) {
  const last = entries[entries.length - 1];
  const canMerge = last
    && last.dir === "TX"
    && last.interactive
    && !/[\r\n\u0003]$/.test(last.text || "");
  if (!canMerge) {
    entries.push(entry);
    return false;
  }
  last.text = String(last.text || "") + String(entry.text || "");
  last.hex = joinTransferHex(last.hex, entry.hex);
  last.ascii = String(last.ascii || "") + String(entry.ascii || "");
  last.ts_ms = Math.max(Number(last.ts_ms) || 0, Number(entry.ts_ms) || 0);
  return true;
}

export function removeTransferEntry(entries, target) {
  const index = entries.indexOf(target);
  if (index < 0) return false;
  entries.splice(index, 1);
  return true;
}

/**
 * A partial RX line is a real entry in the ordered stream. Later TX/RX entries
 * must be appended after it, not rendered before a global "tail" at the bottom.
 */
export function updateTransferTail({ pending, buffer, tail, partial, nextNo }) {
  if (!partial) {
    if (tail) {
      removeTransferEntry(pending, tail);
      removeTransferEntry(buffer, tail);
    }
    return null;
  }
  if (tail) {
    Object.assign(tail, partial);
    return tail;
  }
  const entry = {
    dir: "RX",
    ...partial,
    partial: true,
    no: typeof nextNo === "function" ? nextNo() : partial.no,
  };
  pending.push(entry);
  return entry;
}

/** Replace a partial line in place so its original position in the stream is kept. */
export function completeTransferTail({ pending, buffer, tail, entry }) {
  if (!tail) {
    pending.push(entry);
    return entry;
  }
  if (entry.no == null) entry.no = tail.no;
  for (const entries of [pending, buffer]) {
    const index = entries.indexOf(tail);
    if (index >= 0) {
      entries[index] = entry;
      return entry;
    }
  }
  pending.push(entry);
  return entry;
}

export function clearTransferEntries(pending, buffer) {
  pending.length = 0;
  buffer.length = 0;
}
