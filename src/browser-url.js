/** Address-bar normalization shared by the UI and its executable unit tests. */
export function normalizeBrowserUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw;
}

export function isWebBrowserUrl(input) {
  try {
    const url = new URL(normalizeBrowserUrl(input));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}
