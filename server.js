const path = require('node:path');
const express = require('express');
const multer = require('multer');

const db = require('./src/db');
const { startImportJob, startImportJobFromList, startBackfillJob, startReembedJob, saveOneBookmark, getJob } = require('./src/jobs');
const { search } = require('./src/search');
const { activeProvider } = require('./src/embeddings');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const PORT = process.env.PORT || 3300;

// Permissive CORS on the API only. There's no auth/cookies yet to protect,
// and this is what lets the Chrome extension's popup/background pages (and
// eventually a separately-hosted web frontend) call this server across
// origins. Static asset routes below don't need it.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/stats', (req, res) => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM bookmarks`).get().n;
  const fetched = db.prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status = 'fetched'`).get().n;
  const fallback = db.prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status = 'fallback'`).get().n;
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status = 'failed'`).get().n;
  const clusters = db.prepare(`SELECT COUNT(*) AS n FROM clusters`).get().n;
  res.json({
    total,
    fetched,
    fallback,
    failed,
    indexed: fetched + fallback,
    clusters,
    embeddingMode: activeProvider(),
  });
});

app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach a bookmarks.html export.' });
  }
  const jobId = startImportJob(req.file.buffer);
  res.json({ jobId });
});

// Bulk import from a pre-parsed list rather than an HTML file — what the
// Chrome extension sends after reading chrome.bookmarks.getTree() directly,
// skipping the manual export/upload round trip.
app.post('/api/import-json', (req, res) => {
  const bookmarks = req.body?.bookmarks;
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return res.status(400).json({ error: 'Expected { bookmarks: [{ url, title, folder }, ...] }' });
  }

  const cleaned = bookmarks
    .filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url))
    .map((b) => ({
      url: b.url,
      title: typeof b.title === 'string' && b.title ? b.title : b.url,
      folder: typeof b.folder === 'string' ? b.folder : '',
      addedAt: Number.isFinite(b.addedAt) ? b.addedAt : null,
      favicon: null,
    }));

  if (cleaned.length === 0) {
    return res.status(400).json({ error: 'No valid http(s) bookmarks in that list.' });
  }

  const jobId = startImportJobFromList(cleaned);
  res.json({ jobId });
});

// Single-bookmark save — the extension's toolbar "Save this page" button
// and right-click context menu both hit this. Fast enough to run inline
// (fetch + embed + cluster-assign one URL) rather than needing job polling.
app.post('/api/bookmarks', async (req, res) => {
  const { url, title, folder } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) url is required.' });
  }

  try {
    const { outcome, bookmark } = await saveOneBookmark({ url, title, folder });
    res.json({
      outcome,
      bookmark: {
        id: bookmark.id,
        url: bookmark.url,
        title: bookmark.page_title || bookmark.title,
        status: bookmark.status,
        contentAvailable: bookmark.status === 'fetched',
        fetchError: bookmark.fetch_error,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/search', async (req, res) => {
  try {
    const results = await search(req.query.q || '', { limit: 40 });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clusters', (req, res) => {
  const clusters = db
    .prepare(
      `SELECT c.id, c.label, c.terms, c.size
       FROM clusters c
       ORDER BY c.size DESC`
    )
    .all()
    .map((c) => ({ ...c, terms: JSON.parse(c.terms || '[]') }));

  const sampleStmt = db.prepare(
    `SELECT id, url, title, page_title, favicon FROM bookmarks WHERE cluster_id = ? LIMIT 4`
  );
  for (const c of clusters) {
    c.samples = sampleStmt.all(c.id).map((b) => ({
      id: b.id,
      url: b.url,
      title: b.page_title || b.title,
      favicon: b.favicon,
    }));
  }

  res.json({ clusters });
});

app.get('/api/clusters/:id/bookmarks', (req, res) => {
  const bookmarks = db
    .prepare(
      `SELECT id, url, title, page_title, page_description, favicon, folder, status, fetch_error
       FROM bookmarks WHERE cluster_id = ? ORDER BY page_title`
    )
    .all(req.params.id)
    .map((b) => ({
      id: b.id,
      url: b.url,
      title: b.page_title || b.title,
      description: b.page_description,
      favicon: b.favicon,
      folder: b.folder,
      contentAvailable: b.status !== 'fallback',
      fetchError: b.status === 'fallback' ? b.fetch_error : null,
    }));
  res.json({ bookmarks });
});

app.get('/api/bookmarks/failed', (req, res) => {
  const bookmarks = db
    .prepare(`SELECT id, url, title, fetch_error FROM bookmarks WHERE status = 'failed'`)
    .all();
  res.json({ bookmarks });
});

app.get('/api/bookmarks/fallback', (req, res) => {
  const bookmarks = db
    .prepare(
      `SELECT id, url, title, page_title, favicon, fetch_error FROM bookmarks WHERE status = 'fallback'`
    )
    .all()
    .map((b) => ({ ...b, title: b.page_title || b.title }));
  res.json({ bookmarks });
});

app.post('/api/backfill', (req, res) => {
  const jobId = startBackfillJob();
  res.json({ jobId });
});

app.post('/api/reembed', (req, res) => {
  if (activeProvider() === 'local') {
    return res.status(400).json({ error: 'No embedding provider is configured — nothing to upgrade to.' });
  }
  const jobId = startReembedJob();
  res.json({ jobId });
});

app.delete('/api/bookmarks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const bookmark = db.prepare(`SELECT cluster_id FROM bookmarks WHERE id = ?`).get(id);
  if (!bookmark) return res.status(404).json({ error: 'Bookmark not found' });

  const deleteAndShrinkCluster = db.transaction((bookmarkId, clusterId) => {
    db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(bookmarkId);
    if (clusterId != null) {
      db.prepare(`UPDATE clusters SET size = size - 1 WHERE id = ?`).run(clusterId);
    }
  });
  deleteAndShrinkCluster(id, bookmark.cluster_id);

  res.json({ ok: true });
});

const PROVIDER_LABELS = {
  openai: `OpenAI (${process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'})`,
  gemini: `Gemini (${process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'})`,
  local: 'local (offline, no API key)',
};

app.listen(PORT, () => {
  console.log(`Bookmark Brain running at http://localhost:${PORT}`);
  console.log(`Embedding mode: ${PROVIDER_LABELS[activeProvider()]}`);
});
