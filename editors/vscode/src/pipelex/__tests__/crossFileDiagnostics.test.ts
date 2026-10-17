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
        code?: { value: string; target: { toString(): string } };
        constructor(public range: any, public message: string, public severity: number) {}
    }
    return {
        Range,
        Diagnostic,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Uri: {
            file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
            parse: (value: string) => ({ toString: () => value }),
        },
    };
});

import * as vscode from 'vscode';
import { buildBundleDiagnostics, resolveErrorLocations } from '../validation/crossFileDiagnostics';
import type { BundleFile } from '../validation/backend';
import type { ProblemItem } from '../validation/types';

const DIR = '/project/methods';

function makeFile(name: string, content: string): BundleFile {
    return { uri: vscode.Uri.file(`${DIR}/${name}`) as any, name, content };
}

const PRIMARY = makeFile('main.mthds', 'domain = "d"\n[pipe.main_pipe]\ntype = "PipeLLM"\noutput = "Foo"\n');
const SIBLING = makeFile('concepts.mthds', 'domain = "d"\n[concept.Foo]\ndescription = "a foo"\n[pipe.helper]\ntype = "PipeLLM"\noutput = "Foo"\n');

function build(errors: ProblemItem[], warnings?: ProblemItem[]) {
    return buildBundleDiagnostics({
        errors,
        warnings,
        files: [PRIMARY, SIBLING],
        primaryUri: PRIMARY.uri as any,
        diagnosticSource: 'pipelex',
    });
}

