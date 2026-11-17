// The in-process local copy of one team's memory (docs/local-sync.md, docs/package-local.md).
//   <dir>/replica.snap  sealed snapshot (notes, facts, recall hot set, recent hints, stamp)
//   <dir>/replica.key   the host's replica key (0600), <dir>/lease.json, <dir>/state.json, <dir>/outbox.jsonl
// One process per directory is the "leader": it syncs, holds the WebSocket and writes the snapshot. Other processes
// on the same key follow: they reload the snapshot when it changes. Nothing here throws into a find.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEngine, LOCAL_RANK_VERSION } from "./engine.js";
import { api, NetError } from "./http.js";
import { isLegacy, open as sealOpen, replicaKey, replicaKeyId, seal } from "./seal.js";
import { FRESH_MS, FileLock, HEARTBEAT_MS, POLL_MS, WS_PING_MS, ensureDir, fileSig, hyperHeader, lineCid, unlinkQuiet, writePrivate } from "./util.js";
import { wsConnect } from "./ws.js";

class Stop extends Error {}
class SyncFail extends Error {}

const SNAP = "replica.snap";
const digestOf = (notes) => {
  const h = createHash("sha256");
  for (const uid of [...notes.keys()].sort()) h.update(`${uid}\0${(notes.get(uid).rev | 0)}\n`);
  return h.digest("hex");
};
const bySeq = (a, b) => (a.seq | 0) - (b.seq | 0) || (a.rev | 0) - (b.rev | 0);

