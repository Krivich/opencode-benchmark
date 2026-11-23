# opencode-benchmark — Requirements

Source of truth: this file (design intent) + [AGENTS.md](AGENTS.md) (engineering map) + [README.md](README.md).
Every requirement has a **stable ID**.

> **Must:** every new or changed behavior is written down here (a new ID, or an updated one) **in the same change** — no silent features. If we built it, it is a requirement.

## How to keep this file

1. **IDs never change**: never rename, renumber, or delete them.
2. A new requirement → a new ID at the end of its group.
3. A dropped requirement → mark `DEPRECATED`, keep the ID.
4. The status/description is updated by the same change as the code.
5. Every group has its own prefix; the file is the single source of truth for *what* the project must do (AGENTS.md covers *how*).
6. **Record as you go**: any feature, fix, or behavior change gets captured here (status ✅/🟧/⬜) before/with the code — an undocumented behavior is treated as unfinished.

Statuses: ✅ implemented · 🟧 partial · ⬜ planned · ❓ concept (not directly verifiable)

Verification: there is no test suite. A change is verified by a clean `npm start` run plus an
idempotent re-run (second run must log `0 writes`, all `[skip]`).

---

## Architecture (OB-ARCH)

- ✅ **OB-ARCH-01**: `opencode-benchmark.js` is a thin aggregator ("smart controller"); all logic lives in `lib/`.
- ✅ **OB-ARCH-02**: Each source parser is an independent controller with a "library + thin CLI" interface (`lib/price/opencode.js`, `lib/bench/timetoact.js`).
- ✅ **OB-ARCH-03**: Shared core in `lib/core/` (`fetch`, `match`, `pipeline`, `render`, `write`) reused by every parser and the aggregator.
- ✅ **OB-ARCH-04**: Adding a new source (benchmark series or tariff provider) = a new `lib/<kind>/<name>.js` feeding normalized JSON into the existing pool/join/report machinery — no core changes.
- ✅ **OB-ARCH-05**: Rendering is a pure function over the persisted report JSON; the JSON is the interface, so the renderer can later be swapped for another SSG ("dumb renderer, smart controller", cf. ignition).

## Data & datasets (OB-DATA)

