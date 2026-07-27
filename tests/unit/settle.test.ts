// ABOUTME: Unit tests for the settle helper: frame-navigation detection plus DOM quiescence,
// ABOUTME: with budgets scaled by a network multiplier because Steel sessions run through proxies.
import { describe, expect, it, vi } from 'vitest';
import { resolveSettleBudgets, settle } from '../../src/core/settle.js';
import type { CdpEventParams, CdpSession } from '../../src/core/steel/cdp.js';

interface FakeOptions {
    mutationResult?: { navigated?: boolean; mutated: boolean };
    evaluateDelayMs?: number;
}

function fakeSession(options: FakeOptions = {}) {
    const listeners = new Map<string, Set<(params: CdpEventParams) => void>>();
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];

    const session: CdpSession = {
        async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
            sent.push({ method, params });
            if (options.evaluateDelayMs) await new Promise(r => setTimeout(r, options.evaluateDelayMs));
            if (method === 'Runtime.evaluate') {
                return { result: { value: options.mutationResult?.mutated ?? false } } as T;
            }
            return {} as T;
        },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        },
        async close() {},
    };

    const emit = (event: string, params: CdpEventParams) => {
        for (const listener of listeners.get(event) ?? []) listener(params);
    };
    return { session, sent, emit, listeners };
}

describe('resolveSettleBudgets', () => {
    it('scales every budget by the network multiplier', () => {
        const base = resolveSettleBudgets(1);
        const scaled = resolveSettleBudgets(3);
        expect(scaled.navigationWatchMs).toBe(base.navigationWatchMs * 3);
        expect(scaled.navigationMs).toBe(base.navigationMs * 3);
        expect(scaled.mutationQuietMs).toBe(base.mutationQuietMs * 3);
        expect(scaled.mutationMaxMs).toBe(base.mutationMaxMs * 3);
    });

    it('refuses a multiplier below one, which would be tighter than localhost', () => {
        expect(() => resolveSettleBudgets(0)).toThrow(/multiplier/i);
    });
});

describe('settle', () => {
    it('reports no navigation and no mutation when the page is already quiet', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: false } });
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result).toMatchObject({ navigated: false, domMutated: false, timedOut: false });
    });

    it('detects a real cross-document navigation and reports the destination', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: true } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1) });
        await vi.waitFor(() => expect(true).toBe(true));
        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/next',
            navigationType: 'differentDocument',
        });
        emit('Page.loadEventFired', {});
        const result = await pending;
        expect(result.navigated).toBe(true);
        expect(result.navigatedToUrl).toBe('https://example.com/next');
    });

    it('ignores history and same-document navigations, which are not real loads', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1) });
        for (const navigationType of ['sameDocument', 'historySameDocument', 'historyDifferentDocument']) {
            emit('Page.frameStartedNavigating', { frameId: 'main', url: 'https://example.com/#x', navigationType });
        }
        expect((await pending).navigated).toBe(false);
    });

    it('ignores navigations in subframes so an advert iframe cannot look like a page load', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1), mainFrameId: 'main' });
        emit('Page.frameStartedNavigating', {
            frameId: 'ad-iframe',
            url: 'https://ads.test/',
            navigationType: 'differentDocument',
        });
        expect((await pending).navigated).toBe(false);
    });

    it('reports a DOM mutation without a navigation', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: true } });
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result).toMatchObject({ navigated: false, domMutated: true });
    });

    it('runs the quiescence probe in the page with the configured budgets', async () => {
        const { session, sent } = fakeSession({ mutationResult: { mutated: false } });
        await settle(session, { budgets: { ...resolveSettleBudgets(1), mutationQuietMs: 150, mutationMaxMs: 2500 } });
        const evaluate = sent.find(call => call.method === 'Runtime.evaluate');
        expect(evaluate).toBeDefined();
        expect(String(evaluate?.params.expression)).toContain('MutationObserver');
        expect(String(evaluate?.params.expression)).toContain('150');
        expect(String(evaluate?.params.expression)).toContain('2500');
        expect(evaluate?.params.awaitPromise).toBe(true);
    });

    it('unsubscribes its navigation listener so repeated actions do not leak handlers', async () => {
        const { session, listeners } = fakeSession({ mutationResult: { mutated: false } });
        await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(listeners.get('Page.frameStartedNavigating')?.size ?? 0).toBe(0);
    });

    it('reports a timeout rather than hanging when the page never goes quiet', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: true }, evaluateDelayMs: 60 });
        const result = await settle(session, {
            budgets: { navigationWatchMs: 5, navigationMs: 10, mutationQuietMs: 5, mutationMaxMs: 10 },
        });
        expect(result.timedOut).toBe(true);
    });

    it('does not throw when the quiescence probe fails because the page navigated away', async () => {
        const session: CdpSession = {
            async send() {
                throw new Error('Execution context was destroyed.');
            },
            on: () => () => {},
            async close() {},
        };
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result.domMutated).toBe(true);
    });
});
