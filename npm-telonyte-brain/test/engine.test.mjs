import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, LOCAL_RANK_VERSION } from "../lib/engine.js";

const note = (i, text, extra = {}) => ({
  uid: "u" + i, tier: "ws", bot: "emperor", tags: "", text, ts: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().replace(/\.\d+Z$/, "Z"),
  src: "ws", id: "NEW", user: "", rev: i, created_ms: Date.UTC(2026, 10, 1 + i), seq: i, ...extra,
});

test("engine answers like the server code path and reports hits", async () => {
  const e = await createEngine();
  assert.match(LOCAL_RANK_VERSION, /^hosted-/);
  e.load([
    note(1, "ST-0003 | status: carrier check pending, waiting on Alex's yes"),
    note(2, "D-0045 | finance rule: Alex and Sam only; approval needed for money"),
    note(3, "NEW | the registrar move from godaddy to cloudflare is pending"),
  ], [], [], []);
  const r = await e.find("who approves money", 5);
  assert.ok(Array.isArray(r.lines) && r.lines.length >= 2);
  assert.match(r.lines[0], /D-0045/);
  assert.match(r.lines.at(-1), /^\(\d+(\.\d+)? ms, \d+ bytes\)$/);
  const rep = e.drainReport();
  assert.ok(rep.hits.some((h) => h.kind === "note" && h.key === "u2"));
  assert.ok(rep.recent.includes("u2"));
  assert.deepEqual(e.drainReport(), { hits: [], recent: [] });
  e.close();
});

test("deleted notes disappear and the SQL fallbacks see changes", async () => {
  const e = await createEngine();
  e.load([note(1, "alpha bravo charlie marker one"), note(2, "delta echo foxtrot marker two")], [], [], []);
  let r = await e.find("zzzznomatch", 5);
  assert.match(r.lines[0], /NOT FOUND|marker/); // forces the fallback path and fills the SQL tables
  e.upsert(note(3, "golf hotel india marker three"));
  r = await e.find("hotel", 5);
  assert.match(r.lines.join("\n"), /hotel/);
  e.remove("u3");
  r = await e.find("hotel", 5);
  assert.doesNotMatch(r.lines.join("\n"), /hotel india/);
  e.close();
});
