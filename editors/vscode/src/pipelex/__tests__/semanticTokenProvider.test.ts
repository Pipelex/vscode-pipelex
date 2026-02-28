import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- vscode mock ----------
// vi.mock is hoisted — factory must be self-contained (no references to outer variables)

vi.mock('vscode', () => {
  class SemanticTokensLegend {
    tokenTypes: string[];
    tokenModifiers: string[];
    constructor(tokenTypes: string[], tokenModifiers: string[]) {
      this.tokenTypes = tokenTypes;
      this.tokenModifiers = tokenModifiers;
    }
  }

  class SemanticTokensBuilder {
    tokens: any[] = [];
    legend: any;
    constructor(legend: any) {
      this.legend = legend;
    }
    push(line: number, char: number, length: number, tokenType: number, tokenModifiers: number = 0) {
      this.tokens.push({ line, char, length, tokenType, tokenModifiers });
    }
    build() {
      return { data: this.tokens };
    }
  }

  return { SemanticTokensLegend, SemanticTokensBuilder };
});

import { PipelexSemanticTokensProvider } from '../semanticTokenProvider';

// ---------- helpers ----------

interface PushedToken {
  line: number;
  char: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

// Token type indices (must match semanticTokenProvider.ts TOKEN_TYPES)
const TOKEN = {
  mthdsConcept: 0,
  mthdsPipeType: 1,
  mthdsDataVariable: 2,
  mthdsPipeName: 3,
  mthdsPipeSection: 4,
  mthdsConceptSection: 5,
  mthdsModelRef: 6,
} as const;

const DECLARATION_FLAG = 1; // 1 << 0

function makeDocument(lines: string[]) {
  return {
    lineCount: lines.length,
    lineAt: (n: number) => ({ text: lines[n] }),
  } as any;
}

const cancelToken = {} as any;

let provider: PipelexSemanticTokensProvider;

async function getTokens(lines: string[]): Promise<PushedToken[]> {
  const doc = makeDocument(lines);
  const result = await provider.provideDocumentSemanticTokens(doc, cancelToken);
  return (result as any).data;
}

// ---------- tests ----------

beforeEach(() => {
  provider = new PipelexSemanticTokensProvider();
});

describe('Table headers with declaration modifier', () => {
  it('colors [concept.FeatureAnalysis] with declaration flag', async () => {
    const tokens = await getTokens(['[concept.FeatureAnalysis]']);

    expect(tokens).toHaveLength(2);

    // "concept" keyword
    expect(tokens[0]).toEqual({
      line: 0,
      char: 1, // after '['
      length: 7, // "concept"
      tokenType: TOKEN.mthdsConceptSection,
      tokenModifiers: DECLARATION_FLAG,
    });

    // "FeatureAnalysis" name
    expect(tokens[1]).toEqual({
      line: 0,
      char: 9, // after "[concept."
      length: 15, // "FeatureAnalysis"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: DECLARATION_FLAG,
    });
  });

  it('colors [pipe.analyze_features] with declaration flag', async () => {
    const tokens = await getTokens(['[pipe.analyze_features]']);

    expect(tokens).toHaveLength(2);

    // "pipe" keyword
    expect(tokens[0]).toEqual({
      line: 0,
      char: 1,
      length: 4, // "pipe"
      tokenType: TOKEN.mthdsPipeSection,
      tokenModifiers: DECLARATION_FLAG,
    });

    // "analyze_features" name
    expect(tokens[1]).toEqual({
      line: 0,
      char: 6, // after "[pipe."
      length: 16, // "analyze_features"
      tokenType: TOKEN.mthdsPipeName,
      tokenModifiers: DECLARATION_FLAG,
    });
  });

  it('colors [concept] alone (no name part)', async () => {
    const tokens = await getTokens(['[concept]']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 1,
      length: 7,
      tokenType: TOKEN.mthdsConceptSection,
      tokenModifiers: DECLARATION_FLAG,
    });
  });

  it('colors [pipe] alone (no name part)', async () => {
    const tokens = await getTokens(['[pipe]']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 1,
      length: 4,
      tokenType: TOKEN.mthdsPipeSection,
      tokenModifiers: DECLARATION_FLAG,
    });
  });

