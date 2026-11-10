//! Comandos de ajustes: carpeta de descargas, auto-aceptar favoritos, notificaciones, arranque con Windows y cerrar a la bandeja.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::{AppState, UserSettings};
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn get_settings(state: tauri::State<AppState>) -> UserSettings {
    let s = state.settings.snapshot();
    UserSettings {
        download_dir: s.download_dir.to_string_lossy().to_string(),
        auto_accept_favorites: s.auto_accept_favorites,
        notifications_enabled: s.notifications_enabled,
        start_with_windows: s.start_with_windows,
        close_to_tray: s.close_to_tray,
    }
}

#[tauri::command]
pub(crate) fn set_download_dir(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    state
        .settings
        .set_download_dir(PathBuf::from(path))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn set_auto_accept_favorites(
    state: tauri::State<AppState>,
    value: bool,
) -> Result<(), String> {
    state
        .settings
        .set_auto_accept_favorites(value)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn set_notifications_enabled(
    state: tauri::State<AppState>,
    value: bool,
) -> Result<(), String> {
    state
        .settings
        .set_notifications_enabled(value)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn set_start_with_windows(
    #[allow(unused_variables)] app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    value: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if value {
            manager.enable().map_err(|e| format!("autostart enable: {e}"))?;
        } else {
            manager.disable().map_err(|e| format!("autostart disable: {e}"))?;
        }
    }
    state
        .settings
        .set_start_with_windows(value)
        .map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn set_close_to_tray(
    state: tauri::State<AppState>,
    value: bool,
) -> Result<(), String> {
    state
        .settings
        .set_close_to_tray(value)
        .map_err(|e| format!("{e:#}"))
}
