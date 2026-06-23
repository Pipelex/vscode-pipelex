import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    },
}));

import { hasTopLevelMainPipe, selectGraphPrimaryFile } from '../validation/graphPrimary';
import type { BundleFile } from '../validation/backend';

const DIR = '/project/methods';

function uri(fsPath: string) {
    return { fsPath, scheme: 'file', toString: () => `file://${fsPath}` } as any;
}

function makeFile(name: string, content: string): BundleFile {
    return { uri: uri(`${DIR}/${name}`), name, content };
}

describe('graph primary resolution', () => {
    it('keeps the opened file when it declares top-level main_pipe', () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\nmain_pipe = "run"\n[pipe.run]\n');
        const bundle = makeFile('bundle.mthds', 'domain = "d"\nmain_pipe = "other"\n[pipe.other]\n');

        const selected = selectGraphPrimaryFile(opened.uri, [opened, bundle]);

        expect(selected?.uri.toString()).toBe(opened.uri.toString());
    });

    it('selects sibling bundle.mthds when the opened file has no main_pipe', () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const bundle = makeFile('bundle.mthds', 'domain = "d"\nmain_pipe = "run"\n[pipe.run]\n');
        const other = makeFile('z_main.mthds', 'domain = "d"\nmain_pipe = "other"\n[pipe.other]\n');

        const selected = selectGraphPrimaryFile(opened.uri, [opened, bundle, other]);

        expect(selected?.uri.toString()).toBe(bundle.uri.toString());
    });

    it('selects the first gathered sibling with main_pipe when bundle.mthds has none', () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const first = makeFile('alpha.mthds', 'domain = "d"\nmain_pipe = "a"\n[pipe.a]\n');
        const second = makeFile('zeta.mthds', 'domain = "d"\nmain_pipe = "z"\n[pipe.z]\n');

        const selected = selectGraphPrimaryFile(opened.uri, [opened, first, second]);

        expect(selected?.uri.toString()).toBe(first.uri.toString());
    });

    it('falls back to the opened file when no sibling declares main_pipe', () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const sibling = makeFile('concepts.mthds', 'domain = "d"\n[concept.Thing]\n');

        const selected = selectGraphPrimaryFile(opened.uri, [opened, sibling]);

        expect(selected?.uri.toString()).toBe(opened.uri.toString());
    });

    it('only treats pre-table main_pipe as top-level', () => {
        expect(hasTopLevelMainPipe('domain = "d"\nmain_pipe = "run"\n[pipe.run]\n')).toBe(true);
        expect(hasTopLevelMainPipe('domain = "d"\n[pipe.run]\nmain_pipe = "run"\n')).toBe(false);
    });
});
