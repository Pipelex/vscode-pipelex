import { describe, it, expect } from 'vitest';
import { cancelInflightByKey, cancelAllInflight } from '../validation/processUtils';

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
