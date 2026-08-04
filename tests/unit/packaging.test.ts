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
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe('package metadata', () => {
    it('reports the same version over the wire as on disk', () => {
        expect(SERVER_VERSION).toBe(manifest.version);
    });

    it('carries mcpName, which npm ownership verification in the registry requires', () => {
        expect(manifest.mcpName).toBe('dev.steel/mcp-server');
    });

    it('has one place to change the version, wired to npm version', () => {
        // Four files state the version. The tests below assert they agree; this asserts there is a
        // mechanism that makes them agree, so a release is one edit rather than four and a diff.
        expect(manifest.scripts['sync:version']).toBe('node scripts/sync-version.mjs');
        expect(manifest.scripts.version, 'npm version would not update the other three files').toContain(
            'sync-version.mjs'
        );
        expect(manifest.scripts.version, 'the updated files would be left out of the version commit').toContain(
            'git add'
        );
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

    it.each(['README.md', 'smithery.yaml', 'Dockerfile', 'docker-compose.yaml'])(
        '%s does not launch the entrypoint the build stopped emitting',
        name => {
            expect(read(name), `${name} still launches dist/index.js`).not.toContain('dist/index.js');
        }
    );

    it('the Dockerfile entrypoint is the file the build produces', () => {
        expect(read('Dockerfile')).toContain('dist/stdio.js');
    });

    it('the compose deployment serves the hosted endpoint on the port it advertises', () => {
        // The image's own CMD is the stdio server, which reads stdin and binds nothing. A compose host
        // that cannot override the image command — Coolify's Dockerfile build pack is one — would start
        // that instead, and the symptom is a container that never turns healthy rather than an error.
        const compose = read('docker-compose.yaml');
        expect(compose, 'the compose service does not name the hosted entrypoint').toMatch(/command: dist\/hosted\.js/);
        // The port is stated twice on purpose: once for the server to bind, once for the proxy to
        // target. Disagreement routes traffic to a port nothing is listening on.
        expect(compose).toMatch(/PORT: ['"]8080['"]/);
        expect(compose, 'the exposed port is not the one the server binds').toMatch(/expose:\n\s+- ['"]8080['"]/);
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

describe('what a default install pays for', () => {
    /** The packages every consumer of this package gets, whether or not they run the hosted server. */
    const HOSTED_ONLY = [
        '@modelcontextprotocol/node',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/sdk-node',
        'ioredis',
    ];

    it('declares only what the stdio entrypoint imports as a real dependency', () => {
        // Measured 2026-08-04: with the hosted packages in `dependencies` and `optionalDependencies`,
        // `npm install --omit=dev` pulled 68M across 85 packages — for a server whose own MCPB bundle
        // is 8M across 5. npm installs optionalDependencies by default, so that 35M exporter stack
        // reached every `npx steel-mcp` user.
        expect(Object.keys(manifest.dependencies).sort()).toEqual([
            '@modelcontextprotocol/server',
            '@opentelemetry/api',
            'ws',
            'zod',
        ]);
    });

    it('has no optionalDependencies at all, because npm installs those by default', () => {
        expect(manifest.optionalDependencies).toBeUndefined();
    });

    it.each(HOSTED_ONLY)('offers %s as a peer a consumer may skip', name => {
        expect(manifest.peerDependencies?.[name], `${name} is not declared as a peer`).toBeDefined();
        expect(
            manifest.peerDependenciesMeta?.[name]?.optional,
            `${name} would be auto-installed unless it is marked optional`
        ).toBe(true);
    });

    it.each(HOSTED_ONLY)('keeps %s installed for this repository, which builds and tests it', name => {
        // An optional peer is not installed by npm, so without this the hosted sources would not
        // typecheck and the Redis registry suite would have nothing to run against.
        expect(manifest.devDependencies[name], `${name} is unavailable to the build`).toBeDefined();
    });

    it('installs the optional peers in the image that serves the hosted entrypoint', () => {
        // `npm prune --omit=dev` drops an optional peer, so the image has to ask for it by name or
        // `node dist/hosted.js` fails to resolve ioredis at startup.
        const dockerfile = readFileSync(fileURLToPath(new URL('../../Dockerfile', import.meta.url)), 'utf8');
        expect(dockerfile).toContain('peerDependencies');
    });

    it('selects the hosted entrypoint through CMD, so overriding it works', () => {
        // With the script inside ENTRYPOINT, run arguments append rather than replace, so the
        // documented `docker run <image> node dist/hosted.js` ran `node dist/stdio.js node
        // dist/hosted.js` — the stdio server, for an operator who asked for the hosted one, with
        // nothing to indicate they had not got it.
        const dockerfile = readFileSync(fileURLToPath(new URL('../../Dockerfile', import.meta.url)), 'utf8');
        expect(dockerfile).toContain('ENTRYPOINT ["node"]');
        expect(dockerfile).toContain('CMD ["dist/stdio.js"]');
    });

    it('runs both entrypoints in CI rather than only building the image', () => {
        // The E2E stack runs upstream images, not this Dockerfile, so nothing else executes it. Three
        // faults reached a green build: reinstalled devDependencies, an unresolvable ioredis, and an
        // override that selected the wrong server. A build on its own catches none of them.
        const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
        expect(ci).toContain('docker build');
        expect(ci, 'nothing exercises the stdio entrypoint').toContain('tools/list');
        expect(ci, 'nothing exercises the hosted entrypoint').toContain('dist/hosted.js');
        expect(ci, 'the hosted server is never asked whether it is serving').toContain('/healthz');
    });
});

describe('dependency pins', () => {
    it('pins @modelcontextprotocol/server exactly, because the latest dist-tag points at a beta', () => {
        expect(manifest.dependencies['@modelcontextprotocol/server']).toMatch(/^\d+\.\d+\.\d+(-\w+\.\d+)?$/);
    });

    it('pins the hosted SDK peer exactly too, and to the same line as the server', () => {
        const peer = manifest.peerDependencies?.['@modelcontextprotocol/node'];
        expect(peer).toMatch(/^\d+\.\d+\.\d+(-\w+\.\d+)?$/);
        expect(peer, 'the two SDK packages would resolve to different lines').toBe(
            manifest.dependencies['@modelcontextprotocol/server']
        );
    });

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

    it('leaves the exporter stack out of every install a consumer does not ask for', () => {
        // startTracing loads it through a dynamic import in a try/catch that names both packages in
        // its warning, so absent is a supported state rather than a broken one — and it is 35M.
        for (const name of ['@opentelemetry/sdk-node', '@opentelemetry/exporter-trace-otlp-http']) {
            expect(manifest.dependencies[name]).toBeUndefined();
            expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
        }
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

describe('the release workflow', () => {
    const root = new URL('../../', import.meta.url);
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), 'utf8');
    const release = read('.github/workflows/release.yml');

    it('runs on a version tag rather than on a branch', () => {
        expect(release).toContain("tags: ['v*']");
    });

    it('refuses a tag that disagrees with the version being released', () => {
        // The one mistake a release cannot walk back: a published tag naming a version nobody shipped.
        expect(release).toContain('GITHUB_REF_NAME#v');
        expect(release).toContain('exit 1');
    });

    it('runs every gate CI runs, so a tag cannot take a shortcut', () => {
        // The drift this catches: a check added to ci.yml and forgotten in release.yml, which would
        // make the released artifact the only one nobody checked.
        const ci = read('.github/workflows/ci.yml');
        const gates = [...ci.matchAll(/run: (npm run [\w:]+|\.\/scripts\/[\w-]+\.sh)/g)].map(match => match[1]);
        expect(gates.length, 'no gates were found in ci.yml, so this test proves nothing').toBeGreaterThan(5);
        for (const gate of gates) {
            expect(release, `release.yml never runs ${gate}`).toContain(gate);
        }
    });

    it('attaches the bundle to the release', () => {
        // Without this the only way to get the .mcpb is to clone the repository and build it, which
        // is not something a Claude Desktop user will do.
        expect(release).toContain('gh release create');
        expect(release).toMatch(/build\/steel-mcp-\*\.mcpb/);
    });

    it('leaves npm and container publishing switched off until someone turns them on', () => {
        expect(release).toContain("vars.PUBLISH_NPM == 'true'");
        expect(release).toContain("vars.PUBLISH_DOCKER == 'true'");
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
