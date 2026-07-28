// ABOUTME: Unit tests for the page controller: click hit-testing that names the covering element,
// ABOUTME: ref staleness on action, keyboard and form input, overlay dismissal and explicit waits.
import { describe, expect, it } from 'vitest';
import type { SteelToolError } from '../../src/core/errors.js';
import { BrowserPage } from '../../src/core/page.js';
import { resolveSettleBudgets } from '../../src/core/settle.js';
import { type FixtureNode, type FixturePage, type FixtureSession, fixtureSession } from '../helpers/cdp-fixture.js';

const FAST_BUDGETS = { navigationWatchMs: 1, navigationMs: 5, mutationQuietMs: 1, mutationMaxMs: 5 };

function page(children: FixtureNode[], overrides: Partial<FixturePage> = {}): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Example',
            bounds: [0, 0, 1280, 720],
            children,
        },
        url: 'https://example.com/',
        loaderId: 'loader-1',
        ...overrides,
    };
}

const SAVE_BUTTON: FixtureNode = {
    tag: 'BUTTON',
    backendNodeId: 10,
    role: 'button',
    name: 'Save',
    bounds: [100, 200, 80, 40],
};

interface ActionFixtureOptions {
    hitBackendNodeId?: number;
    contains?: boolean;
    /** Simulates a navigation Chrome refused, which it reports only through errorText. */
    navigateErrorText?: string;
    /** The role and name the live element reports at action time, if it has drifted. */
    liveIdentity?: { role?: string; name?: string };
}

/** Wires the CDP calls the action path makes that the fixture does not model itself. */
function actionFixture(fixture: FixtureSession, options: ActionFixtureOptions = {}) {
    fixture.stub('DOM.scrollIntoViewIfNeeded', () => ({}));
    fixture.stub('DOM.getBoxModel', () => ({ model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }));
    fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: options.hitBackendNodeId ?? 10 }));
    fixture.stub('DOM.describeNode', () => ({
        node: { nodeName: 'DIV', attributes: ['id', 'consent-banner', 'class', 'overlay'] },
    }));
    fixture.stub('DOM.resolveNode', () => ({ object: { objectId: 'obj-1' } }));
    fixture.stub('Runtime.callFunctionOn', () => ({ result: { value: options.contains ?? false } }));
    fixture.stub('DOM.focus', () => ({}));
    fixture.stub('Input.dispatchMouseEvent', () => ({}));
    fixture.stub('Input.dispatchKeyEvent', () => ({}));
    fixture.stub('Input.insertText', () => ({}));
    fixture.stub('Page.navigate', () => ({
        frameId: 'main-frame',
        loaderId: 'loader-1',
        ...(options.navigateErrorText ? { errorText: options.navigateErrorText } : {}),
    }));
    if (options.liveIdentity) {
        fixture.stub('Accessibility.getPartialAXTree', () => ({
            nodes: [
                {
                    nodeId: '1',
                    role: { value: options.liveIdentity?.role ?? 'button' },
                    name: { value: options.liveIdentity?.name ?? 'Save' },
                },
            ],
        }));
    }
    return fixture;
}

async function openPage(fixture: FixtureSession): Promise<BrowserPage> {
    return BrowserPage.attach(fixture.session, { budgets: FAST_BUDGETS });
}

function catchSync(fn: () => unknown): SteelToolError | undefined {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error as SteelToolError;
    }
}

async function catchAsync(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the operation to fail, but it succeeded.');
}

