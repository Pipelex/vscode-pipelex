export const dataInjection = {
  match: "(@)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
  captures: {
    1: {
      name: "punctuation.definition.data-injection.mthds",
    },
    2: {
      name: "variable.name.data.mthds",
    },
  },
};

export const templateVariable = {
  match: "(\\$)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
  captures: {
    1: {
      name: "punctuation.definition.template-variable.mthds",
    },
    2: {
      name: "variable.name.data.mthds",
    },
  },
};
