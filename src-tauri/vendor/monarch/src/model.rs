use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ManagerError;

pub const DEFAULT_PROFILE_SHORTCUT_BASE: &str = "Ctrl+Shift";
pub const DEFAULT_DISPLAY_TOGGLE_SHORTCUT_BASE: &str = "Ctrl+Alt";

fn default_global_shortcuts_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
pub struct DisplayId {
    pub adapter_luid: u64,
    pub target_id: u32,
    pub edid_hash: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DisplayInfo {
    pub id: DisplayId,
    pub friendly_name: String,
    pub is_active: bool,
    pub is_primary: bool,
    pub resolution: Resolution,
    pub refresh_rate_mhz: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OutputConfig {
    pub display_id: DisplayId,
    pub enabled: bool,
    pub position: Position,
    pub resolution: Resolution,
    pub refresh_rate_mhz: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub outputs: Vec<OutputConfig>,
}

impl Layout {
    pub fn enabled_output_count(&self) -> usize {
        self.outputs.iter().filter(|output| output.enabled).count()
    }

    pub fn ensure_valid(&self) -> Result<(), ManagerError> {
        if self.outputs.is_empty() {
            return Err(ManagerError::Validation(
                "layout cannot be empty".to_string(),
            ));
        }

        if self.enabled_output_count() == 0 {
            return Err(ManagerError::Validation(
                "layout must have at least one enabled display".to_string(),
            ));
        }

        Ok(())
    }

    pub fn find_output_index(&self, display_id: &DisplayId) -> Option<usize> {
        self.outputs
            .iter()
            .position(|output| &output.display_id == display_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub layout: Layout,
}

/// Un modo que una pantalla le dijo a Windows que acepta (módulo escenas, encargo 02): lo
/// que ofrece el selector de resolución del editor. En `displays.json` va como
/// `{width, height, refreshMhz}` (la forma del contrato). `normalize_display_modes` descarta
/// los de frecuencia 0 antes de guardar.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_mhz: u32,
}

/// La lista tal como se guarda: sin modos con ancho, alto o frecuencia 0, sin repetidos y
/// de mayor a menor (ancho, alto, frecuencia).
pub fn normalize_display_modes(modes: Vec<DisplayMode>) -> Vec<DisplayMode> {
    let mut modes: Vec<DisplayMode> = modes
        .into_iter()
        .filter(|mode| mode.width > 0 && mode.height > 0 && mode.refresh_mhz > 0)
        .collect();
    modes.sort_by(|left, right| right.cmp(left));
    modes.dedup();
    modes
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DisplayFingerprint {
    pub display_id: DisplayId,
    pub friendly_name: String,
    pub edid_fingerprint: Option<String>,
}

/// Salida de audio deseada por un perfil (Displays v2, Fase 3).
///
/// `endpoint_id` es la clave técnica opaca del endpoint (de `IMMDevice::GetId`);
/// `friendly_name` es la etiqueta linda para la UI y el fallback si el id ya no
/// resuelve (cambio de driver, USB a otro puerto). Ambos `String` → `Eq` trivial.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AudioTarget {
    pub endpoint_id: String,
    pub friendly_name: String,
}

/// Una acción que dispara un perfil-escena (Displays v2, Fase 4).
///
/// Etiquetado por el campo `tipo` (internally tagged) para poder sumar variantes
/// nuevas sin romper los stores viejos. JSON: `{"tipo":"lanzar","destino":"…",
/// "args":["…"]}` o `{"tipo":"volumen","nivel":40}`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum Accion {
    /// Lanzar un `.exe` (con args EN LISTA, sin shell), una URI de protocolo
    /// (`steam://…`) o un `.lnk`. El dispatch por tipo de destino lo hace el
    /// motor de acciones; acá es solo el dato. `args` es opcional en el JSON.
    Lanzar {
        destino: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Fijar el volumen (0–100) de la salida de audio por default actual.
    Volumen { nivel: u8 },
}

/// Una acción de la lista `_v2` de un perfil-escena (módulo escenas, encargo 01).
///
/// Vive APARTE de `Accion` a propósito: si las acciones nuevas entraran en el enum
/// de hoy, una versión vieja que lea un `displays.json` con una de ellas trataría
/// TODO el archivo como corrupto y arrancaría vacía. Por eso `Accion` no cambia y
/// las listas viejas se siguen escribiendo, solo con Lanzar y Volumen.
///
/// `Desconocida` (`#[serde(other)]`) es una acción de una versión más nueva que
/// esta no conoce: se lee sin error (ignora sus campos) y se pierde al guardar.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum ActionV2 {
    /// Igual que `Accion::Lanzar` más `etiqueta`: el texto que muestra el chip.
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
    /// Cerrar con buenos modos las ventanas de un programa, por nombre de `.exe` (sin ruta,
    /// en minúsculas). Nunca mata el proceso (encargo 03).
    Cerrar {
        exe: String,
    },
    /// Esperar `segundos` (1–30) antes de seguir con la próxima acción (encargo 03).
    Esperar {
        segundos: u8,
    },
    /// Prender o apagar el HDR de una pantalla (encargo 07, la "03b" del spec). `pantalla` es
    /// el id de monitor como texto (`"luid:target:edid"`, el de `format_display_id`): un id
    /// raro tocado a mano lo rechaza quien corre la acción, nunca la lectura del archivo.
    Hdr {
        pantalla: String,
        prender: bool,
    },
    #[serde(other)]
    Desconocida,
}

impl ActionV2 {
    /// La versión de hoy de esta acción, o `None` si `Accion` no la puede
    /// representar (las que se pierden en las listas viejas).
    pub fn a_accion(&self) -> Option<Accion> {
        match self {
            Self::Lanzar { destino, args, .. } => Some(Accion::Lanzar {
                destino: destino.clone(),
                args: args.clone(),
            }),
            Self::Volumen { nivel } => Some(Accion::Volumen { nivel: *nivel }),
            Self::Cerrar { .. } | Self::Esperar { .. } | Self::Hdr { .. } | Self::Desconocida => {
                None
            }
        }
    }
}

impl From<&Accion> for ActionV2 {
    fn from(accion: &Accion) -> Self {
        match accion {
            Accion::Lanzar { destino, args } => Self::Lanzar {
                destino: destino.clone(),
                args: args.clone(),
                etiqueta: None,
            },
            Accion::Volumen { nivel } => Self::Volumen { nivel: *nivel },
        }
    }
}

/// Las acciones de un perfil-escena (Displays v2, Fase 4): las de ENTRADA corren
/// al aplicar/confirmar el perfil; las de SALIDA corren cuando se pasa a OTRO
/// perfil (modelo "ida y vuelta"). Ambas listas vacías = perfil sin acciones,
/// idéntico a como se comportaba antes de la Fase 4.
///
/// `entrada_v2`/`salida_v2` (módulo escenas): la lista COMPLETA con todos los
/// tipos. Solo existen en las escenas que se guardaron con la versión nueva
/// (`None` = escena de hoy, no se escribe la clave). Quien lee usa `_v2` si
/// existe; si no, las viejas. Al guardar con `desde_v2` se escriben las dos.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PerfilAcciones {
    pub entrada: Vec<Accion>,
    pub salida: Vec<Accion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrada_v2: Option<Vec<ActionV2>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salida_v2: Option<Vec<ActionV2>>,
}

impl PerfilAcciones {
    /// Escritura doble: la lista completa en `_v2` y las viejas SOLO con
    /// Lanzar y Volumen (lo único que `Accion` sabe representar).
    pub fn desde_v2(entrada: Vec<ActionV2>, salida: Vec<ActionV2>) -> Self {
        // Una acción `Desconocida` (de una versión más nueva) no se puede guardar: se descarta.
        let sin_desconocidas = |lista: Vec<ActionV2>| -> Vec<ActionV2> {
            lista
                .into_iter()
                .filter(|accion| !matches!(accion, ActionV2::Desconocida))
                .collect()
        };
        let entrada = sin_desconocidas(entrada);
        let salida = sin_desconocidas(salida);
        Self {
            entrada: entrada.iter().filter_map(ActionV2::a_accion).collect(),
            salida: salida.iter().filter_map(ActionV2::a_accion).collect(),
            entrada_v2: Some(entrada),
            salida_v2: Some(salida),
        }
    }

