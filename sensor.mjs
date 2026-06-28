#!/usr/bin/env node
/**
 * Deterministic skeleton sensor for the Continuous Research walking skeleton.
 *
 * It emits one JSON detection result on stdout (the sensor↔engine contract) and
 * nothing else, so the engine can parse stdout directly. The edition is chosen
 * per run via SAMPLE_DESCRIPTOR — with none set it reports "no change" — which
 * makes the three-state dedup scenario fully controllable, with no network and
 * no Claude. The real BTC-USD pipeline + agentic sensor replace this at step 7.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const descriptor = process.env.SAMPLE_DESCRIPTOR?.trim();

if (!descriptor) {
  process.stdout.write(`${JSON.stringify({ changed: false })}\n`);
  process.exit(0);
}

// A placeholder artifact standing in for a real BTC-USD daily edition.
const artifactPath = `data/btcusd/${descriptor}.json`;
const payload = `${JSON.stringify(
  { descriptor, note: "placeholder edition (deterministic skeleton)" },
  null,
  2,
)}\n`;

mkdirSync("data/btcusd", { recursive: true });
writeFileSync(artifactPath, payload);

const result = {
  changed: true,
  descriptor,
  source: "deterministic://skeleton",
  retrievedAt: new Date().toISOString(),
  hash: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
  artifacts: [artifactPath],
};

process.stdout.write(`${JSON.stringify(result)}\n`);
