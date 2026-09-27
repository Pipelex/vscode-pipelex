import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

/**
 * The webview shell must define every shadcn token the form kernel's shipped
 * stylesheet reads, because an undefined one fails silently.
 *
 * Since kernel 0.9.0 the sheet reads every token with a fallback holding the
 * kernel's LIGHT palette — `background-color: var(--primary, #18181b)`. A token
 * nobody defines therefore paints light whatever the graph's theme: the build
 * stays green, nothing is discarded, and one control in a dark panel turns
 * white. (Under kernel 0.8.0 the same omission painted it transparent.) Nothing
 * in a type-check, a lint or a unit test would notice.
 *
 * So this test derives the requirement from the kernel's own shipped bytes
 * rather than from a list someone remembered to update. A kernel upgrade that
 * reaches for a token the shell does not define fails here, naming it.
 */

const VSCODE_ROOT = path.resolve(__dirname, '../../..');
const NODE_MODULES = path.join(VSCODE_ROOT, 'node_modules');
const SHELL_CSS = path.join(VSCODE_ROOT, 'src/pipelex/graph/webview/shell.css');
const ADAPTER = path.join(VSCODE_ROOT, 'src/pipelex/graph/webview/adapter.ts');

/** The specifier the webview entry imports to load the kernel's sheet. */
const KERNEL_ENTRY_SPECIFIER = '@pipelex/mthds-ui/form-kernel.css';

/**
 * The kernel sheet the webview actually loads, found the way the bundle finds
 * it: resolve the adapter's import through mthds-ui's `exports` map, then follow
 * that file's own `@import` into `@pipelex/mthds-form`. A hardcoded path into
 * the kernel's `dist/` would keep passing against a sheet the webview had
 * stopped loading.
 */
function kernelStylesPath(): string {
    const requireFromExtension = createRequire(path.join(VSCODE_ROOT, 'package.json'));
    const entry = requireFromExtension.resolve(KERNEL_ENTRY_SPECIFIER);
    const imported = /@import\s+["']([^"']+)["']/.exec(fs.readFileSync(entry, 'utf-8'));
    if (!imported) {
        throw new Error(`${KERNEL_ENTRY_SPECIFIER} (${entry}) no longer @imports the kernel sheet`);
    }
    return createRequire(entry).resolve(imported[1]);
}

/**
 * The renderer's own sheets, which reach the same bundle from `graph/react`'s
 * import graph. Anything they define is already covered and is not the shell's
 * to supply.
 */
const RENDERER_STYLES = [
    '@pipelex/mthds-ui/dist/graph/react/graph-core.css',
    '@pipelex/mthds-ui/dist/graph/react/detail/DetailPanel.css',
    '@pipelex/mthds-ui/dist/graph/react/viewer/GraphToolbar.css',
].map(p => path.join(NODE_MODULES, p));

/**
 * Set at runtime by Radix on its own elements, never by a stylesheet. Reading
 * one the host has not defined is correct and expected.
 */
const RUNTIME_TOKEN = /^--radix-/;

/**
 * Tailwind's own internals: per-utility state (`--tw-*`) and the preflight's
 * font-feature hooks (`--default-*`), read with the fallback Tailwind designed
 * as their value. No host defines them, and none should.
 */
const TAILWIND_INTERNAL = /^--(tw|default)-/;

/**
 * Every custom property the sheet reads, with a fallback or without. A missing
 * one fails silently either way — transparent without a fallback, the kernel's
 * light palette with one — so the fallback is no excuse.
 */
function tokensRead(css: string): Set<string> {
    return new Set(
        [...css.matchAll(/var\((--[a-zA-Z0-9-]+)\s*[,)]/g)].map(m => m[1]),
    );
}

/** Every custom property the sheet itself declares. */
function tokensDefined(css: string): Set<string> {
    return new Set(
        [...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]),
    );
}

describe('the form kernel token map in shell.css', () => {
    it('the webview entry imports the kernel sheet the token map is held to', () => {
        // mthds-ui stopped injecting the kernel's sheet in 0.25.0; without this
        // import the detail panel's controls render unstyled and the rest of
        // this suite would be checking a sheet nothing loads.
        const adapter = fs.readFileSync(ADAPTER, 'utf-8');
        expect(adapter).toContain(`import '${KERNEL_ENTRY_SPECIFIER}';`);
    });

    it('defines every token the kernel reads that nothing else in the bundle supplies', () => {
        const kernelCss = fs.readFileSync(kernelStylesPath(), 'utf-8');
        const shellCss = fs.readFileSync(SHELL_CSS, 'utf-8');

        const required = tokensRead(kernelCss);

        // Whatever the bundle already defines for itself — the kernel's own
        // Tailwind theme block (`--spacing`, `--text-sm`, `--font-sans`, the
        // `--tw-*` internals) plus the renderer's palette — is not the shell's
        // to supply.
        const supplied = tokensDefined(kernelCss);
        for (const file of RENDERER_STYLES) {
            for (const token of tokensDefined(fs.readFileSync(file, 'utf-8'))) {
                supplied.add(token);
            }
        }

        const mustBeInShell = [...required]
            .filter(t => !supplied.has(t) && !RUNTIME_TOKEN.test(t) && !TAILWIND_INTERNAL.test(t))
            .sort();

        // If this is empty the test has stopped testing anything — most likely
        // because a regex above no longer matches the shipped bytes.
        expect(mustBeInShell.length).toBeGreaterThan(0);

        const defined = tokensDefined(shellCss);
        expect([...mustBeInShell].filter(t => !defined.has(t))).toEqual([]);
    });

    it('scopes the token map to the graph container, so it follows the in-graph theme', () => {
        const shellCss = fs.readFileSync(SHELL_CSS, 'utf-8');

        // GraphViewer applies its resolved palette as inline styles on
        // `.react-flow-container`. Defining the kernel's tokens on that same
        // element is what makes them re-resolve when the in-graph toggle flips;
        // hoisting them to `:root` or `body` would pin the panel to one theme
        // (and be shadowed anyway, since graph-core.css redefines the palette
        // names on the container).
        const block = /\.react-flow-container\s*\{([^}]*)\}/.exec(shellCss);
        expect(block, 'shell.css defines no .react-flow-container block').not.toBeNull();

        const tokens = tokensDefined(block![1]);
        expect(tokens.has('--background')).toBe(true);
        expect(tokens.has('--foreground')).toBe(true);
    });

    it('maps every colour token onto the graph palette, never onto a VS Code theme colour', () => {
        const shellCss = fs.readFileSync(SHELL_CSS, 'utf-8');
        const block = /\.react-flow-container\s*\{([^}]*)\}/.exec(shellCss)![1];

        // A `--vscode-*` colour tracks the EDITOR's theme, which cannot see the
        // in-graph light/dark toggle — the panel would then disagree with the
        // graph it sits in whenever the two are pinned differently.
        expect(block).not.toContain('--vscode-');

        // Each declaration is either a graph palette `var()` or a plain length
        // (`--radius`). A literal colour would not follow the toggle either.
        for (const [, name, value] of block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
            if (name === '--radius') continue;
            expect(value.trim(), `${name} should read the graph palette`).toMatch(/^var\(--[a-z-]+\)$/);
        }
    });
});
