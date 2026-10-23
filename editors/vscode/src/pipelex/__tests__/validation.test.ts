import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- vscode mock ----------
// Shared mock workspace object so tests can mutate workspaceFolders / getConfiguration.
// vi.hoisted ensures this is available when vi.mock factory runs (both are hoisted).
const mockWorkspace = vi.hoisted(() => ({
    workspaceFolders: undefined as any,
    getConfiguration: (() => ({
        get: () => null as any,
    })) as any,
    getWorkspaceFolder: ((uri: any) => {
        const folders = mockWorkspace.workspaceFolders;
        if (!folders || !uri) return undefined;
        // Match by checking if the URI fsPath starts with the folder fsPath
        return folders.find((f: any) => {
            const uriPath = typeof uri.fsPath === 'string' ? uri.fsPath : '';
            return uriPath.startsWith(f.uri.fsPath);
        });
    }) as any,
}));

vi.mock('vscode', () => {
    class Range {
        start: { line: number; character: number };
        end: { line: number; character: number };
        constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    }

    return {
        Range,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        workspace: mockWorkspace,
        languages: {
            getDiagnostics: () => [],
        },
    };
});

// ---------- extractJson tests ----------

import { extractJson } from '../validation/pipelexValidator';

describe('extractJson', () => {
    it('extracts JSON from clean stderr', () => {
        const stderr = '{"error": true, "message": "fail"}';
        expect(extractJson(stderr)).toBe('{"error": true, "message": "fail"}');
    });

    it('extracts JSON after WARNING lines', () => {
        const stderr = 'WARNING: something\nWARNING: another\n{"error": true, "validation_errors": []}';
        const result = extractJson(stderr);
        expect(result).toBe('{"error": true, "validation_errors": []}');
        expect(JSON.parse(result!)).toEqual({ error: true, validation_errors: [] });
    });

    it('returns null when no JSON present', () => {
        expect(extractJson('WARNING: no json here')).toBeNull();
        expect(extractJson('')).toBeNull();
    });

    it('skips WARNING lines containing braces', () => {
        const stderr = 'WARNING: bad config {"foo": 1}\n{"error": true}';
        expect(extractJson(stderr)).toBe('{"error": true}');
    });

    it('handles multiple WARNING lines with whitespace', () => {
        const stderr = 'WARNING: line1\n  WARNING: line2\n  {"error":true}';
        const result = extractJson(stderr);
        expect(result).toBe('{"error":true}');
    });
});

// ---------- locateError tests ----------

import { locateError } from '../validation/sourceLocator';
import type { ProblemItem } from '../validation/types';

function makeDocument(lines: string[]) {
    return {
        lineCount: lines.length,
        lineAt: (n: number) => ({
            text: lines[n],
            range: {
                start: { line: n, character: 0 },
                end: { line: n, character: lines[n].length },
            },
        }),
    } as any;
}

