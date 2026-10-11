//! Random identifiers and timestamps, drawn from the operating system's generator.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A random UUID version 4 in its canonical lowercase form, or `None` when the
/// operating system's generator fails, in which case no event is made.
pub fn uuid_v4() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = to_hex(&bytes);
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// A short random suffix for a temporary or claimed file name.
pub fn suffix() -> String {
    let mut bytes = [0u8; 6];
    if getrandom::getrandom(&mut bytes).is_err() {
        // A collision only makes a create or a rename fail, which every caller handles.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        return format!("{:08x}{:04x}", nanos, std::process::id() & 0xffff);
    }
    to_hex(&bytes)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}

/// The current time in RFC 3339, in UTC with milliseconds: `2026-10-11T09:30:00.123Z`.
pub fn timestamp_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
