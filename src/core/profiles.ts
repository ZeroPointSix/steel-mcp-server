// ABOUTME: Named tool presets and the single ordered tool table, so tools/list is deterministic
// ABOUTME: and a profile selection is a data change rather than a code change.
import type { ProfileName } from './config.js';
import type { ServerDeps, ToolHost } from './context.js';
import { registerBatch } from './tools/batch.js';
import { registerAct, registerFind, registerNavigate, registerSnapshot, registerWaitFor } from './tools/browse.js';
import { registerSessionCreate, registerSessionDiagnostics, registerSessionRelease } from './tools/session.js';
import { registerPdf, registerScrape, registerScreenshot } from './tools/stateless.js';

export interface ToolDefinition {
    name: string;
    /** Profiles this tool belongs to. */
    profiles: ProfileName[];
    register(host: ToolHost, deps: ServerDeps): void;
}

const SCRAPE_AND_UP: ProfileName[] = ['scrape', 'browse', 'vision', 'full'];
const BROWSE_AND_UP: ProfileName[] = ['browse', 'vision', 'full'];

/**
 * The tool table, in the order `tools/list` returns them.
 *
 * The order is fixed here rather than derived from a map, because a stable ordering is what makes
 * a host's prompt cache hit across connections.
 */
export const TOOL_TABLE: ToolDefinition[] = [
    { name: 'steel_scrape', profiles: SCRAPE_AND_UP, register: registerScrape },
    { name: 'steel_screenshot', profiles: SCRAPE_AND_UP, register: registerScreenshot },
    { name: 'steel_pdf', profiles: SCRAPE_AND_UP, register: registerPdf },
    { name: 'steel_session_create', profiles: BROWSE_AND_UP, register: registerSessionCreate },
    { name: 'steel_session_release', profiles: BROWSE_AND_UP, register: registerSessionRelease },
    { name: 'steel_navigate', profiles: BROWSE_AND_UP, register: registerNavigate },
    { name: 'steel_snapshot', profiles: BROWSE_AND_UP, register: registerSnapshot },
    { name: 'steel_find', profiles: BROWSE_AND_UP, register: registerFind },
    { name: 'steel_act', profiles: BROWSE_AND_UP, register: registerAct },
    { name: 'steel_wait_for', profiles: BROWSE_AND_UP, register: registerWaitFor },
    { name: 'steel_session_diagnostics', profiles: BROWSE_AND_UP, register: registerSessionDiagnostics },
    { name: 'steel_batch', profiles: BROWSE_AND_UP, register: registerBatch },
];

/** The tools a profile exposes, in `tools/list` order. */
export function toolsForProfile(profile: ProfileName): ToolDefinition[] {
    return TOOL_TABLE.filter(tool => tool.profiles.includes(profile));
}
