//! Lo que `lib.rs` delegaba: comandos de Tauri y servicios de fondo, partidos por tema.

pub(crate) mod updater_cmds;
pub(crate) mod runtime_log_cmds;
pub(crate) mod clipboard_poller;
pub(crate) mod displays_cmds;
#[cfg(desktop)]
pub(crate) mod tray;
pub(crate) mod crash_log;
pub(crate) mod peers_cmds;
