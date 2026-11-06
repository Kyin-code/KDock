/**
 * Small VT-style terminal model used by the ASCII interaction view.
 *
 * The model intentionally keeps completed output as scrollback. Erase-in-display
 * and erase-in-line operations only modify rows that belong to the current
 * screen, so a shell's BS + CSI J redraw cannot wipe an entire debug session.
 */

const DEFAULT_SCREEN_ROWS = 24;
const DEFAULT_TAB_STOP = 4;

export function termNew() {
  return {
    lines: [""], row: 0, col: 0, top: 0, screenRows: DEFAULT_SCREEN_ROWS,
    applicationCursor: false, bracketedPaste: false,
  };
}

function ensureRow(st, row) {
  while (st.lines.length <= row) st.lines.push("");
}

function lineAt(st, row = st.row) {
  ensureRow(st, row);
  return st.lines[row] ?? "";
}

function screenRows(st, fallback = DEFAULT_SCREEN_ROWS) {
  return Math.max(1, Number(st.screenRows) || fallback);
}

function syncScroll(st) {
  const bottom = st.top + screenRows(st) - 1;
  if (st.row > bottom) st.top = st.row - screenRows(st) + 1;
}

function eraseLine(st, mode) {
  const line = lineAt(st);
  if (mode === 2) {
    st.lines[st.row] = "";
    return;
  }
  if (mode === 1) {
    const end = Math.min(line.length, st.col + 1);
    st.lines[st.row] = " ".repeat(end) + line.slice(end);
    return;
  }
  // ECMA-48 default (0): erase the cursor cell and everything to its right.
  st.lines[st.row] = line.slice(0, st.col);
}

function eraseDisplay(st, mode, screenRows = DEFAULT_SCREEN_ROWS) {
  const top = st.top;
  if (mode === 2 || mode === 3) {
    ensureRow(st, top + screenRows - 1);
    for (let row = top; row < top + screenRows; row++) st.lines[row] = "";
    return;
  }
  if (mode === 1) {
    for (let row = top; row < st.row; row++) st.lines[row] = "";
    const line = lineAt(st);
    const end = Math.min(line.length, st.col + 1);
    st.lines[st.row] = " ".repeat(end) + line.slice(end);
    return;
  }
  // ECMA-48 default (0): erase from the cursor to the end of the display.
  // Rows above the cursor are completed scrollback and must remain untouched.
  st.lines[st.row] = lineAt(st).slice(0, st.col);
  st.lines.length = st.row + 1;
}

function eraseChars(st, count) {
  const line = lineAt(st);
  if (st.col >= line.length) return;
  const end = Math.min(line.length, st.col + count);
  const erased = line.slice(st.col, end).replace(/[^\r\n]/g, " ");
  st.lines[st.row] = line.slice(0, st.col) + erased + line.slice(end);
}

function deleteChars(st, count) {
  const line = lineAt(st);
  if (st.col >= line.length) return;
  st.lines[st.row] = line.slice(0, st.col) + line.slice(st.col + count);
}

function insertChars(st, count) {
  const line = lineAt(st);
  st.lines[st.row] = line.slice(0, st.col) + " ".repeat(count) + line.slice(st.col);
}

function param(params, index, fallback) {
  const value = params[index];
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function termPut(st, ch) {
  if (ch === "\n") {
    st.row += 1;
    st.col = 0;
    ensureRow(st, st.row);
    syncScroll(st);
    return;
  }
  if (ch === "\r") {
    st.col = 0;
    return;
  }
  if (ch === "\b") {
    if (st.col > 0) st.col -= 1;
    return;
  }
  if (ch === "\t") {
    const n = DEFAULT_TAB_STOP - (st.col % DEFAULT_TAB_STOP);
    for (let i = 0; i < n; i++) termPut(st, " ");
    return;
  }
  if (ch < " ") return;

  const line = lineAt(st);
  st.lines[st.row] = st.col < line.length
    ? line.slice(0, st.col) + ch + line.slice(st.col + 1)
    : line + " ".repeat(st.col - line.length) + ch;
  st.col += 1;
}

export function termFeed(st, text, options = {}) {
  const screenRows = Math.max(1, Number(options.screenRows) || DEFAULT_SCREEN_ROWS);
  st.screenRows = screenRows;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\u001b") {
      termPut(st, ch);
      i += 1;
      continue;
    }

    const rest = text.slice(i);
    // OSC (window title etc.): consume the whole sequence.
    const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/.exec(rest);
    if (osc) {
      i += osc[0].length;
      continue;
    }

    // CSI supports an empty parameter list and private/intermediate bytes.
    const m = /^\u001b\[([0-9;?><!]*)[ -/]*([@-~])/.exec(rest);
    if (!m) {
      // A bare ESC is not printable. If it starts an incomplete CSI, leave the
      // incomplete bytes unrendered as well.
      i += 1;
      continue;
    }

    const privateSeq = /[?><!]/.test(m[1]);
    const params = m[1] === "" ? [] : m[1].split(";").map((p) => Number.parseInt(p, 10) || 0);
    const n = param(params, 0, 1);
    if (privateSeq) {
      if (m[2] === "h" || m[2] === "l") {
        const enabled = m[2] === "h";
        for (const mode of m[1].replace(/[?><!]/g, "").split(";").map(Number)) {
          if (mode === 1) st.applicationCursor = enabled;
          else if (mode === 2004) st.bracketedPaste = enabled;
        }
      }
    } else {
      switch (m[2]) {
        case "A":
          st.row = Math.max(st.top, st.row - n);
          break;
        case "B":
          st.row = Math.min(st.top + screenRows - 1, st.row + n);
          ensureRow(st, st.row);
          break;
        case "C":
          st.col += n;
          break;
        case "D":
          st.col = Math.max(0, st.col - n);
          break;
        case "E":
          st.row = Math.min(st.top + screenRows - 1, st.row + n);
          st.col = 0;
          ensureRow(st, st.row);
          break;
        case "F":
          st.row = Math.max(st.top, st.row - n);
          st.col = 0;
          break;
        case "G":
          st.col = Math.max(0, n - 1);
          break;
        case "H":
        case "f":
          st.row = st.top + Math.max(0, param(params, 0, 1) - 1);
          st.col = Math.max(0, param(params, 1, 1) - 1);
          ensureRow(st, st.row);
          break;
        case "J":
          eraseDisplay(st, params[0] ?? 0, screenRows);
          break;
        case "K":
          eraseLine(st, params[0] ?? 0);
          break;
        case "P":
          deleteChars(st, n);
          break;
        case "X":
          eraseChars(st, n);
          break;
        case "@":
          insertChars(st, n);
          break;
        case "d":
          st.row = st.top + Math.max(0, n - 1);
          ensureRow(st, st.row);
          break;
        default:
          // SGR, cursor visibility, paste modes, device reports, etc. do not
          // alter the text grid.
          break;
      }
    }
    i += m[0].length;
  }
}

export function termText(st, maxLines = 1000) {
  return st.lines.slice(-Math.max(1, maxLines)).join("\n");
}

export function termModes(st) {
  return {
    applicationCursor: !!st.applicationCursor,
    bracketedPaste: !!st.bracketedPaste,
  };
}
