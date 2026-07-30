// ABOUTME: steel_batch runs a sequence of browser steps in one call, stopping at the first failure
// ABOUTME: and taking at most one snapshot at the end — this is where the round-trip saving lives.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../context.js';
import { SteelToolError } from '../errors.js';
import { ACTIONS } from '../page.js';
import { snapshotSection } from './browse.js';
import { maxTokensSchema, sessionIdSchema, successResult, withPage } from './shared.js';

const STEP_TOOLS = ['steel_navigate', 'steel_act', 'steel_wait_for'] as const;

const stepSchema = z.object({
    tool: z.enum(STEP_TOOLS).describe('Which browser tool to run for this step.'),
    arguments: z
        .object({
            url: z.string().optional(),
            action: z.enum(ACTIONS).optional(),
            target: z.string().optional(),
            value: z.string().optional(),
            fields: z.array(z.object({ target: z.string(), value: z.string() })).optional(),
            text: z.string().optional(),
            selector: z.string().optional(),
            timeout_ms: z.number().int().positive().optional(),
        })
        .describe('Arguments for that tool, minus session_id, which the batch already knows.'),
});

export function registerBatch(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        'steel_batch',
        {
            title: 'Run several browser steps at once',
            description:
                'Run a short sequence of navigate, act and wait_for steps against one session in a single call, ' +
                'with at most one page read at the end. Use it for anything you already know the shape of — ' +
                'filling a form, stepping through a checkout, following a known path. It stops at the first step ' +
                'that fails and tells you which one, so nothing runs against an unexpected page.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            inputSchema: z.object({
                session_id: sessionIdSchema,
                steps: z.array(stepSchema).min(1).max(20).describe('Steps to run in order.'),
                include_snapshot: z
                    .boolean()
                    .optional()
                    .describe('Return the page structure once, after the last step.'),
                max_tokens: maxTokensSchema,
            }),
        },
        async (args, ctx) =>
            withPage(deps, 'steel_batch', ctx.mcpReq, args.session_id, async page => {
                const lines: string[] = [];
                let lastChange = 'No step reported a change.';

                for (const [index, step] of args.steps.entries()) {
                    const label = `Step ${index + 1} (${step.tool})`;
                    try {
                        if (step.tool === 'steel_navigate') {
                            if (!step.arguments.url) {
                                throw new SteelToolError('A steel_navigate step needs a url.', {
                                    code: 'invalid_argument',
                                });
                            }
                            const outcome = await page.navigate(step.arguments.url);
                            lines.push(`${label}: opened ${outcome.finalUrl}. ${outcome.changeDescription}`);
                            lastChange = outcome.changeDescription;
                        } else if (step.tool === 'steel_act') {
                            if (!step.arguments.action) {
                                throw new SteelToolError('A steel_act step needs an action.', {
                                    code: 'invalid_argument',
                                });
                            }
                            const outcome = await page.act({
                                action: step.arguments.action,
                                target: step.arguments.target,
                                value: step.arguments.value,
                                fields: step.arguments.fields,
                            });
                            lines.push(`${label}: ${outcome.summary} ${outcome.changeDescription}`);
                            lastChange = outcome.changeDescription;
                        } else {
                            const outcome = await page.waitFor({
                                text: step.arguments.text,
                                selector: step.arguments.selector,
                                url: step.arguments.url,
                                timeoutMs: step.arguments.timeout_ms,
                            });
                            lines.push(`${label}: waited ${outcome.waitedMs}ms for ${outcome.condition}.`);
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const failure = new SteelToolError(
                            `${label} failed, so the remaining ${args.steps.length - index - 1} step(s) were not run. ` +
                                `${message}\n\nCompleted before the failure:\n${lines.join('\n') || '(nothing)'}`,
                            {
                                code: error instanceof SteelToolError ? error.code : 'steel_error',
                                details: { failed_step: index + 1, completed_steps: index },
                            }
                        );
                        throw failure;
                    }
                }

                const sections = args.include_snapshot
                    ? await snapshotSection(page, deps, { maxTokens: args.max_tokens })
                    : undefined;

                return successResult(
                    {
                        result: `Ran ${args.steps.length} steps.\n${lines.join('\n')}`,
                        pageState: sections?.pageState,
                        change: lastChange,
                        snapshot: sections?.snapshot,
                        pagination: sections?.pagination,
                    },
                    { steps_completed: args.steps.length }
                );
            })
    );
}
