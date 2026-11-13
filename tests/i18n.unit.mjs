import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_GROUPS, HELP_TITLE_EN } from "../src/help-content.js";
import { changeLanguage, createI18n, translate } from "../src/i18n.js";
import { EN } from "../src/locales/en.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFile(resolve(root, path), "utf8");

const [main, html, ...modules] = await Promise.all([
  read("src/main.js"),
  read("index.html"),
  ...(await readdir(resolve(root, "src")))
    .filter((name) => name.endsWith(".js") && name !== "main.js")
    .map((name) => read(`src/${name}`)),
]);

assert.ok(Object.keys(EN).length > 1000, "English dictionary unexpectedly small");

const testI18n = createI18n({
  "你好": "Hello",
  "参数 {{args}}": "Args {{args}}",
}, "en");
assert.equal(translate(testI18n, "en", "你好"), "Hello");
assert.equal(translate(testI18n, "en", "参数 {{args}}"), "Args {{args}}");
assert.equal(translate(testI18n, "en", "参数 {{args}}", { args: "build" }), "Args build");
assert.equal(translate(testI18n, "zh", "你好"), "你好");
await changeLanguage(testI18n, "zh");
assert.equal(translate(testI18n, "zh", "你好"), "你好");
assert.match(main, /createI18n\(EN, LANG\)/);

for (const group of HELP_GROUPS) {
  for (const item of group.items) {
    assert.ok(item.title && item.zh && item.en, `help item ${item.id} is not bilingual`);
    assert.ok(HELP_TITLE_EN[item.title], `help title missing EN mapping: ${item.title}`);
  }
}

const literalCalls = [];
for (const source of [main, ...modules]) {
  for (const match of source.matchAll(/\b(?:en|T)\("([^"\n]*[\u3400-\u9fff][^"\n]*)"\)/g)) {
    // Decode JS string escapes (notably doubled backslashes in Windows paths).
    literalCalls.push(JSON.parse(`"${match[1]}"`));
  }
}
const missing = [...new Set(literalCalls)].filter((key) => !EN[key]);
assert.deepEqual(missing, [], `UI strings passed to en()/T() have no English translation:\n${missing.join("\n")}`);

const htmlAttributeCopy = [
  ...html.matchAll(/(?:title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/g),
].map((match) => match[1]
  .replace(/&#10;/g, "\n")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&"));
const missingAttributes = [...new Set(htmlAttributeCopy)].filter((key) => !EN[key]);
assert.deepEqual(
  missingAttributes,
  [],
  `Static title/placeholder copy has no English translation:\n${missingAttributes.join("\n")}`,
);

assert.ok((html.match(/data-en=/g) || []).length >= 60, "static bilingual markup is unexpectedly sparse");
assert.equal((html.match(/id="set-lang-zh"/g) || []).length, 1);
assert.equal((html.match(/id="set-lang-en"/g) || []).length, 1);
const settingsGroupLabels = [...html.matchAll(/class="modalnav-label">([^<]+)</g)]
  .map((match) => match[1].trim());
const missingGroupLabels = settingsGroupLabels.filter((label) => !EN[label]);
assert.deepEqual(
  missingGroupLabels,
  [],
  `Settings navigation group labels have no English translation:\n${missingGroupLabels.join("\n")}`,
);

console.log(JSON.stringify({
  ok: true,
  dictionaryEntries: Object.keys(EN).length,
  helpItems: HELP_GROUPS.reduce((n, group) => n + group.items.length, 0),
  literalEnCalls: new Set(literalCalls).size,
  translatedAttributes: new Set(htmlAttributeCopy).size,
  staticDataEnAttributes: (html.match(/data-en=/g) || []).length,
}, null, 2));
