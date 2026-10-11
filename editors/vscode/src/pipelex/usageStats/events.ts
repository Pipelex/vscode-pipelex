/**
 * The extension's two events, `extension_activated` and `feature_used`, in the
 * envelope PostHog receives. Every value is an enum value, a count, a version or one
 * of the contract's own identifiers: no path, setting, file or message can reach one.
 *
 * Dependency-free, so the tests build events without a host.
 */

import * as contract from './contract';
import type { Editor, Feature } from './contract';

export interface Envelope {
    event: string;
    distinct_id: string;
    uuid: string;
    timestamp: string;
    properties: Record<string, string | number | boolean>;
}

/** The common properties, computed per event from the host and the shared state. */
export interface Common {
    toolVersion: string;
    idNew: boolean;
    os: 'linux' | 'darwin' | 'windows' | 'other';
    arch: 'x86_64' | 'arm64' | 'other';
    languageRuntime: string | undefined;
    ci: boolean;
    container: boolean;
    internal: boolean;
    noticeVersion: number;
}

export interface EditorFacts {
    editor: Editor;
    editorVersion: string;
}

function commonProperties(common: Common): Record<string, string | number | boolean> {
    const properties: Record<string, string | number | boolean> = {
        schema: contract.SCHEMA_VERSION,
        tool: contract.TOOL,
        tool_version: common.toolVersion,
        surface: contract.SURFACE,
        id_new: common.idNew,
        os: common.os,
        arch: common.arch,
    };
    if (common.languageRuntime !== undefined) properties.language_runtime = common.languageRuntime;
    properties.ci = common.ci;
    properties.container = common.container;
    properties.internal = common.internal;
    properties.notice_version = common.noticeVersion;
    properties[contract.PERSON_PROFILE_PROPERTY] = false;
    return properties;
}

/** RFC 3339 in UTC with milliseconds, as `Date.toISOString` writes it. */
export function timestamp(now: Date = new Date()): string {
    return now.toISOString();
}

function envelope(
    event: string,
    distinctId: string,
    uuid: string,
    now: Date,
    properties: Record<string, string | number | boolean>,
): Envelope {
    return { event, distinct_id: distinctId, uuid, timestamp: timestamp(now), properties };
}

export function extensionActivated(
    distinctId: string,
    uuid: string,
    common: Common,
    editor: EditorFacts,
    now: Date = new Date(),
): Envelope {
    return envelope(contract.EVENT_EXTENSION_ACTIVATED, distinctId, uuid, now, {
        ...commonProperties(common),
        editor_version: editor.editorVersion,
        editor: editor.editor,
    });
}

export function featureUsed(
    distinctId: string,
    uuid: string,
    common: Common,
    editor: EditorFacts,
    feature: Feature,
    count: number,
    now: Date = new Date(),
): Envelope {
    return envelope(contract.EVENT_FEATURE_USED, distinctId, uuid, now, {
        ...commonProperties(common),
        feature,
        count: Math.max(1, Math.min(contract.MAX_FEATURE_COUNT, Math.floor(count))),
        editor_version: editor.editorVersion,
        editor: editor.editor,
    });
}

/** The UTC day of `now`, `YYYY-MM-DD`: `extension_activated` is sent once per day. */
export function utcDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}
