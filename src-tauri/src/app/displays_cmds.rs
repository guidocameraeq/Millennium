//! Comandos de Displays: foto de monitores, perfiles, atajos, audio y acciones, más los helpers de atajos globales.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::displays;
#[cfg(target_os = "windows")]
use crate::runtime_log;
#[cfg(target_os = "windows")]
use tauri::Manager;

/// Foto de los monitores conectados (SPEC-displays, Fase 1: **solo lectura**).
///
/// El comando NO se gatea por plataforma a propósito: se declara siempre, y el
/// que decide por plataforma es `displays::snapshot()`, que en no-Windows
/// devuelve `Err`. Es el mismo patrón que `apply_update`. Si en cambio se gateara
/// la entrada del `generate_handler!`, en Android el `invoke` fallaría con
/// "Command not found" — un error de plomería en vez de uno del dominio, y
/// esconder el botón pasaría a ser load-bearing en vez de cosmético.
///
/// Va en `spawn_blocking` porque las llamadas CCD son syscalls bloqueantes que
/// pueden tardar decenas de milisegundos (mismo criterio que la enumeración de
/// placas de red en `discovery.rs`). No hay `Mutex` de por medio: el motor de la
/// Fase 1 no tiene estado, así que la regla de "nunca sostener un lock a través
/// de un `.await`" se cumple por construcción — no hay nada que sostener.
#[tauri::command]
pub(crate) async fn displays_get_snapshot(app: tauri::AppHandle) -> Result<displays::DisplaysSnapshot, String> {
    // Con el motor de la Fase 2 arrancado, la foto sale de ahí: además de los
    // monitores trae el estado de la confirmación pendiente, que es lo que
    // permite rehidratar la cuenta regresiva si el modal se cerró y se reabrió.
    // Sin motor (no-Windows, o arranque fallido) se cae al camino de lectura
    // puro de la Fase 1, que sigue funcionando igual.
    #[cfg(target_os = "windows")]
    {
        if let Some(estado) = estado_displays(&app) {
            return tokio::task::spawn_blocking(move || estado.snapshot())
                .await
                .map_err(|e| format!("displays: la tarea de enumeración se cayó: {e}"))?;
        }
    }

    let _ = &app;
    tokio::task::spawn_blocking(displays::snapshot)
        .await
        .map_err(|e| format!("displays: la tarea de enumeración se cayó: {e}"))?
}

/// El estado de displays, si arrancó.
///
/// `try_state` y NO un parámetro `State<...>` en la firma del comando: si el
/// estado no está registrado, Tauri **panica** al resolver el parámetro, y con
/// `panic = "abort"` eso se lleva puesto el portapapeles, el discovery y las
/// transferencias. Devolver `None` y contestar un error del dominio es la
/// diferencia entre "la sección de monitores no arrancó" y "se cerró la app".
#[cfg(target_os = "windows")]
fn estado_displays(app: &tauri::AppHandle) -> Option<displays::DisplaysState> {
    // `Manager` (que aporta `try_state`) ya está importado arriba en el archivo.
    app.try_state::<displays::DisplaysState>()
        .map(|estado| (*estado).clone())
}

/// Mensaje único para cuando el módulo no está disponible, así la UI no muestra
/// dos textos distintos para la misma situación.
fn displays_no_disponible() -> String {
    "la sección de monitores no está disponible en esta sesión (solo Windows; si estás en Windows, mirá el LOG: el motor no arrancó)".to_string()
}

