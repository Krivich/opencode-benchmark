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
- `SITE_URL=https://example.com` — sets canonical URL / OG metadata in generated HTML.

| File | Purpose |
|------|---------|
| `docs/index.html` | Main page (GitHub Pages serves from `docs/`) |
| `docs/report.json` | Machine-readable report (same data as the page) |
| `docs/report.schema.json` | JSON Schema for `report.json` |
| `docs/history/YYYY-MM-DD.json` | Daily snapshot (time series) |
| `docs/history/index.json` | Manifest listing all snapshots |
| `docs/benchmarks/<series>/<month>-<year>.json` | Parsed benchmark issues (backfilled on first run) |
| `docs/benchmarks/<series>/index.json` · `docs/benchmarks/index.json` | Benchmark manifests (per-series + registry) |
| `docs/tariffs/opencode-go.json` · `docs/tariffs/index.json` | Normalized OpenCode Go tariffs + manifest |
| `README.md` (auto section) | Rewrites between `<!-- AUTO-DATA -->` markers |
| `og-image.svg` | Open Graph image |
| `index.html` (root, dev only) | Local preview; gitignored |

All `docs/benchmarks/`, `docs/tariffs/` and `docs/history/` JSONs are public, machine-readable datasets the page links to — free to reuse with attribution. Do not hand-edit any generated file.

## Architecture (modules, layer by responsibility)

1. **Entry `opencode-benchmark.js`** — thin aggregator ("smart controller"): parses Go tariffs, refreshes the benchmark history cache, builds the effective pool, joins, computes, snapshots and renders from the ready data.
2. **`lib/price/opencode.js`** — standalone OpenCode Go pricing controller. `parseGo(html)` → rows + peak/off-peak notes (DeepSeek, `Peak hours are … UTC, Monday through Friday`); `fetchModelIds()`/`attachModelIds()` resolve each tariff's `provider` + `modelId` by exact match against the provider's own registry (`MODELS_URL`, 15s cap) — never a guessed id; on an endpoint outage the last published ids are kept (`readPrevModelIds`). `buildTariffDataset(goRows)` → provider-agnostic `{source, session, tariffs[]}` JSON. CLI: `node lib/price/opencode.js [--dir docs/tariffs] [--stdout]` (`. --stdout` shows version).
3. **`lib/bench/timetoact.js`** — standalone benchmark controller. `findBenchIssues(indexHtml)` enumerates ALL monthly issues from the index (URL pattern, no hardcoded month); `ensureBenchCache(dir)` snaps every issue to `docs/benchmarks/timetoact/<month>-<year>.json`. CLI: `node lib/bench/timetoact.js [--dir …] [--all]`.
4. **`lib/core/fetch.js`** — shared HTTP: browser-like headers, optional SOCKS, `extractTableFragments()` (the benchmark site embeds tables inside `<script>` tags).
5. **`lib/core/match.js`** — shared name matching: `normalize`, `benchDisplay`, Levenshtein with hard version/subtype filters; `buildBenchPool(issues)` keeps the NEWEST measurement per model name (newer issues override older ones); `join()` picks the best candidate (tiers OK/AMBIG/WEAK/NONE).
6. **`lib/core/pipeline.js`** — shared math + history: session cost (7,750 input + 147,250 cache-read + 300 output), mp = price/usage × 100 000, `sanityCheck`, `buildReport` (marks rows matched from an older issue as `benchmarkFallback`), `reportToJson`, daily snapshots + change detection.
7. **`lib/core/render.js`** — pure presentation over the persisted report JSON (same object that becomes `docs/report.json`): `renderHtml` (inline CSS/JS, dark mode, sortable tables, SEO metadata, "Top movers" client cache). The page data is the only input, so the renderer can later be swapped for another SSG. Client-side ⚡ Peak/Off-Peak badges convert `data-peak` JSON to the visitor's timezone via `Intl` (fallback `Europe/Moscow`); each badge reflects its row's own `variant` (`peak`/`off`) so the (Peak)/(Off-Peak) pair counts down in antiphase, and weekends are Off-Peak. "Top movers" fetches history JSONs and computes 1/7/30-day deltas. **"Recent changes"** is rendered server-side from `loadRecentChanges()` (the newest change-bearing snapshots, newest first) and sits next to the 1-day "What changed" diff — so a critical event (removed model, price jump) stays visible after the day it happened instead of vanishing.

Adding a new source (another benchmark series or tariff provider) later = a new `lib/<kind>/<name>.js` parser + feeding its normalized JSON into the existing pool/join/readme/report machinery — no changes to core.

### Backfill rule
Issues of a series are cached forever (first run fetches every one). The NEWEST issue is re-fetched on every run (mid-month measurements). Behind the scenes every cached issue keeps its old JSON until a fresh parse of the latest verifies it; an issue whose fresh parse looks broken (<10 rows, different table markup) silently keeps its cached copy or is skipped with a `[bench]` warning.

### Idempotent writes & sparse history
Every artifact (JSON, HTML, SVG, README auto section) is written only when its **data** actually changed. Volatile timestamps (`updated`/`generatedAt`/`savedAt`) are stripped before the comparison, so a run with identical numbers leaves the working tree byte-identical. The log is the contract:
- `[write] <file>` — data changed, file rewritten;
- `[skip] <file> (unchanged)` — same data, file kept as-is;
- `FATAL: …` — fetch/parse broke (sanityCheck), nothing was touched.

Daily history snapshots are sparse: a day whose report equals the previous snapshot adds **no** new `docs/history/YYYY-MM-DD.json` (the skip is logged). "Top movers" compares the snapshots that exist, and the server-side "Recent changes" timeline (`loadRecentChanges`) lists the last change-bearing snapshots, so an event stays visible after the day it happened.

