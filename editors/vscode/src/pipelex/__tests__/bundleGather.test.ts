import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = vi.hoisted(() => ({
    entries: [] as string[],
    contents: {} as Record<string, string>,
}));

vi.mock('fs', () => ({
    promises: {
        readdir: vi.fn(async () => fsState.entries),
        readFile: vi.fn(async (p: string) => {
            const name = p.split('/').pop()!;
            if (!(name in fsState.contents)) throw new Error(`ENOENT ${p}`);
            return fsState.contents[name];
        }),
    },
}));

vi.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }) },
}));

import { gatherBundleFiles } from '../validation/bundleGather';

const DIR = '/project/methods';
const primary = { fsPath: `${DIR}/main.mthds`, toString: () => `file://${DIR}/main.mthds` } as any;

describe('gatherBundleFiles', () => {
    beforeEach(() => {
        fsState.entries = ['main.mthds', 'zeta.mthds', 'alpha.mthds', 'notes.txt', 'legacy.plx'];
        fsState.contents = {
            'main.mthds': 'M',
            'zeta.mthds': 'Z',
            'alpha.mthds': 'A',
            'legacy.plx': 'L',
            'notes.txt': 'ignored',
        };
    });

    it('gathers .mthds files, primary first, siblings sorted, excludes other extensions', async () => {
        const files = await gatherBundleFiles(primary);
        expect(files.map(f => f.name)).toEqual(['main.mthds', 'alpha.mthds', 'zeta.mthds']);
        expect(files.find(f => f.name === 'notes.txt')).toBeUndefined();
        // `.plx` is no longer a recognized bundle extension — it is excluded like any
        // other non-.mthds file.
        expect(files.find(f => f.name === 'legacy.plx')).toBeUndefined();
    });

    it('reads each file content and keeps the primary URI for the primary file', async () => {
        const files = await gatherBundleFiles(primary);
        const main = files[0];
        expect(main.content).toBe('M');
        expect(main.uri.toString()).toBe(primary.toString());
        expect(files.find(f => f.name === 'alpha.mthds')!.content).toBe('A');
    });

    it('skips a sibling that vanished between readdir and read', async () => {
        delete fsState.contents['zeta.mthds'];
        const files = await gatherBundleFiles(primary);
        expect(files.map(f => f.name)).toEqual(['main.mthds', 'alpha.mthds']);
    });

    it('falls back to just the primary when the directory is unreadable', async () => {
        const fs = await import('fs');
        vi.mocked(fs.promises.readdir).mockRejectedValueOnce(new Error('EACCES'));
        const files = await gatherBundleFiles(primary);
        expect(files.map(f => f.name)).toEqual(['main.mthds']);
    });
});
