import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { BundleFile } from './backend';

/** The extension the CLI treats as a bundle file. */
const MTHDS_GLOB = /\.mthds$/i;

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
 * single directory — and an item's `location.file` is matched against it and
 * the file's path, so an item naming a file by its path in the method tree
 * lands on that file.
 *
 * **Known divergence from what the API validates:** this gather is flat (one
 * directory), while the API backend sends the saved file's whole method tree,
 * which may be rooted at a `METHODS.toml` above the directory and hold bundles
 * in nested directories. An item naming such a bundle is placed by the
 * declaration scan, else on the primary. For the common single-directory
 * bundle the two agree, and the gather matches `--library-dir`; placing items
 * on the tree's own files is a follow-up.
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
