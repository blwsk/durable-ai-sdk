import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';
import { agentTurn } from '@/workflows/agent-turn';

export async function POST(request: Request) {
  const { id, messages }: { id?: string; messages: UIMessage[] } =
    await request.json();
  // The chat id from the client identifies the conversation across turns.
  const sessionId = id ?? crypto.randomUUID();

  // The turn now runs durably, independent of this request. This response is
  // only a view onto the run's stream; the client can drop and reconnect.
  const run = await start(agentTurn, [{ sessionId, messages }]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: { 'x-workflow-run-id': run.runId },
  });
}
