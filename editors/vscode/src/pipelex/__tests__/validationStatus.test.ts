import { describe, it, expect, vi } from 'vitest';

// backend.ts imports 'vscode' at module level (for types + Uri); the pure
// helpers under test never touch it, so an empty stub suffices.
vi.mock('vscode', () => ({}));

import { BackendError } from '../validation/backend';
import {
    describeBackendErrorIssue,
    errorContext,
    parseStaticIssueContext,
    validationErrorsToIssues,
} from '../graph/validationStatus';

describe('errorContext', () => {
    it('prefers the pipe chip, then the concept chip, then nothing', () => {
        expect(errorContext({ category: 'x', message: 'm', pipe_code: 'my_pipe' })).toBe('pipe.my_pipe');
        expect(errorContext({ category: 'x', message: 'm', concept_code: 'Foo' })).toBe('concept.Foo');
        expect(errorContext({ category: 'x', message: 'm' })).toBeUndefined();
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
                    suggested_fix: { fix_code: 'match-sequence-output', description: 'Align the output.', ops: [] },
                },
                { category: 'concept_validation', message: 'unknown concept', concept_code: 'Bar' },
            ],
            [undefined, 'concepts.mthds'],
        );

        expect(issues).toEqual([
            {
                severity: 'error',
                message: 'output mismatch',
                context: 'pipe.analyze',
                file: undefined,
                suggestedFix: 'Align the output.',
                origin: 'validator',
                pipeCode: 'analyze',
            },
            {
                severity: 'error',
                message: 'unknown concept',
                context: 'concept.Bar',
                file: 'concepts.mthds',
                suggestedFix: undefined,
                origin: 'validator',
                pipeCode: undefined,
            },
        ]);
    });

    it('tolerates a null suggested_fix and missing owner list', () => {
        const issues = validationErrorsToIssues([
            { category: 'x', message: 'm', suggested_fix: null },
        ]);
        expect(issues[0].suggestedFix).toBeUndefined();
        expect(issues[0].file).toBeUndefined();
    });

    it('fills the graph target pipeCode from pipe_code, tolerating null', () => {
        const issues = validationErrorsToIssues([
            { category: 'x', message: 'm', pipe_code: 'my_pipe' },
            { category: 'x', message: 'm', pipe_code: null },
            { category: 'x', message: 'm', concept_code: 'Foo' },
        ]);
        expect(issues.map(issue => issue.pipeCode)).toEqual(['my_pipe', undefined, undefined]);
    });

    it('coerces boundary fields to strings so a malformed response cannot crash the React renderer', () => {
        // The wire types promise strings but the wire itself doesn't — a
        // non-string rendered as a React child throws inside GraphViewer.
        const issues = validationErrorsToIssues([
            {
                category: 'x',
                message: { unexpected: 'object' },
                pipe_code: 42,
                suggested_fix: { fix_code: 'f', description: ['not', 'a', 'string'] },
            } as any,
        ]);
        expect(typeof issues[0].message).toBe('string');
        expect(typeof issues[0].pipeCode).toBe('string');
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