describe('BrowserPage.navigate', () => {
    it('navigates and reports the final URL and change signal', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.navigate('https://example.com/');
        expect(fixture.sent.some(call => call.method === 'Page.navigate')).toBe(true);
        expect(outcome.finalUrl).toBe('https://example.com/');
        expect(outcome.change).toBeDefined();
    });

    it('reports a navigation Chrome refused instead of describing its error page as success', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            navigateErrorText: 'net::ERR_NAME_NOT_RESOLVED',
        });
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.navigate('https://nope.invalid/'));
        expect(error.message).toContain('net::ERR_NAME_NOT_RESOLVED');
        expect(error.message).toContain('https://nope.invalid/');
    });

    it('classifies a refused proxy tunnel as a proxy failure', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            navigateErrorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        });
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.navigate('https://example.com/'));
        expect(error.code).toBe('proxy_failure');
    });

    it('restricts the settle frame filter to the main frame, so an iframe is not a page load', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const navigating = browserPage.navigate('https://example.com/');
        await new Promise(resolve => setTimeout(resolve, 0));
        fixture.emit('Page.frameStartedNavigating', {
            frameId: 'an-advert-iframe',
            url: 'https://ads.test/',
            navigationType: 'differentDocument',
        });
        const outcome = await navigating;
        expect(outcome.change.navigated, 'a subframe navigation was reported as a page load').toBe(false);
    });

    it('reports the main frame URL rather than any frame that happened to navigate', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.navigate('https://example.com/');
        expect(outcome.finalUrl).toBe('https://example.com/');
    });

    it('does not capture a snapshot unless one is asked for', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.navigate('https://example.com/');
        expect(fixture.sent.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
    });
});

describe('BrowserPage.act — click', () => {
    it('scrolls the target into view and dispatches a press and a release at its centre', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });

        expect(fixture.sent.some(call => call.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true);
        const mouse = fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent');
        expect(mouse.map(call => call.params.type)).toEqual(['mousePressed', 'mouseReleased']);
        expect(mouse[0]?.params).toMatchObject({ x: 140, y: 220 });
    });

    it('names the covering element when the click would not reach the target', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 77,
            contains: false,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('click_blocked');
        expect(error.message).toContain('div#consent-banner');
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('allows the click when the topmost node is a descendant of the target', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 78,
            contains: true,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('refuses a ref from a superseded document with a precise staleness error', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        fixture.setPage(page([SAVE_BUTTON], { loaderId: 'loader-2' }));
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
        expect(error.message).toMatch(/page navigated/i);
    });

    it('refuses to click a target whose role or name changed since the snapshot was read', async () => {
        // The hazard is acting on an element relabelled between the read and the click: a button
        // that said Save when the model decided, and says Delete everything by the time it lands.
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'button', name: 'Delete everything' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
        expect(error.message).toMatch(/changed role or accessible name/i);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('clicks when the live element still matches what the snapshot recorded', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'button', name: 'Save' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('clicks when the browser cannot report a live identity, rather than refusing every action', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('refuses a click on a target that changed role, which is a different element', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'link', name: 'Save' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
    });

    it('refuses to act before any snapshot has been taken, naming the fix', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('ref_not_found');
        expect(error.message).toMatch(/steel_snapshot|steel_find/);
    });
});

describe('BrowserPage.act — text entry', () => {
    const FIELD: FixtureNode = {
        tag: 'INPUT',
        backendNodeId: 20,
        role: 'textbox',
        name: 'Password',
        attributes: { type: 'password', name: 'password' },
        bounds: [0, 0, 200, 30],
    };

    it('focuses the field and inserts the text', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: 'hunter2' });

        expect(fixture.sent.some(call => call.method === 'DOM.focus')).toBe(true);
        expect(fixture.sent.find(call => call.method === 'Input.insertText')?.params.text).toBe('hunter2');
    });

    it('clears the field before typing, so a value is replaced rather than appended', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: 'replacement' });

        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        const selectAll = keys.find(call => JSON.stringify(call.params.commands ?? []).includes('selectAll'));
        expect(selectAll, 'nothing selected the existing content before typing').toBeDefined();

        const focusAt = fixture.sent.findIndex(call => call.method === 'DOM.focus');
        const selectAt = fixture.sent.indexOf(selectAll!);
        const insertAt = fixture.sent.findIndex(call => call.method === 'Input.insertText');
        expect(focusAt).toBeLessThan(selectAt);
        expect(selectAt).toBeLessThan(insertAt);
    });

    it('deletes the selection rather than inserting nothing when clearing a field', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: '' });

        expect(fixture.sent.some(call => call.method === 'Input.insertText')).toBe(false);
        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        expect(keys.some(call => call.params.key === 'Delete')).toBe(true);
    });

    it('never echoes a value typed into a password field back to the caller', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const outcome = await browserPage.act({ action: 'type', target: '@e1', value: 'hunter2' });
        expect(JSON.stringify(outcome)).not.toContain('hunter2');
    });

    it('echoes an ordinary value so the caller can see what was entered', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    {
                        tag: 'INPUT',
                        backendNodeId: 23,
                        role: 'textbox',
                        name: 'City',
                        attributes: { type: 'text', name: 'city' },
                        bounds: [0, 0, 200, 30],
                    },
                ])
            )
        );
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const outcome = await browserPage.act({ action: 'type', target: '@e1', value: 'Zagreb' });
        expect(outcome.summary).toContain('Zagreb');
    });

    it('fills several fields in one call and settles once', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    { ...FIELD, backendNodeId: 21, name: 'Email', attributes: { type: 'email', name: 'email' } },
                    { ...FIELD, backendNodeId: 22, name: 'City', attributes: { type: 'text', name: 'city' } },
                ])
            )
        );
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({
            action: 'fill_form',
            fields: [
                { target: '@e1', value: 'a@b.test' },
                { target: '@e2', value: 'Zagreb' },
            ],
        });
        expect(fixture.sent.filter(call => call.method === 'Input.insertText')).toHaveLength(2);
        expect(fixture.sent.filter(call => call.method === 'Runtime.evaluate').length).toBeLessThanOrEqual(4);
    });
});

