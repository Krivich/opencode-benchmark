// tools/render-from-report.mjs
// Re-render docs/index.html from the report and history already on disk — no network.
//
// The page is a pure function of docs/report.json + docs/history/, so a change to the
// renderer can be published without refetching both upstream sites. That matters when the
// benchmark host stalls mid-body on this network (see AGENTS.md, "Local fetch may hang"):
// `npm start` then dies at the fetch and the page would otherwise wait for CI.
// This writes ONLY the HTML; data files are never touched, and the next `npm start` or CI
// run produces byte-identical output from the same data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtml } from '../lib/core/render.js';
import { loadRecentChanges } from '../lib/core/pipeline.js';
import { writeTextIfChanged } from '../lib/core/write.js';

const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const report = JSON.parse(fs.readFileSync(path.join(docsDir, 'report.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'history', 'index.json'), 'utf8'));
const recentChanges = loadRecentChanges(docsDir, manifest.snapshots, 5);

writeTextIfChanged(
  path.join(docsDir, 'index.html'),
  renderHtml(report, { history: manifest.snapshots, recentChanges }),
);