/// Re-sincroniza los atajos globales de perfil con el sistema operativo, según
/// los ajustes actuales (Displays v2, Fase 1).
///
/// Borra TODO lo registrado y vuelve a registrar el mapa `profile_shortcuts` —
/// pero SOLO si el interruptor general (`global_shortcuts_enabled`) está
/// prendido; apagado, deja todo desregistrado (criterio 5). Devuelve los accel
/// que **no** se pudieron registrar (combinación inválida o en uso por otro
/// programa): el que llama decide si avisa. Nunca hace panic ni rompe: un
/// registro que falla se loguea y se sigue.
///
/// Corre trabajo del SO (RegisterHotKey); llamarla desde un hilo bloqueante
/// (`spawn_blocking`) o desde `setup`. Solo Windows: el plugin no existe fuera.
#[cfg(target_os = "windows")]
pub(crate) fn resync_profile_shortcuts(app: &tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();
    // Partir de cero: así un atajo borrado/cambiado no queda pegado.
    let _ = gs.unregister_all();

    let mut fallidos = Vec::new();
    let Some(estado) = estado_displays(app) else {
        return fallidos;
    };
    let (habilitados, atajos) = match estado.atajos_de_perfil() {
        Ok(v) => v,
        Err(e) => {
            runtime_log::warn(format!("[hotkey] no se pudieron leer los atajos: {e}"));
            return fallidos;
        }
    };
    if !habilitados {
        runtime_log::info("[hotkey] atajos globales apagados; ninguno registrado");
        return fallidos;
    }
    for (nombre, accel) in &atajos {
        match gs.register(accel.as_str()) {
            Ok(()) => runtime_log::info(format!("[hotkey] «{nombre}» → {accel}: registrado")),
            Err(e) => {
                runtime_log::warn(format!(
                    "[hotkey] «{nombre}» → {accel}: no se pudo registrar ({e})"
                ));
                fallidos.push(accel.clone());
            }
        }
    }
    fallidos
}

/// Aplica el perfil cuyo atajo se disparó (Displays v2, Fase 1). Corre en un
/// hilo bloqueante (lo lanza el handler del plugin). Aplica **directo, sin la
/// red** — se pidió a propósito.
///
/// Compara el `Shortcut` disparado contra cada accel guardado **parseado a
/// `Shortcut`**, no por string crudo (que puede diferir en formato). Chequea el
/// interruptor general por defensa en profundidad (criterio 5): si está apagado
/// no debería haber ninguno registrado, pero si igual llegara acá, no dispara.
#[cfg(target_os = "windows")]
pub(crate) fn aplicar_atajo_de_perfil(app: &tauri::AppHandle, disparado: &tauri_plugin_global_shortcut::Shortcut) {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;

    let Some(estado) = estado_displays(app) else {
        return;
    };
    let (habilitados, atajos) = match estado.atajos_de_perfil() {
        Ok(v) => v,
        Err(_) => return,
    };
    if !habilitados {
        return;
    }
    let objetivo = atajos.iter().find_map(|(nombre, accel)| {
        match Shortcut::from_str(accel.as_str()) {
            Ok(sc) if &sc == disparado => Some(nombre.clone()),
            _ => None,
        }
    });
    let Some(nombre) = objetivo else {
        return;
    };
    match estado.aplicar_perfil_directo(&nombre) {
        Ok(()) => runtime_log::info(format!("[hotkey] perfil «{nombre}» aplicado por atajo")),
        Err(e) => runtime_log::warn(format!("[hotkey] no se pudo aplicar «{nombre}» por atajo: {e}")),
    }
}

/// Prende o apaga un monitor. La red de auto-rollback la arma el módulo.
#[tauri::command]
pub(crate) async fn displays_toggle(
    app: tauri::AppHandle,
    display_id: String,
) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        // `spawn_blocking`: adentro hay syscalls CCD que tardan y un
        // `std::sync::Mutex`. Nada de eso puede correr en el reactor, y el lock
        // nunca cruza un `.await` porque adentro del closure no hay ninguno.
        return tokio::task::spawn_blocking(move || estado.toggle(&display_id))
            .await
            .map_err(|e| format!("displays: la tarea de cambio se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &display_id);
        Err(displays_no_disponible())
    }
}

/// "Así está bien": cancela el auto-rollback.
#[tauri::command]
pub(crate) async fn displays_confirm(app: tauri::AppHandle) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.confirm())
            .await
            .map_err(|e| format!("displays: la tarea de confirmación se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        Err(displays_no_disponible())
    }
}

/// "Volvé atrás ya", sin esperar a que venza el plazo.
#[tauri::command]
pub(crate) async fn displays_revert(app: tauri::AppHandle) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.revert())
            .await
            .map_err(|e| format!("displays: la tarea de vuelta atrás se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        Err(displays_no_disponible())
    }
}

