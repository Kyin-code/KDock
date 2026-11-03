import { pathToFileURL } from "node:url";

export function verifyBuildEntry(env = process.env) {
  if (env.KDOCK_TAURI_BUILD_ENTRY !== "1") {
    throw new Error("KDock packaging must start with `npm run tauri build`.");
  }
  if (env.KDOCK_RELEASE_BUILD === "1" && env.KDOCK_VERSION_PREPARED !== "1") {
    throw new Error(
      "Official KDock releases must prepare the Semifold version before Tauri reads tauri.conf.json.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBuildEntry();
}
