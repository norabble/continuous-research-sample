import { test } from "node:test";
import assert from "node:assert/strict";

test("importing sensor.mjs is side-effect-free and exposes SOURCE", async () => {
  const mod = await import("./sensor.mjs");
  assert.equal(typeof mod.SOURCE, "string");
  assert.ok(new URL(mod.SOURCE).host.length > 0);
});
