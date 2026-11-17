// Minimal RFC 6455 client over node:http(s) upgrade, for the change pings on GET /v1/sync/ws.
// Used instead of globalThis.WebSocket because the socket must be unref'd (a background connection never keeps a
// process alive) and the host wants an Authorization header, which the global WebSocket cannot send. Works on Node >= 18.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { UA } from "./util.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Connect. Calls handlers.open(), .message(text), .close(code) and .fail(status|0). Returns {send(text), close()}. */
export function wsConnect(base, key, hyper, handlers) {
  const u = new URL(base);
  const tls = u.protocol === "https:";
  const prefix = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
  const nonce = randomBytes(16).toString("base64");
  let sock = null;
  let done = false;
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let frag = [];
  const finish = (fn, arg) => {
    if (done) return;
    done = true;
    try { sock && sock.destroy(); } catch { /* closing */ }
    fn(arg);
  };
  const frame = (op, payload) => {
    const n = payload.length;
    const mask = randomBytes(4);
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : null;
    if (!head) throw new Error("frame too large");
    const body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([head, mask, body]);
  };
  const send = (text) => {
    if (!sock || done) return;
    try { sock.write(frame(0x1, Buffer.from(text))); } catch { finish(handlers.close, 1006); }
  };
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (op === 0x9) {
        try { sock.write(frame(0xa, payload)); } catch { /* socket closing */ }
      } else if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        try { sock.write(frame(0x8, Buffer.from([code >> 8, code & 255]))); } catch { /* socket closing */ }
        return finish(handlers.close, code);
      } else if (op === 0x0 || op === 0x1 || op === 0x2) {
        if (op !== 0) { fragOp = op; frag = []; }
        frag.push(payload);
        if (fin) {
          const msg = Buffer.concat(frag);
          const kind = fragOp;
          frag = [];
          fragOp = 0;
          if (kind === 0x1) handlers.message(msg.toString("utf8"));
        }
      }
    }
  };
  const req = (tls ? https : http).request({
    hostname: u.hostname,
    port: u.port || (tls ? 443 : 80),
    path: prefix + "/v1/sync/ws",
    method: "GET",
    timeout: 15_000,
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": nonce,
      "Sec-WebSocket-Version": "13",
      Authorization: "Bearer " + key,
      "User-Agent": UA,
      "X-Brain-Hyper": hyper(),
    },
  });
  req.on("socket", (s) => { s.unref(); });
  req.on("timeout", () => { req.destroy(); finish(handlers.fail, 0); });
  req.on("error", () => finish(handlers.fail, 0));
  req.on("response", (res) => { res.resume(); finish(handlers.fail, res.statusCode || 0); });
  req.on("upgrade", (res, socket, head) => {
    const want = createHash("sha1").update(nonce + GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== want) {
      socket.destroy();
      return finish(handlers.fail, 0);
    }
    sock = socket;
    socket.unref();
    socket.setTimeout(0);
    socket.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      try { parse(); } catch { finish(handlers.close, 1006); }
    });
    socket.on("close", () => finish(handlers.close, 1006));
    socket.on("error", () => finish(handlers.close, 1006));
    handlers.open();
    if (head && head.length) { buf = Buffer.from(head); parse(); }
  });
  req.end();
  return {
    send,
    close() {
      if (sock && !done) { try { sock.write(frame(0x8, Buffer.from([0x03, 0xe8]))); } catch { /* closing */ } }
      finish(() => {}, 0);
    },
  };
}
