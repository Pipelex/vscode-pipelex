import * as vscode from 'vscode';
import * as path from 'path';
import type { BundleFile } from './backend';
import type { ValidationErrorItem } from './types';
import { locateError, locateErrorInLines, findTableHeaderInLines } from './sourceLocator';

/** Diagnostics computed for one file in the bundle. */
export interface FileDiagnostics {
    uri: vscode.Uri;
    diagnostics: vscode.Diagnostic[];
}

/**
 * Map a bundle's validation errors onto per-file diagnostics.
 *
 * A directory-wide validation can surface an error that belongs to a sibling
 * file. Each error is placed on its OWNING file, resolved in priority order:
 *
 * 1. `error.source` — the declaring file (CLI: a real path; API: the per-content
 *    `mthds_sources` name). Matched against the gathered files by name / path /
 *    basename. This is the populated-whenever-possible path.
 * 2. Declaration scan — for errors with no `source` (e.g. `pipe_factory`), find
 *    the file that declares the referenced `[pipe.<code>]` / `[concept.<code>]`.
 * 3. Fallback — the saved (primary) file, so an unresolved error is never lost.
 *
 * Ranges within a file come from the same `sourceLocator` logic as the
 * single-file path; the open primary document is used when available (exact
 * ranges), siblings are located against their on-disk text.
 */
export function buildBundleDiagnostics(args: {
    errors: ValidationErrorItem[];
    files: BundleFile[];
    primaryUri: vscode.Uri;
    diagnosticSource: string;
    primaryDocument?: vscode.TextDocument;
}): FileDiagnostics[] {
    const { errors, files, primaryUri, diagnosticSource, primaryDocument } = args;

    const linesCache = new Map<string, string[]>();
    const getLines = (file: BundleFile): string[] => {
        const key = file.uri.toString();
        let lines = linesCache.get(key);
        if (!lines) {
            lines = file.content.split(/\r\n|\r|\n/);
            linesCache.set(key, lines);
        }
        return lines;
    };

    const primaryFile = files.find(f => f.uri.toString() === primaryUri.toString());

    const byUri = new Map<string, FileDiagnostics>();
    const collect = (uri: vscode.Uri): vscode.Diagnostic[] => {
        const key = uri.toString();
        let entry = byUri.get(key);
        if (!entry) {
            entry = { uri, diagnostics: [] };
            byUri.set(key, entry);
        }
        return entry.diagnostics;
    };

    for (const error of errors) {
        const owner = resolveOwner(error, files, getLines) ?? primaryFile;
        const ownerUri = owner?.uri ?? primaryUri;

        let range: vscode.Range;
        if (ownerUri.toString() === primaryUri.toString() && primaryDocument) {
            range = locateError(error, primaryDocument);
        } else if (owner) {
            range = locateErrorInLines(error, getLines(owner));
        } else {
            range = new vscode.Range(0, 0, 0, 0);
        }

        collect(ownerUri).push(makeDiagnostic(error, range, diagnosticSource));
    }

    return [...byUri.values()];
}

function resolveOwner(
    error: ValidationErrorItem,
    files: BundleFile[],
    getLines: (file: BundleFile) => string[],
): BundleFile | undefined {
    if (error.source) {
        const src = error.source;
        const srcBase = path.basename(src);
        const isBareName = src === srcBase;
        // A bare filename matches by basename; a path-qualified source (e.g. `oo/a.mthds`)
        // must match exactly or on a path-segment boundary, so it can't misroute onto a
        // similarly-named sibling like `/project/foo/a.mthds` via either branch.
        const match = files.find(f =>
            f.name === src ||
            f.uri.fsPath === src ||
            (isBareName && path.basename(f.uri.fsPath) === srcBase) ||
            f.uri.fsPath.endsWith(path.sep + src)
        );
        if (match) {
            return match;
        }
    }

    const pipeCode = error.pipe_code ?? undefined;
    if (pipeCode) {
        const match = files.find(f => findTableHeaderInLines(getLines(f), 'pipe', pipeCode) !== -1);
        if (match) {
            return match;
        }
    }

    const conceptCode = error.concept_code ?? undefined;
    if (conceptCode) {
        const match = files.find(f => findTableHeaderInLines(getLines(f), 'concept', conceptCode) !== -1);
        if (match) {
            return match;
        }
    }

    return undefined;
}

function makeDiagnostic(error: ValidationErrorItem, range: vscode.Range, source: string): vscode.Diagnostic {
    const diag = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
    diag.source = source;
    if (error.error_type) {
        diag.code = error.error_type;
    }
    return diag;
}
