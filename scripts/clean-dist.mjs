// ABOUTME: Removes generated output before TypeScript builds, so deleted source cannot survive in packages.
// ABOUTME: This keeps stale app assets and modules out of MCPB and npm artifacts.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
