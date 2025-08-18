// snake_case data variable names
export const dataVariable = {
    match: `\\b([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)\\b`,
    name: "variable.name.data.pml",
};

// Data injection patterns (@ variable_name)
export const dataInjection = {
    match: `(@)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)`,
    captures: {
        1: {
            name: "punctuation.definition.data-injection.pml",
        },
        2: {
            name: "variable.name.data.pml",
        },
    },
};

// Template variable patterns ($ variable_name)
export const templateVariable = {
    match: `(\\$)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)`,
    captures: {
        1: {
            name: "punctuation.definition.template-variable.pml",
        },
        2: {
            name: "variable.name.data.pml",
        },
    },
};
