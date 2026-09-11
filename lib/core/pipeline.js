// lib/core/pipeline.js
// Shared data pipeline for the aggregator (opencode-benchmark.js): session math,
// sanity checks, report building from pooled benchmark rows, report JSON + schema
// serialization, and the daily-history machinery (snapshots + change detection).
// Pure data functions — no HTTP, no rendering; the aggregator wires parsers in.

import fs from 'node:fs';
import path from 'node:path';
import { benchDisplay, join } from './match.js';
import { readJsonSafe, stripMeta, writeJsonIfChanged } from './write.js';

// Typical session (from user logs): 155K context, 95% cache, ~300 output
//   input      =  5% × 155_000 =   7_750
//   cache_read = 95% × 155_000 = 147_250
//   output     =              =     300
const SESSION = {
  input: 7_750,
  cacheRead: 147_250,
  output: 300,
};

const POOL = 60; // monthly quota pool in USD (OpenCode Go fixed pool)

function sessionPrice(go) {
  return (
    (SESSION.input     * go.inputPerM     +
     SESSION.cacheRead * go.cacheReadPerM +
     SESSION.output    * go.outputPerM) / 1_000_000
  );
}

function milliPercents(price, usage) {
  // usage = model quota in $ (e.g. 30)
  // mp = price / usage × 100_000
  if (!usage) return null;
  return (price / usage) * 100_000;
}

// Sanity-validation of the parsed data BEFORE building the report. The point is not to
// catch a captcha per se, but to make sure that from the fresh pages we got
// "roughly what we wanted" (a full benchmark table with numbers),
// and didn't join garbage with garbage. Any anomaly — a clean failure without
// overwriting the previous good index.html.
function sanityCheck(goRows, benchRows) {
  // Minimum expected row count (historically: Go 35, benchmark 169–225).
  // A buffer below the real minimum, but high enough that a captcha page
  // (usually 1–10 rows or no table at all) fails.
  if (goRows.length < 10) {
    throw new Error(`Go table looks wrong: only ${goRows.length} models (expected >= 10). Aborting.`);
  }
  if (benchRows.length < 50) {
    throw new Error(`Benchmark table looks wrong: only ${benchRows.length} rows (expected >= 50). Aborting.`);
  }

  // Every Go row must have a name and all numeric rates (not NaN/Infinity).
  for (const r of goRows) {
    if (!r.model) throw new Error('Go table: empty model name. Aborting.');
    const nums = [r.inputPerM, r.outputPerM, r.cacheReadPerM, r.cacheWritePerM];
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new Error(`Go table: bad numeric value for "${r.model}". Aborting.`);
    }
  }

  // Benchmark: every row must have a name and a finite numeric score; at least some
  // rows must have cost/speed (otherwise this isn't the right table).
  let withCost = 0;
  for (const r of benchRows) {
    if (!r.model) throw new Error('Benchmark: empty model name. Aborting.');
    if (!Number.isFinite(r.score)) throw new Error(`Benchmark: bad score for "${r.model}". Aborting.`);
    if (r.costEuro != null || r.speed != null) withCost++;
  }
  if (benchRows.length > 0 && withCost === 0) {
    throw new Error('Benchmark: no rows carry Cost/Speed — looks like the wrong table. Aborting.');
  }

  return true;
}

