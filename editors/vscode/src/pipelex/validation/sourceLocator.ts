import * as vscode from 'vscode';
import type { ProblemItem } from './types';
import { itemConcept, itemField, itemPipe } from './problemItems';

/**
 * Map a problem item to a source range in a document.
 *
 * Strategy:
 * 1. When `exact` and the item carries its own `location.line` (1-based, with
 *    an optional 1-based `location.column`), that position is the range: from
 *    the column, or the line's start, to the end of the line. `exact` says the
 *    document is the file the item names, so its line means this text.
 * 2. Otherwise determine a target code: the item's `location.pipe` or a pipe
 *    its detail quotes, else its `concept` parameter, else a concept its
 *    detail quotes
 * 3. Search for the matching `[pipe.<code>]` or `[concept.<code>]` table
 *    header, moving to the next candidate when one has none
 * 4. If the item names a field, search for `<field> =` within that table section
 * 5. Fallback to line 0
 *
 * The matching core operates on an array of line strings (`findErrorLine`) so the
 * same placement logic serves an open `TextDocument` (the saved file) and a
 * sibling file that is only read from disk (cross-file diagnostics, never opened).
 */
export function locateError(error: ProblemItem, document: vscode.TextDocument, exact = false): vscode.Range {
    const lines = documentLines(document);
    if (exact) {
        const range = locateLineColumn(error, lines);
        if (range) {
            return range;
        }
    }
    const line = findErrorLine(error, lines);
    const safeLine = Math.min(line, document.lineCount - 1);
    return document.lineAt(safeLine).range;
}

/** Same placement logic against raw text — for files that are not open as documents. */
export function locateErrorInLines(error: ProblemItem, lines: string[], exact = false): vscode.Range {
    if (exact) {
        const range = locateLineColumn(error, lines);
        if (range) {
            return range;
        }
    }
    const line = findErrorLine(error, lines);
    return fullLineRange(lines, line);
}

/**
 * The range an item's own `location.line` and `location.column` name, or
 * undefined when it names no line or a line the text does not have. The range
 * runs from the column to the end of the line, or covers the whole line when
 * there is no column or the column lies at or past the line's end (a fault
 * at the end of a line, such as a missing closing bracket).
 *
 * The column counts Unicode code points, as pipelex does (the MTHDS standard
 * says only that it counts from 1), while a VS Code position counts UTF-16
 * code units, so a character beyond the Basic Multilingual Plane before the
 * column, such as an emoji, moves the start by two units.
 */
export function locateLineColumn(error: ProblemItem, lines: string[]): vscode.Range | undefined {
    const line = error.location?.line;
    if (line === undefined || line < 1 || line > lines.length) {
        return undefined;
    }
    const text = lines[line - 1];
    const column = error.location?.column;
    const offset = column !== undefined && column >= 1 ? codePointColumnOffset(text, column) : undefined;
    const start = offset !== undefined && offset < text.length ? offset : 0;
    return new vscode.Range(line - 1, start, line - 1, text.length);
}

/**
 * The UTF-16 offset in `text` of the 1-based code-point `column`, or undefined
 * when the column lies past the end of the text.
 */
function codePointColumnOffset(text: string, column: number): number | undefined {
    let offset = 0;
    for (let point = 1; point < column; point++) {
        if (offset >= text.length) {
            return undefined;
        }
        offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
    }
    return offset;
}

/** Split document text into line strings (cheaper than repeated `lineAt`). */
export function documentLines(document: vscode.TextDocument): string[] {
    const out: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        out.push(document.lineAt(i).text);
    }
    return out;
}

/**
 * The matching core: returns the 0-based target line for an item, or 0 as fallback.
 *
 * The concept is searched by the item's `concept` parameter, then by a concept
 * its detail quotes. The parameter may name the concept the fault is that it is
 * missing (a validation item's `missing_concept_code`, which pipelex also puts
 * there), which by definition has no header, so it must not stop the search at
 * the concept the detail quotes.
 */
export function findErrorLine(error: ProblemItem, lines: string[]): number {
    const pipeCode = itemPipe(error) ?? extractCodeFromMessage(error.detail, 'pipe');

    let headerLine = -1;

    if (pipeCode) {
        headerLine = findTableHeaderInLines(lines, 'pipe', pipeCode);
    }
    for (const conceptCode of [itemConcept(error), extractCodeFromMessage(error.detail, 'concept')]) {
        if (headerLine !== -1) {
            break;
        }
        if (conceptCode) {
            headerLine = findTableHeaderInLines(lines, 'concept', conceptCode);
        }
    }

    const field = itemField(error);
    if (headerLine !== -1 && field) {
        const fieldKey = field.split('.').pop()!;
        const fieldLine = findFieldInSection(lines, headerLine, fieldKey);
        if (fieldLine !== -1) {
            return fieldLine;
        }
        return headerLine;
    }

    if (headerLine !== -1) {
        return headerLine;
    }

    return 0;
}

/**
 * Try to extract `pipe.X` or `concept.X` codes from an item's detail, for an
 * item whose location and parameters name neither: a sentence may quote a
 * reference like "pipe 'my_pipe'" or "concept 'MyConcept'".
 */
function extractCodeFromMessage(message: string, kind: 'pipe' | 'concept'): string | null {
    // Match patterns like: pipe 'my_pipe', pipe "my_pipe", pipe `my_pipe`
    const pattern = new RegExp(`${kind}\\s+['\`"](\\w+)['\`"]`, 'i');
    const match = pattern.exec(message);
    return match ? match[1] : null;
}

/** Find a `[<kind>.<code>]` table header in a document. */
export function findTableHeader(document: vscode.TextDocument, kind: string, code: string): number {
    return findTableHeaderInLines(documentLines(document), kind, code);
}

/** Find a `[<kind>.<code>]` table header in raw lines. */
export function findTableHeaderInLines(lines: string[], kind: string, code: string): number {
    const pattern = new RegExp(`^\\s*\\[${kind}\\.${escapeRegex(code)}\\]`);
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
            return i;
        }
    }
    return -1;
}

/**
 * Search for `<fieldKey> =` within the table section starting at headerLine.
 * A section ends at the next table header or end of document.
 */
function findFieldInSection(lines: string[], headerLine: number, fieldKey: string): number {
    const fieldPattern = new RegExp(`^\\s*${escapeRegex(fieldKey)}\\s*=`);
    for (let i = headerLine + 1; i < lines.length; i++) {
        const text = lines[i];
        // Stop at the next table header
        if (/^\s*\[/.test(text)) {
            break;
        }
        if (fieldPattern.test(text)) {
            return i;
        }
    }
    return -1;
}

function fullLineRange(lines: string[], line: number): vscode.Range {
    if (lines.length === 0) {
        return new vscode.Range(0, 0, 0, 0);
    }
    const safeLine = Math.min(Math.max(line, 0), lines.length - 1);
    return new vscode.Range(safeLine, 0, safeLine, lines[safeLine].length);
}

export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
