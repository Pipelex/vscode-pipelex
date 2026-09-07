import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readRunArtifacts } from '../graph/runArtifacts';

// Real files in a real temp directory rather than a mocked `fs`. The whole
// point of this module is what the filesystem hands back — a missing sibling,
// an unreadable one, half a pair — and a mock would only be asserting the
// mock's own behaviour.
let dir: string;
let graphspec: string;
let logged: string[];

const log = (message: string) => { logged.push(message); };

function write(name: string, content: string) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

const CONTRACTS = { 'domain.pipe_a': { inputs: {}, output: {} } };
const OUTPUT_FORM = { 'domain.pipe_a': { field: { kind: 'text' } } };
const INPUT_FORM = { 'domain.pipe_a': { fields: [] } };

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipelex-run-artifacts-'));
    graphspec = path.join(dir, 'graphspec.json');
    fs.writeFileSync(graphspec, '{}', 'utf-8');
    logged = [];
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('readRunArtifacts', () => {
    it('loads the required pair from the graphspec\'s own directory', async () => {
        write('pipe_io_contracts.json', JSON.stringify(CONTRACTS));
        write('output_form.json', JSON.stringify(OUTPUT_FORM));

        const artifacts = await readRunArtifacts(graphspec, log);

        expect(artifacts).toEqual({ contracts: CONTRACTS, outputForm: OUTPUT_FORM });
        // input_form is genuinely optional: its absence is not worth a word.
        expect(artifacts!.inputForm).toBeUndefined();
        expect(logged).toEqual([]);
    });

    it('carries input_form when the run wrote one', async () => {
        write('pipe_io_contracts.json', JSON.stringify(CONTRACTS));
        write('output_form.json', JSON.stringify(OUTPUT_FORM));
        write('input_form.json', JSON.stringify(INPUT_FORM));

        const artifacts = await readRunArtifacts(graphspec, log);

        expect(artifacts).toEqual({
            contracts: CONTRACTS,
            outputForm: OUTPUT_FORM,
            inputForm: INPUT_FORM,
        });
        expect(logged).toEqual([]);
    });

    // A graphspec written before the runtime emitted artifacts at all. This is
    // the overwhelmingly common case, so it must stay silent — a line per open
    // would be noise, and the viewer's no-data floor is the correct rendering.
    it('returns undefined and says nothing when neither artifact is there', async () => {
        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(logged).toEqual([]);
    });

    // GraphViewer renders data only when BOTH arrive, so half a pair is
    // indistinguishable at the panel from none — except that it hides a
    // half-written results directory. Hence: same floor, but said out loud.
    it('refuses a lone pipe_io_contracts.json and names what is missing', async () => {
        write('pipe_io_contracts.json', JSON.stringify(CONTRACTS));

        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('output_form.json');
    });

    it('refuses a lone output_form.json and names what is missing', async () => {
        write('output_form.json', JSON.stringify(OUTPUT_FORM));

        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('pipe_io_contracts.json');
    });

    it('logs malformed JSON rather than throwing, and takes the floor', async () => {
        write('pipe_io_contracts.json', '{ not json');
        write('output_form.json', JSON.stringify(OUTPUT_FORM));

        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(logged.some(m => m.includes('pipe_io_contracts.json') && m.includes('not valid JSON'))).toBe(true);
    });

    // An array parses fine and then joins against nothing, so it is rejected
    // here rather than reaching the viewer as an object with no pipe refs.
    it('rejects an artifact that is not a pipe-ref-keyed object', async () => {
        write('pipe_io_contracts.json', JSON.stringify(CONTRACTS));
        write('output_form.json', JSON.stringify([OUTPUT_FORM]));

        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(logged.some(m => m.includes('output_form.json') && m.includes('pipe-ref-keyed'))).toBe(true);
    });

    // A malformed input_form must never cost the pair its data view: the two
    // required artifacts are complete, so the panel renders results and only
    // the method's own inputs fall back to the structure table.
    it('keeps the pair when only input_form.json is malformed', async () => {
        write('pipe_io_contracts.json', JSON.stringify(CONTRACTS));
        write('output_form.json', JSON.stringify(OUTPUT_FORM));
        write('input_form.json', 'null');

        const artifacts = await readRunArtifacts(graphspec, log);

        expect(artifacts).toEqual({ contracts: CONTRACTS, outputForm: OUTPUT_FORM });
        expect(logged.some(m => m.includes('input_form.json'))).toBe(true);
    });

    it('reads siblings of the graphspec, not of the working directory', async () => {
        const nested = path.join(dir, 'results');
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(nested, 'pipe_io_contracts.json'), JSON.stringify(CONTRACTS), 'utf-8');
        fs.writeFileSync(path.join(nested, 'output_form.json'), JSON.stringify(OUTPUT_FORM), 'utf-8');

        // The artifacts live beside the nested graphspec, so the one at the top
        // level (which has none) must still take the floor.
        expect(await readRunArtifacts(graphspec, log)).toBeUndefined();
        expect(await readRunArtifacts(path.join(nested, 'graphspec.json'), log)).toEqual({
            contracts: CONTRACTS,
            outputForm: OUTPUT_FORM,
        });
    });

    it('works without a logger', async () => {
        write('pipe_io_contracts.json', '{ not json');
        await expect(readRunArtifacts(graphspec)).resolves.toBeUndefined();
    });
});
