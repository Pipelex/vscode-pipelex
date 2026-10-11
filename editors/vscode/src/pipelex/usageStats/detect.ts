/**
 * Facts about the extension host the events describe: CI, container, platform,
 * Node's major version and the editor. Node only, for the container check.
 */

import * as fs from 'fs';
import * as contract from './contract';
import type { Editor } from './contract';
import { flagIsOn } from './switches';

export function isCi(env: Record<string, string | undefined>): boolean {
    return contract.CI_VARIABLES.some(name => flagIsOn(env, name));
}

export function isContainer(
    env: Record<string, string | undefined>,
    fileExists: (file: string) => boolean = file => fs.existsSync(file),
    cgroup: string | undefined = readCgroup(),
): boolean {
    return contract.CONTAINER_FILES.some(file => fileExists(file))
        || contract.CONTAINER_VARIABLES.some(name => (env[name] ?? '') !== '')
        || (cgroup !== undefined && contract.CONTAINER_CGROUP_WORDS.some(word => cgroup.includes(word)));
}

function readCgroup(): string | undefined {
    try {
        return fs.readFileSync('/proc/1/cgroup', 'utf-8');
    } catch {
        return undefined;
    }
}

export function osOf(platform: string = process.platform): 'linux' | 'darwin' | 'windows' | 'other' {
    switch (platform) {
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'darwin';
        case 'win32':
            return 'windows';
        default:
            return 'other';
    }
}

export function archOf(arch: string = process.arch): 'x86_64' | 'arm64' | 'other' {
    switch (arch) {
        case 'x64':
            return 'x86_64';
        case 'arm64':
            return 'arm64';
        default:
            return 'other';
    }
}

/** `node-<major>`, the runtime the extension host runs on. */
export function languageRuntime(nodeVersion: string = process.versions.node): string | undefined {
    const major = /^(\d{1,3})\./.exec(nodeVersion)?.[1];
    return major ? `node-${major}` : undefined;
}

/** Which editor hosts the extension, from `vscode.env.appName`. */
export function editorOf(appName: string): Editor {
    const name = appName.toLowerCase();
    if (name.includes('insiders')) return 'vscode-insiders';
    if (name.includes('vscodium')) return 'vscodium';
    if (name.includes('cursor')) return 'cursor';
    if (name.includes('windsurf')) return 'windsurf';
    if (name.includes('visual studio code')) return 'vscode';
    return 'other';
}

/** A version as the schema's release-version pattern admits it: as given when it
 * matches, else its leading `major.minor.patch`, else `undefined` (no event). */
export function releaseVersion(version: string): string | undefined {
    if (version.length <= contract.RELEASE_VERSION_MAX_LENGTH && contract.RELEASE_VERSION_RE.test(version)) {
        return version;
    }
    const prefix = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}/.exec(version)?.[0];
    return prefix;
}
