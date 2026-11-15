import {
  createHarnessWorkflowState,
  finalizeHarnessWorkflow,
} from '@ai-sdk/workflow-harness';
import { getWorkflowMetadata } from 'workflow';
import type { SpanContext } from 'durable-ai-sdk/context';
import {
  advanceCodingAgent,
  removeSandbox,
  prepareCodingTask,
  saveLibrary,
} from '@/tools/coding-agent-steps';

const MAX_AGENT_STEPS = 15;

export interface CodingAgentInput {
  task: string;
  trace?: SpanContext;
}

/**
 * The Pi coding agent as a durable loop of its own.
 *
 * Each agent step (one model call plus the tools it runs) is one workflow
 * step. Between steps the whole agent is serializable state: Pi's session
 * lives in `state`, and the sandbox is found again by id. A crash therefore
 * resumes at the interrupted agent step, with the sandbox's files intact,
 * rather than starting the task over.
 */
export async function codingAgentWorkflow({ task, trace }: CodingAgentInput) {
  'use workflow';

  // One sandbox and one Pi session per run, both named after it.
  const { workflowRunId } = getWorkflowMetadata();
  const sandboxId = `durable-ai-sdk-sandbox-${workflowRunId.toLowerCase()}`;

  let state = createHarnessWorkflowState({
    sessionId: workflowRunId,
    prompt: await prepareCodingTask(task),
  });

  let answer = '';
  const commands: string[] = [];
  let libraryDir: string | undefined;
  let previousLlmSpanId: string | undefined;
  let savedFiles: Array<{ path: string; result: string }> = [];

  try {
    for (let stepIndex = 0; stepIndex < MAX_AGENT_STEPS; stepIndex += 1) {
      const step = await advanceCodingAgent({
        state,
        sandboxId,
        stepIndex,
        previousLlmSpanId,
        trace,
      });
      state = step.state;
      if (step.text) answer = step.text;
      commands.push(...step.commands);
      libraryDir = step.libraryDir ?? libraryDir;
      previousLlmSpanId = step.lastLlmSpanId ?? previousLlmSpanId;
      if (state.status !== 'ready_for_next_step') break;
    }

    if (libraryDir) {
      savedFiles = await saveLibrary({ sandboxId, libraryDir });
    }
  } finally {
    await removeSandbox(sandboxId);
  }

  const { finishReason } = finalizeHarnessWorkflow(state);
  return {
    answer: answer.trim() || 'The coding agent produced no answer.',
    commands,
    savedFiles,
    finishReason,
  };
}
