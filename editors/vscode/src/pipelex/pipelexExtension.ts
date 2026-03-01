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

    // Run bundle command
    const fs = require('fs');
    const path = require('path');
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
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            let pipelexCmd = 'pipelex';
            if (workspaceFolder) {
                const venvPipelex = path.join(workspaceFolder.uri.fsPath, '.venv', 'bin', 'pipelex');
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
            const inputsArg = fs.existsSync(inputsPath) ? ` --inputs '${inputsPath}'` : '';
            terminal.show();
            terminal.sendText(`'${pipelexCmd}' run bundle '${filePath}'${inputsArg}`);
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
