import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

export function needsReleaseVersion(args, env = process.env) {
  return args[0] === "build"
    && env.KDOCK_RELEASE_BUILD === "1"
    && env.KDOCK_VERSION_PREPARED !== "1";
}

function main() {
  const args = process.argv.slice(2);

  // Only official release builds consume a new Semifold version. Local builds
  // package the version that was pulled, with KDOCK_BUILD_ID distinguishing
  // rebuilds of the same source.
  if (needsReleaseVersion(args)) {
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    run(shell, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve(root, "scripts/semfold-version.ps1"),
    ]);
    process.env.KDOCK_VERSION_PREPARED = "1";
  }

  if (args[0] === "build") {
    process.env.KDOCK_TAURI_BUILD_ENTRY = "1";
  }

  run(process.execPath, [
    resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
    ...args,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
