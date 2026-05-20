import { execFile } from 'child_process';

/**
 * Probe `pipelex-agent --version` and return the parsed semver, or null if
 * the probe fails or the output is unparseable. Cached per (command + args)
 * for the lifetime of the extension host.
 *
 * Used to give actionable error messages when an installed `pipelex-agent`
 * predates a feature the extension relies on (e.g. `--format json`, which
 * landed in 0.29.0).
 */

export type Semver = readonly [number, number, number];

/** First `pipelex-agent` version that accepts `validate bundle --format json`. */
export const MIN_FORMAT_JSON_VERSION: Semver = [0, 29, 0];

const cache = new Map<string, Promise<Semver | null>>();

const VERSION_RE = /pipelex-agent\s+(\d+)\.(\d+)\.(\d+)/;

export function compareSemver(a: Semver, b: Semver): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

export function formatSemver(v: Semver): string {
    return `${v[0]}.${v[1]}.${v[2]}`;
}

export function getAgentCliVersion(command: string, baseArgs: string[]): Promise<Semver | null> {
    const key = JSON.stringify([command, baseArgs]);
    const cached = cache.get(key);
    if (cached) return cached;

    const probe = new Promise<Semver | null>((resolve) => {
        execFile(command, [...baseArgs, '--version'], { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                resolve(null);
                return;
            }
            const match = (stdout || stderr || '').match(VERSION_RE);
            if (!match) {
                resolve(null);
                return;
            }
            resolve([Number(match[1]), Number(match[2]), Number(match[3])]);
        });
    });

    cache.set(key, probe);
    return probe;
}

/** Test/diagnostic helper — clears the in-memory version cache. */
export function clearAgentCliVersionCache(): void {
    cache.clear();
}
