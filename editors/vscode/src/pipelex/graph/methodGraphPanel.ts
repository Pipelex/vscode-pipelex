import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { cancelAllInflight } from '../validation/processUtils';
import { gatherBundleFiles } from '../validation/bundleGather';
import { resolveErrorLocations } from '../validation/crossFileDiagnostics';
import { AnalyzeAbortError, BackendError } from '../validation/backend';
import type { BackendErrorAction, BundleAnalysis, GraphAnalysisSink, ValidationBackend } from '../validation/backend';
import { CliValidationBackend } from '../validation/cliValidationBackend';
import { SET_API_KEY_COMMAND } from '../validation/apiKey';
import { findTableHeader } from '../validation/sourceLocator';
import type { ValidationErrorItem } from '../validation/types';
import { resolveGraphConfig } from './graphConfig';
import { parseGraphspecFile } from './graphspecDetector';
import { escapeHtml } from '../htmlEscape';

/**
 * Placeholder for the CSP nonce inside the error view's Retry `<script>`.
 * `setHtml()` swaps ONLY this exact token for the real per-render nonce — it never
 * blesses a bare `<script>` tag — so escaped page content can never smuggle in an
 * executable (nonce-bearing) script even if a future interpolation forgets to escape.
 * Distinct from {@link MethodGraphPanel.CSP_NONCE_SENTINEL} so it can't be mistaken
 * for the rich graph webview.
 */
const RETRY_NONCE_SENTINEL = 'PIPELEX_RETRY_NONCE';

