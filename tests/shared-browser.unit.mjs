import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFile(resolve(root, path), "utf8");
const [html, main, kbview, tools, agent, tauri] = await Promise.all([
  read("index.html"),
  read("src/main.js"),
  read("src-tauri/src/kbview.rs"),
  read("src-tauri/src/agent/tools.rs"),
  read("src-tauri/src/agent/mod.rs"),
  read("src-tauri/src/lib.rs"),
]);

assert.equal((html.match(/id="kb-host"/g) || []).length, 1, "only one browser host is allowed");
assert.equal((html.match(/id="kb-chat-host"/g) || []).length, 0, "second KB host must be removed");
assert.equal((html.match(/id="kb-chat-url"/g) || []).length, 0, "second KB URL bar must be removed");
assert.doesNotMatch(main, /KB_MGMT_KEY|KB_CHAT_KEY|kbLastPlace\.[a-z]/);
assert.match(main, /const KBB_KIND = "browser"/);
assert.match(main, /async function kbOpenUrl/);
assert.match(main, /invoke\("kb_open"/);
assert.match(main, /localStorage\.removeItem\(KB_LEGACY_MGMT_KEY\)/);
assert.match(main, /kb_open/);
assert.match(main, /kb_read_dom/);
assert.match(html, /id="ag-br-show"/);
assert.match(html, /id="kb-back"/);
assert.match(kbview, /pub fn read_dom_json/);
assert.match(kbview, /pub fn open/);
assert.match(kbview, /pub fn navigate/);
assert.match(kbview, /if w <= 1\.0 \|\| h <= 1\.0 \{[\s\S]*?wv\.hide\(\)/);
assert.match(tools, /crate::shared_browser::read_dom_json/);
assert.match(tools, /browser_navigate/);
assert.match(tools, /crate::shared_browser::open/);
assert.doesNotMatch(agent, /pub fn browser_fetch|pub fn browser_back|pub fn browser_current/);
assert.doesNotMatch(tauri, /agent::browser_fetch|agent::browser_back|agent::browser_current/);
assert.doesNotMatch(main, /kb-chat-host|kb-chat-url|kb-chat-open|kb-chat-save/);
assert.doesNotMatch(html, /id="kb-chat-host"|id="kb-chat-url"/);
assert.match(html, /data-tab="kb"[^>]*>[\s\S]*?<span>浏览器<\/span>/);
assert.match(tools, /crate::shared_browser::open/);
console.log(JSON.stringify({ ok: true, host: "browser", sharedTools: ["browser_open", "browser_navigate", "browser_read", "browser_find"] }, null, 2));
