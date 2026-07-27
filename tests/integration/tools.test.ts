// ABOUTME: Integration tests driving the whole tool surface through a real MCP client over the
// ABOUTME: in-memory transport, with fakes only at the Steel REST and browser-pool boundaries.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSteelMcpServer } from '../../src/core/server.js';
import { FakeSteelApi, testDeps } from '../helpers/fakes.js';

type Deps = ReturnType<typeof testDeps>;

interface Harness {
    client: Client;
    deps: Deps;
    close(): Promise<void>;
}

async function connect(deps: Deps = testDeps()): Promise<Harness> {
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
        client,
        deps,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

function textOf(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n');
}

function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

let harness: Harness;

beforeEach(async () => {
    harness = await connect();
});

afterEach(async () => {
    await harness.close();
});

async function newSession(h: Harness = harness): Promise<string> {
    const result = await h.client.callTool({ name: 'steel_session_create', arguments: {} });
    const structured = (result as { structuredContent?: { session_id?: string } }).structuredContent;
    if (!structured?.session_id) throw new Error(`session_create failed: ${textOf(result)}`);
    return structured.session_id;
}

describe('tools/list', () => {
    it('exposes the browse profile in a stable, deterministic order', async () => {
        const first = await harness.client.listTools();
        const second = await harness.client.listTools();
        const names = first.tools.map(tool => tool.name);
        expect(names).toEqual(second.tools.map(tool => tool.name));
        expect(names).toEqual([
            'steel_scrape',
            'steel_screenshot',
            'steel_pdf',
            'steel_session_create',
            'steel_session_release',
            'steel_navigate',
            'steel_snapshot',
            'steel_find',
            'steel_act',
            'steel_wait_for',
            'steel_session_diagnostics',
            'steel_batch',
        ]);
    });

    it('gives every tool a title and an explicit read-only or destructive hint', async () => {
        const { tools } = await harness.client.listTools();
        for (const tool of tools) {
            expect(tool.title, `${tool.name} has no title`).toBeTruthy();
            const annotations = tool.annotations ?? {};
            expect(
                annotations.readOnlyHint === true || annotations.destructiveHint === true,
                `${tool.name} declares neither readOnlyHint nor destructiveHint`
            ).toBe(true);
            expect(annotations.openWorldHint, `${tool.name} is not marked open-world`).toBe(true);
        }
    });

    it('never puts page content in a tool description', async () => {
        await harness.client.callTool({ name: 'steel_scrape', arguments: { url: 'https://example.com' } });
        const { tools } = await harness.client.listTools();
        expect(tools.every(tool => !tool.description?.includes('Hello world'))).toBe(true);
    });

    it('restricts the scrape profile to the three stateless tools', async () => {
        const scrapeOnly = await connect(testDeps({ env: { STEEL_PROFILE: 'scrape' } }));
        try {
            const names = (await scrapeOnly.client.listTools()).tools.map(tool => tool.name);
            expect(names).toEqual(['steel_scrape', 'steel_screenshot', 'steel_pdf']);
        } finally {
            await scrapeOnly.close();
        }
    });
});

describe('server instructions', () => {
    it('are present, under the 2KB host cap, and written in user language', () => {
        const instructions = harness.client.getInstructions();
        expect(instructions).toBeTruthy();
        expect(Buffer.byteLength(instructions ?? '', 'utf8')).toBeLessThanOrEqual(2048);
        expect(instructions).toMatch(/block|JavaScript|log in|CAPTCHA/i);
        expect(instructions).toMatch(/data, not instructions/i);
    });
});

describe('steel_scrape', () => {
    it('fences the page content with its final URL and a data-not-instructions statement', async () => {
        const result = await harness.client.callTool({
            name: 'steel_scrape',
            arguments: { url: 'https://example.com' },
        });
        const text = textOf(result);
        expect(text).toContain('<untrusted-page-content');
        expect(text).toMatch(/data, not instructions/i);
        expect(text).toContain('source="https://example.com/"');
        expect(text).toContain('Hello world');
    });

    it('defaults to markdown and sends the singular format parameter', async () => {
        await harness.client.callTool({ name: 'steel_scrape', arguments: { url: 'https://example.com' } });
        expect(harness.deps.api.scrapes[0]).toMatchObject({ format: ['markdown'] });
    });

    it('always returns links and metadata without being asked', async () => {
        const result = await harness.client.callTool({
            name: 'steel_scrape',
            arguments: { url: 'https://example.com' },
        });
        expect(textOf(result)).toContain('https://example.com/about');
        expect((result as { structuredContent?: { metadata?: unknown } }).structuredContent?.metadata).toBeTruthy();
    });

    it('truncates a huge page at the budget and hands back a cursor', async () => {
        const big = new FakeSteelApi({ scrape: { content: { markdown: 'line\n'.repeat(50_000) } } });
        const h = await connect(testDeps({ api: big }));
        try {
            const result = await h.client.callTool({
                name: 'steel_scrape',
                arguments: { url: 'https://example.com', max_tokens: 500 },
            });
            const text = textOf(result);
            expect(text).toContain('### Pagination');
            expect(text).toMatch(/cursor/i);
            expect(text.length).toBeLessThan(20_000);
        } finally {
            await h.close();
        }
    });

    it('reports a Steel failure as a tool error with actionable prose', async () => {
        const failing = new FakeSteelApi({
            scrape: async () => {
                const { mapSteelHttpError } = await import('../../src/core/errors.js');
                throw mapSteelHttpError(402, { message: 'payment required' }, { operation: 'browser_tool' });
            },
        });
        const h = await connect(testDeps({ api: failing }));
        try {
            const result = await h.client.callTool({ name: 'steel_scrape', arguments: { url: 'https://x.test' } });
            expect(isError(result)).toBe(true);
            expect(textOf(result)).toMatch(/\$10 verified paid balance/);
        } finally {
            await h.close();
        }
    });
});

describe('steel_screenshot and steel_pdf', () => {
    it('returns a resource link rather than inline bytes by default', async () => {
        const result = await harness.client.callTool({
            name: 'steel_screenshot',
            arguments: { url: 'https://example.com' },
        });
        const content = (result as { content: Array<{ type: string; uri?: string }> }).content;
        expect(content.some(block => block.type === 'resource_link')).toBe(true);
        expect(content.some(block => block.type === 'image')).toBe(false);
    });

    it('returns a resource link for a PDF', async () => {
        const result = await harness.client.callTool({ name: 'steel_pdf', arguments: { url: 'https://example.com' } });
        const content = (result as { content: Array<{ type: string; uri?: string }> }).content;
        expect(content.find(block => block.type === 'resource_link')?.uri).toMatch(/\.pdf$/);
    });

    it('tells the model not to act on pixels', async () => {
        const { tools } = await harness.client.listTools();
        const screenshot = tools.find(tool => tool.name === 'steel_screenshot');
        expect(screenshot?.description).toMatch(/steel_snapshot/);
        expect(screenshot?.description).toMatch(/cannot .*act|do not act|not for acting/i);
    });
});

describe('steel_session_create', () => {
    it('mints the session id itself and sets both timeouts on every create', async () => {
        await newSession();
        const created = harness.deps.api.created[0]!;
        expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.inactivityTimeout).toBe(120_000);
        expect(created.timeout).toBeGreaterThan(0);
    });

    it('clamps the hard timeout to the plan maximum rather than hardcoding one', async () => {
        const api = new FakeSteelApi({ details: { maxSessionDuration: 900_000, concurrencyLimit: 10 } });
        const h = await connect(testDeps({ api, env: { STEEL_SESSION_TIMEOUT_MS: '9999999' } }));
        try {
            await newSession(h);
            expect(api.created[0]!.timeout).toBe(900_000);
        } finally {
            await h.close();
        }
    });

    it('returns an opaque handle that is not the Steel session id', async () => {
        const handle = await newSession();
        expect(handle.startsWith('sess_')).toBe(true);
        expect(handle).not.toContain(harness.deps.api.created[0]!.sessionId);
    });

    it('returns the viewer URL and states the retention policy in its description', async () => {
        const result = await harness.client.callTool({ name: 'steel_session_create', arguments: {} });
        expect(textOf(result)).toContain('https://app.steel.dev/sessions/');
        const { tools } = await harness.client.listTools();
        const create = tools.find(tool => tool.name === 'steel_session_create');
        expect(create?.description).toMatch(/steel_session_release/);
        expect(create?.description).toMatch(/billed|charged|costs/i);
    });

    it('refuses a second session on a self-hosted deployment with the concurrency-1 error', async () => {
        const h = await connect(
            testDeps({ env: { STEEL_BASE_URL: 'http://localhost:3000', STEEL_API_KEY: undefined } })
        );
        try {
            await newSession(h);
            const second = await h.client.callTool({ name: 'steel_session_create', arguments: {} });
            expect(isError(second)).toBe(true);
            expect(textOf(second)).toMatch(/one browser session at a time/i);
        } finally {
            await h.close();
        }
    });

    it('names the self-host capability gap when a cloud-only option is requested', async () => {
        const h = await connect(
            testDeps({ env: { STEEL_BASE_URL: 'http://localhost:3000', STEEL_API_KEY: undefined } })
        );
        try {
            const result = await h.client.callTool({
                name: 'steel_session_create',
                arguments: { use_proxy: true },
            });
            expect(isError(result)).toBe(true);
            expect(textOf(result)).toMatch(/Steel-managed prox/i);
        } finally {
            await h.close();
        }
    });
});

