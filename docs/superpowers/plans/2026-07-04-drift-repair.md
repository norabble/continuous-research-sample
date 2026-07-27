# Drift Simulation + Claude Code Sensor Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-healing demo from
`docs/superpowers/specs/2026-07-03-drift-repair-design.md`: a committed
source firewall simulates the BTC-USD feed moving; the next `sense` run
determines the sensor is broken and escalates to a `sensor-drift` issue; a
Claude Code (subscription-backed) workflow proposes the `sensor.mjs` fix.

**Architecture:** Source-agnostic pure logic (firewall matching, FIFO
truncation, shape validation, edition math, drift reports) moves to
`sensor-lib.mjs`; `sensor.mjs` keeps only orchestration plus the
source-specific adapter (`SOURCE` + `fetchEntries`) — the single file the
repair agent may edit. Drift is a structured determination (`changed: false`
+ ephemeral report), never a crash. Escalation and simulation are thin YAML;
repair is `anthropics/claude-code-action@v1` beside gh-aw, not inside it.

**Tech Stack:** Node ≥ 22 (no npm deps, `node:test`), GitHub Actions,
`gh` CLI, `actions/create-github-app-token@v2`,
`anthropics/claude-code-action@v1`, engine `continuous-research#v0.1.2`.

## Global Constraints

- Repo: `/home/rbake/workspace/continuous-research-sample` (public
  `norabble/continuous-research-sample`). All work on `main`; do NOT `git
  push` until the final task — earlier tasks commit locally only.
- No npm dependencies, no package.json — plain `.mjs` + `node --test`.
- The artifact JSON schema (`descriptor,date,close,prev_close,
  day_over_day_pct,ma7,close_vs_ma7_pct,ma7_prev_day,ma7_trend,
  recent_closes,source`) and the descriptor scheme `btcusd-YYYY-MM-DD` are
  frozen contracts — byte-identical math to the current `sensor.mjs`.
- The `SAMPLE_DESCRIPTOR` deterministic test mode must keep working.
- Fail-closed: no edition is ever minted from a broken source.
- Workflow security: never interpolate `github.event.*` or free-text
  `inputs.*` directly into `run:` shell — pass via `env:`.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Commits: imperative subject, body says why.

---

### Task 1: `sensor-lib.mjs` — pure logic + tests

**Files:**
- Create: `sensor-lib.mjs`
- Create: `sensor-lib.test.mjs`

**Interfaces:**
- Produces (later tasks import these exact names):
  - `isBlocked(firewall, host) → boolean`
  - `addToFirewall(firewall, host, reason, addedAt) → { firewall, added }`
    (pure; FIFO cap `firewall.maxEntries ?? 2`; idempotent by host)
  - `validateEntries(entries) → boolean` (entries =
    `[{ day: "YYYY-MM-DD", close: number }, …]`, ascending, ≥ 9)
  - `buildEdition(entries, source) → { descriptor, payload }`
  - `buildDriftReport({ reason, source, detail, at }) → object`

- [x] **Step 1: Write the failing tests** — `sensor-lib.test.mjs`:

```js
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
```

- [x] **Step 2: Run to verify failure**

Run: `cd /home/rbake/workspace/continuous-research-sample && node --test sensor-lib.test.mjs`
Expected: FAIL — `Cannot find module … sensor-lib.mjs`

- [x] **Step 3: Implement `sensor-lib.mjs`**

```js
/**
 * Source-agnostic sensor logic for the BTC-USD sample. sensor.mjs owns the
 * source-specific adapter (URL + fetch + response mapping); this module owns
 * everything a replacement source must NOT change: firewall semantics, entry
 * validation, the frozen edition/artifact math, and drift-report shape. The
 * repair agent's write surface is sensor.mjs only — this file is stable.
 */

export function isBlocked(firewall, host) {
  return (firewall?.blocked ?? []).some((b) => b.host === host);
}

export function addToFirewall(firewall, host, reason, addedAt) {
  if (isBlocked(firewall, host)) return { firewall, added: false };
  const max = firewall.maxEntries ?? 2;
  const blocked = [...(firewall.blocked ?? []), { host, addedAt, reason }].slice(-max);
  return { firewall: { ...firewall, blocked }, added: true };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 9) return false;
  return entries.every(
    (e) => DAY_RE.test(e?.day ?? "") && Number.isFinite(e?.close) && e.close > 0,
  );
}

export function buildEdition(entries, source) {
  const closes = entries.map((e) => e.close);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma7 = avg(closes.slice(-7));
  const ma7Prev = avg(closes.slice(-8, -1));
  const latest = entries.at(-1);
  const descriptor = `btcusd-${latest.day}`;
  const payload = {
    descriptor,
    date: latest.day,
    close: latest.close,
    prev_close: closes.at(-2),
    day_over_day_pct: +((latest.close / closes.at(-2) - 1) * 100).toFixed(2),
    ma7: +ma7.toFixed(2),
    close_vs_ma7_pct: +((latest.close / ma7 - 1) * 100).toFixed(2),
    ma7_prev_day: +ma7Prev.toFixed(2),
    ma7_trend: ma7 >= ma7Prev ? "rising" : "falling",
    recent_closes: Object.fromEntries(entries.slice(-10).map((e) => [e.day, e.close])),
    source,
  };
  return { descriptor, payload };
}

export function buildDriftReport({ reason, source, detail, at }) {
  return { reason, source, host: new URL(source).host, detail, at };
}
```

