// Seal for the local copy: AES-256-GCM (Node crypto), random 12-byte nonce, the slot name as AAD.
// Format r2: "r2" | nonce(12) | ciphertext | tag(16). Same construction as replica_seal() in client/brain.
// Old r1 blobs (SHAKE-256 keystream + HMAC) can still be opened once so the caller can rewrite them as r2;
// the old cipher is never written. Light protection (it stops casual copying of the file, not someone who controls
// the user account); the key lives next to the file, 0600.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const V = Buffer.from("r2");
const V_OLD = Buffer.from("r1");

export const replicaKey = (rk) => createHash("sha256").update("brain-replica|" + rk).digest();
export const replicaKeyId = (rk) => createHash("sha256").update("brain-replica-id|" + rk).digest("hex").slice(0, 16);

const hm = (key, msg) => createHmac("sha256", key).update(msg).digest();
const aesKey = (key) => hm(key, "brain-replica-aes-256-gcm");
const gcmAad = (aad) => Buffer.from("brain-replica|" + aad);

// ---- old r1 format, read only ----
const oldKeys = (key) => [hm(key, "brain-replica-enc"), hm(key, "brain-replica-mac")];
function xor(data, ks) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ ks[i];
  return out;
}
const stream = (ek, nonce, n) => (n ? createHash("shake256", { outputLength: n }).update(Buffer.concat([ek, nonce])).digest() : Buffer.alloc(0));

function openOld(blob, key, aad) {
  if (blob.length < 2 + 16 + 32) throw new Error("unreadable replica entry");
  const [ek, mk] = oldKeys(key);
  const head = blob.subarray(0, blob.length - 32);
  const tag = blob.subarray(blob.length - 32);
  if (!timingSafeEqual(tag, hm(mk, Buffer.concat([Buffer.from(aad), Buffer.from("|"), head])))) throw new Error("replica entry failed authentication");
  const body = head.subarray(18);
  return xor(body, stream(ek, head.subarray(2, 18), body.length));
}

/** True for an old r1 blob that should be rewritten as r2 after it has been opened. */
export const isLegacy = (blob) => Buffer.isBuffer(blob) && blob.length >= 2 && blob.subarray(0, 2).equals(V_OLD);

export function seal(data, key, aad = "") {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(key), nonce);
  c.setAAD(gcmAad(aad));
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([V, nonce, body, c.getAuthTag()]);
}

/** Throws on a wrong key, any tampering, or a blob moved to another slot (aad). */
export function open(blob, key, aad = "") {
  if (!key || !Buffer.isBuffer(blob) || blob.length < 2 + 12 + 16) throw new Error("unreadable replica entry");
  const v = blob.subarray(0, 2);
  if (v.equals(V_OLD)) return openOld(blob, key, aad);
  if (!v.equals(V)) throw new Error("unreadable replica entry");
  try {
    const d = createDecipheriv("aes-256-gcm", aesKey(key), blob.subarray(2, 14));
    d.setAAD(gcmAad(aad));
    d.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([d.update(blob.subarray(14, blob.length - 16)), d.final()]);
  } catch {
    throw new Error("replica entry failed authentication");
  }
}
