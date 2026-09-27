import * as vscode from 'vscode';
import { orderMthdsSources } from '@pipelex/mthds-ui/static-graph';
import { gatherBundleFiles } from './bundleGather';
import type { BundleFile } from './backend';

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
 *
 * Which file leads is `@pipelex/mthds-ui`'s rule (`orderMthdsSources`), shared
 * with every other host that merges a method's files, so the panel, the
 * standalone viewer and the hosted app can never disagree about it: the opened
 * file leads when it declares a top-level `main_pipe`, otherwise the file that
 * does (`bundle.mthds` when several do), otherwise the opened file. The rule
 * matches the opened file by `name`, which is safe here because the gather is
 * flat and every `name` is a basename unique within its directory.
 */
export async function resolveGraphPrimaryBundle(openedUri: vscode.Uri): Promise<GraphPrimaryBundle> {
    const files = await gatherBundleFiles(openedUri);
    const opened = files.find(file => file.uri.toString() === openedUri.toString());
    const ordered = orderMthdsSources(files, opened);
    return {
        primaryUri: ordered[0]?.uri ?? openedUri,
        files: ordered,
    };
}
