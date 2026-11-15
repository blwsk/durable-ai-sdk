import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

// The connection outlives module reloads in dev; the schema is re-applied by
// each module instance so a reload picks up new tables.
const globals = globalThis as { __notesDb?: DatabaseSync };
let schemaApplied = false;

export function getDb(): DatabaseSync {
  if (!globals.__notesDb) {
    const file = process.env.NOTES_DB_PATH ?? '.data/notes.db';
    mkdirSync(path.dirname(file), { recursive: true });
    globals.__notesDb = new DatabaseSync(file);
  }
  if (!schemaApplied) {
    globals.__notesDb.exec(SCHEMA);
    schemaApplied = true;
  }
  return globals.__notesDb;
}
