import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { resolveCli } from '../validation/cliResolver';
import { spawnCli, cancelAllInflight } from '../validation/processUtils';
import { extractJson } from '../validation/pipelexValidator';
import type { ValidationFailure } from '../validation/types';
import { findTableHeader } from '../validation/sourceLocator';
import { resolveGraphConfig, getPaletteColors } from './graphConfig';
import { parseGraphspecFile } from './graphspecDetector';

export class MethodGraphPanel implements vscode.Disposable {
    private static readonly CSP_NONCE_SENTINEL = 'PIPELEX_CSP_NONCE';

    private panel: vscode.WebviewPanel | undefined;
    private currentUri: vscode.Uri | undefined;
    private sourceKind: 'mthds' | 'graphspec-json' | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private readonly extensionUri: vscode.Uri;
    private cliWarningShown = false;
    private webviewReady = false;
    private pendingData: any = null;
    private fileWatcherDebounce: ReturnType<typeof setTimeout> | undefined;

    constructor(output: vscode.OutputChannel, extensionUri: vscode.Uri) {
        this.output = output;
        this.extensionUri = extensionUri;

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (this.currentUri && doc.uri.toString() === this.currentUri.toString()) {
                    if (this.sourceKind === 'graphspec-json') {
                        this.refreshJson(doc.uri);
                    } else {
                        this.refresh(doc.uri);
                    }
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

        const resolved = resolveCli(uri);
        if (!resolved) {
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
                '<code>pipelex.validation.agentCliPath</code> in settings.'
            ));
            return;
        }

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

        const pipelexConfig = vscode.workspace.getConfiguration('pipelex');
        const timeout = pipelexConfig.get<number>('validation.timeout', 30000);
        const direction = pipelexConfig.get<string>('graph.direction', 'top_down');
        const showControllers = pipelexConfig.get<boolean>('graph.showControllers', false);
        const filePath = uri.fsPath;
        const args = [...resolved.args, 'validate', 'bundle', filePath, '--view', '--direction', direction];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const cwd = workspaceFolder?.uri.fsPath;

        try {
            const { stdout } = await spawnCli(resolved.command, args, timeout, controller.signal, cwd);

            if (controller.signal.aborted) return;
            // Staleness check: if the user switched files while we were waiting,
            // discard this result so it doesn't overwrite the new file's graph.
            if (this.currentUri?.toString() !== uri.toString()) return;

            const json = extractJson(stdout);
            if (!json) {
                this.setHtml(messageHtml('No Output', 'The CLI did not return valid JSON.'));
                return;
            }
            const result = JSON.parse(json);

            if (!result?.graphspec) {
                this.setHtml(messageHtml(
                    'No Graph Available',
                    'The CLI did not return a graphspec.'
                ));
                return;
            }

            if (controller.signal.aborted) return;
            if (this.currentUri?.toString() !== uri.toString()) return;

            await this.sendGraphspecToWebview(uri, result.graphspec, direction, showControllers);
        } catch (err: any) {
            if (controller.signal.aborted) return;
            if (this.currentUri?.toString() !== uri.toString()) return;

            if (err.exitCode === 1 && err.stderr) {
                const stderr = err.stderr as string;
                const json = extractJson(stderr);
                if (json) {
                    try {
                        const failure: ValidationFailure = JSON.parse(json);
                        if (failure.validation_errors && Array.isArray(failure.validation_errors) && failure.validation_errors.length > 0) {
                            const errors = failure.validation_errors.map(ve => ({
                                message: ve.message,
                                context: ve.pipe_code
                                    ? `pipe.${ve.pipe_code}`
                                    : ve.concept_code
                                        ? `concept.${ve.concept_code}`
                                        : undefined,
                            }));
                            this.setHtml(errorListHtml('Validation Errors', errors));
                        } else {
                            this.setHtml(messageHtml(
                                failure.error_type ?? 'Error',
                                escapeHtml(failure.message),
                            ));
                        }
                        this.output.appendLine(`pipelex-agent graph: ${stderr.slice(0, 500)}`);
                        return;
                    } catch {
                        // JSON parse failed — fall through
                    }
                }
                // Non-JSON stderr: show raw error
                this.setHtml(messageHtml('Validation Failed', escapeHtml(stderr.trim().slice(0, 500))));
                this.output.appendLine(`pipelex-agent graph: ${stderr.slice(0, 500)}`);
                return;
            }

            this.output.appendLine(`pipelex-agent graph error: ${err.message ?? err}`);
            this.setHtml(messageHtml(
                'Error',
                'An error occurred while generating the method graph. Check the output panel for details.'
            ));
        } finally {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
        }
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
                this.setHtml(messageHtml('Read Error', `Could not read file: ${escapeHtml(err.message ?? String(err))}`));
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
        const showControllers = pipelexConfig.get<boolean>('graph.showControllers', false);

