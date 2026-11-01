import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWebBrowserUrl, normalizeBrowserUrl } from "../src/browser-url.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFile(resolve(root, path), "utf8");

assert.equal(normalizeBrowserUrl("example.com/path"), "https://example.com/path");
assert.equal(normalizeBrowserUrl("http://127.0.0.1:1420"), "http://127.0.0.1:1420");
assert.equal(isWebBrowserUrl("example.com"), true);
assert.equal(isWebBrowserUrl("https://example.com/a?b=1&c=2"), true);
assert.equal(isWebBrowserUrl("ftp://example.com/file"), false);
assert.equal(isWebBrowserUrl("javascript:alert(1)"), false);
assert.equal(isWebBrowserUrl("file:///C:/secret.txt"), false);
assert.equal(isWebBrowserUrl("   "), false);
const [html, main, help, kbview, tools, agent, tauri] = await Promise.all([
  read("index.html"),
  read("src/main.js"),
  read("src/help-content.js"),
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
assert.match(main, /localStorage\.removeItem\("kdock_kb_mgmt"\)/);
assert.match(main, /localStorage\.removeItem\("kdock_kb_chat"\)/);
assert.match(main, /localStorage\.removeItem\("kdock_kb_focus"\)/);
assert.match(main, /kbLastPlace = "";[\s\S]*?return;/);
assert.match(main, /const live = await invoke\("kb_current_url"/);
assert.match(main, /kb_open/);
assert.match(main, /kb_read_dom/);
assert.match(main, /function kbApplyPageEvent/);
assert.match(main, /function kbWebUrlError/);
assert.match(main, /function kbIsWebUrl/);
assert.match(main, /function kbSetAddress/);
assert.match(main, /kbAddressDirty/);
assert.match(main, /kbLastPlaceError/);
assert.match(main, /else localStorage\.removeItem\(KB_HOME_KEY\)/);
assert.doesNotMatch(main, /if \(!kbUrl\) kbUrl = kbNorm/);
assert.match(main, /urlIn\.addEventListener\("input", \(\) => \{ kbAddressDirty = true; \}\)/);
assert.match(main, /box\.hidden = false;\s*kbSyncSoon\(\)/);
assert.match(main, /raw\.loading/);
assert.match(main, /raw\.title/);
assert.match(main, /!agBrSource\) return/);
assert.match(html, /id="ag-br-show"/);
assert.match(html, /id="kb-back"/);
assert.match(kbview, /pub fn read_dom_json/);
assert.match(kbview, /pub fn open/);
assert.match(kbview, /pub fn open_and_wait/);
assert.match(kbview, /pub fn wait_for_load/);
assert.match(kbview, /static NAV: LazyLock<Mutex<\(\)>>/);
assert.match(kbview, /static OPEN_GATE: LazyLock<Mutex<\(\)>>/);
assert.match(kbview, /fn begin_navigation/);
assert.match(kbview, /request_started/);
assert.match(kbview, /request_finished/);
assert.match(kbview, /fn normalize_url/);
assert.match(kbview, /on_navigation\(\|url\| navigation_allowed\(url\)\)/);
assert.match(kbview, /fn navigation_allowed/);
assert.match(kbview, /fn js_string_value/);
assert.match(kbview, /html: \(document\.documentElement\.outerHTML \|\| ''\)\.slice\(0, 1500000\)/);
assert.doesNotMatch(kbview, /app\.emit\("kb:\/\/source", s\)/);
assert.doesNotMatch(kbview, /app\.emit\("kb:\/\/dom", s\)/);
assert.match(kbview, /pub fn navigate/);
assert.match(kbview, /if w <= 1\.0 \|\| h <= 1\.0 \{[\s\S]*?wv\.hide\(\)/);
assert.match(tools, /crate::shared_browser::read_dom_json/);
assert.match(tools, /browser_navigate/);
assert.equal((tools.match(/crate::shared_browser::open_and_wait/g) || []).length, 3);
assert.doesNotMatch(agent, /pub fn browser_fetch|pub fn browser_back|pub fn browser_current/);
assert.doesNotMatch(agent, /Command::new\("cmd"\)[\s\S]{0,120}start/);
assert.match(agent, /ShellExecuteW/);
assert.match(agent, /fn validate_external_target/);
assert.doesNotMatch(tauri, /agent::browser_fetch|agent::browser_back|agent::browser_current/);
for (const fn of ["kb_show", "kb_bounds", "kb_hide", "kb_hide_all", "kb_reload", "kb_navigate", "kb_open", "kb_back", "kb_source", "kb_read_dom"]) {
  assert.match(tauri, new RegExp(`async fn ${fn}\\(`), `${fn} must run off the Tauri main command path`);
}
assert.match(tauri, /fn win_ctl[\s\S]*?let w = app\.get_window\("main"\)/);
assert.match(tauri, /fn window_set_zoom[\s\S]*?app\.get_webview\("main"\)/);
assert.doesNotMatch(main, /kb-chat-host|kb-chat-url|kb-chat-open|kb-chat-save/);
assert.doesNotMatch(html, /id="kb-chat-host"|id="kb-chat-url"/);
assert.match(html, /data-tab="kb"[^>]*>[\s\S]*?<span>浏览器<\/span>/);
assert.doesNotMatch(help, /id:\s*"help-agent-links"|title:\s*"页面里的链接"/);
console.log(JSON.stringify({
  ok: true,
  host: "browser",
  sharedTools: ["browser_open", "browser_navigate", "browser_read", "browser_find"],
  checks: [
    "hide-resets-placement",
    "legacy-storage-cleanup",
    "load-wait",
    "callback-decode",
    "navigation-race",
    "scheme-allowlist",
    "shell-open",
    "address-draft",
  ],
}, null, 2));
