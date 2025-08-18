const escape = [
  {
    match: '\\\\([btnfr"\\\\\\n/ ]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})',
    name: "constant.character.escape.pml",
  },
  {
    match: '\\\\[^btnfr/"\\\\\\n]',
    name: "invalid.illegal.escape.pml",
  },
];

const stringSingle = {
  name: "string.quoted.single.basic.line.pml",
  begin: '"',
  end: '"',
  patterns: escape,
};

const stringBlock = {
  name: "string.quoted.triple.basic.block.pml",
  begin: '"""',
  end: '"""',
  patterns: escape,
};

// do not need escape characters
const literalStringSingle = {
  name: "string.quoted.single.literal.line.pml",
  begin: "'",
  end: "'",
};

const literalStringBlock = {
  name: "string.quoted.triple.literal.block.pml",
  begin: "'''",
  end: "'''",
};

// ordered, block must be before single
export const string = [
  stringBlock,
  stringSingle,
  literalStringBlock,
  literalStringSingle,
];
