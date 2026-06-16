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

    async ensureCapable(client: MthdsApiClient, baseUrl: string): Promise<void> {
        if (this.checked.has(baseUrl)) {
            return;
        }
        let implementationVersion: string | undefined;
        try {
            const info = await client.version();
            implementationVersion = info.implementation_version;
        } catch {
            // Best-effort: a /version failure is surfaced by the validate() call itself.
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
