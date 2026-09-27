import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    },
}));

vi.mock('../validation/bundleGather', () => ({
    gatherBundleFiles: vi.fn(),
}));

import { resolveGraphPrimaryBundle } from '../validation/graphPrimary';
import * as bundleGather from '../validation/bundleGather';
import type { BundleFile } from '../validation/backend';

/**
 * The rule itself (which file leads) is `@pipelex/mthds-ui`'s and is tested
 * there. What these cases pin is this host's side of it: that the opened URI
 * reaches the rule as its `preferred` file, and that the answer comes back as
 * the anchor URI plus the files in merge order, with the rest in gather order.
 */

const DIR = '/project/methods';

function uri(fsPath: string) {
    return { fsPath, scheme: 'file', toString: () => `file://${fsPath}` } as any;
}

function makeFile(name: string, content: string): BundleFile {
    return { uri: uri(`${DIR}/${name}`), name, content };
}

/** Gather returns the opened file first, then its siblings by name, as the real one does. */
async function resolveWith(opened: BundleFile, siblings: BundleFile[]) {
    vi.mocked(bundleGather.gatherBundleFiles).mockResolvedValueOnce([opened, ...siblings]);
    const resolved = await resolveGraphPrimaryBundle(opened.uri);
    return {
        primary: resolved.primaryUri.toString(),
        order: resolved.files.map(file => file.name),
    };
}

describe('graph primary resolution', () => {
    it('keeps the opened file when it declares top-level main_pipe', async () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\nmain_pipe = "run"\n[pipe.run]\n');
        const bundle = makeFile('bundle.mthds', 'domain = "d"\nmain_pipe = "other"\n[pipe.other]\n');

        const { primary, order } = await resolveWith(opened, [bundle]);

        expect(primary).toBe(opened.uri.toString());
        expect(order).toEqual(['helper.mthds', 'bundle.mthds']);
    });

    it('leads with sibling bundle.mthds when the opened file has no main_pipe', async () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const alpha = makeFile('alpha.mthds', 'domain = "d"\nmain_pipe = "a"\n[pipe.a]\n');
        const bundle = makeFile('bundle.mthds', 'domain = "d"\nmain_pipe = "run"\n[pipe.run]\n');

        const { primary, order } = await resolveWith(opened, [alpha, bundle]);

        expect(primary).toBe(bundle.uri.toString());
        expect(order).toEqual(['bundle.mthds', 'helper.mthds', 'alpha.mthds']);
    });

    it('leads with the first gathered sibling with main_pipe when bundle.mthds has none', async () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const first = makeFile('alpha.mthds', 'domain = "d"\nmain_pipe = "a"\n[pipe.a]\n');
        const second = makeFile('zeta.mthds', 'domain = "d"\nmain_pipe = "z"\n[pipe.z]\n');

        const { primary, order } = await resolveWith(opened, [first, second]);

        expect(primary).toBe(first.uri.toString());
        expect(order).toEqual(['alpha.mthds', 'helper.mthds', 'zeta.mthds']);
    });

    it('falls back to the opened file when no sibling declares main_pipe', async () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.helper]\n');
        const sibling = makeFile('concepts.mthds', 'domain = "d"\n[concept.Thing]\n');

        const { primary, order } = await resolveWith(opened, [sibling]);

        expect(primary).toBe(opened.uri.toString());
        expect(order).toEqual(['helper.mthds', 'concepts.mthds']);
    });

    it('does not let a main_pipe key inside a table promote the opened file', async () => {
        const opened = makeFile('helper.mthds', 'domain = "d"\n[pipe.run]\nmain_pipe = "run"\n');
        const bundle = makeFile('bundle.mthds', 'domain = "d"\nmain_pipe = "run"\n[pipe.run]\n');

        const { primary } = await resolveWith(opened, [bundle]);

        expect(primary).toBe(bundle.uri.toString());
    });

    it('anchors on the opened URI when the gather returns nothing', async () => {
        const opened = uri(`${DIR}/helper.mthds`);
        vi.mocked(bundleGather.gatherBundleFiles).mockResolvedValueOnce([]);

        const resolved = await resolveGraphPrimaryBundle(opened);

        expect(resolved.primaryUri).toBe(opened);
        expect(resolved.files).toEqual([]);
    });

    it('propagates gather failures instead of returning an empty API bundle', async () => {
        const opened = uri(`${DIR}/helper.mthds`);
        vi.mocked(bundleGather.gatherBundleFiles).mockRejectedValueOnce(new Error('disk gone'));

        await expect(resolveGraphPrimaryBundle(opened)).rejects.toThrow('disk gone');
    });
});
