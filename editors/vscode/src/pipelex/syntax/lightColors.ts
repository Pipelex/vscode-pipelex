import * as vscode from 'vscode';
import { getOutput } from '../../util';

/**
 * Light-theme syntax colors for `.mthds` files.
 *
 * Why this exists: the extension ships its MTHDS brand palette through
 * `contributes.configurationDefaults.editor.tokenColorCustomizations`. That
 * mechanism applies an unscoped (dark-tuned) palette to *every* theme — VS Code
 * does NOT honor theme-scoped keys (e.g. `[*Light*]`) coming from an extension's
 * `configurationDefaults`, only from real user/workspace settings. So on a light
 * theme the dark colors leak through and read as low-contrast/illegible.
 *
 * The fix: with the user's explicit consent, write a `[*Light*]` block into the
 * user's own `editor.tokenColorCustomizations` (where theme-scoped keys ARE
 * honored). The dark palette stays in `configurationDefaults`, so dark-only users
 * get zero settings pollution and only opted-in light users get a managed block.
 *
 * The light hues mirror the dark `configurationDefaults` rules one-for-one and
 * match the `pipelex-light` shiki theme in `mthds-ui`. See
 * `docs/features/syntax-color-palette.md`.
 */

/** Bump when LIGHT_RULES changes so an already-applied block refreshes on update. */
const PALETTE_VERSION = 2;

/** globalState key: `'applied' | 'declined'`; absent = not yet decided. */
const CONSENT_KEY = 'pipelex.syntaxColors.lightConsent';
/** globalState key: the PALETTE_VERSION last written, so we can refresh on bump. */
const APPLIED_VERSION_KEY = 'pipelex.syntaxColors.appliedVersion';

/** Command ids — also declared in package.json `contributes.commands`. */
export const APPLY_LIGHT_COLORS_COMMAND = 'pipelex.applyLightSyntaxColors';
export const REMOVE_LIGHT_COLORS_COMMAND = 'pipelex.removeLightSyntaxColors';

const TOKEN_COLORS_SECTION = 'editor';
const TOKEN_COLORS_KEY = 'tokenColorCustomizations';
/** VS Code wildcard theme-name key matching every theme whose label contains "Light". */
const LIGHT_THEME_KEY = '[*Light*]';

interface TextMateRule {
    scope: string | string[];
    settings: { foreground?: string; fontStyle?: string };
}

interface ThemeTokenColors {
    textMateRules?: TextMateRule[];
    [key: string]: unknown;
}

interface TokenColorCustomizations {
    [key: string]: unknown;
}

/**
 * Light palette for `.mthds` files. The first group mirrors the dark brand rules
 * in `package.json` configurationDefaults (hues darkened for a light background);
 * the second group pins the "secondary" token types (strings, property names,
 * booleans, numbers, punctuation, Jinja/HTML) to the storybook colors so MTHDS
 * code matches the `pipelex-light` reference on ANY light theme — not just ones
 * (like Light+) whose defaults already happen to match.
 *
 * Every scope is `.mthds`-suffixed on purpose: the `[*Light*]` block applies to
 * all files in light themes, so only fully-qualified MTHDS scopes keep this from
 * recoloring other languages. (Dark deliberately leaves the secondary scopes to
 * the user's theme — that side already reads well and we don't disturb it.)
 */
