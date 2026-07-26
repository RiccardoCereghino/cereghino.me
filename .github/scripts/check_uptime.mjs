#!/usr/bin/env node
/**
 * Behavioural test for the uptime row — the one genuinely non-trivial piece of
 * logic on the page.
 *
 * It extracts the <script> body from index.html and executes *that exact code*
 * against a stubbed clock, so this tests what ships rather than a copy that can
 * drift. No browser needed, fully deterministic.
 *
 * The property that matters: years must come from real calendar arithmetic, so
 * a leap year contributes all 366 of its days. An average-year approximation
 * (days / 365.25) agrees with the calendar on plenty of dates — including,
 * as it happens, the date this was written — so spot-checking "today" proves
 * nothing. The sweep below is what actually pins it down.
 *
 * usage: node check_uptime.mjs [path/to/index.html]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = process.argv[2] || join(HERE, '..', '..', 'index.html');
const EPOCH_YEAR = 2010;
const EPOCH = Date.UTC(EPOCH_YEAR, 0, 1);

const src = readFileSync(INDEX, 'utf8');
const found = /<script>([\s\S]*?)<\/script>/.exec(src);
if (!found) {
  console.error('FATAL: no <script> block found in ' + INDEX);
  process.exit(1);
}
const shipped = found[1];

/** Run the shipped script with the clock pinned to `atMs`. */
function render(atMs) {
  let written = null;
  const document = {
    getElementById: () => ({ set textContent(v) { written = v; } }),
  };
  const RealDate = Date;
  class StubDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [atMs])); }
    static now() { return atMs; }
  }
  new Function('document', 'Date', shipped)(document, StubDate);
  if (written === null) throw new Error('script wrote nothing');
  return written;
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

/* ---- fixed dates, including both leap-year edges ---- */
const CASES = [
  ['2010-01-01T00:00:00Z', '0 years, 0 days, 0 hours, 0 mins', 'the epoch itself'],
  ['2010-01-02T01:01:00Z', '0 years, 1 day, 1 hour, 1 min', 'every unit singular'],
  ['2011-01-01T00:00:00Z', '1 year, 0 days, 0 hours, 0 mins', 'singular year'],
  ['2012-02-29T00:00:00Z', '2 years, 59 days, 0 hours, 0 mins', 'the leap day itself'],
  ['2012-12-31T00:00:00Z', '2 years, 365 days, 0 hours, 0 mins', 'leap year reaches 365'],
  ['2013-01-01T00:00:00Z', '3 years, 0 days, 0 hours, 0 mins', 'rolls over after a leap year'],
  ['2024-12-31T23:59:00Z', '14 years, 365 days, 23 hours, 59 mins', 'last minute of a leap year'],
  ['2025-01-01T00:00:00Z', '15 years, 0 days, 0 hours, 0 mins', 'the minute after'],
];
for (const [iso, want, why] of CASES) {
  const got = render(Date.parse(iso));
  check(`${iso} — ${why}`, got === want, `got "${got}" want "${want}"`);
}

/* ---- format holds on every day for 30 years ---- */
const FORMAT = /^(\d+) years?, (\d+) days?, (\d+) hours?, (\d+) mins?$/;
let badFormat = 0, badRecompose = 0, badSingular = 0, days = 0;
for (let t = EPOCH; t < Date.UTC(2040, 0, 1); t += 864e5) {
  days++;
  const out = render(t + 36e5 * 5); // mid-morning, so hours/mins are non-zero
  const m = FORMAT.exec(out);
  if (!m) { badFormat++; continue; }
  const [, y, d] = m.map(Number);

  // Decomposing into years+days and recomposing must equal the plain day count
  // since the epoch. An average-year approximation drifts and fails this.
  const abs = Math.floor((Date.UTC(EPOCH_YEAR + y, 0, 1) - EPOCH) / 864e5) + d;
  if (abs !== Math.floor((t - EPOCH) / 864e5)) badRecompose++;

  // "1 day" not "1 days", and never "2 day"
  if (/\b1 (?:years|days|hours|mins)\b/.test(out)) badSingular++;
  if (/\b(?!1\b)\d+ (?:year|day|hour|min)\b/.test(out)) badSingular++;
}
check(`format holds across ${days} days`, badFormat === 0, `${badFormat} malformed`);
check('years+days always recompose to the true day count',
  badRecompose === 0, `${badRecompose} mismatches`);
check('singular/plural always agrees with the number',
  badSingular === 0, `${badSingular} wrong`);

/* ---- an average-year approximation must NOT pass the sweep ----
   Proves the sweep has teeth: if it accepted days/365.25 it would be
   worthless as a guard against exactly the mistake it exists to catch. */
let approxDisagrees = 0;
for (let t = EPOCH; t < Date.UTC(2040, 0, 1); t += 864e5) {
  const totalDays = Math.floor((t - EPOCH) / 864e5);
  const approxY = Math.floor(totalDays / 365.25);
  const trueY = new Date(t).getUTCFullYear() - EPOCH_YEAR;
  if (approxY !== trueY) approxDisagrees++;
}
check('a days/365.25 approximation would be caught',
  approxDisagrees > 0, `it differs on ${approxDisagrees} of ${days} days`);

/* ---- report ---- */
const width = Math.max(...results.map(r => r.name.length));
let failed = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'ok  ' : 'FAIL'}] ${r.name.padEnd(width)}` +
    (r.ok ? (r.detail && !r.detail.startsWith('got') ? `   ${r.detail}` : '') : `   <- ${r.detail}`));
  if (!r.ok) failed++;
}
console.log(`\n  ${results.length - failed}/${results.length} uptime checks passed`);
console.log(`  today: ${render(Date.now())}`);
if (failed) {
  console.error(`\n  ${failed} uptime check(s) failed.`);
  process.exit(1);
}
