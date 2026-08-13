import { describe, it, expect, vi, beforeEach } from 'vitest';

const showWarning = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({ window: { showWarningMessage: showWarning } }));

import {
    ApiCapabilityGate,
    KNOWN_IMPLEMENTATIONS,
    STRUCTURED_VALIDATION_DIAGNOSTICS,
    assessCapability,
    isHostedPipelexApi,
    isKnownImplementation,
    parseCleanRelease,
    readHandshake,
    type CapabilityRequirement,
} from '../validation/apiCapabilityGate';

/**
 * Real `GET /v1/version` bodies, verbatim from each implementation. The hosted
 * one is the shape that regressed: a gate keyed on the bare number read its
 * `0.3.1` (the platform front door's own release line) against a floor derived
 * from pipelex-api's line and warned about a perfectly current server.
 */
const HANDSHAKE = {
    /** api-dev.pipelex.com, 2026-08-13. */
    hosted: {
        protocol_version: '0.1.0',
        implementation: 'pipelex-hosted',
        implementation_version: '0.3.1',
        runtime_version: null,
        extensions: ['runs', 'method_id'],
    },
    /** A bare open-source runner (pipelex-api). */
    bareRunner: {
        protocol_version: '0.1.0',
        runner_version: '0.12.0',
        implementation: 'pipelex-api',
        implementation_version: '0.12.0',
        runtime_version: '0.41.0',
    },
    /** The local runtime implementation. */
    local: {
        protocol_version: '0.1.0',
        implementation: 'pipelex',
        implementation_version: '0.41.0',
        runtime_version: '0.41.0',
    },
} as const;

function clientReturning(body: unknown, onCall?: () => void) {
    return {
        version: vi.fn(async () => {
            onCall?.();
            return body;
        }),
    } as any;
}

/** A bare runner at a given version — the one implementation that carries a floor. */
function bareRunnerAt(implementationVersion: string | undefined) {
    return clientReturning({
        protocol_version: '0.1.0',
        implementation: 'pipelex-api',
        implementation_version: implementationVersion,
    });
}

describe('parseCleanRelease', () => {
    it('parses a clean release', () => {
        expect(parseCleanRelease('0.4.0')).toEqual([0, 4, 0]);
        expect(parseCleanRelease('1.12.3')).toEqual([1, 12, 3]);
    });
    it('returns null (lenient → capable) for prerelease / dev / non-semver / missing', () => {
        expect(parseCleanRelease('0.4.0-dev')).toBeNull();
        expect(parseCleanRelease('latest')).toBeNull();
        expect(parseCleanRelease('0.4')).toBeNull();
        expect(parseCleanRelease(undefined)).toBeNull();
    });
});

describe('readHandshake', () => {
    it('narrows the fields we use out of a real hosted body', () => {
        expect(readHandshake(HANDSHAKE.hosted)).toEqual({
            implementation: 'pipelex-hosted',
            implementationVersion: '0.3.1',
            extensions: ['runs', 'method_id'],
        });
    });

    it('defaults extensions to empty when the implementation does not advertise any', () => {
        expect(readHandshake(HANDSHAKE.bareRunner).extensions).toEqual([]);
    });

    it('drops malformed fields rather than trusting the index signature', () => {
        const handshake = readHandshake({
            implementation: 42,
            implementation_version: { nope: true },
            extensions: ['runs', 7, null],
        });
        expect(handshake.implementation).toBeUndefined();
        expect(handshake.implementationVersion).toBeUndefined();
        expect(handshake.extensions).toEqual(['runs']);
    });

    it('survives a non-object body', () => {
        expect(readHandshake(null).extensions).toEqual([]);
        expect(readHandshake('nope').implementation).toBeUndefined();
    });
});

