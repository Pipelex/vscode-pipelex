import * as vscode from 'vscode';
import type { PipelexApiClient } from '@pipelex/sdk';
import { type Semver, compareSemver, formatSemver } from './agentCliVersion';

/**
 * Best-effort capability gate for the API backend — "does this server do X?",
 * never "how new is this server?".
 *
 * ## Why the distinction is load-bearing
 *
 * `GET /v1/version` returns `implementation_version`, but that number belongs to
 * whichever implementation answered, and there are several. A bare open-source
 * runner answers `implementation: "pipelex-api"`; the hosted plane answers
 * `"pipelex-hosted"` (the platform front door, on its OWN release line, which
 * proxies `/validate` to a runner it never reports the version of); the local
 * runtime answers `"pipelex"`. Their version lines are unrelated and always will
 * be. A floor compared against a bare number is therefore a category error: it
 * happened to fire on api-dev, telling a user to upgrade a current server.
 *
 * So a floor is keyed on `(implementation, version)` — never on `version` alone —
 * and **anything we do not recognize passes**. A gate that guesses at strangers
 * produces false alarms, and a false alarm on a healthy server is worse than a
 * missed warning: the missed warning is caught downstream anyway (see below),
 * whereas the false alarm sends someone chasing a deployment problem that does
 * not exist.
 *
 * ## This gate is not the safety net
 *
 * It is an early, friendlier warning. The guarantee lives in
 * `apiValidationBackend`, which rejects an `is_valid: false` verdict carrying no
 * `validation_errors[]` and says so with its own remedy — ground truth, from the
 * response, at the moment it matters. Anything this gate gets wrong still fails
 * safe there. That is what licenses the lenient policy above.
 *
 * Per the MTHDS Protocol spec, clients should key feature detection on
 * `protocol_version` and the `extensions` hint rather than version arithmetic.
 * `protocol_version` is a single SDK constant that no runner overrides, so it
 * cannot discriminate anything today; `extensions` can, and
 * {@link CapabilityRequirement.extension} is where that lands as it grows. The
 * version floors are the fallback until then, and each one is deletable the day
 * its capability gets a token.
 */

/**
 * Implementation identities this extension recognizes. An identity absent from
 * this list is not an error — it is a newer or third-party implementation, and
 * every check passes for it by design.
 */
export const KNOWN_IMPLEMENTATIONS = ['pipelex', 'pipelex-api', 'pipelex-hosted'] as const;

export type KnownImplementation = (typeof KNOWN_IMPLEMENTATIONS)[number];

export function isKnownImplementation(name: string | undefined): name is KnownImplementation {
    return name !== undefined && (KNOWN_IMPLEMENTATIONS as readonly string[]).includes(name);
}

/** A behavior the API backend needs, and how to tell whether a server has it. */
export interface CapabilityRequirement {
    /** Our name for the behavior. Shown in the warning; also the warn-once key. */
    capability: string;
    /**
     * Positive proof: an `extensions` token whose presence settles the question
     * outright, whatever the versions say. Preferred over any floor — a server
     * asserting what it can do beats us inferring it from a release number.
     */
    extension?: string;
    /**
     * Inference of last resort, per implementation. An implementation ABSENT from
     * this map means we hold no opinion about it and the check passes. Absence is
     * a deliberate statement, so say why in a comment when you leave one out.
     */
    floors?: Partial<Record<KnownImplementation, Semver>>;
}

/**
 * Structured `validation_errors[]` carrying `source` — what the API backend maps
 * into cross-file diagnostics.
 */
export const STRUCTURED_VALIDATION_DIAGNOSTICS: CapabilityRequirement = {
    capability: 'structured validation diagnostics',
    floors: {
        // Landed in pipelex-api 0.4.0 ("MTHDS Protocol surface alignment (Phase 2)"):
        // the 200-diagnostic `/validate`, structured `validation_errors[]`, and the
        // `mthds_sources` threading that puts `source` on each error.
        'pipelex-api': [0, 4, 0],

        // 'pipelex-hosted' is deliberately ABSENT. Its `implementation_version` is
        // the platform front door's own release line; the runner implementing
        // /validate sits behind an internal proxy, and the handshake reports
        // nothing about it (`runtime_version` is null there by design — resolving
        // it would cost an internal call per request). Any floor written here
        // would be a number from the wrong service. If the hosted plane ever needs
        // gating, it needs an `extensions` token, not a version.

        // 'pipelex' is deliberately absent too: the local runtime is reached
        // through the `cli` backend, which has its own floor (MIN_AGENT_VERSION).
    },
};

