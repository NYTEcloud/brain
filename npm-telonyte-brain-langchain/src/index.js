import * as brain from "@telonyte/brain";
import { BaseRetriever } from "@langchain/core/retrievers";
import { Document } from "@langchain/core/documents";

// A line is a string, or an object with text and maybe uid and score.
function toDocument(line) {
  if (line === null || typeof line !== "object") {
    return new Document({ pageContent: String(line), metadata: {} });
  }
  const metadata = {};
  if (line.uid != null) metadata.uid = line.uid;
  if (line.score != null) metadata.score = line.score;
  return new Document({ pageContent: String(line.text ?? ""), metadata });
}

export class BrainRetriever extends BaseRetriever {
  static lc_name() {
    return "BrainRetriever";
  }

  lc_namespace = ["telonyte", "brain", "retrievers"];

  // `client` defaults to @telonyte/brain; pass another object to stub it in tests.
  constructor({ bot, k = 5, client = brain, ...fields }) {
    super(fields);
    this.bot = bot;
    this.k = k;
    this.client = client;
    // Where the last answer came from: "local" or "host", and why (see Hyper speed in @telonyte/brain).
    this.lastMode = null;
    this.lastReason = null;
  }

  async _getRelevantDocuments(query) {
    const result = await this.client.find(query, this.k);
    this.lastMode = result?.mode ?? null;
    this.lastReason = result?.reason ?? null;
    return (result?.lines ?? []).map(toDocument);
  }

  add(text) {
    return this.client.add(this.bot, text);
  }

  delete(uid) {
    return this.client.remove(uid);
  }
}