- [x] **Step 4: Run to verify pass**

Run: `node --test sensor-lib.test.mjs`
Expected: PASS, 8/8.

- [x] **Step 5: Commit**

```bash
git add sensor-lib.mjs sensor-lib.test.mjs
git commit -m "sensor-lib: extract the source-agnostic logic (TDD)

The repair loop confines the agent to sensor.mjs, so everything a
replacement source must not change — firewall semantics, entry validation,
the frozen edition math, drift-report shape — moves behind a stable module
boundary with node:test coverage.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: `sensor.mjs` — adapter + drift determination

**Files:**
- Modify: `sensor.mjs` (full rewrite below)
- Create: `sensor.test.mjs`
- Modify: `.gitignore` (append one line)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `export const SOURCE` (string URL — Task 3's script imports it);
  importing `sensor.mjs` must be side-effect-free (main is guarded).
- Behavior contract: drift ⇒ writes `.research/drift/report.json`, prints
  `{"changed":false}` to stdout, exit 0. Healthy ⇒ unchanged current
  behavior. `SAMPLE_DESCRIPTOR` mode unchanged.

- [x] **Step 1: Write the failing test** — `sensor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("importing sensor.mjs is side-effect-free and exposes SOURCE", async () => {
  const mod = await import("./sensor.mjs");
  assert.equal(typeof mod.SOURCE, "string");
  assert.ok(new URL(mod.SOURCE).host.length > 0);
});
```

- [x] **Step 2: Run to verify failure**

Run: `node --test sensor.test.mjs`
Expected: FAIL — the current `sensor.mjs` has no `SOURCE` export, and the
import executes a live fetch (side effect). (It may fail as a timeout/fetch
error — either way, red.)

- [x] **Step 3: Rewrite `sensor.mjs`**

```js
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

export const SOURCE =
  "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400";

