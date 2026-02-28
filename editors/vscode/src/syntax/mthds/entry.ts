const BARE_KEY = `(?:[A-Za-z0-9_+-]+)`;
const QUOTED_KEY = `(?:"[^"]+")|(?:'[^']+')`;
const ANY_KEY = `(?:${BARE_KEY})|${QUOTED_KEY}`;

// 1. pipe.name = (pipe entry)
const pipeEntry = {
  name: "meta.entry.pipe.mthds",
  match: `^\\s*(pipe(?:\\.(?:[A-Za-z0-9_+-]+|"[^"]+"|'[^']+'))?)\\s*(=)`,
  captures: {
    1: {
      patterns: [
        {
          match: "pipe",
          name: "support.type.property-name.pipe.mthds",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.mthds",
        },
        {
          match: `${ANY_KEY}`,
          name: "support.type.property-name.pipe.mthds",
        },
      ],
    },
    2: {
      name: "punctuation.eq.mthds",
    },
  },
};

// 2. output = "ConceptType" or "domain.ConceptType" or "ConceptType[]"
const outputEntry = {
  name: "meta.entry.output-type.mthds",
  match:
    '\\s*(output)\\s*(=)\\s*(")'
    + '(?:([a-z][a-z0-9_]*)(\\.))?' // domain + dot (optional)
    + '([A-Z][A-Za-z0-9]*)'         // ConceptName
    + '(\\[\\])?'                    // multiplicity [] (optional)
    + '(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "entity.other.pipe-domain.mthds" },
    5: { name: "punctuation.separator.dot.mthds" },
    6: { name: "support.type.concept.mthds" },
    7: { name: "punctuation.definition.multiplicity.mthds" },
    8: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 3. refines = "ConceptType" or "domain.ConceptType" or "ConceptType[]"
const refinesEntry = {
  name: "meta.entry.refines-type.mthds",
  match:
    '\\s*(refines)\\s*(=)\\s*(")'
    + '(?:([a-z][a-z0-9_]*)(\\.))?' // domain + dot (optional)
    + '([A-Z][A-Za-z0-9]*)'         // ConceptName
    + '(\\[\\])?'                    // multiplicity [] (optional)
    + '(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "entity.other.pipe-domain.mthds" },
    5: { name: "punctuation.separator.dot.mthds" },
    6: { name: "support.type.concept.mthds" },
    7: { name: "punctuation.definition.multiplicity.mthds" },
    8: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 4. type = "PipeType" (NEW)
const typeEntry = {
  name: "meta.entry.type.mthds",
  match: '\\s*(type)\\s*(=)\\s*(")(Pipe[A-Z][A-Za-z0-9]*)(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.type.pipe-type.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 5. model = "$sigil-ref"
const modelEntry = {
  name: "meta.entry.model.mthds",
  match: '\\s*(model)\\s*(=)\\s*(")([$@~])([a-zA-Z][a-zA-Z0-9_-]*)(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "punctuation.definition.model-sigil.mthds" },
    5: { name: "entity.name.model-ref.mthds" },
    6: { name: "punctuation.definition.string.end.mthds" },
  },
};

// Template string includes for jinja2 fields (with htmlContent)
const jinja2Includes = [
  { include: "#jinjaTemplateContent" },
  { include: "#htmlContent" },
  { include: "#stringEscapes" },
  { include: "#dataInjection" },
  { include: "#templateVariable" },
];

// Template string includes for prompt_template fields (NO htmlContent)
const promptIncludes = [
  { include: "#jinjaTemplateContent" },
  { include: "#stringEscapes" },
  { include: "#dataInjection" },
  { include: "#templateVariable" },
];

// 6. jinja2 = """...""" (block)
const jinja2Block = {
  name: "meta.entry.jinja2-template.mthds",
  begin: '\\s*(jinja2)\\s*(=)\\s*(""")',
  end: '(""")',
  beginCaptures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
  },
  endCaptures: {
    1: { name: "punctuation.definition.string.end.mthds" },
  },
  contentName: "string.quoted.triple.basic.block.jinja2.mthds",
  patterns: jinja2Includes,
};

// 7. jinja2 = "..." (single-line)
const jinja2Line = {
  name: "meta.entry.jinja2-template-line.mthds",
  begin: '\\s*(jinja2)\\s*(=)\\s*(")',
  end: '(")',
  beginCaptures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
  },
  endCaptures: {
    1: { name: "punctuation.definition.string.end.mthds" },
  },
  contentName: "string.quoted.single.basic.line.jinja2.mthds",
  patterns: jinja2Includes,
};

