const crypto = require('node:crypto');
const db = require('./db');
const { parseBookmarksHtml } = require('./importer');
const { fetchPageContent, mapWithConcurrency } = require('./fetcher');
const {
  embed,
  buildEmbeddingText,
  buildFallbackEmbeddingText,
  vectorToBuffer,
  bufferToVector,
  cosineSimilarity,
  activeProvider,
} = require('./embeddings');
const { clusterBookmarks } = require('./cluster');
const { findDuplicateGroups } = require('./dedupe');

const FETCH_CONCURRENCY = 8;

const insertBookmarkStmt = db.prepare(`
  INSERT INTO bookmarks (url, title, folder, added_at, favicon, status)
  VALUES (?, ?, ?, ?, ?, 'pending')
  ON CONFLICT(url) DO UPDATE SET title = excluded.title, folder = excluded.folder
`);

const markFetchedStmt = db.prepare(`
  UPDATE bookmarks
  SET status = 'fetched', page_title = ?, page_description = ?, page_text = ?, favicon = COALESCE(?, favicon), embedding = ?
  WHERE id = ?
`);

// Fetch failed, but the bookmark is still embedded from its saved title
// + folder path so it stays searchable/clusterable rather than vanishing.
const markFallbackStmt = db.prepare(`
  UPDATE bookmarks
  SET status = 'fallback', fetch_error = ?, embedding = ?
  WHERE id = ?
`);

// Truly unusable — fetch failed AND embedding it also failed (e.g. the
// embedding provider errored). Rare; only path with zero search coverage.
const markFailedStmt = db.prepare(`
  UPDATE bookmarks SET status = 'failed', fetch_error = ? WHERE id = ?
`);

const setClusterStmt = db.prepare(`UPDATE bookmarks SET cluster_id = ? WHERE id = ?`);
const setEmbeddingStmt = db.prepare(`UPDATE bookmarks SET embedding = ? WHERE id = ?`);
const clearClustersStmt = db.prepare(`DELETE FROM clusters`);
const insertClusterStmt = db.prepare(
  `INSERT INTO clusters (run_id, label, terms, size) VALUES (?, ?, ?, ?)`
);

