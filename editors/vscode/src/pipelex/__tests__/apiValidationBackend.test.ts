import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MethodTreeError } from 'mthds';

// ---------- Hoisted mock state ----------
const apiState = vi.hoisted(() => ({
    validate: null as null | ((source: any, allow: boolean, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<any>),
    version: null as null | (() => Promise<any>),
    limits: null as null | (() => Promise<any>),
    lastValidateArgs: null as any,
    lastValidateOptions: null as any,
    lastConstructorOptions: null as any,
}));

// ---------- vscode mock (ApiCapabilityGate uses window.showWarningMessage) ----------
vi.mock('vscode', () => ({
    window: { showWarningMessage: vi.fn() },
}));

// ---------- @pipelex/sdk mock (classes defined inside the hoisted factory) ----------
// The method tree itself is NOT mocked: `mthds`'s real lister lists the real
// directories each test writes, so what the backend hands the client is the tree
// the standard's membership rule yields.
vi.mock('@pipelex/sdk', () => {
    // Mirror the real `@pipelex/sdk` constructor signatures (message-first, then the
    // trailing options bag) so the call sites below type-check against the imported
    // real classes, while the backend still reads `.status`/`.serverMessage`/
    // `.statusText`/`.requestId`/`.problemDocument`. Like the real class,
    // `requestId` comes from `options.details`, the typed members the client
    // parsed (the body's `request_id` or the `X-Request-ID` header), and
    // `problemDocument` is the decoded body whole.
    class ApiResponseError extends Error {
        public requestId: string | undefined;
        public problemDocument: Record<string, unknown> | undefined;
        constructor(
            message: string,
            public apiUrl: string,
            public status: number,
            public statusText: string,
            public responseBody: string,
            public errorType: string | undefined,
            public serverMessage: string | undefined,
            public validationErrors: any[] | undefined,
            public code: string | undefined,
            options?: { details?: { requestId?: string }; problemDocument?: Record<string, unknown> },
        ) {
            super(message);
            this.name = 'ApiResponseError';
            this.requestId = options?.details?.requestId;
            this.problemDocument = options?.problemDocument;
        }
    }
    class ApiUnreachableError extends Error {
        constructor(
            message: string,
            public apiUrl: string,
            public code: string | undefined,
            _options?: { cause?: unknown },
        ) {
            super(message);
            this.name = 'ApiUnreachableError';
        }
    }
    class PipelineRequestError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'PipelineRequestError';
        }
    }
    class RequestArgumentError extends PipelineRequestError {
        constructor(message: string, _options?: { cause?: unknown }) {
            super(message);
            this.name = 'RequestArgumentError';
        }
    }
    class MethodFileTransferError extends PipelineRequestError {
        public operation: string;
        public code: string;
        public status: number | undefined;
        constructor(message: string, details: { operation: string; code: string; sha256?: string; path?: string; status?: number }) {
            super(message);
            this.name = 'MethodFileTransferError';
            this.operation = details.operation;
            this.code = details.code;
            this.status = details.status;
        }
    }
    class PipelexApiClient {
        constructor(options: any) {
            apiState.lastConstructorOptions = options;
            // Mirror the real client: reject a non-host-only base URL (the common
            // trigger is a pasted `/v1` path), throwing PipelineRequestError.
            const url = new URL(options.baseUrl);
            if (url.pathname !== '/' && url.pathname !== '') {
                throw new PipelineRequestError(`Invalid API base URL "${options.baseUrl}": must be host-only.`);
            }
        }
        async validate(source: any, allow: boolean, options?: { timeoutMs?: number; signal?: AbortSignal }) {
            apiState.lastValidateArgs = [source, allow];
            apiState.lastValidateOptions = options;
            return apiState.validate!(source, allow, options);
        }
        async methodTreeLimits() {
            return apiState.limits ? apiState.limits() : {};
        }
        async version() {
            return apiState.version ? apiState.version() : { protocol_version: '1', implementation_version: '0.4.0' };
        }
    }
    return {
        PipelexApiClient,
        ApiResponseError,
        ApiUnreachableError,
        PipelineRequestError,
        RequestArgumentError,
        MethodFileTransferError,
    };
});

import { ApiResponseError, ApiUnreachableError, MethodFileTransferError, RequestArgumentError } from '@pipelex/sdk';
import { ApiValidationBackend } from '../validation/apiValidationBackend';