// 8. prompt_template = """...""" (block)
const promptBlock = {
  name: "meta.entry.prompt-template.mthds",
  begin: '\\s*(prompt_template)\\s*(=)\\s*(""")',
  end: '(""")',
  beginCaptures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
  },
  endCaptures: {
    1: { name: "punctuation.definition.string.end.mthds" },
  },
  contentName: "string.quoted.triple.basic.block.prompt.mthds",
  patterns: promptIncludes,
};

// 9. prompt_template = "..." (single-line)
const promptLine = {
  name: "meta.entry.prompt-template-line.mthds",
  begin: '\\s*(prompt_template)\\s*(=)\\s*(")',
  end: '(")',
  beginCaptures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
  },
  endCaptures: {
    1: { name: "punctuation.definition.string.end.mthds" },
  },
  contentName: "string.quoted.single.basic.line.prompt.mthds",
  patterns: promptIncludes,
};

// 10a. pipe = "host/Owner/repo/package->domain.pipe_code" (full package ref)
const pipeRefPackageEntry = {
  name: "meta.entry.pipe-ref-package.mthds",
  match:
    '\\s*(pipe)\\s*(=)\\s*(")'
    + '([a-z][a-z0-9.-]*(?:/[A-Za-z][A-Za-z0-9_-]*){2})' // repo: host/owner/repo
    + '(/[a-z][a-z0-9_]*)'                                 // /package
    + '(->)'                                                // arrow
    + '(?:([a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*)(\\.))?'  // domain + dot (optional)
    + '([a-z][a-z0-9_]*)'                                      // pipe_code
    + '(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "entity.name.package-address.mthds" },          // muted slate
    5: { name: "entity.name.package-address.mthds" },          // muted slate
    6: { name: "punctuation.separator.pipe-ref-arrow.mthds" }, // pink
    7: { name: "entity.other.pipe-domain.mthds" },             // mid-gray
    8: { name: "punctuation.separator.dot.mthds" },            // dot before pipe_code
    9: { name: "support.function.pipe-name.mthds" },           // coral bold
    10: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 10b. pipe = "domain.pipe_code" or pipe = "pipe_code" (local ref)
const pipeRefEntry = {
  name: "meta.entry.pipe-ref.mthds",
  match:
    '\\s*(pipe)\\s*(=)\\s*(")'
    + '(?:([a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*)(\\.))?'  // domain + dot (optional)
    + '([a-z][a-z0-9_]*)'                                     // pipe_code
    + '(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "entity.other.pipe-domain.mthds" },             // mid-gray (optional)
    5: { name: "punctuation.separator.dot.mthds" },             // dot before pipe_code
    6: { name: "support.function.pipe-name.mthds" },           // coral bold
    7: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 11. key = "domain.ConceptType[]" (concept-type value, catch-all for inputs etc.)
// Matches any lowercase key whose value looks like a concept type reference.
// Placed before genericEntry so it wins when the value is PascalCase.
const conceptValueEntry = {
  name: "meta.entry.concept-value.mthds",
  match:
    '\\s*([a-z][a-z0-9_]*)\\s*(=)\\s*(")'
    + '(?:([a-z][a-z0-9_]*)(\\.))?' // domain + dot (optional)
    + '([A-Z][A-Za-z0-9]*)'         // ConceptName
    + '(\\[\\])?'                    // multiplicity [] (optional)
    + '(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "entity.other.pipe-domain.mthds" },
    5: { name: "punctuation.separator.dot.mthds" },
    6: { name: "support.type.concept.mthds" },
    7: { name: "punctuation.definition.multiplicity.mthds" },
    8: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 12. Generic entry (fallback)
const genericEntry = {
  name: "meta.entry.mthds",
  match: `\\s*((?:(?:${ANY_KEY})\\s*\\.?\\s*)+)\\s*(=)`,
  captures: {
    1: {
      patterns: [
        {
          match: ANY_KEY,
          name: "support.type.property-name.mthds",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.mthds",
        },
      ],
    },
    2: {
      name: "punctuation.eq.mthds",
    },
  },
};

// Order matters — first match wins.
// Pipe ref entries must come before pipeEntry: they match the full
// `pipe = "value"` (more specific), while pipeEntry only matches `pipe =`.
export const entryBegin = {
  patterns: [
    pipeRefPackageEntry,
    pipeRefEntry,
    pipeEntry,
    outputEntry,
    refinesEntry,
    typeEntry,
    modelEntry,
    jinja2Block,
    jinja2Line,
    promptBlock,
    promptLine,
    conceptValueEntry,
    genericEntry,
  ],
};
