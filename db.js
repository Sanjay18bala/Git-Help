// The local SQLite database (.data/git-help.db): Slack copies, the RAG index and settings.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let database;

// Opens lazily, so importing server.js (e.g. from tests) doesn't create the file.
export function db() {
  if (database) return database;
  const file = process.env.GIT_HELP_DB ?? '.data/git-help.db';
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec(`
    -- Slack (slack.js)
    CREATE TABLE IF NOT EXISTS links (
      repo TEXT NOT NULL, channel_id TEXT NOT NULL, linked_at TEXT NOT NULL, PRIMARY KEY (repo, channel_id));
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, is_private INTEGER NOT NULL, latest_ts TEXT, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS messages (
      channel_id TEXT NOT NULL, ts TEXT NOT NULL, thread_ts TEXT, user_id TEXT, user_name TEXT,
      text TEXT NOT NULL, reply_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, ts));
    CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (channel_id, thread_ts);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL);

    -- LLM settings (llm.js): one JSON document per key
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- RAG index (rag.js). A chunk belongs to a Slack channel or a GitHub repo.
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, repo TEXT, channel_id TEXT,
      title TEXT NOT NULL, text TEXT NOT NULL, url TEXT NOT NULL, ts TEXT,
      hash TEXT NOT NULL, model TEXT, embedding BLOB);
    CREATE INDEX IF NOT EXISTS chunks_by_repo ON chunks (repo);
    CREATE INDEX IF NOT EXISTS chunks_by_channel ON chunks (channel_id);
    CREATE TABLE IF NOT EXISTS indexed_repos (repo TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
    -- One row per issue / PR as of the last index, for exact counts and lists (search alone can't count).
    CREATE TABLE IF NOT EXISTS items (
      repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, draft INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, labels TEXT NOT NULL, assignees TEXT NOT NULL, author TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, milestone TEXT, due_on TEXT, PRIMARY KEY (repo, number));

    -- Keyword search over chunks, kept in sync by triggers (embedding updates don't touch it).
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, text, content='chunks', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF title, text ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
      INSERT INTO chunks_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
  `);
  // Columns added after a table first shipped: add them to existing databases.
  const has = (table, col) => database.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  for (const [col, type] of [['milestone', 'TEXT'], ['due_on', 'TEXT']]) {
    if (!has('items', col)) database.exec(`ALTER TABLE items ADD COLUMN ${col} ${type}`);
  }
  return database;
}
