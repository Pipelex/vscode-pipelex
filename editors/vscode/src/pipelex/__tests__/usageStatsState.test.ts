import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { StateDir, stateDirOf } from '../usageStats/state';
import {
    endpointOf,
    legacyValue,
    projectRoot,
    projectSettingSaysOff,
    readSwitches,
    runLegacyMigration,
} from '../usageStats/switches';
import type { UsageContext } from '../usageStats/switches';
import { Spool } from '../usageStats/spool';
import { MAX_EVENTS_PER_POST, beforePost, drainSpool, post } from '../usageStats/delivery';
import type { FetchLike } from '../usageStats/delivery';
import * as events from '../usageStats/events';

let root: string;
let home: string;
let project: string;
let state: StateDir;

function context(env: Record<string, string> = {}, folders: string[] = [project]): UsageContext {
    return { env, home, folders };
}

function envelope(distinctId: string, uuid = '4cb223d0-b41d-4b7e-a948-3cd00a5f56fd'): events.Envelope {
    return events.featureUsed(
        distinctId,
        uuid,
        {
            toolVersion: '0.19.1', idNew: false, os: 'linux', arch: 'x86_64', languageRuntime: 'node-20',
            ci: false, container: false, internal: false, noticeVersion: 1,
        },
        { editor: 'vscode', editorVersion: '1.95.3' },
        'validation',
        1,
    );
}

/** A loopback server answering every request with `status`, recording the bodies;
 * `setStatus` changes the answer, so that one origin serves several runs. */
async function captureServer(status: number): Promise<{
    origin: string;
    bodies: any[];
    setStatus: (next: number) => void;
    close: () => Promise<void>;
}> {
    const bodies: any[] = [];
    let answer = status;
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            bodies.push({ path: request.url, body: JSON.parse(body) });
            response.writeHead(answer, { 'Content-Type': 'application/json' });
            response.end('{}');
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        bodies,
        setStatus: next => { answer = next; },
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}

/** The loopback origin the drains below post to through a fetch stub. */
const STUB_ORIGIN = 'http://127.0.0.1:9';

/** Queue a file holding `body` as it is, as another tool or version may have, named
 * as if written `ageMs` ago. */
