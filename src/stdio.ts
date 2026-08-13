#!/usr/bin/env node
// ABOUTME: The stdio entrypoint (bin: steel-mcp). Builds the shared dependencies once, then serves
// ABOUTME: MCP over stdin/stdout through the SDK's serveStdio, which owns the protocol-era choice.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { CdpSessionPool, type ServerDeps } from './core/context.js';
import { REAPER_INTERVAL_MS, resolveRegistryIdleMs } from './core/lifecycle.js';
import { createHandoffCodec } from './core/mrtr.js';
import { InMemoryHandleRegistry, principalFromCredential } from './core/registry.js';
import { createSteelMcpServer } from './core/server.js';
import { createSessionPlanCodec } from './core/session-plan.js';
import { SteelRestClient } from './core/steel/rest.js';
import { recordSessionReleased, resolveTracer } from './core/telemetry.js';
import { SERVER_VERSION } from './core/version.js';
import { startTracing } from './tracing.js';

/** Structured JSON to stderr: the officially recommended logging path for a stdio server. */
function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
    process.stderr.write(`${JSON.stringify({ level, message, at: new Date().toISOString(), ...fields })}\n`);
}

function buildDeps(): ServerDeps {
    const config = loadConfig(process.env);
    const settleMultiplier = config.deployment === 'cloud' ? 2 : 1;
    const api = new SteelRestClient(config);
    const pool = new CdpSessionPool(config, settleMultiplier);
    const registry = new InMemoryHandleRegistry({
        releaseSteelSession: async (steelSessionId: string) => {
            await pool.close(steelSessionId);
            await api.releaseSession(steelSessionId);
        },
        onReapError: error => log('error', 'reaper failed to release a session', { error: String(error) }),
        onReleased: cause => {
            log('info', 'browser session released', {
                cause,
                deployment: config.deployment,
                registry_backend: 'memory',
            });
            recordSessionReleased(resolveTracer(), {
                cause,
                deployment: config.deployment,
                registryBackend: 'memory',
            });
        },
    });

    const principal = principalFromCredential(config.apiKey ?? `self-hosted:${config.baseUrl}`);
    return {
        config,
        api,
        pool,
        registry,
        // One process serves every round of a flow here, so the per-process key the config
        // generates when no secret is configured is enough.
        handoffState: createHandoffCodec(config.requestStateSecret),
        sessionPlanState: createSessionPlanCodec(config.requestStateSecret, principal),
        // One process serves one credential, so the principal is fixed for the connection. The
        // per-call re-authorisation in the tool layer is what makes the hosted entry safe later.
        principal,
        settleMultiplier,
        now: () => new Date(),
    };
}

async function main(): Promise<void> {
    // Started before anything else so the tracer the core resolves is already the real one.
    const tracing = await startTracing(process.env, { onWarn: message => log('info', message) });

    let deps: ServerDeps;
    try {
        deps = buildDeps();
    } catch (error) {
        log('error', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    for (const warning of deps.config.warnings) log('info', warning);

    const reaper = setInterval(() => {
        void deps.registry.reap({ idleMs: resolveRegistryIdleMs(deps.config.inactivityTimeoutMs) }).catch(error => {
            log('error', 'reaper sweep failed', { error: String(error) });
        });
    }, REAPER_INTERVAL_MS);
    reaper.unref();

    const handle = serveStdio(() => createSteelMcpServer(deps), {
        onerror: error => log('error', 'transport error', { error: error.message }),
    });

    log('info', 'steel-mcp listening on stdio', {
        profile: deps.config.profile,
        deployment: deps.config.deployment,
        baseUrl: deps.config.baseUrl,
        server_version: SERVER_VERSION,
        session_timeout_ms: deps.config.sessionTimeoutMs,
        inactivity_timeout_ms: deps.config.inactivityTimeoutMs,
    });

    let shuttingDown = false;
    const shutdown = (cause: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        void (async () => {
            log('info', 'shutting down', { cause });
            clearInterval(reaper);
            // Release every browser this process started before the process itself goes away.
            await deps.registry.releaseAll('stream_close').catch(error => {
                log('error', 'failed to release a session during shutdown', { error: String(error) });
            });
            await deps.pool.closeAll().catch(() => undefined);
            await handle.close().catch(() => undefined);
            // Last, so the spans this shutdown produced are flushed rather than dropped.
            await tracing?.shutdown().catch(error => {
                log('error', 'failed to flush traces during shutdown', { error: String(error) });
            });
            process.exit(0);
        })();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // A host that closes the pipe without signalling is the common way a stdio client goes away,
    // and it is the stdio equivalent of the stream-close cancellation the HTTP transport gets.
    // Without this, a browser keeps running with nobody listening until Steel's idle timeout.
    process.stdin.on('end', () => shutdown('stdin-end'));
    process.stdin.on('close', () => shutdown('stdin-close'));
}

void main();
