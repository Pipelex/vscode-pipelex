use clap::{crate_version, Parser, Subcommand};
use std::path::PathBuf;
pub use taplo_cli::args::{Colors, FormatCommand, GeneralArgs, GetCommand, OutputFormat};
#[cfg(feature = "lint")]
pub use taplo_cli::args::LintCommand;
#[cfg(feature = "lsp")]
pub use taplo_cli::args::{LspCommand, LspCommandIo};

#[derive(Clone, Parser)]
#[clap(name = "plxt")]
#[clap(bin_name = "plxt")]
#[clap(version = crate_version!())]
pub struct PlxtArgs {
    #[clap(long, value_enum, global = true, default_value = "auto")]
    pub colors: Colors,
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
    Lint(LintCommand),

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
}

/// Rebranded config subcommand with Pipelex naming.
#[derive(Clone, Subcommand)]
pub enum PlxtConfigCommand {
    /// Print the default `.pipelex.toml` configuration file.
    Default,
    /// Print the JSON schema of the `.pipelex.toml` configuration file.
    Schema,
}

/// Pipelex-specific GeneralArgs that looks for PIPELEX_CONFIG env var.
#[derive(Clone, clap::Args)]
pub struct PlxtGeneralArgs {
    /// Path to the Pipelex configuration file.
    #[clap(long, short, env = "PIPELEX_CONFIG")]
    pub config: Option<PathBuf>,

    /// Set a cache path.
    #[clap(long)]
    pub cache_path: Option<PathBuf>,

    /// Do not search for a configuration file.
    #[clap(long)]
    pub no_auto_config: bool,
}