## Data sources & APIs

Everything is fetched live; none of the read-only sources below needs a key.

- **Go price table (scraped)** — `https://opencode.ai/docs/en/go`. The only place with the **monthly quota** (`$60`/`$30`/`$15`), the peak/off-peak variants (DeepSeek) and the `≤/> N tokens` context tiers. The page also carries a `Model | Model ID | Endpoint | AI SDK Package` table documenting the base `https://opencode.ai/zen/go/v1/…` (`/chat/completions`, `/responses`) — that is where the official ids come from conceptually.
- **Model list (JSON, no auth)** — `https://opencode.ai/zen/go/v1/models` (Go; used by `fetchModelIds()`); the full Zen catalog is `https://opencode.ai/zen/v1/models`. OpenAI-shaped `{object:"list", data:[{id,…}]}`, used only to validate/attach `modelId`.
- **Canonical pricing registry** — `https://models.dev/api.json` (provider `opencode-go`, `api: https://opencode.ai/zen/go/v1`, 36 models with `cost {input,output,cache_read,cache_write}`, `limit`, `reasoning`). This is the source **OpenCode itself** uses for cost: the `opencode` binary embeds a models.dev snapshot and can refresh it (`opencode models --refresh`; `OPENCODE_DISABLE_MODELS_FETCH` disables the fetch). Caveats if we ever consume it: one price per model (no peak/off-peak, no `>N tokens` tiers), no quota, and small divergences from the page (e.g. MiniMax M2.5 `cache_read` 0.03 vs 0.06; MiniMax M2.5/M2.7 `cache_write` 0.375 missing). It also lists 8 ids that are not priced on the page (grok-4.5, glm-5, kimi-k2.5, mimo-v2-pro/omni, qwen3.5-plus, omen-alpha, ox-alpha-free).
- **OpenCode server Swagger** — `https://opencode.ai/openapi.json` (OpenAPI 3.1, 162 paths): `/provider`, `/config/providers`, and the `Model.cost` schema `{input, output, cache:{read,write}, tiers[], context_over_200k{}}`. That is the **server** API (what the SDK's `client.config.providers()` calls), not the Zen gateway.
- **How OpenCode computes price** — not from response headers: it multiplies the response-body `usage` tokens by the model's `cost` (from models.dev) and stores the result in `AssistantMessage.cost` / `StepFinishPart.cost`. Response headers are for session tracking (`x-opencode-session`).

## Gotchas

- **Live data only** — script always fetches from `opencode.ai` and `timetoact-group.at`. No offline/cached mode. If either site is down or returns a captcha, `sanityCheck()` (`lib/core/pipeline.js`) aborts and the previous `docs/index.html` is preserved.
- **Sanity check** — expects ≥10 Go models and ≥50 benchmark rows (of the NEWEST issue). If parsing returns less, the run fails with `FATAL:` error, no files are overwritten.
- **`modelId` is best-effort** — resolved against `https://opencode.ai/zen/go/v1/models` with a 15s cap; on an outage `readPrevModelIds()` carries the last published id per tariff name forward, so a transient failure never wipes `docs/tariffs/opencode-go.json` / `report.json` to null. A name that matches no official id stays `modelId: null` (honest, not guessed); the row's `provider` is the factual `opencode-go` namespace.
- **Benchmark history & backfill** — old issues are parsed once and cached forever in `docs/benchmarks/timetoact/`; the newest issue is refreshed every run. Rows are pooled per model name with "newest measurement wins", so a tariff matched only from an older issue gets `benchmarkFallback: true` + a "from Month YYYY" note on the page. Old issues with different markup can be skipped with a `[bench]` warning (0 rows, e.g. `january-2025` is really a price table, `april-2025` lacks the `final` column). **TIMETOACT has never measured MiMo V2.5 / V2.5 Pro** in any cached issue — to get MiMo you need a second benchmark series (add `lib/bench/<series>.js`).
- **`npm run bench:fetch`/`price:fetch`** — run the parsers standalone (library + CLI). Useful for pre-populating caches in CI or adding a new series without a full `npm start`.
- **README auto section** — `<!-- AUTO-DATA -->` and `<!-- /AUTO-DATA -->` markers must exist in `README.md`. Manual text outside these markers is preserved. Do not edit the auto section by hand; it is regenerated.
- **Windows** — use `npm run pages:win` for the `PAGES=1` env var (`set PAGES=1&& node opencode-benchmark.js`). PowerShell doesn't support inline env vars like Unix shells.
- **`index.html` in root is gitignored** — only `docs/index.html` is committed. The root copy is for local dev preview.
- **CI workflow exists** — `.github/workflows/update-pages.yml` runs daily (06:00 UTC) and on `workflow_dispatch`: `npm ci && npm start` with `PAGES=1`, then commits `docs/` + `README.md` back to main. Because writes are idempotent, a run where nothing actually changed leaves `git status` empty and the workflow skips the commit (`no changes — docs are up to date`, no push). `SITE_URL` comes from the repo variable (`vars.SITE_URL`); if empty, the generated HTML uses relative URLs — don't "fix" those by hand, the next CI run would overwrite them.
- **Local fetch may hang** — on some networks `timetoact-group.at` stalls mid-body (HTTP 200, never finishes). If `npm start` dies with `FATAL: terminated`, set `SOCKS=socks5h://127.0.0.1:1080` (or your proxy) and re-run. GitHub runners fetch directly and are unaffected.
- **Top movers needs old snapshots** — the client-side movers table compares against `docs/history/*.json`; snapshots are sparse (only days whose data changed), and with fewer than two snapshots it shows an empty-state message (no crash).