function queueRaw(spool: Spool, label: string, ageMs: number, body: unknown): string {
    fs.mkdirSync(spool.dir, { recursive: true });
    const file = path.join(spool.dir, `${Date.now() - ageMs}-${label}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
}

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-usage-stats-')));
    home = path.join(root, 'home');
    project = path.join(home, 'work', 'project');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    state = new StateDir(stateDirOf(home));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('the switches', () => {
    it('are all on by default, VS Code included', () => {
        expect(readSwitches(context(), state, true)).toEqual([]);
    });

    it('name each switch that says off, in the contract order', () => {
        state.createDisabled();
        fs.writeFileSync(path.join(home, '.mthds', 'config'), 'DISABLE_TELEMETRY=1\n');
        fs.mkdirSync(path.join(project, '.pipelex'));
        fs.writeFileSync(path.join(project, '.pipelex', 'pipelex.toml'), '[usage_stats]\nenabled = false\n');
        const env = { DO_NOT_TRACK: '1', PIPELEX_USAGE_STATS: '0', PIPELEX_USAGE_STATS_ENDPOINT: 'https://example.com' };
        expect(readSwitches(context(env), state, false)).toEqual([
            'do_not_track', 'tool_variable', 'machine_choice', 'legacy_mthds_choice',
            'project_setting', 'editor_setting', 'invalid_endpoint_override',
        ]);
    });

    it('read DO_NOT_TRACK and PIPELEX_USAGE_STATS as the contract says', () => {
        for (const value of ['', '0', 'false', ' FALSE ']) {
            expect(readSwitches(context({ DO_NOT_TRACK: value }), state, true)).toEqual([]);
        }
        expect(readSwitches(context({ DO_NOT_TRACK: 'yes' }), state, true)).toEqual(['do_not_track']);
        for (const value of ['0', 'false', 'no', 'off', 'maybe']) {
            expect(readSwitches(context({ PIPELEX_USAGE_STATS: value }), state, true)).toEqual(['tool_variable']);
        }
        for (const value of ['', '1', 'true', 'yes', ' ON ']) {
            expect(readSwitches(context({ PIPELEX_USAGE_STATS: value }), state, true)).toEqual([]);
        }
    });

    it('find the project by walking up from a workspace folder, never at home', () => {
        const nested = path.join(project, 'methods', 'deep');
        fs.mkdirSync(nested, { recursive: true });
        expect(projectRoot(nested, home)).toBe(project);
        fs.mkdirSync(path.join(home, '.pipelex'));
        fs.writeFileSync(path.join(home, '.pipelex', 'pipelex.toml'), '[usage_stats]\nenabled = false\n');
        const loose = path.join(home, 'loose');
        fs.mkdirSync(loose);
        expect(projectRoot(loose, home)).toBeUndefined();
        expect(readSwitches(context({}, [loose]), state, true)).toEqual([]);
    });

    it('fail closed on a project file they cannot read as the setting', () => {
        expect(projectSettingSaysOff('[usage_stats]\nenabled = false\n')).toBe(true);
        expect(projectSettingSaysOff('[usage_stats]\nenabled = true\n')).toBe(false);
        expect(projectSettingSaysOff('[other]\nenabled = false\n')).toBe(false);
        expect(projectSettingSaysOff('[usage_stats\n')).toBe(true);
        expect(projectSettingSaysOff('[usage_stats]\nenabled = "no"\n')).toBe(true);
        expect(projectSettingSaysOff('usage_stats = false\n')).toBe(true);
    });

    it('turn off when any workspace folder\'s project turns them off', () => {
        const other = path.join(home, 'work', 'other');
        fs.mkdirSync(path.join(other, '.pipelex'), { recursive: true });
        fs.writeFileSync(path.join(other, '.pipelex', 'pipelex.toml'), '[usage_stats]\nenabled = false\n');
        expect(readSwitches(context({}, [project, other]), state, true)).toEqual(['project_setting']);
    });

    it('accept only a loopback endpoint override', () => {
        for (const value of ['http://127.0.0.1:9', 'http://localhost:8080/', 'http://[::1]:443']) {
            expect(endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: value }).kind).toBe('loopback');
        }
        for (const value of ['', 'https://127.0.0.1:9', 'http://127.0.0.1', 'http://127.0.0.1:9/batch/', 'http://127.0.0.1:0', 'http://example.com:80']) {
            expect(endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: value }).kind).toBe('invalid');
        }
        expect(endpointOf({})).toEqual({ kind: 'default', origin: 'https://eu.i.posthog.com' });
    });
});

describe('the legacy mthds opt-out', () => {
    it('reads the config dialect, the last key winning', () => {
        expect(legacyValue('DISABLE_TELEMETRY=1\n')).toBe('1');
        expect(legacyValue('# DISABLE_TELEMETRY=1\n')).toBeUndefined();
        expect(legacyValue('DISABLE_TELEMETRY=1\nDISABLE_TELEMETRY=0\n')).toBe('0');
    });

    it('migrates once into the machine choice, which enable can then undo', () => {
        fs.mkdirSync(path.join(home, '.mthds'), { recursive: true });
        fs.writeFileSync(path.join(home, '.mthds', 'config'), 'DISABLE_TELEMETRY=true\n');
        new Spool(state.toolSpool('plxt')).write(STUB_ORIGIN, [envelope('0a6dccf4-9cda-44ee-b0a3-97191c19d98d')]);
        expect(runLegacyMigration(context(), state)).toBe(true);
        expect(state.isDisabled()).toBe(true);
        expect(fs.readdirSync(state.toolSpool('plxt'))).toEqual([]);
        expect(readSwitches(context(), state, true)).toEqual(['machine_choice']);
        state.deleteDisabled();
        state.markLegacyMigrated(path.join(home, '.mthds', 'config'));
        expect(runLegacyMigration(context(), state)).toBe(false);
        expect(readSwitches(context(), state, true)).toEqual([]);
    });
});

describe('the installation identifier', () => {
    it('is created once and shared', () => {
        const first = state.obtainIdentity();
        expect(first).toMatchObject({ created: true, persisted: true });
        const second = state.obtainIdentity();
        expect(second).toEqual({ id: first.id, created: false, persisted: true });
        expect(fs.readFileSync(path.join(state.root, 'id'), 'utf-8')).toBe(first.id);
        expect(fs.readdirSync(state.root).filter(name => name.startsWith('id.tmp-'))).toEqual([]);
    });

    it('reads back the winner when another tool published first', () => {
        const winner = state.createId();
        const loser = state.createId();
        expect(loser).toEqual({ id: winner.id, created: false, persisted: true });
    });

    it('is never rewritten when malformed', () => {
        state.ensure();
        fs.writeFileSync(path.join(state.root, 'id'), 'not-a-uuid');
        const identity = state.obtainIdentity();
        expect(identity).toMatchObject({ created: true, persisted: false });
        expect(fs.readFileSync(path.join(state.root, 'id'), 'utf-8')).toBe('not-a-uuid');
    });
});

describe('the spool and its sender', () => {
    it('keeps at most a hundred files, oldest dropped first', () => {
        const spool = new Spool(state.toolSpool());
        for (let index = 0; index < 102; index++) spool.write(STUB_ORIGIN, [envelope('0a6dccf4-9cda-44ee-b0a3-97191c19d98d')]);
        expect(fs.readdirSync(spool.dir).filter(name => !name.startsWith('.'))).toHaveLength(100);
    });

    it('renames back a stale claim and deletes files older than thirty days', () => {
        const spool = new Spool(state.toolSpool());
        const file = spool.write(STUB_ORIGIN, [envelope('0a6dccf4-9cda-44ee-b0a3-97191c19d98d')]);
        const claimed = spool.claim(file)!;
        const old = new Date(Date.now() - 11 * 60_000);
        fs.utimesSync(claimed.claimed, old, old);
        const ancient = path.join(spool.dir, `${Date.now() - 31 * 24 * 60 * 60_000}-abc.json`);
        fs.writeFileSync(ancient, '{}');
        spool.tidy();
        expect(fs.readdirSync(spool.dir)).toEqual([path.basename(file)]);
    });

    it('posts the spool, drops events of a replaced identifier, and keeps a failed file', async () => {
        const id = state.obtainIdentity().id;
        const spool = new Spool(state.toolSpool());
        // One origin for both drains: a file is posted only to the endpoint it was queued for.
        const server = await captureServer(503);
        try {
            const endpoint = endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: server.origin });
            spool.write(server.origin, [envelope(id), envelope('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')]);
            await drainSpool(context(), state, endpoint, Date.now() + 5000);
            expect(server.bodies).toHaveLength(1);
            expect(server.bodies[0].body.batch).toHaveLength(1);
            expect(fs.readdirSync(spool.dir).filter(name => name.endsWith('.json'))).toHaveLength(1);
            server.setStatus(200);
            await drainSpool(context(), state, endpoint, Date.now() + 5000);
            expect(server.bodies).toHaveLength(2);
            const { path: requestPath, body } = server.bodies[1];
            expect(requestPath).toBe('/batch/');
            expect(body.api_key).toBe('phc_uQjSVbzNPJxA8bHxfevn7NMzB6PbC6aJQRB6ka6MxT7a');
            expect(body.batch.map((event: events.Envelope) => event.distinct_id)).toEqual([id]);
            expect(fs.readdirSync(spool.dir)).toEqual([]);
        } finally {
            await server.close();
        }
    });

    it('writes into every file the origin the switches resolved', () => {
        const spool = new Spool(state.toolSpool());
        const cases: [Record<string, string>, string][] = [
            [{}, 'https://eu.i.posthog.com'],
            [{ PIPELEX_USAGE_STATS_ENDPOINT: 'http://127.0.0.1:9' }, 'http://127.0.0.1:9'],
            [{ PIPELEX_USAGE_STATS_ENDPOINT: 'http://localhost:8080/' }, 'http://localhost:8080'],
        ];
        for (const [env, expected] of cases) {
            const endpoint = endpointOf(env);
            if (endpoint.kind === 'invalid') throw new Error(`${JSON.stringify(env)} is a valid endpoint`);
            const file = spool.write(endpoint.origin, [envelope('0a6dccf4-9cda-44ee-b0a3-97191c19d98d')]);
            const body = JSON.parse(fs.readFileSync(file, 'utf-8'));
            expect(body.spool_version).toBe(1);
            expect(body.endpoint).toBe(expected);
            expect(body.events).toHaveLength(1);
        }
    });

    it('posts only the files queued for its endpoint and those naming none, leaving the rest as they were', async () => {
        const id = state.obtainIdentity().id;
        const spool = new Spool(state.toolSpool());
        const posting = await captureServer(200);
        const elsewhere = await captureServer(200);
        try {
            const own = envelope(id, '11111111-1111-4111-8111-000000000001');
            const anywhere = envelope(id, '11111111-1111-4111-8111-000000000002');
            const foreign = envelope(id, '11111111-1111-4111-8111-000000000003');
            const production = envelope(id, '11111111-1111-4111-8111-000000000004');
            queueRaw(spool, 'own', 4000, { spool_version: 1, endpoint: posting.origin, events: [own] });
            queueRaw(spool, 'anywhere', 3000, { spool_version: 1, events: [anywhere] });
            const foreignFile = queueRaw(spool, 'foreign', 2000, { spool_version: 1, endpoint: elsewhere.origin, events: [foreign] });
            const productionFile = queueRaw(spool, 'production', 1000, { spool_version: 1, endpoint: 'https://eu.i.posthog.com', events: [production] });
            const before = [fs.readFileSync(foreignFile, 'utf-8'), fs.readFileSync(productionFile, 'utf-8')];

            const outcome = await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: posting.origin }), Date.now() + 5000);
            expect(outcome).toBe('drained');
            const sent = posting.bodies.flatMap(request => request.body.batch).map((event: events.Envelope) => event.uuid);
            expect(sent.sort()).toEqual([own.uuid, anywhere.uuid].sort());
            expect(elsewhere.bodies).toEqual([]);
            expect(fs.readdirSync(spool.dir).sort()).toEqual([path.basename(foreignFile), path.basename(productionFile)].sort());
            expect([fs.readFileSync(foreignFile, 'utf-8'), fs.readFileSync(productionFile, 'utf-8')]).toEqual(before);
        } finally {
            await posting.close();
            await elsewhere.close();
        }
    });

    it('keeps the endpoint a file named when it rewrites it, and reads a non-string one as no spool file', async () => {
        const id = state.obtainIdentity().id;
        const spool = new Spool(state.toolSpool());
        const named = spool.write(STUB_ORIGIN, [envelope(id), envelope('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')]);
        const unnamed = queueRaw(spool, 'unnamed', 1000, {
            spool_version: 1,
            events: [envelope(id, '33333333-3333-4333-8333-333333333333'), envelope('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444')],
        });
        const malformed = queueRaw(spool, 'malformed', 500, { spool_version: 1, endpoint: 9, events: [envelope(id)] });
        // The stub fails every post, so the rewritten files are given back for a look.
        const outcome = await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: STUB_ORIGIN }), Date.now() + 5000, {
            fetch: async () => ({ status: 503 }),
        });
        expect(outcome).toBe('failed');
        const namedBody = JSON.parse(fs.readFileSync(named, 'utf-8'));
        expect(namedBody.endpoint).toBe(STUB_ORIGIN);
        expect(namedBody.events.map((event: events.Envelope) => event.distinct_id)).toEqual([id]);
        const unnamedBody = JSON.parse(fs.readFileSync(unnamed, 'utf-8'));
        expect('endpoint' in unnamedBody).toBe(false);
        expect(unnamedBody.events.map((event: events.Envelope) => event.distinct_id)).toEqual([id]);
        // Not a spool file this version reads: deleted unsent.
        expect(fs.existsSync(malformed)).toBe(false);
    });

    it('touches nothing under an invalid endpoint override', async () => {
        const spool = new Spool(state.toolSpool());
        const file = spool.write(STUB_ORIGIN, [envelope(state.obtainIdentity().id)]);
        expect(await drainSpool(context(), state, { kind: 'invalid' }, Date.now() + 5000)).toBe('stopped');
        expect(fs.readdirSync(spool.dir)).toEqual([path.basename(file)]);
    });

    it('deletes a refused file and sends nothing once disabled', async () => {
        const id = state.obtainIdentity().id;
        const spool = new Spool(state.toolSpool());
        const refusing = await captureServer(400);
        try {
            spool.write(refusing.origin, [envelope(id)]);
            await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: refusing.origin }), Date.now() + 5000);
            expect(refusing.bodies).toHaveLength(1);
            expect(fs.readdirSync(spool.dir)).toEqual([]);
            spool.write(refusing.origin, [envelope(id)]);
            state.createDisabled();
            expect(beforePost(context(), state)).toEqual({ kind: 'disabled' });
            await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: refusing.origin }), Date.now() + 5000);
            expect(refusing.bodies).toHaveLength(1);
            expect(fs.readdirSync(spool.dir)).toEqual([]);
        } finally {
            await refusing.close();
        }
    });

    /** Spool files of `perFile` events each, under `id`, oldest first. */
    function queueFiles(id: string, perFile: number[]): Spool {
        const spool = new Spool(state.toolSpool());
        const oldest = Date.now() - 10_000;
        perFile.forEach((count, file) => {
            const batch = Array.from({ length: count }, (_, index) =>
                envelope(id, `${String(file).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`));
            const written = spool.write(STUB_ORIGIN, batch);
            // Spool order is by the creation time a name starts with.
            fs.renameSync(written, path.join(spool.dir, `${oldest + file}-${path.basename(written).split('-')[1]}`));
        });
        return spool;
    }

    it('posts the queue in as few posts as the batch limit allows', async () => {
        const id = state.obtainIdentity().id;
        const half = MAX_EVENTS_PER_POST / 2 + 1;
        const spool = queueFiles(id, [half, half, 1]);
        const sizes: number[] = [];
        const fetchImpl: FetchLike = async (_url, init) => {
            sizes.push(JSON.parse(init.body).batch.length);
            return { status: 200 };
        };
        const outcome = await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: STUB_ORIGIN }), Date.now() + 5000, { fetch: fetchImpl });
        expect(outcome).toBe('drained');
        // Two files of more than half the limit cannot share a post; the small one joins the second.
        expect(sizes).toEqual([half, half + 1]);
        expect(fs.readdirSync(spool.dir)).toEqual([]);
    });

    it('stops before its next post when the live check turns statistics off, keeping the rest queued', async () => {
        const id = state.obtainIdentity().id;
        const half = MAX_EVENTS_PER_POST / 2 + 1;
        const spool = queueFiles(id, [half, half]);
        let on = true;
        let posts = 0;
        const fetchImpl: FetchLike = async () => {
            posts++;
            // VS Code's telemetry is turned off while the first post is on its way.
            on = false;
            return { status: 200 };
        };
        const outcome = await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: STUB_ORIGIN }), Date.now() + 5000, {
            fetch: fetchImpl,
            allowed: () => on,
        });
        expect(outcome).toBe('stopped');
        expect(posts).toBe(1);
        const left = fs.readdirSync(spool.dir);
        expect(left).toHaveLength(1);
        expect(left[0].endsWith('.json')).toBe(true);
    });

    it('leaves a failed batch and the files not yet tried queued', async () => {
        const id = state.obtainIdentity().id;
        const half = MAX_EVENTS_PER_POST / 2 + 1;
        const spool = queueFiles(id, [half, half]);
        let posts = 0;
        const fetchImpl: FetchLike = async () => {
            posts++;
            return { status: 503 };
        };
        const outcome = await drainSpool(context(), state, endpointOf({ PIPELEX_USAGE_STATS_ENDPOINT: STUB_ORIGIN }), Date.now() + 5000, { fetch: fetchImpl });
        expect(outcome).toBe('failed');
        expect(posts).toBe(1);
        expect(fs.readdirSync(spool.dir).filter(name => name.endsWith('.json'))).toHaveLength(2);
    });

    it('never posts to an invalid endpoint', async () => {
        expect(await post({ kind: 'invalid' }, [envelope('0a6dccf4-9cda-44ee-b0a3-97191c19d98d')], 1000)).toBe('failed');
    });
});
