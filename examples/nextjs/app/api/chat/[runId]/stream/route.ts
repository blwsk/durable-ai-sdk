import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { createUIMessageStreamResponse } from 'ai';
import { getRun } from 'workflow/api';

/** Reconnect to a run's stream, e.g. after a dropped connection or restart. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const startIndex = Number(
    new URL(request.url).searchParams.get('startIndex') ?? '0',
  );
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    return Response.json(
      { error: 'startIndex must be a non-negative safe integer' },
      { status: 400 },
    );
  }

  const run = await getRun(runId);
  return createUIMessageStreamResponse({
    stream: run
      .getReadable({ startIndex: 0 })
      .pipeThrough(
        createModelCallToUIChunkTransform({ uiStartIndex: startIndex }),
      ),
    headers: { 'x-workflow-run-id': runId },
  });
}
