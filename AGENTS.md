# AGENTS.md

Node.js project (ESM, monorepo-ish: a thin aggregator entry + standalone parser modules in `lib/`). Fetches OpenCode Go pricing and TIMETOACT LLM benchmark data, fuzzy-matches models, computes session costs, and generates a GitHub Pages site in `docs/` — including normalized, shareable JSON datasets for everyone. Requirements are tracked with stable IDs in [`REQUIREMENTS.md`](REQUIREMENTS.md) — update the matching status in the same change.

## Commands

```bash
npm ci           # install deps (cheerio + optional socks-proxy-agent)
npm start        # full pipeline → docs/ AND root index.html
npm run pages    # CI mode → writes only docs/ (no root index.html)
npm run pages:win  # Windows CI equivalent of pages
npm run bench:fetch  # standalone bench parser: refresh docs/benchmarks/timetoact/ only
npm run price:fetch  # standalone price parser: refresh docs/tariffs/ only
```

No tests, no lint, no typecheck, no formatter configured. The only verification is `npm start` succeeding without error.

## Environment Variables

- `PAGES=1` — write output only to `docs/` (CI). Without it, also writes `index.html` to repo root.
- `SOCKS=socks5h://127.0.0.1:1080` — route fetches through a SOCKS proxy (optional, lazy-loads `socks-proxy-agent`).
- `SITE_URL=https://example.com` — overrides the canonical origin (canonical/OG/Twitter/JSON-LD/`sitemap.xml`/`report.json` `$schema`). Defaults to `https://krivich.github.io/opencode-benchmark` (`lib/core/site.js`); CI derives it from the repository, so a fork or rename lands on its own URL without editing code.

| File | Purpose |
|------|---------|
| `docs/index.html` | Main page (GitHub Pages serves from `docs/`) — the only HTML page |
| `docs/sitemap.xml` | One entry (the page) with `lastmod` = report `generatedAt`; `SITE_URL`-derived absolute `<loc>`, so it is stable when the data is |
| `docs/report.json` | Machine-readable report (same data as the page) |
| `docs/report.schema.json` | JSON Schema for `report.json` |
| `docs/history/YYYY-MM-DD.json` | Daily snapshot (time series) |
| `docs/history/index.json` | Manifest listing all snapshots |
| `docs/benchmarks/<series>/<month>-<year>.json` | Parsed benchmark issues (backfilled on first run) |
| `docs/benchmarks/<series>/index.json` · `docs/benchmarks/index.json` | Benchmark manifests (per-series + registry) |
| `docs/tariffs/opencode-go.json` · `docs/tariffs/index.json` | Normalized OpenCode Go tariffs + manifest |
| `docs/refresh.json` | Refresh heartbeat (`checkedAt`, `everyHours`, `anchorHourUtc`, `generatedAt`) — rewritten every run, the one non-idempotent artifact; the page's freshness indicator reads it |
| `docs/profiles/measured.json` | Measured session profile (turns + per-turn tokens) + method/sample; the provenance behind the cost formula (hand-maintained, not generated) |
| `README.md` (auto section) | Rewrites between `<!-- AUTO-DATA -->` markers |
| `og-image.svg` | Open Graph image |
| `index.html` (root, dev only) | Local preview; gitignored |

All `docs/benchmarks/`, `docs/tariffs/` and `docs/history/` JSONs are public, machine-readable datasets the page links to — free to reuse with attribution. Do not hand-edit any generated file.

## Architecture (modules, layer by responsibility)

