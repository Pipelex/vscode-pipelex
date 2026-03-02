import * as vscode from 'vscode';

const PIPE_HEADER_RE = /^\s*\[pipe\.([a-z][a-z0-9_]*)\]/;

export class PipeCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            const match = PIPE_HEADER_RE.exec(line);
            if (match) {
                const pipeName = match[1];
                const range = new vscode.Range(i, 0, i, line.length);
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(play) Run ${pipeName}`,
                        command: 'pipelex.runPipe',
                        arguments: [document.uri, pipeName],
                    })
                );
            }
        }

        return lenses;
    }
}
