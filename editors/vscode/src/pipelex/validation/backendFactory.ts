import * as vscode from 'vscode';
import type { ValidationBackend } from './backend';
import { CliValidationBackend } from './cliValidationBackend';
import { ApiValidationBackend } from './apiValidationBackend';
import { ApiCapabilityGate } from './apiCapabilityGate';
import { resolveApiToken } from './apiKey';

/**
 * The `pipelex.backend` default. Must match the setting's `default` in
 * `package.json` (a test holds the two together): the contributed default is what
 * VS Code returns for an unset setting, and this fallback is what a read returns
 * when the contribution is missing, as in a test host.
 */
export const DEFAULT_BACKEND = 'api';

/** The `pipelex.api.baseUrl` default, held to `package.json` the same way. */
export const DEFAULT_API_BASE_URL = 'https://api.pipelex.com';

/** The button that grants the remote-send consent. */
export const SEND_TO_API_CHOICE = 'Send to API';

/**
 * Where a host's remote-send grant is remembered, followed by the host. It names
 * what was granted, the method tree, so the grant given to the earlier, narrower
 * send (under `pipelex.api.remoteConsent.<host>`) does not stand for this one.
 */
export const REMOTE_CONSENT_KEY_PREFIX = 'pipelex.api.methodTreeConsent.';

/**
 * Builds the configured {@link ValidationBackend} for a document.
 *
 * Settings are read per call (resource scope) so a `pipelex.backend` /
 * `pipelex.api.baseUrl` change takes effect on the next save without reloading.
 * A single {@link ApiCapabilityGate} and the per-host remote-consent state are held
 * here and shared across the cheap, per-call backend instances.
 */
export class BackendFactory {
    private readonly capabilityGate: ApiCapabilityGate;
    /** Hosts the user declined to send to during this session — not asked again until a reload. */
    private readonly declinedHosts = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {
        this.capabilityGate = new ApiCapabilityGate(output);
    }

    /**
     * Which backend a document uses. Only an explicit `cli` selects the CLI; any
     * other value, including a malformed one, is the default `api` backend.
     */
    backendKind(documentUri?: vscode.Uri): 'cli' | 'api' {
        const config = vscode.workspace.getConfiguration('pipelex', documentUri);
        return config.get<string>('backend', DEFAULT_BACKEND) === 'cli' ? 'cli' : 'api';
    }

    getBackend(documentUri?: vscode.Uri): ValidationBackend {
        if (this.backendKind(documentUri) === 'cli') {
            return new CliValidationBackend();
        }
        const config = vscode.workspace.getConfiguration('pipelex', documentUri);
        const baseUrl = config.get<string>('api.baseUrl', DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL;
        return new ApiValidationBackend({
            baseUrl,
            getToken: () => resolveApiToken(this.context.secrets),
            capabilityGate: this.capabilityGate,
            confirmRemote: url => this.confirmRemote(url),
            output: this.output,
        });
    }

    /**
     * Per-host confirmation before a method's files leave the machine, fired before
     * the first remote request. The prompt states that the saved file's WHOLE
     * method tree is sent, every file of it and not just the active file, and that
     * the API may keep the files it receives.
     *
     * The API backend is the default, so this reaches users who never chose it:
     * the wording says what validation does rather than assuming they picked a
     * backend, and names the way to keep files local. A grant is remembered per
     * host across sessions, under a key naming what was granted, so a grant given
     * to the narrower send that preceded the method tree (the directory's `.mthds`
     * files alone) is asked again once. A decline is remembered for the session
     * only, so a modal does not return on every save, while a reload asks again.
     */
    private async confirmRemote(baseUrl: string): Promise<boolean> {
        const host = hostOf(baseUrl);
        const key = `${REMOTE_CONSENT_KEY_PREFIX}${host}`;
        if (this.context.globalState.get<boolean>(key)) {
            return true;
        }
        if (this.declinedHosts.has(host)) {
            return false;
        }
        const choice = await vscode.window.showWarningMessage(
            `Validate your methods on the Pipelex API at ${host}?`,
            {
                modal: true,
                detail:
                    `On each save, the extension sends the saved file's whole method tree to ${baseUrl} for ` +
                    `validation, not just the active file: every file under the method's root (the nearest ` +
                    `directory holding METHODS.toml, else the saved file's directory), such as its other .mthds ` +
                    `files, templates and Python modules, except files and directories whose names start with a ` +
                    `dot and what a .gitignore inside the tree or the manifest's exclude keeps out. The API may ` +
                    `keep the files it receives in your organization's storage. To keep your files on this ` +
                    `machine, cancel and set pipelex.backend to cli, which validates with a local pipelex-agent.`,
            },
            SEND_TO_API_CHOICE,
        );
        if (choice === SEND_TO_API_CHOICE) {
            await this.context.globalState.update(key, true);
            return true;
        }
        this.declinedHosts.add(host);
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
