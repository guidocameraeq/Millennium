//! Icono de la bandeja del sistema y su menú (solo escritorio).
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use tauri::{Emitter, Manager};

/// Una escena para el submenú: nombre, emoji y si es la puesta ahora. Fuera de Windows la lista
/// va siempre vacía.
#[cfg(desktop)]
type EscenaDeBandeja = (String, Option<String>, bool);

/// El menú de la bandeja: los ítems de siempre y, si hay escenas (solo Windows), el submenú
/// "Escenas" con emoji + nombre y ✓ en la puesta ahora.
#[cfg(desktop)]
fn construir_menu(
    app: &tauri::AppHandle,
    escenas: &[EscenaDeBandeja],
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};

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
    #[cfg(target_os = "windows")]
    let submenu_escenas = if escenas.is_empty() {
        None
    } else {
        use tauri::menu::{CheckMenuItem, Submenu};
        let mut items = Vec::with_capacity(escenas.len());
        for (lugar, (nombre, emoji, puesta)) in escenas.iter().enumerate() {
            // En un menú de Windows el `&` marca una letra de acceso: se duplica para que se vea.
            let texto = match emoji {
                Some(e) => format!("{e} {nombre}"),
                None => nombre.clone(),
            }
            .replace('&', "&&");
            items.push(CheckMenuItem::with_id(
                app,
                crate::displays::puesta::id_de_menu(lugar, nombre),
                texto,
                true,
                *puesta,
                None::<&str>,
            )?);
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
        Some(Submenu::with_items(app, "Escenas", true, &refs)?)
    };
    #[cfg(not(target_os = "windows"))]
    let _ = escenas;

    let mut todos: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&open_i, &send_i, &clip_i];
    #[cfg(target_os = "windows")]
    if let Some(sub) = &submenu_escenas {
        todos.push(sub);
    }
    todos.extend_from_slice(&[&log_i, &sep, &quit_i]);
    Menu::with_items(app, &todos)
}

/// Vuelve a armar el submenú "Escenas" con la lista y la puesta ahora de hoy. Se llama donde
/// el backend emite `displays-scenes-changed`. Corre en un hilo (leer las escenas enumera
/// pantallas) y cambia el menú en el hilo principal. Si falla, deja el menú como estaba.
#[cfg(all(desktop, target_os = "windows"))]
pub(crate) fn rearmar_escenas(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(estado) = app.try_state::<crate::displays::DisplaysState>() else {
            return;
        };
        let escenas = match estado.escenas_para_la_bandeja() {
            Ok(e) => e,
            Err(e) => {
                crate::runtime_log::warn(format!("[bandeja] no se pudo armar el menú de escenas: {e}"));
                return;
            }
        };
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(tray) = app2.tray_by_id("main-tray") else {
                return;
            };
            match construir_menu(&app2, &escenas) {
                Ok(menu) => {
                    let _ = tray.set_menu(Some(menu));
                }
                Err(e) => crate::runtime_log::warn(format!(
                    "[bandeja] no se pudo armar el menú de escenas: {e}"
                )),
            }
        });
    });
}

/// El clic en una escena de la bandeja: aplica con cuenta regresiva (como APLICAR) y, si
/// quedó un cambio esperando confirmación, trae la ventana para poder confirmarlo (si no, se
/// revertiría solo sin que nadie lo vea). Si no se pudo, el motivo va al log.
#[cfg(all(desktop, target_os = "windows"))]
fn aplicar_escena_de_bandeja(app: &tauri::AppHandle, id: &str) {
    let Some(estado) = app.try_state::<crate::displays::DisplaysState>() else {
        crate::runtime_log::warn("[bandeja] el motor de monitores no está disponible");
        return;
    };
    let resultado = estado.aplicar_desde_bandeja(id);
    let hay_que_mostrar = match &resultado {
        Ok(foto) => foto.pending.is_some(),
        Err(_) => estado.hay_cambio_pendiente(),
    };
    if let Err(e) = &resultado {
        crate::runtime_log::warn(format!("[bandeja] {e}"));
    }
    if hay_que_mostrar {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
    // Un clic en un ítem con tilde lo invierte solo: se rearma el menú salga bien o mal, así el
    // ✓ queda donde dice el backend.
    rearmar_escenas(app);
}

#[cfg(desktop)]
pub(crate) fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    // Al arrancar el motor de displays todavía no está: sin escenas. `rearmar_escenas` las suma.
    let menu = construir_menu(app, &[])?;

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
            #[cfg(target_os = "windows")]
            id if id.starts_with(crate::displays::puesta::PREFIJO_MENU) => {
                // Aplicar enumera pantallas y puede tardar: fuera del hilo del menú.
                let app = app.clone();
                let id = id.to_string();
                std::thread::spawn(move || aplicar_escena_de_bandeja(&app, &id));
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
