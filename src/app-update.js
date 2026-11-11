export const UPDATE_REMIND_MS = 24 * 60 * 60 * 1000;

const SKIP_KEY = "kdock_update_skip";
const REMIND_KEY = "kdock_update_remind_after";

export function updateIdentity(info) {
  return `${String(info?.latestVersion || "").trim()}|${String(info?.latestBuild || "").trim()}`;
}

function remindKey(info) {
  return `${REMIND_KEY}:${updateIdentity(info)}`;
}

export function updateRemindAt(info, storage = localStorage) {
  return Number(storage.getItem(remindKey(info)) || 0);
}

export function updateSuppressionReason(info, now = Date.now(), storage = localStorage) {
  if (!info || info.available !== true) return "";
  if (storage.getItem(SKIP_KEY) === updateIdentity(info)) return "skipped";
  const until = updateRemindAt(info, storage);
  return until > now ? "deferred" : "";
}

export function shouldOfferUpdate(info, now = Date.now(), storage = localStorage) {
  return info?.available === true && !updateSuppressionReason(info, now, storage);
}

export function skipUpdate(info, storage = localStorage) {
  storage.setItem(SKIP_KEY, updateIdentity(info));
  storage.removeItem(remindKey(info));
}

export function remindUpdateLater(info, now = Date.now(), storage = localStorage) {
  storage.setItem(remindKey(info), String(now + UPDATE_REMIND_MS));
}
