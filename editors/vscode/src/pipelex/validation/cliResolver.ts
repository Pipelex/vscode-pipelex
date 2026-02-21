import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import which from 'which';
import type { ResolvedCli } from './types';

/**
 * Resolve the pipelex-agent CLI binary.
 *
 * Resolution order:
 * 1. User setting `pipelex.validation.agentCliPath` (explicit override wins)
 * 2. `.venv/bin/pipelex-agent` in workspace root
 * 3. `pipelex-agent` on PATH
 * 4. `uv run pipelex-agent` fallback
 */
export function resolveCli(documentUri?: vscode.Uri): ResolvedCli | null {
    // 1. User setting (explicit override wins)
    const configPath = vscode.workspace.getConfiguration('pipelex').get<string | null>('validation.agentCliPath', null);
    if (configPath) {
        return { command: configPath, args: [] };
    }

    // 2. .venv in workspace root (prefer the folder owning documentUri)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const venvBin = process.platform === 'win32'
            ? path.join('.venv', 'Scripts', 'pipelex-agent.exe')
            : path.join('.venv', 'bin', 'pipelex-agent');

        // If a document URI is provided, check its owning workspace folder first
        if (documentUri) {
            const owningFolder = vscode.workspace.getWorkspaceFolder(documentUri);
            if (owningFolder) {
                const venvPath = path.join(owningFolder.uri.fsPath, venvBin);
                if (fs.existsSync(venvPath)) {
                    return { command: venvPath, args: [] };
                }
            }
        }

        // Fall back to iterating all folders
        for (const folder of workspaceFolders) {
            const venvPath = path.join(folder.uri.fsPath, venvBin);
            if (fs.existsSync(venvPath)) {
                return { command: venvPath, args: [] };
            }
        }
    }

    // 3. pipelex-agent on PATH
    const onPath = which.sync('pipelex-agent', { nothrow: true });
    if (onPath) {
        return { command: onPath, args: [] };
    }

    // 4. uv run fallback
    const uvPath = which.sync('uv', { nothrow: true });
    if (uvPath) {
        return { command: uvPath, args: ['run', 'pipelex-agent'] };
    }

    return null;
}
