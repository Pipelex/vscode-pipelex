// Special highlighting for pipe entries and direct children at root level
const entryPipe = {
  name: "meta.entry.pipe.pml",
  match: `^\\s*(pipe(?:\\.(?:[A-Za-z0-9_+-]+|"[^"]+"|'[^']+'))?)\\s*(=)`,
  captures: {
    1: {
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
    2: {
      name: "punctuation.eq.pml",
    },
  },
};

const entryGeneral = {
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

export const entryBegin = {
  patterns: [entryPipe, entryGeneral],
};
