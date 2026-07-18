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
    validationErrorsToIssues,
} from '../graph/validationStatus';

describe('errorContext', () => {
    it('prefers the pipe chip, then the concept chip, then nothing', () => {
        expect(errorContext({ category: 'x', message: 'm', pipe_code: 'my_pipe' })).toBe('pipe.my_pipe');
        expect(errorContext({ category: 'x', message: 'm', concept_code: 'Foo' })).toBe('concept.Foo');
        expect(errorContext({ category: 'x', message: 'm', pipe_code: 'my_pipe', concept_code: 'Foo' })).toBe('pipe.my_pipe');
        expect(errorContext({ category: 'x', message: 'm' })).toBeUndefined();
    });

    it('keeps the pipe chip bare when the error lives in the shown domain', () => {
        expect(errorContext(
            { category: 'x', message: 'm', pipe_code: 'my_pipe', domain_code: 'screening' },
            'screening',
        )).toBe('pipe.my_pipe');
    });

    it('qualifies the pipe chip when the error lives in another domain', () => {
        expect(errorContext(
            { category: 'x', message: 'm', pipe_code: 'my_pipe', domain_code: 'helpers' },
            'screening',
        )).toBe('pipe.helpers.my_pipe');
    });

    it('stays bare when either domain is unknown', () => {
        expect(errorContext({ category: 'x', message: 'm', pipe_code: 'my_pipe' }, 'screening'))
            .toBe('pipe.my_pipe');
        expect(errorContext({ category: 'x', message: 'm', pipe_code: 'my_pipe', domain_code: 'helpers' }))
            .toBe('pipe.my_pipe');
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

describe('validationErrorsToIssues', () => {
    it('projects message, chip, owning file, and the suggested-fix description', () => {
        const issues = validationErrorsToIssues(
            [
                {
                    category: 'pipe_validation',
                    message: 'output mismatch',
                    pipe_code: 'analyze',
                    domain_code: 'demo',
                    suggested_fix: { fix_code: 'match-sequence-output', description: 'Align the output.', ops: [] },
                },
                { category: 'concept_validation', message: 'unknown concept', concept_code: 'Bar' },
            ],
            { ownerFiles: [undefined, 'concepts.mthds'] },
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

    it('tolerates a null suggested_fix and missing context', () => {
        const issues = validationErrorsToIssues([
            { category: 'x', message: 'm', suggested_fix: null },
        ]);
        expect(issues[0].suggestedFix).toBeUndefined();
        expect(issues[0].file).toBeUndefined();
    });

    it('builds pipeRef from domain_code + pipe_code, tolerating nulls', () => {
        const issues = validationErrorsToIssues([
            { category: 'x', message: 'm', pipe_code: 'my_pipe', domain_code: 'demo' },
            { category: 'x', message: 'm', pipe_code: null, domain_code: 'demo' },
            { category: 'x', message: 'm', concept_code: 'Foo' },
        ]);
        expect(issues.map(issue => issue.pipeRef)).toEqual(['demo.my_pipe', undefined, undefined]);
    });

    it('infers the domain from the registry when only pipe_code arrives', () => {
        const registryRefs = ['screening.analyze', 'screening.main', 'helpers.analyze'];
        const issues = validationErrorsToIssues(
            [
                { category: 'x', message: 'm', pipe_code: 'main' },
                // Colliding code: two domains declare `analyze` — never guess.
                { category: 'x', message: 'm', pipe_code: 'analyze' },
            ],
            { pipeRegistryRefs: registryRefs },
        );
        expect(issues.map(issue => issue.pipeRef)).toEqual(['screening.main', undefined]);
    });

    it('leaves a bare pipe_code untargeted without a registry', () => {
        const issues = validationErrorsToIssues([
            { category: 'x', message: 'm', pipe_code: 'my_pipe' },
        ]);
        expect(issues[0].pipeRef).toBeUndefined();
    });

    it('prefers the wire domain_code over registry inference', () => {
        // The registry knows `analyze` only under `screening`, but the error
        // says `helpers` — the wire is authoritative.
        const issues = validationErrorsToIssues(
            [{ category: 'x', message: 'm', pipe_code: 'analyze', domain_code: 'helpers' }],
            { pipeRegistryRefs: ['screening.analyze'] },
        );
        expect(issues[0].pipeRef).toBe('helpers.analyze');
    });

    it('coerces boundary fields to strings so a malformed response cannot crash the React renderer', () => {
        // The wire types promise strings but the wire itself doesn't — a
        // non-string rendered as a React child throws inside GraphViewer.
        const issues = validationErrorsToIssues([
            {
                category: 'x',
                message: { unexpected: 'object' },
                pipe_code: 42,
                domain_code: 7,
                suggested_fix: { fix_code: 'f', description: ['not', 'a', 'string'] },
            } as any,
        ]);
        expect(typeof issues[0].message).toBe('string');
        expect(issues[0].pipeRef).toBe('7.42');
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
            installedVersion: '0.30.0',
            minVersion: '0.34.0',
        }));
        expect(issue.message).toContain('0.30.0');
        expect(issue.message).toContain('0.34.0');
    });

    it('prefers the userMessage for API-side failures', () => {
        const issue = describeBackendErrorIssue(new BackendError({
            kind: 'api-error',
            logMessage: 'raw log',
            userMessage: 'Pipelex API error (HTTP 503).',
        }));
        expect(issue.message).toBe('Pipelex API error (HTTP 503).');
    });

    it('explains a declined remote send', () => {
        const issue = describeBackendErrorIssue(new BackendError({ kind: 'declined', logMessage: 'x' }));
        expect(issue.severity).toBe('error');
        expect(issue.message).toContain('declined');
    });

    it('falls back to the plain error message for non-backend failures', () => {
        expect(describeBackendErrorIssue(new Error('boom')).message).toBe('boom');
        expect(describeBackendErrorIssue('weird').message).toBe('weird');
    });
});
