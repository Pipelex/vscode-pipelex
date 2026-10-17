import * as vscode from 'vscode';
import type { BundleFile } from './backend';
import type { ProblemItem } from './types';
import { locateError, locateErrorInLines, findTableHeaderInLines } from './sourceLocator';
import { matchSourceFile, findDeclaringFileByScan, fileDeclaredDomain } from './bundleResolution';
import { itemConcept, itemPipe, problemTypeUri } from './problemItems';

/** Diagnostics computed for one file in the bundle. */
export interface FileDiagnostics {
    uri: vscode.Uri;
    diagnostics: vscode.Diagnostic[];
}

/** A problem item placed on its owning file at a source range. */
export interface ErrorLocation {
    error: ProblemItem;
    /** The owning file's on-disk URI (a sibling, or the primary as the fallback). */
    uri: vscode.Uri;
    /** The range within the owning file: the item's own line and column, else a best-effort one. */
    range: vscode.Range;
    /**
     * The domain the item's pipe lives in: the declared domain of the owning
     * file, when the item itself resolved that file (not the primary fallback)
     * and the file declares `[pipe.<location.pipe>]`. Undefined otherwise, and
     * the graph then qualifies the pipe through its registry, or not at all.
     */
    pipeDomain?: string;
}

/** How an item's owning file was found. */
type OwnerResolution = { file: BundleFile; by: 'file' | 'pipe' | 'concept' };

/**
 * Resolve each problem item to its owning file + range, preserving input
 * order. This is the single source of truth for owner + range: both the
 * per-file diagnostics ({@link buildBundleDiagnostics}) and the method graph
 * panel's clickable issue list build on it, so they can never drift.
 *
 * A directory-wide validation can surface an item that belongs to a sibling
 * file. Each item is placed on its OWNING file, resolved in priority order:
 *
 * 1. `location.file` — the file at fault (CLI: a real path; API: the
 *    per-content `mthds_sources` name). Matched against the gathered files by
 *    name / path / basename. This is the populated-whenever-possible path.
 * 2. Declaration scan — for an item naming no file, find the file that
 *    declares the item's `[pipe.<location.pipe>]`, else its
 *    `[concept.<params.concept>]`. Among several declaring files the first
 *    concrete one wins (gather order: primary first).
 * 3. Fallback — the saved (primary) file, so an unresolved item is never lost.
 *
 * The range is the item's own `location.line` and `location.column` when the
 * owner is the file the item names (or the bundle's only file), since only
 * then does its line mean that text. Otherwise it comes from the
 * `sourceLocator` scan for the item's pipe, concept and field. The open
 * primary document is used when available, siblings are located against
 * their on-disk text.
 */
export function resolveErrorLocations(args: {
    errors: ProblemItem[];
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
        const resolved = resolveOwner(error, files, getLines);
        const owner = resolved?.file ?? primaryFile;
        const ownerUri = owner?.uri ?? primaryUri;
        // The item's line and column mean the text of the file it names: trust
        // them only on that file, or when the bundle has no other file.
        const exact = resolved?.by === 'file' || files.length === 1;

        let range: vscode.Range;
        if (ownerUri.toString() === primaryUri.toString() && primaryDocument) {
            range = locateError(error, primaryDocument, exact);
        } else if (owner) {
            range = locateErrorInLines(error, getLines(owner), exact);
        } else {
            range = new vscode.Range(0, 0, 0, 0);
        }

        const location: ErrorLocation = { error, uri: ownerUri, range };
        const pipe = itemPipe(error);
        if (resolved && pipe && findTableHeaderInLines(getLines(resolved.file), 'pipe', pipe) !== -1) {
            location.pipeDomain = fileDeclaredDomain(getLines(resolved.file));
        }
        return location;
    });
}

/**
 * Map a bundle's problem items onto per-file diagnostics, grouping the
 * order-preserving {@link resolveErrorLocations} output by owning file: the
 * verdict's `errors` as errors, its advisory `warnings` as warnings.
 */
export function buildBundleDiagnostics(args: {
    errors: ProblemItem[];
    warnings?: ProblemItem[];
    files: BundleFile[];
    primaryUri: vscode.Uri;
    diagnosticSource: string;
    primaryDocument?: vscode.TextDocument;
}): FileDiagnostics[] {
    const { errors, files, primaryUri, diagnosticSource, primaryDocument } = args;
    const warnings = args.warnings ?? [];

    const locations = resolveErrorLocations({ errors: [...errors, ...warnings], files, primaryUri, primaryDocument });

    const byUri = new Map<string, FileDiagnostics>();
    locations.forEach(({ error, uri, range }, index) => {
        const key = uri.toString();
        let entry = byUri.get(key);
        if (!entry) {
            entry = { uri, diagnostics: [] };
            byUri.set(key, entry);
        }
        const severity = index < errors.length ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
        entry.diagnostics.push(makeDiagnostic(error, range, diagnosticSource, severity));
    });

    return [...byUri.values()];
}

/**
 * Resolve a problem item to its owning file, in priority order:
 * `location.file` → `location.pipe` declaration → `concept` declaration.
 *
 * The matching primitives are shared with the method-graph pipe-node navigation
 * path ({@link resolveDeclaringFile}) so the two surfaces can never disagree on
 * how a source path is matched or how a declaration header is found. The item
 * path keeps its own file→pipe→concept ordering (an item may name both a pipe
 * and a concept); the navigation path resolves a single kind.
 */
function resolveOwner(
    error: ProblemItem,
    files: BundleFile[],
    getLines: (file: BundleFile) => string[],
): OwnerResolution | undefined {
    const file = error.location?.file;
    if (file) {
        const match = matchSourceFile(file, files);
        if (match) {
            return { file: match, by: 'file' };
        }
    }

    const pipeCode = itemPipe(error);
    if (pipeCode) {
        const match = findDeclaringFileByScan('pipe', pipeCode, files, undefined, getLines);
        if (match) {
            return { file: match, by: 'pipe' };
        }
    }

    const conceptCode = itemConcept(error);
    if (conceptCode) {
        const match = findDeclaringFileByScan('concept', conceptCode, files, undefined, getLines);
        if (match) {
            return { file: match, by: 'concept' };
        }
    }

    return undefined;
}

/**
 * A diagnostic for one item: its detail as the message, and its code as the
 * diagnostic's code, linked to the code's page (its type URI), which says
 * what the code means and what to do about it.
 */
function makeDiagnostic(
    error: ProblemItem,
    range: vscode.Range,
    source: string,
    severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic {
    const diag = new vscode.Diagnostic(range, error.detail, severity);
    diag.source = source;
    if (error.code) {
        diag.code = { value: error.code, target: vscode.Uri.parse(problemTypeUri(error.code)) };
    }
    return diag;
}
