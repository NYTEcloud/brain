import test from "node:test";
import assert from "node:assert/strict";
import { BrainRetriever } from "../src/index.js";

function fakeClient(lines) {
  const calls = [];
  return {
    calls,
    find: async (...args) => (calls.push(["find", ...args]), { lines }),
    add: async (...args) => (calls.push(["add", ...args]), { uid: "u9" }),
    remove: async (...args) => (calls.push(["remove", ...args]), { ok: true }),
  };
}

test("invoke maps strings and objects to documents", async () => {
  const client = fakeClient(["plain note", { text: "obj note", uid: "u1", score: 0.5 }, { text: "bare" }]);
  const retriever = new BrainRetriever({ bot: "support", k: 3, client });
  const docs = await retriever.invoke("hours");
  assert.deepEqual(client.calls, [["find", "hours", 3]]);
  assert.deepEqual(docs.map((d) => d.pageContent), ["plain note", "obj note", "bare"]);
  assert.deepEqual(docs[0].metadata, {});
  assert.deepEqual(docs[1].metadata, { uid: "u1", score: 0.5 });
  assert.deepEqual(docs[2].metadata, {});
});

test("invoke handles no lines and defaults k to 5", async () => {
  const client = { find: async (q, n) => ({ n }) };
  const retriever = new BrainRetriever({ bot: "b", client });
  assert.deepEqual(await retriever.invoke("x"), []);
  assert.equal(retriever.k, 5);
});

test("the retriever remembers where the last answer came from", async () => {
  const client = { find: async () => ({ lines: ["a"], mode: "local", reason: "synced" }) };
  const retriever = new BrainRetriever({ bot: "b", client });
  assert.equal(retriever.lastMode, null);
  await retriever.invoke("x");
  assert.equal(retriever.lastMode, "local");
  assert.equal(retriever.lastReason, "synced");
});

test("add and delete go through the client", async () => {
  const client = fakeClient([]);
  const retriever = new BrainRetriever({ bot: "support", client });
  assert.deepEqual(await retriever.add("a note"), { uid: "u9" });
  assert.deepEqual(await retriever.delete("u9"), { ok: true });
  assert.deepEqual(client.calls, [["add", "support", "a note"], ["remove", "u9"]]);
});
