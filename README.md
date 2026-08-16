# Bookmark Brain

Semantic search and auto-generated topic clusters for your browser bookmarks.
Import your existing bookmarks, Bookmark Brain fetches and embeds each page,
then gives you a search box and a clustered topic view instead of a folder
tree you have to remember.

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
2. Open the **Import** tab and drop the file in. Bookmark Brain parses it,
   fetches each page (concurrency-limited, tolerant of dead links/timeouts),
   embeds the content, and runs k-means clustering with auto-generated
   topic labels.
3. Use **Search** to find a bookmark by describing it, or **Clusters** to
   browse the auto-organized topic view.

## Architecture

- `server.js` — Express app, static hosting + REST API.
- `src/importer.js` — parses Netscape-format bookmarks.html exports.
- `src/fetcher.js` — concurrency-limited page fetch + text extraction (cheerio).
- `src/embeddings.js` — pluggable embedder: local hashed bag-of-words by
  default, OpenAI `text-embedding-3-small` when `OPENAI_API_KEY` is set.
- `src/cluster.js` — k-means over embeddings + TF-IDF-style cluster labeling
  (optionally polished by an LLM call when an OpenAI key is present).
- `src/search.js` — cosine-similarity semantic search with a small keyword
  overlap boost.
- `src/jobs.js` — background import pipeline (parse → fetch → embed →
  cluster) with progress polling via `/api/jobs/:id`.
- `src/db.js` — schema, using Node's built-in `node:sqlite` (no native
  build step).
- `public/` — plain HTML/CSS/JS frontend, no build tooling.

Data is stored locally in `data/bookmarks.db` (gitignored).

## Scope

This is the MVP described in the product brief: import, embed, cluster,
search. No collaboration, team features, or archival/wayback capture —
by design, for launch.
