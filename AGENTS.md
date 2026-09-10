# AGENTS.md

Single-file Node.js project (`opencode-benchmark.js`, ESM). Fetches OpenCode Go pricing and TIMETOACT LLM benchmark data, fuzzy-matches models, computes session costs, and generates a GitHub Pages site in `docs/`.

## Commands

```bash
npm ci           # install deps (cheerio + optional socks-proxy-agent)
npm start        # run in dev mode → writes docs/ AND root index.html
npm run pages    # CI mode → writes only docs/ (no root index.html)
npm run pages:win  # Windows CI equivalent of pages
```

No tests, no lint, no typecheck, no formatter configured. The only verification is `npm start` succeeding without error.

## Environment Variables

- `PAGES=1` — write output only to `docs/` (CI). Without it, also writes `index.html` to repo root.
- `SOCKS=socks5h://127.0.0.1:1080` — route fetches through a SOCKS proxy (optional, lazy-loads `socks-proxy-agent`).
- `SITE_URL=https://example.com` — sets canonical URL / OG metadata in generated HTML.

## What Gets Generated (do not hand-edit)

Every `npm start` run regenerates all of these from live external data:

| File | Purpose |
|------|---------|
| `docs/index.html` | Main page (GitHub Pages serves from `docs/`) |
| `docs/report.json` | Machine-readable report (same data as the page) |
| `docs/report.schema.json` | JSON Schema for `report.json` |
| `docs/history/YYYY-MM-DD.json` | Daily snapshot (time series) |
| `docs/history/index.json` | Manifest listing all snapshots |
| `README.md` (auto section) | Rewrites between `<!-- AUTO-DATA -->` markers |
| `og-image.svg` | Open Graph image |
| `index.html` (root, dev only) | Local preview; gitignored |

## Architecture (single file, sections by responsibility)

1. **Fetch** (lines ~52-116) — HTTP fetching with optional SOCKS proxy, browser-like headers to avoid Cloudflare blocks.
2. **Benchmark discovery** (lines ~120-148) — Auto-detects the newest monthly benchmark from the TIMETOACT index page (URL pattern, not hardcoded month).
3. **Table extraction** (lines ~156-168) — `extractTableFragments()` pulls `<table>` tags from raw HTML (the benchmark site embeds tables inside `<script>` tags).
4. **Parsing** (lines ~174-271) — Separate parsers for Go pricing table and benchmark table.
5. **Matching** (lines ~278-424) — Levenshtein-based fuzzy match with hard filters for versions (X.Y) and subtypes (flash/max/pro/etc.). Confidence tiers: OK, AMBIG, WEAK, NONE.
6. **Computation** (lines ~429-442) — Session cost: 7,750 input + 147,250 cache-read + 300 output tokens.
7. **HTML rendering** (lines ~540-952) — Full page with inline CSS/JS, dark mode, sortable tables, SEO metadata.
8. **History/diffing** (lines ~1065-1154) — Snapshots + change detection between runs.
9. **README patching** (lines ~957-997, 1336-1350) — Rewrites the auto section in README.md between markers.

## Gotchas

- **Live data only** — script always fetches from `opencode.ai` and `timetoact-group.at`. No offline/cached mode. If either site is down or returns a captcha, the sanity check (line ~452) aborts and the previous `docs/index.html` is preserved.
- **Sanity check** — expects ≥10 Go models and ≥50 benchmark rows. If parsing returns less, the run fails with `FATAL:` error, no files are overwritten.
- **README auto section** — `<!-- AUTO-DATA -->` and `<!-- /AUTO-DATA -->` markers must exist in `README.md`. Manual text outside these markers is preserved. Do not edit the auto section by hand; it is regenerated.
- **Windows** — use `npm run pages:win` for the `PAGES=1` env var (`set PAGES=1&& node opencode-benchmark.js`). PowerShell doesn't support inline env vars like Unix shells.
- **No `.github/workflows/`** — the repo references a daily GitHub Action (`update-pages.yml`) but no workflow files exist in the repo. If adding CI, create `.github/workflows/` and use `npm run pages`.
- **`index.html` in root is gitignored** — only `docs/index.html` is committed. The root copy is for local dev preview.
