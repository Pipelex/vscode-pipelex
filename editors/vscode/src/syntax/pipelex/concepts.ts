// PascalCase concept names (EmailMessage, String, etc.)
export const conceptName = {
    match: `\\b([A-Z][a-zA-Z0-9]*(?:\\.[A-Z][a-zA-Z0-9]*)*)\\b`,
    name: "support.type.concept.pml",
};

// Native concepts like Text, Image, PDF, Page, Number, Anything
export const nativeConcepts = {
    match: `\\b(Text|Image|PDF|Page|Number|Anything|String)\\b`,
    name: "support.type.concept.native.pml",
};

// Pipe types (PipeLLM, PipeJinja2, PipeSequence, etc.)
export const pipeType = {
    match: `\\b(Pipe[A-Z][a-zA-Z0-9]*)\\b`,
    name: "support.type.pipe-type.pml",
};
