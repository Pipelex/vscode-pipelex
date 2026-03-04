import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    Range: class {
        constructor(
            public startLine: number,
            public startChar: number,
            public endLine: number,
            public endChar: number,
        ) {}
    },
    tests: {
        createTestController: vi.fn(() => ({
            resolveHandler: null,
            createRunProfile: vi.fn(),
            createTestItem: vi.fn(),
            items: { add: vi.fn(), delete: vi.fn(), get: vi.fn(), forEach: vi.fn() },
            dispose: vi.fn(),
        })),
    },
    workspace: {
        createFileSystemWatcher: vi.fn(() => ({
            onDidCreate: vi.fn(),
            onDidChange: vi.fn(),
            onDidDelete: vi.fn(),
            dispose: vi.fn(),
        })),
        onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
        onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
        findFiles: vi.fn(() => Promise.resolve([])),
    },
    TestRunProfileKind: { Run: 1 },
}));

vi.mock('../terminalRunner', () => ({
    runInTerminal: vi.fn(),
}));

import { findPipeHeaders } from '../pipeTestProvider';

describe('findPipeHeaders', () => {
    it('finds [pipe.my_pipe]', () => {
        const result = findPipeHeaders('[pipe.my_pipe]');
        expect(result).toEqual([{ name: 'my_pipe', line: 0 }]);
    });

    it('returns nothing for bare [pipe]', () => {
        const result = findPipeHeaders('[pipe]');
        expect(result).toEqual([]);
    });

    it('finds multiple pipes', () => {
        const text = [
            '[pipe.first]',
            'type = "generate"',
            '',
            '[pipe.second]',
            'type = "generate"',
        ].join('\n');
        const result = findPipeHeaders(text);
        expect(result).toEqual([
            { name: 'first', line: 0 },
            { name: 'second', line: 3 },
        ]);
    });

    it('returns nothing for concept sections', () => {
        const text = '[concept.Foo]\n[concept]';
        const result = findPipeHeaders(text);
        expect(result).toEqual([]);
    });

    it('handles indented pipe headers', () => {
        const result = findPipeHeaders('  [pipe.indented_pipe]');
        expect(result).toEqual([{ name: 'indented_pipe', line: 0 }]);
    });
});
