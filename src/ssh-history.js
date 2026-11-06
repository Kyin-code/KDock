export const SSH_PROFILES_KEY = "kdock_ssh_profiles_v1";
const MAX_SSH_PROFILES = 12;

export function sshProfileId(profile) {
  const user = String(profile?.user || "").trim();
  const host = String(profile?.host || "").trim().toLowerCase();
  const port = Number(profile?.port) || 22;
  return `ssh:${user}@${host}:${port}`;
}

export function sshProfileLabel(profile) {
  const target = `${profile?.host || ""}:${Number(profile?.port) || 22}`;
  return profile?.user ? `${profile.user}@${target}` : target;
}

export function normalizeSshProfiles(profiles) {
  const seen = new Set();
  return (Array.isArray(profiles) ? profiles : [])
    .map((profile) => {
      const host = String(profile?.host || "").trim();
      if (!host) return null;
      const value = {
        id: "",
        host,
        port: Math.max(1, Math.min(65535, Number(profile.port) || 22)),
        user: String(profile.user || "").trim(),
        extra: String(profile.extra || "").trim(),
        auth: profile.auth === "password" ? "password" : "key",
        rememberPassword: profile.rememberPassword === true,
        lastConnectedAt: Math.max(0, Number(profile.lastConnectedAt) || 0),
      };
      value.id = sshProfileId(value);
      return value;
    })
    .filter(Boolean)
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .filter((profile) => {
      if (seen.has(profile.id)) return false;
      seen.add(profile.id);
      return true;
    })
    .slice(0, MAX_SSH_PROFILES);
}

export function upsertSshProfile(profiles, profile) {
  return normalizeSshProfiles([
    profile,
    ...normalizeSshProfiles(profiles).filter((item) => item.id !== profile.id),
  ]);
}

export function createSshHistoryController({ doOpen, toast, translate }) {
  const storage = localStorage;
  const sessionPasswords = new Map();
  let profiles = loadProfiles();
  let connecting = false;

  function loadProfiles() {
    try {
      return normalizeSshProfiles(JSON.parse(storage.getItem(SSH_PROFILES_KEY) || "[]"));
    } catch (_) {
      return [];
    }
  }

  function saveProfiles() {
    storage.setItem(SSH_PROFILES_KEY, JSON.stringify(profiles));
  }

  async function invokeCommand(command, args) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(command, args);
  }

  function render() {
    const list = document.getElementById("ssh-recent-list");
    const empty = document.getElementById("ssh-recent-empty");
    const count = document.getElementById("ssh-recent-count");
    if (!list || !empty) return;
    list.textContent = "";
    if (count) count.textContent = profiles.length ? String(profiles.length) : "";
    empty.hidden = profiles.length > 0;
    for (const profile of profiles) {
      const row = document.createElement("div");
      row.className = "ssh-recent-row";
      const connect = document.createElement("button");
      connect.type = "button";
      connect.className = "ssh-recent-connect";
      connect.title = translate("直接重新连接");
      const main = document.createElement("span");
      main.className = "ssh-recent-main";
      main.textContent = sshProfileLabel(profile);
      const meta = document.createElement("span");
      meta.className = "ssh-recent-meta";
      const auth = profile.auth === "password"
        ? (profile.rememberPassword ? translate("密码 · 已记住") : translate("密码"))
        : translate("密钥");
      const last = profile.lastConnectedAt
        ? new Date(profile.lastConnectedAt).toLocaleString()
        : "";
      meta.textContent = [auth, last].filter(Boolean).join(" · ");
      connect.append(main, meta);
      connect.onclick = () => connectProfile(profile);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ssh-recent-remove";
      remove.title = translate("删除这个连接记录及其保存的密码");
      remove.textContent = "×";
      remove.onclick = () => removeProfile(profile);
      row.append(connect, remove);
      list.appendChild(row);
    }
  }

  function applyProfile(profile) {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set("ssh-host", profile.host);
    set("ssh-port", String(profile.port || 22));
    set("ssh-user", profile.user || "");
    set("ssh-extra", profile.extra || "");
    set("ssh-pass", "");
    const remember = document.getElementById("ssh-remember");
    if (remember) remember.checked = profile.rememberPassword;
  }

  async function connectProfile(profile) {
    if (connecting) return false;
    connecting = true;
    try {
      applyProfile(profile);
      let password = "";
      if (profile.auth === "password") {
        password = sessionPasswords.get(profile.id) || "";
        if (!password && profile.rememberPassword) {
          password = await invokeCommand("ssh_secret_get", { id: profile.id }) || "";
        }
        if (!password) {
          const pass = document.getElementById("ssh-pass");
          if (pass) {
            pass.value = "";
            pass.focus();
          }
          toast(translate("请输入密码后连接"));
          return false;
        }
        const pass = document.getElementById("ssh-pass");
        if (pass) pass.value = password;
      }
      await doOpen();
      return true;
    } finally {
      connecting = false;
    }
  }

  async function record(profile) {
    const id = sshProfileId(profile);
    const remember = document.getElementById("ssh-remember")?.checked || false;
    const password = String(profile.password || "");
    const entry = {
      id,
      host: profile.host,
      port: profile.port,
      user: profile.user,
      extra: profile.extra,
      auth: password ? "password" : "key",
      rememberPassword: false,
      lastConnectedAt: Date.now(),
    };
    if (password) {
      sessionPasswords.set(id, password);
      if (remember) {
        try {
          await invokeCommand("ssh_secret_set", { id, password });
          entry.rememberPassword = true;
        } catch (error) {
          toast(String(error));
        }
      } else {
        sessionPasswords.set(id, password);
        await invokeCommand("ssh_secret_delete", { id }).catch(() => {});
      }
    } else {
      sessionPasswords.delete(id);
      await invokeCommand("ssh_secret_delete", { id }).catch(() => {});
    }
    profiles = upsertSshProfile(profiles, entry);
    saveProfiles();
    render();
  }

  async function removeProfile(profile) {
    if (profile.rememberPassword) {
      await invokeCommand("ssh_secret_delete", { id: profile.id }).catch(() => {});
    }
    sessionPasswords.delete(profile.id);
    profiles = profiles.filter((item) => item.id !== profile.id);
    saveProfiles();
    render();
  }

  function bind() {
    render();
  }

  return { bind, record, render };
}
