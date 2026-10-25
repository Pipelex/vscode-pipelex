/**
 * Every process the extension starts runs with `PIPELEX_USAGE_STATS=0` (the
 * usage-statistics contract, record R6): the extension counts the use in its own
 * `feature_used`, under VS Code's telemetry setting, so a `pipelex-agent` it spawns
 * must not report the same use again by its own switches alone.
 *
 * One test per spawn site, and a guard that fails when a new one appears without a test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const spawned = vi.hoisted(() => ({
    execFile: [] as Array<{ command: string; args: readonly string[]; options: { env?: Record<string, string | undefined>; cwd?: string } }>,
    clients: [] as Array<{ serverOptions: any }>,
    terminals: [] as Array<{ name: string; creationOptions: any; sent: string[] }>,
    createdTerminals: [] as any[],
    config: {} as Record<string, unknown>,
}));

vi.mock('child_process', () => ({
    execFile: (command: string, args: readonly string[], options: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
        spawned.execFile.push({ command, args, options });
        const isVersionProbe = args[args.length - 1] === '--version';
        callback(null, isVersionProbe ? 'pipelex-agent 0.99.0\n' : '{}', '');
        return { kill: () => undefined };
    },
}));

vi.mock('vscode', () => ({
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: path.join('/extension', ...parts) }) },
    workspace: {
        getConfiguration: () => ({ get: (key: string) => spawned.config[key] }),
        getWorkspaceFolder: () => undefined,
        fs: { createDirectory: () => Promise.resolve() },
        createFileSystemWatcher: () => ({ dispose() {} }),
        workspaceFolders: undefined,
    },
    window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        get terminals() {
            return spawned.terminals;
        },
        createTerminal: (options: any) => {
            const terminal = { name: options.name, creationOptions: options, sent: [] as string[], show() {}, sendText(text: string) { this.sent.push(text); } };
            spawned.terminals.push(terminal);
            spawned.createdTerminals.push(terminal);
            return terminal;
        },
    },
}));

vi.mock('vscode-languageclient/node', () => ({
    TransportKind: { stdio: 0, ipc: 1 },
    LanguageClient: class {
        constructor(_id: string, _name: string, serverOptions: any) {
            spawned.clients.push({ serverOptions });
        }
    },
}));

vi.mock('vscode-languageclient/browser', () => ({ LanguageClient: class {} }));

vi.mock('which', () => ({ default: { sync: () => '/usr/local/bin/plxt' } }));

vi.mock('../validation/cliResolver', () => ({
    resolveCli: () => ({ command: '/venv/bin/pipelex-agent', args: [] }),
}));

import { spawnCli } from '../validation/processUtils';
import { clearAgentCliVersionCache, getAgentCliVersion } from '../validation/agentCliVersion';
import { CliValidationBackend } from '../validation/cliValidationBackend';
import { runInTerminal } from '../terminalRunner';
import { createClient } from '../../client';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function expectStatisticsOff(env: Record<string, string | undefined> | undefined) {
    expect(env).toBeDefined();
    expect(env!.PIPELEX_USAGE_STATS).toBe('0');
}

beforeEach(() => {
    spawned.execFile.length = 0;
    spawned.clients.length = 0;
    spawned.terminals.length = 0;
    spawned.createdTerminals.length = 0;
    spawned.config = {};
    clearAgentCliVersionCache();
});

describe('every process the extension starts runs with usage statistics off', () => {
    it('spawnCli, keeping the rest of the extension host environment', async () => {
        await spawnCli('pipelex-agent', ['validate', 'bundle', 'x.mthds'], 1000, new AbortController().signal, '/project');
        expect(spawned.execFile).toHaveLength(1);
        expectStatisticsOff(spawned.execFile[0].options.env);
        expect(spawned.execFile[0].options.env!.PATH).toBe(process.env.PATH);
    });

    it('the pipelex-agent version probe', async () => {
        await getAgentCliVersion('pipelex-agent', [], '/project');
        expect(spawned.execFile).toHaveLength(1);
        expectStatisticsOff(spawned.execFile[0].options.env);
    });

    it('the CLI validation backend, which the validator on save and the graph panel both call', async () => {
        const backend = new CliValidationBackend();
        const main = { fsPath: '/project/main.mthds', toString: () => 'file:///project/main.mthds' } as any;
        await backend.analyze(
            { primaryUri: main, savedUri: main, cwd: '/project', timeout: 1000 },
            { withGraph: false },
            new AbortController().signal,
        );
        const validate = spawned.execFile.find(call => call.args.includes('validate'));
        expect(validate).toBeDefined();
        expect(spawned.execFile.length).toBeGreaterThanOrEqual(1);
        for (const call of spawned.execFile) expectStatisticsOff(call.options.env);
    });

    it('the language server, bundled or plxt, on top of pipelex.server.environment', async () => {
        const context = { extensionUri: {}, globalStorageUri: { fsPath: '/storage' } } as any;
        spawned.config = { 'pipelex.server.bundled': true, 'pipelex.server.environment': { RUST_LOG: 'debug', PIPELEX_USAGE_STATS: '1' } };
        await createClient(context);
        spawned.config = { 'pipelex.server.bundled': false };
        await createClient(context);
        expect(spawned.clients).toHaveLength(2);
        const [bundled, executable] = spawned.clients.map(client => client.serverOptions.run);
        expect(bundled.module).toBeDefined();
        expect(bundled.options.env).toEqual({ RUST_LOG: 'debug', PIPELEX_USAGE_STATS: '0' });
        expect(executable.command).toBe('/usr/local/bin/plxt');
        expectStatisticsOff(executable.options.env);
    });

    it('the terminal a run is typed into, never reusing one opened without the variable', () => {
        const stale = { name: 'Pipelex', creationOptions: { name: 'Pipelex' }, sent: [] as string[], show() {}, sendText() {} };
        spawned.terminals.push(stale);
        const uri = { fsPath: '/project/main.mthds' } as any;
        runInTerminal('/project/main.mthds', uri, (quote, cmd) => `${quote(cmd)} run bundle`);
        expect(spawned.createdTerminals).toHaveLength(1);
        expectStatisticsOff(spawned.createdTerminals[0].creationOptions.env);
        runInTerminal('/project/main.mthds', uri, (quote, cmd) => `${quote(cmd)} run bundle`);
        expect(spawned.createdTerminals).toHaveLength(1);
        expect(spawned.createdTerminals[0].sent).toHaveLength(2);
    });
});

/**
 * The spawn sites the tests above cover. A file that starts processes and is not
 * listed here fails the guard below: add its test above, then list it.
 */