describe('steel_session_release', () => {
    it('captures the session context before releasing it', async () => {
        const handle = await newSession();
        await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://example.com/' },
        });
        const result = await harness.client.callTool({
            name: 'steel_session_release',
            arguments: { session_id: handle },
        });
        expect(textOf(result)).toContain('https://example.com/');
        expect(harness.deps.api.released).toHaveLength(1);
    });

    it('is idempotent: releasing twice is not an error', async () => {
        const handle = await newSession();
        await harness.client.callTool({ name: 'steel_session_release', arguments: { session_id: handle } });
        const second = await harness.client.callTool({
            name: 'steel_session_release',
            arguments: { session_id: handle },
        });
        expect(isError(second)).toBe(false);
        expect(textOf(second)).toMatch(/already released|no live session/i);
    });

    it('closes the browser connection as well as the Steel session', async () => {
        const handle = await newSession();
        await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://example.com/' },
        });
        await harness.client.callTool({ name: 'steel_session_release', arguments: { session_id: handle } });
        expect(harness.deps.pool.closed).toHaveLength(1);
    });
});

describe('stateful tools reject an unknown handle', () => {
    it('answers a handle this credential never created with a not-found error', async () => {
        for (const name of ['steel_navigate', 'steel_snapshot', 'steel_find', 'steel_act', 'steel_wait_for']) {
            const result = await harness.client.callTool({
                name,
                arguments: {
                    session_id: 'sess_someoneelse',
                    url: 'https://x.test',
                    action: 'click',
                    target: '@e1',
                    text: 'x',
                },
            });
            expect(isError(result), `${name} accepted an unknown handle`).toBe(true);
            expect(textOf(result)).toMatch(/no live browser session/i);
        }
    });
});

