import { describe, it, expect, vi } from 'vitest';

// backend.ts imports 'vscode' at module level (for types + Uri); the pure
// helpers under test never touch it, so an empty stub suffices.
vi.mock('vscode', () => ({}));

import { BackendError } from '../validation/backend';
import {
    describeBackendErrorIssue,
    errorContext,
    inferPipeRefFromRegistry,
    parseStaticIssueContext,
    problemItemsToIssues,
} from '../graph/validationStatus';

describe('errorContext', () => {
    it('prefers the pipe chip, then the concept chip, then nothing', () => {
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' } })).toBe('pipe.my_pipe');
        expect(errorContext({ detail: 'm', params: { concept: 'Foo' } })).toBe('concept.Foo');
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' }, params: { concept: 'Foo' } })).toBe('pipe.my_pipe');
        expect(errorContext({ detail: 'm' })).toBeUndefined();
    });

    it("keeps the pipe chip bare when the pipe lives in the shown file's domain", () => {
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' } }, 'screening', 'screening')).toBe('pipe.my_pipe');
    });

    it('qualifies the pipe chip when the pipe lives in another domain', () => {
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' } }, 'screening', 'helpers')).toBe('pipe.helpers.my_pipe');
    });

    it('stays bare when either domain is unknown', () => {
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' } }, 'screening')).toBe('pipe.my_pipe');
        expect(errorContext({ detail: 'm', location: { pipe: 'my_pipe' } }, undefined, 'helpers')).toBe('pipe.my_pipe');
    });
});

describe('inferPipeRefFromRegistry', () => {
    const registry = ['screening.analyze', 'screening.main', 'helpers.analyze', '.orphan'];

    it('qualifies a code that exactly one registry ref carries', () => {
        expect(inferPipeRefFromRegistry('main', registry)).toBe('screening.main');
    });

    it('refuses to guess among colliding domains', () => {
        expect(inferPipeRefFromRegistry('analyze', registry)).toBeUndefined();
    });

    it('returns undefined for unknown codes, malformed keys, and a missing registry', () => {
        expect(inferPipeRefFromRegistry('nonexistent', registry)).toBeUndefined();
        // `.orphan` is an empty-domain key — parseable code but no domain to qualify with.
        expect(inferPipeRefFromRegistry('orphan', registry)).toBeUndefined();
        expect(inferPipeRefFromRegistry('main', undefined)).toBeUndefined();
    });
});

describe('problemItemsToIssues', () => {
    it('projects detail, chip, owning file, and the suggested-fix description', () => {
        const issues = problemItemsToIssues(
            [
                {
                    code: 'method.output_concept_mismatch',
                    detail: 'output mismatch',
                    location: { pipe: 'analyze', file: 'main.mthds' },
                    suggested_fix: { fix_code: 'match-sequence-output', description: 'Align the output.', ops: [] },
                },
                { code: 'method.concept_unresolved', detail: 'unknown concept', params: { concept: 'Bar' } },
            ],
            { ownerFiles: [undefined, 'concepts.mthds'], pipeDomains: ['demo', undefined] },
        );

        expect(issues).toEqual([
            {
                severity: 'error',
                message: 'output mismatch',
                context: 'pipe.analyze',
                file: undefined,
                suggestedFix: 'Align the output.',
                origin: 'validator',
                pipeRef: 'demo.analyze',
            },
            {
                severity: 'error',
                message: 'unknown concept',
                context: 'concept.Bar',
                file: 'concepts.mthds',
                suggestedFix: undefined,
                origin: 'validator',
                pipeRef: undefined,
            },
        ]);
    });

    it('gives advisory findings the warning severity', () => {
        const issues = problemItemsToIssues([{ code: 'method.hint_invalid', detail: 'odd hint' }], {}, 'warning');
        expect(issues[0].severity).toBe('warning');
    });

    it('tolerates a missing suggested fix and missing context', () => {
        const issues = problemItemsToIssues([{ code: 'method.invalid', detail: 'm' }]);
        expect(issues[0].suggestedFix).toBeUndefined();
        expect(issues[0].file).toBeUndefined();
    });

    it("builds pipeRef from the pipe and its declaring file's domain", () => {
        const issues = problemItemsToIssues(
            [
                { detail: 'm', location: { pipe: 'my_pipe' } },
                { detail: 'm', params: { concept: 'Foo' } },
            ],
            { pipeDomains: ['demo', 'demo'] },
        );
        expect(issues.map(issue => issue.pipeRef)).toEqual(['demo.my_pipe', undefined]);
    });

    it("infers the domain from the registry when the pipe's declaring file is not known", () => {
        const registryRefs = ['screening.analyze', 'screening.main', 'helpers.analyze'];
        const issues = problemItemsToIssues(
            [
                { detail: 'm', location: { pipe: 'main' } },
                // Colliding code: two domains declare `analyze` — never guess.
                { detail: 'm', location: { pipe: 'analyze' } },
            ],
            { pipeRegistryRefs: registryRefs },
        );
        expect(issues.map(issue => issue.pipeRef)).toEqual(['screening.main', undefined]);
        // An inferred domain qualifies the chip as a known one does.
        expect(problemItemsToIssues(
            [{ detail: 'm', location: { pipe: 'main' } }],
            { pipeRegistryRefs: registryRefs, shownDomain: 'helpers' },
        )[0].context).toBe('pipe.screening.main');
    });

    it('leaves a bare pipe untargeted without a domain or a registry', () => {
        const issues = problemItemsToIssues([{ detail: 'm', location: { pipe: 'my_pipe' } }]);
        expect(issues[0].pipeRef).toBeUndefined();
    });

    it("prefers the declaring file's domain over registry inference", () => {
        // The registry knows `analyze` only under `screening`, but the file the
        // item resolved declares `helpers` — the file is authoritative.
        const issues = problemItemsToIssues(
            [{ detail: 'm', location: { pipe: 'analyze' } }],
            { pipeRegistryRefs: ['screening.analyze'], pipeDomains: ['helpers'], shownDomain: 'screening' },
        );
        expect(issues[0].pipeRef).toBe('helpers.analyze');
        expect(issues[0].context).toBe('pipe.helpers.analyze');
    });

    it('coerces boundary fields to strings so a malformed response cannot crash the React renderer', () => {
        // The types promise strings but a caller may not hold to them — a
        // non-string rendered as a React child throws inside GraphViewer.
        const issues = problemItemsToIssues([
            {
                detail: { unexpected: 'object' },
                suggested_fix: { fix_code: 'f', description: ['not', 'a', 'string'] },
            } as any,
        ]);
        expect(typeof issues[0].message).toBe('string');
        expect(typeof issues[0].suggestedFix).toBe('string');
    });
});

