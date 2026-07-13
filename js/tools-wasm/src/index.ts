/**
 * `@pipelex/tools-wasm` — MTHDS lint & format compiled to WASM.
 *
 * A thin typed wrapper over the `pipelex-tools-wasm` crate: the same shared
 * Rust engine behind the `plxt` CLI, the `pipelex-tools-py` wheel, and the
 * Pipelex API's `/v1/lint` + `/v1/format`, so every binding emits the
 * identical `Diagnostic` wire shape by construction. Fully offline: lint
 * validates against the MTHDS schema embedded at build time (no HTTP, no
 * filesystem), and format does no config discovery.
 *
 * Usage (bundlers resolve named imports from the UMD bundle; native Node ESM
 * must default-import and destructure — see the README for the per-environment
 * import forms):
 *
 * ```js
 * import { initialize, lintMthds, formatMthds } from "@pipelex/tools-wasm";
 *
 * await initialize();
 * const { diagnostics } = lintMthds(mthdsSource);
 * const { formatted, changed } = formatMthds(mthdsSource);
 * ```
 */
import loadPipelexTools from "../../../crates/pipelex-tools-wasm/Cargo.toml";

// ⚠️ PUBLIC BINDING SURFACE — these types mirror `@pipelex/sdk`'s
// `Diagnostic`/`DiagnosticRange`/`DiagnosticKind`/`LintResponse`/`FormatResponse`
// (pipelex-sdk-js/src/models.ts) and the crate's serialized shapes. Keep all
// three in sync.

/** Which analysis produced a `Diagnostic` — mirror of `pipelex-tools`' closed kind set. */
export type DiagnosticKind = "syntax" | "semantic" | "schema";

/** Source span of a `Diagnostic` — byte offsets plus 1-based line/column coordinates. */
export interface DiagnosticRange {
  start_offset: number;
  end_offset: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

/**
 * One structured lint/format diagnostic — mirror of pipelex's `Diagnostic`.
 * `severity` stays an open string (the engine does not close the vocabulary);
 * `location` and `range` are `null` when the analysis cannot attribute a span.
 */
export interface Diagnostic {
  kind: DiagnosticKind;
  severity: string;
  message: string;
  location: string | null;
  range: DiagnosticRange | null;
}

/** Result of {@link lintMthds} — the diagnostics of one linted `.mthds` file (empty == clean). */
export interface LintResult {
  diagnostics: Diagnostic[];
}

/**
 * Result of {@link formatMthds} — the canonically formatted content, whether it
 * differs from the submitted one, and any diagnostics found on the way. A syntax
 * error yields `changed: false` with the content echoed back unchanged.
 */
export interface FormatResult {
  formatted: string;
  changed: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Formatter overrides for {@link formatMthds}: snake_case option keys with
 * string, number, or boolean values — the same keys as the CLI's `-o key=value`
 * and the API's `/v1/format` `options` passthrough (e.g. `column_width`,
 * `align_entries`, `indent_string`).
 */
export type FormatMthdsOptions = Record<string, string | number | boolean>;

let wasm: any | undefined;

/**
 * Load the WASM module (once) and install its panic hook. Must complete before
 * the first {@link lintMthds} / {@link formatMthds} call; calling it again is a
 * cheap no-op.
 */
export async function initialize(): Promise<void> {
  if (typeof wasm === "undefined") {
    wasm = await loadPipelexTools();
  }
  wasm.initialize();
}

function loaded(): any {
  if (typeof wasm === "undefined") {
    throw new Error(
      "@pipelex/tools-wasm is not initialized: await initialize() first"
    );
  }
  return wasm;
}

/**
 * Lint one MTHDS document: syntax → semantic → schema, short-circuiting at the
 * first failing stage, fully offline against the embedded MTHDS schema.
 * Diagnostics are data — this never throws on bad content.
 */
export function lintMthds(content: string): LintResult {
  return loaded().lint_mthds(content);
}

/**
 * Format one MTHDS document with the canonical MTHDS defaults baked in. On a
 * syntax error the input is returned unchanged along with the blocking
 * diagnostics — it never throws for malformed MTHDS. It *does* throw for a
 * malformed `options` value (e.g. a non-numeric `column_width`).
 */
export function formatMthds(
  content: string,
  options?: FormatMthdsOptions
): FormatResult {
  return loaded().format_mthds(content, options);
}
