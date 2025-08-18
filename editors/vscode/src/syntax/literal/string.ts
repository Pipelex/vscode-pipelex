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

const stringTemplatePatterns = [
  {
    match: "(@)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
    captures: {
      1: {
        name: "punctuation.definition.data-injection.pml",
      },
      2: {
        name: "variable.name.data.pml",
      },
    },
  },
  {
    match: "(\\$)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
    captures: {
      1: {
        name: "punctuation.definition.template-variable.pml",
      },
      2: {
        name: "variable.name.data.pml",
      },
    },
  },
  {
    match: "(\\{\\{|\\}\\}|\\{%|%\\})",
    name: "punctuation.definition.jinja.pml",
  },
  {
    match: "\\b(if|endif|else|elif|for|endfor|set|block|endblock|macro|endmacro|call|endcall|filter|endfilter|with|endwith|autoescape|endautoescape|raw|endraw)\\b",
    name: "keyword.control.jinja.pml",
  },
  {
    match: "(</?)(\\w+)([^>]*)(>)",
    captures: {
      1: {
        name: "punctuation.definition.tag.html.pml",
      },
      2: {
        name: "entity.name.tag.html.pml",
      },
      3: {
        patterns: [
          {
            match: "(\\w+)(=)(\"[^\"]*\"|'[^']*')",
            captures: {
              1: {
                name: "entity.other.attribute-name.html.pml",
              },
              2: {
                name: "punctuation.separator.key-value.html.pml",
              },
              3: {
                name: "string.quoted.html.pml",
              },
            },
          },
        ],
      },
      4: {
        name: "punctuation.definition.tag.html.pml",
      },
    },
  },
  {
    match: "(<!--)(.*?)(-->)",
    captures: {
      1: {
        name: "punctuation.definition.comment.html.pml",
      },
      2: {
        name: "comment.block.html.pml",
      },
      3: {
        name: "punctuation.definition.comment.html.pml",
      },
    },
  },
];

const stringSingle = {
  name: "string.quoted.single.basic.line.pml",
  begin: '"',
  end: '"',
  patterns: [...stringTemplatePatterns, ...escape],
};

const stringBlock = {
  name: "string.quoted.triple.basic.block.pml",
  begin: '"""',
  end: '"""',
  patterns: [...stringTemplatePatterns, ...escape],
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
