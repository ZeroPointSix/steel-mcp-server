// ABOUTME: Unit tests for the cost-weighted rate limiter: the weight table, per-principal isolation,
// ABOUTME: refill on the injected clock, and the rejection error naming the limit and a retry-after.
import { describe, expect, it } from 'vitest';
import { SteelToolError, toolErrorResult } from '../../src/core/errors.js';
import {
    DEFAULT_RATE_LIMIT_POLICY,
    DEFAULT_TOOL_COST,
    InMemoryRateLimiter,
    RATE_LIMIT_NAME,
    type RateLimitPolicy,
    TOOL_COSTS,
    toolCost,
} from '../../src/core/rate-limit.js';

/** One unit per second, ten units of burst: every refill in these tests lands on an exact integer. */
const TEST_POLICY: RateLimitPolicy = { refillPerMinute: 60, burstCapacity: 10 };

function clock(startMs = 1_800_000_000_000) {
    let ms = startMs;
    return {
        now: () => new Date(ms),
        advanceSeconds: (seconds: number) => {
            ms += seconds * 1_000;
        },
    };
}

function limiter(policy: RateLimitPolicy = TEST_POLICY) {
    const time = clock();
    return { limiter: new InMemoryRateLimiter({ policy, now: time.now }), time };
}

async function rejection(work: () => Promise<unknown>): Promise<SteelToolError> {
    try {
        await work();
    } catch (error) {
        if (error instanceof SteelToolError) return error;
        throw error;
    }
    throw new Error('Expected the limiter to reject this call.');
}

describe('the tool weight table', () => {
    it('charges session-creating and CDP-driving tools more than the stateless reads', () => {
        const stateless = Math.max(toolCost('steel_scrape'), toolCost('steel_screenshot'), toolCost('steel_pdf'));
        for (const tool of ['steel_session_create', 'steel_navigate', 'steel_act', 'steel_snapshot', 'steel_batch']) {
            expect(toolCost(tool), `${tool} must cost more than a stateless read`).toBeGreaterThan(stateless);
        }
        expect(toolCost('steel_session_create')).toBe(Math.max(...Object.values(TOOL_COSTS)));
    });

    it('never charges for handing a concurrency slot back', () => {
        expect(toolCost('steel_session_release')).toBe(0);
    });

    it('charges the inline viewer no more than a stateless read, since it drives no browser', () => {
        expect(toolCost('steel_session_live_view')).toBe(toolCost('steel_scrape'));
        expect(toolCost('steel_session_live_view')).toBeLessThan(toolCost('steel_navigate'));
    });

    it('charges an unlisted tool the session-driving default rather than nothing', () => {
        expect(toolCost('steel_tool_added_later')).toBe(DEFAULT_TOOL_COST);
        expect(DEFAULT_TOOL_COST).toBeGreaterThan(0);
    });

    it('sizes the shipped budget so stateless reads track the 20/min Browser Tools cap', () => {
        expect(DEFAULT_RATE_LIMIT_POLICY.refillPerMinute).toBe(20);
        expect(toolCost('steel_scrape')).toBe(1);
        expect(DEFAULT_RATE_LIMIT_POLICY.burstCapacity).toBeGreaterThan(DEFAULT_RATE_LIMIT_POLICY.refillPerMinute);
    });
});

describe('cost-weighted accounting', () => {
    it('spends the bucket in proportion to the weight of each tool', async () => {
        const { limiter: rate } = limiter();

        // Ten one-unit reads exactly drain a ten-unit bucket.
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');
        await expect(rate.charge('principal-a', 'steel_scrape')).rejects.toThrow(/budget/);

        // A single heavier call drains the same bucket for another principal.
        const { limiter: heavier } = limiter();
        await heavier.charge('principal-b', 'steel_batch');
        const left = TEST_POLICY.burstCapacity - toolCost('steel_batch');
        for (let call = 0; call < left; call++) await heavier.charge('principal-b', 'steel_scrape');
        await expect(heavier.charge('principal-b', 'steel_scrape')).rejects.toThrow(/budget/);
    });

    it('still admits a release once the budget is exhausted', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        await expect(rate.charge('principal-a', 'steel_session_release')).resolves.toBeUndefined();
    });
});

describe('per-principal isolation', () => {
    it('leaves every other principal untouched when one exhausts its budget', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('noisy', 'steel_scrape');
        await expect(rate.charge('noisy', 'steel_scrape')).rejects.toThrow(/budget/);

        for (let call = 0; call < 10; call++) await rate.charge('quiet', 'steel_scrape');
        await expect(rate.charge('quiet', 'steel_scrape')).rejects.toThrow(/budget/);
        await expect(rate.charge('third', 'steel_session_create')).resolves.toBeUndefined();
    });
});

describe('refill on the injected clock', () => {
    it('restores budget as time passes, up to the burst ceiling', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');
        await expect(rate.charge('principal-a', 'steel_scrape')).rejects.toThrow(/budget/);

        time.advanceSeconds(3);
        for (let call = 0; call < 3; call++) await rate.charge('principal-a', 'steel_scrape');
        await expect(rate.charge('principal-a', 'steel_scrape')).rejects.toThrow(/budget/);

        // An hour of idleness cannot bank more than one bucket of budget.
        time.advanceSeconds(3_600);
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');
        await expect(rate.charge('principal-a', 'steel_scrape')).rejects.toThrow(/budget/);
    });

    it('honours the retry-after it advertised', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'steel_batch'));
        expect(error.retryAfterSeconds).toBe(toolCost('steel_batch'));

        time.advanceSeconds(error.retryAfterSeconds ?? 0);
        await expect(rate.charge('principal-a', 'steel_batch')).resolves.toBeUndefined();
    });

    it('does not hand out free budget when the clock steps backwards', async () => {
        const { limiter: rate, time } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        time.advanceSeconds(-600);
        await expect(rate.charge('principal-a', 'steel_scrape')).rejects.toThrow(/budget/);
    });
});

describe('the rejection error', () => {
    it('names the limit, the cost, the refill rate and a concrete retry-after', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'steel_navigate'));

        expect(error.code).toBe('rate_limited');
        expect(error.message).toContain(RATE_LIMIT_NAME);
        expect(error.message).toContain('steel_navigate');
        expect(error.message).toMatch(/Retry after \d+s/);
        expect(error.message).toMatch(/60 units\/min/);
        expect(error.message).toMatch(/concurrent-session cap/);
        expect(error.message).toMatch(/20 requests\/min Browser Tools/);
        expect(error.message).toMatch(/steel_scrape/);
        expect(error.details).toMatchObject({ limit: RATE_LIMIT_NAME, tool: 'steel_navigate' });
    });

    it('says it is this server rejecting the call, not Steel', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'steel_scrape'));

        expect(error.message).toMatch(/not by Steel/);
    });

    it('renders as a tool-execution error carrying the retry-after', async () => {
        const { limiter: rate } = limiter();
        for (let call = 0; call < 10; call++) await rate.charge('principal-a', 'steel_scrape');

        const error = await rejection(() => rate.charge('principal-a', 'steel_snapshot'));
        const result = toolErrorResult(error);

        expect(result.isError).toBe(true);
        expect(result.content?.map(block => ('text' in block ? block.text : '')).join('\n')).toMatch(
            new RegExp(`Retry-After: ${error.retryAfterSeconds}s`)
        );
        expect(result.structuredContent).toMatchObject({
            error: { code: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds },
        });
    });
});
