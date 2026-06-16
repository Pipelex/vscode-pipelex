import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';
import { getOutput } from '../util';
import { registerApiKeyCommands } from './validation/apiKey';

/**
 * Register all Pipelex-specific features for MTHDS support
 */
export async function registerPipelexFeatures(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('pipelex');
    const semanticTokensEnabled = config.get<boolean>('mthds.semanticTokens', true);

    // Hosted API key commands (SecretStorage). Available in any host — SecretStorage
    // does not depend on child_process, unlike the validator/graph features below.
    registerApiKeyCommands(context);

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

    // The backend factory selects CLI vs API per `pipelex.backend`; it is shared by
    // the validator and the graph panel so version-gate / remote-consent state is one copy.
    const { BackendFactory } = await import('./validation/backendFactory');
    const factory = new BackendFactory(context, getOutput());

    // Bundle validation on save
    const validationEnabled = config.get<boolean>('validation.enabled', true);
    let validator: import('./validation/pipelexValidator').PipelexValidator | undefined;
    if (validationEnabled) {
        const { PipelexValidator } = await import('./validation/pipelexValidator');
        validator = new PipelexValidator(getOutput(), factory);
        context.subscriptions.push(validator);
    }

    const { runInTerminal } = await import('./terminalRunner');

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
    // Pipe test provider (gutter play icons via Testing API)
    const { PipeTestProvider } = await import('./pipeTestProvider');
    const pipeTestProvider = new PipeTestProvider();
    context.subscriptions.push(pipeTestProvider);

    // Method graph webview panel
    const { MethodGraphPanel } = await import('./graph/methodGraphPanel');
    const { isGraphspecJson } = await import('./graph/graphspecDetector');
    const graphPanel = new MethodGraphPanel(getOutput(), context.extensionUri, uri => factory.getBackend(uri));
    context.subscriptions.push(graphPanel);

    // On save, the validator drives ONE analyze call and hands the graph to the panel
    // (no second backend round-trip when the panel is open).
    validator?.setGraphSink(graphPanel);

    // Context key: set pipelex.isGraphspecJson when the active editor is a valid GraphSpec JSON
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            let isGraphspec = false;
            if (editor?.document.languageId === 'json' && editor.document.uri.scheme === 'file') {
                try {
                    isGraphspec = isGraphspecJson(editor.document.getText());
                } catch { /* ignore */ }
            }
            vscode.commands.executeCommand('setContext', 'pipelex.isGraphspecJson', isGraphspec);
        })
    );

    // Initialize context key for the already-active editor (the event doesn't fire for it)
    {
        const activeEditor = vscode.window.activeTextEditor;
        let isGraphspec = false;
        if (activeEditor?.document.languageId === 'json' && activeEditor.document.uri.scheme === 'file') {
            try {
                isGraphspec = isGraphspecJson(activeEditor.document.getText());
            } catch { /* ignore */ }
        }
        vscode.commands.executeCommand('setContext', 'pipelex.isGraphspecJson', isGraphspec);
    }

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('pipelexMethodGraph', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
                if (state?.uri) {
                    const uri = vscode.Uri.parse(state.uri);
                    if (state.sourceKind === 'graphspec-json') {
                        graphPanel.restoreGraphspecJson(panel, uri);
                    } else {
                        graphPanel.restore(panel, uri);
                    }
                } else {
                    panel.dispose();
                }
            }
        })
    );
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
    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.showGraphSpec', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'json') {
                vscode.window.showWarningMessage('Open a GraphSpec JSON file to view the run graph.');
                return;
            }
            if (!isGraphspecJson(editor.document.getText())) {
                vscode.window.showWarningMessage(
                    'This JSON file is not a valid MTHDS GraphSpec (missing meta.format = "mthds").'
                );
                return;
            }
            graphPanel.showGraphspecJson(editor.document.uri);
        })
    );
}
