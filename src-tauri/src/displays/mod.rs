//! Módulo de displays — **Fase 2 del SPEC-displays: ver Y mover, con red.**
//!
//! Enumera los monitores conectados (activos y desconectados-pero-presentes),
//! y prende o apaga uno con una **red de auto-rollback**: si el cambio no se
//! confirma dentro del plazo, se revierte solo.
//!
//! # Las dos piezas de la red (leer antes de tocar nada)
//!
//! 1. `watchdog.rs` — el gatillo que revierte al vencer el plazo. El manager del
//!    crate puro guarda el plazo pero es **pasivo**: sin este gatillo, un layout
//!    malo queda pegado para siempre. Es el bug que Monarch nació para matar.
//! 2. `system_events.rs` — al despertar la máquina, tira el cache (los LUID de
//!    las placas cambian al suspender).
//!
//! Y la regla que las gobierna a las dos, heredada de Monarch: **nunca se juzga
//! por el código que devuelve Windows, siempre se verifica re-enumerando.** Un
//! `SetDisplayConfig` que no cambió nada devuelve "éxito" igual.
//!
//! # Forma del módulo
//!
//! - Este `mod.rs` es **ungateado** a propósito: los tipos que cruzan al frontend
//!   y el comando tienen que poder nombrarse en cualquier plataforma. Si el DTO
//!   viviera tras `cfg(windows)`, la firma del comando no compilaría en Android.
//! - Los submódulos son **windows-only**, con doble gate: el `#[cfg]` de acá
//!   abajo más un `#![cfg(...)]` interno en cada archivo (el molde de
//!   `windows_integration.rs`).
//! - El crate `monarch` (los tipos del modelo) también es windows-only, así que
//!   NADA de este archivo puede mencionarlo fuera de un bloque gateado.
//! - **Este módulo no menciona a Tauri.** La glue que emite eventos vive en
//!   `lib.rs` y entra por el callback `Emisor`. No es purismo: es lo que permite
//!   type-checkear todo el motor localmente en un crate scratch, porque el stack
//!   de Tauri no compila en la máquina del dueño (ver `docs/DECISIONS.md`).
//!
//! # Origen
//!
//! El motor viene de Monarch @ `7f9f63b` — ver `docs/DECISIONS.md` (ADR-002) y
//! `vendor/monarch/PROVENANCE.md`.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
mod acciones;
#[cfg(target_os = "windows")]
#[allow(dead_code)] // helpers de color/wallpaper que solo usa una rama del apply
mod apply;
#[cfg(target_os = "windows")]
mod audio;
#[cfg(target_os = "windows")]
mod backend;
// La cola de acciones de las escenas (encargo 03): pura, pero nombra a `monarch` (solo Windows).
#[cfg(target_os = "windows")]
mod cola;
#[cfg(target_os = "windows")]
mod enumerate;
#[cfg(target_os = "windows")]
mod ids;
#[cfg(target_os = "windows")]
mod store;
#[cfg(target_os = "windows")]
mod system_events;
#[cfg(target_os = "windows")]
#[allow(dead_code)] // ídem: parte del motor donante no la ejerce el toggle
mod topology;
// Sin `cfg(windows)` a propósito: es lo que `displays-tests` puede correr. Los tipos de
// las escenas se nombran en cualquier plataforma; sus conversiones son solo Windows.
mod escenas;
// Ídem: elegir un juego de Steam, una cuenta de Chrome o un programa abierto (encargo 03).
mod listas;
// Ídem: los tipos del selector de resolución y sus reglas puras (encargo 02 de escenas).
mod modos;
mod view;
#[cfg(target_os = "windows")]
mod watchdog;
#[cfg(target_os = "windows")]
mod win32_types;

pub use escenas::{SceneDraft, SceneView, ScenesResult};
pub use listas::{ChromeProfiles, RunningProgram, SteamGame};
pub use modos::DisplayModesView;

/// Los juegos de Steam instalados para el selector de acciones. Sin Steam, lista vacía.
/// Lee archivos: llamarla desde `spawn_blocking`.
#[cfg(target_os = "windows")]
pub fn listar_juegos_de_steam() -> Vec<SteamGame> {
    acciones::carpeta_de_steam()
        .map(|carpeta| listas::juegos_de_steam(&carpeta))
        .unwrap_or_default()
}

/// Las cuentas de Chrome y la ruta de `chrome.exe`. Sin Chrome, `chrome_path: None` y lista vacía.
#[cfg(target_os = "windows")]
pub fn listar_cuentas_de_chrome() -> ChromeProfiles {
    let chrome_path = acciones::ruta_de_chrome();
    let profiles = match (&chrome_path, acciones::local_state_de_chrome()) {
        (Some(_), Some(texto)) => listas::cuentas_de_chrome(&texto),
        _ => Vec::new(),
    };
    ChromeProfiles {
        chrome_path: chrome_path.map(|ruta| ruta.to_string_lossy().into_owned()),
        profiles,
    }
}

/// Los programas abiertos con ventana, para elegir cuál cerrar (sin la lista prohibida).
#[cfg(target_os = "windows")]
pub fn listar_programas_abiertos() -> Vec<RunningProgram> {
    listas::programas_abiertos(
        acciones::programas_con_ventana(),
        &acciones::nombre_de_esta_app(),
    )
}
pub use view::DisplayView;
use view::mock_displays;
// Solo los usa el camino de Windows (`views_from_topology` y `estado`).
#[cfg(target_os = "windows")]
use view::{mark_can_detach, sort_for_display};

/// Puente del logger del motor migrado hacia el de Millennium.
///
/// El código de Monarch llama `diagnostics::log(...)`, que allá escribía a un
/// `diagnostics.log` propio. Acá va al runtime log de Millennium, que es lo que
/// se ve en el modal LOG. Se resuelve con un shim en vez de editar los `use` del
/// motor para que el diff contra el donante siga siendo legible.
///
/// (`runtime_log` expone `err`, no `error`, y sus funciones toman
/// `impl Into<String>` — no son macros con formato inline.)
#[cfg(target_os = "windows")]
pub(crate) mod diagnostics {
    pub fn log(message: impl AsRef<str>) {
        crate::runtime_log::info(format!("[displays] {}", message.as_ref()));
    }
}

/// Lo que falta para que un cambio sin confirmar se revierta solo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    /// Milisegundos que quedan, según el reloj del **backend** — que es el que
    /// manda. La UI lo usa para rehidratar la cuenta regresiva si el usuario
    /// cerró y reabrió el modal en el medio.
    pub remaining_ms: u64,
    /// `true` si la cuenta regresiva es de PROBAR un borrador (la pantalla bloquea GUARDAR,
    /// RENOMBRAR, BORRAR, DUPLICAR y ↻ mientras dura). Falta = `false`.
    pub is_test: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaysSnapshot {
    /// `"windows"` = monitores reales por CCD. `"mock"` = datos de mentira
    /// (`MONARCH_FORCE_MOCK_BACKEND`). La UI lo muestra para que nadie confunda
    /// una demo con la máquina real.
    pub source: &'static str,
    pub displays: Vec<DisplayView>,
    /// `None` = no hay nada esperando confirmación.
    pub pending: Option<PendingView>,
}

/// Un perfil guardado, tal como lo ve el frontend (SPEC-displays, Fase 3).
///
/// El perfil real guarda un `Layout` entero; acá solo viaja lo que la lista
/// necesita mostrar. El resumen se arma en el backend para que el frontend no
/// tenga que entender la topología.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub name: String,
    /// Cuántos monitores quedan prendidos en este perfil.
    pub active_count: usize,
    /// Resumen legible ya formateado (ej. `"2 monitores · 1920×1080, 2560×1440"`).
    pub summary: String,
    /// El atajo global asignado a este perfil (Displays v2, Fase 1), o `None` si
    /// no tiene. Se guarda en `profile_shortcuts` por **nombre** de perfil.
    pub shortcut: Option<String>,
    /// La salida de audio asignada a este perfil (Displays v2, Fase 3), o `None`
    /// si está en "No tocar el audio". Se guarda en `profile_audio` por nombre.
    pub audio: Option<AudioView>,
    /// Las acciones (entrada/salida) del perfil-escena (Displays v2, Fase 4).
    /// Ambas listas vacías = perfil sin acciones. Se guardan en `profile_actions`
    /// por **nombre** de perfil.
    pub actions: ProfileActionsView,
}

/// La salida de audio de un perfil, plana, para cruzar al frontend (Displays v2,
/// Fase 3). No usa el `AudioTarget` del vendor a propósito: este DTO vive en la
/// parte **ungateada** del módulo (tiene que nombrarse en cualquier plataforma) y
/// el vendor `monarch` es windows-only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioView {
    /// Clave técnica opaca del endpoint (de `IMMDevice::GetId`).
    pub endpoint_id: String,
    /// Etiqueta linda para la UI (nombre del dispositivo).
    pub friendly_name: String,
}

/// Una acción de un perfil-escena, plana, para cruzar al frontend (Displays v2,
/// Fase 4). Espeja `monarch::Accion` (mismo tag `"tipo"`) pero vive en la parte
/// **ungateada** del módulo: se nombra en cualquier plataforma (la firma de los
/// comandos tiene que compilar en Android), mientras que el vendor `monarch` es
/// windows-only. Viaja en los dos sentidos: sale en `ProfileView` y entra en el
/// comando `displays_set_profile_actions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum ActionView {
    Lanzar {
        destino: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Volumen {
        nivel: u8,
    },
}

/// Las acciones (entrada/salida) de un perfil-escena, planas, para el frontend
/// (Displays v2, Fase 4). Ambas listas vacías = perfil sin acciones.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActionsView {
    pub entrada: Vec<ActionView>,
    pub salida: Vec<ActionView>,
}

/// Los ajustes de displays que el frontend puede editar.
///
/// Fase 3 exponía solo el **plazo del auto-revert**. Displays v2 (Fase 1) suma
/// dos: el **perfil de arranque** (`startup_profile_name`) y el **interruptor
/// general de atajos** (`global_shortcuts_enabled`). El resto de `AppSettings`
/// (bases de atajos, el mapa `profile_shortcuts`, `start_with_windows`…) NO
/// viaja por acá: al guardar se **preserva intacto** (ver `guardar_ajustes`).
/// Viaja en los dos sentidos: sale en `leer` y entra en `guardar`.
///
/// Los dos campos nuevos llevan `serde(default)` para que un `displays.json`
/// viejo (o un payload parcial) deserialice sin romper; el frontend igual manda
/// **siempre los tres** para no pisar dato del usuario con un default.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub revert_timeout_secs: u64,
    #[serde(default)]
    pub startup_profile_name: Option<String>,
    #[serde(default = "default_shortcuts_enabled")]
    pub global_shortcuts_enabled: bool,
}

/// Default del interruptor de atajos: `true`, igual que `AppSettings` en el
/// vendor. Sin esto, un payload sin el campo lo apagaría en silencio.
fn default_shortcuts_enabled() -> bool {
    true
}

/// Una posición nueva para un monitor, tal como la manda el lienzo de arrastre
/// (SPEC-displays, Fase 3). Se identifica el monitor por **placa + target**, NO
/// por el id completo con EDID: el EDID puede leerse distinto entre
/// enumeraciones (a veces `None`), y `(adapterLuid, targetId)` alcanza para
/// ubicar un monitor activo sin ese riesgo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PosicionView {
    pub adapter_luid: String,
    pub target_id: u32,
    pub x: i32,
    pub y: i32,
}

/// Variable de entorno que fuerza el backend falso, heredada de Monarch.
///
/// Sirve para ver la UI de displays en una máquina sin monitores raros, o en un
/// build no-Windows.
const FORCE_MOCK_ENV: &str = "MONARCH_FORCE_MOCK_BACKEND";

