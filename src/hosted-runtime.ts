// ABOUTME: Shared hosted dependency runtime that reuses Steel clients within one credential while
// ABOUTME: isolating tenants and routing every session release through the client that created it.
import type { RequestStateCodec } from '@modelcontextprotocol/server';
import type { SteelConfig } from './core/config.js';
import { CdpSessionPool, type ServerDeps, type SessionPool } from './core/context.js';
import { createHandoffCodec, type HandoffState } from './core/mrtr.js';
import {
    type HandleRegistry,
    InMemoryHandleRegistry,
    principalFromCredential,
    type RegistryDeps,
} from './core/registry.js';
import { SteelRestClient } from './core/steel/rest.js';
import type {
    AccountDetails,
    AgentTrace,
    ArtifactRequest,
    ArtifactResponse,
    CreateSessionRequest,
    ScrapeRequest,
    ScrapeResponse,
    SessionLogEntry,
    SteelApi,
    SteelSession,
} from './core/steel/types.js';
import type { RequestDepsInput } from './http.js';

export interface HostedRuntimeOptions {
    /** Builds the complete Steel endpoint/profile configuration for this caller. */
    configForCredential(credential: string): SteelConfig;
    createApi?: ((config: SteelConfig) => SteelApi) | undefined;
    createPool?: ((config: SteelConfig, settleMultiplier: number) => SessionPool) | undefined;
    /** Swap this for a shared backend when replicas must exchange handle records. */
    createRegistry?: ((deps: RegistryDeps) => HandleRegistry) | undefined;
    onReapError?: ((error: unknown) => void) | undefined;
    now?: (() => Date) | undefined;
}

interface TenantClients {
    credential: string;
    config: SteelConfig;
    api: SteelApi;
    pool: SessionPool;
    settleMultiplier: number;
    /**
     * Built once per tenant so both rounds of one human-in-the-loop flow share a key.
     *
     * With no `STEEL_REQUEST_STATE_SECRET` configured this holds a per-process key, which only
     * works while one replica serves the whole flow; a multi-replica deployment must configure one.
     */
    handoffState: RequestStateCodec<HandoffState>;
}

/**
 * Adds ownership tracking around a tenant's REST client.
 *
 * The Steel session id is client-minted, so ownership is known as soon as create succeeds and
 * before the tool layer stores its public handle.
 */
class OwnedSteelApi implements SteelApi {
    constructor(
        private readonly delegate: SteelApi,
        private readonly onCreate: (steelSessionId: string) => void,
        private readonly onRelease: (steelSessionId: string) => void
    ) {}

    scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponse> {
        return this.delegate.scrape(request, signal);
    }

    screenshot(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        return this.delegate.screenshot(request, signal);
    }

    pdf(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResponse> {
        return this.delegate.pdf(request, signal);
    }

    async createSession(request: CreateSessionRequest, signal?: AbortSignal): Promise<SteelSession> {
        const session = await this.delegate.createSession(request, signal);
        this.onCreate(request.sessionId);
        return session;
    }

    async releaseSession(sessionId: string, signal?: AbortSignal): Promise<void> {
        await this.delegate.releaseSession(sessionId, signal);
        this.onRelease(sessionId);
    }

    getSession(sessionId: string, signal?: AbortSignal): Promise<SteelSession> {
        return this.delegate.getSession(sessionId, signal);
    }

    getDetails(signal?: AbortSignal): Promise<AccountDetails> {
        return this.delegate.getDetails(signal);
    }

    getAgentTraces(sessionId: string, signal?: AbortSignal): Promise<AgentTrace[]> {
        return this.delegate.getAgentTraces(sessionId, signal);
    }

    getSessionLogs(sessionId: string, signal?: AbortSignal): Promise<SessionLogEntry[]> {
        return this.delegate.getSessionLogs(sessionId, signal);
    }
}

/**
 * Module-scope runtime for hosted HTTP serving.
 *
 * Handles are shared across request factories, while REST clients and CDP pools are keyed by the
 * one-way principal. Raw credentials stay only in their tenant client bundle, never in handles.
 */
export class HostedRuntime {
    readonly registry: HandleRegistry;
    private readonly tenants = new Map<string, TenantClients>();
    private readonly sessionOwners = new Map<string, string>();
    private readonly createApi: (config: SteelConfig) => SteelApi;
    private readonly createPool: (config: SteelConfig, settleMultiplier: number) => SessionPool;
    private readonly now: () => Date;

    constructor(private readonly options: HostedRuntimeOptions) {
        this.createApi = options.createApi ?? (config => new SteelRestClient(config));
        this.createPool = options.createPool ?? ((config, multiplier) => new CdpSessionPool(config, multiplier));
        this.now = options.now ?? (() => new Date());
        const registryDeps: RegistryDeps = {
            releaseSteelSession: steelSessionId => this.releaseOwnedSession(steelSessionId),
            onReapError: options.onReapError,
        };
        this.registry = (options.createRegistry ?? (deps => new InMemoryHandleRegistry(deps)))(registryDeps);
    }

    private tenantFor(input: RequestDepsInput): TenantClients {
        const derivedPrincipal = principalFromCredential(input.credential);
        if (input.principal !== derivedPrincipal) {
            throw new Error('Refusing hosted dependencies whose principal does not match their credential.');
        }

        const existing = this.tenants.get(input.principal);
        if (existing) {
            if (existing.credential !== input.credential) {
                throw new Error('A principal collision mapped two different credentials to one tenant.');
            }
            return existing;
        }

        const config = this.options.configForCredential(input.credential);
        if (config.apiKey !== input.credential) {
            throw new Error('configForCredential must preserve the request credential as config.apiKey.');
        }
        const settleMultiplier = config.deployment === 'cloud' ? 2 : 1;
        const delegate = this.createApi(config);
        const pool = this.createPool(config, settleMultiplier);
        const api = new OwnedSteelApi(
            delegate,
            steelSessionId => this.sessionOwners.set(steelSessionId, input.principal),
            steelSessionId => this.sessionOwners.delete(steelSessionId)
        );
        const tenant: TenantClients = {
            credential: input.credential,
            config,
            api,
            pool,
            settleMultiplier,
            handoffState: createHandoffCodec(config.requestStateSecret),
        };
        this.tenants.set(input.principal, tenant);
        return tenant;
    }

    depsForRequest = (input: RequestDepsInput): ServerDeps => {
        const tenant = this.tenantFor(input);
        return {
            config: tenant.config,
            api: tenant.api,
            pool: tenant.pool,
            registry: this.registry,
            handoffState: tenant.handoffState,
            principal: input.principal,
            settleMultiplier: tenant.settleMultiplier,
            now: this.now,
        };
    };

    private async releaseOwnedSession(steelSessionId: string): Promise<void> {
        const principal = this.sessionOwners.get(steelSessionId);
        const tenant = principal ? this.tenants.get(principal) : undefined;
        if (!tenant) {
            throw new Error(
                `Cannot release Steel session ${steelSessionId}: this runtime has no record of its owning principal.`
            );
        }

        await tenant.pool.close(steelSessionId);
        await tenant.api.releaseSession(steelSessionId);
        this.sessionOwners.delete(steelSessionId);
    }

    async close(): Promise<void> {
        await this.registry.reap({ idleMs: 0 });
        await Promise.all([...this.tenants.values()].map(tenant => tenant.pool.closeAll()));
        this.tenants.clear();
        this.sessionOwners.clear();
    }
}
