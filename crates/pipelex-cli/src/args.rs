use clap::{crate_version, Parser, Subcommand};
use std::path::PathBuf;
#[cfg(feature = "lint")]
pub use taplo_cli::args::LintCommand;
pub use taplo_cli::args::{Colors, FormatCommand, GeneralArgs, GetCommand, OutputFormat};
#[cfg(feature = "lsp")]
pub use taplo_cli::args::{LspCommand, LspCommandIo};

#[derive(Clone, Parser)]
#[clap(name = "plxt")]
#[clap(bin_name = "plxt")]
#[clap(version = crate_version!())]
pub struct PlxtArgs {
    #[clap(long, value_enum, global = true, default_value = "auto")]
    pub colors: Colors,
    /// Suppress all log/tracing output (only lint diagnostics are printed).
    #[clap(long, short = 'q', global = true)]
    pub quiet: bool,
    /// Enable a verbose logging format.
    #[clap(long, global = true)]
    pub verbose: bool,
    /// Enable logging spans.
    #[clap(long, global = true)]
    pub log_spans: bool,
    #[clap(subcommand)]
    pub cmd: PlxtCommand,
}

#[derive(Clone, Subcommand)]
pub enum PlxtCommand {
    /// Lint TOML documents.
    #[clap(visible_aliases = &["check", "validate"])]
    #[cfg(feature = "lint")]
    Lint(PlxtLintCommand),

    /// Format TOML documents.
    ///
    /// Files are modified in-place unless the input comes from the standard input, in which case the formatted result is printed to the standard output.
    #[clap(visible_aliases = &["fmt"])]
    Format(FormatCommand),

    /// Language server operations.
    #[cfg(feature = "lsp")]
    Lsp {
        #[clap(flatten)]
        cmd: LspCommand,
    },

    /// Operations with the Pipelex config file.
    #[clap(visible_aliases = &["cfg"])]
    Config {
        #[clap(subcommand)]
        cmd: PlxtConfigCommand,
    },

    /// Extract a value from the given TOML document.
    Get(GetCommand),

    /// Generate completions for plxt CLI
    #[cfg(feature = "completions")]
    Completions { shell: String },

    /// Anonymous usage statistics: see whether they are on, turn them off or on for
    /// every Pipelex tool on this machine, or replace the installation identifier.
    #[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
    UsageStats {
        #[clap(subcommand)]
        cmd: crate::usage_stats::command::UsageStatsCommand,
    },

    /// The detached process that posts queued usage statistics; started by `plxt`
    /// itself, never by a person.
    #[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
    #[clap(name = "send-usage-stats", hide = true)]
    SendUsageStats,
}

impl PlxtCommand {
    /// The path `command_completed` reports for this command, aliases resolved, or
    /// `None` for a command that reports nothing: the language server, completions
    /// and the statistics group itself.
    pub fn statistics_name(&self) -> Option<&'static str> {
        match self {
            #[cfg(feature = "lint")]
            PlxtCommand::Lint(_) => Some("lint"),
            PlxtCommand::Format(_) => Some("format"),
            PlxtCommand::Config { .. } => Some("config"),
            PlxtCommand::Get(_) => Some("get"),
            #[cfg(feature = "lsp")]
            PlxtCommand::Lsp { .. } => None,
            #[cfg(feature = "completions")]
            PlxtCommand::Completions { .. } => None,
            #[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
            PlxtCommand::UsageStats { .. } | PlxtCommand::SendUsageStats => None,
        }
    }
}

/// Rebranded config subcommand with Pipelex naming.
#[derive(Clone, Subcommand)]
pub enum PlxtConfigCommand {
    /// Print the default `plxt.toml` configuration file.
    Default,
    /// Print the JSON schema of the `plxt.toml` configuration file.
    Schema,
    /// Print the path of the resolved configuration file.
    Which,
}

/// Pipelex-flavored lint command: wraps taplo's `LintCommand` and adds a path-based schema override.
#[cfg(feature = "lint")]
#[derive(Clone, clap::Args)]
pub struct PlxtLintCommand {
    #[clap(flatten)]
    pub inner: LintCommand,

    /// Path to a JSON schema file to use for validation, overriding the normal schema resolution rules.
    ///
    /// The path can be relative (resolved against the current working directory) or absolute.
    /// Mutually exclusive with `--schema`.
    #[clap(long, value_name = "PATH", conflicts_with = "schema")]
    pub schema_path: Option<PathBuf>,
}

/// Pipelex-specific GeneralArgs.
#[derive(Clone, clap::Args)]
pub struct PlxtGeneralArgs {
    /// Path to the Pipelex configuration file.
    #[clap(long, short)]
    pub config: Option<PathBuf>,

    /// Set a cache path.
    #[clap(long)]
    pub cache_path: Option<PathBuf>,

    /// Do not search for a configuration file.
    #[clap(long)]
    pub no_auto_config: bool,
}