/** Every capability the API backend checks on first contact with a base URL. */
const REQUIREMENTS: readonly CapabilityRequirement[] = [STRUCTURED_VALIDATION_DIAGNOSTICS];

/** The handshake fields we use, narrowed out of the SDK's loosely-typed `VersionInfo`. */
export interface Handshake {
    implementation?: string;
    implementationVersion?: string;
    extensions: readonly string[];
}

/**
 * Narrow a `GET /v1/version` body into a {@link Handshake}. The SDK types only
 * `protocol_version` / `runner_version` / `implementation_version`; `implementation`
 * and `extensions` arrive through its index signature as `unknown`, so every field
 * is checked at runtime and a malformed one is simply dropped.
 */
export function readHandshake(info: unknown): Handshake {
    if (typeof info !== 'object' || info === null) {
        return { extensions: [] };
    }
    const raw = info as Record<string, unknown>;
    const extensions = Array.isArray(raw.extensions)
        ? raw.extensions.filter((token): token is string => typeof token === 'string')
        : [];
    return {
        implementation: typeof raw.implementation === 'string' ? raw.implementation : undefined,
        implementationVersion: typeof raw.implementation_version === 'string' ? raw.implementation_version : undefined,
        extensions,
    };
}

/**
 * Why a verdict came out the way it did. Every pass reason is distinct so tests
 * can assert that a server passed for the RIGHT reason — a hosted handshake must
 * pass because we hold no floor for it, not because its number happened to clear
 * one — and so the output log names the cause when someone asks why.
 */
export type CapabilityReason =
    | 'extension-advertised'
    | 'no-implementation-reported'
    | 'unknown-implementation'
    | 'no-floor-for-implementation'
    | 'version-not-a-clean-release'
    | 'meets-floor'
    | 'below-floor';

export interface CapabilityVerdict {
    capable: boolean;
    reason: CapabilityReason;
    /** The floor that was applied — only set when one was actually compared. */
    floor?: Semver;
}

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
 * Decide whether `handshake` satisfies `requirement`. Pure — the whole policy is
 * here, so it is testable without a client, a URL, or the vscode namespace.
 *
 * Order is most-trustworthy-first: an advertised token settles it; otherwise a
 * floor applies only when we recognize the implementation AND hold a floor for
 * that implementation AND it reports a clean release. Every other path passes.
 */
