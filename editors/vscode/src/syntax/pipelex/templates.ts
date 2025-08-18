// Jinja2 template syntax
export const jinjaDelimiters = {
    match: `(\\{\\{|\\}\\}|\\{%|%\\})`,
    name: "punctuation.definition.jinja.pml",
};

export const jinjaKeywords = {
    match: `\\b(if|endif|else|elif|for|endfor|set|block|endblock|macro|endmacro|call|endcall|filter|endfilter|with|endwith|autoescape|endautoescape|raw|endraw)\\b`,
    name: "keyword.control.jinja.pml",
};

export const jinjaVariable = {
    match: `\\b([a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)*)\\b`,
    name: "variable.other.jinja.pml",
};

// HTML template syntax
export const htmlTag = {
    match: `(</?)(\\w+)([^>]*)(>)`,
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
                    match: `(\\w+)(=)("[^"]*"|'[^']*')`,
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
};

export const htmlComment = {
    match: `(<!--)(.*?)(-->)`,
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
};
