/** Model for the durable orchestrator loop (AI SDK OpenAI provider id). */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? 'gpt-5.4-mini';

/** Model for the Pi coding sub-agent, as Pi's `<provider>/<id>`. */
export const CODING_AGENT_MODEL =
  process.env.CODING_AGENT_MODEL ?? 'openai/gpt-5.4-mini';

export const BRAINTRUST_PROJECT =
  process.env.BRAINTRUST_PROJECT ?? 'durable-ai-sdk';

/** `docker` (local default) or `vercel` (default when deployed on Vercel). */
export const SANDBOX_PROVIDER =
  process.env.SANDBOX_PROVIDER ?? (process.env.VERCEL ? 'vercel' : 'docker');

export const SANDBOX_DOCKER_IMAGE =
  process.env.SANDBOX_DOCKER_IMAGE ?? 'node:24-bookworm-slim';

/**
 * How turns are traced. The alternatives exist to compare against `custom`:
 * - `custom` (default): the integration in lib/tracing.
 * - `default`: Braintrust's stock AI SDK adapter, nothing else.
 * - `otel`: the AI SDK's OpenTelemetry integration, exported to Braintrust.
 */
export const TRACING_MODE = process.env.TRACING_MODE ?? 'custom';
