// Makes this package importable by name from inside the repository, so the
// examples use it exactly as an installed dependency would:
//
//   node_modules/durable-ai-sdk -> the repository root
//
// Bun and npm workspaces do not link a workspace root into itself, and a
// `file:` dependency on the root would install a second copy of `ai`.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Only in a checkout of this repository, not when installed as a dependency.
if (existsSync(path.join(root, 'examples'))) {
  const link = path.join(root, 'node_modules', 'durable-ai-sdk');
  mkdirSync(path.dirname(link), { recursive: true });
  if (lstatSync(link, { throwIfNoEntry: false }))
    rmSync(link, { recursive: true });
  symlinkSync(root, link, 'dir');
}
