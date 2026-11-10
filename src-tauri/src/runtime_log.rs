// Millennium Clipboard — in-memory runtime log
//
// A circular buffer of recent log lines that can be (a) emitted live to
// the frontend as `log-line` events, and (b) dumped wholesale via the
// `get_runtime_log` Tauri command. This is the diagnostic surface the
// user pastes back when something misbehaves in the wild.
//
// All log entries also go to stderr — useful when running from a
// terminal — but on a release Windows build with `windows_subsystem =
// "windows"` stderr is effectively a black hole, so the buffer is the
// real channel. The file `<data_dir>/runtime.log` keeps them across
// restarts; its line format and rotation rules live in `log_format`.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use crate::log_format;

/// The `log-line` IPC event is only worth serializing + crossing the
/// webview boundary while the log panel is actually visible. The
/// in-memory buffer and the file appender run regardless.
static PANEL_OPEN: AtomicBool = AtomicBool::new(false);

pub fn set_panel_open(open: bool) {
    PANEL_OPEN.store(open, Ordering::Relaxed);
}

const CAPACITY: usize = 5000;

/// Only the first failure to write the file is announced; after that the
/// log keeps trying quietly (a full disk would otherwise repeat forever).
static WRITE_WARNED: AtomicBool = AtomicBool::new(false);

/// The open `runtime.log`, the folder it lives in (to rotate) and its size.
struct FileSink {
    file: File,
    dir: PathBuf,
    size: u64,
}

struct RuntimeLog {
    lines: Mutex<VecDeque<String>>,
    app: Mutex<Option<AppHandle>>,
    file: Mutex<Option<FileSink>>,
}

static LOG: OnceLock<RuntimeLog> = OnceLock::new();

fn store() -> &'static RuntimeLog {
    LOG.get_or_init(|| RuntimeLog {
        lines: Mutex::new(VecDeque::with_capacity(CAPACITY)),
        app: Mutex::new(None),
        file: Mutex::new(None),
    })
}

pub fn bind_app(app: AppHandle) {
    *store().app.lock().unwrap() = Some(app);
}

/// Open `<data_dir>/runtime.log` for appending. If the existing file is
/// over the limit, rotate it first (`runtime.log.1..3`, see `log_format`);
/// `push` rotates again whenever a line would pass the limit.
pub fn bind_file(data_dir: &Path) {
    let log_path: PathBuf = data_dir.join("runtime.log");
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if log_format::should_rotate(meta.len(), 0) {
            rotate_files(data_dir);
        }
    }
    match open_append(&log_path) {
        Ok(f) => {
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            let mut sink = FileSink {
                file: f,
                dir: data_dir.to_path_buf(),
                size,
            };
            let header = format!(
                "\n========== new run @ {} ==========",
                log_format::format_stamp(&local_stamp())
            );
            let _ = append_line(&mut sink, &header);
            *store().file.lock().unwrap() = Some(sink);
        }
        Err(e) => {
            note_write_failure(&format!("could not open {}: {}", log_path.display(), e));
        }
    }
}

fn open_append(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Run the rotation plan of `log_format`. Failures are ignored: the worst
/// case is a backup that keeps its old name, never a lost live file.
fn rotate_files(dir: &Path) {
    let (deletes, renames) = log_format::rotation_plan();
    for name in deletes {
        let _ = std::fs::remove_file(dir.join(name));
    }
    for (from, to) in renames {
        let _ = std::fs::rename(dir.join(from), dir.join(to));
    }
}

/// Append one line, rotating first if it would pass the size limit.
fn append_line(sink: &mut FileSink, line: &str) -> std::io::Result<()> {
    let bytes = line.len() as u64 + 1;
    if log_format::should_rotate(sink.size, bytes) {
        // Windows will not rename an open file: park a handle on the null
        // device while the real one is closed.
        let real = std::mem::replace(&mut sink.file, null_file()?);
        drop(real);
        rotate_files(&sink.dir);
        // Size first: if the reopen fails we must not rotate again on the
        // next line and push the backups out for nothing.
        sink.size = 0;
        sink.file = open_append(&sink.dir.join("runtime.log"))?;
    }
    writeln!(sink.file, "{}", line)?;
    sink.size += bytes;
    Ok(())
}

#[cfg(windows)]
fn null_file() -> std::io::Result<File> {
    OpenOptions::new().write(true).open("NUL")
}

#[cfg(not(windows))]
fn null_file() -> std::io::Result<File> {
    OpenOptions::new().write(true).open("/dev/null")
}

/// The first time the file cannot be written, say so on stderr and in the
/// in-memory ring (what the log panel shows) instead of staying silent.
fn note_write_failure(why: &str) {
    if WRITE_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }
    let msg = format!(
        "[runtime_log] runtime.log cannot be written ({}); the file will miss lines, this panel keeps them",
        why
    );
    eprintln!("{}", msg);
    ring_push(format!("{} [WARN] {}", iso_now(), msg));
}

