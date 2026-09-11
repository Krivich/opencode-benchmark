// lib/core/render.js
// Pure presentation layer: turns the persisted report JSON (the same object that is
// written to docs/report.json) into HTML / README auto-section / JSON Schema / OG image.
// No HTTP, no business logic — everything it needs already lives in the data, so this
// module (and the whole render stage) can be swapped for another renderer (e.g. a
// Handlebars-based SSG: JSON is the interface).

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Human-readable title from a benchmark URL or issue slug: ".../september-2026" → "September 2026".
function benchTitle(benchUrl) {
  const label = String(benchUrl || '').split('/').filter(Boolean).pop() || 'recent';
  const parts = label.replace(/^llm-benchmarks-/, '').split('-');
  return parts.length === 2
    ? `${parts[0][0].toUpperCase() + parts[0].slice(1)} ${parts[1]}`
    : label;
}

const tierMark = (tier) => (tier === 'OK' ? '✓' : tier === 'AMBIG' ? '⚠' : '—');
const tierClass = (tier) => ({ OK: 'ok', AMBIG: 'ambig', WEAK: 'weak' }[tier] || 'weak');

const SESS_FALLBACK = { inputTokens: 7750, cacheReadTokens: 147250, outputTokens: 300, monthlyPoolUsd: 60 };

