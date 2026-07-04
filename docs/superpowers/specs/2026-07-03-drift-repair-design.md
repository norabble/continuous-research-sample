# Simulated source drift + agentic sensor repair — design

**Instance:** `continuous-research-sample` (daily BTC-USD editions)
**Date:** 2026-07-03 · **Status:** approved design, pre-implementation

## Goal

Demonstrate the full self-healing loop on the sample instance: a data feed
"changes" (simulated), the next `sense` run determines the current sensor is
broken, escalation raises a labeled issue, and an agentic **code-fix**
workflow finds a replacement source and proposes an edit to `sensor.mjs` —
with merge authority staying human throughout.

Approach: **instance-side drift handling** (no framework changes). The
sensor reports drift inside the existing sensor contract (`changed: false`
plus an ephemeral working-tree report); the instance's workflows do the
escalation and repair. This mirrors the pattern the `token-source-review`
instance proved buildable from the framework's public docs alone; a second
empirical instance here feeds any future framework-native `drift` outcome.

## Components

### 1. Source firewall — `.research/source-firewall.json`

The simulation lever, and the guard that forces genuine re-discovery.

```json
{
  "schema": "sample/source-firewall@v1",
  "maxEntries": 2,
  "blocked": [
    { "host": "api.exchange.coinbase.com",
      "addedAt": "2026-07-03T00:00:00Z",
      "reason": "simulated retirement" }
  ]
}
```

- Hosts the sensor refuses to fetch from.
- **FIFO-truncated at two entries** — adding a third drops the oldest — so
  the pool of viable public BTC-USD sources is never exhausted and an old
  provider eventually becomes eligible again.
- The repair agent's write surface excludes this file, so it **cannot
  unblock** the retired source; it must find a new one.
- Committed, reviewable state; changed only by the simulation workflow or a
  human.

### 2. Sensor — drift instead of crash

`sensor.mjs` gains a drift path; today's `exit 1` on fetch failure becomes a
structured determination. Drift triggers, checked in order:

1. **Firewalled** — the source URL's host appears in the firewall.
2. **Fetch failure** — network error or non-OK status.
3. **Shape mismatch** — the response no longer parses as the expected
   candles array (provider changed their schema).

On drift: write `.research/drift/report.json`
(`{ reason, source, host, detail, at }`) to the **working tree only** —
never committed, so it is naturally fresh each CI run — emit
`{ "changed": false }`, exit 0. Still fail-closed: nothing is proposed, no
edition is minted from a broken source.

The pure logic (firewall check, FIFO truncation, candle-shape validation)
moves to a small module with `node:test` tests. The `SAMPLE_DESCRIPTOR`
deterministic test mode is unchanged.

### 3. Simulation trigger — `simulate-drift.yml`

`workflow_dispatch` only. Runs a small script (`scripts/firewall-add.mjs`,
also runnable locally) that:

- reads the sensor's *current* source host,
- appends it to the firewall (idempotent; FIFO cap 2),
- commits the change to `main` with a message that says this is a simulated
  feed change.

One click = "the feed moved." The next cron or dispatched `sense` run makes
the broken-sensor determination.

### 4. Escalation — a step in `sense.yml`

After the sense step: if `.research/drift/report.json` exists, open-or-update
the **single** issue labeled `sensor-drift` (label auto-created), embedding
the report's JSON in the issue body — the report itself is ephemeral, so the
issue is the durable record the repair agent reads. Re-runs comment on the
open issue rather than filing a new one — the open issue is the escalation
dedup. Runs on the App token (Issues R/W already granted).
No `github.event.*` interpolation reaches the shell.

While touching this file: bump the engine pin `v0.1.1` → `v0.1.2`.

### 5. Repair — `sensor-repair.yml` (claude-code-action, not gh-aw)

Repair is a **plain Actions workflow** using `anthropics/claude-code-action@v1`,
backed by the maintainer's **Claude Pro subscription** — no API billing.
Verified 2026-07-03: `claude setup-token` mints a ~1-year OAuth token
(`CLAUDE_CODE_OAUTH_TOKEN`) that Anthropic documents for CI on Pro plans and
the action accepts as a first-class input. gh-aw deliberately rejects this
token (its auth reference: set as a secret, "it will be ignored"), which is
why repair sits beside gh-aw rather than inside it. Interpretation stays on
gh-aw + flash-lite unchanged.

- **Trigger:** `issues: [labeled]`, job gated on
  `github.event.label.name == 'sensor-drift'`, plus `workflow_dispatch` as
  the debug door.
- **Auth:** `CLAUDE_CODE_OAUTH_TOKEN` repo secret (calendar the ~1-year
  regeneration); PR authorship via an App-minted token (`github_token:`) —
  the org blocks default-token PRs, same pattern as `sense.yml`.
- **Reads:** the drift issue (the report is ephemeral and gone by repair
  time), `.research/source-firewall.json`, `sensor.mjs`, `findings.md`.
- **Task:** select a public daily-candles BTC-USD source **not on the
  firewall**; verify by actually fetching it that the response yields date +
  close for completed UTC days; rewrite the fetch/parse portion of
  `sensor.mjs`; keep the descriptor scheme and artifact schema unchanged.
  Output: a branch + PR whose body carries the evidence trail (chosen
  source, sample response, why it satisfies the artifact schema) and
  `Fixes #<drift issue>`. Never auto-merged.
- **Confinement (honest note):** claude-code-action has no gh-aw-style
  `allowed-files`; the sensor.mjs-only scope is enforced by prompt plus
  human review of the PR diff — acceptable because merge authority is the
  real gate. Cost/runaway guards that *are* mechanical: `--max-turns`,
  `timeout-minutes`, and the one-open-drift-issue trigger cap (CI runs draw
  from the same Pro usage pool as interactive use).

**Framework stance (constraint on any follow-on work):** this integration
is *instance-side by design*. The framework must not assume Claude Code —
adopters will bring API keys, subscriptions, or engines gh-aw adds later.
Framework support is implicit via gh-aw's engine config where gh-aw supports
a credential, and explicit (documented integrations like this one) where it
does not.

### 6. The healed loop

Maintainer merges the fix PR → next `sense` run fetches from the new
provider → proposes the next edition normally → the drift issue closes via
`Fixes #n`. The whole cycle — simulate → detect → issue → code-fix PR →
merge → heal — is legible in the repo history.

## Decisions and invariants

- **Descriptors stay `btcusd-YYYY-MM-DD`** regardless of provider: the
  edition is the day, not the source. The provenance stub records which
  source produced each edition.
- Drift is a *state to escalate*, not a crash; but no edition is ever minted
  from a broken source (fail-closed preserved).
- The artifact JSON schema (`close`, `ma7`, `day_over_day_pct`, …) is the
  stable contract a replacement source must satisfy; the repair PR may not
  change it.
- One open `sensor-drift` issue caps escalation fan-out.
- Guardrails throughout: `timeout-minutes`, sense concurrency group,
  `allowed-files`, fail-closed quota behavior.

## Testing

- `node:test` unit tests for the pure module: firewall matching, FIFO
  truncation at 2, candle-shape validation, drift-report construction.
- Local end-to-end: run the sensor with the firewall containing the Coinbase
  host → expect `{changed:false}` + a drift report; with an empty firewall →
  expect a normal detection.
- Live qualification: dispatch `simulate-drift`, then `sense`; observe the
  issue, the repair run, and review the fix PR — checking both that the fix
  works (run the sensor locally against the new source) and that the diff
  stayed inside `sensor.mjs`.
