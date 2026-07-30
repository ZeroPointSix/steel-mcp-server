// ABOUTME: The three stateless read tools — scrape, screenshot and pdf — which start no browser
// ABOUTME: session, so they carry no billing surprise and no way to leak one.
import type { ContentBlock } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps, ToolHost } from '../context.js';
import { botDetectionError, detectBotBlock, SteelToolError } from '../errors.js';
import type { ScrapeFormat } from '../steel/types.js';
import { fenceUntrusted, type Provenance, stripHtmlComments, stripInvisible } from '../untrusted.js';
import { cursorSchema, fencedSection, guard, maxTokensSchema, successResult, withPage } from './shared.js';

const FORMATS = ['markdown', 'html', 'cleaned_html', 'readability'] as const;

/** Formats that carry raw markup, where an HTML comment can hide instructions a person never sees. */
const MARKUP_FORMATS = new Set<ScrapeFormat>(['html', 'cleaned_html']);

function renderContent(content: Partial<Record<ScrapeFormat, unknown>>, formats: ScrapeFormat[]): string {
    return formats
        .map(format => {
            const value = content[format];
            if (value === undefined) return '';
            const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            const body = MARKUP_FORMATS.has(format) ? stripHtmlComments(raw) : raw;
            return formats.length === 1 ? body : `--- ${format} ---\n${body}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Renders the links and metadata a scrape always returns.
 *
 * Both are page-derived — anchor text and an OG title are written by whoever wrote the page — so
 * they go inside the fence with the content. Emitting them outside it would make the server
 * instructions claim a protection the server does not apply.
 */
function renderLinksAndMetadata(
    links: Array<{ url: string; text?: string }>,
    metadata: Record<string, unknown>,
    provenance: Provenance
): string {
    const linkLines = links
        .slice(0, 100)
        .map(link => `- ${link.text ? `${stripInvisible(link.text)}: ` : ''}${stripInvisible(link.url)}`)
        .join('\n');

    const metadataLines = Object.entries(metadata)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
        .map(([key, value]) => `- ${key}: ${stripInvisible(String(value))}`)
        .join('\n');

    const body = [
        linkLines ? `Links (${links.length}):\n${linkLines}` : 'Links: none on this page.',
        metadataLines ? `Metadata:\n${metadataLines}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');

    return fenceUntrusted(body, provenance);
}

/** Removes smuggling characters from the machine-readable copy a host may render directly. */
function sanitizeStructured<T>(value: T): T {
    if (typeof value === 'string') return stripInvisible(value) as T;
    if (Array.isArray(value)) return value.map(item => sanitizeStructured(item)) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStructured(item)])
        ) as T;
    }
    return value;
}

export function registerScrape(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_scrape',
        {
            title: 'Read a web page',
            description:
                'Read a web page as markdown or HTML through a real browser, so JavaScript-rendered pages and ' +
                'sites that block plain HTTP fetches still work. Starts no browser session, so there is nothing ' +
                'to release afterwards. Always returns the page links and metadata alongside the content. ' +
                'Use this first for anything you only need to read; reach for steel_session_create only when you ' +
                'need to click, type or move through several pages.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                url: z.url().describe('The page to read.'),
                format: z
                    .array(z.enum(FORMATS))
                    .optional()
                    .describe('Content formats to return. Defaults to markdown, which is the cheapest to read.'),
                use_proxy: z
                    .boolean()
                    .optional()
                    .describe('Route through a Steel-managed residential proxy. Needs a verified paid balance.'),
                delay_ms: z.number().int().min(0).max(30_000).optional().describe('Wait this long after load.'),
                max_tokens: maxTokensSchema,
                cursor: cursorSchema,
            }),
        },
        async (args, ctx) =>
            guard(async () => {
                const format = (args.format ?? ['markdown']) as ScrapeFormat[];
                const response = await deps.api.scrape(
                    {
                        url: args.url,
                        format,
                        useProxy: args.use_proxy,
                        delay: args.delay_ms,
                    },
                    ctx.mcpReq.signal
                );

                const finalUrl = response.metadata.urlSource ?? args.url;
                const body = renderContent(response.content, format);

                const block = detectBotBlock({
                    status: response.metadata.statusCode ?? 200,
                    body: body.slice(0, 4096),
                    finalUrl,
                });
                if (block && (response.metadata.statusCode ?? 200) >= 400) {
                    throw botDetectionError(block, finalUrl, { useProxy: args.use_proxy });
                }

                const provenance: Provenance = { finalUrl, fetchedAt: deps.now().toISOString() };
                const { text, pagination } = fencedSection(body, provenance, {
                    maxTokens: args.max_tokens,
                    cursor: args.cursor,
                });

                return successResult(
                    {
                        result: `Read ${finalUrl} (HTTP ${response.metadata.statusCode ?? 'unknown'}).`,
                        snapshot: text,
                        links: renderLinksAndMetadata(response.links, response.metadata, provenance),
                        pagination,
                        notes: block
                            ? [`This page carries ${block.vendor} anti-bot markers; content may be partial.`]
                            : undefined,
                    },
                    {
                        final_url: finalUrl,
                        metadata: sanitizeStructured(response.metadata),
                        links: sanitizeStructured(response.links),
                    }
                );
            })
    );
}

