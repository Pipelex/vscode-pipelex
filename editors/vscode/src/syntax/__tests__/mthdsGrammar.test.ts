import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRAMMAR_PATH = path.resolve(__dirname, '../../../mthds.tmLanguage.json');
const WASM_PATH = path.resolve(
  __dirname,
  '../../../node_modules/vscode-oniguruma/release/onig.wasm',
);

let registry: vsctm.Registry;
let grammar: vsctm.IGrammar;

/** Tokenize a single line using the loaded MTHDS grammar. */
function tokenizeLine(line: string) {
  const result = grammar.tokenizeLine(line, vsctm.INITIAL);
  return result.tokens;
}

/**
 * Find every token whose scopes include `scope` and return the matched text
 * fragments together with their full scope list.
 */
function findTokensByScope(line: string, scope: string) {
  const tokens = tokenizeLine(line);
  return tokens
    .filter((t) => t.scopes.some((s) => s.includes(scope)))
    .map((t) => ({
      text: line.substring(t.startIndex, t.endIndex),
      scopes: t.scopes,
    }));
}

// ---------------------------------------------------------------------------
// Setup — load Oniguruma WASM and create the TextMate registry once.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const wasmBin = fs.readFileSync(WASM_PATH).buffer;
  await oniguruma.loadWASM(wasmBin);

  registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) =>
        new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      if (scopeName === 'source.mthds') {
        const grammarJson = fs.readFileSync(GRAMMAR_PATH, 'utf-8');
        return vsctm.parseRawGrammar(grammarJson, GRAMMAR_PATH);
      }
      return null;
    },
  });

  const g = await registry.loadGrammar('source.mthds');
  if (!g) throw new Error('Failed to load MTHDS grammar');
  grammar = g;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MTHDS TextMate grammar — pipe ref patterns', () => {
  // 1. Bare pipe ref
  it('tokenizes a bare pipe ref', () => {
    const line = 'pipe = "extract_invoice"';

    const pipeKey = findTokensByScope(line, 'support.type.property-name');
    expect(pipeKey.length).toBeGreaterThan(0);
    expect(pipeKey[0].text).toBe('pipe');

    const pipeName = findTokensByScope(line, 'support.function.pipe-name.mthds');
    expect(pipeName.length).toBe(1);
    expect(pipeName[0].text).toBe('extract_invoice');
  });

  // 2. Domain pipe ref
  it('tokenizes a domain-qualified pipe ref', () => {
    const line = 'pipe = "documents.extraction.extract_invoice"';

    const domain = findTokensByScope(line, 'entity.other.pipe-domain.mthds');
    expect(domain.length).toBe(1);
    expect(domain[0].text).toBe('documents.extraction');

    const dot = findTokensByScope(line, 'punctuation.separator.dot.mthds');
    expect(dot.length).toBe(1);
    expect(dot[0].text).toBe('.');

    const pipeName = findTokensByScope(line, 'support.function.pipe-name.mthds');
    expect(pipeName.length).toBe(1);
    expect(pipeName[0].text).toBe('extract_invoice');
  });

  // 3. Full package ref (with domain)
  it('tokenizes a full package pipe ref with domain', () => {
    const line =
      'pipe = "github.com/Pipelex/methods/documents->documents.extraction.extract_page_contents_and_views"';

    const pkgAddr = findTokensByScope(line, 'entity.name.package-address.mthds');
    expect(pkgAddr.length).toBe(2);
    expect(pkgAddr[0].text).toBe('github.com/Pipelex/methods');
    expect(pkgAddr[1].text).toBe('/documents');

    const arrow = findTokensByScope(
      line,
      'punctuation.separator.pipe-ref-arrow.mthds',
    );
    expect(arrow.length).toBe(1);
    expect(arrow[0].text).toBe('->');

    const domain = findTokensByScope(line, 'entity.other.pipe-domain.mthds');
    expect(domain.length).toBe(1);
    expect(domain[0].text).toBe('documents.extraction');

    const dot = findTokensByScope(line, 'punctuation.separator.dot.mthds');
    expect(dot.length).toBe(1);
    expect(dot[0].text).toBe('.');

    const pipeName = findTokensByScope(line, 'support.function.pipe-name.mthds');
    expect(pipeName.length).toBe(1);
    expect(pipeName[0].text).toBe('extract_page_contents_and_views');
  });

  // 4. Package ref without domain
  it('tokenizes a package pipe ref without domain', () => {
    const line =
      'pipe = "github.com/Pipelex/methods/documents->extract_invoice"';

    const domain = findTokensByScope(line, 'entity.other.pipe-domain.mthds');
    expect(domain.length).toBe(0);

    const dot = findTokensByScope(line, 'punctuation.separator.dot.mthds');
    expect(dot.length).toBe(0);

    const pipeName = findTokensByScope(line, 'support.function.pipe-name.mthds');
    expect(pipeName.length).toBe(1);
    expect(pipeName[0].text).toBe('extract_invoice');
  });
});
