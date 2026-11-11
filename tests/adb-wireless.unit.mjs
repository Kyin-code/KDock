import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findAdbConnectService,
  normalizeAdbAddress,
  pairGuidFromText,
  parseAdbMdns,
} from "../src/adb-wireless.js";

const services = parseAdbMdns([
  "adb-b400e73-iRIQge    _adb-tls-connect._tcp    192.168.1.33:42117",
  "adb-b400e73-iRIQge    _adb-tls-pairing._tcp    192.168.1.33:44819",
]);
assert.deepEqual(services, [
  { name: "adb-b400e73-iRIQge", kind: "adb-tls-connect", host: "192.168.1.33", port: 42117 },
  { name: "adb-b400e73-iRIQge", kind: "adb-tls-pairing", host: "192.168.1.33", port: 44819 },
]);

const guid = pairGuidFromText("Successfully paired to 192.168.1.33:44819 [guid=adb-b400e73-iRIQge]");
assert.equal(guid, "adb-b400e73-iRIQge");
assert.deepEqual(
  findAdbConnectService(services, { guid, host: "192.168.1.33" }),
  { name: "adb-b400e73-iRIQge", kind: "adb-tls-connect", host: "192.168.1.33", port: 42117 },
);
assert.equal(findAdbConnectService(services, { host: "192.168.1.33" }).port, 42117);
assert.equal(findAdbConnectService(services, { host: "192.168.1.99" }), null);

assert.deepEqual(normalizeAdbAddress("192.168.1.33:42117"), {
  host: "192.168.1.33",
  port: 42117,
  target: "192.168.1.33:42117",
});
assert.deepEqual(normalizeAdbAddress("192.168.1.33", 41053), {
  host: "192.168.1.33",
  port: 41053,
  target: "192.168.1.33:41053",
});
assert.equal(normalizeAdbAddress("192.168.1.33").target, "");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [main, html] = await Promise.all([
  readFile(resolve(root, "src/main.js"), "utf8"),
  readFile(resolve(root, "index.html"), "utf8"),
]);
assert.match(main, /findAdbConnectService/);
assert.match(main, /adbAutoConnectAfterPair/);
assert.doesNotMatch(main, /adb-wl-host|adb-wl-port/);
assert.match(html, /data-adbp="connect"/);
assert.match(html, /data-adbp="mirror"/);
assert.match(html, /data-adbp="tools"/);
assert.match(html, /data-adbp="logs"/);
assert.match(html, /id="adb-pair-addr"/);
assert.match(html, /id="adb-connect-addr"/);
assert.match(html, /data-adb-open="connect"/);
assert.match(html, /data-adb-preset="wireless"/);

console.log(JSON.stringify({
  ok: true,
  services,
  guid,
  connectPort: findAdbConnectService(services, { guid }).port,
}, null, 2));
