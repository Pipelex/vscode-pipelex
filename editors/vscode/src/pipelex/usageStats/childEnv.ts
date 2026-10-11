/**
 * The environment of every process the extension starts.
 *
 * The extension counts its own uses in `feature_used`, under VS Code's telemetry
 * setting and the shared switches. A `pipelex-agent` it spawns to validate, a
 * `pipelex run` it types into its terminal or the language server it starts would
 * otherwise report by their own switches alone, bypassing VS Code's setting and
 * counting the same use twice. So each one runs with `PIPELEX_USAGE_STATS=0`,
 * whatever VS Code's setting (the usage-statistics contract, record R6).
 *
 * Dependency-free: the spawn sites import it, in every host.
 */

export const CHILD_USAGE_STATS_VARIABLE = 'PIPELEX_USAGE_STATS';
export const CHILD_USAGE_STATS_VALUE = '0';

/** `base` (the extension host's own environment by default) with statistics off. */
export function childProcessEnv(
    base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
    return { ...base, [CHILD_USAGE_STATS_VARIABLE]: CHILD_USAGE_STATS_VALUE };
}

/** Only the statistics variable, for an API that merges it into the parent's
 * environment itself (a terminal's `env`, the language client's `options.env`). */
export function childProcessEnvOverrides(
    overrides: Record<string, string> = {},
): Record<string, string> {
    return { ...overrides, [CHILD_USAGE_STATS_VARIABLE]: CHILD_USAGE_STATS_VALUE };
}
