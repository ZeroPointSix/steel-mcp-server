// ABOUTME: An in-memory OpenTelemetry pipeline for tests: a real tracer whose finished spans are
// ABOUTME: readable, plus the async-context manager span nesting needs to work across awaits.
import { context, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    type ReadableSpan,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** A tracing starter that records how it was called instead of loading the real OTLP SDK. */
export function fakeTracingStarter(options: { failWith?: Error } = {}) {
    const started: Array<{ serviceName: string }> = [];
    let shutdowns = 0;
    return {
        started,
        shutdownCount: () => shutdowns,
        start: async (config: { serviceName: string }) => {
            if (options.failWith) throw options.failWith;
            started.push(config);
            return {
                shutdown: async () => {
                    shutdowns += 1;
                },
            };
        },
    };
}

export interface TracingHarness {
    /** Pass this as `ServerDeps.tracer`, or to a Steel client, to record its spans. */
    tracer: Tracer;
    /** Finished spans in the order they ended. */
    spans(): ReadableSpan[];
    /** The one span with this name, failing loudly when there is not exactly one. */
    span(name: string): ReadableSpan;
    reset(): void;
    shutdown(): Promise<void>;
}

/**
 * Registered once per worker rather than per harness.
 *
 * A second `setGlobalContextManager` call is refused by the API with a diagnostic, which would both
 * leave a stray message in the test output and silently keep the first manager.
 */
let contextManager: AsyncLocalStorageContextManager | undefined;

/** Builds a recording tracer whose spans are inspectable, with async context propagation live. */
export function tracingHarness(): TracingHarness {
    if (!contextManager) {
        contextManager = new AsyncLocalStorageContextManager().enable();
        context.setGlobalContextManager(contextManager);
    }

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

    return {
        tracer: provider.getTracer('test'),
        spans: () => exporter.getFinishedSpans(),
        span: (name: string) => {
            const matches = exporter.getFinishedSpans().filter(span => span.name === name);
            if (matches.length !== 1) {
                const names = exporter
                    .getFinishedSpans()
                    .map(span => span.name)
                    .join(', ');
                throw new Error(`Expected exactly one span named "${name}", found ${matches.length} in [${names}]`);
            }
            return matches[0]!;
        },
        reset: () => exporter.reset(),
        shutdown: async () => {
            await provider.shutdown();
        },
    };
}
