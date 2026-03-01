import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
    class Range {
        constructor(
            public startLine: number,
            public startChar: number,
            public endLine: number,
            public endChar: number,
        ) {}
    }
    class CodeLens {
        range: Range;
        command: any;
        constructor(range: Range, command?: any) {
            this.range = range;
            this.command = command;
        }
    }
    return { Range, CodeLens };
});

import { PipeCodeLensProvider } from '../pipeCodeLensProvider';

function makeDocument(lines: string[]) {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
        uri: { fsPath: '/test/example.mthds', toString: () => 'file:///test/example.mthds' },
    } as any;
}

const cancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any;

describe('PipeCodeLensProvider', () => {
    const provider = new PipeCodeLensProvider();

    it('returns a CodeLens for [pipe.my_pipe]', () => {
        const doc = makeDocument(['[pipe.my_pipe]']);
        const lenses = provider.provideCodeLenses(doc, cancellationToken);

        expect(lenses).toHaveLength(1);
        expect(lenses[0].command!.title).toBe('$(play) Run my_pipe');
        expect(lenses[0].command!.command).toBe('pipelex.runPipe');
        expect(lenses[0].command!.arguments).toEqual([doc.uri, 'my_pipe']);
    });

    it('returns no CodeLens for bare [pipe]', () => {
        const doc = makeDocument(['[pipe]']);
        const lenses = provider.provideCodeLenses(doc, cancellationToken);

        expect(lenses).toHaveLength(0);
    });

    it('returns multiple CodeLenses for multiple pipes', () => {
        const doc = makeDocument([
            '[pipe.first]',
            'type = "generate"',
            '',
            '[pipe.second]',
            'type = "generate"',
        ]);
        const lenses = provider.provideCodeLenses(doc, cancellationToken);

        expect(lenses).toHaveLength(2);
        expect(lenses[0].command!.arguments![1]).toBe('first');
        expect(lenses[1].command!.arguments![1]).toBe('second');
    });

    it('returns no CodeLens for concept sections', () => {
        const doc = makeDocument([
            '[concept.Foo]',
            '[concept]',
        ]);
        const lenses = provider.provideCodeLenses(doc, cancellationToken);

        expect(lenses).toHaveLength(0);
    });

    it('handles indented pipe headers', () => {
        const doc = makeDocument(['  [pipe.indented_pipe]']);
        const lenses = provider.provideCodeLenses(doc, cancellationToken);

        expect(lenses).toHaveLength(1);
        expect(lenses[0].command!.arguments![1]).toBe('indented_pipe');
    });
});
