// snake_case data variable names
export const dataVariable = {
    match: `\\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*)\\b`,
    name: "variable.name.data.pml",
};

// Data injection patterns (@ variable_name)
export const dataInjection = {
    match: `(@)\\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*)`,
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
    match: `(\\$)\\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*)`,
    captures: {
        1: {
            name: "punctuation.definition.template-variable.pml",
        },
        2: {
            name: "variable.name.data.pml",
        },
    },
};
