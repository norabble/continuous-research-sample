#!/usr/bin/env node
/**
 * BTC-USD daily-edition sensor for the Continuous Research sample.
 *
 * Emits one JSON detection result on stdout (the sensor↔engine contract) and
 * nothing else. An edition is one *completed* UTC day of BTC-USD trading —
 * descriptor `btcusd-YYYY-MM-DD`. The sensor always reports the latest
 * completed day; the engine's dedup decides whether that edition is genuinely
 * new (this is the cheap "nothing new" check for ~23 hours a day).
 *
 * Test mode: when SAMPLE_DESCRIPTOR is set, behaves as the original
 * deterministic skeleton (placeholder edition, no network).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const writeArtifact = (path, payload) => {
  mkdirSync("data/btcusd", { recursive: true });
  writeFileSync(path, payload);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
};

// --- deterministic test mode (the original walking-skeleton behavior) ---
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
  process.exit(0);
}

// --- real mode: latest completed UTC day from Coinbase ---
const SOURCE = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400";

const res = await fetch(SOURCE, {
  headers: { "User-Agent": "continuous-research-sample" },
});
if (!res.ok) {
  console.error(`sensor: fetch failed ${res.status}`);
  process.exit(1);
}

// Candles: [[timeSec, low, high, open, close, volume], ...] most-recent-first.
const candles = (await res.json()).sort((a, b) => a[0] - b[0]);
const todayUtcSec = Math.floor(Date.now() / 86_400_000) * 86_400;
const completed = candles.filter((c) => c[0] < todayUtcSec);
if (completed.length < 9) {
  console.error("sensor: not enough completed daily candles");
  process.exit(1);
}

const day = (c) => new Date(c[0] * 1000).toISOString().slice(0, 10);
const close = (c) => c[4];
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

const latest = completed.at(-1);
const closes = completed.map(close);
const ma7 = avg(closes.slice(-7));
const ma7Prev = avg(closes.slice(-8, -1));
const descriptor = `btcusd-${day(latest)}`;

const artifactPath = `data/btcusd/${descriptor}.json`;
const payload = `${JSON.stringify(
  {
    descriptor,
    date: day(latest),
    close: close(latest),
    prev_close: closes.at(-2),
    day_over_day_pct: +((close(latest) / closes.at(-2) - 1) * 100).toFixed(2),
    ma7: +ma7.toFixed(2),
    close_vs_ma7_pct: +((close(latest) / ma7 - 1) * 100).toFixed(2),
    ma7_prev_day: +ma7Prev.toFixed(2),
    ma7_trend: ma7 >= ma7Prev ? "rising" : "falling",
    recent_closes: Object.fromEntries(completed.slice(-10).map((c) => [day(c), close(c)])),
    source: SOURCE,
  },
  null,
  2,
)}\n`;
const hash = writeArtifact(artifactPath, payload);

emit({
  changed: true,
  descriptor,
  source: SOURCE,
  retrievedAt: new Date().toISOString(),
  hash,
  artifacts: [artifactPath],
});
