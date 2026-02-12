// String escape patterns
export const stringEscapes = {
  patterns: [
    {
      match: '\\\\([btnfr"\\\\\\n/ ]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})',
      name: "constant.character.escape.mthds",
    },
    {
      match: '\\\\[^btnfr/"\\\\\\n]',
      name: "invalid.illegal.escape.mthds",
    },
  ],
};

// Block basic strings (""" ... """)
// Includes jinja, html, escapes, and injection/variable via #include refs
const stringBlock = {
  name: "string.quoted.triple.basic.block.mthds",
  begin: '"""',
  end: '"""',
  patterns: [
    { include: "#jinjaTemplateContent" },
    { include: "#htmlContent" },
    { include: "#stringEscapes" },
    { include: "#dataInjection" },
    { include: "#templateVariable" },
  ],
};

// Single basic strings (" ... ")
const stringSingle = {
  name: "string.quoted.single.basic.line.mthds",
  begin: '"',
  end: '"',
  patterns: [
    { include: "#jinjaTemplateContent" },
    { include: "#htmlContent" },
    { include: "#stringEscapes" },
    { include: "#dataInjection" },
    { include: "#templateVariable" },
  ],
};

// Literal strings — NO child patterns (raw text per TOML spec)
const literalStringBlock = {
  name: "string.quoted.triple.literal.block.mthds",
  begin: "'''",
  end: "'''",
};

const literalStringSingle = {
  name: "string.quoted.single.literal.line.mthds",
  begin: "'",
  end: "'",
};

// Datetime patterns
const offsetDateTime = {
  captures: {
    1: {
      name: "constant.other.time.datetime.offset.mthds",
    },
  },
  match:
    "(?<!\\w)(\\d{4}\\-\\d{2}\\-\\d{2}[T| ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[\\+\\-]\\d{2}:\\d{2}))(?!\\w)",
};

const localDateTime = {
  captures: {
    1: {
      name: "constant.other.time.datetime.local.mthds",
    },
  },
  match: "(\\d{4}\\-\\d{2}\\-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)",
};

const localDate = {
  name: "constant.other.time.date.mthds",
  match: "\\d{4}\\-\\d{2}\\-\\d{2}",
};

const localTime = {
  name: "constant.other.time.time.mthds",
  match: "\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?",
};

// Boolean
const boolean = {
  match: "(?<!\\w)(true|false)(?!\\w)",
  captures: {
    1: {
      name: "constant.language.boolean.mthds",
    },
  },
};

// Numbers (float before integer)
const float = {
  match:
    "(?<!\\w)([\\+\\-]?(0|([1-9](([0-9]|_[0-9])+)?))(?:(?:\\.([0-9]+))?[eE][\\+\\-]?[1-9]_?[0-9]*|(?:\\.[0-9_]*)))(?!\\w)",
  captures: {
    1: {
      name: "constant.numeric.float.mthds",
    },
  },
};

const integer = {
  match: "(?<!\\w)((?:[\\+\\-]?(0|([1-9](([0-9]|_[0-9])+)?))))(?!\\w)",
  captures: {
    1: {
      name: "constant.numeric.integer.mthds",
    },
  },
};

const inf = {
  match: "(?<!\\w)([\\+\\-]?inf)(?!\\w)",
  captures: {
    1: {
      name: "constant.numeric.inf.mthds",
    },
  },
};

const nan = {
  match: "(?<!\\w)([\\+\\-]?nan)(?!\\w)",
  captures: {
    1: {
      name: "constant.numeric.nan.mthds",
    },
  },
};

const hex = {
  match:
    "(?<!\\w)((?:0x(([0-9a-fA-F](([0-9a-fA-F]|_[0-9a-fA-F])+)?))))(?!\\w)",
  captures: {
    1: {
      name: "constant.numeric.hex.mthds",
    },
  },
};

const oct = {
  match: /(?<!\w)(0o[0-7](_?[0-7])*)(?!\w)/.source,
  captures: {
    1: {
      name: "constant.numeric.oct.mthds",
    },
  },
};

const bin = {
  match: /(?<!\w)(0b[01](_?[01])*)(?!\w)/.source,
  captures: {
    1: {
      name: "constant.numeric.bin.mthds",
    },
  },
};

// Array
const array = {
  name: "meta.array.mthds",
  begin: "(?<!\\w)(\\[)\\s*",
  end: "\\s*(\\])(?!\\w)",
  beginCaptures: {
    1: {
      name: "punctuation.definition.array.mthds",
    },
  },
  endCaptures: {
    1: {
      name: "punctuation.definition.array.mthds",
    },
  },
  patterns: [
    {
      match: ",",
      name: "punctuation.separator.array.mthds",
    },
    {
      include: "#comment",
    },
    {
      include: "#value",
    },
  ],
};

// Inline table
const tableInline = {
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

// Assembled value: order matters (block before single, float before integer)
export const value = {
  patterns: ([] as any[]).concat(
    // Strings (block before single)
    stringBlock,
    stringSingle,
    literalStringBlock,
    literalStringSingle,
    // Datetime (offset before local)
    offsetDateTime,
    localDateTime,
    localDate,
    localTime,
    // Boolean
    boolean,
    // Numbers (float before integer, then special, then leading-zero)
    float,
    integer,
    inf,
    nan,
    hex,
    oct,
    bin,
    // Composites
    array,
    tableInline
  ),
};
