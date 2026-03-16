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
        // Event handler captures
        onSaveHandler: null as ((doc: any) => void) | null,
        onEditorChangeHandler: null as ((editor: any) => void) | null,
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
    },
    Selection: vi.fn(),
    TextEditorRevealType: { InCenter: 2 },
    workspace: {
        getConfiguration: () => ({ get: (key: string, def: any) => mockState.configOverrides[key] ?? def }),
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

// ---------- Import SUT after mocks ----------
import { MethodGraphPanel } from '../graph/methodGraphPanel';

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
        mockState.configOverrides = {};
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
});