const LIGHT_RULES: readonly TextMateRule[] = [
    { scope: 'entity.name.tag.pipe.mthds', settings: { foreground: '#D32F2F', fontStyle: 'bold' } },
    { scope: 'entity.name.tag.pipe-type.mthds', settings: { foreground: '#D32F2F', fontStyle: 'bold' } },
    { scope: 'entity.name.tag.pipe-name.mthds', settings: { foreground: '#D32F2F', fontStyle: 'bold' } },
    { scope: 'entity.name.type.concept.mthds', settings: { foreground: '#0F766E', fontStyle: 'bold' } },
    { scope: 'variable.other.readwrite.mthds', settings: { foreground: '#15803D', fontStyle: 'bold' } },
    { scope: 'constant.other.symbol.mthds', settings: { foreground: '#C2410C', fontStyle: 'bold' } },
    { scope: ['storage.modifier.mthds', 'constant.character.escape.mthds'], settings: { foreground: '#C2255C' } },
    { scope: 'keyword.operator.arrow.mthds', settings: { foreground: '#C2255C' } },
    { scope: 'punctuation.separator.namespace.mthds', settings: { foreground: '#6A6158' } },
    { scope: 'keyword.control.jinja.mthds', settings: { foreground: '#C2255C', fontStyle: 'bold' } },
    { scope: 'keyword.operator.jinja.mthds', settings: { foreground: '#C2255C' } },
    { scope: 'entity.name.tag.html.mthds', settings: { foreground: '#C2255C' } },
    { scope: 'punctuation.definition.jinja.mthds', settings: { foreground: '#C2410C' } },
    {
        scope: ['comment.line.number-sign.mthds', 'comment.block.jinja.mthds', 'comment.block.html.mthds'],
        settings: { foreground: '#008000', fontStyle: 'italic' },
    },
    { scope: 'meta.preprocessor.mthds', settings: { foreground: '#008000', fontStyle: 'italic' } },
    { scope: 'invalid.illegal.escape.mthds', settings: { foreground: '#C00000', fontStyle: 'underline' } },

    // ── Secondary scopes (storybook match, light-only) ──────────────────────
    // Dark red #A31515 — string values (incl. Jinja string literals, prompt blocks).
    {
        scope: [
            'string.quoted.single.basic.line.mthds',
            'string.quoted.single.literal.line.mthds',
            'string.quoted.triple.basic.block.mthds',
            'string.quoted.triple.literal.block.mthds',
            'string.quoted.double.jinja.mthds',
            'string.quoted.single.jinja.mthds',
            'string.quoted.html.mthds',
        ],
        settings: { foreground: '#A31515' },
    },
    // Navy #001080 — property names (keys) and Jinja variables.
    {
        scope: [
            'support.type.property-name.mthds',
            'support.type.property-name.table.mthds',
            'support.type.property-name.array.mthds',
            'variable.other.jinja.mthds',
        ],
        settings: { foreground: '#001080' },
    },
    // Blue #0000FF — booleans.
    { scope: 'constant.language.boolean.mthds', settings: { foreground: '#0000FF' } },
    // Dark green #098658 — numbers and date/time literals.
    {
        scope: [
            'constant.numeric.integer.mthds',
            'constant.numeric.float.mthds',
            'constant.numeric.hex.mthds',
            'constant.numeric.oct.mthds',
            'constant.numeric.bin.mthds',
            'constant.numeric.inf.mthds',
            'constant.numeric.nan.mthds',
            'constant.numeric.jinja.mthds',
            'constant.other.time.date.mthds',
            'constant.other.time.time.mthds',
            'constant.other.time.datetime.local.mthds',
            'constant.other.time.datetime.offset.mthds',
        ],
        settings: { foreground: '#098658' },
    },
    // Brown #795E26 — Jinja functions and HTML attribute names.
    {
        scope: ['support.function.jinja.mthds', 'entity.other.attribute-name.html.mthds'],
        settings: { foreground: '#795E26' },
    },
    // Foreground #1B1713 — structural punctuation (brackets, separators, `=`, quotes).
    {
        scope: [
            'punctuation.definition.table.mthds',
            'punctuation.definition.array.table.mthds',
            'punctuation.definition.array.mthds',
            'punctuation.definition.table.inline.mthds',
            'punctuation.separator.dot.mthds',
            'punctuation.separator.array.mthds',
            'punctuation.separator.table.inline.mthds',
            'punctuation.eq.mthds',
            'punctuation.definition.string.begin.mthds',
            'punctuation.definition.string.end.mthds',
        ],
        settings: { foreground: '#1B1713' },
    },
];

/** Every individual scope string our rules manage — used to identify our rules on merge/remove. */
const MANAGED_SCOPES: ReadonlySet<string> = new Set(
    LIGHT_RULES.flatMap(rule => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]))
);

/**
 * A rule counts as "ours" when every scope it carries is one we manage. This lets
 * apply/remove replace our rules without disturbing any rule the user authored —
 * even one that happens to touch a `.mthds` scope alongside others.
 */
function isManagedRule(rule: TextMateRule): boolean {
    const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
    return scopes.length > 0 && scopes.every(scope => MANAGED_SCOPES.has(scope));
}

function isLightTheme(): boolean {
    const Kind = vscode.ColorThemeKind;
    const kind = vscode.window.activeColorTheme?.kind;
    return !!Kind && (kind === Kind.Light || kind === Kind.HighContrastLight);
}

function hasMthdsInView(): boolean {
    return vscode.window.visibleTextEditors.some(editor => editor.document.languageId === 'mthds');
}

/**
 * Read ONLY the user-global layer of `editor.tokenColorCustomizations` (not the
 * merged value, which would fold in our dark `configurationDefaults` and pollute
 * what we write back). Returns a shallow-cloned object safe to mutate.
 */
function readGlobalTokenColors(): TokenColorCustomizations {
    const inspected = vscode.workspace
        .getConfiguration(TOKEN_COLORS_SECTION)
        .inspect<TokenColorCustomizations>(TOKEN_COLORS_KEY);
    const current = inspected?.globalValue;
    return current && typeof current === 'object' ? { ...current } : {};
}

async function writeGlobalTokenColors(next: TokenColorCustomizations): Promise<void> {
    const value = Object.keys(next).length > 0 ? next : undefined;
    await vscode.workspace
        .getConfiguration(TOKEN_COLORS_SECTION)
        .update(TOKEN_COLORS_KEY, value, vscode.ConfigurationTarget.Global);
}

