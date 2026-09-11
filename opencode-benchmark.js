// opencode-benchmark.js
// Downloads OpenCode Go price tables and the TIMETOACT benchmark,
// joins by model name, computes the price of a typical session in $ and mp of quota,
// and generates index.html (documentation for GitHub Pages).
//
// Usage:
//   npm start                       # direct
//   SOCKS=socks5h://127.0.0.1:1080 npm start   # via SOCKS proxy
//
// Deps:   npm i cheerio  (+ socks-proxy-agent ONLY if you use SOCKS)
//
// Proxy is optional — enabled by env SOCKS. Whether to write into /docs (Pages) is controlled
// by env PAGES=1.
//
// Typical session (from your logs): 155K context, 95% cache, ~300 output
//   input      =  5% × 155_000 =   7_750
//   cache_read = 95% × 155_000 = 147_250
//   output     =              =     300

import { load as cheerioLoad } from 'cheerio';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = {
  input: 7_750,
  cacheRead: 147_250,
  output: 300,
};

const GO_URL = 'https://opencode.ai/docs/en/go';

// Index page listing all monthly benchmarks. Auto-detects the newest one
// (by year+month in the URL) so no specific month has to be hardcoded.
const BENCH_INDEX_URL = 'https://www.timetoact-group.at/en/insights/llm-benchmarks';

const BENCH_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

const SOCKS = process.env.SOCKS;
const PAGES = process.env.PAGES === '1';

// Project root (folder with the script)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'docs');
const HISTORY_DIR = path.join(OUT_DIR, 'history');

// ──────────────────────────────────────────────
// 1. Fetch
// ──────────────────────────────────────────────
// Browser-like headers so Cloudflare/Varnish on the benchmark site lets us through
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function socksAgent() {
  // Load socks-proxy-agent lazily: it is only needed when SOCKS is enabled,
  // so the script works even if the package isn't installed.
  // Every call creates its OWN agent — parallel fetches must not share a single
  // connection, and the agent is destroyed after the request (see fetchViaProxy).
  const m = await import('socks-proxy-agent');
  return new m.SocksProxyAgent(SOCKS);
}

