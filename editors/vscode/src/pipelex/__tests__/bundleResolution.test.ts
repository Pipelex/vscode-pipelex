import { describe, it, expect, vi } from 'vitest';

// ---------- vscode mock ----------
// bundleResolution.ts pulls in sourceLocator, which does `import * as vscode`.
// Only `Uri.file` is touched at import time; the resolver logic itself is vscode-free.
vi.mock('vscode', () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    },
}));

import { resolveDeclaringFile, matchSourceFile, findDeclaringFileByScan } from '../validation/bundleResolution';
import type { BundleFile } from '../validation/backend';

const DIR = '/project/methods';

function makeFile(fsPath: string, name: string, content: string): BundleFile {
    return { uri: { fsPath, scheme: 'file', toString: () => `file://${fsPath}` } as any, name, content };
}

const getLines = (f: BundleFile): string[] => f.content.split(/\r\n|\r|\n/);

// A signature/concrete split: the primary holds the signature, a sibling the concrete impl.
const SIGNATURE = makeFile(`${DIR}/bundle.mthds`, 'bundle.mthds',
    'domain = "rec"\n[pipe.screen]\ntype = "PipeSignature"\n');
const CONCRETE = makeFile(`${DIR}/screen.mthds`, 'screen.mthds',
    'domain = "rec"\n[pipe.screen]\ntype = "PipeSequence"\n[pipe.build]\ntype = "PipeLLM"\n');
const CONCEPTS = makeFile(`${DIR}/concepts.mthds`, 'concepts.mthds',
    'domain = "rec"\n[concept.Scorecard]\ndescription = "x"\n');

describe('resolveDeclaringFile — source-first tier', () => {
    const files = [SIGNATURE, CONCRETE, CONCEPTS];

    it('resolves an absolute `source` path to its file (over a same-code signature)', () => {
        // `screen` is declared in BOTH bundle.mthds (signature) and screen.mthds
        // (concrete). The registry source points at the concrete impl — the win
        // a pure header scan (which would hit the signature first) cannot make.
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'screen', domainCode: 'rec',
            source: `${DIR}/screen.mthds`, files, getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCRETE.uri.toString());
    });

    it('resolves a bare-basename `source` by basename', () => {
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'screen', source: 'screen.mthds', files, getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCRETE.uri.toString());
    });

    it('resolves a relative-with-subdir `source` on a path-segment boundary', () => {
        const subFile = makeFile('/root/sub/impl.mthds', 'impl.mthds', 'domain = "d"\n[pipe.p]\n');
        const decoy = makeFile('/root/other/impl.mthds', 'impl.mthds', 'domain = "d"\n[pipe.p]\n');
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'p', source: 'sub/impl.mthds', files: [decoy, subFile], getLines,
        });
        expect(owner?.uri.toString()).toBe(subFile.uri.toString());
    });

    it('falls through to the scan when `source` names a file outside the gathered set', () => {
        // source misses, but `screen` is declared in the gathered files → scan wins.
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'build', source: '/elsewhere/lib.mthds', files, getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCRETE.uri.toString());
    });

    it('falls through to the scan when `source` names a file without the declaration header', () => {
        const stale = makeFile(`${DIR}/stale.mthds`, 'stale.mthds', 'domain = "rec"\n[pipe.other]\n');
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'build', source: `${DIR}/stale.mthds`, files: [SIGNATURE, stale, CONCRETE], getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCRETE.uri.toString());
    });
});

describe('resolveDeclaringFile — scan fallback tier (no source)', () => {
    it('finds the file declaring `[pipe.<code>]`', () => {
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'build', files: [SIGNATURE, CONCRETE, CONCEPTS], getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCRETE.uri.toString());
    });

    it('finds the file declaring `[concept.<code>]`', () => {
        const owner = resolveDeclaringFile({
            kind: 'concept', code: 'Scorecard', files: [SIGNATURE, CONCRETE, CONCEPTS], getLines,
        });
        expect(owner?.uri.toString()).toBe(CONCEPTS.uri.toString());
    });

    it('returns undefined when no file declares the code', () => {
        const owner = resolveDeclaringFile({
            kind: 'pipe', code: 'nonexistent', files: [SIGNATURE, CONCRETE, CONCEPTS], getLines,
        });
        expect(owner).toBeUndefined();
    });

    it('does not match a longer header like `[pipe.screen.outcomes]` for code `screen`', () => {
        const sub = makeFile(`${DIR}/route.mthds`, 'route.mthds',
            'domain = "rec"\n[pipe.route]\n[pipe.route.outcomes]\n');
        const owner = resolveDeclaringFile({ kind: 'pipe', code: 'route', files: [sub], getLines });
        // Lands on the real `[pipe.route]` header, not the `.outcomes` sub-table.
        expect(owner?.uri.toString()).toBe(sub.uri.toString());
        expect(findTableHeaderLine(sub, 'route')).toBe(1);
    });
});

