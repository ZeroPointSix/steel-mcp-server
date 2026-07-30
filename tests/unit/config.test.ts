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

    it('does not treat a lookalike domain as Steel Cloud', () => {
        // Without a dot boundary, evilsteel.dev would be classified as Cloud and handed the key.
        for (const host of ['evilsteel.dev', 'notsteel.dev', 'steel.dev.attacker.test']) {
            const config = loadConfig({ STEEL_API_KEY: 'ste-secret', STEEL_BASE_URL: `https://${host}` });
            expect(config.deployment, `${host} was classified as Steel Cloud`).toBe('self_hosted');
        }
    });

    it('still recognises Steel Cloud and its subdomains', () => {
        for (const host of ['steel.dev', 'api.steel.dev', 'api.eu.steel.dev']) {
            const config = loadConfig({ STEEL_API_KEY: 'ste-secret', STEEL_BASE_URL: `https://${host}` });
            expect(config.deployment, `${host} was not recognised as Steel Cloud`).toBe('cloud');
        }
    });

    it('honours STEEL_LOCAL, which the shipped README tells self-hosters to toggle', () => {
        // An upgrading self-hoster with a leftover key would otherwise silently start creating
        // billed cloud sessions.
        const local = loadConfig({ STEEL_LOCAL: 'true', STEEL_API_KEY: 'ste-leftover-key' });
        expect(local.deployment).toBe('self_hosted');
        expect(local.baseUrl).toBe('http://localhost:3000');
        expect(local.apiKey, 'a local deployment kept a cloud credential').toBeUndefined();
    });

    it('waives the API key requirement when STEEL_LOCAL is set', () => {
        expect(() => loadConfig({ STEEL_LOCAL: 'true' })).not.toThrow();
    });

    it('lets an explicit base URL win over the STEEL_LOCAL default', () => {
        const config = loadConfig({ STEEL_LOCAL: 'true', STEEL_BASE_URL: 'http://steel-browser:3000' });
        expect(config.baseUrl).toBe('http://steel-browser:3000');
        expect(config.deployment).toBe('self_hosted');
    });

    it('treats STEEL_LOCAL=false as the cloud it names', () => {
        expect(loadConfig({ STEEL_LOCAL: 'false', STEEL_API_KEY: 'k' }).deployment).toBe('cloud');
    });

    it('warns about the retired GLOBAL_WAIT_SECONDS instead of ignoring it', () => {
        const config = loadConfig({ STEEL_API_KEY: 'k', GLOBAL_WAIT_SECONDS: '2' });
        expect(config.warnings.join(' ')).toMatch(/GLOBAL_WAIT_SECONDS/);
        expect(config.warnings.join(' '), 'the warning does not name the replacement').toMatch(/steel_wait_for/);
    });

    it('has no warnings for a plain configuration', () => {
        expect(loadConfig({ STEEL_API_KEY: 'k' }).warnings).toEqual([]);
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

    it('uses the operator request-state secret so every replica can verify a retried handoff', () => {
        const secret = 'x'.repeat(48);
        expect(loadConfig({ STEEL_API_KEY: 'k', STEEL_REQUEST_STATE_SECRET: secret }).requestStateSecret).toBe(secret);
    });

    it('generates a distinct per-process secret when none is configured', () => {
        const first = loadConfig({ STEEL_API_KEY: 'k' }).requestStateSecret;
        const second = loadConfig({ STEEL_API_KEY: 'k' }).requestStateSecret;
        expect(Buffer.byteLength(first, 'utf8')).toBeGreaterThanOrEqual(32);
        expect(first).not.toBe(second);
    });

    it('refuses a configured secret too short to be an HMAC key, rather than truncating it', () => {
        expect(() => loadConfig({ STEEL_API_KEY: 'k', STEEL_REQUEST_STATE_SECRET: 'short' })).toThrow(
            /STEEL_REQUEST_STATE_SECRET/
        );
    });

    it('does not put the Steel credential in the request-state secret', () => {
        expect(loadConfig({ STEEL_API_KEY: 'ste-supersecret' }).requestStateSecret).not.toContain('supersecret');
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
