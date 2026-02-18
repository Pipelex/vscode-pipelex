import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';
import { PipelexValidator } from './validation/pipelexValidator';
import { MethodGraphPanel } from './graph/methodGraphPanel';
import { getOutput } from '../util';

/**
 * Register all Pipelex-specific features for MTHDS support
 */
export function registerPipelexFeatures(context: vscode.ExtensionContext) {
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

    // Pipelex-agent validation on save
    const validationEnabled = config.get<boolean>('validation.enabled', true);
    if (validationEnabled) {
        const validator = new PipelexValidator(getOutput());
        context.subscriptions.push(validator);
    }

    // Method graph webview panel
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
