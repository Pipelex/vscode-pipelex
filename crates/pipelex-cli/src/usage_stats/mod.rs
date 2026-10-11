//! Anonymous usage statistics of the `plxt` CLI.
//!
//! `plxt` implements the shared usage-statistics contract of the Pipelex tools
//! (conformance's `specs/usage-statistics.md`): it sends one `command_completed`
//! per `format`, `lint`, `get` or `config` command, counting files and diagnostics
//! but never naming them, and nothing in language-server mode or for `completions`.
//! The switches, the notice, the identifier and the queue live in the state
//! directory every reporting tool shares, `~/.mthds/usage-stats/`.
//!
//! - [`session`] reads the switches before a command does anything, prints the
//!   notice, and delivers the event when the command ends;
//! - [`sender`] posts to PostHog, from a detached process outside CI and containers;
//! - [`command`] is the `plxt usage-stats` group.

pub mod command;
mod context;
pub mod contract;
mod detect;
pub mod event;
mod project;
mod random;
pub mod sender;
pub mod session;
mod spool;
mod state;
mod switches;
