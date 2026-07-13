// The pre-initialize guard, on a FRESH module instance: the require cache is
// busted first so this stays deterministic even if the worker already loaded
// (and initialized) the bundle for another test file.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("uninitialized module", () => {
  it("throws a clear error when used before initialize()", () => {
    const bundlePath = require.resolve("../dist/index.js");
    delete require.cache[bundlePath];
    const fresh = require(bundlePath);
    expect(() => fresh.lintMthds("a = 1\n")).toThrow(/initialize/);
    expect(() => fresh.formatMthds("a = 1\n")).toThrow(/initialize/);
  });
});
