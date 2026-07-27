// ABOUTME: A localhost HTTP wrapper around the built core, used only to point the MCP conformance
// ABOUTME: suite at a URL. This is a test harness, not the hosted entrypoint, which is P2 work.
import { createServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../dist/core/config.js';
import { CdpSessionPool } from '../dist/core/context.js';
import { InMemoryHandleRegistry, principalFromCredential } from '../dist/core/registry.js';
import { createSteelMcpServer } from '../dist/core/server.js';
import { SteelRestClient } from '../dist/core/steel/rest.js';

const port = Number.parseInt(process.env.PORT ?? '3399', 10);

const config = loadConfig({ STEEL_API_KEY: 'ste-conformance-harness', ...process.env });
const api = new SteelRestClient(config);
const pool = new CdpSessionPool(config);
const registry = new InMemoryHandleRegistry({
    releaseSteelSession: async steelSessionId => {
        await pool.close(steelSessionId);
        await api.releaseSession(steelSessionId);
    },
});

const deps = {
    config,
    api,
    pool,
    registry,
    principal: principalFromCredential(config.apiKey ?? 'conformance'),
    settleMultiplier: 1,
    now: () => new Date(),
};

// The conformance suite speaks the 2025 protocol eras, so the SDK's legacy shim stays on.
const handler = createMcpHandler(() => createSteelMcpServer(deps), { legacy: 'stateless' });
const nodeHandler = toNodeHandler(handler);

// createMcpHandler validates neither Host nor Origin, so DNS-rebinding protection is mounted in
// front of it here. The hosted entrypoint will need the same guard.
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
}).listen(port, '127.0.0.1', () => {
    process.stderr.write(`conformance harness listening on http://127.0.0.1:${port}/mcp\n`);
});
