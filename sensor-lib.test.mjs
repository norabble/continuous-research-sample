import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlocked,
  addToFirewall,
  validateEntries,
  buildEdition,
  buildDriftReport,
} from "./sensor-lib.mjs";

const fw = (blocked = [], maxEntries = 2) => ({
  schema: "sample/source-firewall@v1",
  maxEntries,
  blocked,
});
const entry = (host) => ({ host, addedAt: "2026-07-04T00:00:00Z", reason: "t" });

test("isBlocked matches hosts in the blocked list", () => {
  assert.equal(isBlocked(fw([entry("a.example")]), "a.example"), true);
  assert.equal(isBlocked(fw([entry("a.example")]), "b.example"), false);
  assert.equal(isBlocked(fw(), "a.example"), false);
});

test("addToFirewall appends a new host", () => {
  const { firewall, added } = addToFirewall(fw(), "a.example", "retired", "2026-07-04T01:00:00Z");
  assert.equal(added, true);
  assert.deepEqual(firewall.blocked, [
    { host: "a.example", addedAt: "2026-07-04T01:00:00Z", reason: "retired" },
  ]);
});

test("addToFirewall is idempotent by host", () => {
  const start = fw([entry("a.example")]);
  const { firewall, added } = addToFirewall(start, "a.example", "again", "x");
  assert.equal(added, false);
  assert.deepEqual(firewall, start);
});

test("addToFirewall FIFO-truncates at maxEntries (2): oldest drops", () => {
  let f = fw();
  f = addToFirewall(f, "one.example", "r", "t1").firewall;
  f = addToFirewall(f, "two.example", "r", "t2").firewall;
  f = addToFirewall(f, "three.example", "r", "t3").firewall;
  assert.deepEqual(f.blocked.map((b) => b.host), ["two.example", "three.example"]);
});

const mkEntries = (closes, startDay = 21) =>
  closes.map((close, i) => ({ day: `2026-06-${String(startDay + i).padStart(2, "0")}`, close }));

test("validateEntries accepts ≥9 well-formed ascending entries", () => {
  assert.equal(validateEntries(mkEntries([100, 101, 102, 103, 104, 105, 106, 107, 108, 110])), true);
});

test("validateEntries rejects short, malformed, or non-finite input", () => {
  assert.equal(validateEntries(mkEntries([100, 101, 102])), false);
  assert.equal(validateEntries(null), false);
  assert.equal(validateEntries([{ day: "junk", close: 1 }, ...mkEntries([1, 2, 3, 4, 5, 6, 7, 8])]), false);
  const bad = mkEntries([100, 101, 102, 103, 104, 105, 106, 107, 108]);
  bad[0].close = NaN;
  assert.equal(validateEntries(bad), false);
});

test("validateEntries rejects non-ascending or duplicate days", () => {
  const asc = mkEntries([100, 101, 102, 103, 104, 105, 106, 107, 108]);
  assert.equal(validateEntries([...asc].reverse()), false);
  const dup = mkEntries([100, 101, 102, 103, 104, 105, 106, 107, 108]);
  dup[4] = { ...dup[3] };
  assert.equal(validateEntries(dup), false);
});

test("buildEdition reproduces the frozen artifact math", () => {
  const entries = mkEntries([100, 101, 102, 103, 104, 105, 106, 107, 108, 110]);
  const { descriptor, payload } = buildEdition(entries, "https://x.example/candles");
  assert.equal(descriptor, "btcusd-2026-06-30");
  assert.equal(payload.date, "2026-06-30");
  assert.equal(payload.close, 110);
  assert.equal(payload.prev_close, 108);
  assert.equal(payload.day_over_day_pct, 1.85);
  assert.equal(payload.ma7, 106.14);
  assert.equal(payload.ma7_prev_day, 105);
  assert.equal(payload.close_vs_ma7_pct, 3.63);
  assert.equal(payload.ma7_trend, "rising");
  assert.equal(Object.keys(payload.recent_closes).length, 10);
  assert.equal(payload.recent_closes["2026-06-30"], 110);
  assert.equal(payload.source, "https://x.example/candles");
});

test("buildDriftReport shapes the report", () => {
  assert.deepEqual(
    buildDriftReport({ reason: "fetch-failed", source: "https://x/y", detail: "503", at: "2026-07-04T02:00:00Z" }),
    { reason: "fetch-failed", source: "https://x/y", host: "x", detail: "503", at: "2026-07-04T02:00:00Z" },
  );
});
