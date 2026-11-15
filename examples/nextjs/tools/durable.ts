import { getStepMetadata } from 'workflow';
import type { LocalWeatherInput } from '@/lib/weather';

/**
 * The durable wrappers: every tool that must run as a workflow step, and the
 * retry policy for each. The implementations are plain functions under
 * `lib/`; nothing there knows about workflows.
 *
 * A tool belongs here if it does I/O. As a step its call is recorded, so a
 * resumed or replayed turn reuses the result instead of repeating the call,
 * and it runs in Node rather than the workflow sandbox. (`'use step'` is a
 * compile-time directive, so each wrapper is written out; it cannot be
 * applied by a helper.)
 *
 * Two questions decide the rest, per tool:
 *
 * Does a retry help? Only when failures are transient.
 *   - Network calls: yes. Default policy, 3 retries with backoff.
 *   - Local SQLite: rarely; a failure is almost always a bug, and retrying a
 *     bug only delays the error reaching the model. 1 retry, for a busy lock.
 *
 * Is running it twice safe? A step can run again after it has already taken
 * effect: on a retry, or when the process dies before the result is recorded.
 *   - Reads: yes.
 *   - `write_file`, `delete_file`: yes. Overwriting by path or deleting by
 *     path a second time changes nothing.
 *   - `record_note`: no, it appends. It is the one tool that needs an
 *     idempotency key, and uses the step id, which is the same on every
 *     attempt of the same call.
 *
 * | tool              | effect                  | retries | safe to repeat because |
 * | ----------------- | ----------------------- | ------- | ---------------------- |
 * | get_local_weather | network read            | 3       | read                   |
 * | get_notes         | local read              | 1       | read                   |
 * | read_file         | local read              | 1       | read                   |
 * | list_files        | local read              | 1       | read                   |
 * | write_file        | local write (overwrite) | 1       | upsert by path         |
 * | delete_file       | local write (delete)    | 1       | delete by path         |
 * | record_note       | local write (append)    | 1       | keyed on the step id   |
 *
 * Whether a tool may run at all is a separate question from how it runs:
 * `delete_file` is also gated on human approval, which is declared with the
 * tool in `index.ts`, not here. By the time this step runs, a person has
 * said yes.
 *
 * `coding_agent` is not here: it is a child workflow (see coding-agent.ts).
 */

const LOCAL_RETRIES = 1;

export async function getLocalWeather(input: LocalWeatherInput) {
  'use step';
  const weather = await import('@/lib/weather');
  // Throws on transient NWS failures, which is what triggers the retry.
  return weather.getLocalWeather(input);
}

export async function getNotes(input: { limit?: number }) {
  'use step';
  const notes = await import('@/lib/notes');
  return { notes: notes.getNotes(input.limit) };
}
getNotes.maxRetries = LOCAL_RETRIES;

export async function recordNote(input: { content: string }) {
  'use step';
  const notes = await import('@/lib/notes');
  return notes.recordNote(input.content, getStepMetadata().stepId);
}
recordNote.maxRetries = LOCAL_RETRIES;

export async function writeFile(input: { path: string; content: string }) {
  'use step';
  const files = await import('@/lib/files');
  const result = files.writeFile(input.path, input.content);
  return { path: files.normalizeFilePath(input.path), result };
}
writeFile.maxRetries = LOCAL_RETRIES;

export async function deleteFile(input: { path: string }) {
  'use step';
  const files = await import('@/lib/files');
  const deleted = files.deleteFile(input.path);
  return { path: files.normalizeFilePath(input.path), deleted };
}
deleteFile.maxRetries = LOCAL_RETRIES;

export async function readFile(input: { path: string }) {
  'use step';
  const files = await import('@/lib/files');
  return files.readFile(input.path) ?? { error: `No file at "${input.path}".` };
}
readFile.maxRetries = LOCAL_RETRIES;

export async function listFiles() {
  'use step';
  const files = await import('@/lib/files');
  return {
    files: files.listFiles().map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content),
      updated_at: file.updated_at,
    })),
  };
}
listFiles.maxRetries = LOCAL_RETRIES;
