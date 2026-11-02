import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldOfferUpdate,
  skipUpdate,
  remindUpdateLater,
  updateIdentity,
  UPDATE_REMIND_MS,
} from "../src/app-update.js";
import { makeManifest } from "../scripts/release-manifest.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const info = {
  available: true,
  latestVersion: "0.3.1",
  latestBuild: "abc123",
};
const storage = memoryStorage();
assert.equal(updateIdentity(info), "0.3.1|abc123");
assert.equal(shouldOfferUpdate(info, 1000, storage), true);
assert.equal(shouldOfferUpdate({ ...info, available: false }, 1000, storage), false);

skipUpdate(info, storage);
assert.equal(shouldOfferUpdate(info, 1000, storage), false);
assert.equal(shouldOfferUpdate({ ...info, latestBuild: "def456" }, 1000, storage), true);

const laterStorage = memoryStorage();
remindUpdateLater(info, 1000, laterStorage);
assert.equal(shouldOfferUpdate(info, 1000 + UPDATE_REMIND_MS - 1, laterStorage), false);
assert.equal(shouldOfferUpdate(info, 1000 + UPDATE_REMIND_MS + 1, laterStorage), true);

const releaseManifest = makeManifest({
  version: "0.3.1",
  build: "abc123",
  installerUrl: "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.1_x64-setup.exe",
  portableUrl: "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock-0.3.1-test-abc123-win-x64.zip",
  releaseUrl: "https://github.com/Kyin-code/KDock/releases/tag/test-latest",
  notes: "fix build",
  publishedAt: "2026-11-02T00:00:00.000Z",
});
assert.equal(releaseManifest.version, "0.3.1");
assert.equal(releaseManifest.build, "abc123");
assert.throws(() => makeManifest({
  ...releaseManifest,
  installerUrl: "https://example.com/setup.exe",
}), /outside the KDock release/);

const [main, html] = await Promise.all([
  readFile(resolve(root, "src/main.js"), "utf8"),
  readFile(resolve(root, "index.html"), "utf8"),
]);
const [pkg, tauriConf, tauriEntry, buildGuard, ciWorkflow] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "scripts/tauri-entry.mjs"), "utf8"),
  readFile(resolve(root, "scripts/verify-tauri-build-entry.mjs"), "utf8"),
  readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
]);
assert.match(main, /setTimeout\(checkAppUpdateOnStartup, 8000\)/);
assert.doesNotMatch(main, /setInterval\([^)]*checkAppUpdateOnStartup/);
assert.match(main, /shouldOfferUpdate\(info\)/);
assert.match(html, /id="app-update-skip"/);
assert.match(html, /id="app-update-later"/);
assert.match(html, /id="app-update-download"/);
assert.equal(pkg.scripts.tauri, "node scripts/tauri-entry.mjs");
assert.equal(pkg.scripts["build:tauri"], "node scripts/verify-tauri-build-entry.mjs && npm run build");
assert.equal(tauriConf.build.beforeBuildCommand, "npm run build:tauri");
assert.match(tauriEntry, /process\.env\.KDOCK_VERSION_PREPARED = "1"/);
assert.match(buildGuard, /KDOCK_VERSION_PREPARED !== "1"/);
assert.ok(
  tauriEntry.indexOf("semfold-version.ps1") < tauriEntry.indexOf("@tauri-apps/cli/tauri.js"),
  "Semifold must finish before Tauri reads tauri.conf.json",
);
const cleanIndex = ciWorkflow.indexOf("Remove-Item -LiteralPath $nsis -Recurse -Force");
const buildIndex = ciWorkflow.indexOf("npm run tauri build");
assert.ok(cleanIndex >= 0 && cleanIndex < buildIndex, "CI must clear stale NSIS output before building");
assert.match(
  ciWorkflow,
  /Get-ChildItem -LiteralPath \$nsis -Filter \$name -File/,
  "CI must stage only the installer matching the current Semifold version",
);

console.log(JSON.stringify({
  ok: true,
  identity: updateIdentity(info),
  remindMs: UPDATE_REMIND_MS,
  releaseManifest,
}, null, 2));
