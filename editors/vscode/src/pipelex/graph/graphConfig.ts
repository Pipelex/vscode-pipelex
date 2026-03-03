import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseToml } from 'smol-toml';

export interface GraphRenderConfig {
    edgeType: string;
    nodesep: number;
    ranksep: number;
    initialZoom: number | undefined;
    panToTop: boolean;
    theme: string;
    palette: string;
}

const DEFAULTS: GraphRenderConfig = {
    edgeType: 'bezier',
    nodesep: 50,
    ranksep: 30,
    initialZoom: undefined,
    panToTop: true,
    theme: 'dark',
    palette: 'dracula',
};

const PALETTE_COLORS: Record<string, Record<string, string>> = {
    dracula: {
        '--color-pipe': '#ff6b6b',
        '--color-pipe-bg': 'rgba(224,108,117,0.18)',
        '--color-pipe-text': '#ffffff',
        '--color-stuff': '#4ECDC4',
        '--color-stuff-bg': 'rgba(78,205,196,0.12)',
        '--color-stuff-border': '#9ddcfd',
        '--color-stuff-text': '#98FB98',
        '--color-stuff-text-dim': '#9ddcfd',
        '--color-edge': '#FFFACD',
        '--color-batch-item': '#bd93f9',
        '--color-batch-aggregate': '#50fa7b',
        '--color-parallel-combine': '#d6a4ff',
        '--color-success': '#50FA7B',
        '--color-success-bg': 'rgba(80,250,123,0.15)',
        '--color-error': '#FF5555',
        '--color-error-bg': 'rgba(255,85,85,0.15)',
        '--color-accent': '#8BE9FD',
        '--color-warning': '#FFB86C',
    },
    // yellow_blue uses CSS defaults — no overrides needed
};

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
        if (typeof rf.style?.theme === 'string') result.theme = rf.style.theme;
        if (typeof rf.style?.palette === 'string') result.palette = rf.style.palette;
        return result;
    } catch {
        vscode.window.showWarningMessage(
            'Pipelex graph: failed to parse ~/.pipelex/pipelex.toml. Check for syntax errors.'
        );
        return {};
    }
}

export async function resolveGraphConfig(): Promise<GraphRenderConfig> {
    const fromToml = await readPipelexToml();
    const merged: GraphRenderConfig = { ...DEFAULTS, ...fromToml };

    // VS Code settings override (only when explicitly set)
    const cfg = vscode.workspace.getConfiguration('pipelex');
    const edgeType = cfg.get<string>('graph.edgeType');
    const palette = cfg.get<string>('graph.palette');

    if (edgeType) merged.edgeType = edgeType;
    if (palette) merged.palette = palette;

    return merged;
}

export function getPaletteColors(palette: string): Record<string, string> {
    return PALETTE_COLORS[palette] || {};
}
