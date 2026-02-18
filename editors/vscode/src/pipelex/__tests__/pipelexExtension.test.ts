import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const mockState = vi.hoisted(() => ({
    subscriptions: [] as any[],
    globalState: new Map<string, any>(),
    showWarningMessage: vi.fn(),
    registerCommand: vi.fn((_cmd: string, _handler: any) => ({ dispose: vi.fn() })),
    registerDocumentSemanticTokensProvider: vi.fn(() => ({ dispose: vi.fn() })),
    childProcessAvailable: true,
    validatorConstructed: false,
    graphPanelConstructed: false,
    importShouldFail: false,
}));

// ---------- Mocks ----------
vi.mock('vscode', () => ({
    ViewColumn: { One: 1, Beside: -2 },
    SemanticTokensLegend: class { constructor() {} },
    SemanticTokensBuilder: class { constructor() {} },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, def: any) => def,
        }),
        onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
        showWarningMessage: mockState.showWarningMessage,
        activeTextEditor: undefined,
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
    },
    commands: {
        registerCommand: mockState.registerCommand,
    },
    languages: {
        registerDocumentSemanticTokensProvider: mockState.registerDocumentSemanticTokensProvider,
    },
}));

vi.mock('../../util', () => ({
    getOutput: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
}));

vi.mock('../validation/pipelexValidator', () => {
    if (mockState.importShouldFail) {
        throw new Error('Simulated import failure');
    }
    return {
        PipelexValidator: class {
            constructor() { mockState.validatorConstructed = true; }
            dispose() {}
        },
    };
});

vi.mock('../graph/methodGraphPanel', () => {
    if (mockState.importShouldFail) {
        throw new Error('Simulated import failure');
    }
    return {
        MethodGraphPanel: class {
            constructor() { mockState.graphPanelConstructed = true; }
            show() {}
            dispose() {}
        },
    };
});

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
        mockState.validatorConstructed = false;
        mockState.graphPanelConstructed = false;
        mockState.importShouldFail = false;
        mockState.childProcessAvailable = true;
    });

    it('returns a promise that resolves after commands are registered', async () => {
        const context = makeContext();

        // Bug A: current code returns void (fire-and-forget async).
        // The function should return a promise so the caller can await it.
        const result = registerPipelexFeatures(context);

        // If the function is synchronous (returns void), the command
        // registration happens asynchronously and may not be done yet.
        // We need to await the result to ensure commands are registered.
        expect(result).toBeInstanceOf(Promise);
        await result;

        // After awaiting, the showMethodGraph command should be registered
        expect(mockState.registerCommand).toHaveBeenCalledWith(
            'pipelex.showMethodGraph',
            expect.any(Function)
        );
    });

    it('registers showMethodGraph command only after dynamic imports resolve', async () => {
        const context = makeContext();

        // Before calling, no command registered
        expect(mockState.registerCommand).not.toHaveBeenCalled();

        const result = registerPipelexFeatures(context);

        // The promise must be awaited to guarantee registration
        if (result instanceof Promise) {
            await result;
        }

        expect(mockState.registerCommand).toHaveBeenCalledWith(
            'pipelex.showMethodGraph',
            expect.any(Function)
        );
    });
});
