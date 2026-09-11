// lib/price/opencode.js
// OpenCode Go tariff parser — a standalone controller in the "smart controller"
// sense: it turns the raw pricing HTML into a normalized JSON dataset and drops it
// into docs/tariffs/ so everyone can reuse it (the site links to it).
//
// Library interface:  parseGo(html) → {goRows, notes}, attachPeak(goRows, notes),
//                     buildTariffDataset(goRows) → {source, session, tariffs}
// CLI interface:      node lib/price/opencode.js        → fetches GO_URL and writes
//                     docs/tariffs/opencode-go.json (+ index manifest) with --dir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cheerioLoad, extractTableFragments, fetchText } from '../core/fetch.js';
import { normalize } from '../core/match.js';
import { SESSION, POOL } from '../core/pipeline.js';
import { writeJsonIfChanged } from '../core/write.js';

const GO_URL = 'https://opencode.ai/docs/en/go';
// Authoritative machine-readable model ids for this provider (no auth, plain JSON).
// The pricing page only shows human names, so we cross-reference them against this
// list instead of guessing a slug ourselves (see attachModelIds).
const MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
// Provider namespace used in OpenCode's `provider/model-id` references.
const PROVIDER_ID = 'opencode-go';
// The model-id lookup is optional enrichment: cap it so a stalled endpoint can never
// hang the whole pipeline (the tariff page is fetched separately by the caller).
const MODELS_TIMEOUT_MS = 15_000;

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Price table: Model | Input | Output | Cached Read | Cached Write | Usage
function parseGoTable(html) {
  const rows = [];

  for (const frag of extractTableFragments(html)) {
    const $ = cheerioLoad(frag);
    let found = false;

    // Find a table whose first row contains "Model", "Input" and "Cached Read"
    $('table').each((_, table) => {
      const headerCells = $(table).find('thead th, tr:first-child th').map((__, th) => $(th).text().trim()).get();
      const headerText = headerCells.join('|').toLowerCase();
      if (!headerText.includes('model') || !headerText.includes('input') || !headerText.includes('cached read')) return;

      $(table).find('tbody tr, tr').slice(1).each((__, tr) => {
        const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
        if (cells.length < 6) return;
        const [model, input, output, cacheRead, cacheWrite, usage] = cells;
        if (!model || model.toLowerCase().includes('model')) return;

        const parse = (s) => {
          const cleaned = s.replace(/[$\s,]/g, '').replace(/^-$/, '0');
          const n = parseFloat(cleaned);
          return isNaN(n) ? 0 : n;
        };

        rows.push({
          model,
          inputPerM: parse(input),
          outputPerM: parse(output),
          cacheReadPerM: parse(cacheRead),
          cacheWritePerM: parse(cacheWrite),
          usage, // quota in $ (raw string)
          provider: PROVIDER_ID, // factual namespace, never guessed
          modelId: null, // filled by attachModelIds once the official id list is known
        });
      });
      found = true;
    });

    if (found) break;
  }

  // Parse usage as a number (the table may show "$30")
  for (const r of rows) {
    r.usage = parseFloat(String(r.usage).replace(/[$\s,]/g, '')) || 0;
  }

  return rows;
}

// ──────────────────────────────────────────────
// Peak/Off-Peak hours notes
// ──────────────────────────────────────────────
// OpenCode Go states weekday-specific peak hours for some providers right under the
// tariff table, e.g. DeepSeek:
//   <p><strong>DeepSeek V4.1 Flash / V4 Pro / V4 Flash / V4 Flash Vision Exp:</strong>
//   Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; ... Off-Peak.</p>
// We extract the model list (the <strong>), the UTC hour windows and the optional
// weekday range, then attach the note to every tariff row that names one of those models.
const PEAK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parsePeakNotes(html) {
  const notes = [];
  const $ = cheerioLoad(html);

  $('p').each((_, el) => {
    const $p = $(el);
    const text = $p.text().replace(/\s+/g, ' ').trim();
    if (!/peak/i.test(text) || !/off\s?[- ]?\s?peak/i.test(text)) return;

    const $strong = $p.find('strong').first();
    if (!$strong.length) return;
    const names = $strong.text().split('/').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;

    const ranges = [];
    for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)) {
      ranges.push([+m[1], +m[2], +m[3], +m[4]]);
    }
    if (!ranges.length) return;

    let days = null;
    const dm = new RegExp(
      '\\b(' + PEAK_DAYS.join('|') + ')\\b[^.;]*?\\b(?:through|to)\\s+(' + PEAK_DAYS.join('|') + ')\\b', 'i'
    ).exec(text);
    if (dm) days = [PEAK_DAYS.indexOf(dm[1].toLowerCase()), PEAK_DAYS.indexOf(dm[2].toLowerCase())];

    notes.push({ names, days, ranges, tz: 'UTC' });
  });

  return notes;
}

function escRegEx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function peakForRow(model, notes) {
  const mk = normalize(model);
  if (!mk || !notes.length) return null;
  for (const note of notes) {
    for (const name of note.names) {
      const nk = normalize(name);
      if (!nk) continue;
      if (new RegExp('(^|\\s)' + escRegEx(nk) + '(\\s|$)').test(mk)) return note;
    }
  }
  return null;
}

// Single entry point for the raw pricing page: parse the Go table and collect the
// peak-hour notes into one dependency-free result.
function parseGo(html) {
  return { goRows: parseGoTable(html), notes: parsePeakNotes(html) };
}

// Attach the matching Peak/Off-Peak note (or null) to each tariff row.
function attachPeak(goRows, notes) {
  for (const r of goRows) r.peak = peakForRow(r.model, notes);
  return goRows;
}

