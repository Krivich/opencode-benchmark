// lib/core/site.js
// The one place that knows where this site is published. Every absolute reference the
// build emits — canonical, og:url/og:image, Twitter image, JSON-LD @id/url, report.json's
// $schema/page, sitemap <loc> — comes from here.
//
// Why a default instead of "empty SITE_URL → relative URLs": a deployment cannot be
// discovered at runtime, so an unset variable used to silently drop the whole group
// (canonical included) from the published page. The canonical origin is a fact about
// the deployment, so it has a default; a fork or mirror overrides it with SITE_URL
// (CI derives it from the repository, see .github/workflows/update-pages.yml).

export const DEFAULT_SITE_URL = 'https://krivich.github.io/opencode-benchmark';

export const getSiteUrl = (env = process.env.SITE_URL) => (env || DEFAULT_SITE_URL).replace(/\/+$/, '');
