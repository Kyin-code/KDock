import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldOfferUpdate,
  skipUpdate,
  remindUpdateLater,
  updateRemindAt,
  updateSuppressionReason,
  updateIdentity,
  UPDATE_REMIND_MS,
} from "../src/app-update.js";
import { createAppUpdateController } from "../src/app-update-controller.js";
import { makeManifest } from "../scripts/release-manifest.mjs";
import { needsReleaseVersion } from "../scripts/tauri-entry.mjs";
import { verifyBuildEntry } from "../scripts/verify-tauri-build-entry.mjs";

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
assert.equal(updateSuppressionReason(info, 1000 + 1, laterStorage), "deferred");
assert.ok(updateRemindAt(info, laterStorage) > 1000);
assert.equal(
  shouldOfferUpdate({ ...info, latestBuild: "newbuild" }, 1000 + 1, laterStorage),
  true,
  "deferring one build must not hide a newer build",
);

async function withUpdateControllerDom(run) {
  const status = { textContent: "", title: "", style: {} };
  const button = { disabled: false };
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldSetInterval = globalThis.setInterval;
  globalThis.window = {
    addEventListener() {},
  };
  globalThis.document = {
    hidden: false,
    getElementById(id) {
      if (id === "set-update-status") return status;
      if (id === "set-check-update") return button;
      return null;
    },
    addEventListener() {},
  };
  globalThis.setInterval = () => 1;
  try {
    return await run(status, button);
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    globalThis.setInterval = oldSetInterval;
  }
}

await withUpdateControllerDom(async () => {
  const controllerStorage = memoryStorage();
  const startupInfo = { ...info, latestVersion: "0.3.2", latestBuild: "startupbuild" };
  remindUpdateLater(startupInfo, Date.now(), controllerStorage);
  const prompts = [];
  const updates = [];
  let invokeCount = 0;
  const controller = createAppUpdateController({
    invoke: async () => {
      invokeCount += 1;
      return invokeCount > 1 ? { ...startupInfo, latestBuild: "newbuild" } : startupInfo;
    },
    showUpdate: (value, context) => updates.push({ value, context }),
    showPrompt: (value) => prompts.push(value),
    toast() {},
    translate: (value) => value,
    storage: controllerStorage,
  });

  await controller.check(false);
  assert.equal(prompts.length, 0, "startup checks must never open the update dialog");
  assert.equal(updates.length, 1, "startup checks must publish the title-bar update state");
  assert.equal(updates[0].context.reason, "deferred");
  await controller.check(false);
  assert.equal(prompts.length, 0, "new builds must still wait for the title-bar update button");
  assert.equal(updates.length, 2);
  assert.equal(updates[1].value.latestBuild, "newbuild");
  remindUpdateLater({ ...startupInfo, latestBuild: "newbuild" }, Date.now(), controllerStorage);
  await controller.check(true);
  assert.equal(prompts.length, 1, "manual checks must still show a deferred build");
  assert.equal(invokeCount, 3);
});

const manifestArgs = {
  version: "0.3.1",
  build: "abc123",
  installerUrl: "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.1_x64-setup.exe",
  installerSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  portableUrl: "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock-0.3.1-test-abc123-win-x64.zip",
  releaseUrl: "https://github.com/Kyin-code/KDock/releases/tag/test-latest",
  notes: "fix build",
  publishedAt: "2026-11-02T00:00:00.000Z",
};
const releaseManifest = makeManifest(manifestArgs);
assert.equal(releaseManifest.version, "0.3.1");
assert.equal(releaseManifest.build, "abc123");
assert.equal(releaseManifest.sha256, "a".repeat(64));
assert.throws(() => makeManifest({
  ...manifestArgs,
  installerUrl: "https://example.com/setup.exe",
}), /outside the KDock release/);
assert.throws(() => makeManifest({
  ...manifestArgs,
  installerSha256: "bad",
}), /invalid installer SHA-256/);

