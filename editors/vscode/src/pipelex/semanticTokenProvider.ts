import * as vscode from 'vscode';

// Token type indices — must match the order in the legend array
const TOKEN_TYPES = {
    mthdsConcept: 0,
    mthdsPipeType: 1,
    mthdsDataVariable: 2,
    mthdsPipeName: 3,
    mthdsPipeSection: 4,
    mthdsConceptSection: 5,
    mthdsModelRef: 6,
} as const;

// Token modifier indices — must match the order in the legend array
const TOKEN_MODIFIERS = {
    declaration: 0,
} as const;

const DECLARATION_FLAG = 1 << TOKEN_MODIFIERS.declaration;

export class PipelexSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private readonly legend: vscode.SemanticTokensLegend;

    constructor() {
        this.legend = new vscode.SemanticTokensLegend(
            [
                'mthdsConcept',
                'mthdsPipeType',
                'mthdsDataVariable',
                'mthdsPipeName',
                'mthdsPipeSection',
                'mthdsConceptSection',
                'mthdsModelRef',
            ],
            ['declaration']
        );
    }

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        const tokensBuilder = new vscode.SemanticTokensBuilder(this.legend);
        const lineCount = document.lineCount;
        let insideMultiLineInputs = false;

        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const line = document.lineAt(lineIndex).text;

            if (insideMultiLineInputs) {
                this.analyzeInputEntries(line, 0, lineIndex, tokensBuilder);
                if (line.includes('}')) {
                    insideMultiLineInputs = false;
                }
                continue;
            }

            // Table headers — add declaration modifier
            this.analyzeTableHeaders(line, lineIndex, tokensBuilder);

            // output/refines concept type references
            this.analyzeOutputRefines(line, lineIndex, tokensBuilder);

            // Single-line inputs = { ... }
            const singleLineInputs = /^(\s*inputs\s*=\s*)\{(.+)\}\s*$/.exec(line);
            if (singleLineInputs) {
                const blockOffset = singleLineInputs[1].length + 1; // after '{'
                this.analyzeInputEntries(singleLineInputs[2], blockOffset, lineIndex, tokensBuilder);
            } else {
                // Check for multi-line inputs start
                const multiLineStart = /^(\s*inputs\s*=\s*)\{(.*)$/.exec(line);
                if (multiLineStart) {
                    const blockOffset = multiLineStart[1].length + 1;
                    const rest = multiLineStart[2];
                    this.analyzeInputEntries(rest, blockOffset, lineIndex, tokensBuilder);
                    // Only enter multi-line state if the closing brace is NOT on this line
                    if (!rest.includes('}')) {
                        insideMultiLineInputs = true;
                    }
                }
            }

            // result/batch_as/batch_over variable names in step objects
            this.analyzeResultVariables(line, lineIndex, tokensBuilder);
        }

        return tokensBuilder.build();
    }

    private analyzeTableHeaders(line: string, lineIndex: number, tokensBuilder: vscode.SemanticTokensBuilder) {
        // Concept sections: [concept] or [concept.Name]
        const conceptMatch = /^(\s*)\[concept(?:\.([A-Z][A-Za-z0-9]*))?\]/.exec(line);
        if (conceptMatch) {
            const keywordOffset = conceptMatch[1].length + 1; // after whitespace + '['
            tokensBuilder.push(lineIndex, keywordOffset, 7, TOKEN_TYPES.mthdsConceptSection, DECLARATION_FLAG);
            if (conceptMatch[2]) {
                const nameOffset = keywordOffset + 7 + 1; // after 'concept' + '.'
                tokensBuilder.push(lineIndex, nameOffset, conceptMatch[2].length, TOKEN_TYPES.mthdsConcept, DECLARATION_FLAG);
            }
            return;
        }

        // Pipe sections: [pipe] or [pipe.name]
        const pipeMatch = /^(\s*)\[pipe(?:\.([a-z][a-z0-9_]*))?\]/.exec(line);
        if (pipeMatch) {
            const keywordOffset = pipeMatch[1].length + 1;
            tokensBuilder.push(lineIndex, keywordOffset, 4, TOKEN_TYPES.mthdsPipeSection, DECLARATION_FLAG);
            if (pipeMatch[2]) {
                const nameOffset = keywordOffset + 4 + 1; // after 'pipe' + '.'
                tokensBuilder.push(lineIndex, nameOffset, pipeMatch[2].length, TOKEN_TYPES.mthdsPipeName, DECLARATION_FLAG);
            }
        }
    }

    private analyzeOutputRefines(line: string, lineIndex: number, tokensBuilder: vscode.SemanticTokensBuilder) {
        const match = /^(\s*)(output|refines)(\s*=\s*")(?:[a-z][a-z0-9_]*\.)?([A-Z][A-Za-z0-9]*)(?:\[\d*\])?"/.exec(line);
        if (match) {
            const valueStart = match[1].length + match[2].length + match[3].length;
            // Find where the concept name starts within the value
            const fullValue = line.substring(valueStart);
            const conceptStart = fullValue.indexOf(match[4]);
            tokensBuilder.push(lineIndex, valueStart + conceptStart, match[4].length, TOKEN_TYPES.mthdsConcept);
        }
    }

    private analyzeInputEntries(content: string, baseOffset: number, lineIndex: number, tokensBuilder: vscode.SemanticTokensBuilder) {
        const entryRegex = /([a-z][a-z0-9_]*)(\s*=\s*")((?:[a-z][a-z0-9_]*\.)?([A-Z][A-Za-z0-9]*))(?:\[\d*\])?(")/g;
        let match;
        while ((match = entryRegex.exec(content)) !== null) {
            const varOffset = baseOffset + match.index;
            tokensBuilder.push(lineIndex, varOffset, match[1].length, TOKEN_TYPES.mthdsDataVariable);

            // Push concept token only for the ConceptName part (match[4]), not the domain
            const valueOffset = baseOffset + match.index + match[1].length + match[2].length;
            const conceptName = match[4];
            const conceptStart = match[3].indexOf(conceptName);
            tokensBuilder.push(lineIndex, valueOffset + conceptStart, conceptName.length, TOKEN_TYPES.mthdsConcept);
        }
    }

    private analyzeResultVariables(line: string, lineIndex: number, tokensBuilder: vscode.SemanticTokensBuilder) {
        const regex = /\b(result|batch_as|batch_over)(\s*=\s*")([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(")/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
            const varOffset = match.index + match[1].length + match[2].length;
            tokensBuilder.push(lineIndex, varOffset, match[3].length, TOKEN_TYPES.mthdsDataVariable);
        }
    }

    getSemanticTokensLegend(): vscode.SemanticTokensLegend {
        return this.legend;
    }
}
