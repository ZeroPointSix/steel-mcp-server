// ABOUTME: Unit tests for token budgeting and cursor pagination, which keep every text tool
// ABOUTME: well under the host response cap and make truncation visible rather than silent.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TOKENS, estimateTokens, HOST_RESPONSE_TOKEN_CAP, paginate } from '../../src/core/pagination.js';

const lines = (count: number, width = 60) =>
    Array.from({ length: count }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(width)}`).join('\n');

describe('estimateTokens', () => {
    it('grows with text length', () => {
        expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(estimateTokens('x'.repeat(40)));
    });

    it('treats an empty string as zero', () => {
        expect(estimateTokens('')).toBe(0);
    });
});

describe('DEFAULT_MAX_TOKENS', () => {
    it('sits well under the host response cap so a page cannot fill the window', () => {
        expect(DEFAULT_MAX_TOKENS).toBeLessThan(HOST_RESPONSE_TOKEN_CAP / 2);
    });
});

describe('paginate', () => {
    it('returns the whole text and no cursor when it fits the budget', () => {
        const page = paginate('short text', { maxTokens: 1_000 });
        expect(page.text).toBe('short text');
        expect(page.nextCursor).toBeUndefined();
        expect(page.truncated).toBe(false);
    });

    it('truncates at a line boundary and reports that it did', () => {
        const page = paginate(lines(500), { maxTokens: 100 });
        expect(page.truncated).toBe(true);
        expect(page.nextCursor).toBeDefined();
        expect(page.text.endsWith('\n')).toBe(false);
        expect(page.text.split('\n').every(line => /^\d{4} x+$/.test(line))).toBe(true);
    });

    it('resumes exactly where the previous page stopped, with no gap and no repeat', () => {
        const text = lines(500);
        const first = paginate(text, { maxTokens: 100 });
        const second = paginate(text, { maxTokens: 100, cursor: first.nextCursor });
        expect(second.text.startsWith(text.slice(first.text.length + 1, first.text.length + 6))).toBe(true);
        expect(`${first.text}\n${second.text}`).toBe(text.slice(0, first.text.length + 1 + second.text.length));
    });

    it('walks the whole document across pages without losing a byte', () => {
        const text = lines(300);
        const chunks: string[] = [];
        let cursor: string | undefined;
        do {
            const page = paginate(text, { maxTokens: 80, cursor });
            chunks.push(page.text);
            cursor = page.nextCursor;
        } while (cursor);
        expect(chunks.join('\n')).toBe(text);
    });

    it('rejects a cursor minted against different content instead of returning garbage', () => {
        const first = paginate(lines(500), { maxTokens: 100 });
        expect(() => paginate(lines(400), { maxTokens: 100, cursor: first.nextCursor })).toThrow(/cursor/i);
    });

    it('rejects a malformed cursor', () => {
        expect(() => paginate('abc', { maxTokens: 10, cursor: 'not-a-cursor' })).toThrow(/cursor/i);
    });

    it('makes progress even when a single line exceeds the whole budget', () => {
        const page = paginate(`${'y'.repeat(10_000)}\ntail`, { maxTokens: 10 });
        expect(page.text.length).toBeGreaterThan(0);
        expect(page.nextCursor).toBeDefined();
    });
});
