import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read the real package.json (resolved from this file, so it is cwd-independent
// and unaffected by the `fs` mock in graphConfig.test.ts). A JSON `import` would
// trip the typecheck's `rootDir: "src"` + no `resolveJsonModule`, so read at
// runtime instead.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const props: Record<string, { scope?: string }> = pkg.contributes.configuration.properties;

// The contributed `scope` of each graph setting must match HOW it is read:
//
//   - `resolveGraphConfig` (graph/graphConfig.ts) reads toolbarPosition / edgeType
//     / theme through `getConfiguration('pipelex')` with NO resource URI — they
//     blend with the machine-level ~/.pipelex/pipelex.toml, so they are
//     window-level concerns. An unscoped read cannot see a folder value, so these
//     MUST be `window`-scoped: declaring `resource` would advertise a per-folder
//     override the reader silently ignores (the bug this test guards against).
//
//   - direction / showControllers / foldMode are read WITH the URI
//     (`getConfiguration('pipelex', uri)` in methodGraphPanel) and legitimately
//     stay `resource`-scoped.
describe('contributed graph-setting scopes match how each is read', () => {
    it.each(['graph.toolbarPosition', 'graph.edgeType', 'graph.theme'])(
        'pipelex.%s is window-scoped (read unscoped via resolveGraphConfig)',
        key => {
            expect(props[`pipelex.${key}`].scope).toBe('window');
        },
    );

    it.each(['graph.direction', 'graph.showControllers', 'graph.foldMode'])(
        'pipelex.%s stays resource-scoped (read with a resource URI)',
        key => {
            expect(props[`pipelex.${key}`].scope).toBe('resource');
        },
    );
});
