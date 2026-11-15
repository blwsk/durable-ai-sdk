import { initLogger } from 'braintrust';
import type { SpanKind, SpanPatch, SpanRecord, SpanSink } from './types';

type Logger = ReturnType<typeof initLogger>;

const SPAN_TYPES: Record<SpanKind, 'task' | 'llm' | 'tool'> = {
  agent: 'task',
  llm: 'llm',
  tool: 'tool',
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function numbers(
  values: Record<string, number | undefined>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/**
 * Sends spans to Braintrust project logs.
 *
 * The row id equals the span id, so writing a span again replaces its row
 * and `update` merges into it. A conversation's traces are linked the way
 * Braintrust expects, by `metadata.session_id` on every span.
 */
export function braintrustSink(options: {
  project: string;
  apiKey?: string;
}): SpanSink {
  // Created on first use, so configuring tracing costs nothing by itself.
  let logger: Logger | undefined;
  const getLogger = () =>
    (logger ??= initLogger({
      projectName: options.project,
      apiKey: options.apiKey ?? process.env.BRAINTRUST_API_KEY,
    }));

  return {
    write(span: SpanRecord) {
      const row = getLogger().startSpan({
        name: span.name,
        type: SPAN_TYPES[span.kind],
        spanId: span.id,
        parentSpanIds: span.parentId
          ? { spanId: span.parentId, rootSpanId: span.traceId }
          : { parentSpanIds: [], rootSpanId: span.traceId },
        startTime: span.startMs / 1000,
        event: {
          id: span.id,
          input: span.input,
          output: span.output,
          metadata: {
            ...span.attributes,
            ...(span.sessionId == null ? {} : { session_id: span.sessionId }),
          },
          metrics: numbers({
            prompt_tokens: span.usage?.inputTokens,
            completion_tokens: span.usage?.outputTokens,
            tokens: span.usage?.totalTokens,
            prompt_cached_tokens: span.usage?.cachedInputTokens,
            completion_reasoning_tokens: span.usage?.reasoningTokens,
          }),
          ...(span.error == null ? {} : { error: formatError(span.error) }),
        },
      });
      if (span.endMs != null) row.end({ endTime: span.endMs / 1000 });
    },

    update(patch: SpanPatch) {
      const metrics = numbers({
        start: patch.startMs == null ? undefined : patch.startMs / 1000,
        end: patch.endMs == null ? undefined : patch.endMs / 1000,
      });
      getLogger().updateSpan({
        id: patch.id,
        ...(patch.output === undefined ? {} : { output: patch.output }),
        ...(patch.error == null ? {} : { error: formatError(patch.error) }),
        ...(patch.attributes == null ? {} : { metadata: patch.attributes }),
        ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        ...(patch.name == null
          ? {}
          : { span_attributes: { name: patch.name } }),
      } as Parameters<Logger['updateSpan']>[0]);
    },

    async flush() {
      await logger?.flush();
    },
  };
}
