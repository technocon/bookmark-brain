const { bufferToVector } = require('./embeddings');

// Deliberately aggressive -- this only feeds a *suggestion* the user
// reviews before deleting anything, never an automatic merge, so erring
// toward catching more variants is the right tradeoff.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url',
  'yclid', 'spm', 'si',
]);

/**
 * Normalizes a URL for duplicate comparison: strips scheme, a leading
 * "www.", trailing slash, hash fragment, and known tracking params (sorted
 * remaining query params for stable comparison), so
 * "https://www.site.com/post/?utm_source=x" and "http://site.com/post"
 * canonicalize to the same key.
 */
function canonicalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
    params.sort(([a], [b]) => a.localeCompare(b));
    const query = params.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function unitVector(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

// Cosine similarity above this is treated as "same content, different
// URL" -- high on purpose (near-identical, not just topically related;
// clustering already handles "related", this is specifically for "you
// bookmarked the same thing twice"). Two unit vectors' dot product IS
// their cosine similarity, so the pairwise scan below is just dot().
const SEMANTIC_THRESHOLD = 0.97;

// Yield to the event loop periodically during the O(n^2) pairwise scan --
// for a few thousand bookmarks this is tens of millions of comparisons,
// easily tens of seconds of pure CPU work, which would otherwise block
// every other request on this (single-threaded) server for the duration.
const YIELD_EVERY_N_COMPARISONS = 200_000;
function maybeYield(counter) {
  return counter % YIELD_EVERY_N_COMPARISONS === 0
    ? new Promise((resolve) => setImmediate(resolve))
    : null;
}

/**
 * Union-find over one dimension-bucket of {id, vector} entries, linking
 * any pair at/above SEMANTIC_THRESHOLD. Only ever called with vectors that
 * share a dimensionality -- comparing embeddings from different providers
 * (e.g. before/after a provider switch) is numerically meaningless, not
 * just imprecise, same reasoning as cluster.js's dimension grouping.
 */
async function findSemanticGroups(bucket) {
  const parent = new Map(bucket.map((b) => [b.id, b.id]));
  function find(id) {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const bestSimilarity = new Map();
  let comparisons = 0;

  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      const sim = dot(bucket[i].vector, bucket[j].vector);
      if (sim >= SEMANTIC_THRESHOLD) {
        union(bucket[i].id, bucket[j].id);
        const root = find(bucket[i].id);
        bestSimilarity.set(root, Math.max(bestSimilarity.get(root) || 0, sim));
      }
      comparisons++;
      const yielded = maybeYield(comparisons);
      if (yielded) await yielded;
    }
  }

  const byRoot = new Map();
  for (const b of bucket) {
    const root = find(b.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(b.id);
  }

  const groups = [];
  for (const [root, ids] of byRoot) {
    if (ids.length < 2) continue;
    groups.push({ reason: 'semantic', similarity: bestSimilarity.get(root), bookmarkIds: ids });
  }
  return groups;
}

/**
 * Finds groups of likely-duplicate bookmarks in one collection: exact
 * canonical-URL matches (similarity 1, "url-variant") plus near-identical
 * embeddings among whatever's left ("semantic" -- the same content saved
 * under two genuinely different URLs). `bookmarks` needs {id, url, status,
 * contentLength, embedding} per row.
 *
 * The semantic pass only considers 'fetched' bookmarks with a reasonable
 * amount of real page text, not 'fallback' ones or thin/empty pages.
 * Verified against a real 3,387-bookmark collection: without this,
 * generic or content-poor pages (three different Reddit threads that all
 * failed to fetch and got saved under the tab title "Reddit"; login
 * walls; JS-only pages our fetcher can't render, leaving barely any
 * extracted text) embed near-identically regardless of what they
 * actually are, and get flagged as "same content" duplicates when
 * they're just thin. A short/generic text blob doesn't carry enough
 * distinguishing signal for the embedding to mean "this is the same
 * content" -- that's true of the local hashed embedder especially, but
 * not exclusively, so this filters by content length rather than by
 * provider. URL-variant matching still covers thin/fallback bookmarks
 * fine, since that's pure string comparison with no embedding involved.
 */
const MIN_CONTENT_LENGTH_FOR_SEMANTIC = 200;

async function findDuplicateGroups(bookmarks) {
  const groups = [];
  const alreadyGrouped = new Set();

  const byCanonicalUrl = new Map();
  for (const b of bookmarks) {
    const key = canonicalizeUrl(b.url);
    if (!byCanonicalUrl.has(key)) byCanonicalUrl.set(key, []);
    byCanonicalUrl.get(key).push(b.id);
  }
  for (const ids of byCanonicalUrl.values()) {
    if (ids.length < 2) continue;
    groups.push({ reason: 'url-variant', similarity: 1, bookmarkIds: ids });
    for (const id of ids) alreadyGrouped.add(id);
  }

  const remaining = bookmarks.filter(
    (b) =>
      !alreadyGrouped.has(b.id) &&
      b.embedding &&
      b.status === 'fetched' &&
      (b.contentLength || 0) >= MIN_CONTENT_LENGTH_FOR_SEMANTIC
  );
  const byDimension = new Map();
  for (const b of remaining) {
    const vec = unitVector(bufferToVector(b.embedding));
    const dim = vec.length;
    if (!byDimension.has(dim)) byDimension.set(dim, []);
    byDimension.get(dim).push({ id: b.id, vector: vec });
  }

  for (const bucket of byDimension.values()) {
    if (bucket.length < 2) continue;
    const semanticGroups = await findSemanticGroups(bucket);
    groups.push(...semanticGroups);
  }

  return groups;
}

module.exports = { canonicalizeUrl, findDuplicateGroups };