const [main, html] = await Promise.all([
  readFile(resolve(root, "src/main.js"), "utf8"),
  readFile(resolve(root, "index.html"), "utf8"),
]);
const [pkg, tauriConf, tauriEntry, ciWorkflow, appUpdateRust, appUpdateController, appUpdateUi] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "scripts/tauri-entry.mjs"), "utf8"),
  readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
  readFile(resolve(root, "src-tauri/src/app_update.rs"), "utf8"),
  readFile(resolve(root, "src/app-update-controller.js"), "utf8"),
  readFile(resolve(root, "src/app-update-ui.js"), "utf8"),
]);
assert.match(main, /setTimeout\(checkAppUpdateOnStartup, 8000\)/);
assert.match(main, /checkAppUpdateOnStartup\(true\)/);
assert.match(main, /import\("\.\/app-update-controller\.js"\)/);
assert.match(main, /import\("\.\/app-update-ui\.js"\)/);
assert.match(appUpdateController, /showUpdate\?\.\(info/);
assert.match(appUpdateController, /updateSuppressionReason\(info/);
assert.match(appUpdateController, /const attempts = manual \? 1 : 3/);
assert.match(appUpdateController, /kdock_update_last_error/);
assert.match(appUpdateController, /setInterval\(/);
assert.match(appUpdateController, /addEventListener\("online"/);
assert.match(main, /set-check-update/);
assert.match(appUpdateRust, /AutoConfigURL/);
assert.match(appUpdateRust, /WinHttpGetProxyForUrl/);
assert.match(appUpdateUi, /invoke\("app_update_download"/);
assert.match(appUpdateUi, /invoke\("app_update_launch"/);
assert.doesNotMatch(main, /openExternal\(info\.installerUrl\)/);
assert.match(appUpdateUi, /安装包下载完成，请点击“启动安装程序”/);
assert.match(appUpdateUi, /pendingAppUpdateSilent/);
assert.match(appUpdateUi, /silent,\s*\}/);
assert.match(appUpdateUi, /readyText.*可从右上角更新按钮继续/);
assert.match(html, /id="app-update-skip"/);
assert.match(html, /id="app-update-later"/);
assert.match(html, /id="app-update-manual"/);
assert.match(html, /id="app-update-download"/);
assert.match(html, /id="app-update-progress"/);
assert.match(html, /id="tb-update"/);
assert.match(html, /id="set-check-update"/);
assert.match(html, /id="set-update-status"/);
assert.match(appUpdateUi, /APP_UPDATE_READY_KEY/);
assert.match(main, /showUpdate: updateUi\.showForCheck/);
assert.match(appUpdateUi, /function hide\(\) \{[\s\S]{0,180}box\.hidden = true/);
assert.doesNotMatch(appUpdateUi, /function hide\(\) \{[\s\S]{0,220}pendingAppUpdate = null/);
assert.match(appUpdateUi, /hide\(\);\s*toast\(en\("更新正在后台下载"\)\)/);
assert.match(appUpdateUi, /storage\.setItem\(APP_UPDATE_READY_KEY/);
assert.equal(pkg.scripts.tauri, "node scripts/tauri-entry.mjs");
assert.equal(pkg.scripts["build:tauri"], "node scripts/verify-tauri-build-entry.mjs && npm run build");
assert.equal(tauriConf.build.beforeBuildCommand, "npm run build:tauri");
assert.equal(tauriConf.bundle.windows.nsis.installMode, "currentUser");
assert.equal(needsReleaseVersion(["build"], {}), false, "local builds must not bump the official version");
assert.equal(
  needsReleaseVersion(["build"], { KDOCK_RELEASE_BUILD: "1" }),
  true,
  "official CI builds must prepare a Semifold version",
);
assert.equal(
  needsReleaseVersion(["build"], { KDOCK_RELEASE_BUILD: "1", KDOCK_VERSION_PREPARED: "1" }),
  false,
  "tag builds must use their already validated version",
);
assert.equal(needsReleaseVersion(["--version"], { KDOCK_RELEASE_BUILD: "1" }), false);
assert.doesNotThrow(() => verifyBuildEntry({ KDOCK_TAURI_BUILD_ENTRY: "1" }));
assert.throws(
  () => verifyBuildEntry({}),
  /must start with `npm run tauri build`/,
  "direct Tauri builds must remain blocked",
);
assert.throws(
  () => verifyBuildEntry({ KDOCK_TAURI_BUILD_ENTRY: "1", KDOCK_RELEASE_BUILD: "1" }),
  /must prepare the Semifold version/,
);
assert.doesNotThrow(() => verifyBuildEntry({
  KDOCK_TAURI_BUILD_ENTRY: "1",
  KDOCK_RELEASE_BUILD: "1",
  KDOCK_VERSION_PREPARED: "1",
}));
assert.match(tauriEntry, /process\.env\.KDOCK_TAURI_BUILD_ENTRY = "1"/);
assert.ok(
  tauriEntry.indexOf("semfold-version.ps1") < tauriEntry.indexOf("@tauri-apps/cli/tauri.js"),
  "Semifold must finish before Tauri reads tauri.conf.json",
);
assert.ok(
  ciWorkflow.includes("KDOCK_RELEASE_BUILD: ${{ github.event_name != 'pull_request' && '1' || '0' }}"),
  "CI must reserve version bumps for non-PR release builds",
);
const buildJobStart = ciWorkflow.indexOf("\n  build:");
assert.ok(buildJobStart >= 0, "CI has no release build job");
const buildJob = ciWorkflow.slice(buildJobStart);
assert.match(
  buildJob,
  /runs-on: \[ self-hosted, windows, kdock \]/,
  "release builds must use the dedicated self-hosted runner",
);
assert.match(buildJob, /CARGO_TARGET_DIR: D:\/CI\/cargo-target\/kdock/);
assert.match(buildJob, /VerifiedAndReputablePolicyState/);
const cleanIndex = buildJob.indexOf("Remove-Item -LiteralPath $nsis -Recurse -Force");
const buildIndex = buildJob.indexOf("npm run tauri build");
assert.ok(cleanIndex >= 0 && cleanIndex < buildIndex, "CI must clear stale NSIS output before building");
assert.match(
  ciWorkflow,
  /Get-ChildItem -LiteralPath \$nsis -Filter \$name -File/,
  "CI must stage only the installer matching the current Semifold version",
);
assert.match(ciWorkflow, /Get-FileHash -LiteralPath \$setup\.FullName -Algorithm SHA256/);
assert.match(ciWorkflow, /--installer-sha256 \$installerSha256/);

console.log(JSON.stringify({
  ok: true,
  identity: updateIdentity(info),
  remindMs: UPDATE_REMIND_MS,
  releaseManifest,
}, null, 2));
