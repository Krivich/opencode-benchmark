// lib/price/opencode.js
// OpenCode Go pricing controller.
//
// Source of truth: the provider's own documented model list
// (https://opencode.ai/inference/go/v1/models — the same endpoint OpenCode itself
// consumes). It carries per-1M-token rates, cache rates, context tiers
// (`cost.text.input.overrides`), time-of-day multipliers, and each model's monthly
// usage limit per plan (`go.monthly_usage`).
//
// This used to scrape the docs page's HTML table. That table is gone: the docs page now
// sends readers to the model list API for "Go's monthly usage limits", and the table
// itself moved into the console UI. Scraping also broke on every docs reshuffle
// (/docs/en/go → /v2/docs/console/go → /docs/console/go), so the API is both the
// documented and the stable source.
//
// Library interface:  fetchGoRows() → tariff rows, parseGoModels(payload) → rows,
//                     buildTariffDataset(rows) → published JSON
// CLI interface:      node lib/price/opencode.js [--dir docs/tariffs] [--stdout]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from '../core/fetch.js';
import { writeJsonIfChanged } from '../core/write.js';
import { DEFAULT_PROFILE, contextTokensPerTurn, POOL } from '../core/pipeline.js';

const GO_API_URL = 'https://opencode.ai/inference/go/v1/models';
// Human-readable counterpart, published as the dataset's source link.
const GO_DOCS_URL = 'https://opencode.ai/docs/console/go/';
const PROVIDER_ID = 'opencode-go';
const MODELS_TIMEOUT_MS = 15000;

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Rates are dollars per 1M tokens; keep the provider's precision (0.003625) but never
// emit float noise like 0.30000000000000004 after a multiplier.
const price = (v, factor = 1) => +(Number(v || 0) * factor).toFixed(6);

// `cost.text.input.cache.write` is either a plain rate or a map of cache TTL → rate
// (e.g. { "30m": 0.125, "12h": 0.25 }). The published table has one number, so take the
// shortest TTL — the rate for the default cache lifetime.
const TTL_MINUTES = { '5m': 5, '30m': 30, '1h': 60, '12h': 720, '1d': 1440 };
const ttlMinutes = (key) => TTL_MINUTES[key] ?? (parseInt(key, 10) || Infinity);

function cacheWriteRate(write) {
  if (write == null) return 0;
  if (typeof write === 'number') return write;
  const keys = Object.keys(write);
  if (!keys.length) return 0;
  const shortest = keys.sort((a, b) => ttlMinutes(a) - ttlMinutes(b))[0];
  return Number(write[shortest]) || 0;
}

// 512000 → "512K": the page's own shorthand for a context tier boundary.
const tierLabel = (tokens) => `${Math.round(tokens / 1000)}K`;

// ──────────────────────────────────────────────
// cost.multipliers: raise the price when their condition matches.
//   • weekly window (utc_days + utc_hours)  → the Peak/Off-Peak tariff pair
//   • date window (date.gte/lte)            → a scheduled price change
// ──────────────────────────────────────────────
const UTC_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function peakWindowOf(when) {
  const days = (when?.utc_days?.in || []).map((d) => UTC_DAYS.indexOf(d)).filter((i) => i >= 0);
  if (!days.length || !Array.isArray(when.any)) return null;

  // A branch is the conjunction "from ≤ hour < to" — but the API puts the two bounds in
  // SEPARATE conditions of `all`, so both are collected across the branch, not per item.
  const ranges = [];
  for (const branch of when.any) {
    const hours = (branch.all || []).map((c) => c.utc_hours).filter(Boolean);
    const from = hours.find((h) => h.gte != null)?.gte;
    const to = hours.find((h) => h.lt != null)?.lt;
    if (from == null || to == null) continue;
    const [h1, m1] = String(from).split(':').map(Number);
    const [h2, m2] = String(to).split(':').map(Number);
    ranges.push([h1, m1, h2, m2]);
  }
  if (!ranges.length) return null;

  // The published shape is [firstDay, lastDay]; the weekday list is contiguous (Mon–Fri).
  return { tz: 'UTC', days: [Math.min(...days), Math.max(...days)], ranges };
}

// The peak multiplier is the weekly one; date-based multipliers are applied to the
// rates instead (a factor that is already in force is today's price, not a peak window).
function peakFactorOf(multipliers) {
  for (const m of multipliers || []) {
    const window = peakWindowOf(m.when);
    if (window) return { window, factor: Number(m.factor) || 1 };
  }
  return null;
}

function activeDateFactor(multipliers, now) {
  let factor = 1;
  for (const m of multipliers || []) {
    const window = m.when?.date;
    if (!window) continue;
    if (window.gte && now < new Date(window.gte)) continue;
    if (window.lte && now > new Date(window.lte)) continue;
    factor *= Number(m.factor) || 1;
  }
  return factor;
}