/// Lista los perfiles guardados (SPEC-displays, Fase 3).
#[tauri::command]
pub(crate) async fn displays_list_profiles(
    app: tauri::AppHandle,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.listar_perfiles())
            .await
            .map_err(|e| format!("displays: la tarea de perfiles se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        Err(displays_no_disponible())
    }
}

/// Guarda el layout actual como un perfil con nombre. Devuelve la lista al día.
#[tauri::command]
pub(crate) async fn displays_save_profile(
    app: tauri::AppHandle,
    name: String,
    replace: Option<bool>,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        // Sin `replace` un nombre repetido es error; el "↻ actualizar" manda `replace: true`.
        let reemplazar = replace.unwrap_or(false);
        return tokio::task::spawn_blocking(move || estado.guardar_perfil(&name, reemplazar))
            .await
            .map_err(|e| format!("displays: la tarea de guardar perfil se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name, &replace);
        Err(displays_no_disponible())
    }
}

/// Carga un perfil: aplica su layout con la red de auto-rollback puesta.
#[tauri::command]
pub(crate) async fn displays_load_profile(
    app: tauri::AppHandle,
    name: String,
) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.cargar_perfil(&name))
            .await
            .map_err(|e| format!("displays: la tarea de cargar perfil se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

/// Borra un perfil por nombre. Devuelve la lista al día.
#[tauri::command]
pub(crate) async fn displays_delete_profile(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            // `borrar_perfil` ya limpió el atajo (y el startup) de los ajustes;
            // el resync lo saca también del sistema operativo (Displays v2).
            let perfiles = estado.borrar_perfil(&name)?;
            resync_profile_shortcuts(&app2);
            Ok(perfiles)
        })
        .await
        .map_err(|e| format!("displays: la tarea de borrar perfil se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

/// Lee los ajustes de displays (hoy: el plazo del auto-revert).
#[tauri::command]
pub(crate) async fn displays_get_settings(app: tauri::AppHandle) -> Result<displays::SettingsView, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.leer_ajustes())
            .await
            .map_err(|e| format!("displays: la tarea de ajustes se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        Err(displays_no_disponible())
    }
}

/// Guarda los ajustes de displays. Devuelve los ajustes al día.
#[tauri::command]
pub(crate) async fn displays_update_settings(
    app: tauri::AppHandle,
    settings: displays::SettingsView,
) -> Result<displays::SettingsView, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            // Guardar pudo prender/apagar el interruptor general de atajos: hay
            // que registrar o limpiar los hotkeys en consecuencia (Displays v2).
            let guardados = estado.guardar_ajustes(settings)?;
            resync_profile_shortcuts(&app2);
            Ok(guardados)
        })
        .await
        .map_err(|e| format!("displays: la tarea de guardar ajustes se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &settings);
        Err(displays_no_disponible())
    }
}

/// Aplica las posiciones del lienzo de arrastre (Fase 3). Es un SetDisplayConfig:
/// vuelve con la cuenta regresiva puesta, igual que el toggle o el cargar perfil.
#[tauri::command]
pub(crate) async fn displays_apply_layout(
    app: tauri::AppHandle,
    positions: Vec<displays::PosicionView>,
) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.aplicar_layout(positions))
            .await
            .map_err(|e| format!("displays: la tarea del lienzo se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &positions);
        Err(displays_no_disponible())
    }
}

// --- Displays v2, Fase 1 -------------------------------------------------------

/// Hace primario un monitor activo. Es un SetDisplayConfig en vivo: vuelve con la
/// cuenta regresiva puesta, igual que el toggle o el lienzo.
#[tauri::command]
pub(crate) async fn displays_set_primary(
    app: tauri::AppHandle,
    display_id: String,
) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.hacer_primario(&display_id))
            .await
            .map_err(|e| format!("displays: la tarea de primario se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &display_id);
        Err(displays_no_disponible())
    }
}

