import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { resolveApiToken } from '../validation/apiKey';

function secretsWith(stored: string | undefined) {
    return { get: vi.fn(async () => stored) } as any;
}

describe('resolveApiToken — SecretStorage, then PIPELEX_API_KEY', () => {
    it('prefers the stored key over the environment', async () => {
        expect(await resolveApiToken(secretsWith('plx_sk_stored'), { PIPELEX_API_KEY: 'plx_sk_env' })).toBe('plx_sk_stored');
    });

    it('falls back to PIPELEX_API_KEY when no key is stored', async () => {
        expect(await resolveApiToken(secretsWith(undefined), { PIPELEX_API_KEY: 'plx_sk_env' })).toBe('plx_sk_env');
        expect(await resolveApiToken(secretsWith(''), { PIPELEX_API_KEY: 'plx_sk_env' })).toBe('plx_sk_env');
    });

    it('trims the environment value', async () => {
        expect(await resolveApiToken(secretsWith(undefined), { PIPELEX_API_KEY: '  plx_sk_env\n' })).toBe('plx_sk_env');
    });

    // `undefined` is how the API backend knows to say where to get a key.
    it('answers undefined when neither source has a key', async () => {
        expect(await resolveApiToken(secretsWith(undefined), {})).toBeUndefined();
        expect(await resolveApiToken(secretsWith(undefined), { PIPELEX_API_KEY: '   ' })).toBeUndefined();
    });

    it('reads process.env by default', async () => {
        vi.stubEnv('PIPELEX_API_KEY', 'plx_sk_process');
        try {
            expect(await resolveApiToken(secretsWith(undefined))).toBe('plx_sk_process');
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
