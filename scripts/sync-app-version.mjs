import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(path, "utf8");
  if (current !== next) await writeFile(path, next, "utf8");
}

const pkg = await readJson(resolve(root, "package.json"));
const version = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json has an invalid version: ${version || "(empty)"}`);
}

const tauriPath = resolve(root, "src-tauri/tauri.conf.json");
const tauri = await readJson(tauriPath);
tauri.version = version;
await writeJsonIfChanged(tauriPath, tauri);

const lockPath = resolve(root, "package-lock.json");
try {
  const lock = await readJson(lockPath);
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  await writeJsonIfChanged(lockPath, lock);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const cargo = await readFile(resolve(root, "Cargo.toml"), "utf8");
const workspaceVersion = cargo.match(
  /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (workspaceVersion !== version) {
  throw new Error(
    `Cargo workspace version ${workspaceVersion || "(missing)"} does not match package.json ${version}`,
  );
}

console.log(version);