    /// Las dos listas vacías (en todas sus formas) = perfil sin acciones.
    pub fn esta_vacia(&self) -> bool {
        self.entrada.is_empty()
            && self.salida.is_empty()
            && self.entrada_v2.as_ref().map_or(true, Vec::is_empty)
            && self.salida_v2.as_ref().map_or(true, Vec::is_empty)
    }

    /// La lista de entrada completa: `_v2` si existe; si no, las viejas convertidas.
    pub fn entrada_completa(&self) -> Vec<ActionV2> {
        match &self.entrada_v2 {
            Some(lista) => lista.clone(),
            None => self.entrada.iter().map(ActionV2::from).collect(),
        }
    }

    /// Ídem `entrada_completa` para la salida.
    pub fn salida_completa(&self) -> Vec<ActionV2> {
        match &self.salida_v2 {
            Some(lista) => lista.clone(),
            None => self.salida.iter().map(ActionV2::from).collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub revert_timeout_secs: u64,
    pub start_with_windows: bool,
    pub startup_profile_name: Option<String>,
    #[serde(default = "default_global_shortcuts_enabled")]
    pub global_shortcuts_enabled: bool,
    pub profile_shortcut_base: Option<String>,
    pub display_toggle_shortcut_base: Option<String>,
    pub profile_shortcuts: BTreeMap<String, String>,
    pub display_toggle_shortcuts: BTreeMap<String, String>,
    /// Salida de audio deseada por perfil (Displays v2, Fase 3), keyed por
    /// **nombre** de perfil — mismo lugar y patrón que `profile_shortcuts`. Sin
    /// entrada = ese perfil está en "No tocar el audio". Nace vacío en stores
    /// viejos gracias al `#[serde(default)]` a nivel struct.
    pub profile_audio: BTreeMap<String, AudioTarget>,
    /// Acciones por perfil-escena (Displays v2, Fase 4), keyed por **nombre** de
    /// perfil — mismo lugar y patrón que `profile_audio`. Sin entrada = perfil
    /// sin acciones (como antes de la Fase 4). Nace vacío en stores viejos por el
    /// `#[serde(default)]` a nivel struct.
    pub profile_actions: BTreeMap<String, PerfilAcciones>,
    /// Emoji por perfil-escena (módulo escenas), keyed por **nombre** de perfil —
    /// mismo patrón que `profile_audio`. Sin entrada = sin ícono. Nace vacío en
    /// stores viejos por el `#[serde(default)]` a nivel struct.
    pub profile_icons: BTreeMap<String, String>,
    /// Modos que reportó cada pantalla la última vez que estuvo prendida (módulo escenas,
    /// encargo 02), keyed por la **huella EDID** (`display_modes_key`, la misma de
    /// `display_fingerprints`), no por nombre de perfil. Solo se suma o reemplaza con una
    /// lista no vacía (`remember_display_modes`): nunca se vacía, así la TV apagada conserva
    /// los suyos. Nace vacío en stores viejos por el `#[serde(default)]` a nivel struct.
    pub display_modes: BTreeMap<String, Vec<DisplayMode>>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            revert_timeout_secs: 10,
            start_with_windows: false,
            startup_profile_name: None,
            global_shortcuts_enabled: true,
            profile_shortcut_base: Some(DEFAULT_PROFILE_SHORTCUT_BASE.to_string()),
            display_toggle_shortcut_base: Some(DEFAULT_DISPLAY_TOGGLE_SHORTCUT_BASE.to_string()),
            profile_shortcuts: BTreeMap::new(),
            display_toggle_shortcuts: BTreeMap::new(),
            profile_audio: BTreeMap::new(),
            profile_actions: BTreeMap::new(),
            profile_icons: BTreeMap::new(),
            display_modes: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub profiles: Vec<Profile>,
    pub display_fingerprints: Vec<DisplayFingerprint>,
    pub last_known_good_layout: Option<Layout>,
    pub last_restorable_layout: Option<Layout>,
    pub settings: AppSettings,
}
