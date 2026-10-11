import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

// ---------- A VS Code whose telemetry logger behaves like the real one ----------
const vs = vi.hoisted(() => ({
    telemetryEnabled: true,
    usageEnabled: true,
    folders: [] as string[],
    info: [] as Array<{ message: string; rest: unknown[] }>,
    commands: new Map<string, (...args: any[]) => unknown>(),
    globalState: new Map<string, unknown>(),
    loggerOptions: [] as unknown[],
    executeCommand: (..._args: unknown[]) => Promise.resolve(undefined),
}));

vi.mock('vscode', () => {
    class TelemetryTrustedValue<T> {
        constructor(readonly value: T) {}
    }
    return {
        version: '1.95.3',
        TelemetryTrustedValue,
        Uri: { parse: (value: string) => ({ toString: () => value }) },
        env: {
            appName: 'Visual Studio Code',
            get isTelemetryEnabled() {
                return vs.telemetryEnabled;
            },
            onDidChangeTelemetryEnabled: () => ({ dispose() {} }),
            openExternal: () => Promise.resolve(true),
            createTelemetryLogger: (sender: any, options: unknown) => {
                vs.loggerOptions.push(options);
                return {
                    get isUsageEnabled() {
                        return vs.telemetryEnabled && vs.usageEnabled;
                    },
                    onDidChangeEnableStates: () => ({ dispose() {} }),
                    // Like VS Code: drop the event when usage telemetry is off, prefix
                    // the name, unwrap trusted values and clean every other string.
                    logUsage(name: string, data: Record<string, unknown>) {
                        if (!vs.telemetryEnabled || !vs.usageEnabled) return;
                        const cleaned: Record<string, unknown> = {};
                        for (const [key, value] of Object.entries(data)) {
                            cleaned[key] = value instanceof TelemetryTrustedValue ? value.value : '<REDACTED>';
                        }
                        sender.sendEventData(`pipelex.pipelex/${name}`, cleaned);
                    },
                    logError() {},
                    dispose() {
                        void sender.flush?.();
                    },
                };
            },
        },
        window: {
            showInformationMessage: (message: string, ...rest: unknown[]) => {
                vs.info.push({ message, rest });
                return Promise.resolve(undefined);
            },
            showErrorMessage: () => Promise.resolve(undefined),
        },
        commands: {
            registerCommand: (id: string, handler: (...args: any[]) => unknown) => {
                vs.commands.set(id, handler);
                return { dispose: () => vs.commands.delete(id) };
            },
            executeCommand: (...args: unknown[]) => vs.executeCommand(...args),
        },
        workspace: {
            get workspaceFolders() {
                return vs.folders.map(folder => ({ uri: { scheme: 'file', fsPath: folder } }));
            },
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        },
    };
});

import {
    UsageStatsService,
    COMMAND_DISABLE,
    COMMAND_RESET_ID,
    LAST_ACTIVATED_DAY_KEY,
    POST_DELAY_MS,
    RETRY_DELAY_MS,
} from '../usageStats/service';
import { MAX_EVENTS_PER_POST } from '../usageStats/delivery';
import type { FetchLike } from '../usageStats/delivery';
import { Spool } from '../usageStats/spool';
import { StateDir, stateDirOf } from '../usageStats/state';
import { recordFeatureUse } from '../usageStats/recorder';
import * as contract from '../usageStats/contract';
import { noticeText } from '../usageStats/contract';
import { featureUsed, utcDay } from '../usageStats/events';
import { gateDropReason, loadSchema } from './usageStatsGate';
import { TEST_HOME, takeRefusedRequests } from './usageStatsIsolation';

const schema = loadSchema();

let root: string;
let home: string;
let project: string;
let lines: string[];
let services: UsageStatsService[];

const output = { appendLine: (line: string) => lines.push(line) } as any;

function extensionContext(): any {
    return {
        extension: { packageJSON: { version: '0.19.1' } },
        globalState: {
            get: (key: string) => vs.globalState.get(key),
            update: (key: string, value: unknown) => {
                vs.globalState.set(key, value);
                return Promise.resolve();
            },
        },
        subscriptions: [],
    };
}