export class Replica {
  constructor({ dir, cfg, hyper }) {
    this.dir = dir;
    this.cfg = cfg;
    this.hyper = hyper; // () => {mode, reason}, for the X-Brain-Hyper header
    this.p = (f) => path.join(dir, f);
    this.engine = null;
    this.noStorage = false;
    this.oldRuntime = false;
    this.engineOk = true;
    this.notes = new Map();
    this.facts = [];
    this.recall = [];
    this.recent = new Set();
    this.stamp = null;
    this.ready = false;
    this.hadCopy = false;
    this.rebuilding = false;
    this.needRebuild = false;
    this.revoked = false;
    this.closed = false;
    this.lastOkMs = 0;
    this.wsUp = false;
    this.wsFails = 0;
    this.leader = false;
    this.lock = new FileLock(this.p("sync.lock"), 150_000);
    this.snapSig = null;
    this.deepAt = 0;
    this.snapTimer = null;
    this.stateAt = 0;
    this.pending = new Map(); // notes this process added while following: kept until the snapshot has them
    this.pend = { hits: [], recent: [] }; // report that did not reach the host yet
    this.overlaySig = undefined;
    this.overlay = new Set();
    this.rebuildFailAt = 0;
    this.kickFlag = false;
    this.wake = null;
    this.ws = null;
    this.wsConnecting = false;
    this.wsNextAt = 0;
    this.wsPing = null;
    this.loop = null;
    this.leaseCache = { sig: null, le: null };
    this.onExit = () => {
      if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null; this.writeSnapshot(); } // a pending write is not lost
      this.lock.release();
    };
  }

  // ---- start and stop ----------------------------------------------------------------------------------------
  async start() {
    try {
      ensureDir(this.dir);
      const probe = this.p(".probe");
      writePrivate(probe, "x");
      unlinkQuiet(probe);
    } catch {
      this.noStorage = true;
      return;
    }
    try {
      this.engine = await createEngine();
    } catch {
      this.oldRuntime = true;
      return;
    }
    this.tryLead();
    if (this.leader) this.loadFromDisk();
    else this.followRefresh();
    process.on("exit", this.onExit);
    this.loop = this.run();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    if (this.leader && this.ready && !this.revoked) this.writeSnapshot();
    if (this.wsPing) clearInterval(this.wsPing);
    try { this.ws && this.ws.close(); } catch { /* closing */ }
    this.ws = null;
    this.wsUp = false;
    this.kick();
    this.lock.release();
    process.removeListener("exit", this.onExit);
    try { this.engine && this.engine.close(); } catch { /* closing */ }
    this.ready = false;
  }

  tryLead() {
    if (this.leader) return true;
    if (this.lock.tryAcquire()) this.leader = true;
    return this.leader;
  }

  // ---- gate: may this process answer a find from the local copy? ----------------------------------------------------
  /** {ok: true, reason: "synced"} to answer locally now, or {ok: false, reason} (stale: the copy is only catching up). */
  gate() {
    if (this.noStorage) return { ok: false, reason: "no_storage" };
    if (this.oldRuntime) return { ok: false, reason: "old_runtime" };
    if (this.revoked || this.closed) return { ok: false, reason: "no_copy_yet" };
    if (!this.engineOk) return { ok: false, reason: "engine_update" };
    if (!this.ready || this.rebuilding || this.needRebuild) return { ok: false, reason: this.hadCopy ? "rebuilding" : "no_copy_yet" };
    return this.fresh() ? { ok: true, reason: "synced" } : { ok: false, reason: "stale" };
  }

  fresh() {
    return this.wsUp || Date.now() - this.lastOkMs < FRESH_MS;
  }

  /** Can this copy answer while the host is unreachable? Needs a sound copy and an unexpired lease. */
  canAnswerOffline() {
    return !this.noStorage && !this.oldRuntime && !this.revoked && !this.closed && this.engineOk && this.ready && !this.rebuilding && !this.needRebuild && this.leaseValid();
  }

  syncedAgoS() {
    return this.lastOkMs ? Math.max(0, (Date.now() - this.lastOkMs) / 1000) : null;
  }

  leaseValid() {
    const le = this.readLease();
    if (!le || !le.lease_key || !le.expires_at) return false;
    const t = Date.parse(le.expires_at);
    return Number.isFinite(t) && t > Date.now();
  }

  readLease() {
    const f = this.p("lease.json");
    const sig = fileSig(f);
    if (sig !== this.leaseCache.sig) {
      let le = null;
      try { le = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* none yet */ }
      this.leaseCache = { sig, le };
    }
    return this.leaseCache.le;
  }

  saveLease(b64) {
    try {
      const raw = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      const parts = String(raw.payload || "").split("|");
      writePrivate(this.p("lease.json"), JSON.stringify({ lease: b64, lease_key: raw.lease_key, expires_at: parts[3] || "", renew_url: raw.renew_url || this.cfg.url + "/subscribe", sig: raw.sig, payload: raw.payload }));
    } catch { /* an unreadable lease changes nothing */ }
  }

  // ---- reading the snapshot -----------------------------------------------------------------------------------
  readKey() {
    try { return fs.readFileSync(this.p("replica.key"), "utf8").trim() || null; } catch { return null; }
  }

  /** Read, authenticate and verify the snapshot. Returns the parsed object; throws when it cannot be trusted. */
  readSnapshot() {
    const rk = this.readKey();
    if (!rk) throw new Error("no replica key");
    const blob = fs.readFileSync(this.p(SNAP));
    const snap = JSON.parse(sealOpen(blob, replicaKey(rk), "snapshot").toString("utf8"));
    if (!snap || snap.v !== 1 || snap.key_id !== replicaKeyId(rk) || !Array.isArray(snap.notes)) throw new Error("snapshot does not match its key");
    const m = new Map(snap.notes.map((n) => [n.uid, n]));
    if (m.size !== snap.notes.length || m.size !== snap.count || digestOf(m) !== snap.digest) throw new Error("snapshot count or digest differs from its stamp");
    return { snap, map: m, legacy: isLegacy(blob) };
  }

  /** Startup (leader) or reload (follower). False when there is no usable copy; a damaged one is deleted. */
  loadFromDisk() {
    const f = this.p(SNAP);
    const sig = fileSig(f);
    if (sig === null) return false;
    this.hadCopy = true;
    try {
      const { snap, map, legacy } = this.readSnapshot();
      this.install(map, snap.facts || [], snap.recall || [], snap.recent || [], { epoch: snap.epoch, cursor: snap.cursor, facts_rev: snap.facts_rev });
      this.snapSig = sig;
      this.deepAt = Date.now();
      if (legacy && this.leader) this.writeSnapshot(); // an old r1 snapshot is read once, then rewritten as AES-256-GCM
      const st = this.readState();
      this.lastOkMs = st && Number.isFinite(st.last_ok_ms) ? st.last_ok_ms : 0;
      for (const [uid, n] of this.pending) {
        if (this.notes.has(uid)) this.pending.delete(uid);
        else this.engine.upsert(n);
      }
      return true;
    } catch {
      this.ready = false;
      if (this.leader) {
        unlinkQuiet(f);
        this.needRebuild = true;
      }
      return false;
    }
  }

  install(map, facts, recall, recent, stamp) {
    const sorted = [...map.values()].sort(bySeq);
    this.engine.load(sorted, facts, recall, recent);
    this.overlaySig = undefined;
    this.overlay = new Set();
    this.notes = map;
    this.facts = facts;
    this.recall = recall;
    this.recent = new Set(recent);
    this.stamp = stamp;
    this.ready = true;
    this.hadCopy = true;
    this.needRebuild = false;
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.p("state.json"), "utf8")); } catch { return null; }
  }

  writeState(force = false) {
    const now = Date.now();
    if (!force && now - this.stateAt < 1000) return;
    this.stateAt = now;
    try { writePrivate(this.p("state.json"), JSON.stringify({ last_ok_ms: this.lastOkMs, engine: LOCAL_RANK_VERSION, pid: process.pid })); } catch { /* best effort */ }
  }

  markOk() {
    this.lastOkMs = Date.now();
    if (this.leader) this.writeState();
  }

  // ---- writing the snapshot -------------------------------------------------------------------------------------
  scheduleSnapshot() {
    if (!this.leader || this.snapTimer || this.closed) return;
    this.snapTimer = setTimeout(() => { this.snapTimer = null; this.writeSnapshot(); }, 500);
    this.snapTimer.unref();
  }

  writeSnapshot() {
    if (!this.leader || !this.ready || this.revoked) return;
    try {
      const rk = this.readKey();
      if (!rk) return;
      const obj = {
        v: 1,
        key_id: replicaKeyId(rk),
        epoch: this.stamp.epoch,
        cursor: this.stamp.cursor,
        facts_rev: this.stamp.facts_rev,
        count: this.notes.size,
        digest: digestOf(this.notes),
        notes: [...this.notes.values()],
        facts: this.facts,
        recall: this.recall,
        recent: [...this.recent],
      };
      writePrivate(this.p(SNAP), seal(Buffer.from(JSON.stringify(obj), "utf8"), replicaKey(rk), "snapshot"));
      this.snapSig = fileSig(this.p(SNAP));
      this.deepAt = Date.now();
      this.writeState(true);
    } catch { /* a full or read-only disk only means no snapshot this time; the in-memory copy stays right */ }
  }

  // ---- keeping the disk honest ---------------------------------------------------------------------------------
  /** Cheap checks before a local answer: deleted or swapped snapshot at once, a deep check at most once a minute. */
  checkDisk() {
    if (!this.engine || this.noStorage || this.revoked || this.closed) return;
    if (!this.leader) {
      this.tryLead();
      if (!this.leader) return this.followRefresh();
      if (!this.ready) this.loadFromDisk();
    }
    if (!this.ready || this.needRebuild || this.snapTimer) return; // a write of ours is pending: the file is about to change
    const sig = fileSig(this.p(SNAP));
    if (sig === null) return this.snapSig !== null ? this.damaged("snapshot was deleted") : undefined;
    if (sig !== this.snapSig || Date.now() - this.deepAt > 60_000) this.verifyDeep();
  }

  verifyDeep() {
    this.deepAt = Date.now();
    try {
      this.readSnapshot();
      this.snapSig = fileSig(this.p(SNAP));
    } catch {
      this.damaged("snapshot failed its checks");
    }
  }

  damaged(why) {
    this.ready = false;
    this.needRebuild = true;
    this.rebuildWhy = why;
    unlinkQuiet(this.p(SNAP));
    this.kick();
  }

  followRefresh() {
    const sig = fileSig(this.p(SNAP));
    if (sig === null) { this.ready = false; return; }
    if (sig !== this.snapSig || !this.ready) this.loadFromDisk();
    const st = this.readState();
    if (st && Number.isFinite(st.last_ok_ms)) this.lastOkMs = st.last_ok_ms;
  }

  // ---- the sync loop ---------------------------------------------------------------------------------------------
  kick() {
    this.kickFlag = true;
    if (this.wake) this.wake();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      if (this.kickFlag || this.closed) { this.kickFlag = false; return resolve(); }
      const t = setTimeout(done, ms);
      t.unref();
      this.wake = done;
      function done() { clearTimeout(t); resolve(); }
    }).then(() => { this.wake = null; this.kickFlag = false; });
  }

  /** Run one cycle now and wait for it (what `await client.sync()` does). Resolves when done; never throws. */
  async syncNow() {
    if (this.noStorage || this.oldRuntime || this.closed || this.revoked) return;
    if (!this.leader) this.tryLead();
    if (!this.leader) return this.followRefresh();
    try {
      await this.cycle();
    } catch { /* offline or refused: the state fields say which */ }
  }

  async run() {
    while (!this.closed && !this.revoked) {
      if (this.leader) {
        this.lock.touch();
        try {
          await this.cycle();
        } catch (e) {
          if (e instanceof Stop) break;
        }
        this.ensureWs();
      } else {
        this.tryLead();
        if (!this.leader) this.followRefresh();
      }
      const polling = !this.wsUp && this.wsFails >= 3;
      await this.sleep(!this.leader ? 15_000 : polling ? POLL_MS : HEARTBEAT_MS);
    }
  }

  async cycle() {
    if (this.closed || this.revoked) throw new Stop();
    if (this.ready && !this.needRebuild) this.checkDisk();
    if (!this.ready || this.needRebuild) await this.rebuild(this.rebuildWhy || "no usable copy");
    else await this.delta();
    if (!this.revoked) await this.pushOutbox();
  }

  async postSync(body) {
    let res;
    try {
      res = await api(this.cfg, "POST", "/v1/sync", body, this.hyper());
    } catch (e) {
      throw e instanceof NetError ? e : new NetError(e);
    }
    if (res.status === 401 || res.status === 403) {
      this.wipe(res.status, res.body);
      throw new Stop();
    }
    if (res.status !== 200 || !res.body || typeof res.body !== "object" || !("cursor" in res.body)) throw new SyncFail("sync answered " + res.status);
    const b = res.body;
    const mark = this.p("engine.mismatch");
    if (String(b.engine || "") !== LOCAL_RANK_VERSION) {
      this.engineOk = false;
      try { writePrivate(mark, String(b.engine || "")); } catch { /* best effort */ }
    } else {
      this.engineOk = true;
      unlinkQuiet(mark);
    }
    if (b.lease) this.saveLease(b.lease);
    return b;
  }

  takeReport() {
    const r = this.ready && this.engine ? this.engine.drainReport() : { hits: [], recent: [] };
    const keep = (x) => !String(typeof x === "string" ? x : x && x.key).startsWith("ob:");
    const out = { hits: [...this.pend.hits, ...r.hits].filter(keep).slice(-200), recent: [...this.pend.recent, ...r.recent].filter(keep).slice(-200) };
    this.pend = { hits: [], recent: [] };
    return out;
  }

  async delta() {
    let { cursor: since, epoch, facts_rev: frev } = this.stamp;
    const report = this.takeReport();
    let delivered = false;
    for (;;) {
      const body = { since, epoch, facts_rev: frev, limit: 500 };
      if (!delivered) { body.hits = report.hits; body.recent = report.recent; }
      let res;
      try {
        res = await this.postSync(body);
      } catch (e) {
        if (!delivered) this.pend = report;
        throw e;
      }
      delivered = true;
      if (res.reset) return this.rebuild("the host asked for a reset");
      const why = this.applyDelta(res);
      if (why !== "ok") return this.rebuild("replica check: " + why);
      since = res.cursor;
      epoch = res.epoch;
      frev = res.facts_rev;
      this.markOk();
      if (!res.more) break;
    }
    if (this.dataChanged) {
      this.dataChanged = false;
      this.scheduleSnapshot(); // only when the notes, facts or cursor moved: a quiet heartbeat leaves the file alone
    }
  }

  /** "ok", or why this copy can no longer be trusted (the caller rebuilds). */
  applyDelta(res) {
    const rk = this.readKey();
    if (!rk || replicaKeyId(res.replica_key || "") !== replicaKeyId(rk)) return "rekey";
    if (String(res.epoch) !== this.stamp.epoch) return "epoch";
    if ((res.notes || []).length || (res.deleted || []).length || res.facts != null || Number(res.cursor) !== this.stamp.cursor) this.dataChanged = true;
    for (const uid of res.deleted || []) {
      this.notes.delete(uid);
      this.pending.delete(uid);
      this.engine.remove(uid);
    }
    for (const n of [...(res.notes || [])].sort(bySeq)) {
      this.notes.set(n.uid, n);
      this.pending.delete(n.uid);
      this.engine.upsert(n);
    }
    if (res.facts != null) {
      this.facts = res.facts;
      this.engine.setFacts(res.facts);
    }
    this.recall = res.recall || [];
    this.engine.setRecall(this.recall);
    const rec = res.recent || [];
    for (const u of rec) this.recent.add(u);
    this.engine.setRecent(rec);
    this.stamp = { epoch: String(res.epoch), cursor: Number(res.cursor), facts_rev: Number(res.facts_rev) };
    if (res.count != null && Number(res.count) !== this.notes.size) return "count";
    return "ok";
  }

  /** Pull everything from 0, then swap it in at once. Finds go to the host meanwhile. */
  async rebuild(why) {
    if (Date.now() - this.rebuildFailAt < 5000) return;
    this.rebuilding = true;
    try {
      const map = new Map();
      let facts = [];
      let recall = [];
      let recent = [];
      let since = 0;
      let rk = null;
      let epoch = "";
      let frev = 0;
      const report = this.takeReport();
      let delivered = false;
      for (;;) {
        const body = { since, epoch: "", limit: 1000 };
        if (!delivered) { body.hits = report.hits; body.recent = report.recent; }
        let res;
        try {
          res = await this.postSync(body);
        } catch (e) {
          if (!delivered) this.pend = report;
          throw e;
        }
        delivered = true;
        if (!res.replica_key || (rk && res.replica_key !== rk)) throw new SyncFail("replica key missing or changed during the pull");
        rk = res.replica_key;
        for (const uid of res.deleted || []) map.delete(uid);
        for (const n of res.notes || []) map.set(n.uid, n);
        if (res.facts != null) facts = res.facts;
        recall = res.recall || [];
        recent = res.recent || [];
        epoch = String(res.epoch);
        frev = Number(res.facts_rev);
        since = Number(res.cursor);
        if (!res.more) {
          if (res.count != null && Number(res.count) !== map.size) throw new SyncFail("row count differs from the host");
          break;
        }
      }
      if (this.revoked || this.closed) return;
      writePrivate(this.p("replica.key"), rk);
      this.install(map, facts, recall, recent, { epoch, cursor: since, facts_rev: frev });
      this.rebuildWhy = "";
      this.markOk();
      this.writeSnapshot();
    } catch (e) {
      if (!(e instanceof Stop) && !(e instanceof NetError)) this.rebuildFailAt = Date.now();
      throw e;
    } finally {
      this.rebuilding = false;
    }
  }

  // ---- WebSocket change pings ----------------------------------------------------------------------------------
  ensureWs() {
    if (this.ws || this.wsConnecting || this.closed || this.revoked || Date.now() < this.wsNextAt) return;
    this.wsConnecting = true;
    const back = () => {
      this.wsUp = false;
      this.wsConnecting = false;
      this.ws = null;
      if (this.wsPing) { clearInterval(this.wsPing); this.wsPing = null; }
      this.wsNextAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.wsFails, 5));
    };
    try {
      this.ws = wsConnect(this.cfg.url, this.cfg.key, () => hyperHeader(this.hyper()), {
        open: () => {
          this.wsUp = true;
          this.wsFails = 0;
          this.wsConnecting = false;
          this.kick(); // catch up on anything missed while the socket was down
          this.wsPing = setInterval(() => this.ws && this.ws.send("ping"), WS_PING_MS);
          this.wsPing.unref();
        },
        message: (text) => {
          if (text === "pong") return;
          try {
            const t = JSON.parse(text).t;
            if (t === "changed" || t === "reset") this.kick();
          } catch { /* not ours */ }
        },
        close: (code) => {
          back();
          if (code === 4401 || code === 4403) this.kick(); // the sync that follows gets 401/403 and wipes
          else if (!this.closed) this.wsNextAt = Date.now() + 1000;
        },
        fail: (status) => {
          this.wsFails++;
          back();
          if (status === 401 || status === 403) this.kick();
        },
      });
    } catch {
      this.wsFails++;
      back();
    }
  }

  // ---- revoke, suspend, purge --------------------------------------------------------------------------------
  /** 401 or 403: delete the copy, its key and the offline lease. The outbox stays (the user's unsent writes). */
  wipe(status, body) {
    if (this.revoked) return;
    this.revoked = true;
    this.ready = false;
    this.wsUp = false;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    for (const f of [SNAP, "replica.key", "state.json", "engine.mismatch"]) unlinkQuiet(this.p(f));
    try {
      for (const f of fs.readdirSync(this.dir)) if (f.startsWith(SNAP + ".tmp-")) unlinkQuiet(this.p(f));
    } catch { /* directory gone */ }
    try {
      writePrivate(this.p("lease.json"), JSON.stringify({ expires_at: "1970-01-01T00:00:00Z", revoked: status === 401, renew_url: (body && body.renew_url) || this.cfg.url + "/subscribe" }));
    } catch { /* best effort */ }
    try { this.engine && this.engine.load([], [], [], []); } catch { /* emptied anyway */ }
    this.notes = new Map();
    this.pending.clear();
    try { this.ws && this.ws.close(); } catch { /* closing */ }
    this.ws = null;
    this.kick();
  }

  // ---- answering ---------------------------------------------------------------------------------------------
  /** Local answer from the engine, with the outbox lines overlaid as working-set notes. */
  async find(q, n, bot) {
    this.checkDisk();
    if (!this.ready) throw new Error("local copy not ready");
    this.refreshOverlay();
    return this.engine.find(q, n, bot || null);
  }

  refreshOverlay() {
    const f = this.p("outbox.jsonl");
    const sig = fileSig(f);
    if (sig === this.overlaySig) return;
    const fresh = new Map();
    if (sig) {
      let lines = [];
      try { lines = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()); } catch { /* none */ }
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          const t = Number(row.t) || Date.now() / 1000;
          const note = overlayNote(String(row.bot), String(row.text), t);
          fresh.set(note.uid, note);
        } catch { /* unreadable lines are left for the push to report */ }
      }
    }
    for (const uid of this.overlay) if (!fresh.has(uid)) this.engine.remove(uid);
    for (const [uid, note] of fresh) if (!this.overlay.has(uid)) this.engine.upsert(note);
    this.overlay = new Set(fresh.keys());
    this.overlaySig = sig;
  }

  /** The stored note from a 201 /v1/add reply, so the writer finds it at once. */
  insertNote(note) {
    if (!this.ready || !this.engine || !note || !note.uid || this.revoked) return;
    this.engine.upsert(note, true);
    if (this.leader) {
      this.notes.set(note.uid, note);
      this.scheduleSnapshot();
    } else this.pending.set(note.uid, note);
  }

  forget(uid) {
    if (!this.ready || !this.engine) return;
    this.engine.remove(uid);
    this.pending.delete(uid);
    if (this.notes.delete(uid)) this.scheduleSnapshot();
  }

  // ---- outbox ----------------------------------------------------------------------------------------------------
  /** Send pending adds. A line leaves the outbox only after the host answered 201 (or refused it for good). */
  async pushOutbox({ wait = false } = {}) {
    const file = this.p("outbox.jsonl");
    const read = () => { try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; } };
    const lines = read();
    if (!lines.length || this.revoked) return { sent: 0, left: lines.length };
    const plock = new FileLock(this.p("outbox.push.lock"), 120_000);
    if (!(wait ? await plock.acquire(5000) : plock.tryAcquire())) return { sent: 0, left: lines.length };
    const sent = [];
    const rejected = [];
    try {
      for (const line of lines) {
        let row;
        let payload;
        try {
          row = JSON.parse(line);
          payload = { bot: row.bot, text: row.text, cid: lineCid(row, line) };
        } catch {
          continue;
        }
        let res;
        try {
          res = await api(this.cfg, "POST", "/v1/add", payload, this.hyper());
        } catch {
          break;
        }
        if (res.status === 401 || res.status === 403) { this.wipe(res.status, res.body); break; }
        if (res.status === 201 && res.body && res.body.ok) {
          sent.push(line);
          this.insertNote(res.body.note);
        } else if (res.status === 400) rejected.push([line, (res.body && res.body.error) || "refused"]);
        else break;
      }
    } finally {
      if (sent.length || rejected.length) {
        await removeLines(this.dir, [...sent, ...rejected.map((r) => r[0])]);
        if (rejected.length) {
          try {
            fs.appendFileSync(this.p("outbox-rejected.jsonl"), rejected.map(([line, why]) => JSON.stringify({ line, reason: why, t: Date.now() / 1000 }) + "\n").join(""), { mode: 0o600 });
          } catch { /* best effort */ }
        }
      }
      plock.release();
    }
    return { sent: sent.length, left: read().length };
  }
}

