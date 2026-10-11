//! Facts about the process the events describe: CI, container, platform, what
//! started `plxt`, and which program of ours declared itself as its host.

use std::{fs, io::IsTerminal, path::Path};

use super::{context::Context, contract};

/// In CI when any CI variable is set to anything but a falsy value.
pub fn is_ci(context: &Context) -> bool {
    contract::CI_VARIABLES
        .iter()
        .any(|name| context.flag_is_on(name))
}

/// In a container when a marker file exists, a marker variable is set and not
/// empty, or `/proc/1/cgroup` mentions a container runtime.
pub fn is_container(context: &Context) -> bool {
    let cgroup = fs::read_to_string("/proc/1/cgroup").ok();
    is_container_with(context, |path| path.exists(), cgroup.as_deref())
}

pub fn is_container_with(
    context: &Context,
    file_exists: impl Fn(&Path) -> bool,
    cgroup: Option<&str>,
) -> bool {
    contract::CONTAINER_FILES
        .iter()
        .any(|file| file_exists(Path::new(file)))
        || contract::CONTAINER_VARIABLES
            .iter()
            .any(|name| context.var(name).is_some_and(|value| !value.is_empty()))
        || cgroup.is_some_and(|text| {
            contract::CONTAINER_CGROUP_WORDS
                .iter()
                .any(|word| text.contains(word))
        })
}

pub fn os() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

pub fn arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "other"
    }
}

/// What started `plxt`: a pre-commit hook, CI, a person at a terminal, or something else.
pub fn invocation(context: &Context, ci: bool) -> &'static str {
    invocation_with(context, ci, std::io::stdin().is_terminal())
}

pub fn invocation_with(context: &Context, ci: bool, stdin_is_terminal: bool) -> &'static str {
    if context
        .var(contract::ENV_PRE_COMMIT)
        .is_some_and(|value| !value.trim().is_empty())
    {
        "pre_commit"
    } else if ci {
        "ci"
    } else if stdin_is_terminal {
        "terminal"
    } else {
        "other"
    }
}

/// The program of ours that declared itself through `PIPELEX_USAGE_STATS_HOST`:
/// one of the declared values, `other` for any other value, nothing when unset or empty.
pub fn host(context: &Context) -> Option<&'static str> {
    let value = context.var(contract::ENV_HOST)?.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }
    Some(
        contract::HOST_VALUES
            .iter()
            .find(|known| **known == value)
            .copied()
            .unwrap_or(contract::HOST_OTHER),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn context(vars: &[(&str, &str)]) -> Context {
        let vars = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();
        Context::new(vars, None, None)
    }

    #[test]
    fn ci_reads_each_variable_like_do_not_track() {
        assert!(!is_ci(&context(&[])));
        assert!(!is_ci(&context(&[
            ("CI", "false"),
            ("GITHUB_ACTIONS", "0"),
            ("BUILD_NUMBER", "")
        ])));
        assert!(is_ci(&context(&[("CI", "true")])));
        assert!(is_ci(&context(&[("JENKINS_URL", "https://ci.example")])));
    }

    #[test]
    fn container_markers() {
        let none = |_: &Path| false;
        assert!(!is_container_with(&context(&[]), none, None));
        assert!(is_container_with(
            &context(&[]),
            |path: &Path| path == Path::new("/.dockerenv"),
            None
        ));
        assert!(is_container_with(
            &context(&[("KUBERNETES_SERVICE_HOST", "10.0.0.1")]),
            none,
            None
        ));
        assert!(!is_container_with(
            &context(&[("container", "")]),
            none,
            None
        ));
        assert!(is_container_with(
            &context(&[]),
            none,
            Some("0::/kubepods/besteffort/pod1")
        ));
        assert!(!is_container_with(
            &context(&[]),
            none,
            Some("0::/init.scope")
        ));
    }

    #[test]
    fn invocation_order() {
        assert_eq!(
            invocation_with(&context(&[("PRE_COMMIT", "1")]), true, true),
            "pre_commit"
        );
        assert_eq!(invocation_with(&context(&[]), true, true), "ci");
        assert_eq!(invocation_with(&context(&[]), false, true), "terminal");
        assert_eq!(invocation_with(&context(&[]), false, false), "other");
    }

    #[test]
    fn host_declarations() {
        assert_eq!(host(&context(&[])), None);
        assert_eq!(host(&context(&[("PIPELEX_USAGE_STATS_HOST", " ")])), None);
        assert_eq!(
            host(&context(&[("PIPELEX_USAGE_STATS_HOST", "mthds-agent")])),
            Some("mthds-agent")
        );
        assert_eq!(
            host(&context(&[("PIPELEX_USAGE_STATS_HOST", "COCODE")])),
            Some("cocode")
        );
        assert_eq!(
            host(&context(&[(
                "PIPELEX_USAGE_STATS_HOST",
                "/home/alice/tool"
            )])),
            Some("other")
        );
    }
}
