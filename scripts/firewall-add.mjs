#!/usr/bin/env node
/**
 * Simulate the data feed moving: add the sensor's CURRENT source host to the
 * source firewall (.research/source-firewall.json). FIFO-capped at
 * maxEntries (2) so the pool of viable sources is never exhausted;
 * idempotent so re-runs are safe. The simulate-drift workflow commits the
 * result; this script only edits the file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { SOURCE } from "../sensor.mjs";
import { addToFirewall } from "../sensor-lib.mjs";

const PATH = new URL("../.research/source-firewall.json", import.meta.url);
const host = new URL(SOURCE).host;
const reason = process.argv[2]?.trim() || "simulated feed retirement";

const current = JSON.parse(readFileSync(PATH, "utf8"));
const { firewall, added } = addToFirewall(current, host, reason, new Date().toISOString());

if (!added) {
  console.error(`firewall-add: ${host} already blocked — nothing to do`);
  process.exit(0);
}
writeFileSync(PATH, `${JSON.stringify(firewall, null, 2)}\n`);
console.error(`firewall-add: blocked ${host} (${reason})`);
