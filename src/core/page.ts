// ABOUTME: The page controller: navigation, targeting, pointer and keyboard input, overlay
// ABOUTME: dismissal and explicit waits, each returning what actually changed on the page.
import { type ChangeSignal, describeChange } from './envelope.js';
import { clickBlockedError, SteelToolError } from './errors.js';
import { type SettleBudgets, type SettleResult, settle } from './settle.js';
import {
    type CaptureOptions,
    type FindQuery,
    findInSnapshot,
    type PageSnapshot,
    PageState,
    type SnapshotNode,
} from './snapshot.js';
import type { CdpSession } from './steel/cdp.js';
import { isSensitiveField } from './untrusted.js';

/** The interaction verbs, mirroring the shape of Steel's own computer-action union. */
export type ActionName =
    | 'click'
    | 'type'
    | 'fill_form'
    | 'select'
    | 'check'
    | 'hover'
    | 'scroll'
    | 'press'
    | 'go_back'
    | 'dismiss_overlays';

export interface FormField {
    target: string;
    value: string;
}

export interface ActRequest {
    action: ActionName;
    /** A `@eN` ref or a CSS selector. Agents guess selectors constantly; both are accepted. */
    target?: string | undefined;
    value?: string | undefined;
    fields?: FormField[] | undefined;
}

export interface ActOutcome {
    summary: string;
    change: ChangeSignal;
    changeDescription: string;
}

export interface NavigateOutcome {
    finalUrl: string;
    title: string;
    change: ChangeSignal;
    changeDescription: string;
}

export interface WaitRequest {
    text?: string | undefined;
    selector?: string | undefined;
    url?: string | undefined;
    timeoutMs?: number | undefined;
}

export interface WaitOutcome {
    satisfied: true;
    waitedMs: number;
    condition: string;
}

export interface AttachOptions {
    budgets: SettleBudgets;
}

/** Named keys the `press` action accepts, with the virtual key codes Chrome expects. */
const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
};

/** Accessible names that identify a consent or cookie overlay's dismiss control. */
const OVERLAY_DISMISS_NAMES =
    /^(accept|agree|allow|got it|ok|okay|dismiss|close|continue|i understand|no thanks|reject)\b|cookies?$/i;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_INTERVAL_MS = 250;

interface TargetHandle {
    backendNodeId: number;
    /** Present when the target came from a ref; used for the redaction and identity checks. */
    node?: SnapshotNode | undefined;
    describe: string;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Renders a CDP node description as the compact `tag#id.class` form used in error messages. */
function describeCdpNode(node: { nodeName?: string; attributes?: string[] } | undefined): string {
    if (!node) return 'another element';
    const attributes: Record<string, string> = {};
    const list = node.attributes ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) attributes[String(list[i])] = String(list[i + 1]);
    const tag = (node.nodeName ?? 'element').toLowerCase();
    const id = attributes.id ? `#${attributes.id}` : '';
    const firstClass = attributes.class?.trim().split(/\s+/)[0];
    return `${tag}${id}${id ? '' : firstClass ? `.${firstClass}` : ''}`;
}

/** Drives one attached page over CDP. Every method reports what changed, never a bare success. */
export class BrowserPage {
    private constructor(
        private readonly session: CdpSession,
        private readonly state: PageState,
        private readonly budgets: SettleBudgets
    ) {}

    /** Enables the CDP domains the pipeline needs and nothing else. */
    static async attach(session: CdpSession, options: AttachOptions): Promise<BrowserPage> {
        await Promise.all([
            session.send('Page.enable'),
            session.send('DOM.enable'),
            session.send('Accessibility.enable'),
        ]);
        return new BrowserPage(session, new PageState(), options.budgets);
    }

    /** The page state, exposed so a tool can resolve refs and read the last snapshot. */
    get pageState(): PageState {
        return this.state;
    }

    private async settleNow(focusChanged = false): Promise<{ change: ChangeSignal; description: string }> {
        const result: SettleResult = await settle(this.session, { budgets: this.budgets });
        const change: ChangeSignal = { ...result, focusChanged };
        return { change, description: describeChange(change) };
    }

    private async currentFrame(): Promise<{ url: string; loaderId: string }> {
        const tree = await this.session.send<{ frameTree?: { frame?: { url?: string; loaderId?: string } } }>(
            'Page.getFrameTree'
        );
        return { url: tree.frameTree?.frame?.url ?? '', loaderId: tree.frameTree?.frame?.loaderId ?? '' };
    }

