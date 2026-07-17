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
        onConfigChangeHandler: null as ((event: any) => void) | null,
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
    Range: class {
        start: any;
        end: any;
        constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
        }
    },
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
        onDidChangeConfiguration: vi.fn((handler: any) => {
            mockState.onConfigChangeHandler = handler;
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

// A minimal valid bundle — the REAL static builder (unmocked) renders it
// without pipelex, which is the whole point of the static-first flow.
const VALID_BUNDLE = [
    'domain = "demo"',
    'main_pipe = "greet"',
    '',
    '[pipe.greet]',
    'type = "PipeLLM"',
    'description = "Greet the user"',
    'output = "Text"',
    'prompt = "Say hello"',
    '',
].join('\n');

/** Seed the gathered bundle files with one file (the shown one) holding `content`. */
function seedBundle(uri: any, content: string = VALID_BUNDLE) {
    mockState.bundleFiles = [
        { uri, name: uri.fsPath.replace(/^.*[\\/]/, ''), content },
    ];
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
        mockState.onConfigChangeHandler = null;
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

    // --- Static-first graph path ---

    it('refresh() renders the STATIC graph immediately and carries the validation payload', async () => {
        const uri = makeUri('/project/file.mthds');
        seedBundle(uri);

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
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
                config: expect.objectContaining({ direction: 'TB' }),
            })
        );
        const setData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .find((m: any) => m?.type === 'setData');
        // The graphspec is the static builder's output, not a CLI product.
        expect(setData.graphspec.meta.mode).toBe('static');
        expect(JSON.stringify(setData.graphspec)).toContain('greet');
        // The verdict rode onto the pending setData: the default spawnCli mock
        // succeeded (exit 0) before the handshake, so the widget shows `valid`.
        expect(setData.validation.state).toBe('valid');
        // The renderer owns the palette via `theme`; the host must never send a
        // `paletteColors` override (it would shadow the light/dark palette).
        // Default mode is `system`, following the (mocked dark) editor via the
        // injected `systemTheme`.
        expect(setData.config.theme).toBe('system');
        expect(setData.config.systemTheme).toBe('dark');
        expect(setData.config).not.toHaveProperty('paletteColors');
        // Toolbar anchor defaults to top-right (the mthds-ui default) when the
        // pipelex.graph.toolbarPosition setting is unset.
        expect(setData.config.toolbarPosition).toBe('top-right');
        panel.dispose();
    });

    it('forwards the pinned pipelex.graph.toolbarPosition into setData config', async () => {
        mockState.configOverrides['graph.toolbarPosition'] = 'center-left';
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
        expect(setData.config.toolbarPosition).toBe('center-left');
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

    it('re-sends the toolbar position when pipelex.graph.toolbarPosition changes', async () => {
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

        // The constructor registered a configuration listener.
        expect(mockState.onConfigChangeHandler).not.toBeNull();

        // User picks a new anchor in settings; the host re-sends only the
        // resolved toolbar position so the toolbar moves live.
        mockState.mockWebview.postMessage.mockClear();
        mockState.configOverrides['graph.toolbarPosition'] = 'bottom-center';
        mockState.onConfigChangeHandler!({ affectsConfiguration: (k: string) => k === 'pipelex.graph.toolbarPosition' });
        await new Promise(r => setTimeout(r, 10)); // onToolbarPositionChanged awaits resolveGraphConfig

        expect(mockState.mockWebview.postMessage).toHaveBeenCalledWith({
            type: 'setToolbarPosition',
            toolbarPosition: 'bottom-center',
        });
        panel.dispose();
    });

    it('ignores configuration changes unrelated to the toolbar position', async () => {
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

        // An unrelated setting changed — no toolbar message should be posted.
        mockState.mockWebview.postMessage.mockClear();
        mockState.onConfigChangeHandler!({ affectsConfiguration: (k: string) => k === 'pipelex.graph.edgeType' });
        await new Promise(r => setTimeout(r, 10));

        expect(mockState.mockWebview.postMessage).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('does not post a toolbar update when no graph is showing yet (not ready)', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(makeUri('/project/file.mthds'));
        await new Promise(r => setTimeout(r, 50));

        // No webviewReady handshake → the webview can't receive a live update.
        mockState.mockWebview.postMessage.mockClear();
        mockState.configOverrides['graph.toolbarPosition'] = 'bottom-center';
        mockState.onConfigChangeHandler!({ affectsConfiguration: (k: string) => k === 'pipelex.graph.toolbarPosition' });
        await new Promise(r => setTimeout(r, 10));

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

    it('navigateToPipe prefers a concrete sibling over a same-code typeless signature when registry source is absent', async () => {
        const vscode = await import('vscode');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        const siblingUri = makeUri('/project/methods/screen.mthds');

        const graphspec = {
            meta: { format: 'mthds' },
            nodes: [{ pipe_code: 'screen', domain_code: 'rec', kind: 'controller' }],
            edges: [],
            pipe_registry: {
                'rec.screen': { code: 'screen', domain_code: 'rec' },
            },
        };
        mockState.docContents['/project/methods/screen.mthds'] =
            'domain = "rec"\n[pipe.screen]\ntype = "PipeSequence"\n';
        mockState.bundleFiles = [
            { uri: primaryUri, name: 'bundle.mthds', content: 'domain = "rec"\n[pipe.screen]\ndescription = "Screen contract"\noutput = "Image"\n' },
            { uri: siblingUri, name: 'screen.mthds', content: mockState.docContents['/project/methods/screen.mthds'] },
        ];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const messageHandler = await showGraphWithSpec(panel, primaryUri, graphspec);

        vi.mocked(vscode.workspace.openTextDocument).mockClear();
        messageHandler({ type: 'navigateToPipe', pipeCode: 'screen' });
        await new Promise(r => setTimeout(r, 20));

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(siblingUri);
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

    it('refresh() analyzes for the verdict only — never requests --view (the graph is static)', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 50));

        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        expect(args).toEqual(expect.arrayContaining(['validate', 'bundle', '--format', 'json']));
        expect(args).not.toContain('--view');
        expect(args).not.toContain('--direction');
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

        // The static graph is anchored on the directory's main bundle too
        // (primary-first file ordering feeds the static builder's entry heuristic).
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });
        const setData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .find((m: any) => m?.type === 'setData');
        expect(setData.uri).toBe(helperUri.toString());
        expect(setData.graphspec.meta.mode).toBe('static');
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

    it('refresh() discards a stale analyze verdict when the file switched during the spawn', async () => {
        const resolvers: ((v: any) => void)[] = [];
        const processUtils = await import('../validation/processUtils');
        vi.mocked(processUtils.spawnCli).mockImplementation(() => {
            return new Promise((resolve) => {
                resolvers.push(resolve);
            });
        });

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri1 = makeUri('/project/file1.mthds');
        panel.show(uri1);
        await vi.waitFor(() => {
            expect(resolvers.length).toBe(1);
        });

        // User switches files: the panel re-renders the static graph for file2
        // and starts its own analyze.
        const uri2 = makeUri('/project/file2.mthds');
        panel.show(uri2);
        await vi.waitFor(() => {
            expect(resolvers.length).toBe(2);
        });

        // The STALE spawn resolves (exit 0 → a `valid` verdict for file1).
        resolvers[0]({ stdout: '', stderr: '' });
        await new Promise(r => setTimeout(r, 10));

        // The staleness check discards it: the buffered payload belongs to file2
        // and its widget still shows `validating` (file2's spawn is unresolved).
        expect((panel as any).pendingData.uri).toBe(uri2.toString());
        expect((panel as any).pendingData.validation.state).toBe('validating');

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

    // --- Backend failures: the graph stays, the widget flips to `error` ---

    it('CLI not found → static graph stays, widget flips to error, one-time toast', async () => {
        const processUtils = await import('../validation/processUtils');
        mockState.resolveCliResult = null; // analyze → BackendError('not-found')
        const uri = makeUri('/project/file.mthds');
        seedBundle(uri);

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // The static graph rendered regardless — pipelex is not needed for it.
        const pending = (panel as any).pendingData;
        expect(pending.type).toBe('setData');
        expect(pending.graphspec.meta.mode).toBe('static');
        // The widget carries the failure as its lead issue.
        expect(pending.validation.state).toBe('error');
        expect(pending.validation.issues[0].message).toContain('pipelex-agent');
        // One-time toast; the analysis never reached spawnCli.
        expect(mockState.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('pipelex-agent'),
        );
        expect(processUtils.spawnCli).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('falls back to a Read Error view (with Retry) when the bundle files cannot be read', async () => {
        const processUtils = await import('../validation/processUtils');
        const bundleGather = await import('../validation/bundleGather');
        // Attacker-influenced text in the failure must be escaped, and only our
        // own Retry script may carry the nonce.
        vi.mocked(bundleGather.gatherBundleFiles).mockRejectedValueOnce(
            new Error('<script>globalThis.pwned = 1;</script> disk gone'),
        );

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/file.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const html = mockState.mockWebview.html;
        expect(html).toContain('Read Error');
        expect(html).toContain('id="pipelex-retry"');
        expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*'retry'/);
        expect(html).toContain("script-src 'nonce-");
        expect(html).not.toContain('PIPELEX_RETRY_NONCE');
        // The injected payload is escaped (not a live <script>), so it can never execute.
        expect(html).not.toContain('<script>globalThis.pwned');
        expect(html).toContain('&lt;script&gt;globalThis.pwned');
        // No graph was rendered, so the analyze was never started.
        expect(processUtils.spawnCli).not.toHaveBeenCalled();

        // Clicking Retry re-runs the full refresh; the gather now succeeds and
        // the analysis reaches spawnCli.
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

    it('applyBackendError (validator path) flips the widget to error without a toast', async () => {
        const uri = makeUri('/project/file.mthds');
        seedBundle(uri);
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));
        mockState.showWarningMessage.mockClear();

        panel.applyBackendError(uri, new BackendError({
            kind: 'api-error',
            logMessage: 'Pipelex API 503 at https://api.pipelex.com: service unavailable',
            userMessage: 'Pipelex API error at https://api.pipelex.com (HTTP 503): service unavailable.',
        }));

        // The graph HTML is untouched (no full-page error view since static-first).
        expect(mockState.mockWebview.html).not.toContain('Pipelex API Error');
        const pending = (panel as any).pendingData;
        expect(pending.validation.state).toBe('error');
        expect(pending.validation.issues[0].message).toContain('HTTP 503');
        // On the validator path the validator owns notifications — no toast here.
        expect(mockState.showWarningMessage).not.toHaveBeenCalled();
        panel.dispose();
    });

    it("the panel's own analyze failure (auth) toasts with the backend's remedy actions", async () => {
        const uri = makeUri('/project/file.mthds');
        seedBundle(uri);
        const authError = new BackendError({
            kind: 'auth',
            logMessage: 'Pipelex API 401 at https://api.pipelex.com: unauthorized',
            userMessage: 'The hosted Pipelex API needs an API key.',
            actions: [
                { label: 'Set API Key', command: 'pipelex.setApiKey' },
                { label: 'Get an API Key', externalUrl: 'https://app.pipelex.com/' },
            ],
        });
        const backend = { kind: 'api', analyze: vi.fn(() => Promise.reject(authError)) } as any;
        mockState.showWarningMessage.mockReturnValueOnce(Promise.resolve('Set API Key'));

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri(), () => backend);
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // Toast with the remedies as actions; picking one dispatches its command.
        expect(mockState.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('API key'),
            'Set API Key',
            'Get an API Key',
        );
        await new Promise(r => setTimeout(r, 10));
        expect(mockState.executeCommand).toHaveBeenCalledWith('pipelex.setApiKey');
        // And the widget carries the failure.
        const pending = (panel as any).pendingData;
        expect(pending.validation.state).toBe('error');
        expect(pending.validation.issues[0].message).toContain('API key');
        panel.dispose();
    });

    // --- Invalid verdict → widget issues (clickable, owner-attributed) ---

    // Drive the invalid-bundle branch of applyAnalysis. resolveErrorLocations is mocked,
    // so each fixture supplies its own resolved owner uri + range.
    function invalidAnalysis(): any {
        return {
            validation: { ok: false, errors: mockState.errorLocations.map((l: any) => l.error) },
            graph: null,
        };
    }

    /** The validation payload the webview would render (buffered or posted). */
    function currentValidationPayload(panel: any): any {
        const posted = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m?.type === 'setValidationStatus')
            .pop();
        if (posted) return { state: posted.state, issues: posted.issues };
        return panel.pendingData?.validation;
    }

    it('posts the invalid verdict as widget issues with messages, context chips, and fixes', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            {
                error: {
                    category: 'pipe_validation',
                    message: 'missing concept Foo',
                    pipe_code: 'my_pipe',
                    suggested_fix: { fix_code: 'declare-concept', description: 'Declare [concept.Foo].', ops: [] },
                },
                uri,
                range,
            },
            { error: { category: 'concept_validation', message: 'unknown concept Bar', concept_code: 'Bar' }, uri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis(), uri);

        const validation = currentValidationPayload(panel);
        expect(validation.state).toBe('invalid');
        expect(validation.issues).toEqual([
            expect.objectContaining({
                severity: 'error',
                message: 'missing concept Foo',
                context: 'pipe.my_pipe',
                suggestedFix: 'Declare [concept.Foo].',
                origin: 'validator',
            }),
            expect.objectContaining({ message: 'unknown concept Bar', context: 'concept.Bar' }),
        ]);
        // Both errors are owned by the shown file → no owning-file label.
        expect(validation.issues[0].file).toBeUndefined();
        expect(validation.issues[1].file).toBeUndefined();
        panel.dispose();
    });

    it('still posts the verdict when gathering bundle files fails (no unhandled rejection)', async () => {
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
        // resolve (not reject) — otherwise the rejection is unhandled and the widget
        // keeps showing a stale state instead of the verdict.
        await expect(panel.applyAnalysis(uri, invalidAnalysis(), uri)).resolves.toBeUndefined();

        const validation = currentValidationPayload(panel);
        expect(validation.state).toBe('invalid');
        expect(validation.issues[0].message).toBe('still shown despite gather failure');
        // The failure was logged, not thrown.
        expect(output.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('could not gather bundle files'),
        );
        panel.dispose();
    });

    it('labels an issue with the owning-file basename when it lives in a sibling file', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        const siblingUri = makeUri('/project/methods/concepts.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'pipe_validation', message: 'helper broke', pipe_code: 'helper' }, uri: siblingUri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis(), uri);

        const validation = currentValidationPayload(panel);
        expect(validation.issues[0].file).toBe('concepts.mthds');
        expect(validation.issues[0].message).toBe('helper broke');
        panel.dispose();
    });

    it('a valid verdict keeps only the static analyzer warnings', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // Seed static analysis results directly: one warning, one error.
        (panel as any).staticIssues = [
            { severity: 'warning', message: 'tolerated with fallback', origin: 'static' },
            { severity: 'error', message: 'static thought this was broken', origin: 'static' },
        ];
        (panel as any).staticTargets = [undefined, undefined];

        await panel.applyAnalysis(uri, { validation: { ok: true, errors: [] } } as any, uri);

        // The verdict is authoritative: static errors are dropped, warnings kept.
        const validation = currentValidationPayload(panel);
        expect(validation.state).toBe('valid');
        expect(validation.issues).toEqual([
            expect.objectContaining({ severity: 'warning', message: 'tolerated with fallback' }),
        ]);
        panel.dispose();
    });

    it('a static rebuild finishing after a fast valid verdict refreshes the kept warnings', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        seedBundle(uri); // clean bundle → the rebuild yields no static warnings
        panel.show(uri);
        await new Promise(r => setTimeout(r, 30));

        // A previous render left a static warning behind…
        (panel as any).staticIssues = [
            { severity: 'warning', message: 'stale warning from previous render', origin: 'static' },
        ];
        (panel as any).staticTargets = [undefined];
        // …the user saves (flips to validating + starts the async rebuild), and
        // the verdict lands BEFORE the rebuild's file reads complete.
        mockState.onSaveHandler!({ uri });
        await panel.applyAnalysis(uri, { validation: { ok: true, errors: [] } } as any, uri);
        expect(currentValidationPayload(panel).issues).toEqual([
            expect.objectContaining({ message: 'stale warning from previous render' }),
        ]);

        await new Promise(r => setTimeout(r, 30));

        // The rebuild rebuilt the valid state's static portion: no warnings left.
        const validation = (panel as any).pendingData?.validation ?? currentValidationPayload(panel);
        expect(validation.state).toBe('valid');
        expect(validation.issues).toEqual([]);
        panel.dispose();
    });

    it('a static rebuild finishing after applySkipped refreshes the static tail behind the lead', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        seedBundle(uri); // clean bundle → the rebuild yields no static issues
        panel.show(uri);
        await new Promise(r => setTimeout(r, 30));

        (panel as any).staticIssues = [
            { severity: 'warning', message: 'stale static issue', origin: 'static' },
        ];
        (panel as any).staticTargets = [undefined];
        // The skip decision needs no CLI run, so it can land before the rebuild.
        mockState.onSaveHandler!({ uri });
        panel.applySkipped(uri, 'This file has errors reported by another extension.');
        expect(currentValidationPayload(panel).issues).toHaveLength(2);

        await new Promise(r => setTimeout(r, 30));

        // Lead issue kept, stale static tail dropped (fresh static is clean).
        const validation = (panel as any).pendingData?.validation ?? currentValidationPayload(panel);
        expect(validation.state).toBe('error');
        expect(validation.issues).toEqual([
            expect.objectContaining({ message: expect.stringContaining('another extension') }),
        ]);
        panel.dispose();
    });

    it('anchors unattributed errors on the analysis primary, not the shown helper', async () => {
        const crossFile = await import('../validation/crossFileDiagnostics');
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/helper.mthds');
        const primaryUri = makeUri('/project/methods/bundle.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        mockState.errorLocations = [
            { error: { category: 'dry_run', message: 'Dry run failed' }, uri: primaryUri, range },
        ];
        await panel.applyAnalysis(uri, invalidAnalysis(), primaryUri);

        // The resolver anchors on the analysis primary — where the Problems
        // panel also places source-less errors — never the shown helper.
        expect(vi.mocked(crossFile.resolveErrorLocations)).toHaveBeenLastCalledWith(
            expect.objectContaining({ primaryUri }),
        );
        // The owning-file label stays relative to the SHOWN file.
        const validation = currentValidationPayload(panel);
        expect(validation.issues[0].file).toBe('bundle.mthds');
        panel.dispose();
    });

    it("an older save's slower static rebuild cannot overwrite a newer one", async () => {
        const bundleGather = await import('../validation/bundleGather');
        const bundleWith = (code: string) => [
            'domain = "demo"',
            `main_pipe = "${code}"`,
            '',
            `[pipe.${code}]`,
            'type = "PipeLLM"',
            'description = "x"',
            'output = "Text"',
            'prompt = "p"',
            '',
        ].join('\n');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        seedBundle(uri);
        panel.show(uri);
        await new Promise(r => setTimeout(r, 30));
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });

        // Two rapid saves: the FIRST rebuild's file reads resolve LAST.
        let resolveOld!: (v: any) => void;
        let resolveNew!: (v: any) => void;
        vi.mocked(bundleGather.gatherBundleFiles)
            .mockImplementationOnce(() => new Promise(r => { resolveOld = r; }))
            .mockImplementationOnce(() => new Promise(r => { resolveNew = r; }));
        mockState.onSaveHandler!({ uri });
        mockState.onSaveHandler!({ uri });

        resolveNew([{ uri, name: 'main.mthds', content: bundleWith('new_pipe') }]);
        await new Promise(r => setTimeout(r, 10));
        resolveOld([{ uri, name: 'main.mthds', content: bundleWith('old_pipe') }]);
        await new Promise(r => setTimeout(r, 10));

        // Last graph on screen is the newer save's — the superseded rebuild bailed.
        const lastSetData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .filter((m: any) => m?.type === 'setData')
            .pop();
        expect(JSON.stringify(lastSetData.graphspec)).toContain('new_pipe');
        expect(JSON.stringify(lastSetData.graphspec)).not.toContain('old_pipe');
        panel.dispose();
    });

    it('applySkipped flips the widget to error with the skip reason', async () => {
        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/main.mthds');
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        panel.applySkipped(uri, 'This file has errors reported by another extension.');

        const validation = currentValidationPayload(panel);
        expect(validation.state).toBe('error');
        expect(validation.issues[0].message).toContain('another extension');
        // The graph HTML is untouched — no full-page notice since static-first.
        expect(mockState.mockWebview.html).not.toContain('Graph Unavailable');
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
        await panel.applyAnalysis(uri, invalidAnalysis(), uri);

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
        await panel.applyAnalysis(uri, invalidAnalysis(), uri);

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

    it('on save with validation enabled, rebuilds only the static graph and flips to validating', async () => {
        const processUtils = await import('../validation/processUtils');
        const uri = makeUri('/project/methods/main.mthds');
        seedBundle(uri);

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        // Complete the handshake so live messages flow.
        const messageHandler = mockState.mockWebview.onDidReceiveMessage.mock.calls[0][0];
        messageHandler({ type: 'webviewReady' });
        mockState.mockWebview.postMessage.mockClear();
        vi.mocked(processUtils.spawnCli).mockClear();

        // Save: the panel rebuilds the static graph immediately, but the analyze
        // call belongs to the on-save validator — the panel must NOT spawn.
        mockState.onSaveHandler!({ uri });
        await new Promise(r => setTimeout(r, 20));

        const setData = mockState.mockWebview.postMessage.mock.calls
            .map(c => c[0])
            .find((m: any) => m?.type === 'setData');
        expect(setData.graphspec.meta.mode).toBe('static');
        expect(setData.validation.state).toBe('validating');
        expect(processUtils.spawnCli).not.toHaveBeenCalled();
        panel.dispose();
    });

    it('graphspec-json views carry no validation payload (widget stays hidden)', async () => {
        const uri = makeUri('/project/run/graphspec.json');
        mockState.openTextDocuments = [{
            uri,
            getText: () => JSON.stringify({ meta: { format: 'mthds' }, nodes: [], edges: [] }),
        }];

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        panel.showGraphspecJson(uri);
        await new Promise(r => setTimeout(r, 20));

        const pending = (panel as any).pendingData;
        expect(pending.type).toBe('setData');
        expect(pending.sourceKind).toBe('graphspec-json');
        expect(pending.validation).toBeUndefined();
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

    it('onDidChangeActiveTextEditor reuses the current graph when switching files with the same graph primary', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/bundle.mthds');
        const helperUri = makeUri('/project/methods/helper.mthds');
        mockState.bundleFiles = [
            { uri, name: 'bundle.mthds', content: 'domain = "rec"\nmain_pipe = "main"\n[pipe.main]\n' },
            { uri: helperUri, name: 'helper.mthds', content: 'domain = "rec"\n[pipe.helper]\n' },
        ];
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        vi.mocked(processUtils.spawnCli).mockClear();
        const originalTitle = mockState.mockPanel.title;
        const editorChangeHandler = mockState.onEditorChangeHandler;
        expect(editorChangeHandler).not.toBeNull();

        await editorChangeHandler!({
            document: { languageId: 'mthds', uri: helperUri },
            viewColumn: 1,
        });

        expect(processUtils.spawnCli).not.toHaveBeenCalled();
        expect(originalTitle).toBe('Method Graph — bundle.mthds');
        expect(mockState.mockPanel.title).toBe('Method Graph — helper.mthds');
        expect((panel as any).currentUri.toString()).toBe(helperUri.toString());
        panel.dispose();
    });

    it('onDidChangeActiveTextEditor refreshes when a same-directory file has its own graph primary', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const uri = makeUri('/project/methods/bundle.mthds');
        const otherUri = makeUri('/project/methods/other.mthds');
        mockState.bundleFiles = [
            { uri, name: 'bundle.mthds', content: 'domain = "rec"\nmain_pipe = "main"\n[pipe.main]\n' },
            { uri: otherUri, name: 'other.mthds', content: 'domain = "rec"\nmain_pipe = "other"\n[pipe.other]\n' },
        ];
        panel.show(uri);
        await new Promise(r => setTimeout(r, 20));

        vi.mocked(processUtils.spawnCli).mockClear();
        const editorChangeHandler = mockState.onEditorChangeHandler;
        expect(editorChangeHandler).not.toBeNull();

        await editorChangeHandler!({
            document: { languageId: 'mthds', uri: otherUri },
            viewColumn: 1,
        });

        await vi.waitFor(() => {
            expect(processUtils.spawnCli).toHaveBeenCalled();
        });
        expect(mockState.mockPanel.title).toBe('Method Graph — other.mthds');
        panel.dispose();
    });

    it('onDidChangeActiveTextEditor switches from graphspec JSON to a same-directory mthds graph', async () => {
        const processUtils = await import('../validation/processUtils');

        const panel = new MethodGraphPanel(mockOutput(), makeExtensionUri());
        const jsonUri = makeUri('/project/methods/run.json');
        mockState.openTextDocuments = [
            {
                uri: jsonUri,
                getText: () => JSON.stringify({ meta: { format: 'mthds' }, nodes: [], edges: [] }),
            },
        ];
        panel.showGraphspecJson(jsonUri);
        await new Promise(r => setTimeout(r, 20));

        const mthdsUri = makeUri('/project/methods/bundle.mthds');
        mockState.bundleFiles = [
            { uri: mthdsUri, name: 'bundle.mthds', content: 'domain = "rec"\nmain_pipe = "main"\n[pipe.main]\n' },
        ];
        vi.mocked(processUtils.spawnCli).mockClear();
        const editorChangeHandler = mockState.onEditorChangeHandler;
        expect(editorChangeHandler).not.toBeNull();

        await editorChangeHandler!({
            document: { languageId: 'mthds', uri: mthdsUri },
            viewColumn: 1,
        });

        await vi.waitFor(() => {
            expect(processUtils.spawnCli).toHaveBeenCalled();
        });
        expect(mockState.mockPanel.title).toBe('Method Graph — bundle.mthds');
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
