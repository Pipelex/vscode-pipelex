# PR #69 — deferred review follow-ups

Notes from triaging the automated-review threads on [PR #69](https://github.com/Pipelex/vscode-pipelex/pull/69) (`release/v0.14.0`). The two reported issues were dealt with in the PR itself (one fixed, one a false positive). What follows is a genuine finding that surfaced *while verifying* those reports — it is not something either bot flagged, and it does not belong in a release branch.

## Schema is re-parsed and re-compiled on every offline lint call

**Where:** `crates/pipelex-common/src/tools/lint.rs:91` (`lint_mthds_with_env`), `crates/taplo-common/src/schema/mod.rs:47-51` (`builtins::mthds_schema`), `crates/taplo-common/src/schema/mod.rs:709-717` (`add_validator` / `create_validator`).

**Reported by:** nobody — found while disproving greptile's "offline cache always expires" claim on `crates/pipelex-common/src/tools/environment.rs:38`. Greptile's *mechanism* was wrong (the frozen `NullEnvironment` clock makes the LRU deadline permanently un-expired, not permanently expired — `lru_expired()` compares `expires_by < now` where `expires_by = now + 60s`). But its *symptom* — "recompiles the embedded MTHDS JSON schema each call" — is real, via a different route.

**The issue:** `lint_mthds_with_env` constructs a fresh `Schemas` per call, so every `lintMthds()` invocation runs `serde_json::from_str` over the embedded MTHDS schema (there is no `OnceLock` around `builtins::mthds_schema()`) and then compiles a fresh `JSONSchema`. There is no cross-call cache at all — the LRU inside each `Schemas` starts empty and dies with the call. The native `lint_mthds_impl` path pays the same cost. This is on the hot path for plugin/editor lint hooks, which call it per keystroke-ish.

**Why deferred:** `release/v0.14.0` is a release branch. This is a performance change to the shared lint engine, not a release blocker, and it deserves its own PR with a benchmark rather than being slipped into a version bump.

**Recommended fix:** memoize the `Schemas<NullEnvironment>` instance behind a `thread_local!` / `OnceLock` inside `lint_mthds_offline`, so the parsed schema and compiled validator are reused across calls. This is safe *precisely because* `NullEnvironment`'s frozen clock means the LRU never expires and never self-clears, and the WASM target is single-threaded. Worth also giving `builtins::mthds_schema()` a `OnceLock` so the native path benefits too.

**Test approach:** the existing inline suite at `crates/pipelex-common/src/tools/lint.rs` (`mod tests`, incl. `lint_is_offline_and_fast` and `offline_path_matches_native_path_on_every_stage`) is the right home. Add a regression guard on the invariant the memoization relies on — `Cache::new(NullEnvironment).lru_expired() == false`, still false after repeated calls — and assert that repeated `lint_mthds_offline` calls reuse the same compiled validator rather than timing them (an invariant assertion is more robust than a timing test).
