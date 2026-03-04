import * as vscode from 'vscode';
import { runInTerminal } from './terminalRunner';

export const PIPE_HEADER_RE = /^\s*\[pipe\.([a-z][a-z0-9_]*)\]/;

/** Parse pipe headers from raw text. Exported for testing. */
export function findPipeHeaders(text: string): Array<{ name: string; line: number }> {
    const results: Array<{ name: string; line: number }> = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = PIPE_HEADER_RE.exec(lines[i]);
        if (match) {
            results.push({ name: match[1], line: i });
        }
    }
    return results;
}

export class PipeTestProvider implements vscode.Disposable {
    private controller: vscode.TestController;
    private watcher: vscode.FileSystemWatcher;
    private docChangeListener: vscode.Disposable;
    private openDocListener: vscode.Disposable;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor() {
        this.controller = vscode.tests.createTestController('pipelexPipes', 'Pipelex Pipes');

        this.controller.resolveHandler = async (item) => {
            if (!item) {
                await this.discoverAllFiles();
            } else {
                await this.resolveFileItem(item);
            }
        };

        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runHandler(request, token),
        );

        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.mthds');
        this.watcher.onDidCreate(uri => this.onFileChanged(uri));
        this.watcher.onDidChange(uri => this.onFileChanged(uri));
        this.watcher.onDidDelete(uri => this.onFileDeleted(uri));

        this.docChangeListener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'mthds') {
                this.debouncedUpdate(e.document.uri);
            }
        });

        // Discover pipes in documents as they are opened
        this.openDocListener = vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId === 'mthds') {
                this.safeUpdate(doc.uri);
            }
        });

        // Eagerly discover all .mthds files at startup
        this.discoverAllFiles().catch(() => {});
    }

    dispose() {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.openDocListener.dispose();
        this.docChangeListener.dispose();
        this.watcher.dispose();
        this.controller.dispose();
    }

    private async discoverAllFiles() {
        const files = await vscode.workspace.findFiles('**/*.mthds');
        for (const uri of files) {
            await this.updateFileItem(uri);
        }
    }

    private async resolveFileItem(item: vscode.TestItem) {
        const uri = item.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        this.parseAndSetChildren(item, findPipeHeaders(doc.getText()), uri);
    }

    private async updateFileItem(uri: vscode.Uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const headers = findPipeHeaders(text);

        if (headers.length === 0) {
            this.controller.items.delete(uri.toString());
            return;
        }

        const fileItem = this.controller.items.get(uri.toString())
            ?? this.controller.createTestItem(
                uri.toString(),
                uri.path.split('/').pop() ?? uri.toString(),
                uri,
            );
        fileItem.canResolveChildren = true;
        this.controller.items.add(fileItem);
        this.parseAndSetChildren(fileItem, headers, uri);
    }

    private parseAndSetChildren(fileItem: vscode.TestItem, headers: Array<{ name: string; line: number }>, uri: vscode.Uri) {
        const existingIds = new Set<string>();

        for (const { name, line } of headers) {
            const id = `${uri.toString()}#${name}`;
            existingIds.add(id);
            let pipeItem = fileItem.children.get(id);
            if (!pipeItem) {
                pipeItem = this.controller.createTestItem(id, name, uri);
                fileItem.children.add(pipeItem);
            }
            pipeItem.range = new vscode.Range(line, 0, line, 0);
        }

        // Remove pipes that no longer exist
        fileItem.children.forEach(child => {
            if (!existingIds.has(child.id)) {
                fileItem.children.delete(child.id);
            }
        });

        // Remove file item if no pipes remain
        if (fileItem.children.size === 0) {
            this.controller.items.delete(fileItem.id);
        }
    }

    private safeUpdate(uri: vscode.Uri) {
        this.updateFileItem(uri).catch(() => {});
    }

    private onFileChanged(uri: vscode.Uri) {
        this.safeUpdate(uri);
    }

    private onFileDeleted(uri: vscode.Uri) {
        this.controller.items.delete(uri.toString());
    }

    private debouncedUpdate(uri: vscode.Uri) {
        const key = uri.toString();
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.safeUpdate(uri);
        }, 500));
    }

    private async runHandler(request: vscode.TestRunRequest, _token: vscode.CancellationToken) {
        const run = this.controller.createTestRun(request);
        const items = request.include ?? this.gatherAllItems();

        for (const item of items) {
            run.started(item);

            // Save dirty document before running
            const uri = item.uri;
            if (uri) {
                const doc = vscode.workspace.textDocuments.find(
                    d => d.uri.toString() === uri.toString()
                );
                if (doc?.isDirty) {
                    await doc.save();
                }
            }

            if (item.children.size > 0) {
                // File-level item: run entire bundle
                if (uri) {
                    runInTerminal(uri.fsPath, uri, (quote, cmd, inputsArg) =>
                        `${quote(cmd)} run bundle ${quote(uri.fsPath)}${inputsArg}`
                    );
                }
            } else {
                // Pipe-level item: run specific pipe
                const pipeName = item.label;
                const fileUri = item.parent?.uri ?? uri;
                if (fileUri) {
                    runInTerminal(fileUri.fsPath, fileUri, (quote, cmd, inputsArg) =>
                        `${quote(cmd)} run bundle ${quote(fileUri.fsPath)} --pipe ${quote(pipeName)}${inputsArg}`,
                        pipeName,
                    );
                }
            }

            // Fire-and-forget: mark as passed after launch
            run.passed(item);
        }

        run.end();
    }

    private gatherAllItems(): vscode.TestItem[] {
        const items: vscode.TestItem[] = [];
        this.controller.items.forEach(item => items.push(item));
        return items;
    }
}
