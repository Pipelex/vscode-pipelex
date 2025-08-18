// Special highlighting for pipe table headers and direct children
const tablePipe = {
  name: "meta.table.pipe.pml",
  match: `^\\s*(\\[)\\s*(pipe(?:\\.(?:[A-Za-z0-9_+-]+|"[^"]+"|'[^']+'))?)\\s*(\\])`,
  captures: {
    1: {
      name: "punctuation.definition.table.pml",
    },
    2: {
      patterns: [
        {
          match: "pipe",
          name: "support.type.property-name.pipe.pml",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.pml",
        },
        {
          match: "(?:[A-Za-z0-9_+-]+)|(?:\"[^\"]+\")|(?:'[^']+')",
          name: "support.type.property-name.pipe.pml",
        },
      ],
    },
    3: {
      name: "punctuation.definition.table.pml",
    },
  },
};

const tableBasic = {
  name: "meta.table.pml",
  match: `^\\s*(\\[)\\s*((?:(?:(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+'))\\s*\\.?\\s*)+)\\s*(\\])`,
  captures: {
    1: {
      name: "punctuation.definition.table.pml",
    },
    2: {
      patterns: [
        {
          match: `(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+')`,
          name: "support.type.property-name.table.pml",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.pml",
        },
      ],
    },
    3: {
      name: "punctuation.definition.table.pml",
    },
  },
};

const tableArray = {
  name: "meta.array.table.pml",
  match: `^\\s*(\\[\\[)\\s*((?:(?:(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+'))\\s*\\.?\\s*)+)\\s*(\\]\\])`,
  captures: {
    1: {
      name: "punctuation.definition.array.table.pml",
    },
    2: {
      patterns: [
        {
          match: `(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+')`,
          name: "support.type.property-name.array.pml",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.pml",
        },
      ],
    },
    3: {
      name: "punctuation.definition.array.table.pml",
    },
  },
};

export const tableInline = {
  begin: "(\\{)",
  end: "(\\})",
  name: "meta.table.inline.pml",
  beginCaptures: {
    1: {
      name: "punctuation.definition.table.inline.pml",
    },
  },
  endCaptures: {
    1: {
      name: "punctuation.definition.table.inline.pml",
    },
  },
  patterns: [
    {
      include: "#comment",
    },
    {
      match: ",",
      name: "punctuation.separator.table.inline.pml",
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
  patterns: [tablePipe, tableBasic, tableArray, tableInline],
};