// ---------- Compile-time conformance: lock the mock to the real @pipelex/sdk ----------
// `vi.mock` swaps the SDK's runtime impl, but TypeScript still resolves these
// `import type`s to the published `.d.ts`. The bindings below fail `yarn typecheck`
// (strict, in `make check` + CI) if the SDK renames/removes any surface this mock
// stands in for — so the mock cannot silently drift from the real contract. They do
// NOT bind the mock's constructor argument order, nor the SDK's runtime behavior
// (when the constructor throws, what a verdict/error actually carries, what a
// timeout becomes): no suite here reaches the real SDK or a server, so those are
// checked by hand against the published `.d.ts`/`.js` and a live API on every bump
// (the `/bump-sdk` skill).
import type {
    PipelexApiClient as RealPipelexApiClient,
    PipelexApiClientOptions,
    PipelexValidateSource,
    ValidateOptions,
    ApiResponseError as RealApiResponseError,
    ApiUnreachableError as RealApiUnreachableError,
    MethodFileTransferError as RealMethodFileTransferError,
} from '@pipelex/sdk';
import type { MethodTree } from 'mthds';
// Methods the backend invokes on the client must exist on the real client.
type _ClientSurface = Pick<RealPipelexApiClient, 'validate' | 'methodTreeLimits' | 'version'>;
// The tree the backend lists is a source `validate` takes, with the options it passes.
type _TreeSource = { tree: MethodTree } extends PipelexValidateSource ? true : never;
const _treeSource: _TreeSource = true;
type _ValidateOptions = Required<Pick<ValidateOptions, 'timeoutMs' | 'signal'>>;
// Constructor option keys the backend passes must be the real option keys.
type _ClientOptions = Required<Pick<PipelexApiClientOptions, 'baseUrl' | 'apiKey'>>;
// Error fields the backend reads off these classes must exist on the real classes.
type _ResponseErrorFields = Pick<RealApiResponseError, 'status' | 'statusText' | 'serverMessage' | 'requestId' | 'problemDocument'>;
type _UnreachableErrorFields = Pick<RealApiUnreachableError, 'code'>;
type _TransferErrorFields = Pick<RealMethodFileTransferError, 'code' | 'status'>;

import { ApiCapabilityGate } from '../validation/apiCapabilityGate';
import { AnalyzeAbortError, BackendError } from '../validation/backend';

// ---------- Method trees on disk ----------
const tempDirs: string[] = [];

