// Special highlighting for pipe entries and direct children at root level
const entryPipe = {
  name: "meta.entry.pipe.pml",
  match: `^\\s*(pipe(?:\\.(?:[A-Za-z0-9_+-]+|\"[^\"]+\"|'[^']+'))?)\\s*(=)`,
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
  match: `\\s*((?:(?:(?:[A-Za-z0-9_+-]+)|(?:\"[^\"]+\")|(?:'[^']+'))\\s*\\.?\\s*)+)\\s*(=)`,
  captures: {
    1: {
      patterns: [
        {
          match: `(?:[A-Za-z0-9_+-]+)|(?:\"[^\"]+\")|(?:'[^']+')`,
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
  match: `\\s*(pipe)\\s*(=)\\s*(\")( [a-z][a-z0-9]*(?:_[a-z0-9]+)* )(\")`.replace(/\s+/g, ""),
  captures: {
    1: { name: "support.type.property-name.pml" },
    2: { name: "punctuation.eq.pml" },
    3: { name: "punctuation.definition.string.begin.pml" },
    4: { name: "support.function.pipe-name.pml" },
    5: { name: "punctuation.definition.string.end.pml" },
  },
};

// Special highlighting for input parameter assignments (var_name = "ConceptType")
const entryInputParameter = {
  name: "meta.entry.input-parameter.pml",
  match: `\\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*)\\s*(=)\\s*(\")( (?:[a-z][a-z0-9_]*\\.)?[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)* )(\")`.replace(/\s+/g, ""),
  captures: {
    1: { name: "variable.name.data.pml" },
    2: { name: "punctuation.eq.pml" },
    3: { name: "punctuation.definition.string.begin.pml" },
    4: { name: "support.type.concept.pml" },
    5: { name: "punctuation.definition.string.end.pml" },
  },
};

// Special highlighting for output type (output = "ConceptType")
const entryOutputType = {
  name: "meta.entry.output-type.pml",
  match: `\\s*(output)\\s*(=)\\s*(\")( (?:[a-z][a-z0-9_]*\\.)?[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)* )(\")`.replace(/\s+/g, ""),
  captures: {
    1: { name: "support.type.property-name.pml" },
    2: { name: "punctuation.eq.pml" },
    3: { name: "punctuation.definition.string.begin.pml" },
    4: { name: "support.type.concept.pml" },
    5: { name: "punctuation.definition.string.end.pml" },
  },
};

// Special highlighting for refines type (refines = "ConceptType")
const entryRefinesType = {
  name: "meta.entry.refines-type.pml",
  match: `\\s*(refines)\\s*(=)\\s*(\")( (?:[a-z][a-z0-9_]*\\.)?[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)* )(\")`.replace(/\s+/g, ""),
  captures: {
    1: { name: "support.type.property-name.pml" },
    2: { name: "punctuation.eq.pml" },
    3: { name: "punctuation.definition.string.begin.pml" },
    4: { name: "support.type.concept.pml" },
    5: { name: "punctuation.definition.string.end.pml" },
  },
};

// Special highlighting for variable assignments (result = "var_name", batch_as = "var_name", etc.)
const entryVariableAssignment = {
  name: "meta.entry.variable-assignment.pml",
  match: `\\s*(result|batch_as|batch_over)\\s*(=)\\s*(\")( [a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)* )(\")`.replace(/\s+/g, ""),
  captures: {
    1: { name: "support.type.property-name.pml" },
    2: { name: "punctuation.eq.pml" },
    3: { name: "punctuation.definition.string.begin.pml" },
    4: { name: "variable.name.data.pml" },
    5: { name: "punctuation.definition.string.end.pml" },
  },
};

export const entryBegin = {
  patterns: [
    entryPipe,
    // Left-side variables, pipe names and input parameter concepts are now
    // colored exclusively by the semantic token provider to avoid conflicts
    // with values appearing inside inline tables (e.g. { type = "text" }).
    entryOutputType,
    entryRefinesType,
    entryGeneral,
  ],
};
