//! Las listas para elegir (módulo escenas, encargo 03): los juegos de Steam, las cuentas de
//! Chrome y los programas abiertos. Forma y nombres: `tools/ui-capturas/contrato-escenas.md`.
//!
//! Todo es PURO a propósito (texto adentro, lista afuera, o una carpeta que le pasan): así
//! `displays-tests` lo prueba con archivos de muestra en una carpeta temporal. Dónde está Steam
//! o Chrome en la PC (registro, `%LOCALAPPDATA%`) lo averigua `acciones.rs`.
//!
//! Regla de la casa: sin Steam, sin Chrome o con un archivo ilegible, la lista sale VACÍA; nunca
//! es un error (el selector simplemente no ofrece nada).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::escenas::exe_prohibido;

/// Un juego de Steam instalado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGame {
    pub app_id: String,
    pub name: String,
}

/// Una cuenta (perfil) de Chrome: `directory` es lo que va en `--profile-directory=`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfile {
    pub directory: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfiles {
    pub chrome_path: Option<String>,
    pub profiles: Vec<ChromeProfile>,
}

/// Un programa abierto con ventana, para elegir cuál cerrar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProgram {
    pub exe: String,
    pub title: String,
}

// ── VDF (el formato de texto de Steam) ─────────────────────────────────────────────

/// Un nodo de un archivo VDF: un texto o un mapa de claves (con el orden del archivo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vdf {
    Texto(String),
    Mapa(Vec<(String, Vdf)>),
}

impl Vdf {
    /// El hijo de un mapa con esa clave (sin mayúsculas: Steam no es parejo con ellas).
    pub fn hijo(&self, clave: &str) -> Option<&Vdf> {
        match self {
            Vdf::Mapa(hijos) => hijos
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(clave))
                .map(|(_, v)| v),
            Vdf::Texto(_) => None,
        }
    }

    pub fn texto(&self) -> Option<&str> {
        match self {
            Vdf::Texto(t) => Some(t),
            Vdf::Mapa(_) => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Ficha {
    Texto(String),
    Abre,
    Cierra,
}

fn fichas(texto: &str) -> Vec<Ficha> {
    let mut salida = Vec::new();
    let mut it = texto.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' => salida.push(Ficha::Abre),
            '}' => salida.push(Ficha::Cierra),
            '"' => {
                let mut t = String::new();
                while let Some(c) = it.next() {
                    match c {
                        '"' => break,
                        // Steam escribe las barras de las rutas dobles (`C:\\Steam`).
                        '\\' => match it.next() {
                            Some('n') => t.push('\n'),
                            Some('t') => t.push('\t'),
                            Some(otro) => t.push(otro),
                            None => break,
                        },
                        otro => t.push(otro),
                    }
                }
                salida.push(Ficha::Texto(t));
            }
            // Comentarios `// ...` hasta el fin de la línea.
            '/' if it.peek() == Some(&'/') => {
                for c in it.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    salida
}

/// Lee un archivo VDF como un mapa de la raíz. Lo que no entiende lo ignora (no hay error).
pub fn leer_vdf(texto: &str) -> Vdf {
    let fichas = fichas(texto);
    let mut pos = 0usize;
    Vdf::Mapa(leer_mapa(&fichas, &mut pos, 0))
}

fn leer_mapa(fichas: &[Ficha], pos: &mut usize, hondo: usize) -> Vec<(String, Vdf)> {
    let mut hijos = Vec::new();
    // Tope de anidado: un archivo roto no puede hacer recursión sin fin.
    if hondo > 16 {
        return hijos;
    }
    while *pos < fichas.len() {
        match &fichas[*pos] {
            Ficha::Cierra => {
                *pos += 1;
                return hijos;
            }
            Ficha::Abre => {
                // Llave suelta sin clave: se lee y se tira.
                *pos += 1;
                let _ = leer_mapa(fichas, pos, hondo + 1);
            }
            Ficha::Texto(clave) => {
                *pos += 1;
                match fichas.get(*pos) {
                    Some(Ficha::Texto(valor)) => {
                        hijos.push((clave.clone(), Vdf::Texto(valor.clone())));
                        *pos += 1;
                    }
                    Some(Ficha::Abre) => {
                        *pos += 1;
                        let sub = leer_mapa(fichas, pos, hondo + 1);
                        hijos.push((clave.clone(), Vdf::Mapa(sub)));
                    }
                    _ => {}
                }
            }
        }
    }
    hijos
}

// ── Steam ──────────────────────────────────────────────────────────────────────────

/// Las carpetas de biblioteca que nombra un `libraryfolders.vdf` (formato nuevo con `path`, y el
/// viejo donde el valor es la ruta). No incluye la carpeta de Steam: eso lo suma quien llama.
pub fn bibliotecas_de_steam(libraryfolders: &str) -> Vec<PathBuf> {
    let raiz = leer_vdf(libraryfolders);
    let Some(Vdf::Mapa(carpetas)) = raiz.hijo("libraryfolders") else {
        return Vec::new();
    };
    let mut rutas = Vec::new();
    for (clave, valor) in carpetas {
        // Las bibliotecas se numeran "0", "1", ...; otras claves (contentstatsid...) no cuentan.
        if clave.is_empty() || !clave.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let ruta = match valor {
            Vdf::Texto(t) => Some(t.as_str()),
            Vdf::Mapa(_) => valor.hijo("path").and_then(Vdf::texto),
        };
        if let Some(ruta) = ruta.map(str::trim).filter(|r| !r.is_empty()) {
            rutas.push(PathBuf::from(ruta));
        }
    }
    rutas
}

/// `(appid, nombre)` de un `appmanifest_*.acf`, o `None` si le falta alguno de los dos.
pub fn juego_de_manifest(texto: &str) -> Option<(String, String)> {
    let raiz = leer_vdf(texto);
    let estado = raiz.hijo("AppState")?;
    let app_id = estado.hijo("appid")?.texto()?.trim().to_string();
    let name = estado.hijo("name")?.texto()?.trim().to_string();
    if app_id.is_empty() || name.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((app_id, name))
}

/// Cosas de Steam que figuran como "instaladas" pero no son juegos para jugar.
const NO_SON_JUEGOS: [&str; 1] = ["228980"]; // Steamworks Common Redistributables

/// Los juegos instalados en las bibliotecas de la carpeta de Steam `steam`, por nombre.
pub fn juegos_de_steam(steam: &Path) -> Vec<SteamGame> {
    let mut bibliotecas: Vec<PathBuf> = vec![steam.to_path_buf()];
    for archivo in [
        steam.join("steamapps").join("libraryfolders.vdf"),
        steam.join("config").join("libraryfolders.vdf"),
    ] {
        if let Ok(texto) = std::fs::read_to_string(&archivo) {
            bibliotecas.extend(bibliotecas_de_steam(&texto));
        }
    }

    let mut vistos = BTreeSet::new();
    let mut por_id: BTreeMap<String, String> = BTreeMap::new();
    for biblioteca in bibliotecas {
        if !vistos.insert(biblioteca.clone()) {
            continue;
        }
        let Ok(entradas) = std::fs::read_dir(biblioteca.join("steamapps")) else {
            continue;
        };
        for entrada in entradas.flatten() {
            let nombre = entrada.file_name().to_string_lossy().to_lowercase();
            if !(nombre.starts_with("appmanifest_") && nombre.ends_with(".acf")) {
                continue;
            }
            let Ok(texto) = std::fs::read_to_string(entrada.path()) else {
                continue;
            };
            if let Some((app_id, name)) = juego_de_manifest(&texto) {
                if !NO_SON_JUEGOS.contains(&app_id.as_str()) {
                    por_id.entry(app_id).or_insert(name);
                }
            }
        }
    }

    let mut juegos: Vec<SteamGame> = por_id
        .into_iter()
        .map(|(app_id, name)| SteamGame { app_id, name })
        .collect();
    juegos.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.app_id.cmp(&b.app_id))
    });
    juegos
}

