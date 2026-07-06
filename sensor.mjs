#!/usr/bin/env node
/**
 * BTC-USD daily-edition sensor for the Continuous Research sample.
 *
 * Emits one JSON detection result on stdout (the sensor↔engine contract) and
 * nothing else. An edition is one *completed* UTC day of BTC-USD trading —
 * descriptor `btcusd-YYYY-MM-DD`. The engine's dedup decides whether that
 * edition is genuinely new.
 *
 * Drift, not crash: if the source is firewalled (.research/source-firewall
 * .json), unreachable, or its response no longer matches the expected shape,
 * the sensor writes .research/drift/report.json (working tree only — never
 * committed), emits {changed:false}, and exits 0. sense.yml escalates the
 * report to a `sensor-drift` issue; a repair agent proposes the fix.
 *
 * REPAIR AGENTS: your write surface is THIS FILE ONLY. To re-point the
 * sensor, change SOURCE and fetchEntries() so it returns completed-UTC-day
 * entries [{ day: "YYYY-MM-DD", close: Number }] ascending. Do not touch
 * sensor-lib.mjs, the firewall, or the artifact schema.
 *
 * Test mode: when SAMPLE_DESCRIPTOR is set, behaves as the original
 * deterministic skeleton (placeholder edition, no network).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isBlocked, validateEntries, buildEdition, buildDriftReport } from "./sensor-lib.mjs";

// --- source adapter (the repair agent's write surface) ---------------------

export const SOURCE = "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=20";

/** Fetch completed-UTC-day entries, ascending: [{ day, close }, …]. */
export async function fetchEntries() {
  const res = await fetch(SOURCE, {
    headers: { "User-Agent": "continuous-research-sample" },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  // OHLC buckets: { data: { ohlc: [{ timestamp, open, high, low, close, volume }, …] } },
  // one per UTC day (bucket start = day), ascending, most recent bucket is today (incomplete).
  const { ohlc } = (await res.json()).data;
  const candles = ohlc.slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const todayUtcSec = Math.floor(Date.now() / 86_400_000) * 86_400;
  return candles
    .filter((c) => Number(c.timestamp) < todayUtcSec)
    .map((c) => ({
      day: new Date(Number(c.timestamp) * 1000).toISOString().slice(0, 10),
      close: Number(c.close),
    }));
}

// --- orchestration (stable; uses sensor-lib) --------------------------------

const FIREWALL_PATH = ".research/source-firewall.json";
const DRIFT_PATH = ".research/drift/report.json";

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const writeArtifact = (path, payload) => {
  mkdirSync("data/btcusd", { recursive: true });
  writeFileSync(path, payload);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
};

const drift = (reason, detail) => {
  const report = buildDriftReport({
    reason,
    source: SOURCE,
    detail,
    at: new Date().toISOString(),
  });
  mkdirSync(".research/drift", { recursive: true });
  writeFileSync(DRIFT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`sensor: drift (${reason}) — ${detail}`);
  emit({ changed: false });
  process.exit(0);
};

async function main() {
  // Deterministic test mode (the original walking-skeleton behavior).
  const override = process.env.SAMPLE_DESCRIPTOR?.trim();
  if (override) {
    const artifactPath = `data/btcusd/${override}.json`;
    const payload = `${JSON.stringify(
      { descriptor: override, note: "placeholder edition (deterministic skeleton)" },
      null,
      2,
    )}\n`;
    const hash = writeArtifact(artifactPath, payload);
    emit({
      changed: true,
      descriptor: override,
      source: "deterministic://skeleton",
      retrievedAt: new Date().toISOString(),
      hash,
      artifacts: [artifactPath],
    });
    return;
  }

  const firewall = existsSync(FIREWALL_PATH)
    ? JSON.parse(readFileSync(FIREWALL_PATH, "utf8"))
    : { blocked: [] };
  const host = new URL(SOURCE).host;
  if (isBlocked(firewall, host)) drift("source-firewalled", `host ${host} is on ${FIREWALL_PATH}`);

  let entries;
  try {
    entries = await fetchEntries();
  } catch (err) {
    drift("fetch-failed", String(err?.message ?? err));
  }
  if (!validateEntries(entries)) {
    drift("shape-mismatch", "response did not yield ≥9 completed daily entries of {day, close}");
  }

  const { descriptor, payload: obj } = buildEdition(entries, SOURCE);
  const artifactPath = `data/btcusd/${descriptor}.json`;
  const payload = `${JSON.stringify(obj, null, 2)}\n`;
  const hash = writeArtifact(artifactPath, payload);
  emit({
    changed: true,
    descriptor,
    source: SOURCE,
    retrievedAt: new Date().toISOString(),
    hash,
    artifacts: [artifactPath],
  });
}

// Guard: importing this module (tests, scripts/firewall-add.mjs) must not run it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
