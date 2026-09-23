import * as vscode from 'vscode';

/** SecretStorage key under which the hosted Pipelex API token is stored. */
const SECRET_KEY = 'pipelex.api.token';

/** Command id for the "Pipelex: Set Hosted API Key" command (shared by registration, pane button, and toast action). */
export const SET_API_KEY_COMMAND = 'pipelex.setApiKey';

/** Where users obtain a hosted API key. Surfaced as the "Get an API Key" remedy on a 401/403. */
export const PIPELEX_PLATFORM_URL = 'https://app.pipelex.com/';

/** Prefix every hosted Pipelex API key carries — used for the input placeholder and validation. */
const PIPELEX_API_KEY_PREFIX = 'plx_sk_';

/**
 * Resolve the API token with SecretStorage → environment precedence.
 *
 * A stored secret (set via `Pipelex: Set Hosted API Key`) wins; with none stored,
 * the `PIPELEX_API_KEY` environment variable is used. `undefined` means no key is
 * available at all. The env read is done here rather than left to
 * `PipelexApiClient`'s own fallback, so the API backend can tell that case apart
 * and say where to get a key before sending anything to a hosted API that would
 * only answer 401. The token is never read from settings (plaintext), by design.
 */
export async function resolveApiToken(
    secrets: vscode.SecretStorage,
    env: Record<string, string | undefined> | undefined = typeof process === 'undefined' ? undefined : process.env,
): Promise<string | undefined> {
    const stored = await secrets.get(SECRET_KEY);
    if (stored && stored.length > 0) {
        return stored;
    }
    const fromEnv = env?.PIPELEX_API_KEY?.trim();
    return fromEnv ? fromEnv : undefined;
}

/** Register the Set / Clear hosted API key commands. */
export function registerApiKeyCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SET_API_KEY_COMMAND, async () => {
            const value = await vscode.window.showInputBox({
                title: 'Pipelex Hosted API Key',
                prompt: 'Stored securely in VS Code SecretStorage — used when connecting to the Pipelex API.',
                placeHolder: `${PIPELEX_API_KEY_PREFIX}…`,
                password: true,
                ignoreFocusOut: true,
                validateInput: value => {
                    const candidate = value.trim();
                    // Empty is allowed through (the user can submit to cancel); the
                    // post-submit check reports "nothing stored". Only flag a clearly
                    // wrong format so a mistyped/wrong key is caught before storing.
                    if (candidate.length === 0 || candidate.startsWith(PIPELEX_API_KEY_PREFIX)) {
                        return undefined;
                    }
                    return `Pipelex API keys start with "${PIPELEX_API_KEY_PREFIX}".`;
                },
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
