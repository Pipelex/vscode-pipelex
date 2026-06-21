import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const mockState = vi.hoisted(() => {
    const mockWebview = {
        html: '',
        asWebviewUri: vi.fn((uri: any) => ({ toString: () => `https://webview-asset/${uri.fsPath || uri}` })),
        onDidReceiveMessage: vi.fn(),
        postMessage: vi.fn(),
    };
    const mockPanel = {
        title: '',
        viewColumn: 2,
        webview: mockWebview,
        reveal: vi.fn(),
        dispose: vi.fn(),
        onDidDispose: vi.fn(),
    };
    return {
        mockWebview,
        mockPanel,
        resolveCliResult: null as { command: string; args: string[] } | null,
        spawnCliResult: { stdout: '', stderr: '' },
        spawnCliResolve: null as ((v: any) => void) | null,
        spawnCliReject: null as ((e: any) => void) | null,
        readFileSyncResult: '<!DOCTYPE html><html><head></head><body>PIPELEX_CSP_NONCE<div id="root"></div><script src="{{GRAPH_JS_URI}}"></script></body></html>',
        showWarningMessage: vi.fn(),
        executeCommand: vi.fn(),
        cancelAllInflightSpy: vi.fn(),
        configOverrides: {} as Record<string, any>,
        // Active VS Code color theme kind (vscode.ColorThemeKind.Dark = 2 by default).
        activeColorThemeKind: 2 as number,
        // Error-list view fixtures: gatherBundleFiles + resolveErrorLocations are mocked
        // so the panel's render/navigation logic is tested in isolation from the resolver.
        bundleFiles: [] as any[],
        errorLocations: [] as any[],
        openTextDocuments: [] as any[],
        // Event handler captures
        onSaveHandler: null as ((doc: any) => void) | null,
        onEditorChangeHandler: null as ((editor: any) => void) | null,
        onDocChangeHandler: null as ((event: any) => void) | null,
    };
});

