// ABOUTME: The three stateless read tools — scrape, screenshot and pdf — which start no browser
// ABOUTME: session, so they carry no billing surprise and no way to leak one.
import type { ContentBlock, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../context.js';
import { botDetectionError, detectBotBlock, SteelToolError } from '../errors.js';
import type { ScrapeFormat } from '../steel/types.js';
import { cursorSchema, fencedSection, guard, maxTokensSchema, successResult } from './shared.js';

const FORMATS = ['markdown', 'html', 'cleaned_html', 'readability'] as const;

function renderContent(content: Partial<Record<ScrapeFormat, unknown>>, formats: ScrapeFormat[]): string {
    return formats
        .map(format => {
            const value = content[format];
            if (value === undefined) return '';
            const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            return formats.length === 1 ? body : `--- ${format} ---\n${body}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

export function registerScrape(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
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

                const { text, pagination } = fencedSection(
                    body,
                    { finalUrl, fetchedAt: deps.now().toISOString() },
                    { maxTokens: args.max_tokens, cursor: args.cursor }
                );

                const links = response.links
                    .slice(0, 100)
                    .map(link => `- ${link.text ? `${link.text}: ` : ''}${link.url}`)
                    .join('\n');

                return successResult(
                    {
                        result: `Read ${finalUrl} (HTTP ${response.metadata.statusCode ?? 'unknown'}).`,
                        snapshot: text,
                        links: links || 'No links on this page.',
                        pagination,
                        notes: block
                            ? [`This page carries ${block.vendor} anti-bot markers; content may be partial.`]
                            : undefined,
                    },
                    { final_url: finalUrl, metadata: response.metadata, links: response.links }
                );
            })
    );
}

export function registerScreenshot(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
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
        async (args, ctx) =>
            guard(async () => {
                if (args.session_id) {
                    const record = await deps.registry.resolve(args.session_id, deps.principal);
                    const page = await deps.pool.page(record.steelSessionId, ctx.mcpReq.signal);
                    const shot = await page.captureScreenshot({ fullPage: args.full_page ?? false });
                    return successResult(
                        { result: 'Captured the current page of this session as a JPEG.' },
                        { session_id: args.session_id },
                        [{ type: 'image', data: shot.data, mimeType: 'image/jpeg' }]
                    );
                }

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
            })
    );
}

export function registerPdf(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
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
