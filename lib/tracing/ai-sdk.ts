import { appendFileSync, mkdirSync } from 'node:fs';
import type { Telemetry } from 'ai';
import { TRACE_CONTEXT_KEY, type TraceContext } from './context';
import { spanIds } from './ids';
import { getSink } from './tracer';

/**
 * Turns the AI SDK's telemetry events into spans, for any agent that was set
 * up with `observeAgent`. Register it once per process:
 *
 *   registerTelemetry(aiSdkTracing());
 *
 * It produces one trace per trace key:
 *
 *   <agent>               root
 *     llm call
 *       <tool>            parent = the LLM call that requested it
 *
 * It is written for durable agents, where no process lives for a whole run:
 * each LLM call and tool call can be its own step, and a run that pauses for
 * human approval is finished by a second execution. The AI SDK therefore
 * delivers events in two phases, and both are used:
 *
 * - live: each LLM call is reported from inside its own step, as it happens.
 * - replay: when an execution ends, one step replays its recorded lifecycle
 *   (start, steps, tool executions, end) with the original timestamps.
 *
 * Span ids are derived (see ids.ts), so the phases, the processes and the
 * executions agree on the tree without sharing memory. An execution that
 * resumes after approval completes the tool span the earlier one left
 * waiting under the LLM call that asked for it.
 *
 * Nothing here knows which agent it observes or where spans are sent.
 */

type AnyEvent = Record<string, any>;

interface LiveCall extends TraceContext {
  stepNumber: number;
  startMs: number;
  input: unknown;
  /** About the request: provider, model, tools offered. */
  details: Record<string, unknown>;
}

interface Replay extends TraceContext {
  name: string;
  startMs: number;
  input: unknown;
  /** Continues a trace that an earlier execution paused for approval. */
  resumed: boolean;
  stepNumber: number;
  toolStarts: Map<string, { startMs: number; stepNumber: number }>;
  /** Steps of this execution in which the model was called. */
  llmSteps: Set<number>;
}

function traceOf(event: AnyEvent): TraceContext | undefined {
  const context =
    event.durableContext?.runtimeContext ?? event.runtimeContext ?? {};
  const trace = context[TRACE_CONTEXT_KEY];
  if (typeof trace?.traceKey !== 'string') return undefined;
  if (typeof trace?.runId !== 'string') return undefined;
  return trace as TraceContext;
}

/** Splits history into the user message being answered, and what follows. */
function splitRequest(messages: unknown): {
  request: unknown;
  /** Non-empty only when the execution resumes after an approval pause. */
  since: AnyEvent[];
} {
  if (!Array.isArray(messages)) return { request: messages, since: [] };
  const lastUser = messages.findLastIndex(
    (message: AnyEvent) => message?.role === 'user',
  );
  if (lastUser < 0) return { request: messages, since: [] };
  return {
    request: [messages[lastUser]],
    since: messages.slice(lastUser + 1),
  };
}

/** Tool calls the user refused, in the history a resumed execution starts from. */
function deniedToolCalls(
  since: AnyEvent[],
): Array<{ toolCallId: string; toolName: string }> {
  return since
    .flatMap((message) =>
      Array.isArray(message?.content) ? message.content : [],
    )
    .filter(
      (part: AnyEvent) =>
        part.type === 'tool-result' && part.output?.type === 'execution-denied',
    )
    .map((part: AnyEvent) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
    }));
}

/** Set TRACE_DEBUG to dump the raw events to `.data/telemetry-events.jsonl`. */
function debug(type: string, event: AnyEvent) {
  if (!process.env.TRACE_DEBUG) return;
  mkdirSync('.data', { recursive: true });
  appendFileSync(
    '.data/telemetry-events.jsonl',
    `${JSON.stringify({ type, event }, (_key, value) =>
      typeof value === 'string' && value.length > 400
        ? `${value.slice(0, 400)}…`
        : value,
    )}\n`,
  );
}

