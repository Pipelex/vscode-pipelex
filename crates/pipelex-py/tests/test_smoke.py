"""Smoke test for the built `pipelex_tools` extension module.

This is the e2e guard for the load-bearing coupling between three names that
must stay in lockstep: the `[lib] name` in Cargo.toml, the `#[pymodule]`
function name in src/python.rs, and the `PyInit_pipelex_tools` symbol PyO3
emits from them. If any of those drift, the wheel still *builds* but `import
pipelex_tools` raises `ImportError: dynamic module does not define module
export function`. No Rust-level check catches that — only importing the built
module does.

The `import pipelex_tools` below IS the desync guard: it fails to import on a
`[lib] name`/`#[pymodule]`/`PyInit_` mismatch. The assertions then pin the
module's identity (`__name__`) and confirm the `#[pymodule]` actually wired its
function in (`ping`) rather than producing an empty module.

Run against a `maturin develop`/`maturin build`-installed module:
    python -m unittest discover -s tests -p 'test_*.py'
"""

import unittest

import pipelex_tools


class SmokeTest(unittest.TestCase):
    def test_module_name(self) -> None:
        # The module Python actually loaded resolves to the expected name; a
        # `[lib] name` rename that desynced from the import would have already
        # failed the import above, but this also guards an accidental rename of
        # the import line here without updating the build.
        self.assertEqual(pipelex_tools.__name__, "pipelex_tools")

    def test_pymodule_registered_its_function(self) -> None:
        # Proves `#[pymodule]` ran `m.add_function(...)` — the module is not an
        # empty shell. `ping()` returns a hardcoded literal, so this asserts
        # function *registration*, not module identity (that's `__name__` above).
        self.assertEqual(pipelex_tools.ping(), "pipelex_tools")


if __name__ == "__main__":
    unittest.main()
