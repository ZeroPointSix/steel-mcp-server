// ABOUTME: Assembles an McpServer for one profile: registers the tool table in a fixed order and
// ABOUTME: sets the cache hints the 2026-07-28 revision requires on cacheable results.
import { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps, ToolHost } from './context.js';
import { toolErrorResult } from './errors.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { toolsForProfile } from './profiles.js';
import type { RateLimiter } from './rate-limit.js';
import { SERVER_VERSION } from './version.js';

/** One hour. The tool list is org-independent and stable, so it is worth caching publicly. */
const TOOL_LIST_TTL_MS = 3_600_000;

/** A registration with the SDK's generics erased. Forwarding arguments needs nothing more. */
type ErasedRegisterTool = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;

/**
 * Wraps the registration surface so every tool charges the request budget before it runs.
 *
 * Metering at registration rather than inside each handler is what makes the guarantee hold for
 * the whole table, including tools added later. A rejection comes back as a tool-execution error,
 * not a protocol error, so the model reads the reason and the retry-after and can act on both.
 *
 * `registerTool` is overloaded and generic and its callback type is conditional on the input
 * schema, so a wrapper that only forwards its arguments cannot be spelled in those types. The two
 * casts erase them and restore them again around a body that inspects nothing but the tool name.
 */
function meteredHost(server: McpServer, limiter: RateLimiter, principal: string): ToolHost {
    const register = server.registerTool.bind(server) as unknown as ErasedRegisterTool;
    const metered: ErasedRegisterTool = (name, config, handler) =>
        register(name, config, async (...args) => {
            try {
                await limiter.charge(principal, name);
            } catch (error) {
                return toolErrorResult(error);
            }
            return handler(...args);
        });
    return { registerTool: metered as unknown as ToolHost['registerTool'] };
}

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

    const host = deps.limiter ? meteredHost(server, deps.limiter, deps.principal) : server;
    for (const tool of toolsForProfile(deps.config.profile)) {
        tool.register(host, deps);
    }

    return server;
}
