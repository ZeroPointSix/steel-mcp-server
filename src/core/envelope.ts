// ABOUTME: The fixed sectioned response envelope every tool returns, plus the change signal that
// ABOUTME: replaces a bare "success" so silent input loss is reported instead of hidden.
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/server';
import type { SettleResult } from './settle.js';

/** Sections of a tool response. Order is fixed by the renderer, not by the caller. */
export interface EnvelopeSections {
    result?: string | undefined;
    pageState?: string | undefined;
    change?: string | undefined;
    snapshot?: string | undefined;
    links?: string | undefined;
    notes?: string[] | undefined;
    pagination?: string | undefined;
}

const SECTION_ORDER: Array<[keyof EnvelopeSections, string]> = [
    ['result', 'Result'],
    ['pageState', 'Page state'],
    ['change', 'Change'],
    ['snapshot', 'Snapshot'],
    ['links', 'Links'],
    ['notes', 'Notes'],
    ['pagination', 'Pagination'],
];

/** Renders sections into a skimmable, per-section-truncatable, testable block of markdown. */
export function renderEnvelope(sections: EnvelopeSections): string {
    const blocks: string[] = [];
    for (const [key, heading] of SECTION_ORDER) {
        const value = sections[key];
        if (value === undefined) continue;
        const body = Array.isArray(value) ? value.map(note => `- ${note}`).join('\n') : value;
        if (body.trim().length === 0) continue;
        blocks.push(`### ${heading}\n${body}`);
    }
    return blocks.join('\n\n');
}

/** What the page did in response to an action, beyond what `settle` alone can see. */
export interface ChangeSignal extends SettleResult {
    focusChanged?: boolean | undefined;
}

/**
 * Describes what actually changed.
 *
 * An action that reports plain success while nothing happened is the worst available failure
 * mode: the model concludes the application is broken rather than that it aimed at the wrong
 * element. So "nothing changed" is stated out loud, with the likely causes.
 */
export function describeChange(signal: ChangeSignal): string {
    const parts: string[] = [];
    if (signal.navigated) {
        parts.push(`Navigated to ${signal.navigatedToUrl ?? 'a new page'}.`);
    }
    if (signal.domMutated) {
        parts.push('The DOM changed.');
    }
    if (signal.focusChanged) {
        parts.push('Focus moved to the target.');
    }
    if (parts.length === 0) {
        parts.push(
            'Nothing changed: no navigation, no DOM mutation and no focus change. The click may have hit the ' +
                'wrong element, or the target may not react to this action. Take a fresh snapshot before retrying.'
        );
    }
    if (signal.timedOut) {
        parts.push('The page was still busy when the wait budget expired, so later changes may not be reflected.');
    }
    return parts.join(' ');
}

/** Builds a successful tool result from envelope sections plus optional extra content blocks. */
export function successResult(
    sections: EnvelopeSections,
    structuredContent?: Record<string, unknown>,
    extraContent: ContentBlock[] = []
): CallToolResult {
    const result: CallToolResult = {
        content: [{ type: 'text', text: renderEnvelope(sections) }, ...extraContent],
    };
    if (structuredContent) result.structuredContent = structuredContent;
    return result;
}
