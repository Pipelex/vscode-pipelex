/**
 * The shared state directory, `~/.mthds/usage-stats/`: one small file per fact,
 * each created or deleted whole and never rewritten, so tools running at once never
 * undo each other's choice. `plxt`, pipelex and the `mthds` CLI read and write the
 * same files; the extension keeps none of these facts in its own global state.
 *
 * Node only: imported by the statistics service, which the browser host never loads.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as contract from './contract';

export interface Identity {
    id: string;
    /** Whether this process created the identifier (`id_new`). */
    created: boolean;
    /** Whether `id` holds it. When it does not, the process drew it for itself alone. */
    persisted: boolean;
}

export type IdReading = { kind: 'absent' } | { kind: 'valid'; id: string } | { kind: 'malformed' };

export function stateDirOf(home: string): string {
    return path.join(home, ...contract.STATE_DIRECTORY);
}

export function legacyConfigOf(home: string): string {
    return path.join(home, ...contract.LEGACY_CONFIG);
}

export function randomUuidV4(): string {
    return crypto.randomUUID();
}

export function randomSuffix(): string {
    return crypto.randomBytes(6).toString('hex');
}

export function isInstallationId(text: string): boolean {
    return contract.INSTALLATION_ID_RE.test(text);
}

function exists(file: string): boolean {
    try {
        fs.statSync(file);
        return true;
    } catch {
        return false;
    }
}

function removeIfPresent(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
}

/** Create an empty marker file; one that exists already is left as it is. */
function createMarker(file: string): void {
    try {
        fs.closeSync(fs.openSync(file, 'wx'));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
}

export function modifiedMs(file: string): number | undefined {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
}

export class StateDir {
    constructor(readonly root: string) {}

    private file(name: string): string {
        return path.join(this.root, name);
    }

    spoolRoot(): string {
        return this.file(contract.STATE_SPOOL);
    }

    toolSpool(tool: string = contract.TOOL): string {
        return path.join(this.spoolRoot(), tool);
    }

    /** Create the directory, with mode `0700` on POSIX, when it does not exist yet. */
    ensure(): void {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }

    readId(): IdReading {
        let text: string;
        try {
            text = fs.readFileSync(this.file(contract.STATE_ID), 'utf-8');
        } catch {
            return { kind: 'absent' };
        }
        const trimmed = text.trim();
        return isInstallationId(trimmed) ? { kind: 'valid', id: trimmed } : { kind: 'malformed' };
    }

    /** The identifier to report under: read, created the race-free way, or drawn for
     * this process alone when `id` is malformed or cannot be written. */
    obtainIdentity(): Identity {
        this.removeStaleIdTemporaries();
        const reading = this.readId();
        if (reading.kind === 'valid') return { id: reading.id, created: false, persisted: true };
        if (reading.kind === 'malformed') return { id: randomUuidV4(), created: true, persisted: false };
        try {
            return this.createId();
        } catch {
            return { id: randomUuidV4(), created: true, persisted: false };
        }
    }

    /** Create `id`: write a fresh identifier to a temporary file, flush it, publish it
     * with a hard link that fails when `id` exists, and read back the winner. */
    createId(): Identity {
        this.ensure();
        const fresh = randomUuidV4();
        const temporary = this.file(`${contract.STATE_ID}.tmp-${randomSuffix()}`);
        try {
            const descriptor = fs.openSync(temporary, 'wx', 0o600);
            try {
                fs.writeSync(descriptor, fresh);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            try {
                fs.linkSync(temporary, this.file(contract.STATE_ID));
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
                const winner = this.readId();
                if (winner.kind === 'valid') return { id: winner.id, created: false, persisted: true };
                return { id: fresh, created: true, persisted: false };
            }
            return { id: fresh, created: true, persisted: true };
        } finally {
            try {
                fs.unlinkSync(temporary);
            } catch {
                // Already gone, or never created.
            }
        }
    }

    deleteId(): void {
        removeIfPresent(this.file(contract.STATE_ID));
    }

    private removeStaleIdTemporaries(): void {
        let names: string[];
        try {
            names = fs.readdirSync(this.root);
        } catch {
            return;
        }
        const maxAge = contract.SPOOL_STALE_TEMP_MINUTES * 60 * 1000;
        for (const name of names) {
            if (!name.startsWith(`${contract.STATE_ID}.tmp-`)) continue;
            const modified = modifiedMs(this.file(name));
            if (modified !== undefined && Date.now() - modified > maxAge) {
                try {
                    fs.unlinkSync(this.file(name));
                } catch {
                    // Another process removed it first.
                }
            }
        }
    }

    isDisabled(): boolean {
        return exists(this.file(contract.STATE_DISABLED));
    }

    createDisabled(): void {
        this.ensure();
        createMarker(this.file(contract.STATE_DISABLED));
    }

    deleteDisabled(): void {
        removeIfPresent(this.file(contract.STATE_DISABLED));
    }

    isInternal(): boolean {
        return exists(this.file(contract.STATE_INTERNAL));
    }

    hasNotice(version: number = contract.NOTICE_VERSION): boolean {
        return exists(this.file(`${contract.STATE_NOTICE_PREFIX}${version}`));
    }

    /** The highest notice version, no higher than this release's, recorded as shown. */
    noticeVersion(): number {
        for (let version = contract.NOTICE_VERSION; version >= 1; version--) {
            if (this.hasNotice(version)) return version;
        }
        return 0;
    }

    recordNotice(version: number = contract.NOTICE_VERSION): void {
        this.ensure();
        createMarker(this.file(`${contract.STATE_NOTICE_PREFIX}${version}`));
    }

    legacyMarkerModifiedMs(): number | undefined {
        return modifiedMs(this.file(contract.STATE_LEGACY_MIGRATED));
    }

    /** Set `legacy-migrated`'s modification time to the later of now and the legacy
     * config file's, creating the marker when it does not exist. */
    markLegacyMigrated(legacyConfig: string | undefined): void {
        this.ensure();
        const marker = this.file(contract.STATE_LEGACY_MIGRATED);
        createMarker(marker);
        const configModified = legacyConfig ? modifiedMs(legacyConfig) : undefined;
        const stamp = Math.max(Date.now(), configModified ?? 0);
        const when = new Date(stamp);
        fs.utimesSync(marker, when, when);
    }

    /** Delete every spooled file of every tool, as `disable`, `reset-id` and the legacy migration do. */
    deleteEverySpool(): void {
        let tools: string[];
        try {
            tools = fs.readdirSync(this.spoolRoot());
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw err;
        }
        for (const tool of tools) {
            const dir = path.join(this.spoolRoot(), tool);
            let files: string[];
            try {
                if (!fs.statSync(dir).isDirectory()) continue;
                files = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const name of files) {
                const file = path.join(dir, name);
                try {
                    if (fs.statSync(file).isFile()) removeIfPresent(file);
                } catch {
                    // Removed by another process meanwhile.
                }
            }
        }
    }
}
