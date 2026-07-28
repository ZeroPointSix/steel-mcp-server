// ABOUTME: Unit tests for environment configuration: base URL normalisation, deployment detection
// ABOUTME: and the CDP connect URL, which must always carry both apiKey and sessionId on cloud.
import { describe, expect, it } from 'vitest';
import { buildCdpUrl, loadConfig, normalizeBaseUrl, resolveInactivityTimeout } from '../../src/core/config.js';

describe('normalizeBaseUrl', () => {
    it('strips a trailing /v1 so the CLI-style and SDK-style values agree', () => {
        expect(normalizeBaseUrl('https://api.steel.dev/v1')).toBe('https://api.steel.dev');
        expect(normalizeBaseUrl('https://api.steel.dev/v1/')).toBe('https://api.steel.dev');
    });

    it('strips trailing slashes', () => {
        expect(normalizeBaseUrl('http://localhost:3000///')).toBe('http://localhost:3000');
    });

    it('leaves an already-normal URL alone', () => {
        expect(normalizeBaseUrl('https://api.steel.dev')).toBe('https://api.steel.dev');
    });
});

describe('loadConfig', () => {
    it('defaults to Steel Cloud with the browse profile', () => {
        const config = loadConfig({ STEEL_API_KEY: 'ste-abc' });
        expect(config.baseUrl).toBe('https://api.steel.dev');
        expect(config.deployment).toBe('cloud');
        expect(config.profile).toBe('browse');
        expect(config.apiKey).toBe('ste-abc');
    });

    it('detects a self-hosted deployment from a non-Steel base URL', () => {
        const config = loadConfig({ STEEL_BASE_URL: 'http://localhost:3000' });
        expect(config.deployment).toBe('self_hosted');
        expect(config.maxConcurrentSessions).toBe(1);
    });

    it('reads the profile from the environment and rejects unknown names', () => {
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: 'scrape' }).profile).toBe('scrape');
        expect(() => loadConfig({ STEEL_API_KEY: 'k', STEEL_PROFILE: 'turbo' })).toThrow(/turbo/);
    });

    it('refuses a cloud deployment with no API key', () => {
        expect(() => loadConfig({})).toThrow(/STEEL_API_KEY/);
    });
});

describe('resolveInactivityTimeout', () => {
    it('keeps the configured idle timeout when it is safely below the hard timeout', () => {
        expect(resolveInactivityTimeout(120_000, 900_000)).toBe(120_000);
    });

    it('never returns a value equal to the hard timeout, which Steel treats as inert', () => {
        expect(resolveInactivityTimeout(120_000, 120_000)).not.toBe(120_000);
        expect(resolveInactivityTimeout(120_000, 120_000)!).toBeLessThan(120_000);
    });

    it('stays strictly below a hard timeout shorter than the configured idle timeout', () => {
        for (const timeout of [119_999, 60_000, 30_000, 5_000, 2_000]) {
            const idle = resolveInactivityTimeout(120_000, timeout);
            expect(idle, `no idle timeout produced for a ${timeout}ms session`).toBeDefined();
            expect(idle!, `idle timeout ${idle} is inert against a ${timeout}ms hard timeout`).toBeLessThan(timeout);
            expect(idle!).toBeGreaterThan(0);
        }
    });

    it('omits the idle timeout rather than sending a uselessly small one', () => {
        expect(resolveInactivityTimeout(120_000, 500)).toBeUndefined();
    });
});

describe('buildCdpUrl', () => {
    it('always includes both apiKey and sessionId on cloud, never just one', () => {
        const url = new URL(
            buildCdpUrl({ deployment: 'cloud', apiKey: 'ste-abc', connectUrl: 'wss://connect.steel.dev' }, 'sess-uuid')
        );
        expect(url.origin).toBe('wss://connect.steel.dev');
        expect(url.searchParams.get('apiKey')).toBe('ste-abc');
        expect(url.searchParams.get('sessionId')).toBe('sess-uuid');
    });

    it('passes sessionId on self-hosted too so no untracked session is created', () => {
        const url = new URL(buildCdpUrl({ deployment: 'self_hosted', connectUrl: 'ws://localhost:3000' }, 'sess-uuid'));
        expect(url.searchParams.get('sessionId')).toBe('sess-uuid');
        expect(url.searchParams.has('apiKey')).toBe(false);
    });

    it('refuses to build a URL without a session id, which would silently start a billed session', () => {
        expect(() => buildCdpUrl({ deployment: 'cloud', apiKey: 'k', connectUrl: 'wss://c' }, '')).toThrow(/sessionId/);
    });
});
