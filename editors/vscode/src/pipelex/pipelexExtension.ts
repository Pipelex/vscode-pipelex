import * as vscode from 'vscode';
import { PipelexSemanticTokensProvider } from './semanticTokenProvider';

/**
 * Register all Pipelex-specific features for PML support
 */
export function registerPipelexFeatures(context: vscode.ExtensionContext) {
    // Register PML semantic token provider
    const semanticTokensProvider = new PipelexSemanticTokensProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'pml' },
            semanticTokensProvider,
            semanticTokensProvider.getSemanticTokensLegend()
        )
    );

    // Future: Add more PML-specific features here
    // - PML-specific validation
    // - PML-specific code actions
    // - PML-specific hover providers
}
