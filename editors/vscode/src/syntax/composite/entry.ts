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

// Special highlighting for pipe step entries (pipe = "pipe_name")
const entryPipeStep = {
  name: "meta.entry.pipe-step.pml",
  match: `\\s*(pipe)\\s*(=)\\s*("([a-z][a-z0-9]*(?:_[a-z0-9]+)*)")`,
  captures: {
    1: {
      name: "support.type.property-name.pml",
    },
    2: {
      name: "punctuation.eq.pml",
    },
    3: {
      name: "string.quoted.double.pml",
    },
    4: {
      name: "support.function.pipe-name.pml",
    },
  },
};

// Special highlighting for variable assignments (result = "var_name", batch_as = "var_name", etc.)
const entryVariableAssignment = {
  name: "meta.entry.variable-assignment.pml",
  match: `\\s*(result|batch_as|batch_over)\\s*(=)\\s*("([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*)")`,
  captures: {
    1: {
      name: "support.type.property-name.pml",
    },
    2: {
      name: "punctuation.eq.pml",
    },
    3: {
      name: "string.quoted.double.pml",
    },
    4: {
      name: "variable.name.data.pml",
    },
  },
};

export const entryBegin = {
  patterns: [entryPipe, entryPipeStep, entryVariableAssignment, entryGeneral],
};
