/**
 * Posting events to PostHog, and the checks every post is preceded by.
 *
 * Node only.
 */

import * as contract from './contract';
import type { Envelope } from './events';
import type { Endpoint, UsageContext } from './switches';
import { runLegacyMigration } from './switches';
import type { StateDir } from './state';
import { Spool } from './spool';

export type PostOutcome = 'accepted' | 'refused' | 'failed';

export type PrePost = { kind: 'disabled' } | { kind: 'current'; id: string | undefined };

/**
 * Immediately before each post: run the legacy migration, stop when `disabled`
 * exists, and read the current identifier. `ownLocalId` is the identifier this
 * process drew for itself when `id` could not hold one; it stays current for the
 * process's own events while `id` holds nothing valid.
 */
export function beforePost(context: UsageContext, state: StateDir, ownLocalId?: string): PrePost {
    try {
        runLegacyMigration(context, state);
    } catch {
        // A migration that cannot write is retried before the next post.
    }
    if (state.isDisabled()) return { kind: 'disabled' };
    const reading = state.readId();
    return { kind: 'current', id: reading.kind === 'valid' ? reading.id : ownLocalId };
}

/** The events made under `current`; events of a replaced identifier are dropped. */
export function keepCurrent(events: readonly Envelope[], current: string | undefined): Envelope[] {
    if (current === undefined) return [];
    return events.filter(event => event.distinct_id === current);
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/** Post one batch, waiting no longer than `timeoutMs`. */
export async function post(
    endpoint: Endpoint,
    events: readonly Envelope[],
    timeoutMs: number,
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<PostOutcome> {
    if (endpoint.kind === 'invalid' || timeoutMs <= 0) return 'failed';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(`${endpoint.origin}${contract.BATCH_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: contract.PROJECT_TOKEN, batch: events }),
            signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) return 'accepted';
        if ([400, 401, 403, 413].includes(response.status)) return 'refused';
        return 'failed';
    } catch {
        return 'failed';
    } finally {
        clearTimeout(timer);
    }
}

/** Post every file of the extension's spool before `deadline`; what is left stays queued. */
export async function drainSpool(
    context: UsageContext,
    state: StateDir,
    endpoint: Endpoint,
    deadline: number,
    fetchImpl?: FetchLike,
): Promise<void> {
    const spool = new Spool(state.toolSpool());
    spool.tidy();
    const claimed = spool.claimAll();
    for (let index = 0; index < claimed.length; index++) {
        const file = claimed[index];
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            claimed.slice(index).forEach(rest => rest.release());
            return;
        }
        const check = beforePost(context, state);
        if (check.kind === 'disabled') {
            claimed.slice(index).forEach(rest => rest.delete());
            return;
        }
        const events = file.events();
        if (!events) {
            file.delete();
            continue;
        }
        const current = keepCurrent(events, check.id);
        if (current.length === 0) {
            file.delete();
            continue;
        }
        if (current.length !== events.length) {
            try {
                file.rewrite(current);
            } catch {
                file.delete();
                continue;
            }
        }
        const outcome = await post(endpoint, current, remaining, fetchImpl);
        if (outcome === 'failed') file.release();
        else file.delete();
    }
}
