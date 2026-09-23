import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- vscode mock ----------
// `settings` stands in for what the user set: a key absent from it is unset, so
// `config.get(key, fallback)` returns the fallback the factory passes — exactly
// what VS Code does for a setting nobody wrote (with the contributed default).
const mockState = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    showWarningMessage: null as any,
}));

vi.mock('vscode', () => {
    mockState.showWarningMessage = vi.fn();
    return {
        workspace: {
            getConfiguration: vi.fn(() => ({
                get: (key: string, fallback: unknown) => (key in mockState.settings ? mockState.settings[key] : fallback),
            })),
        },
        window: { showWarningMessage: mockState.showWarningMessage },
    };
});

import { BackendFactory, DEFAULT_API_BASE_URL, DEFAULT_BACKEND, SEND_TO_API_CHOICE } from '../validation/backendFactory';
import { ApiValidationBackend } from '../validation/apiValidationBackend';
import { CliValidationBackend } from '../validation/cliValidationBackend';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
const props: Record<string, { default?: unknown }> =
    JSON.parse(readFileSync(pkgPath, 'utf-8')).contributes.configuration.properties;

function makeContext() {
    const globalState = new Map<string, unknown>();
    return {
        secrets: { get: vi.fn(async () => undefined) },
        globalState: {
            get: vi.fn((key: string) => globalState.get(key)),
            update: vi.fn(async (key: string, value: unknown) => { globalState.set(key, value); }),
        },
    } as any;
}

function makeFactory(context = makeContext()) {
    return new BackendFactory(context, { appendLine: vi.fn() } as any);
}

/** The consent callback the factory wires into an API backend. */
function confirmRemoteOf(factory: BackendFactory): (baseUrl: string) => Promise<boolean> {
    const backend = factory.getBackend();
    expect(backend).toBeInstanceOf(ApiValidationBackend);
    return (backend as any).deps.confirmRemote;
}

describe('BackendFactory — defaults', () => {
    beforeEach(() => {
        mockState.settings = {};
        mockState.showWarningMessage.mockReset();
    });

    it('the code fallbacks match the defaults package.json contributes', () => {
        expect(props['pipelex.backend'].default).toBe(DEFAULT_BACKEND);
        expect(props['pipelex.api.baseUrl'].default).toBe(DEFAULT_API_BASE_URL);
    });

    it('defaults to the api backend on https://api.pipelex.com', () => {
        const factory = makeFactory();
        expect(factory.backendKind()).toBe('api');
        const backend = factory.getBackend();
        expect(backend).toBeInstanceOf(ApiValidationBackend);
        expect((backend as any).deps.baseUrl).toBe('https://api.pipelex.com');
    });

    it('selects the CLI only when pipelex.backend is explicitly cli', () => {
        mockState.settings = { backend: 'cli' };
        const factory = makeFactory();
        expect(factory.backendKind()).toBe('cli');
        expect(factory.getBackend()).toBeInstanceOf(CliValidationBackend);
    });

    it('treats a malformed pipelex.backend as the default api backend', () => {
        mockState.settings = { backend: 'grpc' };
        expect(makeFactory().getBackend()).toBeInstanceOf(ApiValidationBackend);
    });

    it('honours a configured base URL, and falls back to the default for an empty one', () => {
        mockState.settings = { 'api.baseUrl': 'http://localhost:8081' };
        expect((makeFactory().getBackend() as any).deps.baseUrl).toBe('http://localhost:8081');
        mockState.settings = { 'api.baseUrl': '' };
        expect((makeFactory().getBackend() as any).deps.baseUrl).toBe(DEFAULT_API_BASE_URL);
    });
});

describe('BackendFactory — remote-send consent', () => {
    beforeEach(() => {
        mockState.settings = {};
        mockState.showWarningMessage.mockReset();
    });

    it('asks in words that suit a user who never chose the API backend', async () => {
        mockState.showWarningMessage.mockResolvedValueOnce(SEND_TO_API_CHOICE);
        await confirmRemoteOf(makeFactory())('https://api.pipelex.com');

        const [message, options, ...buttons] = mockState.showWarningMessage.mock.calls[0];
        expect(message).toContain('api.pipelex.com');
        expect(options.modal).toBe(true);
        // The whole directory is sent, not just the active file — and where to.
        expect(options.detail).toContain('every .mthds file');
        expect(options.detail).toContain('not just the active file');
        expect(options.detail).toContain('https://api.pipelex.com');
        // The way to keep files local.
        expect(options.detail).toContain('pipelex.backend to cli');
        // Not phrased as though the user had picked a backend.
        expect(`${message} ${options.detail}`).not.toContain('API backend');
        expect(buttons).toEqual([SEND_TO_API_CHOICE]);
    });

    it('remembers a grant per host across calls', async () => {
        const context = makeContext();
        const confirm = confirmRemoteOf(makeFactory(context));
        mockState.showWarningMessage.mockResolvedValueOnce(SEND_TO_API_CHOICE);

        expect(await confirm('https://api.pipelex.com')).toBe(true);
        expect(await confirm('https://api.pipelex.com')).toBe(true);
        expect(mockState.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(context.globalState.update).toHaveBeenCalledWith('pipelex.api.remoteConsent.api.pipelex.com', true);
    });

    it('remembers a decline for the session only, so the modal does not return on every save', async () => {
        const context = makeContext();
        const confirm = confirmRemoteOf(makeFactory(context));
        mockState.showWarningMessage.mockResolvedValueOnce(undefined); // dismissed / Cancel

        expect(await confirm('https://api.pipelex.com')).toBe(false);
        expect(await confirm('https://api.pipelex.com')).toBe(false);
        expect(mockState.showWarningMessage).toHaveBeenCalledTimes(1);
        // Never persisted: a new session (a new factory, as after a reload) asks again.
        expect(context.globalState.update).not.toHaveBeenCalled();
        mockState.showWarningMessage.mockResolvedValueOnce(SEND_TO_API_CHOICE);
        expect(await confirmRemoteOf(makeFactory(context))('https://api.pipelex.com')).toBe(true);
        expect(mockState.showWarningMessage).toHaveBeenCalledTimes(2);
    });

    it('keeps consent per host: a decline on one host does not silence another', async () => {
        const confirm = confirmRemoteOf(makeFactory());
        mockState.showWarningMessage.mockResolvedValueOnce(undefined);
        mockState.showWarningMessage.mockResolvedValueOnce(SEND_TO_API_CHOICE);

        expect(await confirm('https://api.pipelex.com')).toBe(false);
        expect(await confirm('https://pipelex.internal.example')).toBe(true);
        expect(mockState.showWarningMessage).toHaveBeenCalledTimes(2);
    });
});
