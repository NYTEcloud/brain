// One HTTP call to the host. Every request carries the named User-Agent (the edge refuses anonymous agents)
// and X-Brain-Hyper so the dashboard can show Hyper speed. Network failures throw NetError; HTTP answers never throw.
import { UA, hyperHeader } from "./util.js";

export class NetError extends Error {
  constructor(cause) {
    super("could not reach the host: " + (cause && cause.message ? cause.message : String(cause)));
    this.name = "NetError";
  }
}

export async function api(cfg, method, path, body, hyper, timeoutMs = 30_000) {
  const headers = {
    Authorization: `Bearer ${cfg.key}`,
    "User-Agent": UA,
    "X-Brain-Hyper": hyperHeader(hyper),
    Accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let r;
  let text;
  try {
    r = await fetch(cfg.url + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await r.text();
  } catch (e) {
    throw new NetError(e);
  }
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  }
  return { status: r.status, ok: r.ok, statusText: r.statusText, body: json };
}
