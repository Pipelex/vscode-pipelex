import { makePipeRef, parsePipeRef } from '@pipelex/mthds-ui/static-graph';
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
     * Graph target: the fully-qualified pipe ref (`domain_code.pipe_code`) —
     * the renderer decorates every node invoking exactly this pipe (severity
     * ring + count badge). Always qualified, never a bare code: two domains
     * may declare the same pipe code, and a bare match would ring both. Built
     * from the validator's `domain_code` + `pipe_code` here (with a
     * registry-based inference when only `pipe_code` arrives); static issues
     * get theirs from the mthds-ui mapper.
     */
    pipeRef?: string;
    /** Graph target: one precise invocation node id (static walk diagnostics only). */
    nodeId?: string;
}

/** What the webview receives — on the `setData` payload and via `setValidationStatus`. */
export interface GraphValidationPayload {
    state: GraphValidationState;
    issues: GraphValidationIssue[];
}

/**
 * The `pipe.<code>` / `concept.<code>` chip for an error, or undefined when it
 * names neither. Mirrors the owning-file-label policy: the pipe chip is
 * domain-qualified (`pipe.<domain>.<code>`) only when the error's domain is
 * known AND differs from the shown file's — the obvious, local case stays
 * clean, a cross-domain issue announces where it lives.
 */
export function errorContext(error: ValidationErrorItem, shownDomain?: string): string | undefined {
    if (error.pipe_code) {
        const domain = error.domain_code != null ? String(error.domain_code) : undefined;
        return domain && shownDomain !== undefined && domain !== shownDomain
            ? `pipe.${domain}.${error.pipe_code}`
            : `pipe.${error.pipe_code}`;
    }
    return error.concept_code ? `concept.${error.concept_code}` : undefined;
}

/**
 * Qualify a bare `pipe_code` against the static graphspec's `pipe_registry`
 * refs — the runtime's "obvious rules" transposed to the presentation chain:
 * exactly one registry ref carrying that code names the pipe unambiguously;
 * zero or several means the code alone cannot identify a pipe, and the issue
 * must stay untargeted rather than decorate by guess.
 */
export function inferPipeRefFromRegistry(
    pipeCode: string,
    registryRefs: readonly string[] | undefined,
): string | undefined {
    if (!registryRefs) return undefined;
    const matches = registryRefs.filter(ref => {
        const parsed = parsePipeRef(ref);
        return parsed !== null && parsed.domainPath !== null && parsed.pipeCode === pipeCode;
    });
    return matches.length === 1 ? matches[0] : undefined;
}

/** Host-side context {@link validationErrorsToIssues} projects errors against. */
export interface ValidationIssueContext {
    /**
     * Index-aligned with `errors` (from `resolveErrorLocations`, which
     * preserves input order): the owning-file basename, or undefined when the
     * error lives in the shown file itself (kept unlabeled to stay clean).
     */
    ownerFiles?: (string | undefined)[];
    /**
     * Qualified refs (`domain.code`) keying the static graphspec's
     * `pipe_registry` — the inference pool for errors that arrive with a bare
     * `pipe_code` and no `domain_code`.
     */
    pipeRegistryRefs?: readonly string[];
    /** The shown file's declared domain — drives the chip-qualification policy. */
    shownDomain?: string;
}

/** Project the backend's structured validation errors onto widget issues. */
export function validationErrorsToIssues(
    errors: ValidationErrorItem[],
    context: ValidationIssueContext = {},
): GraphValidationIssue[] {
    return errors.map((error, index) => {
        const pipeCode = error.pipe_code != null ? String(error.pipe_code) : undefined;
        const domainCode = error.domain_code != null ? String(error.domain_code) : undefined;
        const pipeRef = pipeCode !== undefined
            ? domainCode !== undefined
                ? makePipeRef(domainCode, pipeCode)
                : inferPipeRefFromRegistry(pipeCode, context.pipeRegistryRefs)
            : undefined;
        return {
            severity: 'error' as const,
            // Coerced at the trust boundary: these strings cross into the React
            // webview as render children, where a non-string from a malformed
            // backend response would throw inside GraphViewer (blank webview, no
            // error boundary). The types say string; the wire doesn't promise it.
            message: String(error.message),
            context: errorContext(error, context.shownDomain),
            file: context.ownerFiles?.[index],
            suggestedFix: error.suggested_fix?.description != null ? String(error.suggested_fix.description) : undefined,
            origin: 'validator' as const,
            pipeRef,
        };
    });
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
