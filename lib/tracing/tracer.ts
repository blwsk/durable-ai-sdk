import type { SpanContext } from './context';
import { spanIds } from './ids';
import type { SpanKind, SpanRecord, SpanSink, TokenUsage } from './types';

// One sink per process. It is kept on globalThis because a server can load
// this module more than once (separate bundles) within one process.
const globals = globalThis as { __tracingSink?: SpanSink };

/** Chooses where spans go. Call once per process, before any agent runs. */
export function configureTracing({ sink }: { sink: SpanSink }): void {
  globals.__tracingSink = sink;
}

const disabled: SpanSink = {
  write() {},
  update() {},
  flush: async () => {},
};

/** The configured sink, or one that discards everything. */
export function getSink(): SpanSink {
  return globals.__tracingSink ?? disabled;
}

export interface ScopedSpan {
  /** Unique within the scope; the span id is derived from it. */
  key: string | number;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs?: number;
  /** Id of another span in this scope to nest under. Defaults to the scope. */
  parentId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  attributes?: Record<string, unknown>;
  usage?: TokenUsage;
}

/**
 * A place to write spans that nest under one tool call of another agent's
 * trace. This is how a sub-agent, running anywhere, appears inside its
 * parent's trace: the parent passes a `SpanContext` (plain data), and the
 * sub-agent opens a scope from it.
 *
 * `segment` distinguishes separate invocations that write to the same scope,
 * such as the steps of a sub-agent that runs one step at a time.
 */
export function openScope(
  context: SpanContext,
  options: {
    segment?: string | number;
    attributes?: Record<string, unknown>;
  } = {},
) {
  const sink = getSink();
  const traceId = spanIds.root(context.traceKey);
  const scopeId = spanIds.tool(context.traceKey, context.parentToolCallId);
  return {
    /** Writes a span and returns its id, for use as a later `parentId`. */
    span(span: ScopedSpan): string {
      const { key, parentId, attributes, ...rest } = span;
      const id = spanIds.child(scopeId, options.segment ?? 0, key);
      const record: SpanRecord = {
        ...rest,
        id,
        traceId,
        parentId: parentId ?? scopeId,
        sessionId: context.sessionId,
        attributes: { ...options.attributes, ...attributes },
      };
      sink.write(record);
      return id;
    },
    flush: () => sink.flush(),
  };
}

export type TraceScope = ReturnType<typeof openScope>;
