// ABOUTME: Test doubles injected at the Steel client and browser-pool boundaries, so the whole tool
// ABOUTME: surface can be driven through a real MCP client without a network or a browser.
import { loadConfig, type SteelConfig } from '../../src/core/config.js';
import type { ServerDeps, SessionPool } from '../../src/core/context.js';
import { BrowserPage } from '../../src/core/page.js';
import { InMemoryHandleRegistry, principalFromCredential } from '../../src/core/registry.js';
import type {
    AccountDetails,
    AgentTrace,
    ArtifactRequest,
    ArtifactResponse,
    CreateSessionRequest,
    ScrapeRequest,
    ScrapeResponse,
    SessionLogEntry,
    SteelApi,
    SteelSession,
} from '../../src/core/steel/types.js';
import { type FixturePage, fixtureSession } from './cdp-fixture.js';

export interface FakeSteelApiOptions {
    scrape?: Partial<ScrapeResponse> | (() => Promise<ScrapeResponse>);
    details?: AccountDetails;
    traces?: AgentTrace[];
    logs?: SessionLogEntry[];
    failCreateWith?: Error;
}

/** Records every call so tests can assert on the wire shape without a network. */
export class FakeSteelApi implements SteelApi {
    readonly created: CreateSessionRequest[] = [];
    readonly released: string[] = [];
    readonly scrapes: ScrapeRequest[] = [];
    readonly artifacts: ArtifactRequest[] = [];

    constructor(private readonly options: FakeSteelApiOptions = {}) {}

    async scrape(request: ScrapeRequest): Promise<ScrapeResponse> {
        this.scrapes.push(request);
        if (typeof this.options.scrape === 'function') return this.options.scrape();
        return {
            content: { markdown: '# Example\n\nHello world.' },
            links: [{ url: 'https://example.com/about', text: 'About' }],
            metadata: { statusCode: 200, title: 'Example', urlSource: 'https://example.com/' },
            ...this.options.scrape,
        };
    }

    async screenshot(request: ArtifactRequest): Promise<ArtifactResponse> {
        this.artifacts.push(request);
        return { url: 'https://files.steel.dev/v1/static/shot.png' };
    }

    async pdf(request: ArtifactRequest): Promise<ArtifactResponse> {
        this.artifacts.push(request);
        return { url: 'https://files.steel.dev/v1/static/doc.pdf' };
    }

    async createSession(request: CreateSessionRequest): Promise<SteelSession> {
        if (this.options.failCreateWith) throw this.options.failCreateWith;
        this.created.push(request);
        return {
            id: request.sessionId,
            status: 'live',
            createdAt: '2026-07-27T10:00:00.000Z',
            sessionViewerUrl: `https://app.steel.dev/sessions/${request.sessionId}`,
        };
    }

    async releaseSession(sessionId: string): Promise<void> {
        this.released.push(sessionId);
    }

    async getSession(sessionId: string): Promise<SteelSession> {
        return { id: sessionId, status: 'live' };
    }

    async getDetails(): Promise<AccountDetails> {
        return this.options.details ?? { maxSessionDuration: 900_000, concurrencyLimit: 10, plan: 'launch' };
    }

    async getAgentTraces(): Promise<AgentTrace[]> {
        return (
            this.options.traces ?? [
                {
                    timestamp: '2026-07-27T10:00:01.000Z',
                    action: 'click',
                    target: { role: 'button', accessibleName: 'Sign in', selector: { css: 'button.signin' } },
                },
                { timestamp: '2026-07-27T10:00:02.000Z', action: 'navigate', url: 'https://example.com/challenge' },
            ]
        );
    }

    async getSessionLogs(): Promise<SessionLogEntry[]> {
        return (
            this.options.logs ?? [{ timestamp: '2026-07-27T10:00:03.000Z', level: 'error', text: 'net::ERR_ABORTED' }]
        );
    }
}

