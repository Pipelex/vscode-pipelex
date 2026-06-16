import * as vscode from 'vscode';
import type { ValidationErrorItem } from './types';

/**
 * The backend seam for MTHDS bundle analysis.
 *
 * Today the extension validates bundles and renders method graphs by spawning
 * the `pipelex-agent` CLI. This interface lets a second implementation — an
 * HTTP call to a Pipelex API server — sit behind the same single method, so the
 * diagnostics and graph-webview code stay backend-agnostic.
 *
 * The single `analyze()` call returns both the validation outcome and (when
 * asked) the graph, making the "one call serves both" requirement structural:
 * a save with the graph panel open never costs two round-trips.
 */

/** Opaque canonical GraphSpec transport — the webview casts it to the renderer's type. */
export type GraphSpec = unknown;

/** One `.mthds` file gathered for a bundle analysis. */
export interface BundleFile {
    /** On-disk URI — where diagnostics for errors owned by this file are placed. */
    uri: vscode.Uri;
    /**
     * The name sent to the backend (API `mthds_names[]` entry) and matched against
     * an error's `source`. Stable across backends so cross-file mapping is uniform.
     */
    name: string;
    /** File text. v1 reads from disk (CLI `--library-dir` parity). */
    content: string;
}

export interface BundleRequest {
    /** The saved/active file the analysis is anchored on (errors with no owner land here). */
    primaryUri: vscode.Uri;
    /** Every `.mthds` file in the primary's directory, including the primary itself. */
    files: BundleFile[];
    /** Working directory for the CLI spawn (the owning workspace folder). */
    cwd?: string;
    /** Per-call timeout in milliseconds. */
    timeout: number;
}

export interface AnalyzeOptions {
    /** Request the method graph in the same call. */
    withGraph: boolean;
    /** Graph layout direction forwarded to the CLI `--view` (ignored by the API path). */
    direction?: string;
}

/**
 * The validation half of an analysis. `ok` is the verdict; `errors` carries the
 * structured per-error list both backends normalize to (empty when `ok`).
 *
 * Kept as a flat shape (rather than a discriminated union) because the extension
 * tsconfig runs with `strict:false`, where boolean-literal discriminants do not
 * narrow — `errors` is simply always readable, and empty on success.
 */
export interface ValidationOutcome {
    ok: boolean;
    errors: ValidationErrorItem[];
}

export interface BundleAnalysis {
    validation: ValidationOutcome;
    /** Populated only when `withGraph` was requested. `null` when no graph is available (e.g. invalid bundle). */
    graph?: GraphSpec | null;
}

export interface ValidationBackend {
    readonly kind: 'cli' | 'api';
    analyze(request: BundleRequest, options: AnalyzeOptions, signal: AbortSignal): Promise<BundleAnalysis>;
}

/**
 * The method-graph panel, as seen by the on-save orchestrator. When the panel is
 * showing the just-saved `.mthds`, the save handler runs ONE `analyze(withGraph)`
 * and hands the result here — so save-with-panel-open is a single backend call
 * serving both diagnostics and graph, never two.
 */
export interface GraphAnalysisSink {
    isShowingMthds(uri: vscode.Uri): boolean;
    applyAnalysis(uri: vscode.Uri, analysis: BundleAnalysis): void;
    /**
     * The on-save analysis threw (backend / transport error). The panel renders
     * the failure instead of keeping the previous (now stale) graph. A no-op when
     * the panel is not currently showing `uri`.
     */
    applyBackendError(uri: vscode.Uri, err: unknown): void;
    /**
     * The on-save validation was skipped for `uri` (another tool reported errors,
     * so the validator deferred). The panel shows a short notice rather than keep a
     * stale graph. A no-op when the panel is not currently showing `uri`.
     */
    applySkipped(uri: vscode.Uri, message: string): void;
}

/** Why a backend could not produce a verdict (as opposed to producing a "bundle is invalid" verdict). */
export type BackendErrorKind =
    /** The CLI executable could not be resolved. */
    | 'not-found'
    /** The resolved CLI / API server predates a required feature. */
    | 'too-old'
    /** The API server could not be reached, or answered with something that is not a validation result. */
    | 'unreachable'
    /** The backend ran but failed for an infrastructural reason (setup error, spawn failure, unparseable output). */
    | 'infra'
    /** The user declined to send bundle contents to a remote API. */
    | 'declined';

/**
 * A backend-level failure: the backend could not produce a validation verdict.
 * Distinct from a returned `{ ok:false }` outcome, which IS a verdict (the bundle
 * is invalid). Consumers map `kind` to UX — clear stale diagnostics, optionally
 * notify, and never silently leave a wrong verdict on screen.
 */
export class BackendError extends Error {
    readonly kind: BackendErrorKind;
    /** Always logged to the output channel. */
    readonly logMessage: string;
    /** When set, shown to the user as a notification (rate-limited by the consumer). */
    readonly userMessage?: string;
    /** Populated for `too-old` so a consumer can render an upgrade hint. */
    readonly installedVersion?: string;
    readonly minVersion?: string;

    constructor(args: {
        kind: BackendErrorKind;
        logMessage: string;
        userMessage?: string;
        installedVersion?: string;
        minVersion?: string;
    }) {
        super(args.userMessage ?? args.logMessage);
        this.name = 'BackendError';
        this.kind = args.kind;
        this.logMessage = args.logMessage;
        this.userMessage = args.userMessage;
        this.installedVersion = args.installedVersion;
        this.minVersion = args.minVersion;
    }
}

/** A request was cancelled (file switched / superseded by a newer save). Consumers return silently. */
export class AnalyzeAbortError extends Error {
    constructor() {
        super('analysis aborted');
        this.name = 'AnalyzeAbortError';
    }
}
