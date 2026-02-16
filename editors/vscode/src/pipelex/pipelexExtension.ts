import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';

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
