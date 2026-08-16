const { bufferToVector, cosineSimilarity, tokenize, usingOpenAI } = require('./embeddings');

function pickK(n) {
  if (n <= 6) return Math.max(1, Math.min(n, 2));
  // ~sqrt(n/1.5) so a 4,000-bookmark collection (the scale this product
  // targets) lands around 50 clusters instead of topping out at a couple
  // dozen — small collections still get a handful of coarse groups.
  const k = Math.round(Math.sqrt(n / 1.5));
  return Math.max(3, Math.min(k, 60));
}

function dist(a, b) {
  // Vectors are L2-normalized, so this is monotonic with cosine distance.
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function kmeansPlusPlusInit(vectors, k, rng) {
  const centroids = [];
  const first = vectors[Math.floor(rng() * vectors.length)];
  centroids.push(Float32Array.from(first));

  while (centroids.length < k) {
    const distances = vectors.map((v) => {
      let min = Infinity;
      for (const c of centroids) min = Math.min(min, dist(v, c));
      return min;
    });
    const total = distances.reduce((a, b) => a + b, 0);
    if (total === 0) {
      centroids.push(Float32Array.from(vectors[Math.floor(rng() * vectors.length)]));
      continue;
    }
    let threshold = rng() * total;
    let chosen = vectors[0];
    for (let i = 0; i < vectors.length; i++) {
      threshold -= distances[i];
      if (threshold <= 0) {
        chosen = vectors[i];
        break;
      }
    }
    centroids.push(Float32Array.from(chosen));
  }
  return centroids;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simple k-means over L2-normalized vectors, seeded deterministically so
 * re-clustering the same import is reproducible.
 */
function kmeans(vectors, k, { maxIterations = 25, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  let centroids = kmeansPlusPlusInit(vectors, k, rng);
  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist(vectors[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }

    const dims = vectors[0].length;
    const sums = Array.from({ length: k }, () => new Float64Array(dims));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      const s = sums[c];
      for (let d = 0; d < dims; d++) s[d] += v[d];
    }

    centroids = centroids.map((old, c) => {
      if (counts[c] === 0) return old;
      const out = new Float32Array(dims);
      for (let d = 0; d < dims; d++) out[d] = sums[c][d] / counts[c];
      return out;
    });

    if (!changed) break;
  }

  return { assignments, centroids };
}

/**
 * Labels a cluster using terms that are frequent inside the cluster but
 * rare outside it (a cheap TF-IDF-ish contrast score), so labels read as
 * "Python Data Tooling" rather than generic words shared by everything.
 */
function labelClusters(bookmarks, assignments, k) {
  const clusterDocs = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => clusterDocs[c].push(bookmarks[i]));

  const globalDf = new Map();
  const perClusterTf = Array.from({ length: k }, () => new Map());

  for (let c = 0; c < k; c++) {
    const seenGlobal = new Set();
    for (const bm of clusterDocs[c]) {
      // Title carries the most signal but many sites (Wikipedia included)
      // ship no meta description, so fold in a slice of body text too —
      // otherwise labeling degenerates to whatever's in "X - SiteName".
      const title = bm.page_title || bm.title;
      const text = [title, title, bm.page_description, (bm.page_text || '').slice(0, 600)]
        .filter(Boolean)
        .join(' ');
      const tokens = tokenize(text);
      const tf = perClusterTf[c];
      const seenInDoc = new Set();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
        if (!seenInDoc.has(t)) {
          seenInDoc.add(t);
          if (!seenGlobal.has(t)) {
            seenGlobal.add(t);
            globalDf.set(t, (globalDf.get(t) || 0) + 1);
          }
        }
      }
    }
  }

  const totalDocs = bookmarks.length || 1;
  const labels = [];

  for (let c = 0; c < k; c++) {
    const tf = perClusterTf[c];
    const scored = [...tf.entries()]
      .map(([term, count]) => {
        const df = globalDf.get(term) || 1;
        const idf = Math.log((totalDocs + 1) / df);
        return { term, score: count * idf };
      })
      .sort((a, b) => b.score - a.score)
      .filter((t) => t.term.length > 2)
      .slice(0, 5);

    const topTerms = scored.map((s) => s.term);
    const label = topTerms.length
      ? topTerms
          .slice(0, 3)
          .map((t) => t[0].toUpperCase() + t.slice(1))
          .join(' · ')
      : `Cluster ${c + 1}`;

    labels.push({ label, terms: topTerms, size: clusterDocs[c].length });
  }

  return labels;
}

async function maybeImproveLabelsWithLLM(labels, clusterDocs) {
  if (!usingOpenAI()) return labels;
  const { OPENAI_API_KEY } = process.env;
  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

  try {
    const clustersForPrompt = labels.map((l, i) => ({
      index: i,
      keywords: l.terms,
      sampleTitles: (clusterDocs[i] || []).slice(0, 6).map((b) => b.page_title || b.title),
    }));

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You label topic clusters of browser bookmarks. Given keywords and sample titles per cluster, return a JSON object {"labels": ["short 2-4 word label", ...]} in the same order as input, one label per cluster. Labels should be concise, specific, and human-friendly (e.g. "React & Frontend Tooling", "Sourdough Baking").',
          },
          { role: 'user', content: JSON.stringify(clustersForPrompt) },
        ],
      }),
    });

    if (!res.ok) return labels;
    const json = await res.json();
    const parsed = JSON.parse(json.choices[0].message.content);
    if (Array.isArray(parsed.labels) && parsed.labels.length === labels.length) {
      return labels.map((l, i) => ({ ...l, label: parsed.labels[i] || l.label }));
    }
    return labels;
  } catch {
    return labels;
  }
}

/**
 * Runs the full clustering pipeline over all fetched+embedded bookmarks.
 * Returns { assignments: bookmarkId -> clusterIndex, clusters: [{label, terms, size}] }
 */
async function clusterBookmarks(bookmarks) {
  const withVectors = bookmarks.filter((b) => b.embedding);
  if (withVectors.length === 0) return { assignments: {}, clusters: [] };

  const vectors = withVectors.map((b) => bufferToVector(b.embedding));
  const k = pickK(withVectors.length);
  const { assignments } = kmeans(vectors, k);

  let labels = labelClusters(withVectors, assignments, k);

  const clusterDocs = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => clusterDocs[c].push(withVectors[i]));
  labels = await maybeImproveLabelsWithLLM(labels, clusterDocs);

  const assignmentById = {};
  withVectors.forEach((b, i) => {
    assignmentById[b.id] = assignments[i];
  });

  return { assignments: assignmentById, clusters: labels };
}

module.exports = { clusterBookmarks, pickK, cosineSimilarity };
