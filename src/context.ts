import { tool, type FlexibleSchema, type ToolExecutionOptions } from 'ai';

/**
 * The part of the tracing library an agent implementation touches. It is
 * pure data and closures, with no Node or provider dependencies, so it is
 * safe to import where an agent is defined (including a workflow body).
 *
 *   const agent = new WorkflowAgent(
 *     observeAgent(trace, { model, instructions, tools }),
 *   );
 *
 * Everything else (what a span is, where it goes) lives behind that call.
 */

/** Serializable identity of one traced unit of agent work. */
export interface TraceContext {
  /**
   * Names the trace. Every execution that passes the same key writes into the
   * same trace, which is how work that spans several executions (a retried
   * step, a run resumed after human approval) stays one tree.
   */
  traceKey: string;
  /** Names this execution, e.g. a workflow run id. */
  runId: string;
  /** Groups the traces of one conversation. */
  sessionId?: string;
  /** Added to the root span. */
  attributes?: Record<string, string | number | boolean>;
}

/** A place in a trace to nest spans under: one tool call of the parent. */
export interface SpanContext extends TraceContext {
  parentToolCallId: string;
}

/** The key under which the trace context travels in `runtimeContext`. */
export const TRACE_CONTEXT_KEY = 'trace';

const SUB_AGENT = Symbol.for('tracing.subAgent');

type SubAgentExecute<INPUT, OUTPUT> = (
  input: INPUT,
  options: { toolCallId: string; trace?: SpanContext },
) => Promise<OUTPUT>;

/**
 * Defines a tool whose work is another agent. Its `execute` receives a
 * `trace` that places the sub-agent's spans under this tool call, in the
 * parent's trace. Hand that context to wherever the sub-agent runs (it is
 * plain data) and open a scope from it there; see `openScope`.
 *
 * `trace` is set once the tool is given to an agent through `observeAgent`.
 */
export function subAgentTool<INPUT, OUTPUT>(definition: {
  description: string;
  inputSchema: FlexibleSchema<INPUT>;
  execute: SubAgentExecute<INPUT, OUTPUT>;
}) {
  const observed = tool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: (async (input: INPUT, options: ToolExecutionOptions<unknown>) =>
      definition.execute(input, { toolCallId: options.toolCallId })) as never,
  });
  Object.defineProperty(observed, SUB_AGENT, { value: definition.execute });
  return observed as typeof observed & {
    execute: (
      input: INPUT,
      options: ToolExecutionOptions<unknown>,
    ) => Promise<OUTPUT>;
  };
}

/**
 * Makes an agent observed: returns its settings with tracing attached, so the
 * agent run becomes a root span, each model call a child of it, and each tool
 * call a child of the model call that requested it. Sub-agent tools are bound
 * to this trace so their spans nest under their tool call.
 *
 * `name` labels the root span.
 */
export function observeAgent<
  SETTINGS extends { tools?: Record<string, unknown> },
>(trace: TraceContext, settings: SETTINGS & { name?: string }) {
  const { name, ...rest } = settings;
  const tools = Object.fromEntries(
    Object.entries(rest.tools ?? {}).map(([toolName, definition]) => {
      const execute = (definition as Record<symbol, unknown>)?.[SUB_AGENT] as
        SubAgentExecute<unknown, unknown> | undefined;
      if (execute == null) return [toolName, definition];
      return [
        toolName,
        {
          ...(definition as object),
          execute: (input: unknown, options: ToolExecutionOptions<unknown>) =>
            execute(input, {
              toolCallId: options.toolCallId,
              trace: { ...trace, parentToolCallId: options.toolCallId },
            }),
        },
      ];
    }),
  );
  return {
    ...(rest as unknown as SETTINGS),
    tools: tools as SETTINGS['tools'],
    runtimeContext: { [TRACE_CONTEXT_KEY]: trace } as { trace: TraceContext },
    telemetry: {
      functionId: name ?? 'agent',
      includeRuntimeContext: { [TRACE_CONTEXT_KEY]: true } as { trace: true },
    },
  };
}
