import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    PipelexApiClient,
    ApiResponseError,
    ApiUnreachableError,
    MethodFileTransferError,
    PipelineRequestError,
    RequestArgumentError,
} from '@pipelex/sdk';
import type { PipelexValidationReport, PipelexValidationResult } from '@pipelex/sdk';
import { listMethodTree, MethodTreeError, TreeLimitExceededError } from 'mthds';
import type { MethodTree } from 'mthds';
import { AnalyzeAbortError, BackendError } from './backend';
import type { AnalyzeOptions, BackendErrorAction, BundleAnalysis, BundleRequest, ValidationBackend, ValidationOutcome } from './backend';
import { asSentence, problemFacts, readProblemItems, readProblemSummary, readVerdictErrors, withNextStep } from './problemItems';
import { isHostedPipelexApi, type ApiCapabilityGate } from './apiCapabilityGate';
import { PIPELEX_PLATFORM_URL, SET_API_KEY_COMMAND } from './apiKey';

export interface ApiBackendDeps {
    /** Base URL of the API server (read fresh per analysis so a settings change takes effect). */
    baseUrl: string;
    /** Resolve the bearer token (SecretStorage → env). */
    getToken: () => Promise<string | undefined>;
    /** Warn-once capability gate, shared across analyses. */
    capabilityGate: ApiCapabilityGate;
    /**
     * One-time confirmation before sending bundle contents to a non-localhost host.
     * Returns `true` to proceed. Only consulted for remote base URLs.
     */
    confirmRemote: (baseUrl: string) => Promise<boolean>;
    output: vscode.OutputChannel;
}

