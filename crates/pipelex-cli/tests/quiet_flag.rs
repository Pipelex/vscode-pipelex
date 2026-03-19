use std::process::Command;

fn plxt_cmd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_plxt"))
}

const VALID_FILE: &str = "../../test-data/mthds/lint/valid.mthds";
const INVALID_FILE: &str = "../../test-data/mthds/lint/invalid_schema.mthds";

#[test]
fn quiet_valid_file_no_output() {
    let output = plxt_cmd()
        .args(["lint", "--quiet", "--no-auto-config", VALID_FILE])
        .output()
        .expect("failed to run plxt");

    assert!(output.status.success(), "expected exit 0");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.is_empty(), "expected no stderr, got: {stderr}");
}

#[test]
fn quiet_invalid_file_only_diagnostics() {
    let output = plxt_cmd()
        .args(["lint", "--quiet", "--no-auto-config", INVALID_FILE])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Should contain error diagnostic
    assert!(
        stderr.contains("error"),
        "expected error diagnostic in stderr, got: {stderr}"
    );
    // Should NOT contain tracing noise
    assert!(
        !stderr.contains("INFO"),
        "tracing INFO should be suppressed, got: {stderr}"
    );
    assert!(
        !stderr.contains("operation failed"),
        "redundant error should be suppressed, got: {stderr}"
    );
}

#[test]
fn no_quiet_invalid_file_has_tracing() {
    let output = plxt_cmd()
        .args(["lint", "--no-auto-config", INVALID_FILE])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Without --quiet, tracing INFO lines should appear
    assert!(
        stderr.contains("INFO") || stderr.contains("found"),
        "expected tracing output without --quiet, got: {stderr}"
    );
}

#[test]
fn quiet_overrides_verbose_tracing() {
    let output = plxt_cmd()
        .args([
            "lint",
            "--quiet",
            "--verbose",
            "--no-auto-config",
            INVALID_FILE,
        ])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Should NOT contain tracing noise even with --verbose
    assert!(
        !stderr.contains("INFO"),
        "tracing INFO should be suppressed even with --verbose, got: {stderr}"
    );
    assert!(
        !stderr.contains("operation failed"),
        "redundant error should be suppressed, got: {stderr}"
    );
}
