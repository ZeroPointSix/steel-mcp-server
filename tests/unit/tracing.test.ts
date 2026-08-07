// ABOUTME: Unit tests for the entrypoint's optional OTLP wiring: off unless a standard OTEL variable
// ABOUTME: asks for it, and degrading to a warning rather than a crash when the SDK is not installed.
import { describe, expect, it } from 'vitest';
import { startTracing, tracingRequested } from '../../src/tracing.js';
import { fakeTracingStarter } from '../helpers/tracing.js';

describe('tracingRequested', () => {
    it('is false for an environment that says nothing about telemetry', () => {
        expect(tracingRequested({})).toBe(false);
        expect(tracingRequested({ STEEL_API_KEY: 'k' })).toBe(false);
    });

    it('is true for either OTLP endpoint variable', () => {
        expect(tracingRequested({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
        expect(tracingRequested({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' })).toBe(true);
    });

    it('is true when an exporter is named explicitly', () => {
        expect(tracingRequested({ OTEL_TRACES_EXPORTER: 'otlp' })).toBe(true);
    });

    it('honours the standard kill switches', () => {
        expect(tracingRequested({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' })).toBe(
            false
        );
        expect(tracingRequested({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'none' })).toBe(
            false
        );
    });

    it('ignores a variable that is present but blank', () => {
        expect(tracingRequested({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false);
    });
});

describe('startTracing', () => {
    it('does not touch the SDK when nothing asked for tracing', async () => {
        const starter = fakeTracingStarter();
        expect(await startTracing({}, { start: starter.start })).toBeUndefined();
        expect(starter.started).toEqual([]);
    });

    it('starts one pipeline under the default service name', async () => {
        const starter = fakeTracingStarter();
        const handle = await startTracing(
            { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
            { start: starter.start }
        );

        expect(starter.started).toEqual([{ serviceName: 'steel-mcp' }]);
        await handle?.shutdown();
        expect(starter.shutdownCount()).toBe(1);
    });

    it('respects an operator-chosen service name', async () => {
        const starter = fakeTracingStarter();
        await startTracing(
            { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SERVICE_NAME: 'steel-mcp-staging' },
            { start: starter.start }
        );
        expect(starter.started).toEqual([{ serviceName: 'steel-mcp-staging' }]);
    });

    it('warns and carries on serving when the optional SDK packages are absent', async () => {
        const starter = fakeTracingStarter({ failWith: new Error("Cannot find module '@opentelemetry/sdk-node'") });
        const warnings: string[] = [];

        const handle = await startTracing(
            { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
            { start: starter.start, onWarn: message => warnings.push(message) }
        );

        expect(handle).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('@opentelemetry/sdk-node');
    });
});
