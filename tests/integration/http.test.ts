// ABOUTME: Integration tests for the hosted fetch boundary: routing, DNS-rebinding guards, auth
// ABOUTME: precedence and isolation of each credential into its own transport-agnostic server deps.
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { principalFromCredential } from '../../src/core/registry.js';
import type { CreateSessionRequest, SteelSession } from '../../src/core/steel/types.js';
import { HostedRuntime } from '../../src/hosted-runtime.js';
import { createSteelHttpHandler, type RequestDepsInput } from '../../src/http.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

function modernRequest(
    url = 'https://mcp.steel.dev/mcp',
    options: { authorization?: string; host?: string; origin?: string; method?: string } = {}
): Request {
    const method = options.method ?? 'POST';
    const headers = new Headers({
        host: options.host ?? 'mcp.steel.dev',
        accept: 'application/json',
    });
    if (options.authorization !== undefined) headers.set('authorization', options.authorization);
    if (options.origin !== undefined) headers.set('origin', options.origin);
    if (method === 'POST') {
        headers.set('content-type', 'application/json');
        headers.set('mcp-protocol-version', MODERN_PROTOCOL_VERSION);
        headers.set('mcp-method', 'server/discover');
    }

    return new Request(url, {
        method,
        headers,
        body:
            method === 'POST'
                ? JSON.stringify({
                      jsonrpc: '2.0',
                      id: 1,
                      method: 'server/discover',
                      params: {
                          _meta: {
                              [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                              [CLIENT_CAPABILITIES_META_KEY]: {},
                          },
                      },
                  })
                : undefined,
    });
}

function toolRequest(credential: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Request {
    return new Request('https://mcp.steel.dev/mcp', {
        method: 'POST',
        headers: {
            host: 'mcp.steel.dev',
            authorization: `Bearer ${credential}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
        signal,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                },
            },
        }),
    });
}

function harness() {
    const seen: RequestDepsInput[] = [];
    const handler = createSteelHttpHandler({
        allowedHostnames: ['mcp.steel.dev'],
        allowedOriginHostnames: ['steel.dev'],
        depsForRequest: input => {
            seen.push(input);
            const deps = testDeps();
            deps.principal = input.principal;
            deps.config = { ...deps.config, apiKey: input.credential };
            return deps;
        },
    });
    return { handler, seen };
}

const openHandlers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(openHandlers.splice(0).map(handler => handler.close()));
});

describe('hosted HTTP authentication', () => {
    it('uses the bearer credential and derives a non-secret principal for the request', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest(undefined, { authorization: 'Bearer ste-header' }));

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.credential).toBe('ste-header');
        expect(seen[0]?.principal).toMatch(/^[a-f0-9]{32}$/);
        expect(seen[0]?.principal).not.toContain('ste-header');
        expect(seen[0]?.request.headers.get('authorization')).toBeNull();
    });

    it('accepts apiKey as a fallback, while a valid bearer header takes precedence', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        await handler.fetch(
            modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query', {
                authorization: 'Bearer ste-header',
            })
        );
        await handler.fetch(modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query-only'));

        expect(seen.map(input => input.credential)).toEqual(['ste-header', 'ste-query-only']);
        expect(seen[1]?.request.url).not.toContain('apiKey');
    });

    it('does not downgrade a malformed Authorization header to a query credential', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(
            modernRequest('https://mcp.steel.dev/mcp?apiKey=ste-query', { authorization: 'Basic abc' })
        );

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
        expect(seen).toHaveLength(0);
    });

    it('challenges a request with no credential before constructing server dependencies', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest());

        expect(response.status).toBe(401);
        expect(seen).toHaveLength(0);
    });
});

describe('hosted HTTP routing guards', () => {
    it('rejects an untrusted Host or browser Origin before authentication', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const badHost = await handler.fetch(
            modernRequest(undefined, { host: 'attacker.test', authorization: 'Bearer ste-secret' })
        );
        const badOrigin = await handler.fetch(
            modernRequest(undefined, {
                origin: 'https://attacker.test',
                authorization: 'Bearer ste-secret',
            })
        );

        expect(badHost.status).toBe(403);
        expect(badOrigin.status).toBe(403);
        expect(seen).toHaveLength(0);
    });

    it.each(['GET', 'DELETE'])('answers %s on /mcp with 405 and never constructs dependencies', async method => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(modernRequest(undefined, { method }));

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        expect(seen).toHaveLength(0);
    });

    it('does not serve the MCP handler on another path', async () => {
        const { handler, seen } = harness();
        openHandlers.push(handler);

        const response = await handler.fetch(
            modernRequest('https://mcp.steel.dev/not-mcp', { authorization: 'Bearer ste-secret' })
        );

        expect(response.status).toBe(404);
        expect(seen).toHaveLength(0);
    });
});

describe('hosted HTTP session isolation', () => {
    it('keeps a handle across requests for its owner and rejects the same handle from another credential', async () => {
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: () => new FakeSteelApi(),
            createPool: () => testDeps().pool,
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });

        const createdResponse = await handler.fetch(toolRequest('ste-owner', 'steel_session_create', {}));
        const created = (await createdResponse.json()) as {
            result: { structuredContent?: { session_id?: string } };
        };
        const sessionId = created.result.structuredContent?.session_id;
        expect(sessionId).toMatch(/^sess_/);

        const ownerResponse = await handler.fetch(
            toolRequest('ste-owner', 'steel_session_diagnostics', { session_id: sessionId })
        );
        const owner = (await ownerResponse.json()) as { result: { isError?: boolean } };
        expect(owner.result.isError).not.toBe(true);

        const strangerResponse = await handler.fetch(
            toolRequest('ste-stranger', 'steel_session_diagnostics', { session_id: sessionId })
        );
        const stranger = (await strangerResponse.json()) as {
            result: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        expect(stranger.result.isError).toBe(true);
        expect(stranger.result.content?.map(block => block.text).join('\n')).toMatch(/No live browser session/);

        const releaseResponse = await handler.fetch(
            toolRequest('ste-owner', 'steel_session_release', { session_id: sessionId })
        );
        expect(releaseResponse.status).toBe(200);
    });

    it('releases a session when the creating HTTP request disconnects after Steel accepted it', async () => {
        const controller = new AbortController();
        class AbortAfterCreateApi extends FakeSteelApi {
            override async createSession(request: CreateSessionRequest): Promise<SteelSession> {
                const session = await super.createSession(request);
                controller.abort();
                return session;
            }
        }

        const api = new AbortAfterCreateApi();
        const runtime = new HostedRuntime({
            configForCredential: credential => loadConfig({ STEEL_API_KEY: credential }),
            createApi: () => api,
            createPool: () => testDeps().pool,
        });
        const handler = createSteelHttpHandler({
            allowedHostnames: ['mcp.steel.dev'],
            allowedOriginHostnames: ['steel.dev'],
            depsForRequest: runtime.depsForRequest,
        });
        openHandlers.push({
            close: async () => {
                await handler.close();
                await runtime.close();
            },
        });

        await handler.fetch(toolRequest('ste-disconnected', 'steel_session_create', {}, controller.signal));

        expect(api.created).toHaveLength(1);
        await expect.poll(() => api.released, { timeout: 1_000 }).toEqual([api.created[0]?.sessionId]);
        await expect
            .poll(() => runtime.registry.countLive(principalFromCredential('ste-disconnected')), { timeout: 1_000 })
            .toBe(0);
        expect(runtime.registry.releaseCounts().stream_close).toBe(1);
    });
});