/// Toma la foto de los monitores.
///
/// **Bloqueante**: las llamadas CCD pueden tardar decenas de milisegundos (más si
/// un panel está despertando). El que llama TIENE que envolverla en
/// `spawn_blocking` — nunca correrla en el reactor.
pub fn snapshot() -> Result<DisplaysSnapshot, String> {
    if std::env::var_os(FORCE_MOCK_ENV).is_some() {
        crate::runtime_log::warn(format!(
            "[displays] {FORCE_MOCK_ENV} activo — devolviendo monitores FALSOS"
        ));
        return Ok(DisplaysSnapshot {
            source: "mock",
            displays: mock_displays(),
            pending: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let snapshot = enumerate::query_active_topology().map_err(|e| e.to_string())?;
        Ok(DisplaysSnapshot {
            source: "windows",
            displays: views_from_topology(&snapshot),
            // Esta función no conoce el manager (es el camino de lectura puro de
            // la Fase 1, intacto). Quien tenga estado rellena el pendiente.
            pending: None,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(format!(
            "el módulo de displays solo existe en Windows (probá {FORCE_MOCK_ENV}=1 para ver datos de ejemplo)"
        ))
    }
}

/// Traduce el modelo de Monarch al DTO del frontend.
///
/// La geometría sale del `layout` (que es quien tiene la posición) y el resto de
/// `displays`. Se cruzan **por índice**, no buscando por `DisplayId`: el motor
/// construye los dos vectores en lockstep (cada `displays.push` tiene su
/// `outputs.push` en la misma vuelta, tanto en `snapshot_from_raw` como en el
/// seeder), así que el índice es la correspondencia exacta. Buscar por id sería
/// O(n²) y, ante dos monitores con el mismo `DisplayId`, le daría al segundo la
/// posición del primero. Si algún día los largos no coinciden, `get` devuelve
/// `None` y se cae al mismo default que antes.
#[cfg(target_os = "windows")]
fn views_from_topology(snapshot: &win32_types::TopologySnapshot) -> Vec<DisplayView> {
    let mut views: Vec<DisplayView> = snapshot
        .displays
        .iter()
        .enumerate()
        .map(|(idx, display)| {
            let output = snapshot.layout.outputs.get(idx);
            DisplayView {
                id: format!(
                    "{}:{}:{}",
                    display.id.adapter_luid,
                    display.id.target_id,
                    display
                        .id
                        .edid_hash
                        .map(|hash| hash.to_string())
                        .unwrap_or_else(|| "none".to_string())
                ),
                name: if display.friendly_name.trim().is_empty() {
                    // Windows devuelve nombre vacío para algunos paneles
                    // internos. Mismo formato que usa el motor en su propio
                    // fallback (luid + target), para que dos monitores sin
                    // nombre en placas distintas no queden con la misma etiqueta.
                    format!("Display {}:{}", display.id.adapter_luid, display.id.target_id)
                } else {
                    display.friendly_name.clone()
                },
                active: display.is_active,
                primary: display.is_primary,
                width: display.resolution.width,
                height: display.resolution.height,
                refresh_mhz: display.refresh_rate_mhz,
                position_x: output.map(|o| o.position.x).unwrap_or(0),
                position_y: output.map(|o| o.position.y).unwrap_or(0),
                adapter_luid: display.id.adapter_luid.to_string(),
                target_id: display.id.target_id,
                edid_hash: display.id.edid_hash.map(|hash| hash.to_string()),
                // Lo decide `mark_can_detach` abajo, que necesita ver la lista
                // entera para saber cuántos quedan prendidos.
                can_detach: false,
            }
        })
        .collect();

    // Antes de ordenar: así "el primero" es el primero de la enumeración de
    // Windows, no el que quedó arriba después del sort.
    keep_single_primary(&mut views);
    mark_can_detach(&mut views);
    sort_for_display(&mut views);
    views
}

/// Deja UN solo primario.
///
/// El motor deduce `is_primary` de que la posición sea (0,0), porque Windows no
/// lo reporta directo. En **modo espejo** dos monitores clonados comparten esa
/// posición, así que los marca primarios a los dos y la UI mostraría dos badges
/// PRIMARY. Windows tiene uno solo: se conserva el primero en el orden en que
/// vino de la enumeración y se apagan los demás.
///
/// Se corrige acá, en la vista, y no en el motor migrado: la Fase 1 es de solo
/// lectura y conviene no tocarle la semántica al código que viene de Monarch.
// Solo la llama `views_from_topology`, que es windows-only: sin el gate, la rama
// no-Windows la reporta como código muerto y esa advertencia tapa las de verdad.
#[cfg(target_os = "windows")]
fn keep_single_primary(views: &mut [DisplayView]) {
    let mut ya_hay = false;
    for view in views.iter_mut() {
        if view.primary {
            if ya_hay {
                view.primary = false;
            } else {
                ya_hay = true;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// FASE 2 — el estado, el apply y la red de seguridad
// ---------------------------------------------------------------------------

/// Nombres de los eventos que el frontend escucha.
pub const EVENTO_CAMBIO: &str = "displays-changed";
pub const EVENTO_CONFIRMACION: &str = "displays-confirmation";
/// Aviso puntual del audio por perfil (Displays v2, Fase 3): p.ej. la salida
/// asignada no está presente (TV apagada). Canal aparte del de confirmación para
/// no ensuciar la máquina de estados del banner de auto-revert.
pub const EVENTO_AUDIO: &str = "displays-audio";
/// La lista de escenas cambió (guardar, renombrar, duplicar, reordenar, borrar…). El payload
/// es `{ "kind": … }`; la pantalla vuelve a pedir `displays_list_scenes`.
pub const EVENTO_ESCENAS: &str = "displays-scenes-changed";

/// Cómo este módulo le habla al frontend, **sin conocer a Tauri**.
///
/// `lib.rs` inyecta un closure que hace `app.emit(nombre, payload)`. Mantener el
/// tipo acá y la implementación allá es lo que permite type-checkear todo el
/// motor en el crate scratch local (el stack de Tauri no compila en esta
/// máquina). No es prolijidad: es la diferencia entre verificar antes del CI o
/// después.
#[cfg(target_os = "windows")]
pub type Emisor = Box<dyn Fn(&str, serde_json::Value) + Send + Sync + 'static>;

/// Le pregunta a Windows qué modos acepta cada pantalla prendida (encargo 02 de escenas).
///
/// Sondeado antes de escribir (doctrina "Sondar Win32", evidencia del encargo 02):
/// `EnumDisplaySettingsExW` con `iModeNum` 0, 1, 2… sobre el nombre GDI de la FUENTE activa
/// (`\\.\DISPLAYn`, de `DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME`) hasta que devuelve 0. Sin
/// `EDS_RAWMODE` solo da los modos que el monitor acepta; sin `EDS_ROTATEDMODE`, en la
/// orientación de hoy (la misma del modo de fuente que guarda el `Layout`). Una salida sin
/// fuente activa (la TV apagada) no tiene nombre GDI ni API documentada para pedirle modos:
/// por eso solo se leen las prendidas y las demás usan lo recordado.
///
/// Solo LEE: no toca la topología ni el motor (`enumerate.rs` se usa tal cual).
#[cfg(target_os = "windows")]
mod lectura_de_modos {
    use std::mem::size_of;

    use monarch::model::DisplayMode;
    use monarch::ManagerError;
    use windows::core::PCWSTR;
    use windows::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplaySettingsExW, DEVMODEW, ENUM_DISPLAY_SETTINGS_FLAGS, ENUM_DISPLAY_SETTINGS_MODE,
    };

    use super::modos::{modo_de_devmode, ModosLeidos};
    use super::win32_types::luid_to_u64;

    /// `wingdi.h`: el bit de `dmDisplayFlags` de un modo entrelazado.
    const DM_INTERLACED: u32 = 0x0000_0002;
    /// `wingdi.h`: el bit de path activo de `DISPLAYCONFIG_PATH_INFO.flags`.
    const DISPLAYCONFIG_PATH_ACTIVE_FLAG: u32 = 0x0000_0001;
    /// Tope de vueltas por pantalla: un driver que nunca devuelve 0 no cuelga el hilo. Una
    /// pantalla común reporta decenas a pocos cientos (un modo por profundidad de color).
    const TOPE_DE_MODOS: u32 = 4096;

    /// Qué fuente alimenta a qué pantalla, de los paths activos: si cambia mientras se leen
    /// los modos, `\\.\DISPLAYn` puede haber pasado a otra pantalla.
    fn cableado(paths: &[DISPLAYCONFIG_PATH_INFO]) -> Vec<(u64, u32, u64, u32)> {
        let mut cables: Vec<_> = paths
            .iter()
            .filter(|p| p.flags & DISPLAYCONFIG_PATH_ACTIVE_FLAG != 0)
            .map(|p| {
                (
                    luid_to_u64(p.targetInfo.adapterId.HighPart, p.targetInfo.adapterId.LowPart),
                    p.targetInfo.id,
                    luid_to_u64(p.sourceInfo.adapterId.HighPart, p.sourceInfo.adapterId.LowPart),
                    p.sourceInfo.id,
                )
            })
            .collect();
        cables.sort();
        cables
    }

    /// Los modos de cada pantalla prendida. Una pantalla cuyo nombre GDI no se puede leer
    /// queda afuera (sale con lo recordado); un error de la enumeración es error. Si las
    /// pantallas cambiaron mientras se leía (p. ej. la escena de arranque se aplicó en el
    /// medio), la lectura se descarta entera: el `WM_DISPLAYCHANGE` que sigue la repite.
    pub fn leer() -> Result<Vec<ModosLeidos>, ManagerError> {
        let topologia = super::enumerate::query_active_only_topology()?;
        let leidos = leer_con(&topologia)?;
        let despues = super::enumerate::query_active_only_topology()?;
        if cableado(&despues.raw.paths) != cableado(&topologia.raw.paths) {
            super::diagnostics::log("modos:descartados:cambio_las_pantallas");
            return Ok(Vec::new());
        }
        Ok(leidos)
    }

    fn leer_con(
        topologia: &super::win32_types::TopologySnapshot,
    ) -> Result<Vec<ModosLeidos>, ManagerError> {
        let mut leidos = Vec::new();
        for path in &topologia.raw.paths {
            if path.flags & DISPLAYCONFIG_PATH_ACTIVE_FLAG == 0 {
                continue;
            }
            let adapter_luid = luid_to_u64(
                path.targetInfo.adapterId.HighPart,
                path.targetInfo.adapterId.LowPart,
            );
            // Se cruza por (adaptador, target) y no por índice: no depende de que la
            // enumeración arme los dos vectores en el mismo orden.
            let Some(pantalla) = topologia.displays.iter().find(|d| {
                d.id.adapter_luid == adapter_luid && d.id.target_id == path.targetInfo.id
            }) else {
                continue;
            };
            let Some(nombre_gdi) = nombre_gdi_de_la_fuente(path) else {
                continue;
            };
            leidos.push(ModosLeidos {
                id: pantalla.id.clone(),
                nombre: pantalla.friendly_name.clone(),
                modos: modos_del_dispositivo(&nombre_gdi),
            });
        }
        Ok(leidos)
    }

    fn nombre_gdi_de_la_fuente(path: &DISPLAYCONFIG_PATH_INFO) -> Option<Vec<u16>> {
        unsafe {
            let mut fuente = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            fuente.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut fuente.header) != 0 {
                return None;
            }
            let largo = fuente
                .viewGdiDeviceName
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(fuente.viewGdiDeviceName.len());
            if largo == 0 {
                return None;
            }
            let mut nombre = fuente.viewGdiDeviceName[..largo].to_vec();
            nombre.push(0);
            Some(nombre)
        }
    }

    /// Los modos crudos de un dispositivo GDI (`nombre` termina en 0). Sin normalizar: eso lo
    /// hace quien los usa.
    fn modos_del_dispositivo(nombre: &[u16]) -> Vec<DisplayMode> {
        let mut modos = Vec::new();
        for numero in 0..TOPE_DE_MODOS {
            // La doc pide `dmSize` antes de llamar; `dmDriverExtra` en 0 = sin datos privados.
            let mut devmode: DEVMODEW = unsafe { std::mem::zeroed() };
            devmode.dmSize = size_of::<DEVMODEW>() as u16;
            let hay = unsafe {
                EnumDisplaySettingsExW(
                    PCWSTR(nombre.as_ptr()),
                    ENUM_DISPLAY_SETTINGS_MODE(numero),
                    &mut devmode,
                    ENUM_DISPLAY_SETTINGS_FLAGS(0),
                )
            };
            if !hay.as_bool() {
                break;
            }
            // `dmDisplayFlags` vive en una union: leerla es legal porque para un dispositivo
            // de pantalla esa rama es la que llena Windows (la otra, `dmNup`, es de impresora).
            let flags = unsafe { devmode.Anonymous2.dmDisplayFlags };
            if let Some(modo) = modo_de_devmode(
                devmode.dmPelsWidth,
                devmode.dmPelsHeight,
                devmode.dmDisplayFrequency,
                flags & DM_INTERLACED != 0,
            ) {
                modos.push(modo);
            }
        }
        modos
    }
}

#[cfg(target_os = "windows")]
mod estado {
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use monarch::{
        copy_name, Accion, AudioTarget, Layout, ManagerError, MonarchDisplayManager, PerfilAcciones,
        Profile,
    };

    use super::acciones;
    use super::audio;
    use super::backend::SystemDisplayBackend;
    use super::escenas;
    use super::ids::{format_display_id, parse_display_id};
    use super::cola;
    use super::modos;
    use super::store::MillenniumConfigStore;
    use super::watchdog::{self, Desenlace};
    use super::{
        diagnostics, mark_can_detach, ActionView, AudioView, DisplayModesView, DisplayView,
        DisplaysSnapshot, Emisor, PendingView, PosicionView, ProfileActionsView, ProfileView,
        SceneDraft, SceneView, ScenesResult, SettingsView, EVENTO_AUDIO, EVENTO_CAMBIO,
        EVENTO_CONFIRMACION, EVENTO_ESCENAS, FORCE_MOCK_ENV,
    };

    type Manager = MonarchDisplayManager<SystemDisplayBackend, MillenniumConfigStore>;

    /// Plazo de gracia si el manager no supiera decir cuánto falta. No debería
    /// pasar (siempre hay pendiente después de un apply exitoso), pero un
    /// watchdog sin plazo sería un watchdog que no arranca.
    const PLAZO_DE_EMERGENCIA: Duration = Duration::from_secs(10);

    pub struct Interno {
        manager: Mutex<Manager>,
        emisor: Emisor,
        /// `true` cuando se está corriendo contra monitores de mentira.
        mock: bool,
        /// Audio por perfil (Displays v2, Fase 3): el default de audio que había
        /// ANTES de aplicar un perfil con salida asignada. Estado paralelo a la
        /// confirmación de video del vendor (que NO conoce el audio): se captura
        /// al aplicar con red, se restaura en el revert (manual o por timeout) y
        /// se descarta al confirmar. `None` = no hay nada que revertir.
        ///
        /// **Por qué no lleva etiqueta de generación** (a diferencia del pending
        /// de video, que el manager blinda por vencimiento): el manager sostiene
        /// UNA sola confirmación a la vez — un apply nuevo exige resolver el
        /// anterior primero. Por eso este slot siempre corresponde al pending vivo
        /// (o es `None`). Un watchdog viejo, cuando despierta, o no encuentra
        /// pendiente (→ `NadaQueHacer`, no toca el slot) o duerme hasta el
        /// vencimiento REAL del pending vivo y recién ahí actúa — momento en que
        /// restaurar/descartar este slot es lo correcto para ESE pending. No hay
        /// interleaving que meta acá el previo de otro apply. (Ver `watchdog.rs`,
        /// "Un watchdog viejo no puede pisar un apply nuevo".)
        audio_previo: Mutex<Option<audio::AudioPrevio>>,
        /// La escena (perfil) actualmente puesta y **committeada** (Displays v2,
        /// Fase 4). Sirve para correr su SALIDA cuando se pasa a otra escena
        /// (modelo "ida y vuelta"). Nace `None`: al reiniciar la app NO se corre la
        /// limpieza de lo que hubiera quedado abierto (aceptado por Guido).
        escena_activa: Mutex<Option<String>>,
        /// La escena que se aplicó **con red** y espera confirmación. Se consume en
        /// `confirm` (ahí recién queda committeada y corre su ciclo) o se descarta
        /// en revert/timeout SIN correr nada. Mismo molde y misma justificación de
        /// "sin etiqueta de generación" que `audio_previo`: el manager sostiene UNA
        /// sola confirmación viva a la vez, así que este slot siempre corresponde
        /// al pending vivo (o es `None`).
        escena_pendiente: Mutex<Option<String>>,
        /// Las acciones de las escenas corren acá, en fila y en su hilo (encargo 03): `confirm`
        /// avisa antes de encolar y no espera a un Esperar.
        cola: cola::Cola,
    }

    /// El handle que se guarda en Tauri y se clona hacia los hilos.
    ///
    /// Es `Arc` y no un `State<'_>` prestado a propósito: el trabajo pesado
    /// corre en `spawn_blocking` y el watchdog en un hilo propio, y los dos
    /// necesitan quedarse con el estado más allá del comando que los lanzó.
    #[derive(Clone)]
    pub struct DisplaysState(Arc<Interno>);

    /// Arranca el motor. **Nunca es fatal**: si esto devuelve `Err`, `lib.rs` lo
    /// loguea y Millennium sigue andando sin la sección de monitores.
    pub fn init(data_dir: &Path, emisor: Emisor) -> Result<DisplaysState, String> {
        let mock = std::env::var_os(FORCE_MOCK_ENV).is_some();
        let backend = SystemDisplayBackend::new().map_err(|e| e.to_string())?;
        let store = MillenniumConfigStore::new(data_dir).map_err(|e| e.to_string())?;
        if store.loaded_from_corrupt() {
            crate::runtime_log::err(
                "[displays] la config de displays no parseaba; se respaldó y se arrancó con los valores por defecto",
            );
        }
        diagnostics::log(format!("init:store={}", store.config_path().display()));

        let manager = MonarchDisplayManager::new(backend, store).map_err(|e| e.to_string())?;
        let estado = DisplaysState(Arc::new(Interno {
            manager: Mutex::new(manager),
            emisor,
            mock,
            audio_previo: Mutex::new(None),
            escena_activa: Mutex::new(None),
            escena_pendiente: Mutex::new(None),
            cola: cola::Cola::nueva(acciones::EjecutorReal, cola::RelojReal::nuevo()),
        }));

        // La ventana oculta cablea DOS reacciones distintas:
        //  - resume: al despertar la máquina, tirar el cache (los LUID cambian).
        //  - cambio de topología (WM_DISPLAYCHANGE): refrescar la vista SIN tocar
        //    el cache. Son canales separados a propósito: invalidar ante un cambio
        //    borraría el recuerdo del monitor detachado. Solo el resume invalida.
        let para_el_resume = estado.clone();
        let para_el_cambio = estado.clone();
        super::system_events::spawn(
            Box::new(move || para_el_resume.al_despertar()),
            Box::new(move || para_el_cambio.al_cambiar_displays()),
        );

        // Al arrancar, los modos de las pantallas prendidas. En un hilo aparte para no
        // demorar el arranque: no hace falta para nada de lo que sigue.
        let para_los_modos = estado.clone();
        std::thread::spawn(move || {
            para_los_modos.anotar_modos();
        });

        Ok(estado)
    }

    impl DisplaysState {
        // --- lectura ---------------------------------------------------------

        /// La foto que va al frontend, con el estado de la confirmación pendiente.
        pub fn snapshot(&self) -> Result<DisplaysSnapshot, String> {
            let mut foto = self.foto_cruda()?;
            foto.pending = self.pendiente();
            Ok(foto)
        }

        /// La foto SIN el pendiente.
        ///
        /// En Windows sale de una **enumeración fresca de la CCD API**, no del
        /// cache del motor: es a propósito. Esta misma función es la que verifica
        /// que un apply haya hecho lo que decía, y verificar contra el cache
        /// propio sería preguntarle al acusado.
        fn foto_cruda(&self) -> Result<DisplaysSnapshot, String> {
            if self.0.mock {
                return self.foto_del_manager();
            }
            super::snapshot()
        }

        /// En modo mentira la foto sale del manager, para que el ensayo del
        /// attach/detach se vea reflejado en la lista. (El camino de lectura de
        /// la Fase 1 devuelve monitores fijos, que nunca cambiarían.)
        fn foto_del_manager(&self) -> Result<DisplaysSnapshot, String> {
            let guard = self.0.manager.lock().map_err(|_| envenenado())?;
            let displays = guard.list_displays().map_err(|e| e.to_string())?;
            let layout = guard.get_layout().map_err(|e| e.to_string())?;
            drop(guard);
            Ok(DisplaysSnapshot {
                source: "mock",
                displays: vistas_del_modelo(&displays, &layout),
                pending: None,
            })
        }

        fn pendiente(&self) -> Option<PendingView> {
            let guard = self.0.manager.lock().ok()?;
            let restante = guard.pending_confirmation_remaining()?;
            Some(PendingView {
                remaining_ms: restante.as_millis() as u64,
                is_test: guard.pending_is_test(),
            })
        }

        // --- apply -----------------------------------------------------------

        /// Prende o apaga un monitor, con la red puesta.
        ///
        /// El orden importa y es el de la doctrina CCD:
        /// 1. Se mira el estado actual para saber qué se está pidiendo.
        /// 2. Se aplica (el manager guarda el layout anterior y arranca el plazo).
        /// 3. **Se verifica RE-ENUMERANDO**, nunca por el código que devolvió
        ///    Windows: un `SetDisplayConfig` que no cambió nada devuelve éxito.
        /// 4. Si no pasó lo que se pidió, se revierte **en el acto** — dejar una
        ///    configuración a medias armada esperando diez segundos es peor.
        /// 5. Recién con el cambio confirmado por enumeración se arma el watchdog.
        pub fn toggle(&self, display_id: &str) -> Result<DisplaysSnapshot, String> {
            let id = parse_display_id(display_id)?;

            let antes = self.foto_cruda()?;
            let estaba_activo = antes
                .displays
                .iter()
                .find(|v| v.id == display_id)
                .map(|v| v.active)
                .ok_or_else(|| {
                    format!("ese monitor ya no está en la lista (id {display_id}) — refrescá")
                })?;
            let se_quiere_activo = !estaba_activo;

            let plazo = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.toggle_display(&id).map_err(|e| e.to_string())?;
                guard
                    .pending_confirmation_remaining()
                    .unwrap_or(PLAZO_DE_EMERGENCIA)
            };

            // ---------------------------------------------------------------
            // A PARTIR DE ACÁ EL CAMBIO YA ESTÁ APLICADO.
            //
            // Regla de este bloque: **ninguna salida puede irse sin dejar armado
            // el watchdog**, salvo que la confirmación pendiente ya no exista.
            // Por eso no hay un solo `?` de acá abajo: un `?` sería un `return`
            // silencioso que deja el cambio puesto y a nadie persiguiéndolo, que
            // es literalmente el bug que esta fase viene a matar.
            // ---------------------------------------------------------------

            // --- la verificación que la doctrina exige: RE-ENUMERAR ---
            let despues = match self.foto_cruda() {
                Ok(foto) => foto,
                Err(err) => {
                    // No se pudo mirar cómo quedó. Pasa de verdad: justo después
                    // de mover la topología, la CCD API puede rebotar mientras el
                    // stack de video se asienta.
                    //
                    // Sin verificación no se puede afirmar que el cambio salió
                    // bien, así que se hace lo conservador: se deja la red puesta.
                    // Si el usuario ve su pantalla como quería, confirma y listo;
                    // si no, en unos segundos vuelve sola.
                    crate::runtime_log::warn(format!(
                        "[displays] no se pudo verificar cómo quedó ({err}); el watchdog queda armado, así que si no confirmás vuelve solo"
                    ));
                    self.armar_watchdog(plazo);
                    self.avisar_confirmacion(serde_json::json!({
                        "kind": "applied",
                        "timeoutMs": plazo.as_millis() as u64,
                    }));
                    self.avisar_cambio();
                    return Err(format!(
                        "el cambio se aplicó pero no se pudo verificar cómo quedó ({err}). Si la pantalla está bien, confirmá; si no, esperá y vuelve sola."
                    ));
                }
            };
            let quedo_activo = despues
                .displays
                .iter()
                .find(|v| v.id == display_id)
                .map(|v| v.active);

            if quedo_activo != Some(se_quiere_activo) {
                let que_paso = match quedo_activo {
                    Some(v) => format!("quedó active={v}"),
                    None => "desapareció de la enumeración".to_string(),
                };
                crate::runtime_log::err(format!(
                    "[displays] el cambio NO tomó efecto: se pidió active={se_quiere_activo} y {que_paso}. Revirtiendo ya."
                ));
                // Sin `?`: ver la regla del bloque de arriba. Si ni siquiera se
                // puede tomar el lock, se trata como "el rollback falló" y sigue
                // por la rama que deja el watchdog armado.
                let detalle_rollback = match self.0.manager.lock() {
                    Ok(mut guard) => guard.rollback_pending().err().map(|e| e.to_string()),
                    Err(_) => Some(envenenado()),
                };
                self.avisar_cambio();
                return Err(match detalle_rollback {
                    None => {
                        self.avisar_confirmacion(serde_json::json!({
                            "kind": "reverted",
                            "reason": "error",
                            "detail": "el cambio no tomó efecto",
                        }));
                        format!(
                            "Windows aceptó el cambio pero el monitor {que_paso}. Se revirtió solo."
                        )
                    }
                    Some(err) => {
                        // La vuelta atrás inmediata falló. El manager CONSERVA la
                        // confirmación pendiente cuando eso pasa (no la tira), así
                        // que todavía hay algo que revertir — y si nos fuéramos
                        // acá, nadie lo perseguiría nunca y el layout malo quedaría
                        // pegado. Se arma el watchdog igual: es exactamente el
                        // escenario para el que existe.
                        crate::runtime_log::err(format!(
                            "[displays] la vuelta atrás inmediata falló ({err}); queda el watchdog persiguiéndola"
                        ));
                        self.armar_watchdog(plazo);
                        self.avisar_confirmacion(serde_json::json!({
                            "kind": "applied",
                            "timeoutMs": plazo.as_millis() as u64,
                        }));
                        format!(
                            "Windows aceptó el cambio pero el monitor {que_paso}, y la vuelta atrás inmediata también falló: {err}. Se sigue intentando revertir solo."
                        )
                    }
                });
            }

            self.armar_watchdog(plazo);
            self.avisar_confirmacion(serde_json::json!({
                "kind": "applied",
                "timeoutMs": plazo.as_millis() as u64,
            }));
            self.avisar_cambio();

            let mut foto = despues;
            foto.pending = self.pendiente();
            Ok(foto)
        }

        /// El usuario dice "así está bien": se cancela el auto-rollback.
        pub fn confirm(&self) -> Result<DisplaysSnapshot, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.confirm_current_layout().map_err(|e| e.to_string())?;
            }
            // El usuario aceptó: el audio nuevo se queda, ya no hay rollback.
            self.olvidar_audio_previo();
            // Recién ACÁ el cambio con red queda committeado ⇒ correr el ciclo de la
            // escena que estaba pendiente (SALIDA anterior + ENTRADA nueva).
            // La escena queda activa ACÁ; sus acciones se encolan recién después del aviso.
            let acciones = self.confirmar_escena_pendiente();
            diagnostics::log("confirm:el_usuario_confirmo");
            self.avisar_confirmacion(serde_json::json!({ "kind": "confirmed" }));
            self.avisar_cambio();
            self.0.cola.encolar(acciones);
            self.snapshot()
        }

        /// El usuario dice "volvé atrás" sin esperar a que venza el plazo.
        pub fn revert(&self) -> Result<DisplaysSnapshot, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.rollback_pending().map_err(|e| e.to_string())?;
            }
            // El video volvió: el audio también (el perfil es una unidad).
            self.restaurar_audio_previo();
            // El cambio NO se committeó ⇒ ninguna acción debe correr: descartar la
            // escena pendiente (criterio 7).
            self.descartar_escena_pendiente();
            diagnostics::log("revert:a_pedido_del_usuario");
            self.avisar_confirmacion(serde_json::json!({
                "kind": "reverted",
                "reason": "manual",
            }));
            self.avisar_cambio();
            self.snapshot()
        }

        /// Hace primario un monitor **activo**, con la red puesta (es un
        /// `SetDisplayConfig`, igual que el detach o el lienzo).
        ///
        /// El monitor se ubica por `(placa, target)`, NO por el id con EDID (que
        /// a veces se lee `None`) — mismo criterio que el lienzo. Solo se marca
        /// `primary=true` en ese output y `false` en los demás; **el reanclado
        /// del primario en (0,0) lo hace `apply_layout` por su cuenta**
        /// (`normalize_primary` en el vendor). Sigue el patrón de `aplicar_layout`:
        /// si nada cambia (ya era primario), es no-op sin cuenta regresiva.
        pub fn hacer_primario(&self, display_id: &str) -> Result<DisplaysSnapshot, String> {
            let id = parse_display_id(display_id)?;

            let plazo = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut layout = guard.get_layout().map_err(|e| e.to_string())?;

                let idx = layout
                    .outputs
                    .iter()
                    .position(|o| {
                        o.display_id.adapter_luid == id.adapter_luid
                            && o.display_id.target_id == id.target_id
                    })
                    .ok_or_else(|| {
                        format!("ese monitor ya no está en la lista (id {display_id}) — refrescá")
                    })?;

                // Un monitor apagado no puede ser primario. La guarda existe por
                // duplicado a propósito: acá y en la UI (que no ofrece el botón
                // en una fila detachada), como con `can_detach`.
                if !layout.outputs[idx].enabled {
                    return Err(
                        "ese monitor está apagado; prendelo antes de hacerlo primario".to_string(),
                    );
                }

                if layout.outputs[idx].primary {
                    // Ya es primario: no gastar un apply ni una cuenta regresiva.
                    None
                } else {
                    for (i, output) in layout.outputs.iter_mut().enumerate() {
                        output.primary = i == idx;
                    }
                    guard.apply_layout(layout).map_err(|e| e.to_string())?;
                    // A partir de acá el cambio está aplicado: como en el toggle y
                    // el lienzo, el plazo siempre queda Some para que el watchdog
                    // SÍ arranque.
                    Some(
                        guard
                            .pending_confirmation_remaining()
                            .unwrap_or(PLAZO_DE_EMERGENCIA),
                    )
                }
            };

            match plazo {
                None => {
                    diagnostics::log("primario:sin_cambios");
                    self.avisar_cambio();
                    self.snapshot()
                }
                Some(plazo) => self.aplicar_con_red(plazo),
            }
        }

        // --- perfiles --------------------------------------------------------

        /// Lista los perfiles guardados (nombre + resumen legible + su atajo).
        pub fn listar_perfiles(&self) -> Result<Vec<ProfileView>, String> {
            let guard = self.0.manager.lock().map_err(|_| envenenado())?;
            let perfiles = guard.list_profiles();
            // El atajo, la salida de audio y las acciones de cada perfil viven en
            // `AppSettings` (por nombre), no en el `Profile`; se cruzan acá.
            let atajos = guard.settings().profile_shortcuts.clone();
            let audios = guard.settings().profile_audio.clone();
            let acciones = guard.settings().profile_actions.clone();
            drop(guard);
            Ok(perfiles
                .iter()
                .map(|p| vista_de_perfil(p, &atajos, &audios, &acciones))
                .collect())
        }

        /// Guarda el layout actual con un nombre. Si el nombre ya existe, el
        /// manager lo pisa; la confirmación de "vas a pisar 'X'" es del frontend,
        /// que es donde el usuario ve la lista. Devuelve la lista actualizada.
        pub fn guardar_perfil(
            &self,
            nombre: &str,
            reemplazar: bool,
        ) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard
                    .save_profile(nombre, reemplazar)
                    .map_err(mensaje_de)?;
            }
            diagnostics::log("perfil:guardado");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        /// Borra un perfil por nombre. La confirmación es del frontend.
        ///
        /// Al borrar se limpia también **su atajo** de `profile_shortcuts` (si no,
        /// queda un hotkey global apuntando a un perfil que ya no existe) y, si el
        /// perfil borrado era el de arranque, se limpia `startup_profile_name`
        /// (si no, el startup quedaría apuntando a la nada). Esto NO desregistra
        /// el hotkey del sistema operativo: eso lo hace `lib.rs` re-sincronizando
        /// tras el borrado (acá no se conoce a Tauri ni al plugin).
        pub fn borrar_perfil(&self, nombre: &str) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.delete_profile(nombre).map_err(mensaje_de)?;
                let mut ajustes = guard.settings().clone();
                let mut cambio = ajustes.profile_shortcuts.remove(nombre).is_some();
                // Limpiar también la salida de audio del perfil borrado, para no
                // dejar una entrada huérfana en profile_audio (igual que el atajo).
                if ajustes.profile_audio.remove(nombre).is_some() {
                    cambio = true;
                }
                // Ídem las acciones (Fase 4): no dejar escena huérfana.
                if ajustes.profile_actions.remove(nombre).is_some() {
                    cambio = true;
                }
                // Ídem el emoji (módulo escenas).
                if ajustes.profile_icons.remove(nombre).is_some() {
                    cambio = true;
                }
                if ajustes.startup_profile_name.as_deref() == Some(nombre) {
                    ajustes.startup_profile_name = None;
                    cambio = true;
                }
                if cambio {
                    guard.update_settings(ajustes).map_err(|e| e.to_string())?;
                }
            }
            // Si el perfil borrado era la escena activa/pendiente, olvidar ese
            // estado (fuera del lock del manager: toca otros mutex).
            self.olvidar_escena_si_es(nombre);
            diagnostics::log("perfil:borrado");
            self.avisar_escenas("deleted");
            self.listar_perfiles()
        }

        /// Asigna (o reemplaza) el atajo global de un perfil, persistiéndolo en
        /// `profile_shortcuts`. Devuelve la lista al día (con el atajo nuevo).
        ///
        /// Acá SOLO se persiste; el registro del hotkey en el sistema operativo
        /// lo hace `lib.rs` re-sincronizando después (el estado no toca Tauri).
        /// `update_settings` del vendor descarta entradas con nombre o atajo
        /// vacío, así que un `accel` en blanco no se guarda.
        pub fn asignar_atajo(&self, nombre: &str, accel: &str) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                // Rechazar una combinación ya asignada a OTRO perfil: un mismo
                // hotkey no puede aplicar dos perfiles. Se decide acá (dato puro)
                // para dar un mensaje claro, en vez del genérico "la usa otro
                // programa" que daría el rollback por conflicto del sistema.
                let accel_norm = accel.trim();
                if let Some(otro) = guard
                    .settings()
                    .profile_shortcuts
                    .iter()
                    .find(|(n, a)| n.as_str() != nombre && a.trim().eq_ignore_ascii_case(accel_norm))
                    .map(|(n, _)| n.clone())
                {
                    return Err(format!("esa combinación ya está asignada al perfil «{otro}»"));
                }
                let mut ajustes = guard.settings().clone();
                ajustes
                    .profile_shortcuts
                    .insert(nombre.to_string(), accel.to_string());
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("atajo:asignado");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        /// Quita el atajo global de un perfil (si tenía). Devuelve la lista al
        /// día. Ídem `asignar_atajo`: la desregistración en el SO la hace `lib.rs`.
        pub fn limpiar_atajo(&self, nombre: &str) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                ajustes.profile_shortcuts.remove(nombre);
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("atajo:limpiado");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        /// Carga un perfil: aplica su layout **con la red puesta**.
        ///
        /// Cargar es un `SetDisplayConfig`, así que pasa por la MISMA red que el
        /// detach de la TV. `apply_profile` puede ser un no-op (si el perfil ya es
        /// el layout actual): en ese caso no hay confirmación pendiente y no hay
        /// nada que revertir ni perseguir.
        pub fn cargar_perfil(&self, nombre: &str) -> Result<DisplaysSnapshot, String> {
            let (plazo, deseado) = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let deseado = layout_del_perfil(&guard, nombre);
                guard.apply_profile(nombre).map_err(|e| e.to_string())?;
                // Si `apply_profile` aplicó de verdad, dejó una confirmación
                // pendiente; si el perfil ya era el layout actual, no.
                (guard.pending_confirmation_remaining(), deseado)
            };

            match plazo {
                // No-op de video: el perfil ya era el layout actual. Pero igual
                // puede faltar mandar el sonido a la salida del perfil (el "botón
                // único" solo-audio). Sin cuenta regresiva ⇒ el audio se aplica y
                // queda directo (no hay rollback de audio en esta rama).
                None => {
                    self.aplicar_audio_de_perfil(nombre, false);
                    // Commit inmediato ⇒ el ciclo de escena corre ACÁ (después de la
                    // foto y el audio): SALIDA de la escena anterior + ENTRADA de esta.
                    self.correr_ciclo_de_escena(nombre);
                    diagnostics::log("perfil:cargado:sin_cambios");
                    self.avisar_cambio();
                    self.snapshot()
                }
                // Video con red: aplicar el audio y dejar el previo capturado para
                // que el watchdog lo devuelva si nadie confirma el cambio.
                Some(plazo) => {
                    self.aplicar_audio_de_perfil(nombre, true);
                    // Con red: las acciones NO corren todavía. Se dejan pendientes y
                    // corren en `confirm` (si el cambio se auto-revierte, no corren).
                    self.marcar_escena_pendiente(nombre);
                    let avisos = self.avisos_de_resolucion(deseado.as_ref());
                    self.aplicar_con_red_avisando(plazo, avisos)
                }
            }
        }

        /// Aplica un perfil **directo, sin la red** (Displays v2, Fase 1).
        ///
        /// Es la vía del **perfil de arranque** y de los **atajos**: se aplicó a
        /// propósito, sin nadie mirando, así que no hay cuenta regresiva ni
        /// auto-revert — un commit inmediato. Si el perfil ya es el layout actual,
        /// `apply_profile` es no-op y no queda nada que confirmar (criterio 3: "si
        /// ya coincide, no hace nada"); por eso el `confirm_current_layout` va
        /// **solo si quedó algo pendiente** (si no, tiraría `NoPendingConfirmation`).
        ///
        /// El lock se sostiene a través del apply + confirm, que son CCD
        /// bloqueantes SIN `.await` (esta función corre en `spawn_blocking`): la
        /// regla de "nunca un lock a través de un `.await`" se cumple por
        /// construcción, igual que en `toggle`.
        pub fn aplicar_perfil_directo(&self, nombre: &str) -> Result<(), String> {
            // `Some(plazo)` = el apply se hizo pero el commit inmediato falló. En
            // ese caso NO se puede dejar el pending colgado: `confirm_current_layout`
            // lo deja Some si `get_layout` rebota, y un pending sin watchdog congela
            // TODO apply futuro (ensure_no_pending_confirmation). Se cae a la red
            // como último recurso para que el pending se resuelva.
            let deseado;
            let red_de_emergencia = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                deseado = layout_del_perfil(&guard, nombre);
                guard.apply_profile(nombre).map_err(|e| e.to_string())?;
                if !guard.has_pending_confirmation() {
                    // No-op: el perfil ya era el layout actual. Nada que commitear.
                    None
                } else {
                    // Commit inmediato (sin red). `confirm_current_layout` re-lee el
                    // layout, que puede rebotar justo después de un SetDisplayConfig.
                    match guard.confirm_current_layout() {
                        Ok(()) => None,
                        Err(e) => {
                            let plazo = guard
                                .pending_confirmation_remaining()
                                .unwrap_or(PLAZO_DE_EMERGENCIA);
                            crate::runtime_log::warn(format!(
                                "[displays] perfil «{nombre}» aplicado pero no se pudo commitear ({e}); queda la red persiguiéndolo"
                            ));
                            Some(plazo)
                        }
                    }
                }
            };

            match red_de_emergencia {
                None => {
                    // Commit inmediato (perfil de arranque / atajo global): el audio
                    // se aplica y se queda; sin auto-revert de video, no hay previo
                    // que capturar (hay_red=false).
                    self.aplicar_audio_de_perfil(nombre, false);
                    // Commit inmediato ⇒ el ciclo de escena corre ACÁ.
                    self.correr_ciclo_de_escena(nombre);
                    diagnostics::log("perfil:aplicado_directo");
                    // Sin cartel (atajo / arranque): si Windows puso otra resolución, el
                    // aviso queda en el log (`avisos_de_resolucion` lo escribe).
                    self.avisos_de_resolucion(deseado.as_ref());
                    self.avisar_cambio();
                    Ok(())
                }
                // El apply SÍ ocurrió pero no se pudo commitear: se arma la red para
                // que el pending se resuelva (si nadie confirma, el watchdog revierte)
                // en vez de dejar el subsistema congelado en silencio. Acá el video
                // SÍ puede auto-revertirse ⇒ capturar el audio previo (hay_red=true).
                Some(plazo) => {
                    self.aplicar_audio_de_perfil(nombre, true);
                    // Cae a la red ⇒ el video puede auto-revertirse: las acciones
                    // quedan pendientes y corren en `confirm`, no acá.
                    self.marcar_escena_pendiente(nombre);
                    let avisos = self.avisos_de_resolucion(deseado.as_ref());
                    self.aplicar_con_red_avisando(plazo, avisos).map(|_| ())
                }
            }
        }

        // --- escenas en papel (módulo escenas, encargo 01) -------------------

        /// Lo que hace falta para armar vistas, leído de una vez con el lock corto.
        fn insumos_de_escenas(&self) -> Result<InsumosEscenas, String> {
            let guard = self.0.manager.lock().map_err(|_| envenenado())?;
            Ok(InsumosEscenas {
                perfiles: guard.list_profiles(),
                ajustes: guard.settings().clone(),
                huellas: guard.config().display_fingerprints.clone(),
                // Solo los borradores la necesitan: la lista y las respuestas de guardado no
                // pueden fallar porque Windows rebote justo después de un cambio.
                actual: guard.get_layout().map_err(|e| e.to_string()),
                infos: guard.list_displays().unwrap_or_default(),
            })
        }

        /// La lista nueva de la pestaña ESCENAS, en el orden de Guido.
        pub fn listar_escenas(&self) -> Result<Vec<SceneView>, String> {
            let i = self.insumos_de_escenas()?;
            let activa = self.0.escena_activa.lock().ok().and_then(|g| g.clone());
            Ok(i.perfiles
                .iter()
                .map(|p| {
                    escenas::vista_de_escena(p, &i.ajustes, &i.huellas, &i.infos, activa.as_deref())
                })
                .collect())
        }

        /// Arma un borrador SIN tocar nada: `current`, `blank`, `scene` o `copy`.
        pub fn borrador_de_escena(
            &self,
            desde: &str,
            nombre: Option<&str>,
        ) -> Result<SceneDraft, String> {
            let i = self.insumos_de_escenas()?;
            let actual = i.actual.as_ref().map_err(|e| e.clone())?;
            match desde {
                "current" => Ok(escenas::borrador_actual(actual, &i.huellas, &i.infos)),
                "blank" => Ok(escenas::borrador_en_blanco(actual, &i.huellas, &i.infos)),
                "scene" => {
                    let perfil = buscar_escena(&i.perfiles, nombre)?;
                    Ok(escenas::borrador_de_escena(
                        perfil, &i.ajustes, actual, &i.huellas, &i.infos,
                    ))
                }
                "copy" => {
                    let perfil = buscar_escena(&i.perfiles, nombre)?;
                    let copia = copy_name(&perfil.name, &i.perfiles);
                    Ok(escenas::borrador_de_copia(
                        perfil, &i.ajustes, actual, &i.huellas, &i.infos, copia,
                    ))
                }
                _ => Err("no sé de dónde armar la escena".to_string()),
            }
        }

        /// GUARDAR un borrador (crear o editar), en un solo guardado y sin tocar ninguna
        /// pantalla. Si el nombre cambió es además un renombre: la escena activa/pendiente
        /// en memoria sigue a su nombre nuevo. Registrar el atajo es cosa del comando.
        pub fn guardar_escena(
            &self,
            borrador: SceneDraft,
            original: Option<String>,
        ) -> Result<ScenesResult, String> {
            let datos = escenas::datos_de_borrador(&borrador)?;
            // Antes que la resolución: una confirmación pendiente y la escena que ya no existe
            // tienen que decir lo suyo (si no, los taparía "no reporta…").
            let original_layout = {
                let guard = self.0.manager.lock().map_err(|_| envenenado())?;
                if guard.has_pending_confirmation() {
                    return Err(if guard.pending_is_test() {
                        monarch::PRUEBA_PENDIENTE.to_string()
                    } else {
                        mensaje_de(ManagerError::ConfirmationPending)
                    });
                }
                original.as_deref().map(|o| layout_del_perfil(&guard, o))
            };
            // Solo modos que la pantalla reportó (o "Dejar la que tenga"). Lee Windows fuera
            // del lock; la escena original se busca por su nombre de antes de editar. Si la
            // borraron mientras se editaba, la validación no corre: `upsert_scene` da el error.
            if !matches!(original_layout, Some(None)) {
                let pantallas = self.pantallas_con_modos()?;
                modos::validar_resoluciones(
                    &datos.layout,
                    original_layout.flatten().as_ref(),
                    &pantallas,
                )?;
            }
            let nombre = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard
                    .upsert_scene(original.as_deref(), datos)
                    .map_err(mensaje_de)?
            };
            let renombrada = original.as_deref().is_some_and(|o| o != nombre);
            if let Some(vieja) = original.as_deref().filter(|o| *o != nombre) {
                self.renombrar_escena_viva(vieja, &nombre);
            }
            diagnostics::log("escena:guardada");
            self.avisar_escenas(if renombrada { "renamed" } else { "saved" });
            Ok(ScenesResult {
                scenes: self.listar_escenas()?,
                name: Some(nombre),
                warnings: Vec::new(),
            })
        }

        /// RENOMBRAR: mueve atajo, sonido, acciones, emoji y arranque en un solo guardado.
        pub fn renombrar_escena(&self, nombre: &str, nuevo: &str) -> Result<ScenesResult, String> {
            let final_ = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.rename_scene(nombre, nuevo).map_err(mensaje_de)?
            };
            if final_ != nombre {
                self.renombrar_escena_viva(nombre, &final_);
                diagnostics::log("escena:renombrada");
                self.avisar_escenas("renamed");
            }
            Ok(ScenesResult {
                scenes: self.listar_escenas()?,
                name: Some(final_),
                warnings: Vec::new(),
            })
        }

        /// DUPLICAR: copia sin atajo ni arranque, al final de la lista.
        pub fn duplicar_escena(&self, nombre: &str) -> Result<ScenesResult, String> {
            let copia = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.duplicate_scene(nombre).map_err(mensaje_de)?
            };
            diagnostics::log("escena:duplicada");
            self.avisar_escenas("duplicated");
            Ok(ScenesResult {
                scenes: self.listar_escenas()?,
                name: Some(copia),
                warnings: Vec::new(),
            })
        }

        /// ↑/↓ y arrastrar: `nombres` tiene que ser exactamente el conjunto de hoy.
        pub fn reordenar_escenas(&self, nombres: Vec<String>) -> Result<ScenesResult, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                guard.reorder_scenes(&nombres).map_err(mensaje_de)?;
            }
            diagnostics::log("escena:reordenadas");
            self.avisar_escenas("reordered");
            Ok(ScenesResult {
                scenes: self.listar_escenas()?,
                name: None,
                warnings: Vec::new(),
            })
        }

        /// PROBAR un borrador: aplica pantallas y sonido con la red de siempre, pero NO escribe
        /// escenas, NO corre acciones y NO marca `escena_pendiente` ni `escena_activa`.
        pub fn probar_borrador(&self, borrador: SceneDraft) -> Result<DisplaysSnapshot, String> {
            let layout = escenas::layout_de_salidas(&borrador.outputs)?;
            if layout.enabled_output_count() == 0 {
                return Err("tiene que quedar al menos una pantalla prendida".to_string());
            }
            let audio_del_borrador = borrador.audio.as_ref().map(|a| AudioTarget {
                endpoint_id: a.endpoint_id.clone(),
                friendly_name: a.friendly_name.clone(),
            });

            let plazo = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                // Antes de tocar Windows: una pantalla prendida que no está conectada.
                let faltan = guard
                    .unresolved_enabled_outputs(&layout)
                    .map_err(|e| e.to_string())?;
                if let Some(falta) = faltan.first() {
                    let nombre = borrador
                        .outputs
                        .iter()
                        .zip(layout.outputs.iter())
                        .find(|(_, l)| &l.display_id == falta)
                        .map(|(o, _)| {
                            if o.name.trim().is_empty() {
                                o.display_id.clone()
                            } else {
                                o.name.clone()
                            }
                        })
                        .unwrap_or_else(|| format_display_id(falta));
                    return Err(format!(
                        "{nombre} no está conectada: conectala o apagala en la escena para probar"
                    ));
                }
                guard.apply_draft(layout.clone()).map_err(mensaje_de)?;
                guard.pending_confirmation_remaining()
            };
            let avisos = match plazo {
                Some(_) => self.avisos_de_resolucion(Some(&layout)),
                None => Vec::new(),
            };

            // El sonido de una PRUEBA solo se cambia cuando hay cuenta regresiva que lo devuelva:
            // si las pantallas ya estaban así, no hay nada pendiente y un cambio de sonido
            // quedaría para siempre con el borrador sin guardar. Se avisa en el log.
            if let Some(objetivo) = &audio_del_borrador {
                if plazo.is_some() {
                    self.aplicar_audio_objetivo(&borrador.name, objetivo, true);
                } else {
                    crate::runtime_log::info(
                        "[displays] la prueba no cambia el sonido: las pantallas ya estaban así y no hay cuenta regresiva que lo devuelva",
                    );
                }
            }
            diagnostics::log("escena:probada");
            match plazo {
                Some(plazo) => self.aplicar_con_red_avisando(plazo, avisos),
                None => {
                    self.avisar_cambio();
                    self.snapshot()
                }
            }
        }

        /// Un renombre en memoria: la escena activa/pendiente sigue a su nombre nuevo (así su
        /// "Al salir" y el sello siguen andando). Fuera del lock del manager.
        fn renombrar_escena_viva(&self, vieja: &str, nueva: &str) {
            if let Ok(mut slot) = self.0.escena_activa.lock() {
                if slot.as_deref() == Some(vieja) {
                    *slot = Some(nueva.to_string());
                }
            }
            if let Ok(mut slot) = self.0.escena_pendiente.lock() {
                if slot.as_deref() == Some(vieja) {
                    *slot = Some(nueva.to_string());
                }
            }
        }

        // --- ajustes ---------------------------------------------------------

        /// Lee los ajustes que el frontend puede editar: el plazo del
        /// auto-revert, el perfil de arranque y el interruptor de atajos.
        pub fn leer_ajustes(&self) -> Result<SettingsView, String> {
            let guard = self.0.manager.lock().map_err(|_| envenenado())?;
            let ajustes = guard.settings();
            Ok(SettingsView {
                revert_timeout_secs: ajustes.revert_timeout_secs,
                startup_profile_name: ajustes.startup_profile_name.clone(),
                global_shortcuts_enabled: ajustes.global_shortcuts_enabled,
            })
        }

        /// Guarda los ajustes. Se tocan SOLO los tres campos de `SettingsView`
        /// (plazo, perfil de arranque, interruptor de atajos); el resto de la
        /// config (el mapa `profile_shortcuts`, las bases, `start_with_windows`…)
        /// se **preserva intacto** leyendo lo actual y cambiando solo lo mío.
        /// El nuevo plazo rige desde el próximo apply. `update_settings` del
        /// vendor recorta el `startup_profile_name` (vacío → `None`).
        pub fn guardar_ajustes(&self, nuevos: SettingsView) -> Result<SettingsView, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                ajustes.revert_timeout_secs = nuevos.revert_timeout_secs;
                ajustes.startup_profile_name = nuevos.startup_profile_name;
                ajustes.global_shortcuts_enabled = nuevos.global_shortcuts_enabled;
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("ajustes:guardados");
            self.leer_ajustes()
        }

        /// El interruptor general + el mapa (nombre de perfil → accelerator),
        /// para que `lib.rs` registre los hotkeys globales al arrancar y los
        /// re-sincronice tras cada cambio. No hay nada de Tauri acá: es un
        /// getter de datos puros.
        pub fn atajos_de_perfil(&self) -> Result<(bool, BTreeMap<String, String>), String> {
            let guard = self.0.manager.lock().map_err(|_| envenenado())?;
            let ajustes = guard.settings();
            Ok((
                ajustes.global_shortcuts_enabled,
                ajustes.profile_shortcuts.clone(),
            ))
        }

        // --- lienzo ----------------------------------------------------------

        /// Aplica las posiciones que armó el lienzo de arrastre, **con la red
        /// puesta** (es un `SetDisplayConfig`, igual que el detach de la TV).
        ///
        /// Solo mueve monitores; no prende ni apaga ninguno (eso es la LISTA). Las
        /// posiciones se cruzan por `(adapterLuid, targetId)`, no por el id con
        /// EDID (que puede leerse `None` a veces). Windows exige el primario en
        /// `(0,0)`, así que después de mover se corre todo para que el primario
        /// quede en el origen (los demás pueden tener coordenadas negativas, que
        /// es válido).
        pub fn aplicar_layout(&self, posiciones: Vec<PosicionView>) -> Result<DisplaysSnapshot, String> {
            if posiciones.is_empty() {
                return Err("no llegó ninguna posición para aplicar".to_string());
            }

            let plazo = {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut layout = guard.get_layout().map_err(|e| e.to_string())?;

                // Mover cada monitor a su posición nueva. `cambio` distingue un
                // arrastre real de "lo soltaste donde estaba" (no gastar un apply
                // ni una cuenta regresiva si nada se movió).
                let mut cambio = false;
                for output in layout.outputs.iter_mut() {
                    let luid = output.display_id.adapter_luid.to_string();
                    if let Some(pos) = posiciones
                        .iter()
                        .find(|p| p.adapter_luid == luid && p.target_id == output.display_id.target_id)
                    {
                        if output.position.x != pos.x || output.position.y != pos.y {
                            output.position.x = pos.x;
                            output.position.y = pos.y;
                            cambio = true;
                        }
                    }
                }

                if !cambio {
                    None
                } else {
                    // Anclar el primario en (0,0).
                    if let Some((px, py)) = layout
                        .outputs
                        .iter()
                        .find(|o| o.primary)
                        .map(|o| (o.position.x, o.position.y))
                    {
                        if px != 0 || py != 0 {
                            for output in layout.outputs.iter_mut() {
                                output.position.x -= px;
                                output.position.y -= py;
                            }
                        }
                    }
                    guard.apply_layout(layout).map_err(|e| e.to_string())?;
                    // A partir de acá el cambio está aplicado: como en el toggle,
                    // el plazo siempre queda Some para que el watchdog SÍ arranque.
                    Some(
                        guard
                            .pending_confirmation_remaining()
                            .unwrap_or(PLAZO_DE_EMERGENCIA),
                    )
                }
            };

            match plazo {
                // Nada se movió: no se aplicó, no hay nada que confirmar.
                None => {
                    diagnostics::log("lienzo:sin_cambios");
                    self.avisar_cambio();
                    self.snapshot()
                }
                Some(plazo) => self.aplicar_con_red(plazo),
            }
        }

        // --- la red ----------------------------------------------------------

        /// La red compartida por los apply de **layout completo**: hoy cargar un
        /// perfil, y en el lienzo (Fase 3) el arrastre. **Precondición**: ya se
        /// aplicó un cambio y hay una confirmación pendiente con `plazo` restante.
        ///
        /// Arma el watchdog —que es el auto-revert de verdad: si el usuario no
        /// confirma, vuelve solo— y devuelve la foto fresca. Misma regla dura que
        /// el bloque post-apply de `toggle` (con el que es un paralelo deliberado,
        /// NO compartido, para no tocar el camino de la Fase 2): de acá abajo
        /// **ningún `?`** — ninguna salida se va sin dejar el watchdog armado.
        ///
        /// **A propósito NO compara ids a este nivel.** La verificación por
        /// re-enumeración de un layout completo ya la hace el backend adentro del
        /// apply (`settle_poll`, que conoce el remapeo por EDID). Re-verificar acá
        /// comparando ids es poco fiable y contraproducente: las dos lecturas
        /// frescas usan rutas de enumeración distintas (`get_layout` rellena el
        /// EDID desde el cache, `foto_cruda` usa el crudo) y hay una carrera de
        /// asentado, así que una comparación así daría tanto **falsos negativos**
        /// (un no-op se reporta como éxito) como **falsos positivos** (revertir un
        /// apply que sí anduvo). `toggle` sí compara ids porque su target es UN
        /// monitor conocido del estado pre-apply, leído por la MISMA ruta en ambos
        /// lados; un layout completo no tiene ese lujo. Ante un layout malo, el que
        /// avisa es el usuario (no confirma) y el que revierte es el watchdog.
        fn aplicar_con_red(&self, plazo: Duration) -> Result<DisplaysSnapshot, String> {
            self.aplicar_con_red_avisando(plazo, Vec::new())
        }

        /// Lo mismo, con los avisos de resolución (encargo 02) en el `applied`: Windows puso
        /// otra resolución de la que pidió la escena. Vacío = el aviso de siempre.
        fn aplicar_con_red_avisando(
            &self,
            plazo: Duration,
            avisos: Vec<String>,
        ) -> Result<DisplaysSnapshot, String> {
            let despues = match self.foto_cruda() {
                Ok(foto) => foto,
                Err(err) => {
                    // No se pudo leer cómo quedó (la CCD API rebota mientras el
                    // stack de video se asienta). Lo conservador: dejar la red
                    // puesta. Si el usuario ve su pantalla bien, confirma; si no,
                    // vuelve sola.
                    crate::runtime_log::warn(format!(
                        "[displays] no se pudo leer cómo quedó ({err}); el watchdog queda armado, así que si no confirmás vuelve solo"
                    ));
                    self.armar_watchdog(plazo);
                    self.avisar_confirmacion(self.payload_aplicado(plazo, &avisos));
                    self.avisar_cambio();
                    return Err(format!(
                        "el cambio se aplicó pero no se pudo leer cómo quedó ({err}). Si la pantalla está bien, confirmá; si no, esperá y vuelve sola."
                    ));
                }
            };

            self.armar_watchdog(plazo);
            self.avisar_confirmacion(self.payload_aplicado(plazo, &avisos));
            self.avisar_cambio();

            let mut foto = despues;
            foto.pending = self.pendiente();
            Ok(foto)
        }

        /// El aviso `applied`. Si lo pendiente es una PRUEBA de borrador suma `isTest: true`
        /// (campo opcional: falta = cambio común). Con avisos de resolución suma `warnings`
        /// (lista de textos para Guido; campo opcional: falta = nada que avisar).
        fn payload_aplicado(&self, plazo: Duration, avisos: &[String]) -> serde_json::Value {
            let mut payload = serde_json::json!({
                "kind": "applied",
                "timeoutMs": plazo.as_millis() as u64,
            });
            let es_prueba = self
                .0
                .manager
                .lock()
                .map(|guard| guard.pending_is_test())
                .unwrap_or(false);
            if es_prueba {
                payload["isTest"] = serde_json::Value::Bool(true);
            }
            if !avisos.is_empty() {
                payload["warnings"] = serde_json::json!(avisos);
            }
            payload
        }

        /// Lanza el gatillo del auto-rollback.
        ///
        /// Hilo propio con `thread::sleep`, **no** una tarea de Tokio: el
        /// rollback toma un `std::sync::Mutex` y hace llamadas CCD bloqueantes,
        /// así que la regla "nunca sostener un lock a través de un `.await`" se
        /// cumple por construcción — acá no hay ningún `.await`.
        fn armar_watchdog(&self, plazo: Duration) {
            let estado = self.clone();
            std::thread::spawn(move || {
                watchdog::correr(
                    &estado.0.manager,
                    plazo,
                    &mut std::thread::sleep,
                    &mut |desenlace| estado.reportar_desenlace(desenlace),
                );
            });
        }

        fn reportar_desenlace(&self, desenlace: Desenlace) {
            match desenlace {
                Desenlace::Revertido => {
                    // El watchdog ya revirtió el VIDEO; devolver también el audio.
                    self.restaurar_audio_previo();
                    // No se committeó ⇒ ninguna acción corre (criterio 7).
                    self.descartar_escena_pendiente();
                    crate::runtime_log::warn(
                        "[displays] nadie confirmó el cambio: se revirtió solo",
                    );
                    self.avisar_confirmacion(serde_json::json!({
                        "kind": "reverted",
                        "reason": "timeout",
                    }));
                    self.avisar_cambio();
                }
                // Alguien resolvió la confirmación antes (confirmó o revirtió a
                // mano). Los eventos ya los mandó ese camino; repetirlos acá haría
                // parpadear la UI.
                Desenlace::NadaQueHacer => {}
                Desenlace::NoPudoRevertir(motivo) => {
                    // El VIDEO quedó como está (no se pudo revertir) ⇒ el audio
                    // nuevo también se queda; descartar el previo (nada que revertir).
                    self.olvidar_audio_previo();
                    // El usuario NO confirmó (el watchdog falló al revertir): estado
                    // degradado, no un commit querido ⇒ NO correr acciones; descartar
                    // la escena pendiente. Queda a mano resolver el video.
                    self.descartar_escena_pendiente();
                    crate::runtime_log::err(format!(
                        "[displays] NO se pudo revertir solo: {motivo}. La pantalla quedó como está; revertí a mano."
                    ));
                    self.avisar_confirmacion(serde_json::json!({
                        "kind": "reverted",
                        "reason": "error",
                        "detail": motivo,
                    }));
                    self.avisar_cambio();
                }
            }
        }

        /// Al despertar la máquina: tirar el cache del motor.
        fn al_despertar(&self) {
            let resultado = match self.0.manager.lock() {
                Ok(guard) => guard.invalidate_backend_cache(),
                Err(_) => {
                    crate::runtime_log::err("[displays] resume: el estado quedó inconsistente");
                    return;
                }
            };
            if let Err(err) = resultado {
                crate::runtime_log::warn(format!("[displays] resume: no se pudo tirar el cache: {err}"));
            }
            self.avisar_cambio();
        }

        /// Cambió la topología (enchufaste/desenchufaste algo, o un apply propio):
        /// refresca la vista **sin** invalidar el cache.
        ///
        /// Invalidar acá borraría el recuerdo del monitor detachado —y un apply
        /// propio dispara este mismo mensaje—, que es justo lo que hay que
        /// preservar. **Solo el resume invalida.** El frontend, al recibir el
        /// aviso, re-consulta el snapshot, que en Windows sale de una enumeración
        /// CCD fresca (no del cache), así que la lista se actualiza sola.
        fn al_cambiar_displays(&self) {
            self.avisar_cambio();
            // Una pantalla recién prendida es la única que puede contar sus modos. Corre en
            // el hilo del cambio (con su espera anti-ráfaga), no en un poll nuevo.
            self.anotar_modos();
        }

        // --- modos de pantalla (encargo 02) ------------------------------------

        /// Lee los modos de las pantallas prendidas **fuera del lock del manager** y los
        /// anota en `display_modes` (el vendor guarda solo si cambió y nunca vacía una
        /// lista). Devuelve lo leído para quien quiera mostrarlo; en modo mentira, nada.
        fn anotar_modos(&self) -> Vec<modos::ModosLeidos> {
            if self.0.mock {
                return Vec::new();
            }
            let leidos = match super::lectura_de_modos::leer() {
                Ok(leidos) => leidos,
                Err(err) => {
                    crate::runtime_log::warn(format!(
                        "[displays] no se pudieron leer los modos de las pantallas: {err}"
                    ));
                    return Vec::new();
                }
            };
            let vistas: Vec<_> = leidos
                .iter()
                .map(|l| (l.id.clone(), l.nombre.clone(), l.modos.clone()))
                .collect();
            let resultado = match self.0.manager.lock() {
                Ok(mut guard) => guard.remember_display_modes(&vistas),
                Err(_) => {
                    crate::runtime_log::err("[displays] modos: el estado quedó inconsistente");
                    return leidos;
                }
            };
            match resultado {
                Ok(true) => diagnostics::log(format!("modos:anotados:{}", leidos.len())),
                Ok(false) => {}
                Err(err) => crate::runtime_log::warn(format!(
                    "[displays] no se pudieron guardar los modos de las pantallas: {err}"
                )),
            }
            leidos
        }

        /// El selector de resolución: cada pantalla que Windows ve o que alguna escena
        /// nombra, con lo que contestó recién o, si no, lo recordado.
        pub fn listar_modos(&self) -> Result<Vec<DisplayModesView>, String> {
            let pantallas = self.pantallas_con_modos()?;
            Ok(pantallas.iter().map(modos::ModosDePantalla::a_vista).collect())
        }

        fn pantallas_con_modos(&self) -> Result<Vec<modos::ModosDePantalla>, String> {
            let leidos = self.anotar_modos();
            let i = self.insumos_de_escenas()?;
            Ok(modos::pantallas_con_modos(
                &i.infos,
                &i.perfiles,
                &i.huellas,
                &i.ajustes.display_modes,
                &leidos,
            ))
        }

        /// Después de aplicar una escena: re-lee lo que Windows dejó (la enumeración de hoy,
        /// solo las prendidas) y dice en palabras cada pantalla que quedó en otra resolución
        /// o frecuencia de la elegida. Cada aviso va también al log. Sin resolución elegida
        /// (todo "Dejar la que tenga") no lee nada.
        fn avisos_de_resolucion(&self, deseado: Option<&Layout>) -> Vec<String> {
            let Some(deseado) = deseado else {
                return Vec::new();
            };
            let elige_alguna = deseado
                .outputs
                .iter()
                .any(|o| o.enabled && o.resolution.width > 0 && o.resolution.height > 0);
            if self.0.mock || !elige_alguna {
                return Vec::new();
            }
            let quedo = match super::enumerate::query_active_only_topology() {
                Ok(topologia) => topologia,
                Err(err) => {
                    crate::runtime_log::warn(format!(
                        "[displays] no se pudo re-leer la resolución que quedó: {err}"
                    ));
                    return Vec::new();
                }
            };
            let avisos = modos::avisos_tras_aplicar(deseado, &quedo.layout, &quedo.displays);
            for aviso in &avisos {
                crate::runtime_log::warn(format!("[displays] {aviso}"));
            }
            avisos
        }

        // --- avisos ----------------------------------------------------------

        fn avisar_cambio(&self) {
            (self.0.emisor)(EVENTO_CAMBIO, serde_json::Value::Null);
        }

        fn avisar_confirmacion(&self, payload: serde_json::Value) {
            (self.0.emisor)(EVENTO_CONFIRMACION, payload);
        }

        fn avisar_audio(&self, payload: serde_json::Value) {
            (self.0.emisor)(EVENTO_AUDIO, payload);
        }

        /// Avisa que la lista de escenas cambió (`kind`: saved, renamed, duplicated,
        /// reordered, deleted, current). El payload no trae la lista: la pantalla la vuelve a pedir.
        pub fn avisar_escenas(&self, kind: &str) {
            (self.0.emisor)(EVENTO_ESCENAS, serde_json::json!({ "kind": kind }));
        }

        // --- audio por perfil (Fase 3) --------------------------------------

        /// Aplica la salida de audio del perfil `nombre`, si tiene una asignada y
        /// está presente. Best-effort: NUNCA frena ni revierte el video. Si
        /// `hay_red` (hay una confirmación de video que puede auto-revertirse),
        /// captura el default previo en `Interno` para devolverlo en el revert.
        ///
        /// El lock del manager se toma solo para leer `profile_audio` y se suelta
        /// antes de cualquier llamada COM (regla del stack: nada de sostener el
        /// Mutex a través de trabajo bloqueante largo).
        fn aplicar_audio_de_perfil(&self, nombre: &str, hay_red: bool) {
            let target = {
                let Ok(guard) = self.0.manager.lock() else {
                    return;
                };
                guard.settings().profile_audio.get(nombre).cloned()
            };
            let Some(target) = target else {
                return; // "No tocar el audio".
            };
            self.aplicar_audio_objetivo(nombre, &target, hay_red);
        }

        /// Aplica una salida de audio concreta (la de un perfil guardado o la de un borrador en
        /// PRUEBA). `nombre` es solo para el log. Misma red que `aplicar_audio_de_perfil`.
        fn aplicar_audio_objetivo(&self, nombre: &str, target: &AudioTarget, hay_red: bool) {
            // Capturar el default ACTUAL antes de cambiarlo (solo si hay red que
            // pueda revertir). Sin el lock del manager tomado.
            let previo = if hay_red {
                audio::capturar_default()
            } else {
                None
            };
            let resultado = audio::aplicar_salida(target);
            // Guardar el audio previo si el cambio se INTENTÓ: Ok(true) = cambió;
            // Err = pudo cambiar PARCIALMENTE (un rol OK, otro falló) antes de
            // devolver error. En ambos casos el revert debe poder deshacerlo. En
            // Ok(false) no se tocó nada ⇒ no hay previo que guardar.
            if hay_red && !matches!(resultado, Ok(false)) {
                if let Some(previo) = previo.filter(|p| p.tiene_algo()) {
                    if let Ok(mut slot) = self.0.audio_previo.lock() {
                        *slot = Some(previo);
                    }
                }
            }
            match resultado {
                Ok(true) => {
                    crate::runtime_log::info(format!(
                        "[displays] audio del perfil «{nombre}» → «{}»",
                        target.friendly_name
                    ));
                }
                Ok(false) => {
                    // Salida no presente (TV apagada): avisar; el video ya se aplicó.
                    crate::runtime_log::warn(format!(
                        "[displays] la salida de audio «{}» del perfil «{nombre}» no está disponible; el audio no se cambió",
                        target.friendly_name
                    ));
                    self.avisar_audio(serde_json::json!({
                        "kind": "unavailable",
                        "device": target.friendly_name,
                    }));
                }
                Err(e) => {
                    crate::runtime_log::warn(format!(
                        "[displays] no se pudo cambiar el audio del perfil «{nombre}»: {e}"
                    ));
                    self.avisar_audio(serde_json::json!({
                        "kind": "error",
                        "device": target.friendly_name,
                    }));
                }
            }
        }

        /// Consume el audio previo capturado y lo restaura como default de Windows.
        /// No hace nada si no había nada capturado.
        fn restaurar_audio_previo(&self) {
            let previo = match self.0.audio_previo.lock() {
                Ok(mut slot) => slot.take(),
                Err(_) => None,
            };
            if let Some(previo) = previo {
                audio::restaurar_default(&previo);
            }
        }

        /// Descarta el audio previo capturado (el cambio se aceptó; no hay revert).
        fn olvidar_audio_previo(&self) {
            if let Ok(mut slot) = self.0.audio_previo.lock() {
                *slot = None;
            }
        }

        // --- ciclo de escena (Fase 4) ---------------------------------------

        /// Corre el ciclo de escena al **committear** el cambio al perfil `nombre`:
        /// (1) la SALIDA de la escena anterior (si había otra distinta), (2) la
        /// ENTRADA del perfil nuevo, (3) marca `nombre` como escena activa. Va
        /// SIEMPRE después de la foto y del audio (el orden del spec), y solo desde
        /// las vías committeadas (inmediata o `confirm`), NUNCA al aplicar con red.
        ///
        /// Best-effort: el lock del manager se toma solo para clonar el mapa de
        /// acciones y se suelta antes de ejecutar (lanzar procesos / COM puede
        /// tardar; regla de locks del stack). Una acción que falla se loguea y
        /// sigue; el video/audio ya aplicados nunca se revierten por esto.
        fn correr_ciclo_de_escena(&self, nombre: &str) {
            let lista = self.preparar_ciclo_de_escena(nombre);
            self.0.cola.encolar(lista);
        }

        /// La primera mitad del ciclo: arma la lista (SALIDA de la anterior y después ENTRADA
        /// de `nombre`, con todos los tipos de acción) y fija `nombre` como escena activa
        /// ANTES de que corra nada. Quien llama la encola cuando le toca.
        fn preparar_ciclo_de_escena(&self, nombre: &str) -> Vec<monarch::ActionV2> {
            let por_perfil = {
                let Ok(guard) = self.0.manager.lock() else {
                    return Vec::new();
                };
                guard.settings().profile_actions.clone()
            };
            let anterior = self.0.escena_activa.lock().ok().and_then(|g| g.clone());
            let mut lista: Vec<monarch::ActionV2> = match &anterior {
                Some(prev) if prev != nombre => por_perfil
                    .get(prev)
                    .map(|a| a.salida_completa())
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            if let Some(a) = por_perfil.get(nombre) {
                lista.extend(a.entrada_completa());
            }
            // La nueva escena queda activa aunque no tenga acciones: así su SALIDA
            // futura (si se la agregan) tiene contra qué correr, y no se re-dispara
            // la salida de la anterior en el próximo cambio.
            if let Ok(mut slot) = self.0.escena_activa.lock() {
                *slot = Some(nombre.to_string());
            }
            lista
        }

        /// Marca que la escena `nombre` se aplicó **con red** y espera confirmación.
        /// Se consume en `confirm` o se descarta en revert/timeout.
        fn marcar_escena_pendiente(&self, nombre: &str) {
            if let Ok(mut slot) = self.0.escena_pendiente.lock() {
                *slot = Some(nombre.to_string());
            }
        }

        /// En `confirm`: el cambio con red recién ahí queda committeado ⇒ correr el
        /// ciclo de la escena que estaba pendiente (si la había).
        fn confirmar_escena_pendiente(&self) -> Vec<monarch::ActionV2> {
            let pendiente = match self.0.escena_pendiente.lock() {
                Ok(mut slot) => slot.take(),
                Err(_) => None,
            };
            match pendiente {
                Some(nombre) => self.preparar_ciclo_de_escena(&nombre),
                None => Vec::new(),
            }
        }

        /// En revert / timeout / no-op: descartar la escena pendiente SIN correr
        /// nada. Si el cambio no se committeó, NINGUNA acción debe correr (criterio
        /// 7: no se abre Steam si el video se revirtió).
        fn descartar_escena_pendiente(&self) {
            if let Ok(mut slot) = self.0.escena_pendiente.lock() {
                *slot = None;
            }
        }

        /// Al borrar un perfil: si era la escena activa o la pendiente, olvidar ese
        /// estado para no dejar un nombre colgado apuntando a un perfil que ya no
        /// existe.
        fn olvidar_escena_si_es(&self, nombre: &str) {
            if let Ok(mut slot) = self.0.escena_activa.lock() {
                if slot.as_deref() == Some(nombre) {
                    *slot = None;
                }
            }
            if let Ok(mut slot) = self.0.escena_pendiente.lock() {
                if slot.as_deref() == Some(nombre) {
                    *slot = None;
                }
            }
        }

        // --- audio por perfil: comandos --------------------------------------

        /// Lista las salidas de audio activas para el dropdown "Sonido a:".
        pub fn listar_salidas_de_audio(&self) -> Vec<AudioView> {
            audio::listar_salidas().iter().map(a_audio_view).collect()
        }

        /// Asigna una salida de audio a un perfil (persistente). Devuelve la lista
        /// al día. Mismo patrón seguro que `asignar_atajo`: clonar ajustes, tocar
        /// solo lo propio y `update_settings` (que preserva el resto intacto).
        pub fn asignar_audio(
            &self,
            nombre: &str,
            endpoint_id: &str,
            friendly_name: &str,
        ) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                ajustes.profile_audio.insert(
                    nombre.to_string(),
                    AudioTarget {
                        endpoint_id: endpoint_id.to_string(),
                        friendly_name: friendly_name.to_string(),
                    },
                );
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("audio:asignado");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        /// Quita la salida de audio de un perfil (vuelve a "No tocar").
        pub fn limpiar_audio(&self, nombre: &str) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                ajustes.profile_audio.remove(nombre);
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("audio:limpiado");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        // --- acciones por perfil: comandos (Fase 4) --------------------------

        /// Asigna las acciones (entrada/salida) de un perfil-escena, persistiéndolas
        /// en `profile_actions`. Mismo patrón seguro que `asignar_audio`: clonar
        /// ajustes, tocar solo lo propio y `update_settings` (que preserva el resto
        /// intacto — la trampa #1 la blinda el vendor). Si ambas listas quedan
        /// vacías, se quita la entrada (perfil sin escena) en vez de guardar dos
        /// listas vacías. Devuelve la lista al día.
        pub fn asignar_acciones(
            &self,
            nombre: &str,
            entrada: Vec<ActionView>,
            salida: Vec<ActionView>,
        ) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                let entrada: Vec<Accion> = entrada.iter().map(view_a_accion).collect();
                let salida: Vec<Accion> = salida.iter().map(view_a_accion).collect();
                if entrada.is_empty() && salida.is_empty() {
                    ajustes.profile_actions.remove(nombre);
                } else {
                    ajustes
                        .profile_actions
                        .insert(
                            nombre.to_string(),
                            // `..Default`: sin `_v2`. Esta vía vieja reemplaza TODO, y una
                            // lista `_v2` que quedara atrás pisaría lo que se acaba de asignar.
                            PerfilAcciones {
                                entrada,
                                salida,
                                ..Default::default()
                            },
                        );
                }
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("acciones:asignadas");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }

        /// Quita todas las acciones de un perfil (vuelve a "sin escena").
        pub fn limpiar_acciones(&self, nombre: &str) -> Result<Vec<ProfileView>, String> {
            {
                let mut guard = self.0.manager.lock().map_err(|_| envenenado())?;
                let mut ajustes = guard.settings().clone();
                ajustes.profile_actions.remove(nombre);
                guard.update_settings(ajustes).map_err(|e| e.to_string())?;
            }
            diagnostics::log("acciones:limpiadas");
            self.avisar_escenas("saved");
            self.listar_perfiles()
        }
    }

    /// Lo que leen las vistas de escenas, tomado de una vez.
    struct InsumosEscenas {
        perfiles: Vec<Profile>,
        ajustes: monarch::AppSettings,
        huellas: Vec<monarch::DisplayFingerprint>,
        actual: Result<Layout, String>,
        infos: Vec<monarch::DisplayInfo>,
    }

    /// El layout guardado de una escena (para comparar con lo que quedó o con lo editado).
    fn layout_del_perfil(manager: &Manager, nombre: &str) -> Option<Layout> {
        manager
            .list_profiles()
            .into_iter()
            .find(|p| p.name == nombre)
            .map(|p| p.layout)
    }

    fn buscar_escena<'a>(
        perfiles: &'a [Profile],
        nombre: Option<&str>,
    ) -> Result<&'a Profile, String> {
        let nombre = nombre.ok_or_else(|| "decime de qué escena partir".to_string())?;
        perfiles
            .iter()
            .find(|p| p.name == nombre)
            .ok_or_else(|| format!("no existe la escena \"{nombre}\""))
    }

    /// El error del manager como texto para Guido (los de escenas ya vienen en castellano).
    fn mensaje_de(error: ManagerError) -> String {
        match error {
            ManagerError::Validation(texto) | ManagerError::NotFound(texto) => texto,
            ManagerError::ConfirmationPending => {
                "ya hay un cambio esperando que lo confirmes".to_string()
            }
            otro => otro.to_string(),
        }
    }

    fn envenenado() -> String {
        "el estado de monitores quedó inconsistente; reiniciá Millennium".to_string()
    }

    /// Arma la vista de un perfil: nombre + un resumen legible del layout + su
    /// atajo global asignado (si hay).
    ///
    /// El resumen cuenta los monitores prendidos y lista sus resoluciones, para
    /// que el usuario reconozca qué perfil es sin cargarlo.
    fn vista_de_perfil(
        perfil: &Profile,
        atajos: &BTreeMap<String, String>,
        audios: &BTreeMap<String, AudioTarget>,
        acciones_por_perfil: &BTreeMap<String, PerfilAcciones>,
    ) -> ProfileView {
        let activos = perfil.layout.outputs.iter().filter(|o| o.enabled).count();
        ProfileView {
            name: perfil.name.clone(),
            active_count: activos,
            summary: escenas::resumen(&perfil.layout),
            shortcut: atajos.get(&perfil.name).cloned(),
            audio: audios.get(&perfil.name).map(a_audio_view),
            actions: acciones_por_perfil
                .get(&perfil.name)
                .map(a_actions_view)
                .unwrap_or_default(),
        }
    }

    /// `AudioTarget` (vendor, windows-only) → `AudioView` (DTO plano al frontend).
    fn a_audio_view(t: &AudioTarget) -> AudioView {
        AudioView {
            endpoint_id: t.endpoint_id.clone(),
            friendly_name: t.friendly_name.clone(),
        }
    }

    /// `PerfilAcciones` (vendor) → `ProfileActionsView` (DTO plano al frontend).
    fn a_actions_view(a: &PerfilAcciones) -> ProfileActionsView {
        ProfileActionsView {
            entrada: a.entrada.iter().map(accion_a_view).collect(),
            salida: a.salida.iter().map(accion_a_view).collect(),
        }
    }

    /// `Accion` (vendor) → `ActionView` (DTO plano).
    fn accion_a_view(a: &Accion) -> ActionView {
        match a {
            Accion::Lanzar { destino, args } => ActionView::Lanzar {
                destino: destino.clone(),
                args: args.clone(),
            },
            Accion::Volumen { nivel } => ActionView::Volumen { nivel: *nivel },
        }
    }

    /// `ActionView` (del frontend) → `Accion` (vendor). Sanea de paso: recorta el
    /// destino y clampea el volumen a 0–100.
    fn view_a_accion(v: &ActionView) -> Accion {
        match v {
            ActionView::Lanzar { destino, args } => Accion::Lanzar {
                destino: destino.trim().to_string(),
                args: args.clone(),
            },
            ActionView::Volumen { nivel } => Accion::Volumen {
                nivel: (*nivel).min(100),
            },
        }
    }

    /// Arma las vistas desde el modelo de Monarch (no desde los tipos Win32).
    ///
    /// Se usa en modo mentira, donde no hay CCD que enumerar. Cruza por
    /// `DisplayId` y no por índice porque `list_displays()` y `get_layout()` son
    /// dos consultas separadas al backend, sin la correspondencia en lockstep que
    /// sí tiene el snapshot crudo.
    fn vistas_del_modelo(displays: &[monarch::DisplayInfo], layout: &Layout) -> Vec<DisplayView> {
        let mut views: Vec<DisplayView> = displays
            .iter()
            .map(|display| {
                let output = layout
                    .outputs
                    .iter()
                    .find(|output| output.display_id == display.id);
                DisplayView {
                    id: format_display_id(&display.id),
                    name: display.friendly_name.clone(),
                    active: display.is_active,
                    primary: display.is_primary,
                    width: display.resolution.width,
                    height: display.resolution.height,
                    refresh_mhz: display.refresh_rate_mhz,
                    position_x: output.map(|o| o.position.x).unwrap_or(0),
                    position_y: output.map(|o| o.position.y).unwrap_or(0),
                    adapter_luid: display.id.adapter_luid.to_string(),
                    target_id: display.id.target_id,
                    edid_hash: display.id.edid_hash.map(|hash| hash.to_string()),
                    can_detach: false,
                }
            })
            .collect();
        mark_can_detach(&mut views);
        super::sort_for_display(&mut views);
        views
    }

}

#[cfg(target_os = "windows")]
pub use estado::{init, DisplaysState};

// Los tests del crate no pueden correr en Windows: agregar un `#[test]` acá
// arrastra el stack de tao/wry al binario de tests y muere al cargar con
// STATUS_ENTRYPOINT_NOT_FOUND. Mismo gate que `json_store.rs`.
#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn el_snapshot_mock_se_activa_por_la_env_var() {
        std::env::set_var(FORCE_MOCK_ENV, "1");
        let snapshot = snapshot().expect("el mock nunca falla");
        std::env::remove_var(FORCE_MOCK_ENV);
        assert_eq!(snapshot.source, "mock");
        assert_eq!(snapshot.displays.len(), 3);
    }
}