/** Drop the given lines (one occurrence each) from the outbox, keeping anything appended meanwhile. */
export async function removeLines(dir, gone) {
  const lock = new FileLock(path.join(dir, "outbox.lock"));
  if (!(await lock.acquire(5000))) return false;
  try {
    const file = path.join(dir, "outbox.jsonl");
    const rest = [...gone];
    const keep = [];
    for (const l of fs.readFileSync(file, "utf8").split("\n").filter((x) => x.trim())) {
      const i = rest.indexOf(l);
      if (i >= 0) rest.splice(i, 1);
      else keep.push(l);
    }
    writePrivate(file, keep.map((l) => l + "\n").join(""), { fsync: true });
    return true;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

/** Append one line and fsync it. */
export async function appendOutbox(dir, row) {
  const lock = new FileLock(path.join(dir, "outbox.lock"));
  await lock.acquire(2000);
  try {
    const fd = fs.openSync(path.join(dir, "outbox.jsonl"), "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(row) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    lock.release();
  }
}

/** An unsent outbox line as a working-set note, so it is findable before the host confirms it. */
export function overlayNote(bot, text, t) {
  const b = bot.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
  const rid = text.split("|")[0].trim() || "NEW";
  const tags = [...new Set(text.toLowerCase().match(/[a-z0-9@.+#-]{3,}/g) || [])].slice(0, 16).join(" ");
  const uid = "ob:" + createHash("sha1").update(`${b}\0${text}\0${t}`).digest("hex").slice(0, 16);
  return { uid, tier: "ws", bot: b, tags, text, ts: new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), src: "ws", id: rid, user: "", rev: 0, created_ms: Math.round(t * 1000) };
}
