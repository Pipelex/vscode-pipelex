"""Type stubs for the ``pipelex_tools`` native extension module.

⚠️  HAND-MAINTAINED MIRROR — NOT GENERATED, NOT COMPILER-CHECKED.

``pipelex_tools`` is a compiled Rust/PyO3 extension module, so type checkers
(pyright/mypy) and IDEs cannot read signatures from the ``.so``/``.pyd`` binary.
This stub is the *only* static type information downstream consumers (e.g. the
``pipelex-api`` server) get for this package.

Because nothing enforces that this file matches the Rust, **if you change the
exported surface you MUST update this stub in the same commit.** Map of what
mirrors what:

  - ``format_mthds`` / ``lint_mthds`` signatures  → ``src/python.rs``
  - ``Diagnostic`` / ``Range`` / kind values      → ``src/diagnostic.rs``
  - ``format_mthds`` return fields                 → ``src/format.rs`` (``FormatOutcome``)
  - ``lint_mthds`` return field                    → ``src/python.rs`` (``LintOutput``)

Keys come from ``#[derive(Serialize)]`` field names handed to Python via
``pythonize`` (see ``src/python.rs::to_py``), so a Rust field rename is a
breaking change to these dict shapes.
"""

from typing import Literal, Optional, TypedDict

__all__ = [
    "format_mthds",
    "lint_mthds",
    "Diagnostic",
    "Range",
    "FormatResult",
    "LintResult",
]

class Range(TypedDict):
    """Mirror of ``Range`` in ``src/diagnostic.rs`` — byte offsets plus 1-based
    codespan-style line/column coordinates (matching the ``plxt`` CLI)."""

    start_offset: int
    end_offset: int
    start_line: int
    start_col: int
    end_line: int
    end_col: int

class Diagnostic(TypedDict):
    """Mirror of ``Diagnostic`` (+ ``DiagnosticKind``) in ``src/diagnostic.rs``.

    ``kind`` is the serde ``rename_all = "lowercase"`` form of ``DiagnosticKind``.
    ``location`` and ``range`` are always present (``None`` when absent) so the
    shape is stable.
    """

    kind: Literal["syntax", "semantic", "schema"]
    severity: str  # always "error" today; lint has no warnings yet
    message: str
    location: Optional[str]  # dotted instance path for schema errors, else None
    range: Optional[Range]  # None for semantic/schema errors with no position

class FormatResult(TypedDict):
    """Mirror of ``FormatOutcome`` in ``src/format.rs`` — the ``format_mthds`` return."""

    formatted: str
    changed: bool
    diagnostics: list[Diagnostic]

class LintResult(TypedDict):
    """Mirror of ``LintOutput`` in ``src/python.rs`` — the ``lint_mthds`` return."""

    diagnostics: list[Diagnostic]

def format_mthds(
    content: str,
    *,
    options: Optional[dict[str, object]] = ...,
) -> FormatResult:
    """Format MTHDS ``content`` with the canonical MTHDS defaults.

    Never raises for malformed ``.mthds`` (returns the input unchanged with
    blocking diagnostics); raises ``ValueError`` only for a malformed ``options``
    value (e.g. a non-numeric ``column_width``). See ``src/python.rs``.
    """
    ...

def lint_mthds(
    content: str,
    *,
    source: Optional[str] = ...,
) -> LintResult:
    """Lint MTHDS ``content`` against the embedded MTHDS schema, fully offline.

    Never raises for malformed ``.mthds`` (returns the diagnostics). ``source`` is
    accepted for API symmetry but not yet threaded into locators. See
    ``src/python.rs``.
    """
    ...
