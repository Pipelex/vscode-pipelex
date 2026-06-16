import * as vscode from 'vscode';
import type { ValidationBackend } from './backend';
import { CliValidationBackend } from './cliValidationBackend';
import { ApiValidationBackend } from './apiValidationBackend';
import { ApiVersionGate } from './apiVersionGate';
import { resolveApiToken } from './apiKey';

const DEFAULT_API_BASE_URL = 'http://localhost:8081';

/**
 * Builds the configured {@link ValidationBackend} for a document.
 *
 * Settings are read per call (resource scope) so a `pipelex.backend` /
 * `pipelex.api.baseUrl` change takes effect on the next save without reloading.
 * A single {@link ApiVersionGate} and the per-host remote-consent state are held
 * here and shared across the cheap, per-call backend instances.
 */
export class BackendFactory {
    private readonly versionGate: ApiVersionGate;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {
        this.versionGate = new ApiVersionGate(output);
    }

    /** Which backend a document would use, without constructing it (for messaging). */
    backendKind(documentUri?: vscode.Uri): 'cli' | 'api' {
        const config = vscode.workspace.getConfiguration('pipelex', documentUri);
        return config.get<string>('backend', 'cli') === 'api' ? 'api' : 'cli';
    }

    getBackend(documentUri?: vscode.Uri): ValidationBackend {
        const config = vscode.workspace.getConfiguration('pipelex', documentUri);
        if (config.get<string>('backend', 'cli') === 'api') {
            const baseUrl = config.get<string>('api.baseUrl', DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL;
            return new ApiValidationBackend({
                baseUrl,
                getToken: () => resolveApiToken(this.context.secrets),
                versionGate: this.versionGate,
                confirmRemote: url => this.confirmRemote(url),
                output: this.output,
            });
        }
        return new CliValidationBackend();
    }

    /**
     * One-time, per-host confirmation before bundle contents leave the machine.
     * Fired before the first remote request; the prompt states that the WHOLE
     * directory's `.mthds` contents are sent, not just the active file.
     */
    private async confirmRemote(baseUrl: string): Promise<boolean> {
        const host = hostOf(baseUrl);
        const key = `pipelex.api.remoteConsent.${host}`;
        if (this.context.globalState.get<boolean>(key)) {
            return true;
        }
        const choice = await vscode.window.showWarningMessage(
            `The Pipelex API backend will send the contents of every .mthds file in the saved file's ` +
            `directory to ${baseUrl} on each save — not just the active file. Continue?`,
            { modal: true },
            'Send to API',
        );
        if (choice === 'Send to API') {
            await this.context.globalState.update(key, true);
            return true;
        }
        return false;
    }
}

function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
}
