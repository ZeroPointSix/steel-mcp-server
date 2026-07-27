// ABOUTME: End-to-end tests against a real self-hosted steel-browser and the adversarial fixture
// ABOUTME: site: hit-tested clicks, inferred names, injection stripping and session teardown.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { CdpSessionPool } from '../../src/core/context.js';
import type { BrowserPage } from '../../src/core/page.js';
import { SteelRestClient } from '../../src/core/steel/rest.js';
import { describeStack, E2E_ENV, FIXTURE_BASE_URL, FIXTURE_PROBE_URL, stackIsUp } from './stack.js';

const available = await stackIsUp();
const reason = describeStack(available);

const config = loadConfig(E2E_ENV);
const api = new SteelRestClient(config);
const pool = new CdpSessionPool(config, 1);

// Self-hosted steel-browser runs one browser session at a time, so the whole file shares one and
// resets between tests by navigating, exactly as a real agent working through a site would.
let steelSessionId = '';
let sharedPage: BrowserPage;

async function openSession(): Promise<BrowserPage> {
    return sharedPage;
}

beforeAll(async () => {
    if (!available) return;
    // Fail loudly rather than silently skipping if the fixture site is not the one we expect.
    const response = await fetch(`${FIXTURE_PROBE_URL}/`);
    expect(response.status, 'fixture site is not serving its index').toBe(200);

    steelSessionId = crypto.randomUUID();
    await api.createSession({ sessionId: steelSessionId, timeout: 300_000, inactivityTimeout: 120_000 });
    sharedPage = await pool.page(steelSessionId);
});

afterAll(async () => {
    await pool.closeAll().catch(() => undefined);
    if (steelSessionId) await api.releaseSession(steelSessionId).catch(() => undefined);
});

describe.skipIf(!available)(`browsing the adversarial fixture site (${reason})`, () => {
    it('snapshots a real page and gives refs only to interactive elements', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/`);
        const snapshot = await page.snapshot({});

        expect(snapshot.nodes.length).toBeGreaterThan(0);
        const links = snapshot.nodes.filter(node => node.role === 'link');
        expect(links.length).toBeGreaterThanOrEqual(7);
        expect(links.every(link => link.ref?.startsWith('@e'))).toBe(true);
        expect(snapshot.text).toContain('Cookie banner');
    });

    it('refuses a click covered by a consent overlay and names the overlay', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/cookie-banner`);
        await page.snapshot({});
        const [primary] = await page.find({ text: 'Add to basket' });
        expect(primary?.ref).toBeDefined();

        const error = await page.act({ action: 'click', target: primary!.ref! }).then(
            () => null,
            (thrown: unknown) => thrown as { code?: string; message?: string }
        );
        expect(error?.code).toBe('click_blocked');
        expect(error?.message).toMatch(/consent-banner/);
    });

    it('dismisses the overlay and then completes the click it was blocking', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/cookie-banner`);
        await page.snapshot({});

        const dismissal = await page.act({ action: 'dismiss_overlays' });
        expect(dismissal.summary).toMatch(/Accept all cookies/);

        await page.snapshot({});
        const [primary] = await page.find({ text: 'Add to basket' });
        const outcome = await page.act({ action: 'click', target: primary!.ref! });
        expect(outcome.change.domMutated).toBe(true);

        const after = await page.snapshot({});
        expect(after.text).toContain('Added to basket');
    });

    it('synthesises names for icon-only buttons and marks them inferred', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/unnamed-buttons`);
        const snapshot = await page.snapshot({});
        const buttons = snapshot.nodes.filter(node => node.role === 'button');

        expect(buttons.length).toBeGreaterThanOrEqual(4);
        expect(buttons.map(button => button.name)).toContain('Save document');
        expect(buttons.map(button => button.name)).toContain('Delete item');
        // The name attribute is a guess, so it must be flagged for the model to discount.
        const guessed = buttons.find(button => button.name === 'open-settings');
        expect(guessed?.nameInferred).toBe(true);
        // A control with nothing to name it still gets a ref so it can be reached.
        expect(buttons.some(button => button.name === '' && button.ref !== undefined)).toBe(true);
    });

    it('strips every hidden-instruction channel and redacts the password value', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/hidden-injection`);
        const snapshot = await page.snapshot({});

        expect(snapshot.text).toContain('42 EUR');
        expect(snapshot.text).not.toContain('INJECTED_VIA_COMMENT');
        expect(snapshot.text).not.toContain('INJECTED_VIA_DISPLAY_NONE');
        expect(snapshot.text).not.toContain('hunter2-should-not-leak');
        // Zero-width characters must not survive into the text a model reads.
        expect(snapshot.text).not.toMatch(/[​-‍﻿]/);
        expect(snapshot.text).toContain('Buynow');
        // A markdown image in page text must not be renderable as an outbound request.
        expect(snapshot.text).not.toContain('![leak](');
    });

    it('gives no ref to an element hidden behind visibility:hidden', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/hidden-injection`);
        const snapshot = await page.snapshot({});
        const hidden = snapshot.nodes.filter(node => node.name.includes('INJECTED_VIA_VISIBILITY'));
        expect(hidden.every(node => node.ref === undefined)).toBe(true);
    });

    it('fills a login form and follows the redirect', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/login`);
        await page.snapshot({});

        const [email] = await page.find({ text: 'Email', interactiveOnly: true });
        const outcome = await page.act({
            action: 'fill_form',
            fields: [{ target: email!.ref!, value: 'someone@example.test' }],
        });
        expect(JSON.stringify(outcome)).not.toContain('prefilled-secret');

        await page.snapshot({});
        const [submit] = await page.find({ text: 'Sign in', role: 'button' });
        await page.act({ action: 'click', target: submit!.ref! });
        await page.waitFor({ text: 'Signed in successfully', timeoutMs: 15_000 });
    });

    it('waits for a modal that appears after the page was already read', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/modal`);
        const before = await page.snapshot({});
        expect(before.text).not.toContain('Join our newsletter');

        await page.waitFor({ text: 'Join our newsletter', timeoutMs: 15_000 });
        const after = await page.snapshot({});
        expect(after.text).toContain('Join our newsletter');
    });

    it('reports a ref from a superseded document as stale rather than resolving it', async () => {
        const page = await openSession();
        await page.navigate(`${FIXTURE_BASE_URL}/cookie-banner`);
        await page.snapshot({});
        const [accept] = await page.find({ text: 'Accept all cookies' });

        await page.navigate(`${FIXTURE_BASE_URL}/login`);
        await page.snapshot({});

        const error = await page.act({ action: 'click', target: accept!.ref! }).then(
            () => null,
            (thrown: unknown) => thrown as { code?: string; message?: string }
        );
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/page navigated/i);
    });
});

describe.skipIf(!available)(`session teardown against a real browser (${reason})`, () => {
    it('releases the Steel session, and a second release is not an error', async () => {
        await pool.close(steelSessionId);
        await api.releaseSession(steelSessionId);
        await expect(api.releaseSession(steelSessionId)).resolves.toBeUndefined();

        const after = await api.getSession(steelSessionId).catch(() => ({ status: 'gone' }));
        expect(after.status).not.toBe('live');
        steelSessionId = '';
    });
});
