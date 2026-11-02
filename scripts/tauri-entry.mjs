import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);

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

// Tauri reads tauri.conf.json before it runs beforeBuildCommand, so the version
// must be final before the Tauri process starts.
if (args[0] === "build" && process.env.KDOCK_VERSION_PREPARED !== "1") {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  run(shell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "scripts/semfold-version.ps1"),
  ]);
  process.env.KDOCK_VERSION_PREPARED = "1";
}

run(process.execPath, [
  resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
  ...args,
]);
