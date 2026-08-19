const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'bookmarks.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    added_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | fetched | fallback | failed
    fetch_error TEXT,
    page_title TEXT,
    page_description TEXT,
    page_text TEXT,
    favicon TEXT,
    embedding BLOB,
    cluster_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    label TEXT NOT NULL,
    terms TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS duplicate_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reason TEXT NOT NULL, -- 'url-variant' | 'semantic'
    similarity REAL NOT NULL,
    bookmark_ids TEXT NOT NULL, -- JSON array, same convention as clusters.terms
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', -- running | done | error
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(status);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_cluster ON bookmarks(cluster_id);
`);

// CREATE TABLE IF NOT EXISTS doesn't retrofit columns onto a database that
// already existed before this column was added. Add it if missing.
try {
  db.exec('ALTER TABLE jobs ADD COLUMN partial INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// node:sqlite's DatabaseSync has no better-sqlite3-style `.transaction()`
// helper; add a minimal equivalent so callers can write the same pattern.
db.transaction = function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

module.exports = db;
