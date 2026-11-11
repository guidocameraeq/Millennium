//! Escenas en papel (módulo escenas, encargo 01): los tipos que cruzan al frontend y las
//! conversiones PURAS entre ellos y el modelo del vendor.
//!
//! Los tipos (arriba) no tienen `cfg`: la firma de los comandos tiene que compilar en
//! cualquier plataforma. Las conversiones (abajo) son solo Windows porque nombran al crate
//! `monarch`, pero a propósito no tocan ni `windows` ni `tauri`: así `displays-tests` las
//! incluye por `#[path]` y las prueba de verdad. Forma y nombres: `tools/ui-capturas/contrato-escenas.md`.

use serde::{Deserialize, Serialize};

/// Una pantalla dentro de una escena o de un borrador.
///
/// `name` y `connected` son solo de salida: al entrar se ignoran. `width: 0, height: 0` es
/// "Dejar la que tenga". Los `u64` del id viajan como texto (ADR-006).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOutput {
    pub display_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub connected: bool,
    pub enabled: bool,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub refresh_mhz: u32,
}

/// La salida de sonido de una escena (misma forma que `AudioView`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAudio {
    pub endpoint_id: String,
    pub friendly_name: String,
}

/// Una acción de las listas `entradaV2`/`salidaV2`. Espeja `monarch::ActionV2` más `Hdr`
/// (encargo 03b): hasta entonces `save_scene` lo rechaza.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum ActionV2Dto {
    Lanzar {
        destino: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        etiqueta: Option<String>,
    },
    Volumen {
        nivel: u8,
    },
    Cerrar {
        exe: String,
    },
    Esperar {
        segundos: u8,
    },
    Hdr {
        pantalla: String,
        prender: bool,
    },
    #[serde(other)]
    Desconocida,
}

/// Una escena en la lista nueva.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneView {
    pub name: String,
    pub emoji: Option<String>,
    pub outputs: Vec<SceneOutput>,
    pub summary: String,
    pub audio: Option<SceneAudio>,
    pub shortcut: Option<String>,
    pub startup: bool,
    pub is_current: bool,
    pub entrada_v2: Vec<ActionV2Dto>,
    pub salida_v2: Vec<ActionV2Dto>,
}

/// El borrador del editor (ida y vuelta). Vive solo en la pantalla hasta GUARDAR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneDraft {
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    pub outputs: Vec<SceneOutput>,
    #[serde(default)]
    pub audio: Option<SceneAudio>,
    #[serde(default)]
    pub entrada_v2: Vec<ActionV2Dto>,
    #[serde(default)]
    pub salida_v2: Vec<ActionV2Dto>,
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub startup: bool,
}

/// Respuesta de los comandos que escriben escenas.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenesResult {
    pub scenes: Vec<SceneView>,
    pub name: Option<String>,
    pub warnings: Vec<String>,
}

/// Nombre que lleva un borrador nuevo.
pub const NOMBRE_ESCENA_NUEVA: &str = "Escena nueva";

/// Programas que la acción Cerrar no acepta: esta app y lo que Windows necesita para andar.
/// Se rechazan al guardar (`exe_a_cerrar`); como un `displays.json` tocado a mano o escrito por
/// otra versión no pasa por ahí, el ejecutor vuelve a preguntar `exe_prohibido` antes de cerrar.
pub const EXES_PROHIBIDOS: [&str; 5] = [
    "millennium-clipboard.exe",
    "explorer.exe",
    "dwm.exe",
    "csrss.exe",
    "winlogon.exe",
];

/// Los segundos que se puede esperar en una acción Esperar.
pub const ESPERA_MIN_SEG: u8 = 1;
pub const ESPERA_MAX_SEG: u8 = 30;

/// `true` si `exe` (ya en minúsculas) está en la lista prohibida.
pub fn exe_prohibido(exe: &str) -> bool {
    EXES_PROHIBIDOS.contains(&exe)
}

/// `true` si se puede mandar el cierre a `exe`: no está vacío, no está en la lista prohibida y no
/// es el ejecutable de esta misma app (`propio`). Es la guarda que vuelve a mirar el ejecutor.
pub fn se_puede_cerrar(exe: &str, propio: &str) -> bool {
    let exe = exe.trim().to_lowercase();
    !exe.is_empty() && !exe_prohibido(&exe) && exe != propio.trim().to_lowercase()
}

