// Locks in the import forms the README documents for the UMD-only bundle, in a
// REAL `node` child process: vitest's own module interop synthesizes named
// exports that native Node ESM does not, so an in-process `import` here would
// pass even when the documented consumer path is broken.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const distUrl = pathToFileURL(path.resolve(__dirname, "../dist/index.js")).href;

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { encoding: "utf-8" });
}

describe("native Node ESM consumers", () => {
  it("supports the documented default-import + destructure usage", () => {
    const result = runNode([path.join(__dirname, "esmConsumer.mjs")]);
    // stderr may carry a wasm-bindgen deprecation warning; only the exit
    // status decides, with stderr surfaced for debugging on failure.
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects named imports — why the README documents the default-import form", () => {
    // Node's cjs-module-lexer cannot see named exports through the minified
    // UMD wrapper. If this ever starts passing (e.g. a dual ESM build lands),
    // update the README/doc-comment to the named-import form and drop this.
    const result = runNode([
      "--input-type=module",
      "-e",
      `import { lintMthds } from ${JSON.stringify(distUrl)};`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Named export 'lintMthds' not found/);
  });
});
