import { describe, it, expect } from 'vitest';
import {
    asSentence,
    problemFacts,
    problemTypeUri,
    readProblemItems,
    readProblemSummary,
    readVerdictErrors,
    UNDESCRIBED_ITEM_DETAIL,
    withNextStep,
} from '../validation/problemItems';

/** An item as pipelex's runner writes it for a TOML syntax error in a sent file. */
const SYNTAX_ITEM = {
    code: 'method.syntax',
    detail: 'The file broken.mthds is not valid TOML.',
    params: { finding: 'TOML syntax error: expected newline' },
    location: { file: 'broken.mthds', line: 1, column: 19 },
};

/** An item as pipelex's runner writes it for a model no catalog knows. */
const MODEL_ITEM = {
    code: 'model.unknown',
    detail: "The method names the llm model 'no-such-model-in-any-deck', which no catalog knows.",
    params: { model: 'no-such-model-in-any-deck', model_type: 'llm' },
    location: { pipe: 'echo', field: 'model', file: 'echo.mthds' },
};

describe('readProblemItems', () => {
    it('reads problem items as written', () => {
        expect(readProblemItems([SYNTAX_ITEM, MODEL_ITEM])).toEqual([SYNTAX_ITEM, MODEL_ITEM]);
    });

    it('reads a suggested fix, whose edited file is `file`', () => {
        const [item] = readProblemItems([{
            code: 'method.concept_unresolved',
            detail: 'Unknown concept Foo.',
            suggested_fix: { fix_code: 'declare-concept', description: 'Declare [concept.Foo].', safety: 'safe', file: 'a.mthds', ops: [] },
        }]);
        expect(item.suggested_fix).toEqual({
            fix_code: 'declare-concept',
            description: 'Declare [concept.Foo].',
            safety: 'safe',
            file: 'a.mthds',
            ops: [],
        });
    });

    it('drops elements that are not items, and reads a non-list as no items', () => {
        expect(readProblemItems([null, 'text', 42, [], { code: 'method.invalid' }, { detail: '' }])).toEqual([]);
        expect(readProblemItems(undefined)).toEqual([]);
        expect(readProblemItems({ detail: 'not a list' })).toEqual([]);
    });

    it('reads a member of the wrong type as absent', () => {
        const [item] = readProblemItems([{
            code: 7,
            detail: 'Something is wrong.',
            params: ['not', 'a', 'map'],
            location: { pipe: 3, file: 'a.mthds', line: '2', column: 0 },
            suggested_fix: { fix_code: 'f' },
        }]);
        expect(item).toEqual({ detail: 'Something is wrong.', location: { file: 'a.mthds' } });
    });

    it('reads the validation item problem items replace into the same members, keeping its domain and error type', () => {
        const [item] = readProblemItems([{
            category: 'pipe_validation',
            error_type: 'missing_concept',
            message: 'Pipe x references an unknown concept.',
            pipe_code: 'x',
            domain_code: 'demo',
            source: '/project/methods/main.mthds',
            field_path: 'pipe.x.output',
            field_name: 'output',
            missing_concept_code: 'Foo',
            suggested_fix: { fix_code: 'declare-concept', description: 'Declare it.', safety: 'safe', source: 'main.mthds', ops: [] },
        }]);
        expect(item).toEqual({
            detail: 'Pipe x references an unknown concept.',
            params: { concept: 'Foo', field_path: 'pipe.x.output' },
            location: { pipe: 'x', field: 'output', file: '/project/methods/main.mthds' },
            suggested_fix: { fix_code: 'declare-concept', description: 'Declare it.', safety: 'safe', file: 'main.mthds', ops: [] },
            legacy: { domainCode: 'demo', errorType: 'missing_concept' },
        });
        expect(item.code).toBeUndefined();
    });

    it('keeps no legacy facts on a problem item, nor on a validation item naming neither', () => {
        const [problem, validation] = readProblemItems([
            { ...MODEL_ITEM, domain_code: 'demo', error_type: 'unknown_model' },
            { category: 'pipe_validation', message: 'Pipe x is broken.', pipe_code: 'x' },
        ]);
        expect(problem.legacy).toBeUndefined();
        expect(validation.legacy).toBeUndefined();
    });

    it('keeps a validation item whose message is empty or missing, with a neutral sentence', () => {
        const items = readProblemItems([
            { category: 'pipe_validation', error_type: 'missing_input', message: '', pipe_code: 'x' },
            { category: 'dry_run' },
        ]);
        expect(items).toEqual([
            { detail: UNDESCRIBED_ITEM_DETAIL, location: { pipe: 'x' }, legacy: { errorType: 'missing_input' } },
            { detail: UNDESCRIBED_ITEM_DETAIL },
        ]);
    });

    it('reads a list mixing both shapes element by element', () => {
        const items = readProblemItems([MODEL_ITEM, { category: 'dry_run', message: 'Dry run failed.' }]);
        expect(items.map(item => [item.code, item.detail])).toEqual([
            ['model.unknown', MODEL_ITEM.detail],
            [undefined, 'Dry run failed.'],
        ]);
    });
});

