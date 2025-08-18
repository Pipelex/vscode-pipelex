export const array = {
  name: "meta.array.pml",
  begin: "(?<!\\w)(\\[)\\s*",
  end: "\\s*(\\])(?!\\w)",
  beginCaptures: {
    1: {
      name: "punctuation.definition.array.pml",
    },
  },
  endCaptures: {
    1: {
      name: "punctuation.definition.array.pml",
    },
  },
  patterns: [
    {
      match: ",",
      name: "punctuation.separator.array.pml",
    },
    {
      include: "#comment",
    },
    {
      include: "#value",
    },
  ],
};
