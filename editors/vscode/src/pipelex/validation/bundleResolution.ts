import type { BundleFile } from './backend';
import { escapeRegex, findTableHeaderInLines } from './sourceLocator';

/** A declaration kind addressable by a `[<kind>.<code>]` table header. */
export type DeclarationKind = 'pipe' | 'concept';

/**
 * Single source of truth for "which gathered file declares this pipe/concept".
 *
 * Both the cross-file diagnostics path ({@link resolveOwner} in
 * `crossFileDiagnostics.ts`) and the method-graph pipe-node navigation path build
 * on the primitives here, so they can never drift on HOW a `source` path is
 * matched or HOW a declaration header is located.
 *
 * Resolution is two-tier, mirroring the source-first / scan-fallback design:
 * 1. {@link matchSourceFile} — an exact owner from the backend-reported `source`
 *    path (the populated-whenever-possible path; keys on the declaring file, so a
 *    signature/concrete split resolves to the *winning* concrete declaration).
 * 2. {@link findDeclaringFileByScan} — scan the gathered files for the one that
 *    declares `[kind.code]`, preferring the file whose `domain` matches when the
 *    code collides across files.
 */
export function resolveDeclaringFile(args: {
    kind: DeclarationKind;
    code: string;
    domainCode?: string;
    source?: string;
    files: BundleFile[];
    getLines: (file: BundleFile) => string[];
}): BundleFile | undefined {
    const { kind, code, domainCode, source, files, getLines } = args;

    if (source) {
        const match = matchSourceFile(source, files);
        if (match && findTableHeaderInLines(getLines(match), kind, code) !== -1) {
            if (kind === 'pipe' && pipeDeclarationIsSignature(getLines(match), code)) {
                const concrete = findDeclaringFileByScan(
                    kind,
                    code,
                    files,
                    domainCode ?? fileDeclaredDomain(getLines(match)),
                    getLines,
                );
                if (concrete && !pipeDeclarationIsSignature(getLines(concrete), code)) {
                    return concrete;
                }
            }
            return match;
        }
    }

    return findDeclaringFileByScan(kind, code, files, domainCode, getLines);
}

/**
 * Match a backend-reported `source` path against the gathered files.
 *
 * The backend can report a POSIX-style relative source (e.g. `subdir/a.mthds`)
 * even on Windows, where `fsPath` uses `\`. Both sides are normalized to forward
 * slashes before matching, so a path-qualified source is not misrouted by a
 * separator mismatch. A bare filename matches by basename; a path-qualified
 * source must match exactly or on a path-segment boundary, so it can't misroute
 * onto a similarly-named sibling. Tolerates absolute and relative `source`
 * values alike (the local CLI emits absolute paths; the API emits per-content
 * names).
 */
export function matchSourceFile(source: string, files: BundleFile[]): BundleFile | undefined {
    const src = source.replace(/\\/g, '/');
    const srcBase = src.substring(src.lastIndexOf('/') + 1);
    const isBareName = src === srcBase;
    const matches = files.filter(f => {
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
    if (isBareName && matches.length > 1) {
        return undefined;
    }
    return matches[0];
}

/**
 * Find the gathered file that declares `[kind.code]`. When the same pipe header
 * appears in more than one file, prefer a concrete pipe over a `PipeSignature`
 * stub so click-to-code lands on the implementation. If `domainCode` is known,
 * apply that preference within the matching domain. Otherwise the first match
 * wins (gather order: primary first, then siblings sorted by name).
 */
export function findDeclaringFileByScan(
    kind: DeclarationKind,
    code: string,
    files: BundleFile[],
    domainCode: string | undefined,
    getLines: (file: BundleFile) => string[],
): BundleFile | undefined {
    const matches = files.filter(f => findTableHeaderInLines(getLines(f), kind, code) !== -1);
    if (matches.length <= 1) {
        return matches[0];
    }
    const domainMatches = domainCode
        ? matches.filter(f => fileDeclaresDomain(getLines(f), domainCode))
        : [];
    const preferredMatches = domainMatches.length > 0 ? domainMatches : matches;
    if (kind === 'pipe') {
        return preferredMatches.find(f => !pipeDeclarationIsSignature(getLines(f), code))
            ?? preferredMatches[0];
    }
    return preferredMatches[0];
}

/** Whether a file's lines declare a top-level `domain = "<domainCode>"`. */
function fileDeclaresDomain(lines: string[], domainCode: string): boolean {
    return fileDeclaredDomain(lines) === domainCode;
}

function fileDeclaredDomain(lines: string[]): string | undefined {
    for (const line of lines) {
        const match = /^\s*domain\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/.exec(line);
        if (match) {
            return match[2];
        }
        // A `domain` key is a top-level bundle field; stop at the first table so a
        // later `domain = ` inside a `[concept.X.structure]` field can't false-match.
        if (/^\s*\[/.test(line)) {
            break;
        }
    }
    return undefined;
}

/** Whether a `[pipe.<code>]` section is a signature-only declaration. */
function pipeDeclarationIsSignature(lines: string[], code: string): boolean {
    const headerLine = findTableHeaderInLines(lines, 'pipe', code);
    if (headerLine === -1) {
        return false;
    }
    for (let i = headerLine + 1; i < lines.length; i++) {
        const text = lines[i];
        if (/^\s*\[/.test(text)) {
            break;
        }
        if (/^\s*type\s*=\s*(["'])PipeSignature\1\s*(?:#.*)?$/.test(text)) {
            return true;
        }
    }
    return false;
}
