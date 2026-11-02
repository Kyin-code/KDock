import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RELEASE_BASE = "https://github.com/Kyin-code/KDock/releases/";

export function makeManifest({
  version,
  build,
  installerUrl,
  installerSha256,
  portableUrl,
  releaseUrl,
  notes = "",
  publishedAt = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ""))) {
    throw new Error(`invalid release version: ${version}`);
  }
  if (!build) throw new Error("release build id is required");
  if (!/^[0-9a-f]{64}$/i.test(String(installerSha256 || ""))) {
    throw new Error(`invalid installer SHA-256: ${installerSha256}`);
  }
  for (const [name, url] of [
    ["installer", installerUrl],
    ["portable", portableUrl],
    ["release", releaseUrl],
  ]) {
    if (!String(url || "").startsWith(RELEASE_BASE)) {
      throw new Error(`${name} URL is outside the KDock release: ${url}`);
    }
  }
  return {
    schema: 1,
    version,
    build,
    published_at: publishedAt,
    notes: String(notes || "").trim(),
    installer_url: installerUrl,
    sha256: String(installerSha256).toLowerCase(),
    portable_url: portableUrl,
    release_url: releaseUrl,
  };
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function main() {
  const args = process.argv.slice(2);
  const output = cliValue(args, "--output");
  if (!output) throw new Error("--output is required");
  const manifest = makeManifest({
    version: cliValue(args, "--version"),
    build: cliValue(args, "--build"),
    installerUrl: cliValue(args, "--installer-url"),
    installerSha256: cliValue(args, "--installer-sha256"),
    portableUrl: cliValue(args, "--portable-url"),
    releaseUrl: cliValue(args, "--release-url"),
    notes: cliValue(args, "--notes"),
  });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
