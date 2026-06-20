import * as vscode from 'vscode';
import type { MthdsApiClient } from 'mthds';
import { type Semver, compareSemver, formatSemver } from './agentCliVersion';

/**
 * Minimum `pipelex-api` `implementation_version` that delivers the structured
 * `validation_errors[]` contract (incl. `source`) the API backend relies on.
 * Mirrors the Phase 2 pipelex-api version.
 */
export const MIN_API_IMPLEMENTATION_VERSION: Semver = [0, 4, 0];

/** Clean `X.Y.Z` (no prerelease/build suffix). */
const CLEAN_RELEASE_RE = /^\s*(\d+)\.(\d+)\.(\d+)\s*$/;

/**
 * Parse a version string ONLY when it is a clean release. Prerelease / dev /
 * build-tagged versions (`0.4.0-dev`, `latest`, a git pin) and anything
 * unparseable return `null` — the lenient policy treats those as capable rather
 * than risk false-failing a self-hosted or dev server.
 */
export function parseCleanRelease(raw: string | undefined): Semver | null {
    if (!raw) {
        return null;
    }
    const match = CLEAN_RELEASE_RE.exec(raw);
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Await `promise` but stop waiting if `signal` aborts or `timeoutMs` elapses,
 * rejecting in either case. The underlying request is NOT cancelled (it keeps
 * its own client-side request timeout and self-cleans) — we only stop awaiting
 * it, mirroring `runWithAbort` in the API backend. With neither bound supplied,
 * the original promise is returned unchanged.
 */
function probeWithLimit<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    if (!signal && timeoutMs == null) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
            if (timer) {
                clearTimeout(timer);
            }
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
            cleanup();
            reject(new Error('version probe aborted'));
        };
        if (signal?.aborted) {
            reject(new Error('version probe aborted'));
            return;
        }
        if (timeoutMs != null) {
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('version probe timed out'));
            }, timeoutMs);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { cleanup(); resolve(value); },
            error => { cleanup(); reject(error); },
        );
    });
}

/**
 * Best-effort, warn-once capability gate for the API backend.
 *
 * On the first analysis against a given base URL, probe `GET /v1/version` and,
 * if it advertises a clean release strictly below the floor, warn once. It never
 * hard-blocks (prerelease/dev/unparseable versions pass) and never throws — a
 * `/version` failure is left to the actual `validate()` call to surface as a
 * transport error, so the user is not double-notified.
 */
export class ApiVersionGate {
    private readonly checked = new Set<string>();

    constructor(private readonly output: vscode.OutputChannel) {}

    /**
     * `signal` / `timeoutMs` bound the *wait* on the probe (not the underlying
     * request, which keeps its own client-side request timeout). Without them the
     * probe could delay a save by the client's full request ceiling, and a
     * superseded save could not cancel it. Both are optional so non-analysis
     * callers (tests) can probe without an abort context.
     */
    async ensureCapable(
        client: MthdsApiClient,
        baseUrl: string,
        signal?: AbortSignal,
        timeoutMs?: number,
    ): Promise<void> {
        if (this.checked.has(baseUrl)) {
            return;
        }
        let implementationVersion: string | undefined;
        try {
            const info = await probeWithLimit(client.version(), signal, timeoutMs);
            implementationVersion = info.implementation_version;
        } catch {
            // Best-effort: a /version failure — or a superseded save (abort) / hung
            // server (timeout) — leaves the gate unevaluated and uncached. The actual
            // validate() call races the same signal/timeout and surfaces any real fault.
            return;
        }
        this.checked.add(baseUrl);

        const parsed = parseCleanRelease(implementationVersion);
        if (parsed && compareSemver(parsed, MIN_API_IMPLEMENTATION_VERSION) < 0) {
            this.output.appendLine(
                `pipelex-api at ${baseUrl} reports implementation_version ${implementationVersion}, ` +
                `older than the required ${formatSemver(MIN_API_IMPLEMENTATION_VERSION)}.`
            );
            vscode.window.showWarningMessage(
                tooOldMessage({ baseUrl, implementationVersion })
            );
        }
    }

    /** Test/diagnostic helper — forget which base URLs were probed. */
    reset(): void {
        this.checked.clear();
    }
}

/** The host the hosted Pipelex API is served from. */
const HOSTED_PIPELEX_API_HOST = 'api.pipelex.com';

/** True when `baseUrl` points at the managed, hosted Pipelex API (not a self-hosted server). */
export function isHostedPipelexApi(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).hostname === HOSTED_PIPELEX_API_HOST;
    } catch {
        return false;
    }
}

/**
 * Warning shown when the API advertises a version below the floor. The remedy
 * differs by who runs the server: a self-hosted operator can upgrade it, but a
 * user on the hosted API cannot — so we point them at the `cli` backend instead
 * of telling them to "upgrade the server" (which they don't control).
 */
export function tooOldMessage(args: { baseUrl: string; implementationVersion: string | undefined }): string {
    const { baseUrl, implementationVersion } = args;
    const floor = formatSemver(MIN_API_IMPLEMENTATION_VERSION);
    if (isHostedPipelexApi(baseUrl)) {
        return `The hosted Pipelex API (${baseUrl}) is ${implementationVersion}, which does not yet support the ` +
            `structured validation diagnostics this feature needs (≥ ${floor}). This is rolling out — in the ` +
            `meantime, switch \`pipelex.backend\` to \`cli\` for local validation, or point \`pipelex.api.baseUrl\` ` +
            `at a self-hosted pipelex-api ≥ ${floor}.`;
    }
    return `The Pipelex API at ${baseUrl} is ${implementationVersion}, but the extension expects ` +
        `≥ ${floor} for structured validation diagnostics. Upgrade the pipelex-api server (or its pipelex pin).`;
}
