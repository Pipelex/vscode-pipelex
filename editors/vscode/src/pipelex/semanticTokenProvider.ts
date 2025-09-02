import * as vscode from 'vscode';

export class PipelexSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private readonly legend: vscode.SemanticTokensLegend;

    constructor() {
        // Define our custom semantic token types
        this.legend = new vscode.SemanticTokensLegend([
            'plxConcept',
            'plxPipeType',
            'plxDataVariable',
            'plxPipeName',
            'plxPipeSection',
            'plxConceptSection'
        ]);
    }

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        const tokensBuilder = new vscode.SemanticTokensBuilder(this.legend);
        const text = document.getText();
        const lines = text.split('\n');

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            this.analyzeLine(line, lineIndex, tokensBuilder);
        }

        return tokensBuilder.build();
    }

    private analyzeLine(line: string, lineIndex: number, tokensBuilder: vscode.SemanticTokensBuilder) {
        // Skip lines that are concept structure definitions (contain { type = "text" })
        if (line.includes('{ type = "text"') || line.includes('{type="text"')) {
            return;
        }

        // Output and refines concept types (output = "ConceptType", refines = "ConceptType") - only at start of line
        const outputRefinesRegex = /^(\s*)(output|refines)\s*=\s*"((?:[a-z][a-z0-9_]*\.)?[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*)"\s*$/g;
        let match;
        while ((match = outputRefinesRegex.exec(line)) !== null) {
            const conceptStart = match.index + match[0].indexOf(match[3]);
            tokensBuilder.push(lineIndex, conceptStart, match[3].length, 0); // plxConcept - full concept including namespace
        }

        // Concept types in input parameters (var_name = "ConceptType") - only in inputs = { ... } at line start
        const inputParamRegex = /^(\s*)inputs\s*=\s*\{[^}]*\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*=\s*"((?:[a-z][a-z0-9_]*\.)?[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*)"/g;
        while ((match = inputParamRegex.exec(line)) !== null) {
            // Variable name (left side of =)
            const varStart = match.index + match[0].indexOf(match[2]);
            tokensBuilder.push(lineIndex, varStart, match[2].length, 2); // plxDataVariable

            // Concept type (right side of =)
            const conceptStart = match.index + match[0].indexOf(match[3]);
            tokensBuilder.push(lineIndex, conceptStart, match[3].length, 0); // plxConcept - full concept including namespace
        }

        // Pipe types (PipeLLM, PipeSequence, etc.) - only at start of line, not in structure definitions
        const pipeTypeRegex = /^(\s*)type\s*=\s*"(Pipe[A-Z][A-Za-z0-9]*)"\s*$/g;
        while ((match = pipeTypeRegex.exec(line)) !== null) {
            const pipeTypeStart = match.index + match[0].indexOf(match[2]);
            tokensBuilder.push(lineIndex, pipeTypeStart, match[2].length, 1); // plxPipeType
        }

        // Pipe names in steps (pipe = "pipe_name")
        const pipeNameRegex = /\bpipe\s*=\s*"([a-z][a-z0-9_]*)"/g;
        while ((match = pipeNameRegex.exec(line)) !== null) {
            const pipeNameStart = match.index + match[0].indexOf(match[1]);
            tokensBuilder.push(lineIndex, pipeNameStart, match[1].length, 3); // plxPipeName
        }

        // Variable names in result assignments
        const resultVarRegex = /\b(result|batch_as|batch_over)\s*=\s*"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)"/g;
        while ((match = resultVarRegex.exec(line)) !== null) {
            const varStart = match.index + match[0].indexOf(match[2]);
            tokensBuilder.push(lineIndex, varStart, match[2].length, 2); // plxDataVariable
        }

        // Data injection (@variable_name)
        const dataInjectionRegex = /@([a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)/g;
        while ((match = dataInjectionRegex.exec(line)) !== null) {
            const varStart = match.index + 1; // Skip the @
            tokensBuilder.push(lineIndex, varStart, match[1].length, 2); // plxDataVariable
        }

        // Template variables ($variable_name)
        const templateVarRegex = /\$([a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)/g;
        while ((match = templateVarRegex.exec(line)) !== null) {
            const varStart = match.index + 1; // Skip the $
            tokensBuilder.push(lineIndex, varStart, match[1].length, 2); // plxDataVariable
        }

        // Section headers
        if (line.trim().startsWith('[')) {
            // Pipe sections [pipe.name]
            const pipeSectionRegex = /^\s*\[pipe(?:\.([a-z][a-z0-9_]*))?\]/;
            const pipeMatch = pipeSectionRegex.exec(line);
            if (pipeMatch) {
                const sectionStart = line.indexOf('[pipe');
                tokensBuilder.push(lineIndex, sectionStart + 1, 4, 4); // "pipe" part - plxPipeSection
                if (pipeMatch[1]) {
                    const nameStart = line.indexOf(pipeMatch[1]);
                    tokensBuilder.push(lineIndex, nameStart, pipeMatch[1].length, 3); // pipe name - plxPipeName
                }
            }

            // Concept sections [concept.Name]
            const conceptSectionRegex = /^\s*\[concept(?:\.([A-Z][A-Za-z0-9]*))?\]/;
            const conceptMatch = conceptSectionRegex.exec(line);
            if (conceptMatch) {
                const sectionStart = line.indexOf('[concept');
                tokensBuilder.push(lineIndex, sectionStart + 1, 7, 5); // "concept" part - plxConceptSection
                if (conceptMatch[1]) {
                    const nameStart = line.indexOf(conceptMatch[1]);
                    tokensBuilder.push(lineIndex, nameStart, conceptMatch[1].length, 0); // concept name - plxConcept
                }
            }
        }
    }

    getSemanticTokensLegend(): vscode.SemanticTokensLegend {
        return this.legend;
    }
}
