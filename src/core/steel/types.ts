// ABOUTME: Request and response shapes for the Steel /v1 REST surface, hand-written because the
// ABOUTME: published steel-sdk types omit inactivityTimeout, agent traces, logs and browser modes.

/** Scrape output formats. Note the parameter is named `format` and takes an array of these. */
export type ScrapeFormat = 'html' | 'readability' | 'cleaned_html' | 'markdown';

export interface ScrapeRequest {
    url: string;
    format: ScrapeFormat[];
    /** Milliseconds to wait after load before capturing. */
    delay?: number | undefined;
    useProxy?: boolean | undefined;
    screenshot?: boolean | undefined;
    pdf?: boolean | undefined;
}

/** A link as Steel returns it. Always present on a scrape response; never a requested format. */
export interface ScrapedLink {
    url: string;
    text?: string;
}

export interface ScrapeMetadata {
    statusCode?: number;
    title?: string;
    description?: string;
    ogImage?: string;
    urlSource?: string;
    published_timestamp?: string;
    [key: string]: unknown;
}

export interface ScrapeResponse {
    /** Keyed by requested format. `readability` yields an object, the rest yield strings. */
    content: Partial<Record<ScrapeFormat, unknown>>;
    links: ScrapedLink[];
    metadata: ScrapeMetadata;
    screenshot?: string;
    pdf?: string;
}

export interface ArtifactRequest {
    url: string;
    fullPage?: boolean | undefined;
    delay?: number | undefined;
    useProxy?: boolean | undefined;
}

/** Both `/v1/screenshot` and `/v1/pdf` answer with a hosted file URL, never with bytes. */
export interface ArtifactResponse {
    url: string;
}

export interface CreateSessionRequest {
    /** Minted by this server before the call, so a crash mid-create still leaves a sweepable id. */
    sessionId: string;
    /** Hard cap in ms. Clamped to the plan maximum by the caller. */
    timeout: number;
    /**
     * Idle release in ms — the layer that survives this process dying. Steel ignores it when it is
     * not strictly below `timeout`, so it is omitted rather than sent as an inert value.
     */
    inactivityTimeout?: number | undefined;
    region?: string | undefined;
    useProxy?: boolean | undefined;
    solveCaptcha?: boolean | undefined;
    profileId?: string | undefined;
    namespace?: string | undefined;
    dimensions?: { width: number; height: number } | undefined;
    blockAds?: boolean | undefined;
    userAgent?: string | undefined;
}

export interface SteelSession {
    id: string;
    status?: string;
    createdAt?: string;
    duration?: number;
    sessionViewerUrl?: string;
    debugUrl?: string;
    websocketUrl?: string;
    [key: string]: unknown;
}

/** `GET /v1/details` — the source of truth for plan limits, never hardcode them. */
export interface AccountDetails {
    /** Longest permitted session, in ms. 15 minutes on Launch, 1 hour on Scale. */
    maxSessionDuration?: number;
    concurrencyLimit?: number;
    plan?: string;
    [key: string]: unknown;
}

/** A URL-bearing context on an activity: `page` for where it happened, `navigation` for a move. */
export interface AgentTraceUrlContext {
    url?: string;
    [key: string]: unknown;
}

/** Element context, present when Steel could identify what an activity acted on. */
export interface AgentTraceTarget {
    role?: string;
    accessibleName?: string;
    text?: string;
    attributes?: Record<string, string>;
    selector?: { css?: string };
}

/**
 * One activity of the timeline from `GET /v1/sessions/{id}/agent-traces`.
 *
 * The index signature carries the extras that depend on the activity type — `pointer` on a click,
 * `keyboard` and `value` on typing — which the docs describe but do not pin. Fields this server
 * renders are declared; nothing is declared that has not been seen on the wire or documented.
 */
export interface AgentTrace {
    /** Activity type, such as `click`, `input`, `navigate`, `scroll`, `drag` or `error`. */
    type?: string;
    timestamp?: string;
    /** Present when the activity spans a range of time rather than an instant. */
    endTimestamp?: string;
    /** Page context, usually including `url`. */
    page?: AgentTraceUrlContext;
    /** Destination context on a navigation activity. */
    navigation?: AgentTraceUrlContext;
    target?: AgentTraceTarget;
    /** Documented on error activities without a pinned shape, so read it through a helper. */
    error?: unknown;
    [key: string]: unknown;
}

/** The envelope `agent-traces` answers with. `events` is chronological. */
export interface AgentTraceTimeline {
    events: AgentTrace[];
    /** Number of activities returned, which is not the number Steel holds — see `hasMore`. */
    total?: number;
    /** True when Steel has more activity for the session than this response carried. */
    hasMore?: boolean;
}

export interface SessionLogEntry {
    timestamp?: string;
    level?: string;
    text?: string;
    message?: string;
    [key: string]: unknown;
}

/**
 * The Steel REST surface this server depends on. Tools depend on this interface, never on a
 * concrete transport, so unit tests inject a fake at exactly this boundary.
 */
export interface SteelApi {
    scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponse>;
    screenshot(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse>;
    pdf(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse>;
    createSession(request: CreateSessionRequest, signal?: AbortSignal): Promise<SteelSession>;
    releaseSession(sessionId: string, signal?: AbortSignal): Promise<void>;
    getSession(sessionId: string, signal?: AbortSignal): Promise<SteelSession>;
    getDetails(signal?: AbortSignal): Promise<AccountDetails>;
    getAgentTraces(sessionId: string, signal?: AbortSignal): Promise<AgentTraceTimeline>;
    getSessionLogs(sessionId: string, signal?: AbortSignal): Promise<SessionLogEntry[]>;
}