/// Valida el `.exe` de una acción Cerrar y lo deja como se guarda: sin espacios y en minúsculas.
/// Nombre pelado (nada de carpetas) y fuera de la lista prohibida.
pub fn exe_a_cerrar(exe: &str) -> Result<String, String> {
    let exe = exe.trim().to_lowercase();
    let con_carpeta = exe.contains(['\\', '/', ':']);
    if con_carpeta || exe.len() <= ".exe".len() || !exe.ends_with(".exe") {
        return Err("el programa a cerrar va como nombre.exe, sin carpeta".to_string());
    }
    if exe_prohibido(&exe) {
        return Err(format!(
            "no se puede cerrar {exe}: lo necesita Windows o es esta app"
        ));
    }
    Ok(exe)
}

#[cfg(target_os = "windows")]
pub use windows_impl::*;

#[cfg(target_os = "windows")]
mod windows_impl {
    use monarch::{
        ActionV2, AppSettings, AudioTarget, DisplayFingerprint, DisplayId, DisplayInfo, Layout,
        OutputConfig, Position, Profile, Resolution, SceneData,
    };

    use super::{
        exe_a_cerrar, ActionV2Dto, SceneAudio, SceneDraft, SceneOutput, SceneView, ESPERA_MAX_SEG,
        ESPERA_MIN_SEG, NOMBRE_ESCENA_NUEVA,
    };
    use crate::displays::ids::{format_display_id, parse_display_id};

    /// "2 monitores · 1920×1080, 2560×1440": el resumen de la lista de escenas.
    pub fn resumen(layout: &Layout) -> String {
        let activos: Vec<_> = layout.outputs.iter().filter(|o| o.enabled).collect();
        if activos.is_empty() {
            return "sin monitores".to_string();
        }
        let resoluciones: Vec<String> = activos
            .iter()
            .map(|o| format!("{}×{}", o.resolution.width, o.resolution.height))
            .collect();
        format!(
            "{} {} · {}",
            activos.len(),
            if activos.len() == 1 { "monitor" } else { "monitores" },
            resoluciones.join(", ")
        )
    }

    /// Dos ids son la misma pantalla si son iguales o si comparten un EDID conocido (el
    /// adaptador puede cambiar de LUID entre arranques).
    pub fn mismo_monitor(a: &DisplayId, b: &DisplayId) -> bool {
        a == b || (a.edid_hash.is_some() && a.edid_hash == b.edid_hash)
    }

