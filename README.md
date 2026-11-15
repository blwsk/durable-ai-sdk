# durable-ai-sdk

A minimal agent whose whole tool loop is durable: the Vercel AI SDK's
`WorkflowAgent` runs inside a Vercel Workflow, so every LLM call and every tool
call is its own recorded step. Kill the server mid-turn and the turn resumes
from the last completed step. Each turn is one Braintrust trace:

```
agent turn                 root span: owns the whole loop
  llm call
    get_local_weather
  llm call
    coding_agent           sub-agent as a tool
      pi llm call
        bash               runs in the sandbox
  llm call                 final output
```

## Run it

Requires Node 22.13+ and Docker (for the local sandbox).

```bash
bun install            # or npm install
docker pull node:24-bookworm-slim
bun dev                # http://localhost:3000
```

`.env.local` needs `OPENAI_API_KEY` and `BRAINTRUST_API_KEY`. Optional:

| Variable             | Default                       |                                                                                                                           |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MODEL`        | `gpt-5.4-mini`                | orchestrator model                                                                                                        |
| `CODING_AGENT_MODEL` | `openai/gpt-5.4-mini`         | Pi model, as `<provider>/<id>`                                                                                            |
| `BRAINTRUST_PROJECT` | `durable-ai-sdk`              |                                                                                                                           |
| `SANDBOX_PROVIDER`   | `docker` (`vercel` on Vercel) |                                                                                                                           |
| `TRACING_MODE`       | `custom`                      | `default` = Braintrust's stock AI SDK adapter; `otel` = AI SDK OpenTelemetry exported to Braintrust (both for comparison) |
| `TRACE_DEBUG`        | unset                         | dump telemetry events to `.data/`                                                                                         |

Everything is local: workflows use the Local World (state in
`.next/workflow-data`, inspect with `npx workflow web`), the sandbox is a
throwaway Docker container, notes and library files go to SQLite at
`.data/notes.db`.

## Verify a trace

The UI shows the workflow run id of the last turn (it is also the
`x-workflow-run-id` response header). This finds the trace that run wrote to,
reads it back from Braintrust,
prints the tree, and fails if the shape is wrong:

```bash
bun run trace <run id> --expect-tools
```

## See the durability

1. Ask: _"Record a note saying 'started', then have the coding agent print the
   first 10 primes, then record them as a second note."_
2. While `coding_agent` is running, `kill -9` the dev server.
3. Start it again. The run resumes on boot: the first note is not written
   again, the coding agent continues from the agent step it was on in the
   same sandbox, and the trace is still one tree.

## How it fits together

| File                                             |                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `workflows/agent-turn.ts`                        | `'use workflow'`: one `WorkflowAgent.stream()` call per turn                   |
| `tools/index.ts`                                 | what the model sees: tool names, descriptions, schemas                         |
| `tools/durable.ts`                               | the `'use step'` wrappers, with each tool's retry and idempotency policy       |
| `lib/notes.ts`, `lib/files.ts`, `lib/weather.ts` | the tool logic as plain functions; weather is adapted from an existing tool    |
| `tools/coding-agent.ts`                          | starts the coding agent as a child workflow and awaits it                      |
| `workflows/coding-agent.ts`                      | child workflow: one durable step per Pi agent step                             |
| `tools/coding-agent-steps.ts`                    | its steps: run one agent step, save the library, remove sandbox                |
| `lib/sandbox/`                                   | Docker session locally, `@ai-sdk/sandbox-vercel` when deployed                 |
| `lib/tracing/`                                   | a tracing library that is generic to the agent and to the provider (see below) |
| `app/api/chat/`                                  | starts the run; `[runId]/stream` reconnects to it                              |

### The coding agent is a child workflow

`coding_agent` is not a step. Its `execute` runs in the parent workflow body,
calls `start(codingAgentWorkflow)` and awaits `run.returnValue`; the parent
suspends until the child finishes. The child is its own run (see it in
`npx workflow web`) with its own event log and failure boundary.

Inside the child, `@ai-sdk/workflow-harness` runs Pi one agent step per
workflow step. Between steps the agent is only serializable state: Pi's
session travels in the step result, and the sandbox is a container named
after the run that each step reattaches to. A crash resumes at the
interrupted agent step with the sandbox's files intact.

The child's spans still land in the parent's trace: the parent passes its run
id and the tool call id, and the child derives the same span ids from them.

The cost: a step boundary is made by interrupting Pi, which has usually
already begun its next model call. That call is abandoned and repeated by the
next step. It shows in the trace as `pi llm call (interrupted)`, roughly a
second each, and makes a multi-step task noticeably slower than running it
as one step.

### Approval before a destructive tool

`delete_file` has `needsApproval: true`. When the model calls it, the agent
loop stops and the run ends with an approval request in the stream. The page
shows Approve and Deny; answering sends the conversation back, and a new run
executes the approved call as a step before its first model call.

- A denial is final for that turn: `delete_file` and `write_file` are
  withdrawn from the run that follows one (`activeTools` in
  `workflows/agent-turn.ts`). Telling the model was not enough: it asked
  again, and once emptied the denied file with `write_file` instead.
- Both runs share one trace. The first leaves an open `delete_file` span
  under the model call that requested it and ends with status
  `awaiting_approval`. The second completes that same span, as `delete_file`
  (approved and run) or `delete_file (denied)`, then adds its own model
  calls under the same root.
- The pending request is not held by a suspended run. It lives in the
  conversation, which this demo keeps only in the browser, so a page reload
  loses it. Persisting conversations server-side would make it survive.
- Requests are not signed. Set `experimental_toolApprovalSecret` on the agent
  before trusting approvals from an untrusted client.

SQLite doubles as a small file system (`files` table, one row per relative
path; `lib/files.ts`). The orchestrator edits it with `write_file`,
`read_file` and `list_files`. The coding agent sees the same files on disk:

- **In:** when its sandbox session starts, every stored file is copied to
  `library/` in the working directory, and the task prompt lists what is
  there so the agent runs existing code instead of rewriting it.
- **Out:** when the turn ends, files the agent created or changed under
  `library/` are upserted back (text files under 256 KB; deletions are not
  propagated).

Try: _"Create primes.js in the file library: prints all primes up to N."_ then
_"How many primes are there up to 7000? Compute it."_ The second turn runs
`node library/primes.js 7000`.

### The tracing library

`lib/tracing/` knows nothing about this agent or about Braintrust. The agent
uses three functions from it:

```ts
// The agent: root span, model calls, tool calls.
new WorkflowAgent(observeAgent(trace, { name, model, instructions, tools }));

