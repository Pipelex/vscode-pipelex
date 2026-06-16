import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const apiState = vi.hoisted(() => ({
    validate: null as null | ((c: string[], a: boolean, n?: string[]) => Promise<any>),
    version: null as null | (() => Promise<any>),
    lastValidateArgs: null as any,
    lastConstructorOptions: null as any,
}));

// ---------- vscode mock (ApiVersionGate uses window.showWarningMessage) ----------
vi.mock('vscode', () => ({
    window: { showWarningMessage: vi.fn() },
}));

// ---------- mthds mock (classes defined inside the hoisted factory) ----------
vi.mock('mthds', () => {
    class ApiResponseError extends Error {
        constructor(
            public status: number,
            public errorType: string | undefined,
            public serverMessage: string | undefined,
            public validationErrors: any[] | undefined,
            public apiUrl = 'http://localhost:8081',
            public statusText = 'Unprocessable Entity',
        ) {
            super(serverMessage ?? 'api error');
            this.name = 'ApiResponseError';
        }
    }
    class ApiUnreachableError extends Error {
        constructor(public apiUrl: string, public code: string | undefined) {
            super('unreachable');
            this.name = 'ApiUnreachableError';
        }
    }
    class MthdsApiClient {
        constructor(options: any) { apiState.lastConstructorOptions = options; }
        async validate(contents: string[], allow: boolean, names?: string[]) {
            apiState.lastValidateArgs = [contents, allow, names];
            return apiState.validate!(contents, allow, names);
        }
        async version() {
            return apiState.version ? apiState.version() : { protocol_version: '1', implementation_version: '0.4.0' };
        }
    }
    return { MthdsApiClient, ApiResponseError, ApiUnreachableError };
});

import { ApiResponseError, ApiUnreachableError } from 'mthds';
import { ApiValidationBackend } from '../validation/apiValidationBackend';
import { ApiVersionGate } from '../validation/apiVersionGate';
import { BackendError } from '../validation/backend';

function mockOutput() {
    return { appendLine: vi.fn() } as any;
}

function makeBackend(opts?: { baseUrl?: string; confirmRemote?: () => Promise<boolean> }) {
    const output = mockOutput();
    return new ApiValidationBackend({
        baseUrl: opts?.baseUrl ?? 'http://localhost:8081',
        getToken: async () => 'secret-token',
        versionGate: new ApiVersionGate(output),
        confirmRemote: opts?.confirmRemote ?? (async () => true),
        output,
    });
}

const FILES = [{ uri: { fsPath: '/p/a.mthds', toString: () => 'file:///p/a.mthds' } as any, name: 'a.mthds', content: 'domain="d"' }];

function analyze(backend: ApiValidationBackend, withGraph = false) {
    const controller = new AbortController();
    return backend.analyze(
        { primaryUri: FILES[0].uri, files: FILES, timeout: 30000 },
        { withGraph },
        controller.signal,
    );
}

describe('ApiValidationBackend', () => {
    beforeEach(() => {
        apiState.validate = null;
        apiState.version = null;
        apiState.lastValidateArgs = null;
        apiState.lastConstructorOptions = null;
    });

    it('returns ok + graph on a valid bundle, and sends mthds_names', async () => {
        apiState.validate = async () => ({ success: true, graph_spec: { nodes: [], edges: [] } });
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.graph).toEqual({ nodes: [], edges: [] });
        // contents + allowSignatures=true + parallel names
        expect(apiState.lastValidateArgs).toEqual([['domain="d"'], true, ['a.mthds']]);
    });

    it('passes the resolved token to the client constructor (SecretStorage precedence)', async () => {
        apiState.validate = async () => ({ success: true });
        await analyze(makeBackend());
        expect(apiState.lastConstructorOptions).toEqual({ baseUrl: 'http://localhost:8081', apiToken: 'secret-token' });
    });

    it('maps a 422 with validationErrors to a not-ok outcome', async () => {
        apiState.validate = async () => { throw new ApiResponseError(422, 'ValidateBundleError', 'invalid', [{ category: 'pipe_validation', message: 'bad', source: 'a.mthds' }]); };
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toHaveLength(1);
        expect(analysis.validation.errors[0].source).toBe('a.mthds');
        expect(analysis.graph).toBeNull();
    });

    it('synthesizes a single diagnostic for a 422 ValidateBundleError with no per-error list', async () => {
        apiState.validate = async () => { throw new ApiResponseError(422, 'ValidateBundleError', 'whole bundle failed dry-run', undefined); };
        const analysis = await analyze(makeBackend());
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([{ category: 'blueprint_validation', message: 'whole bundle failed dry-run', error_type: 'ValidateBundleError' }]);
    });

    it('maps a self-hosted 401 to an auth BackendError with a single Set-API-Key action', async () => {
        apiState.validate = async () => { throw new ApiResponseError(401, 'AuthError', 'unauthorized', undefined); };
        const err = await analyze(makeBackend()).catch(e => e); // default baseUrl is localhost (self-hosted)
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        expect(err.userMessage).toMatch(/Set Hosted API Key/);
        // Self-hosted: only the "Set API Key" remedy (no platform "Get a key" link).
        expect(err.actions).toEqual([{ label: 'Set API Key', command: 'pipelex.setApiKey' }]);
    });

    it('maps a hosted 401/403 to an auth BackendError with Set + Get-a-key actions and host-aware text', async () => {
        apiState.validate = async () => { throw new ApiResponseError(403, 'AuthError', 'forbidden', undefined); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        expect(err.userMessage).toMatch(/HTTP 403/);
        expect(err.userMessage).toMatch(/app\.pipelex\.com/);
        expect(err.userMessage).toMatch(/`cli`/);
        expect(err.actions).toEqual([
            { label: 'Set API Key', command: 'pipelex.setApiKey' },
            { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
        ]);
    });

    it('maps a 5xx to an api-error BackendError (server reached, errored)', async () => {
        apiState.validate = async () => { throw new ApiResponseError(503, undefined, 'service unavailable', undefined, 'https://api.pipelex.com', 'Service Unavailable'); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
    });

    it('maps ApiUnreachableError to a transport BackendError', async () => {
        apiState.validate = async () => { throw new ApiUnreachableError('http://localhost:8081', 'ECONNREFUSED'); };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
        expect(err.userMessage).toMatch(/is pipelex-api running/);
    });

    it('uses a network-flavored unreachable message for the hosted API (not "is pipelex-api running")', async () => {
        apiState.validate = async () => { throw new ApiUnreachableError('https://api.pipelex.com', 'ENOTFOUND'); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
        expect(err.userMessage).not.toMatch(/is pipelex-api running/);
        expect(err.userMessage).toMatch(/hosted Pipelex API may be temporarily unavailable/);
    });

    it('maps a non-problem+json / unparseable failure to a transport BackendError', async () => {
        apiState.validate = async () => { throw new SyntaxError('Unexpected token < in JSON'); };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
    });

    it('declines a non-localhost send when the user does not confirm', async () => {
        apiState.validate = async () => ({ success: true });
        const backend = makeBackend({ baseUrl: 'https://api.pipelex.com', confirmRemote: async () => false });
        const err = await analyze(backend).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('declined');
        // No request was sent.
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('proceeds with a remote send when the user confirms', async () => {
        apiState.validate = async () => ({ success: true });
        const backend = makeBackend({ baseUrl: 'https://api.pipelex.com', confirmRemote: async () => true });
        const analysis = await analyze(backend);
        expect(analysis.validation.ok).toBe(true);
        expect(apiState.lastValidateArgs).not.toBeNull();
    });
});