describe('BrowserPage.act — keyboard', () => {
    it('sends a keydown and keyup with the virtual key code for a named key', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.act({ action: 'press', value: 'Enter' });
        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        expect(keys.map(call => call.params.type)).toEqual(['keyDown', 'keyUp']);
        expect(keys[0]?.params).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });

    it('rejects an unknown key name rather than sending nothing', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.act({ action: 'press', value: 'Fnord' }));
        expect(error.code).toBe('invalid_argument');
        expect(error.message).toContain('Fnord');
    });
});

describe('BrowserPage.act — dismiss_overlays', () => {
    it('presses Escape and clicks a recognised consent control, naming what it dismissed', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    {
                        tag: 'BUTTON',
                        backendNodeId: 30,
                        role: 'button',
                        name: 'Accept all cookies',
                        bounds: [10, 10, 120, 40],
                    },
                    SAVE_BUTTON,
                ])
            )
        );
        fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: 30 }));
        const browserPage = await openPage(fixture);

        const outcome = await browserPage.act({ action: 'dismiss_overlays' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(true);
        expect(outcome.summary).toContain('Accept all cookies');
    });

    it('says so when there was nothing to dismiss', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.act({ action: 'dismiss_overlays' });
        expect(outcome.summary).toMatch(/no .*overlay/i);
    });
});

describe('BrowserPage.waitFor', () => {
    it('returns as soon as the awaited text appears', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        setTimeout(() => fixture.setPage(page([{ ...SAVE_BUTTON, name: 'Order confirmed' }])), 20);
        const outcome = await browserPage.waitFor({ text: 'Order confirmed', timeoutMs: 2_000 });
        expect(outcome.satisfied).toBe(true);
    });

    it('fails with a timeout naming what it waited for', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.waitFor({ text: 'Never appears', timeoutMs: 60 }));
        expect(error.code).toBe('timeout');
        expect(error.message).toContain('Never appears');
    });

    it('waits for a URL match', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        setTimeout(() => fixture.setPage(page([], { url: 'https://example.com/done' })), 20);
        expect((await browserPage.waitFor({ url: '/done', timeoutMs: 2_000 })).satisfied).toBe(true);
    });

    it('rejects a wait with no condition instead of sleeping', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.waitFor({ timeoutMs: 100 }));
        expect(error.code).toBe('invalid_argument');
    });
});

describe('BrowserPage.attach', () => {
    it('enables only the CDP domains the pipeline needs', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        await openPage(fixture);
        const enabled = fixture.sent.filter(call => call.method.endsWith('.enable')).map(call => call.method);
        expect(enabled).toContain('Page.enable');
        expect(enabled).toContain('DOM.enable');
        expect(enabled).toContain('Accessibility.enable');
        expect(enabled).not.toContain('Network.enable');
    });
});

describe('settle budget wiring', () => {
    it('uses scaled budgets by default so proxied sessions are not cut short', () => {
        expect(catchSync(() => resolveSettleBudgets(2))).toBeUndefined();
        expect(resolveSettleBudgets(2).navigationMs).toBeGreaterThan(resolveSettleBudgets(1).navigationMs);
    });
});