1. **Entry `opencode-benchmark.js`** — thin aggregator ("smart controller"): parses Go tariffs, refreshes the benchmark history cache, builds the effective pool, joins, computes, snapshots and renders from the ready data.
2. **`lib/price/opencode.js`** — standalone OpenCode Go pricing controller, fed by the provider's own documented model list (`https://opencode.ai/inference/go/v1/models`, 15s cap) — rates, cache rates, context tiers (`cost.text.input.overrides`), time-of-day multipliers and each model's monthly limit (`go.monthly_usage.go`) all arrive structured, so no HTML is scraped. `parseGoModels(payload)` → rows: one price point per line the page compares (base, `(> N tokens)` tier, and a `(Off-Peak)`/`(Peak)` pair for models whose price depends on the hour), with `modelId` taken straight from the API's `id` (never derived from the display name); `fetchGoRows()` → fetch + parse. `buildTariffDataset(goRows)` → provider-agnostic `{source, session, tariffs[]}` JSON. CLI: `node lib/price/opencode.js [--dir docs/tariffs] [--stdout]` (`. --stdout` shows version).
3. **`lib/bench/timetoact.js`** — standalone benchmark controller. `findBenchIssues(indexHtml)` enumerates ALL monthly issues from the index (URL pattern, no hardcoded month); `ensureBenchCache(dir)` snaps every issue to `docs/benchmarks/timetoact/<month>-<year>.json`. CLI: `node lib/bench/timetoact.js [--dir …] [--all]`.
4. **`lib/core/fetch.js`** — shared HTTP: browser-like headers, optional SOCKS, `extractTableFragments()` (the benchmark site embeds tables inside `<script>` tags).
5. **`lib/core/match.js`** — shared name matching: `normalize`, `benchDisplay`, Levenshtein with hard version/subtype filters; `buildBenchPool(issues)` keeps the NEWEST measurement per model name (newer issues override older ones); `join()` picks the best candidate (tiers OK/AMBIG/WEAK/NONE).
6. **`lib/core/pipeline.js`** — shared math + history: session cost over a named measured profile (`PROFILES.agentic` = 147 turns × per-turn 5,649 input + 120,424 cache-read + 137 cache-write + 728 output; method in `docs/profiles/measured.json`), `sessionCostSplit`, mp = price/usage × 100 000, `sessionsPerMonth`, `sanityCheck`, `buildReport` (marks rows matched from an older issue as `benchmarkFallback`), `reportToJson`, daily snapshots + change detection.
7. **`lib/core/render.js`** — pure presentation over the persisted report JSON (same object that becomes `docs/report.json`): `renderHtml` (inline CSS/JS, dark mode, sortable tables, SEO metadata, "Top movers" client cache). The page data is the only input, so the renderer can later be swapped for another SSG. Client-side ⚡ Peak/Off-Peak badges convert `data-peak` JSON to the visitor's timezone via `Intl` (fallback `Europe/Moscow`); each badge reflects its row's own `variant` (`peak`/`off`) so the (Peak)/(Off-Peak) pair counts down in antiphase, and weekends are Off-Peak. "Top movers" fetches history JSONs and computes 1/7/30-day deltas. **"Recent changes"** is rendered server-side from `loadRecentChanges()` (the newest change-bearing snapshots, newest first) and sits next to the 1-day "What changed" diff — so a critical event (removed model, price jump) stays visible after the day it happened instead of vanishing.

Adding a new source (another benchmark series or tariff provider) later = a new `lib/<kind>/<name>.js` parser + feeding its normalized JSON into the existing pool/join/readme/report machinery — no changes to core.

### Backfill rule
Issues of a series are cached forever (first run fetches every one). The NEWEST issue is re-fetched on every run (mid-month measurements). Behind the scenes every cached issue keeps its old JSON until a fresh parse of the latest verifies it; an issue whose fresh parse looks broken (<10 rows, different table markup) silently keeps its cached copy or is skipped with a `[bench]` warning.

### Idempotent writes & sparse history
Every artifact (JSON, HTML, SVG, README auto section) is written only when its **data** actually changed. Volatile timestamps (`updated`/`generatedAt`/`savedAt`) are stripped before the comparison, so a run with identical numbers leaves the working tree byte-identical. The log is the contract:
- `[write] <file>` — data changed, file rewritten;
- `[skip] <file> (unchanged)` — same data, file kept as-is;
- `[write] <file> (heartbeat)` — `docs/refresh.json`, the **sole** non-idempotent artifact (OB-DATA-14): rewritten every run so the page can say "checked N ago". Its `checkedAt` is deliberately NOT embedded in `docs/index.html` (that would rewrite the page every run) — the client fetches the file. CI excludes it from the data-change test and commits it on its own;
- `FATAL: …` — fetch/parse broke (sanityCheck), nothing was touched. A failed run leaves `refresh.json` untouched, so its age grows — that *is* the failure signal, no separate alert needed.

Daily history snapshots are sparse: a day whose report equals the previous snapshot adds **no** new `docs/history/YYYY-MM-DD.json` (the skip is logged). "Top movers" compares the snapshots that exist, and the server-side "Recent changes" timeline (`loadRecentChanges`) lists the last change-bearing snapshots, so an event stays visible after the day it happened.

