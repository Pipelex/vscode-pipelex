import * as vscode from 'vscode';
import type { BundleFile } from './backend';
import type { ProblemItem } from './types';
import { documentLines, locateError, locateErrorInLines, findTableHeaderInLines } from './sourceLocator';
import { matchSourceFile, findDeclaringFileByScan, fileDeclaredDomain, soleDeclaringDomain } from './bundleResolution';
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
     * The domain the item's pipe lives in, when it is known without guessing:
     * the domain an item read from the shape problem items replace named;
     * else the declared domain of the file the item names, when that file
     * declares `[pipe.<location.pipe>]`; else, when the item names no file,
     * the one domain every file declaring that pipe declares. Undefined
     * otherwise, several domains declaring the code included, and the graph
     * then qualifies the pipe through its registry, or not at all.
     */
    pipeDomain?: string;
}

/** What an item resolved to: its owning file and how it was found, and the domain its pipe lives in. */
interface ItemResolution {
    owner?: { file: BundleFile; by: 'file' | 'pipe' | 'concept' };
    pipeDomain?: string;
}

/**
 * Resolve each problem item to its owning file + range, preserving input
 * order. This is the single source of truth for owner + range: both the
 * per-file diagnostics ({@link buildBundleDiagnostics}) and the method graph
 * panel's clickable issue list build on it, so they can never drift.
 *
 * A directory-wide validation can surface an item that belongs to a sibling
 * file. Each item is placed on its OWNING file, resolved in priority order:
 *
 * 1. `location.file` — the file at fault (CLI: a real path; API: its path in
 *    the method tree, `sub/x.mthds` when the tree is rooted above the saved
 *    file's directory). Matched against the gathered files by name / path /
 *    basename / path suffix. This is the populated-whenever-possible path.
 * 2. Declaration scan — for an item naming no file, find the file that
 *    declares the item's `[pipe.<location.pipe>]`, else its
 *    `[concept.<params.concept>]`. Among several declaring files the first
 *    concrete one wins (gather order: primary first), within the domain an
 *    item read from the shape problem items replace names, when it names one.
 * 3. Fallback — the saved (primary) file, so an unresolved item is never lost.
 *
 * `files` are the files as they were validated: the directory's `.mthds` files
 * as gathered for the request, which the API's method tree holds and the CLI
 * read itself. The owner is resolved against them, since the item speaks of
 * that text.
 *
 * The range is the item's own `location.line` and `location.column` when they
 * mean the owner's text: the owner is the file the item names, or the item
 * names no file and the bundle has no other one. They also need the owner's
 * current text to be the text that was validated, since an edit made after
 * the request would shift them: the open primary document's text, and every
 * other file's text in `currentFiles`, read after the verdict arrived.
 * Otherwise the range comes from the `sourceLocator` scan for the item's pipe,
 * concept and field, which reads the current text. A file `currentFiles` does
 * not hold (gone, or unreadable now) has no known current text, so it is
 * scanned as it was validated. Without `currentFiles`, the validated files
 * are taken as the current text.
 */
