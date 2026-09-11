// lib/core/write.js
// Idempotent file writes for every generated artifact. A file is rewritten ONLY when
// its data actually changed — volatile meta timestamps (updated/generatedAt/savedAt)
// are stripped before comparing, so "a fresh run with the same numbers" leaves the
// repo byte-identical and CI can skip the commit.
//
// Every CLI and the aggregator write through these helpers and log either
//   [write] <file>                    — data changed, the file was rewritten
//   [skip]  <file> (unchanged)        — same data, the existing file is kept as-is
// An all-`[skip]` run is the "nothing changed" signal; a FATAL abort is the
// "something broke" signal. No ambiguous silence in the logs.

import fs from 'node:fs';
import path from 'node:path';

const META_KEYS = new Set(['updated', 'generatedAt', 'savedAt']);

// Deep copy of a JSON-ish value with meta-only keys removed.
export function stripMeta(v) {
  if (Array.isArray(v)) return v.map(stripMeta);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (META_KEYS.has(k)) continue;
      out[k] = stripMeta(v[k]);
    }
    return out;
  }
  return v;
}

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// True when the JSON already on disk carries exactly the same data as `obj`
// (volatile meta fields ignored).
export function jsonEqualsDisk(file, obj) {
  const disk = readJsonSafe(file);
  if (disk == null) return false;
  return JSON.stringify(stripMeta(disk)) === JSON.stringify(stripMeta(obj));
}

const jsonString = (obj) => JSON.stringify(obj, null, 2) + '\n';

export function writeJsonIfChanged(file, obj) {
  if (jsonEqualsDisk(file, obj)) {
    console.log(`[skip] ${file} (unchanged)`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonString(obj), 'utf8');
  console.log(`[write] ${file}`);
  return true;
}

export function writeTextIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) {
      console.log(`[skip] ${file} (unchanged)`);
      return false;
    }
  } catch {
    // file missing → write it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  console.log(`[write] ${file}`);
  return true;
}