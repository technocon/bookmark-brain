const db = require('./db');
const { embed, bufferToVector, cosineSimilarity, tokenize } = require('./embeddings');

// A "fallback" match is only backed by the saved title + folder (the page
// itself couldn't be fetched), so it's real but weaker evidence than a
// full-content match — discount it so equally-worded full matches win ties.
const FALLBACK_SCORE_PENALTY = 0.7;

/**
 * Semantic search: embeds the query the same way bookmarks were embedded,
 * ranks by cosine similarity, and adds a small keyword-overlap boost so
 * exact term matches (e.g. a distinctive proper noun) don't get buried
 * under purely vector-similar results.
 */
async function search(query, { limit = 30 } = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  const rows = db
    .prepare(
      `SELECT id, url, title, folder, page_title, page_description, favicon, embedding, cluster_id, status, fetch_error
       FROM bookmarks WHERE status IN ('fetched', 'fallback') AND embedding IS NOT NULL`
    )
    .all();

  if (rows.length === 0) return [];

  const { vector: queryVec } = await embed(trimmed);
  const queryTerms = new Set(tokenize(trimmed));

  const scored = rows.map((row) => {
    const vec = bufferToVector(row.embedding);
    const similarity = cosineSimilarity(queryVec, vec);
    const isFallback = row.status === 'fallback';

    const docTerms = new Set(
      tokenize([row.page_title || row.title, row.page_description].filter(Boolean).join(' '))
    );
    let overlap = 0;
    for (const t of queryTerms) if (docTerms.has(t)) overlap++;
    const keywordBoost = queryTerms.size ? (overlap / queryTerms.size) * 0.15 : 0;

    const rawScore = similarity + keywordBoost;

    return {
      id: row.id,
      url: row.url,
      title: row.page_title || row.title,
      folder: row.folder,
      description: row.page_description,
      favicon: row.favicon,
      clusterId: row.cluster_id,
      contentAvailable: !isFallback,
      fetchError: isFallback ? row.fetch_error : null,
      score: isFallback ? rawScore * FALLBACK_SCORE_PENALTY : rawScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { search };
