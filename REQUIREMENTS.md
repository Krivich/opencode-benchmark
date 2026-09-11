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
- ✅ **OB-DATA-11**: Every `report.json` row carries `provider` and the provider's authoritative `modelId`, resolved **only** by exact match against the provider's own model list (`opencode.ai/zen/go/v1/models`, 15s cap). An unresolved name yields `modelId: null` - never a guessed id - and consumers fall back to their own matching (absence is not proof the model is unavailable). On an endpoint outage the last published id per tariff name is kept (no downgrade to null).

## Pipeline (OB-PIPE)

- ✅ **OB-PIPE-01**: `sanityCheck` before any write (≥10 Go tariffs, ≥50 rows in the newest benchmark issue); on failure it aborts with `FATAL:` and touches no files.
- ✅ **OB-PIPE-02**: The effective pool keeps the NEWEST measurement per model name (newer issues override older ones).
- ✅ **OB-PIPE-03**: A tariff matched only from an older issue is flagged `benchmarkFallback` and shows a "from Month YYYY" note.
- ✅ **OB-PIPE-04**: Session cost uses a fixed split (7,750 input + 147,250 cache-read + 300 output tokens); `mp = price / quota × 100 000`.
- ✅ **OB-PIPE-05**: Matching is Levenshtein-based with hard version/subtype filters; confidence tiers OK / AMBIG / WEAK / NONE.

## Idempotent writes (OB-IDEM)

- ✅ **OB-IDEM-01**: A file is rewritten only when its data actually changed.
- ✅ **OB-IDEM-02**: Volatile timestamps (`updated`/`generatedAt`/`savedAt`) are stripped before comparison, so they never trigger a diff on their own.
- ✅ **OB-IDEM-03**: The log is the contract: `[write] <file>`, `[skip] <file> (unchanged)`, `[skip] <file> (no changes since snapshot …)`, `FATAL: …` — no ambiguous silence.
- ✅ **OB-IDEM-04**: Daily history snapshots are sparse: a day equal to the previous snapshot adds no new file.
- ✅ **OB-IDEM-05**: HTML/README embed the preserved `generatedAt` (the last real change), so a no-change run leaves them byte-identical.

## History & changes (OB-HIST)

- ✅ **OB-HIST-01**: Every change-bearing run stores a dated snapshot `docs/history/YYYY-MM-DD.json` plus a manifest.
- ✅ **OB-HIST-02**: "What changed" shows the 1-day diff against the previous snapshot.
- ✅ **OB-HIST-03**: "Recent changes" shows a timeline of the last few change-bearing snapshots (newest first), so a critical event (removed model, price jump) stays visible after the day it happened.
- ✅ **OB-HIST-04**: "Top movers" (client-side) computes 1/7/30-day deltas over the snapshots that exist.

## Page & rendering (OB-RENDER)

- ✅ **OB-RENDER-01**: The page is generated purely from `report.json` (inline CSS/JS, dark mode, sortable tables, SEO metadata/JSON-LD).
- ✅ **OB-RENDER-02**: ⚡ Peak/Off-Peak badges convert the tariff's UTC windows to the visitor's timezone via `Intl` (fallback `Europe/Moscow`).
- ✅ **OB-RENDER-03**: Each badge reflects its own row's variant (`peak`/`off`), so the (Peak)/(Off-Peak) pair counts down in antiphase.
- ✅ **OB-RENDER-04**: Weekends are Off-Peak (peak windows are Mon–Fri as stated by OpenCode Go).
- ✅ **OB-RENDER-05**: The page links to the normalized tariff and benchmark datasets (header + footer).
- ✅ **OB-RENDER-06**: Fallback rows show a "from Month YYYY" note.
- ✅ **OB-RENDER-07**: ⚡ Peak/Off-Peak badges are shown in every table that lists models with peak pricing — the main tariffs table and the "Top: Score per mp" table.
- ✅ **OB-RENDER-08**: The peak countdown uses lettered units (`2h 05m`, `47m`, `1m`), never clock-like `HH:MM` — so "hours or minutes?" is never ambiguous.

## Tariffs parser (OB-PRICE)

- ✅ **OB-PRICE-01**: Parse the Go price table (Model / Input / Output / Cached Read / Cached Write / Usage).
- ✅ **OB-PRICE-02**: Parse Peak/Off-Peak notes (model list, UTC hour windows, optional weekday range) and attach them to the matching tariff rows.
- ✅ **OB-PRICE-03**: `npm run price:fetch` refreshes only `docs/tariffs/` (flags `--dir`, `--stdout`).

## Benchmark parser (OB-BENCH)

- ✅ **OB-BENCH-01**: Discover every monthly issue from the index page by URL pattern (no hardcoded month).
- ✅ **OB-BENCH-02**: Parse the benchmark table (Model / … / final / Cost / Speed).
- ✅ **OB-BENCH-03**: `npm run bench:fetch` refreshes only `docs/benchmarks/timetoact/` (flags `--dir`, `--all`).

## CI (OB-CI)

- ✅ **OB-CI-01**: A daily workflow (06:00 UTC) plus manual dispatch runs `npm ci && npm start` with `PAGES=1`.
- ✅ **OB-CI-02**: The workflow pushes only when `git status` for `docs/` + `README.md` is non-empty; an idempotent run commits nothing.
- ✅ **OB-CI-03**: `SITE_URL` comes from a repository variable; when empty the page uses relative URLs.

---

## Open questions

- OB-DATA-10 (second benchmark series) — needed to cover models TIMETOACT never measured (e.g. MiMo V2.5 / V2.5 Pro).
- Confirm the ID prefix (`OB-`) and group set; adjust once more sources/areas appear.
