import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Hoisted mock state ----------
const cliState = vi.hoisted(() => ({
    resolveResult: { command: 'pipelex-agent', args: [] } as { command: string; args: string[] } | null,
    spawnResolve: { stdout: '', stderr: '' } as { stdout: string; stderr: string } | null,
    spawnReject: null as any,
    version: null as readonly [number, number, number] | null,
}));

vi.mock('../validation/cliResolver', () => ({
    resolveCli: vi.fn(() => cliState.resolveResult),
}));

vi.mock('../validation/processUtils', () => ({
    spawnCli: vi.fn(() => (cliState.spawnReject ? Promise.reject(cliState.spawnReject) : Promise.resolve(cliState.spawnResolve))),
}));

vi.mock('../validation/agentCliVersion', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../validation/agentCliVersion')>();
    return { ...actual, getAgentCliVersion: vi.fn(async () => cliState.version) };
});

import { CliValidationBackend } from '../validation/cliValidationBackend';
import { BackendError } from '../validation/backend';

const PRIMARY = { fsPath: '/project/methods/main.mthds', toString: () => 'file:///project/methods/main.mthds' } as any;

function analyze(withGraph = false) {
    const backend = new CliValidationBackend();
    const controller = new AbortController();
    return backend.analyze(
        { primaryUri: PRIMARY, savedUri: PRIMARY, cwd: '/project', timeout: 30000 },
        { withGraph, direction: 'top_down' },
        controller.signal,
    );
}

