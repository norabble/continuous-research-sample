# Continuous Research — Sample Instance

The reference instance for the
[Continuous Research](https://github.com/norabble/continuous-research) framework
— a real demonstrator we control end to end.

> **⚠️ This is a demonstration, not research.** This repo exists only to exercise
> the framework's loop (sense → propose → review → impact). The BTC-USD figures
> and "trend" claims are **illustrative of the mechanism**, not financial
> analysis, advice, or anything held to a research standard. Don't rely on them.

**Subject:** a 24/7 crypto pair (BTC-USD), periodized into **daily editions**
(descriptor `btcusd-YYYY-MM-DD`), with a simple updating trend claim.

**Status — deterministic skeleton.** Right now the sensor
([`sensor.mjs`](./sensor.mjs)) is a *deterministic stand-in*: it emits a
detection result for the edition named in `SAMPLE_DESCRIPTOR` (or "no change"
when unset), so the framework's propose / dedup / decline loop can be validated
with no network and no Claude. The real BTC-USD pipeline and the agentic sensor
arrive later.

Hooks are declared in [`.research/config.json`](./.research/config.json).

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
