export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerTelemetry } = await import('ai');
  const { TRACING_MODE } = await import('@/lib/config');
  // Must be registered in every process that executes workflow steps.
  if (TRACING_MODE === 'default') {
    const { braintrustAISDKTelemetry, initLogger } = await import('braintrust');
    const { BRAINTRUST_PROJECT } = await import('@/lib/config');
    initLogger({ projectName: BRAINTRUST_PROJECT });
    registerTelemetry(braintrustAISDKTelemetry());
  } else if (TRACING_MODE === 'otel') {
    // Pure OpenTelemetry: the AI SDK's own OTel integration, with its bridge
    // for durable runs, exported to Braintrust by Braintrust's span processor.
    const { OpenTelemetry, OpenTelemetryIdGenerator } =
      await import('@ai-sdk/otel');
    const { BraintrustSpanProcessor } = await import('@braintrust/otel');
    const { NodeTracerProvider } =
      await import('@opentelemetry/sdk-trace-node');
    const { BRAINTRUST_PROJECT } = await import('@/lib/config');
    const durable = new OpenTelemetryIdGenerator();
    new NodeTracerProvider({
      idGenerator: durable,
      sampler: durable,
      spanProcessors: [
        new BraintrustSpanProcessor({
          parent: `project_name:${BRAINTRUST_PROJECT}`,
          filterAISpans: true,
        }),
      ],
    }).register();
    registerTelemetry(new OpenTelemetry({ durable }));
  } else {
    // The tracing library is generic; these three lines are the only place
    // that says spans go to Braintrust.
    const { configureTracing } = await import('@/lib/tracing/tracer');
    const { braintrustSink } = await import('@/lib/tracing/braintrust');
    const { aiSdkTracing } = await import('@/lib/tracing/ai-sdk');
    const { BRAINTRUST_PROJECT } = await import('@/lib/config');
    configureTracing({ sink: braintrustSink({ project: BRAINTRUST_PROJECT }) });
    registerTelemetry(aiSdkTracing());
  }

  // Start the workflow world at boot rather than on first use, so runs that
  // were in flight when the previous process died are picked up immediately.
  const { getWorld } = await import('workflow/runtime');
  const world = await getWorld();
  await world.start?.();
}
