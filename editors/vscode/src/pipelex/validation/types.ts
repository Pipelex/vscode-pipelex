/**
 * One fault, or one advisory finding, of a validation verdict: the MTHDS
 * protocol's problem item, holding the members the extension reads.
 *
 * Both backends produce this shape. The Pipelex API's `/validate` verdict
 * carries its faults as `errors[]` and its advisory findings as `warnings[]`,
 * and `pipelex-agent validate bundle` reports an invalid verdict as the
 * `method.invalid` problem, whose `errors[]` are these items. So the CLI and
 * API paths feed the same diagnostics pipe with no per-backend branching.
 * `problemItems.ts` reads them off the wire.
 *
 * An item carries no domain and no next step: those belong to the problem
 * document as a whole (an item read from the shape problem items replace
 * keeps the domain that shape named, in {@link ProblemItem.legacy}). What to do about one item is the page its code's type
 * URI names ({@link problemTypeUri}), and its `suggested_fix` when the runtime's
 * fix planner derived one.
 */
export interface ProblemItem {
    /**
     * The registry code, such as `method.unknown_pipe` or `pipelex.…`. Absent
     * only on an item read from the shape the hosted plane's runner and an
     * older `pipelex-agent` still write, which has no code.
     */
    code?: string;
    /** The sentence the code renders for this occurrence. */
    detail: string;
    /** The code's parameters. The extension reads `concept` and `field_path`. */
    params?: Record<string, unknown>;
    location?: ProblemLocation;
    suggested_fix?: SuggestedFix;
    /**
     * What only the validation item problem items replace carries, kept when
     * an item is read from that shape. Absent on a problem item. It goes with
     * that reader.
     */
    legacy?: LegacyItemFacts;
}

/**
 * The members of the validation item problem items replace that a problem
 * item has no place for, and that the extension still uses.
 */
export interface LegacyItemFacts {
    /**
     * The `domain_code` the item named: the domain its pipe or concept lives
     * in. It constrains the declaration scan for its owning file and
     * qualifies its pipe in the method graph.
     */
    domainCode?: string;
    /**
     * The `error_type` the item named, which the Problems panel shows as the
     * diagnostic's code. It is no registry code, so it links to no page.
     */
    errorType?: string;
}

/** Where a problem item points: the members of the protocol's location the extension reads. */
export interface ProblemLocation {
    /** The bare code of the pipe at fault (never domain-qualified). */
    pipe?: string;
    /** The field at fault: a field name or a dotted path. */
    field?: string;
    /**
     * The file at fault: the per-content name the API was sent in
     * `mthds_sources`, or the path `pipelex-agent` read. The owning file for
     * cross-file diagnostics.
     */
    file?: string;
    /** The line within `file`, 1-based. */
    line?: number;
    /**
     * The column within `line`, 1-based. The standard does not name its unit;
     * pipelex counts Unicode code points, as Python's strings do, so the
     * extension reads it that way (`locateLineColumn`).
     */
    column?: number;
}

/**
 * A deterministic fix the runtime's fix planner derived for one item. The
 * extension shows only `description` (in the graph panel's validation widget);
 * the ops are for style-preserving appliers and stay opaque here.
 */
export interface SuggestedFix {
    fix_code: string;
    description: string;
    safety?: string;
    /** The file the fix edits. */
    file?: string;
    ops?: unknown[];
}

/** Resolved CLI command + args for spawning pipelex-agent */
export interface ResolvedCli {
    command: string;
    args: string[];
}
