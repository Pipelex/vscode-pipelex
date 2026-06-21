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

import { applyLightColors, removeLightColors } from '../syntax/lightColors';

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
});
