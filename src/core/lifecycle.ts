// ABOUTME: Shared browser lifecycle defaults keep Steel inactivity, handoff, and local cleanup aligned.
// ABOUTME: Hard expiry remains immutable and always wins over these best-effort idle windows.

export const REAPER_INTERVAL_MS = 30_000;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000;
export const DEFAULT_SESSION_TIMEOUT_MS = 900_000;
export const HANDOFF_GRACE_MS = 600_000;

/** Gives Steel's remote-input clock one sweep of slack before local MCP cleanup. */
export function resolveRegistryIdleMs(inactivityTimeoutMs: number): number {
    if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
        throw new Error('inactivityTimeoutMs must be a positive finite number.');
    }
    return inactivityTimeoutMs + REAPER_INTERVAL_MS;
}
