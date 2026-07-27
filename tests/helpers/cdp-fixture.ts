// ABOUTME: Builds a fake page-scoped CDP session from a declarative node tree, producing the exact
// ABOUTME: Accessibility.getFullAXTree and DOMSnapshot.captureSnapshot payloads the pipeline joins.
import type { CdpEventParams, CdpSession } from '../../src/core/steel/cdp.js';

/** One node in a fixture page. Omitting `bounds` models a node the layout engine never rendered. */
export interface FixtureNode {
    tag: string;
    backendNodeId: number;
    /** ARIA role. Omit to leave the node out of the accessibility tree entirely. */
    role?: string;
    name?: string;
    /** Marked ignored by Chrome (aria-hidden, presentational, etc.). */
    ignored?: boolean;
    attributes?: Record<string, string>;
    inputValue?: string;
    /** `[x, y, width, height]` in CSS pixels. Absent means not in the layout tree. */
    bounds?: [number, number, number, number];
    pointerEvents?: string;
    visibility?: string;
    /** AX properties such as level, checked, disabled. */
    properties?: Record<string, string | number | boolean>;
    children?: FixtureNode[];
}

export interface FixturePage {
    root: FixtureNode;
    loaderId?: string;
    url?: string;
    title?: string;
    frameId?: string;
    viewport?: { width: number; height: number };
    scroll?: { x: number; y: number };
}

interface FlatNode {
    node: FixtureNode;
    index: number;
    parentIndex: number;
}

function flatten(root: FixtureNode): FlatNode[] {
    const flat: FlatNode[] = [];
    const walk = (node: FixtureNode, parentIndex: number): void => {
        const index = flat.length;
        flat.push({ node, index, parentIndex });
        for (const child of node.children ?? []) walk(child, index);
    };
    walk(root, -1);
    return flat;
}

class StringTable {
    readonly strings: string[] = [];
    private readonly index = new Map<string, number>();

    intern(value: string): number {
        const existing = this.index.get(value);
        if (existing !== undefined) return existing;
        this.strings.push(value);
        const at = this.strings.length - 1;
        this.index.set(value, at);
        return at;
    }
}

/** The computed styles the snapshot pipeline asks DOMSnapshot for, in order. */
export const REQUESTED_COMPUTED_STYLES = ['pointer-events', 'visibility', 'display', 'opacity'];

function buildAxTree(flat: FlatNode[]) {
    const axNodes = flat
        .filter(entry => entry.node.role !== undefined)
        .map(entry => {
            const { node } = entry;
            const childIds = flat
                .filter(child => child.parentIndex === entry.index && child.node.role !== undefined)
                .map(child => String(child.index));
            return {
                nodeId: String(entry.index),
                ignored: node.ignored ?? false,
                role: { type: 'role', value: node.role },
                name: node.name === undefined ? undefined : { type: 'computedString', value: node.name },
                value: node.inputValue === undefined ? undefined : { type: 'string', value: node.inputValue },
                properties: Object.entries(node.properties ?? {}).map(([name, value]) => ({
                    name,
                    value: { type: typeof value, value },
                })),
                childIds,
                backendDOMNodeId: node.backendNodeId,
                parentId: entry.parentIndex >= 0 ? String(entry.parentIndex) : undefined,
            };
        });
    return { nodes: axNodes };
}

