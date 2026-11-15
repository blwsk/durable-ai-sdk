import type { PiHarnessSettings } from '@ai-sdk/harness-pi';
import type { TraceScope } from './tracer.js';

type Extension = NonNullable<PiHarnessSettings['extensionFactories']>[number];

const MAX_CHARS = 32_000;

/** Drops credentials and caps size before a payload leaves the process. */
function safe(value: unknown): unknown {
  let text =
    JSON.stringify(value, (name, item) =>
      /^(authorization|headers|api_?key|env|encrypted_content)$/i.test(name)
        ? '[omitted]'
        : item,
    ) ?? 'null';
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(_KEY|_TOKEN|_SECRET)$/.test(name) && secret && secret.length >= 8) {
      text = text.split(secret).join('[redacted]');
    }
  }
  if (text.length > MAX_CHARS) {
    return { truncated: true, preview: text.slice(0, MAX_CHARS) };
  }
  return JSON.parse(text);
}

/**
 * Adapter for the Pi coding agent: reports its model calls and tool
 * executions into a scope, from Pi's own events.
 *
 *   <scope>               e.g. the parent agent's tool call
 *     pi llm call
 *       bash
 *
 * It holds no state across invocations. When Pi runs one step at a time,
 * open the scope with a `segment` per step and pass the previous step's
 * `lastLlmSpanId()` so tools that run now nest under the call that asked.
 */
export function piTracing(
  scope: TraceScope,
  options: { label?: string; previousLlmSpanId?: string } = {},
): { extension: Extension; lastLlmSpanId: () => string | undefined } {
  const label = options.label ?? 'pi';
  let calls = 0;
  let model: { startMs: number; input: unknown; status?: number } | undefined;
  let lastLlmSpanId = options.previousLlmSpanId;
  const tools = new Map<
    string,
    { startMs: number; name: string; input: unknown; parentId?: string }
  >();

  const observe = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      // Tracing must never break the agent.
      console.warn('[tracing:pi]', error);
    }
  };

  const extension: Extension = (pi) => {
    pi.on('before_provider_request', (event) =>
      observe(() => {
        calls += 1;
        model = { startMs: Date.now(), input: safe(event.payload) };
      }),
    );
    pi.on('after_provider_response', (event) =>
      observe(() => {
        if (model) model.status = event.status;
      }),
    );
    pi.on('message_end', (event) =>
      observe(() => {
        const message = event.message;
        if (message.role !== 'assistant' || !model) return;
        // A step boundary interrupts Pi, which has usually already started
        // its next model call. That call is abandoned and made again by the
        // next step: real latency and tokens, but not a failure.
        const interrupted = message.stopReason === 'aborted';
        const usage = message.usage;
        const id = scope.span({
          key: `llm:${calls}`,
          name: interrupted
            ? `${label} llm call (interrupted)`
            : `${label} llm call`,
          kind: 'llm',
          startMs: model.startMs,
          endMs: Date.now(),
          input: model.input,
          output: safe(message.content),
          error:
            message.stopReason === 'error'
              ? (message.errorMessage ?? message.stopReason)
              : undefined,
          attributes: {
            provider: message.provider,
            model: message.model,
            stopReason: message.stopReason,
            interrupted,
            httpStatus: model.status,
          },
          usage: {
            // Pi counts uncached input separately from cache reads/writes.
            inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
            outputTokens: usage.output,
            totalTokens:
              usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
            cachedInputTokens: usage.cacheRead,
          },
        });
        if (!interrupted) lastLlmSpanId = id;
        model = undefined;
      }),
    );
    pi.on('tool_execution_start', (event) =>
      observe(() => {
        tools.set(event.toolCallId, {
          startMs: Date.now(),
          name: event.toolName,
          input: safe(event.args),
          parentId: lastLlmSpanId,
        });
      }),
    );
    pi.on('tool_execution_end', (event) =>
      observe(() => {
        const tool = tools.get(event.toolCallId);
        if (!tool) return;
        tools.delete(event.toolCallId);
        scope.span({
          key: `tool:${event.toolCallId}`,
          name: tool.name,
          kind: 'tool',
          parentId: tool.parentId,
          startMs: tool.startMs,
          endMs: Date.now(),
          input: tool.input,
          output: safe(event.result),
          error: event.isError ? 'Tool execution failed' : undefined,
          attributes: { toolCallId: event.toolCallId },
        });
      }),
    );
  };

  return { extension, lastLlmSpanId: () => lastLlmSpanId };
}
