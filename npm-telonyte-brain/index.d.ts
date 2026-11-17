/** Why Hyper speed is on or off. `synced` and `offline` mean the answer came from the local copy. */
export type HyperReason =
  | "synced"
  | "offline"
  | "no_copy_yet"
  | "rebuilding"
  | "stale"
  | "lease_expired"
  | "serverless"
  | "opted_out"
  | "no_storage"
  | "engine_update"
  | "old_runtime"
  | "host_needed"
  | "unknown";

export interface HyperInfo {
  mode: "local" | "host";
  reason: HyperReason;
  /** Seconds since the local copy last synced with the host. null when there is no local copy in use. */
  synced_ago_s: number | null;
  /** For example "Hyper speed: on (local copy, synced 4s ago)" or "Hyper speed: off (using host: no local copy yet)". */
  text: string;
}

/** Added to every response. For find, `mode` says where the answer came from. */
export interface HyperFields {
  mode: "local" | "host";
  reason: HyperReason;
}

export interface FindResult extends HyperFields {
  lines: string[];
  ms?: number | null;
  bytes?: number;
  path?: string;
  pack_tier?: string;
  instant?: boolean;
  cached?: boolean;
  tenant_id?: string;
  /** Present when the answer came from the local copy. */
  synced_ago_s?: number | null;
  [field: string]: unknown;
}

export interface AddResult extends HyperFields {
  ok: boolean;
  uid?: string;
  ts?: string;
  note?: Record<string, unknown>;
  duplicate?: boolean;
  /** true when the host could not be reached: the note waits in the outbox and is sent later. */
  queued?: boolean;
  cid?: string;
  [field: string]: unknown;
}

export interface StatusResult extends HyperFields {
  [field: string]: unknown;
}

export interface RemoveResult extends HyperFields {
  ok?: boolean;
  [field: string]: unknown;
}

export interface ClientOptions {
  /** Defaults to BRAIN_URL, then https://brain.telonyte.com. */
  url?: string;
  /** Defaults to BRAIN_KEY. */
  key?: string;
  /** Keep a local synced copy and answer from it. Default true. BRAIN_LOCAL=0 also turns it off. */
  local?: boolean;
  /** Directory for the local copy. Default: <cache home>/telonyte-brain/<id of url and key>. */
  cacheDir?: string;
  /** Default bot name: used to rank that bot's notes first, and as the bot for add(text). */
  bot?: string;
}

export interface Client {
  status(): Promise<StatusResult>;
  add(bot: string, text: string): Promise<AddResult>;
  add(text: string): Promise<AddResult>;
  find(q: string, n?: number): Promise<FindResult>;
  remove(uid: string): Promise<RemoveResult>;
  /** Is Hyper speed on, and why. */
  hyper(): HyperInfo;
  /** Resolves when the local copy has been looked for on disk. */
  ready(): Promise<void>;
  /** Run a sync now and wait for it. */
  sync(): Promise<void>;
  /** Send queued adds now. */
  flush(): Promise<{ sent: number; left: number }>;
  /** Stop background sync. The copy stays on disk. */
  close(): void;
}

export function createClient(opts?: ClientOptions): Client;

/** Module-level calls read BRAIN_URL and BRAIN_KEY when called. */
export function status(): Promise<StatusResult>;
export function add(bot: string, text: string): Promise<AddResult>;
export function find(q: string, n?: number): Promise<FindResult>;
export function remove(uid: string): Promise<RemoveResult>;
export function hyper(): HyperInfo;
