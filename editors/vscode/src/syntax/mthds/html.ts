export const htmlAttributes = {
  patterns: [
    {
      match: "([a-zA-Z-]+)(=)(\"[^\"]*\"|'[^']*')",
      captures: {
        1: {
          name: "entity.other.attribute-name.html.mthds",
        },
        2: {
          name: "punctuation.separator.key-value.html.mthds",
        },
        3: {
          name: "string.quoted.html.mthds",
        },
      },
    },
    {
      match: "[a-zA-Z-]+",
      name: "entity.other.attribute-name.html.mthds",
    },
  ],
};

export const htmlContent = {
  patterns: [
    {
      name: "meta.tag.html.mthds",
      begin: "(<)([a-zA-Z][a-zA-Z0-9]*)",
      end: "(>)",
      beginCaptures: {
        1: {
          name: "punctuation.definition.tag.begin.html.mthds",
        },
        2: {
          name: "entity.name.tag.html.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.tag.end.html.mthds",
        },
      },
      patterns: [
        {
          include: "#htmlAttributes",
        },
      ],
    },
    {
      name: "meta.tag.html.mthds",
      begin: "(</)([a-zA-Z][a-zA-Z0-9]*)",
      end: "(>)",
      beginCaptures: {
        1: {
          name: "punctuation.definition.tag.begin.html.mthds",
        },
        2: {
          name: "entity.name.tag.html.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.tag.end.html.mthds",
        },
      },
    },
    {
      name: "comment.block.html.mthds",
      begin: "(<!--)",
      end: "(-->)",
      beginCaptures: {
        1: {
          name: "punctuation.definition.comment.begin.html.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.comment.end.html.mthds",
        },
      },
    },
  ],
};
