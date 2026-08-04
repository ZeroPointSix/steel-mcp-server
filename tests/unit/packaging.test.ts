// ABOUTME: Guards the packaging facts that are easy to drift and expensive to get wrong on a
// ABOUTME: release day: the wire version, the registry name, and exact SDK pins.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_TABLE } from '../../src/core/profiles.js';
import { SERVER_VERSION } from '../../src/core/version.js';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
    name: string;
    version: string;
    mcpName?: string;
    bin: Record<string, string>;
    repository: { url: string };
    bugs: string;
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

    it('announces the version it actually ships, so the README cannot advertise a stale release', () => {
        const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
        const announced = /\*\*Status:\*\* `([^`]+)`/.exec(readme)?.[1];
        expect(announced, 'the README no longer carries a Status line naming a version').toBeDefined();
        expect(announced).toBe(manifest.version);
    });

    it('ships the stdio binary under the name the install snippets use', () => {
        expect(manifest.bin['steel-mcp']).toBe('dist/stdio.js');
    });

    it('exports the hosted HTTP boundary and its shared runtime', () => {
        expect(manifest.exports['./http']).toBe('./dist/http.js');
        expect(manifest.exports['./hosted-runtime']).toBe('./dist/hosted-runtime.js');
    });

    it('ships a runnable hosted entrypoint, not only the boundary it is built from', () => {
        expect(manifest.exports['./hosted']).toBe('./dist/hosted.js');
        expect(manifest.scripts['start:hosted']).toBe('node dist/hosted.js');
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

    it('copies every file the build script compiles from', () => {
        const project = /tsc -p (\S+)/.exec(manifest.scripts.build ?? '')?.[1] ?? '';
        expect(project, 'the build script no longer names a tsconfig').not.toBe('');
        expect(read('Dockerfile'), `the build compiles ${project}, which the image never copies`).toContain(project);
    });

    it('does not copy a lockfile the repository does not track', () => {
        // package-lock.json is gitignored, so COPYing it fails on every clean checkout — including
        // the ones Smithery and the release build run from.
        expect(read('Dockerfile')).not.toContain('package-lock.json');
    });

    it('documents every tool the browse profile registers', () => {
        // A reviewer reads the README's table and calls what it lists. An undocumented tool, or a
        // documented one that no longer exists, is the drift this catches.
        const readme = read('README.md');
        for (const tool of TOOL_TABLE) {
            expect(readme, `the README never mentions ${tool.name}`).toContain(tool.name);
        }
    });

    it('points its repository and issue links at the remote that actually serves them', () => {
        expect(manifest.repository.url).toContain('steel-dev/steel-mcp-server');
        expect(manifest.bugs).toContain('steel-dev/steel-mcp-server');
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

describe('the desktop bundle dependency surface', () => {
    /**
     * The bare package specifiers reachable from an entrypoint, split by how they are imported.
     *
     * An MCPB bundle ships its own `node_modules` and Claude Desktop installs nothing, so what the
     * stdio entrypoint can reach is exactly what the bundle has to carry. Walking the graph rather
     * than reading `dependencies` is the point: a package listed but unreachable is weight the
     * bundle can drop, and one reachable but unlisted is a crash on a user's machine.
     *
     * The split matters. A static import must resolve for the process to start at all, so it has to
     * be in the bundle. A dynamic one sits behind a runtime decision — the exporter stack loads
     * inside a try/catch that warns and carries on — so the bundle may leave it out.
     */
    function reachablePackages(entry: string): { required: Set<string>; optional: Set<string> } {
        const srcRoot = new URL('../../src/', import.meta.url);
        const required = new Set<string>();
        const optional = new Set<string>();
        const seen = new Set<string>();
        const queue = [entry];

        /** `./x.js` in the emitted ESM is `./x.ts` on disk. */
        const resolve = (specifier: string, from: string) =>
            new URL(specifier, new URL(from, srcRoot)).href.slice(srcRoot.href.length).replace(/\.js$/, '.ts');

        while (queue.length > 0) {
            const relative = queue.pop() as string;
            if (seen.has(relative)) continue;
            seen.add(relative);

            const source = readFileSync(fileURLToPath(new URL(relative, srcRoot)), 'utf8');
            const found: Array<[string, Set<string>]> = [
                // `import x from 'y'`, `import 'y'`, and `export … from 'y'`, but never `import('y')`.
                ...[...source.matchAll(/(?:from|^\s*import)\s+'([^']+)'/gm)].map(
                    m => [m[1] as string, required] as [string, Set<string>]
                ),
                ...[...source.matchAll(/import\s*\(\s*'([^']+)'/g)].map(
                    m => [m[1] as string, optional] as [string, Set<string>]
                ),
            ];

            for (const [specifier, bucket] of found) {
                if (specifier.startsWith('.')) queue.push(resolve(specifier, relative));
                else if (!specifier.startsWith('node:')) bucket.add(specifier);
            }
        }
        return { required, optional };
    }

    /** A specifier like `@modelcontextprotocol/server/stdio` is carried by one installed package. */
    function installedNames(specifiers: Iterable<string>): Set<string> {
        return new Set(
            [...specifiers].map(specifier => {
                const parts = specifier.split('/');
                return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
            })
        );
    }

    const reachable = reachablePackages('stdio.ts');
    const required = installedNames(reachable.required);

    it('never reaches ioredis, which only the hosted entrypoint needs', () => {
        // 1.1M the bundle would carry for a code path Claude Desktop can never take. If this fails,
        // a core module started importing the Redis adapter and the pack script must stop pruning it.
        expect([...required, ...installedNames(reachable.optional)]).not.toContain('ioredis');
    });

    it('needs no OpenTelemetry package beyond the no-op API to start', () => {
        // startTracing dynamic-imports the SDK inside a try/catch and warns rather than throwing, so
        // a bundle without it serves normally. A static import would turn that into a startup crash.
        expect([...required].filter(name => name.startsWith('@opentelemetry/'))).toEqual(['@opentelemetry/api']);
    });

    it('loads the exporter stack only dynamically, so a pruned bundle can omit it', () => {
        expect([...installedNames(reachable.optional)].sort()).toEqual([
            '@opentelemetry/exporter-trace-otlp-http',
            '@opentelemetry/sdk-node',
        ]);
    });

    it('reaches only packages the bundle is built to carry', () => {
        expect([...required].sort()).toEqual(['@modelcontextprotocol/server', '@opentelemetry/api', 'ws', 'zod']);
    });

    it('declares every package the entrypoint reaches, so the pruned install resolves', () => {
        for (const name of required) {
            expect(manifest.dependencies[name], `${name} is imported but not a dependency`).toBeDefined();
        }
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
