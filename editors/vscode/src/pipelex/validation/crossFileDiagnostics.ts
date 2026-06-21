import * as vscode from 'vscode';
import type { BundleFile } from './backend';
import type { ValidationErrorItem } from './types';
import { locateError, locateErrorInLines, findTableHeaderInLines } from './sourceLocator';

/** Diagnostics computed for one file in the bundle. */
export interface FileDiagnostics {
    uri: vscode.Uri;
    diagnostics: vscode.Diagnostic[];
}

/** A validation error placed on its owning file at a best-effort source range. */
export interface ErrorLocation {
    error: ValidationErrorItem;
    /** The owning file's on-disk URI (a sibling, or the primary as the fallback). */
    uri: vscode.Uri;
    /** Best-effort range within the owning file. */
    range: vscode.Range;
}

/**
 * Resolve each bundle validation error to its owning file + best-effort range,
 * preserving input order. This is the single source of truth for owner + range:
 * both the per-file diagnostics ({@link buildBundleDiagnostics}) and the method
 * graph panel's clickable error list build on it, so they can never drift.
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
export function resolveErrorLocations(args: {
    errors: ValidationErrorItem[];
    files: BundleFile[];
    primaryUri: vscode.Uri;
    primaryDocument?: vscode.TextDocument;
}): ErrorLocation[] {
    const { errors, files, primaryUri, primaryDocument } = args;

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

    return errors.map(error => {
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

        return { error, uri: ownerUri, range };
    });
}

/**
 * Map a bundle's validation errors onto per-file diagnostics, grouping the
 * order-preserving {@link resolveErrorLocations} output by owning file.
 */
export function buildBundleDiagnostics(args: {
    errors: ValidationErrorItem[];
    files: BundleFile[];
    primaryUri: vscode.Uri;
    diagnosticSource: string;
    primaryDocument?: vscode.TextDocument;
}): FileDiagnostics[] {
    const { errors, files, primaryUri, diagnosticSource, primaryDocument } = args;

    const locations = resolveErrorLocations({ errors, files, primaryUri, primaryDocument });

    const byUri = new Map<string, FileDiagnostics>();
    for (const { error, uri, range } of locations) {
        const key = uri.toString();
        let entry = byUri.get(key);
        if (!entry) {
            entry = { uri, diagnostics: [] };
            byUri.set(key, entry);
        }
        entry.diagnostics.push(makeDiagnostic(error, range, diagnosticSource));
    }

    return [...byUri.values()];
}

function resolveOwner(
    error: ValidationErrorItem,
    files: BundleFile[],
    getLines: (file: BundleFile) => string[],
): BundleFile | undefined {
    if (error.source) {
        // The backend can report a POSIX-style relative source (e.g. `subdir/a.mthds`)
        // even on Windows, where `fsPath` uses `\`. Normalize both sides to forward
        // slashes before matching, so a path-qualified source is not misrouted by a
        // separator mismatch (`\` vs `/`) in the basename or segment-boundary checks.
        const src = error.source.replace(/\\/g, '/');
        const srcBase = src.substring(src.lastIndexOf('/') + 1);
        const isBareName = src === srcBase;
        // A bare filename matches by basename; a path-qualified source (e.g. `foo/a.mthds`)
        // must match exactly or on a path-segment boundary, so it can't misroute onto a
        // similarly-named sibling like `/project/bar/a.mthds` via either branch.
        const match = files.find(f => {
            const fsPath = f.uri.fsPath.replace(/\\/g, '/');
            const fsBase = fsPath.substring(fsPath.lastIndexOf('/') + 1);
            const name = f.name.replace(/\\/g, '/');
            return (
                name === src ||
                fsPath === src ||
                (isBareName && fsBase === srcBase) ||
                fsPath.endsWith('/' + src)
            );
        });
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
