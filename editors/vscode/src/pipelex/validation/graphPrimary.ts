import * as vscode from 'vscode';
import { gatherBundleFiles } from './bundleGather';
import type { BundleFile } from './backend';

const DEFAULT_BUNDLE_NAME = 'bundle.mthds';

export interface GraphPrimaryBundle {
    /** The file whose `main_pipe` should anchor graph generation. */
    primaryUri: vscode.Uri;
    /** Gathered bundle files, reordered so `primaryUri` is first when present. */
    files: BundleFile[];
}

/**
 * Resolve the graph-analysis anchor for an opened `.mthds` file.
 *
 * Most graph opens are for the real bundle file, but users often open an
 * ancillary sibling (signatures, concepts, helper pipes) inside a directory
 * whose `bundle.mthds` declares the method's `main_pipe`. In that case the
 * graph should still be generated from the directory's main bundle.
 */
export async function resolveGraphPrimaryBundle(openedUri: vscode.Uri): Promise<GraphPrimaryBundle> {
    const files = await gatherBundleFiles(openedUri);
    const primary = selectGraphPrimaryFile(openedUri, files);
    return {
        primaryUri: primary?.uri ?? openedUri,
        files: primary ? reorderFilesWithPrimary(files, primary.uri) : files,
    };
}

export function selectGraphPrimaryFile(openedUri: vscode.Uri, files: BundleFile[]): BundleFile | undefined {
    const opened = files.find(file => file.uri.toString() === openedUri.toString()) ?? files[0];
    if (!opened) return undefined;

    if (hasTopLevelMainPipe(opened.content)) {
        return opened;
    }

    const filesWithMain = files.filter(file => hasTopLevelMainPipe(file.content));
    const defaultBundle = filesWithMain.find(file => file.name.toLowerCase() === DEFAULT_BUNDLE_NAME);
    return defaultBundle ?? filesWithMain[0] ?? opened;
}

export function hasTopLevelMainPipe(content: string): boolean {
    for (const line of content.split(/\r\n|\r|\n/)) {
        if (/^\s*\[/.test(line)) return false;
        if (/^\s*main_pipe\s*=\s*(["'])[^"']+\1\s*(?:#.*)?$/.test(line)) {
            return true;
        }
    }
    return false;
}

function reorderFilesWithPrimary(files: BundleFile[], primaryUri: vscode.Uri): BundleFile[] {
    const index = files.findIndex(file => file.uri.toString() === primaryUri.toString());
    if (index <= 0) return files;
    return [files[index], ...files.slice(0, index), ...files.slice(index + 1)];
}
