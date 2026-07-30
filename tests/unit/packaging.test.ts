// ABOUTME: Guards the packaging facts that are easy to drift and expensive to get wrong on a
// ABOUTME: release day: the wire version, the registry name, and exact SDK pins.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../src/core/version.js';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
    name: string;
    version: string;
    mcpName?: string;
    bin: Record<string, string>;
    exports: Record<string, string>;
    scripts: Record<string, string>;
    engines: { node: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
};

describe('package metadata', () => {
    it('reports the same version over the wire as on disk', () => {
        expect(SERVER_VERSION).toBe(manifest.version);
    });

    it('carries mcpName, which npm ownership verification in the registry requires', () => {
        expect(manifest.mcpName).toBe('dev.steel/mcp-server');
    });

    it('ships the stdio binary under the name the install snippets use', () => {
        expect(manifest.bin['steel-mcp']).toBe('dist/stdio.js');
    });

    it('exports the hosted HTTP boundary and its shared runtime', () => {
        expect(manifest.exports['./http']).toBe('./dist/http.js');
        expect(manifest.exports['./hosted-runtime']).toBe('./dist/hosted-runtime.js');
    });

    it('requires Node 20 or newer, which the v2 SDK line needs', () => {
        expect(manifest.engines.node).toBe('>=20');
    });
});

describe('an install from git still yields a usable dist', () => {
    it('builds on prepare, which prepublishOnly does not cover', () => {
        // npm runs prepare for a git dependency and for a local install; prepublishOnly runs only
        // when publishing, so without prepare a git install leaves no dist at all.
        expect(manifest.scripts.prepare).toMatch(/build/);
    });

    it('marks the built entrypoint executable, which the old shx chmod used to do', () => {
        expect(manifest.scripts.build, 'nothing restores the executable bit on dist/stdio.js').toMatch(/chmod/);
    });
});

describe('real-browser test entrypoint', () => {
    const root = new URL('../../', import.meta.url);
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), 'utf8');

    it('runs E2E through the stack-owning script rather than racing Compose readiness', () => {
        expect(manifest.scripts['test:e2e']).toBe('./scripts/run-e2e.sh');
        const runner = read('scripts/run-e2e.sh');
        expect(runner).toContain('up -d --wait');
        expect(runner).toContain('down');
    });

    it('runs the real-browser suite in CI instead of allowing local-only coverage', () => {
        expect(read('.github/workflows/ci.yml')).toContain('npm run test:e2e');
    });
});

describe('the shipped launch paths all point at the real entrypoint', () => {
    const root = new URL('../../', import.meta.url);
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), 'utf8');

    it.each(['README.md', 'smithery.yaml', 'Dockerfile'])(
        '%s does not launch the entrypoint the build stopped emitting',
        name => {
            expect(read(name), `${name} still launches dist/index.js`).not.toContain('dist/index.js');
        }
    );

    it('the Dockerfile entrypoint is the file the build produces', () => {
        expect(read('Dockerfile')).toContain('dist/stdio.js');
    });

    it('smithery launches the built stdio entrypoint', () => {
        expect(read('smithery.yaml')).toContain('dist/stdio.js');
    });

    it('the README no longer configures retired environment variables as if they worked', () => {
        const readme = read('README.md');
        expect(readme).not.toContain('GLOBAL_WAIT_SECONDS');
        expect(readme, 'the README still names the unpublished v1 package').not.toContain('steel-voyager/dist');
    });
});

describe('dependency pins', () => {
    it.each(['@modelcontextprotocol/server', '@modelcontextprotocol/node'])(
        'pins %s exactly, because the latest dist-tag points at a beta',
        name => {
            expect(manifest.dependencies[name]).toMatch(/^\d+\.\d+\.\d+(-\w+\.\d+)?$/);
        }
    );

    it('pins the client and conformance dev dependencies exactly too', () => {
        expect(manifest.devDependencies['@modelcontextprotocol/client']).toMatch(/^\d+\.\d+\.\d+(-\w+\.\d+)?$/);
        expect(manifest.devDependencies['@modelcontextprotocol/conformance']).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    });

    it('uses the conformance line that exercises the final stateless protocol', () => {
        expect(manifest.devDependencies['@modelcontextprotocol/conformance']).toMatch(/^0\.2\.0-alpha\.\d+$/);
    });

    it('requires Zod 4.2 or newer, which the v2 SDK depends on', () => {
        expect(manifest.dependencies.zod).toMatch(/^\^4\.[2-9]/);
    });
});

describe('telemetry packaging', () => {
    /** Every core source file, so an import rule can be checked against all of them at once. */
    function coreSources(): string[] {
        const root = new URL('../../src/core/', import.meta.url);
        return readdirSync(fileURLToPath(root), { recursive: true, encoding: 'utf8' })
            .filter(name => name.endsWith('.ts'))
            .map(name => readFileSync(fileURLToPath(new URL(name, root)), 'utf8'));
    }

    it('exports the tracing wiring so a hosted deployment can start an exporter', () => {
        expect(manifest.exports['./tracing']).toBe('./dist/tracing.js');
    });

    it('depends on the OpenTelemetry API, whose default is a no-op', () => {
        expect(manifest.dependencies['@opentelemetry/api']).toMatch(/^\^1\./);
    });

    it('keeps the exporter stack optional, so an unconfigured install never needs it', () => {
        expect(manifest.optionalDependencies['@opentelemetry/sdk-node']).toBeDefined();
        expect(manifest.optionalDependencies['@opentelemetry/exporter-trace-otlp-http']).toBeDefined();
        expect(manifest.dependencies['@opentelemetry/sdk-node']).toBeUndefined();
    });

    it('never lets the core reach for anything beyond the OpenTelemetry API', () => {
        const forbidden = coreSources().flatMap(source =>
            [...source.matchAll(/from '(@opentelemetry\/[\w-]+)'/g)].map(match => match[1])
        );
        expect([...new Set(forbidden)]).toEqual(['@opentelemetry/api']);
    });
});

describe('protocol conformance gates', () => {
    it('runs both the legacy compatibility scenarios and the modern stateless HTTP scenarios', () => {
        const script = readFileSync(
            fileURLToPath(new URL('../../scripts/run-conformance.sh', import.meta.url)),
            'utf8'
        );
        expect(script).toContain('2025-11-25');
        expect(script).toContain('2026-07-28');
        expect(script).toContain('server-stateless');
        expect(script).toContain('caching');
        expect(script).toContain('http-header-validation');
    });
});