## Data sources & APIs

Everything is fetched live; none of the read-only sources below needs a key.

- **Go model list (JSON, no auth) — the tariff source of truth** — `https://opencode.ai/inference/go/v1/models` (OpenAI-shaped `{object:"list", data:[…]}`). Each item carries what the page publishes and more: `name`, per-1M-token `cost.text.{input,output}.price` + `cost.text.input.cache.{read,write}`, context tiers (`cost.text.input|output.overrides[]` with `when.context.gt`), `cost.multipliers[]` (weekly `utc_days`/`utc_hours` windows = the Peak/Off-Peak pair, `date` windows = scheduled price changes), and `go.monthly_usage.{go,go-plus,go-teams}` — the monthly limit per plan, in dollars. `cache.write` is either a plain rate or a TTL map (`{"30m":0.125,"12h":0.25}`); we publish the shortest TTL. The docs page (`https://opencode.ai/docs/console/go/`) links here for "Go's monthly usage limits" and no longer renders a tariff table at all.
- **Docs pages** — `https://opencode.ai/docs/console/go/` and `…/console/models/` (the latter has the model/ID/endpoint table and a *deprecation table* — useful for explaining why a model vanished, never parsed). Both are also served as raw markdown (`…/go.md`, `…/models.md`).
- **Canonical pricing registry** — `https://models.dev/api.json` (provider `opencode-go`, `api: https://opencode.ai/zen/go/v1`, 36 models with `cost {input,output,cache_read,cache_write}`, `limit`, `reasoning`). This is the source **OpenCode itself** uses for cost: the `opencode` binary embeds a models.dev snapshot and can refresh it (`opencode models --refresh`; `OPENCODE_DISABLE_MODELS_FETCH` disables the fetch). Caveats if we ever consume it: one price per model (no peak/off-peak, no `>N tokens` tiers), no quota, and small divergences from the page (e.g. MiniMax M2.5 `cache_read` 0.03 vs 0.06; MiniMax M2.5/M2.7 `cache_write` 0.375 missing). It also lists 8 ids that are not priced on the page (grok-4.5, glm-5, kimi-k2.5, mimo-v2-pro/omni, qwen3.5-plus, omen-alpha, ox-alpha-free).
- **OpenCode server Swagger** — `https://opencode.ai/openapi.json` (OpenAPI 3.1, 162 paths): `/provider`, `/config/providers`, and the `Model.cost` schema `{input, output, cache:{read,write}, tiers[], context_over_200k{}}`. That is the **server** API (what the SDK's `client.config.providers()` calls), not the Zen gateway.
- **How OpenCode computes price** — not from response headers: it multiplies the response-body `usage` tokens by the model's `cost` (from models.dev) and stores the result in `AssistantMessage.cost` / `StepFinishPart.cost`. Response headers are for session tracking (`x-opencode-session`).

## Gotchas

- **Live data only** — script always fetches from `opencode.ai` and `timetoact-group.at`. No offline/cached mode. If either site is down or returns a captcha, `sanityCheck()` (`lib/core/pipeline.js`) aborts and the previous `docs/index.html` is preserved.
- **Sanity check** — expects ≥10 Go models and ≥50 benchmark rows (of the NEWEST issue). If parsing returns less, the run fails with `FATAL:` error, no files are overwritten.
- **`modelId` is exact, never guessed** — it is the API's own `id` for the row, so the two data sources cannot disagree. Synthesized rows (tiers, peak pairs) inherit their model's id.
- **Peak pricing comes from `cost.multipliers`, not from prose** — a weekly multiplier (`when.utc_days.in` + `when.any[].all[].utc_hours`) publishes the `(Off-Peak)` row at the API price and the `(Peak)` row at `price × factor`, both carrying `peakHours {tz, days, ranges}`. Note the API puts the two hour bounds in *separate* `all` conditions (`{gte}` and `{lt}`), so a branch must be read as a conjunction across its items — reading `gte`+`lt` from one item silently yields zero windows. A `date` multiplier (e.g. Gemini 4 Argon `≥ 2026-12-01`, factor 2) is a scheduled price change: it is applied to the rates only while it is in force, never rendered as a peak window. Unmodelled promo *annotations* are gone with the scraped table — the API price is the price charged now (that is why Gemini 4 Argon dropped from the pre-discount 4.002 to the actual 2).
- **Vendor display names are cosmetic** — the API's `name` may gain a build suffix ("DeepSeek V4.1 Flash 1017") or a hyphen ("GPT-6 Luna", "MiniMax-M3"). `normalize()` treats hyphens as spaces, and `join()` prefers a measured name that is fully contained in ours (the build-suffix case) over a merely similar rival; an identical name still wins. Do not "fix" names by hand.
- **Benchmark history & backfill** — old issues are parsed once and cached forever in `docs/benchmarks/timetoact/`; the newest issue is refreshed every run. Rows are pooled per model name with "newest measurement wins", so a tariff matched only from an older issue gets `benchmarkFallback: true` + a "from Month YYYY" note on the page. Old issues with different markup can be skipped with a `[bench]` warning (0 rows, e.g. `january-2025` is really a price table, `april-2025` lacks the `final` column). **TIMETOACT has never measured MiMo V2.5 / V2.5 Pro** in any cached issue — to get MiMo you need a second benchmark series (add `lib/bench/<series>.js`).
- **`npm run bench:fetch`/`price:fetch`** — run the parsers standalone (library + CLI). Useful for pre-populating caches in CI or adding a new series without a full `npm start`.
- **README auto section** — `<!-- AUTO-DATA -->` and `<!-- /AUTO-DATA -->` markers must exist in `README.md`. Manual text outside these markers is preserved. Do not edit the auto section by hand; it is regenerated.
- **Windows** — use `npm run pages:win` for the `PAGES=1` env var (`set PAGES=1&& node opencode-benchmark.js`). PowerShell doesn't support inline env vars like Unix shells.
- **`index.html` in root is gitignored** — only `docs/index.html` is committed. The root copy is for local dev preview.
- **CI workflow exists** — `.github/workflows/update-pages.yml` runs every 6 h (00/06/12/18 UTC) and on `workflow_dispatch`: `npm ci && npm start` with `PAGES=1`. It then makes two commits: a data commit only when `git status docs README.md` is non-empty **excluding `docs/refresh.json`**, and an always-on `chore: heartbeat` commit for the heartbeat file (OB-DATA-14) — so a no-data-change run still advances the page's "checked N ago". It pushes whenever either commit happened (`nothing to push` when neither did). `SITE_URL` wins from the repo variable (`vars.SITE_URL`); when that is empty the workflow derives it from the repository itself (`https://<owner>.github.io/<repo>`), so the page never falls back to relative canonical/OG/JSON-LD URLs — a fork or a rename keeps pointing at its own origin.
- **Canonical origin is a build fact, not a runtime discovery** — `lib/core/site.js` owns it; the renderer, `report.json`'s `$schema`/`generator.page`, `report.schema.json`'s `$id` and `docs/sitemap.xml` all derive from it. Never emit a relative `rel="canonical"`, JSON-LD `@id`/`url` or `<loc>`: a relative canonical is not a canonical, and Search Console ignores it. `getSiteUrl()` lowercases the host, so the CI's `Krivich` owner spelling and the lowercase default yield the same string (otherwise local and CI runs would rewrite each other's canonical every time). `tools/check-seo`-style validation is not wired yet — the check is `grep` on `docs/index.html` for `rel="canonical"` after a run.
- **Docs page keeps moving; the API does not** — the Go docs went `/docs/en/go` → `/v2/docs/console/go/` → `/docs/console/go/`, and in November 2026 the tariff table disappeared from the page entirely (it now points at the model list API for monthly limits). Each move used to kill the pipeline with `FATAL: Go table looks wrong: only 0 models` while the heartbeat went stale — that staleness *is* the failure signal. Since then the price parser reads the JSON model list, so a docs reshuffle is not a data-source change; if a run fails with `FATAL: Go model list …`, check the API before suspecting the docs.
- **Local fetch may hang** — on some networks `timetoact-group.at` stalls mid-body (HTTP 200, never finishes). If `npm start` dies with `FATAL: terminated`, set `SOCKS=socks5h://127.0.0.1:1080` (or your proxy) and re-run. GitHub runners fetch directly and are unaffected.
- **Top movers needs old snapshots** — the client-side movers table compares against `docs/history/*.json`; snapshots are sparse (only days whose data changed), and with fewer than two snapshots it shows an empty-state message (no crash).
