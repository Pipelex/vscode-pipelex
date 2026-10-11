# Anonymous usage statistics

`plxt` and the VS Code extension send anonymous usage statistics: counts of the commands and features people use, so we know which ones matter and which ones break. They follow the usage-statistics contract every Pipelex tool shares, whose public description is [docs.pipelex.com/latest/setup/usage-statistics](https://docs.pipelex.com/latest/setup/usage-statistics/), the page the notice links to. The contract itself is `specs/usage-statistics.md` in the conformance repository, and its machine-readable schema is vendored byte for byte at [`test-data/usage-statistics.json`](../../test-data/usage-statistics.json).

## What is sent

Every event carries the same common properties: the tool (`plxt` or `vscode-pipelex`) and its released version, a random installation identifier, the operating system family and processor architecture, whether the process runs in CI or a container, whether the machine is marked as one of the team's, the notice version seen, and for the extension the Node major version (`node-20`). When one of our programs starts `plxt` and declares itself in `PIPELEX_USAGE_STATS_HOST` (`cocode` or `mthds-agent`), `plxt`'s events carry it as `host`, and any other value is reported as `other`. PostHog derives the country from the client address and stores the country alone, never the address.

**`plxt`** sends one `command_completed` per `format`, `lint`, `get` or `config` command, whatever its outcome, Ctrl-C included (`cancelled`). Aliases are resolved: `plxt fmt` sends `format`, `plxt check` and `plxt validate` send `lint`, `plxt cfg` sends `config`. The event says how the command ended, how long it took, how many files it processed in buckets (`0`, `1`, `2-10`, `11-100`, `101-1000`, `1001+`), what started it (`pre_commit` when pre-commit runs it, `ci`, `terminal` when stdin is a terminal, `other`), and how many diagnostics it reported of each kind: `syntax` (the parser's errors), `semantic` (conflicting keys and other DOM errors) and `schema` (JSON Schema violations). A failed command whose diagnostics or unformatted files caused the failure carries `error_domain: input`. `plxt lsp`, `plxt completions`, `--help`, `--version` and the `plxt usage-stats` group send nothing.

**The VS Code extension** sends `extension_activated` at most once per installation and UTC day, with the editor (`vscode`, `vscode-insiders`, `cursor`, `windsurf`, `vscodium` or `other`) and its version, and `feature_used` with the number of uses of one feature since the previous one, counted in memory and sent every five minutes and when the extension deactivates:

| Feature | Counted when |
| --- | --- |
| `graph_preview` | `Pipelex: Show Method Graph` or `Pipelex: Show Run Graph` opens a graph (not when VS Code restores one) |
| `validation` | a bundle is validated, on save or in the background of an open graph |
| `run` | `Pipelex: Run Bundle` or a pipe's gutter play icon types a run into the Pipelex terminal |
| `format` | the language server formats a TOML or MTHDS document, whole or a range |

Nothing else is ever sent: no method, MTHDS source, pipe code, concept or domain name, prompt, input, output, file name, path, URL, error message, command argument, environment variable's value, hostname or user name. Every value is an enum value, a count, a version or one of the contract's own identifiers, and the PostHog project's gate drops any event carrying anything else.

## The notice

The first time a reporting tool runs with statistics on, it says so once for the whole machine:

> Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, and the country your IP address maps to; the address itself is never stored. It never collects your methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run `plxt usage-stats disable` or set DO_NOT_TRACK=1. Details: https://docs.pipelex.com/latest/setup/usage-statistics/

`plxt` prints it on stderr, even under `--quiet`, before the command does any work. The extension shows it as a non-modal information message, naming the `Pipelex: Disable Usage Statistics` command and offering **Disable** and **Details** buttons. Either records it in the shared state's `notice-v1` marker, so whichever Pipelex tool runs first shows it and no other tool shows it again. Nothing is shown while statistics are off.

## Turning them off

Any one of these turns statistics off, and none of them can turn them back on over another:

| Switch | Effect |
| --- | --- |
| `plxt usage-stats disable`, or `Pipelex: Disable Usage Statistics` in the palette | Turns them off on this machine for every Pipelex tool and the `mthds` CLI, and deletes every queued event |
| `DO_NOT_TRACK=1` | Off for every tool that honours the convention; any value but empty, `0` or `false` |
| `PIPELEX_USAGE_STATS=0` | Off for the Pipelex tools; `false`, `no` and `off` work too, and so, failing closed, does any value other than `1`, `true`, `yes`, `on` or empty |
| `[usage_stats] enabled = false` in a project's `.pipelex/pipelex.toml` | Off for anyone working in that project, found by walking up from the working directory (from each workspace folder, for the extension) to the first directory holding `.pipelex`, `.git`, `pyproject.toml`, `setup.py`, `setup.cfg`, `package.json` or `.hg`, never the home directory; a file that cannot be read as the setting also turns them off |
| VS Code's `telemetry.telemetryLevel` below `all`, enterprise policy included | Off for the extension, followed live |
| `DISABLE_TELEMETRY=1` in `~/.mthds/config` | Today's `mthds` CLI opt-out, carried once into the machine choice |

The extension starts `pipelex-agent` to validate, `pipelex run` in its terminal and the language server with `PIPELEX_USAGE_STATS=0`, whatever VS Code's setting: it counts those uses itself, in `feature_used`, under VS Code's setting.

## The commands

`plxt usage-stats` and the extension's palette commands read and change the shared state; they never send, queue or print the notice.

| `plxt` | Palette | Effect |
| --- | --- | --- |
| `plxt usage-stats status` | `Pipelex: Show Usage Statistics Status` | Whether statistics are on, each switch that turns them off, the installation identifier and the notice version seen. Read-only |
| `plxt usage-stats status --format json` | | The same as one JSON object: `tool`, `enabled`, `off_by`, `installation_id`, `notice_version`, `internal`, `ci`, `container`, `state_dir` |
| `plxt usage-stats disable` | `Pipelex: Disable Usage Statistics` | Creates `disabled` and deletes every tool's queued events |
| `plxt usage-stats enable` | `Pipelex: Enable Usage Statistics` | Deletes `disabled`, and names every other switch that still keeps statistics off |
| `plxt usage-stats reset-id` | `Pipelex: Reset Usage Statistics Identifier` | Deletes every queued event and replaces the identifier with a new random one |

`off_by` names switches by the contract's tokens: `do_not_track`, `tool_variable`, `machine_choice`, `legacy_mthds_choice`, `project_setting`, `editor_setting` (the extension only) and `invalid_endpoint_override`. The palette commands exist in the desktop host only; the browser host (vscode.dev) has no shared state and sends nothing.

## The shared state

Every Pipelex tool and the `mthds` CLI share one directory, `~/.mthds/usage-stats/` (mode `0700`), one small file per fact, each created or deleted whole and never rewritten, so two tools running at once never undo each other's choice:

| File | Meaning |
| --- | --- |
| `id` | The installation identifier, a random UUID, created by whichever tool runs first; never derived from the machine or the person |
| `disabled` | Statistics are off on this machine |
| `legacy-migrated` | When the `mthds` CLI's own opt-out was last carried over |
| `notice-v1` | The notice has been shown |
| `internal` | The machine is one of the team's |
| `spool/plxt/`, `spool/vscode-pipelex/` | Events waiting to be sent |

## Delivery

A `plxt` command writes its event to `spool/plxt/` when it ends, starts a detached copy of itself (`plxt send-usage-stats`, hidden, no terminal, no output) that posts every queued file within ten seconds, and exits at once. In CI or a container, where a detached process would be killed, it posts in-process within one second and queues what fails. The extension posts its events within ten seconds of making them, and at deactivation it flushes within two seconds and queues the rest in `spool/vscode-pipelex/`, which its next session sends. Before each post, a sender carries over the `mthds` opt-out, stops when `disabled` exists, and drops events made under an identifier since replaced. PostHog's EU host receives them (`https://eu.i.posthog.com/batch/`); a refused file is deleted, a failed one is kept for the next sender, and a file older than thirty days is deleted unsent.

## Debugging and tests

`PIPELEX_USAGE_STATS_DEBUG=1` prints each event, exactly as it would be posted, as one JSON line `{"usage_stats_debug": …}` instead of sending or queueing it: on stderr for `plxt`, in the Pipelex output channel for the extension. `PIPELEX_USAGE_STATS_ENDPOINT` points the senders at a loopback origin (`http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`) for tests; any other value turns statistics off.

This repository's own runs never report and never touch the developer's own `~/.mthds/usage-stats/`, which matters because `plxt` runs the legacy `mthds` opt-out migration in its home even when statistics are off:

- The Makefile exports `DO_NOT_TRACK=1` for every target and runs the `plxt` its gates format and lint with through `$(PLXT)`, in a throwaway home under `target/tmp/`. The workflows set `DO_NOT_TRACK=1` for every job.
- Every Rust suite starts `plxt` through `common::plxt_command()` in `crates/pipelex-cli/tests/common/mod.rs`, in a throwaway home under Cargo's temporary directory, with `DO_NOT_TRACK=1` and the endpoint override on a loopback port nothing listens on. The statistics suite clears that environment and gives each run its own throwaway home and a loopback endpoint, refusing any other for a command that may post. `every_plxt_run_goes_through_the_isolated_command` fails when a suite names the binary anywhere else, and `post()` refuses the real capture host under a unit test.
- Every extension test file loads `src/pipelex/__tests__/usageStatsIsolation.ts` first (`setupFiles` in `vitest.config.mts`): it points `HOME` and `USERPROFILE` at a throwaway directory, sets `DO_NOT_TRACK=1` and a loopback endpoint override, and wraps the global `fetch` so that a request to any host but loopback is refused and fails the test that made it.
- A manual run of `plxt` while developing the statistics gets the same treatment by hand: `env HOME=$(mktemp -d) DO_NOT_TRACK=1 target/debug/plxt …`, or a loopback `PIPELEX_USAGE_STATS_ENDPOINT` in place of `DO_NOT_TRACK` when the run tests the switches.

The tests are:

- `crates/pipelex-cli/tests/usage_stats.rs`: the constants against the vendored schema, every built event through a port of the PostHog gate, aliases, diagnostics by kind, the switches, the group, and delivery to a capture server;
- `editors/vscode/src/pipelex/__tests__/usageStats*.test.ts`: the same for the extension, the service under a mocked VS Code whose telemetry logger behaves like the real one, and `usageStatsSpawnEnv.test.ts`, which asserts `PIPELEX_USAGE_STATS=0` at every spawn site and fails when a new one appears untested.

The conformance repository verifies `plxt` against the contract from outside, with its `tests/usage_stats` arm (`CONFORMANCE_CLI_PLXT=<path to plxt>`).

## Where the code lives

- `crates/pipelex-cli/src/usage_stats/`: `plxt`'s side, behind the default `usage-stats` feature and absent from the WASM builds. `bin/plxt.rs` reads the switches and prints the notice before a reporting command runs, and delivers its event after.
- `crates/taplo-cli/src/lib.rs` (`RunStats`) and its `lint`, `format` and `get` commands count the documents, the unformatted files and the diagnostics by kind that the event reports. This is a change to upstream Taplo code.
- `editors/vscode/src/pipelex/usageStats/`: the extension's side. `service.ts` is loaded only in the desktop host; `recorder.ts`, which the features call, and `childEnv.ts`, which every spawn site uses, depend on nothing.
