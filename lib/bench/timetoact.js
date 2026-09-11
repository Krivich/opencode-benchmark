// lib/bench/timetoact.js
// TIMETOACT LLM Benchmark parser — a standalone controller: it discovers ALL monthly
// issues from the index page, parses every one into a normalized JSON and caches them
// under docs/benchmarks/timetoact/<month>-<year>.json. Caching the whole history is
// what lets the aggregator backfill models that the newest issue no longer measures
// (e.g. "MiMo V2.5" without "Pro" — it exists in older issues).
//
// Library interface:  findBenchIssues(indexHtml) → [{url, info}],
//                     ensureBenchCache(dir, {fetch, minRows, all}) → {issues, latest}
//                     (issues = [{slug, url, file, rank, rows, generatedAt}])
// CLI interface:      node lib/bench/timetoact.js        → refresh docs/benchmarks/timetoact/
//                     node lib/bench/timetoact.js --all   → re-fetch every issue
//                     node lib/bench/timetoact.js --dir <path>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cheerioLoad, extractTableFragments, fetchText } from '../core/fetch.js';
import { jsonEqualsDisk, writeJsonIfChanged } from '../core/write.js';

const BENCH_INDEX_URL = 'https://www.timetoact-group.at/en/insights/llm-benchmarks';

const BENCH_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// Legacy issues the index page does not (or no longer) link — discovered by probing
// the stable URL pattern; kept here so a fresh clone back-fills them too. They are
// treated exactly like index issues (cached forever, newest-wins pooling).
const BENCH_ARCHIVES = [
  'https://www.timetoact-group.at/en/insights/llm-benchmarks/january-2024',
  'https://www.timetoact-group.at/en/insights/llm-benchmarks/february-2024',
];

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// The llm-benchmarks index page links to every monthly benchmark of the form
// /…/llm-benchmarks/<month>-<year> or /…/llm-benchmarks/llm-benchmarks-<month>-<year>.
// TIMETOACT's pattern is stable, but the code doesn't depend on a specific month —
// it will pick up october-2026 and beyond.
function parseBenchMonth(urlPath) {
  const m = /llm-benchmarks\/(?:llm-benchmarks-)?([a-z]+)-(\d{4})/i.exec(urlPath);
  if (!m) return null;
  const month = m[1].toLowerCase();
  const midx = BENCH_MONTHS.indexOf(month);
  if (midx === -1) return null;
  return { year: parseInt(m[2], 10), monthIdx: midx, rank: parseInt(m[2], 10) * 12 + midx };
}

function slugOf(info) {
  return `${BENCH_MONTHS[info.monthIdx]}-${info.year}`;
}

// Enumerate ALL monthly benchmark issues: those linked from the index page plus the
// curated legacy archives the index no longer links (not just the newest issue).
function findBenchIssues(indexHtml) {
  const seen = new Set();
  const issues = [];
  for (const m of indexHtml.matchAll(/href="(https:\/\/www\.timetoact-group\.at\/en\/insights\/llm-benchmarks\/[^"]*?([a-z]+)-(\d{4})[^"]*)"/gi)) {
    const href = m[1];
    if (href.includes('content-share')) continue; // old blog links, not the table
    if (seen.has(href)) continue;
    seen.add(href);
    const info = parseBenchMonth(href);
    if (!info) continue;
    issues.push({ url: href, info });
  }
  for (const href of BENCH_ARCHIVES) {
    if (seen.has(href)) continue;
    const info = parseBenchMonth(href);
    if (!info) continue;
    seen.add(href);
    issues.push({ url: href, info });
  }
  if (!issues.length) throw new Error('No monthly benchmark link found in index page');
  issues.sort((a, b) => a.info.rank - b.info.rank);
  return issues;
}

