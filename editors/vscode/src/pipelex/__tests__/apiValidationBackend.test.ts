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
    class PipelineRequestError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'PipelineRequestError';
        }
    }
    class MthdsApiClient {
        constructor(options: any) {
            apiState.lastConstructorOptions = options;
            // Mirror the real client: reject a non-host-only base URL (the common
            // trigger is a pasted `/v1` path), throwing PipelineRequestError.
            const url = new URL(options.baseUrl);
            if (url.pathname !== '/' && url.pathname !== '') {
                throw new PipelineRequestError(`Invalid API base URL "${options.baseUrl}": must be host-only.`);
            }
        }
        async validate(contents: string[], allow: boolean, names?: string[]) {
            apiState.lastValidateArgs = [contents, allow, names];
            return apiState.validate!(contents, allow, names);
        }
        async version() {
            return apiState.version ? apiState.version() : { protocol_version: '1', implementation_version: '0.4.0' };
        }
    }
    return { MthdsApiClient, ApiResponseError, ApiUnreachableError, PipelineRequestError };
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

    it('returns ok + graph on a valid bundle, and sends mthds_sources', async () => {
        apiState.validate = async () => ({ is_valid: true, graph_spec: { nodes: [], edges: [] } });
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.graph).toEqual({ nodes: [], edges: [] });
        // contents + allowSignatures=true + parallel sources (file names)
        expect(apiState.lastValidateArgs).toEqual([['domain="d"'], true, ['a.mthds']]);
    });

    it('passes the resolved token to the client constructor (SecretStorage precedence)', async () => {
        apiState.validate = async () => ({ is_valid: true });
        await analyze(makeBackend());
        expect(apiState.lastConstructorOptions).toEqual({ baseUrl: 'http://localhost:8081', apiToken: 'secret-token' });
    });

    it('maps a 200 invalid verdict (is_valid:false) to a not-ok outcome with the structured errors', async () => {
        // 200-diagnostic: an invalid bundle is a produced verdict in the body, not a throw.
        apiState.validate = async () => ({
            is_valid: false,
            validation_errors: [{ category: 'pipe_validation', message: 'bad', source: 'a.mthds' }],
            pending_signatures: [],
            is_runnable: false,
            message: 'MTHDS validation found errors',
        });
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toHaveLength(1);
        expect(analysis.validation.errors[0].source).toBe('a.mthds');
        expect(analysis.graph).toBeNull();
    });

    it('consumes a dry_run residual item directly — no fabricated category', async () => {
        // The runtime's structured-info invariant is total: a dry-run failure rides
        // a `dry_run` item (no source). The backend passes it through verbatim — the
        // old `blueprint_validation` synthesis is gone.
        apiState.validate = async () => ({
            is_valid: false,
            validation_errors: [{ category: 'dry_run', error_type: 'DryRunError', message: 'Dry run failed: ...' }],
            pending_signatures: [],
            is_runnable: false,
            message: 'MTHDS validation found errors',
        });
        const analysis = await analyze(makeBackend());
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([
            { category: 'dry_run', error_type: 'DryRunError', message: 'Dry run failed: ...' },
        ]);
    });

    it('treats is_valid:false with an empty validation_errors as an api-error BackendError (contract violation)', async () => {
        // The runtime invariant is total: an invalid verdict ALWAYS carries a
        // non-empty validation_errors[] (mirrors the CLI parseFailure guard). An
        // empty list during a server regression must NOT publish zero diagnostics —
        // it is a no-verdict backend error so stale diagnostics are cleared, not hidden.
        apiState.validate = async () => ({
            is_valid: false,
            validation_errors: [],
            is_runnable: false,
            message: 'MTHDS validation found errors',
        });
        const err = await analyze(makeBackend(), true).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        // No empty invalid outcome leaked through.
        expect(err.logMessage).toMatch(/no validation_errors/);
    });

    it('treats is_valid:false with a missing validation_errors as an api-error BackendError', async () => {
        apiState.validate = async () => ({ is_valid: false, is_runnable: false, message: 'x' });
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
    });

    it('treats a non-object 200 body (literal null) as an api-error BackendError, not a TypeError', async () => {
        // The mthds client JSON.parses without shape-validating, so a 200 with body
        // `null` resolves `report` to null. Reading `report.is_valid` would throw a
        // TypeError that escapes to the generic error path — guard it as a malformed
        // (no-verdict) response instead.
        apiState.validate = async () => null;
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.logMessage).toMatch(/non-object/);
    });

    it('maps a request-shape 422 (no verdict) to an api-error BackendError', async () => {
        // `/validate` never 422s a content verdict now — a 422 is a request-shape
        // problem (e.g. mthds_sources length mismatch), surfaced as api-error.
        apiState.validate = async () => { throw new ApiResponseError(422, 'ValidationError', 'mthds_sources length must match mthds_contents', undefined); };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
    });

    it('maps a self-hosted 401 to an auth BackendError with a single Set-API-Key action', async () => {
        apiState.validate = async () => { throw new ApiResponseError(401, 'AuthError', 'unauthorized', undefined); };
        const err = await analyze(makeBackend()).catch(e => e); // default baseUrl is localhost (self-hosted)
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        expect(err.userMessage).toMatch(/Set Hosted API Key/);
        // Self-hosted: only the "Set API Key" remedy (no platform "Get a key" link).
        expect(err.actions).toEqual([{ label: 'Set API Key', command: 'pipelex.setApiKey' }]);
        // No platform/self-host pointers — you already run the server.
        expect(err.detailHtml).toBeTruthy();
        expect(err.detailHtml).not.toContain('app.pipelex.com');
        expect(err.detailHtml).not.toContain('github.com');
    });

    it('maps a hosted 401/403 to an auth BackendError with Set + Get-a-key actions and clickable rich detail', async () => {
        apiState.validate = async () => { throw new ApiResponseError(403, 'AuthError', 'forbidden', undefined); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        // Plain-text (toast) message covers all three paths.
        expect(err.userMessage).toMatch(/HTTP 403/);
        expect(err.userMessage).toMatch(/app\.pipelex\.com/);
        expect(err.userMessage).toMatch(/`cli`/);
        expect(err.actions).toEqual([
            { label: 'Set API Key', command: 'pipelex.setApiKey' },
            { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
        ]);
        // Rich (pane) detail has clickable links + the exact Docker command.
        expect(err.detailHtml).toContain('class="pipelex-link" href="https://app.pipelex.com/"');
        expect(err.detailHtml).toContain('class="pipelex-link" href="https://github.com/Pipelex/pipelex-api"');
        expect(err.detailHtml).toContain('docker run -p 8081:8081 pipelex/pipelex-api');
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
        apiState.validate = async () => ({ is_valid: true });
        const backend = makeBackend({ baseUrl: 'https://api.pipelex.com', confirmRemote: async () => false });
        const err = await analyze(backend).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('declined');
        // No request was sent.
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('proceeds with a remote send when the user confirms', async () => {
        apiState.validate = async () => ({ is_valid: true });
        const backend = makeBackend({ baseUrl: 'https://api.pipelex.com', confirmRemote: async () => true });
        const analysis = await analyze(backend);
        expect(analysis.validation.ok).toBe(true);
        expect(apiState.lastValidateArgs).not.toBeNull();
    });

    it('maps a non-host-only base URL to an actionable api-error BackendError, before prompting or sending', async () => {
        apiState.validate = async () => ({ is_valid: true });
        const confirmRemote = vi.fn(async () => true);
        // A pasted `/v1` path — the client constructor rejects it; this used to escape
        // handleError as a silent throw (validator: no toast; panel: generic error).
        const backend = makeBackend({ baseUrl: 'https://api.pipelex.com/v1', confirmRemote });
        const err = await analyze(backend).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.userMessage).toMatch(/must be host-only/);
        expect(err.userMessage).toMatch(/pipelex\.api\.baseUrl/);
        // Fails fast: no privacy modal, no request sent.
        expect(confirmRemote).not.toHaveBeenCalled();
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('maps a token-read (SecretStorage) failure to an infra BackendError, not a silent throw', async () => {
        const output = mockOutput();
        const backend = new ApiValidationBackend({
            baseUrl: 'http://localhost:8081',
            getToken: async () => { throw new Error('keychain locked'); },
            versionGate: new ApiVersionGate(output),
            confirmRemote: async () => true,
            output,
        });
        const err = await analyze(backend).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('infra');
        expect(err.userMessage).toMatch(/could not initialize the client/);
        expect(apiState.lastValidateArgs).toBeNull();
    });
});
