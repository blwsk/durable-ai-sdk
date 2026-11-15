import { createHash } from 'node:crypto';

/**
 * Span ids are derived, never random.
 *
 * The spans of one trace may be written by different processes, by retried
 * steps, and by separate executions of the same logical unit. Deriving ids
 * means any of them can name any span without coordination, and writing a
 * span twice replaces it instead of duplicating it.
 *
 * The root and tool spans are keyed on the trace, so every execution that
 * shares a trace key addresses the same ones. LLM spans are keyed on the
 * execution, because step numbers restart in each.
 */
function derive(...parts: Array<string | number>): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export const spanIds = {
  /** Root span of the trace; also the trace's id. */
  root: (traceKey: string) => derive(traceKey, 'root'),
  llm: (runId: string, stepNumber: number) => derive(runId, 'llm', stepNumber),
  tool: (traceKey: string, toolCallId: string) =>
    derive(traceKey, 'tool', toolCallId),
  /** Spans nested inside another span, e.g. by a sub-agent. */
  child: (parentId: string, ...parts: Array<string | number>) =>
    derive(parentId, ...parts),
};