- ✅ **OB-DATA-01**: Live data only — always fetch from `opencode.ai` and `timetoact-group.at`; no offline/cached mode.
- ✅ **OB-DATA-02**: OpenCode Go tariffs are normalized to `docs/tariffs/opencode-go.json` (+ `index.json` manifest).
- ✅ **OB-DATA-03**: Benchmark history is cached as one JSON per issue under `docs/benchmarks/timetoact/<month>-<year>.json`.
- ✅ **OB-DATA-04**: The first run backfills **all** issues of a series, not just the newest.
- ✅ **OB-DATA-05**: The newest issue is re-fetched on every run; older issues are reused from cache.
- ✅ **OB-DATA-06**: An issue whose fresh parse looks broken (<10 rows / different markup) keeps its cached copy, or is skipped with a `[bench]` warning.
- ✅ **OB-DATA-07**: Issues the index page does not link but that exist at the stable URL pattern are appended from a curated list (`BENCH_ARCHIVES`), so a fresh clone backfills them too.
- ✅ **OB-DATA-08**: Every dataset is public and machine-readable, with manifests (`index.json`); the page links to them with a "free to reuse" note.
- ✅ **OB-DATA-09**: `docs/report.schema.json` documents `report.json` (and daily snapshots).
- ⬜ **OB-DATA-10**: A second benchmark series (e.g. one that measures MiMo) can be added so models absent from TIMETOACT are covered.
- ✅ **OB-DATA-12**: The measured session profile is published as a public artifact (`docs/profiles/measured.json`) with its method, sample size, distribution and reproduce steps — the numbers behind the cost formula are auditable, not buried in a constant.- ✅ **OB-DATA-13**: The report states the **real** monthly charge (`session.monthlySubscriptionUsd`, author-reported) beside the **virtual** pool (`monthlyPoolUsd`), so consumers can read `mp` as a share of what is actually billed. The virtual pool is never presented as a price (the hero shows `Plan $10/mo · up to ×6`), and the disclaimer records that $10 is the author's charge, not a scraped list price.
- ✅ **OB-DATA-11**: Every `report.json` row carries `provider` and the provider's authoritative `modelId` — taken directly from the pricing API's own `id` (synthesized tier/peak rows inherit it), so it is exact rather than name-matched. An id the provider does not publish never appears; consumers still fall back to their own matching, because absent is not proof the model is unavailable.
- ✅ **OB-DATA-14**: A refresh heartbeat is published as `docs/refresh.json` (`checkedAt`, `everyHours`, `anchorHourUtc`, plus the report's `generatedAt`). It is written on **every** run — the one deliberate exception to the idempotent-write contract (OB-IDEM-01) — so the page can show a truthful "checked N ago / numbers changed M ago / next check in T" and a stopped pipeline is visible as a stale heartbeat. It carries **no** report data, so it never counts as a data change; after a failed run it stays untouched (age grows), which is exactly the failure signal.

## Pipeline (OB-PIPE)

- ✅ **OB-PIPE-01**: `sanityCheck` before any write (≥10 Go tariffs, ≥50 rows in the newest benchmark issue); on failure it aborts with `FATAL:` and touches no files.
- ✅ **OB-PIPE-02**: The effective pool keeps the NEWEST measurement per model name (newer issues override older ones).
- ✅ **OB-PIPE-03**: A tariff matched only from an older issue is flagged `benchmarkFallback` and shows a "from Month YYYY" note.
- ✅ **OB-PIPE-04**: Session cost is `turns × perTurn` over a named **measured** profile (default `agentic`: 147 turns; per turn 5,649 input + 120,424 cache-read + 137 cache-write + 728 output). Handles all four token classes (incl. `cache_write`); `mp = price / quota × 100 000`; `sessionsPerMonth = quota / price`. Method/sample live in `docs/profiles/measured.json`.
- ✅ **OB-PIPE-06**: The session profile is measured, not assumed: it is derived from a local OpenCode store (aggregate token counts only), published as `docs/profiles/measured.json`, and labelled `agentic` (single-user autonomous workload), never "the typical session". Editing the profile is a deliberate, documented change.
- ✅ **OB-PIPE-05**: Matching is Levenshtein-based with hard version/subtype filters; confidence tiers OK / AMBIG / WEAK / NONE.

## Idempotent writes (OB-IDEM)

- ✅ **OB-IDEM-01**: A file is rewritten only when its data actually changed.
- ✅ **OB-IDEM-02**: Volatile timestamps (`updated`/`generatedAt`/`savedAt`) are stripped before comparison, so they never trigger a diff on their own.
- ✅ **OB-IDEM-03**: The log is the contract: `[write] <file>`, `[skip] <file> (unchanged)`, `[skip] <file> (no changes since snapshot …)`, `FATAL: …` — no ambiguous silence.
- ✅ **OB-IDEM-04**: Daily history snapshots are sparse: a day equal to the previous snapshot adds no new file.
- ✅ **OB-IDEM-05**: HTML/README embed the preserved `generatedAt` (the last real change), so a no-change run leaves them byte-identical.
- ✅ **OB-IDEM-06**: `docs/refresh.json` (the heartbeat, OB-DATA-14) is the **sole** exception: it is rewritten every run by design. Its `checkedAt` is deliberately **not** embedded in `docs/index.html` (that would rewrite the page every run); the client fetches the file instead, so every other artifact stays byte-identical on a no-op run. Its write is logged as `[write] … (heartbeat)` and CI excludes it from the data-change test.

## History & changes (OB-HIST)

- ✅ **OB-HIST-01**: Every change-bearing run stores a dated snapshot `docs/history/YYYY-MM-DD.json` plus a manifest.
- ✅ **OB-HIST-02**: "What changed" shows the 1-day diff against the previous snapshot.
- ✅ **OB-HIST-03**: "Recent changes" shows a timeline of the last few change-bearing snapshots (newest first), so a critical event (removed model, price jump) stays visible after the day it happened.
- ✅ **OB-HIST-04**: "Top movers" (client-side) computes 1/7/30-day deltas over the snapshots that exist.
- ✅ **OB-HIST-05**: A same-day re-run diffs against the previous **day's** snapshot (never against today's own file), so the day's change events are not erased by a self-diff and the run still converges to `[skip]`.

## Page & rendering (OB-RENDER)

