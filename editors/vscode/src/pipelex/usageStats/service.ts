/**
 * The extension's anonymous usage statistics (conformance's
 * `specs/usage-statistics.md`): `extension_activated` at most once per UTC day, and
 * `feature_used` counts of the graph preview, validation, runs and formatting,
 * aggregated in memory and sent every few minutes and at deactivation.
 *
 * Every event goes through a `vscode.env.createTelemetryLogger` logger, so VS Code's
 * own telemetry setting, its enterprise policy included, governs it on top of the
 * shared switches; the logger hands the event back to this service's sender, which
 * posts it to PostHog. The switches, the notice marker, the identifier and the spool
 * live in the shared state directory, `~/.mthds/usage-stats/`, which `plxt`,
 * pipelex and the `mthds` CLI read and write too.
 *
 * Node only: the extension loads it with a dynamic import outside the browser host.
 */

import * as os from 'os';
import * as vscode from 'vscode';
import * as contract from './contract';
import type { Feature, OffBy } from './contract';
import * as detect from './detect';
import { beforePost, drainSpool, keepCurrent, post } from './delivery';
import type { FetchLike } from './delivery';
import * as events from './events';
import type { Envelope } from './events';
import { setFeatureSink } from './recorder';
import { Spool } from './spool';
import { StateDir, legacyConfigOf, randomUuidV4, stateDirOf } from './state';
import type { Identity } from './state';
import { endpointOf, flagIsOn, readSwitches, runLegacyMigration } from './switches';
import type { UsageContext } from './switches';

/** The global-state key holding the UTC day of the last `extension_activated`. */
export const LAST_ACTIVATED_DAY_KEY = 'pipelex.usageStats.lastActivatedDay';
/** How often the feature counts are sent. */
export const FEATURE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** How long after an event is made it is posted, well inside the ten-second budget. */
export const POST_DELAY_MS = 2000;
/** The most events kept in memory waiting for a retry; older ones are spooled. */
const MAX_PENDING = 500;

export const COMMAND_STATUS = 'pipelex.usageStats.status';
export const COMMAND_DISABLE = 'pipelex.usageStats.disable';
export const COMMAND_ENABLE = 'pipelex.usageStats.enable';
export const COMMAND_RESET_ID = 'pipelex.usageStats.resetId';

const NOTICE_DISABLE = 'Disable';
const NOTICE_DETAILS = 'Details';

/** What the service reads from its host; the tests replace it. */
export interface UsageStatsHost {
    env: Record<string, string | undefined>;
    home: string | undefined;
    fetch?: FetchLike;
}

function defaultHost(): UsageStatsHost {
    let home: string | undefined;
    try {
        home = os.homedir() || undefined;
    } catch {
        home = undefined;
    }
    return { env: process.env, home };
}

export interface StatusReport {
    tool: string;
    enabled: boolean;
    off_by: OffBy[];
    installation_id: string | null;
    notice_version: number;
    internal: boolean;
    ci: boolean;
    container: boolean;
    state_dir: string | null;
}

