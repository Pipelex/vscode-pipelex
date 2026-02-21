import { execFile } from 'child_process';

export interface SpawnResult {
    stdout: string;
    stderr: string;
}

/**
 * Spawn a CLI process and return its stdout and stderr.
 * Rejects with `{ exitCode, stderr, stdout, message }` on non-zero exit.
 */
export function spawnCli(
    command: string,
    args: string[],
    timeout: number,
    signal: AbortSignal,
    cwd?: string,
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const proc = execFile(command, args, { timeout, maxBuffer: 1024 * 1024, cwd }, (err, stdout, stderr) => {
            if (err) {
                reject({ exitCode: (err as any).code ?? err.code, stderr, stdout, message: err.message });
            } else {
                resolve({ stdout, stderr });
            }
        });

        const onAbort = () => {
            proc.kill();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Cancel the inflight request for a specific URI key. */
export function cancelInflightByKey(inflight: Map<string, AbortController>, uriKey: string) {
    const existing = inflight.get(uriKey);
    if (existing) {
        existing.abort();
        inflight.delete(uriKey);
    }
}

/** Cancel ALL inflight requests. */
export function cancelAllInflight(inflight: Map<string, AbortController>) {
    for (const controller of inflight.values()) {
        controller.abort();
    }
    inflight.clear();
}
