// ABOUTME: Reads Steel credentials and deployment settings from the environment and derives the
// ABOUTME: CDP connect URL, which must always carry a sessionId or Steel starts an untracked session.

/** The named tool presets a connection can select. */
export const PROFILE_NAMES = ['scrape', 'browse', 'vision', 'full'] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

export type Deployment = 'cloud' | 'self_hosted';

/** Everything the server needs to reach a Steel deployment. */
export interface SteelConfig {
    /** Absent only on a self-hosted deployment, which has no API-key auth. */
    apiKey: string | undefined;
    /** REST base URL with no trailing slash and no `/v1` suffix. */
    baseUrl: string;
    /** WebSocket origin for CDP connections. */
    connectUrl: string;
    deployment: Deployment;
    profile: ProfileName;
    /**
     * Hard cap on simultaneous browser sessions. Self-hosted steel-browser runs exactly one;
     * the cloud value is refined from `GET /v1/details` at runtime.
     */
    maxConcurrentSessions: number;
    /** Idle release, in ms, set on every session so a browser frees itself if this process dies. */
    inactivityTimeoutMs: number;
    /** Hard session cap, in ms, clamped at runtime to the plan maximum from `GET /v1/details`. */
    sessionTimeoutMs: number;
}

const CLOUD_BASE_URL = 'https://api.steel.dev';
const CLOUD_CONNECT_URL = 'wss://connect.steel.dev';
const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/** Removes a trailing `/v1` and any trailing slashes, reconciling the SDK and CLI conventions. */
export function normalizeBaseUrl(raw: string): string {
    return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function parseIntEnv(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, got "${value}"`);
    }
    return parsed;
}

function toWebSocketUrl(httpUrl: string): string {
    return httpUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

/** Builds the configuration from a process environment, failing loudly on an unusable combination. */
export function loadConfig(env: Record<string, string | undefined>): SteelConfig {
    const baseUrl = normalizeBaseUrl(env.STEEL_BASE_URL ?? CLOUD_BASE_URL);
    const deployment: Deployment = new URL(baseUrl).hostname.endsWith('steel.dev') ? 'cloud' : 'self_hosted';
    const apiKey = env.STEEL_API_KEY?.trim() || undefined;

    if (deployment === 'cloud' && !apiKey) {
        throw new Error(
            'STEEL_API_KEY is required to reach Steel Cloud. Set it, or point STEEL_BASE_URL at a self-hosted steel-browser.'
        );
    }

    const profileName = env.STEEL_PROFILE ?? 'browse';
    if (!(PROFILE_NAMES as readonly string[]).includes(profileName)) {
        throw new Error(`Unknown STEEL_PROFILE "${profileName}". Expected one of: ${PROFILE_NAMES.join(', ')}.`);
    }

    return {
        apiKey,
        baseUrl,
        connectUrl: env.STEEL_CONNECT_URL ?? (deployment === 'cloud' ? CLOUD_CONNECT_URL : toWebSocketUrl(baseUrl)),
        deployment,
        profile: profileName as ProfileName,
        maxConcurrentSessions: deployment === 'self_hosted' ? 1 : parseIntEnv(env.STEEL_MAX_SESSIONS, 10),
        inactivityTimeoutMs: parseIntEnv(env.STEEL_INACTIVITY_TIMEOUT_MS, DEFAULT_INACTIVITY_TIMEOUT_MS),
        sessionTimeoutMs: parseIntEnv(env.STEEL_SESSION_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS),
    };
}

/** The subset of configuration a CDP URL is built from. */
export type CdpEndpoint = Pick<SteelConfig, 'deployment' | 'connectUrl'> & { apiKey?: string | undefined };

/**
 * Builds the CDP WebSocket URL for a session.
 *
 * `sessionId` is mandatory: connecting to Steel without one makes it create a fresh billed
 * session that nothing in this process knows about, so an empty id is a programming error.
 */
export function buildCdpUrl(endpoint: CdpEndpoint, sessionId: string): string {
    if (!sessionId) {
        throw new Error(
            'Refusing to open a CDP connection without a sessionId: Steel would start an untracked billed session.'
        );
    }
    const url = new URL(endpoint.connectUrl);
    if (endpoint.apiKey) url.searchParams.set('apiKey', endpoint.apiKey);
    url.searchParams.set('sessionId', sessionId);
    return url.toString();
}