/** Write `files` (tree path → text) under a fresh directory and return its real path. */
function writeTree(files: Record<string, string>): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pipelex-api-tree-')));
    tempDirs.push(dir);
    for (const [treePath, content] of Object.entries(files)) {
        const target = path.join(dir, ...treePath.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fileUri(fsPath: string) {
    return { fsPath, toString: () => `file://${fsPath}` } as any;
}

/** The single-file method most tests validate. */
const METHOD_DIR = writeTree({ 'a.mthds': 'domain="d"' });
const SAVED = fileUri(path.join(METHOD_DIR, 'a.mthds'));

/** The tree paths of the tree the client was handed. */
function sentTreePaths(): string[] {
    return apiState.lastValidateArgs[0].tree.files.map((file: { path: string }) => file.path);
}

function mockOutput() {
    return { appendLine: vi.fn() } as any;
}

function makeBackend(opts?: { baseUrl?: string; confirmRemote?: () => Promise<boolean>; token?: string }) {
    const output = mockOutput();
    const token = opts && 'token' in opts ? opts.token : 'secret-token';
    return new ApiValidationBackend({
        baseUrl: opts?.baseUrl ?? 'http://localhost:8081',
        getToken: async () => token,
        capabilityGate: new ApiCapabilityGate(output),
        confirmRemote: opts?.confirmRemote ?? (async () => true),
        output,
    });
}

function analyze(backend: ApiValidationBackend, withGraph = false, savedPath = SAVED.fsPath) {
    const controller = new AbortController();
    return backend.analyze(
        { primaryUri: fileUri(savedPath), savedUri: fileUri(savedPath), timeout: 30000 },
        { withGraph },
        controller.signal,
    );
}

describe('ApiValidationBackend', () => {
    beforeEach(() => {
        apiState.validate = null;
        apiState.version = null;
        apiState.limits = null;
        apiState.lastValidateArgs = null;
        apiState.lastValidateOptions = null;
        apiState.lastConstructorOptions = null;
    });

    it('returns ok + graph on a valid tree, sent with allowSignatures', async () => {
        apiState.validate = async () => ({ is_valid: true, graph_spec: { nodes: [], edges: [] } });
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.graph).toEqual({ nodes: [], edges: [] });
        // The saved file's tree, its only source, and allowSignatures=true.
        expect(Object.keys(apiState.lastValidateArgs[0])).toEqual(['tree']);
        expect(apiState.lastValidateArgs[1]).toBe(true);
        expect(sentTreePaths()).toEqual(['a.mthds']);
    });

    it("sends the saved file's method tree: every file the membership rule keeps, not only the bundles", async () => {
        const dir = writeTree({
            'a.mthds': 'domain="d"',
            'b.mthds': 'domain="d"',
            'templates/letter.html': '<p>{{ name }}</p>',
            'funcs/totals.py': 'def totals(): ...',
            '.env': 'KEY=secret',
            '.gitignore': 'scratch/\n',
            'scratch/notes.txt': 'kept home',
            'node_modules/pkg/index.js': '',
        });
        apiState.validate = async () => ({ is_valid: true });
        await analyze(makeBackend(), false, path.join(dir, 'b.mthds'));
        expect(sentTreePaths()).toEqual(['a.mthds', 'b.mthds', 'funcs/totals.py', 'templates/letter.html']);
        // The tree carries what each file's bytes are, read back from disk when sent.
        const tree = apiState.lastValidateArgs[0].tree;
        expect(new TextDecoder().decode(await tree.readFile('templates/letter.html'))).toBe('<p>{{ name }}</p>');
    });

    it('roots the tree at the nearest METHODS.toml above the saved file', async () => {
        const dir = writeTree({
            'METHODS.toml': '',
            'shared/concepts.mthds': 'domain="d"',
            'methods/a.mthds': 'domain="d"',
        });
        apiState.validate = async () => ({ is_valid: true });
        await analyze(makeBackend(), false, path.join(dir, 'methods', 'a.mthds'));
        expect(sentTreePaths()).toEqual(['METHODS.toml', 'methods/a.mthds', 'shared/concepts.mthds']);
    });

    it('lists the tree under the limits the API announces, and sends nothing past one', async () => {
        const dir = writeTree({ 'a.mthds': 'domain="d"', 'b.mthds': 'domain="d"' });
        apiState.limits = async () => ({ maxFileCount: 1 });
        apiState.validate = async () => ({ is_valid: true });
        const err = await analyze(makeBackend(), false, path.join(dir, 'a.mthds')).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toContain(`The method tree rooted at ${dir} is too large for the Pipelex API`);
        expect(err.userMessage).toContain('.gitignore');
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('does not validate a saved file its own tree keeps out, and sends nothing', async () => {
        // A verdict on the tree would say nothing about the saved file, which a run
        // of the method would never send either.
        const dir = writeTree({ 'a.mthds': 'domain="d"', 'scratch.mthds': 'domain="d"', '.gitignore': 'scratch.mthds\n' });
        apiState.validate = async () => ({ is_valid: true });
        const err = await analyze(makeBackend(), false, path.join(dir, 'scratch.mthds')).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toContain(`scratch.mthds was not validated: it is not a file of its method tree, rooted at ${dir}`);
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('checks the saved file against its tree, not the graph primary the analysis is anchored on', async () => {
        // With the method graph showing an ancillary file, the analysis anchors on
        // the directory's main bundle, which the tree holds. The file saved is a
        // scratch file a .gitignore keeps out, so it is still refused, and nothing
        // is sent, as it is with the panel closed.
        const dir = writeTree({
            'bundle.mthds': 'domain="d"\nmain_pipe="main"',
            'scratch.mthds': 'domain="d"',
            '.gitignore': 'scratch.mthds\n',
        });
        apiState.validate = async () => ({ is_valid: true });
        const err = await makeBackend().analyze(
            {
                primaryUri: fileUri(path.join(dir, 'bundle.mthds')),
                savedUri: fileUri(path.join(dir, 'scratch.mthds')),
                timeout: 30000,
            },
            { withGraph: false },
            new AbortController().signal,
        ).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toContain(`scratch.mthds was not validated: it is not a file of its method tree, rooted at ${dir}`);
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('refuses a tree the standard refuses, such as one holding a symbolic link, before sending', async () => {
        const dir = writeTree({ 'a.mthds': 'domain="d"', 'target.txt': 'x' });
        fs.symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'));
        apiState.validate = async () => ({ is_valid: true });
        const err = await analyze(makeBackend(), false, path.join(dir, 'a.mthds')).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toMatch(/^The method tree could not be sent for validation: .*link\.txt/);
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it('maps a file that changed while the tree was being sent to a tree BackendError', async () => {
        apiState.validate = async () => {
            throw new MethodTreeError('not_listable', "'a.mthds' changed since the method tree was listed; list it again.", { names: ['a.mthds'] });
        };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toContain("'a.mthds' changed since the method tree was listed");
    });

    it('maps a tree the client refuses before sending (RequestArgumentError) to a tree BackendError', async () => {
        apiState.validate = async () => {
            throw new RequestArgumentError('validate() cannot send the tree inline: its inline map weighs 300000 bytes, past the limit of 262144 bytes.');
        };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('tree');
        expect(err.userMessage).toContain('past the limit of 262144 bytes');
    });

    it("maps a failed upload of the tree's files by its code, without the signed link", async () => {
        apiState.validate = async () => {
            throw new MethodFileTransferError('Uploading a file of the method tree failed: storage answered HTTP 503, so validate was not sent.', {
                operation: 'upload',
                code: 'storage_error',
                status: 503,
            });
        };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.userMessage).toContain('so validate was not sent');
        expect(err.logMessage).toContain('(storage_error, HTTP 503)');

        apiState.validate = async () => {
            throw new MethodFileTransferError('Storage gave no answer to an upload, so validate was not sent.', { operation: 'upload', code: 'unreachable' });
        };
        const unreachable = await analyze(makeBackend()).catch(e => e);
        expect(unreachable.kind).toBe('unreachable');
    });

    it('stops before listing the tree when the save is superseded during the handshake', async () => {
        let releaseLimits: (() => void) | undefined;
        apiState.limits = () => new Promise(resolve => { releaseLimits = () => resolve({}); });
        apiState.validate = async () => ({ is_valid: true });
        const controller = new AbortController();
        const pending = makeBackend().analyze(
            { primaryUri: SAVED, savedUri: SAVED, timeout: 30000 },
            { withGraph: false },
            controller.signal,
        );
        await vi.waitFor(() => expect(releaseLimits).toBeDefined());
        controller.abort();
        releaseLimits!();
        await expect(pending).rejects.toBeInstanceOf(AnalyzeAbortError);
        // Let the abandoned listing settle: it must not go on to send the tree.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(apiState.lastValidateArgs).toBeNull();
    });

    it("gives the request the time left of the save's one timeout, not a fresh one", async () => {
        // Without a timeout the SDK's 20-minute default governs; with a fresh one, a
        // slow handshake would let the request run past the save's own timeout.
        let now = 1_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            // The handshake takes four seconds of the save's twelve.
            apiState.limits = async () => {
                now += 4000;
                return {};
            };
            apiState.validate = async () => ({ is_valid: true });
            await makeBackend().analyze(
                { primaryUri: SAVED, savedUri: SAVED, timeout: 12000 },
                { withGraph: false },
                new AbortController().signal,
            );
            expect(apiState.lastValidateOptions.timeoutMs).toBe(8000);
            expect(apiState.lastValidateOptions.signal).toBeInstanceOf(AbortSignal);
        } finally {
            clock.mockRestore();
        }
    });

    it('cancels the uploads and the request of a save superseded while they run', async () => {
        // The client holds a signal the save's own abort reaches, so a superseded
        // save does not keep uploading the method's files.
        apiState.validate = (_source, _allow, options) => new Promise((_resolve, reject) => {
            options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        const controller = new AbortController();
        const pending = makeBackend().analyze(
            { primaryUri: SAVED, savedUri: SAVED, timeout: 30000 },
            { withGraph: false },
            controller.signal,
        );
        await vi.waitFor(() => expect(apiState.lastValidateOptions).not.toBeNull());
        const sent: AbortSignal = apiState.lastValidateOptions.signal;
        expect(sent.aborted).toBe(false);
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(AnalyzeAbortError);
        expect(sent.aborted).toBe(true);
    });

    it('stops at the handshake when the timeout runs out during it, and never sends the tree', async () => {
        // The handshake takes no signal, so it answers after the save was told it
        // failed: the validation must stop there rather than send the tree under a
        // fresh timeout.
        let releaseLimits: (() => void) | undefined;
        apiState.limits = () => new Promise(resolve => { releaseLimits = () => resolve({}); });
        apiState.validate = async () => ({ is_valid: true });
        const controller = new AbortController();
        const err = await makeBackend().analyze(
            { primaryUri: SAVED, savedUri: SAVED, timeout: 30 },
            { withGraph: false },
            controller.signal,
        ).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
        expect(err.logMessage).toBe('Pipelex API request timed out after 30ms');
        releaseLimits!();
        // Let the late handshake settle, with time enough to list the tree: it must
        // not go on to list and send it.
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(apiState.lastValidateArgs).toBeNull();
        expect(controller.signal.aborted).toBe(false);
    });

    it('cancels the uploads still running when the timeout runs out', async () => {
        apiState.validate = (_source, _allow, options) => new Promise((_resolve, reject) => {
            options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        const err = await makeBackend().analyze(
            { primaryUri: SAVED, savedUri: SAVED, timeout: 50 },
            { withGraph: false },
            new AbortController().signal,
        ).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
        // The uploads see an aborted signal, so none keeps running after the save
        // was told it failed.
        expect(apiState.lastValidateOptions.signal.aborted).toBe(true);
    });

    it('passes the resolved token to the client constructor (SecretStorage precedence)', async () => {
        apiState.validate = async () => ({ is_valid: true });
        await analyze(makeBackend());
        expect(apiState.lastConstructorOptions).toEqual({ baseUrl: 'http://localhost:8081', apiKey: 'secret-token' });
    });

    it('maps a 200 invalid verdict (is_valid:false) to a not-ok outcome holding its problem items', async () => {
        // 200-diagnostic: an invalid bundle is a produced verdict in the body, not a throw.
        const item = {
            code: 'model.unknown',
            detail: "The method names the llm model 'no-such-model', which no catalog knows.",
            params: { model: 'no-such-model', model_type: 'llm' },
            location: { pipe: 'echo', field: 'model', file: 'a.mthds' },
        };
        apiState.validate = async () => ({
            is_valid: false,
            errors: [item],
            pending_signatures: [],
            is_runnable: false,
            message: 'The method does not validate.',
        });
        const analysis = await analyze(makeBackend(), true);
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([item]);
        expect(analysis.graph).toBeNull();
    });

    it("reads a valid verdict's advisory warnings as problem items", async () => {
        const warning = {
            code: 'pipelex.docgen.template_warning',
            detail: "The document template 'invoice.xlsx' may be faulty: a cell reads an unknown name.",
            params: { template: 'invoice.xlsx', finding: 'a cell reads an unknown name' },
            location: { pipe: 'print_invoice' },
        };
        apiState.validate = async () => ({ is_valid: true, warnings: [warning] });
        const analysis = await analyze(makeBackend());
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.validation.warnings).toEqual([warning]);
    });

    it('reads no fault from a runner that still writes validation_errors, and names the release that writes problem items', async () => {
        // A runner older than pipelex-api 0.90.0 lists its faults in the shape
        // problem items replaced, which is not read: its invalid verdict carries
        // no readable item, so it is the contract violation below, never a verdict
        // with zero diagnostics.
        apiState.validate = async () => ({
            is_valid: false,
            validation_errors: [{ category: 'dry_run', error_type: 'DryRunError', message: 'Dry run failed: ...', pipe_code: 'main', domain_code: 'd', source: 'a.mthds' }],
            pending_signatures: [],
            is_runnable: false,
            message: 'MTHDS validation found errors',
        });
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.logMessage).toMatch(/no readable errors/);
        expect(err.userMessage).toContain('pipelex-api 0.90.0');
        expect(err.userMessage).toContain('upgrade the server');
        expect(err.userMessage).toContain('`pipelex.backend`');
    });

    it('points a hosted-API user whose runner writes validation_errors at the cli backend, not at an upgrade', async () => {
        apiState.validate = async () => ({
            is_valid: false,
            validation_errors: [{ category: 'dry_run', message: 'Dry run failed: ...', pipe_code: 'main' }],
            is_runnable: false,
        });
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.userMessage).toContain('hosted Pipelex API');
        expect(err.userMessage).toContain('pipelex-api 0.90.0');
        expect(err.userMessage).not.toContain('upgrade the server');
        expect(err.userMessage).toContain('`pipelex.backend`');
    });

    it('treats is_valid:false with an empty errors list as an api-error BackendError (contract violation)', async () => {
        // The runtime invariant is total: an invalid verdict ALWAYS carries a
        // non-empty errors[]. This body is no problem document, so it has no
        // code and detail of its own to stand for the faults. An empty list
        // during a server regression must NOT publish zero diagnostics — it is a
        // no-verdict backend error so stale diagnostics are cleared, not hidden.
        apiState.validate = async () => ({
            is_valid: false,
            errors: [],
            is_runnable: false,
            message: 'The method does not validate.',
        });
        const err = await analyze(makeBackend(), true).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        // No empty invalid outcome leaked through.
        expect(err.logMessage).toMatch(/no readable errors/);
    });

    it('treats is_valid:false with missing or unreadable errors as an api-error BackendError', async () => {
        for (const body of [
            { is_valid: false, is_runnable: false, message: 'x' },
            { is_valid: false, errors: [{ code: 'method.syntax' }, 'text'], message: 'x' },
        ]) {
            apiState.validate = async () => body;
            const err = await analyze(makeBackend()).catch(e => e);
            expect(err).toBeInstanceOf(BackendError);
            expect(err.kind).toBe('api-error');
        }
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
        // problem (e.g. a `files` key that is not a tree path), surfaced as api-error.
        apiState.validate = async () => { throw new ApiResponseError("files key 'a\\b.mthds' is not a tree path", 'http://localhost:8081', 422, 'Unprocessable Entity', '', 'ValidationError', "files key 'a\\b.mthds' is not a tree path", undefined, undefined); };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
    });

    it('maps a self-hosted 401 to an auth BackendError with a single Set-API-Key action', async () => {
        apiState.validate = async () => { throw new ApiResponseError('unauthorized', 'http://localhost:8081', 401, 'Unauthorized', '', 'AuthError', 'unauthorized', undefined, undefined); };
        const err = await analyze(makeBackend()).catch(e => e); // default baseUrl is localhost (self-hosted)
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        expect(err.userMessage).toMatch(/Set Hosted API Key/);
        // Self-hosted: only the "Set API Key" remedy (no platform "Get a key" link).
        expect(err.actions).toEqual([{ label: 'Set API Key', command: 'pipelex.setApiKey' }]);
        // No platform/self-host pointers — you already run the server.
        expect(err.userMessage).not.toContain('app.pipelex.com');
        expect(err.userMessage).not.toContain('github.com');
    });

    it('maps a hosted 401/403 to an auth BackendError with Set + Get-a-key actions', async () => {
        apiState.validate = async () => { throw new ApiResponseError('forbidden', 'https://api.pipelex.com', 403, 'Forbidden', '', 'AuthError', 'forbidden', undefined, undefined); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('auth');
        // Plain-text (toast) message covers all three paths.
        expect(err.userMessage).toMatch(/HTTP 403/);
        expect(err.userMessage).toMatch(/app\.pipelex\.com/);
        expect(err.userMessage).toMatch(/`cli`/);
        // A hosted request always carried a key (none → `no-key` before sending),
        // so the message is about the key being refused, not missing.
        expect(err.userMessage).toMatch(/rejected your API key/);
        expect(err.actions).toEqual([
            { label: 'Set API Key', command: 'pipelex.setApiKey' },
            { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
        ]);
    });

    it.each(['https://api-dev.pipelex.com', 'https://api.pipelex.com'])(
        'stops with a no-key BackendError for the hosted API at %s when no key is available, before prompting or sending',
        async baseUrl => {
            apiState.validate = async () => ({ is_valid: true });
            const confirmRemote = vi.fn(async () => true);
            const err = await analyze(makeBackend({ baseUrl, confirmRemote, token: undefined })).catch(e => e);
            expect(err).toBeInstanceOf(BackendError);
            expect(err.kind).toBe('no-key');
            // Where to get a key, and the command that stores it.
            expect(err.userMessage).toContain('https://app.pipelex.com/');
            expect(err.userMessage).toContain('"Pipelex: Set Hosted API Key"');
            expect(err.userMessage).toContain(baseUrl);
            expect(err.userMessage).toMatch(/`cli`/);
            expect(err.actions).toEqual([
                { label: 'Set API Key', command: 'pipelex.setApiKey' },
                { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
            ]);
            // Nothing to consent to and nothing sent: the request could only be a 401.
            expect(confirmRemote).not.toHaveBeenCalled();
            expect(apiState.lastValidateArgs).toBeNull();
        },
    );

    it.each(['http://localhost:8081', 'https://pipelex.internal.example'])(
        'sends without a key to a self-hosted server at %s, which may run without auth',
        async baseUrl => {
            apiState.validate = async () => ({ is_valid: true });
            const analysis = await analyze(makeBackend({ baseUrl, token: undefined }));
            expect(analysis.validation.ok).toBe(true);
            expect(apiState.lastConstructorOptions).toEqual({ baseUrl, apiKey: undefined });
            expect(apiState.lastValidateArgs).not.toBeNull();
        },
    );

    it('maps a 5xx to an api-error BackendError (server reached, errored)', async () => {
        apiState.validate = async () => { throw new ApiResponseError('service unavailable', 'https://api.pipelex.com', 503, 'Service Unavailable', '', undefined, 'service unavailable', undefined, undefined); };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        // No request id on the error, so none in the log line.
        expect(err.logMessage).not.toMatch(/request /);
    });

    it('shows the next step of the problem document a no-verdict answer carries', async () => {
        apiState.validate = async () => {
            throw new ApiResponseError(
                "The request's field 'files' does not match the route's schema.",
                'http://localhost:8081', 422, 'Unprocessable Entity', '', undefined,
                "The request's field 'files' does not match the route's schema.", undefined, 'request.invalid',
                {
                    details: { requestId: 'req_9' },
                    problemDocument: {
                        type: 'https://mthds.ai/errors/request.invalid',
                        title: "The request does not match the route's schema",
                        status: 422,
                        code: 'request.invalid',
                        domain: 'input',
                        retry: 'no',
                        detail: "The request's field 'files' does not match the route's schema.",
                        next_step: { kind: 'change_input', detail: "Correct the field 'files' as the route's schema requires, then send the request again." },
                        request_id: 'req_9',
                    },
                },
            );
        };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.userMessage).toBe(
            "Pipelex API error at http://localhost:8081 (HTTP 422): The request's field 'files' does not match the route's schema. " +
            "Next step: Correct the field 'files' as the route's schema requires, then send the request again.",
        );
        // The code and the request id are for the log.
        expect(err.logMessage).toBe(
            "Pipelex API 422 at http://localhost:8081: The request's field 'files' does not match the route's schema. " +
            '(code request.invalid, request req_9)',
        );
    });

    it("logs the server's request id with an API error, for support", async () => {
        apiState.validate = async () => {
            throw new ApiResponseError('internal error', 'https://api.pipelex.com', 500, 'Internal Server Error', '', undefined, 'internal error', undefined, undefined, { details: { requestId: 'req_7f3a' } });
        };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('api-error');
        expect(err.logMessage).toBe('Pipelex API 500 at https://api.pipelex.com: internal error (request req_7f3a)');
        // The id is for the log, not the toast.
        expect(err.userMessage).not.toContain('req_7f3a');
    });

    it("logs the problem document's request id when the error carries none of its own", async () => {
        apiState.validate = async () => {
            throw new ApiResponseError('internal error', 'https://api.pipelex.com', 500, 'Internal Server Error', '', undefined, 'internal error', undefined, undefined, {
                problemDocument: { code: 'runtime.unexpected', detail: 'internal error', request_id: 'req_body' },
            });
        };
        const err = await analyze(makeBackend({ baseUrl: 'https://api.pipelex.com' })).catch(e => e);
        expect(err.logMessage).toBe('Pipelex API 500 at https://api.pipelex.com: internal error (code runtime.unexpected, request req_body)');
    });

    it('maps ApiUnreachableError to a transport BackendError', async () => {
        apiState.validate = async () => { throw new ApiUnreachableError('connection refused', 'http://localhost:8081', 'ECONNREFUSED'); };
        const err = await analyze(makeBackend()).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('unreachable');
        expect(err.userMessage).toMatch(/is pipelex-api running/);
    });

    it('uses a network-flavored unreachable message for the hosted API (not "is pipelex-api running")', async () => {
        apiState.validate = async () => { throw new ApiUnreachableError('host not found', 'https://api.pipelex.com', 'ENOTFOUND'); };
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
            capabilityGate: new ApiCapabilityGate(output),
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