    async navigate(url: string): Promise<NavigateOutcome> {
        await this.session.send('Page.navigate', { url });
        const { change, description } = await this.settleNow();
        const frame = await this.currentFrame();
        return {
            finalUrl: change.navigatedToUrl ?? frame.url ?? url,
            title: await this.readTitle(),
            change,
            changeDescription: description,
        };
    }

    private async readTitle(): Promise<string> {
        try {
            const result = await this.session.send<{ result?: { value?: string } }>('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            });
            return result.result?.value ?? '';
        } catch {
            return '';
        }
    }

    /**
     * Captures the viewport as a JPEG.
     *
     * JPEG rather than PNG, and quality well below default, because the bytes travel through a
     * model's context window: an exact-pixel PNG costs several times more for no decision value.
     */
    async captureScreenshot(options: { fullPage: boolean }): Promise<{ data: string }> {
        const result = await this.session.send<{ data: string }>('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 60,
            captureBeyondViewport: options.fullPage,
        });
        return { data: result.data };
    }

    async snapshot(options: CaptureOptions): Promise<PageSnapshot> {
        return this.state.capture(this.session, options);
    }

    async find(query: FindQuery, options: CaptureOptions = {}): Promise<SnapshotNode[]> {
        const snapshot = this.state.lastSnapshot ?? (await this.snapshot(options));
        return findInSnapshot(snapshot.nodes, query);
    }

