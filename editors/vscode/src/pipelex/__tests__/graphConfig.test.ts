import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tunable stand-ins for the filesystem (~/.pipelex/pipelex.toml), the VS Code
// `pipelex.graph.theme` setting, and the active editor theme.
const state = vi.hoisted(() => ({
    tomlContent: undefined as string | undefined, // undefined → readFile rejects (no file)
    themeInspect: { defaultValue: 'auto' } as Record<string, unknown>,
    activeKind: 2, // ColorThemeKind.Dark
}));

vi.mock('fs', () => ({
    promises: {
        readFile: vi.fn(async () => {
            if (state.tomlContent === undefined) {
                throw new Error('ENOENT');
            }
            return state.tomlContent;
        }),
    },
}));

vi.mock('vscode', () => ({
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
        get activeColorTheme() {
            return { kind: state.activeKind };
        },
        showWarningMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: (_key: string) => undefined,
            inspect: (key: string) => (key === 'graph.theme' ? state.themeInspect : undefined),
        })),
    },
}));

import { resolveGraphConfig } from '../graph/graphConfig';

const DARK_TOML = `
[pipelex.pipeline_execution_config.graph_config.reactflow_config.style]
theme = "dark"
`;

describe('resolveGraphConfig theme priority', () => {
    beforeEach(() => {
        state.tomlContent = undefined;
        state.themeInspect = { defaultValue: 'auto' };
        state.activeKind = 2;
    });

    it('honors a pipelex.toml theme pin when graph.theme is not explicitly set', async () => {
        state.tomlContent = DARK_TOML;
        state.themeInspect = { defaultValue: 'auto' }; // contributed default only
        state.activeKind = 1; // Light editor — proves the toml pin (dark) wins over the editor
        const cfg = await resolveGraphConfig();
        expect(cfg.theme).toBe('dark');
    });

    it('lets an explicit graph.theme setting override the toml pin', async () => {
        state.tomlContent = DARK_TOML;
        state.themeInspect = { defaultValue: 'auto', globalValue: 'light' };
        const cfg = await resolveGraphConfig();
        expect(cfg.theme).toBe('light');
    });

    it('treats an explicit `auto` setting as system mode, overriding the toml pin', async () => {
        state.tomlContent = DARK_TOML;
        state.themeInspect = { defaultValue: 'auto', globalValue: 'auto' };
        const cfg = await resolveGraphConfig();
        expect(cfg.theme).toBe('system');
    });

    it('defaults to system mode with systemTheme following the editor', async () => {
        state.tomlContent = undefined; // no toml
        state.themeInspect = { defaultValue: 'auto' };
        state.activeKind = 1; // Light
        const cfg = await resolveGraphConfig();
        expect(cfg.theme).toBe('system');
        expect(cfg.systemTheme).toBe('light');
    });
});
