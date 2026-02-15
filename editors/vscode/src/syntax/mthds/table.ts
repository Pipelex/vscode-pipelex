const BARE_KEY = `(?:[A-Za-z0-9_+-]+)`;
const QUOTED_KEY = `(?:"[^"]+")|(?:'[^']+')`;
const ANY_KEY = `(?:${BARE_KEY})|${QUOTED_KEY}`;

// Concept table: [concept.PascalName]
// Tightened: concept name must start with uppercase letter
const conceptTable = {
  name: "meta.table.concept.mthds",
  match: `^\\s*(\\[)\\s*(concept(?:\\.[A-Z][A-Za-z0-9]*)?)\\s*(\\])`,
  captures: {
    1: {
      name: "punctuation.definition.table.mthds",
    },
    2: {
      patterns: [
        {
          match: "concept",
          name: "support.type.property-name.concept.mthds",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.mthds",
        },
        {
          match: "[A-Z][A-Za-z0-9]*",
          name: "support.type.property-name.concept.mthds",
        },
      ],
    },
    3: {
      name: "punctuation.definition.table.mthds",
    },
  },
};

// Pipe table: [pipe.snake_name]
// Tightened: pipe name must start with lowercase, only lowercase/digits/underscores
const pipeTable = {
  name: "meta.table.pipe.mthds",
  match: `^\\s*(\\[)\\s*(pipe(?:\\.[a-z][a-z0-9_]*)?)\\s*(\\])`,
  captures: {
    1: {
      name: "punctuation.definition.table.mthds",
    },
    2: {
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
          match: "[a-z][a-z0-9_]*",
          name: "support.type.property-name.pipe.mthds",
        },
      ],
    },
    3: {
      name: "punctuation.definition.table.mthds",
    },
  },
};

// Generic table: [key.key] — for sub-tables like [concept.Name.structure]
const genericTable = {
  name: "meta.table.mthds",
  match: `^\\s*(\\[)\\s*((?:(?:${ANY_KEY})\\s*\\.?\\s*)+)\\s*(\\])`,
  captures: {
    1: {
      name: "punctuation.definition.table.mthds",
    },
    2: {
      patterns: [
        {
          match: ANY_KEY,
          name: "support.type.property-name.table.mthds",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.mthds",
        },
      ],
    },
    3: {
      name: "punctuation.definition.table.mthds",
    },
  },
};

// Array table: [[key.key]]
const arrayTable = {
  name: "meta.array.table.mthds",
  match: `^\\s*(\\[\\[)\\s*((?:(?:${ANY_KEY})\\s*\\.?\\s*)+)\\s*(\\]\\])`,
  captures: {
    1: {
      name: "punctuation.definition.array.table.mthds",
    },
    2: {
      patterns: [
        {
          match: ANY_KEY,
          name: "support.type.property-name.array.mthds",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.mthds",
        },
      ],
    },
    3: {
      name: "punctuation.definition.array.table.mthds",
    },
  },
};

// Inline table: { ... }
const inlineTable = {
  begin: "(\\{)",
  end: "(\\})",
  name: "meta.table.inline.mthds",
  beginCaptures: {
    1: {
      name: "punctuation.definition.table.inline.mthds",
    },
  },
  endCaptures: {
    1: {
      name: "punctuation.definition.table.inline.mthds",
    },
  },
  patterns: [
    {
      include: "#comment",
    },
    {
      match: ",",
      name: "punctuation.separator.table.inline.mthds",
    },
    {
      include: "#entryBegin",
    },
    {
      include: "#value",
    },
  ],
};

export const table = {
  patterns: [conceptTable, pipeTable, genericTable, arrayTable, inlineTable],
};
