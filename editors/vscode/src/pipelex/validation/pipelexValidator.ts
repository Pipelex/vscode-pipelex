import * as vscode from 'vscode';
import * as path from 'path';
import { cancelInflightByKey } from './processUtils';
import { gatherBundleFiles } from './bundleGather';
import { buildBundleDiagnostics } from './crossFileDiagnostics';
import { AnalyzeAbortError, BackendError } from './backend';
import type { BackendFactory } from './backendFactory';
import type { BackendErrorAction, BundleAnalysis, GraphAnalysisSink } from './backend';

const DIAGNOSTIC_SOURCE = 'pipelex';

/**
 * Runs bundle validation on save and publishes diagnostics.
 *
 * The validator is the single on-save orchestration point: one `analyze()` call
 * produces the diagnostics AND — when the method-graph panel is showing the same
 * file — the graph, which it hands to the panel (no second backend call). It
 * works against either backend (CLI / API) via {@link BackendFactory}; the
 * structured errors are placed on their owning file (cross-file diagnostics).
 */
export class PipelexValidator implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private readonly factory: BackendFactory;
    /** Per-directory record of URIs currently holding diagnostics, so a re-run clears its own stale set. */
    private readonly ownedByDir = new Map<string, vscode.Uri[]>();
    private graphSink: GraphAnalysisSink | undefined;
    private notFoundWarningShown = false;
    private lastNotifiedMessage: string | undefined;

    constructor(output: vscode.OutputChannel, factory: BackendFactory) {
        this.output = output;
        this.factory = factory;
        this.diagnostics = vscode.languages.createDiagnosticCollection('pipelex-validation');

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc))
        );
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.diagnostics.delete(doc.uri);
                cancelInflightByKey(this.inflight, doc.uri.toString());
            })
        );
    }

    /** Wire the method-graph panel so a save with the panel open is a single analyze call. */
    setGraphSink(sink: GraphAnalysisSink): void {
        this.graphSink = sink;
    }

    dispose() {
        for (const controller of this.inflight.values()) {
            controller.abort();
        }
        this.inflight.clear();
        this.diagnostics.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async onSave(document: vscode.TextDocument) {
        if (document.languageId !== 'mthds') return;
        if (document.uri.scheme !== 'file') return;

        const config = vscode.workspace.getConfiguration('pipelex', document.uri);
        if (!config.get<boolean>('validation.enabled', true)) return;

        // A new save supersedes any in-flight analysis for this file. Cancel it
        // BEFORE the early-return guards below — otherwise a stale run could resolve
        // afterwards and re-publish diagnostics we are about to clear.
        const uriKey = document.uri.toString();
        cancelInflightByKey(this.inflight, uriKey);

        // Skip if the file has existing Error-severity diagnostics from other sources (e.g. LSP syntax errors)
        const existingDiags = vscode.languages.getDiagnostics(document.uri);
        const hasOtherErrors = existingDiags.some(
            d => d.severity === vscode.DiagnosticSeverity.Error && d.source !== DIAGNOSTIC_SOURCE
        );
        if (hasOtherErrors) {
            this.clearDir(path.dirname(document.uri.fsPath));
            // Keep an open graph panel in sync: it no longer self-refreshes on save
            // when validation is enabled, so tell it this save was skipped rather
            // than let it keep showing a stale graph.
            this.graphSink?.applySkipped(
                document.uri,
                'This file has errors reported by another extension (e.g. syntax errors). Fix them and save to update the graph.',
            );
            return;
        }

        const controller = new AbortController();
        this.inflight.set(uriKey, controller);

        const dir = path.dirname(document.uri.fsPath);
        const timeout = config.get<number>('validation.timeout', 30000);
        const direction = config.get<string>('graph.direction', 'top_down');
        const withGraph = this.graphSink?.isShowingMthds(document.uri) ?? false;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        try {
            const backend = this.factory.getBackend(document.uri);
            const files = await gatherBundleFiles(document.uri);
            const analysis = await backend.analyze(
                { primaryUri: document.uri, files, cwd: workspaceFolder?.uri.fsPath, timeout },
                { withGraph, direction },
                controller.signal,
            );
            if (controller.signal.aborted) return;

            this.applyValidation(document, files, analysis);
            this.lastNotifiedMessage = undefined;

            if (withGraph) {
                // Fire-and-forget: the panel render (incl. the async error branch)
                // is independent of publishing diagnostics for this save.
                void this.graphSink?.applyAnalysis(document.uri, analysis);
            }
        } catch (err: unknown) {
            if (controller.signal.aborted || err instanceof AnalyzeAbortError) return;
            this.handleBackendError(err, dir);
            // Keep an open graph panel in sync — with validation enabled it does not
            // self-refresh on save, so without this it would keep showing the last
            // good graph after a transport/backend failure. No-ops if not showing.
            this.graphSink?.applyBackendError(document.uri, err);
        } finally {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
        }
    }

    private applyValidation(
        document: vscode.TextDocument,
        files: { uri: vscode.Uri; name: string; content: string }[],
        analysis: BundleAnalysis,
    ): void {
        const dir = path.dirname(document.uri.fsPath);
        const validation = analysis.validation;
        if (validation.ok) {
            this.setDiagnosticsForDir(dir, []);
            return;
        }
        const fileDiags = buildBundleDiagnostics({
            errors: validation.errors,
            files,
            primaryUri: document.uri,
            diagnosticSource: DIAGNOSTIC_SOURCE,
            primaryDocument: document,
        });
        this.setDiagnosticsForDir(dir, fileDiags);
    }

    private handleBackendError(err: unknown, dir: string): void {
        // Any failure to PRODUCE a verdict clears stale diagnostics for the directory.
        this.clearDir(dir);

        if (!(err instanceof BackendError)) {
            this.output.appendLine(`pipelex validation error: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }

        this.output.appendLine(`pipelex: ${err.logMessage}`);

        switch (err.kind) {
            case 'declined':
                // The user opted out of sending to a remote API — stay silent.
                return;
            case 'not-found':
                if (!this.notFoundWarningShown && err.userMessage) {
                    this.notFoundWarningShown = true;
                    vscode.window.showWarningMessage(err.userMessage);
                }
                return;
            case 'too-old':
                this.notifyOnce(
                    `Your pipelex-agent is ${err.installedVersion}, but the extension needs ` +
                    `≥ ${err.minVersion}. Upgrade pipelex and reload.`
                );
                return;
            case 'auth':
                if (err.userMessage) {
                    this.notifyOnce(err.userMessage, err.actions ?? []);
                }
                return;
            case 'unreachable':
            case 'api-error':
            case 'infra':
                if (err.userMessage) {
                    this.notifyOnce(err.userMessage);
                }
                return;
        }
    }

    /**
     * Show a notification at most once per error streak (deduped until the next
     * success). When `actions` are given they become toast buttons; selecting one
     * runs its command or opens its URL.
     */
    private notifyOnce(message: string, actions: BackendErrorAction[] = []): void {
        if (this.lastNotifiedMessage === message) return;
        this.lastNotifiedMessage = message;
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

    private setDiagnosticsForDir(dir: string, fileDiags: { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }[]): void {
        const prev = this.ownedByDir.get(dir);
        if (prev) {
            for (const uri of prev) {
                this.diagnostics.delete(uri);
            }
        }
        const next: vscode.Uri[] = [];
        for (const fd of fileDiags) {
            this.diagnostics.set(fd.uri, fd.diagnostics);
            next.push(fd.uri);
        }
        this.ownedByDir.set(dir, next);
    }

    private clearDir(dir: string): void {
        this.setDiagnosticsForDir(dir, []);
    }
}

export { extractJson } from './cliOutput';