/** Commands the message-view buttons may dispatch — a closed allowlist, not arbitrary command execution. */
const WEBVIEW_ALLOWED_COMMANDS = new Set<string>([SET_API_KEY_COMMAND]);

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
     * Resolved jump targets for the rows of the current validation-error view,
     * indexed positionally. The webview navigates by index only (never by path),
     * so it can never request an arbitrary file — see {@link navigateToError}.
     */
    private errorTargets: { uri: vscode.Uri; range: vscode.Range }[] = [];

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
                // For .mthds, the on-save validator drives ONE analyze call and hands us the
                // graph (see setGraphSink). Only self-refresh when validation is disabled, so
                // the panel still updates on save without the validator running.
                const validationEnabled = vscode.workspace
                    .getConfiguration('pipelex', doc.uri)
                    .get<boolean>('validation.enabled', true);
                if (!validationEnabled) {
                    this.refresh(doc.uri);
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
                    if (!this.currentUri || newUri.toString() !== this.currentUri.toString()) {
                        this.show(newUri);
                    }
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
    }

    show(uri: vscode.Uri) {
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

        // Show loading screen only on first load; keep the current graph visible
        // during subsequent refreshes so the viewport position is preserved.
        if (!this.webviewReady) {
            this.setHtml(loadingHtml());
        }

        const pipelexConfig = vscode.workspace.getConfiguration('pipelex', uri);
        const timeout = pipelexConfig.get<number>('validation.timeout', 30000);
        const direction = pipelexConfig.get<string>('graph.direction', 'top_down');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        try {
            const backend = this.getBackend(uri);
            // The CLI reads siblings via `--library-dir` itself; only the API path needs contents.
            const files = backend.kind === 'api' ? await gatherBundleFiles(uri) : [];
            const analysis = await backend.analyze(
                { primaryUri: uri, files, cwd: workspaceFolder?.uri.fsPath, timeout },
                { withGraph: true, direction },
                controller.signal,
            );

            if (controller.signal.aborted) return;
            // Staleness check: if the user switched files while we were waiting,
            // discard this result so it doesn't overwrite the new file's graph.
            if (this.currentUri?.toString() !== uri.toString()) return;

            await this.applyAnalysis(uri, analysis);
        } catch (err: unknown) {
            if (controller.signal.aborted || err instanceof AnalyzeAbortError) return;
            if (this.currentUri?.toString() !== uri.toString()) return;
            this.renderBackendError(err);
        } finally {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
        }
    }

    /** Whether the panel currently shows the method graph of this `.mthds` file. */
    isShowingMthds(uri: vscode.Uri): boolean {
        return !!this.panel
            && this.sourceKind === 'mthds'
            && this.currentUri?.toString() === uri.toString();
    }

    /**
     * Render a backend analysis: the graph when present, the validation errors
     * when the bundle is invalid, otherwise a "no graph" notice. Public so the
     * on-save validator can hand it the analysis from its single backend call.
     *
     * Async because the error branch resolves each error to its owning file +
     * range (a few sibling-file reads) so the rendered list can be clickable;
     * the common graph / no-graph branches stay synchronous.
     */
    async applyAnalysis(uri: vscode.Uri, analysis: BundleAnalysis): Promise<void> {
        if (!this.panel) return;
        if (this.currentUri?.toString() !== uri.toString()) return;

        if (analysis.graph) {
            const config = vscode.workspace.getConfiguration('pipelex', uri);
            const direction = config.get<string>('graph.direction', 'top_down');
            const showControllers = config.get<boolean>('graph.showControllers', true);
            const foldMode = config.get<string>('graph.foldMode', 'folded');
            void this.sendGraphspecToWebview(uri, analysis.graph, direction, showControllers, foldMode);
            return;
        }

        const validation = analysis.validation;
        if (!validation.ok && validation.errors.length > 0) {
            await this.renderValidationErrors(uri, validation.errors);
            return;
        }

        this.setHtml(messageHtml('No Graph Available', 'The bundle did not produce a method graph.'));
    }

    /**
     * Render the structured validation errors as a clickable list. Each error is
     * resolved to its owning file + range (reusing the diagnostics resolver, so the
     * panel and the Problems panel can never disagree) and stashed in
     * {@link errorTargets} for index-based navigation.
     */
    private async renderValidationErrors(uri: vscode.Uri, errors: ValidationErrorItem[]): Promise<void> {
        // The CLI path resolves siblings itself, so `refresh()` does not gather them;
        // the clickable list needs their contents to place an error on its owning file.
        // A gather failure (transient read error, deleted primary file) must NOT reject:
        // the validator calls applyAnalysis fire-and-forget, so an unhandled rejection
        // would leave the previous graph stale instead of showing the verdict. Fall back
        // to no siblings — resolveErrorLocations then places every error on the primary
        // file (non-clickable to siblings) rather than throwing.
        let files: Awaited<ReturnType<typeof gatherBundleFiles>>;
        try {
            files = await gatherBundleFiles(uri);
        } catch (err) {
            this.output.appendLine(
                `pipelex graph: could not gather bundle files for the error view: ${String(err)}`,
            );
            files = [];
        }
        // Re-check staleness: the gather above is async, so the user may have switched
        // files (or closed the panel) while sibling contents were read from disk.
        if (!this.panel) return;
        if (this.currentUri?.toString() !== uri.toString()) return;

        const primaryDocument = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === uri.toString(),
        );
        const locations = resolveErrorLocations({ errors, files, primaryUri: uri, primaryDocument });

        this.errorTargets = locations.map(loc => ({ uri: loc.uri, range: loc.range }));

        const entries: ErrorListEntry[] = locations.map((loc, index) => ({
            index,
            message: loc.error.message,
            context: errorContext(loc.error),
            // Name the owning file only when it differs from the saved one, so a
            // single-file bundle (or an error on the file you saved) stays clean.
            file: loc.uri.toString() !== uri.toString() ? basename(loc.uri.fsPath) : undefined,
        }));

        this.setHtml(errorListHtml(entries));
    }

    /**
     * The on-save analysis threw. Render the failure rather than leave a stale
     * graph — with validation enabled the panel no longer self-refreshes on save,
     * so the validator drives this for the file it is showing.
     */
    applyBackendError(uri: vscode.Uri, err: unknown): void {
        if (!this.panel) return;
        if (this.currentUri?.toString() !== uri.toString()) return;
        this.renderBackendError(err);
    }

    /**
     * The on-save validation was skipped for this file (another tool reported
     * errors). Replace the stale graph with a short notice.
     */
    applySkipped(uri: vscode.Uri, message: string): void {
        if (!this.panel) return;
        if (this.currentUri?.toString() !== uri.toString()) return;
        this.setHtml(messageHtml('Graph Unavailable', escapeHtml(message)));
    }

    private renderBackendError(err: unknown): void {
        if (err instanceof BackendError) {
            switch (err.kind) {
                case 'not-found':
                    if (!this.cliWarningShown) {
                        this.cliWarningShown = true;
                        vscode.window.showWarningMessage(
                            'Pipelex graph: could not find pipelex-agent. ' +
                            'Install it or set pipelex.validation.agentCliPath in settings.'
                        );
                    }
                    this.setHtml(messageHtml(
                        'CLI Not Found',
                        'Could not find <code>pipelex-agent</code>. Install it or set ' +
                        '<code>pipelex.validation.agentCliPath</code> in settings.',
                        { retry: true }
                    ));
                    return;
                case 'too-old':
                    this.output.appendLine(err.logMessage);
                    this.setHtml(messageHtml(
                        'Update Pipelex',
                        `Your installed <code>pipelex-agent</code> is <strong>${escapeHtml(err.installedVersion ?? '?')}</strong>, ` +
                        `but the method graph requires <strong>≥ ${escapeHtml(err.minVersion ?? '?')}</strong> ` +
                        `(structured validation errors landed in that release).` +
                        `</p><p>` +
                        `Upgrade Pipelex and try again:<br>` +
                        `<code>mthds runner setup pipelex</code> (mthds-managed install)<br>` +
                        `<code>uv tool upgrade pipelex</code> (uv tool install)<br>` +
                        `<code>uv pip install -U pipelex</code> or <code>pip install -U pipelex</code> (project virtualenv)`,
                        { retry: true }
                    ));
                    return;
                case 'unreachable':
                    this.output.appendLine(err.logMessage);
                    this.setHtml(messageHtml('Pipelex API Unreachable', escapeHtml(err.userMessage ?? err.logMessage), { retry: true }));
                    return;
                case 'api-error':
                    this.output.appendLine(err.logMessage);
                    this.setHtml(messageHtml('Pipelex API Error', escapeHtml(err.userMessage ?? err.logMessage), { retry: true }));
                    return;
                case 'auth':
                    this.output.appendLine(err.logMessage);
                    this.setHtml(messageHtml(
                        'Pipelex API Key Required',
                        err.detailHtml ?? escapeHtml(err.userMessage ?? err.logMessage),
                        { retry: true, actions: (err.actions ?? []).map(toPanelAction) },
                    ));
                    return;
                case 'declined':
                    this.setHtml(messageHtml('Not Sent', 'Sending bundle contents to the remote Pipelex API was declined.', { retry: true }));
                    return;
                case 'infra':
                    this.output.appendLine(err.logMessage);
                    this.setHtml(messageHtml('Validation Failed', escapeHtml(err.logMessage.slice(0, 500)), { retry: true }));
                    return;
            }
        }
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`pipelex graph error: ${message}`);
        this.setHtml(messageHtml(
            'Error',
            'An error occurred while generating the method graph. Check the output panel for details.',
            { retry: true }
        ));
    }

    private async refreshJson(uri: vscode.Uri) {
        if (!this.panel) return;

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
                this.setHtml(messageHtml('Read Error', `Could not read file: ${escapeHtml(err.message ?? String(err))}`, { retry: true }));
                return;
            }
        }

        const graphspec = parseGraphspecFile(content);
        if (!graphspec) {
            this.setHtml(messageHtml(
                'Invalid GraphSpec',
                'File does not contain a valid MTHDS GraphSpec JSON (missing <code>meta.format</code>, <code>nodes</code>, or <code>edges</code>).'
            ));
            return;
        }

        if (this.currentUri?.toString() !== uri.toString()) return;

        const pipelexConfig = vscode.workspace.getConfiguration('pipelex');
        const direction = pipelexConfig.get<string>('graph.direction', 'top_down');
        const showControllers = pipelexConfig.get<boolean>('graph.showControllers', true);
        const foldMode = pipelexConfig.get<string>('graph.foldMode', 'folded');

        await this.sendGraphspecToWebview(uri, graphspec, direction, showControllers, foldMode);
    }

    private async sendGraphspecToWebview(
        uri: vscode.Uri,
        graphspec: unknown,
        direction: string,
        showControllers: boolean,
        foldMode: string,
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

        const setDataPayload = {
            type: 'setData',
            uri: uri.toString(),
            sourceKind: this.sourceKind,
            graphspec,
            config: {
                direction: dagreDirection,
                showControllers,
                foldMode,
                nodesep: graphConfig.nodesep,
                ranksep: graphConfig.ranksep,
                edgeType: graphConfig.edgeType,
                initialZoom: graphConfig.initialZoom,
                panToTop: graphConfig.panToTop,
                // The renderer derives its full light/dark palette from `theme`.
                // Do NOT send `paletteColors` here — GraphViewer merges it *over*
                // the theme palette, which would pin node/edge colors to one theme
                // and break the in-graph light/dark toggle.
                theme: graphConfig.theme,
            },
        };

        if (this.webviewReady && this.panel) {
            this.panel.webview.postMessage(setDataPayload);
        } else {
            this.pendingData = setDataPayload;
            this.setHtml(webviewHtml);
        }
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
        if (message.type === 'runCommand' && typeof message.command === 'string') {
            // Only commands we explicitly expose — never an arbitrary command from the webview.
            if (WEBVIEW_ALLOWED_COMMANDS.has(message.command)) {
                void vscode.commands.executeCommand(message.command);
            } else {
                this.output.appendLine(`runCommand: refused non-whitelisted command "${message.command}"`);
            }
            return;
        }
        if (message.type === 'navigateToPipe' && message.pipeCode && this.currentUri) {
            if (this.sourceKind === 'graphspec-json') return;
            this.navigateToPipe(message.pipeCode);
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

    private async navigateToPipe(pipeCode: string) {
        if (!this.currentUri) return;

        try {
            const document = await vscode.workspace.openTextDocument(this.currentUri);
            const headerLine = findTableHeader(document, 'pipe', pipeCode);
            if (headerLine === -1) {
                this.output.appendLine(`Could not find [pipe.${pipeCode}] in ${this.currentUri.fsPath}`);
                return;
            }

            const panelCol = this.panel?.viewColumn;
            const targetCol = panelCol && panelCol > 1 ? panelCol - 1 : vscode.ViewColumn.One;

            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: targetCol,
                preserveFocus: false,
            });

            const range = document.lineAt(headerLine).range;
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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

            const panelCol = this.panel?.viewColumn;
            const targetCol = panelCol && panelCol > 1 ? panelCol - 1 : vscode.ViewColumn.One;

            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: targetCol,
                preserveFocus: false,
            });

            editor.selection = new vscode.Selection(target.range.start, target.range.end);
            editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
        } catch (err: any) {
            this.output.appendLine(`navigateToError error: ${err.message ?? err}`);
        }
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

