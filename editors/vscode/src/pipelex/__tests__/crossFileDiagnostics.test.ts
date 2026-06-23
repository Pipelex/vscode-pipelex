import { describe, it, expect, vi } from 'vitest';

// ---------- vscode mock ----------
vi.mock('vscode', () => {
    class Range {
        start: { line: number; character: number };
        end: { line: number; character: number };
        constructor(sl: number, sc: number, el: number, ec: number) {
            this.start = { line: sl, character: sc };
            this.end = { line: el, character: ec };
        }
    }
    class Diagnostic {
        source?: string;
        code?: string;
        constructor(public range: any, public message: string, public severity: number) {}
    }
    return {
        Range,
        Diagnostic,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Uri: {
            file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
        },
    };
});

import * as vscode from 'vscode';
import { buildBundleDiagnostics, resolveErrorLocations } from '../validation/crossFileDiagnostics';
import type { BundleFile } from '../validation/backend';
import type { ValidationErrorItem } from '../validation/types';

const DIR = '/project/methods';

function makeFile(name: string, content: string): BundleFile {
    return { uri: vscode.Uri.file(`${DIR}/${name}`) as any, name, content };
}

const PRIMARY = makeFile('main.mthds', 'domain = "d"\n[pipe.main_pipe]\ntype = "PipeLLM"\noutput = "Foo"\n');
const SIBLING = makeFile('concepts.mthds', 'domain = "d"\n[concept.Foo]\ndescription = "a foo"\n[pipe.helper]\ntype = "PipeLLM"\noutput = "Foo"\n');

function build(errors: ValidationErrorItem[]) {
    return buildBundleDiagnostics({
        errors,
        files: [PRIMARY, SIBLING],
        primaryUri: PRIMARY.uri as any,
        diagnosticSource: 'pipelex',
    });
}