function createJobRow(type) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, type, status, stage) VALUES (?, ?, 'running', 'starting')`
  ).run(id, type);
  return id;
}

function updateJob(id, fields) {
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(val);
  }
  sets.push(`updated_at = unixepoch()`);
  values.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function getJob(id) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

/**
 * Kicks off the full pipeline (parse -> insert -> fetch -> embed -> cluster)
 * in the background and returns immediately with a job id to poll.
 */
function startImportJob(htmlBuffer) {
  const jobId = createJobRow('import');
  runImportPipeline(jobId, htmlBuffer).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
  return jobId;
}

/**
 * Same pipeline, but for callers that already have a parsed bookmark list
 * instead of a Netscape HTML export — the Chrome extension reads
 * chrome.bookmarks.getTree() directly and posts JSON, so there's no HTML
 * to parse.
 */
function startImportJobFromList(parsedList) {
  const jobId = createJobRow('import');
  runBatchImport(jobId, parsedList).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
  return jobId;
}

/**
 * Fetches+embeds one bookmark. On a successful fetch, embeds the real page
 * content. On failure, falls back to embedding just the saved title +
 * folder path — worse signal, but the bookmark stays searchable instead
 * of disappearing. Only in the (rare) case the embedding call itself
 * throws does the bookmark end up truly excluded.
 */
async function fetchAndEmbedOne(bookmark) {
  const result = await fetchPageContent(bookmark.url);

  if (result.ok) {
    const embeddingText = buildEmbeddingText({
      title: bookmark.title,
      pageTitle: result.pageTitle,
      description: result.description,
      text: result.text,
    });
    const { vector } = await embed(embeddingText);
    markFetchedStmt.run(
      result.pageTitle || bookmark.title,
      result.description,
      result.text,
      result.favicon,
      vectorToBuffer(vector),
      bookmark.id
    );
    return 'done';
  }

  try {
    const fallbackText = buildFallbackEmbeddingText({ title: bookmark.title, folder: bookmark.folder });
    const { vector } = await embed(fallbackText);
    markFallbackStmt.run(result.error, vectorToBuffer(vector), bookmark.id);
    return 'partial';
  } catch (err) {
    markFailedStmt.run(`${result.error} (and fallback embedding failed: ${err.message})`, bookmark.id);
    return 'failed';
  }
}

/**
 * Re-runs k-means over every embedded bookmark (fetched or fallback) and
 * replaces the cluster assignments. Shared by import and backfill so
 * clusters stay consistent regardless of which pipeline last ran.
 */
async function reclusterAll(jobId) {
  updateJob(jobId, { stage: 'clustering' });

  const embedded = db
    .prepare(`SELECT * FROM bookmarks WHERE status IN ('fetched', 'fallback')`)
    .all();
  const { assignments, clusters } = await clusterBookmarks(embedded);

  const runId = crypto.randomUUID();
  const assignClusters = db.transaction(() => {
    clearClustersStmt.run();
    // idMap stays sparse (indexed by position, not push order) — an empty
    // cluster (a known k-means edge case) never appears in `assignments`
    // since no bookmark can be assigned to a cluster with no members, so
    // skipping its insert here just leaves that slot unused rather than
    // persisting a size-0 cluster that'd show up as a dead, empty card.
    const idMap = [];
    clusters.forEach((c, index) => {
      if (c.size <= 0) return;
      const info = insertClusterStmt.run(runId, c.label, JSON.stringify(c.terms), c.size);
      idMap[index] = Number(info.lastInsertRowid);
    });
    for (const [bookmarkId, clusterIndex] of Object.entries(assignments)) {
      setClusterStmt.run(idMap[clusterIndex], Number(bookmarkId));
    }
  });
  assignClusters();
}

async function runImportPipeline(jobId, htmlBuffer) {
  updateJob(jobId, { stage: 'parsing bookmarks' });
  const parsed = parseBookmarksHtml(htmlBuffer.toString('utf8'));

  if (parsed.length === 0) {
    updateJob(jobId, {
      status: 'error',
      error: 'No bookmarks found in that file. Export a standard Netscape-format bookmarks.html from your browser.',
    });
    return;
  }

  await runBatchImport(jobId, parsed);
}

async function runBatchImport(jobId, parsed) {
  if (parsed.length === 0) {
    updateJob(jobId, { status: 'error', error: 'No bookmarks were provided.' });
    return;
  }

  const insertMany = db.transaction((items) => {
    for (const bm of items) {
      insertBookmarkStmt.run(bm.url, bm.title, bm.folder, bm.addedAt, bm.favicon);
    }
  });
  insertMany(parsed);

  const pending = db.prepare(`SELECT * FROM bookmarks WHERE status = 'pending'`).all();

  updateJob(jobId, {
    stage: 'fetching pages',
    total: pending.length,
    done: 0,
    partial: 0,
    failed: 0,
  });

  let done = 0;
  let partial = 0;
  let failed = 0;

  await mapWithConcurrency(
    pending,
    FETCH_CONCURRENCY,
    async (bookmark) => {
      const outcome = await fetchAndEmbedOne(bookmark);
      if (outcome === 'done') done++;
      else if (outcome === 'partial') partial++;
      else failed++;
    },
    (completed, total) => {
      updateJob(jobId, { done, partial, failed, stage: `fetching pages (${completed}/${total})` });
    }
  );

  await reclusterAll(jobId);

  updateJob(jobId, {
    status: 'done',
    stage: 'done',
    done,
    partial,
    failed,
    total: pending.length,
  });
}

/**
 * Re-embeds every already-failed bookmark using the title/folder fallback
 * (no network fetch needed — the fetch already failed and permanently
 * blocked sites/dead links aren't going to start working now) and
 * re-clusters. Lets an existing collection recover search coverage for
 * bookmarks that failed before this fallback mechanism existed, or after
 * a bulk import where many links were simply dead.
 */
function startBackfillJob() {
  const jobId = createJobRow('backfill');
  runBackfillPipeline(jobId).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
  return jobId;
}

async function runBackfillPipeline(jobId) {
  const failedBookmarks = db.prepare(`SELECT * FROM bookmarks WHERE status = 'failed'`).all();

  updateJob(jobId, {
    stage: 'embedding titles for previously failed bookmarks',
    total: failedBookmarks.length,
    done: 0,
    partial: 0,
    failed: 0,
  });

  if (failedBookmarks.length === 0) {
    updateJob(jobId, { status: 'done', stage: 'done' });
    return;
  }

  let partial = 0;
  let failed = 0;

  await mapWithConcurrency(
    failedBookmarks,
    FETCH_CONCURRENCY,
    async (bookmark) => {
      try {
        const fallbackText = buildFallbackEmbeddingText({ title: bookmark.title, folder: bookmark.folder });
        const { vector } = await embed(fallbackText);
        markFallbackStmt.run(bookmark.fetch_error, vectorToBuffer(vector), bookmark.id);
        partial++;
      } catch (err) {
        failed++;
      }
    },
    (completed, total) => {
      updateJob(jobId, { partial, failed, stage: `recovering (${completed}/${total})` });
    }
  );

  await reclusterAll(jobId);

  updateJob(jobId, {
    status: 'done',
    stage: 'done',
    partial,
    failed,
    total: failedBookmarks.length,
  });
}

/**
 * Re-embeds every already-fetched/fallback bookmark with whichever
 * provider is currently active, reusing the content already stored from
 * the original fetch — no re-crawling the web, just re-running embed()
 * over text that's already sitting in the database. For when a
 * collection was originally embedded locally (or under a different
 * provider) and you want it consistently upgraded, e.g. after adding an
 * API key. Ends with a full recluster so everything lands in one
 * dimensionality group again instead of staying split (see cluster.js).
 */
function startReembedJob() {
  const jobId = createJobRow('reembed');
  runReembedPipeline(jobId).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
  return jobId;
}

async function runReembedPipeline(jobId) {
  const targets = db.prepare(`SELECT * FROM bookmarks WHERE status IN ('fetched', 'fallback')`).all();

  updateJob(jobId, {
    stage: `re-embedding with ${activeProvider()}`,
    total: targets.length,
    done: 0,
    partial: 0,
    failed: 0,
  });

  if (targets.length === 0) {
    updateJob(jobId, { status: 'done', stage: 'done' });
    return;
  }

  let done = 0;
  let partial = 0;

  await mapWithConcurrency(
    targets,
    FETCH_CONCURRENCY,
    async (bookmark) => {
      const text =
        bookmark.status === 'fallback'
          ? buildFallbackEmbeddingText({ title: bookmark.title, folder: bookmark.folder })
          : buildEmbeddingText({
              title: bookmark.title,
              pageTitle: bookmark.page_title,
              description: bookmark.page_description,
              text: bookmark.page_text,
            });
      const { vector, source } = await embed(text);
      setEmbeddingStmt.run(vectorToBuffer(vector), bookmark.id);
      if (source === activeProvider()) done++;
      else partial++; // embed() fell back to local (transient provider error)
    },
    (completed, total) => {
      updateJob(jobId, { done, partial, stage: `re-embedding (${completed}/${total})` });
    }
  );

  await reclusterAll(jobId);

  updateJob(jobId, { status: 'done', stage: 'done', done, partial, total: targets.length });
}

/**
 * Scans the whole collection for likely duplicates (URL variants and
 * near-identical embeddings) and replaces the persisted duplicate_groups
 * with the fresh result. On-demand only (like reembed) -- running this
 * after every single-bookmark save would mean rescanning the whole
 * collection for one new row, not worth the CPU.
 */
function startDuplicateScanJob() {
  const jobId = createJobRow('duplicates');
  runDuplicateScan(jobId).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
  return jobId;
}

async function runDuplicateScan(jobId) {
  updateJob(jobId, { stage: 'scanning for duplicates' });

  const bookmarks = db
    .prepare(
      `SELECT id, url, status, embedding, length(page_text) AS contentLength
       FROM bookmarks WHERE status IN ('fetched', 'fallback')`
    )
    .all();
  const groups = await findDuplicateGroups(bookmarks);

  const replaceGroups = db.transaction((items) => {
    db.prepare(`DELETE FROM duplicate_groups`).run();
    const insert = db.prepare(
      `INSERT INTO duplicate_groups (reason, similarity, bookmark_ids) VALUES (?, ?, ?)`
    );
    for (const g of items) {
      insert.run(g.reason, g.similarity, JSON.stringify(g.bookmarkIds));
    }
  });
  replaceGroups(groups);

  updateJob(jobId, { status: 'done', stage: 'done', total: groups.length, done: groups.length });
}

/**
 * Places a freshly-embedded bookmark into whichever existing cluster it's
 * closest to, without re-running k-means over the whole collection — a
 * full recluster is fine for a batch import but would make every single
 * quick-save from the extension pause for a full pass over thousands of
 * bookmarks. Centroids are computed on the fly from current members
 * rather than stored, since clusters change size between full reclusters.
 * Labels are left as-is; they drift slightly until the next full
 * recluster (import or backfill), which is an acceptable trade for an
 * instant save.
 */
function assignToNearestCluster(vector) {
  const clusters = db.prepare(`SELECT id FROM clusters`).all();
  if (clusters.length === 0) return null;

  let bestClusterId = null;
  let bestSimilarity = -Infinity;

  const membersStmt = db.prepare(
    `SELECT embedding FROM bookmarks WHERE cluster_id = ? AND embedding IS NOT NULL LIMIT 200`
  );

  for (const cluster of clusters) {
    const members = membersStmt.all(cluster.id);
    if (members.length === 0) continue;

    const dims = vector.length;
    const centroid = new Float64Array(dims);
    for (const m of members) {
      const v = bufferToVector(m.embedding);
      for (let d = 0; d < dims; d++) centroid[d] += v[d];
    }
    for (let d = 0; d < dims; d++) centroid[d] /= members.length;

    const similarity = cosineSimilarity(vector, centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestClusterId = cluster.id;
    }
  }

  return bestClusterId;
}

/**
 * Saves a single bookmark synchronously (fetch -> embed -> cluster-assign)
 * and returns the finished record. Used by the extension's "save this
 * page" action and context menu — a single URL is fast enough to do
 * inline without the job-polling machinery a bulk import needs.
 */
async function saveOneBookmark({ url, title, folder }) {
  insertBookmarkStmt.run(url, title || url, folder || '', null, null);
  const bookmark = db.prepare(`SELECT * FROM bookmarks WHERE url = ?`).get(url);

  if (bookmark.status === 'fetched' || bookmark.status === 'fallback') {
    return { outcome: 'already-saved', bookmark };
  }

  const outcome = await fetchAndEmbedOne(bookmark);
  const saved = db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(bookmark.id);

  if (outcome !== 'failed' && saved.embedding) {
    const clusterId = assignToNearestCluster(bufferToVector(saved.embedding));
    if (clusterId != null) {
      setClusterStmt.run(clusterId, saved.id);
      db.prepare(`UPDATE clusters SET size = size + 1 WHERE id = ?`).run(clusterId);
      saved.cluster_id = clusterId;
    }
  }

  return { outcome, bookmark: saved };
}

module.exports = {
  startImportJob,
  startImportJobFromList,
  startBackfillJob,
  startReembedJob,
  startDuplicateScanJob,
  saveOneBookmark,
  getJob,
};
