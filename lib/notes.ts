import { getDb } from './db';

export interface Note {
  id: number;
  content: string;
  created_at: string;
}

/**
 * Inserts a note at most once per `idempotencyKey`. A second call with the
 * same key returns the note the first call wrote.
 */
export function recordNote(content: string, idempotencyKey: string) {
  const db = getDb();
  const inserted = db
    .prepare(
      'INSERT INTO notes (idempotency_key, content) VALUES (?, ?) ON CONFLICT (idempotency_key) DO NOTHING',
    )
    .run(idempotencyKey, content);
  const note = db
    .prepare(
      'SELECT id, content, created_at FROM notes WHERE idempotency_key = ?',
    )
    .get(idempotencyKey) as unknown as Note;
  return { note, alreadyRecorded: inserted.changes === 0 };
}

export function getNotes(limit = 20): Note[] {
  return getDb()
    .prepare(
      'SELECT id, content, created_at FROM notes ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as unknown as Note[];
}
