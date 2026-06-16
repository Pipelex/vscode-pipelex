import * as vscode from 'vscode';
import { MthdsApiClient, ApiResponseError, ApiUnreachableError, PipelineRequestError } from 'mthds';
import type { PipelexValidationReport } from 'mthds';
import { AnalyzeAbortError, BackendError } from './backend';
import type { AnalyzeOptions, BackendErrorAction, BundleAnalysis, BundleRequest, ValidationBackend, ValidationOutcome } from './backend';
import type { ValidationErrorItem } from './types';
import { isHostedPipelexApi, type ApiVersionGate } from './apiVersionGate';
import { PIPELEX_PLATFORM_URL, SET_API_KEY_COMMAND } from './apiKey';
import { escapeHtml } from '../htmlEscape';

/** Open-source runner users can self-host instead of using the hosted API. */
const PIPELEX_API_REPO_URL = 'https://github.com/Pipelex/pipelex-api';
/** Quickest way to run the open-source runner locally (container listens on 8081). */
const PIPELEX_API_DOCKER_HINT = 'docker run -p 8081:8081 pipelex/pipelex-api';

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

        // Build the client first — reading the token (SecretStorage) and constructing
        // the client are local, and the constructor validates the base URL (rejecting a
        // non-host-only `pipelex.api.baseUrl`, e.g. one with a `/v1` path). Doing it here,
        // inside a try, turns a misconfiguration into an actionable BackendError instead
        // of a throw that escapes `handleError` — and fails fast, before the privacy modal.
        let client: MthdsApiClient;
        try {
            const token = await this.deps.getToken();
            client = new MthdsApiClient({ baseUrl, apiToken: token });
        } catch (err: unknown) {
            throw setupError(err, baseUrl);
        }

        // Privacy gate — fire BEFORE the first remote request, not after a send.
        if (!isLocalhost(baseUrl)) {
            const proceed = await this.deps.confirmRemote(baseUrl);
            if (!proceed) {
                throw new BackendError({ kind: 'declined', logMessage: `remote send declined for ${baseUrl}` });
            }
        }

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
            // A non-validation API response. The server WAS reached — this is not
            // "unreachable". An auth rejection (401/403) gets its own kind + one-click
            // remedies; everything else (bad request, 5xx) is a generic api-error.
            const logMessage = `Pipelex API ${err.status} at ${baseUrl}: ${err.serverMessage ?? err.statusText}`;
            if (err.status === 401 || err.status === 403) {
                throw new BackendError({
                    kind: 'auth',
                    logMessage,
                    userMessage: authMessage(baseUrl, err.status),
                    detailHtml: authDetailHtml(baseUrl, err.status),
                    actions: authActions(baseUrl),
                });
            }
            throw new BackendError({
                kind: 'api-error',
                logMessage,
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

/**
 * Map a failure from building the client (token read / constructor) to an
 * actionable {@link BackendError}. The constructor throws `PipelineRequestError`
 * when `baseUrl` is not host-only (a path, query, or embedded credentials) — a
 * pure configuration problem, surfaced as an `api-error` with a fix-it message.
 * Anything else (a SecretStorage read failure) is an `infra` setup error.
 */
function setupError(err: unknown, baseUrl: string): BackendError {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PipelineRequestError) {
        return new BackendError({
            kind: 'api-error',
            logMessage: `Pipelex API base URL rejected for ${baseUrl}: ${message}`,
            userMessage: invalidBaseUrlMessage(baseUrl),
        });
    }
    return new BackendError({
        kind: 'infra',
        logMessage: `Pipelex API client setup failed for ${baseUrl}: ${message}`,
        userMessage:
            `Pipelex API: could not initialize the client for ${baseUrl} (${message}). ` +
            `Check \`pipelex.api.baseUrl\`, or switch \`pipelex.backend\` to \`cli\`.`,
    });
}

/** Guidance for a base URL the client rejected as not host-only. */
function invalidBaseUrlMessage(baseUrl: string): string {
    return `Invalid Pipelex API base URL "${baseUrl}" — it must be host-only (no path, query, or ` +
        `credentials), e.g. https://api.pipelex.com or http://localhost:8081. ` +
        `Fix \`pipelex.api.baseUrl\` in settings, or switch \`pipelex.backend\` to \`cli\`.`;
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
    if (isHostedPipelexApi(baseUrl)) {
        return `Pipelex API unreachable at ${baseUrl} — check your network connection; ` +
            `the hosted Pipelex API may be temporarily unavailable.`;
    }
    return `Pipelex API unreachable at ${baseUrl} — is pipelex-api running?`;
}

/** Non-auth API response (bad request, 5xx). Auth (401/403) is handled by {@link authMessage}. */
function apiResponseMessage(err: ApiResponseError, baseUrl: string): string {
    return `Pipelex API error at ${baseUrl} (HTTP ${err.status}): ${err.serverMessage ?? err.statusText}.`;
}

/**
 * Plain-text guidance for a 401/403 (used by the notification toast, which can't
 * render links/code). The remedies differ by host: a hosted-API user gets a key
 * from the platform or self-hosts the open-source runner, whereas a self-hosted
 * operator configures auth on the server they run. {@link authDetailHtml} is the
 * richer pane equivalent with clickable links and the exact Docker command.
 */
function authMessage(baseUrl: string, status: number): string {
    if (isHostedPipelexApi(baseUrl)) {
        return `The hosted Pipelex API at ${baseUrl} rejected the request (HTTP ${status}) — the \`api\` backend ` +
            `needs an API key. Set one, get a key at ${PIPELEX_PLATFORM_URL}, run the open-source pipelex-api ` +
            `locally with Docker, or switch \`pipelex.backend\` to \`cli\` to validate without a key.`;
    }
    return `The Pipelex API at ${baseUrl} rejected the request (HTTP ${status}) — it requires authentication. ` +
        `Set a key with the "Pipelex: Set Hosted API Key" command (or set the MTHDS_API_KEY environment variable). ` +
        `You can also switch \`pipelex.backend\` to \`cli\` to validate locally.`;
}

/**
 * Rich HTML body for the method pane: same guidance as {@link authMessage} but
 * with clickable links (opened via the pane's `openExternally` bridge) and a
 * copyable Docker command. The only dynamic value, `baseUrl`, is escaped.
 */
function authDetailHtml(baseUrl: string, status: number): string {
    const host = `<code>${escapeHtml(baseUrl)}</code>`;
    const docker = `<code>${escapeHtml(PIPELEX_API_DOCKER_HINT)}</code>`;
    const platformLink = `<a class="pipelex-link" href="${PIPELEX_PLATFORM_URL}">app.pipelex.com</a>`;
    const repoLink = `<a class="pipelex-link" href="${PIPELEX_API_REPO_URL}">pipelex-api</a>`;
    if (isHostedPipelexApi(baseUrl)) {
        return `The hosted Pipelex API at ${host} rejected the request (HTTP ${status}) — the <code>api</code> ` +
            `backend needs an API key.` +
            `</p><p>Have a key? Click <strong>Set API Key</strong> below. Need one? Get it at ${platformLink}.` +
            `</p><p>Prefer to run it yourself? Start the open-source ${repoLink} — ${docker} — then point ` +
            `<code>pipelex.api.baseUrl</code> at it, or switch <code>pipelex.backend</code> to <code>cli</code> ` +
            `to validate locally.`;
    }
    return `The Pipelex API at ${host} rejected the request (HTTP ${status}) — it requires authentication.` +
        `</p><p>Click <strong>Set API Key</strong> below, or set the <code>MTHDS_API_KEY</code> environment ` +
        `variable. You can also switch <code>pipelex.backend</code> to <code>cli</code> to validate locally.`;
}

/** One-click remedies for a 401/403, shown as pane buttons and toast actions. */
function authActions(baseUrl: string): BackendErrorAction[] {
    const actions: BackendErrorAction[] = [{ label: 'Set API Key', command: SET_API_KEY_COMMAND }];
    if (isHostedPipelexApi(baseUrl)) {
        actions.push({ label: 'Get an API Key', externalUrl: PIPELEX_PLATFORM_URL });
    }
    return actions;
}
