/**
 * Pure utility functions for detecting and parsing GraphSpec JSON files.
 * A valid GraphSpec JSON has `meta.format === "mthds"` at the top level.
 */

export function isGraphspecJson(content: string): boolean {
    try {
        const obj = JSON.parse(content);
        return obj?.meta?.format === 'mthds';
    } catch {
        return false;
    }
}

export function parseGraphspecFile(content: string): Record<string, unknown> | null {
    try {
        const obj = JSON.parse(content);
        if (
            obj?.meta?.format === 'mthds'
            && Array.isArray(obj.nodes)
            && Array.isArray(obj.edges)
        ) {
            return obj;
        }
        return null;
    } catch {
        return null;
    }
}
