import * as fs from 'fs';
import * as path from 'path';

/**
 * The `/validate` artifacts a run writes beside its graphspec, and the reason
 * they have to be read off the disk rather than derived here.
 *
 * `GraphViewer`'s detail panel renders a data node's VALUE only when the host
 * hands it two artifacts keyed by pipe ref: `pipe_io_contracts` (the payload's
 * JSON Schema, naming the property the concept's content model wraps the value
 * under) and `output_form` (the descriptor node saying what the result IS).
 * Pass neither and the panel takes mthds-ui's documented floor — the concept's
 * structure table and no data tab — which is the honest rendering for a spec
 * whose artifacts nobody holds, and exactly the wrong one for a run whose
 * payloads are sitting right there in the graphspec.
 *
 * A run's `graphspec.json` carries neither artifact, and carries no path back
 * to the bundle it came from, so nothing downstream can regenerate them: the
 * local CLI cannot emit them at all, and the API needs a bundle to validate
 * that a bare run file does not name. The runtime is the only place that holds
 * the loaded library at the moment the graphspec is written, so it writes all
 * three side by side — tracked as L-260907-817d80. This module is the reading
 * half of that arrangement: siblings of the graphspec, found by name.
 *
 * Only the `graphspec-json` view calls it. A `.mthds` editor builds its graph
 * statically from bundle text and has no run data to show, so the structure
 * table is already the right rendering there.
 */

/** The artifact trio, in the shape `adapter.ts` spreads onto `GraphViewer`. */
export interface RunArtifacts {
    /** `pipe_io_contracts` — keyed by pipe ref. */
    contracts: Record<string, unknown>;
    /** `output_form` — keyed by pipe ref, from the same `/validate` call. */
    outputForm: Record<string, unknown>;
    /**
     * `input_form`, present only when the run wrote it. It is what lets a
     * method's own INPUTS show a value: no pipe produced them, so no output
     * descriptor describes them, and the consuming pipe's descriptor for their
     * slot is what names them instead.
     */
    inputForm?: Record<string, unknown>;
}

/** Sibling file names, fixed by what the runtime writes. */
const CONTRACTS_FILE = 'pipe_io_contracts.json';
const OUTPUT_FORM_FILE = 'output_form.json';
const INPUT_FORM_FILE = 'input_form.json';

type Log = (message: string) => void;

/**
 * One artifact file, or `undefined` for every way it can fail to be one.
 *
 * A missing file is silence: the overwhelmingly common case is a graphspec
 * written before the runtime emitted artifacts at all, and a line of log per
 * open would be noise. Anything else — unreadable, not JSON, or JSON that is
 * not the pipe-ref-keyed object the viewer joins against — is logged, because
 * it means a file IS there and is not what it claims to be.
 */
async function readArtifactFile(
    filePath: string,
    log?: Log,
): Promise<Record<string, unknown> | undefined> {
    let raw: string;
    try {
        raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err: any) {
        if (err?.code !== 'ENOENT') {
            log?.(`pipelex graph: could not read ${path.basename(filePath)}: ${err?.message ?? err}`);
        }
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: any) {
        log?.(`pipelex graph: ${path.basename(filePath)} is not valid JSON: ${err?.message ?? err}`);
        return undefined;
    }

    // Both artifacts are maps from pipe ref to descriptor. An array or a scalar
    // parses fine and then joins against nothing, so it is rejected here rather
    // than reaching the viewer as an object with no keys.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log?.(`pipelex graph: ${path.basename(filePath)} is not a pipe-ref-keyed object; ignoring it`);
        return undefined;
    }
    return parsed as Record<string, unknown>;
}

/**
 * Load the artifacts sitting beside `graphspecFsPath`, or `undefined` when the
 * pair the viewer needs is not both there.
 *
 * **Both required files or neither.** `GraphViewer` renders data only when
 * `contracts` AND `outputForm` are present, so handing it one of the two is
 * indistinguishable at the panel from handing it none — except that it hides
 * the fact that a results directory is half written. When exactly one is
 * present that is said out loud; when neither is, this is simply a graphspec
 * from before the runtime wrote artifacts, and nothing is logged.
 *
 * `inputForm` is genuinely optional and never gates the pair.
 */
export async function readRunArtifacts(
    graphspecFsPath: string,
    log?: Log,
): Promise<RunArtifacts | undefined> {
    const dir = path.dirname(graphspecFsPath);

    const [contracts, outputForm, inputForm] = await Promise.all([
        readArtifactFile(path.join(dir, CONTRACTS_FILE), log),
        readArtifactFile(path.join(dir, OUTPUT_FORM_FILE), log),
        readArtifactFile(path.join(dir, INPUT_FORM_FILE), log),
    ]);

    if (!contracts || !outputForm) {
        if (contracts || outputForm) {
            const missing = contracts ? OUTPUT_FORM_FILE : CONTRACTS_FILE;
            log?.(
                `pipelex graph: ${missing} is missing or unusable beside the graphspec, `
                + 'so the detail panel cannot show values — both artifacts are required together.',
            );
        }
        return undefined;
    }

    return inputForm ? { contracts, outputForm, inputForm } : { contracts, outputForm };
}