// Columns: Model | Code+Eng | crm | docs | integrate | marketing | reason | final | Cost | Speed
function parseBenchmarkTable(html) {
  const rows = [];

  for (const frag of extractTableFragments(html)) {
    const $ = cheerioLoad(frag);
    let found = false;

    $('table').each((_, table) => {
      const headerCells = $(table).find('thead th, tr:first-child th').map((__, th) => $(th).text().trim()).get();
      const headerText = headerCells.join('|').toLowerCase();
      if (!headerText.includes('code') || !headerText.includes('final')) return;

      $(table).find('tbody tr, tr').slice(1).each((__, tr) => {
        const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
        if (cells.length < 9) return;

        const parse = (s) => {
          const cleaned = String(s).replace(/[€$\s,]/g, '').replace(/^-$/, '0');
          const n = parseFloat(cleaned);
          return isNaN(n) ? null : n;
        };

        const model = cells[0];
        if (!model || model.includes('Model')) return;

        const score = parse(cells[7]); // final 🏆
        const cost = parse(cells[8]);  // Cost
        const speed = parse(cells[9]); // Speed

        if (score == null) return;

        rows.push({ model, score, costEuro: cost, speed: speed });
      });
      found = true;
    });

    if (found) break;
  }

  return rows;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Make sure every issue from the index has a parsed JSON copy in the cache, then return
// all of them. Rules:
//   - a cached issue is reused as-is, EXCEPT the newest one which is always re-fetched
//     (mid-month updates and mid-measurements on the canvas);
//   - `all:true` re-fetches every issue;
//   - an issue whose fresh parse looks broken (< minRows) keeps its old copy if one exists,
//     otherwise it is skipped with a warning — the newest issue still needs its rows for the
//     sanity check, so a broken newest issue falls through to the callers' fatal error.
async function ensureBenchCache(dir, opts = {}) {
  const fetchFn = opts.fetch || fetchText;
  const minRows = opts.minRows ?? 10;
  const forceAll = !!opts.all;
  const indexHtml = await fetchFn(BENCH_INDEX_URL);
  const found = findBenchIssues(indexHtml);
  const maxRank = found[found.length - 1].info.rank;

  fs.mkdirSync(dir, { recursive: true });
  const issues = [];
  for (const { url, info } of found) {
    const slug = slugOf(info);
    const file = path.join(dir, `${slug}.json`);
    const isLatest = info.rank === maxRank;
    const cached = readJsonSafe(file);

    if (cached && !isLatest && !forceAll) {
      issues.push({
        slug, url, file, rank: info.rank,
        rows: cached.rows || [], generatedAt: cached.generatedAt || null,
      });
      continue;
    }

    const html = await fetchFn(url);
    const rows = parseBenchmarkTable(html);
    if (rows.length < minRows) {
      if (cached) {
        console.error(`[bench] ${slug}: fresh parse looks off (${rows.length} rows) — keeping cached copy.`);
        issues.push({
          slug, url, file, rank: info.rank,
          rows: cached.rows || [], generatedAt: cached.generatedAt || null,
        });
      } else {
        console.error(`[bench] ${slug}: skip — parse looks broken (${rows.length} rows < ${minRows}).`);
      }
      continue;
    }

    // Idempotent cache: the newest issue is re-fetched on every run, but the JSON is
    // rewritten only when the measurements actually changed (the volatile
    // generatedAt never triggers a diff by itself).
    const source = {
      title: 'TIMETOACT GROUP — LLM Benchmark',
      url,
      indexUrl: BENCH_INDEX_URL,
      publisher: 'TIMETOACT GROUP',
      copyright: 'Copyright © TIMETOACT GROUP. All benchmark rights belong to their owners.',
    };
    const draft = { series: 'timetoact', source, issue: slug, generatedAt: null, rows };
    if (jsonEqualsDisk(file, draft)) {
      console.log(`[skip] ${file} (unchanged)`);
      issues.push({
        slug, url, file, rank: info.rank,
        rows, generatedAt: cached ? cached.generatedAt : null,
      });
      continue;
    }
    const doc = { ...draft, generatedAt: new Date().toISOString() };
    writeJsonIfChanged(file, doc);
    issues.push({ slug, url, file, rank: info.rank, rows, generatedAt: doc.generatedAt });
  }

  const latest = issues[issues.length - 1];
  return { issues, latest, indexUrl: BENCH_INDEX_URL };
}

// ──────────────────────────────────────────────
// CLI: refresh the benchmark history without touching the rest of the pipeline.
//   node lib/bench/timetoact.js [--dir docs/benchmarks/timetoact] [--all]
// ──────────────────────────────────────────────
async function mainCli() {
  const args = process.argv.slice(2);
  const dir = args[args.indexOf('--dir') + 1] || path.join('docs', 'benchmarks', 'timetoact');
  const { issues, latest } = await ensureBenchCache(dir, { all: args.includes('--all') });
  console.log(`[bench] ${issues.length} issues cached in ${path.resolve(dir)}`);
  console.log(`[bench] latest: ${latest.slug} (${latest.rows.length} rows)`);

  // Per-series manifest so consumers can list every issue without crawling the site.
  const manifest = {
    series: 'timetoact',
    name: 'TIMETOACT GROUP — LLM Benchmark',
    indexUrl: BENCH_INDEX_URL,
    updated: new Date().toISOString(),
    issues: [...issues].reverse().map((it) => ({
      issue: it.slug,
      file: `benchmarks/timetoact/${it.slug}.json`,
      url: it.url,
      rows: it.rows.length,
      generatedAt: it.generatedAt,
    })),
  };
  writeJsonIfChanged(path.join(dir, 'index.json'), manifest);
}

if (IS_CLI) {
  mainCli().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export { BENCH_INDEX_URL, BENCH_MONTHS, BENCH_ARCHIVES, parseBenchMonth, findBenchIssues, parseBenchmarkTable, ensureBenchCache };