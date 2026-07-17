import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { buildStaticGraphSpecFromToml, staticDiagnosticsToValidationIssues } from '@pipelex/mthds-ui/static-graph';
import { cancelAllInflight } from '../validation/processUtils';
import { gatherBundleFiles } from '../validation/bundleGather';
import { resolveGraphPrimaryBundle } from '../validation/graphPrimary';
import type { GraphPrimaryBundle } from '../validation/graphPrimary';
import { resolveErrorLocations } from '../validation/crossFileDiagnostics';
import { resolveDeclaringFile } from '../validation/bundleResolution';
import { AnalyzeAbortError, BackendError } from '../validation/backend';
import type { BundleAnalysis, BundleFile, GraphAnalysisSink, ValidationBackend } from '../validation/backend';
import { CliValidationBackend } from '../validation/cliValidationBackend';
import { findTableHeader, findTableHeaderInLines } from '../validation/sourceLocator';
import { resolveGraphConfig, activeEditorGraphTheme } from './graphConfig';
import { parseGraphspecFile } from './graphspecDetector';
import { escapeHtml } from '../htmlEscape';
import { describeBackendErrorIssue, parseStaticIssueContext, validationErrorsToIssues } from './validationStatus';
import type { GraphValidationIssue, GraphValidationPayload } from './validationStatus';

/**
 * Placeholder for the CSP nonce inside the message view's Retry `<script>`.
 * `setHtml()` swaps ONLY this exact token for the real per-render nonce — it never
 * blesses a bare `<script>` tag — so escaped page content can never smuggle in an
 * executable (nonce-bearing) script even if a future interpolation forgets to escape.
 * Distinct from {@link MethodGraphPanel.CSP_NONCE_SENTINEL} so it can't be mistaken
 * for the rich graph webview.
 */
const RETRY_NONCE_SENTINEL = 'PIPELEX_RETRY_NONCE';

/** A resolved jump target for one validation-widget issue row (sparse: non-navigable rows are undefined). */
type ErrorTarget = { uri: vscode.Uri; range: vscode.Range };

/**
 * The subset of a GraphSpec the panel reads to map a clicked pipe node back to
 * its declaring file. Loosely typed on purpose: the registry's `source` field is
 * an additive, feature-detected enrichment (older CLIs omit it) and is not part
 * of the published `@pipelex/mthds-ui` GraphSpec types. The panel retains the
 * full graphspec it forwarded to the webview and reads only these fields.
 */
interface GraphspecForNav {
    nodes?: Array<{ id?: string; pipe_code?: string; domain_code?: string }>;
    pipe_registry?: Record<string, { code?: string; domain_code?: string; source?: string } | undefined>;
}

/** A clicked pipe node's resolved identity bits, recovered from the retained graphspec. */
interface PipeNodeIdentity {
    /** The node's declaring domain, when the graphspec carries it. */
    domainCode?: string;
    /** The declaring file path from `pipe_registry[domain.code].source`, when present. */
    source?: string;
}

export class MethodGraphPanel implements vscode.Disposable, GraphAnalysisSink {
    private static readonly CSP_NONCE_SENTINEL = 'PIPELEX_CSP_NONCE';

    private panel: vscode.WebviewPanel | undefined;
    private currentUri: vscode.Uri | undefined;
    private sourceKind: 'mthds' | 'graphspec-json' | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private readonly extensionUri: vscode.Uri;
    private readonly getBackend: (uri: vscode.Uri) => ValidationBackend;
    private cliWarningShown = false;
    private webviewReady = false;
    private pendingData: any = null;
    private fileWatcherDebounce: ReturnType<typeof setTimeout> | undefined;
    /**
     * Resolved jump targets for the rows of the validation widget's issue list,
     * indexed positionally (sparse — a row without a resolvable source is
     * undefined and its click no-ops). The webview navigates by index only
     * (never by path), so it can never request an arbitrary file — see
     * {@link navigateToError}.
     */
    private errorTargets: (ErrorTarget | undefined)[] = [];
    /**
     * The static analyzer's issues (+ aligned best-effort jump targets) for the
     * graph currently shown, kept so verdict updates can re-compose the issue
     * list per state: all of them while `validating`, warnings only on `valid`,
     * appended after the failure description on `error`.
     */
    private staticIssues: GraphValidationIssue[] = [];
    private staticTargets: (ErrorTarget | undefined)[] = [];
    /**
     * The validation payload the webview currently shows (state + issues).
     * Single source of truth: `setData` embeds it and `setValidationStatus`
     * updates it, so a rebuild can never resurrect a stale verdict.
     */
    private currentValidation: GraphValidationPayload | undefined;
    /**
     * The lead issue of the current `error` state (backend failure or skip
     * reason). Retained separately from {@link currentValidation} so a static
     * rebuild finishing after the verdict can re-compose `[lead, ...fresh
     * static issues]` instead of keeping the previous render's static tail.
     */
    private errorLead: GraphValidationIssue | undefined;
    /**
     * Monotonic token claimed by each graph-producing render (static rebuild or
     * graphspec-json refresh). Re-checked after every await so a superseded
     * render — e.g. an older save's slower file reads — can never post its
     * graph or issue state over a newer one for the same URI (the existing
     * `currentUri` checks only catch file switches).
     */
    private renderSequence = 0;
    /** Last backend-failure toast shown from the panel's own refresh, deduped until the next verdict. */
    private lastNotifiedMessage: string | undefined;
    /**
     * The graphspec last forwarded to the webview, retained so a `navigateToPipe`
     * click can recover the clicked node's `domain_code` and registry `source`
     * (the webview message carries only the bare `pipeCode`). Reset on every send,
     * cleared on dispose.
     */
    private currentGraphspec: unknown;

