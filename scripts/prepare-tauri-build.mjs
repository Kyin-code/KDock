import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

if (process.env.KDOCK_VERSION_PREPARED !== "1") {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  run(shell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "scripts/semfold-version.ps1"),
  ]);
}

if (process.platform === "win32") {
  run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"]);
} else {
  run("npm", ["run", "build"]);
}
