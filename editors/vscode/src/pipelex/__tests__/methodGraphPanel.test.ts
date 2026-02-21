import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const mockState = vi.hoisted(() => {
    const mockWebview = { html: '' };
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
        readFileResult: '<html>graph</html>',
        readFileResolve: null as ((v: any) => void) | null,
        showWarningMessage: vi.fn(),
        executeCommand: vi.fn(),
        cancelAllInflightSpy: vi.fn(),
        // Event handler captures
        onSaveHandler: null as ((doc: any) => void) | null,
        onEditorChangeHandler: null as ((editor: any) => void) | null,
    };
});

// ---------- Mocks ----------
vi.mock('vscode', () => ({
    ViewColumn: { One: 1, Beside: -2 },
    workspace: {
        getConfiguration: () => ({ get: (_key: string, def: any) => def }),
        onDidSaveTextDocument: vi.fn((handler: any) => {
            mockState.onSaveHandler = handler;
            return { dispose: vi.fn() };
        }),
        getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
    },
    window: {
        createWebviewPanel: vi.fn((_id: string, title: string) => {
            mockState.mockPanel.title = title;
            return mockState.mockPanel;
        }),
        showWarningMessage: mockState.showWarningMessage,
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
        promises: {
            readFile: vi.fn((..._args: any[]) => {
                if (mockState.readFileResolve) {
                    return new Promise((resolve) => {
                        mockState.readFileResolve = resolve;
                    });
                }
                return Promise.resolve(mockState.readFileResult);
            }),
        },
    },
    promises: {
        readFile: vi.fn((..._args: any[]) => {
            if (mockState.readFileResolve) {
                return new Promise((resolve) => {
                    mockState.readFileResolve = resolve;
                });
            }
            return Promise.resolve(mockState.readFileResult);
        }),
    },
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

describe('MethodGraphPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.mockWebview.html = '';
        mockState.mockPanel.title = '';
        mockState.mockPanel.viewColumn = 2;
        mockState.resolveCliResult = { command: 'pipelex-agent', args: [] };
        mockState.spawnCliResult = {
            stdout: JSON.stringify({ graph_files: { reactflow_html: '/tmp/graph.html' } }),
            stderr: '',
        };
        mockState.spawnCliResolve = null;
        mockState.spawnCliReject = null;
        mockState.readFileResult = '<html>graph</html>';
        mockState.readFileResolve = null;
        mockState.onSaveHandler = null;
        mockState.onEditorChangeHandler = null;
    });

    // --- Bug B: Filename extraction ---

    it('show() extracts filename correctly from unix paths', () => {
        const panel = new MethodGraphPanel(mockOutput());
        const uri = makeUri('/home/user/project/bundle.mthds');

        panel.show(uri);

        // show() sets the title synchronously before refresh()
        expect(mockState.mockPanel.title).toBe('Method Graph — bundle.mthds');
        panel.dispose();
    });

    it('show() extracts filename correctly from Windows backslash paths', () => {
        const panel = new MethodGraphPanel(mockOutput());
        const uri = makeUri('C:\\Users\\dev\\project\\bar.mthds');

        panel.show(uri);

        // Bug B: current code uses split('/') which won't split backslashes
        // The title should be "Method Graph — bar.mthds", not the full path
        expect(mockState.mockPanel.title).toBe('Method Graph — bar.mthds');
        panel.dispose();
    });

    // --- Bug C: Staleness after readFile ---

    it('refresh() discards readFile result when file switched during read', async () => {
        // Use deferred readFile so we can switch files while it's pending
        let readFileResolve: ((v: string) => void) | null = null;
        const fs = await import('fs');
        vi.mocked(fs.promises.readFile).mockImplementation(() => {
            return new Promise<string>((resolve) => {
                readFileResolve = resolve as (v: string) => void;
            }) as any;
        });

        const panel = new MethodGraphPanel(mockOutput());
        const uri1 = makeUri('/project/file1.mthds');
        panel.show(uri1);

        // Wait for spawnCli to resolve and readFile to be called
        await vi.waitFor(() => {
            expect(readFileResolve).not.toBeNull();
        });

        // Simulate user switching to a different file
        const uri2 = makeUri('/project/file2.mthds');
        (panel as any).currentUri = uri2;

        // Now resolve readFile with stale content
        readFileResolve!('<html>stale graph for file1</html>');
        await new Promise(r => setTimeout(r, 10));

        // Bug C: The stale content should NOT be set on the webview
        expect(mockState.mockWebview.html).not.toContain('stale graph for file1');

        panel.dispose();
    });

    // --- Regression: staleness after spawnCli (previous Bug 1) ---

    it('refresh() discards spawnCli result when file switched during spawn', async () => {
        // Set readFileResult to contain 'stale' so that if the staleness guard
        // were removed, the webview would contain 'stale' and this test would fail.
        mockState.readFileResult = '<html>stale content from old file</html>';

        let resolveSpawn: ((v: any) => void) | null = null;
        const processUtils = await import('../validation/processUtils');
        vi.mocked(processUtils.spawnCli).mockImplementation(() => {
            return new Promise((resolve) => {
                resolveSpawn = resolve;
            });
        });

        const panel = new MethodGraphPanel(mockOutput());
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
            stdout: JSON.stringify({ graph_files: { reactflow_html: '/tmp/stale.html' } }),
            stderr: '',
        });
        await new Promise(r => setTimeout(r, 10));

        // readFile would return 'stale content' but the staleness check
        // after spawnCli should prevent it from being set on the webview.
        expect(mockState.mockWebview.html).not.toContain('stale');

        panel.dispose();
    });

    // --- Regression: cancel all inflight (previous Bug 1) ---

    it('refresh() cancels all inflight jobs at start of refresh', async () => {
        const panel = new MethodGraphPanel(mockOutput());
        const uri = makeUri('/project/file.mthds');

        panel.show(uri);
        await new Promise(r => setTimeout(r, 10));

        expect(mockState.cancelAllInflightSpy).toHaveBeenCalled();
        panel.dispose();
    });

    // --- Regression: CLI warning (previous Bug 6) ---

    it('refresh() shows warning message when CLI not found', async () => {
        mockState.resolveCliResult = null;

        const panel = new MethodGraphPanel(mockOutput());
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
        const panel = new MethodGraphPanel(mockOutput());
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
