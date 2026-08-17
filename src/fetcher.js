const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 4000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; BookmarkBrain/0.1; +https://bookmarkbrain.app)';

/**
 * True if two hostnames belong to the same site — equal, or one is a
 * subdomain of the other (bookmarkbrain.app vs www.bookmarkbrain.app vs
 * blog.bookmarkbrain.app all count). Deliberately not a full public-suffix
 * comparison; the point is just to distinguish "the site moved/normalized
 * its URL" from "this domain expired and now belongs to someone else."
 */
function sameSite(hostA, hostB) {
  const a = hostA.replace(/^www\./, '');
  const b = hostB.replace(/^www\./, '');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Fetches a bookmark's URL and extracts a compact text representation
 * (title, meta description, and a chunk of visible body text) suitable
 * for embedding. Never throws — returns { ok:false, error } on failure
 * so a dead link doesn't stall the whole import batch.
 */
async function fetchPageContent(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    // A redirect landing on a different site than the one bookmarked means
    // the original domain likely expired and now belongs to someone else
    // (parking pages, resold domains hijacking old URLs to point wherever
    // the new owner wants — including, in one observed real case, an old
    // CBS Interactive "site.com.com" shortener domain now 301-ing to an
    // unrelated Wikipedia article). Trusting that content would silently
    // embed/cluster the bookmark under whatever the hijacked domain now
    // serves. Safer to treat it as failed — same as any other dead link —
    // which already falls back to title-only embedding.
    try {
      const originalHost = new URL(url).hostname;
      const finalHost = new URL(res.url).hostname;
      if (!sameSite(originalHost, finalHost)) {
        return { ok: false, error: `Redirected to a different site (${finalHost}) — likely an expired/resold domain` };
      }
    } catch {
      // If either URL fails to parse, fall through and let the rest of
      // the function's own error handling deal with it.
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) {
      return { ok: false, error: `Unsupported content-type: ${contentType || 'unknown'}` };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Strip chrome that's shared across nearly every page on a site (nav,
    // footers, edit links, reference lists, infobox tables) — left in,
    // this noise dominates the extracted text and drowns out what the
    // page is actually about, especially on wikis and docs sites.
    $(
      [
        'script',
        'style',
        'noscript',
        'svg',
        'nav',
        'footer',
        'header',
        'aside',
        'form',
        'iframe',
        'table',
        '[role="navigation"]',
        '.navbox',
        '.infobox',
        '.metadata',
        '.mw-editsection',
        '.reflist',
        '.catlinks',
        '.toc',
        '.mw-jump-link',
        '.hatnote',
        '.ambox',
        'sup.reference',
      ].join(', ')
    ).remove();

    const pageTitle = $('title').first().text().trim().slice(0, 300);
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';

    let favicon =
      $('link[rel="icon"]').attr('href') ||
      $('link[rel="shortcut icon"]').attr('href') ||
      null;
    if (favicon) {
      try {
        favicon = new URL(favicon, url).href;
      } catch {
        favicon = null;
      }
    }

    // Prefer a real content container over the whole <body> when the page
    // has one — cuts out sidebars/menus that survive the removals above.
    const contentSelectors = ['#mw-content-text', 'article', 'main', '[role="main"]', '#content'];
    let $content = null;
    for (const sel of contentSelectors) {
      const found = $(sel).first();
      if (found.length && found.text().trim().length > 200) {
        $content = found;
        break;
      }
    }

    const bodyText = ($content || $('body'))
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT_CHARS);

    return {
      ok: true,
      pageTitle,
      description: description.slice(0, 500),
      text: bodyText,
      favicon,
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timed out' : err.message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs an async worker over a list of items with a bounded number of
 * concurrent in-flight calls. Calls onProgress after each item settles.
 */
async function mapWithConcurrency(items, limit, worker, onProgress) {
  let cursor = 0;
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    if (items.length === 0) return resolve();

    function next() {
      if (cursor >= items.length && active === 0) {
        return resolve();
      }
      while (active < limit && cursor < items.length) {
        const index = cursor++;
        active++;
        Promise.resolve(worker(items[index], index))
          .catch(() => {})
          .finally(() => {
            active--;
            completed++;
            if (onProgress) onProgress(completed, items.length);
            next();
          });
      }
    }
    next();
  });
}

module.exports = { fetchPageContent, mapWithConcurrency, FETCH_TIMEOUT_MS };
