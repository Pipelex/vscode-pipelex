import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tunable stand-ins for the filesystem (~/.pipelex/pipelex.toml), the VS Code
// `pipelex.graph.theme` setting, and the active editor theme.
const state = vi.hoisted(() => ({
    tomlContent: undefined as string | undefined, // undefined → readFile rejects (no file)
    themeInspect: { defaultValue: 'auto' } as Record<string, unknown>,
    activeKind: 2, // ColorThemeKind.Dark
    // `pipelex.graph.toolbarPosition` setting value (undefined → not set).
    toolbarPosition: undefined as string | undefined,
    // `pipelex.graph.style` setting value (undefined → not set).
    graphStyle: undefined as string | undefined,
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
            get: (key: string) => (key === 'graph.toolbarPosition'
                ? state.toolbarPosition
                : key === 'graph.style' ? state.graphStyle : undefined),
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
        state.toolbarPosition = undefined;
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

describe('resolveGraphConfig toolbar position', () => {
    beforeEach(() => {
        state.tomlContent = undefined;
        state.themeInspect = { defaultValue: 'auto' };
        state.activeKind = 2;
        state.toolbarPosition = undefined;
    });

    it('defaults to top-right when the setting is unset', async () => {
        const cfg = await resolveGraphConfig();
        expect(cfg.toolbarPosition).toBe('top-right');
    });

    it('honors a valid toolbarPosition setting', async () => {
        state.toolbarPosition = 'center-left';
        const cfg = await resolveGraphConfig();
        expect(cfg.toolbarPosition).toBe('center-left');
    });

    it('ignores a malformed toolbarPosition value, keeping the default', async () => {
        state.toolbarPosition = 'middle-of-nowhere';
        const cfg = await resolveGraphConfig();
        expect(cfg.toolbarPosition).toBe('top-right');
    });
});

describe('resolveGraphConfig graph style', () => {
    beforeEach(() => {
        state.tomlContent = undefined;
        state.themeInspect = { defaultValue: 'auto' };
        state.activeKind = 2;
        state.toolbarPosition = undefined;
        state.graphStyle = undefined;
    });

    it('defaults to detailed, the drawing every graph had before styles', async () => {
        const cfg = await resolveGraphConfig();
        expect(cfg.graphStyle).toBe('detailed');
    });

    it('honors a pipelex.graph.style setting naming a known style', async () => {
        state.graphStyle = 'simple';
        const cfg = await resolveGraphConfig();
        expect(cfg.graphStyle).toBe('simple');
    });

    // A settings.json shared with a newer extension may name a style this one
    // does not know; relaying it would hand the renderer an id it treats as
    // unset anyway, so the host settles it to the default itself.
    it('falls back to detailed for a style this extension does not know', async () => {
        state.graphStyle = 'swimlanes';
        const cfg = await resolveGraphConfig();
        expect(cfg.graphStyle).toBe('detailed');
    });
});
