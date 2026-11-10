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

/// The line written to the file (one line: newlines in `msg` become spaces): `2026-11-10 23:14:05 [INFO] msg`.
pub fn format_line(t: &Stamp, level: &str, msg: &str) -> String {
    format!("{} [{}] {}", format_stamp(t), level, one_line(msg))
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

// ---------------------------------------------------------------------------
// What the network path writes (encargo 02, sub-step 3).
//
// These take sizes and names, never the text or clipboard itself: a secret
// that was sent cannot end up in the log because it never reaches here.
// ---------------------------------------------------------------------------

/// Control characters (newlines included) become spaces: a peer alias or a
/// file name must not be able to forge a log line.
pub fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// `alias (ip:port)`
pub fn peer_label(alias: &str, ip: &str, port: u16) -> String {
    format!("{} ({}:{})", one_line(alias), one_line(ip), port)
}

/// A text is being sent: only how long it is.
pub fn send_text_line(alias: &str, ip: &str, port: u16, chars: usize) -> String {
    format!("[send] text -> {} chars={}", peer_label(alias, ip, port), chars)
}

/// Files are being sent: how many, and the session.
pub fn send_files_line(alias: &str, ip: &str, port: u16, files: usize, session: &str) -> String {
    let short: String = session.chars().take(8).collect();
    format!(
        "[send] files -> {} files={} session={}",
        peer_label(alias, ip, port),
        files,
        one_line(&short)
    )
}

/// A send failed: what was being done, to whom, and why.
pub fn send_failed_line(op: &str, alias: &str, ip: &str, port: u16, cause: &str) -> String {
    format!(
        "[send] FAILED {} -> {}: {}",
        op,
        peer_label(alias, ip, port),
        one_line(cause)
    )
}

/// A text arrived: from whom and how long, not what it said.
pub fn text_received_line(alias: &str, ip: &str, chars: usize) -> String {
    format!("[http] /text received chars={} from {} ({})", chars, one_line(alias), one_line(ip))
}

/// The lines logged once at startup (encargo 02, sub-step 4): version, the
/// adapters seen (used, or dropped and why), the IP announced and the port
/// of the HTTPS server. First thing to read when "today it doesn't work".
pub fn startup_diagnostic(
    version: &str,
    choice: &crate::net_ifaces::IfaceChoice,
    chosen_ip: &str,
    port: u16,
) -> Vec<String> {
    let mut lines = vec![format!(
        "[diag] Millennium v{} · announced ip {} · server port {} · adapters: {} used, {} discarded",
        one_line(version),
        one_line(chosen_ip),
        port,
        choice.used.len(),
        choice.discarded.len()
    )];
    for (name, ip) in &choice.used {
        lines.push(format!("[diag]   adapter '{}' {} -> used", one_line(name), ip));
    }
    for (name, ip, why) in &choice.discarded {
        lines.push(format!(
            "[diag]   adapter '{}' {} -> discarded: {}",
            one_line(name),
            ip,
            why.as_str()
        ));
    }
    lines
}