export class UsageStatsService implements vscode.Disposable {
    private readonly state: StateDir | undefined;
    private readonly logger: vscode.TelemetryLogger;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly removeSink: () => void;
    private readonly toolVersion: string | undefined;
    private readonly editor: events.EditorFacts | undefined;
    private readonly debug: boolean;
    private readonly createdIds = new Set<string>();
    private readonly made = new Map<string, Envelope>();
    private counts = new Map<Feature, number>();
    private pending: Envelope[] = [];
    private localIdentity: Identity | undefined;
    private on = false;
    private postTimer: ReturnType<typeof setTimeout> | undefined;
    private flushTimer: ReturnType<typeof setInterval> | undefined;
    private posting: Promise<void> | undefined;
    private stopped = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly host: UsageStatsHost = defaultHost(),
    ) {
        this.state = host.home ? new StateDir(stateDirOf(host.home)) : undefined;
        this.debug = flagIsOn(host.env, contract.ENV_DEBUG);
        this.toolVersion = detect.releaseVersion(String(context.extension?.packageJSON?.version ?? ''));
        const editorVersion = detect.releaseVersion(vscode.version);
        this.editor = editorVersion === undefined
            ? undefined
            : { editor: detect.editorOf(vscode.env.appName ?? ''), editorVersion };

        this.logger = vscode.env.createTelemetryLogger(
            {
                sendEventData: (_eventName, data) => this.accept(data),
                sendErrorData: () => {
                    // The extension sends no error events.
                },
            },
            { ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true },
        );
        this.removeSink = setFeatureSink(feature => this.countFeature(feature));

        this.disposables.push(
            vscode.commands.registerCommand(COMMAND_STATUS, () => this.showStatus()),
            vscode.commands.registerCommand(COMMAND_DISABLE, () => this.disable()),
            vscode.commands.registerCommand(COMMAND_ENABLE, () => this.enable()),
            vscode.commands.registerCommand(COMMAND_RESET_ID, () => this.resetId()),
            vscode.env.onDidChangeTelemetryEnabled(() => this.refresh()),
            this.logger.onDidChangeEnableStates(() => this.refresh()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
        );
    }

    /** Read the switches, show the notice when due, send the day's `extension_activated`,
     * and start the feature timer and the spool drain. */
    start(): void {
        if (this.state) {
            try {
                runLegacyMigration(this.usageContext(), this.state);
            } catch {
                // Retried before every post.
            }
        }
        this.refresh();
        this.flushTimer = setInterval(() => this.flushFeatures(), FEATURE_FLUSH_INTERVAL_MS);
        if (this.on && !this.debug) this.schedulePost();
    }

    private usageContext(): UsageContext {
        const folders = (vscode.workspace.workspaceFolders ?? [])
            .filter(folder => folder.uri.scheme === 'file')
            .map(folder => folder.uri.fsPath);
        return { env: this.host.env, home: this.host.home, folders };
    }

    private editorEnabled(): boolean {
        return vscode.env.isTelemetryEnabled && this.logger.isUsageEnabled;
    }

    /** Every switch that says off, the editor's setting included. */
    offBy(): OffBy[] {
        return readSwitches(this.usageContext(), this.state, this.editorEnabled());
    }

    /** Re-read the switches. Turning off drops what is held; turning on shows the
     * notice when this machine has not seen it and sends the day's activation. */
    refresh(): void {
        if (this.stopped) return;
        const wasOn = this.on;
        this.on = this.state !== undefined && this.toolVersion !== undefined && this.editor !== undefined
            && this.offBy().length === 0;
        if (!this.on) {
            this.counts.clear();
            this.pending = [];
            return;
        }
        if (!wasOn) {
            this.showNoticeIfDue();
            this.sendActivationIfDue();
        }
    }

    private showNoticeIfDue(): void {
        const state = this.state;
        if (!state || state.hasNotice()) return;
        try {
            state.recordNotice();
        } catch {
            // Unrecorded, it is shown again next time rather than not at all.
        }
        void Promise.resolve(
            vscode.window.showInformationMessage(contract.noticeText(), NOTICE_DISABLE, NOTICE_DETAILS),
        ).then(choice => {
            if (choice === NOTICE_DISABLE) {
                void vscode.commands.executeCommand(COMMAND_DISABLE);
            } else if (choice === NOTICE_DETAILS) {
                void vscode.env.openExternal(vscode.Uri.parse(contract.NOTICE_DETAILS_URL));
            }
        }, () => undefined);
    }

    private sendActivationIfDue(): void {
        const today = events.utcDay();
        if (this.context.globalState.get<string>(LAST_ACTIVATED_DAY_KEY) === today) return;
        const envelope = this.build(identity => events.extensionActivated(
            identity.id, randomUuidV4(), this.common(identity), this.editor!,
        ));
        if (!envelope) return;
        this.emit(envelope);
        void this.context.globalState.update(LAST_ACTIVATED_DAY_KEY, today);
    }

    /** Count one use of a feature, while statistics are on. */
    countFeature(feature: Feature): void {
        if (!this.on || this.stopped) return;
        const count = this.counts.get(feature) ?? 0;
        if (count < contract.MAX_FEATURE_COUNT) this.counts.set(feature, count + 1);
    }

    /** Send one `feature_used` per feature used since the last flush. */
    flushFeatures(): void {
        if (this.counts.size === 0) return;
        this.refresh();
        if (!this.on) return;
        const counts = this.counts;
        this.counts = new Map();
        for (const [feature, count] of counts) {
            const envelope = this.build(identity => events.featureUsed(
                identity.id, randomUuidV4(), this.common(identity), this.editor!, feature, count,
            ));
            if (envelope) this.emit(envelope);
        }
    }

    /** The identifier to report under, re-read for every event so that a `reset-id`
     * run by another tool takes effect at once. */
    private identity(): Identity | undefined {
        const state = this.state;
        if (!state) return undefined;
        const identity = state.obtainIdentity();
        if (identity.persisted) {
            this.localIdentity = undefined;
            if (identity.created) this.createdIds.add(identity.id);
            return { ...identity, created: this.createdIds.has(identity.id) };
        }
        // Drawn for this process alone: keep one for the whole session.
        this.localIdentity ??= identity;
        return this.localIdentity;
    }

    private common(identity: Identity): events.Common {
        const state = this.state!;
        return {
            toolVersion: this.toolVersion!,
            idNew: identity.created,
            os: detect.osOf(),
            arch: detect.archOf(),
            languageRuntime: detect.languageRuntime(),
            ci: detect.isCi(this.host.env),
            container: detect.isContainer(this.host.env),
            internal: state.isInternal(),
            noticeVersion: state.noticeVersion(),
        };
    }

    private build(make: (identity: Identity) => Envelope): Envelope | undefined {
        const identity = this.identity();
        if (!identity) return undefined;
        return make(identity);
    }

    /** Hand an event to the telemetry logger, which calls the sender back only when
     * VS Code's setting allows usage telemetry. */
    private emit(envelope: Envelope): void {
        this.made.set(envelope.uuid, envelope);
        // An event the logger declines never comes back: keep only the latest few.
        for (const uuid of this.made.keys()) {
            if (this.made.size <= MAX_PENDING) break;
            this.made.delete(uuid);
        }
        this.logger.logUsage(envelope.event, { envelope: new vscode.TelemetryTrustedValue(envelope) });
    }

    /** The logger's sender: post exactly the envelope this service made. */
    private accept(data: Record<string, unknown> | undefined): void {
        const received = data?.envelope as Partial<Envelope> | undefined;
        const envelope = typeof received?.uuid === 'string' ? this.made.get(received.uuid) : undefined;
        if (!envelope) return;
        this.made.delete(envelope.uuid);
        if (!this.on) return;
        if (this.debug) {
            this.output.appendLine(JSON.stringify({ usage_stats_debug: envelope }));
            return;
        }
        this.pending.push(envelope);
        if (this.pending.length > MAX_PENDING) this.spool(this.pending.splice(0, this.pending.length - MAX_PENDING));
        this.schedulePost();
    }

    private schedulePost(delay: number = POST_DELAY_MS): void {
        if (this.postTimer || this.stopped) return;
        this.postTimer = setTimeout(() => {
            this.postTimer = undefined;
            void this.postNow(contract.BUDGET_BACKGROUND_POST_DELAY_MS, true);
        }, delay);
    }

    /** Post what is held, then the spool, within `budgetMs`. */
    async postNow(budgetMs: number, drain: boolean): Promise<void> {
        if (this.posting) await this.posting;
        const run = this.postWithin(Date.now() + budgetMs, drain);
        this.posting = run;
        try {
            await run;
        } finally {
            if (this.posting === run) this.posting = undefined;
        }
    }

    private async postWithin(deadline: number, drain: boolean): Promise<void> {
        const state = this.state;
        if (!state || this.debug) return;
        const context = this.usageContext();
        const endpoint = endpointOf(context.env);
        const batch = this.pending.splice(0);
        if (batch.length > 0) {
            this.refresh();
            if (!this.on) return;
            const check = beforePost(context, state, this.localIdentity?.id);
            if (check.kind === 'disabled') {
                this.refresh();
                return;
            }
            const current = keepCurrent(batch, check.id);
            if (current.length > 0) {
                const outcome = await post(endpoint, current, deadline - Date.now(), this.host.fetch);
                if (outcome === 'failed') {
                    // Kept for the next post, or spooled at deactivation.
                    this.pending.unshift(...current);
                }
            }
        }
        if (drain && this.on && Date.now() < deadline) {
            await drainSpool(context, state, endpoint, deadline, this.host.fetch);
        }
    }

    private spool(unsent: Envelope[]): void {
        const state = this.state;
        if (!state || unsent.length === 0 || this.localIdentity) return;
        try {
            new Spool(state.toolSpool()).write(unsent);
        } catch {
            // A read-only filesystem loses them.
        }
    }

    /** Deactivation: send the feature counts and what is held within two seconds, and
     * spool the rest. */
    async shutdown(): Promise<void> {
        if (this.stopped) return;
        this.flushFeatures();
        if (this.postTimer) {
            clearTimeout(this.postTimer);
            this.postTimer = undefined;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
        if (this.on && this.pending.length > 0) {
            const flushed = this.postNow(contract.BUDGET_SHUTDOWN_FLUSH_MS, false);
            const timeout = new Promise<void>(resolve => setTimeout(resolve, contract.BUDGET_SHUTDOWN_FLUSH_MS + 200));
            await Promise.race([flushed, timeout]);
        }
        this.spool(this.pending.splice(0));
        this.stopped = true;
        this.dispose();
    }

    dispose(): void {
        this.stopped = true;
        if (this.postTimer) clearTimeout(this.postTimer);
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.postTimer = undefined;
        this.flushTimer = undefined;
        this.removeSink();
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
        this.logger.dispose();
    }

    // ── The palette commands ────────────────────────────────────────────────

    status(): StatusReport {
        const offBy = this.offBy();
        const reading = this.state?.readId();
        return {
            tool: contract.TOOL,
            enabled: offBy.length === 0 && this.state !== undefined,
            off_by: offBy,
            installation_id: reading?.kind === 'valid' ? reading.id : null,
            notice_version: this.state?.noticeVersion() ?? 0,
            internal: this.state?.isInternal() ?? false,
            ci: detect.isCi(this.host.env),
            container: detect.isContainer(this.host.env),
            state_dir: this.state?.root ?? null,
        };
    }

    private showStatus(): void {
        const report = this.status();
        this.output.appendLine(`Pipelex usage statistics: ${JSON.stringify(report)}`);
        const summary = report.enabled
            ? 'Pipelex usage statistics are on.'
            : `Pipelex usage statistics are off (${report.off_by.join(', ') || 'no shared state'}).`;
        void vscode.window.showInformationMessage(`${summary} The Pipelex output channel has the details.`);
    }

    private disable(): void {
        const state = this.state;
        if (!state) return;
        try {
            state.createDisabled();
            state.deleteEverySpool();
        } catch (err) {
            void vscode.window.showErrorMessage(`Pipelex: could not turn usage statistics off: ${(err as Error).message}`);
            return;
        }
        this.refresh();
        void vscode.window.showInformationMessage(
            'Pipelex usage statistics are off on this machine, for every Pipelex tool and the mthds CLI.',
        );
    }

    private enable(): void {
        const state = this.state;
        if (!state) return;
        try {
            state.deleteDisabled();
            state.markLegacyMigrated(this.host.home ? legacyConfigOf(this.host.home) : undefined);
        } catch (err) {
            void vscode.window.showErrorMessage(`Pipelex: could not turn usage statistics on: ${(err as Error).message}`);
            return;
        }
        this.refresh();
        const stillOff = this.offBy();
        void vscode.window.showInformationMessage(stillOff.length === 0
            ? 'Pipelex usage statistics are on.'
            : `The machine choice is on, but Pipelex usage statistics stay off: ${stillOff.join(', ')}.`);
    }

    private resetId(): void {
        const state = this.state;
        if (!state) return;
        let identity: Identity;
        try {
            state.deleteEverySpool();
            state.deleteId();
            identity = state.createId();
        } catch (err) {
            void vscode.window.showErrorMessage(`Pipelex: could not reset the usage statistics identifier: ${(err as Error).message}`);
            return;
        }
        this.pending = [];
        if (identity.created) this.createdIds.add(identity.id);
        void vscode.window.showInformationMessage(`Pipelex usage statistics identifier: ${identity.id}`);
    }
}

/** Start the statistics of this extension host. Never throws: statistics never
 * stand in the way of the extension. */
export function startUsageStats(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    host?: UsageStatsHost,
): UsageStatsService | undefined {
    try {
        const service = new UsageStatsService(context, output, host);
        service.start();
        return service;
    } catch (err) {
        output.appendLine(`Pipelex: usage statistics could not start: ${(err as Error).message ?? err}`);
        return undefined;
    }
}
