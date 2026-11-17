/**
 * B.R.A.I.N. client for Node.js. Reads BRAIN_URL and BRAIN_KEY from the environment.
 * Answers come from a local synced copy on this machine when there is one (Hyper speed), else from the host.
 */
import { Client, defaultClient } from "./lib/client.js";

export const status = async () => defaultClient().status();
export const add = async (bot, text) => defaultClient().add(bot, text);
export const find = async (q, n = 5) => defaultClient().find(q, n);
export const remove = async (uid) => defaultClient().remove(uid);
/** Is Hyper speed on for the default client: {mode, reason, synced_ago_s, text}. */
export const hyper = () => defaultClient().hyper();

/** A client with its own settings: createClient({ url, key, local = true, cacheDir, bot }). */
export const createClient = (opts = {}) => new Client(opts);
