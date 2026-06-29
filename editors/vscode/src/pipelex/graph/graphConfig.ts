import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseToml } from 'smol-toml';

/** Resolved binary color theme understood by the mthds-ui GraphViewer. */
export type GraphTheme = 'dark' | 'light';

/**
 * Theme *mode* sent to the renderer. `'system'` follows the active VS Code
 * color theme (via the injected {@link GraphRenderConfig.systemTheme});
 * `'dark'`/`'light'` pin a fixed appearance.
 */
export type GraphThemeMode = 'dark' | 'light' | 'system';

/**
 * Anchor for the GraphViewer's built-in floating toolbar — passed straight to
 * the renderer's `config.toolbarPosition`. Mirrors mthds-ui's `ToolbarPosition`
 * union (and matches ReactFlow's `PanelPosition`). Defined locally so the
 * extension host doesn't import the webview-only `@pipelex/mthds-ui` package —
 * same reason {@link GraphTheme}/{@link GraphThemeMode} are local.
 */
export type GraphToolbarPosition =
    | 'top-left' | 'top-center' | 'top-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right'
    | 'center-left' | 'center-right';

const TOOLBAR_POSITIONS: readonly GraphToolbarPosition[] = [
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
    'center-left', 'center-right',
];

function isToolbarPosition(value: unknown): value is GraphToolbarPosition {
    return typeof value === 'string' && (TOOLBAR_POSITIONS as readonly string[]).includes(value);
}

export interface GraphRenderConfig {
    edgeType: string;
    nodesep: number;
    ranksep: number;
    initialZoom: number | undefined;
    panToTop: boolean;
    /** Theme mode. `'system'` (the default) tracks the editor via {@link systemTheme}. */
    theme: GraphThemeMode;
    /**
     * The active editor's resolved binary theme. Injected into the renderer's
     * `'system'` mode so it flips deterministically — the webview's own
     * `prefers-color-scheme` is unreliable — and re-sent on every editor theme
     * switch (see methodGraphPanel.onColorThemeChanged).
     */
    systemTheme: GraphTheme;
    /**
     * Anchor for the GraphViewer's built-in floating toolbar. Defaults to
     * `'top-right'` (the mthds-ui default); pinned by the
     * `pipelex.graph.toolbarPosition` setting.
     */
    toolbarPosition: GraphToolbarPosition;
}

const DEFAULTS: Omit<GraphRenderConfig, 'theme' | 'systemTheme'> = {
    edgeType: 'bezier',
    nodesep: 50,
    ranksep: 30,
    initialZoom: undefined,
    panToTop: true,
    toolbarPosition: 'top-right',
};

function isGraphTheme(value: unknown): value is GraphTheme {
    return value === 'dark' || value === 'light';
}

/**
 * Map VS Code's active color theme to the graph's binary light/dark theme so
 * the graph opens matching the editor. Guards against `ColorThemeKind` being
 * absent (e.g. under unit-test mocks), defaulting to dark.
 */
export function activeEditorGraphTheme(): GraphTheme {
    const Kind = vscode.ColorThemeKind;
    const kind = vscode.window.activeColorTheme?.kind;
    if (Kind && (kind === Kind.Light || kind === Kind.HighContrastLight)) {
        return 'light';
    }
    return 'dark';
}

async function readPipelexToml(): Promise<Partial<GraphRenderConfig>> {
    const tomlPath = path.join(os.homedir(), '.pipelex', 'pipelex.toml');
    let content: string;
    try {
        content = await fs.promises.readFile(tomlPath, 'utf-8');
    } catch {
        return {};
    }

    try {
        const doc = parseToml(content) as any;
        const rf = doc?.pipelex?.pipeline_execution_config?.graph_config?.reactflow_config;
        if (!rf) return {};

        const result: Partial<GraphRenderConfig> = {};
        if (typeof rf.edge_type === 'string') result.edgeType = rf.edge_type;
        if (typeof rf.nodesep === 'number') result.nodesep = rf.nodesep;
        if (typeof rf.ranksep === 'number') result.ranksep = rf.ranksep;
        if (typeof rf.initial_zoom === 'number') result.initialZoom = rf.initial_zoom;
        if (typeof rf.pan_to_top === 'boolean') result.panToTop = rf.pan_to_top;
        if (isGraphTheme(rf.style?.theme)) result.theme = rf.style.theme;
        return result;
    } catch {
        vscode.window.showWarningMessage(
            'Pipelex graph: failed to parse ~/.pipelex/pipelex.toml. Check for syntax errors.'
        );
        return {};
    }
}

/**
 * Resolve the graph render config from (lowest→highest priority):
 *   default `system` mode → ~/.pipelex/pipelex.toml → VS Code settings.
 *
 * The theme mode defaults to `'system'`, which follows the active editor via
 * the injected `systemTheme`. A `pipelex.toml` `style.theme`, or the
 * `pipelex.graph.theme` setting when pinned to `dark`/`light` (i.e. not
 * `auto`), pins it instead. The renderer derives its full palette from the
 * resolved theme — the host must NOT send a `paletteColors` override, or it
 * would shadow the renderer's light/dark palette (see
 * methodGraphPanel.sendGraphspecToWebview).
 */
export async function resolveGraphConfig(): Promise<GraphRenderConfig> {
    const fromToml = await readPipelexToml();
    const merged: GraphRenderConfig = {
        ...DEFAULTS,
        theme: 'system',
        systemTheme: activeEditorGraphTheme(),
        ...fromToml,
    };

    // VS Code settings override (only when explicitly set)
    const cfg = vscode.workspace.getConfiguration('pipelex');
    const edgeType = cfg.get<string>('graph.edgeType');
    if (edgeType) merged.edgeType = edgeType;

    // `pipelex.graph.toolbarPosition` pins the toolbar anchor. pipelex.toml has no
    // toolbar key, so this is the only source; the guard ignores a malformed value
    // and falls back to the `'top-right'` default.
    const toolbarPosition = cfg.get<string>('graph.toolbarPosition');
    if (isToolbarPosition(toolbarPosition)) merged.toolbarPosition = toolbarPosition;

    // `pipelex.graph.theme`: `auto` follows the editor (`system` mode);
    // `dark`/`light` pin it. Inspect rather than `get` so the contributed
    // `auto` default does NOT clobber a `pipelex.toml` `style.theme` pin —
    // only an *explicitly set* value (user/workspace/folder) overrides the toml.
    const themeInspect = cfg.inspect<string>('graph.theme');
    const theme = themeInspect?.workspaceFolderValue ?? themeInspect?.workspaceValue ?? themeInspect?.globalValue;
    if (theme === 'auto') {
        merged.theme = 'system';
    } else if (isGraphTheme(theme)) {
        merged.theme = theme;
    }

    return merged;
}
