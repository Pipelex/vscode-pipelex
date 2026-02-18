/** A single validation error from `pipelex-agent validate` JSON output */
export interface ValidationErrorItem {
    category: string;
    error_type: string;
    pipe_code?: string | null;
    concept_code?: string | null;
    field_path?: string | null;
    message: string;
    domain_code?: string | null;
    variable_names?: string[] | null;
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