// Build the merged report from fresh Go tariffs and the EFFECTIVE benchmark pool
// (pop = [{ row, issue }], see buildBenchPool). `latestSlug` is the issue slug of the
// newest issue; a row matched from an older issue is flagged as a backfill.
function buildReport(goRows, pool, latestSlug) {
  const joined = join(goRows, pool);

  // Sort: first by score DESC, then by mp ASC
  joined.sort((a, b) => {
    const as = a.bench?.score ?? -1;
    const bs = b.bench?.score ?? -1;
    if (as !== bs) return bs - as;
    const am = a.go.usage ? sessionPrice(a.go) / a.go.usage : Infinity;
    const bm = b.go.usage ? sessionPrice(b.go) / b.go.usage : Infinity;
    return am - bm;
  });

  const rows = joined.map(({ go, bench, issue, sim, tier }) => {
    const price = sessionPrice(go);
    const mp = milliPercents(price, go.usage);
    const multiplier = go.usage ? POOL / go.usage : null;
    const reqPerMonth = go.usage ? Math.floor(go.usage / price) : null;
    return {
      model: go.model,
      provider: go.provider ?? null,
      modelId: go.modelId ?? null,
      peak: go.peak || null,
      score: bench ? bench.score : null,
      price,
      mp,
      usage: go.usage,
      multiplier,
      reqPerMonth,
      matchedName: bench ? benchDisplay(bench.model) : null,
      sim,
      tier,
      benchIssue: issue ? issue.slug : null,
      benchFallback: !!issue && latestSlug && issue.slug !== latestSlug,
    };
  });

  const ranked = joined
    .filter(x => x.bench && x.go.usage > 0 && x.tier === 'OK')
    .map(x => ({
      model: x.go.model,
      score: x.bench.score,
      mp: milliPercents(sessionPrice(x.go), x.go.usage),
    }))
    .map(x => ({ ...x, ratio: x.score / x.mp }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 15);

  return { rows, ranked };
}

// Machine-readable JSON twin of the report (docs/report.json). Same data as the
// page, for anyone who wants to consume it programmatically instead of scraping HTML.
const round = (v, d) => (v == null ? null : +v.toFixed(d));

function reportToJson(report, sources, siteUrl) {
  return {
    $schema: siteUrl ? `${siteUrl}/report.schema.json` : 'report.schema.json',
    generatedAt: new Date().toISOString(),
    generator: {
      name: 'opencode-benchmark',
      page: siteUrl ? `${siteUrl}/` : null,
      source: 'https://github.com/krivich/opencode-benchmark',
      license: 'MIT',
    },
    sources,
    legal: {
      trademarks: 'Model names and trademarks belong to their respective owners and are used for identification only.',
      disclaimer: 'Unofficial, independent aggregation of public data; not affiliated with or endorsed by OpenCode, TIMETOACT GROUP or any model vendor. All figures are rough estimates and may change without notice — verify before use.',
    },
    session: {
      inputTokens: SESSION.input,
      cacheReadTokens: SESSION.cacheRead,
      outputTokens: SESSION.output,
      monthlyPoolUsd: POOL,
    },
    rows: report.rows.map((r) => ({
      model: r.model,
      provider: r.provider ?? null,
      modelId: r.modelId ?? null,
      score: r.score,
      priceUsdPerSession: round(r.price, 6),
      mpPerSession: round(r.mp, 2),
      quotaUsd: r.usage,
      multiplier: round(r.multiplier, 4),
      requestsPerMonth: r.reqPerMonth,
      matchedBenchmarkName: r.matchedName,
      similarity: round(r.sim, 3),
      tier: r.tier,
      benchmarkIssue: r.benchIssue || null,
      benchmarkFallback: r.benchFallback || false,
      peakHours: r.peak
        ? { tz: r.peak.tz, days: r.peak.days, ranges: r.peak.ranges }
        : null,
    })),
    ranked: report.ranked.map((x) => ({
      model: x.model,
      score: x.score,
      mpPerSession: round(x.mp, 1),
      scorePerMp: round(x.ratio, 2),
    })),
  };
}

// ──────────────────────────────────────────────
// History: daily snapshots + change detection
// ──────────────────────────────────────────────
// Every run stores a dated snapshot (docs/history/YYYY-MM-DD.json, same schema as
// report.json) and diffs it against the previous snapshot. The page then shows
// "what changed" and a history table — the site becomes a time series, not just
// a table for today.

function loadPrevSnapshot(outDir) {
  const manifestPath = path.join(outDir, 'history', 'index.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const list = manifest.snapshots || [];
  const last = list[list.length - 1];
  if (!last) return null;
  const file = path.join(outDir, last.file);
  if (!fs.existsSync(file)) return null;
  try {
    return { manifest, prev: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

function detectChanges(json, prev) {
  if (!prev || !Array.isArray(prev.rows)) {
    return { vs: null, benchmarkIssueChanged: false, items: [] };
  }
  const prevByModel = new Map(prev.rows.map((r) => [r.model, r]));
  const curNames = new Set();
  const KIND_ORDER = { score: 0, price: 1, quota: 2, added: 3, removed: 4 };
  const items = [];

  for (const r of json.rows) {
    curNames.add(r.model);
    const p = prevByModel.get(r.model);
    if (!p) {
      items.push({ kind: 'added', model: r.model, from: null, to: null });
      continue;
    }
    if ((p.score ?? null) !== (r.score ?? null)) {
      items.push({ kind: 'score', model: r.model, from: p.score ?? null, to: r.score ?? null });
    }
    if (p.priceUsdPerSession != null && r.priceUsdPerSession != null
      && Math.abs(p.priceUsdPerSession - r.priceUsdPerSession) > 1e-9) {
      items.push({ kind: 'price', model: r.model, from: p.priceUsdPerSession, to: r.priceUsdPerSession });
    }
    if ((p.quotaUsd ?? null) !== (r.quotaUsd ?? null)) {
      items.push({ kind: 'quota', model: r.model, from: p.quotaUsd ?? null, to: r.quotaUsd ?? null });
    }
  }
  for (const p of prev.rows) {
    if (!curNames.has(p.model)) items.push({ kind: 'removed', model: p.model, from: null, to: null });
  }
  items.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.model.localeCompare(b.model, 'en'));

  return {
    vs: prev.generatedAt ? String(prev.generatedAt).slice(0, 10) : null,
    benchmarkIssueChanged: !!(prev.sources?.benchmark?.url && json.sources.benchmark.url !== prev.sources.benchmark.url),
    items,
  };
}

function writeSnapshot(outDir, full, changesCount) {
  const historyDir = path.join(outDir, 'history');
  const manifestPath = path.join(historyDir, 'index.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = { updated: null, snapshots: [] };
  }
  const date = full.generatedAt.slice(0, 10);
  const top = full.ranked[0];
  const entry = {
    date,
    file: `history/${date}.json`,
    generatedAt: full.generatedAt,
    models: full.rows.length,
    best: top ? `${top.model} · ${top.scorePerMp.toFixed(2)}` : null,
    changes: changesCount,
  };
  const snapFile = path.join(historyDir, `${date}.json`);

  // Idempotent history: if the report carries exactly the same data as the previous
  // snapshot, do NOT write a new day file (sparse time series) — the log makes it
  // obvious the file is absent because nothing changed, not because we broke.
  const prevSnap = manifest.snapshots[manifest.snapshots.length - 1];
  if (prevSnap) {
    const prevRaw = readJsonSafe(path.join(outDir, prevSnap.file));
    if (prevRaw && JSON.stringify(stripMeta(prevRaw)) === JSON.stringify(stripMeta(full))) {
      console.log(`[skip] ${snapFile} (no changes since snapshot ${prevSnap.date})`);
      return { snapshots: manifest.snapshots };
    }
  }

  manifest.snapshots = (manifest.snapshots || []).filter((e) => e.date !== entry.date);
  manifest.snapshots.push(entry);
  manifest.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  manifest.updated = full.generatedAt;
  writeJsonIfChanged(snapFile, full);
  writeJsonIfChanged(manifestPath, manifest);
  return { snapshots: manifest.snapshots };
}

// Recent change events for the page's "Recent changes" timeline: the newest snapshots
// that actually carried changes, newest first. Daily snapshots are sparse, so this
// surfaces a critical event (a removed model, a price jump) even when the visitor was
// not around the day it happened — it stays until newer changes push it out.
function loadRecentChanges(outDir, snapshots, limit = 5) {
  const events = [];
  for (let i = snapshots.length - 1; i >= 0 && events.length < limit; i--) {
    const s = snapshots[i];
    if (!s.changes) continue; // manifest tracks the change count per snapshot
    const doc = readJsonSafe(path.join(outDir, s.file));
    const items = doc?.changes?.items;
    if (!items || !items.length) continue;
    events.push({ date: s.date, vs: doc.changes.vs || null, items });
  }
  return events;
}

export {
  SESSION,
  POOL,
  sessionPrice,
  milliPercents,
  sanityCheck,
  buildReport,
  round,
  reportToJson,
  loadPrevSnapshot,
  detectChanges,
  writeSnapshot,
  loadRecentChanges,
};