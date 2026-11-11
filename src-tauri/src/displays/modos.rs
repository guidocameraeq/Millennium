//! Resoluciones por pantalla (módulo escenas, encargo 02): los tipos del selector de
//! resolución y las reglas PURAS sobre los modos (de un DEVMODE crudo a un modo, qué lista
//! ve cada pantalla, qué se puede guardar, qué avisar después de aplicar).
//!
//! Mismo molde que `escenas.rs`: los tipos (arriba) no tienen `cfg`, porque la firma del
//! comando compila en cualquier plataforma; las reglas (abajo) son solo Windows porque
//! nombran al crate `monarch`, pero no tocan ni `windows` ni `tauri`, así `displays-tests`
//! las incluye por `#[path]`. La lectura de Windows (`EnumDisplaySettingsExW`) vive en
//! `mod.rs`. Forma: `tools/ui-capturas/contrato-escenas.md`, `displays_list_display_modes`.

use serde::Serialize;

/// Un modo del selector: `{width, height, refreshMhz}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayModeView {
    pub width: u32,
    pub height: u32,
    pub refresh_mhz: u32,
}

/// Una pantalla con sus modos (una entrada de `displays_list_display_modes`).
///
/// `remembered: true` = la lista viene de memoria (apagada, no conectada o Windows no
/// contestó). `modes` vacía = nunca la vimos prendida: el editor ofrece solo "Dejar la que
/// tenga", que no viene en la lista.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayModesView {
    pub display_id: String,
    pub name: String,
    pub connected: bool,
    pub active: bool,
    pub remembered: bool,
    pub modes: Vec<DisplayModeView>,
}

#[cfg(target_os = "windows")]
pub use windows_impl::*;

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::collections::BTreeMap;

    use monarch::manager::display_modes_key;
    use monarch::model::{normalize_display_modes, DisplayMode};
    use monarch::{DisplayFingerprint, DisplayId, DisplayInfo, Profile};

    use super::{DisplayModeView, DisplayModesView};
    use crate::displays::escenas::mismo_monitor;
    use crate::displays::ids::format_display_id;

    /// Lo que Windows contestó para una pantalla prendida, ya normalizado.
    #[derive(Debug, Clone)]
    pub struct ModosLeidos {
        pub id: DisplayId,
        pub nombre: String,
        pub modos: Vec<DisplayMode>,
    }

    /// Una pantalla con su lista de modos, antes de pasarla a texto.
    #[derive(Debug, Clone)]
    pub struct ModosDePantalla {
        pub id: DisplayId,
        pub nombre: String,
        pub conectada: bool,
        pub activa: bool,
        pub recordados: bool,
        pub modos: Vec<DisplayMode>,
    }

    impl ModosDePantalla {
        pub fn a_vista(&self) -> DisplayModesView {
            DisplayModesView {
                display_id: format_display_id(&self.id),
                name: self.nombre.clone(),
                connected: self.conectada,
                active: self.activa,
                remembered: self.recordados,
                modes: self
                    .modos
                    .iter()
                    .map(|m| DisplayModeView {
                        width: m.width,
                        height: m.height,
                        refresh_mhz: m.refresh_mhz,
                    })
                    .collect(),
            }
        }
    }

    /// De los campos de un DEVMODE a un modo. `None` = no es un modo elegible: frecuencia 0 o 1
    /// (no es una frecuencia: es "la que tenga el hardware"), entrelazado (el apply no lo puede
    /// pedir) o tamaño 0.
    pub fn modo_de_devmode(
        width: u32,
        height: u32,
        frecuencia_hz: u32,
        entrelazado: bool,
    ) -> Option<DisplayMode> {
        if width == 0 || height == 0 || frecuencia_hz <= 1 || entrelazado {
            return None;
        }
        Some(DisplayMode {
            width,
            height,
            refresh_mhz: frecuencia_hz.saturating_mul(1000),
        })
    }

    /// Las pantallas del selector: las que Windows ve (en su orden) y después las que alguna
    /// escena nombra y hoy no están. Cada una con lo que Windows contestó recién (`leidos`);
    /// si no hay nada, con lo recordado en `recordados` (mapa `display_modes`).
    pub fn pantallas_con_modos(
        infos: &[DisplayInfo],
        perfiles: &[Profile],
        huellas: &[DisplayFingerprint],
        recordados: &BTreeMap<String, Vec<DisplayMode>>,
        leidos: &[ModosLeidos],
    ) -> Vec<ModosDePantalla> {
        let mut pantallas: Vec<ModosDePantalla> = Vec::new();
        for info in infos {
            if pantallas.iter().any(|p| mismo_monitor(&p.id, &info.id)) {
                continue;
            }
            let clave = display_modes_key(&info.id, &info.friendly_name);
            pantallas.push(armar(
                info.id.clone(),
                nombre_o_numero(&info.friendly_name, &info.id),
                true,
                info.is_active,
                clave,
                recordados,
                leidos,
            ));
        }
        for perfil in perfiles {
            for salida in &perfil.layout.outputs {
                let id = &salida.display_id;
                if pantallas.iter().any(|p| mismo_monitor(&p.id, id)) {
                    continue;
                }
                let huella = huellas.iter().find(|h| mismo_monitor(&h.display_id, id));
                let nombre = huella.map(|h| h.friendly_name.as_str()).unwrap_or("");
                pantallas.push(armar(
                    id.clone(),
                    nombre_o_numero(nombre, id),
                    false,
                    false,
                    huella.and_then(|h| h.edid_fingerprint.clone()),
                    recordados,
                    leidos,
                ));
            }
        }
        pantallas
    }

    fn armar(
        id: DisplayId,
        nombre: String,
        conectada: bool,
        activa: bool,
        clave: Option<String>,
        recordados: &BTreeMap<String, Vec<DisplayMode>>,
        leidos: &[ModosLeidos],
    ) -> ModosDePantalla {
        let recien = leidos
            .iter()
            .find(|l| mismo_monitor(&l.id, &id))
            .map(|l| normalize_display_modes(l.modos.clone()))
            .filter(|modos| !modos.is_empty());
        let (modos, recordados) = match recien {
            Some(modos) => (modos, false),
            None => match clave.and_then(|c| recordados.get(&c)) {
                Some(modos) => (normalize_display_modes(modos.clone()), true),
                None => (Vec::new(), false),
            },
        };
        let recordados = recordados && !modos.is_empty();
        ModosDePantalla {
            id,
            nombre,
            conectada,
            activa,
            recordados,
            modos,
        }
    }

    fn nombre_o_numero(nombre: &str, id: &DisplayId) -> String {
        if nombre.trim().is_empty() {
            format!("Pantalla {}", id.target_id)
        } else {
            nombre.to_string()
        }
    }
}
