import { openai } from '@ai-sdk/openai';
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { convertToModelMessages, isStepCount, type UIMessage } from 'ai';
import { getWorkflowMetadata, getWritable } from 'workflow';
import { AGENT_MODEL } from '@/lib/config';
import { observeAgent, type TraceContext } from 'durable-ai-sdk/context';
import { tools } from '@/tools';

const INSTRUCTIONS = `You are a helpful assistant with these tools:
- get_local_weather: US weather forecasts (you may infer coordinates for well-known places).
- record_note / get_notes: a persistent notebook.
- write_file / read_file / list_files / delete_file: a persistent file library.
  Deleting asks the user for approval automatically.
- coding_agent: a sub-agent that writes and runs code in a sandbox. The file library is
  mounted in its sandbox under library/.
When a task needs code, check list_files first. If a stored file fits, tell the coding
agent to run that file (by name, with the inputs) instead of writing new code.
Use tools whenever they help, one step at a time, then answer concisely.`;

/**
 * One agent turn = one trace, and normally one workflow run. A turn that
 * pauses for approval takes two runs. Turns of the same conversation are
 * separate traces that share `metadata.session_id`.
 *
 * `WorkflowAgent` runs the tool loop here, in the workflow body, and turns
 * each LLM call and each tool call into its own durable step. If the process
 * dies mid-turn, the run resumes from the last completed step: finished LLM
 * calls and tool calls are replayed from the event log, not executed again.
 */
export interface AgentTurnInput {
  /** Stable id of the conversation; the same for every turn of a chat. */
  sessionId: string;
  messages: UIMessage[];
}

export async function agentTurn({ sessionId, messages }: AgentTurnInput) {
  'use workflow';

  const { workflowRunId } = getWorkflowMetadata();

  // A turn is identified by the user message it answers. Unlike the run id,
  // that is the same for both runs of a turn that pauses for approval, so
  // both write into one trace.
  const lastUserMessage = messages.findLast(
    (message) => message.role === 'user',
  );
  const trace: TraceContext = {
    traceKey: `${sessionId}:${lastUserMessage?.id ?? workflowRunId}`,
    runId: workflowRunId,
    sessionId,
    attributes: {
      turn: messages.filter((message) => message.role === 'user').length,
    },
  };

  // `observeAgent` is all the tracing this agent carries: the turn becomes a
  // root span, with its model calls, tool calls and sub-agent nested inside.
  const agent = new WorkflowAgent(
    observeAgent(trace, {
      name: 'agent turn',
      model: openai(AGENT_MODEL),
      instructions: INSTRUCTIONS,
      tools,
    }),
  );

  // A denial is final for the turn. The model is told so, but does not
  // reliably comply: it has asked again, and it has emptied the file with
  // write_file instead. So every tool that can destroy a file is withdrawn
  // for this run, until the user sends a new message.
  const denied = messages
    .at(-1)
    ?.parts.some(
      (part) =>
        part.type === 'tool-delete_file' &&
        'approval' in part &&
        part.approval?.approved === false,
    );
  const toolNames = Object.keys(tools) as Array<keyof typeof tools>;

  const result = await agent.stream({
    activeTools: denied
      ? toolNames.filter(
          (name) => name !== 'delete_file' && name !== 'write_file',
        )
      : undefined,
    messages: await convertToModelMessages(messages),
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(12),
  });

  return { steps: result.steps.length };
}
