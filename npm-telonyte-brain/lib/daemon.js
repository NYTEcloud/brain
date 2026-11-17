// Client of a running `brain` daemon (client/brain daemon): one JSON line out, one back, over the Unix socket in the
// CLI's cache dir (or 127.0.0.1 plus a token on Windows). The 2.2.6 daemon needs cfg plus the caller's key (auth).
// Resolves null when no daemon answers for this team.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { cfgId, cliCacheDir } from "./util.js";

function call(req, timeoutMs) {
  const dir = cliCacheDir();
  const sock = path.join(dir, "braind.sock");
  const portFile = path.join(dir, "braind.port");
  let opts;
  if (process.platform !== "win32" && fs.existsSync(sock)) opts = { path: sock };
  else if (fs.existsSync(portFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(portFile, "utf8"));
      opts = { host: "127.0.0.1", port: Number(d.port) };
      req = { ...req, token: d.token };
    } catch {
      return Promise.resolve(null);
    }
  } else return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const s = net.createConnection(opts);
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref();
    s.unref();
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); }
      }
    });
    s.on("error", () => done(null));
    s.on("close", () => done(null));
  });
}

/** Ask a running daemon. Returns {lines, ms, offline, ws} or null (use the next path). */
export async function daemonFind(cfg, q, n, bot) {
  const r = await call({ op: "find", q, n, bot: bot || null, cfg: cfgId(cfg.url, cfg.key), auth: cfg.key || "" }, 12_000);
  return r && r.ok === true && Array.isArray(r.lines) ? r : null;
}
