/// Config file names searched by the Pipelex tools.
/// These are searched before falling back to the taplo config file names.
pub const PIPELEX_CONFIG_FILE_NAMES: &[&str] = &[".pipelex/plxt.toml", "plxt.toml"];

/// User-level config path relative to the home directory.
pub const PIPELEX_HOME_CONFIG: &str = ".pipelex/plxt.toml";
