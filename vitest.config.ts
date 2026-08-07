// ABOUTME: Vitest workspace configuration defining the unit, integration, budget and e2e test projects.
// ABOUTME: Each project maps to one testing layer so CI can run them separately and report per-layer counts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['tests/unit/**/*.test.ts'],
                    environment: 'node',
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['tests/integration/**/*.test.ts'],
                    environment: 'node',
                    testTimeout: 30_000,
                },
            },
            {
                test: {
                    name: 'budget',
                    include: ['tests/budget/**/*.test.ts'],
                    environment: 'node',
                },
            },
            {
                test: {
                    name: 'browser',
                    include: ['tests/browser/**/*.test.ts'],
                    environment: 'node',
                    testTimeout: 60_000,
                    hookTimeout: 60_000,
                    // These drive one real headless Chrome per file, and two of them wait out the
                    // app's own 15s timeouts, so they never share a browser with another file.
                    fileParallelism: false,
                    sequence: { concurrent: false },
                },
            },
            {
                test: {
                    name: 'smoke',
                    include: ['tests/smoke/**/*.test.ts'],
                    environment: 'node',
                    testTimeout: 120_000,
                    hookTimeout: 60_000,
                    // These calls bill real money and a create competes for a concurrency slot, so
                    // they run one at a time.
                    fileParallelism: false,
                    sequence: { concurrent: false },
                },
            },
            {
                test: {
                    name: 'e2e',
                    include: ['tests/e2e/**/*.test.ts'],
                    environment: 'node',
                    testTimeout: 120_000,
                    hookTimeout: 180_000,
                    // Self-hosted steel-browser runs exactly one browser session at a time, so
                    // two E2E files in parallel fight over it and fail for the wrong reason.
                    fileParallelism: false,
                    sequence: { concurrent: false },
                },
            },
        ],
    },
});