fn ring_push(line: String) {
    let mut lines = store().lines.lock().unwrap();
    if lines.len() >= CAPACITY {
        lines.pop_front();
    }
    lines.push_back(line);
}

/// Local wall-clock time. Windows: `GetLocalTime` (kernel32, which std
/// already links — no new crate). Elsewhere: UTC.
#[cfg(windows)]
fn local_stamp() -> log_format::Stamp {
    #[repr(C)]
    struct SysTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(out: *mut SysTime);
    }
    let mut t = SysTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        milliseconds: 0,
    };
    // SAFETY: GetLocalTime only fills the struct we pass, which has the
    // layout of the Win32 SYSTEMTIME.
    unsafe { GetLocalTime(&mut t) };
    log_format::Stamp {
        year: t.year as i32,
        month: t.month as u32,
        day: t.day as u32,
        hour: t.hour as u32,
        minute: t.minute as u32,
        second: t.second as u32,
    }
}

#[cfg(not(windows))]
fn local_stamp() -> log_format::Stamp {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    log_format::stamp_from_unix(secs)
}

fn iso_now() -> String {
    // Lightweight HH:MM:SS.mmm timestamp for the ring / log panel — UTC
    // offset doesn't help here, the user just wants a relative timeline.
    // UNIX seconds % day gives a wall-clock-ish reading with no chrono dep.
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, millis)
}

pub fn push(level: &str, msg: String) {
    // The ring and the panel keep the short `HH:MM:SS.mmm` line; only the
    // file gets the dated local-time one.
    let line = format!("{} [{}] {}", iso_now(), level, msg);
    eprintln!("{}", line);
    let s = store();
    ring_push(line.clone());
    if PANEL_OPEN.load(Ordering::Relaxed) {
        if let Some(app) = s.app.lock().unwrap().as_ref() {
            let _ = app.emit("log-line", &line);
        }
    }
    let failed = {
        let mut slot = s.file.lock().unwrap();
        match slot.as_mut() {
            Some(sink) => {
                let file_line = log_format::format_line(&local_stamp(), level, &msg);
                append_line(sink, &file_line).err()
            }
            None => None,
        }
    };
    if let Some(e) = failed {
        note_write_failure(&e.to_string());
    }
}

pub fn info(msg: impl Into<String>) {
    push("INFO", msg.into());
}

pub fn warn(msg: impl Into<String>) {
    push("WARN", msg.into());
}

pub fn err(msg: impl Into<String>) {
    push("ERR ", msg.into());
}

pub fn dump_all() -> String {
    let s = store();
    let lines = s.lines.lock().unwrap();
    lines.iter().cloned().collect::<Vec<_>>().join("\n")
}

pub fn clear() {
    let s = store();
    s.lines.lock().unwrap().clear();
}

/// The startup diagnostic: version, adapters (used / discarded and why),
/// the IP announced and the HTTPS port. Text built by `log_format`.
pub fn log_startup_diagnostic(chosen_ip: &str, port: u16) {
    let ifaces = local_ip_address::list_afinet_netifas().unwrap_or_default();
    let choice = crate::net_ifaces::classify_ifaces(&ifaces);
    for line in log_format::startup_diagnostic(env!("CARGO_PKG_VERSION"), &choice, chosen_ip, port) {
        info(line);
    }
}

/// Snapshot every routable IPv4 interface the OS exposes. We need this
/// to diagnose the "local_ip pointed at WSL/Hyper-V instead of WiFi"
/// class of bug — without it, we can't tell whether the wrong NIC was
/// picked.
pub fn log_network_interfaces() {
    match local_ip_address::list_afinet_netifas() {
        Ok(list) => {
            info(format!("[net] {} IPv4 interface(s) detected:", list.len()));
            for (name, ip) in list {
                info(format!("[net]   {} -> {}", name, ip));
            }
        }
        Err(e) => {
            err(format!("[net] list_afinet_netifas failed: {}", e));
        }
    }
}
