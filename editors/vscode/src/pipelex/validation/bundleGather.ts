import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { BundleFile } from './backend';

/** Extensions the CLI treats as bundle files. `.plx` is the deprecated alias. */
const MTHDS_GLOB = /\.(mthds|plx)$/i;

/**
 * Gather every `.mthds` file in the saved file's directory, mirroring the CLI's
 * `--library-dir <dir>` (a non-recursive `glob("*.mthds")` over the directory).
 *
 * v1 reads sibling contents from disk — the just-saved primary is already
 * flushed, so disk is current. Reading unsaved editor buffers for fresher
 * cross-file diagnostics is a deliberate follow-up.
 *
 * The primary file is placed first; siblings follow sorted by name for
 * deterministic ordering. Each file's `name` is its basename — unique within a
 * single directory and what the API threads onto `blueprint.source` so cross-file
 * diagnostics name the owning file.
 *
 * **Known divergence from CLI resolution:** this gather is flat (one directory).
 * It does NOT follow nested directories, configured/installed libraries, or
 * resolve symlinks the way full bundle resolution might. For the common
 * single-directory bundle it matches `--library-dir`; richer resolution is a
 * follow-up.
 */
export async function gatherBundleFiles(primaryUri: vscode.Uri): Promise<BundleFile[]> {
    const primaryPath = primaryUri.fsPath;
    const dir = path.dirname(primaryPath);
    const primaryName = path.basename(primaryPath);

    let entries: string[];
    try {
        entries = await fs.promises.readdir(dir);
    } catch {
        // Directory unreadable — fall back to just the primary file.
        entries = [primaryName];
    }

    const siblingNames = entries
        .filter(name => MTHDS_GLOB.test(name) && name !== primaryName)
        .sort((a, b) => a.localeCompare(b));

    const orderedNames = [primaryName, ...siblingNames];

    const files: BundleFile[] = [];
    for (const name of orderedNames) {
        const fsPath = path.join(dir, name);
        let content: string;
        try {
            content = await fs.promises.readFile(fsPath, 'utf-8');
        } catch {
            // A sibling vanished between readdir and read — skip it. The primary
            // is the one that just saved, so it is virtually always readable.
            if (name === primaryName) {
                throw new Error(`Could not read ${fsPath}`);
            }
            continue;
        }
        files.push({
            uri: name === primaryName ? primaryUri : vscode.Uri.file(fsPath),
            name,
            content,
        });
    }

    return files;
}