// ──────────────────────────────────────────────
// API payload → tariff rows
// ──────────────────────────────────────────────
// One row per price point the page compares: the base tariff, an optional
// "> N tokens" context tier, and — for models whose price depends on the hour — the
// (Off-Peak) / (Peak) pair, so the two windows stay comparable side by side.
function parseGoModels(payload, now = new Date()) {
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((m) => m && m.type === 'chat' && m.cost?.text);
  const rows = [];

  for (const m of models) {
    const text = m.cost.text;
    const multipliers = m.cost.multipliers || [];
    const dateFactor = activeDateFactor(multipliers, now);
    const peak = peakFactorOf(multipliers);
    const name = m.name || m.id;
    // Free models carry no monthly limit (`go: null`); they price at 0 and rank nowhere.
    const usage = Number(m.go?.monthly_usage?.go ?? 0) || 0;

    const ratesOf = (input, output, factor) => ({
      inputPerM: price(input?.price, factor),
      outputPerM: price(output?.price, factor),
      cacheReadPerM: price(input?.cache?.read, factor),
      cacheWritePerM: price(cacheWriteRate(input?.cache?.write), factor),
    });

    // Context tiers: the model's own prices apply up to the boundary, the override's
    // prices above it. Both rows are published so the jump is visible, not hidden.
    const tiers = (text.input?.overrides || [])
      .filter((o) => o?.when?.context?.gt != null)
      .map((o) => {
        const outputOverride = (text.output?.overrides || [])
          .find((oo) => oo?.when?.context?.gt === o.when.context.gt);
        return { limit: o.when.context.gt, input: o, output: outputOverride || text.output };
      });

    const pricePoints = tiers.length
      ? [
        { suffix: ` (≤ ${tierLabel(tiers[0].limit)} tokens)`, rates: ratesOf(text.input, text.output, dateFactor) },
        ...tiers.map((t) => ({
          suffix: ` (> ${tierLabel(t.limit)} tokens)`,
          rates: ratesOf(t.input, t.output, dateFactor),
        })),
      ]
      : [{ suffix: '', rates: ratesOf(text.input, text.output, dateFactor) }];

    for (const point of pricePoints) {
      if (!peak) {
        rows.push(row(name + point.suffix, point.rates, usage, m.id, null));
        continue;
      }
      // The API price is the outside-peak price; the multiplier is the peak surcharge.
      rows.push(row(`${name}${point.suffix} (Off-Peak)`, point.rates, usage, m.id, peak.window));
      const peakRates = {
        inputPerM: price(point.rates.inputPerM, peak.factor),
        outputPerM: price(point.rates.outputPerM, peak.factor),
        cacheReadPerM: price(point.rates.cacheReadPerM, peak.factor),
        cacheWritePerM: price(point.rates.cacheWritePerM, peak.factor),
      };
      rows.push(row(`${name}${point.suffix} (Peak)`, peakRates, usage, m.id, peak.window));
    }
  }

  return rows;
}

function row(model, rates, usage, modelId, peak) {
  return {
    model,
    provider: PROVIDER_ID,
    modelId: modelId || null, // the provider's own id — never derived from the display name
    ...rates,
    usage, // monthly usage limit in $ on the Go plan
    peak,
  };
}

// Reject a promise after `ms` so network work cannot block a run forever.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function fetchGoRows(fetchTextFn = fetchText, timeoutMs = MODELS_TIMEOUT_MS) {
  const text = await withTimeout(fetchTextFn(GO_API_URL), timeoutMs, 'Go model list');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Go model list is not JSON — the endpoint answered with something else');
  }
  const rows = parseGoModels(payload);
  if (!rows.length) throw new Error('Go model list returned no priced chat models');
  return rows;
}

// Normalized, shareable dataset: everything about this provider's tariffs, in a
// provider-agnostic shape (per-million-token rates + quota + optional peak windows).
function buildTariffDataset(goRows) {
  const session = {
    profile: DEFAULT_PROFILE.name,
    turns: DEFAULT_PROFILE.turns,
    perTurn: {
      inputTokens: DEFAULT_PROFILE.perTurn.input,
      cacheReadTokens: DEFAULT_PROFILE.perTurn.cacheRead,
      cacheWriteTokens: DEFAULT_PROFILE.perTurn.cacheWrite,
      outputTokens: DEFAULT_PROFILE.perTurn.output,
    },
    contextTokensPerTurn: contextTokensPerTurn(DEFAULT_PROFILE),
    monthlyPoolUsd: POOL,
  };
  return {
    source: {
      provider: PROVIDER_ID,
      title: 'OpenCode Go tariff prices and quotas',
      url: GO_DOCS_URL,
      api: GO_API_URL,
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
//   node lib/price/opencode.js [--dir docs/tariffs] [--stdout]
// ──────────────────────────────────────────────
async function mainCli() {
  const args = process.argv.slice(2);
  const dir = args.includes('--stdout') ? null : (args[args.indexOf('--dir') + 1] || path.join('docs', 'tariffs'));
  const toStdout = args.includes('--stdout');

  const goRows = await fetchGoRows();
  if (goRows.length < 10) throw new Error(`Go tariffs look wrong: only ${goRows.length} rows. Aborting.`);
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
  console.log(`[parse] OpenCode Go: ${goRows.length} tariffs, Peak/Off-Peak: ${goRows.filter((r) => r.peak).length}, modelId resolved: ${goRows.filter((r) => r.modelId).length}`);
}

if (IS_CLI) {
  mainCli().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export { GO_API_URL, GO_DOCS_URL, PROVIDER_ID, MODELS_TIMEOUT_MS, parseGoModels, fetchGoRows, buildTariffDataset };
