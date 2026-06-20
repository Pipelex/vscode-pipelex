/**
 * A single structured validation error.
 *
 * This is the normalized shape both backends produce. It mirrors the pipelex
 * wire contract (`ValidationErrorItem` on the API 422 `problem+json` body, and
 * the `validation_errors[]` entries in the `pipelex-agent validate` JSON output),
 * so the CLI and API paths feed the same diagnostics pipe with no per-backend
 * branching. `mthds`'s exported `ValidationErrorItem` is structurally assignable
 * to this (its optional fields are a subset).
 *
 * Only `category` and `message` are always present; the rest are populated per
 * category. `source` is the declaring file path (CLI) or the per-content name
 * the API threads onto the in-memory load path — the owning file for cross-file
 * diagnostics.
 */
export interface ValidationErrorItem {
    category: string;
    message: string;
    error_type?: string | null;
    pipe_code?: string | null;
    concept_code?: string | null;
    domain_code?: string | null;
    source?: string | null;
    field_path?: string | null;
    field_name?: string | null;
    variable_names?: string[] | null;
    missing_concept_code?: string | null;
    declared_concepts?: string[] | null;
}

/** Top-level JSON envelope when `pipelex-agent validate` exits with code 1 */
export interface ValidationFailure {
    error: true;
    error_type: string;
    message: string;
    validation_errors: ValidationErrorItem[];
}

/** Resolved CLI command + args for spawning pipelex-agent */
export interface ResolvedCli {
    command: string;
    args: string[];
}