function start(env: Record<string, string> = {}): UsageStatsService {
    const service = new UsageStatsService(extensionContext(), output, {
        env: { PIPELEX_USAGE_STATS_ENDPOINT: 'http://127.0.0.1:9', ...env },
        home,
    });
    services.push(service);
    service.start();
    return service;
}

/** A service posting through `fetchImpl` instead of the network. */
function startWith(fetchImpl: FetchLike, env: Record<string, string> = {}): UsageStatsService {
    const service = new UsageStatsService(extensionContext(), output, {
        env: { PIPELEX_USAGE_STATS_ENDPOINT: 'http://127.0.0.1:9', ...env },
        home,
        fetch: fetchImpl,
    });
    services.push(service);
    service.start();
    return service;
}

/** Queue spool files of `perFile` `feature_used` events each, under the machine's identifier. */
function queueFiles(perFile: number[]): void {
    const state = new StateDir(stateDirOf(home));
    const id = state.obtainIdentity().id;
    const spool = new Spool(state.toolSpool());
    perFile.forEach((count, file) => {
        spool.write(Array.from({ length: count }, (_, index) => featureUsed(
            id,
            `${String(file).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
            {
                toolVersion: '0.19.1', idNew: false, os: 'darwin', arch: 'arm64', languageRuntime: 'node-20',
                ci: false, container: false, internal: false, noticeVersion: 1,
            },
            { editor: 'vscode', editorVersion: '1.95.3' },
            'run',
            1,
        )));
    });
}

function debugEvents(): any[] {
    return lines
        .filter(line => line.startsWith('{"usage_stats_debug"'))
        .map(line => JSON.parse(line).usage_stats_debug);
}

function stateDir(): string {
    return path.join(home, '.mthds', 'usage-stats');
}

function spooled(): string[] {
    try {
        return fs.readdirSync(path.join(stateDir(), 'spool', 'vscode-pipelex'));
    } catch {
        return [];
    }
}

async function captureServer(status: number) {
    const bodies: any[] = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            bodies.push(JSON.parse(body));
            response.writeHead(status);
            response.end('{}');
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, bodies, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-usage-service-')));
    home = path.join(root, 'home');
    project = path.join(home, 'work', 'project');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    lines = [];
    services = [];
    vs.telemetryEnabled = true;
    vs.usageEnabled = true;
    vs.folders = [project];
    vs.info = [];
    vs.globalState.clear();
    vs.loggerOptions = [];
});

afterEach(() => {
    for (const service of services) service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('the usage statistics service', () => {
    it('runs in the suite\'s throwaway home, with statistics off, when given no host of its own', () => {
        expect(os.homedir()).toBe(TEST_HOME);
        expect(TEST_HOME.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
        const service = new UsageStatsService(extensionContext(), output);
        services.push(service);
        service.start();
        const status = service.status();
        expect(status.enabled).toBe(false);
        expect(status.off_by).toContain('do_not_track');
        expect(status.state_dir).toBe(path.join(TEST_HOME, '.mthds', 'usage-stats'));
        expect(fs.existsSync(path.join(TEST_HOME, '.mthds'))).toBe(false);
        expect(vs.info).toEqual([]);
    });

    it('cannot reach a host other than loopback', async () => {
        await expect(fetch('https://eu.i.posthog.com/batch/', { method: 'POST', body: '{}' })).rejects.toThrow(/not a loopback host/);
        expect(takeRefusedRequests()).toEqual(['POST https://eu.i.posthog.com']);
    });

    it('sends through a telemetry logger without VS Code\'s common properties', () => {
        start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        expect(vs.loggerOptions).toEqual([{ ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true }]);
    });

    it('shows the notice once per machine as a non-modal message, recorded in the shared marker', () => {
        start({ PIPELEX_USAGE_STATS_DEBUG: '1' }).dispose();
        expect(vs.info).toHaveLength(1);
        expect(vs.info[0].message).toBe(noticeText());
        // Buttons only: no `{ modal: true }` options object.
        expect(vs.info[0].rest).toEqual(['Disable', 'Details']);
        expect(fs.existsSync(path.join(stateDir(), 'notice-v1'))).toBe(true);
        start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        expect(vs.info).toHaveLength(1);
    });

    it('prints events to the output channel under the debug variable, and spools nothing', () => {
        const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        recordFeatureUse('validation');
        recordFeatureUse('validation');
        recordFeatureUse('validation');
        recordFeatureUse('run');
        service.flushFeatures();
        const printed = debugEvents();
        expect(printed.map(event => event.event)).toEqual(['extension_activated', 'feature_used', 'feature_used']);
        for (const event of printed) {
            expect(gateDropReason(schema, event), JSON.stringify(event)).toBeUndefined();
        }
        expect(printed[1].properties).toMatchObject({ feature: 'validation', count: 3, editor: 'vscode', editor_version: '1.95.3' });
        expect(printed[2].properties).toMatchObject({ feature: 'run', count: 1 });
        expect(printed[0].properties).toMatchObject({ tool: 'vscode-pipelex', surface: 'extension', id_new: true, notice_version: 1 });
        expect(printed[0].properties.language_runtime).toMatch(/^node-\d+$/);
        const id = fs.readFileSync(path.join(stateDir(), 'id'), 'utf-8');
        expect(printed.every(event => event.distinct_id === id)).toBe(true);
        expect(spooled()).toEqual([]);
    });

    it('sends extension_activated at most once per UTC day', () => {
        start({ PIPELEX_USAGE_STATS_DEBUG: '1' }).dispose();
        expect(vs.globalState.get(LAST_ACTIVATED_DAY_KEY)).toBe(utcDay());
        start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        expect(debugEvents().filter(event => event.event === 'extension_activated')).toHaveLength(1);
    });

    it('sends nothing, shows nothing and creates nothing when VS Code\'s telemetry is off', () => {
        vs.telemetryEnabled = false;
        const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        recordFeatureUse('format');
        service.flushFeatures();
        expect(debugEvents()).toEqual([]);
        expect(vs.info).toEqual([]);
        expect(fs.existsSync(stateDir())).toBe(false);
        expect(service.status().off_by).toEqual(['editor_setting']);
    });

    it('drops what it counted when VS Code\'s telemetry turns off', () => {
        const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        recordFeatureUse('format');
        vs.usageEnabled = false;
        service.refresh();
        vs.usageEnabled = true;
        service.flushFeatures();
        expect(debugEvents().map(event => event.event)).toEqual(['extension_activated']);
    });

    it('honours the project setting found from the workspace folder', () => {
        fs.mkdirSync(path.join(project, '.pipelex'));
        fs.writeFileSync(path.join(project, '.pipelex', 'pipelex.toml'), '[usage_stats]\nenabled = false\n');
        const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        expect(debugEvents()).toEqual([]);
        expect(vs.info).toEqual([]);
        expect(service.status().off_by).toEqual(['project_setting']);
    });

    it('honours the shared switches', () => {
        const switches: Array<Record<string, string>> = [{ DO_NOT_TRACK: '1' }, { PIPELEX_USAGE_STATS: 'off' }, { PIPELEX_USAGE_STATS_ENDPOINT: 'https://example.com' }];
        for (const env of switches) {
            const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1', ...env });
            recordFeatureUse('run');
            service.flushFeatures();
            service.dispose();
        }
        expect(debugEvents()).toEqual([]);
        expect(vs.info).toEqual([]);
    });

    it('posts what it made, and spools at deactivation what it could not post', async () => {
        const accepting = await captureServer(200);
        try {
            const service = start({ PIPELEX_USAGE_STATS_ENDPOINT: accepting.origin });
            recordFeatureUse('graph_preview');
            await service.shutdown();
            const sent = accepting.bodies.flatMap(body => body.batch);
            expect(sent.map((event: any) => event.event)).toEqual(['extension_activated', 'feature_used']);
            for (const event of sent) expect(gateDropReason(schema, event)).toBeUndefined();
            expect(accepting.bodies[0].api_key).toBe('phc_uQjSVbzNPJxA8bHxfevn7NMzB6PbC6aJQRB6ka6MxT7a');
            expect(spooled()).toEqual([]);
        } finally {
            await accepting.close();
        }
        const failing = await captureServer(503);
        try {
            const service = start({ PIPELEX_USAGE_STATS_ENDPOINT: failing.origin });
            recordFeatureUse('format');
            await service.shutdown();
            expect(failing.bodies).toHaveLength(1);
            const files = spooled();
            expect(files).toHaveLength(1);
            const body = JSON.parse(fs.readFileSync(path.join(stateDir(), 'spool', 'vscode-pipelex', files[0]), 'utf-8'));
            expect(body.spool_version).toBe(1);
            expect(body.events.map((event: any) => event.properties.feature)).toEqual(['format']);
        } finally {
            await failing.close();
        }
        // The next session posts the spooled file.
        const later = await captureServer(200);
        try {
            const service = start({ PIPELEX_USAGE_STATS_ENDPOINT: later.origin });
            await service.postNow(5000, true);
            expect(later.bodies.flatMap(body => body.batch).map((event: any) => event.properties.feature)).toEqual(['format']);
            expect(spooled()).toEqual([]);
        } finally {
            await later.close();
        }
    });

    it('stops draining the queue as soon as VS Code\'s telemetry is turned off', async () => {
        vs.globalState.set(LAST_ACTIVATED_DAY_KEY, utcDay());
        // Two files that cannot share a post.
        queueFiles([MAX_EVENTS_PER_POST / 2 + 1, MAX_EVENTS_PER_POST / 2 + 1]);
        let posts = 0;
        const service = startWith(async () => {
            posts++;
            // The person turns telemetry off while the first post is on its way.
            vs.telemetryEnabled = false;
            return { status: 200 };
        });
        await service.postNow(5000, true);
        expect(posts).toBe(1);
        expect(spooled().filter(name => name.endsWith('.json'))).toHaveLength(1);
    });

    it('spools a batch still in flight when the shutdown budget runs out, and only once', async () => {
        vs.globalState.set(LAST_ACTIVATED_DAY_KEY, utcDay());
        let settle: (status: number) => void = () => undefined;
        // A request that neither answers nor heeds its abort until told to.
        const service = startWith(() => new Promise(resolve => {
            settle = status => resolve({ status });
        }));
        recordFeatureUse('run');
        service.flushFeatures();
        const background = service.postNow(contract.BUDGET_BACKGROUND_POST_DELAY_MS, false);
        await service.shutdown();
        const files = spooled();
        expect(files).toHaveLength(1);
        const body = JSON.parse(fs.readFileSync(path.join(stateDir(), 'spool', 'vscode-pipelex', files[0]), 'utf-8'));
        expect(body.events.map((event: any) => event.properties.feature)).toEqual(['run']);
        // The abandoned request fails late: its batch is not spooled a second time.
        settle(503);
        await background;
        expect(spooled()).toHaveLength(1);
    }, 10_000);

    it('retries a failed post after a delay, from the spool', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        try {
            vs.globalState.set(LAST_ACTIVATED_DAY_KEY, utcDay());
            const statuses = [503, 200];
            const bodies: any[] = [];
            const service = startWith(async (_url, init) => {
                bodies.push(JSON.parse(init.body));
                return { status: statuses.shift() ?? 200 };
            });
            recordFeatureUse('validation');
            service.flushFeatures();
            await vi.advanceTimersByTimeAsync(POST_DELAY_MS);
            expect(bodies).toHaveLength(1);
            expect(spooled().filter(name => name.endsWith('.json'))).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
            expect(bodies).toHaveLength(2);
            expect(bodies[1].batch.map((event: any) => event.properties.feature)).toEqual(['validation']);
            expect(spooled()).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('offers disable and reset-id in the palette', async () => {
        const service = start({ PIPELEX_USAGE_STATS_DEBUG: '1' });
        const firstId = fs.readFileSync(path.join(stateDir(), 'id'), 'utf-8');
        await vs.commands.get(COMMAND_RESET_ID)!();
        const secondId = fs.readFileSync(path.join(stateDir(), 'id'), 'utf-8');
        expect(secondId).not.toBe(firstId);
        await vs.commands.get(COMMAND_DISABLE)!();
        expect(fs.existsSync(path.join(stateDir(), 'disabled'))).toBe(true);
        recordFeatureUse('run');
        service.flushFeatures();
        expect(debugEvents().map(event => event.event)).toEqual(['extension_activated']);
        expect(service.status()).toMatchObject({ enabled: false, off_by: ['machine_choice'], installation_id: secondId });
    });
});