    fn nombre_de(id: &DisplayId, fps: &[DisplayFingerprint], infos: &[DisplayInfo]) -> String {
        infos
            .iter()
            .find(|d| mismo_monitor(&d.id, id))
            .map(|d| d.friendly_name.clone())
            .or_else(|| {
                fps.iter()
                    .find(|f| mismo_monitor(&f.display_id, id))
                    .map(|f| f.friendly_name.clone())
            })
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("Pantalla {}", id.target_id))
    }

    fn salida_de(
        o: &OutputConfig,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> SceneOutput {
        SceneOutput {
            display_id: format_display_id(&o.display_id),
            name: nombre_de(&o.display_id, fps, infos),
            connected: infos.iter().any(|d| mismo_monitor(&d.id, &o.display_id)),
            enabled: o.enabled,
            primary: o.primary,
            x: o.position.x,
            y: o.position.y,
            width: o.resolution.width,
            height: o.resolution.height,
            refresh_mhz: o.refresh_rate_mhz,
        }
    }

    /// Las pantallas de un layout, en su orden.
    pub fn salidas_de_layout(
        layout: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> Vec<SceneOutput> {
        layout.outputs.iter().map(|o| salida_de(o, fps, infos)).collect()
    }

    /// Las pantallas de la escena más las que Windows ve y la escena no nombra, apagadas y con
    /// "Dejar la que tenga": así el editor muestra todas.
    pub fn salidas_completas(
        layout: &Layout,
        actual: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> Vec<SceneOutput> {
        let mut salidas = salidas_de_layout(layout, fps, infos);
        for o in &actual.outputs {
            if layout
                .outputs
                .iter()
                .any(|propia| mismo_monitor(&propia.display_id, &o.display_id))
            {
                continue;
            }
            let mut extra = salida_de(o, fps, infos);
            extra.enabled = false;
            extra.primary = false;
            extra.width = 0;
            extra.height = 0;
            salidas.push(extra);
        }
        salidas
    }

    /// De las pantallas del editor al `Layout` del vendor. Un id mal formado es error (nunca se
    /// adivina). La frecuencia 0 nunca se guarda con una resolución elegida; con "Dejar la que
    /// tenga" (0×0) se respeta lo que tenía.
    pub fn layout_de_salidas(salidas: &[SceneOutput]) -> Result<Layout, String> {
        let mut outputs = Vec::with_capacity(salidas.len());
        for s in salidas {
            let display_id = parse_display_id(&s.display_id)?;
            let nombre = if s.name.trim().is_empty() {
                s.display_id.clone()
            } else {
                s.name.clone()
            };
            if (s.width == 0) != (s.height == 0) {
                return Err(format!("la resolución de {nombre} no es válida"));
            }
            if s.width > 0 && s.refresh_mhz == 0 {
                return Err(format!("elegí una frecuencia para {nombre}"));
            }
            outputs.push(OutputConfig {
                display_id,
                enabled: s.enabled,
                position: Position { x: s.x, y: s.y },
                resolution: Resolution {
                    width: s.width,
                    height: s.height,
                },
                refresh_rate_mhz: s.refresh_mhz,
                primary: s.primary,
            });
        }
        Ok(Layout { outputs })
    }

    /// Una acción del editor al vendor. `Ok(None)` = se descarta (una acción que esta versión
    /// no conoce). `Hdr` (encargo 03b) todavía no se puede guardar.
    fn accion_a_vendor(dto: &ActionV2Dto) -> Result<Option<ActionV2>, String> {
        match dto {
            ActionV2Dto::Lanzar {
                destino,
                args,
                etiqueta,
            } => {
                let destino = destino.trim();
                if destino.is_empty() {
                    return Err("falta qué abrir".to_string());
                }
                Ok(Some(ActionV2::Lanzar {
                    destino: destino.to_string(),
                    args: args.clone(),
                    etiqueta: etiqueta
                        .as_deref()
                        .map(str::trim)
                        .filter(|e| !e.is_empty())
                        .map(str::to_string),
                }))
            }
            ActionV2Dto::Volumen { nivel } => {
                if *nivel > 100 {
                    return Err("el volumen va de 0 a 100".to_string());
                }
                Ok(Some(ActionV2::Volumen { nivel: *nivel }))
            }
            ActionV2Dto::Cerrar { exe } => Ok(Some(ActionV2::Cerrar {
                exe: exe_a_cerrar(exe)?,
            })),
            ActionV2Dto::Esperar { segundos } => {
                if !(ESPERA_MIN_SEG..=ESPERA_MAX_SEG).contains(segundos) {
                    return Err("esperar va de 1 a 30 segundos".to_string());
                }
                Ok(Some(ActionV2::Esperar {
                    segundos: *segundos,
                }))
            }
            ActionV2Dto::Hdr { .. } => Err(no_sabe_guardar("hdr")),
            ActionV2Dto::Desconocida => Ok(None),
        }
    }

    fn no_sabe_guardar(tipo: &str) -> String {
        format!("esta versión todavía no sabe guardar acciones {tipo}")
    }

    fn acciones_a_vendor(dtos: &[ActionV2Dto]) -> Result<Vec<ActionV2>, String> {
        let mut lista = Vec::with_capacity(dtos.len());
        for dto in dtos {
            if let Some(accion) = accion_a_vendor(dto)? {
                lista.push(accion);
            }
        }
        Ok(lista)
    }

    pub fn accion_a_dto(accion: &ActionV2) -> ActionV2Dto {
        match accion {
            ActionV2::Lanzar {
                destino,
                args,
                etiqueta,
            } => ActionV2Dto::Lanzar {
                destino: destino.clone(),
                args: args.clone(),
                etiqueta: etiqueta.clone(),
            },
            ActionV2::Volumen { nivel } => ActionV2Dto::Volumen { nivel: *nivel },
            ActionV2::Cerrar { exe } => ActionV2Dto::Cerrar { exe: exe.clone() },
            ActionV2::Esperar { segundos } => ActionV2Dto::Esperar {
                segundos: *segundos,
            },
            ActionV2::Desconocida => ActionV2Dto::Desconocida,
        }
    }

    fn audio_a_dto(a: &AudioTarget) -> SceneAudio {
        SceneAudio {
            endpoint_id: a.endpoint_id.clone(),
            friendly_name: a.friendly_name.clone(),
        }
    }

    /// Del borrador del editor a lo que guarda `upsert_scene`. Todo error es para Guido.
    pub fn datos_de_borrador(borrador: &SceneDraft) -> Result<SceneData, String> {
        let layout = layout_de_salidas(&borrador.outputs)?;
        Ok(SceneData {
            name: borrador.name.trim().to_string(),
            layout,
            emoji: borrador.emoji.clone(),
            audio: borrador.audio.as_ref().map(|a| AudioTarget {
                endpoint_id: a.endpoint_id.clone(),
                friendly_name: a.friendly_name.clone(),
            }),
            entrada: acciones_a_vendor(&borrador.entrada_v2)?,
            salida: acciones_a_vendor(&borrador.salida_v2)?,
            shortcut: borrador.shortcut.clone(),
            startup: borrador.startup,
        })
    }

    /// Una escena para la lista. `activa` = la escena puesta y committeada (hasta el encargo
    /// 04 es lo único que marca el sello PUESTA AHORA).
    pub fn vista_de_escena(
        perfil: &Profile,
        ajustes: &AppSettings,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
        activa: Option<&str>,
    ) -> SceneView {
        let nombre = perfil.name.as_str();
        let acciones = ajustes.profile_actions.get(nombre);
        SceneView {
            name: perfil.name.clone(),
            emoji: ajustes.profile_icons.get(nombre).cloned(),
            outputs: salidas_de_layout(&perfil.layout, fps, infos),
            summary: resumen(&perfil.layout),
            audio: ajustes.profile_audio.get(nombre).map(audio_a_dto),
            shortcut: ajustes.profile_shortcuts.get(nombre).cloned(),
            startup: ajustes.startup_profile_name.as_deref() == Some(nombre),
            is_current: activa == Some(nombre),
            entrada_v2: acciones
                .map(|a| a.entrada_completa().iter().map(accion_a_dto).collect())
                .unwrap_or_default(),
            salida_v2: acciones
                .map(|a| a.salida_completa().iter().map(accion_a_dto).collect())
                .unwrap_or_default(),
        }
    }

    fn borrador_vacio(outputs: Vec<SceneOutput>) -> SceneDraft {
        SceneDraft {
            name: NOMBRE_ESCENA_NUEVA.to_string(),
            emoji: None,
            outputs,
            audio: None,
            entrada_v2: Vec::new(),
            salida_v2: Vec::new(),
            shortcut: None,
            startup: false,
        }
    }

    /// `from: "current"`: lo que está puesto ahora, sin sonido, acciones, atajo ni arranque.
    pub fn borrador_actual(
        actual: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> SceneDraft {
        borrador_vacio(salidas_de_layout(actual, fps, infos))
    }

    /// `from: "blank"`: todas las pantallas que Windows ve; prendida solo la principal de ahora
    /// (en 0,0, con su resolución actual), las demás apagadas con "Dejar la que tenga".
    pub fn borrador_en_blanco(
        actual: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> SceneDraft {
        let principal = actual
            .outputs
            .iter()
            .position(|o| o.enabled && o.primary)
            .or_else(|| actual.outputs.iter().position(|o| o.enabled))
            .unwrap_or(0);
        let mut layout = actual.clone();
        for (i, o) in layout.outputs.iter_mut().enumerate() {
            if i == principal {
                o.enabled = true;
                o.primary = true;
                o.position = Position { x: 0, y: 0 };
            } else {
                o.enabled = false;
                o.primary = false;
                o.resolution = Resolution {
                    width: 0,
                    height: 0,
                };
            }
        }
        borrador_vacio(salidas_de_layout(&layout, fps, infos))
    }

    /// `from: "scene"`: la escena entera para editarla (atajo y arranque incluidos), con las
    /// pantallas que Windows ve y la escena no nombra agregadas apagadas.
    pub fn borrador_de_escena(
        perfil: &Profile,
        ajustes: &AppSettings,
        actual: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
    ) -> SceneDraft {
        let vista = vista_de_escena(perfil, ajustes, fps, infos, None);
        SceneDraft {
            name: vista.name,
            emoji: vista.emoji,
            outputs: salidas_completas(&perfil.layout, actual, fps, infos),
            audio: vista.audio,
            entrada_v2: vista.entrada_v2,
            salida_v2: vista.salida_v2,
            shortcut: vista.shortcut,
            startup: vista.startup,
        }
    }

    /// `from: "copy"`: como `scene` pero con las reglas de duplicar: sin atajo ni arranque y con
    /// el nombre `nombre_copia`.
    pub fn borrador_de_copia(
        perfil: &Profile,
        ajustes: &AppSettings,
        actual: &Layout,
        fps: &[DisplayFingerprint],
        infos: &[DisplayInfo],
        nombre_copia: String,
    ) -> SceneDraft {
        let mut borrador = borrador_de_escena(perfil, ajustes, actual, fps, infos);
        borrador.name = nombre_copia;
        borrador.shortcut = None;
        borrador.startup = false;
        borrador
    }
}
