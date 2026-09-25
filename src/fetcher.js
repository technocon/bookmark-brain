const cheerio = require('cheerio');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { BlockedAddressError, assertSafeUrl, resolvePublicAddresses, safeLookup } = require('./ssrf-guard');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 4000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
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
 * One GET with no redirect following. The connection's DNS lookup is
 * safeLookup, which validates the resolved addresses and connects to exactly
 * the address it validated (no DNS-rebinding window). Resolves to
 * { status, headers, body } where body is a Buffer of the (decoded) response,
 * capped at MAX_BODY_BYTES, and only read for 2xx responses.
 */
function requestOnce(parsedUrl, signal) {
  return new Promise((resolve, reject) => {
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsedUrl,
      {
        method: 'GET',
        lookup: safeLookup,
        agent: false,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('text/html') && !contentType.includes('xml')) {
          res.destroy();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== 'identity') {
          res.destroy();
          return reject(new Error(`Unsupported content-encoding: ${enc}`));
        }
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy();
            return reject(new Error('Response too large'));
          }
          chunks.push(chunk);
        });
        stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', reject);
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
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
    // Redirects are followed by hand so every hop is validated as a public
    // address before we connect to it (a public URL can 302 to 127.0.0.1 or
    // 169.254.169.254). The pre-check gives a clean early error; safeLookup
    // re-validates and pins the IP at connect time.
    let currentUrl = url;
    let res;
    for (let hop = 0; ; hop++) {
      const parsed = assertSafeUrl(currentUrl);
      await resolvePublicAddresses(parsed.hostname);
      res = await requestOnce(parsed, controller.signal);
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      const location = res.headers.location;
      if (!isRedirect || !location) break;
      if (hop >= MAX_REDIRECTS) return { ok: false, error: 'Too many redirects' };
      currentUrl = new URL(location, currentUrl).href;
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const finalUrl = currentUrl;

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
      const finalHost = new URL(finalUrl).hostname;
      if (!sameSite(originalHost, finalHost)) {
        return { ok: false, error: `Redirected to a different site (${finalHost}) — likely an expired/resold domain` };
      }
    } catch {
      // If either URL fails to parse, fall through and let the rest of
      // the function's own error handling deal with it.
    }

    const contentType = res.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) {
      return { ok: false, error: `Unsupported content-type: ${contentType || 'unknown'}` };
    }

    const html = res.body.toString('utf8');
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
        favicon = new URL(favicon, finalUrl).href;
      } catch {
        favicon = null;
      }
    }

    // Preview image for the thumbnail cards: the page's own social-share
    // image. Kept only if it resolves to an absolute http(s) URL.
    let image =
      $('meta[property="og:image:secure_url"]').attr('content') ||
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[name="twitter:image:src"]').attr('content') ||
      null;
    if (image) {
      try {
        const resolved = new URL(image.trim(), finalUrl);
        image = /^https?:$/.test(resolved.protocol) && resolved.href.length <= 2000 ? resolved.href : null;
      } catch {
        image = null;
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
      image,
    };
  } catch (err) {
    // Node wraps a lookup-callback error in the request error; unwrap ours.
    if (err instanceof BlockedAddressError) return { ok: false, error: err.message };
    const message = err.name === 'AbortError' || err.code === 'ABORT_ERR' ? 'Timed out' : err.message;
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
