//! Comandos del panel de log: leer, limpiar, avisar que el panel está abierto y recibir los logs del frontend.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::{log_format, runtime_log};

#[tauri::command]
pub(crate) fn get_runtime_log() -> String {
    runtime_log::dump_all()
}

#[tauri::command]
pub(crate) fn clear_runtime_log() {
    runtime_log::clear();
}

#[tauri::command]
pub(crate) fn set_log_panel_open(open: bool) {
    runtime_log::set_panel_open(open);
}

#[tauri::command]
pub(crate) fn record_frontend_log(level: String, msg: String) {
    let msg = log_format::limit_ui_msg(&msg);
    match level.as_str() {
        "ERR" | "ERROR" | "err" | "error" => runtime_log::err(format!("[ui] {}", msg)),
        "WARN" | "warn" => runtime_log::warn(format!("[ui] {}", msg)),
        _ => runtime_log::info(format!("[ui] {}", msg)),
    }
}
