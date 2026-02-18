import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { resolveCli } from './cliResolver';
import { locateError } from './sourceLocator';
import type { ValidationFailure, ValidationErrorItem } from './types';

const DIAGNOSTIC_SOURCE = 'pipelex-agent';

export class PipelexValidator implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly inflight = new Map<string, AbortController>();
    private readonly output: vscode.OutputChannel;
    private cliWarningShown = false;

    constructor(output: vscode.OutputChannel) {
        this.output = output;
        this.diagnostics = vscode.languages.createDiagnosticCollection('pipelex-validation');

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc))
        );
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.diagnostics.delete(doc.uri);
                this.cancelInflight(doc.uri.toString());
            })
        );
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

        const config = vscode.workspace.getConfiguration('pipelex');
        if (!config.get<boolean>('validation.enabled', true)) return;

        // Skip if the file has existing Error-severity diagnostics from other sources (e.g. LSP syntax errors)
        const existingDiags = vscode.languages.getDiagnostics(document.uri);
        const hasOtherErrors = existingDiags.some(
            d => d.severity === vscode.DiagnosticSeverity.Error && d.source !== DIAGNOSTIC_SOURCE
        );
        if (hasOtherErrors) {
            this.diagnostics.delete(document.uri);
            return;
        }

        const resolved = resolveCli();
        if (!resolved) {
            if (!this.cliWarningShown) {
                this.cliWarningShown = true;
                vscode.window.showWarningMessage(
                    'Pipelex validation: could not find pipelex-agent. ' +
                    'Install it or set pipelex.validation.agentCliPath in settings.'
                );
            }
            return;
        }

        const uriKey = document.uri.toString();
        this.cancelInflight(uriKey);

        const controller = new AbortController();
        this.inflight.set(uriKey, controller);

        const timeout = config.get<number>('validation.timeout', 30000);
        const filePath = document.uri.fsPath;
        const args = [...resolved.args, 'validate', filePath];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const cwd = workspaceFolder?.uri.fsPath;

        try {
            const stderr = await this.spawn(resolved.command, args, timeout, controller.signal, cwd);
            // exit 0 → clear diagnostics
            this.diagnostics.set(document.uri, []);
        } catch (err: any) {
            if (controller.signal.aborted) return;

            if (err.exitCode === 1 && err.stderr) {
                const json = extractJson(err.stderr as string);
                if (json) {
                    try {
                        const failure: ValidationFailure = JSON.parse(json);

                        // Setup/infrastructure errors (e.g. PipelexSetupError) are not
                        // file-level validation problems — log and skip diagnostics.
                        if (!failure.validation_errors || !Array.isArray(failure.validation_errors)) {
                            this.output.appendLine(
                                `pipelex-agent: ${failure.error_type}: ${failure.message}`
                            );
                            this.diagnostics.delete(document.uri);
                            return;
                        }

                        const diags = failure.validation_errors.map(ve =>
                            this.toDiagnostic(ve, document)
                        );
                        this.diagnostics.set(document.uri, diags);
                        return;
                    } catch {
                        // JSON parse failed — fall through to generic error
                    }
                }
                // Non-JSON stderr: log to output channel, don't pollute Problems panel
                this.output.appendLine(
                    `pipelex-agent: ${(err.stderr as string).slice(0, 500)}`
                );
                this.diagnostics.delete(document.uri);
                return;
            }

            // Other errors (timeout, spawn failure, etc.)
            this.output.appendLine(`pipelex-agent error: ${err.message ?? err}`);
        } finally {
            if (this.inflight.get(uriKey) === controller) {
                this.inflight.delete(uriKey);
            }
        }
    }

    private toDiagnostic(error: ValidationErrorItem, document: vscode.TextDocument): vscode.Diagnostic {
        const range = locateError(error, document);
        const diag = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
        diag.source = DIAGNOSTIC_SOURCE;
        if (error.error_type) {
            diag.code = error.error_type;
        }
        return diag;
    }

    private cancelInflight(uriKey: string) {
        const existing = this.inflight.get(uriKey);
        if (existing) {
            existing.abort();
            this.inflight.delete(uriKey);
        }
    }

    private spawn(command: string, args: string[], timeout: number, signal: AbortSignal, cwd?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = execFile(command, args, { timeout, maxBuffer: 1024 * 1024, cwd }, (err, _stdout, stderr) => {
                if (err) {
                    reject({ exitCode: (err as any).code ?? err.code, stderr, message: err.message });
                } else {
                    resolve(stderr);
                }
            });

            const onAbort = () => {
                proc.kill();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}

/**
 * Extract the first JSON object from stderr output, skipping WARNING lines.
 * The pipelex-agent may emit WARNING: lines before the JSON payload.
 */
export function extractJson(stderr: string): string | null {
    const idx = stderr.indexOf('{');
    if (idx === -1) return null;
    return stderr.slice(idx);
}
