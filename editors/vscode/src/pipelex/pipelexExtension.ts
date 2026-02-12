import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';

/**
 * Register all Pipelex-specific features for MTHDS support
 */
export function registerPipelexFeatures(context: vscode.ExtensionContext) {
    // Register MTHDS semantic token provider
    const semanticTokensProvider = new PipelexSemanticTokensProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'mthds' },
            semanticTokensProvider,
            semanticTokensProvider.getSemanticTokensLegend()
        )
    );

    // Future: Add more MTHDS-specific features here
    // - MTHDS-specific validation
    // - MTHDS-specific code actions
    // - MTHDS-specific hover providers
}