describe('assessCapability', () => {
    const withFloor: CapabilityRequirement = {
        capability: 'test capability',
        floors: { 'pipelex-api': [0, 4, 0] },
    };

    it('fails a known implementation below its own floor', () => {
        const verdict = assessCapability(withFloor, {
            implementation: 'pipelex-api',
            implementationVersion: '0.3.0',
            extensions: [],
        });
        expect(verdict).toEqual({ capable: false, reason: 'below-floor', floor: [0, 4, 0] });
    });

    it('passes a known implementation at or above its floor', () => {
        expect(assessCapability(withFloor, {
            implementation: 'pipelex-api',
            implementationVersion: '0.4.0',
            extensions: [],
        }).reason).toBe('meets-floor');
    });

    // The regression this whole module exists for: 0.3.1 < 0.4.0 numerically, but
    // the numbers belong to different implementations, so the floor must not apply.
    it('passes the hosted handshake — and does so because no floor is held for it', () => {
        const verdict = assessCapability(withFloor, readHandshake(HANDSHAKE.hosted));
        expect(verdict.capable).toBe(true);
        expect(verdict.reason).toBe('no-floor-for-implementation');
        expect(verdict.floor).toBeUndefined();
    });

    it('passes an implementation it has never heard of', () => {
        expect(assessCapability(withFloor, {
            implementation: 'someone-elses-runner',
            implementationVersion: '0.0.1',
            extensions: [],
        }).reason).toBe('unknown-implementation');
    });

    it('passes when no implementation is reported at all', () => {
        expect(assessCapability(withFloor, { implementationVersion: '0.0.1', extensions: [] }).reason)
            .toBe('no-implementation-reported');
    });

    it('passes a prerelease/dev tag on an implementation that does carry a floor', () => {
        expect(assessCapability(withFloor, {
            implementation: 'pipelex-api',
            implementationVersion: '0.3.0-dev',
            extensions: [],
        }).reason).toBe('version-not-a-clean-release');
    });

    it('lets an advertised extensions token override a version that would otherwise fail', () => {
        const tokened: CapabilityRequirement = { ...withFloor, extension: 'structured_validation' };
        expect(assessCapability(tokened, {
            implementation: 'pipelex-api',
            implementationVersion: '0.1.0',
            extensions: ['structured_validation'],
        }).reason).toBe('extension-advertised');
    });
});

describe('capability requirement declarations', () => {
    it('keys every floor on an implementation the extension knows', () => {
        for (const requirement of [STRUCTURED_VALIDATION_DIAGNOSTICS]) {
            for (const implementation of Object.keys(requirement.floors ?? {})) {
                expect(isKnownImplementation(implementation)).toBe(true);
            }
        }
    });

    // Encodes the lesson, not the symptom: `pipelex-hosted`'s version describes the
    // platform front door, while /validate is served by a runner behind its internal
    // proxy that the handshake never reports on. A floor here would always be a
    // number from the wrong service. Gate the hosted plane with an `extensions`
    // token instead — see the module docstring.
    it('holds no pipelex-hosted floor for a capability served behind the platform proxy', () => {
        expect(STRUCTURED_VALIDATION_DIAGNOSTICS.floors).not.toHaveProperty('pipelex-hosted');
    });

    it('lists the implementations the handshake fixtures actually report', () => {
        for (const body of Object.values(HANDSHAKE)) {
            expect(KNOWN_IMPLEMENTATIONS).toContain(body.implementation);
        }
    });
});

describe('isHostedPipelexApi', () => {
    it('matches every managed environment, not just production', () => {
        expect(isHostedPipelexApi('https://api.pipelex.com')).toBe(true);
        expect(isHostedPipelexApi('https://api.pipelex.com/v1')).toBe(true);
        // Regression: these fell through to the self-hosted branch, which told the
        // user to upgrade a server they do not operate.
        expect(isHostedPipelexApi('https://api-dev.pipelex.com')).toBe(true);
        expect(isHostedPipelexApi('https://api-staging.pipelex.com')).toBe(true);
    });
    it('is false for self-hosted / other hosts and unparseable URLs', () => {
        expect(isHostedPipelexApi('http://localhost:8081')).toBe(false);
        expect(isHostedPipelexApi('https://pipelex.com')).toBe(false);
        expect(isHostedPipelexApi('https://evil-api.pipelex.com.attacker.test')).toBe(false);
        expect(isHostedPipelexApi('https://api-dev.pipelex.com.attacker.test')).toBe(false);
        expect(isHostedPipelexApi('not a url')).toBe(false);
    });
});