// A tool that is another agent: its spans nest under this tool call.
coding_agent: subAgentTool({ description, inputSchema, execute }),
//   execute(input, { trace })  → pass `trace` to wherever the sub-agent runs

// Inside the sub-agent: write spans into the parent's trace.
const scope = openScope(trace, { segment: stepIndex });
```

`trace` is plain data (`traceKey`, `runId`, `sessionId`), so it can cross a
workflow, step or process boundary.

| File                 |                                                                   |
| -------------------- | ----------------------------------------------------------------- |
| `context.ts`         | `observeAgent`, `subAgentTool`; safe to import in a workflow body |
| `ai-sdk.ts`          | turns AI SDK telemetry events into spans, for any observed agent  |
| `tracer.ts`          | `configureTracing({ sink })`, `openScope`                         |
| `ids.ts`, `types.ts` | derived span ids; the span and provider types                     |
| `pi.ts`              | adapter that reports the Pi coding agent into a scope             |
| `braintrust.ts`      | the Braintrust provider: `write`, `update`, `flush`               |

Choosing the provider is three lines in `instrumentation.ts`. Another
provider is another implementation of the `SpanSink` interface.

### Tracing a loop that no process owns

The workflow body is replayed after every step and steps can run in different
processes, so no in-memory span can wrap the loop. Instead:

- **Span ids are derived** (`lib/tracing/ids.ts`): root =
  `hash(turnKey)`, tool call = `hash(turnKey, toolCallId)`, LLM call =
  `hash(runId, stepNumber)`. Any process can name any span, and a retried step
  rewrites its own row.
- **A trace follows the turn, not the run.** The turn key is the session id
  plus the id of the user message being answered. A turn that pauses for
  approval is finished by a second run, and both write into one tree.
- **LLM calls are written live**, from inside their step.
- **The root and tool spans are written when the run ends**, when
  `WorkflowAgent` replays the recorded lifecycle (with original timestamps) to
  the integration in a single step. The root is also opened at the start, so an
  in-flight run is visible.
- **The sub-agent's spans are written live** under the id its tool span will
  have.

### Linking the turns of a conversation

Each turn stays its own trace. Braintrust has no session object, so turns are
linked by a shared key: the client sends its chat id, and every span of every
turn carries it as `metadata.session_id` (the root also has `metadata.turn`).
Filter logs on `metadata.session_id` to see a conversation, or use it as the
"Group by" key of an online scoring rule to score the conversation as a whole.

The root span's input is only the new user message. The full history the
model saw, earlier turns included, is on the LLM spans.

### Things to know

- Pi runs in the Node process; its tools (bash, read, write, edit) run in the
  sandbox. That is how `@ai-sdk/harness-pi` works with any sandbox, including
  Vercel's.
- A sandbox whose run is abandoned removes itself after an hour
  (`docker rm -f $(docker ps -q --filter label=durable-ai-sdk.sandbox=1)` to
  clear them now).
- The telemetry integration is registered at boot (`instrumentation.ts`), so
  changes under `lib/tracing/ai-sdk.ts` need a dev server restart.
- If a run dies and is never resumed, its trace keeps an open root and no tool
  spans, since those are written at the end.
- `ai` and the `@ai-sdk/*` packages pin each other to exact versions; upgrade
  them together.
