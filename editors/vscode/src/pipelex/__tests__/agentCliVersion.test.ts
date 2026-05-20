import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process.execFile so the probe is fully controllable.
// The mock records each invocation so we can assert that cwd is forwarded
// and that the per-cwd cache key isolates results across workspaces.
type ExecFileCall = {
    command: string;
    args: readonly string[];
    options: { cwd?: string };
};

const calls: ExecFileCall[] = [];
let nextStdout = 'pipelex-agent 0.29.0\n';

vi.mock('child_process', () => ({
    execFile: (
        command: string,
        args: readonly string[],
        options: { cwd?: string },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
        calls.push({ command, args, options });
        cb(null, nextStdout, '');
    },
}));

import { getAgentCliVersion, clearAgentCliVersionCache } from '../validation/agentCliVersion';

describe('getAgentCliVersion', () => {
    beforeEach(() => {
        clearAgentCliVersionCache();
        calls.length = 0;
    });

    it('forwards cwd to execFile so uv resolves the right project env', async () => {
        await getAgentCliVersion('uv', ['run', 'pipelex-agent'], '/workspace/a');
        expect(calls).toHaveLength(1);
        expect(calls[0].options.cwd).toBe('/workspace/a');
        expect(calls[0].args).toEqual(['run', 'pipelex-agent', '--version']);
    });

    it('keys the cache by cwd so different workspaces probe independently', async () => {
        nextStdout = 'pipelex-agent 0.29.0\n';
        const a = await getAgentCliVersion('uv', ['run', 'pipelex-agent'], '/workspace/a');

        nextStdout = 'pipelex-agent 0.28.0\n';
        const b = await getAgentCliVersion('uv', ['run', 'pipelex-agent'], '/workspace/b');

        expect(a).toEqual([0, 29, 0]);
        expect(b).toEqual([0, 28, 0]);
        expect(calls).toHaveLength(2);
    });

    it('reuses the cached probe for the same (command, args, cwd) triple', async () => {
        nextStdout = 'pipelex-agent 0.29.0\n';
        await getAgentCliVersion('uv', ['run', 'pipelex-agent'], '/workspace/a');
        await getAgentCliVersion('uv', ['run', 'pipelex-agent'], '/workspace/a');
        expect(calls).toHaveLength(1);
    });
});
