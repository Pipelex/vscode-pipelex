/**
 * Test helper: the usage-statistics schema this repository vendors byte for byte at
 * `test-data/usage-statistics.json`, and the checks the PostHog gate applies to an
 * event, read from it the way conformance's reference evaluator
 * (`conformance/usage_stats/gate.py`) reads it. Not a test file itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

type Json = any;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const SCHEMA_PATH = path.join(REPO_ROOT, 'test-data', 'usage-statistics.json');

export function loadSchema(): Json {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
}

/** UTF-16 code units, as JavaScript and Hog count a string. */
function patternMatches(schema: Json, name: string, text: string): boolean {
    const pattern = schema.patterns[name];
    return text.length <= pattern.max_length && new RegExp(pattern.regex).test(text);
}

function conditionHolds(condition: Json, properties: Record<string, unknown>): boolean {
    return properties[condition.property] === condition.equals;
}

function inBounds(rule: Json, value: number): boolean {
    return value >= rule.min && value <= rule.max;
}

function valueIsValid(schema: Json, rule: Json, value: unknown, properties: Record<string, unknown>): boolean {
    let valid: boolean;
    switch (rule.type) {
        case 'integer':
            valid = typeof value === 'number' && Number.isInteger(value) && inBounds(rule, value);
            break;
        case 'number':
            valid = typeof value === 'number' && Number.isFinite(value) && inBounds(rule, value);
            break;
        case 'boolean':
            valid = typeof value === 'boolean';
            break;
        case 'enum': {
            let allowed: unknown[] | undefined = rule.values;
            if (!allowed && rule.values_by) {
                const selected = properties[rule.values_by.property];
                allowed = typeof selected === 'string' ? rule.values_by.values[selected] : undefined;
            }
            valid = typeof value === 'string' && Array.isArray(allowed) && allowed.includes(value);
            break;
        }
        case 'pattern':
            valid = typeof value === 'string' && patternMatches(schema, rule.pattern, value);
            break;
        case 'secret':
            valid = true;
            break;
        default:
            throw new Error(`the schema names a type this test does not know: ${rule.type}`);
    }
    if (valid && rule.fixed_when && properties[rule.fixed_when.property] === rule.fixed_when.equals) {
        valid = value === rule.fixed_when.value;
    }
    return valid;
}

/** The first reason the gate would drop `envelope`, or `undefined` when it passes. */
export function gateDropReason(schema: Json, envelope: Json): string | undefined {
    const name = envelope?.event;
    const eventSpec = typeof name === 'string' ? schema.events[name] : undefined;
    if (!eventSpec) return `undeclared event ${name}`;
    const properties = envelope.properties;
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        return 'properties are not an object';
    }
    for (const [field, rule] of Object.entries<Json>(schema.envelope.fields)) {
        const value = envelope[field];
        if (typeof value !== 'string' || !patternMatches(schema, rule.pattern, value)) {
            return `envelope field ${field} is not a ${rule.pattern}`;
        }
    }
    for (const field of Object.keys(schema.envelope.empty_fields)) {
        const value = envelope[field];
        if (value !== undefined && value !== null && value !== '') return `envelope field ${field} is not empty`;
    }
    const profile = schema.person_profile_property;
    const isDeletion = eventSpec.person_profile === 'deletion';
    if (properties[profile] !== isDeletion) return `${profile} must be ${isDeletion}`;
    if (eventSpec.tools.length > 0 && !eventSpec.tools.includes(properties.tool)) return 'the tool may not send this event';

    const declared: Record<string, Json> = {
        ...(eventSpec.common ? schema.common_properties : {}),
        ...eventSpec.properties,
    };
    for (const [property, value] of Object.entries(properties)) {
        if (property === profile) continue;
        const rule = declared[property];
        if (!rule) {
            if (property in schema.posthog_added_properties) continue;
            return `undeclared property ${property}`;
        }
        if (rule.when && !conditionHolds(rule.when, properties)) return `${property} is not allowed here`;
        if (!valueIsValid(schema, rule, value, properties)) return `invalid value for ${property}: ${JSON.stringify(value)}`;
    }
    for (const [property, rule] of Object.entries<Json>(declared)) {
        if (!rule.required || (properties[property] !== undefined && properties[property] !== null)) continue;
        if (!rule.when || conditionHolds(rule.when, properties)) return `missing required ${property}`;
    }
    return undefined;
}

/** What an emitter must hold to on top of the gate: only the contract's envelope
 * fields, so no `$lib`, `sent_at`, `$set` or `$geoip_disable`. */
export function envelopeKeys(envelope: Json): string[] {
    return Object.keys(envelope).sort();
}

export const ENVELOPE_KEYS = ['distinct_id', 'event', 'properties', 'timestamp', 'uuid'];
