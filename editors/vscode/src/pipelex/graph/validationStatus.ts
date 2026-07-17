import { BackendError } from '../validation/backend';
import type { ValidationErrorItem } from '../validation/types';

/**
 * Presentation shapes for the graph toolbar's validation widget.
 *
 * These mirror `@pipelex/mthds-ui`'s `ValidationState` / `ValidationIssue`
 * (structurally assignable) but are declared locally so this module — the
 * pure, unit-testable half of the widget flow — has no dependency beyond the
 * backend error type. The panel/adapter pass them to the renderer verbatim.
 */
export type GraphValidationState = 'validating' | 'valid' | 'invalid' | 'error';

export interface GraphValidationIssue {
    severity: 'error' | 'warning';
    message: string;
    /** Locator chip, e.g. `pipe.analyze_candidate` or a static-diagnostic TOML path. */
    context?: string;
    /** Owning-file basename, only when the issue lives outside the shown file. */
    file?: string;
    /** Human-readable fix line from the runtime's fix planner. */
    suggestedFix?: string;
    origin?: 'validator' | 'static';
    /**
     * Graph target: the renderer decorates every node invoking this pipe
     * (severity ring + count badge). Filled from the validator's `pipe_code`
     * here; static issues get theirs from the mthds-ui mapper.
     */
    pipeCode?: string;
    /** Graph target: one precise invocation node id (static walk diagnostics only). */
    nodeId?: string;
}

/** What the webview receives — on the `setData` payload and via `setValidationStatus`. */
export interface GraphValidationPayload {
    state: GraphValidationState;
    issues: GraphValidationIssue[];
}

/** The `pipe.<code>` / `concept.<code>` chip for an error, or undefined when it names neither. */
export function errorContext(error: ValidationErrorItem): string | undefined {
    return error.pipe_code
        ? `pipe.${error.pipe_code}`
        : error.concept_code
            ? `concept.${error.concept_code}`
            : undefined;
}

/**
 * Project the backend's structured validation errors onto widget issues.
 * `ownerFiles` is index-aligned with `errors` (from `resolveErrorLocations`,
 * which preserves input order): the owning-file basename, or undefined when
 * the error lives in the shown file itself (kept unlabeled to stay clean).
 */
export function validationErrorsToIssues(
    errors: ValidationErrorItem[],
    ownerFiles?: (string | undefined)[],
): GraphValidationIssue[] {
    return errors.map((error, index) => ({
        severity: 'error' as const,
        message: error.message,
        context: errorContext(error),
        file: ownerFiles?.[index],
        suggestedFix: error.suggested_fix?.description ?? undefined,
        origin: 'validator' as const,
        pipeCode: error.pipe_code ?? undefined,
    }));
}

/**
 * Parse a static diagnostic's locator chip back into a declaration reference,
 * when its TOML path starts with `pipe.<code>` / `concept.<code>` — the hook
 * for best-effort click-to-navigate on static issues. Paths that don't name a
 * declaration (e.g. a bare `domain` key) return undefined: the row stays
 * non-navigable rather than jumping somewhere wrong.
 */
export function parseStaticIssueContext(
    context: string | undefined,
): { kind: 'pipe' | 'concept'; code: string } | undefined {
    if (!context) return undefined;
    const match = /^(pipe|concept)\.([A-Za-z0-9_-]+)/.exec(context);
    if (!match) return undefined;
    return { kind: match[1] as 'pipe' | 'concept', code: match[2] };
}

/**
 * Render a backend failure (no verdict could be produced) as the lead issue of
 * the widget's `error` state. Mirrors the per-kind wording the full-page views
 * used before the static-first flow; toast side-channels (install warning,
 * auth actions) stay with the panel.
 */
export function describeBackendErrorIssue(err: unknown): GraphValidationIssue {
    let message: string;
    if (err instanceof BackendError) {
        switch (err.kind) {
            case 'not-found':
                message =
                    'Could not find pipelex-agent. Install it or set pipelex.validation.agentCliPath in settings.';
                break;
            case 'too-old':
                message =
                    `Your installed pipelex-agent is ${err.installedVersion ?? '?'}, but validation requires ` +
                    `≥ ${err.minVersion ?? '?'}. Upgrade pipelex and save again.`;
                break;
            case 'declined':
                message = 'Sending bundle contents to the remote Pipelex API was declined.';
                break;
            default:
                message = err.userMessage ?? err.logMessage;
                break;
        }
    } else {
        message = err instanceof Error ? err.message : String(err);
    }
    return { severity: 'error', message, origin: 'validator' };
}