/**
 * API backend — one `POST /v1/validate` per `analyze()` always returns both the
 * validation verdict and (when asked) the graph.
 *
 * What it validates is the saved file's **method tree**, the tree a run of the
 * method would send: the saved file's directory listed by the `mthds` package's
 * lister under the MTHDS standard's membership rule, so it is rooted at the
 * nearest `METHODS.toml` at or above that directory, else at the directory
 * itself, and holds every file the rule keeps (every bundle, and every file a
 * step reads, such as a `PipeDocGen` step's template), under the limits the
 * deployment announces. The client sends it inline when small and by hash
 * otherwise, uploading only the files the API lacks. The saved file must be a
 * file of that tree: one the rule keeps out is not validated at all, since a
 * verdict on the tree would say nothing about it. The saved file is
 * `request.savedUri`, the file saved or opened, and never the graph primary
 * the analysis may be anchored on, which the tree can hold when the saved file
 * is kept out. The verdict's items, which name a file by its tree path, are
 * placed by the caller against the directory's `.mthds` files it gathered.
 *
 * `/validate` is 200-diagnostic:
 * the produced verdict rides the response body discriminated on `is_valid`. An
 * `is_valid: false` body carries its faults as problem items in `errors[]` (the
 * same items the CLI path reads), and either arm may carry advisory findings as
 * problem items in `warnings[]`; a valid bundle with pending signatures is
 * `is_valid: true` / `is_runnable: false` — a runnability fact, not an error
 * (the `--allow-signatures` sweep tolerates them). A runner that still writes
 * the shape problem items replace (the hosted plane's, until it runs a pipelex
 * that writes problems) is read through `problemItems.ts`.
 *
 * Transport / no-verdict failures (server unreachable, non-`problem+json`, auth,
 * a request-shape 422, timeout, unparseable, a tree that cannot be listed or
 * sent) never become diagnostics: they surface a {@link BackendError} so the
 * consumer notifies, clears stale diagnostics, and does NOT fall back to the
 * CLI. A no-verdict answer is a problem document, and its detail and next step
 * are what the user is shown.
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
        let client: PipelexApiClient;
        let token: string | undefined;
        try {
            token = await this.deps.getToken();
            client = new PipelexApiClient({ baseUrl, apiKey: token });
        } catch (err: unknown) {
            throw setupError(err, baseUrl);
        }

        // A hosted Pipelex API always requires a key, and this backend is the
        // extension's default, so a user who has not stored one yet lands here on
        // their first save. Say where to get a key and how to store it — before the
        // privacy modal (there is nothing to consent to yet) and before any request
        // (which could only come back 401). A self-hosted server may run without
        // auth, so it gets the request and its own answer.
        if (!token && isHostedPipelexApi(baseUrl)) {
            throw new BackendError({
                kind: 'no-key',
                logMessage: `no API key stored or in PIPELEX_API_KEY for the hosted Pipelex API at ${baseUrl}`,
                userMessage: missingKeyMessage(baseUrl),
                actions: authActions(baseUrl),
            });
        }

        // Privacy gate — fire BEFORE the first remote request, not after a send.
        if (!isLocalhost(baseUrl)) {
            const proceed = await this.deps.confirmRemote(baseUrl);
            if (!proceed) {
                throw new BackendError({ kind: 'declined', logMessage: `remote send declined for ${baseUrl}` });
            }
        }

        // Best-effort, warn-once capability gate (never blocks, never throws). Fire it
        // CONCURRENTLY with validate() instead of awaiting it first: serialized, a hung
        // /version would add a full timeout on TOP of validate()'s own, so one save could
        // take up to 2× `pipelex.validation.timeout`. Running them together caps the wait
        // at a single timeout. The probe still carries the same signal/timeout (a
        // superseded save abandons it) and `ensureCapable` swallows every fault internally.
        void this.deps.capabilityGate.ensureCapable(client, baseUrl, signal, request.timeout);

        let report: PipelexValidationResult;
        try {
            // One timeout for the whole validation: the handshake, the listing, the
            // uploads and the request together, as a save's wait was always capped.
            // The consent modal and the token read above were awaited, so the save
            // may have been superseded meanwhile: `runWithAbort` then settles before
            // starting the validation, which never lists or ships a stale tree.
            report = await this.runWithAbort(
                (operationSignal, deadline) => this.validateMethodTree(client, request, operationSignal, deadline),
                signal,
                request.timeout,
                baseUrl,
            );
        } catch (err: unknown) {
            this.handleError(err, baseUrl);
        }

        // A 200 must carry a JSON object with `is_valid`. The `mthds` client
        // JSON.parses the body without shape-validating it, so a `null`/primitive
        // body slips through as `report` — and reading `report.is_valid` below would
        // throw a TypeError that escapes `handleError` to the generic error path.
        // Treat a non-object body as a malformed (no-verdict) response, mirroring the
        // missing-`errors` contract violation handled further down.
        if (report === null || typeof report !== 'object') {
            throw new BackendError({
                kind: 'api-error',
                logMessage: `Pipelex API returned a non-object /validate body at ${baseUrl}`,
                userMessage: apiMalformedBodyMessage(baseUrl),
            });
        }

        // 200-diagnostic: the verdict is in the body, not the status. An invalid
        // bundle is a produced verdict (`is_valid: false`), not a transport error.
        // (The extension tsconfig is `strict:false`, where boolean-literal
        // discriminants don't narrow — read `is_valid` and cast the arm explicitly.)
        // The SDK types the shape problem items replace, so the items are read
        // loosely off the body itself.
        const body = report as unknown as Record<string, unknown>;
        const warnings = readProblemItems(body.warnings);
        if (report.is_valid === false) {
            const errors = readVerdictErrors(body);
            // The runtime's structured-info invariant is total: an invalid verdict
            // ALWAYS carries a non-empty `errors[]`. An `is_valid: false` body with
            // no readable item is a backend/contract violation, NOT an empty invalid
            // verdict — surface it as a no-verdict BackendError so the consumer
            // clears stale diagnostics, instead of silently publishing zero
            // diagnostics (which would read as a falsely-clean bundle). Unlike the
            // CLI's verdict, which is a problem document whose own code and detail
            // can stand for its faults (`parseFailure`), this body has neither.
            if (errors.length === 0) {
                throw new BackendError({
                    kind: 'api-error',
                    logMessage: `Pipelex API returned is_valid:false with no readable errors at ${baseUrl}`,
                    userMessage: apiInvalidContractMessage(baseUrl),
                });
            }
            const validation: ValidationOutcome = { ok: false, errors, warnings };
            return options.withGraph ? { validation, graph: null } : { validation };
        }

        // Valid arm. Pending signatures (when `--allow-signatures` swept any) are an
        // `is_runnable: false` fact on the success path — never a fabricated error.
        const valid = report as PipelexValidationReport;
        const graph = options.withGraph ? (valid.graph_spec ?? null) : undefined;
        return { validation: { ok: true, errors: [], warnings }, graph };
    }

    /**
     * List the saved file's method tree and validate it. The tree is listed under
     * the limits the deployment announces, so one it would refuse for its size is
     * refused here, before any file is hashed; the handshake that announces them
     * is the one the client then reads to choose between inline and by hash. A
     * saved file the tree does not hold is refused before anything is sent.
     *
     * `signal` is the one {@link runWithAbort} hands it, which the save's own
     * signal and its timeout both abort, and `deadline` the moment that timeout
     * runs out. The client gets that signal for the blob check, the uploads and
     * the request, and the time left before the deadline as the request's own
     * timeout, so a superseded or timed-out save cancels the uploads and the
     * request themselves, and the request never outlives the save's one timeout.
     * Without them the SDK's own 20-minute default governs, and every abandoned
     * save keeps its upload in flight. The handshake takes no signal, so a save
     * abandoned while it is asked stops as soon as it answers, before the tree is
     * listed.
     */
    private async validateMethodTree(
        client: PipelexApiClient,
        request: BundleRequest,
        signal: AbortSignal,
        deadline: number,
    ): Promise<PipelexValidationResult> {
        const savedPath = request.savedUri.fsPath;
        const limits = await client.methodTreeLimits();
        if (signal.aborted) {
            throw new AnalyzeAbortError();
        }
        const tree = await listMethodTree(path.dirname(savedPath), { limits });
        const treePath = await treePathOf(savedPath, tree.root);
        if (treePath === undefined || !tree.has(treePath)) {
            throw new BackendError({
                kind: 'tree',
                logMessage: `${savedPath} is not a file of its method tree rooted at ${tree.root ?? path.dirname(savedPath)}`,
                userMessage: outsideTreeMessage(savedPath, tree),
            });
        }
        if (signal.aborted) {
            throw new AnalyzeAbortError();
        }
        return client.validate({ tree }, true, { timeoutMs: remainingMs(deadline), signal });
    }

    /**
     * Run one validation under the save's signal and one deadline, `timeout` from
     * now, and race it against both. The operation is handed a signal of its own,
     * which the save's signal aborts and so does the deadline, so whatever it still
     * has in flight when the save is superseded or times out, an upload or the
     * request, is cancelled rather than orphaned: the caller drops its controller
     * once the save settles, and nothing could cancel it later. The race is what
     * settles the save with our own outcome — an {@link AnalyzeAbortError} or an
     * `unreachable` {@link BackendError} — whichever way the operation reports its
     * end. A save already superseded settles before the operation starts.
     */
    private runWithAbort<T>(
        operation: (signal: AbortSignal, deadline: number) => Promise<T>,
        signal: AbortSignal,
        timeout: number,
        baseUrl: string,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (signal.aborted) {
                reject(new AnalyzeAbortError());
                return;
            }
            const deadline = Date.now() + timeout;
            const controller = new AbortController();
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                cleanup();
                reject(new AnalyzeAbortError());
                controller.abort(signal.reason);
            };
            const timer = setTimeout(() => {
                cleanup();
                const timedOut = new BackendError({
                    kind: 'unreachable',
                    logMessage: `Pipelex API request timed out after ${timeout}ms`,
                    userMessage: unreachableMessage(baseUrl),
                });
                reject(timedOut);
                controller.abort(timedOut);
            }, timeout);

            signal.addEventListener('abort', onAbort, { once: true });
            operation(controller.signal, deadline).then(
                value => { cleanup(); resolve(value); },
                error => { cleanup(); reject(error); },
            );
        });
    }

    private handleError(err: unknown, baseUrl: string): never {
        // Cancellation and our own timeout/decline pass straight through.
        if (err instanceof AnalyzeAbortError || err instanceof BackendError) {
            throw err;
        }

        if (err instanceof ApiResponseError) {
            // `/validate` is 200-diagnostic: a content verdict (valid OR invalid)
            // never throws — it returned in `analyze`. So an `ApiResponseError` here
            // is always a *no-verdict* condition. The server WAS reached — this is
            // not "unreachable". An auth rejection (401/403) gets its own kind +
            // one-click remedies; everything else (a request-shape 422, a bad
            // request, a 5xx) is a generic api-error.
            // The body is a problem document: its code names the situation, and the
            // request id is what finds the server's log lines for this request.
            const problem = readProblemSummary(err.problemDocument);
            const facts = problemFacts(problem?.code, err.requestId ?? problem?.requestId);
            const logMessage = `Pipelex API ${err.status} at ${baseUrl}: ${err.serverMessage ?? err.statusText}${facts}`;
            if (err.status === 401 || err.status === 403) {
                throw new BackendError({
                    kind: 'auth',
                    logMessage,
                    userMessage: authMessage(baseUrl, err.status),
                    actions: authActions(baseUrl),
                });
            }
            throw new BackendError({
                kind: 'api-error',
                logMessage,
                userMessage: apiResponseMessage(err, baseUrl, problem?.nextStep),
            });
        }

        if (err instanceof ApiUnreachableError) {
            throw new BackendError({
                kind: 'unreachable',
                logMessage: `Pipelex API unreachable at ${baseUrl} (${err.code ?? 'network error'})`,
                userMessage: unreachableMessage(baseUrl),
            });
        }

        // A file of the tree the API lacked could not be uploaded to the storage it
        // named, so the request was not sent. The message carries neither the
        // signed link nor storage's body, by the SDK's own rule.
        if (err instanceof MethodFileTransferError) {
            throw new BackendError({
                kind: err.code === 'unreachable' ? 'unreachable' : 'api-error',
                logMessage: `Pipelex API at ${baseUrl}: uploading a file of the method tree failed ` +
                    `(${err.code}${err.status === undefined ? '' : `, HTTP ${err.status}`}): ${err.message}`,
                userMessage: asSentence(`Pipelex API at ${baseUrl}: ${err.message}`),
            });
        }

        // The tree could not be listed (a symbolic link or a special file in it, a
        // directory it cannot read, a tree past the API's limits, no file at all), or
        // a file of it changed between the listing and the sending.
        if (err instanceof MethodTreeError) {
            throw new BackendError({
                kind: 'tree',
                logMessage: `the method tree could not be sent to ${baseUrl} (${err.code}): ${err.message}`,
                userMessage: treeRefusalMessage(err),
            });
        }

        // The client refused the tree before sending it, such as one heavier than an
        // API with no blob store takes inline. Nothing was sent.
        if (err instanceof RequestArgumentError) {
            throw new BackendError({
                kind: 'tree',
                logMessage: `the Pipelex API client refused the method tree for ${baseUrl}: ${err.message}`,
                userMessage: asSentence(`The method tree could not be sent to the Pipelex API at ${baseUrl}: ${err.message}`),
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

/**
 * The time left before `deadline`, in milliseconds, and never less than one: the
 * SDK refuses a timeout that is not positive, and a deadline just past is the
 * race's to report, its timer being due.
 */
function remainingMs(deadline: number): number {
    return Math.max(1, deadline - Date.now());
}

/**
 * The saved file's tree path under `root`: its real path relative to the root,
 * with forward slashes, in NFC, as the lister names the files it lists from the
 * root's real path. `undefined` when it lies outside the root, or when `root` is
 * null (the one-file tree of a file named alone, which a directory never is).
 */
async function treePathOf(savedPath: string, root: string | null): Promise<string | undefined> {
    if (root === null) return undefined;
    let real: string;
    try {
        real = await fs.promises.realpath(savedPath);
    } catch {
        return undefined;
    }
    const relativePath = path.relative(root, real);
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return undefined;
    }
    return relativePath.split(path.sep).join('/').normalize('NFC');
}

/** Why the saved file was not validated: its method tree does not hold it. */
function outsideTreeMessage(savedPath: string, tree: MethodTree): string {
    const root = tree.root ?? path.dirname(savedPath);
    return `${path.basename(savedPath)} was not validated: it is not a file of its method tree, rooted at ${root}, ` +
        `since the MTHDS membership rule keeps it out, by a name starting with a dot, a .gitignore pattern inside ` +
        `the tree, the manifest's exclude, or a directory such as node_modules or a virtual environment. ` +
        `The Pipelex API validates the tree a run would send, so move the file into the tree to validate it.`;
}

/**
 * Plain-text guidance for a tree the lister refused, or one of whose files
 * changed while it was being sent. The lister's own message names the file or
 * the limit; a tree past a limit also gets the ways to make it smaller, since
 * the commonest cause is a saved file whose directory, or whose `METHODS.toml`,
 * roots far more than the method.
 */
function treeRefusalMessage(err: MethodTreeError): string {
    if (err instanceof TreeLimitExceededError) {
        return `The method tree rooted at ${err.root} is too large for the Pipelex API: ${asSentence(err.message)} ` +
            `Keep the files a run does not need out of the tree with a .gitignore inside it or the exclude of ` +
            `METHODS.toml, or give the method a directory of its own.`;
    }
    return `The method tree could not be sent for validation: ${asSentence(err.message)}`;
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

/**
 * Non-auth API response (bad request, 5xx), with the next step its problem
 * document gives. Auth (401/403) is handled by {@link authMessage}.
 */
function apiResponseMessage(err: ApiResponseError, baseUrl: string, nextStep: string | undefined): string {
    const sentence = asSentence(`Pipelex API error at ${baseUrl} (HTTP ${err.status}): ${err.serverMessage ?? err.statusText}`);
    return withNextStep(sentence, nextStep);
}

/**
 * Guidance for an `is_valid:false` body that carried no readable item in its
 * required `errors[]`. The server WAS reached and returned a 200, but the
 * verdict is unusable — a backend/protocol breakdown, surfaced as an api-error.
 */
function apiInvalidContractMessage(baseUrl: string): string {
    return `Pipelex API at ${baseUrl} reported the bundle invalid but returned no error details — ` +
        `the server response is malformed. Retry; if it persists, the pipelex-api server may be out of ` +
        `date, or switch \`pipelex.backend\` to \`cli\`.`;
}

/**
 * Guidance for a 200 `/validate` body that is not a JSON object (e.g. literal
 * `null` or a primitive). The server was reached and returned 200, but the body
 * is not a verdict at all — a backend/protocol breakdown, surfaced as an api-error
 * like the missing-`errors` case above.
 */
function apiMalformedBodyMessage(baseUrl: string): string {
    return `Pipelex API at ${baseUrl} returned a malformed validation response (not a JSON verdict) — ` +
        `retry; if it persists, the pipelex-api server may be out of date, or switch ` +
        `\`pipelex.backend\` to \`cli\`.`;
}

/**
 * Plain-text guidance for a hosted API with no key available, shown by the
 * notification toast (with the {@link authActions} remedies) and as the widget's
 * lead issue. This is the first thing a new user of the default backend sees, so
 * it names where a key comes from and the command that stores it.
 */
function missingKeyMessage(baseUrl: string): string {
    return `Validating .mthds files on the Pipelex API (${baseUrl}) needs an API key. Get one at ` +
        `${PIPELEX_PLATFORM_URL}, then store it with the "Pipelex: Set Hosted API Key" command. ` +
        `To validate locally with pipelex-agent instead, set \`pipelex.backend\` to \`cli\`.`;
}

/**
 * Plain-text guidance for a 401/403, shown by the notification toast (which
 * carries the one-click remedies from {@link authActions}) and as the widget's
 * lead issue. The remedies differ by host: a hosted-API user gets a key from
 * the platform or self-hosts the open-source runner, whereas a self-hosted
 * operator configures auth on the server they run. A hosted request always
 * carried a key — with none, `analyze` stops before sending — so the hosted
 * wording is about the key being refused, not missing.
 */
function authMessage(baseUrl: string, status: number): string {
    if (isHostedPipelexApi(baseUrl)) {
        return `The hosted Pipelex API at ${baseUrl} rejected your API key (HTTP ${status}). Store a valid one ` +
            `with the "Pipelex: Set Hosted API Key" command (get a key at ${PIPELEX_PLATFORM_URL}), run the ` +
            `open-source pipelex-api locally with Docker, or switch \`pipelex.backend\` to \`cli\` to validate ` +
            `without a key.`;
    }
    return `The Pipelex API at ${baseUrl} rejected the request (HTTP ${status}) — it requires authentication. ` +
        `Set a key with the "Pipelex: Set Hosted API Key" command (or set the PIPELEX_API_KEY environment variable). ` +
        `You can also switch \`pipelex.backend\` to \`cli\` to validate locally.`;
}

/** One-click remedies for a 401/403, shown as toast actions. */
function authActions(baseUrl: string): BackendErrorAction[] {
    const actions: BackendErrorAction[] = [{ label: 'Set API Key', command: SET_API_KEY_COMMAND }];
    if (isHostedPipelexApi(baseUrl)) {
        actions.push({ label: 'Get an API Key', externalUrl: PIPELEX_PLATFORM_URL });
    }
    return actions;
}
