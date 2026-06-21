import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stateful stand-in for the user's global `editor.tokenColorCustomizations`.
const state = vi.hoisted(() => ({ stored: undefined as any }));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        getConfiguration: vi.fn(() => ({
            inspect: (_key: string) => ({ globalValue: state.stored }),
            update: (_key: string, value: any) => {
                state.stored = value;
                return Promise.resolve();
            },
        })),
    },
    window: {},
}));

vi.mock('../../util', () => ({ getOutput: () => ({ appendLine: vi.fn() }) }));

import { applyLightColors, removeLightColors, refreshIfStale } from '../syntax/lightColors';

function makeContext() {
    const gs = new Map<string, any>();
    const context = {
        globalState: {
            get: (key: string) => gs.get(key),
            update: (key: string, val: any) => {
                gs.set(key, val);
                return Promise.resolve();
            },
        },
    } as any;
    return { context, gs };
}

const managedRules = () => state.stored['[*Light*]'].textMateRules as any[];
const hasScope = (rules: any[], scope: string) => rules.some(r => r.scope === scope);

describe('lightColors apply/remove', () => {
    beforeEach(() => {
        state.stored = undefined;
    });

    it('writes the [*Light*] block on empty settings and records consent + version', async () => {
        const { context, gs } = makeContext();
        await applyLightColors(context);

        const rules = managedRules();
        expect(rules.some(r => r.scope === 'entity.name.type.concept.mthds' && r.settings.foreground === '#0F766E')).toBe(true);
        expect(gs.get('pipelex.syntaxColors.lightConsent')).toBe('applied');
        expect(typeof gs.get('pipelex.syntaxColors.appliedVersion')).toBe('number');
    });

    it('preserves user-authored rules and other keys when applying', async () => {
        state.stored = {
            textMateRules: [{ scope: 'comment', settings: { foreground: '#abcabc' } }],
            '[*Light*]': {
                comments: '#ffffff',
                textMateRules: [{ scope: 'keyword', settings: { foreground: '#123123' } }],
            },
        };
        const { context } = makeContext();
        await applyLightColors(context);

        // Top-level user rule and the light block's non-textMateRules key are untouched.
        expect(state.stored.textMateRules).toEqual([{ scope: 'comment', settings: { foreground: '#abcabc' } }]);
        expect(state.stored['[*Light*]'].comments).toBe('#ffffff');
        // User's own keyword rule survives; our managed rule is added.
        expect(hasScope(managedRules(), 'keyword')).toBe(true);
        expect(hasScope(managedRules(), 'entity.name.tag.pipe.mthds')).toBe(true);
    });

    it('does not duplicate managed rules on re-apply', async () => {
        const { context } = makeContext();
        await applyLightColors(context);
        const firstCount = managedRules().length;
        await applyLightColors(context);
        expect(managedRules().length).toBe(firstCount);
    });

    it('removes the whole setting when our block is the only content', async () => {
        const { context } = makeContext();
        await applyLightColors(context);
        await removeLightColors();
        expect(state.stored).toBeUndefined();
    });

    it('strips only managed rules, keeping user rules, on remove', async () => {
        state.stored = {
            '[*Light*]': { textMateRules: [{ scope: 'keyword', settings: { foreground: '#123123' } }] },
        };
        const { context } = makeContext();
        await applyLightColors(context);
        await removeLightColors();

        const rules = state.stored['[*Light*]'].textMateRules;
        expect(rules).toEqual([{ scope: 'keyword', settings: { foreground: '#123123' } }]);
        expect(hasScope(rules, 'entity.name.tag.pipe.mthds')).toBe(false);
    });

    it('preserves a user rule that targets a managed scope (no sentinel name) on apply', async () => {
        const userRule = { scope: 'entity.name.tag.pipe.mthds', settings: { foreground: '#ababab' } };
        state.stored = { '[*Light*]': { textMateRules: [userRule] } };
        const { context } = makeContext();
        await applyLightColors(context);

        const rules = managedRules();
        // The user's own customization survives untouched (no sentinel name).
        expect(rules).toContainEqual(userRule);
        // Our managed rule for the same scope is also present, stamped with the sentinel.
        expect(rules.some(r => r.scope === 'entity.name.tag.pipe.mthds' && r.name === 'pipelex.mthds.light')).toBe(true);
    });

    it('does not delete a user rule on a managed scope when removing', async () => {
        const userRule = { scope: 'entity.name.tag.pipe.mthds', settings: { foreground: '#ababab' } };
        state.stored = { '[*Light*]': { textMateRules: [userRule] } };
        const { context } = makeContext();
        await applyLightColors(context);
        await removeLightColors();

        // Only our stamped rules are stripped; the user's same-scope rule remains.
        expect(state.stored['[*Light*]'].textMateRules).toEqual([userRule]);
    });

    it('refreshIfStale rewrites the block and advances appliedVersion when applied under an older palette', async () => {
        const { context, gs } = makeContext();
        // Simulate a prior apply under an older palette version.
        gs.set('pipelex.syntaxColors.lightConsent', 'applied');
        gs.set('pipelex.syntaxColors.appliedVersion', 1);
        state.stored = undefined;

        await refreshIfStale(context);

        // The managed block was re-applied in place.
        expect(hasScope(managedRules(), 'entity.name.tag.pipe.mthds')).toBe(true);
        // appliedVersion advanced off the stale value to the current palette version.
        const advanced = gs.get('pipelex.syntaxColors.appliedVersion');
        expect(typeof advanced).toBe('number');
        expect(advanced).not.toBe(1);
    });

    it('refreshIfStale leaves settings untouched when consent was never given', async () => {
        const { context, gs } = makeContext();
        // No consent recorded (and a stale version that would otherwise trigger a refresh).
        gs.set('pipelex.syntaxColors.appliedVersion', 1);
        state.stored = undefined;

        await refreshIfStale(context);

        // A declined/never-applied user must not get their settings written.
        expect(state.stored).toBeUndefined();
        expect(gs.get('pipelex.syntaxColors.appliedVersion')).toBe(1);
    });

    it('refreshIfStale is a no-op when already on the current palette version', async () => {
        const { context } = makeContext();
        // applyLightColors stamps the current version; a refresh must then not rewrite.
        await applyLightColors(context);
        state.stored = { marker: true } as any;

        await refreshIfStale(context);

        // Untouched — the version gate short-circuits before re-applying.
        expect(state.stored).toEqual({ marker: true });
    });

    it('keeps a user-authored nameless rule on a managed scope across a palette refresh', async () => {
        // Regression for the over-aggressive legacy migration: a refresh re-applies
        // the palette via plain applyLightColors and must NOT delete a user's own
        // nameless rule just because it targets a managed MTHDS scope.
        const userRule = { scope: 'entity.name.tag.pipe.mthds', settings: { foreground: '#ababab', fontStyle: 'italic' } };
        state.stored = { '[*Light*]': { textMateRules: [userRule] } };
        const { context } = makeContext();
        await applyLightColors(context);

        const rules = managedRules();
        // The user's customization survives verbatim.
        expect(rules).toContainEqual(userRule);
        // Our managed rule for the same scope is present, stamped with the sentinel.
        expect(rules.some(r => r.scope === 'entity.name.tag.pipe.mthds' && r.name === 'pipelex.mthds.light')).toBe(true);
    });
});