describe('findDeclaringFileByScan — domain-disambiguated collision', () => {
    // Same `[pipe.process]` declared in two files under DIFFERENT domains.
    const fileA = makeFile(`${DIR}/a.mthds`, 'a.mthds', 'domain = "alpha"\n[pipe.process]\ntype = "PipeLLM"\n');
    const fileB = makeFile(`${DIR}/b.mthds`, 'b.mthds', 'domain = "beta"\n[pipe.process]\ntype = "PipeLLM"\n');

    it('prefers the file whose domain matches when domainCode is known', () => {
        const owner = findDeclaringFileByScan('pipe', 'process', [fileA, fileB], 'beta', getLines);
        expect(owner?.uri.toString()).toBe(fileB.uri.toString());
    });

    it('falls back to the first match when domainCode is unknown', () => {
        const owner = findDeclaringFileByScan('pipe', 'process', [fileA, fileB], undefined, getLines);
        expect(owner?.uri.toString()).toBe(fileA.uri.toString());
    });

    it('falls back to the first match when no file declares the named domain', () => {
        const owner = findDeclaringFileByScan('pipe', 'process', [fileA, fileB], 'gamma', getLines);
        expect(owner?.uri.toString()).toBe(fileA.uri.toString());
    });

    it('ignores a `domain = ` that appears inside a table section, not at top level', () => {
        // A nested `domain = ` after the first `[...]` header must not satisfy the
        // domain check (it scans only the top-level prelude).
        const nested = makeFile(`${DIR}/c.mthds`, 'c.mthds',
            '[pipe.process]\ntype = "PipeLLM"\ndomain = "beta"\n');
        const owner = findDeclaringFileByScan('pipe', 'process', [fileA, nested], 'beta', getLines);
        // `nested` has no top-level domain, so the real top-level `beta` (none here)
        // isn't found → first match (fileA) wins.
        expect(owner?.uri.toString()).toBe(fileA.uri.toString());
    });

    it('does not accept mismatched quotes in a top-level domain declaration', () => {
        const malformed = makeFile(`${DIR}/malformed.mthds`, 'malformed.mthds',
            'domain = "beta\'\n[pipe.process]\ntype = "PipeLLM"\n');
        const owner = findDeclaringFileByScan('pipe', 'process', [fileA, malformed], 'beta', getLines);
        expect(owner?.uri.toString()).toBe(fileA.uri.toString());
    });
});

describe('matchSourceFile — path normalization', () => {
    it('does not guess when a bare source basename is ambiguous', () => {
        const a = makeFile('/x/foo/a.mthds', 'a.mthds', '');
        const b = makeFile('/x/bar/a.mthds', 'a.mthds', '');
        expect(matchSourceFile('a.mthds', [a, b])).toBeUndefined();
    });

    it('matches a Windows backslash fsPath from a POSIX relative source', () => {
        const win = makeFile('C:\\proj\\sub\\a.mthds', 'a.mthds', '');
        expect(matchSourceFile('sub/a.mthds', [win])?.uri.toString()).toBe(win.uri.toString());
    });

    it('returns undefined when nothing matches', () => {
        expect(matchSourceFile('/nope/x.mthds', [SIGNATURE])).toBeUndefined();
    });
});

/** Helper: the 0-based line of `[pipe.<code>]` in a file, for header-placement assertions. */
function findTableHeaderLine(file: BundleFile, code: string): number {
    const lines = getLines(file);
    const re = new RegExp(`^\\s*\\[pipe\\.${code}\\]`);
    return lines.findIndex(l => re.test(l));
}
