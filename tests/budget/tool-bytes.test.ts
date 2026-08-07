// ABOUTME: Fails the build when the tools/list payload grows past the per-profile byte budget, and
// ABOUTME: when the server instructions exceed the 2KB many hosts truncate at.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ProfileName } from '../../src/core/config.js';
import { SERVER_INSTRUCTIONS } from '../../src/core/instructions.js';
import { createSteelMcpServer } from '../../src/core/server.js';
import { testDeps } from '../helpers/fakes.js';

interface BudgetFile {
    instructionsBytes: number;
    profiles: Record<string, { tools: number; bytes: number }>;
}

const budgets = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../tool-budgets.json', import.meta.url)), 'utf8')
) as BudgetFile;

async function measure(profile: ProfileName): Promise<{ tools: number; bytes: number }> {
    const server = createSteelMcpServer(testDeps({ env: { STEEL_PROFILE: profile } }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'budget', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const { tools } = await client.listTools();
        return { tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
    } finally {
        await client.close();
        await server.close();
    }
}

describe('tools/list byte budget', () => {
    for (const [profile, budget] of Object.entries(budgets.profiles)) {
        it(`the ${profile} profile stays within ${budget.bytes} bytes and ${budget.tools} tools`, async () => {
            const measured = await measure(profile as ProfileName);
            // Print the number so a CI log shows the measurement, not only the pass or fail.
            process.stdout.write(
                `  ${profile}: ${measured.tools} tools, ${measured.bytes} bytes (budget ${budget.bytes})\n`
            );
            expect(measured.tools).toBe(budget.tools);
            expect(measured.bytes).toBeLessThanOrEqual(budget.bytes);
        });
    }
});

describe('server instructions budget', () => {
    it(`stays within ${budgets.instructionsBytes} bytes`, () => {
        const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8');
        process.stdout.write(`  instructions: ${bytes} bytes (budget ${budgets.instructionsBytes})\n`);
        expect(bytes).toBeLessThanOrEqual(budgets.instructionsBytes);
        // 2048 is where hosts truncate; the budget must never be raised past it.
        expect(budgets.instructionsBytes).toBeLessThanOrEqual(2048);
    });
});
