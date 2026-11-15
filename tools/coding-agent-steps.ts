import type { HarnessWorkflowState } from '@ai-sdk/workflow-harness';
import type { SpanContext } from '@/lib/tracing/context';
import { getWritable } from 'workflow';

/**
 * Steps of `codingAgentWorkflow`. Kept apart from the workflow so the agent,
 * sandbox and tracing dependencies stay out of the workflow bundle; they are
 * imported inside the step bodies.
 */

const LIBRARY_DIR = 'library';

const INSTRUCTIONS = `You are a coding sub-agent working inside an isolated Linux sandbox.
Use the bash tool to write and run code (Node.js is installed) to complete the task.

The \`${LIBRARY_DIR}/\` directory in your working directory is a persistent library of
files shared across tasks. Before writing new code, list it and reuse what is there:
if a file already does the job, run it as is rather than reimplementing it. Files you
create or change inside \`${LIBRARY_DIR}/\` are saved for future tasks, so put only
reusable, working code there and keep scratch files elsewhere.

Verify your work by running it. Finish with a concise answer that states the result
and includes the relevant output.`;

interface Chunk {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * The sub-agent cannot be relied on to go looking, so the task itself names
 * what is already in the library.
 */
export async function prepareCodingTask(task: string): Promise<string> {
  'use step';
  const { listFiles } = await import('@/lib/files');
  const stored = listFiles().map((file) => file.path);
  if (stored.length === 0) return task;
  return `${task}\n\nFiles already in ${LIBRARY_DIR}/: ${stored.join(', ')}\nIf one of them does this job, read it and run it with the right arguments. Do not reimplement what it already does.`;
}

/**
 * Runs exactly one agent step: restore Pi from `state`, reattach to the
 * sandbox, let the model make one call and run its tools, then hand back the
 * next state.
 *
 * Nothing survives in memory between calls. A retry of this step repeats only
 * this one agent step, against the same sandbox.
 */
export async function advanceCodingAgent({
  state,
  sandboxId,
  stepIndex,
  previousLlmSpanId,
  trace,
}: {
  state: HarnessWorkflowState;
  sandboxId: string;
  stepIndex: number;
  previousLlmSpanId?: string;
  /** Where this sub-agent's spans go; absent if the parent is not traced. */
  trace?: SpanContext;
}) {
  'use step';
  const [
    { HarnessAgent },
    { createPi },
    { runHarnessAgentStep },
    { isStepCount },
    { getWorkflowMetadata },
    { acquireSandboxSession },
    { openScope },
    { piTracing },
    { CODING_AGENT_MODEL, TRACING_MODE },
    files,
  ] = await Promise.all([
    import('@ai-sdk/harness/agent'),
    import('@ai-sdk/harness-pi'),
    import('@ai-sdk/workflow-harness'),
    import('ai'),
    import('workflow'),
    import('@/lib/sandbox'),
    import('@/lib/tracing/tracer'),
    import('@/lib/tracing/pi'),
    import('@/lib/config'),
    import('@/lib/files'),
  ]);

  // Each step runs in its own invocation with no shared memory, so it opens
  // its own scope under the parent's tool call, with the step as the segment.
  const scope =
    trace && TRACING_MODE === 'custom'
      ? openScope(trace, {
          segment: stepIndex,
          attributes: {
            childRunId: getWorkflowMetadata().workflowRunId,
            agentStep: stepIndex,
          },
        })
      : undefined;
  const tracing = scope ? piTracing(scope, { previousLlmSpanId }) : undefined;

  let libraryDir: string | undefined;

  const agent = new HarnessAgent({
    harness: createPi({
      thinkingLevel: 'low',
      extensionFactories: tracing ? [tracing.extension] : [],
      // Always rebuild Pi from the persisted state, as a different process
      // would have to, instead of reusing a session cached in this one.
      reattachInProcess: false,
    }),
    id: 'coding-agent',
    model: CODING_AGENT_MODEL,
    instructions: INSTRUCTIONS,
    // One agent step per workflow step.
    stopWhen: isStepCount(1),
    sandboxConfig: {
      // Runs in every step that touches the sandbox, so the copy into
      // `library/` is guarded by a marker and happens once per sandbox.
      onSession: async ({ session, sessionWorkDir }) => {
        libraryDir = `${sessionWorkDir}/${LIBRARY_DIR}`;
        const marker = `${sessionWorkDir}/.library-ready`;
        if ((await session.stat({ path: marker })) != null) return;
        await session.run({ command: `mkdir -p '${libraryDir}'` });
        for (const file of files.listFiles()) {
          await session.writeTextFile({
            path: `${libraryDir}/${file.path}`,
            content: file.content,
          });
        }
        await session.writeTextFile({ path: marker, content: '' });
      },
    },
    // Traced from Pi's own events instead (see lib/tracing/pi.ts).
    telemetry: { isEnabled: TRACING_MODE !== 'custom' },
  });

  const sandboxSession = await acquireSandboxSession({
    id: sandboxId,
    create: state.status === 'not_started',
  });

  // The step's output goes to this run's durable stream (visible in the
  // workflow UI) and is also collected for the tool result.
  let text = '';
  const commands: string[] = [];
  const output = getWritable<Chunk>().getWriter();
  const writable = new WritableStream<Chunk>({
    async write(chunk) {
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
        text += chunk.delta;
      }
      if (chunk.type === 'tool-input-available') {
        const command = (chunk.input as { command?: unknown })?.command;
        if (typeof command === 'string') commands.push(command);
      }
      await output.write(chunk);
    },
  });

  try {
    const next = await runHarnessAgentStep({
      agent,
      state,
      sandboxSession,
      writable,
      destroyOnFinish: true,
    });
    return {
      state: next,
      text,
      commands,
      libraryDir,
      lastLlmSpanId: tracing?.lastLlmSpanId(),
    };
  } finally {
    output.releaseLock();
    await scope?.flush();
  }
}

/**
 * Copies files the agent created or changed under `library/` back to the
 * store. An upsert by path, so a retry rewrites the same rows.
 */
export async function saveLibrary({
  sandboxId,
  libraryDir,
}: {
  sandboxId: string;
  libraryDir: string;
}) {
  'use step';
  const { acquireSandboxSession } = await import('@/lib/sandbox');
  const files = await import('@/lib/files');
  const sandbox = await acquireSandboxSession({ id: sandboxId, create: false });

  const listing = await sandbox.run({
    command: `find . -type f -size -${files.MAX_FILE_BYTES}c -not -path '*/node_modules/*' -not -path '*/.git/*' | head -n 200`,
    workingDirectory: libraryDir,
  });
  const saved: Array<{ path: string; result: string }> = [];
  for (const line of listing.stdout.split('\n').filter(Boolean)) {
    const relativePath = line.replace(/^\.\//, '');
    const content = await sandbox.readTextFile({
      path: `${libraryDir}/${relativePath}`,
    });
    // Text only: skip anything unreadable or binary.
    if (content == null || content.includes('\0')) continue;
    const result = files.writeFile(relativePath, content);
    if (result !== 'unchanged') saved.push({ path: relativePath, result });
  }
  return saved;
}

export async function removeSandbox(sandboxId: string): Promise<void> {
  'use step';
  const { destroySandbox } = await import('@/lib/sandbox');
  await destroySandbox(sandboxId);
}
