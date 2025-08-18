export const entryBegin = {
  name: "meta.entry.pml",
  match: `\\s*((?:(?:(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+'))\\s*\\.?\\s*)+)\\s*(=)`,
  captures: {
    1: {
      patterns: [
        {
          match: `(?:[A-Za-z0-9_+-]+)|(?:"[^"]+")|(?:'[^']+')`,
          name: "support.type.property-name.pml",
        },
        {
          match: "\\.",
          name: "punctuation.separator.dot.pml",
        },
      ],
    },
    2: {
      name: "punctuation.eq.pml",
    },
  },
};
