# Next.js example: a durable agent

The application this repository's tracing library was built against. It
imports the library by package name (`durable-ai-sdk`), as an installed
dependency would; see the [root README](../../README.md) for the library
itself.

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
# from the repository root: installs everything and builds the library
bun install
docker pull node:24-bookworm-slim

cd examples/nextjs
bun dev                # http://localhost:3000
```

`.env.local` in this directory needs `OPENAI_API_KEY` and `BRAINTRUST_API_KEY`. Optional:

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

| File                                             |                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `workflows/agent-turn.ts`                        | `'use workflow'`: one `WorkflowAgent.stream()` call per turn                |
| `tools/index.ts`                                 | what the model sees: tool names, descriptions, schemas                      |
| `tools/durable.ts`                               | the `'use step'` wrappers, with each tool's retry and idempotency policy    |
| `lib/notes.ts`, `lib/files.ts`, `lib/weather.ts` | the tool logic as plain functions; weather is adapted from an existing tool |
| `tools/coding-agent.ts`                          | starts the coding agent as a child workflow and awaits it                   |
| `workflows/coding-agent.ts`                      | child workflow: one durable step per Pi agent step                          |
| `tools/coding-agent-steps.ts`                    | its steps: run one agent step, save the library, remove sandbox             |
| `lib/sandbox/`                                   | Docker session locally, `@ai-sdk/sandbox-vercel` when deployed              |
| `instrumentation.ts`                             | registers the tracing library and chooses Braintrust as its provider        |
| `app/api/chat/`                                  | starts the run; `[runId]/stream` reconnects to it                           |

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

### How this app uses the tracing library

All of the tracing in the app is these call sites:

| Where                         | What                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `instrumentation.ts`          | `configureTracing({ sink: braintrustSink(...) })` and `registerTelemetry(aiSdkTracing())`, once at boot |
| `workflows/agent-turn.ts`     | builds the turn's `TraceContext` and wraps the agent's settings in `observeAgent`                       |
| `tools/index.ts`              | declares `coding_agent` with `subAgentTool`, so its `execute` receives a `trace`                        |
| `tools/coding-agent.ts`       | passes that `trace` to the child workflow                                                               |
| `tools/coding-agent-steps.ts` | `openScope(trace, { segment: stepIndex })` and the Pi adapter, once per agent step                      |

The choices that are this app's, not the library's:

- **Trace key:** the chat id plus the id of the user message being answered.
  That is the same for both runs of a turn that pauses for approval, so both
  write into one trace.
- **Session:** the client sends its chat id, and every span carries it as
  `metadata.session_id` in Braintrust (the root also has `metadata.turn`).
  Filter logs on it to see a conversation, or use it as the "Group by" key of
  an online scoring rule.
- **Sub-agent segments:** the coding agent runs one agent step per workflow
  step, so each step opens its own scope with the step index as the segment.

### Things to know

- Pi runs in the Node process; its tools (bash, read, write, edit) run in the
  sandbox. That is how `@ai-sdk/harness-pi` works with any sandbox, including
  Vercel's.
- A sandbox whose run is abandoned removes itself after an hour
  (`docker rm -f $(docker ps -q --filter label=durable-ai-sdk.sandbox=1)` to
  clear them now).
- The tracing library is consumed as built output and registered at boot. After
  changing anything under the root `src/`, run `bun run build` at the root and
  restart the dev server.
- If a run dies and is never resumed, its trace keeps an open root and no tool
  spans, since those are written at the end.
- `ai` and the `@ai-sdk/*` packages pin each other to exact versions; upgrade
  them together.