/** A button rendered in a message view; clicking it posts `message` back to the extension. */
interface PanelAction {
    label: string;
    message: Record<string, unknown>;
}

/**
 * Convert a backend remedy into a pane button. The posted message is one the
 * webview handler explicitly allows (a whitelisted command, or an http(s) open);
 * the webview never gets to run an arbitrary command.
 */
function toPanelAction(action: BackendErrorAction): PanelAction {
    if ('command' in action) {
        return { label: action.label, message: { type: 'runCommand', command: action.command } };
    }
    return { label: action.label, message: { type: 'openExternally', url: action.externalUrl } };
}

/**
 * Render a simple message view. `title` is plain text and is escaped here. `body`
 * is trusted HTML by contract — callers MUST pass either a static string, their own
 * `escapeHtml(...)` output, or pre-escaped HTML (e.g. `BackendError.detailHtml`).
 */
function messageHtml(title: string, body: string, options?: { retry?: boolean; actions?: PanelAction[] }): string {
    // Buttons post back to the extension (see handleWebviewMessage); the single
    // inline <script> runs under the nonce that setHtml() injects for simple HTML.
    // Remedy buttons come first, Retry last.
    const actions = options?.actions ?? [];
    const buttons: string[] = actions.map(
        (a, i) => `<button class="pipelex-action" data-action-index="${i}" type="button">${escapeHtml(a.label)}</button>`,
    );
    if (options?.retry) {
        buttons.push(`<button id="pipelex-retry" type="button">Retry</button>`);
    }
    // JSON of each action's message, hardened against a `</script>` breakout even
    // though every message here is built from our own constants, not server input.
    const actionMessagesJson = JSON.stringify(actions.map(a => a.message)).replace(/</g, '\\u003c');
    const actionsBlock = buttons.length
        ? `<p class="actions">${buttons.join(' ')}</p>
<script nonce="${RETRY_NONCE_SENTINEL}">
(function () {
  var vscode = acquireVsCodeApi();
  var retry = document.getElementById('pipelex-retry');
  if (retry) { retry.addEventListener('click', function () { vscode.postMessage({ type: 'retry' }); }); }
  var messages = ${actionMessagesJson};
  var actionButtons = document.querySelectorAll('.pipelex-action');
  for (var i = 0; i < actionButtons.length; i++) {
    (function (idx) {
      actionButtons[idx].addEventListener('click', function () { vscode.postMessage(messages[idx]); });
    })(i);
  }
  // Inline links open externally via the extension (preventDefault stops the
  // webview from trying to navigate to them itself).
  var links = document.querySelectorAll('a.pipelex-link');
  for (var j = 0; j < links.length; j++) {
    links[j].addEventListener('click', function (e) {
      e.preventDefault();
      var href = this.getAttribute('href');
      if (href) { vscode.postMessage({ type: 'openExternally', url: href }); }
    });
  }
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
a.pipelex-link { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline; cursor: pointer; }
a.pipelex-link:hover { color: var(--vscode-textLink-activeForeground, #4daafc); }
.actions { margin-top: 1.25em; }
button { font-family: inherit; font-size: 13px; padding: 4px 14px; cursor: pointer;
         color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
         border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
</style></head><body><div class="msg"><h2>${escapeHtml(title)}</h2><p>${body}</p>${actionsBlock}</div></body></html>`;
}

