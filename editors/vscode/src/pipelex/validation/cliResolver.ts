import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import which from 'which';
import type { ResolvedCli } from './types';

/**
 * Resolve the pipelex-agent CLI binary.
 *
 * Resolution order:
 * 1. `.venv/bin/pipelex-agent` in workspace root
 * 2. User setting `pipelex.validation.agentCliPath`
 * 3. `pipelex-agent` on PATH
 * 4. `uv run pipelex-agent` fallback
 */
export function resolveCli(): ResolvedCli | null {
    // 1. .venv in workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const venvBin = process.platform === 'win32'
                ? path.join('.venv', 'Scripts', 'pipelex-agent.exe')
                : path.join('.venv', 'bin', 'pipelex-agent');
            const venvPath = path.join(folder.uri.fsPath, venvBin);
            if (fs.existsSync(venvPath)) {
                return { command: venvPath, args: [] };
            }
        }
    }

    // 2. User setting
    const configPath = vscode.workspace.getConfiguration('pipelex').get<string | null>('validation.agentCliPath', null);
    if (configPath) {
        return { command: configPath, args: [] };
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
