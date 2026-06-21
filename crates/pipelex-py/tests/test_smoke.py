"""Smoke test for the built `pipelex_tools` extension module.

This is the e2e guard for the load-bearing coupling between three names that
must stay in lockstep: the `[lib] name` in Cargo.toml, the `#[pymodule]`
function name in src/python.rs, and the `PyInit_pipelex_tools` symbol PyO3
emits from them. If any of those drift, the wheel still *builds* but `import
pipelex_tools` raises `ImportError: dynamic module does not define module
export function`. No Rust-level check catches that — only importing the built
module does, which is what this test does.

Run against a `maturin develop`/`maturin build`-installed module:
    python -m unittest discover -s tests -p 'test_*.py'
"""

import unittest

import pipelex_tools


class SmokeTest(unittest.TestCase):
    def test_module_imports_and_ping_returns_module_name(self) -> None:
        # `ping()` returns the module name; asserting it both confirms the
        # function is wired into the module and pins the expected module name.
        self.assertEqual(pipelex_tools.ping(), "pipelex_tools")


if __name__ == "__main__":
    unittest.main()