// ──────────────────────────────────────────────
// Official model ids (truth, not guessing)
// ──────────────────────────────────────────────
// The provider exposes its real model ids at MODELS_URL. A tariff display name is
// turned into a lookup key by dropping parenthetical service notes ("(Off-Peak)",
// "(≤ 256K tokens)"), lowercasing and separating tokens with "-" (dots in versions
// are kept). The key is accepted ONLY if it exactly equals one of the official ids;
// otherwise the row keeps modelId = null and consumers do their own matching against
// their live catalog. We never fabricate an id here.
function modelKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// Reject a promise after `ms` so optional network work cannot block a run forever.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Fetch the provider's authoritative id list. Throws when the endpoint is unavailable
// or returns no models, so callers can tell "outage" (keep last good ids) from a real
// list where an unknown name honestly stays null.
async function fetchModelIds(fetchTextFn = fetchText, timeoutMs = MODELS_TIMEOUT_MS) {
  const text = await withTimeout(fetchTextFn(MODELS_URL), timeoutMs, 'model id endpoint');
  const data = JSON.parse(text);
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m && m.id).filter(Boolean) : [];
  if (!ids.length) throw new Error('model id endpoint returned no models');
  return new Set(ids);
}

// Resolve each row's modelId against the official id set. A resolved-but-unknown name
// is honestly null (never guessed). When the endpoint was unavailable (empty/absent
// set) the last published id per tariff name is carried forward instead of wiping the
// whole dataset to null on a transient outage.
function attachModelIds(goRows, idSet, prevModelIds = null) {
  const haveIds = idSet instanceof Set && idSet.size > 0;
  for (const r of goRows) {
    if (haveIds) {
      const key = modelKey(r.model);
      r.modelId = idSet.has(key) ? key : null;
    } else {
      r.modelId = prevModelIds?.get?.(r.model) ?? null;
    }
  }
  return goRows;
}

// Last published tariff ids keyed by display name (fallback source on API outage).
function readPrevModelIds(file) {
  try {
    const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = new Map();
    for (const t of ds.tariffs || []) if (t.model) map.set(t.model, t.modelId ?? null);
    return map;
  } catch {
    return new Map();
  }
}

// Normalized, shareable dataset: everything about this provider's tariffs, in a
// provider-agnostic shape (per-million-token rates + quota + optional peak windows).
function buildTariffDataset(goRows) {
  const session = {
    inputTokens: SESSION.input,
    cacheReadTokens: SESSION.cacheRead,
    outputTokens: SESSION.output,
    monthlyPoolUsd: POOL,
  };
  return {
    source: {
      provider: PROVIDER_ID,
      title: 'OpenCode Go tariff prices and quotas',
      url: GO_URL,
      publisher: 'OpenCode',
    },
    session,
    generatedAt: new Date().toISOString(),
    tariffs: goRows.map((r) => ({
      model: r.model,
      provider: r.provider ?? PROVIDER_ID,
      modelId: r.modelId ?? null,
      inputPerM: r.inputPerM,
      outputPerM: r.outputPerM,
      cacheReadPerM: r.cacheReadPerM,
      cacheWritePerM: r.cacheWritePerM,
      quotaUsd: r.usage,
      peakHours: r.peak
        ? { tz: r.peak.tz, days: r.peak.days, ranges: r.peak.ranges }
        : null,
    })),
  };
}

// ──────────────────────────────────────────────
// CLI: refresh the published JSON without touching the rest of the pipeline.
//   node lib/price/opencode.js [--dir docs] [--stdout]
// ──────────────────────────────────────────────
async function mainCli() {
  const args = process.argv.slice(2);
  const dir = args.includes('--stdout') ? null : (args[args.indexOf('--dir') + 1] || path.join('docs', 'tariffs'));
  const toStdout = args.includes('--stdout');

  const html = await fetchText(GO_URL);
  const { goRows, notes } = parseGo(html);
  attachPeak(goRows, notes);
  if (goRows.length < 10) throw new Error(`Go table looks wrong: only ${goRows.length} models. Aborting.`);
  let idSet = new Set();
  try {
    idSet = await fetchModelIds();
  } catch (e) {
    console.error(`[price] model id endpoint unavailable (${e.message}); keeping last published ids`);
  }
  const prevModelIds = dir ? readPrevModelIds(path.join(dir, 'opencode-go.json')) : null;
  attachModelIds(goRows, idSet, prevModelIds);
  const dataset = buildTariffDataset(goRows);

  if (toStdout) {
    process.stdout.write(JSON.stringify(dataset, null, 2) + '\n');
    return;
  }

  writeJsonIfChanged(path.join(dir, 'opencode-go.json'), dataset);

  // Manifest so consumers can discover every published tariff dataset.
  const manifestPath = path.join(dir, 'index.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = { updated: null, tariffs: [] };
  }
  manifest.updated = dataset.generatedAt;
  manifest.tariffs = [
    {
      provider: dataset.source.provider,
      title: dataset.source.title,
      file: 'tariffs/opencode-go.json',
      url: dataset.source.url,
      rows: dataset.tariffs.length,
    },
  ];
  writeJsonIfChanged(manifestPath, manifest);
  console.log(`[parse] OpenCode Go: ${goRows.length} tariffs, Peak/Off-Peak: ${goRows.filter(r => r.peak).length}, modelId resolved: ${goRows.filter(r => r.modelId).length}`);
}

if (IS_CLI) {
  mainCli().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export { GO_URL, MODELS_URL, PROVIDER_ID, MODELS_TIMEOUT_MS, parseGoTable, parsePeakNotes, peakForRow, parseGo, attachPeak, modelKey, fetchModelIds, attachModelIds, readPrevModelIds, buildTariffDataset };