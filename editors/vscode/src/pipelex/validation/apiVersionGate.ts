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
                `The Pipelex API at ${baseUrl} is ${implementationVersion}, but the extension expects ` +
                `≥ ${formatSemver(MIN_API_IMPLEMENTATION_VERSION)} for structured validation diagnostics. ` +
                `Upgrade the pipelex-api server (or its pipelex pin).`
            );
        }
    }

    /** Test/diagnostic helper — forget which base URLs were probed. */
    reset(): void {
        this.checked.clear();
    }
}
