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
