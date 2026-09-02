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

/**
 * The line that opens an `inputs` block. The capture is everything up to and
 * including the `{`, so the scan starts at `match[1].length`.
 */
const INPUTS_BLOCK_START = /^(\s*inputs\s*=\s*\{)/;

/**
 * A table header. Valid TOML never puts one inside an inline table, so meeting one
 * while a block is open means the block was left unclosed rather than continued.
 */
const TABLE_HEADER_LINE = /^\s*\[/;

/** A bare key, anchored — the slot names and schema keys inside an inputs block. */
const IDENTIFIER = /[A-Za-z0-9_-]+/y;

/**
 * A concept reference as it appears between the quotes: an optional lowercase
 * domain prefix, the PascalCase concept name, an optional multiplicity suffix.
 *
 * This is the one place the concept-value grammar is written, shared by both slot
 * forms, so a later change to it (presence markers, say) lands in a single spot.
 */
const CONCEPT_VALUE = /^(?:([a-z][a-z0-9_]*)\.)?([A-Z][A-Za-z0-9]*)(?:\[\d*\])?$/;

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
        // Nesting inside the open `inputs` block: 0 = not in one, 1 = directly inside
        // `inputs = { … }`, 2 = inside a slot table, 3+ = inside its hints.
        let inputsDepth = 0;

        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const line = document.lineAt(lineIndex).text;

            // A block left open on an earlier line owns this whole line — unless the line
            // is a table header, which cannot occur inside an inline table. Treating that
            // as an abandoned block is what stops one unclosed brace from swallowing the
            // colouring of every line below it while the user is still typing.
            if (inputsDepth > 0 && !TABLE_HEADER_LINE.test(line)) {
                inputsDepth = this.scanInputsBlock(line, 0, lineIndex, inputsDepth, tokensBuilder);
                continue;
            }
            inputsDepth = 0;

            // Table headers — add declaration modifier
            this.analyzeTableHeaders(line, lineIndex, tokensBuilder);

            // output/refines concept type references
            this.analyzeOutputRefines(line, lineIndex, tokensBuilder);

            // inputs = { … } — the scanner runs from just after the '{' and reports the
            // depth it ended the line at, so single-line, multi-line, empty and
            // trailing-comment blocks are all the same case.
            const inputsStart = INPUTS_BLOCK_START.exec(line);
            if (inputsStart) {
                inputsDepth = this.scanInputsBlock(
                    line,
                    inputsStart[1].length,
                    lineIndex,
                    1,
                    tokensBuilder
                );
            }

            // result/batch_as/batch_over variable names in step objects
            this.analyzeResultVariables(line, lineIndex, tokensBuilder);
        }

        return tokensBuilder.build();
    }

    /**
     * Scan one line of an open `inputs` block, emitting slot and concept tokens, and
     * return the brace depth the line ends at (0 once the block has closed).
     *
     * MTHDS declares a slot in either of two forms, and depth is what tells them apart:
     *
     * - depth 1, directly inside `inputs = { … }` — `notes = "Text"` is the string form,
     *   colouring the slot name and the concept; `notes = {` opens the expanded form,
     *   colouring the slot name and descending to depth 2;
     * - depth 2, inside a slot table — only `concept = "Text"` carries a concept, and
     *   just the concept is coloured: `concept` is a schema keyword, not a slot name, and
     *   the TextMate grammar already paints it as a property name;
     * - depth 3 and deeper, inside `hints` — presentation intent, nothing to colour.
     *
     * Braces are counted outside strings only, and a `#` outside a string ends the line,
     * so a `}` in a quoted value or a trailing comment cannot close the block early.
     */
    private scanInputsBlock(
        line: string,
        start: number,
        lineIndex: number,
        depth: number,
        tokensBuilder: vscode.SemanticTokensBuilder
    ): number {
        let i = start;

        while (i < line.length) {
            const ch = line[i];

            if (ch === '#') {
                return depth; // comment runs to end of line
            }
            if (ch === '"' || ch === "'") {
                i = this.skipString(line, i);
                continue;
            }
            if (ch === '{') {
                depth += 1;
                i += 1;
                continue;
            }
            if (ch === '}') {
                depth -= 1;
                i += 1;
                if (depth <= 0) {
                    return 0;
                }
                continue;
            }

            // Sticky, so a match can only start at `i` — anything else advances by one.
            IDENTIFIER.lastIndex = i;
            const identifier = IDENTIFIER.exec(line);
            if (!identifier) {
                i += 1;
                continue;
            }

            const keyStart = i;
            const key = identifier[0];
            i = IDENTIFIER.lastIndex;

            // Only a `<key> =` is a key; a bare word anywhere else is skipped whole, so
            // its letters are never re-read as the start of another key.
            let valueStart = this.skipSpaces(line, i);
            if (line[valueStart] !== '=') {
                continue;
            }
            valueStart = this.skipSpaces(line, valueStart + 1);
            i = valueStart;

            if (line[valueStart] === '{') {
                // `<slot> = {` — the expanded form. The loop consumes the brace next and
                // takes the depth to 2; deeper tables (hints) name nothing worth colouring.
                if (depth === 1) {
                    tokensBuilder.push(
                        lineIndex,
                        keyStart,
                        key.length,
                        TOKEN_TYPES.mthdsDataVariable
                    );
                }
                continue;
            }

            if (line[valueStart] !== '"') {
                continue;
            }

            const closingQuote = this.skipString(line, valueStart) - 1;
            const value = line.slice(valueStart + 1, closingQuote);
            const concept = CONCEPT_VALUE.exec(value);
            if (!concept) {
                continue;
            }

            if (depth === 1) {
                tokensBuilder.push(lineIndex, keyStart, key.length, TOKEN_TYPES.mthdsDataVariable);
            } else if (depth !== 2 || key !== 'concept') {
                continue;
            }

            // Colour the concept name only — the domain prefix is the grammar's job.
            const domain = concept[1];
            const conceptStart = valueStart + 1 + (domain ? domain.length + 1 : 0);
            tokensBuilder.push(lineIndex, conceptStart, concept[2].length, TOKEN_TYPES.mthdsConcept);
        }

        return depth;
    }

    /**
     * Index of the first character after the string opening at `start`, or the end of
     * the line when the string is unterminated.
     */
    private skipString(line: string, start: number): number {
        const quote = line[start];
        for (let i = start + 1; i < line.length; i++) {
            if (quote === '"' && line[i] === '\\') {
                i += 1; // escapes only exist in basic strings
                continue;
            }
            if (line[i] === quote) {
                return i + 1;
            }
        }
        return line.length;
    }

    /** Index of the first character at or after `start` that is not a space or tab. */
    private skipSpaces(line: string, start: number): number {
        let i = start;
        while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
            i += 1;
        }
        return i;
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
