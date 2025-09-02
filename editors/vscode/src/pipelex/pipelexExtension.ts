import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';

/**
 * Register all Pipelex-specific features for PLX support
 */
export function registerPipelexFeatures(context: vscode.ExtensionContext) {
    // Register PLX semantic token provider
    const semanticTokensProvider = new PipelexSemanticTokensProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'plx' },
            semanticTokensProvider,
            semanticTokensProvider.getSemanticTokensLegend()
        )
    );

    // Future: Add more PLX-specific features here
    // - PLX-specific validation
    // - PLX-specific code actions
    // - PLX-specific hover providers
}
