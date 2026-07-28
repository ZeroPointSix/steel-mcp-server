// ABOUTME: Detects whether the docker-composed E2E stack is reachable, so the suite skips with a
// ABOUTME: stated reason instead of failing opaquely when Docker is unavailable.

/** Where the test process reaches the self-hosted steel-browser. */
export const STEEL_BASE_URL = process.env.E2E_STEEL_BASE_URL ?? 'http://localhost:3100';

/**
 * Where the *browser* reaches the fixture site.
 *
 * Inside compose that is the service name; when the site runs on the host it is localhost. The
 * test process reads the site over `FIXTURE_PROBE_URL`, which is always host-reachable.
 */
export const FIXTURE_BASE_URL = process.env.E2E_FIXTURE_URL ?? 'http://fixture-site:8099';

/** Host-side URL used only to check the fixture site is up. */
export const FIXTURE_PROBE_URL = process.env.E2E_FIXTURE_PROBE_URL ?? 'http://localhost:8099';

export const E2E_ENV: Record<string, string | undefined> = {
    STEEL_BASE_URL,
    STEEL_API_KEY: undefined,
    STEEL_PROFILE: 'browse',
};

async function reachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

/** True when both the browser and the fixture site answer. */
export async function stackIsUp(): Promise<boolean> {
    const [browser, fixture] = await Promise.all([
        reachable(`${STEEL_BASE_URL}/v1/health`),
        reachable(`${FIXTURE_PROBE_URL}/`),
    ]);
    return browser && fixture;
}

const START_COMMAND = 'docker compose -f tests/e2e/docker-compose.yml up -d';

/** A human-readable reason, used in the suite name so a skip is visible in the report. */
export function describeStack(up: boolean): string {
    return up ? 'live steel-browser' : `SKIPPED: start it with ${START_COMMAND}`;
}

/**
 * Writes the skip reason to stderr.
 *
 * Vitest does not print the names of skipped suites at default verbosity, so without this an
 * unavailable stack looks exactly like a suite nobody wrote.
 */
export function announceStack(up: boolean, suite: string): void {
    if (up) return;
    process.stderr.write(
        `\n  SKIPPED ${suite}: the E2E stack is not reachable at ${STEEL_BASE_URL} and ${FIXTURE_PROBE_URL}.\n` +
            `  Start it with: ${START_COMMAND}\n\n`
    );
}