  it('handles leading whitespace in table headers', async () => {
    const tokens = await getTokens(['  [concept.Name]']);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 3, // 2 spaces + '['
      length: 7,
      tokenType: TOKEN.mthdsConceptSection,
      tokenModifiers: DECLARATION_FLAG,
    });
    expect(tokens[1]).toEqual({
      line: 0,
      char: 11, // 2 spaces + '[' + 'concept' + '.'
      length: 4, // "Name"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: DECLARATION_FLAG,
    });
  });
});

describe('Output/refines concept references (no modifier)', () => {
  it('colors output = "FeatureAnalysis"', async () => {
    const tokens = await getTokens(['output = "FeatureAnalysis"']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 10, // len('output = "')
      length: 15, // "FeatureAnalysis"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors refines = "images.ImgGenPrompt" — concept only (domain handled by grammar)', async () => {
    const tokens = await getTokens(['refines = "images.ImgGenPrompt"']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 18, // len('refines = "images.')
      length: 12, // "ImgGenPrompt"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors output = "Text[]" — concept only, ignores multiplicity', async () => {
    const tokens = await getTokens(['output = "Text[]"']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 10, // len('output = "')
      length: 4, // "Text"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors output = "legal.Contract" — concept only (domain handled by grammar)', async () => {
    const tokens = await getTokens(['output = "legal.Contract"']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 16, // len('output = "legal.')
      length: 8, // "Contract"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors output with trailing comment', async () => {
    const tokens = await getTokens(['output = "FeatureAnalysis" # comment']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 10,
      length: 15,
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors output with leading whitespace', async () => {
    const tokens = await getTokens(['    output = "Text"']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 14, // len('    output = "')
      length: 4, // "Text"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });
});

describe('Single-line inputs', () => {
  it('colors inputs = { photo = "native.Image" }', async () => {
    const tokens = await getTokens(['inputs = { photo = "native.Image" }']);

    expect(tokens).toHaveLength(2);

    // "photo" variable
    expect(tokens[0]).toEqual({
      line: 0,
      char: 11, // after 'inputs = { '
      length: 5, // "photo"
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });

    // "Image" concept type (domain "native" handled by grammar)
    expect(tokens[1]).toEqual({
      line: 0,
      char: 27, // after 'inputs = { photo = "native.'
      length: 5, // "Image"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors inputs = { names = "Text[]" } — variable + concept only', async () => {
    const tokens = await getTokens(['inputs = { names = "Text[]" }']);

    expect(tokens).toHaveLength(2);

    // "names" variable
    expect(tokens[0]).toEqual({
      line: 0,
      char: 11, // after 'inputs = { '
      length: 5, // "names"
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });

    // "Text" concept (not "Text[]")
    expect(tokens[1]).toEqual({
      line: 0,
      char: 20, // after 'inputs = { names = "'
      length: 4, // "Text"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors inputs = { contract = "legal.Contract" } — variable + concept only', async () => {
    const tokens = await getTokens(['inputs = { contract = "legal.Contract" }']);

    expect(tokens).toHaveLength(2);

    // "contract" variable
    expect(tokens[0]).toEqual({
      line: 0,
      char: 11, // after 'inputs = { '
      length: 8, // "contract"
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });

    // "Contract" concept only (domain "legal" handled by grammar)
    expect(tokens[1]).toEqual({
      line: 0,
      char: 29, // after 'inputs = { contract = "legal.'
      length: 8, // "Contract"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('colors multiple input entries', async () => {
    const tokens = await getTokens(['inputs = { a = "TypeA", b = "TypeB" }']);

    expect(tokens).toHaveLength(4);

    // "a" variable
    expect(tokens[0].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[0].length).toBe(1);

    // "TypeA" concept
    expect(tokens[1].tokenType).toBe(TOKEN.mthdsConcept);
    expect(tokens[1].length).toBe(5);

    // "b" variable
    expect(tokens[2].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[2].length).toBe(1);

    // "TypeB" concept
    expect(tokens[3].tokenType).toBe(TOKEN.mthdsConcept);
    expect(tokens[3].length).toBe(5);
  });
});

describe('Multi-line inputs (state machine)', () => {
  it('colors entries across multiple lines', async () => {
    const tokens = await getTokens([
      'inputs = {',
      '    photo = "native.Image",',
      '    text = "Text"',
      '}',
    ]);

    expect(tokens).toHaveLength(4);

    // Line 1: "photo" variable
    expect(tokens[0]).toEqual({
      line: 1,
      char: expect.any(Number),
      length: 5,
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });

    // Line 1: "Image" concept (domain "native" handled by grammar)
    expect(tokens[1]).toEqual({
      line: 1,
      char: expect.any(Number),
      length: 5, // "Image" only
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });

    // Line 2: "text" variable
    expect(tokens[2]).toEqual({
      line: 2,
      char: expect.any(Number),
      length: 4,
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });

    // Line 2: "Text" concept
    expect(tokens[3]).toEqual({
      line: 2,
      char: expect.any(Number),
      length: 4,
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('stops tracking after closing brace', async () => {
    const tokens = await getTokens([
      'inputs = {',
      '    photo = "native.Image"',
      '}',
      'output = "Result"',
    ]);

    // Should have: photo var, native.Image concept, Result concept
    expect(tokens).toHaveLength(3);

    // Last token should be on line 3 (output line)
    expect(tokens[2]).toEqual({
      line: 3,
      char: 10, // len('output = "')
      length: 6, // "Result"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('does not enter multi-line state when closing brace is on the same line (with trailing comment)', async () => {
    const tokens = await getTokens([
      'inputs = { a = "TypeA" } # comment',
      'output = "FeatureAnalysis"',
    ]);

    // inputs line: a variable + TypeA concept (matched by multi-line fallback, which parses the content)
    // output line: FeatureAnalysis concept (must NOT be swallowed by multi-line state)
    expect(tokens).toHaveLength(3);

    expect(tokens[0].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[0].line).toBe(0);

    expect(tokens[1].tokenType).toBe(TOKEN.mthdsConcept);
    expect(tokens[1].line).toBe(0);

    expect(tokens[2]).toEqual({
      line: 1,
      char: 10,
      length: 15, // "FeatureAnalysis"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });

  it('does not enter multi-line state for empty inputs = {}', async () => {
    const tokens = await getTokens([
      'inputs = {}',
      'output = "Result"',
    ]);

    // inputs = {} has no entries inside
    // output line must still be processed
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 1,
      char: 10,
      length: 6, // "Result"
      tokenType: TOKEN.mthdsConcept,
      tokenModifiers: 0,
    });
  });
});

describe('Result variables', () => {
  it('colors result = "first_result"', async () => {
    const tokens = await getTokens(['{ pipe = "step_one", result = "first_result" }']);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      line: 0,
      char: 31, // position of "first_result" in the string
      length: 12,
      tokenType: TOKEN.mthdsDataVariable,
      tokenModifiers: 0,
    });
  });

  it('colors batch_over and batch_as variables', async () => {
    const tokens = await getTokens([
      '{ pipe = "step", batch_over = "items", batch_as = "item", result = "out" }',
    ]);

    expect(tokens).toHaveLength(3);

    // batch_over -> "items"
    expect(tokens[0].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[0].length).toBe(5); // "items"

    // batch_as -> "item"
    expect(tokens[1].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[1].length).toBe(4); // "item"

    // result -> "out"
    expect(tokens[2].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[2].length).toBe(3); // "out"
  });
});

describe('False positives (should produce NO tokens)', () => {
  it('does not color plain definition strings', async () => {
    const tokens = await getTokens(['definition = "Some description"']);
    expect(tokens).toHaveLength(0);
  });

  it('does not color structure field type = "text"', async () => {
    const tokens = await getTokens(['{ type = "text", required = true }']);
    expect(tokens).toHaveLength(0);
  });

  it('does not color lines inside template strings', async () => {
    const tokens = await getTokens([
      'prompt_template = """',
      'This is a template with @injection',
      'And $template_variable',
      '"""',
    ]);
    expect(tokens).toHaveLength(0);
  });

  it('does not color comment lines', async () => {
    const tokens = await getTokens(['# output = "SomeType"']);
    expect(tokens).toHaveLength(0);
  });

  it('does not color empty lines', async () => {
    const tokens = await getTokens(['', '  ', '']);
    expect(tokens).toHaveLength(0);
  });

  it('does not color generic table headers', async () => {
    const tokens = await getTokens(['[concept.FeatureAnalysis.structure]']);
    expect(tokens).toHaveLength(0);
  });
});

describe('Integration: multi-element document', () => {
  it('colors a complete pipe definition', async () => {
    const tokens = await getTokens([
      '[pipe.analyze_features]',
      'type = "PipeLLM"',
      'definition = "Analyze features"',
      'inputs = { photo = "native.Image" }',
      'output = "FeatureAnalysis"',
      'model = "$gpt-4o"',
    ]);

    // [pipe.analyze_features] -> pipe section + pipe name (both declaration)
    // inputs = { photo = "native.Image" } -> variable + concept
    // output = "FeatureAnalysis" -> concept
    // type, definition, model -> not handled by semantic provider
    expect(tokens).toHaveLength(5);

    // Pipe section header
    expect(tokens[0].tokenType).toBe(TOKEN.mthdsPipeSection);
    expect(tokens[0].tokenModifiers).toBe(DECLARATION_FLAG);

    expect(tokens[1].tokenType).toBe(TOKEN.mthdsPipeName);
    expect(tokens[1].tokenModifiers).toBe(DECLARATION_FLAG);

    // Input variable
    expect(tokens[2].tokenType).toBe(TOKEN.mthdsDataVariable);
    expect(tokens[2].line).toBe(3);

    // Input concept type
    expect(tokens[3].tokenType).toBe(TOKEN.mthdsConcept);
    expect(tokens[3].line).toBe(3);

    // Output concept
    expect(tokens[4].tokenType).toBe(TOKEN.mthdsConcept);
    expect(tokens[4].line).toBe(4);
  });

  it('colors a sequence pipe with steps', async () => {
    const tokens = await getTokens([
      '[pipe.gen_sequence]',
      'type = "PipeSequence"',
      'inputs = { data = "InputData" }',
      'output = "FinalResult"',
      'steps = [',
      '    { pipe = "step_one", result = "first_result" },',
      '    { pipe = "step_two", batch_over = "items", batch_as = "item", result = "second_result" },',
      ']',
    ]);

    // Table header: pipe section + pipe name
    // inputs: variable + concept
    // output: concept
    // step_one result: variable
    // step_two: batch_over + batch_as + result = 3 variables
    // Total: 2 + 2 + 1 + 1 + 3 = 9
    expect(tokens).toHaveLength(9);

    // Verify step result tokens
    const stepTokens = tokens.filter(t => t.line >= 5);
    expect(stepTokens).toHaveLength(4);
    expect(stepTokens.every(t => t.tokenType === TOKEN.mthdsDataVariable)).toBe(true);
  });
});

describe('getSemanticTokensLegend', () => {
  it('returns the correct legend', () => {
    const legend = provider.getSemanticTokensLegend();

    expect(legend.tokenTypes).toEqual([
      'mthdsConcept',
      'mthdsPipeType',
      'mthdsDataVariable',
      'mthdsPipeName',
      'mthdsPipeSection',
      'mthdsConceptSection',
      'mthdsModelRef',
    ]);
    expect(legend.tokenModifiers).toEqual(['declaration']);
  });
});