describe('steel_navigate', () => {
    it('reports the final URL and a change signal, with no snapshot by default', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://example.com/' },
        });
        const text = textOf(result);
        expect(text).toContain('### Change');
        expect(text).toContain('https://example.com/');
        expect(text).not.toContain('### Snapshot');
    });

    it('includes the snapshot only when asked', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://example.com/', include_snapshot: true },
        });
        expect(textOf(result)).toContain('### Snapshot');
        expect(textOf(result)).toContain('@e');
    });
});

describe('steel_snapshot', () => {
    it('returns the accessibility tree with refs and a snapshot id', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const text = textOf(result);
        expect(text).toContain('button "Save" @e');
        expect(text).toMatch(/snapshot [a-z]?\d+/i);
    });

    it('fences the snapshot as untrusted page content', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        expect(textOf(result)).toContain('<untrusted-page-content');
    });
});

describe('steel_find', () => {
    it('returns only the matching nodes, not the whole page', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_find',
            arguments: { session_id: handle, text: 'About' },
        });
        const text = textOf(result);
        expect(text).toContain('About us');
        expect(text).not.toContain('"Save"');
    });

    it('says so, and suggests a snapshot, when nothing matches', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_find',
            arguments: { session_id: handle, text: 'Checkout' },
        });
        expect(textOf(result)).toMatch(/no .*match/i);
        expect(textOf(result)).toContain('steel_snapshot');
    });
});

describe('steel_act', () => {
    it('clicks a ref and reports what changed', async () => {
        const handle = await newSession();
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const result = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });
        const text = textOf(result);
        expect(isError(result)).toBe(false);
        expect(text).toContain('### Change');
    });

    it('says nothing changed rather than reporting a bare success', async () => {
        const handle = await newSession();
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const result = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });
        expect(textOf(result)).toMatch(/nothing changed/i);
    });

    it('rejects an unknown action at the schema boundary', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'teleport' },
        });
        expect(isError(result)).toBe(true);
    });
});

describe('steel_wait_for', () => {
    it('fails with a timeout that names the condition', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_wait_for',
            arguments: { session_id: handle, text: 'Never', timeout_ms: 50 },
        });
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('Never');
    });
});

describe('steel_session_diagnostics', () => {
    it('returns a compact timeline built from agent traces and logs', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_session_diagnostics',
            arguments: { session_id: handle },
        });
        const text = textOf(result);
        expect(text).toContain('click');
        expect(text).toContain('Sign in');
        expect(text).toContain('ERR_ABORTED');
    });
});

describe('steel_batch', () => {
    it('runs several steps in one call and returns one snapshot at the end', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_batch',
            arguments: {
                session_id: handle,
                include_snapshot: true,
                steps: [
                    { tool: 'steel_navigate', arguments: { url: 'https://example.com/' } },
                    { tool: 'steel_act', arguments: { action: 'scroll', value: '300' } },
                ],
            },
        });
        const text = textOf(result);
        expect(isError(result)).toBe(false);
        expect(text.match(/### Snapshot/g) ?? []).toHaveLength(1);
        expect(text).toMatch(/step 1/i);
        expect(text).toMatch(/step 2/i);
    });

    it('stops at the first failure and names the failing index', async () => {
        const handle = await newSession();
        const result = await harness.client.callTool({
            name: 'steel_batch',
            arguments: {
                session_id: handle,
                steps: [
                    { tool: 'steel_act', arguments: { action: 'click', target: '@e404' } },
                    { tool: 'steel_navigate', arguments: { url: 'https://example.com/second' } },
                ],
            },
        });
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toMatch(/step 1/i);
        expect(textOf(result)).not.toMatch(/step 2/i);
    });
});