/// Asigna un atajo global a un perfil y lo registra. Devuelve la lista al día.
///
/// Si la combinación no se puede tomar (inválida o en uso por otro programa), se
/// **deshace** lo guardado y se devuelve `Err` para que la UI avise (criterio 7):
/// no queda un atajo muerto persistido. Con el interruptor general apagado se
/// guarda igual sin registrar (no es un fallo, es el estado elegido).
#[tauri::command]
pub(crate) async fn displays_set_profile_shortcut(
    app: tauri::AppHandle,
    name: String,
    accelerator: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            // 1. Persistir (rechaza una combinación ya asignada a otro perfil).
            let perfiles = estado.asignar_atajo(&name, &accelerator)?;
            // 2. Registrar el mapa actualizado en el sistema operativo.
            let fallidos = resync_profile_shortcuts(&app2);
            // 3. ¿Este accel quedó sin registrar? (conflicto externo real; con el
            //    interruptor apagado `fallidos` viene vacío, así que no es fallo.)
            if fallidos.iter().any(|a| a == &accelerator) {
                // Deshacer: no dejar un atajo que no se puede activar.
                let _ = estado.limpiar_atajo(&name);
                resync_profile_shortcuts(&app2);
                return Err(
                    "no se pudo activar esa combinación (¿la usa otro programa?). Probá con otra."
                        .to_string(),
                );
            }
            Ok(perfiles)
        })
        .await
        .map_err(|e| format!("displays: la tarea de atajo se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name, &accelerator);
        Err(displays_no_disponible())
    }
}

/// Quita el atajo global de un perfil y lo desregistra. Devuelve la lista al día.
#[tauri::command]
pub(crate) async fn displays_clear_profile_shortcut(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            let perfiles = estado.limpiar_atajo(&name)?;
            resync_profile_shortcuts(&app2);
            Ok(perfiles)
        })
        .await
        .map_err(|e| format!("displays: la tarea de atajo se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

/// Lista las salidas de audio activas para el dropdown "Sonido a:" (Fase 3).
#[tauri::command]
pub(crate) async fn displays_list_audio_outputs(
    app: tauri::AppHandle,
) -> Result<Vec<displays::AudioView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || {
            Ok::<_, String>(estado.listar_salidas_de_audio())
        })
        .await
        .map_err(|e| format!("displays: la tarea de audio se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        Err(displays_no_disponible())
    }
}

/// Asigna una salida de audio a un perfil (Fase 3). Devuelve la lista al día.
#[tauri::command]
pub(crate) async fn displays_set_profile_audio(
    app: tauri::AppHandle,
    name: String,
    endpoint_id: String,
    friendly_name: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || {
            estado.asignar_audio(&name, &endpoint_id, &friendly_name)
        })
        .await
        .map_err(|e| format!("displays: la tarea de audio se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name, &endpoint_id, &friendly_name);
        Err(displays_no_disponible())
    }
}

/// Quita la salida de audio de un perfil, vuelve a "No tocar" (Fase 3).
#[tauri::command]
pub(crate) async fn displays_clear_profile_audio(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.limpiar_audio(&name))
            .await
            .map_err(|e| format!("displays: la tarea de audio se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

/// Asigna las acciones (entrada/salida) de un perfil-escena (Fase 4). Listas
/// vacías = perfil sin escena. Devuelve la lista al día.
#[tauri::command]
pub(crate) async fn displays_set_profile_actions(
    app: tauri::AppHandle,
    name: String,
    entrada: Vec<displays::ActionView>,
    salida: Vec<displays::ActionView>,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.asignar_acciones(&name, entrada, salida))
            .await
            .map_err(|e| format!("displays: la tarea de acciones se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name, &entrada, &salida);
        Err(displays_no_disponible())
    }
}

/// Quita todas las acciones de un perfil, vuelve a "sin escena" (Fase 4).
#[tauri::command]
pub(crate) async fn displays_clear_profile_actions(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<displays::ProfileView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.limpiar_acciones(&name))
            .await
            .map_err(|e| format!("displays: la tarea de acciones se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

// --- Escenas en papel (módulo escenas, encargo 01) -----------------------------------
// Forma y nombres: tools/ui-capturas/contrato-escenas.md. Todos se declaran siempre (también
// en Android) y fuera de Windows responden el error de hoy.

/// La lista de la pestaña ESCENAS, en el orden de Guido.
#[tauri::command]
pub(crate) async fn displays_list_scenes(
    app: tauri::AppHandle,
) -> Result<Vec<displays::SceneView>, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.listar_escenas())
            .await
            .map_err(|e| format!("displays: la tarea de escenas se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app);
        Err(displays_no_disponible())
    }
}

/// Arma un borrador (`current`, `blank`, `scene` o `copy`) sin tocar nada.
#[tauri::command]
pub(crate) async fn displays_scene_draft(
    app: tauri::AppHandle,
    from: String,
    name: Option<String>,
) -> Result<displays::SceneDraft, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.borrador_de_escena(&from, name.as_deref()))
            .await
            .map_err(|e| format!("displays: la tarea de escenas se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &from, &name);
        Err(displays_no_disponible())
    }
}

/// GUARDAR un borrador (crear o editar), en un solo guardado y sin tocar ninguna pantalla.
///
/// Después re-registra los atajos. Si el atajo se guardó pero Windows no deja registrarlo, la
/// escena queda guardada SIN atajo y va un aviso (no se deja un atajo muerto).
#[tauri::command]
pub(crate) async fn displays_save_scene(
    app: tauri::AppHandle,
    draft: displays::SceneDraft,
    original_name: Option<String>,
) -> Result<displays::ScenesResult, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            let atajo = draft.shortcut.as_deref().map(str::trim).map(str::to_string);
            let mut resultado = estado.guardar_escena(draft, original_name)?;
            let fallidos = resync_profile_shortcuts(&app2);
            if let (Some(accel), Some(nombre)) = (atajo.filter(|a| !a.is_empty()), resultado.name.clone()) {
                if fallidos.iter().any(|f| f == &accel) {
                    // Deshacer solo el atajo: lo demás ya quedó guardado.
                    let _ = estado.limpiar_atajo(&nombre);
                    resync_profile_shortcuts(&app2);
                    resultado.scenes = estado.listar_escenas()?;
                    resultado.warnings.push(format!(
                        "se guardó, pero el atajo {accel} no se pudo activar (¿lo usa otro programa?)"
                    ));
                }
            }
            Ok(resultado)
        })
        .await
        .map_err(|e| format!("displays: la tarea de guardar escena se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &draft, &original_name);
        Err(displays_no_disponible())
    }
}

/// DUPLICAR: copia sin atajo ni arranque, al final de la lista.
#[tauri::command]
pub(crate) async fn displays_duplicate_scene(
    app: tauri::AppHandle,
    name: String,
) -> Result<displays::ScenesResult, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.duplicar_escena(&name))
            .await
            .map_err(|e| format!("displays: la tarea de duplicar se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name);
        Err(displays_no_disponible())
    }
}

