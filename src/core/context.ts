// ABOUTME: The dependency bundle every tool closes over, and the browser-pool contract that keeps
// ABOUTME: one attached CDP page per Steel session so element refs survive across tool calls.
import { randomUUID } from 'node:crypto';
import type { SteelConfig } from './config.js';
import { buildCdpUrl } from './config.js';
import { BrowserPage } from './page.js';
import type { HandleRegistry } from './registry.js';
import { resolveSettleBudgets } from './settle.js';
import { CdpConnection } from './steel/cdp.js';
import type { SteelApi } from './steel/types.js';

/** Hands out the attached page for a Steel session, creating the CDP connection on first use. */
export interface SessionPool {
    page(steelSessionId: string, signal?: AbortSignal): Promise<BrowserPage>;
    close(steelSessionId: string): Promise<void>;
    closeAll(): Promise<void>;
}

/** Everything the tool layer needs. Held at module scope and closed over by the server factory. */
export interface ServerDeps {
    config: SteelConfig;
    api: SteelApi;
    registry: HandleRegistry;
    pool: SessionPool;
    /** The principal for this request's own credential; handles are re-authorised against it. */
    principal: string;
    /** Multiplier applied to settle budgets, because Steel sessions run through proxies. */
    settleMultiplier: number;
    now(): Date;
    /** Overridable so tests get deterministic Steel session ids. */
    newSessionId?: (() => string) | undefined;
}

/** Mints the session UUID before the create call, closing the create-then-crash gap. */
export function mintSteelSessionId(deps: ServerDeps): string {
    return (deps.newSessionId ?? randomUUID)();
}

/** Opens one CDP connection per Steel session and keeps the attached page for later calls. */
export class CdpSessionPool implements SessionPool {
    private readonly entries = new Map<string, { connection: CdpConnection; page: BrowserPage }>();

    constructor(private readonly config: SteelConfig) {}

    async page(steelSessionId: string, signal?: AbortSignal): Promise<BrowserPage> {
        const existing = this.entries.get(steelSessionId);
        if (existing) return existing.page;

        const url = buildCdpUrl(this.config, steelSessionId);
        const connection = await CdpConnection.connect(url, signal);
        const session = await connection.attachToPage();
        const page = await BrowserPage.attach(session, {
            budgets: resolveSettleBudgets(this.config.deployment === 'cloud' ? 2 : 1),
        });
        this.entries.set(steelSessionId, { connection, page });
        return page;
    }

    async close(steelSessionId: string): Promise<void> {
        const entry = this.entries.get(steelSessionId);
        if (!entry) return;
        this.entries.delete(steelSessionId);
        await entry.connection.close();
    }

    async closeAll(): Promise<void> {
        for (const id of [...this.entries.keys()]) await this.close(id);
    }
}
