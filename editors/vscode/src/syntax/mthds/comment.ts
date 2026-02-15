export const comment = {
  captures: {
    1: {
      name: "comment.line.number-sign.mthds",
    },
    2: {
      name: "punctuation.definition.comment.mthds",
    },
  },
  comment: "Comments",
  match: "\\s*((#).*)$",
};

export const commentDirective = {
  captures: {
    1: {
      name: "meta.preprocessor.mthds",
    },
    2: {
      name: "punctuation.definition.meta.preprocessor.mthds",
    },
  },
  comment: "Comments",
  match: "\\s*((#):.*)$",
};
