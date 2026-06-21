"""End-to-end smoke test for the built `pipelex_tools` extension module.

This runs against a `maturin develop`/`maturin build`-installed wheel and is the
e2e gate that catches packaging/ABI regressions a `cargo test` cannot: it
exercises the *shipped* module, asserting on the structured `diagnostics`
(`kind`, `range`, `location`) rather than just truthiness.

The `import pipelex_tools` below is also the desync guard for the load-bearing
coupling between the `[lib] name` in Cargo.toml, the `#[pymodule]` function name
in src/python.rs, and the `PyInit_pipelex_tools` symbol PyO3 emits — a mismatch
still *builds* but raises `ImportError` here.

Run against an installed module:
    python -m unittest discover -s tests -p 'test_*.py'
"""

import unittest

import pipelex_tools

VALID_MTHDS = """\
domain      = "test_lint"
description = "A minimal valid MTHDS file"

[concept]

[concept.Greeting]
description = "A simple greeting"

[pipe]

[pipe.say_hello]
type        = "PipeLLM"
description = "Generate a greeting"
output      = "Greeting"
model       = "$default"
"""

INVALID_SCHEMA_MTHDS = VALID_MTHDS.replace("PipeLLM", "UnknownPipeType")


class SmokeTest(unittest.TestCase):
    def test_module_identity(self) -> None:
        # A `[lib] name`/`#[pymodule]`/`PyInit_` desync would have failed the
        # import above; this also pins the loaded module's name.
        self.assertEqual(pipelex_tools.__name__, "pipelex_tools")

    def test_format_canonicalizes_unformatted_input(self) -> None:
        result = pipelex_tools.format_mthds("a=1")
        self.assertEqual(result["formatted"], "a = 1\n")
        self.assertTrue(result["changed"])
        self.assertEqual(result["diagnostics"], [])

    def test_format_reports_no_change_on_canonical_input(self) -> None:
        result = pipelex_tools.format_mthds(VALID_MTHDS)
        self.assertFalse(result["changed"])
        self.assertEqual(result["formatted"], VALID_MTHDS)

    def test_format_options_override_baked_default(self) -> None:
        # The baked default aligns entries; an override turns it off.
        aligned = pipelex_tools.format_mthds("a = 1\nbb = 2\n")["formatted"]
        self.assertEqual(aligned, "a  = 1\nbb = 2\n")
        unaligned = pipelex_tools.format_mthds(
            "a = 1\nbb = 2\n", options={"align_entries": False}
        )["formatted"]
        self.assertEqual(unaligned, "a = 1\nbb = 2\n")

    def test_format_raises_value_error_on_malformed_option_value(self) -> None:
        # A non-numeric `column_width` can't parse as usize. This is the one
        # documented raising path — malformed *content* never raises, but a
        # malformed *option value* does (as ValueError).
        with self.assertRaises(ValueError):
            pipelex_tools.format_mthds("a = 1\n", options={"column_width": "wide"})

    def test_format_int_option_value_round_trips_and_takes_effect(self) -> None:
        # Non-bool option values round-trip through `str()`: an int `column_width`
        # is honored, not just accepted. A tight width wraps a wide array across
        # lines; a loose width keeps it inline — proving the value is applied.
        wide_array = "a = [100, 200, 300, 400, 500, 600, 700, 800]\n"
        tight = pipelex_tools.format_mthds(wide_array, options={"column_width": 10})
        loose = pipelex_tools.format_mthds(wide_array, options={"column_width": 200})
        self.assertNotEqual(tight["formatted"], loose["formatted"])
        self.assertGreater(
            tight["formatted"].count("\n"),
            loose["formatted"].count("\n"),
            "a tight column_width should wrap the array onto more lines",
        )

    def test_format_does_not_raise_on_syntax_error(self) -> None:
        result = pipelex_tools.format_mthds("key = ")
        self.assertFalse(result["changed"])
        self.assertEqual(result["formatted"], "key = ")
        self.assertTrue(result["diagnostics"])
        diag = result["diagnostics"][0]
        self.assertEqual(diag["kind"], "syntax")
        self.assertEqual(diag["severity"], "error")
        self.assertIsNotNone(diag["range"])

    def test_lint_clean_input_has_no_diagnostics(self) -> None:
        result = pipelex_tools.lint_mthds(VALID_MTHDS)
        self.assertEqual(result["diagnostics"], [])

    def test_lint_reports_schema_error_with_location(self) -> None:
        result = pipelex_tools.lint_mthds(INVALID_SCHEMA_MTHDS)
        diagnostics = result["diagnostics"]
        self.assertTrue(diagnostics)
        self.assertTrue(all(d["kind"] == "schema" for d in diagnostics))
        self.assertTrue(any(d["location"] for d in diagnostics))

    def test_lint_reports_syntax_error(self) -> None:
        result = pipelex_tools.lint_mthds("key = ")
        self.assertTrue(result["diagnostics"])
        self.assertEqual(result["diagnostics"][0]["kind"], "syntax")

    def test_lint_reports_semantic_error(self) -> None:
        # Duplicate keys parse cleanly but fail DOM validation.
        result = pipelex_tools.lint_mthds("a = 1\na = 2\n")
        self.assertTrue(result["diagnostics"])
        self.assertEqual(result["diagnostics"][0]["kind"], "semantic")

    def test_lint_accepts_source_kwarg(self) -> None:
        # `source` is accepted for API symmetry (a reserved locator); today it's
        # a no-op, so passing it must not change the verdict on clean input.
        result = pipelex_tools.lint_mthds(VALID_MTHDS, source="greeting.mthds")
        self.assertEqual(result["diagnostics"], [])

    def test_diagnostic_range_has_one_based_coords(self) -> None:
        diag = pipelex_tools.lint_mthds("key = ")["diagnostics"][0]
        rng = diag["range"]
        self.assertEqual(rng["start_line"], 1)
        self.assertIn("start_col", rng)
        self.assertIn("start_offset", rng)


if __name__ == "__main__":
    unittest.main()
