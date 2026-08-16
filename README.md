# Bookmark Brain

Semantic search and auto-generated topic clusters for your browser bookmarks.
Import your existing bookmarks, Bookmark Brain fetches and embeds each page,
then gives you a search box and a clustered topic view instead of a folder
tree you have to remember.

This is the **self-hosted, single-tenant** edition — one person, their own
machine, no accounts. A companion
[Chrome extension](extension/README.md) lives in this repo (search from the
toolbar, one-click save, direct Chrome-bookmarks import) and pairs with
either this app or the **hosted, multi-tenant, subscription** edition at
[github.com/technocon/bookmark-brain-cloud](https://github.com/technocon/bookmark-brain-cloud)
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
`.env` and set `OPENAI_API_KEY`; embeddings (and cluster labels) then use
OpenAI automatically, with a graceful fallback to local embeddings if a
request ever fails.

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

## Architecture

- `server.js` — Express app, static hosting + REST API (search, clusters,
  import, single-bookmark save, delete, failed/fallback logs, backfill).
- `src/importer.js` — parses Netscape-format bookmarks.html exports.
- `src/fetcher.js` — concurrency-limited page fetch + text extraction (cheerio).
- `src/embeddings.js` — pluggable embedder: local hashed bag-of-words by
  default, OpenAI `text-embedding-3-small` when `OPENAI_API_KEY` is set.
  Also builds the title+folder-only fallback text used when a fetch fails.
- `src/cluster.js` — k-means over embeddings + TF-IDF-style cluster labeling
  (optionally polished by an LLM call when an OpenAI key is present).
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
