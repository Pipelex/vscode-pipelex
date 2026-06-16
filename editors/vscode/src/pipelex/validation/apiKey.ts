import * as vscode from 'vscode';

/** SecretStorage key under which the hosted Pipelex API token is stored. */
const SECRET_KEY = 'pipelex.api.token';

/**
 * Resolve the API token with SecretStorage → environment precedence.
 *
 * A stored secret (set via `Pipelex: Set Hosted API Key`) wins. When none is
 * stored we return `undefined`, letting `MthdsApiClient` fall back to its native
 * `MTHDS_API_KEY` env read — so the wrapper overrides the env when a key is
 * stored, and defers to it otherwise. The token is never read from settings
 * (plaintext), by design.
 */
export async function resolveApiToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
    const stored = await secrets.get(SECRET_KEY);
    return stored && stored.length > 0 ? stored : undefined;
}

/** Register the Set / Clear hosted API key commands. */
export function registerApiKeyCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.setApiKey', async () => {
            const value = await vscode.window.showInputBox({
                title: 'Pipelex Hosted API Key',
                prompt: 'Stored securely in VS Code SecretStorage — used when pipelex.backend is "api" against a hosted endpoint.',
                placeHolder: 'sk-…',
                password: true,
                ignoreFocusOut: true,
            });
            if (value === undefined) {
                return; // cancelled
            }
            const trimmed = value.trim();
            if (trimmed.length === 0) {
                vscode.window.showWarningMessage('Pipelex: no key entered — nothing stored.');
                return;
            }
            await context.secrets.store(SECRET_KEY, trimmed);
            vscode.window.showInformationMessage('Pipelex: hosted API key stored.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pipelex.clearApiKey', async () => {
            await context.secrets.delete(SECRET_KEY);
            vscode.window.showInformationMessage('Pipelex: hosted API key cleared.');
        })
    );
}