    constructor(
        output: vscode.OutputChannel,
        extensionUri: vscode.Uri,
        getBackend: (uri: vscode.Uri) => ValidationBackend = () => new CliValidationBackend(),
    ) {
        this.output = output;
        this.extensionUri = extensionUri;
        this.getBackend = getBackend;

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (!this.currentUri || doc.uri.toString() !== this.currentUri.toString()) return;
                if (this.sourceKind === 'graphspec-json') {
                    this.refreshJson(doc.uri);
                    return;
                }
                // For .mthds the static graph rebuilds immediately on every save; the
                // verdict channel depends on the validator. When validation is enabled
                // the on-save validator owns the single analyze call and hands the
                // verdict to the widget (see setGraphSink), so only rebuild the static
                // graph here; when disabled, run the full refresh (static + analyze).
                const validationEnabled = vscode.workspace
                    .getConfiguration('pipelex', doc.uri)
                    .get<boolean>('validation.enabled', true);
                if (validationEnabled) {
                    // Flip to "validating" synchronously so a fast verdict from the
                    // validator can never be overwritten by this rebuild's async reads.
                    this.currentValidation = { state: 'validating', issues: this.staticIssues };
                    void this.renderStaticGraph(doc.uri);
                } else {
                    void this.refresh(doc.uri);
                }
            })
        );

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.currentUri
                    && event.document.uri.toString() === this.currentUri.toString()
                    && !event.document.isDirty) {
                    // Document changed but is not dirty → external tool wrote to disk
                    // and the editor reloaded it. Debounce to coalesce rapid writes.
                    this.debouncedRefresh(event.document.uri, this.sourceKind === 'graphspec-json');
                }
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(async editor => {
                if (!this.panel || !editor) return;

                // If a file opened in the panel's column (e.g. user clicked
                // explorer while the graph had focus), close it there and
                // re-open it in the main editor column.
                const panelCol = this.panel.viewColumn;
                if (panelCol && editor.viewColumn === panelCol) {
                    const doc = editor.document;
                    const targetCol = panelCol > 1 ? panelCol - 1 : vscode.ViewColumn.One;
                    // Guard: if panel is already in column 1, targetCol === panelCol,
                    // re-opening would trigger this handler again → infinite loop.
                    if (targetCol === panelCol) return;
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    vscode.window.showTextDocument(doc, {
                        viewColumn: targetCol,
                        preserveFocus: false,
                    });
                    return;
                }

                if (editor.document.languageId === 'mthds' && editor.document.uri.scheme === 'file') {
                    const newUri = editor.document.uri;
                    const currentUri = this.currentUri;
                    if (!currentUri || this.sourceKind !== 'mthds') {
                        this.show(newUri);
                        return;
                    }
                    if (newUri.toString() === currentUri.toString()) {
                        return;
                    }
                    if (sameDirectory(newUri, currentUri)) {
                        const samePrimary = await resolvesToSameGraphPrimary(newUri, currentUri);
                        if (this.currentUri?.toString() !== currentUri.toString() || this.sourceKind !== 'mthds') {
                            return;
                        }
                        if (samePrimary) {
                            this.currentUri = newUri;
                            this.panel.title = `Method Graph — ${basename(newUri.fsPath)}`;
                            return;
                        }
                    }
                    this.show(newUri);
                } else if (editor.document.languageId === 'json' && editor.document.uri.scheme === 'file') {
                    const graphspec = parseGraphspecFile(editor.document.getText());
                    if (graphspec) {
                        const newUri = editor.document.uri;
                        if (!this.currentUri || newUri.toString() !== this.currentUri.toString()) {
                            this.showGraphspecJson(newUri);
                        }
                    }
                }
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => this.onColorThemeChanged())
        );

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('pipelex.graph.toolbarPosition')) {
                    void this.onToolbarPositionChanged();
                }
            })
        );
    }

    /**
     * The VS Code color theme switched. A graph in `'system'` mode (the
     * default — it follows the editor) must repaint to match; its own
     * `prefers-color-scheme` is unreliable in the webview, so the host injects
     * the resolved theme. Only the resolved `systemTheme` changes here (the
     * mode is unchanged), so re-send just that — cheap, and it leaves the
     * graphspec/viewport untouched. A manual in-graph theme pin is preserved
     * because the renderer ignores `systemTheme` unless its mode is `'system'`.
     */
    private onColorThemeChanged(): void {
        if (!this.panel || !this.webviewReady) return;
        this.panel.webview.postMessage({
            type: 'setSystemTheme',
            systemTheme: activeEditorGraphTheme(),
        });
    }

    /**
     * The `pipelex.graph.toolbarPosition` setting changed. If a graph is live,
     * re-send just the resolved anchor so the toolbar moves immediately —
     * GraphViewer reads `config.toolbarPosition` reactively, so the lightweight
     * `setToolbarPosition` message repaints the toolbar without re-running
     * analysis or resetting the viewport (mirrors onColorThemeChanged). Resolved
     * through `resolveGraphConfig` so the live update applies the exact same
     * guard + default as the initial send.
     */
    private async onToolbarPositionChanged(): Promise<void> {
        if (!this.panel || !this.webviewReady) return;
        const config = await resolveGraphConfig();
        // Re-check liveness: resolveGraphConfig is async (it reads pipelex.toml),
        // so the panel may have closed or swapped to a non-graph view meanwhile.
        if (!this.panel || !this.webviewReady) return;
        this.panel.webview.postMessage({
            type: 'setToolbarPosition',
            toolbarPosition: config.toolbarPosition,
        });
    }

    show(uri: vscode.Uri) {
        this.clearNavigationState();
        this.currentUri = uri;
        this.sourceKind = 'mthds';
        const filename = uri.fsPath.replace(/^.*[\\/]/, '');

        if (this.panel) {
            this.panel.title = `Method Graph — ${filename}`;
            this.panel.reveal(undefined, true);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'pipelexMethodGraph',
                `Method Graph — ${filename}`,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this.webviewDir()],
                }
            );
            this.wirePanel();
        }

        this.refresh(uri);
    }

    restore(panel: vscode.WebviewPanel, uri: vscode.Uri) {
        this.clearNavigationState();
        this.panel = panel;
        this.currentUri = uri;
        this.sourceKind = 'mthds';

        const filename = uri.fsPath.replace(/^.*[\\/]/, '');
        this.panel.title = `Method Graph — ${filename}`;

        // The extension path may have changed between sessions — update localResourceRoots
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.webviewDir()],
        };

        this.wirePanel();
        this.refresh(uri);
    }

    showGraphspecJson(uri: vscode.Uri) {
        this.clearNavigationState();
        this.currentUri = uri;
        this.sourceKind = 'graphspec-json';
        const filename = uri.fsPath.replace(/^.*[\\/]/, '');

        if (this.panel) {
            this.panel.title = `Run Graph — ${filename}`;
            this.panel.reveal(undefined, true);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'pipelexMethodGraph',
                `Run Graph — ${filename}`,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this.webviewDir()],
                }
            );
            this.wirePanel();
        }

        this.refreshJson(uri);
    }

    restoreGraphspecJson(panel: vscode.WebviewPanel, uri: vscode.Uri) {
        this.clearNavigationState();
        this.panel = panel;
        this.currentUri = uri;
        this.sourceKind = 'graphspec-json';

        const filename = uri.fsPath.replace(/^.*[\\/]/, '');
        this.panel.title = `Run Graph — ${filename}`;

        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.webviewDir()],
        };

        this.wirePanel();
        this.refreshJson(uri);
    }

    private webviewDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'dist', 'pipelex', 'graph', 'webview');
    }

    private wirePanel() {
        if (!this.panel) return;
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.currentUri = undefined;
            this.sourceKind = undefined;
            this.webviewReady = false;
            this.clearNavigationState();
        });
        this.panel.webview.onDidReceiveMessage(
            message => this.handleWebviewMessage(message),
            undefined,
            this.disposables,
        );
    }

    dispose() {
        if (this.fileWatcherDebounce) {
            clearTimeout(this.fileWatcherDebounce);
        }
        cancelAllInflight(this.inflight);
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private debouncedRefresh(uri: vscode.Uri, isJson = false) {
        if (this.fileWatcherDebounce) {
            clearTimeout(this.fileWatcherDebounce);
        }
        this.fileWatcherDebounce = setTimeout(() => {
            this.fileWatcherDebounce = undefined;
            if (isJson) {
                this.refreshJson(uri);
            } else {
                this.refresh(uri);
            }
        }, 500);
    }

    private async refresh(uri: vscode.Uri) {
        if (!this.panel) return;

        // Cancel ALL inflight jobs — the panel only serves one URI at a time
        cancelAllInflight(this.inflight);

        const controller = new AbortController();
        const uriKey = uri.toString();
        this.inflight.set(uriKey, controller);

        // Verdict pending — the static graph below renders immediately with the
        // widget spinning; the analyze result flips it.
        this.currentValidation = { state: 'validating', issues: this.staticIssues };

        // Show loading screen only on first load; keep the current graph visible
        // during subsequent refreshes so the viewport position is preserved.
        if (!this.webviewReady) {
            this.setHtml(loadingHtml());
        }

        // 1) Static graph, immediately — no backend involved.
        const graphPrimary = await this.renderStaticGraph(uri);
        if (!graphPrimary) {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
            return;
        }

        // 2) Verdict in the background. The graph is NOT requested (`withGraph:
        // false`): since the static-first flow, the rendered graph is the static
        // one and the backend call only produces the verdict.
        const pipelexConfig = vscode.workspace.getConfiguration('pipelex', uri);
        const timeout = pipelexConfig.get<number>('validation.timeout', 30000);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        try {
            const backend = this.getBackend(uri);
            // The CLI reads siblings via `--library-dir` itself; only the API path needs contents.
            const files = backend.kind === 'api' ? graphPrimary.files : [];
            const analysis = await backend.analyze(
                { primaryUri: graphPrimary.primaryUri, files, cwd: workspaceFolder?.uri.fsPath, timeout },
                { withGraph: false },
                controller.signal,
            );

            if (controller.signal.aborted) return;
            // Staleness check: if the user switched files while we were waiting,
            // discard this result so it doesn't overwrite the new file's status.
            if (this.currentUri?.toString() !== uri.toString()) return;

            await this.applyAnalysis(uri, analysis, graphPrimary.primaryUri);
        } catch (err: unknown) {
            if (controller.signal.aborted || err instanceof AnalyzeAbortError) return;
            if (this.currentUri?.toString() !== uri.toString()) return;
            this.notifyBackendError(err);
            this.showBackendErrorInWidget(err);
        } finally {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
        }
    }

    /**
     * Build the static graph from the bundle's files and send it to the webview
     * with the current validation payload. Never involves pipelex: the static
     * builder is best-effort and its diagnostics become widget issues (listed
     * while `validating` and folded into later verdict states).
     *
     * Returns the resolved bundle (for the follow-up analyze call), or undefined
     * when nothing was rendered (stale URI, panel closed, or unreadable files —
     * the latter falls back to the message view).
     */
    private async renderStaticGraph(uri: vscode.Uri): Promise<GraphPrimaryBundle | undefined> {
        if (!this.panel) return undefined;
        const seq = ++this.renderSequence;

        let graphPrimary: GraphPrimaryBundle;
        try {
            graphPrimary = await resolveGraphPrimaryBundle(uri);
        } catch (err: any) {
            if (!this.panel) return undefined;
            if (this.currentUri?.toString() !== uri.toString()) return undefined;
            if (seq !== this.renderSequence) return undefined;
            this.clearNavigationState();
            this.setHtml(messageHtml(
                'Read Error',
                `Could not read the bundle files: ${escapeHtml(err?.message ?? String(err))}`,
                { retry: true },
            ));
            return undefined;
        }
        if (!this.panel) return undefined;
        if (this.currentUri?.toString() !== uri.toString()) return undefined;
        if (seq !== this.renderSequence) return undefined;

        const { spec, diagnostics } = buildStaticGraphSpecFromToml(graphPrimary.files.map(f => f.content));
        this.staticIssues = staticDiagnosticsToValidationIssues(diagnostics);
        this.staticTargets = this.resolveStaticIssueTargets(this.staticIssues, graphPrimary.files);

        // Fold the fresh static issues into the widget state. While the verdict
        // is pending they ARE the list; a verdict that already landed (the
        // validator racing ahead of these file reads — e.g. an immediate skip)
        // keeps its state, but any static portion of its issue list is rebuilt
        // here so it can never retain the previous render's issues or targets.
        const current = this.currentValidation;
        if (!current || current.state === 'validating') {
            this.currentValidation = { state: 'validating', issues: this.staticIssues };
            this.errorTargets = this.staticTargets;
        } else if (current.state === 'valid') {
            const kept = this.keptStaticWarnings();
            this.currentValidation = { state: 'valid', issues: kept.issues };
            this.errorTargets = kept.targets;
        } else if (current.state === 'error' && this.errorLead) {
            this.currentValidation = { state: 'error', issues: [this.errorLead, ...this.staticIssues] };
            this.errorTargets = [undefined, ...this.staticTargets];
        }
        // `invalid` keeps the validator's own list — it has no static component.

        const config = vscode.workspace.getConfiguration('pipelex', uri);
        const direction = config.get<string>('graph.direction', 'top_down');
        const showControllers = config.get<boolean>('graph.showControllers', true);
        const foldMode = config.get<string>('graph.foldMode', 'folded');
        await this.sendGraphspecToWebview(uri, spec, direction, showControllers, foldMode, seq);
        return graphPrimary;
    }

    /** The static warnings (+ aligned targets) the `valid` state keeps visible. */
    private keptStaticWarnings(): { issues: GraphValidationIssue[]; targets: (ErrorTarget | undefined)[] } {
        const kept = this.staticIssues
            .map((issue, index) => ({ issue, target: this.staticTargets[index] }))
            .filter(entry => entry.issue.severity === 'warning');
        return { issues: kept.map(entry => entry.issue), targets: kept.map(entry => entry.target) };
    }

    /**
     * Best-effort jump targets for static issues: when a diagnostic's TOML path
     * names a `[pipe.<code>]` / `[concept.<code>]` declaration, point the row at
     * that table header in its declaring file. Rows that resolve nowhere stay
     * undefined (non-navigable) rather than jumping somewhere wrong.
     */
    private resolveStaticIssueTargets(
        issues: GraphValidationIssue[],
        files: BundleFile[],
    ): (ErrorTarget | undefined)[] {
        const linesCache = new Map<string, string[]>();
        const getLines = (file: BundleFile): string[] => {
            const key = file.uri.toString();
            let lines = linesCache.get(key);
            if (!lines) {
                lines = file.content.split(/\r\n|\r|\n/);
                linesCache.set(key, lines);
            }
            return lines;
        };
        return issues.map(issue => {
            const ref = parseStaticIssueContext(issue.context);
            if (!ref) return undefined;
            const owner = resolveDeclaringFile({ kind: ref.kind, code: ref.code, files, getLines });
            if (!owner) return undefined;
            const lines = getLines(owner);
            const line = findTableHeaderInLines(lines, ref.kind, ref.code);
            if (line === -1) return undefined;
            return { uri: owner.uri, range: new vscode.Range(line, 0, line, lines[line].length) };
        });
    }

    /** Whether the panel currently shows the method graph of this `.mthds` file. */
    isShowingMthds(uri: vscode.Uri): boolean {
        return !!this.panel
            && this.sourceKind === 'mthds'
            && this.currentUri?.toString() === uri.toString();
    }

    /**
     * Apply a verdict to the validation widget. Public so the on-save validator
     * can hand over the outcome of its single analyze call. The graph itself is
     * NOT touched — since the static-first flow, the rendered graph is the
     * static one and stays on screen whatever the verdict.
     *
     * Issue policy per state: `invalid` shows the validator's errors only (the
     * static analyzer would double-report the same problems); `valid` keeps
     * static warnings but drops static errors (contradicted by the
     * authoritative verdict).
     *
     * Async because the invalid branch resolves each error to its owning file +
     * range (a few sibling-file reads) so the issue rows can be clickable;
     * callers may fire-and-forget — a gather failure never rejects.
     *
     * `uri` is the SHOWN file (staleness checks + owning-file labels are
     * relative to it); `analysisPrimaryUri` is the bundle file the analysis
     * anchored on (`resolveGraphPrimaryBundle` — a sibling `bundle.mthds` when
     * the shown file is a helper). An error that resolves to no owning file
     * falls back to that primary, matching the Problems-panel placement, so a
     * bundle-level error never lands on the helper the user happens to view.
     */
    async applyAnalysis(uri: vscode.Uri, analysis: BundleAnalysis, analysisPrimaryUri: vscode.Uri): Promise<void> {
        if (!this.panel) return;
        if (this.sourceKind !== 'mthds') return;
        if (this.currentUri?.toString() !== uri.toString()) return;

        const validation = analysis.validation;
        this.errorLead = undefined;
        if (validation.ok) {
            this.lastNotifiedMessage = undefined;
            const kept = this.keptStaticWarnings();
            this.postValidationStatus(
                { state: 'valid', issues: kept.issues },
                kept.targets,
            );
            return;
        }

        // Invalid: place each error on its owning file + range (reusing the
        // diagnostics resolver, so the widget and the Problems panel can never
        // disagree). The CLI path resolves siblings itself, so they are gathered
        // here; a gather failure falls back to no siblings, which places every
        // error on the primary file rather than rejecting.
        let files: BundleFile[];
        try {
            files = await gatherBundleFiles(uri);
        } catch (err) {
            this.output.appendLine(
                `pipelex graph: could not gather bundle files for the validation issues: ${String(err)}`,
            );
            files = [];
        }
        // Re-check staleness: the gather above is async, so the user may have switched
        // files (or closed the panel) while sibling contents were read from disk.
        if (!this.panel) return;
        if (this.currentUri?.toString() !== uri.toString()) return;

        const primaryDocument = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === analysisPrimaryUri.toString(),
        );
        const locations = resolveErrorLocations({
            errors: validation.errors,
            files,
            primaryUri: analysisPrimaryUri,
            primaryDocument,
        });
        const issues = validationErrorsToIssues(
            validation.errors,
            // Name the owning file only when it differs from the shown one, so a
            // single-file bundle (or an error on the file you saved) stays clean.
            locations.map(loc => loc.uri.toString() !== uri.toString() ? basename(loc.uri.fsPath) : undefined),
        );
        this.postValidationStatus(
            { state: 'invalid', issues },
            locations.map(loc => ({ uri: loc.uri, range: loc.range })),
        );
    }

    /**
     * The on-save analysis threw (validator path). The static graph stays; the
     * widget flips to `error`. Notifications are the validator's job on this
     * path, so none are shown here. A no-op when the panel is not showing `uri`.
     */
    applyBackendError(uri: vscode.Uri, err: unknown): void {
        if (!this.panel) return;
        if (this.sourceKind !== 'mthds') return;
        if (this.currentUri?.toString() !== uri.toString()) return;
        this.showBackendErrorInWidget(err);
    }

    /**
     * The on-save validation was skipped for this file (another tool reported
     * errors). The static graph stays; the widget flips to `error` with the
     * skip reason as its lead issue.
     */
    applySkipped(uri: vscode.Uri, message: string): void {
        if (!this.panel) return;
        if (this.sourceKind !== 'mthds') return;
        if (this.currentUri?.toString() !== uri.toString()) return;
        this.errorLead = { severity: 'error', message, origin: 'validator' };
        this.postValidationStatus(
            { state: 'error', issues: [this.errorLead, ...this.staticIssues] },
            [undefined, ...this.staticTargets],
        );
    }

    /**
     * Update the validation widget: retain the payload (so a later `setData`
     * carries it), swap the navigation targets to match the new issue list, and
     * push a lightweight `setValidationStatus` to a live webview — the
     * `setSystemTheme` pattern: no re-layout, no viewport reset. Before the
     * webview is ready the payload rides on the pending `setData` instead.
     */
    private postValidationStatus(
        payload: GraphValidationPayload,
        targets: (ErrorTarget | undefined)[],
    ): void {
        this.currentValidation = payload;
        this.errorTargets = targets;
        if (this.webviewReady && this.panel) {
            this.panel.webview.postMessage({
                type: 'setValidationStatus',
                state: payload.state,
                issues: payload.issues,
            });
        } else if (this.pendingData) {
            this.pendingData.validation = payload;
        }
    }

    /** Flip the widget to `error`: the failure as lead issue, static issues after it. */
    private showBackendErrorInWidget(err: unknown): void {
        if (err instanceof BackendError) {
            this.output.appendLine(`pipelex graph: ${err.logMessage}`);
        } else {
            this.output.appendLine(
                `pipelex graph error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        this.errorLead = describeBackendErrorIssue(err);
        this.postValidationStatus(
            { state: 'error', issues: [this.errorLead, ...this.staticIssues] },
            [undefined, ...this.staticTargets],
        );
    }

    /**
     * Toast side-channel for the panel's own analyze failures (the open /
     * external-change path — on save the validator owns notifications). One-time
     * for a missing CLI; deduped-by-message otherwise (until the next `valid`
     * verdict), with the backend's remedies (e.g. Set API Key) as toast actions.
     */
    private notifyBackendError(err: unknown): void {
        if (!(err instanceof BackendError)) return;
        if (err.kind === 'declined') return;
        if (err.kind === 'not-found') {
            if (!this.cliWarningShown) {
                this.cliWarningShown = true;
                vscode.window.showWarningMessage(
                    'Pipelex graph: could not find pipelex-agent. ' +
                    'Install it or set pipelex.validation.agentCliPath in settings.'
                );
            }
            return;
        }
        const message = err.userMessage
            ?? (err.kind === 'too-old'
                ? `Your pipelex-agent is ${err.installedVersion ?? '?'}, but the extension needs ` +
                  `≥ ${err.minVersion ?? '?'}. Upgrade pipelex.`
                : undefined);
        if (!message || this.lastNotifiedMessage === message) return;
        this.lastNotifiedMessage = message;
        const actions = err.actions ?? [];
        if (actions.length === 0) {
            void vscode.window.showWarningMessage(message);
            return;
        }
        void vscode.window.showWarningMessage(message, ...actions.map(a => a.label)).then(choice => {
            const action = actions.find(a => a.label === choice);
            if (!action) return;
            if ('command' in action) {
                void vscode.commands.executeCommand(action.command);
            } else {
                void vscode.env.openExternal(vscode.Uri.parse(action.externalUrl));
            }
        });
    }

    private async refreshJson(uri: vscode.Uri) {
        if (!this.panel) return;
        const seq = ++this.renderSequence;

        // Show loading screen only on first load, same as the .mthds path.
        // This covers the initial ReactFlow layout pass so the user doesn't
        // see the graph flash at natural zoom before fitView kicks in.
        if (!this.webviewReady) {
            this.setHtml(loadingHtml());
        }

        let content: string;
        const openDoc = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === uri.toString()
        );
        if (openDoc) {
            content = openDoc.getText();
        } else {
            try {
                content = await fs.promises.readFile(uri.fsPath, 'utf-8');
            } catch (err: any) {
                if (this.currentUri?.toString() !== uri.toString()) return;
                if (seq !== this.renderSequence) return;
                this.clearNavigationState();
                this.setHtml(messageHtml('Read Error', `Could not read file: ${escapeHtml(err.message ?? String(err))}`, { retry: true }));
                return;
            }
        }

        if (this.currentUri?.toString() !== uri.toString()) return;
        if (seq !== this.renderSequence) return;

        const graphspec = parseGraphspecFile(content);
        if (!graphspec) {
            this.clearNavigationState();
            this.setHtml(messageHtml(
                'Invalid GraphSpec',
                'File does not contain a valid MTHDS GraphSpec JSON (missing <code>meta.format</code>, <code>nodes</code>, or <code>edges</code>).'
            ));
            return;
        }

        const pipelexConfig = vscode.workspace.getConfiguration('pipelex');
        const direction = pipelexConfig.get<string>('graph.direction', 'top_down');
        const showControllers = pipelexConfig.get<boolean>('graph.showControllers', true);
        const foldMode = pipelexConfig.get<string>('graph.foldMode', 'folded');

        await this.sendGraphspecToWebview(uri, graphspec, direction, showControllers, foldMode, seq);
    }

    private async sendGraphspecToWebview(
        uri: vscode.Uri,
        graphspec: unknown,
        direction: string,
        showControllers: boolean,
        foldMode: string,
        seq: number,
    ) {
        if (!this.panel) return;

        const webviewHtml = this.buildWebviewHtml();
        if (!webviewHtml) {
            this.setHtml(messageHtml(
                'Webview Error',
                'Could not load graph webview assets.',
                { retry: true }
            ));
            return;
        }

        const dagreDirection = direction === 'left_to_right' ? 'LR' : 'TB';
        const graphConfig = await resolveGraphConfig();

        if (this.currentUri?.toString() !== uri.toString()) return;
        if (seq !== this.renderSequence) return;

        // Retain the graphspec so a pipe-node click can recover its declaring
        // domain + registry `source` (see navigateToPipe). Set alongside the send
        // so it always matches what the webview is rendering. The navigation
        // targets are NOT reset here — they track the validation issue list
        // (postValidationStatus / renderStaticGraph), not the graphspec.
        this.currentGraphspec = graphspec;

        const setDataPayload = {
            type: 'setData',
            uri: uri.toString(),
            sourceKind: this.sourceKind,
            graphspec,
            // The validation widget state rides on setData so a fresh webview
            // paints it without waiting for a follow-up message; graphspec-json
            // views never validate, so the widget stays hidden there.
            validation: this.sourceKind === 'mthds' ? this.currentValidation : undefined,
            config: {
                direction: dagreDirection,
                showControllers,
                foldMode,
                nodesep: graphConfig.nodesep,
                ranksep: graphConfig.ranksep,
                edgeType: graphConfig.edgeType,
                initialZoom: graphConfig.initialZoom,
                panToTop: graphConfig.panToTop,
                // Anchor for the renderer's floating toolbar. GraphViewer reads
                // `config.toolbarPosition` reactively on every render, so the
                // pinned value takes effect on the next analysis / open.
                toolbarPosition: graphConfig.toolbarPosition,
                // The renderer derives its full light/dark palette from `theme`.
                // Do NOT send `paletteColors` here — GraphViewer merges it *over*
                // the theme palette, which would pin node/edge colors to one theme
                // and break the in-graph light/dark toggle.
                //
                // `theme` is the *mode* (`system`/`dark`/`light`). `system` (the
                // default) follows the editor via the injected `systemTheme`, which
                // onColorThemeChanged re-sends on every editor theme switch.
                theme: graphConfig.theme,
                systemTheme: graphConfig.systemTheme,
            },
        };

        if (this.webviewReady && this.panel) {
            this.panel.webview.postMessage(setDataPayload);
        } else {
            this.pendingData = setDataPayload;
            this.setHtml(webviewHtml);
        }
    }

    private clearNavigationState(): void {
        this.currentGraphspec = undefined;
        this.errorTargets = [];
        this.staticIssues = [];
        this.staticTargets = [];
        this.currentValidation = undefined;
        this.errorLead = undefined;
    }

    private buildWebviewHtml(): string | undefined {
        if (!this.panel) return undefined;

        const webviewDir = this.webviewDir();
        const htmlPath = vscode.Uri.joinPath(webviewDir, 'graph.html').fsPath;

        let html: string;
        try {
            html = fs.readFileSync(htmlPath, 'utf-8');
        } catch {
            return undefined;
        }

        const cssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph.css'));
        const jsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph.js'));
        const xyflowCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'xyflow.css'));
        const graphCoreCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph-core.css'));
        const graphToolbarCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph-toolbar.css'));
        const stuffViewerCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'stuff-viewer.css'));
        const detailPanelCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'detail-panel.css'));

        html = html.replace('{{XYFLOW_CSS_URI}}', xyflowCssUri.toString());
        html = html.replace('{{GRAPH_CORE_CSS_URI}}', graphCoreCssUri.toString());
        html = html.replace('{{GRAPH_TOOLBAR_CSS_URI}}', graphToolbarCssUri.toString());
        html = html.replace('{{GRAPH_CSS_URI}}', cssUri.toString());
        html = html.replace('{{STUFF_VIEWER_CSS_URI}}', stuffViewerCssUri.toString());
        html = html.replace('{{DETAIL_PANEL_CSS_URI}}', detailPanelCssUri.toString());
        html = html.replace('{{GRAPH_JS_URI}}', jsUri.toString());

        return html;
    }

    /**
     * Re-run the analysis for the file the panel is showing. Wired to the Retry
     * button on the error views so a transient failure (server starting, network
     * blip, a just-installed CLI) can be recovered without re-opening the panel.
     */
    private retry(): void {
        const uri = this.currentUri;
        if (!uri) return;
        if (this.sourceKind === 'graphspec-json') {
            void this.refreshJson(uri);
        } else {
            void this.refresh(uri);
        }
    }

    /**
     * Persist the in-graph theme toggle into the `pipelex.graph.theme` setting so
     * the choice survives panel reloads and VS Code restarts (restored via
     * resolveGraphConfig). The renderer's mode (`dark`/`light`/`system`) maps onto
     * the setting's enum (`dark`/`light`/`auto`).
     *
     * Reads and writes through the SAME unscoped accessor `resolveGraphConfig`
     * uses (graphConfig.ts) — `getConfiguration('pipelex')` with no resource — and
     * targets Workspace (when a workspace value already exists, so the toggle
     * "sticks") or otherwise Global. It deliberately never targets WorkspaceFolder:
     * the unscoped reader cannot see a folder-scoped value, so a folder write would
     * be persisted but never read back. The no-op guard compares against the
     * *effective* value including the contributed `auto` default, so toggling to
     * `system` while nothing is explicitly set does NOT pin an explicit `auto` that
     * would then clobber a `pipelex.toml` `style.theme` pin. No panel re-render is
     * triggered (there is no config-change listener for the graph), so the live
     * viewport is untouched; the value takes effect on the next analysis or open.
     */
    private async persistThemeMode(mode: string): Promise<void> {
        const value = mode === 'dark' || mode === 'light' ? mode : mode === 'system' ? 'auto' : undefined;
        if (!value) {
            this.output.appendLine(`pipelex graph: ignoring unknown theme mode "${mode}"`);
            return;
        }

        try {
            const cfg = vscode.workspace.getConfiguration('pipelex');
            const inspect = cfg.inspect<string>('graph.theme');
            const target = inspect?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;

            // Effective value the reader resolves: explicit scopes, then the
            // contributed default. Skipping the write when it matches avoids churn
            // and — when the effective value is already `auto` by default — keeps a
            // `system` toggle from pinning an explicit `auto` over a toml pin.
            const current = inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue;
            if (current === value) return;

            await cfg.update('graph.theme', value, target);
        } catch (err: any) {
            this.output.appendLine(`pipelex graph: failed to persist theme mode: ${err?.message ?? err}`);
        }
    }

    private handleWebviewMessage(message: any) {
        if (message.type === 'webviewReady') {
            this.webviewReady = true;
            if (this.pendingData && this.panel) {
                this.panel.webview.postMessage(this.pendingData);
                this.pendingData = null;
            }
            return;
        }
        if (message.type === 'retry') {
            this.retry();
            return;
        }
        if (message.type === 'themeModeChanged' && typeof message.mode === 'string') {
            void this.persistThemeMode(message.mode);
            return;
        }
        if (message.type === 'navigateToPipe' && message.pipeCode && this.currentUri) {
            if (this.sourceKind === 'graphspec-json') return;
            const domainCode = typeof message.domainCode === 'string' ? message.domainCode : undefined;
            const nodeId = typeof message.nodeId === 'string' ? message.nodeId : undefined;
            this.navigateToPipe(message.pipeCode, domainCode, nodeId);
            return;
        }
        if (message.type === 'navigateToError' && typeof message.index === 'number' && this.currentUri) {
            // Graphspec-JSON never yields validation errors, so there is nothing to jump to.
            if (this.sourceKind === 'graphspec-json') return;
            void this.navigateToError(message.index);
            return;
        }
        if (message.type === 'openExternally' && typeof message.url === 'string') {
            // Webviews can't `window.open` or render <embed type="application/pdf">,
            // so the StuffViewer routes both through here. Hand off to the OS via
            // VS Code so the user gets their default browser/PDF viewer.
            this.openExternally(message.url);
        }
    }

    private async openExternally(url: string) {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(url, true);
        } catch (err: any) {
            this.output.appendLine(`openExternally: invalid URL "${url}" — ${err.message ?? err}`);
            return;
        }
        // Only http(s) — refuse file:, vscode:, and other registered-handler schemes
        // that could be triggered by a malicious or accidental GraphSpec payload.
        if (uri.scheme !== 'http' && uri.scheme !== 'https') {
            this.output.appendLine(`openExternally: refused non-http(s) URL "${url}" (scheme: ${uri.scheme})`);
            return;
        }
        const opened = await vscode.env.openExternal(uri);
        if (!opened) {
            this.output.appendLine(`openExternally: OS declined to open "${url}"`);
        }
    }

    /**
     * Recover a clicked pipe node's identity from the retained graphspec. The
     * webview normally sends the clicked node id/domain recovered through
     * GraphViewer's `onNodeSelect`; older renderers/messages may still send only
     * the bare `pipeCode`. Prefer exact node/domain matching, then fall back to a
     * unique bare-code match. Registry keys are tried with both `domain.code` and
     * `.code` because domain-less pipes are serialized with an empty-domain key.
     */
    private lookupPipeNode(pipeCode: string, clickedDomainCode?: string, clickedNodeId?: string): PipeNodeIdentity {
        const spec = this.currentGraphspec as GraphspecForNav | undefined;
        const candidates = spec?.nodes?.filter(n => n.pipe_code === pipeCode) ?? [];
        const node =
            (clickedNodeId ? candidates.find(n => n.id === clickedNodeId) : undefined)
            ?? (clickedDomainCode !== undefined ? candidates.find(n => (n.domain_code ?? '') === clickedDomainCode) : undefined)
            ?? (candidates.length === 1 ? candidates[0] : undefined);
        const domainCode = clickedDomainCode ?? node?.domain_code;
        const source = this.lookupPipeRegistrySource(pipeCode, domainCode);
        return { domainCode, source };
    }

    private lookupPipeRegistrySource(pipeCode: string, domainCode?: string): string | undefined {
        const registry = (this.currentGraphspec as GraphspecForNav | undefined)?.pipe_registry;
        if (!registry) return undefined;

        const keys = domainCode
            ? [`${domainCode}.${pipeCode}`]
            : [`.${pipeCode}`];
        for (const key of keys) {
            const source = registry[key]?.source;
            if (source) return source;
        }

        const matches = Object.entries(registry).filter(([key, value]) => {
            const registryCode = value?.code ?? key.substring(key.lastIndexOf('.') + 1);
            if (registryCode !== pipeCode) return false;
            if (domainCode === undefined) return true;
            const registryDomain = value?.domain_code ?? key.substring(0, key.length - pipeCode.length - 1);
            return registryDomain === domainCode;
        });
        return matches.length === 1 ? matches[0][1]?.source : undefined;
    }

    /**
     * Reveal the code for a clicked pipe node, across files in the bundle.
     *
     * Resolution is source-first, scan-as-fallback (feature-detected, no version
     * floor): the registry `source` gives an exact declaring file when present
     * (so a signature/concrete split lands on the concrete implementation in a
     * sibling), else the gathered siblings are scanned for the `[pipe.<code>]`
     * declaration. When neither resolves a sibling, it falls back to the primary
     * file — today's single-file behavior. The owning file is resolved to a URI;
     * the exact line still comes from scanning the opened document, so the live
     * (possibly unsaved) buffer of the primary is honored.
     */
    private async navigateToPipe(pipeCode: string, clickedDomainCode?: string, clickedNodeId?: string) {
        const primaryUri = this.currentUri;
        if (!primaryUri) return;
        const primaryUriString = primaryUri.toString();

        try {
            const { domainCode, source } = this.lookupPipeNode(pipeCode, clickedDomainCode, clickedNodeId);

            // The CLI path doesn't gather siblings during refresh (it reads them via
            // --library-dir), so gather them here to resolve a cross-file declaration.
            // A gather failure degrades to the primary-only path rather than aborting.
            let files: BundleFile[];
            try {
                files = await gatherBundleFiles(primaryUri);
            } catch {
                files = [];
            }
            if (!this.panel || this.currentUri?.toString() !== primaryUriString) return;

            const linesCache = new Map<string, string[]>();
            const getLines = (file: BundleFile): string[] => {
                const key = file.uri.toString();
                let lines = linesCache.get(key);
                if (!lines) {
                    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
                    lines = openDoc ? textDocumentLines(openDoc) : file.content.split(/\r\n|\r|\n/);
                    linesCache.set(key, lines);
                }
                return lines;
            };

            const owner = resolveDeclaringFile({
                kind: 'pipe',
                code: pipeCode,
                domainCode,
                source,
                files,
                getLines,
            });
            const targetUri = owner?.uri ?? primaryUri;

            const document = await vscode.workspace.openTextDocument(targetUri);
            if (!this.panel || this.currentUri?.toString() !== primaryUriString) return;
            const headerLine = findTableHeader(document, 'pipe', pipeCode);
            if (headerLine === -1) {
                this.output.appendLine(`Could not find [pipe.${pipeCode}] in ${targetUri.fsPath}`);
                return;
            }

            await this.revealRangeBeside(document, document.lineAt(headerLine).range);
        } catch (err: any) {
            this.output.appendLine(`navigateToPipe error: ${err.message ?? err}`);
        }
    }

    /**
     * Open the owning file of error row `index` at its line, beside the panel.
     * The target (which may be a sibling file) comes from {@link errorTargets} —
     * the webview supplies only an index, never a path. Out-of-range indices are a
     * safe no-op, mirroring {@link navigateToPipe}'s error handling.
     */
    private async navigateToError(index: number) {
        const target = this.errorTargets[index];
        if (!target) return;

        try {
            const document = await vscode.workspace.openTextDocument(target.uri);
            await this.revealRangeBeside(document, target.range);
        } catch (err: any) {
            this.output.appendLine(`navigateToError error: ${err.message ?? err}`);
        }
    }

    /**
     * Open `document` in the column beside the panel and reveal `range`, centered
     * and selected. Shared by pipe-node navigation and error-list navigation so
     * both place the cursor identically. The target column is one left of the
     * panel (or column 1 when the panel is already leftmost).
     */
    private async revealRangeBeside(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
        const panelCol = this.panel?.viewColumn;
        const targetCol = panelCol && panelCol > 1 ? panelCol - 1 : vscode.ViewColumn.One;

        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: targetCol,
            preserveFocus: false,
        });

        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }

    private setHtml(html: string) {
        if (!this.panel) return;
        this.webviewReady = false;

        const nonce = crypto.randomBytes(16).toString('base64');
        const cspSource = this.panel.webview.cspSource;
        const isPipelexHtml = html.includes(MethodGraphPanel.CSP_NONCE_SENTINEL);

        if (isPipelexHtml) {
            // Replace all sentinel occurrences with the real nonce
            html = html.replace(new RegExp(MethodGraphPanel.CSP_NONCE_SENTINEL, 'g'), nonce);
            // Inject full CSP meta tag into <head>
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${cspSource} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src ${cspSource} https: data:; object-src ${cspSource} data: blob:; connect-src 'none';">`;
            html = html.replace('<head>', `<head>\n${cspMeta}`);
        } else {
            // Simple HTML (loading/message). Nonce the <style> tags. The only script
            // here is the error view's Retry button, whose <script> carries
            // RETRY_NONCE_SENTINEL: we substitute the nonce for that exact token only —
            // never a blanket <script> match — so escaped page content can't acquire a
            // runnable nonce, and script-src is added solely when our own script is present.
            html = html.replace(/<style>/g, `<style nonce="${nonce}">`);
            let scriptDirective = '';
            if (html.includes(RETRY_NONCE_SENTINEL)) {
                html = html.split(RETRY_NONCE_SENTINEL).join(nonce);
                scriptDirective = ` script-src 'nonce-${nonce}';`;
            }
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${scriptDirective}">`;
            html = html.replace('<head>', `<head>\n${cspMeta}`);
        }

        this.panel.webview.html = html;
    }
}

function loadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); }
</style></head><body><p>Loading method graph...</p></body></html>`;
}

/**
 * Render a simple message view — only for pre-graph failures now (webview
 * assets missing, unreadable bundle files, invalid graphspec JSON); backend
 * failures with a graph on screen go to the validation widget instead. `title`
 * is plain text and is escaped here. `body` is trusted HTML by contract —
 * callers MUST pass either a static string or their own `escapeHtml(...)` output.
 */
function messageHtml(title: string, body: string, options?: { retry?: boolean }): string {
    // The Retry button posts back to the extension (see handleWebviewMessage);
    // its single inline <script> runs under the nonce that setHtml() injects
    // for simple HTML.
    const actionsBlock = options?.retry
        ? `<p class="actions"><button id="pipelex-retry" type="button">Retry</button></p>
<script nonce="${RETRY_NONCE_SENTINEL}">
(function () {
  var vscode = acquireVsCodeApi();
  var retry = document.getElementById('pipelex-retry');
  if (retry) { retry.addEventListener('click', function () { vscode.postMessage({ type: 'retry' }); }); }
}());
</script>`
        : '';
    return `<!DOCTYPE html>
<html>
<head>
<style>
body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); }
.msg { text-align: center; max-width: 480px; }
h2 { margin-bottom: 0.5em; }
code { background: var(--vscode-textCodeBlock-background, #2d2d2d); padding: 2px 6px; border-radius: 3px; }
.actions { margin-top: 1.25em; }
button { font-family: inherit; font-size: 13px; padding: 4px 14px; cursor: pointer;
         color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
         border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
</style></head><body><div class="msg"><h2>${escapeHtml(title)}</h2><p>${body}</p>${actionsBlock}</div></body></html>`;
}

/** Last path segment of a file path, cross-platform (handles `/` and `\`). */
function basename(fsPath: string): string {
    return fsPath.replace(/^.*[\\/]/, '');
}

function sameDirectory(a: vscode.Uri, b: vscode.Uri): boolean {
    return dirname(a.fsPath) === dirname(b.fsPath);
}

async function resolvesToSameGraphPrimary(a: vscode.Uri, b: vscode.Uri): Promise<boolean> {
    try {
        const [aPrimary, bPrimary] = await Promise.all([
            resolveGraphPrimaryBundle(a),
            resolveGraphPrimaryBundle(b),
        ]);
        return aPrimary.primaryUri.toString() === bPrimary.primaryUri.toString();
    } catch {
        return false;
    }
}

function dirname(fsPath: string): string {
    const normalized = fsPath.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index === -1 ? '' : normalized.slice(0, index);
}

function textDocumentLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return lines;
}
