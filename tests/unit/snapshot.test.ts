// ABOUTME: Unit tests for the accessibility snapshot pipeline: which nodes earn a @eN ref, how refs
// ABOUTME: survive DOM mutation, viewport marking, password redaction and precise staleness errors.
import { describe, expect, it } from 'vitest';
import type { SteelToolError } from '../../src/core/errors.js';
import { findInSnapshot, PageState, renderSnapshot } from '../../src/core/snapshot.js';
import { type FixtureNode, type FixturePage, fixtureSession } from '../helpers/cdp-fixture.js';

function page(children: FixtureNode[], overrides: Partial<FixturePage> = {}): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: overrides.title ?? 'Example',
            bounds: [0, 0, 1280, 720],
            children,
        },
        url: 'https://example.com/',
        title: 'Example',
        loaderId: 'loader-1',
        ...overrides,
    };
}

const BUTTON: FixtureNode = {
    tag: 'BUTTON',
    backendNodeId: 10,
    role: 'button',
    name: 'Save',
    bounds: [10, 20, 80, 30],
};

describe('PageState.capture — which nodes earn a ref', () => {
    it('gives a ref to a visible node that receives pointer events', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.ref).toBe('@e1');
    });

    it('withholds a ref from a node with pointer-events none, but keeps it in the text', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, pointerEvents: 'none' }]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button).toBeDefined();
        expect(button?.ref).toBeUndefined();
    });

    it('withholds a ref from a visibility-hidden node', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, visibility: 'hidden' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('withholds a ref from a node the layout engine never rendered', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: undefined }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('withholds a ref from a zero-area node', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: [10, 20, 0, 0] }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('drops accessibility-ignored nodes entirely', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, ignored: true }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')).toBeUndefined();
    });

    it('keeps an off-screen node with a ref and marks it out of the viewport', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: [10, 3000, 80, 30] }]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.ref).toBe('@e1');
        expect(button?.inViewport).toBe(false);
    });
});

describe('PageState.capture — ref stability', () => {
    it('keeps a ref across a DOM mutation that changes the accessible name', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        const first = await state.capture(fixture.session, {});
        const originalRef = first.nodes.find(node => node.role === 'button')?.ref;

        fixture.setPage(page([{ ...BUTTON, name: 'Saving…' }]));
        const second = await state.capture(fixture.session, {});

        expect(second.nodes.find(node => node.role === 'button')?.ref).toBe(originalRef);
        expect(second.snapshotId).not.toBe(first.snapshotId);
    });

    it('issues fresh refs after a document load so an old ref can never silently resolve', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});

        fixture.setPage(page([BUTTON], { loaderId: 'loader-2', url: 'https://example.com/2' }));
        const second = await state.capture(fixture.session, {});

        expect(second.loaderId).toBe('loader-2');
        expect(second.nodes.find(node => node.role === 'button')?.ref).not.toBe('@e1');
    });

    it('assigns a new ref to a node that appears after the first snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});

        fixture.setPage(
            page([BUTTON, { tag: 'A', backendNodeId: 11, role: 'link', name: 'Next', bounds: [10, 60, 40, 20] }])
        );
        const second = await state.capture(fixture.session, {});
        expect(second.nodes.find(node => node.role === 'link')?.ref).toBe('@e2');
    });
});

describe('PageState.resolveRef', () => {
    it('resolves a live ref to its backend node', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        expect(state.resolveRef('@e1').backendNodeId).toBe(10);
    });

    it('reports an unknown ref as not found rather than as stale', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        expect(catchSync(() => state.resolveRef('@e99'))?.code).toBe('ref_not_found');
    });

    it('reports a navigation as the reason when the document changed', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        fixture.setPage(page([BUTTON], { loaderId: 'loader-2' }));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.resolveRef('@e1'));
        // The button survived the reload under a fresh loaderId, so the old ref is gone.
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/page navigated/i);
    });

    it('reports node removal when the element disappeared from the current snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        fixture.setPage(page([]));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.resolveRef('@e1'));
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/removed from the DOM/i);
    });

    it('flags a target whose role or accessible name changed since the snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        const recorded = state.resolveRef('@e1');

        fixture.setPage(page([{ ...BUTTON, name: 'Delete everything' }]));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.assertIdentityUnchanged('@e1', recorded));
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/changed role or accessible name/i);
    });
});