describe('buildBundleDiagnostics — owner resolution', () => {
    it('places an item on the file its `location.file` names', () => {
        const result = build([{ code: 'method.wiring_invalid', detail: 'bad helper', location: { file: 'concepts.mthds', pipe: 'helper' } }]);
        expect(result).toHaveLength(1);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
        expect(result[0].diagnostics[0].message).toBe('bad helper');
    });

    it('matches `location.file` by basename when it is a full path', () => {
        const result = build([{ code: 'method.wiring_invalid', detail: 'bad', location: { file: `${DIR}/concepts.mthds` } }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to the declaration scan of `location.pipe` when the item names no file', () => {
        const result = build([{ code: 'pipe.failed', detail: 'helper broke', location: { pipe: 'helper' } }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a same-code pipe item on the file it names, not the first declaring file', () => {
        const alpha = makeFile('alpha.mthds', 'domain = "alpha"\n[pipe.process]\ntype = "PipeLLM"\n');
        const beta = makeFile('beta.mthds', 'domain = "beta"\n[pipe.process]\ntype = "PipeLLM"\n');
        const result = buildBundleDiagnostics({
            errors: [{ code: 'method.wiring_invalid', detail: 'beta process broke', location: { pipe: 'process', file: 'beta.mthds' } }],
            files: [alpha, beta],
            primaryUri: alpha.uri as any,
            diagnosticSource: 'pipelex',
        });
        expect(result).toHaveLength(1);
        expect(result[0].uri.toString()).toBe(beta.uri.toString());
        expect(result[0].diagnostics[0].range.start.line).toBe(1);
    });

    it('falls back to the concept-declaring file when only the `concept` parameter is known', () => {
        const result = build([{ code: 'method.concept_unresolved', detail: 'Foo missing', params: { concept: 'Foo' } }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to the primary file when nothing resolves', () => {
        const result = build([{ code: 'method.invalid', detail: 'mystery error' }]);
        expect(result[0].uri.toString()).toBe(PRIMARY.uri.toString());
    });

    it('falls back to the primary file when `location.file` names a file outside the gathered set', () => {
        const result = build([{ code: 'method.wiring_invalid', detail: 'external', location: { file: '/elsewhere/lib.mthds' } }]);
        expect(result[0].uri.toString()).toBe(PRIMARY.uri.toString());
    });

    it('groups multiple items by their owning files', () => {
        const result = build([
            { code: 'method.wiring_invalid', detail: 'on primary', location: { file: 'main.mthds' } },
            { code: 'method.wiring_invalid', detail: 'on sibling', location: { file: 'concepts.mthds' } },
            { code: 'method.wiring_invalid', detail: 'also sibling', location: { file: 'concepts.mthds' } },
        ]);
        const byUri = new Map(result.map(r => [r.uri.toString(), r.diagnostics.length]));
        expect(byUri.get(PRIMARY.uri.toString())).toBe(1);
        expect(byUri.get(SIBLING.uri.toString())).toBe(2);
    });

    it('sets the diagnostic source, and the code linked to its page', () => {
        const result = build([{ code: 'method.wiring_invalid', detail: 'x', location: { file: 'main.mthds' } }]);
        const diag = result[0].diagnostics[0];
        expect(diag.source).toBe('pipelex');
        expect((diag.code as any).value).toBe('method.wiring_invalid');
        expect((diag.code as any).target.toString()).toBe('https://mthds.ai/errors/method.wiring_invalid');
        expect(diag.severity).toBe(vscode.DiagnosticSeverity.Error);
    });

    it('links a Pipelex code to its page on docs.pipelex.com', () => {
        const result = build([{ code: 'pipelex.docgen.template_warning', detail: 'x', location: { file: 'main.mthds' } }]);
        expect((result[0].diagnostics[0].code as any).target.toString())
            .toBe('https://docs.pipelex.com/errors/pipelex.docgen.template_warning');
    });

    it('leaves the code unset for an item that carries none', () => {
        const result = build([{ detail: 'read from the shape problem items replace', location: { file: 'main.mthds' } }]);
        expect(result[0].diagnostics[0].code).toBeUndefined();
    });

    it('locates an item on the declaring table-header line of the owning file', () => {
        // [pipe.helper] is on line index 3 of the sibling file.
        const result = build([{ code: 'method.wiring_invalid', detail: 'bad', location: { file: 'concepts.mthds', pipe: 'helper' } }]);
        expect(result[0].diagnostics[0].range.start.line).toBe(3);
    });

    it("places an item at its own line and column in the file it names", () => {
        // Line 6 (1-based) of the sibling is `output = "Foo"`; column 10 is the opening quote.
        const result = build([{ code: 'method.syntax', detail: 'bad value', location: { file: 'concepts.mthds', line: 6, column: 10 } }]);
        const range = result[0].diagnostics[0].range;
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
        expect(range.start).toEqual({ line: 5, character: 9 });
        expect(range.end).toEqual({ line: 5, character: 'output = "Foo"'.length });
    });

    it('covers the whole line when the item gives a line and no column', () => {
        const result = build([{ code: 'method.syntax', detail: 'bad line', location: { file: 'concepts.mthds', line: 2 } }]);
        const range = result[0].diagnostics[0].range;
        expect(range.start).toEqual({ line: 1, character: 0 });
        expect(range.end).toEqual({ line: 1, character: '[concept.Foo]'.length });
    });

    it('falls back to the declaration scan when the line lies past the end of the file', () => {
        const result = build([{ code: 'method.syntax', detail: 'stale line', location: { file: 'concepts.mthds', pipe: 'helper', line: 99 } }]);
        expect(result[0].diagnostics[0].range.start.line).toBe(3);
    });

    it('does not trust a line on a file the item does not name', () => {
        // No `location.file`: the owner comes from the scan, so line 1 could mean any
        // file's line 1. The header scan places it instead.
        const result = build([{ code: 'method.wiring_invalid', detail: 'helper broke', location: { pipe: 'helper', line: 1 } }]);
        expect(result[0].uri.toString()).toBe(SIBLING.uri.toString());
        expect(result[0].diagnostics[0].range.start.line).toBe(3);
    });

    it('trusts a line in a bundle of one file even when the item names no file', () => {
        const result = buildBundleDiagnostics({
            errors: [{ code: 'method.syntax', detail: 'bad', location: { line: 3, column: 1 } }],
            files: [PRIMARY],
            primaryUri: PRIMARY.uri as any,
            diagnosticSource: 'pipelex',
        });
        expect(result[0].diagnostics[0].range.start).toEqual({ line: 2, character: 0 });
    });

    it('places the field the item names within its pipe section', () => {
        // `output` is at line index 5 of the sibling, inside [pipe.helper].
        const result = build([{ code: 'method.output_concept_mismatch', detail: 'bad output', location: { file: 'concepts.mthds', pipe: 'helper', field: 'output' } }]);
        expect(result[0].diagnostics[0].range.start.line).toBe(5);
    });

    it('publishes warnings as warning diagnostics after the errors', () => {
        const result = build(
            [{ code: 'method.wiring_invalid', detail: 'an error', location: { file: 'main.mthds' } }],
            [{ code: 'method.hint_invalid', detail: 'a warning', location: { file: 'main.mthds' } }],
        );
        const diagnostics = result[0].diagnostics;
        expect(diagnostics.map(d => [d.message, d.severity])).toEqual([
            ['an error', vscode.DiagnosticSeverity.Error],
            ['a warning', vscode.DiagnosticSeverity.Warning],
        ]);
    });
});

describe('resolveErrorLocations — owner + range, order-preserving', () => {
    function resolve(errors: ProblemItem[], primaryDocument?: any) {
        return resolveErrorLocations({
            errors,
            files: [PRIMARY, SIBLING],
            primaryUri: PRIMARY.uri as any,
            primaryDocument,
        });
    }

    it('preserves input order across mixed owners', () => {
        const result = resolve([
            { code: 'method.wiring_invalid', detail: 'first (primary)', location: { file: 'main.mthds' } },
            { code: 'method.wiring_invalid', detail: 'second (sibling)', location: { file: 'concepts.mthds' } },
            { code: 'method.wiring_invalid', detail: 'third (primary)', location: { file: 'main.mthds' } },
        ]);
        expect(result.map(r => r.error.detail)).toEqual(['first (primary)', 'second (sibling)', 'third (primary)']);
        expect(result.map(r => r.uri.toString())).toEqual([
            PRIMARY.uri.toString(),
            SIBLING.uri.toString(),
            PRIMARY.uri.toString(),
        ]);
    });

    it('places a file-owned item on the named file', () => {
        const [loc] = resolve([{ code: 'method.wiring_invalid', detail: 'x', location: { file: 'concepts.mthds' } }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a pipe-owned item (no file) on the declaring file', () => {
        const [loc] = resolve([{ code: 'pipe.failed', detail: 'x', location: { pipe: 'helper' } }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('places a concept-owned item (no file) on the declaring file', () => {
        const [loc] = resolve([{ code: 'method.concept_unresolved', detail: 'x', params: { concept: 'Foo' } }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
    });

    it('falls back to the primary file when nothing resolves, at range line 0', () => {
        const [loc] = resolve([{ code: 'method.invalid', detail: 'mystery' }]);
        expect(loc.uri.toString()).toBe(PRIMARY.uri.toString());
        expect(loc.range.start.line).toBe(0);
    });

    it('ranges a sibling-owned item from its on-disk lines (no open document)', () => {
        // [pipe.helper] is at line index 3 of the sibling.
        const [loc] = resolve([{ code: 'method.wiring_invalid', detail: 'x', location: { file: 'concepts.mthds', pipe: 'helper' } }]);
        expect(loc.uri.toString()).toBe(SIBLING.uri.toString());
        expect(loc.range.start.line).toBe(3);
    });

    it("carries the domain of the file that declares the item's pipe", () => {
        const [byFile, byScan] = resolve([
            { code: 'method.wiring_invalid', detail: 'x', location: { file: 'concepts.mthds', pipe: 'helper' } },
            { code: 'pipe.failed', detail: 'y', location: { pipe: 'main_pipe' } },
        ]);
        expect(byFile.pipeDomain).toBe('d');
        expect(byScan.pipeDomain).toBe('d');
    });

    it('carries no pipe domain when the owner does not declare the pipe, or is only the fallback', () => {
        const [elsewhere, fallback] = resolve([
            { code: 'method.pipe_unresolved', detail: 'x', location: { file: 'concepts.mthds', pipe: 'main_pipe' } },
            { code: 'method.pipe_unresolved', detail: 'y', location: { pipe: 'nowhere' } },
        ]);
        expect(elsewhere.pipeDomain).toBeUndefined();
        expect(fallback.pipeDomain).toBeUndefined();
    });

    it('routes a POSIX-relative `location.file` onto a backslash (Windows) fsPath', () => {
        // The backend can report a POSIX-style relative file (`subdir/concepts.mthds`)
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
            errors: [{ code: 'method.concept_invalid', detail: 'bad Foo', location: { file: 'subdir/concepts.mthds' } }],
            files: [winPrimary, winSibling],
            primaryUri: winPrimary.uri as any,
        });
        expect(loc.uri.toString()).toBe(winSibling.uri.toString());
    });

    it('ranges a primary-owned item from the OPEN document, not the on-disk text', () => {
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
            [{ code: 'pipe.failed', detail: 'x', location: { pipe: 'main_pipe' } }],
            primaryDocument,
        );
        expect(loc.uri.toString()).toBe(PRIMARY.uri.toString());
        expect(loc.range.start.line).toBe(1);
        expect(loc.range.end.character).toBe(999);
    });
});
