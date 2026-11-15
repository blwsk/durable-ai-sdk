import { tool } from 'ai';
import { z } from 'zod';
import { subAgentTool } from '@/lib/tracing/context';
import { runCodingAgent } from './coding-agent';
import {
  deleteFile,
  getLocalWeather,
  getNotes,
  listFiles,
  readFile,
  recordNote,
  writeFile,
} from './durable';

/**
 * What the model sees: names, descriptions and schemas. Every `execute` is
 * durable. Most are step wrappers from `./durable`, which is also where each
 * tool's retry and idempotency policy is decided; `coding_agent` starts a
 * child workflow instead, and is declared with `subAgentTool` so that its
 * spans nest under its tool call in the turn's trace.
 */
export const tools = {
  coding_agent: subAgentTool({
    description:
      'Delegate a programming or computation task to a coding sub-agent that can write and run code with bash in an isolated sandbox. Give it a complete, self-contained task description; it cannot see this conversation. It works with the persistent file library: every stored file is available to it under `library/`, and files it creates or changes there are saved. To reuse stored code, name the file and tell it to run that file rather than write new code. Returns its final answer, the commands it ran, and the files it saved.',
    inputSchema: z.object({
      task: z
        .string()
        .describe('Self-contained description of what to build or compute.'),
    }),
    execute: runCodingAgent,
  }),

  get_local_weather: tool({
    description:
      'Get the local weather forecast and active weather alerts for a US location from the NOAA National Weather Service. Requires latitude and longitude in decimal degrees (e.g., 39.7456, -97.0892). Coverage is United States territory only; coordinates outside the US return an error. Use forecastType "daily" (default) for a 7-day outlook split into day/night periods, or "hourly" for the next 48 hours.',
    inputSchema: z.object({
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe('Latitude in decimal degrees (e.g., 39.7456)'),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe('Longitude in decimal degrees (e.g., -97.0892)'),
      forecastType: z
        .enum(['daily', 'hourly'])
        .optional()
        .describe(
          'Forecast granularity: "daily" returns 7 days of day/night periods (default); "hourly" returns the next 48 hours.',
        ),
    }),
    execute: getLocalWeather,
  }),

  write_file: tool({
    description:
      'Create or overwrite a file in the persistent file library. Use for reusable code the coding agent should run later. Paths are relative, e.g. "primes.js".',
    inputSchema: z.object({
      path: z.string().describe('Relative path, e.g. "primes.js"'),
      content: z.string().describe('Full file content.'),
    }),
    execute: writeFile,
  }),

  read_file: tool({
    description: 'Read one file from the persistent file library.',
    inputSchema: z.object({ path: z.string() }),
    execute: readFile,
  }),

  delete_file: tool({
    description:
      'Permanently delete a file from the persistent file library. The user is asked to approve each deletion before it happens, so call this directly when asked to delete; do not ask for confirmation in chat first. If the user denies a deletion, that decision is final: do not call this again for that file, just tell them it was kept.',
    inputSchema: z.object({
      path: z.string().describe('Relative path of the file to delete.'),
    }),
    // Destructive and irreversible: the agent loop stops here and the tool
    // runs only after the user approves this exact call.
    needsApproval: true,
    execute: deleteFile,
  }),

  list_files: tool({
    description:
      'List the files in the persistent file library. Check this before asking the coding agent to write code that may already exist.',
    inputSchema: z.object({}),
    execute: listFiles,
  }),

  get_notes: tool({
    description: 'Read previously recorded notes, newest first.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: getNotes,
  }),

  record_note: tool({
    description:
      'Save a note for later. Use when the user asks to remember, record, or note something.',
    inputSchema: z.object({
      content: z.string().min(1).describe('The note text to save.'),
    }),
    execute: recordNote,
  }),
};
