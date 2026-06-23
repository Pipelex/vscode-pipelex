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
        // Per-key `inspect()` results (scope values). Falls back to globalValue
        // from configOverrides when a key isn't listed here.
        configInspect: {} as Record<string, any>,
        // Captured `config.update(key, value, target)` calls for assertions.
        configUpdates: [] as { key: string; value: any; target: any }[],
        // Active VS Code color theme kind (vscode.ColorThemeKind.Dark = 2 by default).
        activeColorThemeKind: 2 as number,
        // Error-list view fixtures: gatherBundleFiles + resolveErrorLocations are mocked
        // so the panel's render/navigation logic is tested in isolation from the resolver.
        bundleFiles: [] as any[],
        errorLocations: [] as any[],
        openTextDocuments: [] as any[],
        // Per-fsPath file contents for the URI-aware openTextDocument mock, so a
        // resolved sibling opens with real text the faithful findTableHeader can scan.
        docContents: {} as Record<string, string>,
        // Event handler captures
        onSaveHandler: null as ((doc: any) => void) | null,
        onEditorChangeHandler: null as ((editor: any) => void) | null,
        onDocChangeHandler: null as ((event: any) => void) | null,
        onColorThemeChangeHandler: null as ((theme: any) => void) | null,
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
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        get textDocuments() { return mockState.openTextDocuments; },
        getConfiguration: () => ({
            get: (key: string, def: any) => mockState.configOverrides[key] ?? def,
            inspect: (key: string) => mockState.configInspect[key] ?? { globalValue: mockState.configOverrides[key] },
            update: (key: string, value: any, target: any) => {
                mockState.configUpdates.push({ key, value, target });
                return Promise.resolve();
            },
        }),
        onDidChangeTextDocument: vi.fn((handler: any) => {
            mockState.onDocChangeHandler = handler;
            return { dispose: vi.fn() };
        }),
        onDidSaveTextDocument: vi.fn((handler: any) => {
            mockState.onSaveHandler = handler;
            return { dispose: vi.fn() };
        }),
        getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
        openTextDocument: vi.fn((uriArg: any) => {
            // URI-aware: when a fixture registers content for this path, build a
            // document from it (so a resolved sibling opens with its real text);
            // otherwise fall back to the legacy single-doc shape used by older tests.
            const fsPath = uriArg?.fsPath ?? uriArg;
            const content = mockState.docContents[fsPath];
            if (content != null) {
                const lines = content.split('\n');
                return Promise.resolve({
                    lineCount: lines.length,
                    lineAt: (i: number) => ({
                        text: lines[i] ?? '',
                        range: { start: { line: i, character: 0 }, end: { line: i, character: (lines[i] ?? '').length } },
                    }),
                });
            }
            return Promise.resolve({
                lineCount: 10,
                lineAt: (i: number) => ({
                    text: i === 3 ? '[pipe.my_pipe]' : '',
                    range: { start: { line: i, character: 0 }, end: { line: i, character: 14 } },
                }),
            });
        }),
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
        onDidChangeActiveColorTheme: vi.fn((handler: any) => {
            mockState.onColorThemeChangeHandler = handler;
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

// Faithful (vscode-free) re-implementations: findTableHeader scans the opened
// document, findTableHeaderInLines scans raw lines — the latter is what the real
// resolveDeclaringFile (unmocked here) calls during its scan-fallback tier.
vi.mock('../validation/sourceLocator', () => {
    const headerRe = (kind: string, code: string) =>
        new RegExp(`^\\s*\\[${kind}\\.${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
    return {
        escapeRegex: (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        findTableHeader: vi.fn((doc: any, kind: string, code: string) => {
            const re = headerRe(kind, code);
            for (let i = 0; i < doc.lineCount; i++) {
                if (re.test(doc.lineAt(i).text)) return i;
            }
            return -1;
        }),
        findTableHeaderInLines: vi.fn((lines: string[], kind: string, code: string) => {
            const re = headerRe(kind, code);
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) return i;
            }
            return -1;
        }),
    };
});

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
        mockState.onColorThemeChangeHandler = null;
        mockState.configOverrides = {};
        mockState.configInspect = {};
        mockState.configUpdates = [];
        mockState.bundleFiles = [];
        mockState.errorLocations = [];
        mockState.openTextDocuments = [];
        mockState.docContents = {};
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
        // Default mode is `system`, following the (mocked dark) editor via the
        // injected `systemTheme`.
        expect(setData.config.theme).toBe('system');
        expect(setData.config.systemTheme).toBe('dark');
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
        // `system` mode resolves to the (mocked light) editor via `systemTheme`.
        expect(setData.config.theme).toBe('system');
        expect(setData.config.systemTheme).toBe('light');
        panel.dispose();
    });

    it('re-sends the resolved systemTheme when the editor color theme switches', async () => {
        const graphspec = { nodes: [], edges: [] };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec, pipe_code: 'main' }),
            stderr: '',
        };

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));

        // Complete the handshake so the panel is ready to receive live updates.
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });

        // The constructor registered a color-theme listener.
        expect(mockState.onColorThemeChangeHandler).not.toBeNull();

        // Editor switches dark → light; the host re-sends only the resolved
        // systemTheme so the renderer's `system` mode flips live.
        mockState.mockWebview.postMessage.mockClear();
        mockState.activeColorThemeKind = 1; // ColorThemeKind.Light
        mockState.onColorThemeChangeHandler!({ kind: 1 });

        expect(mockState.mockWebview.postMessage).toHaveBeenCalledWith({
            type: 'setSystemTheme',
            systemTheme: 'light',
        });
        panel.dispose();
    });

    it('does not post a theme update when no graph is showing yet (not ready)', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));

        // No webviewReady handshake → the webview can't receive a live update.
        mockState.mockWebview.postMessage.mockClear();
        mockState.activeColorThemeKind = 1;
        mockState.onColorThemeChangeHandler!({ kind: 1 });

        expect(mockState.mockWebview.postMessage).not.toHaveBeenCalled();
        panel.dispose();
    });

    // --- themeModeChanged persistence ---

    // The in-graph theme toggle reports its new mode; the host persists it into
    // `pipelex.graph.theme` so it survives reloads / restarts.
    async function showGraphAndGetHandler() {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        return { panel, messageHandler };
    }

    it('persists a dark/light toggle to pipelex.graph.theme (Global) verbatim', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();

        messageHandler({ type: 'themeModeChanged', mode: 'light' });
        await new Promise(r => setTimeout(r, 0));

        expect(mockState.configUpdates).toContainEqual({ key: 'graph.theme', value: 'light', target: 1 });
        panel.dispose();
    });

    it('maps the renderer "system" mode onto the setting\'s "auto" value', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();
        // Pretend the setting is currently pinned to light so the write is observable.
        mockState.configInspect['graph.theme'] = { globalValue: 'light' };

        messageHandler({ type: 'themeModeChanged', mode: 'system' });
        await new Promise(r => setTimeout(r, 0));

        expect(mockState.configUpdates).toContainEqual({ key: 'graph.theme', value: 'auto', target: 1 });
        panel.dispose();
    });

    it('writes at the scope where the setting is already defined so the toggle sticks', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();
        mockState.configInspect['graph.theme'] = { workspaceValue: 'dark' };

        messageHandler({ type: 'themeModeChanged', mode: 'light' });
        await new Promise(r => setTimeout(r, 0));

        // ConfigurationTarget.Workspace === 2
        expect(mockState.configUpdates).toContainEqual({ key: 'graph.theme', value: 'light', target: 2 });
        panel.dispose();
    });

    it('never targets WorkspaceFolder — the unscoped reader cannot see it', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();
        // Even if a folder-scoped value exists, the writer must match the
        // resource-blind resolveGraphConfig: target Global, not WorkspaceFolder
        // (which would be written but never read back).
        mockState.configInspect['graph.theme'] = { workspaceFolderValue: 'dark' };

        messageHandler({ type: 'themeModeChanged', mode: 'light' });
        await new Promise(r => setTimeout(r, 0));

        // ConfigurationTarget.Global === 1 (never 3 / WorkspaceFolder).
        expect(mockState.configUpdates).toContainEqual({ key: 'graph.theme', value: 'light', target: 1 });
        panel.dispose();
    });

    it('does not pin an explicit "auto" over the contributed default (toml-pin safe)', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();
        // Nothing explicitly set; the effective value is the contributed default.
        // Toggling to system (→ auto) must NOT write, or it would override a
        // pipelex.toml style.theme pin (which resolveGraphConfig only yields to an
        // *explicitly* set graph.theme).
        mockState.configInspect['graph.theme'] = { defaultValue: 'auto' };

        messageHandler({ type: 'themeModeChanged', mode: 'system' });
        await new Promise(r => setTimeout(r, 0));

        expect(mockState.configUpdates).toHaveLength(0);
        panel.dispose();
    });

    it('does not write when the new mode already matches the persisted value', async () => {
        const { panel, messageHandler } = await showGraphAndGetHandler();
        mockState.configInspect['graph.theme'] = { globalValue: 'dark' };

        messageHandler({ type: 'themeModeChanged', mode: 'dark' });
        await new Promise(r => setTimeout(r, 0));

        expect(mockState.configUpdates).toHaveLength(0);
        panel.dispose();
    });

    it('ignores an unknown theme mode without writing', async () => {
        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];

        messageHandler({ type: 'themeModeChanged', mode: 'sepia' });
        await new Promise(r => setTimeout(r, 0));

        expect(mockState.configUpdates).toHaveLength(0);
        expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('unknown theme mode "sepia"'));
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

    // --- Cross-file pipe navigation (source-first, scan-as-fallback) ---

    // Drive a graphspec (with a pipe_registry) onto the panel via the normal CLI
    // path so `currentGraphspec` is retained, then return the message handler.
    async function showGraphWithSpec(panel: MethodGraphPanel, primaryUri: any, graphspec: any) {
        mockState.spawnCliResult = { stdout: JSON.stringify({ graphspec, pipe_code: 'x' }), stderr: '' };
        panel.show(primaryUri);
        await new Promise(r => setTimeout(r, 50));
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });
        return messageHandler;
    }

    it('navigateToPipe opens the concrete sibling named by registry `source` (cross-file)', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const siblingUri = makeUri('/project/methods/screen.mthds');

        // `screen` is declared in BOTH the primary (signature) and the sibling
        // (concrete). The registry `source` points at the concrete sibling — the
        // win a pure scan (which hits the primary signature first) cannot make.
        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ pipe_code: 'screen', domain_code: 'rec', kind: 'controller' }],
            edges: [],
            pipe_registry: {
                'rec.screen': { code: 'screen', domain_code: 'rec', source: '/project/methods/screen.mthds' },
            },
        };
        mockState.docContents['/project/methods/screen.mthds'] =
            'domain = "rec"\n[pipe.screen]\ntype = "PipeSequence"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "rec"\n[pipe.screen]\ntype = "PipeSignature"\n' },
            { uri: siblingUri, name: 'screen.mthds', content: mockState.docContents['/project/methods/screen.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'screen' });
        await new Promise(r => setTimeout(r, 20));

        // Opened the CONCRETE sibling, not the signature in the primary, and revealed it beside.
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ viewColumn: 1, preserveFocus: false }),
        );
        panel.dispose();
    });

    it('navigateToPipe reads domain-less registry sources from `.pipe` keys', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const siblingUri = makeUri('/project/methods/screen.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ id: 'node-screen', pipe_code: 'screen', kind: 'controller' }],
            edges: [],
            pipe_registry: {
                '.screen': { code: 'screen', domain_code: '', source: '/project/methods/screen.mthds' },
            },
        };
        mockState.docContents['/project/methods/screen.mthds'] =
            '[pipe.screen]\ntype = "PipeSequence"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: '[pipe.screen]\ntype = "PipeSignature"\n' },
            { uri: siblingUri, name: 'screen.mthds', content: mockState.docContents['/project/methods/screen.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'screen', nodeId: 'node-screen', domainCode: '' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
        panel.dispose();
    });

    it('navigateToPipe uses the clicked node domain when two nodes share a pipe_code', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const alphaUri = makeUri('/project/methods/alpha.mthds');
        const betaUri = makeUri('/project/methods/beta.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [
                { id: 'alpha-process', pipe_code: 'process', domain_code: 'alpha', kind: 'operator' },
                { id: 'beta-process', pipe_code: 'process', domain_code: 'beta', kind: 'operator' },
            ],
            edges: [],
            pipe_registry: {
                'alpha.process': { code: 'process', domain_code: 'alpha', source: '/project/methods/alpha.mthds' },
                'beta.process': { code: 'process', domain_code: 'beta', source: '/project/methods/beta.mthds' },
            },
        };
        mockState.docContents['/project/methods/alpha.mthds'] = 'domain = "alpha"\n[pipe.process]\n';
        mockState.docContents['/project/methods/beta.mthds'] = 'domain = "beta"\n[pipe.process]\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "root"\n[pipe.main]\n' },
            { uri: alphaUri, name: 'alpha.mthds', content: mockState.docContents['/project/methods/alpha.mthds'] },
            { uri: betaUri, name: 'beta.mthds', content: mockState.docContents['/project/methods/beta.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'process', nodeId: 'beta-process', domainCode: 'beta' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(betaUri);
        panel.dispose();
    });

    it('navigateToPipe does not use a domainless registry source for a domain-specific click', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const domainlessUri = makeUri('/project/methods/shared.mthds');
        const betaUri = makeUri('/project/methods/beta.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ id: 'beta-process', pipe_code: 'process', domain_code: 'beta', kind: 'operator' }],
            edges: [],
            pipe_registry: {
                '.process': { code: 'process', domain_code: '', source: '/project/methods/shared.mthds' },
            },
        };
        mockState.docContents['/project/methods/shared.mthds'] = '[pipe.process]\n';
        mockState.docContents['/project/methods/beta.mthds'] = 'domain = "beta"\n[pipe.process]\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "root"\n[pipe.main]\n' },
            { uri: domainlessUri, name: 'shared.mthds', content: mockState.docContents['/project/methods/shared.mthds'] },
            { uri: betaUri, name: 'beta.mthds', content: mockState.docContents['/project/methods/beta.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'process', nodeId: 'beta-process', domainCode: 'beta' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(betaUri);
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalledWith(domainlessUri);
        panel.dispose();
    });

    it('navigateToPipe falls back to the declaration scan when registry `source` is stale', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const staleUri = makeUri('/project/methods/stale.mthds');
        const siblingUri = makeUri('/project/methods/helpers.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ id: 'node-build', pipe_code: 'build', domain_code: 'rec', kind: 'operator' }],
            edges: [],
            pipe_registry: { 'rec.build': { code: 'build', domain_code: 'rec', source: '/project/methods/stale.mthds' } },
        };
        mockState.docContents['/project/methods/helpers.mthds'] = 'domain = "rec"\n[pipe.build]\ntype = "PipeLLM"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "rec"\n[pipe.main]\n' },
            { uri: staleUri, name: 'stale.mthds', content: 'domain = "rec"\n[pipe.other]\n' },
            { uri: siblingUri, name: 'helpers.mthds', content: mockState.docContents['/project/methods/helpers.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'build', nodeId: 'node-build', domainCode: 'rec' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
        panel.dispose();
    });

    it('navigateToPipe keeps a primary-declared pipe on the primary file (single-file regression)', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ pipe_code: 'main', domain_code: 'rec', kind: 'controller' }],
            edges: [],
            pipe_registry: { 'rec.main': { code: 'main', domain_code: 'rec', source: '/project/methods/bundle.mthds' } },
        };
        mockState.docContents['/project/methods/bundle.mthds'] = 'domain = "rec"\n[pipe.main]\ntype = "PipeLLM"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: mockState.docContents['/project/methods/bundle.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'main' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(primaryUri);
        panel.dispose();
    });

    it('navigateToPipe falls back to the declaration scan when the registry omits `source` (older CLI)', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const siblingUri = makeUri('/project/methods/helpers.mthds');

        // Registry entry WITHOUT a `source` — the feature-detection degradation path.
        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ pipe_code: 'helper', domain_code: 'rec', kind: 'operator' }],
            edges: [],
            pipe_registry: { 'rec.helper': { code: 'helper', domain_code: 'rec' } },
        };
        mockState.docContents['/project/methods/helpers.mthds'] = 'domain = "rec"\n[pipe.helper]\ntype = "PipeLLM"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "rec"\n[pipe.main]\n' },
            { uri: siblingUri, name: 'helpers.mthds', content: mockState.docContents['/project/methods/helpers.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'helper' });
        await new Promise(r => setTimeout(r, 20));

        // No source → scan locates `[pipe.helper]` in the sibling.
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
        panel.dispose();
    });

    it('navigateToPipe aborts if the panel switches files while gathering siblings', async () => {
        const vscode = await import('vscode');
        const bundleGather = await import('../validation/bundleGather');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const siblingUri = makeUri('/project/methods/helpers.mthds');
        let resolveGather: ((files: any[]) => void) | undefined;

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ id: 'node-helper', pipe_code: 'helper', domain_code: 'rec', kind: 'operator' }],
            edges: [],
            pipe_registry: { 'rec.helper': { code: 'helper', domain_code: 'rec', source: '/project/methods/helpers.mthds' } },
        };
        mockState.docContents['/project/methods/helpers.mthds'] = 'domain = "rec"\n[pipe.helper]\n';

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(bundleGather.gatherBundleFiles).mockImplementationOnce(() => new Promise(resolve => {
            resolveGather = resolve;
        }));
        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'helper', nodeId: 'node-helper', domainCode: 'rec' });
        await vi.waitFor(() => {
            expect(resolveGather).toBeDefined();
        });
        (panel as any).currentUri = makeUri('/project/methods/other.mthds');
        resolveGather!([
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "rec"\n[pipe.main]\n' },
            { uri: siblingUri, name: 'helpers.mthds', content: mockState.docContents['/project/methods/helpers.mthds'] },
        ]);
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('navigateToPipe logs and stays put for a synthesized pipe with no declaring file', async () => {
        const output = mockOutput();
        const primaryUri = makeUri('/project/methods/bundle.mthds');

        // A synthesized controller (e.g. an implicit batch wrapper): no `source` and
        // no declaring header anywhere — mirrors today's silent-log behavior.
        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ pipe_code: 'process_batch', domain_code: 'rec', kind: 'controller' }],
            edges: [],
            pipe_registry: { 'rec.process_batch': { code: 'process_batch', domain_code: 'rec' } },
        };
        mockState.docContents['/project/methods/bundle.mthds'] = 'domain = "rec"\n[pipe.main]\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: mockState.docContents['/project/methods/bundle.mthds'] },
        ];

        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        messageHandler({ type: 'navigateToPipe', pipeCode: 'process_batch' });
        await new Promise(r => setTimeout(r, 20));

        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('Could not find [pipe.process_batch]'),
        );
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

    it('refresh() analyzes sibling bundle.mthds when opened file has no main_pipe', async () => {
        const processUtils = await import('../validation/processUtils');
        const graphspec = { nodes: [], edges: [] };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graphspec, pipe_code: 'main' }),
            stderr: '',
        };
        const helperUri = makeUri('/project/methods/helper.mthds');
        const bundleUri = makeUri('/project/methods/bundle.mthds');
        mockState.bundleFiles = [
            { uri: helperUri, name: 'helper.mthds', content: 'domain = "rec"\n[pipe.helper]\n' },
            { uri: bundleUri, name: 'bundle.mthds', content: 'domain = "rec"\nmain_pipe = "main"\n[pipe.main]\n' },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(helperUri);
        await new Promise(r => setTimeout(r, 50));

        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        expect(args).toEqual(expect.arrayContaining([
            'validate',
            'bundle',
            '/project/methods/bundle.mthds',
            '--library-dir',
            '/project/methods',
        ]));

        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });
        expect(mockState.mockWebview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'setData',
                uri: helperUri.toString(),
                graphspec,
            }),
        );
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

        const output = mockOutput();
        const panel = new MethodGraphPanel(output, makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));
        vi.mocked(bundleGather.gatherBundleFiles).mockRejectedValueOnce(new Error('disk gone'));

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

    it('onDidChangeActiveTextEditor keeps the current graph when switching bundles in the same directory', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/bundle.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        vi.mocked(processUtils.spawnCli).mockClear();
        const originalTitle = mockState.mockPanel.title;
        const editorChangeHandler = mockState.onEditorChangeHandler;
        expect(editorChangeHandler).not.toBeNull();

        await editorChangeHandler!({
            document: { languageId: 'mthds', uri: makeUri('/project/methods/helper.mthds') },
            viewColumn: 1,
        });

        expect(processUtils.spawnCli).not.toHaveBeenCalled();
        expect(mockState.mockPanel.title).toBe(originalTitle);
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
