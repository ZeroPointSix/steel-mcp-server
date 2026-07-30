// ABOUTME: Public entry point of the transport-agnostic core, re-exporting what an entrypoint or an
// ABOUTME: embedder needs to assemble a Steel MCP server.

export type { Deployment, ProfileName, SteelConfig } from './config.js';
export { buildCdpUrl, loadConfig, normalizeBaseUrl, PROFILE_NAMES } from './config.js';
export type { ServerDeps, SessionPool } from './context.js';
export { CdpSessionPool, mintSteelSessionId } from './context.js';
export { SteelToolError } from './errors.js';
export { SERVER_INSTRUCTIONS } from './instructions.js';
export type { HandoffState } from './mrtr.js';
export { createHandoffCodec } from './mrtr.js';
export type { ToolDefinition } from './profiles.js';
export { TOOL_TABLE, toolsForProfile } from './profiles.js';
export type { HandleRegistry, ReleasePath } from './registry.js';
export { InMemoryHandleRegistry, principalFromCredential } from './registry.js';
export { createSteelMcpServer } from './server.js';
export { SteelRestClient } from './steel/rest.js';
export type { SteelApi } from './steel/types.js';
export { SERVER_VERSION } from './version.js';