function renderHtml(report, extras = {}) {
  const generatedAt = report.generatedAt || new Date().toISOString();
  const fmtVal = (v, digits) => (v != null ? v.toFixed(digits) : '—');

  const benchUrl = report.sources?.benchmark?.url;
  const bTitle = benchTitle(benchUrl);
  const changes = extras.changes || report.changes || { vs: null, benchmarkIssueChanged: false, items: [] };
  const historyList = extras.history || [];
  const sess = report.session || SESS_FALLBACK;

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

  // The peak note is shared by the (Peak) and (Off-Peak) rows, but each row's badge must
  // describe its OWN price window — so encode which side of the pair this row is.
  const peakVariantOf = (model) => /\(\s*off[-\s]?peak\s*\)/i.test(model) ? 'off'
    : /\(\s*peak\s*\)/i.test(model) ? 'peak' : null;
  const peakBadgeFor = (model, peakHours) => peakHours
    ? `<span class="pk" data-peak='${esc(JSON.stringify({ tz: peakHours.tz, days: peakHours.days, ranges: peakHours.ranges, variant: peakVariantOf(model) }))}' title="Peak/Off-Peak tariff">⚡</span>`
    : '';
  const peakByModel = new Map(report.rows.map((r) => [r.model, r.peakHours]));

  const tableBody = report.rows.map((r, i) => {
    const score = fmtVal(r.score, 0);
    const mp = fmtVal(r.mpPerSession, 1);
    const mult = fmtVal(r.multiplier, 2);
    const req = r.requestsPerMonth != null ? r.requestsPerMonth.toLocaleString('en-US') : '—';
    const matched = r.matchedBenchmarkName != null
      ? `<span class="tier tier-${tierClass(r.tier)}" title="${tierTitle[r.tier]}">${tierMark(r.tier)}</span> ${annotateIcons(r.matchedBenchmarkName)}`
      : '<span class="muted" title="Not found in benchmark">—</span>';
    const fallbackNote = r.benchmarkFallback && r.benchmarkIssue
      ? ` <i class="old" title="Not measured in the newest issue — this score comes from ${esc(benchTitle('/' + r.benchmarkIssue))}.">from ${esc(benchTitle('/' + r.benchmarkIssue))}</i>`
      : '';
    const peakBadge = peakBadgeFor(r.model, r.peakHours);
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="model">${annotateIcons(r.model)}${peakBadge}</td>
      <td class="num">${score}</td>
      <td class="num">$${r.priceUsdPerSession != null ? r.priceUsdPerSession.toFixed(4) : '—'}</td>
      <td class="num"><strong>${mp}</strong></td>
      <td class="num">$${r.quotaUsd}</td>
      <td class="num">${mult}</td>
      <td class="num">${req}</td>
      <td class="match">${matched}${fallbackNote}</td>
    </tr>`;
  }).join('\n');

  const rankedBody = report.ranked.map((x, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="model">${annotateIcons(x.model)}${peakBadgeFor(x.model, peakByModel.get(x.model))}</td>
    <td class="num">${x.score.toFixed(0)}</td>
    <td class="num">${x.mpPerSession != null ? x.mpPerSession.toFixed(1) : '—'}</td>
    <td class="num"><strong>${x.scorePerMp != null ? x.scorePerMp.toFixed(2) : '—'}</strong></td>
  </tr>`).join('\n');

  // "What changed" — diff vs the previous daily snapshot.
  const fmtP = (v) => (v == null ? '—' : `$${(+v).toFixed(4).replace(/\.?0+$/, '')}`);
  const changeLine = (c) => {
    const m = esc(c.model);
    if (c.kind === 'added') return `<li class="chg neu"><b>+ new tariff:</b> ${m}</li>`;
    if (c.kind === 'removed') return `<li class="chg neu"><b>− removed:</b> ${m}</li>`;
    if (c.kind === 'score') {
      const cls = (c.to ?? 0) > (c.from ?? 0) ? 'good' : 'bad';
      return `<li class="chg ${cls}"><b>score:</b> ${m} ${c.from ?? '—'} → ${c.to ?? '—'} ${(c.to ?? 0) > (c.from ?? 0) ? '▲' : '▼'}</li>`;
    }
    if (c.kind === 'price') {
      const up = (c.to ?? 0) > (c.from ?? 0);
      return `<li class="chg ${up ? 'bad' : 'good'}"><b>price:</b> ${m} ${fmtP(c.from)} → ${fmtP(c.to)} ${up ? '▲' : '▼'}</li>`;
    }
    return `<li class="chg neu"><b>quota:</b> ${m} $${c.from} → $${c.to}</li>`;
  };
  const changeLines = changes.items.slice(0, 50).map((c) => `      ${changeLine(c)}`).join('\n');
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

  // "Recent changes" — the last few days that actually changed. Daily snapshots are
  // sparse, so an event stays visible here until newer changes push it out, even if
  // the visitor missed the day it happened. Kept separate from the 1-day diff above.
  const recent = extras.recentChanges || [];
  const recentSection = (() => {
    if (!recent.length) return '';
    const MAX_ITEMS = 12;
    const body = recent.map((ev) => {
      const shown = ev.items.slice(0, MAX_ITEMS);
      const head = `<li class="chg-date">${esc(ev.date)}${ev.vs ? ` <span class="sub">vs ${esc(ev.vs)}</span>` : ''}</li>`;
      const items = shown.map((c) => `      ${changeLine(c)}`).join('\n');
      const tail = ev.items.length > shown.length
        ? `\n      <li class="chg empty">…and ${ev.items.length - shown.length} more — see <a href="report.json">report.json</a></li>`
        : '';
      return `${head}\n${items}${tail}`;
    }).join('\n');
    return `<div class="chgcard">
  <h2>Recent changes <span class="tt" title="The last days on which something actually changed. Unchanged days are not snapshotted, so a critical event stays listed here until newer changes push it out.">ⓘ</span></h2>
  <ul class="chgs">
${body}
  </ul>
</div>`;
  })();

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
  <p class="sub">${olderNote}Machine-readable manifest: <a href="history/index.json">history/index.json</a> — every snapshot as JSON.</p>`;
  })();

  const MATCH_TIP = 'Matching is Levenshtein-based with strict guards: versions (2.5 ≠ 2.6) '
    + 'and subtypes (Flash ≠ Max, Pro, Plus, …) are hard filters; similarity below 0.50 counts as '
    + 'not found unless one name is an exact substring of the other ("Hy3" → "Tencent Hy3"). '
    + 'Marks: ✓ confident, ⚠ plausible but different, — not in benchmark. Verify names by eye. '
    + '"from Month YYYY" — measured in an older benchmark issue (the newest one doesn\'t carry the model).';

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
  .old { color: #999; font-style: normal; font-size: 0.8em; cursor: help; }
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
  .chg-date { padding: 8px 0 2px; margin-top: 4px; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #666; border-bottom: 1px solid #e3e3e3; }
  .chg-date .sub { margin: 0; font-size: 0.78rem; }
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
    .chg-date { color: #aaa; border-color: #333; }
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
        <a href="tariffs/index.json">tariffs/</a> · <a href="benchmarks/index.json">benchmarks/</a> —
        raw normalized datasets, free to reuse ·
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
    <div>Typical session<br><b>${sess.inputTokens.toLocaleString('en-US')} input</b></div>
    <div>Cache-read<br><b>${sess.cacheReadTokens.toLocaleString('en-US')} tok.</b></div>
    <div>Output<br><b>${sess.outputTokens}</b></div>
    <div>Pool<br><b>$${sess.monthlyPoolUsd}/mo</b></div>
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
  ${recentSection}

  <footer>
    <h3>Data sources</h3>
    <p>OpenCode Go model prices and quotas: <a href="https://opencode.ai/docs/en/go" rel="noopener">opencode.ai/docs/en/go</a> — normalized copy: <a href="tariffs/opencode-go.json" rel="noopener">tariffs/opencode-go.json</a> (<a href="tariffs/index.json" rel="noopener">manifest</a>).</p>
    <p>Model benchmark scores: <a href="${benchUrl}" rel="noopener">TIMETOACT GROUP — LLM Benchmark, ${bTitle}</a>. Copyright © TIMETOACT GROUP. All benchmark rights belong to their owners. Full issue history (raw): <a href="benchmarks/timetoact/index.json" rel="noopener">benchmarks/timetoact/</a>.</p>
    <p>Machine-readable data: <a href="report.json" rel="noopener">report.json</a> — the full report as JSON (schema: <a href="report.schema.json" rel="noopener">report.schema.json</a>), regenerated by the same run. All datasets on this site are public and may be reused with attribution.</p>

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
    var out = '';
    try {
      var abrp = new Intl.DateTimeFormat('en-US', { timeZone: t, timeZoneName: 'short' }).formatToParts(new Date());
      for (var ai = 0; ai < abrp.length; ai++) {
        if (abrp[ai].type === 'timeZoneName') out = abrp[ai].value;
      }
    } catch (e) {}
    // 1) Clean real abbreviation (MSK, EDT, CEST …) — keep it.
    if (/^[A-Za-z]{2,5}$/.test(out) && !/^(GMT|UTC)$/i.test(out)) return out;
    // 2) Real IANA city zone → city label ("America/New_York" → "New York").
    if (t.indexOf('/') !== -1) {
      var last = t.split('/').pop() || t;
      if (!/^(GMT|UTC|Etc)/i.test(last)) return last.replace(/_/g, ' ');
    }
    // 3) Degenerate zone (e.g. "Etc/GMT-3" on some Windows setups) — for a Russian
    // browser fall back to Moscow, otherwise show whatever the zone reports.
    var lang = (typeof navigator !== 'undefined' ? String(navigator.language || '') : '').toLowerCase();
    if (lang.indexOf('ru') === 0) return 'Moscow';
    // 4) Last resort: numeric short name or the zone string itself.
    return out || t;
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
    if (!inDayRange(wd, n.days)) return false; // outside the weekday range every hour is Off-Peak
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
    // Human countdown with lettered units ("2h 05m", "47m") — HH:MM reads as a clock time.
    if (ms < 60000) return '1m';
    var totalMin = Math.ceil(ms / 60000);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? h + 'h ' + pad2(m) + 'm' : m + 'm';
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
      var off = cheapOn(n, now);
      // Each badge describes THIS row's own price window: the (Peak) and (Off-Peak) rows
      // are complements, so their countdowns are in antiphase (one "left", the other "in").
      var isOffRow = n.variant === 'off';
      var active = isOffRow ? off : !off;
      var next = nextChange(n, now.getTime(), off);
      var dur = next ? fmt(next - now.getTime()) : '\u2014';
      var label = isOffRow ? 'Discounted price' : 'Peak price';
      var msg;
      if (active) {
        el._txt.textContent = dur + ' left \u00b7 ' + tzLabel;
        msg = label + ' applies now \u00b7 ends in ' + dur;
      } else {
        el._txt.textContent = 'in ' + dur + ' \u00b7 ' + tzLabel;
        msg = label + ' starts in ' + dur;
      }
      el.title = msg + '. Window: ' + windowTxt(n) + ' (your zone \u00b7 ' + tzLabel + ')';
      el.className = 'pk' + (active ? ' pk-on' : ' pk-off');
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
function renderReadmeAuto(report, changes = { vs: null, items: [] }) {
  const bt = benchTitle(report.sources?.benchmark?.url);
  const updated = (report.generatedAt || new Date().toISOString()).slice(0, 10);

  const okCount = report.rows.filter((r) => r.tier === 'OK').length;
  const noneCount = report.rows.filter((r) => r.tier === 'NONE').length;

  const byKind = {};
  for (const it of changes.items || []) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ');
  const changesLine = changes.vs
    ? `- **Changes vs ${changes.vs}:** ${changes.items.length === 0 ? 'none' : changes.items.length + (kindSummary ? ` (${kindSummary})` : '')}`
    : '- **Changes:** first snapshot — daily history starts today.';

  const topRows = report.ranked
    .map((x) => `| ${x.model.replace(/\|/g, '\\|')} | ${x.score.toFixed(0)} | ${(x.mpPerSession ?? 0).toFixed(1)} | **${(x.scorePerMp ?? 0).toFixed(2)}** |`)
    .join('\n');

  return `## Score per mp — live

Data for this README is regenerated by the same script that builds the page
([docs/index.html](docs/index.html)). No one updates these numbers by hand.

- **Benchmark:** ${bt} — [TIMETOACT GROUP](https://www.timetoact-group.at/en/insights/llm-benchmarks), full issue history: [docs/benchmarks/](docs/benchmarks/)
- **OpenCode Go tariffs:** [opencode.ai/docs/en/go](https://opencode.ai/docs/en/go), normalized: [docs/tariffs/](docs/tariffs/)
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
              series: { type: 'string', description: 'Identifier of the benchmark series this report scores against.' },
              issue: { type: 'string', description: 'Slug of the newest issue, e.g. "september-2026".' },
              issues: { type: 'integer', description: 'Number of issues kept in the benchmark history (docs/benchmarks/<series>/).' },
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
          required: ['model', 'provider', 'modelId', 'score', 'priceUsdPerSession', 'mpPerSession', 'quotaUsd', 'multiplier', 'requestsPerMonth', 'matchedBenchmarkName', 'similarity', 'tier'],
          properties: {
            model: { type: 'string', description: 'Tariff name exactly as listed on the OpenCode Go pricing page.' },
            provider: { type: ['string', 'null'], description: 'Provider namespace the tariff belongs to, e.g. "opencode-go"; null when unknown.' },
            modelId: { type: ['string', 'null'], description: "Authoritative provider model id resolved by exact match against the provider's own model list (opencode.ai/zen/go/v1/models), e.g. \"deepseek-v4.1-flash\". Null means the tariff name did not exactly resolve: consumers must do their own matching and must NOT assume the model is unavailable." },
            score: { type: ['number', 'null'], description: 'TIMETOACT benchmark "final" score; null when the model was not matched.' },
            priceUsdPerSession: { type: ['number', 'null'], minimum: 0, description: 'Computed cost of one typical session in USD.' },
            mpPerSession: { type: ['number', 'null'], minimum: 0, description: 'Milli-percent of the monthly pool consumed by one session (price ÷ quota × 100 000).' },
            quotaUsd: { type: 'number', minimum: 0, description: 'Monthly quota in USD as listed by OpenCode Go.' },
            multiplier: { type: ['number', 'null'], minimum: 0, description: 'Quota multiplier implied by the pool: 60 ÷ quotaUsd.' },
            requestsPerMonth: { type: ['integer', 'null'], minimum: 0, description: 'How many typical sessions fit into the monthly pool.' },
            matchedBenchmarkName: { type: ['string', 'null'], description: 'Benchmark row name matched to this tariff; null if unmatched.' },
            similarity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Levenshtein similarity of the normalized names; null if unmatched.' },
            tier: { type: 'string', enum: ['OK', 'AMBIG', 'WEAK', 'NONE'], description: 'Match confidence: OK ≥ 0.85 or substring rescue; AMBIG 0.55–0.85; WEAK 0.50–0.55; NONE — no match.' },
            benchmarkIssue: { type: ['string', 'null'], description: 'Issue slug that measured the matched row, e.g. "march-2026"; null if unmatched. Null also implies the newest issue.' },
            benchmarkFallback: { type: 'boolean', description: 'True when the matched score comes from an older issue (the newest one does not carry this model).' },
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

export { esc, benchTitle, tierMark, tierClass, renderHtml, renderReadmeAuto, reportSchema, OG_IMAGE };