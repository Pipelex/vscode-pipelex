import * as vscode from 'vscode';
import { MthdsApiClient, ApiResponseError, ApiUnreachableError } from 'mthds';
import type { PipelexValidationReport } from 'mthds';
import { AnalyzeAbortError, BackendError } from './backend';
import type { AnalyzeOptions, BundleAnalysis, BundleRequest, ValidationBackend, ValidationOutcome } from './backend';
import type { ValidationErrorItem } from './types';
import type { ApiVersionGate } from './apiVersionGate';

export interface ApiBackendDeps {
    /** Base URL of the API server (read fresh per analysis so a settings change takes effect). */
    baseUrl: string;
    /** Resolve the bearer token (SecretStorage → env). */
    getToken: () => Promise<string | undefined>;
    /** Warn-once capability gate, shared across analyses. */
    versionGate: ApiVersionGate;
    /**
     * One-time confirmation before sending bundle contents to a non-localhost host.
     * Returns `true` to proceed. Only consulted for remote base URLs.
     */
    confirmRemote: (baseUrl: string) => Promise<boolean>;
    output: vscode.OutputChannel;
}

/**
 * API backend — one `POST /v1/validate` per `analyze()` always returns both the
 * validation verdict and (when asked) the graph. An invalid bundle is an HTTP 422
 * carrying structured `validation_errors`, mapped to the same diagnostics shape
 * the CLI path produces.
 *
 * Transport / non-validation failures (server unreachable, non-`problem+json`,
 * auth, timeout, unparseable) never become diagnostics: they surface a
 * {@link BackendError} so the consumer notifies, clears stale diagnostics, and
 * does NOT fall back to the CLI.
 */
export class ApiValidationBackend implements ValidationBackend {
    readonly kind = 'api' as const;

    constructor(private readonly deps: ApiBackendDeps) {}

    async analyze(request: BundleRequest, options: AnalyzeOptions, signal: AbortSignal): Promise<BundleAnalysis> {
        const { baseUrl } = this.deps;

        // Privacy gate — fire BEFORE the first remote request, not after a send.
        if (!isLocalhost(baseUrl)) {
            const proceed = await this.deps.confirmRemote(baseUrl);
            if (!proceed) {
                throw new BackendError({ kind: 'declined', logMessage: `remote send declined for ${baseUrl}` });
            }
        }

        const token = await this.deps.getToken();
        const client = new MthdsApiClient({ baseUrl, apiToken: token });

        // Best-effort, warn-once version gate (never blocks).
        await this.deps.versionGate.ensureCapable(client, baseUrl);
        if (signal.aborted) {
            throw new AnalyzeAbortError();
        }

        const names = request.files.map(f => f.name);
        const contents = request.files.map(f => f.content);

        let report: PipelexValidationReport;
        try {
            report = await this.runWithAbort(
                client.validate(contents, true, names),
                signal,
                request.timeout,
                baseUrl,
            );
        } catch (err: unknown) {
            return this.handleError(err, options, baseUrl);
        }

        const graph = options.withGraph ? (report.graph_spec ?? null) : undefined;
        return { validation: { ok: true, errors: [] }, graph };
    }

    /**
     * Race the (uncancellable) client request against the abort signal and a
     * timeout. The underlying fetch keeps running, but we stop awaiting it so a
     * superseded save or a hung server does not pile up.
     */
    private runWithAbort<T>(promise: Promise<T>, signal: AbortSignal, timeout: number, baseUrl: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                cleanup();
                reject(new AnalyzeAbortError());
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new BackendError({
                    kind: 'unreachable',
                    logMessage: `Pipelex API request timed out after ${timeout}ms`,
                    userMessage: unreachableMessage(baseUrl),
                }));
            }, timeout);

            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                value => { cleanup(); resolve(value); },
                error => { cleanup(); reject(error); },
            );
        });
    }

    private handleError(err: unknown, options: AnalyzeOptions, baseUrl: string): BundleAnalysis {
        // Cancellation and our own timeout/decline pass straight through.
        if (err instanceof AnalyzeAbortError || err instanceof BackendError) {
            throw err;
        }

        if (err instanceof ApiResponseError) {
            const validationOutcome = this.asValidationOutcome(err);
            if (validationOutcome) {
                return options.withGraph
                    ? { validation: validationOutcome, graph: null }
                    : { validation: validationOutcome };
            }
            // A non-validation API response (auth, request-shape, 5xx). Notify, no diagnostics.
            throw new BackendError({
                kind: 'unreachable',
                logMessage: `Pipelex API ${err.status} at ${baseUrl}: ${err.serverMessage ?? err.statusText}`,
                userMessage: apiResponseMessage(err, baseUrl),
            });
        }

        if (err instanceof ApiUnreachableError) {
            throw new BackendError({
                kind: 'unreachable',
                logMessage: `Pipelex API unreachable at ${baseUrl} (${err.code ?? 'network error'})`,
                userMessage: unreachableMessage(baseUrl),
            });
        }

        // Unparseable body / non-problem+json / unknown — treat as a transport failure.
        const message = err instanceof Error ? err.message : String(err);
        throw new BackendError({
            kind: 'unreachable',
            logMessage: `Pipelex API unexpected response from ${baseUrl}: ${message}`,
            userMessage: unreachableMessage(baseUrl),
        });
    }

    /**
     * Interpret an `ApiResponseError` as a bundle-validation verdict, or return
     * `undefined` when it is NOT a validation failure (so the caller surfaces it
     * as a transport/non-validation error).
     */
    private asValidationOutcome(err: ApiResponseError): ValidationOutcome | undefined {
        if (err.validationErrors && err.validationErrors.length > 0) {
            return { ok: false, errors: err.validationErrors as ValidationErrorItem[] };
        }
        // A 422 ValidateBundleError with no per-error list (whole-bundle dry-run /
        // signature failure) rides the human-readable detail — surface it as one
        // diagnostic on the primary file rather than dropping it.
        if (err.status === 422 && err.errorType === 'ValidateBundleError') {
            return {
                ok: false,
                errors: [{
                    category: 'blueprint_validation',
                    message: err.serverMessage ?? err.message,
                    error_type: err.errorType,
                }],
            };
        }
        return undefined;
    }
}

/** Localhost / loopback host → privacy confirmation is skipped. */
export function isLocalhost(baseUrl: string): boolean {
    let host: string;
    try {
        host = new URL(baseUrl).hostname;
    } catch {
        return false;
    }
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

function unreachableMessage(baseUrl: string): string {
    return `Pipelex API unreachable at ${baseUrl} — is pipelex-api running?`;
}

function apiResponseMessage(err: ApiResponseError, baseUrl: string): string {
    if (err.status === 401 || err.status === 403) {
        return `Pipelex API at ${baseUrl} rejected the request (HTTP ${err.status}). ` +
            'Check your hosted API key (run "Pipelex: Set Hosted API Key").';
    }
    return `Pipelex API error at ${baseUrl} (HTTP ${err.status}): ${err.serverMessage ?? err.statusText}.`;
}
