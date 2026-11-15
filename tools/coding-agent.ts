import { start } from 'workflow/api';
import type { SpanContext } from '@/lib/tracing/context';
import { codingAgentWorkflow } from '@/workflows/coding-agent';

/**
 * Sub-agent as a tool, run as a child workflow.
 *
 * Unlike the other tools this is not a step: it runs in the parent workflow
 * body, starts `codingAgentWorkflow` as its own run, and suspends until that
 * run finishes. `start()` is recorded like a step, so replaying the parent
 * finds the same child instead of starting another, and waiting costs nothing.
 *
 * A failed child rejects `returnValue`, which reaches the model as a tool
 * error.
 */
export async function runCodingAgent(
  input: { task: string },
  { trace }: { trace?: SpanContext },
) {
  const run = await start(codingAgentWorkflow, [
    // `trace` is plain data naming this tool call's span in the parent's
    // trace; the child opens a scope from it to nest its own spans there.
    { task: input.task, trace },
  ]);
  return { ...(await run.returnValue), childRunId: run.runId };
}
