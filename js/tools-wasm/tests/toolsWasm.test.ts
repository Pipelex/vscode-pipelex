// Tests for the @pipelex/tools-wasm binding + serialization layer, run against
// the BUILT bundle (dist/index.js) — `yarn build` first (the Makefile target
// does). Rust-level correctness (staging, dedup, CLI parity) is covered by the
// shared-impl tests and `pipelex-cli`'s parity suite; what these guard is the
// JS-facing surface: the wire shapes coming out of serde-wasm-bindgen, the
// options marshalling, and the corpus outputs pinned as committed snapshots.
//
// The bundle is loaded via `createRequire` (it is a UMD build), so this file
// exercises exactly what a Node consumer gets.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type {
  Diagnostic,
  FormatResult,
  LintResult,
  FormatMthdsOptions,
} from "../src/index";

const require = createRequire(import.meta.url);
const tools = require("../dist/index.js") as {
  initialize(): Promise<void>;
  lintMthds(content: string): LintResult;
  formatMthds(content: string, options?: FormatMthdsOptions): FormatResult;
};

/** Repo root, resolved from this package dir (`<root>/js/tools-wasm`). */
const repoRoot = path.resolve(__dirname, "../../..");
const corpusDir = path.join(repoRoot, "test-data/mthds");

/**
 * Every `.mthds` fixture under `test-data/mthds/`, recursively — the same
 * corpus discovery as `pipelex-cli`'s parity suite, so a fixture added in any
 * subdirectory is snapshot-pinned here automatically.
 */
function mthdsFixtures(): string[] {
  return readdirSync(corpusDir, { recursive: true, encoding: "utf-8" })
    .filter((entry) => entry.endsWith(".mthds"))
    .sort()
    .map((entry) => path.join(corpusDir, entry));
}

beforeAll(async () => {
  await tools.initialize();
  // Idempotent: a second call must be a cheap no-op, not a reload or a throw.
  await tools.initialize();
});

describe("corpus snapshots (committed expected outputs)", () => {
  for (const fixture of mthdsFixtures()) {
    const name = path.relative(corpusDir, fixture);

    it(`lint ${name}`, () => {
      const content = readFileSync(fixture, "utf-8");
      expect(tools.lintMthds(content).diagnostics).toMatchSnapshot();
    });

    it(`format ${name}`, () => {
      const content = readFileSync(fixture, "utf-8");
      const result = tools.formatMthds(content);
      expect(result).toMatchSnapshot();
      // Whatever the snapshot pins, `changed` must agree with the text delta.
      expect(result.changed).toBe(result.formatted !== content);
    });
  }
});

describe("lint wire shape", () => {
  it("returns no diagnostics on a valid document", () => {
    const content = readFileSync(
      path.join(corpusDir, "lint/valid.mthds"),
      "utf-8"
    );
    expect(tools.lintMthds(content)).toEqual({ diagnostics: [] });
  });

  it("reports schema diagnostics with the full Diagnostic shape", () => {
    const content = readFileSync(
      path.join(corpusDir, "lint/invalid_schema.mthds"),
      "utf-8"
    );
    const { diagnostics } = tools.lintMthds(content);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.kind).toBe("schema");
      expect(diagnostic.severity).toBe("error");
      expect(typeof diagnostic.message).toBe("string");
      // location/range are part of the wire shape even when null — the
      // JSON-compatible serializer must not drop them as `undefined`.
      expect(Object.keys(diagnostic).sort()).toEqual([
        "kind",
        "location",
        "message",
        "range",
        "severity",
      ]);
    }
  });

  it("reports a syntax error with a range and a null location", () => {
    const { diagnostics } = tools.lintMthds("key = ");
    expect(diagnostics.length).toBeGreaterThan(0);
    const diagnostic: Diagnostic = diagnostics[0];
    expect(diagnostic.kind).toBe("syntax");
    expect(diagnostic.location).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(diagnostic, "location")).toBe(
      true
    );
    expect(diagnostic.range).toMatchObject({
      start_offset: expect.any(Number),
      end_offset: expect.any(Number),
      start_line: expect.any(Number),
      start_col: expect.any(Number),
      end_line: expect.any(Number),
      end_col: expect.any(Number),
    });
  });

  it("reports duplicate keys as a semantic error", () => {
    const { diagnostics } = tools.lintMthds("a = 1\na = 2\n");
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.kind).toBe("semantic");
    }
  });

  it("returns plain JSON-compatible objects, not Maps", () => {
    const { diagnostics } = tools.lintMthds("key = ");
    expect(diagnostics[0]).not.toBeInstanceOf(Map);
    expect(JSON.parse(JSON.stringify(diagnostics[0]))).toEqual(diagnostics[0]);
  });
});

describe("format", () => {
  it("canonicalizes unaligned entries (the parity suite's hermetic case)", () => {
    const result = tools.formatMthds("a = 1\nbb = 2\n");
    expect(result).toEqual({
      formatted: "a  = 1\nbb = 2\n",
      changed: true,
      diagnostics: [],
    });
  });

  it("reports already-canonical input as unchanged", () => {
    const result = tools.formatMthds("a  = 1\nbb = 2\n");
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe("a  = 1\nbb = 2\n");
  });

  it("echoes back malformed input unchanged with diagnostics, without throwing", () => {
    const result = tools.formatMthds("key = ");
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe("key = ");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].kind).toBe("syntax");
  });

  it("applies boolean and number option overrides", () => {
    // align_entries=false switches off the canonical alignment.
    const unaligned = tools.formatMthds("a = 1\nbb = 2\n", {
      align_entries: false,
    });
    expect(unaligned.formatted).toBe("a = 1\nbb = 2\n");
    expect(unaligned.changed).toBe(false);
    // A numeric column_width is stringified and accepted like `-o key=value`.
    const narrow = tools.formatMthds("a = 1\n", { column_width: 30 });
    expect(narrow.diagnostics).toEqual([]);
  });

  it("throws on a non-primitive option value, naming the key", () => {
    expect(() =>
      tools.formatMthds("a = 1\n", { column_width: [80] as any })
    ).toThrow(/column_width/);
  });

  it("throws on an unparseable option value", () => {
    expect(() =>
      tools.formatMthds("a = 1\n", { column_width: "not-a-number" })
    ).toThrow();
  });
});
