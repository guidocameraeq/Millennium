// Millennium — log line format and rotation rules (puesta-a-punto, encargo 02)
//
// The pure part of `runtime_log`: what a line of `runtime.log` looks like and
// when the file rotates. No Tauri, no files, no real clock (the time comes in
// as data), so `displays-tests` can test it.

/// Rotate when the file would pass this size.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Backups kept: `runtime.log.1` (newest) .. `runtime.log.3` (oldest).
pub const BACKUPS: u32 = 3;

/// A wall-clock reading, already broken into fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// `2026-11-10 23:14:05`
pub fn format_stamp(t: &Stamp) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// The line written to the file (no trailing newline): `2026-11-10 23:14:05 [INFO] msg`.
pub fn format_line(t: &Stamp, level: &str, msg: &str) -> String {
    format!("{} [{}] {}", format_stamp(t), level, msg)
}

/// UTC fields from UNIX seconds. Fallback when the OS gives no local time.
pub fn stamp_from_unix(secs: u64) -> Stamp {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant), days since 1970-01-01.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = (yoe + era * 400 + if month <= 2 { 1 } else { 0 }) as i32;
    Stamp {
        year,
        month,
        day,
        hour: (rem / 3_600) as u32,
        minute: ((rem / 60) % 60) as u32,
        second: (rem % 60) as u32,
    }
}

/// Whether appending `line_bytes` (newline included) to a file of
/// `current_bytes` must rotate first: only when it would pass the limit.
pub fn should_rotate(current_bytes: u64, line_bytes: u64) -> bool {
    current_bytes.saturating_add(line_bytes) > MAX_FILE_BYTES
}

/// `runtime.log.<n>`
pub fn backup_name(n: u32) -> String {
    format!("runtime.log.{}", n)
}

/// What a rotation does, in order: the file names to delete (the oldest
/// backup is lost), then `(from, to)` renames, oldest first so nothing is
/// overwritten: `.2`→`.3`, `.1`→`.2`, `runtime.log`→`.1`.
pub fn rotation_plan() -> (Vec<String>, Vec<(String, String)>) {
    let deletes = vec![backup_name(BACKUPS)];
    let mut renames = Vec::new();
    for n in (1..BACKUPS).rev() {
        renames.push((backup_name(n), backup_name(n + 1)));
    }
    renames.push(("runtime.log".to_string(), backup_name(1)));
    (deletes, renames)
}
