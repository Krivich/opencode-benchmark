// lib/core/match.js
// Shared model-name normalization + fuzzy matching (Levenshtein) between a pool of
// benchmark measurements and tariff rows. Also builds the "newest wins" pool from a
// series' issue history — the model is expected back in the benchmark under the same
// name, and a measurement from a future issue silently overrides an older one.

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

// Build the effective measurement pool of one benchmark series: for every model name
// keep the measurement from the NEWEST issue that carries it (measurements improve as
// models get updates, so a newer issue silently overrides an older one — while issues
// that never measured the model keep their older row as a backfill).
// pool = [{ row, issue }]   (issue: { slug, url, file, generatedAt })
function buildBenchPool(issues) {
  const seen = new Map();
  const desc = [...issues].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  const pool = [];
  for (const it of desc) {
    for (const row of it.rows || []) {
      const key = normalize(row.model);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.set(key, true);
      pool.push({ row, issue: it });
    }
  }
  return pool;
}

// Match a Go model name against the best benchmark candidate in the pool.
// Candidates are hard-filtered by version (X.Y) and subtype markers (max/pro/flash),
// then the maximum Levenshtein similarity wins. Above the floor — a match with a
// confidence tier; below the floor without substring rescue — an honest "not in benchmark".
//
// Returns rows { go, bench, issue, sim, tier } where `bench` is a pool row (or null)
// and `issue` the {slug,url,file} of the issue that measured it (or null).
function join(goRows, pool) {
  const joined = goRows.map(go => {
    const gk = normalize(go.model);
    const gv = dottedVersions(gk);
    let best = null;
    let bestSim = 0;

    for (const entry of pool) {
      const b = entry.row;
      const bk = normalize(b.model);
      if (!versionsCompatible(gv, dottedVersions(bk))) continue;
      if (subtypeConflict(gk, bk)) continue;

      const s = similarity(gk, bk);
      if (s > bestSim) {
        bestSim = s;
        best = entry;
      }
    }

    // Substring rescue: even at low similarity "hy3" → "tencent hy3" is a match.
    const rescued = best && isSubstringMatch(gk, normalize(best.row.model));

    let tier = 'NONE';
    if (best && (rescued || bestSim >= SIM_FLOOR)) {
      tier = rescued || bestSim >= 0.85 ? 'OK' : bestSim >= 0.55 ? 'AMBIG' : 'WEAK';
    } else if (best) {
      best = null;
      bestSim = 0;
    }

    return { go, bench: best ? best.row : null, issue: best ? best.issue : null, sim: bestSim, tier };
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
          r.issue = null;
          r.sim = 0;
          r.tier = 'NONE';
        }
      }
    }
  }

  return joined;
}

export {
  normalize,
  benchDisplay,
  levenshtein,
  similarity,
  versionsCompatible,
  subtypeConflict,
  isSubstringMatch,
  SIM_FLOOR,
  buildBenchPool,
  join,
};