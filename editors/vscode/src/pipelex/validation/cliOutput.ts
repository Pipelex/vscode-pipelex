/**
 * Extract the first JSON object from `pipelex-agent` output, skipping `WARNING:`
 * lines that the CLI may emit before the JSON payload.
 *
 * Kept in its own module (not `processUtils`, not `pipelexValidator`) so the CLI
 * backend can parse output without dragging in the spawn/vscode surface that
 * tests mock around those modules.
 */
export function extractJson(output: string): string | null {
    // Strip WARNING lines that may contain braces
    const lines = output.split('\n');
    const filtered = lines.filter(l => !l.trimStart().startsWith('WARNING:')).join('\n');
    const idx = filtered.indexOf('{');
    if (idx === -1) return null;
    const lastIdx = filtered.lastIndexOf('}');
    if (lastIdx === -1) return null;
    return filtered.slice(idx, lastIdx + 1);
}
