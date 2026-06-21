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
        const onAbort = () => {
            proc.kill();
        };
        const proc = execFile(command, args, { timeout, maxBuffer: 1024 * 1024, cwd }, (err, stdout, stderr) => {
            signal.removeEventListener('abort', onAbort);
            if (err) {
                reject({ exitCode: (err as NodeJS.ErrnoException).code, stderr, stdout, message: err.message });
            } else {
                resolve({ stdout, stderr });
            }
        });

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

/**
 * Cancel every inflight request whose URI lives in `dir`. Used when validation is
 * turned off mid-flight: the per-URI cancel only supersedes the saved file, so a
 * sibling analysing in the same directory (not cancelled, generation unchanged)
 * could still pass its generation gate and publish directory diagnostics after
 * validation is disabled. `dirOfKey` maps an inflight key (a `Uri.toString()`) to
 * its parent directory; injected so this stays free of a `vscode` dependency.
 */
export function cancelInflightInDir(
    inflight: Map<string, AbortController>,
    dir: string,
    dirOfKey: (key: string) => string,
) {
    for (const [key, controller] of inflight) {
        if (dirOfKey(key) === dir) {
            controller.abort();
            inflight.delete(key);
        }
    }
}
