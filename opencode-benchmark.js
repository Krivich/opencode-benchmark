// opencode-benchmark.js
// Thin aggregator (the "smart controller"): wires the standalone parsers and the shared
// pipeline into one run.
//
//   1. Price controller (lib/price/opencode.js) parses the OpenCode Go tariffs
//      → normalized JSON dropped to docs/tariffs/opencode-go.json.
//   2. Benchmark controller (lib/bench/timetoact.js) snapshots the WHOLE history of
//      monthly TIMETOACT issues → docs/benchmarks/timetoact/<month>-<year>.json,
//      refreshing the newest issue every run and backfilling the rest on first run.
//   3. The aggregator builds the effective pool (newest measurement wins per model
//      name), joins tariffs, computes session costs, stores a daily snapshot
//      (docs/history/) and renders the page + report.json from the ready data.
//
// Usage:
//   npm start                        # direct
//   SOCKS=socks5h://127.0.0.1:1080 npm start   # via SOCKS proxy
//   PAGES=1 npm start                # write only docs/ (CI, no root index.html)
//
// Deps: npm i cheerio (+ socks-proxy-agent ONLY if you use SOCKS)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from './lib/core/fetch.js';
import { buildBenchPool } from './lib/core/match.js';
import {
  sanityCheck, buildReport, reportToJson, detectChanges, writeSnapshot, loadPrevSnapshot, loadRecentChanges,
} from './lib/core/pipeline.js';
import {
  renderHtml, renderReadmeAuto, reportSchema, OG_IMAGE,
} from './lib/core/render.js';
import {
  GO_URL, parseGo, attachPeak, fetchModelIds, attachModelIds, readPrevModelIds, buildTariffDataset,
} from './lib/price/opencode.js';
import { ensureBenchCache, BENCH_INDEX_URL } from './lib/bench/timetoact.js';
import {
  writeJsonIfChanged, writeTextIfChanged, readJsonSafe, jsonEqualsDisk,
} from './lib/core/write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'docs');
const BENCH_DIR = path.join(OUT_DIR, 'benchmarks');
const TARIFF_DIR = path.join(OUT_DIR, 'tariffs');
const PAGES = process.env.PAGES === '1';

const BENCH_SERIES = 'timetoact';
const BENCH_SERIES_TITLE = 'TIMETOACT GROUP — LLM Benchmark';

