import path from 'node:path';
import { getDb } from './db';

/**
 * A flat file store in SQLite: one row per file, keyed by a relative POSIX
 * path. Writes are upserts, so repeating one (a retried step, a re-synced
 * sandbox) leaves a single row with the latest content.
 */

export interface StoredFile {
  path: string;
  content: string;
  updated_at: string;
}

export const MAX_FILE_BYTES = 256 * 1024;

/** Returns the canonical relative path, or throws if it could escape the store. */
export function normalizeFilePath(input: string): string {
  const normalized = path.posix.normalize(input.trim().replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.endsWith('/') ||
    normalized.includes('\0')
  ) {
    throw new Error(
      `Invalid file path "${input}". Use a relative path such as "primes.js" or "utils/math.js".`,
    );
  }
  return normalized;
}

export function listFiles(): StoredFile[] {
  return getDb()
    .prepare('SELECT path, content, updated_at FROM files ORDER BY path')
    .all() as unknown as StoredFile[];
}

export function readFile(filePath: string): StoredFile | null {
  const row = getDb()
    .prepare('SELECT path, content, updated_at FROM files WHERE path = ?')
    .get(normalizeFilePath(filePath));
  return (row as unknown as StoredFile | undefined) ?? null;
}

/** Returns whether a file was there to delete. */
export function deleteFile(filePath: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM files WHERE path = ?')
    .run(normalizeFilePath(filePath));
  return result.changes > 0;
}

/** Returns what the write did, so callers can report it. */
export function writeFile(
  filePath: string,
  content: string,
): 'created' | 'updated' | 'unchanged' {
  const normalized = normalizeFilePath(filePath);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);
  }
  const existing = readFile(normalized);
  if (existing?.content === content) return 'unchanged';
  getDb()
    .prepare(
      `INSERT INTO files (path, content) VALUES (?, ?)
       ON CONFLICT (path) DO UPDATE SET
         content = excluded.content,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(normalized, content);
  return existing ? 'updated' : 'created';
}