export function aiSdkTracing(): Telemetry {
  // Keyed by the execution's telemetry call id, which its model steps and
  // its final report share. Live entries only ever span a single step.
  const live = new Map<string, LiveCall>();
  const replays = new Map<string, Replay>();
  // Tool events that arrive before their execution's start event: a tool
  // approved by the user runs before anything else in the next execution.
  const earlyTools = new Map<string, Array<[string, AnyEvent]>>();
  const stashEarly = (type: string, event: AnyEvent) => {
    if (earlyTools.size > 100) earlyTools.clear();
    const events = earlyTools.get(event.callId) ?? [];
    events.push([type, event]);
    earlyTools.set(event.callId, events);
  };
  const base = (trace: TraceContext) => ({
    traceId: spanIds.root(trace.traceKey),
    sessionId: trace.sessionId,
  });

  const integration: Record<string, unknown> = {
    experimental_durable: {
      /**
       * Runs once per execution, in a step, before its first LLM call.
       * Returning a context is what opts in to live LLM events.
       */
      async captureContext(event: AnyEvent) {
        debug('captureContext', event);
        const trace = traceOf(event);
        // An execution that begins by running an approved tool passes that
        // tool event here, without a trace context. Its root already exists.
        if (trace != null && splitRequest(event.messages).since.length === 0) {
          // Open the root now, so a run that is still in flight (or that
          // dies) is visible as a trace.
          getSink().write({
            ...base(trace),
            id: spanIds.root(trace.traceKey),
            name: event.functionId ?? 'agent',
            kind: 'agent',
            startMs: Date.now(),
            input: splitRequest(event.messages).request,
            attributes: {
              ...trace.attributes,
              runId: trace.runId,
              status: 'running',
            },
          });
          await getSink().flush();
        }
        // These ids are placeholders: live events carry the trace context,
        // from which the real ones are derived.
        const id = trace?.runId ?? event.callId ?? 'unknown';
        return {
          traceId: id,
          rootSpanId: id,
          traceFlags: 1,
          samplingDecision: 2 as const,
        };
      },
    },

    onStart(event: AnyEvent) {
      debug('onStart', event);
      if (event.durableContext?.phase !== 'replay') return;
      const trace = traceOf(event);
      if (trace == null) return;
      const { request, since } = splitRequest(event.messages);
      const startMs = event.timestamp ?? Date.now();
      replays.set(event.callId, {
        ...trace,
        name: event.functionId ?? 'agent',
        startMs,
        input: request,
        resumed: since.length > 0,
        stepNumber: 0,
        toolStarts: new Map(),
        llmSteps: new Set(),
      });
      // A denied call never executes, so no tool event reports it. Close
      // the span the earlier execution left waiting.
      for (const { toolCallId, toolName } of deniedToolCalls(since)) {
        getSink().update({
          id: spanIds.tool(trace.traceKey, toolCallId),
          name: `${toolName} (denied)`,
          endMs: startMs,
          output: { denied: true },
          attributes: { status: 'denied', approval: 'denied' },
        });
      }
      for (const [type, early] of earlyTools.get(event.callId) ?? []) {
        (integration[type] as (event: AnyEvent) => void)(early);
      }
      earlyTools.delete(event.callId);
    },

    onStepStart(event: AnyEvent) {
      debug('onStepStart', event);
      const replay = replays.get(event.callId);
      if (replay) replay.stepNumber = event.stepNumber ?? replay.stepNumber;
    },

    onLanguageModelCallStart(event: AnyEvent) {
      debug('onLanguageModelCallStart', event);
      const context = event.durableContext;
      if (context?.phase !== 'live') {
        const replay = replays.get(event.callId);
        replay?.llmSteps.add(replay.stepNumber);
        return;
      }
      const trace = traceOf(event);
      if (trace == null) return;
      live.set(event.callId, {
        ...trace,
        stepNumber: context.stepNumber ?? 0,
        startMs: Date.now(),
        input: event.messages ?? event.prompt,
        details: {
          provider: event.provider,
          model: event.modelId,
          tools: event.tools?.map((tool: AnyEvent) => tool.name),
        },
      });
    },

    async onLanguageModelCallEnd(event: AnyEvent) {
      debug('onLanguageModelCallEnd', event);
      const call = live.get(event.callId);
      // No live entry: this is the end-of-execution replay of a call that
      // was already written from its own step.
      if (call == null) return;
      live.delete(event.callId);
      const usage = event.usage ?? {};
      getSink().write({
        ...base(call),
        id: spanIds.llm(call.runId, call.stepNumber),
        parentId: spanIds.root(call.traceKey),
        name: 'llm call',
        kind: 'llm',
        startMs: call.startMs,
        endMs: Date.now(),
        input: call.input,
        output: event.content,
        attributes: {
          ...call.details,
          runId: call.runId,
          stepNumber: call.stepNumber,
          finishReason: event.finishReason,
          responseId: event.responseId,
        },
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        },
      });
      await getSink().flush();
    },

    onToolExecutionStart(event: AnyEvent) {
      debug('onToolExecutionStart', event);
      const replay = replays.get(event.callId);
      const toolCallId = event.toolCall?.toolCallId;
      if (replay == null) return stashEarly('onToolExecutionStart', event);
      if (toolCallId == null) return;
      replay.toolStarts.set(toolCallId, {
        startMs: event.timestamp ?? Date.now(),
        stepNumber: event.stepNumber ?? replay.stepNumber,
      });
    },

    onToolExecutionEnd(event: AnyEvent) {
      debug('onToolExecutionEnd', event);
      const replay = replays.get(event.callId);
      const toolCall = event.toolCall;
      if (replay == null) return stashEarly('onToolExecutionEnd', event);
      if (toolCall?.toolCallId == null) return;
      const endMs = event.timestamp ?? Date.now();
      const start = replay.toolStarts.get(toolCall.toolCallId) ?? {
        startMs: endMs - (event.toolExecutionMs ?? 0),
        stepNumber: replay.stepNumber,
      };
      const failed = event.toolOutput?.type === 'tool-error';
      const id = spanIds.tool(replay.traceKey, toolCall.toolCallId);
      const output = failed ? undefined : event.toolOutput?.output;
      const error = failed ? event.toolOutput?.error : undefined;

      if (!replay.llmSteps.has(start.stepNumber)) {
        // No model call in this execution asked for this tool: the user
        // approved it. Its span already exists, waiting under the LLM call
        // of the earlier execution that requested it, so complete that one.
        getSink().update({
          id,
          startMs: start.startMs,
          endMs,
          output,
          error,
          attributes: {
            status: failed ? 'failed' : 'approved',
            approval: 'approved',
            executedByRunId: replay.runId,
          },
        });
        return;
      }

      getSink().write({
        ...base(replay),
        id,
        parentId: spanIds.llm(replay.runId, start.stepNumber),
        name: toolCall.toolName,
        kind: 'tool',
        startMs: start.startMs,
        endMs,
        input: toolCall.input,
        output,
        error,
        attributes: { runId: replay.runId, toolCallId: toolCall.toolCallId },
      });
    },

    onStepEnd(event: AnyEvent) {
      debug('onStepEnd', event);
    },

    async onEnd(event: AnyEvent) {
      debug('onEnd', event);
      // An execution that stops to ask for approval ends without text.
      // Leave a span waiting under the model call that made each request;
      // the execution that resumes completes it.
      const requests: AnyEvent[] = (event.content ?? []).filter(
        (part: AnyEvent) => part.type === 'tool-approval-request',
      );
      const replay = replays.get(event.callId);
      if (replay != null) {
        for (const { toolCall } of requests) {
          getSink().write({
            ...base(replay),
            id: spanIds.tool(replay.traceKey, toolCall.toolCallId),
            parentId: spanIds.llm(replay.runId, replay.stepNumber),
            name: toolCall.toolName,
            kind: 'tool',
            startMs: event.timestamp ?? Date.now(),
            input: toolCall.input,
            attributes: {
              runId: replay.runId,
              toolCallId: toolCall.toolCallId,
              approval: 'requested',
              status: 'awaiting_approval',
            },
          });
        }
      }
      const awaitingApproval = requests.map(({ toolCall }) => ({
        tool: toolCall.toolName,
        input: toolCall.input,
      }));
      await finish(event, {
        output: awaitingApproval.length > 0 ? { awaitingApproval } : event.text,
        status: awaitingApproval.length > 0 ? 'awaiting_approval' : undefined,
        totalTokens: event.totalUsage?.totalTokens,
      });
    },

    async onAbort(event: AnyEvent) {
      debug('onAbort', event);
      await finish(event, { error: 'Run ended without completing' });
    },

    async onError(event: AnyEvent) {
      debug('onError', event);
      live.delete(event.callId);
      await finish(event, { error: event.error ?? 'Run failed' });
    },
  };

  async function finish(
    event: AnyEvent,
    result: {
      output?: unknown;
      error?: unknown;
      status?: string;
      totalTokens?: number;
    },
  ) {
    const replay = replays.get(event.callId);
    if (replay == null) return;
    replays.delete(event.callId);
    const id = spanIds.root(replay.traceKey);
    const endMs = event.timestamp ?? Date.now();
    const status =
      result.status ?? (result.error == null ? 'completed' : 'failed');

    if (replay.resumed) {
      // The earlier execution wrote the root, with the request and start
      // time. Extend it rather than replace it.
      getSink().update({
        id,
        endMs,
        output: result.output,
        error: result.error,
        attributes: { status, resumedByRunId: replay.runId },
      });
    } else {
      getSink().write({
        ...base(replay),
        id,
        name: replay.name,
        kind: 'agent',
        startMs: replay.startMs,
        endMs,
        input: replay.input,
        output: result.output,
        error: result.error,
        attributes: {
          ...replay.attributes,
          runId: replay.runId,
          status,
          totalTokens: result.totalTokens,
        },
      });
    }
    await getSink().flush();
  }

  return integration as Telemetry;
}
