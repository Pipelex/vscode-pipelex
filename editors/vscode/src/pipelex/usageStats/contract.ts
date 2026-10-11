/**
 * The facts of the usage-statistics contract the extension relies on.
 *
 * The contract lives in the conformance repository (`specs/usage-statistics.md`,
 * machine source `specs/usage-statistics.json`). The repository vendors the JSON
 * byte for byte at `test-data/usage-statistics.json`, and
 * `__tests__/usageStatsContract.test.ts` checks every constant here against it, so a
 * schema refresh that changes one of them fails until this file follows.
 *
 * Dependency-free on purpose: the browser build and the tests import it.
 */

export const SCHEMA_VERSION = 1;
export const TOOL = 'vscode-pipelex';
export const SURFACE = 'extension';

/** PostHog's EU capture host and its batch endpoint. The project token is public by
 * design: it can only write events, and the project's gate decides what is kept. */
export const CAPTURE_HOST = 'https://eu.i.posthog.com';
export const BATCH_PATH = '/batch/';
export const PROJECT_TOKEN = 'phc_uQjSVbzNPJxA8bHxfevn7NMzB6PbC6aJQRB6ka6MxT7a';
/** Set to `false` on every event, so PostHog never builds a person profile. */
export const PERSON_PROFILE_PROPERTY = '$process_person_profile';

export const NOTICE_VERSION = 1;
export const NOTICE_TEMPLATE =
    'Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, and the country your IP address maps to; the address itself is never stored. It never collects your methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run `{disable_command}` or set DO_NOT_TRACK=1. Details: {details_url}';
export const NOTICE_DETAILS_URL = 'https://docs.pipelex.com/latest/setup/usage-statistics/';
/** The palette title of the disable command, as the notice names it. */
export const DISABLE_COMMAND_TITLE = 'Pipelex: Disable Usage Statistics';

export function noticeText(): string {
    return NOTICE_TEMPLATE
        .replace('{disable_command}', DISABLE_COMMAND_TITLE)
        .replace('{details_url}', NOTICE_DETAILS_URL);
}

export const ENV_DO_NOT_TRACK = 'DO_NOT_TRACK';
export const ENV_TOOL_SWITCH = 'PIPELEX_USAGE_STATS';
export const ENV_DEBUG = 'PIPELEX_USAGE_STATS_DEBUG';
export const ENV_ENDPOINT_OVERRIDE = 'PIPELEX_USAGE_STATS_ENDPOINT';

/** The shared state directory, relative to the home directory, and its files. */
export const STATE_DIRECTORY = ['.mthds', 'usage-stats'] as const;
export const STATE_ID = 'id';
export const STATE_DISABLED = 'disabled';
export const STATE_LEGACY_MIGRATED = 'legacy-migrated';
export const STATE_NOTICE_PREFIX = 'notice-v';
export const STATE_INTERNAL = 'internal';
export const STATE_SPOOL = 'spool';
export const LEGACY_CONFIG = ['.mthds', 'config'] as const;
export const LEGACY_KEY = 'DISABLE_TELEMETRY';

export const FALSY_VALUES = ['', '0', 'false'] as const;
export const TOOL_SWITCH_OFF_VALUES = ['0', 'false', 'no', 'off'] as const;
export const TOOL_SWITCH_NO_EFFECT_VALUES = ['', '1', 'true', 'yes', 'on'] as const;
export const LEGACY_DISABLE_ON_VALUES = ['1', 'true', 'yes', 'on'] as const;

export const SPOOL_MAX_FILES = 100;
export const SPOOL_MAX_AGE_DAYS = 30;
export const SPOOL_STALE_CLAIM_MINUTES = 10;
export const SPOOL_STALE_TEMP_MINUTES = 60;

/** A long-running process posts within this delay of an event's creation... */
export const BUDGET_BACKGROUND_POST_DELAY_MS = 10000;
/** ...and flushes within this budget at shutdown, spooling the rest. */
export const BUDGET_SHUTDOWN_FLUSH_MS = 2000;

export const CI_VARIABLES = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'BUILD_NUMBER',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'BUILDKITE',
    'TF_BUILD',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'BITBUCKET_BUILD_NUMBER',
    'CODEBUILD_BUILD_ID',
    'DRONE',
    'APPVEYOR',
    'SEMAPHORE',
    'WOODPECKER',
] as const;

export const CONTAINER_FILES = ['/.dockerenv', '/run/.containerenv'] as const;
export const CONTAINER_VARIABLES = ['container', 'KUBERNETES_SERVICE_HOST'] as const;
export const CONTAINER_CGROUP_WORDS = ['docker', 'kubepods', 'containerd', 'lxc'] as const;

export const PROJECT_MARKERS = ['.pipelex', '.git', 'pyproject.toml', 'setup.py', 'setup.cfg', 'package.json', '.hg'] as const;

/** The switches the extension reads, by the token `status` prints, in the contract's order. */
export const SWITCH_TOKENS = [
    'do_not_track',
    'tool_variable',
    'machine_choice',
    'legacy_mthds_choice',
    'project_setting',
    'editor_setting',
    'invalid_endpoint_override',
] as const;
export type OffBy = (typeof SWITCH_TOKENS)[number];

export const EVENT_EXTENSION_ACTIVATED = 'extension_activated';
export const EVENT_FEATURE_USED = 'feature_used';

export const EDITORS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium', 'other'] as const;
export type Editor = (typeof EDITORS)[number];

export const FEATURES = ['graph_preview', 'validation', 'run', 'format', 'other'] as const;
export type Feature = (typeof FEATURES)[number];

/** `feature_used.count`'s upper bound. */
export const MAX_FEATURE_COUNT = 100000;

/** The patterns the extension's values are checked against before they are sent. */
export const RELEASE_VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([.-]?(a|b|rc|alpha|beta|dev|post|insider)[.]?[0-9]{0,4})?$/;
export const RELEASE_VERSION_MAX_LENGTH = 32;
export const INSTALLATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
