// ABOUTME: Rewrites the staged package.json to declare only what the stdio entrypoint imports, so npm
// ABOUTME: never installs the hosted-only trees rather than the pack script deleting them afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';

/**
 * The packages `dist/stdio.js` statically imports.
 *
 * Kept in step with `tests/unit/packaging.test.ts`, which walks the import graph and asserts this is
 * exactly the reachable set — and which also asserts `dependencies` already holds only these, since
 * the hosted-only packages are optional peers. So this is a second line of defence rather than the
 * only one: if a hosted package ever lands back in `dependencies`, the bundle still does not ship it.
 */
const RUNTIME_DEPENDENCIES = ['@modelcontextprotocol/server', '@opentelemetry/api', 'ws', 'zod'];

const stage = argv[2];
if (!stage) {
    stderr.write('usage: stage-mcpb-package.mjs <staging-directory>\n');
    exit(2);
}

const path = `${stage}/package.json`;
const pkg = JSON.parse(readFileSync(path, 'utf8'));

const missing = RUNTIME_DEPENDENCIES.filter(name => !pkg.dependencies?.[name]);
if (missing.length > 0) {
    stderr.write(`package.json no longer declares: ${missing.join(', ')}\n`);
    exit(1);
}

pkg.dependencies = Object.fromEntries(RUNTIME_DEPENDENCIES.map(name => [name, pkg.dependencies[name]]));

// Nothing in the bundle can run these: the scripts reference src/ and scripts/, which the staging
// tree deliberately omits, and `prepare` would try to rebuild from sources that are not there. The
// peers are the hosted server's, and nothing in the bundle can reach the hosted entrypoint.
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.optionalDependencies;
delete pkg.peerDependencies;
delete pkg.peerDependenciesMeta;

writeFileSync(path, `${JSON.stringify(pkg, null, 4)}\n`);
stderr.write(`    staged package.json declares ${RUNTIME_DEPENDENCIES.length} runtime dependencies\n`);
