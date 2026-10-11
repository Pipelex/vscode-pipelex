/**
 * The switches that turn statistics off, read in the contract's order, and the
 * migration of today's `mthds` opt-out into the shared state.
 *
 * Node only. VS Code's own telemetry setting, the `editor_setting` switch, is read
 * by the service, which passes it in.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import * as contract from './contract';
import type { OffBy } from './contract';
import { StateDir, legacyConfigOf, modifiedMs } from './state';

/** What a statistics decision reads from the extension host. */
export interface UsageContext {
    env: Record<string, string | undefined>;
    /** The home directory, `undefined` when there is none. */
    home: string | undefined;
    /** The workspace folders' paths: each is a starting point of the project walk. */
    folders: readonly string[];
}

export function normalized(value: string): string {
    return value.trim().toLowerCase();
}

/** Read the way `DO_NOT_TRACK` is read: on unless unset, empty, `0` or `false`. */
export function flagIsOn(env: Record<string, string | undefined>, name: string): boolean {
    const value = env[name];
    if (value === undefined) return false;
    return !(contract.FALSY_VALUES as readonly string[]).includes(normalized(value));
}

/** `PIPELEX_USAGE_STATS` says off for its off values and, failing closed, for any
 * value nobody can read; its no-effect values and its absence leave statistics on. */
function toolVariableSaysOff(env: Record<string, string | undefined>): boolean {
    const value = env[contract.ENV_TOOL_SWITCH];
    if (value === undefined) return false;
    return !(contract.TOOL_SWITCH_NO_EFFECT_VALUES as readonly string[]).includes(normalized(value));
}

export type Endpoint = { kind: 'default'; origin: string } | { kind: 'loopback'; origin: string } | { kind: 'invalid' };

/** A loopback `http` origin with a port and no path: the only override the endpoint variable accepts. */
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/;

/**
 * Where events are posted: PostHog, or the loopback origin the test-only override names,
 * taken verbatim. Unlike a switch value, the override is not trimmed, and a trailing slash
 * is a path: either makes it invalid, as it is for pipelex and `mthds`, so the same value
 * sends from every tool or from none.
 */
export function endpointOf(env: Record<string, string | undefined>): Endpoint {
    const value = env[contract.ENV_ENDPOINT_OVERRIDE];
    if (value === undefined) return { kind: 'default', origin: contract.CAPTURE_HOST };
    const match = LOOPBACK_RE.exec(value);
    if (!match) return { kind: 'invalid' };
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return { kind: 'invalid' };
    return { kind: 'loopback', origin: value };
}

/** The value of `DISABLE_TELEMETRY` in `~/.mthds/config`'s dialect: `KEY=value` lines,
 * trimmed, whole-line `#` comments, the first `=` separating, the last key winning. */
export function legacyValue(content: string): string | undefined {
    let found: string | undefined;
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index < 0) continue;
        if (line.slice(0, index).trim() === contract.LEGACY_KEY) {
            found = line.slice(index + 1).trim();
        }
    }
    return found;
}

function legacySaysOff(legacyConfig: string): boolean {
    let content: string;
    try {
        content = fs.readFileSync(legacyConfig, 'utf-8');
    } catch {
        return false;
    }
    const value = legacyValue(content);
    return value !== undefined && (contract.LEGACY_DISABLE_ON_VALUES as readonly string[]).includes(normalized(value));
}

/** Whether the legacy opt-out says off and is newer than the `legacy-migrated` marker. */
function legacyChoicePending(context: UsageContext, state: StateDir | undefined): boolean {
    if (!context.home) return false;
    const legacyConfig = legacyConfigOf(context.home);
    if (!legacySaysOff(legacyConfig)) return false;
    const configModified = modifiedMs(legacyConfig);
    if (configModified === undefined) return false;
    const markerModified = state?.legacyMarkerModifiedMs();
    return markerModified === undefined || configModified > markerModified;
}

/** Carry today's `mthds` opt-out into the shared state, before any switch is read
 * and again before each post. Answers whether it migrated. */
export function runLegacyMigration(context: UsageContext, state: StateDir): boolean {
    if (!legacyChoicePending(context, state)) return false;
    state.createDisabled();
    state.deleteEverySpool();
    state.markLegacyMigrated(context.home ? legacyConfigOf(context.home) : undefined);
    return true;
}

function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realPath(dir: string): string {
    try {
        return fs.realpathSync(dir);
    } catch {
        return path.resolve(dir);
    }
}

/** Walk up from `start` to the first directory holding a project marker, stopping at
 * the home directory, which is never a project, and at the filesystem root. */
export function projectRoot(start: string, home: string | undefined): string | undefined {
    const homeDir = home ? realPath(home) : undefined;
    let current = realPath(start);
    for (;;) {
        if (homeDir && samePath(current, homeDir)) return undefined;
        if (contract.PROJECT_MARKERS.some(marker => fs.existsSync(path.join(current, marker)))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

/** What a `pipelex.toml` text says: it can only turn statistics off, and fails closed. */
export function projectSettingSaysOff(text: string): boolean {
    let table: Record<string, unknown>;
    try {
        table = parseToml(text) as Record<string, unknown>;
    } catch {
        return true;
    }
    if (!('usage_stats' in table)) return false;
    const section = table.usage_stats;
    if (typeof section !== 'object' || section === null || Array.isArray(section) || section instanceof Date) {
        return true;
    }
    const enabled = (section as Record<string, unknown>).enabled;
    if (enabled === undefined || enabled === true) return false;
    return true;
}

/** Whether the project of `start` turns statistics off. */
export function projectSaysOff(start: string, home: string | undefined): boolean {
    const root = projectRoot(start, home);
    if (!root) return false;
    const file = path.join(root, '.pipelex', 'pipelex.toml');
    if (!fs.existsSync(file)) return false;
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf-8');
    } catch {
        return true;
    }
    return projectSettingSaysOff(text);
}

/** Every switch that says off, in the contract's order. Read-only: it migrates and
 * creates nothing. `editorEnabled` is VS Code's telemetry setting. Any workspace
 * folder whose project turns statistics off turns them off for the window. */
export function readSwitches(context: UsageContext, state: StateDir | undefined, editorEnabled: boolean): OffBy[] {
    const offBy: OffBy[] = [];
    if (flagIsOn(context.env, contract.ENV_DO_NOT_TRACK)) offBy.push('do_not_track');
    if (toolVariableSaysOff(context.env)) offBy.push('tool_variable');
    if (state?.isDisabled()) offBy.push('machine_choice');
    if (legacyChoicePending(context, state)) offBy.push('legacy_mthds_choice');
    if (context.folders.some(folder => projectSaysOff(folder, context.home))) offBy.push('project_setting');
    if (!editorEnabled) offBy.push('editor_setting');
    if (endpointOf(context.env).kind === 'invalid') offBy.push('invalid_endpoint_override');
    return offBy;
}
