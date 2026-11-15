/**
 * Reads a turn's trace back from Braintrust and prints its span tree.
 *
 *   npm run trace -- <workflow run id> [--expect-tools]
 *
 * Exits non-zero unless the trace has exactly one root, every span hangs off
 * that root, every LLM call sits directly under the root, and every tool call
 * sits under the LLM call that requested it.
 */

const API = process.env.BRAINTRUST_API_URL ?? 'https://api.braintrust.dev';
const PROJECT = process.env.BRAINTRUST_PROJECT ?? 'durable-ai-sdk';
const headers = {
  authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
  'content-type': 'application/json',
};

interface SpanRow {
  span_id: string;
  span_parents: string[] | null;
  span_attributes: { name: string; type: string };
  metrics: { start?: number; end?: number; tokens?: number } | null;
  metadata: Record<string, unknown> | null;
  error: unknown;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function fetchSpans(projectId: string, rootId: string) {
  const { data } = await api<{ data: SpanRow[] }>('/btql', {
    method: 'POST',
    body: JSON.stringify({
      query: `select: span_id, span_parents, span_attributes, metrics, metadata, error | from: project_logs('${projectId}') spans | filter: root_span_id = '${rootId}' | limit: 500`,
      fmt: 'json',
    }),
  });
  return data;
}

const args = process.argv.slice(2);
const runId = args.find((arg) => !arg.startsWith('--'));
if (!runId) {
  console.error('usage: npm run trace -- <workflow run id> [--expect-tools]');
  process.exit(2);
}

const { objects } = await api<{ objects: Array<{ id: string }> }>(
  `/v1/project?project_name=${encodeURIComponent(PROJECT)}`,
);
if (objects.length === 0) throw new Error(`No Braintrust project "${PROJECT}"`);
// A trace is keyed on the turn, not the run, so look the trace up by a span
// this run wrote.
async function findRootId(projectId: string, run: string) {
  const { data } = await api<{ data: Array<{ root_span_id: string }> }>(
    '/btql',
    {
      method: 'POST',
      body: JSON.stringify({
        query: `select: root_span_id | from: project_logs('${projectId}') spans | filter: metadata.runId = '${run}' | limit: 1`,
        fmt: 'json',
      }),
    },
  );
  return data[0]?.root_span_id;
}

// Ingestion is asynchronous; wait for the completed root span to land.
let spans: SpanRow[] = [];
let rootId = '';
for (let attempt = 0; attempt < 20; attempt += 1) {
  rootId = (await findRootId(objects[0].id, runId)) ?? '';
  spans = rootId ? await fetchSpans(objects[0].id, rootId) : [];
  const root = spans.find((span) => span.span_id === rootId);
  if (root?.metrics?.end != null) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

const byId = new Map(spans.map((span) => [span.span_id, span]));
const childrenOf = (id: string) =>
  spans
    .filter((span) => span.span_parents?.[0] === id)
    .sort((a, b) => (a.metrics?.start ?? 0) - (b.metrics?.start ?? 0));

function print(span: SpanRow, depth: number) {
  const { start, end, tokens } = span.metrics ?? {};
  const duration =
    start != null && end != null ? `${(end - start).toFixed(2)}s` : 'open';
  console.log(
    `${'  '.repeat(depth)}${span.span_attributes.name} [${span.span_attributes.type}] ${duration}${tokens ? ` ${tokens} tok` : ''}${span.error ? ' ERROR' : ''}`,
  );
  for (const child of childrenOf(span.span_id)) print(child, depth + 1);
}

const problems: string[] = [];
const root = byId.get(rootId);
if (!root) {
  problems.push('root span not found');
} else {
  console.log(`trace ${rootId} (${spans.length} spans)\n`);
  print(root, 0);
  if (root.metrics?.end == null) problems.push('root span never ended');
}

const roots = spans.filter((span) => !span.span_parents?.length);
if (roots.length !== 1) problems.push(`expected 1 root, found ${roots.length}`);

for (const span of spans) {
  const parent = span.span_parents?.[0];
  if (parent == null) continue;
  const parentSpan = byId.get(parent);
  const { name, type } = span.span_attributes;
  if (!parentSpan) {
    problems.push(`${name}: parent ${parent} is missing`);
  } else if (type === 'llm' && name === 'llm call' && parent !== rootId) {
    problems.push(`${name}: expected to sit directly under the root`);
  } else if (type === 'tool' && parentSpan.span_attributes.type !== 'llm') {
    problems.push(`${name}: expected an llm parent`);
  }
}

const llmCalls = childrenOf(rootId).filter(
  (span) => span.span_attributes.type === 'llm',
);
if (llmCalls.length === 0) problems.push('no llm calls under the root');
if (
  args.includes('--expect-tools') &&
  !spans.some((span) => span.span_attributes.type === 'tool')
) {
  problems.push('no tool spans');
}

console.log(problems.length ? `\nFAIL\n- ${problems.join('\n- ')}` : '\nOK');
process.exit(problems.length ? 1 : 0);

export {};
