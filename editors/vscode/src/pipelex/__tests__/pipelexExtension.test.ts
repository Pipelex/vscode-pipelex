import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const mockState = vi.hoisted(() => ({
    subscriptions: [] as any[],
    globalState: new Map<string, any>(),
    config: {} as Record<string, any>,
    showWarningMessage: vi.fn(),
    registerCommand: vi.fn((_cmd: string, _handler: any) => ({ dispose: vi.fn() })),
    registerDocumentSemanticTokensProvider: vi.fn(() => ({ dispose: vi.fn() })),
    childProcessAvailable: true,
    validatorConstructed: false,
    graphPanelConstructed: false,
    pipeTestProviderConstructed: false,
}));

// ---------- Mocks ----------
vi.mock('vscode', () => ({
    ViewColumn: { One: 1, Beside: -2 },
    SemanticTokensLegend: class { constructor() {} },
    SemanticTokensBuilder: class { constructor() {} },
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: (key: string, def: any) => (key in mockState.config ? mockState.config[key] : def),
        })),
        onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
        showWarningMessage: mockState.showWarningMessage,
        showInformationMessage: vi.fn(),
        activeTextEditor: undefined,
        visibleTextEditors: [],
        activeColorTheme: { kind: 2 },
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
        registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
        registerCommand: mockState.registerCommand,
        executeCommand: vi.fn(),
    },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    languages: {
        registerDocumentSemanticTokensProvider: mockState.registerDocumentSemanticTokensProvider,
    },
}));

vi.mock('../../util', () => ({
    getOutput: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
}));

vi.mock('../validation/pipelexValidator', () => {
    return {
        PipelexValidator: class {
            constructor() { mockState.validatorConstructed = true; }
            setGraphSink() {}
            dispose() {}
        },
    };
});

vi.mock('../terminalRunner', () => ({
    runInTerminal: vi.fn(),
}));

vi.mock('../pipeTestProvider', () => {
    return {
        PipeTestProvider: class {
            constructor() { mockState.pipeTestProviderConstructed = true; }
            dispose() {}
        },
    };
});

vi.mock('../graph/methodGraphPanel', () => {
    return {
        MethodGraphPanel: class {
            constructor() { mockState.graphPanelConstructed = true; }
            show() {}
            showGraphspecJson() {}
            restoreGraphspecJson() {}
            dispose() {}
        },
    };
});

vi.mock('../graph/graphspecDetector', () => ({
    isGraphspecJson: vi.fn(() => false),
}));

// ---------- Import SUT ----------
import { registerPipelexFeatures } from '../pipelexExtension';

function makeContext() {
    mockState.subscriptions = [];
    return {
        subscriptions: mockState.subscriptions,
        globalState: {
            get: (key: string) => mockState.globalState.get(key),
            update: (key: string, val: any) => { mockState.globalState.set(key, val); return Promise.resolve(); },
        },
    } as any;
}

describe('registerPipelexFeatures', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.subscriptions = [];
        mockState.globalState.clear();
        mockState.config = {};
        mockState.validatorConstructed = false;
        mockState.graphPanelConstructed = false;
        mockState.pipeTestProviderConstructed = false;
        mockState.childProcessAvailable = true;
    });

    it('returns a promise that resolves after commands are registered', async () => {
        const context = makeContext();

        const result = registerPipelexFeatures(context);

        expect(result).toBeInstanceOf(Promise);
        await result;

        expect(mockState.registerCommand).toHaveBeenCalledWith(
            'pipelex.showMethodGraph',
            expect.any(Function)
        );
    });

    it('registers showMethodGraph command only after dynamic imports resolve', async () => {
        const context = makeContext();

        expect(mockState.registerCommand).not.toHaveBeenCalled();

        const result = registerPipelexFeatures(context);

        if (result instanceof Promise) {
            await result;
        }

        expect(mockState.registerCommand).toHaveBeenCalledWith(
            'pipelex.showMethodGraph',
            expect.any(Function)
        );
    });

    it('instantiates PipeTestProvider during registration', async () => {
        const context = makeContext();
        await registerPipelexFeatures(context);

        expect(mockState.pipeTestProviderConstructed).toBe(true);
    });

    it('registers the validator even when validation is disabled at activation', async () => {
        // The graph panel reads `validation.enabled` live and suppresses its own
        // refresh when it is on, so a validator must always exist to drive analysis —
        // even if the setting was off at activation and is enabled later without a reload.
        mockState.config['validation.enabled'] = false;
        const context = makeContext();
        await registerPipelexFeatures(context);

        expect(mockState.validatorConstructed).toBe(true);
    });
});
