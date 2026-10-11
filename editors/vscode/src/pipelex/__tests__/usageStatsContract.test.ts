import { describe, it, expect } from 'vitest';
import * as contract from '../usageStats/contract';
import * as events from '../usageStats/events';
import { editorOf, languageRuntime, releaseVersion } from '../usageStats/detect';
import { ENVELOPE_KEYS, envelopeKeys, gateDropReason, loadSchema } from './usageStatsGate';

const schema = loadSchema();
const ID = '0a6dccf4-9cda-44ee-b0a3-97191c19d98d';
const UUID = '4cb223d0-b41d-4b7e-a948-3cd00a5f56fd';

const COMMON: events.Common = {
    toolVersion: '0.19.1',
    idNew: true,
    os: 'darwin',
    arch: 'arm64',
    languageRuntime: 'node-20',
    ci: false,
    container: false,
    internal: false,
    noticeVersion: 1,
};
const EDITOR: events.EditorFacts = { editor: 'vscode', editorVersion: '1.95.3' };

describe('the usage-statistics contract constants', () => {
    it('follow the vendored schema', () => {
        expect(schema.schema_version).toBe(contract.SCHEMA_VERSION);
        expect(schema.destination.capture_host).toBe(contract.CAPTURE_HOST);
        expect(schema.destination.batch_path).toBe(contract.BATCH_PATH);
        expect(schema.destination.project_token).toBe(contract.PROJECT_TOKEN);
        expect(schema.person_profile_property).toBe(contract.PERSON_PROFILE_PROPERTY);

        expect(schema.notice.version).toBe(contract.NOTICE_VERSION);
        expect(schema.notice.text).toBe(contract.NOTICE_TEMPLATE);
        expect(schema.notice.details_url).toBe(contract.NOTICE_DETAILS_URL);
        expect(schema.notice.disable_commands[contract.TOOL]).toBe(contract.DISABLE_COMMAND_TITLE);

        expect(schema.environment.do_not_track).toBe(contract.ENV_DO_NOT_TRACK);
        expect(schema.environment.tool_switch).toBe(contract.ENV_TOOL_SWITCH);
        expect(schema.environment.debug).toBe(contract.ENV_DEBUG);
        expect(schema.environment.endpoint_override).toBe(contract.ENV_ENDPOINT_OVERRIDE);

        expect(schema.state.directory).toBe(`~/${contract.STATE_DIRECTORY.join('/')}`);
        expect(schema.state.id).toBe(contract.STATE_ID);
        expect(schema.state.disabled).toBe(contract.STATE_DISABLED);
        expect(schema.state.legacy_migrated).toBe(contract.STATE_LEGACY_MIGRATED);
        expect(schema.state.notice_prefix).toBe(contract.STATE_NOTICE_PREFIX);
        expect(schema.state.internal).toBe(contract.STATE_INTERNAL);
        expect(schema.state.spool).toBe(contract.STATE_SPOOL);
        expect(schema.state.legacy_config).toBe(`~/${contract.LEGACY_CONFIG.join('/')}`);
        expect(schema.state.legacy_key).toBe(contract.LEGACY_KEY);

        expect(schema.switch_values.falsy).toEqual([...contract.FALSY_VALUES]);
        expect(schema.switch_values.tool_switch_off).toEqual([...contract.TOOL_SWITCH_OFF_VALUES]);
        expect(schema.switch_values.tool_switch_no_effect).toEqual([...contract.TOOL_SWITCH_NO_EFFECT_VALUES]);
        expect(schema.switch_values.mthds_disable_on).toEqual([...contract.LEGACY_DISABLE_ON_VALUES]);

        expect(schema.spool.max_files_per_tool).toBe(contract.SPOOL_MAX_FILES);
        expect(schema.spool.max_age_days).toBe(contract.SPOOL_MAX_AGE_DAYS);
        expect(schema.spool.stale_claim_minutes).toBe(contract.SPOOL_STALE_CLAIM_MINUTES);
        expect(schema.spool.stale_temp_minutes).toBe(contract.SPOOL_STALE_TEMP_MINUTES);
        expect(schema.budgets_ms.background_post_delay).toBe(contract.BUDGET_BACKGROUND_POST_DELAY_MS);
        expect(schema.budgets_ms.shutdown_flush).toBe(contract.BUDGET_SHUTDOWN_FLUSH_MS);

        expect(schema.ci_variables).toEqual([...contract.CI_VARIABLES]);
        expect(schema.container_markers.files).toEqual([...contract.CONTAINER_FILES]);
        expect(schema.container_markers.environment).toEqual([...contract.CONTAINER_VARIABLES]);
        expect(schema.container_markers.cgroup_words).toEqual([...contract.CONTAINER_CGROUP_WORDS]);
        expect(schema.project_markers).toEqual([...contract.PROJECT_MARKERS]);

        const switches = schema.switches
            .filter((entry: any) => entry.tools.includes(contract.TOOL))
            .map((entry: any) => entry.token);
        expect(switches).toEqual([...contract.SWITCH_TOKENS]);

        expect(schema.common_properties.surface.values_by.values[contract.TOOL]).toEqual([contract.SURFACE]);
        expect(schema.events.extension_activated.tools).toEqual([contract.TOOL]);
        expect(schema.events.feature_used.tools).toEqual([contract.TOOL]);
        expect(schema.events.feature_used.properties.editor.values).toEqual([...contract.EDITORS]);
        expect(schema.events.extension_activated.properties.editor.values).toEqual([...contract.EDITORS]);
        expect(schema.events.feature_used.properties.feature.values).toEqual([...contract.FEATURES]);
        expect(schema.events.feature_used.properties.count.max).toBe(contract.MAX_FEATURE_COUNT);
        expect(schema.patterns.release_version.regex).toBe(contract.RELEASE_VERSION_RE.source);
        expect(schema.patterns.release_version.max_length).toBe(contract.RELEASE_VERSION_MAX_LENGTH);
        expect(schema.patterns.installation_id.regex).toBe(contract.INSTALLATION_ID_RE.source);
    });

    it('fills the notice with the palette command that disables', () => {
        expect(contract.noticeText()).toContain('run `Pipelex: Disable Usage Statistics` or set DO_NOT_TRACK=1');
        expect(contract.noticeText()).toContain(contract.NOTICE_DETAILS_URL);
    });
});