/** Merge our managed light rules into `[*Light*]`, preserving any rules the user authored. */
export async function applyLightColors(context: vscode.ExtensionContext): Promise<void> {
    const next = readGlobalTokenColors();
    const existingLight = (next[LIGHT_THEME_KEY] as ThemeTokenColors | undefined) ?? {};
    const existingRules = Array.isArray(existingLight.textMateRules) ? existingLight.textMateRules : [];
    const preserved = existingRules.filter(rule => !isManagedRule(rule));
    next[LIGHT_THEME_KEY] = { ...existingLight, textMateRules: [...preserved, ...LIGHT_RULES] };

    await writeGlobalTokenColors(next);
    await context.globalState.update(CONSENT_KEY, 'applied');
    await context.globalState.update(APPLIED_VERSION_KEY, PALETTE_VERSION);
}

/** Strip only our managed rules from `[*Light*]`, cleaning up empty containers. */
export async function removeLightColors(): Promise<void> {
    const next = readGlobalTokenColors();
    const existingLight = next[LIGHT_THEME_KEY] as ThemeTokenColors | undefined;
    if (existingLight && Array.isArray(existingLight.textMateRules)) {
        const preserved = existingLight.textMateRules.filter(rule => !isManagedRule(rule));
        const { textMateRules: _drop, ...rest } = existingLight;
        const rebuilt: ThemeTokenColors = preserved.length > 0 ? { ...rest, textMateRules: preserved } : { ...rest };
        if (Object.keys(rebuilt).length > 0) {
            next[LIGHT_THEME_KEY] = rebuilt;
        } else {
            delete next[LIGHT_THEME_KEY];
        }
    }
    await writeGlobalTokenColors(next);
}

/**
 * One-time, light-theme-only consent prompt. Shown when a light theme is active
 * and a `.mthds` file is in view, at most once per decision: "Apply" writes the
 * block, "Don't ask again" records a decline, "Not now" defers to a later session
 * (and is snoozed for the rest of this one).
 */
async function maybePrompt(context: vscode.ExtensionContext): Promise<void> {
    if (snoozedThisSession || promptInFlight) {
        return;
    }
    if (!isLightTheme() || !hasMthdsInView()) {
        return;
    }
    if (context.globalState.get<string>(CONSENT_KEY)) {
        return; // already 'applied' or 'declined'
    }

    promptInFlight = true;
    try {
        const choice = await vscode.window.showInformationMessage(
            'Pipelex can apply its light-theme syntax colors so MTHDS code stays readable on light ' +
                'backgrounds. This adds a managed block to your VS Code settings (editor.tokenColorCustomizations).',
            'Apply',
            'Not now',
            "Don't ask again",
        );
        if (choice === 'Apply') {
            await applyLightColors(context);
            vscode.window.showInformationMessage('Pipelex: light-theme MTHDS colors applied.');
        } else if (choice === "Don't ask again") {
            await context.globalState.update(CONSENT_KEY, 'declined');
        } else {
            // "Not now" or dismissed — ask again next session, but stop nagging now.
            snoozedThisSession = true;
        }
    } catch (err) {
        getOutput().appendLine(`Pipelex: light-color prompt failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
        promptInFlight = false;
    }
}

/** If colors were applied under an older palette version, refresh them in place. */
async function refreshIfStale(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<string>(CONSENT_KEY) !== 'applied') {
        return;
    }
    if (context.globalState.get<number>(APPLIED_VERSION_KEY) === PALETTE_VERSION) {
        return;
    }
    try {
        await applyLightColors(context);
    } catch (err) {
        getOutput().appendLine(`Pipelex: light-color refresh failed: ${String((err as Error)?.message ?? err)}`);
    }
}

let snoozedThisSession = false;
let promptInFlight = false;

/**
 * Register the apply/remove commands, the consent prompt triggers (activation +
 * theme change + opening a `.mthds` file), and refresh stale applied colors.
 * Does not depend on child_process, so it works in browser hosts too.
 */
export function registerLightSyntaxColors(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(APPLY_LIGHT_COLORS_COMMAND, async () => {
            await applyLightColors(context);
            vscode.window.showInformationMessage('Pipelex: light-theme MTHDS colors applied.');
        }),
        vscode.commands.registerCommand(REMOVE_LIGHT_COLORS_COMMAND, async () => {
            await removeLightColors();
            // Explicit removal is a deliberate opt-out — don't re-prompt automatically.
            await context.globalState.update(CONSENT_KEY, 'declined');
            vscode.window.showInformationMessage('Pipelex: light-theme MTHDS colors removed.');
        }),
        vscode.window.onDidChangeActiveColorTheme(() => void maybePrompt(context)),
        vscode.window.onDidChangeActiveTextEditor(() => void maybePrompt(context)),
    );

    void refreshIfStale(context);
    void maybePrompt(context);
}