describe('locateError', () => {
    it('locates a pipe table header by location.pipe', () => {
        const doc = makeDocument([
            '[concept.Input]',
            'definition = "Some input"',
            '',
            '[pipe.my_pipe]',
            'type = "PipeLLM"',
            'output = "Result"',
        ]);
        const error: ProblemItem = {
            code: 'method.output_concept_mismatch',
            detail: 'Invalid output type',
            location: { pipe: 'my_pipe' },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(3);
    });

    it('locates a concept table header by the concept parameter', () => {
        const doc = makeDocument([
            '[concept.MyType]',
            'definition = "A type"',
            '',
            '[pipe.test]',
        ]);
        const error: ProblemItem = {
            code: 'method.concept_invalid',
            detail: 'Missing required field',
            params: { concept: 'MyType' },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });

    it('locates a field within a pipe section', () => {
        const doc = makeDocument([
            '[pipe.my_pipe]',
            'type = "PipeLLM"',
            'output = "BadRef"',
            'model = "$gpt-4o"',
            '',
            '[pipe.other]',
        ]);
        const error: ProblemItem = {
            code: 'method.concept_unresolved',
            detail: 'Invalid output reference',
            location: { pipe: 'my_pipe', field: 'output' },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(2);
    });

    it('reads the field from the field_path parameter when the location names none', () => {
        const doc = makeDocument([
            '[pipe.my_pipe]',
            'type = "PipeLLM"',
            'output = "BadRef"',
        ]);
        const error: ProblemItem = {
            code: 'method.field_path_unresolved',
            detail: 'Bad path',
            params: { field_path: 'pipe.my_pipe.output' },
            location: { pipe: 'my_pipe' },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(2);
    });

    it('extracts the pipe code from the detail when the item names no pipe', () => {
        const doc = makeDocument([
            '[pipe.broken_pipe]',
            'type = "PipeLLM"',
        ]);
        const error: ProblemItem = {
            code: 'method.invalid',
            detail: "pipe 'broken_pipe' has invalid configuration",
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });

    it('extracts the concept code from the detail when the item names no concept', () => {
        const doc = makeDocument([
            '[concept.BadConcept]',
            'definition = "Broken"',
        ]);
        const error: ProblemItem = {
            code: 'method.invalid',
            detail: "concept 'BadConcept' is invalid",
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });

    it('goes on to the concept the detail quotes when the concept parameter is a missing one', () => {
        const doc = makeDocument([
            '[pipe.extract]',
            'type = "PipeLLM"',
            '',
            '[concept.Invoice]',
            'description = "An invoice"',
            'refines = "Document"',
        ]);
        // The concept parameter names the missing concept, which has no header
        // by definition.
        const error: ProblemItem = {
            code: 'method.concept_unresolved',
            detail: "concept 'Invoice' refines concept 'Document', which no domain declares",
            params: { concept: 'Document' },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(3);
    });

    it('falls back to line 0 when nothing matches', () => {
        const doc = makeDocument([
            '[pipe.something]',
            'type = "PipeLLM"',
        ]);
        const error: ProblemItem = {
            code: 'method.invalid',
            detail: 'Some generic error',
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });

    it('does not search past the next table header for the field', () => {
        const doc = makeDocument([
            '[pipe.first]',
            'type = "PipeLLM"',
            '',
            '[pipe.second]',
            'output = "Something"',
        ]);
        const error: ProblemItem = {
            code: 'method.schema_violation',
            detail: 'Missing output',
            location: { pipe: 'first', field: 'output' },
        };

        // output = is in [pipe.second], not [pipe.first], so should fall back to header line
        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });

    it('places an exact item at its own line and column', () => {
        const doc = makeDocument([
            '[pipe.first]',
            'type = "PipeLLM',
        ]);
        const error: ProblemItem = {
            code: 'method.syntax',
            detail: 'Unterminated string',
            location: { pipe: 'first', line: 2, column: 8 },
        };

        const range = locateError(error, doc, true);
        expect(range.start).toEqual({ line: 1, character: 7 });
        expect(range.end).toEqual({ line: 1, character: 'type = "PipeLLM'.length });
    });

    it('covers the whole line when the column lies at the end of the line', () => {
        const doc = makeDocument(['[pipe.first']);
        const error: ProblemItem = { code: 'method.syntax', detail: 'Missing ]', location: { line: 1, column: 12 } };

        const range = locateError(error, doc, true);
        expect(range.start).toEqual({ line: 0, character: 0 });
    });

    it('ignores the line and column of an item not known to belong to this document', () => {
        const doc = makeDocument([
            '[pipe.first]',
            'type = "PipeLLM"',
        ]);
        const error: ProblemItem = {
            code: 'method.syntax',
            detail: 'Somewhere else',
            location: { pipe: 'first', line: 2, column: 1 },
        };

        const range = locateError(error, doc);
        expect(range.start.line).toBe(0);
    });
});

// ---------- cliResolver tests ----------

vi.mock('fs', () => ({
    default: { existsSync: vi.fn(() => false), promises: {} },
    existsSync: vi.fn(() => false),
}));

vi.mock('which', () => ({
    default: { sync: vi.fn(() => null) },
}));

import * as fs from 'fs';
import which from 'which';
import { resolveCli } from '../validation/cliResolver';

describe('cliResolver', () => {
    beforeEach(() => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(which.sync).mockReturnValue(null as unknown as string);
        mockWorkspace.workspaceFolders = undefined;
        mockWorkspace.getConfiguration = () => ({ get: () => null });
    });

    it('finds pipelex-agent in .venv/bin on unix', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        try {
            mockWorkspace.workspaceFolders = [
                { uri: { fsPath: '/workspace' } },
            ];
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return String(p).includes('.venv/bin/pipelex-agent');
            });

            const result = resolveCli();
            expect(result).not.toBeNull();
            expect(result!.command).toContain('.venv/bin/pipelex-agent');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('finds pipelex-agent in .venv/Scripts on win32', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            mockWorkspace.workspaceFolders = [
                { uri: { fsPath: 'C:\\workspace' } },
            ];
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return String(p).includes('Scripts');
            });

            const result = resolveCli();
            expect(result).not.toBeNull();
            expect(result!.command).toContain('Scripts');
            expect(result!.command).toContain('pipelex-agent.exe');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('falls back to which on PATH', () => {
        vi.mocked(which.sync).mockImplementation(((cmd: string, opts?: any) => {
            if (cmd === 'pipelex-agent') return '/usr/local/bin/pipelex-agent';
            return null;
        }) as any);

        const result = resolveCli();
        expect(result).not.toBeNull();
        expect(result!.command).toBe('/usr/local/bin/pipelex-agent');
    });

    it('falls back to uv run', () => {
        vi.mocked(which.sync).mockImplementation(((cmd: string, opts?: any) => {
            if (cmd === 'uv') return '/usr/local/bin/uv';
            return null;
        }) as any);

        const result = resolveCli();
        expect(result).not.toBeNull();
        expect(result!.command).toBe('/usr/local/bin/uv');
        expect(result!.args).toEqual(['run', 'pipelex-agent']);
    });

    it('returns null when nothing found', () => {
        expect(resolveCli()).toBeNull();
    });

    it('user setting takes priority over .venv', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        try {
            mockWorkspace.workspaceFolders = [
                { uri: { fsPath: '/workspace' } },
            ];
            // .venv exists
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return String(p).includes('.venv/bin/pipelex-agent');
            });
            // User setting is also configured
            mockWorkspace.getConfiguration = () => ({
                get: () => '/custom/path/pipelex-agent',
            });

            const result = resolveCli();
            expect(result).not.toBeNull();
            expect(result!.command).toBe('/custom/path/pipelex-agent');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('prefers .venv from the workspace folder matching documentUri', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        try {
            mockWorkspace.workspaceFolders = [
                { uri: { fsPath: '/workspace-a' } },
                { uri: { fsPath: '/workspace-b' } },
            ];
            // Both folders have .venv
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                const s = String(p);
                return s.includes('.venv/bin/pipelex-agent');
            });

            const docUri = { fsPath: '/workspace-b/src/file.mthds' };
            const result = resolveCli(docUri as any);
            expect(result).not.toBeNull();
            // Should pick workspace-b's .venv, not workspace-a's
            expect(result!.command).toContain('/workspace-b/');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });
});
