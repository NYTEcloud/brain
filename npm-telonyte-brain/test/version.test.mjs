import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION } from "../lib/util.js";

test("package version is 2.2.6", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  assert.equal(pkg.version, "2.2.6");
  assert.equal(VERSION, "2.2.6");
});
