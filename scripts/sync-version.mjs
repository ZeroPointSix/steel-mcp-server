// ABOUTME: Writes package.json's version into the three other files that state it, so a release is one
// ABOUTME: edit rather than four; runs from npm's `version` lifecycle hook and is idempotent.
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const path = name => fileURLToPath(new URL(name, root));
const read = name => readFileSync(path(name), 'utf8');

const version = JSON.parse(read('package.json')).version;
const checkOnly = argv.includes('--check');

/**
 * Every file that states the version, and how to rewrite it.
 *
 * `src/core/version.ts` is a checked-in constant rather than a read of package.json, because the
 * bundle must do no filesystem reads at startup — so it has to be generated rather than derived.
 */
const targets = [
    {
        file: 'src/core/version.ts',
        find: /export const SERVER_VERSION = '[^']*';/,
        write: () => `export const SERVER_VERSION = '${version}';`,
    },
    {
        file: 'manifest.json',
        find: /("version":\s*)"[^"]*"/,
        write: (_, prefix) => `${prefix}"${version}"`,
    },
    {
        file: 'README.md',
        find: /(\*\*Status:\*\* )`[^`]*`/,
        write: (_, prefix) => `${prefix}\`${version}\``,
    },
];

const stale = [];
for (const { file, find, write } of targets) {
    const before = read(file);
    if (!find.test(before)) {
        stdout.write(`${file} no longer contains a version this script knows how to update\n`);
        exit(1);
    }
    const after = before.replace(find, write);
    if (after === before) continue;
    stale.push(file);
    if (!checkOnly) writeFileSync(path(file), after);
}

if (checkOnly && stale.length > 0) {
    stdout.write(`These files disagree with package.json's ${version}: ${stale.join(', ')}\n`);
    stdout.write('Run `npm run sync:version` to bring them into line.\n');
    exit(1);
}

stdout.write(stale.length === 0 ? `Version ${version} is already stated everywhere.\n` : `Set ${version} in ${stale.join(', ')}.\n`);