const TESTED_SPAWN_SITES: Record<string, string> = {
    'pipelex/validation/processUtils.ts': 'spawnCli',
    'pipelex/validation/agentCliVersion.ts': 'the pipelex-agent version probe',
    'client.ts': 'the language server',
    'pipelex/terminalRunner.ts': 'the run terminal',
};
/** Files that only probe whether `child_process` exists, binding and calling nothing. */
const CHILD_PROCESS_PROBES = ['pipelex/pipelexExtension.ts'];

const PROCESS_APIS = [
    /['"]child_process['"]/,
    /['"]node:child_process['"]/,
    /\bcreateTerminal\s*\(/,
    /\bTransportKind\./,
    /\bnew\s+(ProcessExecution|ShellExecution)\s*\(/,
];

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
}

function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

describe('the spawn-site guard', () => {
    it('knows every file that starts a process', () => {
        const starting = sourceFiles(SRC)
            .map(file => ({ relative: path.relative(SRC, file).split(path.sep).join('/'), code: withoutComments(fs.readFileSync(file, 'utf-8')) }))
            .filter(({ code }) => PROCESS_APIS.some(api => api.test(code)));
        const unknown = starting
            .map(({ relative }) => relative)
            .filter(relative => !(relative in TESTED_SPAWN_SITES) && !CHILD_PROCESS_PROBES.includes(relative));
        expect(unknown, 'a new spawn site needs a test above asserting PIPELEX_USAGE_STATS=0').toEqual([]);
        for (const { relative, code } of starting.filter(({ relative }) => CHILD_PROCESS_PROBES.includes(relative))) {
            expect(code, `${relative} should only probe child_process`).not.toMatch(/(import|const|let|var)[^;\n]*child_process/);
            expect(code, `${relative} should only probe child_process`).not.toMatch(/\bcreateTerminal\s*\(|\bTransportKind\./);
        }
        for (const relative of Object.keys(TESTED_SPAWN_SITES)) {
            expect(starting.map(site => site.relative), `${relative} no longer starts a process: drop it from the list`).toContain(relative);
        }
    });
});