export function resolveErrorLocations(args: {
    errors: ProblemItem[];
    files: BundleFile[];
    currentFiles?: BundleFile[];
    primaryUri: vscode.Uri;
    primaryDocument?: vscode.TextDocument;
}): ErrorLocation[] {
    const { errors, files, currentFiles, primaryUri, primaryDocument } = args;

    // The text of a gathered file, split once: a validated file's, or a current one's.
    const linesCache = new Map<BundleFile, string[]>();
    const getLines = (file: BundleFile): string[] => {
        let lines = linesCache.get(file);
        if (!lines) {
            lines = file.content.split(/\r\n|\r|\n/);
            linesCache.set(file, lines);
        }
        return lines;
    };
    // The current text of a validated file, or undefined when it is not known.
    const currentByUri = new Map((currentFiles ?? files).map(file => [file.uri.toString(), file]));
    const getCurrentLines = (file: BundleFile): string[] | undefined => {
        const current = currentByUri.get(file.uri.toString());
        return current ? getLines(current) : undefined;
    };

    const primaryFile = files.find(f => f.uri.toString() === primaryUri.toString());

    // Whether the open primary document still holds the text that was
    // validated, decided once and only when an exact placement asks.
    let documentIsValidatedText: boolean | undefined;
    const documentHoldsValidatedText = (document: vscode.TextDocument): boolean => {
        if (documentIsValidatedText === undefined) {
            documentIsValidatedText = primaryFile !== undefined
                && sameLines(documentLines(document), getLines(primaryFile));
        }
        return documentIsValidatedText;
    };

    return errors.map(error => {
        const { owner: resolved, pipeDomain } = resolveItem(error, files, getLines);
        const owner = resolved?.file ?? primaryFile;
        const ownerUri = owner?.uri ?? primaryUri;
        // The item's line and column mean the text of the file it names: trust
        // them only on that file, or, when it names none, on the only file of
        // the bundle. A file it names that is not gathered (a Python module of
        // the method, a file outside the directory) lends its line to no file.
        const exact = resolved?.by === 'file'
            || (error.location?.file === undefined && files.length === 1 && owner === files[0]);

        let range: vscode.Range;
        if (ownerUri.toString() === primaryUri.toString() && primaryDocument) {
            range = locateError(error, primaryDocument, exact && documentHoldsValidatedText(primaryDocument));
        } else if (owner) {
            const validated = getLines(owner);
            const current = getCurrentLines(owner);
            const unchanged = current !== undefined && sameLines(current, validated);
            range = locateErrorInLines(error, current ?? validated, exact && unchanged);
        } else {
            range = new vscode.Range(0, 0, 0, 0);
        }

        const location: ErrorLocation = { error, uri: ownerUri, range };
        if (pipeDomain !== undefined) {
            location.pipeDomain = pipeDomain;
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
    currentFiles?: BundleFile[];
    primaryUri: vscode.Uri;
    diagnosticSource: string;
    primaryDocument?: vscode.TextDocument;
}): FileDiagnostics[] {
    const { errors, files, currentFiles, primaryUri, diagnosticSource, primaryDocument } = args;
    const warnings = args.warnings ?? [];

    const locations = resolveErrorLocations({ errors: [...errors, ...warnings], files, currentFiles, primaryUri, primaryDocument });

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
 * `location.file` → `location.pipe` declaration → `concept` declaration, and
 * the domain its pipe lives in (see {@link ErrorLocation.pipeDomain}).
 *
 * The matching primitives are shared with the method-graph pipe-node navigation
 * path ({@link resolveDeclaringFile}) so the two surfaces can never disagree on
 * how a source path is matched or how a declaration header is found. The item
 * path keeps its own file→pipe→concept ordering (an item may name both a pipe
 * and a concept); the navigation path resolves a single kind.
 *
 * An item read from the shape problem items replace may name its domain. That
 * domain constrains both declaration scans, so of two domains declaring the
 * same code the item lands in its own, and it is its pipe's domain outright.
 */
function resolveItem(
    error: ProblemItem,
    files: BundleFile[],
    getLines: (file: BundleFile) => string[],
): ItemResolution {
    const pipeCode = itemPipe(error);
    const namedDomain = error.legacy?.domainCode;
    // The pipe's domain, given what the resolution found: the named domain
    // first, and nothing for an item that names no pipe.
    const withPipeDomain = (owner: ItemResolution['owner'], found?: string): ItemResolution => ({
        owner,
        pipeDomain: pipeCode === undefined ? undefined : namedDomain ?? found,
    });

    const file = error.location?.file;
    if (file) {
        const match = matchSourceFile(file, files);
        if (match) {
            const declaresPipe = pipeCode !== undefined
                && findTableHeaderInLines(getLines(match), 'pipe', pipeCode) !== -1;
            return withPipeDomain(
                { file: match, by: 'file' },
                declaresPipe ? fileDeclaredDomain(getLines(match)) : undefined,
            );
        }
    }

    if (pipeCode) {
        const match = findDeclaringFileByScan('pipe', pipeCode, files, namedDomain, getLines);
        if (match) {
            // The scan settles on one file even when several domains declare
            // the code; its domain is the pipe's only when no other domain does.
            return withPipeDomain(
                { file: match, by: 'pipe' },
                soleDeclaringDomain('pipe', pipeCode, files, getLines),
            );
        }
    }

    const conceptCode = itemConcept(error);
    if (conceptCode) {
        const match = findDeclaringFileByScan('concept', conceptCode, files, namedDomain, getLines);
        if (match) {
            return withPipeDomain({ file: match, by: 'concept' });
        }
    }

    return withPipeDomain(undefined);
}

/** Whether two texts, split into lines, are the same text. */
function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * A diagnostic for one item: its detail as the message, and its code as the
 * diagnostic's code, linked to the code's page (its type URI), which says
 * what the code means and what to do about it. An item read from the shape
 * problem items replace has no code: its `error_type` is the diagnostic's
 * code, unlinked, since it is no registry code and has no page.
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
    } else if (error.legacy?.errorType) {
        diag.code = error.legacy.errorType;
    }
    return diag;
}
