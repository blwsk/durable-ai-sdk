/**
 * Node-side entry point: where spans go, and the adapters that produce them.
 *
 * What an agent definition needs (`observeAgent`, `subAgentTool`) is in
 * `durable-ai-sdk/context`, which has no Node dependencies and is safe to
 * import in a workflow body. Providers and runtime adapters are separate
 * entry points so their SDKs are only loaded when used:
 * `durable-ai-sdk/braintrust`, `durable-ai-sdk/pi`.
 */
export { aiSdkTracing } from './ai-sdk.js';
export { configureTracing, getSink, openScope } from './tracer.js';
export type { ScopedSpan, TraceScope } from './tracer.js';
export { spanIds } from './ids.js';
export type {
  SpanKind,
  SpanPatch,
  SpanRecord,
  SpanSink,
  TokenUsage,
} from './types.js';
export type { SpanContext, TraceContext } from './context.js';
