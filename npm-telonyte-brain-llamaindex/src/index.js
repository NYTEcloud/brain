import * as brain from "@telonyte/brain";
import { BaseRetriever } from "@llamaindex/core/retriever";
import { TextNode } from "@llamaindex/core/schema";

// The query is a string, or message content: an array of parts with text.
function queryText(query) {
  if (typeof query === "string") return query;
  if (Array.isArray(query)) {
    return query.map((part) => (part?.type === "text" ? part.text : "")).join("");
  }
  return String(query ?? "");
}

// A line is a string, or an object with text and maybe uid and score.
function toNode(line) {
  if (line === null || typeof line !== "object") {
    return { node: new TextNode({ text: String(line) }) };
  }
  const metadata = line.uid != null ? { uid: line.uid } : {};
  const hit = { node: new TextNode({ text: String(line.text ?? ""), metadata }) };
  if (line.score != null) hit.score = line.score;
  return hit;
}

export class BrainRetriever extends BaseRetriever {
  // `client` defaults to @telonyte/brain; pass another object to stub it in tests.
  constructor({ bot, k = 5, client = brain }) {
    super();
    this.bot = bot;
    this.k = k;
    this.client = client;
    // Where the last answer came from: "local" or "host", and why (see Hyper speed in @telonyte/brain).
    this.lastMode = null;
    this.lastReason = null;
  }

  async _retrieve(params) {
    const result = await this.client.find(queryText(params.query), this.k);
    this.lastMode = result?.mode ?? null;
    this.lastReason = result?.reason ?? null;
    return (result?.lines ?? []).map(toNode);
  }

  add(text) {
    return this.client.add(this.bot, text);
  }

  delete(uid) {
    return this.client.remove(uid);
  }
}