export function assessCapability(requirement: CapabilityRequirement, handshake: Handshake): CapabilityVerdict {
    if (requirement.extension && handshake.extensions.includes(requirement.extension)) {
        return { capable: true, reason: 'extension-advertised' };
    }
    if (handshake.implementation === undefined) {
        return { capable: true, reason: 'no-implementation-reported' };
    }
    if (!isKnownImplementation(handshake.implementation)) {
        return { capable: true, reason: 'unknown-implementation' };
    }
    const floor = requirement.floors?.[handshake.implementation];
    if (!floor) {
        return { capable: true, reason: 'no-floor-for-implementation' };
    }
    const parsed = parseCleanRelease(handshake.implementationVersion);
    if (!parsed) {
        return { capable: true, reason: 'version-not-a-clean-release' };
    }
    return compareSemver(parsed, floor) < 0
        ? { capable: false, reason: 'below-floor', floor }
        : { capable: true, reason: 'meets-floor', floor };
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

/** Warn-once identity: one capability at one base URL. */
function capabilityKey(baseUrl: string, capability: string): string {
    return `${baseUrl}\n${capability}`;
}

/**
 * Best-effort, warn-once capability gate for the API backend.
 *
 * On the first analysis against a given base URL, probe `GET /v1/version` and
 * evaluate every {@link REQUIREMENTS} entry against the handshake. It never
 * hard-blocks and never throws — a `/version` failure is left to the actual
 * `validate()` call to surface as a transport error, so the user is not
 * double-notified.
 */
export class ApiCapabilityGate {
    /** Keys of `(baseUrl, capability)` pairs already evaluated. */
    private readonly checked = new Set<string>();
    /**
     * Base URLs with a probe currently in flight. `ensureCapable` is started
     * fire-and-forget per analysis, so without this guard two quick saves against
     * the same URL would both find work pending, both probe, and both warn.
     */
    private readonly inFlight = new Set<string>();

    constructor(private readonly output: vscode.OutputChannel) {}

    /**
     * `signal` / `timeoutMs` bound the *wait* on the probe (not the underlying
     * request, which keeps its own client-side request timeout). Without them the
     * probe could delay a save by the client's full request ceiling, and a
     * superseded save could not cancel it. Both are optional so non-analysis
     * callers (tests) can probe without an abort context.
     */
    async ensureCapable(
        client: PipelexApiClient,
        baseUrl: string,
        signal?: AbortSignal,
        timeoutMs?: number,
    ): Promise<void> {
        if (this.inFlight.has(baseUrl)) {
            return;
        }
        const pending = REQUIREMENTS.filter(req => !this.checked.has(capabilityKey(baseUrl, req.capability)));
        if (pending.length === 0) {
            return;
        }
        this.inFlight.add(baseUrl);
        try {
            let handshake: Handshake;
            try {
                handshake = readHandshake(await probeWithLimit(client.version(), signal, timeoutMs));
            } catch {
                // Best-effort: a /version failure — or a superseded save (abort) / hung
                // server (timeout) — leaves the gate unevaluated and uncached (in-flight is
                // cleared in `finally`, so a later save re-probes). The actual validate()
                // call races the same signal/timeout and surfaces any real fault.
                return;
            }

            for (const requirement of pending) {
                this.checked.add(capabilityKey(baseUrl, requirement.capability));
                const verdict = assessCapability(requirement, handshake);
                // Log every verdict, pass or fail, with the reason that produced it:
                // when someone asks why a warning did (or did not) appear, this line
                // answers it without a debug build.
                this.output.appendLine(
                    `[capability] ${baseUrl} ${requirement.capability}: ` +
                    `${verdict.capable ? 'ok' : 'TOO OLD'} (${verdict.reason}; ` +
                    `implementation=${handshake.implementation ?? 'unreported'} ` +
                    `version=${handshake.implementationVersion ?? 'unreported'})`
                );
                if (!verdict.capable && verdict.floor) {
                    vscode.window.showWarningMessage(tooOldMessage({
                        baseUrl,
                        capability: requirement.capability,
                        implementation: handshake.implementation,
                        implementationVersion: handshake.implementationVersion,
                        floor: verdict.floor,
                    }));
                }
            }
        } finally {
            this.inFlight.delete(baseUrl);
        }
    }

    /** Test/diagnostic helper — forget which base URLs were probed. */
    reset(): void {
        this.checked.clear();
        this.inFlight.clear();
    }
}

/**
 * Hosts the managed Pipelex API is served from, across environments. An exact-match
 * set rather than a suffix test: `endsWith('.pipelex.com')` would accept
 * `evil-api.pipelex.com.attacker.test`-style lookalikes, and the remedies below
 * point users at account actions, so mis-identifying a host is worth avoiding.
 */
const HOSTED_PIPELEX_API_HOSTS: ReadonlySet<string> = new Set([
    'api.pipelex.com',
    'api-dev.pipelex.com',
    'api-staging.pipelex.com',
    'api-default.pipelex.com',
]);

/** True when `baseUrl` points at a managed, hosted Pipelex API (not a self-hosted server). */
export function isHostedPipelexApi(baseUrl: string): boolean {
    try {
        return HOSTED_PIPELEX_API_HOSTS.has(new URL(baseUrl).hostname);
    } catch {
        return false;
    }
}

/**
 * Warning shown when a known implementation advertises a release below its floor.
 * It names the implementation, because the number alone is meaningless without it
 * — that omission is exactly what made the previous version of this message
 * misleading. The remedy differs by who runs the server: a self-hosted operator
 * can upgrade it, but a user on the hosted API cannot, so they are pointed at the
 * `cli` backend instead of told to "upgrade the server" they don't control.
 */
export function tooOldMessage(args: {
    baseUrl: string;
    capability: string;
    implementation: string | undefined;
    implementationVersion: string | undefined;
    floor: Semver;
}): string {
    const { baseUrl, capability, implementation, implementationVersion, floor } = args;
    const named = `${implementation ?? 'the server'} ${implementationVersion ?? 'of unknown version'}`;
    if (isHostedPipelexApi(baseUrl)) {
        return `The hosted Pipelex API (${baseUrl}) reports ${named}, which does not yet support ` +
            `${capability} (needs ${implementation} ≥ ${formatSemver(floor)}). This is rolling out — in the ` +
            `meantime, switch \`pipelex.backend\` to \`cli\` for local validation.`;
    }
    return `The Pipelex API at ${baseUrl} reports ${named}, but the extension expects ` +
        `${implementation} ≥ ${formatSemver(floor)} for ${capability}. Upgrade the server (or its pipelex pin), ` +
        `or switch \`pipelex.backend\` to \`cli\`.`;
}
