export const dataInjection = {
  match: "(@)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
  captures: {
    1: {
      name: "storage.modifier.mthds",
    },
    2: {
      name: "variable.other.readwrite.mthds",
    },
  },
};

export const templateVariable = {
  match: "(\\$)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
  captures: {
    1: {
      name: "storage.modifier.mthds",
    },
    2: {
      name: "variable.other.readwrite.mthds",
    },
  },
};