describe('ApiCapabilityGate.ensureCapable', () => {
    beforeEach(() => showWarning.mockClear());

    it('stays silent against the real hosted handshake', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(clientReturning(HANDSHAKE.hosted), 'https://api-dev.pipelex.com');
        expect(showWarning).not.toHaveBeenCalled();
    });

    it('stays silent against a current bare runner and the local runtime', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(clientReturning(HANDSHAKE.bareRunner), 'http://localhost:8081');
        await gate.ensureCapable(clientReturning(HANDSHAKE.local), 'http://localhost:9000');
        expect(showWarning).not.toHaveBeenCalled();
    });

    it('warns once for a bare runner below the floor', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(bareRunnerAt('0.3.0'), 'http://localhost:8081');
        expect(showWarning).toHaveBeenCalledTimes(1);
    });

    it('names the implementation in the warning — a bare number is what misled before', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(bareRunnerAt('0.3.0'), 'http://localhost:8081');
        const message = showWarning.mock.calls[0][0] as string;
        expect(message).toContain('pipelex-api 0.3.0');
        expect(message).toContain('structured validation diagnostics');
    });

    it('tells a self-hosted operator to upgrade, and offers the cli fallback', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(bareRunnerAt('0.3.0'), 'http://localhost:8081');
        const message = showWarning.mock.calls[0][0] as string;
        expect(message).toContain('Upgrade the server');
        expect(message).toContain('`pipelex.backend`');
    });

    it('does not tell a hosted-API user to upgrade the server; points at the cli backend', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        // A hosted host reporting the one implementation that does carry a floor —
        // contrived, but it pins the remedy wording to the host, not the identity.
        await gate.ensureCapable(bareRunnerAt('0.3.0'), 'https://api.pipelex.com');
        const message = showWarning.mock.calls[0][0] as string;
        expect(message).not.toContain('Upgrade the server');
        expect(message).toContain('hosted Pipelex API');
        expect(message).toContain('`pipelex.backend`');
    });

    it('logs the verdict and its reason even when the server passes', async () => {
        const appendLine = vi.fn();
        const gate = new ApiCapabilityGate({ appendLine } as any);
        await gate.ensureCapable(clientReturning(HANDSHAKE.hosted), 'https://api-dev.pipelex.com');
        const logged = appendLine.mock.calls.map(call => call[0] as string).join('\n');
        expect(logged).toContain('no-floor-for-implementation');
        expect(logged).toContain('pipelex-hosted');
    });

    it('does not warn for a prerelease/dev tag (lenient)', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        await gate.ensureCapable(bareRunnerAt('0.3.0-dev'), 'http://localhost:8081');
        expect(showWarning).not.toHaveBeenCalled();
    });

    it('probes /version only once per base URL', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const client = clientReturning(HANDSHAKE.bareRunner);
        await gate.ensureCapable(client, 'http://localhost:8081');
        await gate.ensureCapable(client, 'http://localhost:8081');
        expect(client.version).toHaveBeenCalledTimes(1);
    });

    it('probes once and warns once when two saves race the same base URL', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const client = bareRunnerAt('0.3.0');
        // Fire both before either probe resolves: without an in-flight guard both
        // find work pending, both probe, and both show the warning.
        await Promise.all([
            gate.ensureCapable(client, 'http://localhost:8081'),
            gate.ensureCapable(client, 'http://localhost:8081'),
        ]);
        expect(client.version).toHaveBeenCalledTimes(1);
        expect(showWarning).toHaveBeenCalledTimes(1);
    });

    it('does not throw or cache when /version fails (best-effort)', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const failing = { version: vi.fn(async () => { throw new Error('down'); }) } as any;
        await expect(gate.ensureCapable(failing, 'http://localhost:8081')).resolves.toBeUndefined();
        // not cached → a later capable probe still runs
        await gate.ensureCapable(failing, 'http://localhost:8081');
        expect(failing.version).toHaveBeenCalledTimes(2);
    });

    it('still warns (below floor) when given a signal + timeout — the probe resolves first', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const controller = new AbortController();
        await gate.ensureCapable(bareRunnerAt('0.3.0'), 'http://localhost:8081', controller.signal, 30000);
        expect(showWarning).toHaveBeenCalledTimes(1);
    });

    it('abandons the probe when the signal is already aborted (does not await a hung version())', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const hanging = { version: vi.fn(() => new Promise<never>(() => { /* never resolves */ })) } as any;
        const controller = new AbortController();
        controller.abort();
        await expect(
            gate.ensureCapable(hanging, 'http://localhost:8081', controller.signal, 30000)
        ).resolves.toBeUndefined();
        expect(showWarning).not.toHaveBeenCalled();
        // best-effort: not cached → a later (resolving) probe still runs
        const ok = clientReturning(HANDSHAKE.bareRunner);
        await gate.ensureCapable(ok, 'http://localhost:8081');
        expect(ok.version).toHaveBeenCalledTimes(1);
    });

    it('abandons the probe when the signal aborts mid-flight', async () => {
        const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
        const hanging = { version: vi.fn(() => new Promise<never>(() => { /* never resolves */ })) } as any;
        const controller = new AbortController();
        const pending = gate.ensureCapable(hanging, 'http://localhost:8081', controller.signal, 30000);
        controller.abort();
        await expect(pending).resolves.toBeUndefined();
    });

    it('bounds the probe by timeoutMs — a hung /version does not block past the timeout', async () => {
        vi.useFakeTimers();
        try {
            const gate = new ApiCapabilityGate({ appendLine: vi.fn() } as any);
            const hanging = { version: vi.fn(() => new Promise<never>(() => { /* never resolves */ })) } as any;
            const pending = gate.ensureCapable(hanging, 'http://localhost:8081', undefined, 5000);
            await vi.advanceTimersByTimeAsync(5000);
            await expect(pending).resolves.toBeUndefined();
            expect(showWarning).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
