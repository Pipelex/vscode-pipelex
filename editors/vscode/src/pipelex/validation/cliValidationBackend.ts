import * as path from 'path';
import { resolveCli } from './cliResolver';
import { spawnCli } from './processUtils';
import { extractJson } from './cliOutput';
import { getAgentCliVersion, compareSemver, formatSemver, MIN_AGENT_VERSION } from './agentCliVersion';
import { AnalyzeAbortError, BackendError } from './backend';
import type { AnalyzeOptions, BundleAnalysis, BundleRequest, ValidationBackend } from './backend';
import type { ValidationErrorItem, ValidationFailure } from './types';

/**
 * CLI backend — spawns `pipelex-agent validate bundle`.
 *
 * A single spawn per `analyze()` serves both channels via the exit code (Part B
 * of the upstream plan was deferred — the one `--view` spawn already returns
 * graph-on-success or errors-on-failure):
 *
 * - `withGraph:false` → `validate bundle … --allow-signatures --format json`.
 *   exit 0 → valid; exit 1 → parse `validation_errors` from stderr JSON.
 * - `withGraph:true`  → adds `--view --direction <dir>`. exit 0 → parse the
 *   `graphspec` from stdout JSON; exit 1 → errors + `graph:null`.
 *
 * `--format json` makes both streams machine-readable (the agent CLI otherwise
 * defaults error output to markdown).
 */
export class CliValidationBackend implements ValidationBackend {
    readonly kind = 'cli' as const;

    async analyze(request: BundleRequest, options: AnalyzeOptions, signal: AbortSignal): Promise<BundleAnalysis> {
        const resolved = resolveCli(request.primaryUri);
        if (!resolved) {
            throw new BackendError({
                kind: 'not-found',
                logMessage: 'could not resolve pipelex-agent',
                userMessage:
                    'Pipelex validation: could not find pipelex-agent. ' +
                    'Install it or set pipelex.validation.agentCliPath in settings.',
            });
        }

        const primaryPath = request.primaryUri.fsPath;
        const dir = path.dirname(primaryPath);
        const args = [
            ...resolved.args,
            'validate', 'bundle', primaryPath,
            '--library-dir', dir,
            '--allow-signatures',
        ];
        if (options.withGraph) {
            args.push('--view');
            if (options.direction) {
                args.push('--direction', options.direction);
            }
        }
        args.push('--format', 'json');

        try {
            const { stdout } = await spawnCli(resolved.command, args, request.timeout, signal, request.cwd);
            // exit 0 → valid bundle.
            if (options.withGraph) {
                const graph = this.parseGraphspec(stdout);
                return { validation: { ok: true, errors: [] }, graph };
            }
            return { validation: { ok: true, errors: [] } };
        } catch (err: any) {
            if (signal.aborted) {
                throw new AnalyzeAbortError();
            }
            return await this.handleSpawnError(err, resolved, request, options, signal);
        }
    }

    private parseGraphspec(stdout: string): unknown {
        const json = extractJson(stdout);
        if (!json) {
            return null;
        }
        try {
            const result = JSON.parse(json);
            return result?.graphspec ?? null;
        } catch {
            return null;
        }
    }

    private async handleSpawnError(
        err: any,
        resolved: { command: string; args: string[] },
        request: BundleRequest,
        options: AnalyzeOptions,
        signal: AbortSignal,
    ): Promise<BundleAnalysis> {
        if (err.exitCode === 1 && typeof err.stderr === 'string') {
            const json = extractJson(err.stderr);
            if (json) {
                const outcome = this.parseFailure(json);
                if (outcome) {
                    return options.withGraph ? { validation: outcome, graph: null } : { validation: outcome };
                }
            }
            // exit 1 but the stderr is not a parseable validation failure — could be an
            // outdated CLI (argparse error on an unknown flag). Probe the version.
            await this.throwIfTooOld(resolved, request, signal);
            throw new BackendError({
                kind: 'infra',
                logMessage: `pipelex-agent: ${err.stderr.slice(0, 500)}`,
            });
        }

        // Non-exit-1 failure (spawn error, timeout, …). Check for an outdated CLI first.
        await this.throwIfTooOld(resolved, request, signal);
        throw new BackendError({
            kind: 'infra',
            logMessage: `pipelex-agent error: ${err.message ?? err}`,
        });
    }

    /**
     * Parse the exit-1 stderr JSON into a validation outcome.
     * Returns `undefined` when it is an infrastructural error (not a bundle problem),
     * so the caller can surface it as a {@link BackendError} instead.
     */
    private parseFailure(json: string): { ok: false; errors: ValidationErrorItem[] } | undefined {
        let failure: ValidationFailure & { error_domain?: string };
        try {
            failure = JSON.parse(json);
        } catch {
            return undefined;
        }

        const errors = failure.validation_errors;
        if (Array.isArray(errors) && errors.length > 0) {
            return { ok: false, errors };
        }

        // A bundle validation failure with no structured list (e.g. a top-level
        // interpreter error). Surface the message as a single diagnostic on the
        // primary file rather than dropping it silently. Infra errors
        // (config/runtime domain) fall through to a BackendError.
        if (failure.error_domain === 'input' && failure.message) {
            return {
                ok: false,
                errors: [{
                    category: 'blueprint_validation',
                    message: failure.message,
                    error_type: failure.error_type,
                }],
            };
        }

        return undefined;
    }

    private async throwIfTooOld(
        resolved: { command: string; args: string[] },
        request: BundleRequest,
        signal: AbortSignal,
    ): Promise<void> {
        const installed = await getAgentCliVersion(resolved.command, resolved.args, request.cwd);
        if (signal.aborted) {
            throw new AnalyzeAbortError();
        }
        if (installed && compareSemver(installed, MIN_AGENT_VERSION) < 0) {
            throw new BackendError({
                kind: 'too-old',
                installedVersion: formatSemver(installed),
                minVersion: formatSemver(MIN_AGENT_VERSION),
                logMessage:
                    `pipelex-agent ${formatSemver(installed)} is too old ` +
                    `(needs ≥ ${formatSemver(MIN_AGENT_VERSION)}).`,
            });
        }
    }
}
