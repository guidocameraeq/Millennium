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
    use monarch::{DisplayFingerprint, DisplayId, DisplayInfo, Layout, OutputConfig, Profile};

    use super::{DisplayModeView, DisplayModesView};
    use crate::displays::escenas::mismo_monitor;
    use crate::displays::ids::format_display_id;

    /// Dos frecuencias son la misma si difieren en menos de 1 Hz: Windows lista los modos en
    /// Hz enteros (60) y la topología trae la exacta (59,94 Hz = 59940 mHz).
    const TOLERANCIA_MHZ: u32 = 1000;

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

    /// "60" o "59,94": la frecuencia en palabras para Guido.
    pub fn texto_hz(refresh_mhz: u32) -> String {
        if refresh_mhz % 1000 == 0 {
            return (refresh_mhz / 1000).to_string();
        }
        let texto = format!("{:.2}", refresh_mhz as f64 / 1000.0);
        texto
            .trim_end_matches('0')
            .trim_end_matches('.')
            .replace('.', ",")
    }

    fn texto_modo(o: &OutputConfig) -> String {
        format!(
            "{}×{} a {} Hz",
            o.resolution.width,
            o.resolution.height,
            texto_hz(o.refresh_rate_mhz)
        )
    }

    fn coincide(modo: &DisplayMode, o: &OutputConfig) -> bool {
        modo.width == o.resolution.width
            && modo.height == o.resolution.height
            && modo.refresh_mhz.abs_diff(o.refresh_rate_mhz) < TOLERANCIA_MHZ
    }

    /// GUARDAR: cada pantalla prendida con una resolución elegida tiene que llevar un modo de
    /// los que reportó (`pantallas`, lo mismo que ve el selector). "Dejar la que tenga" (0×0)
    /// siempre vale. También vale la resolución que la escena ya tenía guardada para esa
    /// pantalla (`original`), sin cambios: así una escena de antes se puede editar aunque su
    /// pantalla todavía no haya contado sus modos. Las apagadas no se miran: no se aplican.
    pub fn validar_resoluciones(
        layout: &Layout,
        original: Option<&Layout>,
        pantallas: &[ModosDePantalla],
    ) -> Result<(), String> {
        for o in layout.outputs.iter().filter(|o| o.enabled) {
            if o.resolution.width == 0 && o.resolution.height == 0 {
                continue;
            }
            let ya_la_tenia = original.is_some_and(|l| {
                l.outputs.iter().any(|v| {
                    mismo_monitor(&v.display_id, &o.display_id)
                        && v.resolution == o.resolution
                        && v.refresh_rate_mhz == o.refresh_rate_mhz
                })
            });
            if ya_la_tenia {
                continue;
            }
            let pantalla = pantallas.iter().find(|p| mismo_monitor(&p.id, &o.display_id));
            if pantalla.is_some_and(|p| p.modos.iter().any(|m| coincide(m, o))) {
                continue;
            }
            let nombre = pantalla
                .map(|p| p.nombre.clone())
                .unwrap_or_else(|| nombre_o_numero("", &o.display_id));
            if pantalla.map_or(true, |p| p.modos.is_empty()) {
                return Err(format!(
                    "todavía no sé qué resoluciones acepta {nombre}: prendela una vez o elegí \"Dejar la que tenga\""
                ));
            }
            return Err(format!(
                "{nombre} no reporta {}: elegí una de su lista o \"Dejar la que tenga\"",
                texto_modo(o)
            ));
        }
        Ok(())
    }

    /// Después de aplicar: para cada pantalla prendida con resolución elegida, ¿Windows la
    /// dejó así? `quedo` es lo que se re-leyó de Windows; una pantalla que no aparece prendida
    /// ahí no se juzga acá (eso lo cuenta el apply). Un aviso en palabras por pantalla.
    pub fn avisos_tras_aplicar(
        deseado: &Layout,
        quedo: &Layout,
        infos: &[DisplayInfo],
    ) -> Vec<String> {
        let mut avisos = Vec::new();
        for o in deseado.outputs.iter().filter(|o| o.enabled) {
            if o.resolution.width == 0 && o.resolution.height == 0 {
                continue;
            }
            let Some(real) = quedo
                .outputs
                .iter()
                .find(|q| q.enabled && mismo_monitor(&q.display_id, &o.display_id))
            else {
                continue;
            };
            let igual = real.resolution == o.resolution
                && real.refresh_rate_mhz.abs_diff(o.refresh_rate_mhz) < TOLERANCIA_MHZ;
            if igual {
                continue;
            }
            let nombre = infos
                .iter()
                .find(|d| mismo_monitor(&d.id, &o.display_id))
                .map(|d| nombre_o_numero(&d.friendly_name, &d.id))
                .unwrap_or_else(|| nombre_o_numero("", &o.display_id));
            avisos.push(format!(
                "pediste {} para {nombre}, pero Windows la dejó en {}",
                texto_modo(o),
                texto_modo(real)
            ));
        }
        avisos
    }
}
