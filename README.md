# Bookmark Brain

Semantic search and auto-generated topic clusters for your browser bookmarks.
Import your existing bookmarks, Bookmark Brain fetches and embeds each page,
then gives you a search box and a clustered topic view instead of a folder
tree you have to remember.

This is the **self-hosted, single-tenant** edition — one person, their own
machine, no accounts. A companion
[Chrome extension](extension/README.md) lives in this repo (search from the
toolbar, one-click save, direct Chrome-bookmarks import) — get it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/bookmark-brain/jleoijmjcmcjhkagaipoppimfopdckhh)
— and pairs with either this app or the **hosted, multi-tenant,
subscription** edition at [bookmarkbrain.site](https://bookmarkbrain.site)
— same product, rearchitected with accounts and Stripe billing to run as a
paid service for many users at once.

## Setup

```bash
npm install
npm start
```

Open **http://localhost:3300**.

No API key is required — by default Bookmark Brain uses a built-in local
embedding model (hashed bag-of-words), so import/search/clustering all work
fully offline. For noticeably better semantic search, copy `.env.example` to
`.env` and set either `OPENAI_API_KEY` **or** `GEMINI_API_KEY` (whichever
provider you have — if both are set, `EMBEDDING_PROVIDER` picks the
winner); embeddings and cluster-label polishing then use that provider
automatically, with a graceful fallback to local embeddings if a request
ever fails. See the comments in `.env.example` for model overrides and how
to add another provider later.

## Using it

1. **Export your bookmarks** from your browser as an HTML file:
   - Chrome/Edge/Brave: Bookmarks → Bookmark Manager → ⋮ → Export bookmarks
   - Firefox: Bookmarks → Manage Bookmarks → Import and Backup → Export Bookmarks to HTML
   - Safari: File → Export Bookmarks
   (Or, to try it immediately without exporting anything, drop in the
   included `sample-bookmarks.html` — a small Wikipedia-based test set.)
2. Open the **Import** tab and drop the file in — or install the
   [Chrome extension](extension/README.md) and import directly from
   Chrome's own bookmarks, no export step needed. Either way, Bookmark
   Brain parses it, fetches each page (concurrency-limited, tolerant of
   dead links/timeouts), embeds the content, and runs k-means clustering
   with auto-generated topic labels.
3. Use **Search** to find a bookmark by describing it, or **Clusters** to
   browse the auto-organized topic view. A trash icon on any result deletes
   it.
4. Pages that can't be fetched (dead links, logins, bot-blocked sites)
   aren't dropped — they're embedded from their saved title + folder
   instead and tagged **Title only** everywhere they appear, so they stay
   searchable at reduced confidence rather than disappearing. The header's
   "N failed" pill (if any survive even that) opens a log with a one-click
   "Recover as title-only" action.
5. The extension also adds a **Save this page** button and a right-click
   "Save to Bookmark Brain" — both fetch/embed/cluster a single URL
   instantly, no full re-import needed.
6. The Import tab's **Export** button downloads everything as a standard
   `bookmarks.html` — for backup, or to move this collection to the
   [hosted edition](https://bookmarkbrain.site): sign up there, open its
   own Import tab, and drop in the file you just exported here. It
   re-fetches and re-embeds every page fresh (nothing about status,
   clusters, or embeddings carries over — only url/title/folder do), so
   expect it to take a while and make one API call per bookmark against
   whatever embedding provider the cloud deployment has configured.
7. The Import tab's **Find duplicates** button scans for bookmarks that
   are likely the same thing saved twice — an exact URL saved with a
   different tracking link or trailing slash ("url-variant"), or two
   different URLs whose embedded content is near-identical ("semantic",
   e.g. the same article re-shared from two different links). Runs as a
   background job (it's an O(n²) comparison, so it can take a while on a
   large collection) and never deletes anything itself — it surfaces
   grouped matches in a drawer for you to review and pick what to keep.

## Architecture

- `server.js` — Express app, static hosting + REST API (search, clusters,
  import, single-bookmark save, delete, failed/fallback logs, backfill).
- `src/importer.js` — parses Netscape-format bookmarks.html exports.
- `src/fetcher.js` — concurrency-limited page fetch + text extraction (cheerio).
- `src/embeddings.js` — pluggable embedder: local hashed bag-of-words by
  default, OpenAI or Gemini when the corresponding API key is set
  (`EMBEDDING_PROVIDER` disambiguates if both are). Also builds the
  title+folder-only fallback text used when a fetch fails, and documents
  how to add another provider.
- `src/cluster.js` — k-means over embeddings + TF-IDF-style cluster labeling
  (optionally polished by an LLM call — OpenAI or Gemini, whichever's active).
- `src/search.js` — cosine-similarity semantic search with a small keyword
  overlap boost; fallback (title-only) matches are penalized and tagged.
- `src/jobs.js` — background import pipeline (parse → fetch → embed →
  cluster) with progress polling via `/api/jobs/:id`; also handles the
  extension's JSON import, single-bookmark quick-save (with nearest-cluster
  assignment instead of a full recluster), and the failed-imports backfill.
- `src/db.js` — schema, using Node's built-in `node:sqlite` (no native
  build step).
- `extension/` — the Manifest V3 Chrome extension; see its own README.
- `public/` — plain HTML/CSS/JS frontend, no build tooling.

Data is stored locally in `data/bookmarks.db` (gitignored).

## Scope

This is the MVP described in the product brief: import, embed, cluster,
search. No collaboration, team features, or archival/wayback capture —
by design, for launch.
