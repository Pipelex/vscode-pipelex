// Native-ESM consumer smoke script, executed by esmConsumer.test.ts in a real
// `node` process — vitest transpiles its own imports, which would mask the
// UMD/ESM interop this exercises. This is the README's documented native-ESM
// usage: default-import the UMD bundle, then destructure. It exits non-zero on
// any failed assertion.
import assert from "node:assert/strict";

import pkg from "../dist/index.js";

const { initialize, lintMthds, formatMthds } = pkg;

assert.equal(typeof initialize, "function");
assert.equal(typeof lintMthds, "function");
assert.equal(typeof formatMthds, "function");

await initialize();

const { diagnostics } = lintMthds("key = ");
assert.ok(diagnostics.length > 0);
assert.equal(diagnostics[0].kind, "syntax");

const result = formatMthds("a = 1\nbb = 2\n");
assert.deepEqual(result, {
  formatted: "a  = 1\nbb = 2\n",
  changed: true,
  diagnostics: [],
});