export function registerScreenshot(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_screenshot',
        {
            title: 'Screenshot a web page',
            description:
                'Capture a PNG of a page and return a link to it. Screenshots are for showing a person what a ' +
                'page looks like; you cannot act on pixels, so use steel_snapshot when you need to click or type. ' +
                'Pass a url to capture without starting a session, or a session_id to capture the page a browser ' +
                'session is currently on.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                url: z.url().optional().describe('Page to capture. Starts no browser session.'),
                session_id: z
                    .string()
                    .optional()
                    .describe('Capture the current page of this session instead. Returns the image inline.'),
                full_page: z.boolean().optional().describe('Capture the whole scrollable page, not just the viewport.'),
                inline: z
                    .boolean()
                    .optional()
                    .describe('Return the image bytes in the response instead of a link. Costs far more context.'),
            }),
        },
        async (args, ctx) => {
            // The session branch goes through withPage so there is exactly one path that resolves
            // a handle and marks it as used; screenshotting in a loop must not let the reaper
            // reclaim the session out from under the agent doing it.
            if (args.session_id) {
                return withPage(deps, args.session_id, ctx.mcpReq.signal, async page => {
                    const shot = await page.captureScreenshot({ fullPage: args.full_page ?? false });
                    return successResult(
                        { result: 'Captured the current page of this session as a JPEG.' },
                        { session_id: args.session_id },
                        [{ type: 'image', data: shot.data, mimeType: 'image/jpeg' }]
                    );
                });
            }

            return guard(async () => {
                if (!args.url) {
                    throw new SteelToolError('steel_screenshot needs either a url or a session_id.', {
                        code: 'invalid_argument',
                    });
                }

                const artifact = await deps.api.screenshot(
                    { url: args.url, fullPage: args.full_page },
                    ctx.mcpReq.signal
                );
                const content: ContentBlock[] = [
                    {
                        type: 'resource_link',
                        uri: artifact.url,
                        name: 'screenshot.png',
                        mimeType: 'image/png',
                        description: `Screenshot of ${args.url}`,
                    },
                ];
                if (args.inline) {
                    const response = await fetch(artifact.url, { signal: ctx.mcpReq.signal });
                    const bytes = Buffer.from(await response.arrayBuffer());
                    content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
                }
                return successResult(
                    { result: `Captured ${args.url}. The image is linked below${args.inline ? ' and inlined' : ''}.` },
                    { url: artifact.url },
                    content
                );
            });
        }
    );
}

export function registerPdf(host: ToolHost, deps: ServerDeps): void {
    host.registerTool(
        'steel_pdf',
        {
            title: 'Render a web page as PDF',
            description:
                'Render a page to PDF and return a link to the file. Starts no browser session. Use steel_scrape ' +
                'if you want to read the text — a PDF link is for handing a document to a person.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                url: z.url().describe('The page to render.'),
                delay_ms: z.number().int().min(0).max(30_000).optional().describe('Wait this long after load.'),
            }),
        },
        async (args, ctx) =>
            guard(async () => {
                const artifact = await deps.api.pdf({ url: args.url, delay: args.delay_ms }, ctx.mcpReq.signal);
                return successResult({ result: `Rendered ${args.url} to PDF.` }, { url: artifact.url }, [
                    {
                        type: 'resource_link',
                        uri: artifact.url,
                        name: 'page.pdf',
                        mimeType: 'application/pdf',
                        description: `PDF of ${args.url}`,
                    },
                ]);
            })
    );
}
