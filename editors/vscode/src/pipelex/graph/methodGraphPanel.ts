import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveCli } from '../validation/cliResolver';
import { spawnCli, cancelAllInflight } from '../validation/processUtils';

export class MethodGraphPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private currentUri: vscode.Uri | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private cliWarningShown = false;

    constructor(output: vscode.OutputChannel) {
        this.output = output;

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

        if (this.panel) {
            this.panel.title = `Method Graph — ${filename}`;
            this.panel.reveal(undefined, true);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'pipelexMethodGraph',
                `Method Graph — ${filename}`,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.currentUri = undefined;
            });
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

        const resolved = resolveCli();
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

        const config = vscode.workspace.getConfiguration('pipelex');
        const timeout = config.get<number>('validation.timeout', 30000);
        const filePath = uri.fsPath;
        const args = [...resolved.args, 'validate', filePath, '--graph'];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const cwd = workspaceFolder?.uri.fsPath;

        try {
            const { stdout } = await spawnCli(resolved.command, args, timeout, controller.signal, cwd);

            if (controller.signal.aborted) return;
            // Staleness check: if the user switched files while we were waiting,
            // discard this result so it doesn't overwrite the new file's graph.
            if (this.currentUri?.toString() !== uri.toString()) return;

            const result = JSON.parse(stdout);
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

    private setHtml(html: string) {
        if (this.panel) {
            this.panel.webview.html = html;
        }
    }
}

function loadingHtml(): string {
    return `<!DOCTYPE html>
<html><head><style>
body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); }
</style></head><body><p>Loading method graph...</p></body></html>`;
}

function messageHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html><head><style>
body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
       font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc);
       background: var(--vscode-editor-background, #1e1e1e); }
.msg { text-align: center; max-width: 480px; }
h2 { margin-bottom: 0.5em; }
code { background: var(--vscode-textCodeBlock-background, #2d2d2d); padding: 2px 6px; border-radius: 3px; }
</style></head><body><div class="msg"><h2>${title}</h2><p>${body}</p></div></body></html>`;
}
