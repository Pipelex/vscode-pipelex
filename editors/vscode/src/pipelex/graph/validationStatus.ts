import { makePipeRef, parsePipeRef } from '@pipelex/mthds-ui/static-graph';
import { BackendError } from '../validation/backend';
import type { ProblemItem } from '../validation/types';
import { itemConcept, itemPipe } from '../validation/problemItems';

/**
 * Presentation shapes for the graph toolbar's validation widget.
 *
 * These mirror `@pipelex/mthds-ui`'s `ValidationState` / `ValidationIssue`
 * (structurally assignable) but are declared locally so this module — the
 * pure, unit-testable half of the widget flow — has no dependency beyond the
 * backend error type. The panel/adapter pass them to the renderer verbatim.
 */
export type GraphValidationState = 'validating' | 'valid' | 'invalid' | 'error' | 'unvalidated';

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
     * here from the item's `location.pipe` and the domain of the file that
     * declares it (with a registry-based inference when that file is not
     * known); static issues get theirs from the mthds-ui mapper.
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
 * The `pipe.<code>` / `concept.<code>` chip for an item, or undefined when it
 * names neither. Mirrors the owning-file-label policy: the pipe chip is
 * domain-qualified (`pipe.<domain>.<code>`) only when the pipe's domain is
 * known AND differs from the shown file's — the obvious, local case stays
 * clean, a cross-domain issue announces where it lives.
 */
export function errorContext(item: ProblemItem, shownDomain?: string, pipeDomain?: string): string | undefined {
    const pipe = itemPipe(item);
    if (pipe) {
        return pipeDomain && shownDomain !== undefined && pipeDomain !== shownDomain
            ? `pipe.${pipeDomain}.${pipe}`
            : `pipe.${pipe}`;
    }
    const concept = itemConcept(item);
    return concept ? `concept.${concept}` : undefined;
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

/** Host-side context {@link problemItemsToIssues} projects items against. */
export interface ValidationIssueContext {
    /**
     * Index-aligned with the items (from `resolveErrorLocations`, which
     * preserves input order): the owning-file basename, or undefined when the
     * item lives in the shown file itself (kept unlabeled to stay clean).
     */
    ownerFiles?: (string | undefined)[];
    /**
     * Index-aligned with the items (from `resolveErrorLocations`): the domain
     * of the file that declares the item's pipe, when the item resolved that
     * file itself. It qualifies the item's pipe outright.
     */
    pipeDomains?: (string | undefined)[];
    /**
     * Qualified refs (`domain.code`) keying the static graphspec's
     * `pipe_registry` — the inference pool for items whose pipe's domain is
     * not known from its file.
     */
    pipeRegistryRefs?: readonly string[];
    /** The shown file's declared domain — drives the chip-qualification policy. */
    shownDomain?: string;
}

/**
 * Project the validator's problem items onto widget issues: its faults with
 * `severity` `error`, its advisory findings with `warning`. An item carries no
 * domain, so its pipe is qualified by the domain of the file that declares it,
 * else through the static registry when exactly one domain declares that code.
 */
export function problemItemsToIssues(
    items: ProblemItem[],
    context: ValidationIssueContext = {},
    severity: 'error' | 'warning' = 'error',
): GraphValidationIssue[] {
    return items.map((item, index) => {
        const pipe = itemPipe(item);
        const knownDomain = context.pipeDomains?.[index];
        const pipeRef = pipe !== undefined
            ? knownDomain !== undefined
                ? makePipeRef(knownDomain, pipe)
                : inferPipeRefFromRegistry(pipe, context.pipeRegistryRefs)
            : undefined;
        const pipeDomain = pipeRef !== undefined ? parsePipeRef(pipeRef)?.domainPath ?? undefined : undefined;
        return {
            severity,
            // Coerced at the trust boundary: these strings cross into the React
            // webview as render children, where a non-string from a malformed
            // backend response would throw inside GraphViewer (blank webview, no
            // error boundary). The reader keeps only strings; this guards any
            // other caller.
            message: String(item.detail),
            context: errorContext(item, context.shownDomain, pipeDomain),
            file: context.ownerFiles?.[index],
            suggestedFix: item.suggested_fix?.description != null ? String(item.suggested_fix.description) : undefined,
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
 * the widget's `error` state — or, for a declined remote send, of its
 * `unvalidated` state, since the user chose not to validate. Mirrors the
 * per-kind wording the full-page views used before the static-first flow;
 * toast side-channels (install warning, auth actions) stay with the panel.
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
                message =
                    'Sending your .mthds files to the Pipelex API was declined, so validation is off until you ' +
                    'reload the window and are asked again. To validate locally instead, set pipelex.backend to cli.';
                break;
            default:
                message = err.userMessage ?? err.logMessage;
                break;
        }
    } else {
        message = err instanceof Error ? err.message : String(err);
    }
    // A declined send is the user's own choice, not a fault in anything, so it
    // leads the list as a note rather than as an error.
    const severity = err instanceof BackendError && err.kind === 'declined' ? 'warning' : 'error';
    return { severity, message, origin: 'validator' };
}
