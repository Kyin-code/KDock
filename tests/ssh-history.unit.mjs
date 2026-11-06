import assert from "node:assert/strict";
import {
  normalizeSshProfiles,
  sshProfileId,
  sshProfileLabel,
  upsertSshProfile,
} from "../src/ssh-history.js";

assert.equal(
  sshProfileId({ user: "Root", host: "Example.COM", port: 22 }),
  "ssh:Root@example.com:22",
);
assert.equal(sshProfileLabel({ user: "root", host: "10.0.0.2", port: 2222 }), "root@10.0.0.2:2222");

const normalized = normalizeSshProfiles([
  {
    host: "old.example",
    port: 22,
    user: "root",
    auth: "password",
    rememberPassword: true,
    lastConnectedAt: 10,
    password: "must-not-survive",
  },
  { host: "new.example", port: 2202, user: "admin", auth: "key", lastConnectedAt: 20 },
  { host: "", port: 22 },
  { host: "new.example", port: 2202, user: "admin", lastConnectedAt: 30 },
]);
assert.deepEqual(normalized.map((item) => item.host), ["new.example", "old.example"]);
assert.equal(normalized[0].lastConnectedAt, 30);
assert.equal(normalized[1].rememberPassword, true);
assert.equal("password" in normalized[1], false);

const updated = upsertSshProfile(normalized, {
  host: "old.example",
  port: 22,
  user: "root",
  auth: "key",
  lastConnectedAt: 40,
});
assert.equal(updated.length, 2);
assert.equal(updated[0].host, "old.example");
assert.equal(updated[0].auth, "key");

console.log(JSON.stringify({ ok: true, sshProfiles: updated.length }));
