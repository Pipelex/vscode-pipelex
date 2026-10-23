import type { ProblemItem, ProblemLocation, SuggestedFix } from './types';

/**
 * Reading what a validator writes: a verdict's problem items, and the problem
 * document a validator answers when it produces no verdict.
 *
 * Every reader here is loose on purpose. A wire body is untrusted, so a member
 * of the wrong type reads as absent rather than as a wrong value, and an item
 * with no sentence is dropped rather than shown empty.
 *
 * The one item shape read is the MTHDS problem item (`code`, `detail`,
 * `params`, `location`, `suggested_fix`), which pipelex's runner and
 * `pipelex-agent` write from pipelex 0.90.0. The validation item it replaced
 * (`category`, `message`, `pipe_code`, `source`, …) carries no `detail`, so an
 * element of that shape is dropped like any other unreadable element, and a
 * verdict listing its faults only in `validation_errors[]` reads as a verdict
 * with no readable fault.
 */

/** The core registry's base URL: a core code's type URI is this, a slash, then the code. */
const CORE_ERRORS_BASE_URL = 'https://mthds.ai/errors';

/**
 * The extension prefixes the core registry registers, each with the base URL
 * its codes' pages live under. A code whose first segment is not one of them
 * is a core code. A `Map`, so a prefix such as `constructor` names no
 * inherited member of an object.
 */
const EXTENSION_ERRORS_BASE_URLS: ReadonlyMap<string, string> = new Map([
    ['pipelex', 'https://docs.pipelex.com/errors'],
]);

/**
 * The type URI of a code, which is the URL of the page saying what the code
 * means and what to do about it: its owner's base URL, a slash, then the whole
 * code (the protocol's `type` rule).
 */
export function problemTypeUri(code: string): string {
    const prefix = code.split('.', 1)[0];
    const baseUrl = EXTENSION_ERRORS_BASE_URLS.get(prefix) ?? CORE_ERRORS_BASE_URL;
    return `${baseUrl}/${code}`;
}

/** Read a list of problem items off the wire, dropping every element that is not one. */
export function readProblemItems(raw: unknown): ProblemItem[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const items: ProblemItem[] = [];
    for (const element of raw) {
        const item = readProblemItem(element);
        if (item) {
            items.push(item);
        }
    }
    return items;
}

/** The members of a problem document the extension shows or logs when a validator produced no verdict. */
export interface ProblemSummary {
    code?: string;
    detail?: string;
    /** `next_step.detail`: what the reader should do now. */
    nextStep?: string;
    /** The request that carried the failure, which finds its server's log lines. */
    requestId?: string;
}

/**
 * Read a problem document, or undefined when the body is not one: not an
 * object, or carrying neither a `code` nor a `detail`.
 */
export function readProblemSummary(raw: unknown): ProblemSummary | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const summary: ProblemSummary = {
        code: text(raw.code),
        detail: text(raw.detail),
        nextStep: isRecord(raw.next_step) ? text(raw.next_step.detail) : undefined,
        requestId: text(raw.request_id),
    };
    return summary.code !== undefined || summary.detail !== undefined ? summary : undefined;
}

/**
 * The facts a log line about a failure carries, so its reader can look it up:
 * ` (code <code>, request <id>)`, either part only when known, or nothing.
 */
export function problemFacts(code: string | undefined, requestId: string | undefined): string {
    const facts = [
        code ? `code ${code}` : undefined,
        requestId ? `request ${requestId}` : undefined,
    ].filter(fact => fact !== undefined);
    return facts.length > 0 ? ` (${facts.join(', ')})` : '';
}

/** A sentence followed by the next step, when there is one. */
export function withNextStep(sentence: string, nextStep: string | undefined): string {
    if (!nextStep) {
        return sentence;
    }
    return `${asSentence(sentence)} Next step: ${nextStep}`;
}

/** The text with a closing period when it does not end a sentence already. */
export function asSentence(value: string): string {
    const trimmed = value.trimEnd();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The bare code of the pipe an item points at. */
export function itemPipe(item: ProblemItem): string | undefined {
    return item.location?.pipe;
}

/** The concept an item names, from its `concept` parameter. */
export function itemConcept(item: ProblemItem): string | undefined {
    return text(item.params?.concept);
}

/** The field an item points at, a name or a dotted path. */
export function itemField(item: ProblemItem): string | undefined {
    return item.location?.field ?? text(item.params?.field_path);
}

/** One problem item, or undefined for an element that is no object or carries no `detail`. */
function readProblemItem(raw: unknown): ProblemItem | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const detail = text(raw.detail);
    if (detail === undefined) {
        return undefined;
    }
    const item: ProblemItem = { detail };
    const code = text(raw.code);
    if (code !== undefined) item.code = code;
    if (isRecord(raw.params)) item.params = raw.params;
    const location = readLocation(raw.location);
    if (location) item.location = location;
    const fix = readSuggestedFix(raw.suggested_fix);
    if (fix) item.suggested_fix = fix;
    return item;
}

function readLocation(raw: unknown): ProblemLocation | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    return compactLocation({
        pipe: text(raw.pipe),
        field: text(raw.field),
        file: text(raw.file),
        line: position(raw.line),
        column: position(raw.column),
    });
}

function compactLocation(location: ProblemLocation): ProblemLocation | undefined {
    const entries = Object.entries(location).filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) as ProblemLocation : undefined;
}

/** A suggested fix, which names the file it edits as `file`. */
function readSuggestedFix(raw: unknown): SuggestedFix | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const description = text(raw.description);
    if (description === undefined) {
        return undefined;
    }
    const fix: SuggestedFix = { fix_code: text(raw.fix_code) ?? '', description };
    const safety = text(raw.safety);
    if (safety !== undefined) fix.safety = safety;
    const file = text(raw.file);
    if (file !== undefined) fix.file = file;
    if (Array.isArray(raw.ops)) fix.ops = raw.ops;
    return fix;
}

/** Whether a value read off the wire is a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A 1-based position, or undefined. */
function position(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}
