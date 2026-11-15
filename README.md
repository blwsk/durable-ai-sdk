# durable-ai-sdk

Tracing for durable agents built with the Vercel AI SDK. One agent turn
becomes one trace, with tool calls nested under the model call that requested
them and sub-agents inside the same tree:

```
agent turn                 root
  llm call
    get_local_weather
  llm call
    coding_agent           a tool that is another agent
      pi llm call
        bash
  llm call
```

It is generic in two directions. The agent only wraps its settings in
`observeAgent`; the library does not know which agent it observes. Spans go to
a provider behind a three-method interface; a Braintrust provider is included.

It exists because a durable agent has no process that lives for a whole turn.
The workflow body is replayed after every step, each model call and tool call
can run in its own invocation, and a turn that pauses for human approval is
finished by a second run. Tracing that keeps open spans in memory cannot follow
that. This library derives every span id instead, so separate processes and
runs write into one tree without coordinating.

[`examples/nextjs`](examples/nextjs) is a complete application that uses it.

## Runtime requirements

- **`ai` 7.0.170 or later** (the peer dependency). The library relies on the
  AI SDK's telemetry hooks for durable runs. They are present in 7.0.170, the
  version it was built and tested against, and absent from 7.0.62.
- **Agents built with `WorkflowAgent`** from `@ai-sdk/workflow`, running in a
  Vercel Workflow. Tested with `@ai-sdk/workflow` 2.0.102 and `workflow`
  5.5.0. Agents that call `streamText`, `generateText` or `ToolLoopAgent`
  directly are not traced.
- **Node.js** for the main entry point (it uses `node:crypto`). The
  `durable-ai-sdk/context` entry point has no Node dependencies, so it can be
  imported in a workflow body.
- **ESM only.**
- **Registered in every process that executes workflow steps**, before any
  agent runs.
- **Optional peers:** `braintrust` 3 or later for the Braintrust provider
  (tested with 3.44.0, needs `BRAINTRUST_API_KEY`), and `@ai-sdk/harness-pi`
  for the Pi adapter (tested with 1.0.184).

`ai` and the `@ai-sdk/*` packages pin each other to exact versions, so install
a matching set.

## Install

The package is not published to npm. Install it from GitHub:

```bash
bun add github:blwsk/durable-ai-sdk
```

A git install builds the package on your machine through its `prepare`
script, which needs the package's dev dependencies and permission to run
lifecycle scripts (in Bun, add it to `trustedDependencies`). This path has not
been tested; inside this repository the example uses a local link instead.

## Usage

### 1. Choose a provider, once per process

In Next.js this goes in `instrumentation.ts`:

```ts
import { registerTelemetry } from 'ai';
import { aiSdkTracing, configureTracing } from 'durable-ai-sdk';
import { braintrustSink } from 'durable-ai-sdk/braintrust';

configureTracing({ sink: braintrustSink({ project: 'my-project' }) });
registerTelemetry(aiSdkTracing());
```

### 2. Observe the agent

Describe the turn, then wrap the agent's settings:

```ts
import { WorkflowAgent } from '@ai-sdk/workflow';
import { observeAgent, type TraceContext } from 'durable-ai-sdk/context';

export async function agentTurn({ sessionId, messages }) {
  'use workflow';

  const trace: TraceContext = {
    traceKey: `${sessionId}:${lastUserMessageId}`,
    runId: getWorkflowMetadata().workflowRunId,
    sessionId,
  };

  const agent = new WorkflowAgent(
    observeAgent(trace, { name: 'agent turn', model, instructions, tools }),
  );
  // agent.stream(...) as usual
}
```

| Field        |                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `traceKey`   | Names the trace. Every run that passes the same key writes into the same trace, so choose something stable for the turn, not the run id. |
| `runId`      | Names this execution.                                                                                                                    |
| `sessionId`  | Optional. Groups the traces of one conversation.                                                                                         |
| `attributes` | Optional. Added to the root span.                                                                                                        |

That is all an agent needs for the root span, its model calls and its tool
calls. Tools are not wrapped or changed.

### 3. Nest a sub-agent

