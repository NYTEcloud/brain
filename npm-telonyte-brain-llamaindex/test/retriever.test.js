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

test("retrieve maps strings and objects to nodes", async () => {
  const client = fakeClient(["plain note", { text: "obj note", uid: "u1", score: 0.5 }, { text: "bare" }]);
  const retriever = new BrainRetriever({ bot: "support", k: 3, client });
  const nodes = await retriever.retrieve({ query: "hours" });
  assert.deepEqual(client.calls, [["find", "hours", 3]]);
  assert.deepEqual(nodes.map((n) => n.node.getContent()), ["plain note", "obj note", "bare"]);
  assert.deepEqual(nodes.map((n) => n.score), [undefined, 0.5, undefined]);
  assert.deepEqual(nodes[0].node.metadata, {});
  assert.deepEqual(nodes[1].node.metadata, { uid: "u1" });
});

test("retrieve handles no lines and defaults k to 5", async () => {
  const client = { find: async (q, n) => ({ n }) };
  const retriever = new BrainRetriever({ bot: "b", client });
  assert.deepEqual(await retriever.retrieve({ query: "x" }), []);
  assert.equal(retriever.k, 5);
});

test("the retriever remembers where the last answer came from", async () => {
  const client = { find: async () => ({ lines: ["a"], mode: "host", reason: "stale" }) };
  const retriever = new BrainRetriever({ bot: "b", client });
  assert.equal(retriever.lastMode, null);
  await retriever.retrieve({ query: "x" });
  assert.equal(retriever.lastMode, "host");
  assert.equal(retriever.lastReason, "stale");
});

test("add and delete go through the client", async () => {
  const client = fakeClient([]);
  const retriever = new BrainRetriever({ bot: "support", client });
  assert.deepEqual(await retriever.add("a note"), { uid: "u9" });
  assert.deepEqual(await retriever.delete("u9"), { ok: true });
  assert.deepEqual(client.calls, [["add", "support", "a note"], ["remove", "u9"]]);
});