describe('the extension events', () => {
    it('pass the gate, carrying only the envelope the contract names', () => {
        const built: events.Envelope[] = [
            events.extensionActivated(ID, UUID, COMMON, EDITOR),
            events.extensionActivated(ID, UUID, { ...COMMON, languageRuntime: undefined, idNew: false }, { editor: 'cursor', editorVersion: '1.99.3' }),
        ];
        for (const feature of contract.FEATURES) {
            built.push(events.featureUsed(ID, UUID, COMMON, EDITOR, feature, 3));
        }
        built.push(events.featureUsed(ID, UUID, COMMON, EDITOR, 'format', 10_000_000));
        built.push(events.featureUsed(ID, UUID, COMMON, { editor: 'vscode-insiders', editorVersion: '1.96.0-insider' }, 'run', 1));
        for (const envelope of built) {
            expect(gateDropReason(schema, envelope), JSON.stringify(envelope)).toBeUndefined();
            expect(envelopeKeys(envelope)).toEqual(ENVELOPE_KEYS);
            expect(envelope.properties.tool).toBe('vscode-pipelex');
            expect(envelope.properties.surface).toBe('extension');
            expect(envelope.properties.$process_person_profile).toBe(false);
        }
    });

    it('caps a count at the schema bound', () => {
        expect(events.featureUsed(ID, UUID, COMMON, EDITOR, 'format', 10_000_000).properties.count).toBe(contract.MAX_FEATURE_COUNT);
    });

    it('are checked by a gate that is not vacuous', () => {
        const valid = events.featureUsed(ID, UUID, COMMON, EDITOR, 'validation', 2);
        expect(gateDropReason(schema, valid)).toBeUndefined();
        const broken: Array<(event: any) => void> = [
            event => { event.properties.$lib = 'node'; },
            event => { event.properties.feature = 'graph'; },
            event => { delete event.properties.editor; },
            event => { event.properties.$process_person_profile = true; },
            event => { event.distinct_id = 'not-an-id'; },
            event => { event.properties.count = 0; },
            event => { event.properties.tool = 'plxt'; },
            event => { event.properties.files_bucket = '1'; },
        ];
        for (const mutate of broken) {
            const event = JSON.parse(JSON.stringify(valid));
            mutate(event);
            expect(gateDropReason(schema, event), JSON.stringify(event)).toBeDefined();
        }
    });
});

describe('the host facts', () => {
    it('names the editor from appName', () => {
        expect(editorOf('Visual Studio Code')).toBe('vscode');
        expect(editorOf('Visual Studio Code - Insiders')).toBe('vscode-insiders');
        expect(editorOf('Cursor')).toBe('cursor');
        expect(editorOf('Windsurf')).toBe('windsurf');
        expect(editorOf('VSCodium')).toBe('vscodium');
        expect(editorOf('Code - OSS')).toBe('other');
    });

    it('keeps a version the release pattern admits, or its leading triple', () => {
        expect(releaseVersion('1.95.3')).toBe('1.95.3');
        expect(releaseVersion('1.96.0-insider')).toBe('1.96.0-insider');
        expect(releaseVersion('1.99.3-20250101-abcdef')).toBe('1.99.3');
        expect(releaseVersion('unknown')).toBeUndefined();
    });

    it('reports the Node major as the language runtime', () => {
        expect(languageRuntime('20.18.1')).toBe('node-20');
        expect(languageRuntime('')).toBeUndefined();
    });
});
