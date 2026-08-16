const crypto = require('node:crypto');

// ---------- provider selection ----------
// EMBEDDING_PROVIDER explicitly picks one ('local' | 'openai' | 'gemini').
// Left unset, auto-detect by whichever key is present — OpenAI checked
// first so an existing deployment that already had OPENAI_API_KEY set
// keeps behaving exactly as before this file supported multiple providers.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.7-flash';

function resolveProvider() {
  const explicit = (process.env.EMBEDDING_PROVIDER || '').toLowerCase();
  if (explicit === 'local' || explicit === 'openai' || explicit === 'gemini') return explicit;
  if (OPENAI_API_KEY) return 'openai';
  if (GEMINI_API_KEY) return 'gemini';
  return 'local';
}
const PROVIDER = resolveProvider();

/*
 * Adding another provider (e.g. Voyage AI, which Anthropic recommends for
 * embeddings — Claude itself has no embeddings API, it's a chat model, so
 * there's nothing to wire up under an "ANTHROPIC_API_KEY" here):
 *
 *   1. Add its API key + model env vars up top, next to the others.
 *   2. Add its name to resolveProvider()'s explicit/auto-detect checks.
 *   3. Write an async `voyageEmbed(text)` returning a Float32Array,
 *      following openAIEmbed/geminiEmbed below as a template.
 *   4. Add a case for it in embed() and (optionally) in
 *      maybeImproveLabelsWithLLM() in cluster.js if the provider also
 *      does chat completions for cluster-label polishing.
 *
 * One thing to know before switching providers on a deployment that
 * already has embedded bookmarks: old embeddings stay in whatever
 * dimensionality/space the previous provider produced. Search still
 * "works" against them (cosineSimilarity doesn't error on a mismatch),
 * but a query embedded by the new provider isn't meaningfully comparable
 * to documents embedded by the old one — you'd want to re-import or
 * re-embed existing bookmarks after switching, not just swap the key.
 */

const STOPWORDS = new Set(
  (
    'a an the and or but if then else for of to in on at by with without from into ' +
    'is are was were be been being this that these those it its as not no yes you your ' +
    'we our us they their them he she his her i my me do does did doing have has had ' +
    'will would shall should can could may might must about above after again against ' +
    'all am below between both down during each few further here how more most other ' +
    'over own same so some such than too very what when where which who whom why'
  ).split(/\s+/)
);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 30 && !STOPWORDS.has(t));
}

const LOCAL_DIMS = 512;

function hashToken(token) {
  const hash = crypto.createHash('md5').update(token).digest();
  const index = hash.readUInt32LE(0) % LOCAL_DIMS;
  const sign = hash.readUInt8(4) % 2 === 0 ? 1 : -1;
  return { index, sign };
}

/**
 * Local, dependency-free "embedding": a hashed, log-dampened bag-of-words
 * vector, L2-normalized. This is a lexical approximation, not a true
 * semantic model, but it requires no API key and works fully offline —
 * good enough to power search and clustering out of the box. Swapped out
 * automatically for a real provider once an API key is set (see PROVIDER).
 */
function localEmbed(text) {
  const vec = new Float32Array(LOCAL_DIMS);
  const tokens = tokenize(text);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);

  for (const [token, count] of counts) {
    const { index, sign } = hashToken(token);
    vec[index] += sign * (1 + Math.log(count));
  }

  // Also hash bigrams to capture a little word-order/phrase signal.
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = tokens[i] + '_' + tokens[i + 1];
    const { index, sign } = hashToken(bigram);
    vec[index] += sign * 0.5;
  }

  return normalize(vec);
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function openAIEmbed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Float32Array.from(json.data[0].embedding);
}

async function geminiEmbed(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini embeddings failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Float32Array.from(json.embedding.values);
}

function usingOpenAI() {
  return PROVIDER === 'openai';
}

function usingGemini() {
  return PROVIDER === 'gemini';
}

/** Whichever provider is active, for display (stats pill, startup log, etc). */
function activeProvider() {
  return PROVIDER;
}

/**
 * Builds the text blob to embed for a bookmark, weighting the title
 * (repeated) above the description and body so titles dominate matches.
 */
function buildEmbeddingText({ title, pageTitle, description, text }) {
  const bestTitle = pageTitle || title || '';
  return [bestTitle, bestTitle, description || '', (text || '').slice(0, 2000)].join('\n');
}

/**
 * Text to embed when the page itself couldn't be fetched (dead link,
 * paywall, bot-blocked, timeout, ...). Falls back to whatever the browser
 * bookmark record already carried — the saved title and the folder path
 * it was filed under — so the bookmark stays searchable/clusterable
 * instead of silently disappearing from the collection.
 */
function buildFallbackEmbeddingText({ title, folder }) {
  return [title, title, folder || ''].join('\n');
}

async function embed(text) {
  try {
    if (PROVIDER === 'openai') return { vector: await openAIEmbed(text), source: 'openai' };
    if (PROVIDER === 'gemini') return { vector: await geminiEmbed(text), source: 'gemini' };
  } catch (err) {
    // Fall back gracefully rather than failing the whole import.
    return { vector: localEmbed(text), source: 'local', warning: err.message };
  }
  return { vector: localEmbed(text), source: 'local' };
}

function vectorToBuffer(vec) {
  return Buffer.from(Float32Array.from(vec).buffer);
}

function bufferToVector(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  embed,
  buildEmbeddingText,
  vectorToBuffer,
  bufferToVector,
  cosineSimilarity,
  usingOpenAI,
  usingGemini,
  activeProvider,
  tokenize,
  buildFallbackEmbeddingText,
  LOCAL_DIMS,
  // exposed for cluster.js's label-polishing call
  OPENAI_API_KEY,
  OPENAI_CHAT_MODEL,
  GEMINI_API_KEY,
  GEMINI_CHAT_MODEL,
};
