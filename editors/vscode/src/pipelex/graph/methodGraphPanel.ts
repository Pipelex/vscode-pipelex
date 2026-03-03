import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { resolveCli } from '../validation/cliResolver';
import { spawnCli, cancelAllInflight } from '../validation/processUtils';
import { extractJson } from '../validation/pipelexValidator';
import { findTableHeader } from '../validation/sourceLocator';
import { resolveGraphConfig, getPaletteColors } from './graphConfig';

export class MethodGraphPanel implements vscode.Disposable {
    private static readonly CSP_NONCE_SENTINEL = 'PIPELEX_CSP_NONCE';

    private panel: vscode.WebviewPanel | undefined;
    private currentUri: vscode.Uri | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private readonly extensionUri: vscode.Uri;
    private cliWarningShown = false;
    private webviewReady = false;
    private pendingData: any = null;

    constructor(output: vscode.OutputChannel, extensionUri: vscode.Uri) {
        this.output = output;
        this.extensionUri = extensionUri;

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (this.currentUri && doc.uri.toString() === this.currentUri.toString()) {
                    this.refresh(doc.uri);
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
                }
            })
        );
    }

    show(uri: vscode.Uri) {
        this.currentUri = uri;
        const filename = uri.fsPath.replace(/^.*[\\/]/, '');

        const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'dist', 'pipelex', 'graph', 'webview');

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
                    localResourceRoots: [webviewDir],
                }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.currentUri = undefined;
            });

            this.panel.webview.onDidReceiveMessage(
                message => this.handleWebviewMessage(message),
                undefined,
                this.disposables,
            );
        }

        this.refresh(uri);
    }

    dispose() {
        cancelAllInflight(this.inflight);
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
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

        this.setHtml(loadingHtml());

        const pipelexConfig = vscode.workspace.getConfiguration('pipelex');
        const timeout = pipelexConfig.get<number>('validation.timeout', 30000);
        const direction = pipelexConfig.get<string>('graph.direction', 'top_down');
        const renderer = pipelexConfig.get<string>('graph.renderer', 'classic');
        const filePath = uri.fsPath;
        const useExtensionRenderer = renderer === 'extension';
        // Build CLI flags based on renderer choice
        const graphFlags: string[] = [];
        if (useExtensionRenderer) {
            graphFlags.push('--view');
        }
        graphFlags.push('--graph'); // Always request --graph as fallback
        const args = [...resolved.args, 'validate', 'bundle', filePath, ...graphFlags, '--direction', direction];
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

            // Extension-owned webview with ViewSpec (only when explicitly selected)
            if (useExtensionRenderer && result?.viewspec) {
                const webviewHtml = this.buildWebviewHtml();
                if (!webviewHtml) {
                    this.setHtml(messageHtml(
                        'Webview Error',
                        'Could not load graph webview assets.'
                    ));
                    return;
                }
                // Map direction setting to Dagre format
                const dagreDirection = direction === 'left_to_right' ? 'LR' : 'TB';
                const graphConfig = resolveGraphConfig();

                const setDataPayload = {
                    type: 'setData',
                    viewspec: result.viewspec,
                    graphspec: result.graphspec || null,
                    config: {
                        direction: dagreDirection,
                        nodesep: graphConfig.nodesep,
                        ranksep: graphConfig.ranksep,
                        edgeType: graphConfig.edgeType,
                        initialZoom: graphConfig.initialZoom,
                        panToTop: graphConfig.panToTop,
                        paletteColors: getPaletteColors(graphConfig.palette),
                    },
                };

                // Reset webviewReady — the new HTML will reload the webview
                this.webviewReady = false;
                this.pendingData = setDataPayload;
                this.setHtml(webviewHtml);
                return;
            }

            // Classic renderer: HTML file from --graph
            const htmlPath: string | undefined = result?.graph_files?.reactflow_html;
            if (!htmlPath) {
                this.setHtml(messageHtml(
                    'No Graph Available',
                    'The CLI did not return a graph file path.'
                ));
                return;
            }

            const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');
            if (controller.signal.aborted) return;
            if (this.currentUri?.toString() !== uri.toString()) return;
            this.setHtml(htmlContent);
        } catch (err: any) {
            if (controller.signal.aborted) return;
            if (this.currentUri?.toString() !== uri.toString()) return;

            if (err.exitCode === 1 && err.stderr) {
                const stderr = err.stderr as string;
                if (stderr.includes('PipelexInterpreterError') || stderr.includes('main_pipe')) {
                    this.setHtml(messageHtml(
                        'No Main Pipe Declared',
                        'This bundle does not declare a main pipe. Add ' +
                        '<code>main_pipe = "your_pipe"</code> to generate a method graph.'
                    ));
                    return;
                }
                // General validation failure
                this.setHtml(messageHtml(
                    'Validation Failed',
                    'The bundle has validation errors. Fix them and save to retry.'
                ));
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

    private buildWebviewHtml(): string | undefined {
        if (!this.panel) return undefined;

        const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'dist', 'pipelex', 'graph', 'webview');
        const htmlPath = vscode.Uri.joinPath(webviewDir, 'graph.html').fsPath;

        let html: string;
        try {
            html = fs.readFileSync(htmlPath, 'utf-8');
        } catch {
            return undefined;
        }

        const cssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph.css'));
        const jsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'graph.js'));

        html = html.replace('{{GRAPH_CSS_URI}}', cssUri.toString());
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
        if (message.type === 'navigateToPipe' && message.pipeCode && this.currentUri) {
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

        const nonce = crypto.randomBytes(16).toString('base64');
        const cspSource = this.panel.webview.cspSource;
        const isPipelexHtml = html.includes(MethodGraphPanel.CSP_NONCE_SENTINEL);

        if (isPipelexHtml) {
            // Replace all sentinel occurrences with the real nonce
            html = html.replace(new RegExp(MethodGraphPanel.CSP_NONCE_SENTINEL, 'g'), nonce);
            // Inject full CSP meta tag into <head>
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${cspSource} https://unpkg.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src ${cspSource} https: data:; connect-src 'none';">`;
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
