import { describe, it, expect } from 'vitest';
import { cancelInflightByKey, cancelAllInflight, cancelInflightInDir } from '../validation/processUtils';

// Inflight keys are `uri.toString()`; here their dir is just the path prefix.
const dirOf = (key: string) => key.slice(0, key.lastIndexOf('/'));

describe('cancelInflightByKey', () => {
    it('aborts and removes the matching entry', () => {
        const map = new Map<string, AbortController>();
        const controller = new AbortController();
        map.set('file:///a.mthds', controller);

        cancelInflightByKey(map, 'file:///a.mthds');

        expect(controller.signal.aborted).toBe(true);
        expect(map.has('file:///a.mthds')).toBe(false);
    });

    it('is a no-op for missing keys', () => {
        const map = new Map<string, AbortController>();
        const controller = new AbortController();
        map.set('file:///a.mthds', controller);

        cancelInflightByKey(map, 'file:///other.mthds');

        expect(controller.signal.aborted).toBe(false);
        expect(map.size).toBe(1);
    });
});

describe('cancelAllInflight', () => {
    it('aborts all entries and clears the map', () => {
        const map = new Map<string, AbortController>();
        const c1 = new AbortController();
        const c2 = new AbortController();
        map.set('file:///a.mthds', c1);
        map.set('file:///b.mthds', c2);

        cancelAllInflight(map);

        expect(c1.signal.aborted).toBe(true);
        expect(c2.signal.aborted).toBe(true);
        expect(map.size).toBe(0);
    });
});

describe('cancelInflightInDir', () => {
    it('aborts and removes only entries whose URI lives in the directory', () => {
        const map = new Map<string, AbortController>();
        const sibling = new AbortController();
        const sameDir = new AbortController();
        const otherDir = new AbortController();
        map.set('file:///proj/a.mthds', sibling);
        map.set('file:///proj/b.mthds', sameDir);
        map.set('file:///proj/sub/c.mthds', otherDir);

        cancelInflightInDir(map, 'file:///proj', dirOf);

        expect(sibling.signal.aborted).toBe(true);
        expect(sameDir.signal.aborted).toBe(true);
        expect(otherDir.signal.aborted).toBe(false);
        expect(map.has('file:///proj/a.mthds')).toBe(false);
        expect(map.has('file:///proj/b.mthds')).toBe(false);
        expect(map.has('file:///proj/sub/c.mthds')).toBe(true);
    });

    it('is a no-op when no entry matches the directory', () => {
        const map = new Map<string, AbortController>();
        const controller = new AbortController();
        map.set('file:///proj/a.mthds', controller);

        cancelInflightInDir(map, 'file:///elsewhere', dirOf);

        expect(controller.signal.aborted).toBe(false);
        expect(map.size).toBe(1);
    });
});