describe('buildBundleDiagnostics — owner resolution', () => {
    it('places an error on the file named by its `source`', () => {
        const result = build([{ category: 'pipe_validation', message: 'bad helper', source: 'concepts.mthds', pipe_code: 'helper' }]);
        expect(result).toHaveLength(1);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
        expect(result[0].diagnostics[0].message).toBe('bad helper');
    });

    it('matches `source` by basename when it is a full path', () => {
        const result = build([{ category: 'pipe_validation', message: 'bad', source: `${DIR}/concepts.mthds` }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to declaration scan (pipe_code) when there is no source', () => {
        const result = build([{ category: 'pipe_factory', message: 'helper broke', pipe_code: 'helper' }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a same-code pipe error on the file whose domain matches the error', () => {
        const alpha = makeFile('alpha.mthds', 'domain = "alpha"\n[pipe.process]\ntype = "PipeLLM"\n');
        const beta = makeFile('beta.mthds', 'domain = "beta"\n[pipe.process]\ntype = "PipeLLM"\n');
        const result = buildBundleDiagnostics({
            errors: [{ category: 'pipe_factory', message: 'beta process broke', pipe_code: 'process', domain_code: 'beta' }],
            files: [alpha, beta],
            primaryUri: alpha.uri as any,
            diagnosticSource: 'pipelex',
        });
        expect(result).toHaveLength(1);
        expect(result[0].uri.toString()).toBe(beta.uri.toString());
        expect(result[0].diagnostics[0].range.start.line).toBe(1);
    });

    it('falls back to the concept-declaring file when only concept_code is known', () => {
        const result = build([{ category: 'pipe_factory', message: 'Foo missing', concept_code: 'Foo' }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to the primary file when nothing resolves', () => {
        const result = build([{ category: 'blueprint_validation', message: 'mystery error' }]);
        expect(result[0].uri.toString()).toBe(PRIMARY.uri.toString());
    });

    it('falls back to the primary file when `source` names a file outside the gathered set', () => {
        const result = build([{ category: 'pipe_validation', message: 'external', source: '/elsewhere/lib.mthds' }]);
        expect(result[0].uri.toString()).toBe(PRIMARY.uri.toString());
    });

    it('groups multiple errors by their owning files', () => {
        const result = build([
            { category: 'pipe_validation', message: 'on primary', source: 'main.mthds' },
            { category: 'pipe_validation', message: 'on sibling', source: 'concepts.mthds' },
            { category: 'pipe_validation', message: 'also sibling', source: 'concepts.mthds' },
        ]);
        const byUri = new Map(result.map(r => [r.uri.toString(), r.diagnostics.length]));
        expect(byUri.get(PRIMARY.uri.toString())).toBe(1);
        expect(byUri.get(SIBLING.uri.toString())).toBe(2);
    });

    it('sets the diagnostic source and code', () => {
        const result = build([{ category: 'pipe_validation', message: 'x', error_type: 'PipeValidationError', source: 'main.mthds' }]);
        const diag = result[0].diagnostics[0];
        expect(diag.source).toBe('pipelex');
        expect(diag.code).toBe('PipeValidationError');
        expect(diag.severity).toBe(vscode.DiagnosticSeverity.Error);
    });

    it('locates the error on the declaring table-header line of the owning file', () => {
        // [pipe.helper] is on line index 3 of the sibling file.
        const result = build([{ category: 'pipe_validation', message: 'bad', source: 'concepts.mthds', pipe_code: 'helper' }]);
        expect(result[0].diagnostics[0].range.start.line).toBe(3);
    });
});

describe('resolveErrorLocations — owner + range, order-preserving', () => {
    function resolve(errors: ValidationErrorItem[], primaryDocument?: any) {
        return resolveErrorLocations({
            errors,
            files: [PRIMARY, SIBLING],
            primaryUri: PRIMARY.uri as any,
            primaryDocument,
        });
    }

    it('preserves input order across mixed owners', () => {
        const result = resolve([
            { category: 'pipe_validation', message: 'first (primary)', source: 'main.mthds' },
            { category: 'pipe_validation', message: 'second (sibling)', source: 'concepts.mthds' },
            { category: 'pipe_validation', message: 'third (primary)', source: 'main.mthds' },
        ]);
        expect(result.map(r => r.error.message)).toEqual(['first (primary)', 'second (sibling)', 'third (primary)']);
        expect(result.map(r => r.uri.toString())).toEqual([
            PRIMARY.uri.toString(),
            SIBLING.uri.toString(),
            PRIMARY.uri.toString(),
        ]);
    });

    it('places a `source`-owned error on the named file', () => {
        const [loc] = resolve([{ category: 'pipe_validation', message: 'x', source: 'concepts.mthds' }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a pipe-code-owned error (no source) on the declaring file', () => {
        const [loc] = resolve([{ category: 'pipe_factory', message: 'x', pipe_code: 'helper' }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a concept-code-owned error (no source) on the declaring file', () => {
        const [loc] = resolve([{ category: 'pipe_factory', message: 'x', concept_code: 'Foo' }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to the primary file when nothing resolves, at range line 0', () => {
        const [loc] = resolve([{ category: 'blueprint_validation', message: 'mystery' }]);
        expect(loc.uri.toString()).toBe(PRIMARY.uri.toString());
        expect(loc.range.start.line).toBe(0);
    });

    it('ranges a sibling-owned error from its on-disk lines (no open document)', () => {
        // [pipe.helper] is at line index 3 of the sibling.
        const [loc] = resolve([{ category: 'pipe_validation', message: 'x', source: 'concepts.mthds', pipe_code: 'helper' }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
        expect(loc.range.start.line).toBe(3);
    });

    it('routes a POSIX-relative `source` onto a backslash (Windows) fsPath', () => {
        // The backend can report a POSIX-style relative source (`subdir/concepts.mthds`)
        // even on Windows, where fsPath uses `\`. The sibling's `name` is the bare
        // basename, so only the segment-boundary suffix check can match it — and only
        // after both sides are normalized to `/`. Pre-fix this misrouted to the primary.
        const winFile = (fsPath: string, name: string, content: string): BundleFile =>
            ({ uri: { fsPath, scheme: 'file', toString: () => `file://${fsPath}` } as any, name, content });
        const winPrimary = winFile('C:\\project\\methods\\main.mthds', 'main.mthds', 'domain = "d"\n');
        const winSibling = winFile(
            'C:\\project\\methods\\subdir\\concepts.mthds',
            'concepts.mthds',
            'domain = "d"\n[concept.Foo]\ndescription = "a foo"\n',
        );
        const [loc] = resolveErrorLocations({
            errors: [{ category: 'concept_validation', message: 'bad Foo', source: 'subdir/concepts.mthds' }],
            files: [winPrimary, winSibling],
            primaryUri: winPrimary.uri as any,
        });
        expect(loc.uri.toString()).toBe(winSibling.uri.toString());
    });

    it('ranges a primary-owned error from the OPEN document, not the on-disk text', () => {
        // [pipe.main_pipe] is at line index 1 of the primary. The open document
        // returns a sentinel range end (999) the on-disk path would never produce,
        // proving locateError(document) — not locateErrorInLines — supplied the range.
        const lines = (PRIMARY.content as string).split('\n');
        const primaryDocument = {
            lineCount: lines.length,
            lineAt: (i: number) => ({
                text: lines[i] ?? '',
                range: new (vscode as any).Range(i, 0, i, 999),
            }),
        };
        const [loc] = resolve(
            [{ category: 'pipe_validation', message: 'x', pipe_code: 'main_pipe' }],
            primaryDocument,
        );
        expect(loc.uri.toString()).toBe(PRIMARY.uri.toString());
        expect(loc.range.start.line).toBe(1);
        expect(loc.range.end.character).toBe(999);
    });
});