- ✅ **OB-RENDER-01**: The page is generated purely from `report.json` (inline CSS/JS, dark mode, sortable tables, SEO metadata/JSON-LD).
- ✅ **OB-RENDER-02**: ⚡ Peak/Off-Peak badges convert the tariff's UTC windows to the visitor's timezone via `Intl` (fallback `Europe/Moscow`).
- ✅ **OB-RENDER-03**: Each badge reflects its own row's variant (`peak`/`off`), so the (Peak)/(Off-Peak) pair counts down in antiphase.
- ✅ **OB-RENDER-04**: Weekends are Off-Peak (peak windows are Mon–Fri as stated by OpenCode Go).
- ✅ **OB-RENDER-05**: The page links to the normalized tariff and benchmark datasets (header + footer).
- ✅ **OB-RENDER-06**: Fallback rows show a "from Month YYYY" note.
- ✅ **OB-RENDER-07**: ⚡ Peak/Off-Peak badges are shown in every table that lists models with peak pricing — the main tariffs table and the "Top: Score per mp" table.
- ✅ **OB-RENDER-08**: The peak countdown uses lettered units (`2h 05m`, `47m`, `1m`), never clock-like `HH:MM` — so "hours or minutes?" is never ambiguous.
- ✅ **OB-RENDER-09**: The main table makes the hidden variable visible: per-row `Input $/M`, `Cache-read $/M` and `Output $/M` columns (rates up to 4 decimals, trailing zeros trimmed), plus a per-row cost decomposition (% new input / % cache-read / % cache-write / % output) shown on the `$/session` cell; `session/mo` (how many average tasks fit the monthly pool) replaces the old request count; the `session/mp`/`session/mo`/`$/session` headers wrap to two lines so those columns stay narrow and the model-name column gets the width. (The mp column is labelled `mp/session` — the measured value is mp per session, and the header used to read `session/mp`.)
- ✅ **OB-RENDER-10**: Every data column header carries a native `title` tooltip (no icons) that explains what the field means and when it matters for the price or for comparing tariffs — an explanation, not a restatement of the label; tooltip texts must not contain double quotes (they are injected into `title="…"`).

- ✅ **OB-RENDER-11**: The headline multiplier column shows the **wallet** multiplier — `walletMultiplier` = quota ÷ actual charge (×6/×3/×1.5, how far the payment stretches in list-price work) — not the vendor's reciprocal (`multiplier` = 60 ÷ quota = 1×/2×/4×), which stays in the data labelled as the vendor scale. Outside the disclaimer and the JSON schema, user-facing copy says "plan", never "pool".
- ✅ **OB-RENDER-12**: The page shows a freshness indicator (client-side, from `docs/refresh.json`): "checked N ago · numbers changed M ago · next check in T", ticking every 30s. `checked` = last run (heartbeat), `changed` = `generatedAt`, `next check` computed on the UTC schedule grid (`everyHours` + `anchorHourUtc`). The status dot is green within ~1.5 intervals, amber past that, red past 3 — so a stopped updater is visible. With no heartbeat yet (file missing) it degrades to "numbers changed … · next check …".
- ✅ **OB-RENDER-13**: The `<head>` carries the Google Search Console ownership token (`<meta name="google-site-verification">`) **baked into the renderer**, not the artifact — the page is regenerated by every refresh, so a hand edit of `docs/index.html` would lose the token and silently break verification.
- ✅ **OB-RENDER-14**: Every absolute reference is emitted **unconditionally and absolutely**: `rel="canonical"`, `og:url`/`og:image`, `twitter:image` (card `summary_large_image`), JSON-LD `@id`/`url`, plus `report.json`'s `$schema`/`generator.page` and `report.schema.json`'s `$id`. The origin lives in one place (`lib/core/site.js`: `SITE_URL` env → deployment default), so a missing variable can no longer silently drop the whole group into relative form (the site was published without a canonical exactly because of that).
- ✅ **OB-RENDER-15**: `docs/sitemap.xml` is generated on every run: one `<url>` for the page with `<loc>` = canonical origin and `<lastmod>` = report `generatedAt` (so it only changes when the data does). It is linked from `<head>` via `rel="sitemap"` and is the file to submit in Search Console; `robots.txt` is deliberately absent — GitHub Pages project sites cannot own `/robots.txt` on the host root.
- ✅ **OB-RENDER-16**: The Dataset node carries what Dataset Search actually reads: `license` (MIT), `isAccessibleForFree`, and `distribution` — one `DataDownload` (`encodingFormat: application/json`) per public dataset (`report.json`, tariffs, benchmark issues, history snapshots). Title/description carry the searchable terms (`pricing`, `cost`) while the title keeps its question form for CTR.
- ✅ **OB-RENDER-17**: The favicon is a **crawlable raster** set, not an inline `data:` URI or SVG: `docs/favicon.ico` (16/32/48 frames), `docs/favicon-192.png`, `docs/apple-touch-icon.png`, referenced from `<head>` with `rel="icon"` / `rel="apple-touch-icon"`. Google accepts only BMP/GIF/ICO/PNG/JPEG/PPM/TIFF and must fetch the bytes with Googlebot-Image — a `data:` URI can never be fetched, and SVG is not in the accepted list, so the page used to show no icon at all. `og:image`/`twitter:image` are `og-image.png` for the same reason on the social side (Facebook/X/LinkedIn drop an SVG card). All four images are brand assets generated by `tools/make-brand-assets.ps1` and committed, not build output.
  - ⚠ Known host-level limit (accepted, not a bug to fix here): Google reads the favicon and the SERP **site name** only from the *hostname's* home page, and `https://krivich.github.io/` is a 404, so the result keeps the platform label "GitHub Pages" and may skip our icon. Site names are unsupported for subdirectory home pages, and the same hostname already serves a dozen other project sites — a root repo would impose one project's name/icon on all of them, so the project keeps its `github.io` URL. A project-specific name/icon needs its own hostname (custom domain + `docs/CNAME`; `SITE_URL` already carries the origin).