/// RENOMBRAR: mueve atajo, sonido, acciones, emoji y arranque en un solo guardado.
#[tauri::command]
pub(crate) async fn displays_rename_scene(
    app: tauri::AppHandle,
    name: String,
    new_name: String,
) -> Result<displays::ScenesResult, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        let app2 = app.clone();
        return tokio::task::spawn_blocking(move || {
            let resultado = estado.renombrar_escena(&name, &new_name)?;
            // El atajo cambió de nombre: re-registrar.
            resync_profile_shortcuts(&app2);
            Ok(resultado)
        })
        .await
        .map_err(|e| format!("displays: la tarea de renombrar se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &name, &new_name);
        Err(displays_no_disponible())
    }
}

/// ↑/↓ y arrastrar: `names` tiene que ser exactamente el conjunto de escenas de hoy.
#[tauri::command]
pub(crate) async fn displays_reorder_scenes(
    app: tauri::AppHandle,
    names: Vec<String>,
) -> Result<displays::ScenesResult, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.reordenar_escenas(names))
            .await
            .map_err(|e| format!("displays: la tarea de ordenar se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &names);
        Err(displays_no_disponible())
    }
}

/// PROBAR un borrador: pantallas y sonido con la cuenta regresiva de siempre, sin guardar la
/// escena ni correr acciones.
#[tauri::command]
pub(crate) async fn displays_test_draft(
    app: tauri::AppHandle,
    draft: displays::SceneDraft,
) -> Result<displays::DisplaysSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        let estado = estado_displays(&app).ok_or_else(displays_no_disponible)?;
        return tokio::task::spawn_blocking(move || estado.probar_borrador(draft))
            .await
            .map_err(|e| format!("displays: la tarea de probar se cayó: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &draft);
        Err(displays_no_disponible())
    }
}