// ── Chrome ─────────────────────────────────────────────────────────────────────────

/// Las cuentas de un `Local State` de Chrome (`profile.info_cache`), por nombre visible. Un JSON
/// roto o sin ese mapa da lista vacía.
pub fn cuentas_de_chrome(local_state: &str) -> Vec<ChromeProfile> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(local_state) else {
        return Vec::new();
    };
    let Some(mapa) = json
        .get("profile")
        .and_then(|p| p.get("info_cache"))
        .and_then(|c| c.as_object())
    else {
        return Vec::new();
    };
    let mut cuentas: Vec<ChromeProfile> = mapa
        .iter()
        .filter(|(directorio, _)| !directorio.trim().is_empty())
        .map(|(directorio, info)| {
            let nombre = info
                .get("name")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(directorio);
            ChromeProfile {
                directory: directorio.clone(),
                name: nombre.to_string(),
            }
        })
        .collect();
    cuentas.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.directory.cmp(&b.directory))
    });
    cuentas
}

// ── Programas abiertos ─────────────────────────────────────────────────────────────

/// De `(exe, título de una ventana)` a la lista del contrato: un renglón por exe en minúsculas,
/// sin la lista prohibida ni esta app (`propio`, en minúsculas), por título.
pub fn programas_abiertos(ventanas: Vec<(String, String)>, propio: &str) -> Vec<RunningProgram> {
    let mut por_exe: BTreeMap<String, String> = BTreeMap::new();
    for (exe, titulo) in ventanas {
        let exe = exe.trim().to_lowercase();
        if exe.is_empty() || exe_prohibido(&exe) || exe == propio {
            continue;
        }
        let titulo = titulo.trim().to_string();
        if titulo.is_empty() {
            continue;
        }
        por_exe.entry(exe).or_insert(titulo);
    }
    let mut lista: Vec<RunningProgram> = por_exe
        .into_iter()
        .map(|(exe, title)| RunningProgram { exe, title })
        .collect();
    lista.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.exe.cmp(&b.exe))
    });
    lista
}
