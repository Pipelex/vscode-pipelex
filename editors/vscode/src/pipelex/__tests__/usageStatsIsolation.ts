/**
 * Usage-statistics isolation for the whole extension suite, loaded before every test
 * file by `setupFiles` in `vitest.config.mts`.
 *
 * The extension reads and writes the shared state under `~/.mthds/usage-stats/` and
 * posts to PostHog, so no test may run it in the developer's home or let it reach a
 * real host:
 * - `HOME` and `USERPROFILE` point at a throwaway directory before any test module
 *   loads, so `os.homedir()`, and every state directory derived from it, is that
 *   directory, removed when the file's tests end;
 * - `DO_NOT_TRACK=1` and a loopback endpoint override are in `process.env`, which the
 *   service reads when it is given no host of its own;
 * - the global `fetch` refuses every request to a host other than loopback, and the
 *   test that made one fails, even when the code under test swallowed the error.
 *
 * The tests of the reporting itself pass their own throwaway home and a loopback
 * endpoint (a capture server, or a port nothing listens on) to the service.
 */
import { afterAll, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The hosts a test may reach: `URL.hostname` keeps the brackets of an IPv6 literal. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-pipelex-test-home-')));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.DO_NOT_TRACK = '1';
process.env.PIPELEX_USAGE_STATS_ENDPOINT = 'http://127.0.0.1:9';
if (os.homedir() !== TEST_HOME) {
    throw new Error(`usage-statistics test isolation: os.homedir() is ${os.homedir()}, not the test home`);
}

const refused: string[] = [];
const realFetch = globalThis.fetch;

function urlOf(input: string | URL | Request): URL {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
}

globalThis.fetch = async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
        refused.push(`${init?.method ?? 'GET'} ${url.origin}`);
        throw new TypeError(`usage-statistics test guard: refused a request to ${url.origin}, which is not a loopback host`);
    }
    return realFetch(input, init);
};

/** The requests the guard refused since the last call, which it then forgets. */
export function takeRefusedRequests(): string[] {
    return refused.splice(0);
}

afterEach(() => {
    expect(takeRefusedRequests(), 'a test made a request to a host other than loopback').toEqual([]);
});

afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});
