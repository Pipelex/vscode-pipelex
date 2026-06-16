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
        { primaryUri: PRIMARY, files: [], cwd: '/project', timeout: 30000 },
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

    it('maps exit 1 with validation_errors to a not-ok outcome', async () => {
        cliState.spawnReject = { exitCode: 1, stderr: JSON.stringify({ error: true, error_type: 'ValidateBundleError', message: 'invalid', validation_errors: [{ category: 'pipe_validation', message: 'bad pipe', pipe_code: 'x' }] }) };
        const analysis = await analyze();
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toHaveLength(1);
        expect(analysis.validation.errors[0].message).toBe('bad pipe');
    });

    it('synthesizes one diagnostic for an input-domain failure with no structured list', async () => {
        cliState.spawnReject = { exitCode: 1, stderr: JSON.stringify({ error: true, error_type: 'PipelexInterpreterError', error_domain: 'input', message: 'Missing required fields', validation_errors: [] }) };
        const analysis = await analyze();
        expect(analysis.validation.ok).toBe(false);
        expect(analysis.validation.errors).toEqual([{ category: 'blueprint_validation', message: 'Missing required fields', error_type: 'PipelexInterpreterError' }]);
    });

    it('surfaces a config-domain failure (no list) as an infra BackendError', async () => {
        cliState.version = [0, 34, 0];
        cliState.spawnReject = { exitCode: 1, stderr: JSON.stringify({ error: true, error_type: 'PipelexSetupError', error_domain: 'config', message: 'setup needed', validation_errors: [] }) };
        const err = await analyze().catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('infra');
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
        // A CLI in [0.31.0, 0.34.0) supports --allow-signatures/--view/--format json,
        // so it exits 0 — but emits source-less errors. The floor must be enforced
        // before we trust its output, not only on a spawn failure.
        cliState.version = [0, 32, 0];
        cliState.spawnResolve = { stdout: JSON.stringify({ graphspec: { nodes: [], edges: [] } }), stderr: '' };
        const err = await analyze(true).catch(e => e);
        expect(err).toBeInstanceOf(BackendError);
        expect(err.kind).toBe('too-old');
        expect(err.installedVersion).toBe('0.32.0');
        const processUtils = await import('../validation/processUtils');
        expect(vi.mocked(processUtils.spawnCli)).not.toHaveBeenCalled();
    });
});