        await this.sendGraphspecToWebview(uri, graphspec, direction, showControllers);
    }

    private async sendGraphspecToWebview(
        uri: vscode.Uri,
        graphspec: unknown,
        direction: string,
        showControllers: boolean,
    ) {
        if (!this.panel) return;

        const webviewHtml = this.buildWebviewHtml();
        if (!webviewHtml) {
            this.setHtml(messageHtml(
                'Webview Error',
                'Could not load graph webview assets.'
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
                nodesep: graphConfig.nodesep,
                ranksep: graphConfig.ranksep,
                edgeType: graphConfig.edgeType,
                initialZoom: graphConfig.initialZoom,
                panToTop: graphConfig.panToTop,
                paletteColors: getPaletteColors(graphConfig.palette),
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
        const stuffViewerCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'stuff-viewer.css'));
        const detailPanelCssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'detail-panel.css'));

        html = html.replace('{{XYFLOW_CSS_URI}}', xyflowCssUri.toString());
        html = html.replace('{{GRAPH_CORE_CSS_URI}}', graphCoreCssUri.toString());
        html = html.replace('{{GRAPH_CSS_URI}}', cssUri.toString());
        html = html.replace('{{STUFF_VIEWER_CSS_URI}}', stuffViewerCssUri.toString());
        html = html.replace('{{DETAIL_PANEL_CSS_URI}}', detailPanelCssUri.toString());
        html = html.replace('{{GRAPH_JS_URI}}', jsUri.toString());

        return html;
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
        if (message.type === 'updateDirection' && typeof message.value === 'string') {
            const cfg = vscode.workspace.getConfiguration('pipelex');
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            // Map Dagre format (LR/TB) back → VS Code setting (left_to_right/top_down)
            const settingValue = message.value === 'LR' ? 'left_to_right' : 'top_down';
            cfg.update('graph.direction', settingValue, target);
            return;
        }
        if (message.type === 'updateShowControllers' && typeof message.value === 'boolean') {
            const cfg = vscode.workspace.getConfiguration('pipelex');
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            cfg.update('graph.showControllers', message.value, target);
            return;
        }
        if (message.type === 'navigateToPipe' && message.pipeCode && this.currentUri) {
            if (this.sourceKind === 'graphspec-json') return;
            this.navigateToPipe(message.pipeCode);
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
            // Simple HTML (loading/message): add nonce to <style> tags, minimal CSP
            html = html.replace(/<style>/g, `<style nonce="${nonce}">`);
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">`;
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

function messageHtml(title: string, body: string): string {
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
</style></head><body><div class="msg"><h2>${title}</h2><p>${body}</p></div></body></html>`;
}

function errorListHtml(title: string, errors: { message: string; context?: string }[]): string {
    const items = errors.map(e => {
        const ctx = e.context
            ? `<span class="ctx">${escapeHtml(e.context)}</span> `
            : '';
        return `<li>${ctx}${escapeHtml(e.message)}</li>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html>
<head>
<style>
body { display: flex; align-items: flex-start; justify-content: center; min-height: 100vh; margin: 0; padding: 24px;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); box-sizing: border-box; }
.msg { max-width: 600px; width: 100%; }
h2 { margin-bottom: 0.5em; }
ul { list-style: none; padding: 0; margin: 0; }
li { padding: 6px 10px; margin-bottom: 4px; border-left: 3px solid var(--vscode-errorForeground, #f44); border-radius: 2px;
     background: var(--vscode-textCodeBlock-background, #2d2d2d); }
.ctx { font-weight: 600; color: var(--vscode-symbolIcon-fieldForeground, #75beff); margin-right: 6px; }
.ctx::after { content: ":"; }
</style></head><body><div class="msg"><h2>${escapeHtml(title)}</h2><ul>
${items}
</ul></div></body></html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