/** Fetch completed-UTC-day entries, ascending: [{ day, close }, …]. */
export async function fetchEntries() {
  const res = await fetch(SOURCE, {
    headers: { "User-Agent": "continuous-research-sample" },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  // Candles: [[timeSec, low, high, open, close, volume], …] most-recent-first.
  const candles = (await res.json()).sort((a, b) => a[0] - b[0]);
  const todayUtcSec = Math.floor(Date.now() / 86_400_000) * 86_400;
  return candles
    .filter((c) => c[0] < todayUtcSec)
    .map((c) => ({ day: new Date(c[0] * 1000).toISOString().slice(0, 10), close: c[4] }));
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
```

- [x] **Step 4: Append to `.gitignore`** (the drift report is working-tree
  state, never committed):

```
.research/drift/
```

- [x] **Step 5: Run tests**

Run: `node --test`
Expected: PASS — all of Task 1's tests plus the new import test (9 total).

- [x] **Step 6: End-to-end drift check (local, no commit of outputs)**

```bash
mkdir -p .research
cat > .research/source-firewall.json <<'EOF'
{
  "schema": "sample/source-firewall@v1",
  "maxEntries": 2,
  "blocked": [
    { "host": "api.exchange.coinbase.com", "addedAt": "2026-07-04T00:00:00Z", "reason": "e2e check" }
  ]
}
EOF
node sensor.mjs
cat .research/drift/report.json
```

Expected: stdout exactly `{"changed":false}`; the report shows
`"reason": "source-firewalled"`. Then verify the healthy path and test mode:

```bash
printf '{\n  "schema": "sample/source-firewall@v1",\n  "maxEntries": 2,\n  "blocked": []\n}\n' > .research/source-firewall.json
node sensor.mjs            # expect {"changed":true,...,"descriptor":"btcusd-<yesterday>"}
SAMPLE_DESCRIPTOR=btcusd-e2e-check node sensor.mjs   # expect deterministic skeleton output
rm -rf .research/drift data/btcusd/btcusd-e2e-check.json
git checkout -- data/ 2>/dev/null || true
git status --short          # only intended files (firewall stays for Task 3)
```

- [x] **Step 7: Commit** (the firewall file is committed in Task 3; keep it
  out here):

```bash
git add sensor.mjs sensor.test.mjs .gitignore
git commit -m "sensor: turn source failure into a drift determination

Firewalled host, fetch failure, and response-shape mismatch now produce a
structured drift report (working-tree only) plus {changed:false} instead of
a crash — a broken source is a state to escalate, not an error, and
fail-closed is preserved because nothing is proposed. The source-specific
adapter (SOURCE + fetchEntries) is the repair agent's entire write surface;
main is import-guarded so scripts and tests can read SOURCE safely.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: firewall seed + `scripts/firewall-add.mjs`

**Files:**
- Create: `.research/source-firewall.json`
- Create: `scripts/firewall-add.mjs`

**Interfaces:**
- Consumes: `SOURCE` from `sensor.mjs`; `addToFirewall` from
  `sensor-lib.mjs`.
- Produces: CLI `node scripts/firewall-add.mjs [reason]` — appends the
  current source host to the firewall (idempotent, FIFO 2); exit 0 both on
  add and on already-blocked. Task 4's workflow calls it.

- [x] **Step 1: Seed the firewall (empty)** — `.research/source-firewall.json`:

```json
{
  "schema": "sample/source-firewall@v1",
  "maxEntries": 2,
  "blocked": []
}
```

(If Task 2's e2e check left this exact file in place, just verify content.)

- [x] **Step 2: Write `scripts/firewall-add.mjs`**

```js
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
```

- [x] **Step 3: Verify by hand (round-trip)**

```bash
node scripts/firewall-add.mjs "manual check"
cat .research/source-firewall.json    # expect api.exchange.coinbase.com blocked
node scripts/firewall-add.mjs         # expect "already blocked", exit 0
node sensor.mjs                       # expect {"changed":false} + drift report
git checkout -- .research/source-firewall.json
rm -rf .research/drift
node --test                           # still all green
```

- [x] **Step 4: Commit**

```bash
git add .research/source-firewall.json scripts/firewall-add.mjs
git commit -m "firewall: seed the source blocklist + the simulation script

The committed firewall is the simulation lever: adding the current source
host makes the next sense run determine the sensor is broken. FIFO cap 2
keeps older providers eligible again; the repair agent cannot edit this
file, so it must genuinely find a new source.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: `simulate-drift.yml`

**Files:**
- Create: `.github/workflows/simulate-drift.yml`

**Interfaces:**
- Consumes: `scripts/firewall-add.mjs` (Task 3).
- Produces: a dispatchable workflow that commits the firewall change to
  `main` — the "one click = feed moved" trigger.

- [x] **Step 1: Write the workflow**

```yaml
name: simulate-drift

# Simulate the data feed moving: firewall the sensor's current source host
# and commit, so the next sense run makes the broken-sensor determination.
on:
  workflow_dispatch:
    inputs:
      reason:
        description: "Why (recorded in the firewall entry)"
        required: false
        default: "simulated feed retirement"

permissions:
  contents: write

concurrency:
  group: simulate-drift
  cancel-in-progress: false

jobs:
  simulate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Firewall the current source host
        env:
          REASON: ${{ inputs.reason }}
        run: node scripts/firewall-add.mjs "$REASON"
      - name: Commit the firewall change
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .research/source-firewall.json
          if git diff --cached --quiet; then
            echo "source already firewalled — nothing to commit"
          else
            git commit -m "simulate drift: firewall the current source host"
            git push
          fi
```

- [x] **Step 2: Sanity-check the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/simulate-drift.yml'))"`
Expected: silence.

- [x] **Step 3: Commit**

```bash
git add .github/workflows/simulate-drift.yml
git commit -m "simulate-drift: one-click feed-change simulation

Dispatch appends the current source host to the firewall and commits, so
the next cron/dispatched sense run detects the sensor as broken. Free-text
input reaches the shell only via env.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: `sense.yml` escalation + engine pin bumps

**Files:**
- Modify: `.github/workflows/sense.yml` (pin line 46 + new step after `sense`)
- Modify: `.github/workflows/decline.yml:30` (pin only)

**Interfaces:**
- Consumes: the drift report path `.research/drift/report.json` (Task 2).
- Produces: on drift, exactly one open issue labeled `sensor-drift` whose
  body embeds the report JSON — the durable record Task 6's agent reads.

- [x] **Step 1: Bump both engine pins** — in `sense.yml` and `decline.yml`,
  change `github:norabble/continuous-research#v0.1.1` →
  `github:norabble/continuous-research#v0.1.2`.

- [x] **Step 2: Append the escalation step** to `sense.yml` after the
  `sense` step (same indentation level):

```yaml
      - name: Escalate drift to the sensor-drift issue
        # The drift report is ephemeral working-tree state; the issue is the
        # durable record the repair agent reads. One open issue = escalation
        # dedup (re-runs comment instead of re-filing). App token: Issues R/W.
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          [ -f .research/drift/report.json ] || exit 0
          gh label create sensor-drift \
            --description "Sensor cannot produce an edition from its declared source" \
            --color B60205 --force
          report="$(cat .research/drift/report.json)"
          body="$(printf 'The sense run could not produce an edition — the sensor is broken or its source moved.\n\nDrift report:\n\n```json\n%s\n```\n\nRepair contract: propose a fix PR editing **sensor.mjs only** (SOURCE + fetchEntries), using a source whose host is NOT in `.research/source-firewall.json`. Close this issue via `Fixes #N` in the PR.' "$report")"
          existing="$(gh issue list --label sensor-drift --state open --json number --jq '.[0].number // empty')"
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body "$body"
          else
            gh issue create --title "sensor drift: cannot produce an edition" \
              --label sensor-drift --body "$body"
          fi
```

- [x] **Step 3: Verify YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sense.yml')); yaml.safe_load(open('.github/workflows/decline.yml'))"`
Expected: silence.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/sense.yml .github/workflows/decline.yml
git commit -m "sense: escalate drift reports to the sensor-drift issue

A drift report in the working tree after sense means the sensor could not
produce an edition; the step opens (or comments on) the single sensor-drift
issue with the report embedded — the durable record the repair workflow
reads. Also bumps the engine pin to v0.1.2 in both engine workflows.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: `sensor-repair.yml` (claude-code-action)

**Files:**
- Create: `.github/workflows/sensor-repair.yml`

**Interfaces:**
- Consumes: the `sensor-drift` label + issue (Task 5); repo secrets
  `CLAUDE_CODE_OAUTH_TOKEN` (maintainer creates — final task checklist),
  `APP_ID`, `APP_PRIVATE_KEY` (already exist).
- Produces: on drift-label, a Claude Code run that opens the fix PR.

- [x] **Step 1: Verify the action's input names against its current
  `action.yml`** (the spec's research verified the secret name; confirm the
  inputs before wiring):

Run: `curl -sf https://raw.githubusercontent.com/anthropics/claude-code-action/main/action.yml | grep -E "^  [a-z_]+:" | head -25`
Expected: inputs including `claude_code_oauth_token`, `github_token`,
`prompt`, `claude_args`. **If any name differs, use the names actually
listed** and note the difference in the commit body.

- [x] **Step 2: Write the workflow**

```yaml
name: sensor-repair

# Agentic code fix for sensor drift. Runs on the maintainer's Claude Pro
# subscription via claude-code-action's OAuth token (sanctioned CI path;
# gh-aw deliberately rejects this token, hence a plain workflow beside it).
# Confinement is prompt + human PR review — merge authority is the gate.
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Open sensor-drift issue number to repair against"
        required: true

permissions:
  contents: read

concurrency:
  group: sensor-repair
  cancel-in-progress: false

jobs:
  repair:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'sensor-drift'
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Mint App installation token
        id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: ${{ steps.app-token.outputs.token }}
          claude_args: "--max-turns 40"
          prompt: |
            You are the sensor-repair agent for this Continuous Research
            instance. Drift issue: #${{ github.event.issue.number || inputs.issue_number }}.

            Read, in order: that issue (the drift report is embedded in it),
            .research/source-firewall.json, sensor.mjs, sensor-lib.mjs
            (context only), findings.md (context only).

            Task: the declared source in sensor.mjs is unusable. Find a
            replacement public BTC-USD daily-candles API whose host is NOT
            on the firewall. Candidates to evaluate first: Kraken public
            OHLC, Bitstamp OHLC, CoinGecko market chart. Requirements: no
            API key, plainly fetchable (no JS rendering), yields at least 9
            completed UTC days of date + close.

            Verify before coding: actually fetch the candidate and inspect
            the real response shape.

            Then edit sensor.mjs ONLY — update SOURCE and fetchEntries() so
            it returns [{ day: "YYYY-MM-DD", close: Number }] ascending,
            completed UTC days only. Do not modify sensor-lib.mjs, the
            firewall, workflows, tests, or the artifact schema. Run
            `node --test` and make it pass; run `node sensor.mjs` and
            confirm it emits {"changed":true,...} with a plausible
            btcusd-YYYY-MM-DD descriptor.

            Open a pull request: branch fix/sensor-<new-host>, title
            "fix(sensor): re-point to <new host> after source drift". The
            body must include the evidence trail — chosen source URL, a
            trimmed sample of its real response, why it satisfies the
            entry contract — and the line "Fixes #<issue number>".
```

- [x] **Step 3: Verify YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sensor-repair.yml'))"`
Expected: silence.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/sensor-repair.yml
git commit -m "sensor-repair: Claude Code fix workflow on the drift label

Runs anthropics/claude-code-action on the maintainer's Claude Pro OAuth
token (the sanctioned no-API-billing CI path; gh-aw deliberately ignores
that token, so repair lives beside gh-aw). The agent must find a
non-firewalled replacement source, verify it by fetching, and PR a
sensor.mjs-only fix with the evidence trail; merge authority stays human.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: CI tests, README, push + maintainer checklist

**Files:**
- Create: `.github/workflows/test.yml`
- Modify: `README.md` (new section)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: PR-gating tests (they run on the repair agent's PR — the
  mechanical part of reviewing its fix), public docs, everything pushed.

- [x] **Step 1: Write `.github/workflows/test.yml`**

```yaml
name: test

# node:test suite. Runs on any PR touching sensor code — including the
# repair agent's fix PR, where it is the mechanical half of the review.
on:
  push:
    branches: [main]
    paths: ["sensor*.mjs", "scripts/**", ".github/workflows/test.yml"]
  pull_request:
    paths: ["sensor*.mjs", "scripts/**"]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: node --test
```

- [x] **Step 2: Add a README section** (after the existing loop
  description; match the README's tone and heading level):

```markdown
## Drift & self-repair demo

The feed "moving" can be simulated: **Actions → simulate-drift → Run
workflow** adds the sensor's current source host to
`.research/source-firewall.json` (FIFO, max 2 entries — old providers
become eligible again). The next `sense` run then *determines the sensor is
broken* — firewalled, unreachable, or shape-changed sources all produce a
drift report instead of a crash — and escalates it to the single open
`sensor-drift` issue.

That label triggers `sensor-repair.yml`: a Claude Code agent (running on a
subscription OAuth token, not API billing) researches a replacement source,
verifies it by fetching it, and opens a PR editing `sensor.mjs` only. Tests
gate the PR; a human merges it; the next `sense` run heals and the issue
closes. The whole cycle — break → detect → issue → code-fix PR → merge →
heal — stays legible in the repo history.
```

- [x] **Step 3: Full local verification**

```bash
node --test                 # all green
git status --short          # clean except intended files
git log --oneline origin/main..HEAD   # the task commits + the two design commits
```

- [x] **Step 4: Commit and push everything**

```bash
git add .github/workflows/test.yml README.md
git commit -m "test workflow + README: document the drift/self-repair demo

The test job runs on any PR touching sensor code, so it mechanically gates
the repair agent's own fix PR.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

- [x] **Step 5: Report the maintainer checklist** (cannot be automated —
  end the run by listing these verbatim):

1. Locally run `claude setup-token` (needs the Claude Pro login) and save
   the printed token as repo secret `CLAUDE_CODE_OAUTH_TOKEN` on
   `norabble/continuous-research-sample`. Calendar a regeneration in ~11
   months.
2. Live demo: Actions → **simulate-drift** → run; then Actions → **sense**
   → run; confirm the `sensor-drift` issue appears with the embedded
   report; watch **sensor-repair** fire on the label; review the fix PR
   (diff confined to `sensor.mjs`, tests green, evidence trail present);
   merge; dispatch **sense** again → healthy `proposed`/`skip` outcome and
   the issue closes.
3. If the repair run exhausts Pro limits or misbehaves, it is bounded by
   `--max-turns 40` + `timeout-minutes: 25`; re-dispatch via
   workflow_dispatch with the issue number once limits reset.