async function fetchViaProxy(url) {
  const agent = await socksAgent();
  const { href } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.get(href, { agent, headers: HTTP_HEADERS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        agent.destroy();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchViaProxy(new URL(res.headers.location, url).href));
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${res.statusMessage} fetching ${url}`));
        const buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        let out = buf;
        if (enc === 'br') out = zlib.brotliDecompressSync(buf);
        else if (enc === 'gzip') out = zlib.gunzipSync(buf);
        else if (enc === 'deflate') out = zlib.inflateSync(buf);
        resolve(out.toString('utf8'));
      });
    });
    req.on('error', (e) => { agent.destroy(); reject(e); });
  });
}

async function fetchText(url) {
  if (SOCKS) {
    try {
      return await fetchViaProxy(url);
    } catch (e) {
      if (e?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('SOCKS is set, but the socks-proxy-agent package is not installed. Run: npm i socks-proxy-agent');
      }
      throw e;
    }
  }

  const res = await fetch(url, { headers: HTTP_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  return res.text();
}

// ──────────────────────────────────────────────
// 1b. Finding the newest benchmark page
// ──────────────────────────────────────────────
// The llm-benchmarks index page links to every monthly benchmark of the form
// /…/llm-benchmarks/<month>-<year> or /…/llm-benchmarks/llm-benchmarks-<month>-<year>.
// Pick the newest by (year, month). TIMETOACT's pattern is stable, but the code
// doesn't depend on a specific month — it will pick up october-2026 and beyond.
function parseBenchMonth(urlPath) {
  const m = /llm-benchmarks\/(?:llm-benchmarks-)?([a-z]+)-(\d{4})/i.exec(urlPath);
  if (!m) return null;
  const month = m[1].toLowerCase();
  const midx = BENCH_MONTHS.indexOf(month);
  if (midx === -1) return null;
  return { year: parseInt(m[2], 10), monthIdx: midx, rank: parseInt(m[2], 10) * 12 + midx };
}

function findLatestBenchUrl(indexHtml) {
  const seen = new Set();
  let best = null;
  for (const m of indexHtml.matchAll(/href="(https:\/\/www\.timetoact-group\.at\/en\/insights\/llm-benchmarks\/[^"]*?([a-z]+)-(\d{4})[^"]*)"/gi)) {
    const href = m[1];
    if (href.includes('content-share')) continue; // old blog links, not the table
    if (seen.has(href)) continue;
    seen.add(href);
    const info = parseBenchMonth(href);
    if (!info) continue;
    if (!best || info.rank > best.info.rank) best = { url: href, info };
  }
  if (!best) throw new Error('No monthly benchmark link found in index page');
  return best;
}

// ──────────────────────────────────────────────
// 1c. Extracting tables from raw HTML
// ──────────────────────────────────────────────
// The benchmark site renders the table via JS and keeps the table HTML inside
// an unclosed <script> (the <table> is there as a string, but not parser-readable).
// Extract <table>…</table> fragments directly from the source and parse them separately.
function extractTableFragments(html) {
  const frags = [];
  let i = 0;
  while (true) {
    const start = html.indexOf('<table', i);
    if (start === -1) break;
    const end = html.indexOf('</table>', start);
    if (end === -1) break;
    frags.push(html.slice(start, end + '</table>'.length));
    i = end + '</table>'.length;
  }
  return frags;
}

// ──────────────────────────────────────────────
// 2. Parsing the OpenCode Go table
// ──────────────────────────────────────────────
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
// 2b. Peak/Off-Peak hours notes
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

// ──────────────────────────────────────────────
// 3. Parsing the benchmark table
// ──────────────────────────────────────────────
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

      rows.push({
        model,
        score,
        costEuro: cost,
        speed: speed,
      });
    });
    found = true;
  });

    if (found) break;
  }

  return rows;
}

// ──────────────────────────────────────────────
// 4. Name matching (fuzzy, via Levenshtein)
// ──────────────────────────────────────────────
// Careful normalization: strip ONLY unambiguous formatting noise
// (rank prefix, emoji/badges, extra whitespace, service notes in parentheses:
//  "≤ 256K tokens", "reasoning high", "Off-Peak"). Versions and variants are left alone.
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/^[\s\d.]+\.?\s?/, '')   // rank prefix "12. ", "3. " in the benchmark
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}✅⚠️⏳🦙☁️]/gu, ' ')
    .replace(/\(.*?\)/g, ' ')         // notes in parentheses: "≤ 256K tokens", "(reasoning high)", "(Off-Peak)"
    .replace(/[–—-]|&nbsp;|&lt;=|&gt;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Honest display name of the benchmark model: strip only the rank number, keep the meaning.
function benchDisplay(name) {
  return name
    .replace(/^[\s\d.]+[. ]/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Similarity 0..1 (1 = identical)
function similarity(a, b) {
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length, 1);
}

// Protected versions of the form X.Y (digits with a dot): 2.5, 3.8, 5.6, 4.6…
// Parameter sizes (27, 70, 236, 671) and build dates (0731, 0813) are NOT versions —
// they have no dot. A version is a hard model property: 2.5 is definitely not 2.6.
function dottedVersions(name) {
  return [...name.matchAll(/\d+\.\d+/g)].map(m => parseFloat(m[0]));
}

// Versions compatible? If BOTH names carry an X.Y version, they must match (at least one).
// If only one side has a version — no conflict (the other side may simply not state it).
function versionsCompatible(gv, bv) {
  if (gv.length === 0 || bv.length === 0) return true;
  return gv.some(v => bv.includes(v));
}

// Model subtype markers: "max", "pro", "flash". If a marker is in one name
// but not in the other, they are different models: Flash is not Max, Pro is not base.
const SUBTYPE_TOKENS = ['max', 'pro', 'flash', 'plus', 'lite', 'mini', 'nano',
  'ultra', 'turbo', 'vision', 'code', 'instruct', 'preview', 'thinking', 'omni'];

function subtypeTokens(name) {
  return SUBTYPE_TOKENS.filter(t => new RegExp(`(^|\\s)${t}(\\s|$)`).test(name));
}

// Subtype conflict: a marker is present in one name but missing in the other.
function subtypeConflict(goKey, benchKey) {
  const gt = subtypeTokens(goKey);
  const bt = subtypeTokens(benchKey);
  return gt.some(t => !bt.includes(t)) || bt.some(t => !gt.includes(t));
}

// Exact containment of one normalized name in the other — safety net for short
// names that Levenshtein doesn't see: "hy3" ⊂ "tencent hy3" is a real match.
function isSubstringMatch(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  return a.includes(b) || b.includes(a);
}

// Levenshtein floor: similarity below this is garbage, not a match.
const SIM_FLOOR = 0.50;

// Match a Go model name against the best benchmark candidate.
// Candidates are hard-filtered by version (X.Y) and subtype markers (max/pro/flash),
// then the maximum Levenshtein similarity wins. Above the floor — a match with a
// confidence tier; below the floor without substring rescue — an honest "not in benchmark".
function join(goRows, benchRows) {
  const joined = goRows.map(go => {
    const gk = normalize(go.model);
    const gv = dottedVersions(gk);
    let best = null;
    let bestSim = 0;

    for (const b of benchRows) {
      const bk = normalize(b.model);
      if (!versionsCompatible(gv, dottedVersions(bk))) continue;
      if (subtypeConflict(gk, bk)) continue;

      const s = similarity(gk, bk);
      if (s > bestSim) {
        bestSim = s;
        best = b;
      }
    }

    // Substring rescue: even at low similarity "hy3" → "tencent hy3" is a match.
    const rescued = best && isSubstringMatch(gk, normalize(best.model));

    let tier = 'NONE';
    if (best && (rescued || bestSim >= SIM_FLOOR)) {
      tier = rescued || bestSim >= 0.85 ? 'OK' : bestSim >= 0.55 ? 'AMBIG' : 'WEAK';
    } else if (best) {
      best = null;
      bestSim = 0;
    }

    return { go, bench: best, sim: bestSim, tier };
  });

  // Consolidation pass: if several Go models claim the same benchmark row,
  // the most confident wins; the less confident ones honestly become "not in benchmark".
  // (Duplicate rows of one tariff — Grok 4.6 ≤ / > 200K — both stay.)
  const claims = new Map();
  for (const r of joined) {
    if (!r.bench) continue;
    if (!claims.has(r.bench)) claims.set(r.bench, []);
    claims.get(r.bench).push(r);
  }
  for (const group of claims.values()) {
    group.sort((a, b) => b.sim - a.sim);
    const winner = group[0];
    if (winner.sim >= 0.85) {
      for (const r of group) {
        if (r !== winner && r.sim < winner.sim - 0.1) {
          r.bench = null;
          r.sim = 0;
          r.tier = 'NONE';
        }
      }
    }
  }

  return joined;
}

// ──────────────────────────────────────────────
// 5. Session price and mp computation
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// 6. Building the report
// ──────────────────────────────────────────────
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


const tierMark = (tier) => (tier === 'OK' ? '✓' : tier === 'AMBIG' ? '⚠' : '—');
const tierClass = (tier) => ({ OK: 'ok', AMBIG: 'ambig', WEAK: 'weak' }[tier] || 'weak');

function buildReport(goRows, benchRows) {
  const joined = join(goRows, benchRows);

  // Sort: first by score DESC, then by mp ASC
  joined.sort((a, b) => {
    const as = a.bench?.score ?? -1;
    const bs = b.bench?.score ?? -1;
    if (as !== bs) return bs - as;
    const am = a.go.usage ? sessionPrice(a.go) / a.go.usage : Infinity;
    const bm = b.go.usage ? sessionPrice(b.go) / b.go.usage : Infinity;
    return am - bm;
  });

  const rows = joined.map(({ go, bench, sim, tier }) => {
    const price = sessionPrice(go);
    const mp = milliPercents(price, go.usage);
    const multiplier = go.usage ? 60 / go.usage : null;
    const reqPerMonth = go.usage ? Math.floor(go.usage / price) : null;
    return {
      model: go.model,
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

// ──────────────────────────────────────────────
// 7. HTML rendering (index.html for GitHub Pages)
// ──────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Human-readable title from the benchmark URL: ".../september-2026" → "September 2026".
function benchTitle(benchUrl) {
  const label = benchUrl.split('/').filter(Boolean).pop() || 'recent';
  const parts = label.replace(/^llm-benchmarks-/, '').split('-');
  return parts.length === 2
    ? `${parts[0][0].toUpperCase() + parts[0].slice(1)} ${parts[1]}`
    : label;
}

function renderHtml(report, benchUrl, extras = {}) {
  const generatedAt = new Date().toISOString();
  const fmtVal = (v, digits) => (v != null ? v.toFixed(digits) : '—');

  const bTitle = benchTitle(benchUrl);
  const changes = extras.changes || { vs: null, benchmarkIssueChanged: false, items: [] };
  const historyList = extras.history || [];

  // SEO: absolute page URL (for canonical/OG/Twitter/JSON-LD). GitHub Pages
  // with a /docs source serves the folder from the site root, so /docs is NOT added to URLs.
  const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const pageUrl = SITE_URL ? `${SITE_URL}/` : 'index.html';
  const imageUrl = SITE_URL ? `${SITE_URL}/og-image.svg` : 'og-image.svg';
  const SEO_TITLE = 'Which OpenCode Go model gets you the most for your money?';
  const SEO_DESC = 'Session cost and independent benchmark score for every OpenCode Go tariff — ' +
    'quotas, multipliers and context splits decoded, side by side.';
  const openGraph = SITE_URL
    ? `<meta property="og:url" content="${pageUrl}">
  <meta property="og:image" content="${imageUrl}">
  <link rel="canonical" href="${pageUrl}">`
    : '';
  const twitterCard = `summary${SITE_URL ? '_large_image' : ''}`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${pageUrl}#website`,
        url: pageUrl,
        name: 'OpenCode Go × TIMETOACT LLM Benchmark',
        publisher: { '@type': 'Organization', name: 'opencode-benchmark' },
      },
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: SEO_TITLE,
        description: SEO_DESC,
        isPartOf: { '@id': `${pageUrl}#website` },
        dateModified: generatedAt,
        inLanguage: 'en',
        mainEntity: { '@id': `${pageUrl}#dataset` },
      },
      {
        '@type': 'Dataset',
        '@id': `${pageUrl}#dataset`,
        name: 'OpenCode Go tariff pricing vs TIMETOACT LLM benchmark scores',
        description: SEO_DESC,
        url: pageUrl,
        dateModified: generatedAt,
        creator: { '@type': 'Organization', name: 'opencode-benchmark' },
        keywords: ['OpenCode', 'OpenCode Go', 'LLM', 'benchmark', 'pricing', 'quota', 'TIMETOACT'],
      },
    ],
  });

  // Tooltips for confidence markers (instead of a text legend).
  const tierTitle = {
    OK: 'Confident match — name similarity ≥ 0.85, or exact substring (e.g. "Hy3" inside "Tencent Hy3").',
    AMBIG: 'Plausible, but the names differ — check by eye.',
    WEAK: 'Below the similarity floor or filtered out by version/subtype rules.',
  };

  // Badge icons that TIMETOACT embeds right into the model names.
  const iconTitle = {
    '☁️': 'Cloud, proprietary license',
    '🦙': 'Local, Llama 2 license',
    '✅': 'Open source, unrestricted local use',
    '⚠️': 'License not determined',
    '🔄': 'Outdated or missing results',
    '⏳': 'Benchmark results still in progress (provisional)',
  };
  const annotateIcons = (text) => {
    let out = esc(text);
    for (const [ic, tip] of Object.entries(iconTitle)) {
      out = out.split(ic).join(`<span class="ic" title="${tip}">${ic}</span>`);
    }
    return out;
  };

  const tableBody = report.rows.map((r, i) => {
    const score = fmtVal(r.score, 0);
    const mp = fmtVal(r.mp, 1);
    const mult = fmtVal(r.multiplier, 2);
    const req = r.reqPerMonth != null ? r.reqPerMonth.toLocaleString('en-US') : '—';
    const matched = r.matchedName != null
      ? `<span class="tier tier-${tierClass(r.tier)}" title="${tierTitle[r.tier]}">${tierMark(r.tier)}</span> ${annotateIcons(r.matchedName)}`
      : '<span class="muted" title="Not found in benchmark">—</span>';
    const peakBadge = r.peak
      ? `<span class="pk" data-peak='${esc(JSON.stringify({ tz: r.peak.tz, days: r.peak.days, ranges: r.peak.ranges }))}' title="Peak/Off-Peak tariff">⚡</span>`
      : '';
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="model">${annotateIcons(r.model)}${peakBadge}</td>
      <td class="num">${score}</td>
      <td class="num">$${r.price.toFixed(4)}</td>
      <td class="num"><strong>${mp}</strong></td>
      <td class="num">$${r.usage}</td>
      <td class="num">${mult}</td>
      <td class="num">${req}</td>
      <td class="match">${matched}</td>
    </tr>`;
  }).join('\n');

  const rankedBody = report.ranked.map((x, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="model">${annotateIcons(x.model)}</td>
    <td class="num">${x.score.toFixed(0)}</td>
    <td class="num">${x.mp.toFixed(1)}</td>
    <td class="num"><strong>${x.ratio.toFixed(2)}</strong></td>
  </tr>`).join('\n');

  // "What changed" — diff vs the previous daily snapshot.
  const fmtP = (v) => (v == null ? '—' : `$${(+v).toFixed(4).replace(/\.?0+$/, '')}`);
  const changeLines = changes.items.slice(0, 50).map((c) => {
    const m = esc(c.model);
    if (c.kind === 'added') return `      <li class="chg neu"><b>+ new tariff:</b> ${m}</li>`;
    if (c.kind === 'removed') return `      <li class="chg neu"><b>− removed:</b> ${m}</li>`;
    if (c.kind === 'score') {
      const cls = (c.to ?? 0) > (c.from ?? 0) ? 'good' : 'bad';
      return `      <li class="chg ${cls}"><b>score:</b> ${m} ${c.from ?? '—'} → ${c.to ?? '—'} ${(c.to ?? 0) > (c.from ?? 0) ? '▲' : '▼'}</li>`;
    }
    if (c.kind === 'price') {
      const up = (c.to ?? 0) > (c.from ?? 0);
      return `      <li class="chg ${up ? 'bad' : 'good'}"><b>price:</b> ${m} ${fmtP(c.from)} → ${fmtP(c.to)} ${up ? '▲' : '▼'}</li>`;
    }
    return `      <li class="chg neu"><b>quota:</b> ${m} $${c.from} → $${c.to}</li>`;
  }).join('\n');
  const changesBody = !changes.vs
    ? '      <li class="chg empty">First snapshot — history starts today. Next runs will show diffs here.</li>'
    : changes.items.length === 0
      ? `      <li class="chg empty">No changes vs ${esc(changes.vs)}.</li>`
      : changeLines + (changes.items.length > 50
        ? `\n      <li class="chg empty">…and ${changes.items.length - 50} more — see <a href="report.json">report.json</a></li>`
        : '');
  const changesSection = `<div class="chgcard">
  <h2>What changed <span class="tt" title="Diff against the previous daily snapshot (docs/history/).">ⓘ</span></h2>
  ${changes.benchmarkIssueChanged ? '<p class="chg-issue">New monthly benchmark issue detected — scores below come from a fresh issue.</p>' : ''}
  <ul class="chgs">
${changesBody}
  </ul>
</div>`;

  // History table — daily snapshots (newest first, last 30).
  const historySection = (() => {
    if (!historyList.length) return '';
    const shown = [...historyList].slice(-30).reverse();
    const olderNote = historyList.length > shown.length ? `Older snapshots are in the manifest. ` : '';
    const rows = shown.map((e) => `<tr>
        <td><a href="${esc(e.file)}">${esc(e.date)}</a></td>
        <td class="num">${e.models}</td>
        <td>${esc(e.best || '—')}</td>
        <td class="num">${e.changes}</td>
      </tr>`).join('\n');
    return `<h2>History</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Date</th><th class="num">Models</th><th>Best score/mp</th><th class="num">Δ changes</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <p class="sub">${olderNote}Machine-readable manifest: <a href="history/index.json">history/index.json</a></p>`;
  })();

  const MATCH_TIP = 'Matching is Levenshtein-based with strict guards: versions (2.5 ≠ 2.6) '
    + 'and subtypes (Flash ≠ Max, Pro, Plus, …) are hard filters; similarity below 0.50 counts as '
    + 'not found unless one name is an exact substring of the other ("Hy3" → "Tencent Hy3"). '
    + 'Marks: ✓ confident, ⚠ plausible but different, — not in benchmark. Verify names by eye.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23000'/%3E%3Ctext x='32' y='46' font-family='monospace,Menlo,Consolas' font-size='27' font-weight='700' fill='%23fff' text-anchor='middle'%3EGO%3F%3C/text%3E%3C/svg%3E">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SEO_TITLE}</title>
<meta name="description" content="${SEO_DESC}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#000">
<meta name="generator" content="opencode-benchmark">
<meta name="referrer" content="no-referrer">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenCode Go × TIMETOACT LLM Benchmark">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${SEO_TITLE}">
<meta property="og:description" content="${SEO_DESC}">
${openGraph}
<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${SEO_TITLE}">
<meta name="twitter:description" content="${SEO_DESC}">
${SITE_URL ? `<meta name="twitter:image" content="${imageUrl}">` : ''}
<script type="application/ld+json">${jsonLd}</script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 0; padding: 24px; line-height: 1.5; color: #222;
    background: #fafafa;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  .head { display: flex; gap: 24px; align-items: center; }
  .head .cols { flex: 1; min-width: 0; }
  .goq { font-family: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 10rem; font-weight: 700; line-height: 0.8; color: inherit;
    letter-spacing: -0.05em; user-select: none; white-space: nowrap; }
  .kicker { margin: 0 0 6px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: #888; font-weight: 600; }
  h1 { font-size: 1.7rem; margin: 0 0 2px; line-height: 1.2; }
  h1 .brand { color: #000; font-weight: 900; letter-spacing: -0.03em; font-stretch: condensed;
    white-space: nowrap; }
  .tagline { color: #555; font-size: 1.02rem; margin: 0 0 10px; }
  @media (prefers-color-scheme: dark) {
    h1 .brand { color: #fff; }
    .tagline { color: #bbb; }
  }
  .sub { color: #666; margin: 0 0 20px; font-size: 0.9rem; }
  .datalinks { font-size: 0.82rem; color: #888; margin: -12px 0 16px; }
  .datalinks a { color: #2563eb; }
  td.num strong { font-weight: 700; }
  .intro { max-width: 74ch; margin: 0 0 18px; padding-bottom: 16px; border-bottom: 1px dashed #ddd;
    color: #444; font-size: 0.94rem; }
  .intro b { color: #222; }
  @media (prefers-color-scheme: dark) {
    .intro { color: #bbb; border-color: #333; }
    .intro b { color: #fff; }
  }
  .nums { display: flex; gap: 24px; flex-wrap: wrap; margin: 12px 0 20px; padding: 14px 18px;
    background: #fff; border: 1px solid #e3e3e3; border-radius: 10px; font-size: 0.92rem; }
  .nums b { font-size: 1.1rem; }
  .mp-explain { font-size: 0.78rem; color: #666; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e3e3;
    border-radius: 10px; overflow: hidden; font-size: 0.86rem; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; text-align: left; white-space: nowrap; }
  th { background: #f3f4f6; font-weight: 600; position: sticky; top: 0; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sorted[data-dir="asc"]::after { content: " ▲"; }
  th.sorted[data-dir="desc"]::after { content: " ▼"; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover { background: #f7f9ff; }
  .model { max-width: 260px; white-space: normal; }
  .pk { display: inline-block; margin-left: 6px; padding: 0 4px; font-size: 0.72rem; line-height: 1.4;
    border-radius: 5px; cursor: help; opacity: 0.85; vertical-align: 0.08em; }
  .pk-on { background: #ffd98a; color: #5a3b00; }
  .pk-off { background: #e4e4e4; color: #666; }
  @media (prefers-color-scheme: dark) {
    .pk-on { background: #9a6b00; color: #fff2cf; }
    .pk-off { background: #3a3a3a; color: #bbb; }
  }
  .match { max-width: 320px; white-space: normal; }
  .tier { font-weight: 700; cursor: help; }
  .tier-ok { color: #0a7d32; }
  .tier-ambig { color: #b26a00; }
  .tier-weak { color: #999; }
  .muted { color: #999; cursor: help; }
  .ic { cursor: help; }
  .tt { color: #888; font-weight: 400; cursor: help; }
  .scroll { overflow-x: auto; margin: 12px 0; }
  h2 { font-size: 1.15rem; margin: 28px 0 8px; }
  .chgs { list-style: none; margin: 8px 0 4px; padding: 0; font-size: 0.9rem; }
  .chgcard { border: 1px solid #e3e3e3; border-radius: 10px; padding: 10px 14px 6px; margin: 12px 0 20px; background: #fff; }
  .chgcard h2 { margin-top: 4px; }
  .chg { padding: 4px 0; border-bottom: 1px dashed #eee; }
  .chg b { font-weight: 600; color: #444; }
  .chg.good { color: #0a7d32; }
  .chg.bad { color: #b3261e; }
  .chg.neu { color: #555; }
  .chg.empty, .chg-issue { color: #888; }
  .chg-issue { color: #b26a00; font-size: 0.9rem; }
  .periods { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; }
  .period-btn { font: inherit; font-size: 0.82rem; padding: 4px 12px; border: 1px solid #ddd; background: #fff; color: #555; border-radius: 999px; cursor: pointer; }
  .period-btn.on { border-color: #2563eb; color: #2563eb; background: #eff6ff; font-weight: 600; }
  .mup { color: #0a7d32; font-weight: 600; }
  .mdown { color: #b3261e; font-weight: 600; }
  .mnew { color: #2563eb; font-weight: 600; }
  .mgone { color: #999; }
  .mdr { color: #555; font-size: 0.85rem; }
  @media (prefers-color-scheme: dark) {
    .chg { border-color: #333; }
    .chgcard { background: #1b1b1b; border-color: #333; }
    .chg b { color: #ccc; }
    .chg.good { color: #4ade80; }
    .chg.bad { color: #f87171; }
    .chg.neu { color: #bbb; }
    .chg.empty { color: #888; }
  }
  footer { margin-top: 32px; font-size: 0.78rem; color: #666; border-top: 1px solid #ddd; padding-top: 14px; }
  footer h3 { font-size: 0.85rem; color: #444; margin: 12px 0 4px; }
  footer p { margin: 4px 0; }
  footer a { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #e6e6e6; }
    .nums, table { background: #1b1b1b; border-color: #333; }
    th { background: #262626; }
    td { border-color: #2a2a2a; }
    tr:hover { background: #22252e; }
    footer { border-color: #333; color: #999; }
    .sub { color: #aaa; }
    .mp-explain { color: #aaa; }
    .period-btn { background: #1b1b1b; border-color: #333; color: #aaa; }
    .period-btn.on { border-color: #60a5fa; color: #60a5fa; background: #1e293b; }
    .mup { color: #4ade80; }
    .mdown { color: #f87171; }
    .mnew { color: #60a5fa; }
    .mdr { color: #bbb; }
    footer h3 { color: #ccc; }
  }
  @media (max-width: 640px) {
    .head { flex-direction: column; align-items: flex-start; }
    .goq { font-size: 5rem; line-height: 0.85; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="cols">
      <p class="kicker">OpenCode Go × TIMETOACT LLM Benchmark</p>
      <h1>Which <span class="brand">OpenCode Go</span> model gets you the most for your money?</h1>
      <p class="tagline">Tariffs hide the real price behind quota multipliers and context splits. Here's what a
        typical session actually costs and how smart each model is — side by side, so you can pick.</p>
      <p class="sub">Typical session cost and the share of the monthly quota it consumes.
        Updated: <time datetime="${generatedAt}">${new Date(generatedAt).toLocaleString('en-US')}</time></p>

      <p class="datalinks">Data:
        <a href="report.json">report.json</a> — full export (<a href="report.schema.json">JSON Schema</a>) ·
        <a href="history/index.json">history/index.json</a> — daily snapshots with change diffs</p>

      <p class="intro">Picking a model on OpenCode Go means solving a billing puzzle, not an AI one.
        Tariffs come with <b>quota multipliers</b> that quietly triple the price, every session splits into
        <b>input / cache-read / output</b>, and a tariff named “Flash” can cost four times what its “Max”
        sibling does — with nothing explaining how that relates to how <em>smart</em> the model actually is.
        Good luck comparing anything by eyeballing a price list. This page pairs each tariff with an
        independent benchmark <a href="${benchUrl}" rel="noopener">score</a> and works out the honest number: what one typical session costs in
        dollars, how many <b>millipercents of your monthly pool</b> it eats, and how much intelligence you get
        per unit. No marketing, no “premium” labels — just price against measured capability.</p>
    </div>
    <div class="goq" aria-hidden="true">GO?</div>
  </div>

  <div class="nums">
    <div>Typical session<br><b>${SESSION.input.toLocaleString('en-US')} input</b></div>
    <div>Cache-read<br><b>${SESSION.cacheRead.toLocaleString('en-US')} tok.</b></div>
    <div>Output<br><b>${SESSION.output}</b></div>
    <div>Pool<br><b>$60/mo</b></div>
    <div><b>mp/session</b> = session price ÷ quota × 100 000<br><span class="mp-explain">how much of your monthly quota one typical session eats — higher means more expensive</span></div>
  </div>

  <h2>All tariffs <span class="tt" title="Every OpenCode Go tariff from the price list, priced for a typical session. Click a header to sort.">ⓘ</span></h2>
  <p class="sub" style="margin-top:-6px">⚡ = Peak/Off-Peak pricing — hover for the hours in your timezone.</p>
  <div class="scroll">
    <table class="sortable">
      <thead><tr>
        <th class="num sortable">#</th><th class="sortable">Model (Go)</th><th class="num sortable">Score</th>
        <th class="num sortable">$/session</th><th class="num sortable">mp/session</th><th class="num sortable">Quota $</th>
        <th class="num sortable">Multiplier</th><th class="num sortable">Requests/mo</th>
        <th class="match sortable">Match in benchmark <span class="tt" title="${MATCH_TIP}">ⓘ</span></th>
      </tr></thead>
      <tbody>
${tableBody}
      </tbody>
    </table>
  </div>

  <h2>Top: Score per mp <span class="tt" title="score ÷ mp — intelligence per consumed fraction of the pool; confident matches only (✓).">ⓘ</span></h2>
  <div class="scroll">
    <table class="sortable">
      <thead><tr><th class="num sortable">#</th><th class="sortable">Model</th><th class="num sortable">Score</th><th class="num sortable">mp</th><th class="num sortable">Score/mp</th></tr></thead>
      <tbody>
${rankedBody}
      </tbody>
    </table>
  </div>

  <h2>Top movers <span class="tt" title="Models that moved in the score/mp ranking over the selected period vs a prior snapshot.">ⓘ</span></h2>
  <div class="periods">
    <button class="period-btn on" data-days="1">1 day</button>
    <button class="period-btn" data-days="7">7 days</button>
    <button class="period-btn" data-days="30">30 days</button>
  </div>
  <div class="scroll">
    <table id="movers" class="sortable">
      <thead><tr>
        <th class="num">#</th><th>Model</th>
        <th class="num">Score/mp now</th><th class="num">Score/mp then</th>
        <th class="num">Δ Score/mp</th><th class="num">Δ Rank</th><th>Driver</th>
      </tr></thead>
      <tbody><tr><td colspan="7" class="muted">Loading history…</td></tr></tbody>
    </table>
  </div>

  ${historySection}

  ${changesSection}

  <footer>
    <h3>Data sources</h3>
    <p>OpenCode Go model prices and quotas: <a href="https://opencode.ai/docs/en/go" rel="noopener">opencode.ai/docs/en/go</a>.</p>
    <p>Model benchmark scores: <a href="${benchUrl}" rel="noopener">TIMETOACT GROUP — LLM Benchmark, ${bTitle}</a>. Copyright © TIMETOACT GROUP. All benchmark rights belong to their owners.</p>
    <p>Machine-readable data: <a href="report.json" rel="noopener">report.json</a> — the full report as JSON (schema: <a href="report.schema.json" rel="noopener">report.schema.json</a>), regenerated by the same run.</p>

    <h3>Disclaimer</h3>
    <p>This site is an unofficial, independent and unaffiliated aggregation of publicly available data. It is not endorsed by or affiliated with OpenCode, TIMETOACT GROUP, any model vendor or their owners.</p>
    <p>All cost figures are <em>rough estimates</em> based on a typical session with assumed request patterns and publicly stated prices. Actual prices, quotas, multipliers and model capabilities differ and change without notice. Do not make financial or architectural decisions based on these numbers.</p>
    <p>Use of trademarks, logos and model names (OpenAI, Anthropic, Google, DeepSeek, Qwen, GLM, Kimi, MiniMax, Grok, MiMo, Muse and others) is for identification purposes only; all rights belong to their respective owners.</p>
    <p>Neither the author nor this site is liable for any loss, direct or indirect, arising from the use of the information presented here.</p>
    <p>© ${new Date().getFullYear()} opencode-benchmark. Build it yourself: <code>npm start</code> regenerates this file.</p>
  </footer>
</div>
<script>
  document.querySelectorAll('table.sortable').forEach(function (tbl) {
    const heads = tbl.querySelectorAll('th.sortable');
    const tbody = tbl.tBodies[0];
    heads.forEach(function (th, i) {
      th.addEventListener('click', function () {
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        heads.forEach(function (h) { delete h.dataset.dir; h.classList.remove('sorted'); });
        th.dataset.dir = dir;
        th.classList.add('sorted');
        const isNum = th.classList.contains('num');
        const rows = Array.from(tbody.rows).sort(function (a, b) {
          let av = a.cells[i].textContent.trim().replace(/^[✓⚠—]\\s*/, '');
          let bv = b.cells[i].textContent.trim().replace(/^[✓⚠—]\\s*/, '');
          if (isNum) {
            const an = parseFloat(av.replace(/[$,\\s]/g, ''));
            const bn = parseFloat(bv.replace(/[$,\\s]/g, ''));
            if (!isFinite(an)) return 1;
            if (!isFinite(bn)) return -1;
            return dir === 'asc' ? an - bn : bn - an;
          }
          if (av === '') return 1;
          if (bv === '') return -1;
          const c = av.localeCompare(bv, 'en');
          return dir === 'asc' ? c : -c;
        });
        rows.forEach(function (row) { tbody.appendChild(row); });
      });
    });
  });
</script>
<script>
(function () {
  var box = document.getElementById('movers');
  if (!box) return;
  var tbody = box.tBodies[0];
  var btns = Array.prototype.slice.call(document.querySelectorAll('.period-btn'));
  if (!btns.length) return;
  var cache = {};
  var snaps = null, latest = null, curList = null;

  function escTxt(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function buildList(report) {
    var out = [];
    (report.rows || []).forEach(function (r) {
      var mp = r.mpPerSession;
      if (r.score != null && r.quotaUsd > 0 && r.tier === 'OK' && mp != null && mp > 0) {
        out.push({ model: r.model, score: r.score, mp: mp, price: r.priceUsdPerSession, quota: r.quotaUsd, ratio: r.score / mp });
      }
    });
    out.sort(function (a, b) { return (b.ratio - a.ratio) || (b.score - a.score); });
    out.forEach(function (m, i) { m.rank = i + 1; });
    return out;
  }

  function topMovers(cur) {
    var baseRep = cache[cur.file];
    if (!baseRep) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Not enough history yet — daily snapshots accumulate over time.</td></tr>';
      return;
    }
    var base = buildList(baseRep);
    var bmap = {};
    base.forEach(function (m) { bmap[m.model] = m; });
    var cmap = {};
    curList.forEach(function (m) { cmap[m.model] = m; });

    var items = [];
    curList.forEach(function (m) {
      var b = bmap[m.model];
      if (!b) {
        items.push({ m: m, kind: 'new', dr: null, r: m.ratio, prev: null, dRank: null, dpct: null, qmult: null });
        return;
      }
      items.push({
        m: m, kind: 'move', dr: m.ratio - b.ratio, r: m.ratio, prev: b.ratio,
        dRank: b.rank - m.rank,
        dpct: (m.price != null && b.price != null && b.price > 0) ? (m.price - b.price) / b.price : null,
        qmult: (m.quota != null && b.quota != null && b.quota > 0) ? m.quota / b.quota : null,
      });
    });
    base.forEach(function (m) {
      if (!cmap[m.model]) {
        items.push({ m: m, kind: 'gone', dr: null, r: null, prev: m.ratio, dRank: null, dpct: null, qmult: null });
      }
    });

    function prio(it) {
      if (it.kind === 'new' || it.kind === 'gone') return 3;
      if (Math.abs(it.dr) >= 0.005) return 2;
      if (it.dRank !== 0) return 1;
      return 0;
    }
    items = items.filter(function (it) { return prio(it) > 0; });
    items.sort(function (a, b) {
      var pa = prio(a), pb = prio(b);
      if (pa !== pb) return pb - pa;
      if (pa === 3) return a.m.model.localeCompare(b.m.model);
      if (pa === 2) return Math.abs(b.dr) - Math.abs(a.dr);
      return Math.abs(b.dRank) - Math.abs(a.dRank);
    });
    items = items.slice(0, 12);

    var html = '';
    items.forEach(function (it, idx) {
      var m = it.m;
      var realDelta = it.dr != null && Math.abs(it.dr) >= 0.005;
      var nowTxt = it.r != null ? it.r.toFixed(2) : '—';
      var prevTxt = it.prev != null ? it.prev.toFixed(2) : '—';
      var dTxt, cls;
      if (it.kind === 'new') { dTxt = 'new'; cls = 'mnew'; }
      else if (it.kind === 'gone') { dTxt = 'left'; cls = 'mgone'; }
      else if (!realDelta) { dTxt = '±0.00'; cls = 'mgone'; }
      else { dTxt = (it.dr >= 0 ? '+' : '') + it.dr.toFixed(2); cls = it.dr >= 0 ? 'mup' : 'mdown'; }
      var placeTxt = it.dRank == null ? '—' : it.dRank === 0 ? '—' : (it.dRank > 0 ? '+' + it.dRank : '' + it.dRank);
      var reasons = [];
      if (it.kind === 'new') { reasons.push('entered top score/mp'); }
      else if (it.kind === 'gone') { reasons.push('left top score/mp'); }
      else if (realDelta) {
        if (it.dpct != null && Math.abs(it.dpct) >= 0.02) reasons.push('price ' + (it.dpct < 0 ? '−' : '+') + Math.abs(it.dpct * 100).toFixed(0) + '%');
        if (it.qmult != null && (it.qmult >= 1.5 || it.qmult <= 0.67)) reasons.push('quota ×' + (Math.round(it.qmult * 10) / 10));
        if (!reasons.length) reasons.push('benchmark score change');
      }
      else {
        reasons.push(it.dRank > 0 ? 'rank up — rivals dropped' : 'outpaced by rivals (own metrics unchanged)');
      }
      html += '<tr>'
        + '<td class="num">' + (idx + 1) + '</td>'
        + '<td class="model">' + escTxt(m.model) + '</td>'
        + '<td class="num">' + nowTxt + '</td>'
        + '<td class="num">' + prevTxt + '</td>'
        + '<td class="num ' + cls + '">' + dTxt + '</td>'
        + '<td class="num">' + placeTxt + '</td>'
        + '<td class="mdr">' + escTxt(reasons.join('; ')) + '</td>'
        + '</tr>';
    });
    tbody.innerHTML = html || '<tr><td colspan="7" class="muted">No score/mp changes in this period.</td></tr>';
  }

  function load(days) {
    var limit = new Date(new Date(latest.date + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10);
    var best = null;
    snaps.forEach(function (s) { if (s.date <= limit && (!best || s.date > best.date)) best = s; });
    if (!best) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No snapshot this far back — history accumulates daily.</td></tr>';
      return;
    }
    function go() { topMovers(best); }
    if (cache[best.file]) go();
    else {
      fetch(best.file).then(function (r) { return r.json(); }).then(function (j) {
        cache[best.file] = j;
        go();
      }).catch(function () {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">Failed to load snapshot.</td></tr>';
      });
    }
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      load(parseInt(b.getAttribute('data-days'), 10));
    });
  });

  fetch('history/index.json').then(function (r) { return r.json(); }).then(function (m) {
    snaps = (m.snapshots || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (snaps.length < 2) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">History is empty — available from the second snapshot onward.</td></tr>';
      return;
    }
    latest = snaps[snaps.length - 1];
    fetch(latest.file).then(function (r) { return r.json(); }).then(function (j) {
      cache[latest.file] = j;
      curList = buildList(j);
      load(1);
    });
  });
})();
</script>
<script>
(function () {
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.pk[data-peak]'));
  if (!nodes.length) return;
  var tz = null;
  try { tz = new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  tz = tz || 'Europe/Moscow';
  // Short standard abbreviation (MSK, EST, CEST, JST …). Some browser/zones fall back to
  // "GMT+3" — for those, derive a city label from the IANA name instead.
  function tzAbbr(t) {
    var out = t;
    try {
      var abrp = new Intl.DateTimeFormat('en-US', { timeZone: t, timeZoneName: 'short' }).formatToParts(new Date());
      for (var ai = 0; ai < abrp.length; ai++) {
        if (abrp[ai].type === 'timeZoneName') out = abrp[ai].value;
      }
    } catch (e) {}
    if (/^(GMT|UTC|Etc[-+]|[+\\-]\\d)/.test(out)) {
      var seg = t.split('/');
      var last = seg[seg.length - 1] || t;
      if (!/^(GMT|UTC|Etc)/i.test(last)) out = last.replace(/_/g, ' ');
    }
    return out;
  }
  var tzLabel = tzAbbr(tz);
  var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  function inDayRange(wd, days) {
    if (!days || days.length < 2) return true;
    var a = days[0], b = days[1];
    return a <= b ? (wd >= a && wd <= b) : (wd >= a || wd <= b);
  }
  // Local wall clock of a REAL instant (DST-aware, reform-proof): Intl converts the actual
  // timestamp, so the offset applied is whatever the zone was on that exact day — not a
  // hardcoded reference date that could rot after a timezone reform.
  function localAt(ms) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms));
      var hh = 0, mm = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') hh = parseInt(parts[i].value, 10);
        if (parts[i].type === 'minute') mm = parseInt(parts[i].value, 10);
      }
      return pad2(hh) + ':' + pad2(mm);
    } catch (e) { return ''; }
  }
  // Next future instant (in UTC time-of-week terms) where the hour:minute falls inside the
  // note's peak windows — used to render each window in local time under the real offset
  // that will actually be in effect for that occurrence.
  function scanHM(n, h, m, fromMs) {
    var t = fromMs == null ? Date.now() : fromMs;
    for (var i = 0; i <= 10081; i++) {
      var d = new Date(t + i * 60000);
      if (d.getUTCHours() === h && d.getUTCMinutes() === m && inDayRange(d.getUTCDay(), n.days)) return d.getTime();
    }
    return null;
  }
  function daysText(days) {
    if (!days || days.length < 2) return '';
    var a = days[0], b = days[1];
    return a === b ? DAY[a] : DAY[a] + '\u2013' + DAY[b];
  }
  function rangeHas(t, r) {
    var s = r[0] * 60 + r[1], e = r[2] * 60 + r[3];
    return s <= e ? (t >= s && t < e) : (t >= s || t < e);
  }
  // Peak = the expensive (Peak) price window; the discounted (Off-Peak) price is its complement.
  function isPeakAt(n, d) {
    var wd = d.getUTCDay();
    if (!inDayRange(wd, n.days)) return true; // outside the weekday range every hour is Off-Peak
    var t = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (var i = 0; i < n.ranges.length; i++) {
      if (rangeHas(t, n.ranges[i])) return true;
    }
    return false;
  }
  function cheapOn(n, d) { return !isPeakAt(n, d); }
  function nextChange(n, fromMs, on) {
    for (var i = 1; i <= 10080; i++) {
      var d = new Date(fromMs + i * 60000);
      if (cheapOn(n, d) !== on) return d.getTime();
    }
    return null;
  }
  function fmt(ms) {
    // Human countdown: hours:minutes only — nobody tracks seconds on a badge.
    if (ms < 60000) return '0:01';
    var totalMin = Math.ceil(ms / 60000);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h + ':' + pad2(m);
  }
  function windowTxt(n) {
    var parts = [];
    for (var wi = 0; wi < n.ranges.length; wi++) {
      var r = n.ranges[wi];
      var sMs = scanHM(n, r[0], r[1]);
      if (sMs == null) continue;
      var eMs = scanHM(n, r[2], r[3], sMs + 60000);
      parts.push(localAt(sMs) + '\u2013' + (eMs == null ? '' : localAt(eMs)));
    }
    var days = daysText(n.days);
    return (days ? days + ' ' : '') + parts.join(', ');
  }
  nodes.forEach(function (el) {
    var n;
    try { n = JSON.parse(el.getAttribute('data-peak')); } catch (e) { return; }
    if (!n || !n.ranges || !n.ranges.length) return;
    el._pk = n;
    el._txt = document.createElement('i');
    el.appendChild(el._txt);
  });
  function tick() {
    var now = new Date();
    nodes.forEach(function (el) {
      var n = el._pk;
      if (!n) return;
      var on = cheapOn(n, now);
      var next = nextChange(n, now.getTime(), on);
      var dur = next ? fmt(next - now.getTime()) : '\u2014';
      var msg;
      if (on) {
        el._txt.textContent = dur + ' left \u00b7 ' + tzLabel;
        msg = 'Discounted price applies now \u00b7 ends in ' + dur;
      } else {
        el._txt.textContent = 'in ' + dur + ' \u00b7 ' + tzLabel;
        msg = 'Discounted price starts in ' + dur;
      }
      el.title = msg + '. Window: ' + windowTxt(n) + ' (your zone \u00b7 ' + tz + ')';
      el.className = 'pk' + (on ? ' pk-on' : ' pk-off');
      el.setAttribute('aria-label', el.title);
    });
  }
  setInterval(tick, 30 * 1000);
  tick();
})();
</script>
</body>
</html>
`;
}

// Auto-section of README.md: live facts from the current report + the second table
// (Top: Score/mp). Inserted between the <!-- AUTO-DATA -->…<!-- /AUTO-DATA --> markers.
function renderReadmeAuto(report, benchUrl, changes = { vs: null, items: [] }) {
  const bt = benchTitle(benchUrl);
  const updated = new Date().toISOString().slice(0, 10);

  const okCount = report.rows.filter((r) => r.tier === 'OK').length;
  const noneCount = report.rows.filter((r) => r.tier === 'NONE').length;

  const byKind = {};
  for (const it of changes.items || []) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ');
  const changesLine = changes.vs
    ? `- **Changes vs ${changes.vs}:** ${changes.items.length === 0 ? 'none' : changes.items.length + (kindSummary ? ` (${kindSummary})` : '')}`
    : '- **Changes:** first snapshot — daily history starts today.';

  const topRows = report.ranked
    .map((x) => `| ${x.model.replace(/\|/g, '\\|')} | ${x.score.toFixed(0)} | ${x.mp.toFixed(1)} | **${x.ratio.toFixed(2)}** |`)
    .join('\n');

  return `## Score per mp — live

Data for this README is regenerated by the same script that builds the page
([docs/index.html](docs/index.html)). No one updates these numbers by hand.

- **Benchmark:** ${bt} — [TIMETOACT GROUP](https://www.timetoact-group.at/en/insights/llm-benchmarks)
- **OpenCode Go tariffs:** [opencode.ai/docs/en/go](https://opencode.ai/docs/en/go)
- **Generated:** ${updated} UTC
- **Matched:** ${okCount} of ${report.rows.length} tariffs have a confident match in the benchmark (${noneCount} not found).
${changesLine}
- **History:** daily snapshots in [docs/history/](docs/history/) — one JSON per day, diffs included.

Top models by *intelligence per unit of quota* — score ÷ milli-percent of the
monthly pool (confident matches only):

| Model | Score | mp/session | Score/mp |
|---|---|---|---|
${topRows}

> Hands-off number: scripts, pricing assumptions, matching rules and disclaimers
> are described on the page footer and below. Verify names by eye before relying
> on any pairing.`;
}

// Machine-readable JSON twin of the report (docs/report.json). Same data as the
// page, for anyone who wants to consume it programmatically instead of scraping HTML.
const round = (v, d) => (v == null ? null : +v.toFixed(d));

function reportToJson(report, benchUrl, siteUrl) {
  return {
    $schema: siteUrl ? `${siteUrl}/report.schema.json` : 'report.schema.json',
    generatedAt: new Date().toISOString(),
    generator: {
      name: 'opencode-benchmark',
      page: siteUrl ? `${siteUrl}/` : null,
      source: 'https://github.com/krivich/opencode-benchmark',
      license: 'MIT',
    },
    sources: {
      pricing: {
        title: 'OpenCode Go tariff prices and quotas',
        url: 'https://opencode.ai/docs/en/go',
        publisher: 'OpenCode',
      },
      benchmark: {
        title: 'TIMETOACT GROUP — LLM Benchmark',
        url: benchUrl,
        indexUrl: 'https://www.timetoact-group.at/en/insights/llm-benchmarks',
        publisher: 'TIMETOACT GROUP',
        copyright: 'Copyright © TIMETOACT GROUP. All benchmark rights belong to their owners.',
      },
    },
    legal: {
      trademarks: 'Model names and trademarks belong to their respective owners and are used for identification only.',
      disclaimer: 'Unofficial, independent aggregation of public data; not affiliated with or endorsed by OpenCode, TIMETOACT GROUP or any model vendor. All figures are rough estimates and may change without notice — verify before use.',
    },
    session: {
      inputTokens: SESSION.input,
      cacheReadTokens: SESSION.cacheRead,
      outputTokens: SESSION.output,
      monthlyPoolUsd: 60,
    },
    rows: report.rows.map((r) => ({
      model: r.model,
      score: r.score,
      priceUsdPerSession: round(r.price, 6),
      mpPerSession: round(r.mp, 2),
      quotaUsd: r.usage,
      multiplier: round(r.multiplier, 4),
      requestsPerMonth: r.reqPerMonth,
      matchedBenchmarkName: r.matchedName,
      similarity: round(r.sim, 3),
      tier: r.tier,
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
// 6b. History: daily snapshots + change detection
// ──────────────────────────────────────────────
// Every run stores a dated snapshot (docs/history/YYYY-MM-DD.json, same schema as
// report.json) and diffs it against the previous snapshot. The page then shows
// "what changed" and a history table — the site becomes a time series, not just
// a table for today.
function loadPrevSnapshot() {
  const manifestPath = path.join(HISTORY_DIR, 'index.json');
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
  const file = path.join(OUT_DIR, last.file);
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

function writeSnapshot(full, changesCount) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const manifestPath = path.join(HISTORY_DIR, 'index.json');
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
  manifest.snapshots = (manifest.snapshots || []).filter((e) => e.date !== entry.date);
  manifest.snapshots.push(entry);
  manifest.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  manifest.updated = full.generatedAt;
  const snapFile = path.join(HISTORY_DIR, `${date}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(full, null, 2) + '\n', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[write] ${snapFile}`);
  console.log(`[write] ${manifestPath}`);
  return { snapshots: manifest.snapshots };
}

// JSON Schema for report.json (docs/report.schema.json). Generated by the same run,
// so it can never drift from the data. Descriptions make it self-documenting.
function reportSchema(siteUrl) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: siteUrl ? `${siteUrl}/report.schema.json` : 'report.schema.json',
    title: 'OpenCode Go × TIMETOACT LLM Benchmark report',
    description: 'One typical OpenCode Go session priced against the latest TIMETOACT LLM ' +
      'Benchmark issue. Generated by the opencode-benchmark script; do not edit by hand.',
    type: 'object',
    additionalProperties: false,
    required: ['$schema', 'generatedAt', 'generator', 'sources', 'legal', 'session', 'rows', 'ranked', 'changes'],
    properties: {
      $schema: { type: 'string', format: 'uri', description: 'URL of this JSON Schema.' },
      generatedAt: { type: 'string', format: 'date-time', description: 'ISO 8601 UTC timestamp of the run that produced this file.' },
      generator: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'page', 'source', 'license'],
        description: 'Who produced this file. Consumers reusing the data should credit it.',
        properties: {
          name: { type: 'string', description: 'Name of the generating project.' },
          page: { type: ['string', 'null'], format: 'uri', description: 'Deployed page URL; null when generated without a known deployment target.' },
          source: { type: 'string', format: 'uri', description: 'Repository with the generating code.' },
          license: { type: 'string', description: 'SPDX license identifier of the generating project.' },
        },
      },
      sources: {
        type: 'object',
        additionalProperties: false,
        required: ['pricing', 'benchmark'],
        description: 'Where every number in this report comes from. Consumers who republish this report must keep this block.',
        properties: {
          pricing: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'url', 'publisher'],
            properties: {
              title: { type: 'string', description: 'What was taken from this source (tariff prices and quotas).' },
              url: { type: 'string', format: 'uri', description: 'URL of the OpenCode Go pricing page.' },
              publisher: { type: 'string', description: 'Publisher of the pricing data.' },
            },
          },
          benchmark: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'url', 'indexUrl', 'publisher', 'copyright'],
            properties: {
              title: { type: 'string', description: 'Name of the benchmark.' },
              url: { type: 'string', format: 'uri', description: 'URL of the exact monthly issue used for the scores in this report.' },
              indexUrl: { type: 'string', format: 'uri', description: 'Index page listing all monthly issues (the script picks the newest).' },
              publisher: { type: 'string', description: 'Publisher of the benchmark.' },
              copyright: { type: 'string', description: 'Copyright notice of the benchmark publisher.' },
            },
          },
        },
      },
      legal: {
        type: 'object',
        additionalProperties: false,
        required: ['trademarks', 'disclaimer'],
        description: 'Legal notices that must travel with the data.',
        properties: {
          trademarks: { type: 'string', description: 'Trademark notice for model names.' },
          disclaimer: { type: 'string', description: 'Liability/accuracy disclaimer for anyone reusing this data.' },
        },
      },
      changes: {
        type: 'object',
        additionalProperties: false,
        required: ['vs', 'benchmarkIssueChanged', 'items'],
        description: 'Diff against the previous daily snapshot (docs/history/). Daily history turns the report into a time series.',
        properties: {
          vs: { type: ['string', 'null'], description: 'Date (YYYY-MM-DD) of the previous snapshot this diff was computed against; null for the very first snapshot.' },
          benchmarkIssueChanged: { type: 'boolean', description: 'True when a new monthly benchmark issue appeared since the previous snapshot.' },
          items: {
            type: 'array',
            description: 'Per-model changes: score moves, price/quota changes, tariffs added or removed.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'model', 'from', 'to'],
              properties: {
                kind: { type: 'string', enum: ['score', 'price', 'quota', 'added', 'removed'], description: 'What changed.' },
                model: { type: 'string', description: 'Tariff name (as listed by OpenCode Go).' },
                from: { type: ['number', 'null'], description: 'Previous value; null for added/removed.' },
                to: { type: ['number', 'null'], description: 'New value; null for removed.' },
              },
            },
          },
        },
      },
      session: {
        type: 'object',
        additionalProperties: false,
        required: ['inputTokens', 'cacheReadTokens', 'outputTokens', 'monthlyPoolUsd'],
        description: 'The "typical session" assumption all costs are computed against.',
        properties: {
          inputTokens: { type: 'integer', description: 'Input tokens per session (5% of a 155K context, not cache-served).' },
          cacheReadTokens: { type: 'integer', description: 'Cache-read tokens per session (95% of a 155K context).' },
          outputTokens: { type: 'integer', description: 'Output tokens per session.' },
          monthlyPoolUsd: { type: 'number', description: 'Monthly quota pool in USD (OpenCode Go fixed pool).' },
        },
      },
      rows: {
        type: 'array',
        description: 'Every OpenCode Go tariff with computed cost metrics and its benchmark match.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['model', 'score', 'priceUsdPerSession', 'mpPerSession', 'quotaUsd', 'multiplier', 'requestsPerMonth', 'matchedBenchmarkName', 'similarity', 'tier'],
          properties: {
            model: { type: 'string', description: 'Tariff name exactly as listed on the OpenCode Go pricing page.' },
            score: { type: ['number', 'null'], description: 'TIMETOACT benchmark "final" score; null when the model was not matched.' },
            priceUsdPerSession: { type: ['number', 'null'], minimum: 0, description: 'Computed cost of one typical session in USD.' },
            mpPerSession: { type: ['number', 'null'], minimum: 0, description: 'Milli-percent of the monthly pool consumed by one session (price ÷ quota × 100 000).' },
            quotaUsd: { type: 'number', minimum: 0, description: 'Monthly quota in USD as listed by OpenCode Go.' },
            multiplier: { type: ['number', 'null'], minimum: 0, description: 'Quota multiplier implied by the pool: 60 ÷ quotaUsd.' },
            requestsPerMonth: { type: ['integer', 'null'], minimum: 0, description: 'How many typical sessions fit into the monthly pool.' },
            matchedBenchmarkName: { type: ['string', 'null'], description: 'Benchmark row name matched to this tariff; null if unmatched.' },
            similarity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Levenshtein similarity of the normalized names; null if unmatched.' },
            tier: { type: 'string', enum: ['OK', 'AMBIG', 'WEAK', 'NONE'], description: 'Match confidence: OK ≥ 0.85 or substring rescue; AMBIG 0.55–0.85; WEAK 0.50–0.55; NONE — no match.' },
            peakHours: {
              type: ['object', 'null'],
              description: 'Peak/Off-Peak pricing hours for this tariff as stated by OpenCode Go (e.g. DeepSeek V4). null when the note does not apply.',
              required: ['tz', 'days', 'ranges'],
              additionalProperties: false,
              properties: {
                tz: { type: 'string', description: 'Timezone the stated hours are in (always UTC so far).' },
                days: { type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Inclusive weekday range using JS getDay numbering (0=Sunday); null when every day is affected.' },
                ranges: { type: 'array', items: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'integer', minimum: 0 }, description: 'One peak window as [fromHour, fromMinute, toHour, toMinute] in tz.' }, description: 'Peak hour windows within the weekday range; all other hours (incl. weekends) are Off-Peak.' },
              },
            },
          },
        },
      },
      ranked: {
        type: 'array',
        description: 'Top tariffs by benchmark score per milli-percent of quota; confident matches only.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['model', 'score', 'mpPerSession', 'scorePerMp'],
          properties: {
            model: { type: 'string', description: 'Tariff name as listed on the OpenCode Go pricing page.' },
            score: { type: 'number', description: 'TIMETOACT benchmark "final" score.' },
            mpPerSession: { type: 'number', description: 'Milli-percent of the monthly pool consumed by one session.' },
            scorePerMp: { type: 'number', description: 'score ÷ mp — intelligence per consumed fraction of the pool.' },
          },
        },
      },
    },
  };
}

// --- og-image: SVG picture for Open Graph / Twitter Card ---

const OG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#111111"/>
  <text x="84" y="360" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="220" font-weight="700" fill="#ffffff">GO?</text>
</svg>
`;

function writeReport(report, benchUrl) {
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const json = reportToJson(report, benchUrl, siteUrl);
  const prevSnap = loadPrevSnapshot();
  const changes = detectChanges(json, prevSnap ? prevSnap.prev : null);
  const full = { ...json, changes };

  const { snapshots } = writeSnapshot(full, changes.items.length);
  const html = renderHtml(report, benchUrl, { changes, history: snapshots });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const docsFile = path.join(OUT_DIR, 'index.html');
  fs.writeFileSync(docsFile, html, 'utf8');
  console.log(`[write] ${docsFile}`);

  const ogFile = path.join(OUT_DIR, 'og-image.svg');
  fs.writeFileSync(ogFile, OG_IMAGE, 'utf8');
  console.log(`[write] ${ogFile}`);

  const jsonFile = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(jsonFile, JSON.stringify(full, null, 2) + '\n', 'utf8');
  console.log(`[write] ${jsonFile}`);

  const schemaFile = path.join(OUT_DIR, 'report.schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(reportSchema(siteUrl), null, 2) + '\n', 'utf8');
  console.log(`[write] ${schemaFile}`);

  // Update the auto-section in README.md (only between the markers, manual text untouched).
  const readmePath = path.join(__dirname, 'README.md');
  if (fs.existsSync(readmePath)) {
    let readme = fs.readFileSync(readmePath, 'utf8');
    const startMark = '<!-- AUTO-DATA -->';
    const endMark = '<!-- /AUTO-DATA -->';
    const start = readme.indexOf(startMark);
    const end = readme.indexOf(endMark);
    if (start !== -1 && end !== -1 && end > start) {
      readme = readme.slice(0, start + startMark.length) + '\n\n' + renderReadmeAuto(report, benchUrl, changes) + '\n\n' + readme.slice(end);
      fs.writeFileSync(readmePath, readme, 'utf8');
      console.log(`[write] ${readmePath} (auto section)`);
    } else {
      console.error('[skip] README.md: AUTO-DATA markers not found — manual part not patched.');
    }
  }

  // In a manual run (without PAGES=1) mirror to the repo root for local viewing.
  if (!PAGES) {
    const rootIdx = path.join(__dirname, 'index.html');
    fs.writeFileSync(rootIdx, html, 'utf8');
    console.log(`[write] ${rootIdx}`);
  }
}

async function main() {
  const [goHtml, benchIndexHtml] = await Promise.all([
    fetchText(GO_URL),
    fetchText(BENCH_INDEX_URL),
  ]);

  // Fetch the newest benchmark page from the index, not a hardcoded month.
  const latest = findLatestBenchUrl(benchIndexHtml);
  const benchHtml = await fetchText(latest.url);
  const benchLabel = latest.url.split('/').filter(Boolean).pop();
  console.error(`[bench] using latest benchmark: ${benchLabel}`);

  const goRows = parseGoTable(goHtml);
  const benchRows = parseBenchmarkTable(benchHtml);

  // Attach Peak/Off-Peak hours notes (e.g. DeepSeek V4) to the matching tariff rows.
  const peakNotes = parsePeakNotes(goHtml);
  for (const r of goRows) r.peak = peakForRow(r.model, peakNotes);

  // Make sure the fresh pages really contain tables, not a captcha/garbage.
  sanityCheck(goRows, benchRows);

  const withPeak = goRows.filter((r) => r.peak).length;
  console.error(`[parse] Go: ${goRows.length} models, Benchmark: ${benchRows.length} rows, Peak/Off-Peak: ${withPeak}`);

  const report = buildReport(goRows, benchRows);
  writeReport(report, latest.url);

  console.log(PAGES
    ? '[pages] docs/index.html is ready — commit and push to GitHub, Pages will serve it from /docs.'
    : '[pages] tip: with PAGES=1 output is written only to docs/ (for CI).');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
