#!/usr/bin/env node
// ABOUTME: The stdio entrypoint (bin: steel-mcp). Builds the shared dependencies once, then serves
// ABOUTME: MCP over stdin/stdout through the SDK's serveStdio, which owns the protocol-era choice.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { CdpSessionPool, type ServerDeps } from './core/context.js';
import { InMemoryHandleRegistry, principalFromCredential } from './core/registry.js';
import { createSteelMcpServer } from './core/server.js';
import { SteelRestClient } from './core/steel/rest.js';

/** How often the reaper sweeps, and how idle a handle must be before it reclaims the slot. */
const REAPER_INTERVAL_MS = 30_000;
const REAPER_IDLE_MS = 150_000;

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
    });

    return {
        config,
        api,
        pool,
        registry,
        // One process serves one credential, so the principal is fixed for the connection. The
        // per-call re-authorisation in the tool layer is what makes the hosted entry safe later.
        principal: principalFromCredential(config.apiKey ?? `self-hosted:${config.baseUrl}`),
        settleMultiplier,
        now: () => new Date(),
    };
}

function main(): void {
    let deps: ServerDeps;
    try {
        deps = buildDeps();
    } catch (error) {
        log('error', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    const reaper = setInterval(() => {
        void deps.registry.reap({ idleMs: REAPER_IDLE_MS }).catch(error => {
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
    });

    let shuttingDown = false;
    const shutdown = (cause: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        void (async () => {
            log('info', 'shutting down', { cause });
            clearInterval(reaper);
            // Release every browser this process started before the process itself goes away.
            await deps.registry.reap({ idleMs: 0 }).catch(error => {
                log('error', 'failed to release a session during shutdown', { error: String(error) });
            });
            await deps.pool.closeAll().catch(() => undefined);
            await handle.close().catch(() => undefined);
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

main();
