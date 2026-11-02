export const UPDATE_REMIND_MS = 24 * 60 * 60 * 1000;

const SKIP_KEY = "kdock_update_skip";
const REMIND_KEY = "kdock_update_remind_after";

export function updateIdentity(info) {
  return `${String(info?.latestVersion || "").trim()}|${String(info?.latestBuild || "").trim()}`;
}

export function shouldOfferUpdate(info, now = Date.now(), storage = localStorage) {
  if (!info || info.available !== true) return false;
  if (storage.getItem(SKIP_KEY) === updateIdentity(info)) return false;
  return Number(storage.getItem(REMIND_KEY) || 0) <= now;
}

export function skipUpdate(info, storage = localStorage) {
  storage.setItem(SKIP_KEY, updateIdentity(info));
  storage.removeItem(REMIND_KEY);
}

export function remindUpdateLater(info, now = Date.now(), storage = localStorage) {
  storage.setItem(REMIND_KEY, String(now + UPDATE_REMIND_MS));
}
