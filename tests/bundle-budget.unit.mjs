import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "dist", ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entry = manifest["index.html"];
assert.ok(entry?.isEntry, "Vite manifest has no index.html entry");

const chunks = [];
for (const [source, item] of Object.entries(manifest)) {
  if (!item.file.endsWith(".js")) continue;
  const bytes = await stat(resolve(root, "dist", item.file));
  const contents = await readFile(resolve(root, "dist", item.file));
  chunks.push({
    source,
    file: item.file,
    entry: !!item.isEntry,
    dynamic: !!item.isDynamicEntry,
    bytes: bytes.size,
    gzip: gzipSync(contents).length,
  });
}
chunks.sort((a, b) => b.bytes - a.bytes);

const entryChunk = chunks.find((chunk) => chunk.file === entry.file);
assert.ok(entryChunk, "entry JavaScript chunk is missing");
const dynamicChunks = chunks.filter((chunk) => chunk.dynamic);
const initialFiles = new Set();
function addInitial(key) {
  const item = manifest[key];
  if (!item || !item.file?.endsWith(".js") || initialFiles.has(item.file)) return;
  initialFiles.add(item.file);
  for (const dependency of item.imports || []) addInitial(dependency);
}
addInitial("index.html");
const initialChunks = chunks.filter((chunk) => initialFiles.has(chunk.file));
const initialBytes = initialChunks.reduce((total, chunk) => total + chunk.bytes, 0);
const initialGzip = initialChunks.reduce((total, chunk) => total + chunk.gzip, 0);

const lazySources = [
  "src/help-content.js",
  "src/logic-analyzer.js",
  "src/runtime-graph.js",
  "src/tools-batch-calc.js",
  "node_modules/uplot/dist/uPlot.esm.js",
];
for (const source of lazySources) {
  assert.ok(
    dynamicChunks.some((chunk) => chunk.source.includes(source.replace("src/", "src/"))),
    `expected ${source} to be emitted as a lazy chunk`,
  );
}

// The initial UI should stay below Vite's default warning threshold. Page
// modules are loaded on first navigation, so they do not inflate startup parse.
assert.ok(
  entryChunk.bytes <= 500 * 1000,
  `entry chunk is ${(entryChunk.bytes / 1000).toFixed(2)} kB, expected <= 500 kB`,
);
assert.ok(
  entryChunk.bytes < chunks.reduce((total, chunk) => total + chunk.bytes, 0) * 0.75,
  "entry chunk still dominates all emitted JavaScript",
);
assert.ok(initialBytes <= 656 * 1000, `initial JavaScript is ${(initialBytes / 1000).toFixed(2)} kB, expected <= 656 kB`);
assert.ok(initialGzip <= 260 * 1000, `initial JavaScript gzip is ${(initialGzip / 1000).toFixed(2)} kB, expected <= 260 kB`);

console.log(JSON.stringify({
  ok: true,
  entry: {
    file: entryChunk.file,
    kb: Number((entryChunk.bytes / 1000).toFixed(2)),
    gzipKb: Number((entryChunk.gzip / 1000).toFixed(2)),
  },
  initial: {
    kb: Number((initialBytes / 1000).toFixed(2)),
    gzipKb: Number((initialGzip / 1000).toFixed(2)),
    chunks: initialChunks.map((chunk) => chunk.file),
  },
  lazyChunks: dynamicChunks.length,
  chunks: chunks.map((chunk) => ({
    file: chunk.file,
    kb: Number((chunk.bytes / 1000).toFixed(2)),
    gzipKb: Number((chunk.gzip / 1000).toFixed(2)),
    dynamic: chunk.dynamic,
  })),
}, null, 2));
