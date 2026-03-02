import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';
import { getOutput } from '../util';

/**
 * Register all Pipelex-specific features for MTHDS support
 */
export async function registerPipelexFeatures(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('pipelex');
    const semanticTokensEnabled = config.get<boolean>('mthds.semanticTokens', true);

    if (semanticTokensEnabled) {
        const provider = new PipelexSemanticTokensProvider();
        context.subscriptions.push(
            vscode.languages.registerDocumentSemanticTokensProvider(
                { language: 'mthds' },
                provider,
                provider.getSemanticTokensLegend()
            )
        );
    }

    // Validator and graph panel require child_process (Node host only)
    try {
        await registerNodeFeatures(context, config);
    } catch (err: any) {
        const output = getOutput();
        output.appendLine(`Pipelex: failed to register Node features: ${err.message ?? err}`);
        vscode.window.showWarningMessage(
            'Pipelex: some features could not be loaded. Check the output panel for details.'
        );
    }

    const PLX_DISMISSED_KEY = 'pipelex.plxDeprecationDismissed';
    if (!context.globalState.get<boolean>(PLX_DISMISSED_KEY)) {
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.uri.fsPath.endsWith('.plx') &&
                    !context.globalState.get<boolean>(PLX_DISMISSED_KEY)) {
                    vscode.window.showWarningMessage(
                        'The .plx file extension is deprecated. Please rename your files to .mthds.',
                        "Don't Show Again"
                    ).then(choice => {
                        if (choice === "Don't Show Again") {
                            context.globalState.update(PLX_DISMISSED_KEY, true);
                        }
                    });
                }
            })
        );
    }
}

/**
 * Register features that depend on Node.js APIs (child_process).
 * Skipped when running in a browser host (e.g. vscode.dev).
 */
async function registerNodeFeatures(
    context: vscode.ExtensionContext,
    config: vscode.WorkspaceConfiguration,
) {
    // In browser environments, child_process is unavailable
    try {
        require('child_process');
    } catch {
        return;
    }

    // Pipelex-agent validation on save
    const validationEnabled = config.get<boolean>('validation.enabled', true);
    if (validationEnabled) {
        const { PipelexValidator } = await import('./validation/pipelexValidator');
        const validator = new PipelexValidator(getOutput());
        context.subscriptions.push(validator);
    }

    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    /** Resolve pipelex command, get/create terminal, and send a command string. */
    function runInTerminal(filePath: string, uri: vscode.Uri, buildCmd: (quote: (s: string) => string, pipelexCmd: string, inputsArg: string) => string) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const isWindows = process.platform === 'win32';
        let pipelexCmd = 'pipelex';
        if (workspaceFolder) {
            const venvPipelex = path.join(
                workspaceFolder.uri.fsPath,
                isWindows ? path.join('.venv', 'Scripts', 'pipelex.exe')
                          : path.join('.venv', 'bin', 'pipelex'),
            );
            if (fs.existsSync(venvPipelex)) {
                pipelexCmd = venvPipelex;
            }
        }
        const terminalName = 'Pipelex';
        let terminal = vscode.window.terminals.find(t => t.name === terminalName);
        if (!terminal) {
            terminal = vscode.window.createTerminal({ name: terminalName });
        }
        const inputsPath = path.join(path.dirname(filePath), 'inputs.json');
        const quote = isWindows ? winQuote : shellQuote;
        const inputsArg = fs.existsSync(inputsPath) ? ` --inputs ${quote(inputsPath)}` : '';
        terminal.show();
        const callOp = isWindows ? '& ' : '';
        terminal.sendText(`${callOp}${buildCmd(quote, pipelexCmd, inputsArg)}`);
    }

    // Run bundle command
    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.runBundle', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'mthds') {
                vscode.window.showWarningMessage('Open an MTHDS file to run.');
                return;
            }
            if (editor.document.isDirty) {
                await editor.document.save();
            }
            const filePath = editor.document.uri.fsPath;
            runInTerminal(filePath, editor.document.uri, (quote, cmd, inputsArg) =>
                `${quote(cmd)} run bundle ${quote(filePath)}${inputsArg}`
            );
        })
    );

    // Run individual pipe command (invoked from CodeLens)
    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.runPipe', async (uri: vscode.Uri, pipeName: string) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.toString() === uri.toString() && editor.document.isDirty) {
                await editor.document.save();
            }
            const filePath = uri.fsPath;
            runInTerminal(filePath, uri, (quote, cmd, inputsArg) =>
                `${quote(cmd)} run bundle ${quote(filePath)} --pipe ${quote(pipeName)}${inputsArg}`
            );
        })
    );

    // Register CodeLens provider for pipe headers (togglable via setting)
    const { PipeCodeLensProvider } = await import('./pipeCodeLensProvider');
    let codeLensRegistration: vscode.Disposable | undefined;

    function registerCodeLens() {
        codeLensRegistration = vscode.languages.registerCodeLensProvider(
            { language: 'mthds' },
            new PipeCodeLensProvider()
        );
    }

    if (config.get<boolean>('mthds.runPipeCodeLens', true)) {
        registerCodeLens();
    }

    // Dispose the CodeLens registration on extension deactivation
    context.subscriptions.push({ dispose: () => codeLensRegistration?.dispose() });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('pipelex.mthds.runPipeCodeLens')) {
                const enabled = vscode.workspace.getConfiguration('pipelex')
                    .get<boolean>('mthds.runPipeCodeLens', true);
                if (enabled && !codeLensRegistration) {
                    registerCodeLens();
                } else if (!enabled && codeLensRegistration) {
                    codeLensRegistration.dispose();
                    codeLensRegistration = undefined;
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.toggleRunPipeCodeLens', () => {
            const cfg = vscode.workspace.getConfiguration('pipelex');
            const current = cfg.get<boolean>('mthds.runPipeCodeLens', true);
            cfg.update('mthds.runPipeCodeLens', !current);
        })
    );

    // Method graph webview panel
    const { MethodGraphPanel } = await import('./graph/methodGraphPanel');
    const graphPanel = new MethodGraphPanel(getOutput());
    context.subscriptions.push(graphPanel);
    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.showMethodGraph', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'mthds') {
                vscode.window.showWarningMessage('Open an MTHDS file to view the method graph.');
                return;
            }
            graphPanel.show(editor.document.uri);
        })
    );
}

/** Escape a string for safe use in a POSIX shell command. */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for safe use in PowerShell (single-quoted literal). */
function winQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}
