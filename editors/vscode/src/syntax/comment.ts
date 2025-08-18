export const comment = {
    captures: {
        1: {
            name: 'comment.line.number-sign.pml',
        },
        2: {
            name: 'punctuation.definition.comment.pml',
        },
    },
    comment: 'Comments',
    match: '\\s*((#).*)$',
}

export const commentDirective = {
    captures: {
        1: {
            name: 'meta.preprocessor.pml',
        },
        2: {
            name: 'punctuation.definition.meta.preprocessor.pml',
        },
    },
    comment: 'Comments',
    match: '\\s*((#):.*)$',
}