describe('parseStaticIssueContext', () => {
    it('extracts the declaration reference from a TOML path prefix', () => {
        expect(parseStaticIssueContext('pipe.analyze_candidate.output')).toEqual({ kind: 'pipe', code: 'analyze_candidate' });
        expect(parseStaticIssueContext('concept.Foo')).toEqual({ kind: 'concept', code: 'Foo' });
    });

    it('does not truncate a hyphenated code (invalid MTHDS, but present in the file)', () => {
        expect(parseStaticIssueContext('pipe.my-pipe.output')).toEqual({ kind: 'pipe', code: 'my-pipe' });
    });

    it('returns undefined for paths that name no declaration', () => {
        expect(parseStaticIssueContext(undefined)).toBeUndefined();
        expect(parseStaticIssueContext('domain')).toBeUndefined();
        expect(parseStaticIssueContext('bundle.main_pipe')).toBeUndefined();
    });
});

describe('describeBackendErrorIssue', () => {
    it('gives actionable wording for a missing CLI', () => {
        const issue = describeBackendErrorIssue(new BackendError({ kind: 'not-found', logMessage: 'x' }));
        expect(issue.severity).toBe('error');
        expect(issue.message).toContain('pipelex-agent');
        expect(issue.message).toContain('pipelex.validation.agentCliPath');
    });

    it('names installed and required versions for a too-old CLI', () => {
        const issue = describeBackendErrorIssue(new BackendError({
            kind: 'too-old',
            logMessage: 'x',
            installedVersion: '0.89.0',
            minVersion: '0.90.0',
        }));
        expect(issue.message).toContain('0.89.0');
        expect(issue.message).toContain('0.90.0');
    });

    it.each(['api-error', 'no-key'] as const)('prefers the userMessage for API-side failures (%s)', kind => {
        const issue = describeBackendErrorIssue(new BackendError({
            kind,
            logMessage: 'raw log',
            userMessage: 'Pipelex API error (HTTP 503).',
        }));
        expect(issue.message).toBe('Pipelex API error (HTTP 503).');
    });

    it('explains a declined remote send, and how to get validation back', () => {
        const issue = describeBackendErrorIssue(new BackendError({ kind: 'declined', logMessage: 'x' }));
        // The user's own choice, not a fault: a note, never an error.
        expect(issue.severity).toBe('warning');
        expect(issue.message).toContain('declined');
        expect(issue.message).toContain('reload the window');
        expect(issue.message).toContain('pipelex.backend to cli');
    });

    it('falls back to the plain error message for non-backend failures', () => {
        expect(describeBackendErrorIssue(new Error('boom')).message).toBe('boom');
        expect(describeBackendErrorIssue('weird').message).toBe('weird');
    });
});
