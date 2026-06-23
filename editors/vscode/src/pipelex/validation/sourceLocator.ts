import * as vscode from 'vscode';
import type { ValidationErrorItem } from './types';

/**
 * Map a validation error to the best-effort source range in a document.
 *
 * Strategy:
 * 1. Determine a target code: use pipe_code, concept_code, or extract from message
 * 2. Search for the matching `[pipe.<code>]` or `[concept.<code>]` table header
 * 3. If field_path is present, search for `<field> =` within that table section
 * 4. Fallback to line 0
 *
 * The matching core operates on an array of line strings (`findErrorLine`) so the
 * same placement logic serves an open `TextDocument` (the saved file) and a
 * sibling file that is only read from disk (cross-file diagnostics, never opened).
 */
export function locateError(error: ValidationErrorItem, document: vscode.TextDocument): vscode.Range {
    const lines = documentLines(document);
    const line = findErrorLine(error, lines);
    const safeLine = Math.min(line, document.lineCount - 1);
    return document.lineAt(safeLine).range;
}

/** Same placement logic against raw text — for files that are not open as documents. */
export function locateErrorInLines(error: ValidationErrorItem, lines: string[]): vscode.Range {
    const line = findErrorLine(error, lines);
    return fullLineRange(lines, line);
}

/** Split document text into line strings (cheaper than repeated `lineAt`). */
function documentLines(document: vscode.TextDocument): string[] {
    const out: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        out.push(document.lineAt(i).text);
    }
    return out;
}

/** The matching core: returns the 0-based target line for an error, or 0 as fallback. */
export function findErrorLine(error: ValidationErrorItem, lines: string[]): number {
    const pipeCode = error.pipe_code ?? extractCodeFromMessage(error.message, 'pipe');
    const conceptCode = error.concept_code ?? extractCodeFromMessage(error.message, 'concept');

    let headerLine = -1;

    if (pipeCode) {
        headerLine = findTableHeaderInLines(lines, 'pipe', pipeCode);
    }
    if (headerLine === -1 && conceptCode) {
        headerLine = findTableHeaderInLines(lines, 'concept', conceptCode);
    }

    if (headerLine !== -1 && error.field_path) {
        const fieldKey = error.field_path.split('.').pop()!;
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
 * Try to extract `pipe.X` or `concept.X` codes from the error message text.
 * Many blueprint_validation errors encode references like "pipe 'my_pipe'" or
 * "concept 'MyConcept'" in the message string.
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