Declare a tool that runs another agent with `subAgentTool`. Its `execute`
receives a `trace` naming that tool call's span:

```ts
import { subAgentTool } from 'durable-ai-sdk/context';

const tools = {
  coding_agent: subAgentTool({
    description: '…',
    inputSchema: z.object({ task: z.string() }),
    execute: async (input, { trace }) => {
      const run = await start(codingAgentWorkflow, [
        { task: input.task, trace },
      ]);
      return run.returnValue;
    },
  }),
};
```

`trace` is plain data, so it can cross a workflow, step or process boundary.
Wherever the sub-agent runs, open a scope from it and write spans there:

```ts
import { openScope } from 'durable-ai-sdk';

const scope = openScope(trace, { segment: stepIndex });
const id = scope.span({
  key: 'llm:1',
  name: 'llm call',
  kind: 'llm',
  startMs,
  endMs,
  input,
  output,
});
scope.span({
  key: 'tool:abc',
  name: 'bash',
  kind: 'tool',
  parentId: id,
  startMs,
  endMs,
});
await scope.flush();
```

Use `segment` when separate invocations write into the same scope, such as a
sub-agent that runs one step per workflow step. For the Pi coding agent there
is an adapter that does this from Pi's own events:

```ts
import { piTracing } from 'durable-ai-sdk/pi';

const tracing = piTracing(scope, { previousLlmSpanId });
createPi({ extensionFactories: [tracing.extension] });
```

## Entry points

| Import                      | Contents                                                             | Loads                |
| --------------------------- | -------------------------------------------------------------------- | -------------------- |
| `durable-ai-sdk`            | `configureTracing`, `aiSdkTracing`, `openScope`, span and sink types | `ai`, Node built-ins |
| `durable-ai-sdk/context`    | `observeAgent`, `subAgentTool`, `TraceContext`, `SpanContext`        | `ai` only            |
| `durable-ai-sdk/braintrust` | `braintrustSink`                                                     | `braintrust`         |
| `durable-ai-sdk/pi`         | `piTracing`                                                          | `@ai-sdk/harness-pi` |

## Writing a provider

Implement `SpanSink` and pass it to `configureTracing`:

```ts
import type { SpanSink } from 'durable-ai-sdk';

const sink: SpanSink = {
  write(span) {}, // a complete span; the same id again replaces it
  update(patch) {}, // merge fields into a span written earlier
  async flush() {}, // resolve once everything written is delivered
};
```

Two properties matter. Writing a span with an id that already exists must
replace it, because a retried step writes its spans again. `update` must leave
the span's parent, input and unnamed fields alone, because a later run uses it
to finish a span an earlier run started.

## How it works

- **Span ids are derived.** The root is `hash(traceKey)`, a tool call is
  `hash(traceKey, toolCallId)`, a model call is `hash(runId, stepNumber)`.
  Any process can name any span, and nothing has to be shared in memory.
- **Model calls are written as they happen**, from inside their step. The
  root span is opened at the start, so a turn in flight is visible.
- **The root and tool spans are written when a run ends.** `WorkflowAgent`
  replays the run's recorded lifecycle, with original timestamps, in one step.
- **A turn that pauses for approval stays one trace.** The first run leaves an
  open tool span under the model call that requested it. The second run has
  the same trace key, so it completes that span (approved and run, or denied)
  and adds its own model calls under the same root.
- **Sub-agents write directly into the parent's trace**, under the id their
  tool span has.

## Limits

- Tool spans appear when a run ends. A run that dies and is never resumed
  leaves a trace with an open root and its model calls, but no tool spans.
- Sub-agent nesting needs an adapter per sub-agent runtime. One is included,
  for Pi.
- Braintrust is the only provider, so the `SpanSink` interface has not been
  exercised against a second one.
- The durable telemetry hooks in the AI SDK are marked experimental.

## Development

```
src/              the library
examples/nextjs/  an application that uses it
```

```bash
bun install       # installs the workspace and builds the library to dist/
bun run build     # rebuild after changing src/
bun run typecheck
```

`bun install` also links the package into `node_modules` under its own name,
so the example imports it the way a consumer would.
