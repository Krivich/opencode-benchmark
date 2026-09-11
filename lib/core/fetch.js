// lib/core/fetch.js
// Shared HTTP dependency for every parser: browser-like fetching (with optional SOCKS
// proxy) and table extraction from raw HTML. Parser modules (price/, bench/) import
// these; nothing standalone here.
//
// SOCKS=socks5h://127.0.0.1:1080 routes requests through a proxy (lazy-loads
// socks-proxy-agent). Without it plain node fetch is used.

import https from 'node:https';
import zlib from 'node:zlib';
import { load as cheerioLoad } from 'cheerio';

const SOCKS = process.env.SOCKS;

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

export { cheerioLoad, fetchText, extractTableFragments, HTTP_HEADERS };