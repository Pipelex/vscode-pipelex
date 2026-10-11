/**
 * The extension's spool, `spool/vscode-pipelex/` in the shared state: events the
 * shutdown flush could not post, waiting for the next session. A file is
 * `<created-ms>-<random>.json`, written under a dot name and renamed into place; a
 * sender claims it by renaming it to `<name>.sending-<random>`, then deletes it or
 * renames it back.
 *
 * Node only.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as contract from './contract';
import type { Envelope } from './events';
import { modifiedMs, randomSuffix } from './state';

const SPOOL_VERSION = 1;
const CLAIM_MARK = '.sending-';
const EXTENSION = '.json';

function writeAtomically(file: string, events: readonly Envelope[]): void {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomSuffix()}.tmp`);
    const body = JSON.stringify({ spool_version: SPOOL_VERSION, events });
    try {
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeSync(descriptor, body);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, file);
    } catch (err) {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // Never created.
        }
        throw err;
    }
}

function createdMs(name: string): number | undefined {
    const prefix = /^(\d+)-/.exec(name)?.[1];
    return prefix === undefined ? undefined : Number(prefix);
}

export class Claimed {
    constructor(readonly original: string, readonly claimed: string) {}

    /** The events the file holds, or `undefined` when it is not a spool file this version reads. */
    events(): Envelope[] | undefined {
        try {
            const body = JSON.parse(fs.readFileSync(this.claimed, 'utf-8'));
            if (body?.spool_version !== SPOOL_VERSION || !Array.isArray(body.events)) return undefined;
            return body.events as Envelope[];
        } catch {
            return undefined;
        }
    }

    rewrite(events: readonly Envelope[]): void {
        writeAtomically(this.claimed, events);
    }

    delete(): void {
        try {
            fs.unlinkSync(this.claimed);
        } catch {
            // Already gone.
        }
    }

    /** Give the file back to the next sender. */
    release(): void {
        try {
            fs.renameSync(this.claimed, this.original);
        } catch {
            this.delete();
        }
    }
}

export class Spool {
    constructor(readonly dir: string) {}

    /** Queue `events` in a new file, then trim the spool to its limit, oldest first. */
    write(events: readonly Envelope[]): string {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = path.join(this.dir, `${Date.now()}-${randomSuffix()}${EXTENSION}`);
        writeAtomically(file, events);
        this.trimToLimit();
        return file;
    }

    /** The spool's files, claimed or not, oldest first; temporary files excluded. */
    private files(): string[] {
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return [];
        }
        return names
            .filter(name => !name.startsWith('.'))
            .sort((a, b) => (createdMs(a) ?? Infinity) - (createdMs(b) ?? Infinity))
            .map(name => path.join(this.dir, name));
    }

    private trimToLimit(): void {
        const files = this.files();
        for (const file of files.slice(0, Math.max(0, files.length - contract.SPOOL_MAX_FILES))) {
            try {
                fs.unlinkSync(file);
            } catch {
                // Already gone.
            }
        }
    }

    /** Delete temporary files older than an hour, rename back claims older than ten
     * minutes, and delete unsent files older than thirty days. */
    tidy(now: number = Date.now()): void {
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return;
        }
        for (const name of names) {
            const file = path.join(this.dir, name);
            const modified = modifiedMs(file);
            if (name.startsWith('.')) {
                if (modified !== undefined && now - modified > contract.SPOOL_STALE_TEMP_MINUTES * 60_000) {
                    this.remove(file);
                }
                continue;
            }
            const created = createdMs(name) ?? modified;
            if (created !== undefined && now - created > contract.SPOOL_MAX_AGE_DAYS * 24 * 60 * 60_000) {
                this.remove(file);
                continue;
            }
            const index = name.indexOf(CLAIM_MARK);
            if (index >= 0 && modified !== undefined && now - modified > contract.SPOOL_STALE_CLAIM_MINUTES * 60_000) {
                try {
                    fs.renameSync(file, path.join(this.dir, name.slice(0, index)));
                } catch {
                    // Another sender got it first.
                }
            }
        }
    }

    private remove(file: string): void {
        try {
            fs.unlinkSync(file);
        } catch {
            // Already gone.
        }
    }

    claim(file: string): Claimed | undefined {
        const claimed = `${file}${CLAIM_MARK}${randomSuffix()}`;
        try {
            fs.renameSync(file, claimed);
        } catch {
            return undefined;
        }
        // The rename keeps the file's time; stamp the claim so another sender can
        // tell a live claim from a crashed one.
        try {
            const now = new Date();
            fs.utimesSync(claimed, now, now);
        } catch {
            // The claim still holds; it only looks older.
        }
        return new Claimed(file, claimed);
    }

    claimAll(): Claimed[] {
        return this.files()
            .filter(file => file.endsWith(EXTENSION))
            .map(file => this.claim(file))
            .filter((claimed): claimed is Claimed => claimed !== undefined);
    }
}