// ---------- Mocks ----------
vi.mock('vscode', () => ({
    ViewColumn: { One: 1, Beside: -2 },
    Uri: {
        joinPath: vi.fn((...parts: any[]) => ({
            fsPath: parts.map((p: any) => p.fsPath || p).join('/'),
            toString: () => parts.map((p: any) => p.fsPath || p).join('/'),
        })),
        parse: vi.fn((value: string, _strict?: boolean) => {
            const match = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(value);
            if (!match) {
                throw new Error(`invalid URI: ${value}`);
            }
            return { scheme: match[1].toLowerCase(), toString: () => value } as any;
        }),
    },
    env: {
        openExternal: vi.fn(() => Promise.resolve(true)),
    },
    Selection: vi.fn(),
    TextEditorRevealType: { InCenter: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    workspace: {
        get textDocuments() { return mockState.openTextDocuments; },
        getConfiguration: () => ({ get: (key: string, def: any) => mockState.configOverrides[key] ?? def }),
        onDidChangeTextDocument: vi.fn((handler: any) => {
            mockState.onDocChangeHandler = handler;
            return { dispose: vi.fn() };
        }),
        onDidSaveTextDocument: vi.fn((handler: any) => {
            mockState.onSaveHandler = handler;
            return { dispose: vi.fn() };
        }),
        getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
        openTextDocument: vi.fn(() => Promise.resolve({
            lineCount: 10,
            lineAt: (i: number) => ({
                text: i === 3 ? '[pipe.my_pipe]' : '',
                range: { start: { line: i, character: 0 }, end: { line: i, character: 14 } },
            }),
        })),
    },
    window: {
        // Default to a dark editor theme; tests can override via mockState.activeColorThemeKind.
        get activeColorTheme() { return { kind: mockState.activeColorThemeKind ?? 2 }; },
        createWebviewPanel: vi.fn((_id: string, title: string) => {
            mockState.mockPanel.title = title;
            return mockState.mockPanel;
        }),
        showWarningMessage: mockState.showWarningMessage,
        showTextDocument: vi.fn(() => Promise.resolve({
            selection: null,
            revealRange: vi.fn(),
        })),
        onDidChangeActiveTextEditor: vi.fn((handler: any) => {
            mockState.onEditorChangeHandler = handler;
            return { dispose: vi.fn() };
        }),
    },
    commands: {
        executeCommand: mockState.executeCommand,
    },
}));

vi.mock('../validation/cliResolver', () => ({
    resolveCli: vi.fn(() => mockState.resolveCliResult),
}));

vi.mock('../validation/processUtils', () => ({
    spawnCli: vi.fn((..._args: any[]) => {
        if (mockState.spawnCliResolve) {
            // Deferred mode: return a promise controlled externally
            return new Promise((resolve, reject) => {
                mockState.spawnCliResolve = resolve;
                mockState.spawnCliReject = reject;
            });
        }
        return Promise.resolve(mockState.spawnCliResult);
    }),
    cancelAllInflight: (...args: any[]) => mockState.cancelAllInflightSpy(...args),
}));

vi.mock('fs', () => ({
    default: {
        readFileSync: vi.fn(() => mockState.readFileSyncResult),
    },
    readFileSync: vi.fn(() => mockState.readFileSyncResult),
}));

vi.mock('../validation/sourceLocator', () => ({
    findTableHeader: vi.fn((_doc: any, _kind: string, code: string) => {
        if (code === 'my_pipe') return 3;
        return -1;
    }),
}));

vi.mock('../validation/bundleGather', () => ({
    gatherBundleFiles: vi.fn(() => Promise.resolve(mockState.bundleFiles)),
}));

vi.mock('../validation/crossFileDiagnostics', () => ({
    resolveErrorLocations: vi.fn(() => mockState.errorLocations),
}));

// ---------- Import SUT after mocks ----------
import { MethodGraphPanel } from '../graph/methodGraphPanel';
import { BackendError } from '../validation/backend';

// Helper to create a mock output channel
function mockOutput() {
    return { appendLine: vi.fn() } as any;
}

// Helper to create a mock URI
function makeUri(fsPath: string) {
    return {
        fsPath,
        scheme: 'file',
        toString: () => `file://${fsPath}`,
    } as any;
}

// Helper to create a mock extension URI
function makeExtensionUri() {
    return {
        fsPath: '/ext',
        toString: () => 'file:///ext',
    } as any;
}

describe('MethodGraphPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.mockWebview.html = '';
        mockState.mockPanel.title = '';
        mockState.mockPanel.viewColumn = 2;
        mockState.resolveCliResult = { command: 'pipelex-agent', args: [] };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec: { nodes: [], edges: [] } }),
            stderr: '',
        };
        mockState.spawnCliResolve = null;
        mockState.spawnCliReject = null;
        mockState.onSaveHandler = null;
        mockState.onEditorChangeHandler = null;
        mockState.onDocChangeHandler = null;
        mockState.configOverrides = {};
        mockState.bundleFiles = [];
        mockState.errorLocations = [];
        mockState.openTextDocuments = [];
        mockState.activeColorThemeKind = 2; // ColorThemeKind.Dark
    });

    // --- Bug B: Filename extraction ---

    it('show() extracts filename correctly from unix paths', () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/home/user/project/bundle.mthds');

        panel.show(uri);

        // show() sets the title synchronously before refresh()
        expect(mockState.mockPanel.title).toBe('Method Graph — bundle.mthds');
        panel.dispose();
    });

    it('show() extracts filename correctly from Windows backslash paths', () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('C:\\Users\\dev\\project\\bar.mthds');

        panel.show(uri);

        // Bug B: current code uses split('/') which won't split backslashes
        // The title should be "Method Graph — bar.mthds", not the full path
        expect(mockState.mockPanel.title).toBe('Method Graph — bar.mthds');
        panel.dispose();
    });

    // --- GraphSpec (--view) path ---

    it('refresh() uses extension-owned webview when graphspec is present', async () => {
        const graphspec = {
            nodes: [{ id: 'n1', label: 'test', kind: 'operator', status: 'succeeded', ui: {}, inspector: {} }],
            edges: [],
        };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec, pipe_code: 'main' }),
            stderr: '',
        };

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        // Data is buffered until webview signals ready — simulate the handshake
        const receiveMessageCall = mockState.mockWebview.onDidReceiveMessage.mock.calls[0];
        expect(receiveMessageCall).toBeDefined();
        const messageHandler = receiveMessageCall[0];
        messageHandler({ type: 'webviewReady' });

        // Should have called postMessage with setData after webviewReady
        expect(mockState.mockWebview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'setData',
                graphspec: graphspec,
                config: expect.objectContaining({ direction: 'TB' }),
            })
        );
        // The renderer owns the palette via `theme`; the host must never send a
        // `paletteColors` override (it would shadow the light/dark palette).
        const setData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .find((m: any) => m?.type === 'setData');
        expect(setData.config.theme).toBe('dark'); // follows the (mocked dark) editor
        expect(setData.config).not.toHaveProperty('paletteColors');
        panel.dispose();
    });

    it('graph theme follows the active editor color theme (light)', async () => {
        mockState.activeColorThemeKind = 1; // ColorThemeKind.Light
        const graphspec = { nodes: [], edges: [] };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec, pipe_code: 'main' }),
            stderr: '',
        };

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });

        const setData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .find((m: any) => m?.type === 'setData');
        expect(setData.config.theme).toBe('light');
        panel.dispose();
    });

    // --- navigateToPipe message handling ---

    it('handleWebviewMessage navigates to pipe header on navigateToPipe', async () => {
        const vscode = await import('vscode');

        const graphspec = {
            nodes: [{ id: 'n1', label: 'my_pipe', kind: 'operator', status: 'succeeded', ui: {}, inspector: { pipe_code: 'my_pipe' } }],
            edges: [],
        };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec, pipe_code: 'my_pipe' }),
            stderr: '',
        };

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        // Get the onDidReceiveMessage handler and complete handshake
        const receiveMessageCall = mockState.mockWebview.onDidReceiveMessage.mock.calls[0];
        expect(receiveMessageCall).toBeDefined();
        const messageHandler = receiveMessageCall[0];
        messageHandler({ type: 'webviewReady' });

        // Simulate navigateToPipe message
        messageHandler({ type: 'navigateToPipe', pipeCode: 'my_pipe' });
        await new Promise(r => setTimeout(r, 50));

        // Should have opened the document and shown it
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(uri);
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
        panel.dispose();
    });

    // --- CLI flags ---

    it('refresh() sends --view flag', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        expect(args).toContain('--view');
        expect(args).not.toContain('--graph');
        panel.dispose();
    });

    it('refresh() passes --library-dir with the bundle directory', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        const idx = args.indexOf('--library-dir');
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe('/project/methods');
        panel.dispose();
    });

    it('refresh() passes --allow-signatures so stub pipes still render', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        expect(args).toContain('--allow-signatures');
        panel.dispose();
    });

    // --- Regression: staleness after spawnCli (previous Bug 1) ---

    it('refresh() discards spawnCli result when file switched during spawn', async () => {
        let resolveSpawn: ((v: any) => void) | null = null;
        const processUtils = await import('../validation/processUtils');
        vi.mocked(processUtils.spawnCli).mockImplementation(() => {
            return new Promise((resolve) => {
                resolveSpawn = resolve;
            });
        });

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri1 = makeUri('/project/file1.mthds');
        panel.show(uri1);

        // Wait for spawnCli to be called
        await vi.waitFor(() => {
            expect(resolveSpawn).not.toBeNull();
        });

        // Simulate user switching files
        const uri2 = makeUri('/project/file2.mthds');
        (panel as any).currentUri = uri2;

        // Resolve spawnCli for the stale file
        resolveSpawn!({
            stdout: JSON.stringify({ graphspec: { nodes: [], edges: [] } }),
            stderr: '',
        });
        await new Promise(r => setTimeout(r, 10));

        // The staleness check after spawnCli should prevent the stale
        // graphspec from being buffered or sent to the webview.
        expect((panel as any).pendingData).toBeNull();

        // Even after webviewReady handshake, stale data must not be delivered
        const receiveMessageCall = mockState.mockWebview.onDidReceiveMessage.mock.calls[0];
        expect(receiveMessageCall).toBeDefined();
        const messageHandler = receiveMessageCall[0];
        messageHandler({ type: 'webviewReady' });

        expect(mockState.mockWebview.postMessage).not.toHaveBeenCalled();

        panel.dispose();
    });

    // --- Regression: cancel all inflight (previous Bug 1) ---

    it('refresh() cancels all inflight jobs at start of refresh', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');

        panel.show(uri);
        await new Promise(r => setTimeout(r, 10));

        expect(mockState.cancelAllInflightSpy).toHaveBeenCalled();
        panel.dispose();
    });

    // --- Regression: CLI warning (previous Bug 6) ---

    it('refresh() shows warning message when CLI not found', async () => {
        mockState.resolveCliResult = null;

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 10));

        expect(mockState.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('pipelex-agent')
        );
        panel.dispose();
    });

    // --- Retry button on the error view ---

    it('renders a Retry button on the error view and re-runs the analysis when clicked', async () => {
        const processUtils = await import('../validation/processUtils');
        mockState.resolveCliResult = null; // → CLI Not Found error view

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // The error view carries a Retry button wired to post { type: 'retry' }.
        expect(mockState.mockWebview.html).toContain('CLI Not Found');
        expect(mockState.mockWebview.html).toContain('id="pipelex-retry"');
        expect(mockState.mockWebview.html).toMatch(/postMessage\(\s*\{\s*type:\s*'retry'/);
        expect(mockState.mockWebview.html).toContain("script-src 'nonce-");
        // resolveCli returned null, so the analysis never reached spawnCli.
        expect(processUtils.spawnCli).not.toHaveBeenCalled();

        // CLI becomes available; clicking Retry re-runs and now reaches spawnCli.
        mockState.resolveCliResult = { command: 'pipelex-agent', args: [] };
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'retry' });
        await vi.waitFor(() => {
            expect(processUtils.spawnCli).toHaveBeenCalled();
        });

        panel.dispose();
    });

    it('does not render a Retry button on a successful graph render', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // Success path swaps in the graph webview HTML (no error message / Retry button).
        expect(mockState.mockWebview.html).not.toContain('id="pipelex-retry"');
        panel.dispose();
    });

    it('renders a non-auth api-error (e.g. HTTP 503) under "Pipelex API Error", not "Unreachable"', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        panel.applyBackendError(uri, new BackendError({
            kind: 'api-error',
            logMessage: 'Pipelex API 503 at https://api.pipelex.com: service unavailable',
            userMessage: 'Pipelex API error at https://api.pipelex.com (HTTP 503): service unavailable.',
        }));

        const html = mockState.mockWebview.html;
        expect(html).toContain('Pipelex API Error');
        expect(html).not.toContain('Pipelex API Unreachable');
        expect(html).toContain('HTTP 503');
        panel.dispose();
    });

    it('renders an auth error under "Pipelex API Key Required" with buttons + clickable inline links', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        panel.applyBackendError(uri, new BackendError({
            kind: 'auth',
            logMessage: 'Pipelex API 401 at https://api.pipelex.com: unauthorized',
            userMessage: 'plain text fallback (should not be used when detailHtml is present)',
            detailHtml: 'The hosted Pipelex API needs an API key.</p><p>Get it at ' +
                '<a class="pipelex-link" href="https://app.pipelex.com/">app.pipelex.com</a>, or self-host the ' +
                '<a class="pipelex-link" href="https://github.com/Pipelex/pipelex-api">pipelex-api</a> — ' +
                '<code>docker run -p 8081:8081 pipelex/pipelex-api</code>.',
            actions: [
                { label: 'Set API Key', command: 'pipelex.setApiKey' },
                { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
            ],
        }));

        const html = mockState.mockWebview.html;
        expect(html).toContain('Pipelex API Key Required');
        expect(html).not.toContain('Pipelex API Unreachable');
        // Both remedy buttons plus Retry are rendered.
        expect(html).toContain('Set API Key');
        expect(html).toContain('Get an API Key');
        expect(html).toContain('Retry');
        // Buttons post the safe, whitelisted message shapes (command dispatch + http open).
        expect(html).toContain('"type":"runCommand","command":"pipelex.setApiKey"');
        expect(html).toContain('"type":"openExternally","url":"https://app.pipelex.com/"');
        // detailHtml is rendered as real HTML (not escaped), with clickable links + the Docker command.
        expect(html).toContain('<a class="pipelex-link" href="https://app.pipelex.com/"');
        expect(html).toContain('<a class="pipelex-link" href="https://github.com/Pipelex/pipelex-api"');
        expect(html).toContain('docker run -p 8081:8081 pipelex/pipelex-api');
        // The script wires inline-link clicks to open externally.
        expect(html).toContain("querySelectorAll('a.pipelex-link')");
        expect(html).not.toContain('plain text fallback');
        panel.dispose();
    });

    it('never blesses attacker-influenced error text with a nonce (only the trusted Retry script gets one)', async () => {
        // A backend failure carrying server-influenced text (here via the CLI's stderr;
        // the same body path serves the API "unreachable" message, whose text a malicious
        // baseUrl controls). Even WITH the Retry script's script-src active, a <script>
        // smuggled into the body must stay inert.
        const processUtils = await import('../validation/processUtils');
        vi.mocked(processUtils.spawnCli).mockRejectedValueOnce({
            exitCode: 1,
            stderr: '<script>globalThis.pwned = 1;</script>',
        });

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const html = mockState.mockWebview.html;
        // Our own Retry script is the ONLY thing that got a nonce, and the sentinel is consumed.
        expect(html).toMatch(/<script nonce="[^"]+">[\s\S]*postMessage/);
        expect(html).not.toContain('PIPELEX_RETRY_NONCE');
        // The injected payload is escaped (not a live <script>), so it can never execute.
        expect(html).not.toContain('<script>globalThis.pwned');
        expect(html).toContain('&lt;script&gt;globalThis.pwned');
        panel.dispose();
    });

    // --- Validation-error list view (clickable, owner-attributed) ---

    // Drive the invalid-bundle branch of applyAnalysis. resolveErrorLocations is mocked,
    // so each fixture supplies its own resolved owner uri + range.
    function invalidAnalysis(): any {
        return {
            validation: { ok: false, errors: mockState.errorLocations.map((l: any) => l.error) },
            graph: null,
        };
    }

    it('renders the validation errors with a count header, messages, context chips, and Retry', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'missing concept Foo', pipe_code: 'my_pipe' }, uri, range },
            { error: { category: 'concept_validation', message: 'unknown concept Bar', concept_code: 'Bar' }, uri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        const html = mockState.mockWebview.html;
        expect(html).toContain('2 Validation Errors');
        expect(html).toContain('Fix and save to regenerate the graph');
        expect(html).toContain('missing concept Foo');
        expect(html).toContain('unknown concept Bar');
        expect(html).toContain('pipe.my_pipe');
        expect(html).toContain('concept.Bar');
        expect(html).toContain('id="pipelex-retry"');
        expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*'navigateToError'/);
        expect(html).toContain("script-src 'nonce-");
        // Both errors are owned by the saved file → no owning-file chip.
        expect(html).not.toContain('class="file"');
        panel.dispose();
    });

    it('still renders the error list when gathering bundle files fails (no unhandled rejection)', async () => {
        const bundleGather = await import('../validation/bundleGather');
        vi.mocked(bundleGather.gatherBundleFiles).mockRejectedValueOnce(new Error('disk gone'));

        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'still shown despite gather failure' }, uri, range },
        ];

        // The validator calls applyAnalysis fire-and-forget, so a gather failure must
        // resolve (not reject) — otherwise the rejection is unhandled and the panel
        // keeps a stale graph instead of the verdict.
        await expect(panel.applyAnalysis(uri, invalidAnalysis())).resolves.toBeUndefined();

        const html = mockState.mockWebview.html;
        expect(html).toContain('1 Validation Error');
        expect(html).toContain('still shown despite gather failure');
        // The failure was logged, not thrown.
        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('could not gather bundle files'),
        );
        panel.dispose();
    });

    it('uses a singular header for a single validation error', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'only one' }, uri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        expect(mockState.mockWebview.html).toContain('1 Validation Error');
        expect(mockState.mockWebview.html).not.toContain('1 Validation Errors');
        panel.dispose();
    });

    it('shows the owning-file basename for an error that lives in a sibling file', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        const siblingUri = makeUri('/project/methods/concepts.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'helper broke', pipe_code: 'helper' }, uri: siblingUri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        const html = mockState.mockWebview.html;
        expect(html).toContain('class="file"');
        expect(html).toContain('concepts.mthds');
        expect(html).toContain('helper broke');
        panel.dispose();
    });

    it('navigateToError opens the owning file in the column beside the panel', async () => {
        const vscode = await import('vscode');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        const siblingUri = makeUri('/project/methods/concepts.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'helper broke', pipe_code: 'helper' }, uri: siblingUri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'navigateToError', index: 0 });
        await new Promise(r => setTimeout(r, 20));

        // Opens the SIBLING (the owning file), not the saved primary.
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
        // Panel sits in column 2 → file opens beside it in column 1.
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ viewColumn: 1, preserveFocus: false }),
        );
        panel.dispose();
    });

    it('navigateToError with an out-of-range index is a safe no-op', async () => {
        const vscode = await import('vscode');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'x', message: 'only one' }, uri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'navigateToError', index: 5 });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('navigateToError is ignored for graphspec-json source', async () => {
        const vscode = await import('vscode');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // A valid target exists, but the panel is showing a run-graph JSON.
        (panel as any).errorTargets = [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
        (panel as any).sourceKind = 'graphspec-json';

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'navigateToError', index: 0 });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('escapes attacker-influenced error text in the list; only the trusted script is nonced', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const evil = '<script>globalThis.pwned = 1;</script><img src=x onerror=alert(1)>';
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'x', message: evil }, uri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis());

        const html = mockState.mockWebview.html;
        // Our own row/Retry script is the ONLY thing nonced; the sentinel is consumed.
        expect(html).toMatch(/<script nonce="[^"]+">[\s\S]*navigateToError/);
        expect(html).not.toContain('PIPELEX_RETRY_NONCE');
        // The payload is escaped, never a live tag, so it can never execute.
        expect(html).not.toContain('<script>globalThis.pwned');
        expect(html).toContain('&lt;script&gt;globalThis.pwned');
        expect(html).not.toContain('<img src=x onerror=');
        expect(html).toContain('&lt;img src=x onerror=');
        panel.dispose();
    });

    // --- Regression: infinite loop guard (previous Bug 4) ---

    it('onDidChangeActiveTextEditor does not redirect when panel is in column 1', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 10));

        // Simulate panel in column 1
        mockState.mockPanel.viewColumn = 1;

        // Simulate editor opening in column 1 (same as panel)
        const editorChangeHandler = mockState.onEditorChangeHandler;
        expect(editorChangeHandler).not.toBeNull();

        await editorChangeHandler!({
            document: { languageId: 'mthds', uri: makeUri('/project/other.mthds') },
            viewColumn: 1,
        });

        // Should NOT have tried to close/reopen — that would cause an infinite loop
        expect(mockState.executeCommand).not.toHaveBeenCalledWith('workbench.action.closeActiveEditor');

        panel.dispose();
    });

    // --- onDidChangeTextDocument: external file changes ---

    it('external file change triggers debounced refresh after 500ms', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        vi.mocked(processUtils.spawnCli).mockClear();

        // Simulate external change: isDirty=false means editor reloaded from disk
        expect(mockState.onDocChangeHandler).not.toBeNull();
        mockState.onDocChangeHandler!({ document: { uri, isDirty: false } });

        // Should NOT have called spawnCli yet (debounce pending)
        expect(processUtils.spawnCli).not.toHaveBeenCalled();

        // Advance past debounce
        await vi.waitFor(() => {
            expect(processUtils.spawnCli).toHaveBeenCalled();
        }, { timeout: 1000 });

        panel.dispose();
    });

    it('user typing (isDirty=true) does not trigger refresh', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        vi.mocked(processUtils.spawnCli).mockClear();

        // Simulate user typing: isDirty=true
        mockState.onDocChangeHandler!({ document: { uri, isDirty: true } });

        await new Promise(r => setTimeout(r, 600));
        expect(processUtils.spawnCli).not.toHaveBeenCalled();

        panel.dispose();
    });

    it('rapid external changes coalesce into a single refresh', async () => {
        vi.useFakeTimers();
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await vi.advanceTimersByTimeAsync(50);

        vi.mocked(processUtils.spawnCli).mockClear();

        // Simulate two rapid external changes
        mockState.onDocChangeHandler!({ document: { uri, isDirty: false } });
        await vi.advanceTimersByTimeAsync(200);
        mockState.onDocChangeHandler!({ document: { uri, isDirty: false } });
        await vi.advanceTimersByTimeAsync(600);

        // Only one spawnCli call from the second (debounce reset)
        expect(processUtils.spawnCli).toHaveBeenCalledTimes(1);

        panel.dispose();
        vi.useRealTimers();
    });

    it('external change to unrelated file does not trigger refresh', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        vi.mocked(processUtils.spawnCli).mockClear();

        const otherUri = makeUri('/project/other.mthds');
        mockState.onDocChangeHandler!({ document: { uri: otherUri, isDirty: false } });

        await new Promise(r => setTimeout(r, 600));
        expect(processUtils.spawnCli).not.toHaveBeenCalled();

        panel.dispose();
    });

    it('external change after panel closed does not crash', () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.dispose();

        const uri = makeUri('/project/file.mthds');
        expect(() => mockState.onDocChangeHandler!({ document: { uri, isDirty: false } })).not.toThrow();
    });

    // --- openExternally message handling ---

    it('openExternally opens https URLs via vscode.env.openExternal', async () => {
        const vscode = await import('vscode');
        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'https://example.com/foo.pdf' });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
        const calledWith = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as any;
        expect(calledWith.scheme).toBe('https');
        panel.dispose();
    });

    it('openExternally opens http URLs', async () => {
        const vscode = await import('vscode');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'http://example.com/foo.pdf' });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
        panel.dispose();
    });

    it('openExternally refuses non-http(s) schemes (file:)', async () => {
        const vscode = await import('vscode');
        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'file:///etc/passwd' });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.env.openExternal).not.toHaveBeenCalled();
        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('refused')
        );
        panel.dispose();
    });

    it('openExternally refuses vscode: scheme', async () => {
        const vscode = await import('vscode');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'vscode://settings' });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.env.openExternal).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('openExternally logs when openExternal returns false', async () => {
        const vscode = await import('vscode');
        vi.mocked(vscode.env.openExternal).mockResolvedValueOnce(false as any);

        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'https://example.com/x.pdf' });
        await new Promise(r => setTimeout(r, 10));

        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('OS declined')
        );
        panel.dispose();
    });

    it('openExternally logs and skips when URL is unparseable', async () => {
        const vscode = await import('vscode');
        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'openExternally', url: 'not a url' });
        await new Promise(r => setTimeout(r, 10));

        expect(vscode.env.openExternal).not.toHaveBeenCalled();
        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('invalid URL')
        );
        panel.dispose();
    });
});