describe('readVerdictErrors', () => {
    it("reads the verdict's `errors`", () => {
        expect(readVerdictErrors({ is_valid: false, errors: [MODEL_ITEM] })).toEqual([MODEL_ITEM]);
    });

    it('reads `validation_errors` from a validator that still writes them', () => {
        const errors = readVerdictErrors({ is_valid: false, validation_errors: [{ category: 'x', message: 'old shape' }] });
        expect(errors).toEqual([{ detail: 'old shape' }]);
    });

    it('is empty when neither list holds a readable item', () => {
        expect(readVerdictErrors({ is_valid: false, errors: [] })).toEqual([]);
        expect(readVerdictErrors({ is_valid: false })).toEqual([]);
    });
});

describe('readProblemSummary', () => {
    it('reads the code, the detail, the next step and the request id', () => {
        expect(readProblemSummary({
            type: 'https://mthds.ai/errors/request.malformed',
            title: 'The request body cannot be parsed',
            status: 422,
            code: 'request.malformed',
            domain: 'input',
            retry: 'no',
            detail: 'The runner cannot parse the request body (reason: not_json).',
            next_step: { kind: 'change_input', detail: 'Fix the body so that it parses, then send the request again.' },
            request_id: 'req_1',
        })).toEqual({
            code: 'request.malformed',
            detail: 'The runner cannot parse the request body (reason: not_json).',
            nextStep: 'Fix the body so that it parses, then send the request again.',
            requestId: 'req_1',
        });
    });

    it('is undefined for a body that is not a problem document', () => {
        expect(readProblemSummary(undefined)).toBeUndefined();
        expect(readProblemSummary('text')).toBeUndefined();
        expect(readProblemSummary({ error: true, message: 'the envelope problems replace' })).toBeUndefined();
    });
});

describe('problemTypeUri', () => {
    it('joins a core code to the core base URL, and a Pipelex code to its own', () => {
        expect(problemTypeUri('method.syntax')).toBe('https://mthds.ai/errors/method.syntax');
        expect(problemTypeUri('pipelex.config.invalid')).toBe('https://docs.pipelex.com/errors/pipelex.config.invalid');
    });

    it("reads a prefix naming a member every object inherits as a core code's", () => {
        for (const prefix of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
            expect(problemTypeUri(`${prefix}.x`)).toBe(`https://mthds.ai/errors/${prefix}.x`);
        }
    });
});

describe('problemFacts', () => {
    it('names the code and the request id that are known, or nothing', () => {
        expect(problemFacts('request.malformed', 'req_1')).toBe(' (code request.malformed, request req_1)');
        expect(problemFacts('request.malformed', undefined)).toBe(' (code request.malformed)');
        expect(problemFacts(undefined, 'req_1')).toBe(' (request req_1)');
        expect(problemFacts(undefined, undefined)).toBe('');
    });
});

describe('withNextStep', () => {
    it('adds the next step after the sentence', () => {
        expect(withNextStep('Something failed', 'Do this.')).toBe('Something failed. Next step: Do this.');
        expect(withNextStep('Something failed.', 'Do this.')).toBe('Something failed. Next step: Do this.');
    });

    it('leaves the sentence alone without a next step', () => {
        expect(withNextStep('Something failed', undefined)).toBe('Something failed');
    });

    it('closes a sentence only when it is open', () => {
        expect(asSentence('Done')).toBe('Done.');
        expect(asSentence('Done?')).toBe('Done?');
    });
});
