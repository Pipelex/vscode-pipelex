import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- vscode mock ----------
// Minimal surface PipelexValidator touches: the save/close events (captured so the
// test can drive onSave directly), a recording DiagnosticCollection, and config.
const mockState = vi.hoisted(() => ({
    onSaveHandler: null as ((doc: any) => any) | null,
    diagStore: new Map<string, any>(),
    setCalls: [] as string[],
    configEnabled: true,
    bundleFiles: [] as any[],
}));

vi.mock('vscode', () => {
    const collection = {
        set: vi.fn((uri: any, diags: any) => {
            mockState.diagStore.set(uri.toString(), diags);
            mockState.setCalls.push(uri.toString());
        }),
        delete: vi.fn((uri: any) => mockState.diagStore.delete(uri.toString())),
        dispose: vi.fn(),
    };
    return {
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        // Round-trips an inflight key (a `uri.toString()`) back to its fsPath, matching
        // mkDoc's `file://<fsPath>` form, so cancelInflightInDir can resolve each key's dir.
        Uri: { parse: (s: string) => ({ fsPath: s.replace(/^file:\/\//, '') }) },
        languages: {
            createDiagnosticCollection: vi.fn(() => collection),
            getDiagnostics: vi.fn(() => []),
        },
        workspace: {
            onDidSaveTextDocument: vi.fn((handler: any) => {
                mockState.onSaveHandler = handler;
                return { dispose: vi.fn() };
            }),
            onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
            getConfiguration: vi.fn(() => ({
                get: (key: string, def: any) => (key === 'validation.enabled' ? mockState.configEnabled : def),
            })),
            getWorkspaceFolder: vi.fn(() => undefined),
        },
        window: { showWarningMessage: vi.fn() },
    };
});

vi.mock('../validation/bundleGather', () => ({
    gatherBundleFiles: vi.fn(async () => mockState.bundleFiles),
}));

// Isolate the test from the real diagnostics resolver (needs vscode.Range / sourceLocator):
// place each run's errors on its own primary URI so we can observe which run's write won.
vi.mock('../validation/crossFileDiagnostics', () => ({
    buildBundleDiagnostics: vi.fn(({ errors, primaryUri }: any) => [
        { uri: primaryUri, diagnostics: errors.map((e: any) => ({ message: e.message })) },
    ]),
}));

import { PipelexValidator } from '../validation/pipelexValidator';

function makeDeferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function mkDoc(fsPath: string) {
    return {
        languageId: 'mthds',
        uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
    } as any;
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('PipelexValidator — per-directory generation gate', () => {
    beforeEach(() => {
        mockState.onSaveHandler = null;
        mockState.diagStore.clear();
        mockState.setCalls.length = 0;
        mockState.configEnabled = true;
        mockState.bundleFiles = [];
    });

    it('a stale sibling run does not clobber a newer save in the same directory', async () => {
        const deferredA = makeDeferred<any>();
        const deferredB = makeDeferred<any>();
        const backend = {
            kind: 'cli',
            analyze: (req: any) =>
                req.primaryUri.fsPath.endsWith('a.mthds') ? deferredA.promise : deferredB.promise,
        };
        const factory = { getBackend: () => backend } as any;
        const output = { appendLine: vi.fn() } as any;

        const validator = new PipelexValidator(output, factory);
        const onSave = mockState.onSaveHandler!;

        // A saved first (generation 1), then sibling B (generation 2) — both in /proj.
        const pA = onSave(mkDoc('/proj/a.mthds'));
        const pB = onSave(mkDoc('/proj/b.mthds'));
        await flush();

        // The newer save (B) resolves first and publishes its diagnostics...
        deferredB.resolve({ validation: { ok: false, errors: [{ category: 'x', message: 'B-error' }] } });
        await pB;

        // ...then the older sibling run (A) resolves last with its own (now stale) set.
        deferredA.resolve({ validation: { ok: false, errors: [{ category: 'x', message: 'A-error' }] } });
        await pA;

        // B's diagnostics survive; A's late write is dropped (generation no longer current).
        expect(mockState.diagStore.has('file:///proj/b.mthds')).toBe(true);
        expect(mockState.diagStore.get('file:///proj/b.mthds')).toEqual([{ message: 'B-error' }]);
        expect(mockState.diagStore.has('file:///proj/a.mthds')).toBe(false);
        expect(mockState.setCalls).not.toContain('file:///proj/a.mthds');

        validator.dispose();
    });

    it('a save while validation is disabled cancels an in-flight analysis so its stale result is dropped', async () => {
        const deferred = makeDeferred<any>();
        let capturedSignal: AbortSignal | undefined;
        const backend = {
            kind: 'cli',
            analyze: (_req: any, _opts: any, signal: AbortSignal) => {
                capturedSignal = signal;
                return deferred.promise;
            },
        };
        const factory = { getBackend: () => backend } as any;
        const validator = new PipelexValidator({ appendLine: vi.fn() } as any, factory);
        const onSave = mockState.onSaveHandler!;

        // 1. Validation enabled: first save starts an in-flight analysis.
        const p1 = onSave(mkDoc('/proj/x.mthds'));
        await flush();
        expect(capturedSignal?.aborted).toBe(false);

        // 2. User disables validation, then saves the same file again. That save
        //    must cancel the in-flight run BEFORE returning on the disabled guard.
        mockState.configEnabled = false;
        await onSave(mkDoc('/proj/x.mthds'));
        expect(capturedSignal?.aborted).toBe(true);

        // 3. When the now-superseded analysis resolves, it publishes nothing.
        deferred.resolve({ validation: { ok: false, errors: [{ category: 'x', message: 'stale' }] } });
        await p1;
        expect(mockState.diagStore.has('file:///proj/x.mthds')).toBe(false);
        expect(mockState.setCalls).not.toContain('file:///proj/x.mthds');

        validator.dispose();
    });

    it('a sibling save while validation is disabled cancels an in-flight analysis in the same directory', async () => {
        const deferredA = makeDeferred<any>();
        let signalA: AbortSignal | undefined;
        const backend = {
            kind: 'cli',
            analyze: (req: any, _opts: any, signal: AbortSignal) => {
                if (req.primaryUri.fsPath.endsWith('a.mthds')) {
                    signalA = signal;
                    return deferredA.promise;
                }
                return makeDeferred<any>().promise; // sibling B never resolves; irrelevant here
            },
        };
        const factory = { getBackend: () => backend } as any;
        const validator = new PipelexValidator({ appendLine: vi.fn() } as any, factory);
        const onSave = mockState.onSaveHandler!;

        // 1. Validation enabled: A starts an in-flight analysis in /proj.
        const pA = onSave(mkDoc('/proj/a.mthds'));
        await flush();
        expect(signalA?.aborted).toBe(false);

        // 2. User disables validation, then saves a SIBLING (B) in the same directory.
        //    The per-URI cancel only supersedes B; B's disabled-guard return must also
        //    cancel A's in-flight run so it can't publish after validation is off.
        mockState.configEnabled = false;
        await onSave(mkDoc('/proj/b.mthds'));
        expect(signalA?.aborted).toBe(true);

        // 3. A resolves after validation was disabled — it must publish nothing.
        deferredA.resolve({ validation: { ok: false, errors: [{ category: 'x', message: 'A-stale' }] } });
        await pA;
        expect(mockState.diagStore.has('file:///proj/a.mthds')).toBe(false);
        expect(mockState.setCalls).not.toContain('file:///proj/a.mthds');

        validator.dispose();
    });

    it('publishes diagnostics on a normal single save', async () => {
        const deferred = makeDeferred<any>();
        const backend = { kind: 'cli', analyze: () => deferred.promise };
        const factory = { getBackend: () => backend } as any;
        const validator = new PipelexValidator({ appendLine: vi.fn() } as any, factory);

        const p = mockState.onSaveHandler!(mkDoc('/proj/solo.mthds'));
        await flush();
        deferred.resolve({ validation: { ok: false, errors: [{ category: 'x', message: 'solo-error' }] } });
        await p;

        expect(mockState.diagStore.get('file:///proj/solo.mthds')).toEqual([{ message: 'solo-error' }]);
        validator.dispose();
    });

    it('uses the directory main bundle for save-time graph analysis of an ancillary file', async () => {
        let capturedRequest: any;
        let capturedOptions: any;
        const backend = {
            kind: 'cli',
            analyze: (req: any, opts: any) => {
                capturedRequest = req;
                capturedOptions = opts;
                return Promise.resolve({ validation: { ok: true, errors: [] }, graph: { nodes: [], edges: [] } });
            },
        };
        const factory = { getBackend: () => backend } as any;
        const graphSink = {
            isShowingMthds: vi.fn(() => true),
            applyAnalysis: vi.fn(),
            applyBackendError: vi.fn(),
            applySkipped: vi.fn(),
        };
        const validator = new PipelexValidator({ appendLine: vi.fn() } as any, factory);
        validator.setGraphSink(graphSink as any);

        const helper = mkDoc('/proj/helper.mthds');
        const bundleUri = { scheme: 'file', fsPath: '/proj/bundle.mthds', toString: () => 'file:///proj/bundle.mthds' };
        mockState.bundleFiles = [
            { uri: helper.uri, name: 'helper.mthds', content: 'domain = "rec"\n[pipe.helper]\n' },
            { uri: bundleUri, name: 'bundle.mthds', content: 'domain = "rec"\nmain_pipe = "main"\n[pipe.main]\n' },
        ];

        await mockState.onSaveHandler!(helper);

        expect(capturedOptions.withGraph).toBe(true);
        expect(capturedRequest.primaryUri.fsPath).toBe('/proj/bundle.mthds');
        expect(capturedRequest.files.map((file: any) => file.name)).toEqual(['bundle.mthds', 'helper.mthds']);
        expect(graphSink.applyAnalysis).toHaveBeenCalledWith(helper.uri, expect.objectContaining({
            graph: { nodes: [], edges: [] },
        }));

        validator.dispose();
    });
});