describe('CliValidationBackend', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cliState.resolveResult = { command: 'pipelex-agent', args: [] };
        cliState.spawnResolve = { stdout: '', stderr: '' };
        cliState.spawnReject = null;
        cliState.version = null;
    });

    it('throws a not-found BackendError when the CLI cannot be resolved', async () => {
        cliState.resolveResult = null;
        const err = await analyze().catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('not-found');
        expect(err.userMessage).toMatch(/pipelex-agent/);
    });

    it('returns ok on exit 0 (diagnostics-only)', async () => {
        const analysis = await analyze(false);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.graph).toBeUndefined();
    });

    it('returns ok + parsed graphspec on exit 0 with --view', async () => {
        cliState.spawnResolve = { stdout: JSON.stringify({ graphspec: { nodes: [], edges: [] }, pipe_code: 'main' }), stderr: '' };
        const analysis = await analyze(true);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.graph).toEqual({ nodes: [], edges: [] });
    });

    it('builds the args with --library-dir <dir>, --allow-signatures and --format json', async () => {
        const processUtils = await import('../validation/processUtils');
        await analyze(true);
        const args = vi.mocked(processUtils.spawnCli).mock.calls[0][1] as string[];
        expect(args).toEqual(expect.arrayContaining(['validate', 'bundle', '/project/methods/main.mthds', '--library-dir', '/project/methods', '--allow-signatures', '--view', '--format', 'json']));
    });

    it('reads the advisory warnings of a valid verdict from stdout', async () => {
        const warning = {
            code: 'method.hint_invalid',
            detail: "The hint 'intent' of input 'notes' is unknown.",
            location: { pipe: 'main', field: 'inputs', file: '/project/methods/main.mthds' },
        };
        cliState.spawnResolve = {
            stdout: JSON.stringify({ success: true, is_valid: true, warnings: [warning] }),
            stderr: '',
        };
        const analysis = await analyze(false);
        expect(analysis.validation.ok).toBe(true);
        expect(analysis.validation.warnings).toEqual([warning]);
    });

    it('reads no warnings from a stdout that holds none', async () => {
        cliState.spawnResolve = { stdout: 'not json', stderr: '' };
        const analysis = await analyze(false);
        expect(analysis.validation.warnings).toEqual([]);
    });

    it("maps exit 1 with the method.invalid problem to a not-ok outcome holding its items", async () => {
        const item = {
            code: 'method.syntax',
            detail: 'The file main.mthds is not valid TOML.',
            params: { finding: 'TOML syntax error' },
            location: { file: '/project/methods/main.mthds', line: 3, column: 7 },
        };
        cliState.spawnReject = {
            exitCode: 1,
            stderr: JSON.stringify({
                type: 'https://mthds.ai/errors/method.invalid',
                title: 'The method does not validate',
                code: 'method.invalid',
                domain: 'method',
                retry: 'no',
                detail: 'The method does not validate.',
                next_step: { kind: 'change_method', detail: "Fix each fault the problem's errors list, then validate the method again." },
                errors: [item],
                message: 'Bundle validation failed',
                is_valid: false,
                bundle_path: '/project/methods/main.mthds',
            }),
        };
        const analysis = await analyze();
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([item]);
    });

    it('returns graph:null beside the errors when the graph was asked for', async () => {
        cliState.spawnReject = {
            exitCode: 1,
            stderr: JSON.stringify({ code: 'method.invalid', detail: 'The method does not validate.', is_valid: false, errors: [{ code: 'pipe.input_unresolved', detail: "Pipe 'main' could not read 'text', which an earlier step should have produced.", location: { pipe: 'main' } }] }),
        };
        const analysis = await analyze(true);
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.graph).toBeNull();
    });

    it('keeps the warnings an invalid verdict carries beside its errors', async () => {
        const error = { code: 'pipe.input_unresolved', detail: "Pipe 'main' could not read 'text'.", location: { pipe: 'main' } };
        const warning = { code: 'method.hint_invalid', detail: "The hint 'intent' of input 'notes' is unknown.", location: { pipe: 'main', field: 'inputs' } };
        cliState.spawnReject = {
            exitCode: 1,
            stderr: JSON.stringify({ code: 'method.invalid', detail: 'The method does not validate.', is_valid: false, errors: [error], warnings: [warning] }),
        };
        const analysis = await analyze();
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([error]);
        expect(analysis.validation.warnings).toEqual([warning]);
    });

    it('reads an invalid verdict whose items cannot be read as its own code and detail, not as a failure to validate', async () => {
        cliState.spawnReject = {
            exitCode: 1,
            stderr: JSON.stringify({
                code: 'method.invalid',
                detail: 'The method does not validate.',
                next_step: { kind: 'change_method', detail: "Fix each fault the problem's errors list, then validate the method again." },
                is_valid: false,
                errors: [{ unreadable: true }],
                warnings: [{ code: 'method.hint_invalid', detail: 'odd hint' }],
            }),
        };
        const analysis = await analyze(true);
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([{ code: 'method.invalid', detail: 'The method does not validate.' }]);
        expect(analysis.validation.warnings).toEqual([{ code: 'method.hint_invalid', detail: 'odd hint' }]);
        expect(analysis.graph).toBeNull();
    });

    it('reads no verdict from the envelope problems replaced, whatever its validation_errors hold', async () => {
        // The floor stops a CLI that writes this envelope before it runs; one whose
        // version cannot be probed still gets here. Its items are not read, and it
        // has no problem of its own to show, so it surfaces as infra rather than
        // as a verdict or a synthesized stand-in item.
        for (const envelope of [
            { error: true, error_type: 'ValidateBundleError', message: 'invalid', validation_errors: [{ category: 'pipe_validation', message: 'bad pipe', pipe_code: 'x' }] },
            { error: true, error_type: 'MthdsParserError', error_domain: 'input', message: 'Missing required fields', validation_errors: [] },
            { error: true, error_type: 'PipelexSetupError', error_domain: 'config', message: 'setup needed', validation_errors: [] },
        ]) {
            cliState.spawnReject = { exitCode: 1, stderr: JSON.stringify(envelope) };
            const err = await analyze().catch(e => e);
            expect(err).toBeInstanceOf(BackendError);
            expect(err.kind).toBe('infra');
            expect(err.userMessage).toBeUndefined();
        }
    });

    it("shows a problem that produced no verdict with its detail and next step", async () => {
        cliState.spawnReject = {
            exitCode: 1,
            stderr: 'WARNING: something\n' + JSON.stringify({
                type: 'https://docs.pipelex.com/errors/pipelex.config.invalid',
                title: "The runtime's configuration is invalid",
                code: 'pipelex.config.invalid',
                domain: 'operator',
                retry: 'no',
                detail: "The runtime's configuration is invalid, so it cannot serve this request.",
                next_step: {
                    kind: 'fix_configuration',
                    detail: "Correct the setting 'default' in the file 'routing_profiles.toml' of the backends configuration, then restart the runtime.",
                },
            }),
        };
        const err = await analyze().catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('infra');
        expect(err.userMessage).toBe(
            "pipelex-agent could not validate this method: The runtime's configuration is invalid, so it cannot serve this request. " +
            "Next step: Correct the setting 'default' in the file 'routing_profiles.toml' of the backends configuration, then restart the runtime.",
        );
        expect(err.logMessage).toBe(
            "pipelex-agent: The runtime's configuration is invalid, so it cannot serve this request. (code pipelex.config.invalid)",
        );
    });

    it('logs the request id of a problem that carries one beside its code, as the API path does', async () => {
        cliState.spawnReject = {
            exitCode: 1,
            stderr: JSON.stringify({
                code: 'model.unavailable',
                detail: "The model 'gpt-x' cannot be reached.",
                request_id: 'req_cli_1',
            }),
        };
        const err = await analyze().catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.logMessage).toBe("pipelex-agent: The model 'gpt-x' cannot be reached. (code model.unavailable, request req_cli_1)");
        // The id is for the log, not the toast.
        expect(err.userMessage).not.toContain('req_cli_1');
    });

    it('reads a problem on stderr whatever the exit code', async () => {
        cliState.spawnReject = {
            exitCode: 2,
            stderr: JSON.stringify({ code: 'client.argument_invalid', detail: "The argument '--nope' was refused before any request left (reason: unknown).", next_step: { kind: 'change_input', detail: "Correct the argument '--nope', then try again." } }),
        };
        const err = await analyze().catch(e => e);
        expect(err.kind).toBe('infra');
        expect(err.userMessage).toBe(
            "pipelex-agent could not validate this method: The argument '--nope' was refused before any request left (reason: unknown). " +
            "Next step: Correct the argument '--nope', then try again.",
        );
    });

    it('detects an outdated CLI that argparse-errors on an unknown flag', async () => {
        cliState.version = [0, 30, 0];
        cliState.spawnReject = { exitCode: 1, stderr: 'usage: pipelex-agent ... unrecognized arguments: --allow-signatures' };
        const err = await analyze().catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('too-old');
        expect(err.installedVersion).toBe('0.30.0');
    });

    it('rejects a CLI below the floor up front, even when it would validate cleanly', async () => {
        // A CLI older than 0.90.0 supports --allow-signatures/--view/--format json,
        // so it exits 0 on a valid method — but reports an invalid one as the
        // validation_errors envelope, which is not read. The floor must be enforced
        // before we trust its output, not only on a spawn failure.
        cliState.version = [0, 89, 0];
        cliState.spawnResolve = { stdout: JSON.stringify({ graphspec: { nodes: [], edges: [] } }), stderr: '' };
        const err = await analyze(true).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('too-old');
        expect(err.installedVersion).toBe('0.89.0');
        expect(err.minVersion).toBe('0.90.0');
        const processUtils = await import('../validation/processUtils');
        expect(vi.mocked(processUtils.spawnCli)).not.toHaveBeenCalled();
    });

    it('runs a CLI at the floor, the first release that writes problem items', async () => {
        cliState.version = [0, 90, 0];
        const analysis = await analyze(false);
        expect(analysis.validation.ok).toBe(true);
        const processUtils = await import('../validation/processUtils');
        expect(vi.mocked(processUtils.spawnCli)).toHaveBeenCalledTimes(1);
    });
});
