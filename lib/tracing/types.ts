/**
 * The vocabulary shared by the tracing core and its providers. Nothing here
 * is specific to an agent, a framework, or a tracing product.
 */

export type SpanKind = 'agent' | 'llm' | 'tool';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/** One complete span. Writing the same `id` again replaces it. */
export interface SpanRecord {
  id: string;
  /** Id of the trace's root span. */
  traceId: string;
  /** Omit for the root span. */
  parentId?: string;
  name: string;
  kind: SpanKind;
  /** Milliseconds since the Unix epoch. */
  startMs: number;
  /** Leave unset to write a span that is still running. */
  endMs?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  /** Groups the traces of one conversation. */
  sessionId?: string;
  attributes?: Record<string, unknown>;
  usage?: TokenUsage;
}

/** Fields to merge into a span that was already written, possibly elsewhere. */
export interface SpanPatch {
  id: string;
  name?: string;
  startMs?: number;
  endMs?: number;
  output?: unknown;
  error?: unknown;
  attributes?: Record<string, unknown>;
}

/**
 * A tracing provider. Implement these three methods to send traces
 * somewhere; see `braintrust.ts` for one.
 */
export interface SpanSink {
  write(span: SpanRecord): void;
  /** Must leave the span's parent, input and unnamed fields untouched. */
  update(patch: SpanPatch): void;
  /** Resolves once everything written so far has been delivered. */
  flush(): Promise<void>;
}
