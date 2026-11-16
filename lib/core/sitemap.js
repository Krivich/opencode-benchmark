// lib/core/sitemap.js
// docs/sitemap.xml: the one HTML page the build produces, with its last-modified stamp.
//
// The site is a single document (the history tables live inside it; /history/ holds JSON
// datasets, not pages), so the sitemap is genuinely one entry — the point of publishing it
// is not discovery of many pages but a machine-readable "this page changed at T" that
// Search Console can consume.
//
// <changefreq>/<priority> are deliberately absent: Google ignores both, and a claim nobody
// reads is worse than no claim.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderSitemap({ siteUrl, lastmod }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${esc(`${siteUrl}/`)}</loc>
    <lastmod>${esc(lastmod)}</lastmod>
  </url>
</urlset>
`;
}
