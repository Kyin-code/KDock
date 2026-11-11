import { shouldOfferUpdate, updateRemindAt, updateSuppressionReason } from "./app-update.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createAppUpdateController({
  invoke,
  showPrompt,
  toast,
  translate,
  storage = localStorage,
}) {
  let busy = false;

  function setStatus(text, error = false) {
    const el = document.getElementById("set-update-status");
    if (!el) return;
    el.textContent = text || "";
    el.title = text || "";
    el.style.color = error ? "hsl(var(--destructive))" : "";
  }

  function paintSaved() {
    const lastError = storage.getItem("kdock_update_last_error") || "";
    const lastCheck = Number(storage.getItem("kdock_update_last_check") || 0);
    if (lastError) setStatus(`${translate("更新检查失败：")}${lastError}`, true);
    else if (lastCheck > 0) setStatus(`${translate("上次检查：")}${new Date(lastCheck).toLocaleString()}`);
    else setStatus(translate("启动后自动检查，也可手动检查"));
  }

  async function check(manual = false) {
    if (busy) {
      if (manual) toast(translate("正在检查更新…"));
      return false;
    }
    busy = true;
    const button = document.getElementById("set-check-update");
    if (button) button.disabled = true;
    if (manual) setStatus(translate("正在检查更新…"));
    try {
      const attempts = manual ? 1 : 3;
      const retryDelays = [0, 2500, 6000];
      let info = null;
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (retryDelays[attempt]) {
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        }
        try {
          info = await invoke("app_update_check");
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts) {
            setStatus(translate("更新清单同步中，正在重试…"));
          }
        }
      }
      if (!info) throw lastError || new Error("update check failed");
      storage.setItem("kdock_update_last_check", String(Date.now()));
      storage.removeItem("kdock_update_last_error");
      if (info?.available) {
        const latestBuild = String(info.latestBuild || "").slice(0, 7);
        const version = `v${info.latestVersion}${latestBuild ? ` (${latestBuild})` : ""}`;
        const now = Date.now();
        const reason = updateSuppressionReason(info, now, storage);
        if (reason === "skipped") {
          setStatus(`${translate("发现新版本")} ${version} · ${translate("此版本已跳过")}`);
        } else if (reason === "deferred") {
          const until = updateRemindAt(info, storage);
          const text = until > 0 ? new Date(until).toLocaleString() : "";
          setStatus(`${translate("发现新版本")} ${version} · ${translate("已选择稍后")}${text ? `：${text}` : ""}`);
        } else {
          setStatus(`${translate("发现新版本")} ${version}`);
        }
        if (manual || shouldOfferUpdate(info, now, storage)) showPrompt(info);
      } else {
        const version = info?.latestVersion ? ` v${info.latestVersion}` : "";
        setStatus(`${translate("已是最新版本")}${version}`);
        if (manual) toast(`${translate("已是最新版本")}${version}`);
      }
      return true;
    } catch (error) {
      const message = String(error);
      storage.setItem("kdock_update_last_check", String(Date.now()));
      storage.setItem("kdock_update_last_error", message);
      setStatus(`${translate("更新检查失败：")}${message}`, true);
      console.warn("[update] check failed:", message);
      if (manual) toast(`${translate("更新检查失败：")}${message}`);
      return false;
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  window.addEventListener("online", () => check(false));
  setInterval(() => {
    if (!document.hidden) check(false);
  }, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const last = Number(storage.getItem("kdock_update_last_check") || 0);
    if (!last || Date.now() - last >= CHECK_INTERVAL_MS) check(false);
  });

  return { check, paintSaved };
}
