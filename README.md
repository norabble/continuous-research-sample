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
