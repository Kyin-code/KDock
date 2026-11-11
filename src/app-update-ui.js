import { remindUpdateLater, skipUpdate, updateIdentity } from "./app-update.js";

const APP_UPDATE_READY_KEY = "kdock_update_ready";

export function createAppUpdateUi({
  invoke,
  listen,
  toast,
  translate,
  syncNativeView,
  storage = localStorage,
}) {
  let pendingAppUpdate = null;
  let pendingAppUpdateDownload = null;
  let pendingAppUpdateSilent = false;
  let appUpdateBusy = false;
  let appUpdatePhase = "idle";
  let appUpdatePercent = -1;
  let appUpdateReceived = 0;
  let appUpdateTotal = 0;
  let appUpdateError = "";
  let appUpdateVerified = false;
  let appUpdateSuppressed = false;

  const en = (text) => translate(text);

  function hide() {
    const box = document.getElementById("app-update-dlg");
    if (box) box.hidden = true;
    syncNativeView?.();
  }

  function versionText(info = pendingAppUpdate) {
    if (!info) return "";
    const build = String(info.latestBuild || "").slice(0, 7);
    return `v${info.latestVersion || ""}${build ? ` (${build})` : ""}`;
  }

  function clearPersistedReady() {
    try {
      storage.removeItem(APP_UPDATE_READY_KEY);
    } catch (_) {}
  }

  function restoreReady(info) {
    if (!info?.available || pendingAppUpdateDownload) return;
    try {
      const saved = JSON.parse(storage.getItem(APP_UPDATE_READY_KEY) || "null");
      if (!saved || saved.identity !== updateIdentity(info) || !saved.path) return;
      pendingAppUpdateDownload = String(saved.path);
      pendingAppUpdateSilent = Boolean(saved.silentUpdate);
      appUpdateVerified = Boolean(saved.verified);
      appUpdatePhase = "ready";
      appUpdatePercent = 100;
      appUpdateReceived = Number(saved.bytes || 0);
      appUpdateTotal = appUpdateReceived;
    } catch (_) {}
  }

  function persistReady() {
    if (!pendingAppUpdate?.available || !pendingAppUpdateDownload) return;
    try {
      storage.setItem(APP_UPDATE_READY_KEY, JSON.stringify({
        identity: updateIdentity(pendingAppUpdate),
        path: pendingAppUpdateDownload,
        silentUpdate: pendingAppUpdateSilent,
        verified: appUpdateVerified,
        bytes: appUpdateReceived,
      }));
    } catch (_) {}
  }

  function resetState() {
    pendingAppUpdate = null;
    pendingAppUpdateDownload = null;
    pendingAppUpdateSilent = false;
    appUpdateBusy = false;
    appUpdatePhase = "idle";
    appUpdatePercent = -1;
    appUpdateReceived = 0;
    appUpdateTotal = 0;
    appUpdateError = "";
    appUpdateVerified = false;
    appUpdateSuppressed = false;
    paintIndicator();
  }

  function paintIndicator() {
    const button = document.getElementById("tb-update");
    if (!button) return;
    const available = pendingAppUpdate?.available === true;
    const visible = available && (!appUpdateSuppressed || appUpdateBusy || !!pendingAppUpdateDownload);
    button.hidden = !visible;
    if (!visible) return;

    const state = appUpdateBusy
      ? "downloading"
      : pendingAppUpdateDownload
        ? "ready"
        : appUpdatePhase === "error"
          ? "error"
          : "available";
    const percent = Math.max(0, Math.min(100, Number(appUpdatePercent) || 0));
    button.dataset.state = state;
    button.style.setProperty("--update-pct", `${percent}%`);
    let label = `${en("发现新版本")} ${versionText()}`;
    if (state === "downloading") {
      label = appUpdatePercent >= 0
        ? `${en("后台下载更新")} ${Math.round(percent)}%`
        : en("后台下载更新");
    } else if (state === "ready") {
      label = `${versionText()} ${en("已下载，点击安装")}`;
    } else if (state === "error") {
      label = `${en("更新下载失败，点击重试")}：${appUpdateError}`;
    }
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function statusMessage() {
    if (appUpdatePhase === "error") return `${en("下载失败：")}${appUpdateError}`;
    if (appUpdatePhase === "ready" || appUpdatePhase === "done") {
      const readyText = pendingAppUpdateSilent
        ? en("安装包下载完成，点击“立即静默更新”将沿用上次安装目录并自动重启 KDock")
        : en("安装包下载完成，请点击“启动安装程序”");
      return appUpdateVerified
        ? `${en("安装包已下载，SHA-256 校验通过")}。${readyText}`
        : `${en("安装包已下载；旧版更新清单未提供 SHA-256")}。${readyText}`;
    }
    if (appUpdatePhase === "verify") return en("正在校验安装包…");
    if (appUpdatePhase === "downloading") {
      if (appUpdateTotal > 0 && appUpdatePercent >= 0) {
        const gotMb = appUpdateReceived / 1048576;
        const totalMb = appUpdateTotal / 1048576;
        return `${en("正在下载安装包…")} ${Math.round(appUpdatePercent)}% · ${gotMb.toFixed(1)} / ${totalMb.toFixed(1)} MB`;
      }
      if (appUpdateReceived > 0) {
        return `${en("正在下载安装包…")} ${(appUpdateReceived / 1048576).toFixed(1)} MB`;
      }
      return en("正在下载安装包…");
    }
    return "";
  }

  function paintDialog() {
    const box = document.getElementById("app-update-dlg");
    const text = document.getElementById("app-update-text");
    if (!box || !text || !pendingAppUpdate) return;
    const info = pendingAppUpdate;
    const currentBuild = String(info.currentBuild || "").slice(0, 7);
    const latestBuild = String(info.latestBuild || "").slice(0, 7);
    const notes = String(info.notes || "").trim().slice(0, 600);
    text.textContent = [
      `${en("当前版本")} v${info.currentVersion}${currentBuild ? ` (${currentBuild})` : ""} → v${info.latestVersion}${latestBuild ? ` (${latestBuild})` : ""}`,
      notes,
      en("下载会在后台继续，关闭此窗口不会影响下载；完成后从右上角更新按钮安装。"),
    ].filter(Boolean).join("\n\n");

    const wrap = document.getElementById("app-update-progress");
    const bar = document.getElementById("app-update-progress-bar");
    const status = document.getElementById("app-update-status");
    const download = document.getElementById("app-update-download");
    const manual = document.getElementById("app-update-manual");
    const skip = document.getElementById("app-update-skip");
    const later = document.getElementById("app-update-later");
    const message = statusMessage();
    const showProgress = appUpdatePhase !== "idle" && appUpdatePhase !== "";
    if (wrap) {
      wrap.hidden = !showProgress;
      wrap.classList.toggle("indeterminate", appUpdateBusy && appUpdatePercent < 0);
      wrap.classList.toggle("error", appUpdatePhase === "error");
    }
    if (bar) {
      bar.style.width = (appUpdateBusy && appUpdatePercent < 0
        ? 28
        : Math.max(0, Math.min(100, Number(appUpdatePercent) || 0))) + "%";
    }
    if (status) {
      status.hidden = !message;
      status.textContent = message;
      status.classList.toggle("error", appUpdatePhase === "error");
    }
    if (manual) manual.hidden = !pendingAppUpdateDownload || !pendingAppUpdateSilent || appUpdateBusy;
    if (skip) skip.hidden = appUpdateBusy || !!pendingAppUpdateDownload;
    if (later) later.hidden = appUpdateBusy || !!pendingAppUpdateDownload;
    if (download) {
      download.disabled = appUpdateBusy;
      download.textContent = appUpdateBusy
        ? en("后台下载中…")
        : pendingAppUpdateDownload
          ? pendingAppUpdateSilent
            ? en("立即静默更新")
            : en("启动安装程序")
          : appUpdatePhase === "error"
            ? en("重试下载")
            : en("后台下载");
    }
  }

  function progress(phase, pct, received, total) {
    const nextPhase = String(phase || "downloading");
    appUpdatePhase = nextPhase === "download" ? "downloading" : nextPhase;
    appUpdatePercent = Number.isFinite(Number(pct)) && Number(pct) >= 0
      ? Math.max(0, Math.min(100, Number(pct)))
      : -1;
    appUpdateReceived = Math.max(0, Number(received) || 0);
    appUpdateTotal = Math.max(0, Number(total) || 0);
    paintIndicator();
    paintDialog();
  }

  function open(info = pendingAppUpdate) {
    const box = document.getElementById("app-update-dlg");
    const text = document.getElementById("app-update-text");
    if (!box || !text || !info?.available) return;
    const same = pendingAppUpdate && updateIdentity(pendingAppUpdate) === updateIdentity(info);
    pendingAppUpdate = info;
    if (!same) {
      pendingAppUpdateDownload = null;
      pendingAppUpdateSilent = false;
      appUpdateBusy = false;
      appUpdatePhase = "idle";
      appUpdatePercent = -1;
      appUpdateReceived = 0;
      appUpdateTotal = 0;
      appUpdateError = "";
      appUpdateVerified = false;
      restoreReady(info);
    }
    appUpdateSuppressed = false;
    paintDialog();
    paintIndicator();
    box.hidden = false;
    syncNativeView?.();
    setTimeout(() => document.getElementById("app-update-download")?.focus(), 30);
  }

  function showForCheck(info, { manual = false, reason = "" } = {}) {
    if (!info?.available) {
      if (!appUpdateBusy && !pendingAppUpdateDownload) resetState();
      return;
    }
    const same = pendingAppUpdate && updateIdentity(pendingAppUpdate) === updateIdentity(info);
    if (!same) {
      pendingAppUpdate = info;
      pendingAppUpdateDownload = null;
      pendingAppUpdateSilent = false;
      appUpdateBusy = false;
      appUpdatePhase = "idle";
      appUpdatePercent = -1;
      appUpdateReceived = 0;
      appUpdateTotal = 0;
      appUpdateError = "";
      appUpdateVerified = false;
      restoreReady(info);
    } else {
      pendingAppUpdate = info;
    }
    appUpdateSuppressed = reason === "skipped" && !manual;
    paintIndicator();
  }

  async function launch(silent) {
    if (!pendingAppUpdateDownload || appUpdateBusy) return;
    try {
      await invoke("app_update_launch", {
        path: pendingAppUpdateDownload,
        silent,
      });
      hide();
      toast(silent ? en("正在静默更新，KDock 将自动重启…") : en("正在启动安装程序…"));
    } catch (e) {
      const message = String(e);
      pendingAppUpdateDownload = null;
      pendingAppUpdateSilent = false;
      appUpdateVerified = false;
      clearPersistedReady();
      appUpdatePhase = "error";
      appUpdateError = message;
      paintDialog();
      paintIndicator();
      toast(en("无法启动安装程序：") + message);
    }
  }

  function bind() {
    const box = document.getElementById("app-update-dlg");
    if (!box) return;
    const on = (id, fn) => {
      const button = document.getElementById(id);
      if (button) button.onclick = fn;
    };
    listen("app-update://progress", (event) => {
      if (!pendingAppUpdate) return;
      const p = event.payload || {};
      progress(p.phase, p.pct, p.received, p.total);
    });
    on("app-update-skip", () => {
      if (appUpdateBusy) return;
      if (pendingAppUpdate) skipUpdate(pendingAppUpdate);
      clearPersistedReady();
      resetState();
      hide();
    });
    on("app-update-later", () => {
      if (appUpdateBusy) return;
      if (pendingAppUpdate) remindUpdateLater(pendingAppUpdate);
      hide();
    });
    on("app-update-download", async () => {
      const info = pendingAppUpdate;
      if (!info || appUpdateBusy) return;
      if (pendingAppUpdateDownload) {
        await launch(pendingAppUpdateSilent);
        return;
      }
      appUpdateBusy = true;
      appUpdatePhase = "downloading";
      appUpdatePercent = 0;
      appUpdateReceived = 0;
      appUpdateTotal = 0;
      appUpdateError = "";
      paintDialog();
      paintIndicator();
      hide();
      toast(en("更新正在后台下载"));
      try {
        const got = await invoke("app_update_download", {
          url: info.installerUrl,
          sha256: String(info.sha256 || ""),
        });
        pendingAppUpdateDownload = got.path;
        pendingAppUpdateSilent = Boolean(got.silentUpdate);
        appUpdateVerified = Boolean(got.verified);
        appUpdatePhase = "ready";
        appUpdatePercent = 100;
        appUpdateReceived = Number(got.bytes || appUpdateReceived);
        appUpdateTotal = appUpdateReceived;
        appUpdateError = "";
        persistReady();
        const readyText = pendingAppUpdateSilent
          ? en("安装包下载完成，点击“立即静默更新”将沿用上次安装目录并自动重启 KDock")
          : en("安装包下载完成，请点击“启动安装程序”");
        paintDialog();
        toast(`${readyText}${box.hidden ? en("，可从右上角更新按钮继续") : ""}`);
      } catch (e) {
        appUpdatePhase = "error";
        appUpdatePercent = 100;
        appUpdateError = String(e);
        paintDialog();
        toast(String(e));
      } finally {
        appUpdateBusy = false;
        paintDialog();
        paintIndicator();
      }
    });
    on("app-update-manual", async () => {
      await launch(false);
    });
    box.onclick = (event) => {
      if (event.target === box) hide();
    };
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || box.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    }, true);
    const updateButton = document.getElementById("tb-update");
    if (updateButton) {
      updateButton.onclick = (event) => {
        event.stopPropagation();
        open(pendingAppUpdate);
      };
    }
    paintIndicator();
  }

  return { bind, hide, open, showForCheck };
}