- ✅ **OB-RENDER-18**: `<title>` is identical to the `<h1>` and starts with the query ("OpenCode Go pricing: …"): Google replaces a differing `<title>` with the H1, and its rewrite dropped the words the page is found by. `meta description` states a finding from the current run (cheapest→priciest tariff for the identical measured session and the multiplier between them), not a promise to compare.
- ✅ **OB-RENDER-19**: The body opens with a computed **"Short answer"** paragraph right after the tagline — best score/mp tariff with its $/task and share of the plan, plus the cheapest and the priciest tariff for the same session — **and it opens with the benchmark's coverage**, not with the winner: `N of M` tariffs matched by name (✓), `K` are lookalikes (⚠), `L` were never measured (—). A "best value" claim whose numerator (score) exists only for the measured subset while its denominator (mp) exists for every tariff is a claim about that subset: ranking the cheapest-but-unmeasured tariffs as "worse" would turn *unknown* into *bad* — the exact opposite of the page's promise. The same count is spelled out in the tariff table legend. Google quotes on-page copy over the meta description whenever the copy answers the query more concretely, so the finding has to exist in the copy, not only in `<meta>`.
- ✅ **OB-RENDER-20**: The tariff table opens **sorted by `mp/session` ascending** (cheapest slice of the plan first); rows with no quota (free tiers) have no share to compare and are placed last. The header shows the active sort (`sorted`/`data-dir="asc"`), and the `#` column is renumbered on every re-sort, so it always means "row in the current order" — which is what its tooltip claims.

## Tariffs parser (OB-PRICE)

- ✅ **OB-PRICE-01**: Tariffs come from the provider's documented model list (`https://opencode.ai/inference/go/v1/models`), not from scraped docs HTML: `cost.text.{input,output}.price`, `cost.text.input.cache.{read,write}`, `go.monthly_usage.go` (the Go plan limit, in dollars) and the model's own `id`. A docs reshuffle therefore cannot zero the table — the November 2026 rewrite of the docs page (tariff table removed) broke the old scraper and is what forced this.
- ✅ **OB-PRICE-02**: Peak pricing is derived from `cost.multipliers`: a weekly `utc_days`/`utc_hours` factor publishes an `(Off-Peak)`/`(Peak)` row pair (same `modelId`, same quota) carrying `peakHours {tz, days, ranges}`; a `date` factor is a scheduled price change applied to the rates only while in force (never a peak window).
- ✅ **OB-PRICE-03**: `npm run price:fetch` refreshes only `docs/tariffs/` (flags `--dir`, `--stdout`).
- ✅ **OB-PRICE-04**: Context tiers (`cost.text.input|output.overrides[].when.context.gt`) are published as separate `(≤ N tokens)` / `(> N tokens)` rows so the price jump above the boundary is visible instead of hidden behind one row.
- ✅ **OB-PRICE-05**: A cache-write rate that the API gives per cache TTL (`{"30m": 0.125, "12h": 0.25}`) is published as the shortest TTL's rate; free models (`go: null`, rate 0) stay listed with a `0` quota so they remain visible but rank nowhere.

## Benchmark parser (OB-BENCH)

- ✅ **OB-BENCH-01**: Discover every monthly issue from the index page by URL pattern (no hardcoded month).
- ✅ **OB-BENCH-02**: Parse the benchmark table (Model / … / final / Cost / Speed).
- ✅ **OB-BENCH-03**: `npm run bench:fetch` refreshes only `docs/benchmarks/timetoact/` (flags `--dir`, `--all`).

## CI (OB-CI)

- ✅ **OB-CI-01**: A scheduled workflow runs `npm ci && npm start` with `PAGES=1` every 6 hours (00/06/12/18 UTC) plus manual dispatch.
- ✅ **OB-CI-02**: The workflow commits data only when `git status` for `docs/` + `README.md` is non-empty **excluding `docs/refresh.json`**; the heartbeat is committed on its own `chore: heartbeat` commit even when no data changed. It pushes whenever it has committed anything; an all-`[skip]` data run with an unchanged heartbeat still pushes nothing.
- ✅ **OB-CI-03**: `SITE_URL` comes from a repository variable; when it is empty the workflow derives the origin from the repository (`https://<owner>.github.io/<repo>`), so the build never publishes relative canonical/OG/JSON-LD URLs (OB-RENDER-14).

---

## Open questions

- OB-DATA-10 (second benchmark series) — needed to cover models TIMETOACT never measured (e.g. MiMo V2.5 / V2.5 Pro).
- Confirm the ID prefix (`OB-`) and group set; adjust once more sources/areas appear.
