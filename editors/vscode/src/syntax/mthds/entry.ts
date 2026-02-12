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

// 2. output = "ConceptType"
const outputEntry = {
  name: "meta.entry.output-type.mthds",
  match:
    '\\s*(output)\\s*(=)\\s*(")((?:[a-z][a-z0-9_]*\\.)?[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*)(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.type.concept.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 3. refines = "ConceptType"
const refinesEntry = {
  name: "meta.entry.refines-type.mthds",
  match:
    '\\s*(refines)\\s*(=)\\s*(")((?:[a-z][a-z0-9_]*\\.)?[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*)(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.type.concept.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 4. type = "PipeType" (NEW)
const typeEntry = {
  name: "meta.entry.type.mthds",
  match: '\\s*(type)\\s*(=)\\s*(")((?:[A-Za-z][A-Za-z0-9]*))(")',
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

// 10. pipe = "pipe_name" (NEW — colorize pipe name value in step objects)
const pipeRefEntry = {
  name: "meta.entry.pipe-ref.mthds",
  match: '\\s*(pipe)\\s*(=)\\s*(")((?:[a-z][a-z0-9_]*)(?:\\.[a-z][a-z0-9_]*)*)(")',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.function.pipe-name.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  },
};

// 11. Generic entry (fallback)
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

// Order matters — first match wins
export const entryBegin = {
  patterns: [
    pipeEntry,
    outputEntry,
    refinesEntry,
    typeEntry,
    modelEntry,
    jinja2Block,
    jinja2Line,
    promptBlock,
    promptLine,
    pipeRefEntry,
    genericEntry,
  ],
};
