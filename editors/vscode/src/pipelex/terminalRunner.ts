import * as vscode from 'vscode';

/** Escape a string for safe use in a POSIX shell command. */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for safe use in PowerShell (single-quoted literal). */
function winQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/** Find the `main_pipe = "..."` value at the top level (before any [section] header). */
export function findMainPipeName(text: string): string | undefined {
    const lines = text.split('\n');
    for (const line of lines) {
        if (/^\s*\[/.test(line)) break; // reached first section header
        const m = /^\s*main_pipe\s*=\s*"([^"]+)"/.exec(line);
        if (m) return m[1];
    }
    return undefined;
}

/** Check whether the `[pipe.<pipeName>]` section contains an `inputs` field. */
export function pipeHasInputs(text: string, pipeName: string): boolean {
    const lines = text.split('\n');
    let inSection = false;
    const sectionHeader = `[pipe.${pipeName}]`;
    for (const line of lines) {
        if (inSection) {
            // Next section header means we've left the target section
            if (/^\s*\[/.test(line)) return false;
            if (/^\s*inputs\s*=/.test(line)) return true;
        } else if (line.trim() === sectionHeader) {
            inSection = true;
        }
    }
    return false;
}

/** Resolve pipelex command, get/create terminal, and send a command string. */
export function runInTerminal(
    filePath: string,
    uri: vscode.Uri,
    buildCmd: (quote: (s: string) => string, pipelexCmd: string, inputsArg: string) => string,
    pipeName?: string,
) {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const isWindows = process.platform === 'win32';
    let pipelexCmd = 'pipelex';
    if (workspaceFolder) {
        const venvPipelex = path.join(
            workspaceFolder.uri.fsPath,
            isWindows ? path.join('.venv', 'Scripts', 'pipelex.exe')
                      : path.join('.venv', 'bin', 'pipelex'),
        );
        if (fs.existsSync(venvPipelex)) {
            pipelexCmd = venvPipelex;
        }
    }
    const terminalName = 'Pipelex';
    let terminal = vscode.window.terminals.find(t => t.name === terminalName);
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: terminalName });
    }
    const inputsPath = path.join(path.dirname(filePath), 'inputs.json');
    const quote = isWindows ? winQuote : shellQuote;

    let inputsArg = '';
    if (fs.existsSync(inputsPath)) {
        try {
            const text = fs.readFileSync(filePath, 'utf-8');
            const targetPipe = pipeName ?? findMainPipeName(text);
            // Include --inputs only if the target pipe has inputs (or if we can't determine)
            if (!targetPipe || pipeHasInputs(text, targetPipe)) {
                inputsArg = ` --inputs ${quote(inputsPath)}`;
            }
        } catch {
            // If we can't read the file, fall back to including --inputs
            inputsArg = ` --inputs ${quote(inputsPath)}`;
        }
    }

    terminal.show();
    const callOp = isWindows ? '& ' : '';
    terminal.sendText(`${callOp}${buildCmd(quote, pipelexCmd, inputsArg)}`);
}