function buildDomSnapshot(flat: FlatNode[], page: FixturePage) {
    const table = new StringTable();
    const layoutNodeIndex: number[] = [];
    const layoutStyles: number[][] = [];
    const layoutBounds: number[][] = [];
    const inputValueIndex: number[] = [];
    const inputValueValue: number[] = [];
    const isClickableIndex: number[] = [];

    for (const { node, index } of flat) {
        if (node.inputValue !== undefined) {
            inputValueIndex.push(index);
            inputValueValue.push(table.intern(node.inputValue));
        }
        if (node.role === 'button' || node.role === 'link' || node.tag === 'BUTTON' || node.tag === 'A') {
            isClickableIndex.push(index);
        }
        if (!node.bounds) continue;
        layoutNodeIndex.push(index);
        layoutStyles.push([
            table.intern(node.pointerEvents ?? 'auto'),
            table.intern(node.visibility ?? 'visible'),
            table.intern('block'),
            table.intern('1'),
        ]);
        layoutBounds.push([...node.bounds]);
    }

    return {
        strings: table.strings,
        documents: [
            {
                documentURL: table.intern(page.url ?? 'https://example.com/'),
                title: table.intern(page.title ?? 'Example'),
                baseURL: table.intern(page.url ?? 'https://example.com/'),
                frameId: table.intern(page.frameId ?? 'main-frame'),
                nodes: {
                    parentIndex: flat.map(entry => entry.parentIndex),
                    nodeType: flat.map(entry => (entry.node.tag === '#text' ? 3 : 1)),
                    nodeName: flat.map(entry => table.intern(entry.node.tag)),
                    nodeValue: flat.map(entry => table.intern(entry.node.attributes?.['#value'] ?? '')),
                    backendNodeId: flat.map(entry => entry.node.backendNodeId),
                    attributes: flat.map(entry =>
                        Object.entries(entry.node.attributes ?? {})
                            .filter(([name]) => name !== '#value')
                            .flatMap(([name, value]) => [table.intern(name), table.intern(value)])
                    ),
                    inputValue: { index: inputValueIndex, value: inputValueValue },
                    isClickable: { index: isClickableIndex },
                },
                layout: {
                    nodeIndex: layoutNodeIndex,
                    styles: layoutStyles,
                    bounds: layoutBounds,
                    text: layoutNodeIndex.map(() => -1),
                },
                scrollOffsetX: page.scroll?.x ?? 0,
                scrollOffsetY: page.scroll?.y ?? 0,
            },
        ],
    };
}

export interface FixtureSession {
    session: CdpSession;
    sent: Array<{ method: string; params: Record<string, unknown> }>;
    emit(event: string, params: CdpEventParams): void;
    /** Replaces the page the fixture serves, modelling a navigation or a DOM change. */
    setPage(page: FixturePage): void;
    /** Canned answers for methods the pipeline calls but the fixture does not model. */
    stub(method: string, handler: (params: Record<string, unknown>) => unknown): void;
}

/** Builds a fake page-scoped CDP session that answers the four calls the snapshot pipeline makes. */
export function fixtureSession(initialPage: FixturePage): FixtureSession {
    let page = initialPage;
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const listeners = new Map<string, Set<(params: CdpEventParams) => void>>();
    const stubs = new Map<string, (params: Record<string, unknown>) => unknown>();

    const session: CdpSession = {
        async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
            sent.push({ method, params });
            const stub = stubs.get(method);
            if (stub) return stub(params) as T;

            const flat = flatten(page.root);
            switch (method) {
                case 'Page.getFrameTree':
                    return {
                        frameTree: {
                            frame: {
                                id: page.frameId ?? 'main-frame',
                                loaderId: page.loaderId ?? 'loader-1',
                                url: page.url ?? 'https://example.com/',
                            },
                        },
                    } as T;
                case 'Accessibility.getFullAXTree':
                    return buildAxTree(flat) as T;
                case 'DOMSnapshot.captureSnapshot':
                    return buildDomSnapshot(flat, page) as T;
                case 'Page.getLayoutMetrics':
                    return {
                        cssLayoutViewport: {
                            clientWidth: page.viewport?.width ?? 1280,
                            clientHeight: page.viewport?.height ?? 720,
                            pageX: page.scroll?.x ?? 0,
                            pageY: page.scroll?.y ?? 0,
                        },
                        cssContentSize: { width: 1280, height: 4000 },
                    } as T;
                case 'Runtime.evaluate':
                    return { result: { value: false } } as T;
                default:
                    return {} as T;
            }
        },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        },
        async close() {},
    };

    return {
        session,
        sent,
        emit(event, params) {
            for (const listener of listeners.get(event) ?? []) listener(params);
        },
        setPage(next) {
            page = next;
        },
        stub(method, handler) {
            stubs.set(method, handler);
        },
    };
}