async function main() {
  // 1. Fresh tariffs.
  const [goHtml] = await Promise.all([fetchText(GO_URL)]);
  const { goRows, notes } = parseGo(goHtml);
  attachPeak(goRows, notes);
  // Enrich each tariff with the provider's authoritative model id (exact match only).
  // On an endpoint outage, keep the ids from the last published dataset instead of
  // downgrading every row to null.
  let idSet = new Set();
  try {
    idSet = await fetchModelIds();
  } catch (e) {
    console.error(`[parse] model id endpoint unavailable (${e.message}); keeping last published ids`);
  }
  attachModelIds(goRows, idSet, readPrevModelIds(path.join(TARIFF_DIR, 'opencode-go.json')));

  // 2. Benchmark history (fetches the index + the newest issue, reuses cached old ones).
  const seriesDir = path.join(BENCH_DIR, BENCH_SERIES);
  const { issues, latest } = await ensureBenchCache(seriesDir, { fetch: fetchText });
  console.error(`[bench] using latest benchmark: ${latest.slug} (${latest.rows.length} rows, ${issues.length} issues total)`);

  // Make sure the fresh pages really contain tables, not a captcha/garbage.
  sanityCheck(goRows, latest.rows);

  const withPeak = goRows.filter((r) => r.peak).length;
  console.error(`[parse] Go: ${goRows.length} models, Benchmark (latest): ${latest.rows.length} rows, Peak/Off-Peak: ${withPeak}`);

  // 3. Effective pool → join → report.
  const pool = buildBenchPool(issues);
  const report = buildReport(goRows, pool, latest.slug);

  // 4. Serialize the report (this IS the page's data), diff vs yesterday, snapshot.
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const tariffDs = buildTariffDataset(goRows);
  const sources = {
    pricing: {
      title: tariffDs.source.title,
      url: tariffDs.source.url,
      publisher: tariffDs.source.publisher,
    },
    benchmark: {
      title: BENCH_SERIES_TITLE,
      url: latest.url,
      indexUrl: latest.indexUrl,
      publisher: 'TIMETOACT GROUP',
      copyright: 'Copyright © TIMETOACT GROUP. All benchmark rights belong to their owners.',
      series: BENCH_SERIES,
      issue: latest.slug,
      issues: issues.length,
    },
  };
  const json = reportToJson(report, sources, siteUrl);
  const prevSnap = loadPrevSnapshot(OUT_DIR);
  const changes = detectChanges(json, prevSnap ? prevSnap.prev : null);
  const full = { ...json, changes };

  // Idempotency: when the report carries exactly the same data as the one already on
  // disk, keep the old generatedAt ("last real change"), so the page, README, the
  // daily snapshot and CI stay stable — only a genuine change triggers new timestamps.
  const jsonFile = path.join(OUT_DIR, 'report.json');
  const cachedReport = readJsonSafe(jsonFile);
  if (cachedReport && jsonEqualsDisk(jsonFile, full)) {
    full.generatedAt = cachedReport.generatedAt || full.generatedAt;
  }

  const { snapshots } = writeSnapshot(OUT_DIR, full, changes.items.length);
  const recentChanges = loadRecentChanges(OUT_DIR, snapshots, 5);

  // 5. Render the page from the ready data (also serves as the offline renderer).
  const html = renderHtml(full, { history: snapshots, recentChanges });

  writeTextIfChanged(path.join(OUT_DIR, 'index.html'), html);
  writeTextIfChanged(path.join(OUT_DIR, 'og-image.svg'), OG_IMAGE);
  writeJsonIfChanged(jsonFile, full);
  writeJsonIfChanged(path.join(OUT_DIR, 'report.schema.json'), reportSchema(siteUrl));

  // 6. Published datasets (for everyone, not just the page):  normalized tariffs,
  // benchmark issue history and both manifests.
  writeJsonIfChanged(path.join(TARIFF_DIR, 'opencode-go.json'), tariffDs);
  writeJsonIfChanged(path.join(TARIFF_DIR, 'index.json'), {
    updated: tariffDs.generatedAt,
    tariffs: [
      {
        provider: tariffDs.source.provider,
        title: tariffDs.source.title,
        file: 'tariffs/opencode-go.json',
        url: tariffDs.source.url,
        rows: tariffDs.tariffs.length,
      },
    ],
  });

  writeJsonIfChanged(path.join(seriesDir, 'index.json'), {
    series: BENCH_SERIES,
    name: BENCH_SERIES_TITLE,
    indexUrl: BENCH_INDEX_URL,
    updated: new Date().toISOString(),
    issues: [...issues].reverse().map((it) => ({
      issue: it.slug,
      file: `benchmarks/${BENCH_SERIES}/${it.slug}.json`,
      url: it.url,
      rows: it.rows.length,
      generatedAt: it.generatedAt,
    })),
  });

  writeJsonIfChanged(path.join(BENCH_DIR, 'index.json'), {
    updated: new Date().toISOString(),
    series: [
      {
        series: BENCH_SERIES,
        name: BENCH_SERIES_TITLE,
        indexUrl: BENCH_INDEX_URL,
        issues: issues.length,
        index: `benchmarks/${BENCH_SERIES}/index.json`,
      },
    ],
  });

  // 7. Patch the README auto-section (between the markers; manual text untouched).
  const readmePath = path.join(__dirname, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const startMark = '<!-- AUTO-DATA -->';
    const endMark = '<!-- /AUTO-DATA -->';
    const start = readme.indexOf(startMark);
    const end = readme.indexOf(endMark);
    if (start !== -1 && end !== -1 && end > start) {
      const patched = readme.slice(0, start + startMark.length) + '\n\n' + renderReadmeAuto(full, changes) + '\n\n' + readme.slice(end);
      writeTextIfChanged(readmePath, patched);
    } else {
      console.error('[skip] README.md: AUTO-DATA markers not found — manual part not patched.');
    }
  }

  // In a manual run (without PAGES=1) mirror to the repo root for local viewing.
  if (!PAGES) {
    writeTextIfChanged(path.join(__dirname, 'index.html'), html);
  }

  console.log(PAGES
    ? '[pages] docs/index.html is ready — commit and push to GitHub, Pages will serve it from /docs.'
    : '[pages] tip: with PAGES=1 output is written only to docs/ (for CI).');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});