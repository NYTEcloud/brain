// The client: find answers from a running brain daemon, else the in-process local copy, else the host.
import path from "node:path";
import { daemonFind } from "./daemon.js";
import { NetError, api } from "./http.js";
import { Replica, appendOutbox } from "./replica.js";
import { DEFAULT_URL, hyperText, isServerless, localOffByEnv, newCid, nodeHasSqlite, packageCacheDir } from "./util.js";

const env = () => process.env || {};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export class Client {
  /** opts: {url, key, local = true, cacheDir, bot}. Url and key default to BRAIN_URL and BRAIN_KEY. */
  constructor(opts = {}) {
    const e = env();
    this.url = String(opts.url || e.BRAIN_URL || DEFAULT_URL).replace(/\/+$/, "");
    this.key = opts.key || e.BRAIN_KEY || "";
    this.bot = opts.bot || null;
    this.off = null; // host reason when the local copy is not used at all
    this.replica = null;
    this.hostDown = false;
    this.daemonSeen = null;
    this.closed = false;
    this._ready = Promise.resolve();
    if (opts.local === false || localOffByEnv()) this.off = "opted_out";
    else if (isServerless()) this.off = "serverless";
    else if (!nodeHasSqlite()) this.off = "old_runtime";
    if (this.key && !this.off) {
      const dir = opts.cacheDir ? path.resolve(opts.cacheDir) : packageCacheDir(this.url, this.key);
      this.replica = new Replica({ dir, cfg: { url: this.url, key: this.key }, hyper: () => this.hyperState() });
      this._ready = this.replica.start().catch(() => { this.replica.noStorage = true; });
    }
  }

  cfg() {
    if (!this.key) throw new Error("Set BRAIN_KEY");
    return { url: this.url, key: this.key };
  }

  /** Resolves when the local copy has been looked for on disk. */
  ready() {
    return this._ready;
  }

  /** Run a sync now and wait for it (extra to the spec: handy in tests and before a burst of finds). */
  async sync() {
    await this._ready;
    if (this.replica) await this.replica.syncNow();
  }

  hyperState() {
    if (this.off) return { mode: "host", reason: this.off };
    const r = this.replica;
    if (!r) return { mode: "host", reason: "unknown" };
    if (this.daemonSeen && Date.now() - this.daemonSeen.t < 60_000) return { mode: "local", reason: this.daemonSeen.offline ? "offline" : "synced" };
    const g = r.gate();
    if (g.ok) return { mode: "local", reason: "synced" };
    if (this.hostDown && g.reason === "stale" && r.canAnswerOffline()) return { mode: "local", reason: "offline" };
    if (g.reason === "stale" && this.hostDown && !r.leaseValid()) return { mode: "host", reason: "lease_expired" };
    return { mode: "host", reason: g.reason };
  }

  /** {mode, reason, synced_ago_s, text}: is Hyper speed on, and why. */
  hyper() {
    const h = this.hyperState();
    const ago = h.mode === "local" && this.replica && !(this.daemonSeen && Date.now() - this.daemonSeen.t < 60_000) ? round1(this.replica.syncedAgoS()) : null;
    return { mode: h.mode, reason: h.reason, synced_ago_s: ago, text: hyperText(h.mode, h.reason, ago) };
  }

  tag(obj) {
    const h = this.hyperState();
    return { ...obj, mode: h.mode, reason: h.reason };
  }

  // ---- find ------------------------------------------------------------------------------------------------------
  async find(q, n = 5) {
    const cfg = this.cfg();
    const text = String(q ?? "").trim();
    let why = this.off || "unknown";
    if (!this.off && text) {
      const d = await daemonFind(cfg, text, n, this.bot).catch(() => null);
      if (d) {
        this.daemonSeen = { t: Date.now(), offline: !!d.offline };
        return { lines: d.lines, ms: d.ms ?? null, bytes: d.lines.reduce((a, l) => a + l.length, 0), path: d.path || "daemon", mode: "local", reason: d.offline ? "offline" : "synced", synced_ago_s: d.offline ? null : d.ws ? 0 : null };
      }
      this.daemonSeen = null;
      await this._ready;
      const r = this.replica;
      if (r) {
        r.checkDisk(); // a deleted or damaged copy is noticed here, so the reason says rebuilding
        const g = r.gate();
        why = g.reason;
        if (g.ok) {
          try {
            const out = await r.find(text, n, this.bot);
            return { ...out, mode: "local", reason: "synced", synced_ago_s: round1(r.syncedAgoS()) };
          } catch {
            why = "host_needed";
          }
        }
      }
    }
    return this.hostFind(q, n, why);
  }

  async hostFind(q, n, why) {
    const cfg = this.cfg();
    const body = { q, n, format: "json" };
    if (this.bot) body.bot = this.bot;
    let res;
    try {
      res = await api(cfg, "POST", "/v1/find", body, { mode: "host", reason: why });
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      const r = this.replica;
      if (r && !this.off && String(q ?? "").trim()) {
        this.hostDown = true;
        if (r.canAnswerOffline()) {
          try {
            const out = await r.find(String(q).trim(), n, this.bot);
            return { ...out, mode: "local", reason: "offline", synced_ago_s: round1(r.syncedAgoS()) };
          } catch { /* the host error below is the honest answer */ }
        } else if (r.ready && !r.leaseValid()) {
          throw Object.assign(new Error(`license inactive, renew at ${cfg.url}/subscribe`), { mode: "host", reason: "lease_expired" });
        }
      }
      throw e;
    }
    this.hostDown = false;
    if (this.replica && (res.status === 401 || res.status === 403)) this.replica.wipe(res.status, res.body);
    const j = res.body;
    if (!res.ok) throw new Error((j && j.error) || res.statusText);
    if (this.replica && why === "stale") this.replica.kick();
    return { ...j, mode: "host", reason: why };
  }

  // ---- the other calls ---------------------------------------------------------------------------------------------
  async status() {
    const cfg = this.cfg();
    const res = await api(cfg, "GET", "/v1/status", undefined, this.hyperState());
    this.afterHost(res);
    return res.body && typeof res.body === "object" ? this.tag(res.body) : res.body;
  }

  afterHost(res) {
    this.hostDown = false;
    if (this.replica && (res.status === 401 || res.status === 403)) this.replica.wipe(res.status, res.body);
  }

  /** add(bot, text), or add(text) when the client was created with a bot. */
  async add(bot, text) {
    if (text === undefined && this.bot) { text = bot; bot = this.bot; }
    const cfg = this.cfg();
    const cid = newCid();
    const r = this.replica;
    let res;
    try {
      res = await api(cfg, "POST", "/v1/add", { bot, text, cid }, this.hyperState());
    } catch (e) {
      if (!(e instanceof NetError) || !r || r.noStorage) throw e;
      this.hostDown = true;
      try {
        await appendOutbox(r.dir, { bot, text, t: Date.now() / 1000, cid });
      } catch {
        throw e;
      }
      return this.tag({ ok: true, queued: true, cid });
    }
    this.afterHost(res);
    const j = res.body;
    if (!res.ok) throw new Error((j && j.error) || res.statusText);
    if (r) {
      await this._ready;
      r.insertNote(j && j.note);
      r.pushOutbox().catch(() => {});
    }
    return this.tag(j);
  }

  async remove(uid) {
    const cfg = this.cfg();
    const res = await api(cfg, "POST", "/v1/delete", { uid }, this.hyperState());
    this.afterHost(res);
    const j = res.body;
    if (!res.ok) throw new Error((j && j.error) || res.statusText);
    if (this.replica) { await this._ready; this.replica.forget(uid); }
    return this.tag(j);
  }

  /** Send queued adds now. Returns {sent, left}. */
  async flush() {
    await this._ready;
    return this.replica ? this.replica.pushOutbox({ wait: true }) : { sent: 0, left: 0 };
  }

  /** Stop the background sync and the WebSocket. The copy stays on disk. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.replica) this.replica.close();
  }
}

// ---- module-level API (BRAIN_URL and BRAIN_KEY are read on each call) --------------------------------------------
const defaults = new Map();
export function defaultClient() {
  const e = env();
  const url = String(e.BRAIN_URL || DEFAULT_URL).replace(/\/+$/, "");
  const key = e.BRAIN_KEY || "";
  if (!key) throw new Error("Set BRAIN_KEY");
  const id = `${url}\n${key}\n${localOffByEnv() ? 0 : 1}`;
  let c = defaults.get(id);
  if (!c || c.closed) defaults.set(id, (c = new Client({ url, key })));
  return c;
}