describe('PageState.capture — untrusted content handling', () => {
    it('redacts the value of a password input', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 20,
                    role: 'textbox',
                    name: 'Password',
                    attributes: { type: 'password', name: 'password' },
                    inputValue: 'hunter2',
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        const field = snapshot.nodes.find(node => node.name === 'Password');
        expect(field?.value).toBe('[redacted:7 chars]');
        expect(snapshot.text).not.toContain('hunter2');
    });

    it('keeps the value of an ordinary text input', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 21,
                    role: 'textbox',
                    name: 'City',
                    attributes: { type: 'text', name: 'city' },
                    inputValue: 'Zagreb',
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'City')?.value).toBe('Zagreb');
    });

    it('strips invisible characters smuggled into an accessible name', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, name: 'Sa​ve' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.name).toBe('Save');
    });

    it('defangs a markdown link smuggled into an accessible name', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, name: '![x](https://evil.test/leak)' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.name).not.toContain('](');
    });
});

describe('PageState.capture — name synthesis', () => {
    it('synthesises a name for an unnamed button and marks it inferred', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'BUTTON',
                    backendNodeId: 30,
                    role: 'button',
                    name: '',
                    attributes: { 'aria-label': '', title: 'Close dialog' },
                    bounds: [0, 0, 20, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.name).toBe('Close dialog');
        expect(button?.nameInferred).toBe(true);
    });

    it('falls back through alt, placeholder and name attributes', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 31,
                    role: 'textbox',
                    name: '',
                    attributes: { placeholder: 'Search products' },
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'textbox')?.name).toBe('Search products');
    });

    it('does not mark a real accessible name as inferred', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.nameInferred).toBe(false);
    });
});

describe('renderSnapshot', () => {
    it('renders one line per node with role, name and ref', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('button "Save" @e1');
    });

    it('marks inferred names and off-screen nodes', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'BUTTON',
                    backendNodeId: 40,
                    role: 'button',
                    name: '',
                    attributes: { title: 'Menu' },
                    bounds: [0, 5000, 20, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('(inferred)');
        expect(snapshot.text).toContain('[off-screen]');
    });

    it('never emits a ref for a node that has none', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, pointerEvents: 'none' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('button "Save"');
        expect(snapshot.text).not.toMatch(/@e\d/);
    });

    it('indents by tree depth so structure survives the flattening', () => {
        const text = renderSnapshot([
            {
                role: 'main',
                name: '',
                nameInferred: false,
                backendNodeId: 1,
                depth: 0,
                inViewport: true,
                interactive: false,
            },
            {
                role: 'button',
                name: 'Go',
                nameInferred: false,
                backendNodeId: 2,
                depth: 1,
                inViewport: true,
                interactive: true,
                ref: '@e1',
            },
        ]);
        const lines = text.split('\n');
        expect(lines[0]).toMatch(/^- main/);
        expect(lines[1]).toMatch(/^ {2}- button "Go" @e1/);
    });
});

describe('findInSnapshot', () => {
    const nodes = [
        {
            role: 'button',
            name: 'Save changes',
            nameInferred: false,
            backendNodeId: 1,
            depth: 1,
            inViewport: true,
            interactive: true,
            ref: '@e1',
        },
        {
            role: 'link',
            name: 'Save as draft',
            nameInferred: false,
            backendNodeId: 2,
            depth: 1,
            inViewport: true,
            interactive: true,
            ref: '@e2',
        },
        {
            role: 'heading',
            name: 'Settings',
            nameInferred: false,
            backendNodeId: 3,
            depth: 0,
            inViewport: true,
            interactive: false,
        },
    ];

    it('matches on a case-insensitive substring of the name', () => {
        expect(findInSnapshot(nodes, { text: 'save' }).map(node => node.ref)).toEqual(['@e1', '@e2']);
    });

    it('matches on a regular expression', () => {
        expect(findInSnapshot(nodes, { regex: '^Save c' }).map(node => node.ref)).toEqual(['@e1']);
    });

    it('filters by role', () => {
        expect(findInSnapshot(nodes, { text: 'save', role: 'link' }).map(node => node.ref)).toEqual(['@e2']);
    });

    it('can restrict results to nodes that can actually be targeted', () => {
        expect(findInSnapshot(nodes, { text: 'settings', interactiveOnly: true })).toEqual([]);
        expect(findInSnapshot(nodes, { text: 'settings' })).toHaveLength(1);
    });

    it('rejects an invalid regular expression with an actionable message', () => {
        expect(() => findInSnapshot(nodes, { regex: '([' })).toThrow(/not a valid regular expression/i);
    });
});

/** Runs a synchronous call and returns the SteelToolError it threw, if any. */
function catchSync(fn: () => unknown): SteelToolError | undefined {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error as SteelToolError;
    }
}
