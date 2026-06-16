import { describe, it, expect, vi, beforeEach } from 'vitest';

const showWarning = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({ window: { showWarningMessage: showWarning } }));

import { ApiVersionGate, parseCleanRelease } from '../validation/apiVersionGate';

function clientReturning(implementationVersion: string | undefined, onCall?: () => void) {
    return {
        version: vi.fn(async () => {
            onCall?.();
            return { protocol_version: '1', implementation_version: implementationVersion };
        }),
    } as any;
}

describe('parseCleanRelease', () => {
    it('parses a clean release', () => {
        expect(parseCleanRelease('0.4.0')).toEqual([0, 4, 0]);
        expect(parseCleanRelease('1.12.3')).toEqual([1, 12, 3]);
    });
    it('returns null (lenient → capable) for prerelease / dev / non-semver / missing', () => {
        expect(parseCleanRelease('0.4.0-dev')).toBeNull();
        expect(parseCleanRelease('latest')).toBeNull();
        expect(parseCleanRelease('0.4')).toBeNull();
        expect(parseCleanRelease(undefined)).toBeNull();
    });
});

describe('ApiVersionGate.ensureCapable', () => {
    beforeEach(() => showWarning.mockClear());

    it('warns once for a clean release below the floor', async () => {
        const gate = new ApiVersionGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(clientReturning('0.3.0'), 'http://localhost:8081');
        expect(showWarning).toHaveBeenCalledTimes(1);
    });

    it('does not warn for a version at or above the floor', async () => {
        const gate = new ApiVersionGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(clientReturning('0.4.0'), 'http://localhost:8081');
        expect(showWarning).not.toHaveBeenCalled();
    });

    it('does not warn for a prerelease/dev tag (lenient)', async () => {
        const gate = new ApiVersionGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(clientReturning('0.3.0-dev'), 'http://localhost:8081');
        expect(showWarning).not.toHaveBeenCalled();
    });

    it('probes /version only once per base URL', async () => {
        const gate = new ApiVersionGate({ appendLine: vi.fn() } as any);
        const client = clientReturning('0.4.0');
        await gate.ensureCapable(client, 'http://localhost:8081');
        await gate.ensureCapable(client, 'http://localhost:8081');
        expect(client.version).toHaveBeenCalledTimes(1);
    });

    it('does not throw or cache when /version fails (best-effort)', async () => {
        const gate = new ApiVersionGate({ appendLine: vi.fn() } as any);
        const failing = { version: vi.fn(async () => { throw new Error('down'); }) } as any;
        await expect(gate.ensureCapable(failing, 'http://localhost:8081')).resolves.toBeUndefined();
        // not cached → a later capable probe still runs
        await gate.ensureCapable(failing, 'http://localhost:8081');
        expect(failing.version).toHaveBeenCalledTimes(2);
    });
});
