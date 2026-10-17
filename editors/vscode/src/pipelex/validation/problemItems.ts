import type { LegacyItemFacts, ProblemItem, ProblemLocation, SuggestedFix } from './types';

/**
 * Reading what a validator writes: a verdict's problem items, and the problem
 * document a validator answers when it produces no verdict.
 *
 * Every reader here is loose on purpose. A wire body is untrusted, so a member
 * of the wrong type reads as absent rather than as a wrong value, and a problem
 * item with no sentence is dropped rather than shown empty. The validation
 * item problem items replace may carry an empty `message`, which its shape
 * allows, so such an item is kept with {@link UNDESCRIBED_ITEM_DETAIL} as its
 * sentence: its fault is still a fault of the verdict.
 *
 * Two item shapes are read, element by element:
 *
 * - **The problem item** (`code`, `detail`, `params`, `location`,
 *   `suggested_fix`), which pipelex's runner and `pipelex-agent` write from the
 *   release that speaks the problem document.
 * - **The validation item it replaces** (`category`, `message`, `pipe_code`,
 *   `concept_code`, `source`, `field_path`, …), which the hosted plane's runner
 *   and a `pipelex-agent` older than that release still write. It is read into
 *   the problem item's members, with no code, and keeps its `domain_code` and
 *   `error_type` in `legacy`. This reader goes once the hosted plane runs a
 *   pipelex that writes problems and the CLI floor (`MIN_AGENT_VERSION`)
 *   reaches that release.
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

/** Read a list of items off the wire, whichever of the two shapes each element has. */
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

/**
 * The faults of an invalid verdict: its `errors[]`, or, from a validator that
 * still writes the shape problem items replace, its `validation_errors[]`.
 * Empty when neither holds a readable item, which no invalid verdict may be.
 */
export function readVerdictErrors(body: Record<string, unknown>): ProblemItem[] {
    const errors = readProblemItems(body.errors);
    if (errors.length > 0) {
        return errors;
    }
    return readProblemItems(body.validation_errors);
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

/**
 * The sentence of a validation item, of the shape problem items replace,
 * whose `message` is empty or missing. That shape always carries its
 * `category`, which is how such an item is recognized.
 */
export const UNDESCRIBED_ITEM_DETAIL = 'The validator reported this without describing it.';

function readProblemItem(raw: unknown): ProblemItem | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    if (text(raw.detail) !== undefined) {
        return fromProblemItem(raw);
    }
    if (text(raw.message) !== undefined || text(raw.category) !== undefined) {
        return fromValidationItem(raw);
    }
    return undefined;
}

function fromProblemItem(raw: Record<string, unknown>): ProblemItem {
    const item: ProblemItem = { detail: text(raw.detail)! };
    const code = text(raw.code);
    if (code !== undefined) item.code = code;
    if (isRecord(raw.params)) item.params = raw.params;
    const location = readLocation(raw.location);
    if (location) item.location = location;
    const fix = readSuggestedFix(raw.suggested_fix, 'file');
    if (fix) item.suggested_fix = fix;
    return item;
}

/**
 * The validation item problem items replace, read into the same members the
 * way pipelex builds a problem item from it: the detail from `message`, or
 * {@link UNDESCRIBED_ITEM_DETAIL} when it is empty, the pipe and the file from
 * `pipe_code` and `source`, the field from `field_name` or `field_path`, the
 * concept parameter from `concept_code` or `missing_concept_code`. Its
 * `domain_code` and `error_type` have no member there, so they are kept in
 * `legacy`: the domain tells apart two domains declaring the same pipe code
 * when the item names no file, and the error type is the diagnostic's code.
 */
function fromValidationItem(raw: Record<string, unknown>): ProblemItem {
    const item: ProblemItem = { detail: text(raw.message) ?? UNDESCRIBED_ITEM_DETAIL };
    const params: Record<string, unknown> = {};
    const concept = text(raw.concept_code) ?? text(raw.missing_concept_code);
    if (concept !== undefined) params.concept = concept;
    const fieldPath = text(raw.field_path);
    if (fieldPath !== undefined) params.field_path = fieldPath;
    if (Object.keys(params).length > 0) item.params = params;
    const location = compactLocation({
        pipe: text(raw.pipe_code),
        field: text(raw.field_name) ?? fieldPath,
        file: text(raw.source),
    });
    if (location) item.location = location;
    const fix = readSuggestedFix(raw.suggested_fix, 'source');
    if (fix) item.suggested_fix = fix;
    const legacy: LegacyItemFacts = {};
    const domainCode = text(raw.domain_code);
    if (domainCode !== undefined) legacy.domainCode = domainCode;
    const errorType = text(raw.error_type);
    if (errorType !== undefined) legacy.errorType = errorType;
    if (Object.keys(legacy).length > 0) item.legacy = legacy;
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

/** A suggested fix, its edited file read from `fileKey` (`file` on a problem item, `source` before it). */
function readSuggestedFix(raw: unknown, fileKey: 'file' | 'source'): SuggestedFix | undefined {
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
    const file = text(raw[fileKey]);
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
