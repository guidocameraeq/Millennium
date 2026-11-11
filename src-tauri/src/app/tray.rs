//! Icono de la bandeja del sistema y su menú (solo escritorio).
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use tauri::{Emitter, Manager};

#[cfg(desktop)]
pub(crate) fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    let open_i = MenuItem::with_id(app, "tray_open", "Open Millennium", true, None::<&str>)?;
    let send_i = MenuItem::with_id(app, "tray_send", "Send to peer…", true, None::<&str>)?;
    let clip_i = MenuItem::with_id(
        app,
        "tray_clip_toggle",
        "Toggle clipboard sync (all)",
        true,
        None::<&str>,
    )?;
    let log_i = MenuItem::with_id(app, "tray_log", "Open log", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &send_i, &clip_i, &log_i, &sep, &quit_i])?;

    let icon = tauri::include_image!("icons/icon.ico");

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("Millennium")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "tray_send" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    let _ = w.emit("tray-action", "send");
                }
            }
            "tray_clip_toggle" => {
                let _ = app.emit("tray-action", "toggle-clipboard");
            }
            "tray_log" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    let _ = w.emit("tray-action", "log");
                }
            }
            "tray_quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Double-click (left button, "up" twice in a row counts as
            // DoubleClick on most platforms — Tauri's TrayIconEvent
            // surfaces it directly as DoubleClick).
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
