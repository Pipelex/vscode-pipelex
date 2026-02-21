import * as vscode from 'vscode';
import type { ValidationErrorItem } from './types';

/**
 * Map a validation error to the best-effort source range in the document.
 *
 * Strategy:
 * 1. Determine a target code: use pipe_code, concept_code, or extract from message
 * 2. Search for the matching `[pipe.<code>]` or `[concept.<code>]` table header
 * 3. If field_path is present, search for `<field> =` within that table section
 * 4. Fallback to line 0
 */
export function locateError(error: ValidationErrorItem, document: vscode.TextDocument): vscode.Range {
    const pipeCode = error.pipe_code ?? extractCodeFromMessage(error.message, 'pipe');
    const conceptCode = error.concept_code ?? extractCodeFromMessage(error.message, 'concept');

    let headerLine = -1;

    if (pipeCode) {
        headerLine = findTableHeader(document, 'pipe', pipeCode);
    }
    if (headerLine === -1 && conceptCode) {
        headerLine = findTableHeader(document, 'concept', conceptCode);
    }

    if (headerLine !== -1 && error.field_path) {
        const fieldKey = error.field_path.split('.').pop()!;
        const fieldLine = findFieldInSection(document, headerLine, fieldKey);
        if (fieldLine !== -1) {
            return fullLineRange(document, fieldLine);
        }
        return fullLineRange(document, headerLine);
    }

    if (headerLine !== -1) {
        return fullLineRange(document, headerLine);
    }

    return fullLineRange(document, 0);
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

function findTableHeader(document: vscode.TextDocument, kind: string, code: string): number {
    const pattern = new RegExp(`^\\s*\\[${kind}\\.${escapeRegex(code)}\\]`);
    for (let i = 0; i < document.lineCount; i++) {
        if (pattern.test(document.lineAt(i).text)) {
            return i;
        }
    }
    return -1;
}

/**
 * Search for `<fieldKey> =` within the table section starting at headerLine.
 * A section ends at the next table header or end of document.
 */
function findFieldInSection(document: vscode.TextDocument, headerLine: number, fieldKey: string): number {
    const fieldPattern = new RegExp(`^\\s*${escapeRegex(fieldKey)}\\s*=`);
    for (let i = headerLine + 1; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
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

function fullLineRange(document: vscode.TextDocument, line: number): vscode.Range {
    const safeLine = Math.min(line, document.lineCount - 1);
    return document.lineAt(safeLine).range;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
