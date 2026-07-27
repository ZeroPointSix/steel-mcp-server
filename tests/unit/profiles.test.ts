// ABOUTME: Unit tests for profile selection: which tools each named preset exposes, and that the
// ABOUTME: selection mechanism exists for the presets that do not add tools yet.
import { describe, expect, it } from 'vitest';
import { PROFILE_NAMES } from '../../src/core/config.js';
import { TOOL_TABLE, toolsForProfile } from '../../src/core/profiles.js';

describe('toolsForProfile', () => {
    it('gives scrape only the three stateless tools, which start no billed session', () => {
        expect(toolsForProfile('scrape').map(tool => tool.name)).toEqual([
            'steel_scrape',
            'steel_screenshot',
            'steel_pdf',
        ]);
    });

    it('gives browse the full default surface', () => {
        expect(toolsForProfile('browse')).toHaveLength(12);
    });

    it('resolves every declared profile name, including the ones that add nothing yet', () => {
        for (const profile of PROFILE_NAMES) {
            expect(toolsForProfile(profile).length, `${profile} resolves to no tools`).toBeGreaterThan(0);
        }
    });

    it('keeps vision and full a superset of browse, so opting in never removes a tool', () => {
        const browse = new Set(toolsForProfile('browse').map(tool => tool.name));
        for (const profile of ['vision', 'full'] as const) {
            const names = new Set(toolsForProfile(profile).map(tool => tool.name));
            for (const name of browse) expect(names.has(name), `${profile} dropped ${name}`).toBe(true);
        }
    });

    it('preserves table order, which is what makes a host prompt cache hit', () => {
        const table = TOOL_TABLE.map(tool => tool.name);
        const browse = toolsForProfile('browse').map(tool => tool.name);
        expect(browse).toEqual(table.filter(name => browse.includes(name)));
    });

    it('registers no tool name twice', () => {
        const names = TOOL_TABLE.map(tool => tool.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('keeps every tool name within the 64-character review limit', () => {
        for (const tool of TOOL_TABLE) expect(tool.name.length).toBeLessThanOrEqual(64);
    });
});
