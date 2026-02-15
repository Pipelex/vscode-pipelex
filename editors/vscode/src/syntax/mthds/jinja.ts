export const jinjaStatements = {
  patterns: [
    {
      match:
        "\\b(if|elif|else|endif|for|endfor|set|with|endwith|block|endblock|macro|endmacro|call|endcall|filter|endfilter|autoescape|endautoescape|raw|endraw|extends|include|import|from)\\b",
      name: "keyword.control.jinja.mthds",
    },
    {
      match: "\\b(and|or|not|in|is|true|false|none)\\b",
      name: "keyword.operator.jinja.mthds",
    },
    {
      match:
        "\\b(selectattr|rejectattr|map|select|reject|join|list|sort|reverse|length|first|last|random|min|max|sum|abs|round|int|float|string)\\b",
      name: "support.function.jinja.mthds",
    },
    {
      match: "[a-zA-Z_][a-zA-Z0-9_]*",
      name: "variable.other.jinja.mthds",
    },
    {
      match: "\\.",
      name: "punctuation.accessor.jinja.mthds",
    },
    {
      match: "\\|",
      name: "punctuation.separator.filter.jinja.mthds",
    },
  ],
};

export const jinjaExpressions = {
  patterns: [
    {
      match: "\\b(and|or|not|in|is|true|false|none)\\b",
      name: "keyword.operator.jinja.mthds",
    },
    {
      match:
        "\\b(selectattr|rejectattr|map|select|reject|join|list|sort|reverse|length|first|last|random|min|max|sum|abs|round|int|float|string|equalto)\\b",
      name: "support.function.jinja.mthds",
    },
    {
      match: "[a-zA-Z_][a-zA-Z0-9_]*",
      name: "variable.other.jinja.mthds",
    },
    {
      match: "\\.",
      name: "punctuation.accessor.jinja.mthds",
    },
    {
      match: "\\|",
      name: "punctuation.separator.filter.jinja.mthds",
    },
    {
      match: '"[^"]*"',
      name: "string.quoted.double.jinja.mthds",
    },
    {
      match: "'[^']*'",
      name: "string.quoted.single.jinja.mthds",
    },
    {
      match: "\\d+",
      name: "constant.numeric.jinja.mthds",
    },
  ],
};

export const jinjaTemplateContent = {
  patterns: [
    {
      name: "meta.embedded.block.jinja.mthds",
      begin: "(\\{%)",
      end: "(%\\})",
      beginCaptures: {
        1: {
          name: "punctuation.definition.jinja.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.jinja.mthds",
        },
      },
      patterns: [
        {
          include: "#jinjaStatements",
        },
      ],
    },
    {
      name: "meta.embedded.expression.jinja.mthds",
      begin: "(\\{\\{)",
      end: "(\\}\\})",
      beginCaptures: {
        1: {
          name: "punctuation.definition.jinja.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.jinja.mthds",
        },
      },
      patterns: [
        {
          include: "#jinjaExpressions",
        },
      ],
    },
    {
      name: "comment.block.jinja.mthds",
      begin: "(\\{#)",
      end: "(#\\})",
      beginCaptures: {
        1: {
          name: "punctuation.definition.comment.begin.jinja.mthds",
        },
      },
      endCaptures: {
        1: {
          name: "punctuation.definition.comment.end.jinja.mthds",
        },
      },
    },
  ],
};
