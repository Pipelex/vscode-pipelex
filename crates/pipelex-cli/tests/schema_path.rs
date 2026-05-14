use std::process::Command;

fn plxt_cmd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_plxt"))
}

const VALID_FILE: &str = "../../test-data/mthds/lint/valid.mthds";
const INVALID_FILE: &str = "../../test-data/mthds/lint/invalid_schema.mthds";
const MTHDS_SCHEMA: &str = "../taplo-common/schemas/mthds_schema.json";

#[test]
fn schema_path_valid_file_passes() {
    let output = plxt_cmd()
        .args([
            "lint",
            "--quiet",
            "--no-auto-config",
            "--schema-path",
            MTHDS_SCHEMA,
            VALID_FILE,
        ])
        .output()
        .expect("failed to run plxt");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "expected exit 0, got status {:?}, stderr: {stderr}",
        output.status.code()
    );
    assert!(stderr.is_empty(), "expected no stderr, got: {stderr}");
}

#[test]
fn schema_path_invalid_file_fails_with_schema_error() {
    let output = plxt_cmd()
        .args([
            "lint",
            "--quiet",
            "--no-auto-config",
            "--schema-path",
            MTHDS_SCHEMA,
            INVALID_FILE,
        ])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("error[schema]"),
        "expected schema diagnostic in stderr, got: {stderr}"
    );
}

#[test]
fn schema_and_schema_path_are_mutually_exclusive() {
    let output = plxt_cmd()
        .args([
            "lint",
            "--no-auto-config",
            "--schema",
            "http://example.com/x.json",
            "--schema-path",
            "/tmp/x.json",
            VALID_FILE,
        ])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("cannot be used with"),
        "expected clap conflict error, got: {stderr}"
    );
}

#[test]
fn schema_path_missing_file_errors_cleanly() {
    let output = plxt_cmd()
        .args([
            "lint",
            "--no-auto-config",
            "--schema-path",
            "/definitely/does/not/exist.json",
            VALID_FILE,
        ])
        .output()
        .expect("failed to run plxt");

    assert!(!output.status.success(), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("could not resolve --schema-path"),
        "expected resolve error in stderr, got: {stderr}"
    );
}
