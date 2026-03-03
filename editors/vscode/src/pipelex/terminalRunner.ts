import * as vscode from 'vscode';

/** Escape a string for safe use in a POSIX shell command. */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for safe use in PowerShell (single-quoted literal). */
function winQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/** Resolve pipelex command, get/create terminal, and send a command string. */
export function runInTerminal(
    filePath: string,
    uri: vscode.Uri,
    buildCmd: (quote: (s: string) => string, pipelexCmd: string, inputsArg: string) => string,
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
    const inputsArg = fs.existsSync(inputsPath) ? ` --inputs ${quote(inputsPath)}` : '';
    terminal.show();
    const callOp = isWindows ? '& ' : '';
    terminal.sendText(`${callOp}${buildCmd(quote, pipelexCmd, inputsArg)}`);
}