/** One row in the clickable validation-error list. `index` keys into {@link MethodGraphPanel.errorTargets}. */
interface ErrorListEntry {
    index: number;
    message: string;
    /** `pipe.<code>` / `concept.<code>`, when the error names one. */
    context?: string;
    /** Owning-file basename, set only when the error lives in a sibling (not the saved file). */
    file?: string;
}

/** The `pipe.<code>` / `concept.<code>` chip for an error, or undefined when it names neither. */
function errorContext(error: ValidationErrorItem): string | undefined {
    return error.pipe_code
        ? `pipe.${error.pipe_code}`
        : error.concept_code
            ? `concept.${error.concept_code}`
            : undefined;
}

/** Last path segment of a file path, cross-platform (handles `/` and `\`). */
function basename(fsPath: string): string {
    return fsPath.replace(/^.*[\\/]/, '');
}

/**
 * Render the validation errors as a clickable list. Each row posts
 * `{ type: 'navigateToError', index }` (never a path) so the extension can open
 * the owning file at the error's line. The single inline `<script>` carries
 * {@link RETRY_NONCE_SENTINEL}: `setHtml()` swaps that token for the real nonce
 * and adds `script-src` only because our own script is present — escaped page
 * content can never acquire a runnable nonce.
 */
function errorListHtml(entries: ErrorListEntry[]): string {
    const count = entries.length;
    const heading = `${count} ${count === 1 ? 'Validation Error' : 'Validation Errors'}`;
    const items = entries.map(e => {
        const ctx = e.context ? `<span class="ctx">${escapeHtml(e.context)}</span>` : '';
        const file = e.file ? `<span class="file">${escapeHtml(e.file)}</span>` : '';
        const meta = (ctx || file) ? `<div class="meta">${ctx}${file}</div>` : '';
        // `data-error-index` is our own integer, not page content; the message is escaped.
        return `<li class="error-row" role="button" tabindex="0" data-error-index="${e.index}">`
            + `${meta}<div class="message">${escapeHtml(e.message)}</div></li>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html>
<head>
<style>
body { display: flex; align-items: flex-start; justify-content: center; min-height: 100vh; margin: 0; padding: 24px;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); box-sizing: border-box; }
.msg { max-width: 600px; width: 100%; }
h2 { margin-bottom: 0.25em; }
.hint { margin: 0 0 1.25em; color: var(--vscode-descriptionForeground, #999); }
ul { list-style: none; padding: 0; margin: 0; }
li.error-row { padding: 6px 10px; margin-bottom: 4px; border-left: 3px solid var(--vscode-errorForeground, #f44);
     border-radius: 2px; background: var(--vscode-textCodeBlock-background, #2d2d2d); cursor: pointer; }
li.error-row:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
li.error-row:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.meta { margin-bottom: 2px; }
.ctx { font-weight: 600; color: var(--vscode-symbolIcon-fieldForeground, #75beff); margin-right: 8px; }
.ctx::after { content: ":"; }
.file { font-size: 0.85em; color: var(--vscode-descriptionForeground, #999); }
.message { white-space: pre-wrap; }
.actions { margin-top: 1.25em; }
button { font-family: inherit; font-size: 13px; padding: 4px 14px; cursor: pointer;
         color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
         border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
</style></head><body><div class="msg"><h2>${escapeHtml(heading)}</h2>
<p class="hint">Fix and save to regenerate the graph.</p>
<ul>
${items}
</ul>
<p class="actions"><button id="pipelex-retry" type="button">Retry</button></p>
<script nonce="${RETRY_NONCE_SENTINEL}">
(function () {
  var vscode = acquireVsCodeApi();
  var retry = document.getElementById('pipelex-retry');
  if (retry) { retry.addEventListener('click', function () { vscode.postMessage({ type: 'retry' }); }); }
  var rows = document.querySelectorAll('.error-row');
  for (var i = 0; i < rows.length; i++) {
    (function (row) {
      var idx = parseInt(row.getAttribute('data-error-index'), 10);
      function go() { vscode.postMessage({ type: 'navigateToError', index: idx }); }
      row.addEventListener('click', go);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    })(rows[i]);
  }
}());
</script>
</div></body></html>`;
}

