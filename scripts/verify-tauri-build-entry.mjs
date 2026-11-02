if (process.env.KDOCK_VERSION_PREPARED !== "1") {
  throw new Error(
    "KDock packaging must start with `npm run tauri build` so Semifold increments the version before Tauri reads tauri.conf.json.",
  );
}
