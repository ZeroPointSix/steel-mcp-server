// ABOUTME: Assembles an McpServer for one profile: registers the tool table in a fixed order and
// ABOUTME: sets the cache hints the 2026-07-28 revision requires on cacheable results.
import { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './context.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { toolsForProfile } from './profiles.js';
import { SERVER_VERSION } from './version.js';

/** One hour. The tool list is org-independent and stable, so it is worth caching publicly. */
const TOOL_LIST_TTL_MS = 3_600_000;

/**
 * Builds a server instance.
 *
 * Called once per connection on stdio and once per request behind the HTTP entry, so it must stay
 * cheap: everything expensive lives in `deps`, created once at module scope and closed over here.
 */
export function createSteelMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer(
        { name: 'steel', title: 'Steel Browser', version: SERVER_VERSION },
        {
            capabilities: { tools: {} },
            instructions: SERVER_INSTRUCTIONS,
            cacheHints: {
                // The tool list depends on the profile, not on who is asking.
                'tools/list': { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' },
                'server/discover': { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' },
                // Anything derived from an authenticated principal must never reach a shared cache.
                'resources/read': { ttlMs: 0, cacheScope: 'private' },
                'resources/list': { ttlMs: 0, cacheScope: 'private' },
            },
        }
    );

    for (const tool of toolsForProfile(deps.config.profile)) {
        tool.register(server, deps);
    }

    return server;
}
