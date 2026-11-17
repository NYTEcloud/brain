// The local find engine: the server's own TenantBrain (lib/server-engine.js, bundled from src/tenant.ts) running
// in this process. Its SQL storage is an in-memory node:sqlite database; the notes and fts tables of that database
// are only filled the first time a query needs them (the FTS5 and LIKE fallbacks), everything else answers from
// the in-memory index, exactly like the server.
import { LOCAL_RANK_VERSION } from "./engine-version.js";

export { LOCAL_RANK_VERSION };

const emptyCursor = () => cursor([]);
function cursor(rows) {
  return {
    toArray: () => rows,
    one() {
      if (rows.length !== 1) throw new Error("expected exactly one row");
      return rows[0];
    },
    raw: () => rows.map((r) => Object.values(r)),
    rowsWritten: 0,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

function makeSql(db, hooks) {
  const prepared = new Map();
  return {
    exec(sql, ...params) {
      if (hooks.closed()) return emptyCursor(); // a flush timer that fires after close() does nothing
      hooks.before(sql);
      if (!params.length && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ""))) {
        db.exec(sql);
        return emptyCursor();
      }
      let st = prepared.get(sql);
      if (!st) prepared.set(sql, (st = db.prepare(sql)));
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return cursor(st.all(...params).map((r) => ({ ...r })));
      st.run(...params);
      return emptyCursor();
    },
    get databaseSize() {
      const one = (s) => Object.values(db.prepare(s).get())[0];
      return one("PRAGMA page_count") * one("PRAGMA page_size");
    },
  };
}

/** Node.js 22.13 or newer has node:sqlite without a flag. Returns the module or null. */
export async function loadSqlite() {
  const [maj, min] = String(process.versions?.node || "0.0").split(".").map(Number);
  if (!(maj > 22 || (maj === 22 && min >= 13))) return null;
  try {
    const m = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : await import("node:sqlite");
    return m && m.DatabaseSync ? m : null;
  } catch {
    return null;
  }
}

const NOTE_COLS = ["uid", "tier", "bot", "tags", "text", "ts", "src", "id"];
const str = (v) => (v == null ? "" : String(v));
const normNote = (n) => {
  const o = { ...n };
  for (const k of NOTE_COLS) o[k] = str(o[k]);
  o.user = str(o.user || o.user_key);
  return o;
};

