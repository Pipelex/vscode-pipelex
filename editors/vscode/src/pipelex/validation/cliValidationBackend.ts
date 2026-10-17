import * as path from 'path';
import { resolveCli } from './cliResolver';
import { spawnCli } from './processUtils';
import { extractJson } from './cliOutput';
import { getAgentCliVersion, compareSemver, formatSemver, MIN_AGENT_VERSION } from './agentCliVersion';
import { AnalyzeAbortError, BackendError } from './backend';
import type { AnalyzeOptions, BundleAnalysis, BundleRequest, ValidationBackend, ValidationOutcome } from './backend';
import { isRecord, problemFacts, readProblemItems, readProblemSummary, readVerdictErrors, withNextStep } from './problemItems';

/**
 * CLI backend — spawns `pipelex-agent validate bundle`.
 *
 * A single spawn per `analyze()` serves both channels via the exit code (Part B
 * of the upstream plan was deferred — the one `--view` spawn already returns
 * graph-on-success or errors-on-failure):
 *
 * - `withGraph:false` → `validate bundle … --allow-signatures --format json`.
 *   exit 0 → valid, its advisory `warnings` read from stdout JSON; exit 1 →
 *   the invalid verdict read from the problem on stderr.
 * - `withGraph:true`  → adds `--view --direction <dir>`. exit 0 → parse the
 *   `graphspec` from stdout JSON; exit 1 → errors + `graph:null`.
 *
 * `--format json` makes both streams machine-readable (the agent CLI otherwise
 * defaults error output to markdown).
 *
 * `pipelex-agent` reports every failure as a problem document on stderr. The
 * invalid verdict is the `method.invalid` problem with `is_valid: false`, its
 * faults the problem items of its `errors[]`. Any other problem means no
 * verdict was produced (a configuration the runtime cannot boot with, an
 * unreadable bundle, …), and it surfaces as a {@link BackendError} whose
 * message is the problem's detail and next step. A CLI older than the pipelex
 * release that writes problems reports the verdict as `validation_errors[]`,
 * which is read into the same items (`problemItems.ts`).
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

        // Enforce the version floor BEFORE trusting the CLI's output. The structured
        // `source` / `field_name` fields cross-file diagnostics rely on only exist from
        // MIN_AGENT_VERSION; a CLI in [0.31.0, 0.34.0) still exits 0 / emits a structured
        // error list, just without those fields. Checking only on a spawn failure (the
        // earlier behavior) let such a CLI through silently, degrading cross-file mapping
        // with no "too old" warning. The version probe is cached per command, so only the
        // first analysis of a session pays for it.
        await this.throwIfTooOld(resolved, request, signal);

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
            const validation: ValidationOutcome = { ok: true, errors: [], warnings: this.parseWarnings(stdout) };
            if (options.withGraph) {
                const graph = this.parseGraphspec(stdout);
                return { validation, graph };
            }
            return { validation };
        } catch (err: any) {
            if (signal.aborted) {
                throw new AnalyzeAbortError();
            }
            return this.handleSpawnError(err, options);
        }
    }

    /** The advisory findings of a valid verdict, from its stdout JSON; none when it cannot be read. */
    private parseWarnings(stdout: string): ValidationOutcome['warnings'] {
        const json = extractJson(stdout);
        if (!json) {
            return [];
        }
        try {
            return readProblemItems(JSON.parse(json)?.warnings);
        } catch {
            return [];
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

    /**
     * Map a non-zero CLI exit to a validation outcome or a {@link BackendError}.
     * The version floor is enforced up front in {@link analyze}, so a too-old CLI
     * (including one that argparse-errors on an unknown flag) never reaches here.
     */
    private handleSpawnError(err: any, options: AnalyzeOptions): BundleAnalysis {
        const stderr = typeof err.stderr === 'string' ? err.stderr : undefined;
        const json = stderr !== undefined ? extractJson(stderr) : null;
        const body = json ? parseObject(json) : undefined;

        if (err.exitCode === 1 && body) {
            const outcome = this.parseFailure(body);
            if (outcome) {
                return options.withGraph ? { validation: outcome, graph: null } : { validation: outcome };
            }
        }

        // No verdict. When the CLI said why as a problem document, its detail and
        // next step are what the user is shown, and the log line carries its code
        // and its request id when it has one, as the API path's does.
        const problem = readProblemSummary(body);
        if (problem?.detail) {
            throw new BackendError({
                kind: 'infra',
                logMessage: `pipelex-agent: ${problem.detail}${problemFacts(problem.code, problem.requestId)}`,
                userMessage: withNextStep(`pipelex-agent could not validate this method: ${problem.detail}`, problem.nextStep),
            });
        }

        if (stderr !== undefined && err.exitCode === 1) {
            // exit 1 but the stderr is neither a verdict nor a problem.
            throw new BackendError({
                kind: 'infra',
                logMessage: `pipelex-agent: ${stderr.slice(0, 500)}`,
            });
        }

        // Any other failure (spawn error, timeout, …).
        throw new BackendError({
            kind: 'infra',
            logMessage: `pipelex-agent error: ${err.message ?? err}`,
        });
    }

    /**
     * Read the exit-1 stderr problem as an invalid verdict. Returns `undefined`
     * when it is not one (a problem that produced no verdict), so the caller can
     * surface it as a {@link BackendError} instead.
     *
     * The runtime's structured-info invariant is total: every invalid verdict
     * carries a non-empty `errors[]` (a parse-level failure yields one located
     * syntax item; a dry-run failure one item per failed pipe). So the list is
     * consumed directly — no synthesis here. A CLI that still writes the shape
     * problem items replace reports the verdict as a non-empty
     * `validation_errors[]`, read into the same items. A problem with no item is
     * therefore NOT a bundle verdict.
     */
    private parseFailure(body: Record<string, unknown>): ValidationOutcome | undefined {
        if (body.is_valid === false || body.validation_errors !== undefined) {
            const errors = readVerdictErrors(body);
            if (errors.length > 0) {
                return { ok: false, errors };
            }
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

/** The JSON object a text holds, or undefined when it holds none. */
function parseObject(json: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(json);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}