    /** Resolves a `@eN` ref or a CSS selector to a backend node id. */
    private async resolveTarget(target: string): Promise<TargetHandle> {
        if (target.startsWith('@e')) {
            const resolved = this.state.resolveRef(target);
            const node = this.state.lastSnapshot?.nodes.find(candidate => candidate.ref === target);
            return { backendNodeId: resolved.backendNodeId, node, describe: `${target} (${resolved.role})` };
        }

        const { root } = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
        const { nodeId } = await this.session.send<{ nodeId: number }>('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: target,
        });
        if (!nodeId) {
            throw new SteelToolError(
                `No element matches the selector "${target}". Call steel_find to locate the element and use its @eN ref instead.`,
                { code: 'ref_not_found', details: { target } }
            );
        }
        const described = await this.session.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
            nodeId,
        });
        const backendNodeId = described.node?.backendNodeId;
        if (backendNodeId === undefined) {
            throw new SteelToolError(`The selector "${target}" matched a node that cannot be targeted.`, {
                code: 'ref_not_found',
            });
        }
        return { backendNodeId, describe: `"${target}"` };
    }

    private requireTarget(request: ActRequest): string {
        if (!request.target) {
            throw new SteelToolError(
                `The "${request.action}" action needs a target: a @eN ref from steel_snapshot or steel_find, or a CSS selector.`,
                { code: 'invalid_argument' }
            );
        }
        return request.target;
    }

    /** Returns the centre of the target after scrolling it into view. */
    private async centreOf(backendNodeId: number): Promise<{ x: number; y: number }> {
        await this.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const box = await this.session.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId });
        const quad = box.model?.content;
        if (!quad || quad.length < 8) {
            throw new SteelToolError(
                'The target has no layout box, so it cannot be clicked. It may be hidden or collapsed; take a fresh snapshot.',
                { code: 'click_blocked' }
            );
        }
        const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
        const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
        return {
            x: (Math.min(...xs) + Math.max(...xs)) / 2,
            y: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
    }

    /**
     * Confirms the pointer would actually reach the target, and names the blocker if not.
     *
     * A click that lands on a cookie banner and reports success is the single most common
     * browsing dead-end; naming the covering element turns it into a self-correctable one.
     */
    private async assertReachable(handle: TargetHandle, point: { x: number; y: number }): Promise<void> {
        const hit = await this.session.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
            x: Math.round(point.x),
            y: Math.round(point.y),
            includeUserAgentShadowDOM: false,
        });
        const hitId = hit.backendNodeId;
        if (hitId === undefined || hitId === handle.backendNodeId) return;

        const [target, topmost] = await Promise.all([
            this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
                backendNodeId: handle.backendNodeId,
            }),
            this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: hitId }),
        ]);

        if (target.object?.objectId && topmost.object?.objectId) {
            const contains = await this.session.send<{ result?: { value?: boolean } }>('Runtime.callFunctionOn', {
                objectId: target.object.objectId,
                functionDeclaration: 'function(other) { return this === other || this.contains(other); }',
                arguments: [{ objectId: topmost.object.objectId }],
                returnByValue: true,
            });
            if (contains.result?.value === true) return;
        }

        const described = await this.session.send<{ node?: { nodeName?: string; attributes?: string[] } }>(
            'DOM.describeNode',
            { backendNodeId: hitId }
        );
        throw clickBlockedError(handle.describe, describeCdpNode(described.node));
    }

    private async clickAt(point: { x: number; y: number }): Promise<void> {
        const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 };
        await this.session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
        await this.session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    }

    private async pressKey(name: string): Promise<void> {
        const key = NAMED_KEYS[name];
        if (!key) {
            throw new SteelToolError(
                `"${name}" is not a key this tool can press. Supported keys: ${Object.keys(NAMED_KEYS).join(', ')}.`,
                { code: 'invalid_argument', details: { key: name } }
            );
        }
        const base = {
            key: name,
            code: key.code,
            windowsVirtualKeyCode: key.keyCode,
            nativeVirtualKeyCode: key.keyCode,
        };
        await this.session.send('Input.dispatchKeyEvent', {
            ...base,
            type: key.text ? 'keyDown' : 'rawKeyDown',
            ...(key.text ? { text: key.text } : {}),
        });
        await this.session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }

    private async typeInto(target: string, value: string): Promise<TargetHandle> {
        const handle = await this.resolveTarget(target);
        await this.session.send('DOM.focus', { backendNodeId: handle.backendNodeId });
        await this.session.send('Input.insertText', { text: value });
        return handle;
    }

    /** Describes what was typed without ever repeating a secret back to the caller. */
    private describeTyped(handle: TargetHandle, value: string): string {
        const sensitive =
            handle.node !== undefined &&
            isSensitiveField({ tagName: 'input', type: 'password', name: handle.node.name });
        const shown =
            sensitive || /password|secret|otp|token/i.test(handle.node?.name ?? '')
                ? `${value.length} characters`
                : `"${value}"`;
        return `Typed ${shown} into ${handle.describe}.`;
    }

    async act(request: ActRequest): Promise<ActOutcome> {
        switch (request.action) {
            case 'click':
            case 'check': {
                const handle = await this.resolveTarget(this.requireTarget(request));
                const point = await this.centreOf(handle.backendNodeId);
                await this.assertReachable(handle, point);
                await this.clickAt(point);
                const { change, description } = await this.settleNow();
                return { summary: `Clicked ${handle.describe}.`, change, changeDescription: description };
            }
            case 'hover': {
                const handle = await this.resolveTarget(this.requireTarget(request));
                const point = await this.centreOf(handle.backendNodeId);
                await this.session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                });
                const { change, description } = await this.settleNow();
                return { summary: `Hovered ${handle.describe}.`, change, changeDescription: description };
            }
            case 'type': {
                if (request.value === undefined) {
                    throw new SteelToolError('The "type" action needs a value.', { code: 'invalid_argument' });
                }
                const handle = await this.typeInto(this.requireTarget(request), request.value);
                const { change, description } = await this.settleNow(true);
                return { summary: this.describeTyped(handle, request.value), change, changeDescription: description };
            }
            case 'fill_form': {
                if (!request.fields?.length) {
                    throw new SteelToolError('The "fill_form" action needs a non-empty fields array.', {
                        code: 'invalid_argument',
                    });
                }
                const summaries: string[] = [];
                for (const field of request.fields) {
                    const handle = await this.typeInto(field.target, field.value);
                    summaries.push(this.describeTyped(handle, field.value));
                }
                const { change, description } = await this.settleNow(true);
                return { summary: summaries.join(' '), change, changeDescription: description };
            }
            case 'select': {
                if (request.value === undefined) {
                    throw new SteelToolError('The "select" action needs the option value to choose.', {
                        code: 'invalid_argument',
                    });
                }
                const handle = await this.resolveTarget(this.requireTarget(request));
                const resolved = await this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
                    backendNodeId: handle.backendNodeId,
                });
                await this.session.send('Runtime.callFunctionOn', {
                    objectId: resolved.object?.objectId,
                    functionDeclaration:
                        'function(value) { this.value = value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }',
                    arguments: [{ value: request.value }],
                });
                const { change, description } = await this.settleNow();
                return {
                    summary: `Selected "${request.value}" in ${handle.describe}.`,
                    change,
                    changeDescription: description,
                };
            }
            case 'scroll': {
                const amount = Number.parseInt(request.value ?? '600', 10);
                await this.session.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: 10,
                    y: 10,
                    deltaX: 0,
                    deltaY: Number.isFinite(amount) ? amount : 600,
                });
                const { change, description } = await this.settleNow();
                return { summary: `Scrolled by ${amount}px.`, change, changeDescription: description };
            }
            case 'press': {
                if (!request.value) {
                    throw new SteelToolError('The "press" action needs a key name in value.', {
                        code: 'invalid_argument',
                    });
                }
                await this.pressKey(request.value);
                const { change, description } = await this.settleNow();
                return { summary: `Pressed ${request.value}.`, change, changeDescription: description };
            }
            case 'go_back': {
                const history = await this.session.send<{
                    currentIndex: number;
                    entries: Array<{ id: number }>;
                }>('Page.getNavigationHistory');
                const previous = history.entries?.[history.currentIndex - 1];
                if (!previous) {
                    throw new SteelToolError('There is no previous page in this session history.', {
                        code: 'invalid_argument',
                    });
                }
                await this.session.send('Page.navigateToHistoryEntry', { entryId: previous.id });
                const { change, description } = await this.settleNow();
                return { summary: 'Went back one page.', change, changeDescription: description };
            }
            case 'dismiss_overlays':
                return this.dismissOverlays();
        }
    }

    /** Presses Escape and clicks a recognised consent control, if one is on the page. */
    private async dismissOverlays(): Promise<ActOutcome> {
        await this.pressKey('Escape');
        const snapshot = await this.snapshot({});
        const candidate = snapshot.nodes.find(
            node => node.ref !== undefined && node.inViewport && OVERLAY_DISMISS_NAMES.test(node.name)
        );

        if (!candidate?.ref) {
            const { change, description } = await this.settleNow();
            return {
                summary: 'Pressed Escape. Found no recognised cookie or consent overlay control to click.',
                change,
                changeDescription: description,
            };
        }

        const handle = await this.resolveTarget(candidate.ref);
        const point = await this.centreOf(handle.backendNodeId);
        await this.clickAt(point);
        const { change, description } = await this.settleNow();
        return {
            summary: `Pressed Escape and clicked "${candidate.name}".`,
            change,
            changeDescription: description,
        };
    }

    /** Polls until an explicit condition holds. There is deliberately no network-idle wait. */
    async waitFor(request: WaitRequest): Promise<WaitOutcome> {
        const condition =
            request.text !== undefined
                ? `the text "${request.text}" to appear`
                : request.selector !== undefined
                  ? `an element matching "${request.selector}" to appear`
                  : request.url !== undefined
                    ? `the URL to contain "${request.url}"`
                    : undefined;

        if (condition === undefined) {
            throw new SteelToolError(
                'steel_wait_for needs one of text, selector or url. There is no network-idle wait: name what you are waiting for.',
                { code: 'invalid_argument' }
            );
        }

        const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            if (await this.conditionHolds(request)) {
                return { satisfied: true, waitedMs: Date.now() - startedAt, condition };
            }
            await delay(WAIT_POLL_INTERVAL_MS);
        }

        throw new SteelToolError(
            `Waited ${timeoutMs}ms for ${condition} and it did not happen. Take a snapshot to see the current page, ` +
                'or raise timeout_ms if the page is genuinely slow.',
            { code: 'timeout', details: { condition, timeoutMs } }
        );
    }

    private async conditionHolds(request: WaitRequest): Promise<boolean> {
        if (request.url !== undefined) {
            const frame = await this.currentFrame();
            return frame.url.includes(request.url);
        }
        if (request.selector !== undefined) {
            const { root } = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
            const { nodeId } = await this.session.send<{ nodeId: number }>('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: request.selector,
            });
            return Boolean(nodeId);
        }
        const snapshot = await this.snapshot({});
        const needle = (request.text ?? '').toLowerCase();
        return snapshot.nodes.some(node => node.name.toLowerCase().includes(needle));
    }
}