/** Create an engine. Throws when this runtime cannot run it (the caller then answers from the host). */
export async function createEngine() {
  const sqlite = await loadSqlite();
  if (!sqlite) throw Object.assign(new Error("node:sqlite is not available"), { reason: "old_runtime" });
  const mod = await import("./server-engine.js");
  if (mod.FIND_ENGINE !== LOCAL_RANK_VERSION) throw new Error("engine bundle and engine-version.js disagree");
  const db = new sqlite.DatabaseSync(":memory:");
  const st = { armed: false, populated: false, tenant: null };
  const sql = makeSql(db, {
    closed: () => st.closed,
    before(q) {
      if (st.armed && !st.populated && /\b(?:FROM|JOIN)\s+(?:notes|fts)\b/i.test(q)) populate();
    },
  });
  let ready = Promise.resolve();
  const ctx = {
    storage: {
      sql,
      deleteAlarm: async () => {},
      deleteAll: async () => {},
      get: async () => undefined,
      put: async () => {},
      setAlarm: async () => {},
      transactionSync: (fn) => fn(),
    },
    blockConcurrencyWhile: (fn) => (ready = Promise.resolve(fn())),
    setWebSocketAutoResponse: () => {},
    getWebSockets: () => [],
    acceptWebSocket: () => {},
  };
  let tenant;
  try {
    tenant = new mod.TenantBrain(ctx, {});
    await ready;
  } catch (e) {
    try { db.close(); } catch { /* closing a broken handle */ }
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { reason: "old_runtime" });
  }
  st.tenant = tenant;
  // This copy never writes tier changes to SQL: the host owns them and sends them down in sync.
  tenant.memoryOnlyTiers = true;

  // Local hits and recency hints, reported to the host on the next sync (the shared hot set stays one hive).
  let hits = [];
  let recentReport = new Map();
  const recallHit = tenant.recall.hit.bind(tenant.recall);
  tenant.recall.hit = (scope, kind, key, now) => {
    hits.push({ scope, kind, key, t: now });
    return recallHit(scope, kind, key, now);
  };
  const baseSet = Map.prototype.set;
  tenant.recentMem = new (class extends Map {
    set(k, v) {
      recentReport.set(k, v);
      return baseSet.call(this, k, v);
    }
  })();
  st.armed = true;

  function putSql(n) {
    const cm = Number.isFinite(Number(n.created_ms)) && n.created_ms != null ? Number(n.created_ms) : Math.max(0, Date.parse(n.ts) || 0);
    const vals = [n.tier, n.bot, n.tags, n.text, n.ts, n.src, n.id];
    sql.exec(
      "INSERT OR REPLACE INTO notes (uid, tier, bot, tags, text, ts, src, id, created_ms, user_key, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      n.uid, ...vals, Math.round(cm), n.user || "", Number(n.rev) || 0,
    );
    sql.exec("DELETE FROM fts WHERE uid = ?", n.uid);
    sql.exec("INSERT INTO fts (uid, tier, bot, tags, text, ts, src) VALUES (?, ?, ?, ?, ?, ?, ?)", n.uid, ...vals.slice(0, 6));
  }
  function populate() {
    st.populated = true;
    const hot = tenant.hot;
    for (const [uid, idx] of hot.byUid) {
      const n = hot.notes[idx];
      if (n && n.uid === uid) putSql(n);
    }
  }

  return {
    name: "hosted",
    version: LOCAL_RANK_VERSION,
    /** Replace everything. `notes` must come in the server's insert order (seq). */
    load(notes, facts, recall, recent) {
      tenant.hot.load(notes.map(normNote));
      if (st.populated) {
        sql.exec("DELETE FROM notes");
        sql.exec("DELETE FROM fts");
        st.populated = false;
      }
      this.setFacts(facts || []);
      this.setRecall(recall || []);
      sql.exec("DELETE FROM recent");
      this.setRecent(recent || []);
      hits = [];
      recentReport = new Map();
    },
    /** Insert or replace one note. `retire` also applies recallNoteWritten (a newer note retires hot items it replaces). */
    upsert(n, retire = false) {
      const note = normNote(n);
      tenant.hot.upsert(note);
      if (st.populated) putSql(note);
      if (retire) tenant.recallNoteWritten({ uid: note.uid, user: note.user, id: note.id, text: note.text, ts: note.ts });
    },
    remove(uid) {
      tenant.hot.remove(uid);
      if (st.populated) {
        sql.exec("DELETE FROM notes WHERE uid = ?", uid);
        sql.exec("DELETE FROM fts WHERE uid = ?", uid);
      }
    },
    setFacts(list) {
      const fl = list.map((f) => mod.normalizeFact({ ...f, user: f.user || f.user_key || "" }));
      fl.sort((a, b) => a.id - b.id);
      tenant.facts = fl;
    },
    setRecall(rows) {
      tenant.recall.load(rows);
    },
    setRecent(uids) {
      const now = Date.now() / 1000;
      for (const u of uids) sql.exec("INSERT INTO recent (uid, t) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM recent WHERE uid = ?)", u, now, u);
    },
    /** The server's find(): same lines, same ranking. */
    async find(q, n = 5, askBot = null, user = null) {
      return tenant.find(q, n, askBot, user, "json");
    },
    /** Dormant sweep over this copy (flag dormant), in memory only. Used by tests and the bench. */
    dormantSweep(nowMs) {
      return tenant.dormantSweep(nowMs, { persist: false });
    },
    drainReport(cap = 200) {
      const rep = { hits: hits.slice(-cap), recent: [...recentReport.keys()].slice(-cap) };
      hits = [];
      recentReport = new Map();
      return rep;
    },
    noteCount: () => tenant.hot.byUid.size,
    has: (uid) => tenant.hot.byUid.has(uid),
    close() {
      st.closed = true;
      clearTimeout(tenant.recentTimer);
      clearTimeout(tenant.recallTimer);
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
