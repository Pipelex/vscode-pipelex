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
import { Spool, isQueuedFor } from './spool';
import type { Claimed } from './spool';

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

/** The most events one post carries: far below the capture endpoint's request size
 * limit, and enough that a full spool goes in a few posts rather than one per file. */
export const MAX_EVENTS_PER_POST = 500;

/** Post one batch, waiting no longer than `timeoutMs`, and giving up at once when
 * `signal` aborts. */
export async function post(
    endpoint: Endpoint,
    events: readonly Envelope[],
    timeoutMs: number,
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
    signal?: AbortSignal,
): Promise<PostOutcome> {
    if (endpoint.kind === 'invalid' || timeoutMs <= 0 || signal?.aborted) return 'failed';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const giveUp = () => controller.abort();
    signal?.addEventListener('abort', giveUp);
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
        signal?.removeEventListener('abort', giveUp);
    }
}

export interface DrainOptions {
    fetch?: FetchLike;
    /** Asked immediately before each post, after the shared checks: `false` stops the
     * drain and leaves the queue as it is. The service answers with VS Code's
     * telemetry setting, so an opt-out taken during a drain holds from its next post. */
    allowed?: () => boolean;
    /** Aborts the post in flight, leaving its files queued: the service's shutdown. */
    signal?: AbortSignal;
}

/** `drained`: every file queued for the endpoint is sent. `failed`: a post failed or
 * time ran out, and what is left waits for a retry. `stopped`: a switch turned
 * statistics off, an invalid endpoint override included. */
export type DrainOutcome = 'drained' | 'failed' | 'stopped';

/**
 * Post the files of the extension's spool queued for `endpoint` before `deadline`, as
 * few files to a post as `MAX_EVENTS_PER_POST` allows, each file once. A file queued
 * for another endpoint is left for a sender posting there, so events queued under a
 * test's loopback override never reach PostHog, and events queued for PostHog never
 * reach a loopback endpoint. The checks every post is preceded by run before each
 * post, `options.allowed` included; a failed post leaves its files and every file not
 * yet tried queued, since the endpoint is unreachable or failing.
 */
export async function drainSpool(
    context: UsageContext,
    state: StateDir,
    endpoint: Endpoint,
    deadline: number,
    options: DrainOptions = {},
): Promise<DrainOutcome> {
    // An invalid override is a switch that says off: nothing is posted, nothing touched.
    if (endpoint.kind === 'invalid') return 'stopped';
    const spool = new Spool(state.toolSpool());
    spool.tidy();
    const claimed = spool.claimAll(endpoint.origin);
    while (claimed.length > 0) {
        if (deadline - Date.now() <= 0 || options.signal?.aborted) {
            claimed.splice(0).forEach(file => file.release());
            return 'failed';
        }
        const check = beforePost(context, state);
        if (check.kind === 'disabled') {
            // `disabled` appeared: what is claimed is deleted unsent.
            claimed.splice(0).forEach(file => file.delete());
            return 'stopped';
        }
        if (options.allowed && !options.allowed()) {
            claimed.splice(0).forEach(file => file.release());
            return 'stopped';
        }
        const batch = nextBatch(claimed, check.id, endpoint.origin);
        if (batch.files.length === 0) continue;
        const outcome = await post(endpoint, batch.events, deadline - Date.now(), options.fetch, options.signal);
        if (outcome === 'failed') {
            [...batch.files, ...claimed.splice(0)].forEach(file => file.release());
            return 'failed';
        }
        batch.files.forEach(file => file.delete());
    }
    return 'drained';
}

/** Take from the front of `claimed` the files whose current events fit in one post to
 * `origin`, deleting on the way the files nothing of which is sent: unreadable ones,
 * and those whose events were all made under a replaced identifier. A file queued for
 * another endpoint is given back untouched. A file keeping only some of its events is
 * rewritten with them first. */
function nextBatch(claimed: Claimed[], current: string | undefined, origin: string): { files: Claimed[]; events: Envelope[] } {
    const files: Claimed[] = [];
    const events: Envelope[] = [];
    while (claimed.length > 0) {
        const file = claimed[0];
        const content = file.content();
        if (!content) {
            // Not a spool file this version can read or send: nobody ever will.
            claimed.shift();
            file.delete();
            continue;
        }
        if (!isQueuedFor(content, origin)) {
            // Queued for another endpoint, which only a read after the claim told: a
            // sender posting there sends it.
            claimed.shift();
            file.release();
            continue;
        }
        const held = content.events;
        const kept = keepCurrent(held, current);
        if (kept.length === 0) {
            claimed.shift();
            file.delete();
            continue;
        }
        if (events.length > 0 && events.length + kept.length > MAX_EVENTS_PER_POST) break;
        claimed.shift();
        if (kept.length !== held.length) {
            try {
                file.rewrite({ endpoint: content.endpoint, events: kept });
            } catch {
                file.delete();
                continue;
            }
        }
        events.push(...kept);
        files.push(file);
    }
    return { files, events };
}
