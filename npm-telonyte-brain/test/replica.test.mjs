import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "../index.js";
import { hyperText, nodeHasSqlite, cfgId, lineCid } from "../lib/util.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { open, isLegacy, replicaKey, replicaKeyId, seal } from "../lib/seal.js";
import { Replica } from "../lib/replica.js";
import { createEngine } from "../lib/engine.js";

test("seal round trip (AES-256-GCM, r2), tamper, wrong slot and wrong key", () => {
  const k = replicaKey("abc");
  const blob = seal(Buffer.from("hello notes"), k, "snapshot");
  assert.equal(blob.subarray(0, 2).toString(), "r2");
  assert.equal(blob.length, 2 + 12 + "hello notes".length + 16);
  assert.ok(!blob.includes(Buffer.from("hello notes")));
  assert.equal(open(blob, k, "snapshot").toString(), "hello notes");
  assert.notDeepEqual(seal(Buffer.from("hello notes"), k, "snapshot"), blob); // fresh nonce each time
  assert.equal(open(seal(Buffer.alloc(0), k, "snapshot"), k, "snapshot").length, 0);
  for (const i of [3, 20, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] ^= 1;
    assert.throws(() => open(bad, k, "snapshot"));
  }
  assert.throws(() => open(blob.subarray(0, blob.length - 1), k, "snapshot"));
  assert.throws(() => open(blob, k, "facts"));
  assert.throws(() => open(blob, replicaKey("other"), "snapshot"));
  assert.equal(replicaKeyId("abc").length, 16);
});

// The old r1 construction (SHAKE-256 keystream + HMAC), built here only to prove old files can still be read once.
function oldR1(data, key, aad) {
  const hm = (kk, m) => createHmac("sha256", kk).update(m).digest();
  const ek = hm(key, "brain-replica-enc"), mk = hm(key, "brain-replica-mac");
  const nonce = randomBytes(16);
  const ks = data.length ? createHash("shake256", { outputLength: data.length }).update(Buffer.concat([ek, nonce])).digest() : Buffer.alloc(0);
  const body = Buffer.from(data.map((b, i) => b ^ ks[i]));
  const head = Buffer.concat([Buffer.from("r1"), nonce, body]);
  return Buffer.concat([head, hm(mk, Buffer.concat([Buffer.from(aad), Buffer.from("|"), head]))]);
}

test("old r1 blob opens once, is flagged legacy, and its rewrite is r2", () => {
  const k = replicaKey("abc");
  const old = oldR1(Buffer.from("old notes"), k, "snapshot");
  assert.equal(isLegacy(old), true);
  assert.equal(open(old, k, "snapshot").toString(), "old notes");
  assert.throws(() => open(old, k, "facts"));
  assert.throws(() => open(old, replicaKey("other"), "snapshot"));
  const bad = Buffer.from(old);
  bad[20] ^= 1;
  assert.throws(() => open(bad, k, "snapshot"));
  const fresh = seal(open(old, k, "snapshot"), k, "snapshot");
  assert.equal(isLegacy(fresh), false);
  assert.equal(fresh.subarray(0, 2).toString(), "r2");
  assert.equal(open(fresh, k, "snapshot").toString(), "old notes");
});

test("an old r1 snapshot file is read and rewritten as r2 by the leader", { skip: !nodeHasSqlite(process.versions.node) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-mig-"));
  const rk = "mig-key";
  const note = { uid: "u1", seq: 1, rev: 1, text: "legacy note" };
  const digest = createHash("sha256").update("u1\0" + "1\n").digest("hex");
  const snap = { v: 1, key_id: replicaKeyId(rk), epoch: "e", cursor: 1, facts_rev: 0, count: 1, digest, notes: [note], facts: [], recall: [], recent: [] };
  fs.writeFileSync(path.join(dir, "replica.key"), rk);
  const file = path.join(dir, "replica.snap");
  fs.writeFileSync(file, oldR1(Buffer.from(JSON.stringify(snap)), replicaKey(rk), "snapshot"));
  const rep = new Replica({ dir, cfg: { url: "http://127.0.0.1:9", key: "brn_mig" }, hyper: () => ({ mode: "local", reason: "synced" }) });
  rep.engine = await createEngine();
  rep.leader = true;
  try {
    assert.equal(rep.loadFromDisk(), true);
    const after = fs.readFileSync(file);
    assert.equal(after.subarray(0, 2).toString(), "r2");
    assert.equal(rep.readSnapshot().snap.notes[0].text, "legacy note");
    assert.equal(rep.readSnapshot().legacy, false);
  } finally {
    rep.engine.close();
  }
});

test("Hyper speed text and runtime check", () => {
  assert.equal(hyperText("local", "synced", 4), "Hyper speed: on (local copy, synced 4s ago)");
  assert.equal(hyperText("local", "offline"), "Hyper speed: on (local copy, offline)");
  assert.equal(hyperText("host", "no_copy_yet"), "Hyper speed: off (using host: no local copy yet)");
  assert.equal(hyperText("host", "old_runtime"), "Hyper speed: off (using host: Node.js 22.13 or newer is needed for the local copy)");
  assert.equal(nodeHasSqlite("22.12.0"), false);
  assert.equal(nodeHasSqlite("22.13.0"), true);
  assert.equal(nodeHasSqlite("18.20.0"), false);
  assert.equal(nodeHasSqlite("24.1.0"), true);
});

test("client ids match the CLI's rules", () => {
  assert.equal(cfgId("http://x", "k").length, 16);
  assert.equal(lineCid({ cid: "abcdefgh12" }, "l"), "abcdefgh12");
  assert.match(lineCid({}, "some line"), /^ob-[0-9a-f]{40}$/);
});

test("opted out and missing key", async () => {
  const c = createClient({ url: "http://127.0.0.1:9", key: "k", local: false });
  assert.equal(c.hyper().text, "Hyper speed: off (using host: local copy turned off)");
  await assert.rejects(c.find("x"));
  const none = createClient({ url: "http://127.0.0.1:9", key: "", local: false });
  await assert.rejects(none.find("x"), /Set BRAIN_KEY/);
});

test("host down: add waits in the outbox with a client id, never throws on the disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-unit-"));
  const c = createClient({ url: "http://127.0.0.1:9", key: "brn_unit", cacheDir: dir });
  await c.ready();
  const r = await c.add("bot", "NEW | queued while offline");
  assert.equal(r.queued, true);
  const row = JSON.parse(fs.readFileSync(path.join(dir, "outbox.jsonl"), "utf8").trim());
  assert.equal(row.cid, r.cid);
  assert.equal(fs.statSync(path.join(dir, "outbox.jsonl")).mode & 0o777, 0o600);
  c.close();
});
