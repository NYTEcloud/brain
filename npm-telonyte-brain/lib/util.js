// Shared helpers: constants, paths, private files, locks, the Hyper speed reasons and serverless detection.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "2.2.7";
export const UA = `telonyte-brain-js/${VERSION}`;
export const DEFAULT_URL = "https://brain.telonyte.com";
export const FRESH_MS = 120_000; // answer locally while the last successful host contact is younger than this
export const HEARTBEAT_MS = 60_000; // sync even without a change ping: re-auth and lease renewal
export const POLL_MS = 10_000; // sync interval while no WebSocket is up
export const WS_PING_MS = 30_000;

const env = () => (typeof process !== "undefined" && process.env) || {};
const win = () => typeof process !== "undefined" && process.platform === "win32";

export const cfgId = (url, key) => createHash("sha256").update(`${url}\n${key}`).digest("hex").slice(0, 16);

/** The package's own cache dir: <XDG_CACHE_HOME or ~/.cache or %LOCALAPPDATA%>/telonyte-brain/<cfg id>. */
export function packageCacheDir(url, key) {
  const e = env();
  const base = win() ? e.LOCALAPPDATA || os.homedir() : e.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "telonyte-brain", cfgId(url, key));
}

/** Where the brain CLI keeps its cache and daemon socket (cache_dir() in client/brain.src.py). */
export function cliCacheDir() {
  const e = env();
  if (e.BRAIN_CACHE) return e.BRAIN_CACHE;
  if (win()) return path.join(e.LOCALAPPDATA || os.homedir(), "brain-hosted");
  return path.join(e.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "brain-hosted");
}

export const newCid = () => randomBytes(16).toString("base64url");
export const cidOk = (c) => typeof c === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(c);
/** The id an outbox line is sent with. Older lines carry none: a hash of the line keeps their replays single too. */
export const lineCid = (row, line) => (row && cidOk(row.cid) ? row.cid : "ob-" + createHash("sha256").update(line, "utf8").digest("hex").slice(0, 40));

// ---- files ------------------------------------------------------------------------------------------------------
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

export function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/** Write a file only this user can read, replacing any old one atomically (temp file, then rename). */
export function writePrivate(file, data, { fsync = false } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, data);
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    unlinkQuiet(tmp);
    throw e;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export const fileSig = (p) => {
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
};

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
};

/** Advisory lock by exclusive file creation. A lock older than `staleMs`, or held by a dead process, is taken over. */
export class FileLock {
  constructor(file, staleMs = 30_000) {
    this.file = file;
    this.staleMs = staleMs;
    this.held = false;
  }

  tryAcquire() {
    for (let i = 0; i < 3; i++) {
      try {
        const fd = fs.openSync(this.file, "wx", 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
        fs.closeSync(fd);
        this.held = true;
        return true;
      } catch (e) {
        if (!e || e.code !== "EEXIST") return false;
        try {
          const age = Date.now() - fs.statSync(this.file).mtimeMs;
          let owner = 0;
          try { owner = JSON.parse(fs.readFileSync(this.file, "utf8")).pid || 0; } catch { /* half-written lock */ }
          if (age > this.staleMs || (owner && owner !== process.pid && !pidAlive(owner))) unlinkQuiet(this.file);
          else return false;
        } catch {
          /* vanished between the calls: try again */
        }
      }
    }
    return false;
  }

  /** Keep a held lock fresh. */
  touch() {
    if (!this.held) return;
    try { const now = new Date(); fs.utimesSync(this.file, now, now); } catch { this.held = false; }
  }

  async acquire(waitMs = 2000) {
    const end = Date.now() + waitMs;
    while (!this.tryAcquire()) {
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  }

  release() {
    if (this.held) {
      this.held = false;
      unlinkQuiet(this.file);
    }
  }
}

// ---- Hyper speed ------------------------------------------------------------------------------------------------
const WHY = {
  no_copy_yet: "no local copy yet",
  rebuilding: "local copy is rebuilding",
  stale: "local copy is catching up",
  lease_expired: "offline too long so the local copy is locked",
  serverless: "serverless or short-lived machine",
  opted_out: "local copy turned off",
  no_storage: "this machine cannot store a local copy",
  engine_update: "waiting for a client update",
  old_runtime: "Node.js 22.13 or newer is needed for the local copy",
  host_needed: "this question needs the host",
  unknown: "reason unknown",
};
export const HOST_REASONS = Object.keys(WHY);
export const LOCAL_REASONS = ["synced", "offline"];

export function hyperText(mode, reason, syncedAgoS) {
  if (mode === "local") {
    return reason === "offline" ? "Hyper speed: on (local copy, offline)" : `Hyper speed: on (local copy, synced ${Math.max(0, Math.round(syncedAgoS ?? 0))}s ago)`;
  }
  return `Hyper speed: off (using host: ${WHY[reason] || WHY.unknown})`;
}

export const hyperHeader = (h) => `${h.mode};${h.reason}`;

const SERVERLESS_ENV = ["AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "VERCEL", "NETLIFY", "K_SERVICE", "FUNCTION_TARGET", "FUNCTIONS_WORKER_RUNTIME", "DENO_DEPLOYMENT_ID"];

export function isServerless() {
  const e = env();
  if (SERVERLESS_ENV.some((k) => e[k])) return true;
  if (typeof process === "undefined" || !process.versions || !process.versions.node) return true;
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

export const localOffByEnv = () => ["0", "false", "no", "off"].includes(String(env().BRAIN_LOCAL ?? "1").trim().toLowerCase());

export function nodeHasSqlite(version = process.versions?.node) {
  const [maj, min] = String(version || "0.0").split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
}