/** Hands out BrowserPage instances backed by the CDP fixture, one per Steel session id. */
export class FakeSessionPool implements SessionPool {
    readonly closed: string[] = [];
    private readonly pages = new Map<string, BrowserPage>();
    private readonly fixtures = new Map<string, ReturnType<typeof fixtureSession>>();

    constructor(private readonly makePage: () => FixturePage) {}

    async page(steelSessionId: string): Promise<BrowserPage> {
        const existing = this.pages.get(steelSessionId);
        if (existing) return existing;

        const fixture = fixtureSession(this.makePage());
        fixture.stub('DOM.scrollIntoViewIfNeeded', () => ({}));
        fixture.stub('DOM.getBoxModel', () => ({ model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }));
        fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: 10 }));
        fixture.stub('DOM.describeNode', () => ({ node: { nodeName: 'BUTTON', attributes: [] } }));
        fixture.stub('DOM.focus', () => ({}));
        fixture.stub('Input.dispatchMouseEvent', () => ({}));
        fixture.stub('Input.dispatchKeyEvent', () => ({}));
        fixture.stub('Input.insertText', () => ({}));
        fixture.stub('Page.navigate', () => ({ frameId: 'main-frame', loaderId: 'loader-1' }));
        fixture.stub('Page.captureScreenshot', () => ({ data: 'aGVsbG8=' }));

        const page = await BrowserPage.attach(fixture.session, {
            budgets: { navigationWatchMs: 1, navigationMs: 5, mutationQuietMs: 1, mutationMaxMs: 5 },
        });
        this.pages.set(steelSessionId, page);
        this.fixtures.set(steelSessionId, fixture);
        return page;
    }

    fixtureFor(steelSessionId: string) {
        return this.fixtures.get(steelSessionId);
    }

    async close(steelSessionId: string): Promise<void> {
        this.closed.push(steelSessionId);
        this.pages.delete(steelSessionId);
        this.fixtures.delete(steelSessionId);
    }

    async closeAll(): Promise<void> {
        for (const id of [...this.pages.keys()]) await this.close(id);
    }
}

export const TEST_API_KEY = 'ste-test-key';

export interface TestDepsOptions {
    api?: SteelApi;
    pool?: SessionPool;
    env?: Record<string, string | undefined>;
    page?: () => FixturePage;
}

/** Assembles the dependency bundle a server needs, with fakes at both external boundaries. */
export function testDeps(options: TestDepsOptions = {}): ServerDeps & {
    api: FakeSteelApi;
    pool: FakeSessionPool;
    config: SteelConfig;
} {
    const config = loadConfig({ STEEL_API_KEY: TEST_API_KEY, ...options.env });
    const api = (options.api as FakeSteelApi) ?? new FakeSteelApi();
    const pool =
        (options.pool as FakeSessionPool) ??
        new FakeSessionPool(
            options.page ??
                (() => ({
                    root: {
                        tag: 'HTML',
                        backendNodeId: 1,
                        role: 'RootWebArea',
                        name: 'Example',
                        bounds: [0, 0, 1280, 720],
                        children: [
                            {
                                tag: 'BUTTON',
                                backendNodeId: 10,
                                role: 'button',
                                name: 'Save',
                                bounds: [100, 200, 80, 40],
                            },
                            {
                                tag: 'A',
                                backendNodeId: 11,
                                role: 'link',
                                name: 'About us',
                                bounds: [10, 60, 60, 20],
                            },
                        ],
                    },
                    url: 'https://example.com/',
                    loaderId: 'loader-1',
                }))
        );

    const registry = new InMemoryHandleRegistry({
        releaseSteelSession: async (id: string) => {
            await pool.close(id);
            await api.releaseSession(id);
        },
    });

    return {
        config,
        api,
        pool,
        registry,
        principal: principalFromCredential(TEST_API_KEY),
        settleMultiplier: 1,
        // Real time: the registry checks handle expiry against the real clock.
        now: () => new Date(),
    };
}
