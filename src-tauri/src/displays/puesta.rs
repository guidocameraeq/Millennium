//! "Puesta ahora" (módulo escenas, encargo 04): qué escena coincide con cómo están las
//! pantallas, aunque se hayan puesto a mano. PURO: sin el crate `windows`, sin `tauri` y sin tocar
//! el motor; `displays-tests` lo incluye por `#[path]` y lo prueba de verdad. Usa `monarch` y
//! `escenas::mismo_monitor`, que son solo Windows: en `mod.rs` se declara bajo
//! `#[cfg(target_os = "windows")]`, nunca junto a `mod escenas;`.
//!
//! Se compara lo que una escena **decide**: qué pantallas están prendidas, cuál es la principal
//! y dónde queda cada una respecto de la principal. No se comparan ids crudos (ADR-012): el
//! adaptador puede cambiar de LUID entre arranques, así que una pantalla es la misma si tiene el
//! mismo id o el mismo EDID (`escenas::mismo_monitor`, la misma noción que el remapeo del motor).
//! Un monitor que enumera sin EDID solo coincide por id exacto (no se adivina). Entre monitores gemelos (mismo EDID) la principal se empareja con la principal.

use monarch::{Layout, OutputConfig, Profile};

use super::escenas::mismo_monitor;

/// La principal de las pantallas prendidas: la marcada (la primera, si hubiera dos) o, si
/// ninguna lo está, la primera prendida. Es lo que hace `normalize_primary` del motor al aplicar.
fn principal_de<'a>(prendidas: &[&'a OutputConfig]) -> Option<&'a OutputConfig> {
    prendidas
        .iter()
        .find(|o| o.primary)
        .or_else(|| prendidas.first())
        .copied()
}

/// Empareja cada pantalla prendida de la escena con una prendida de `actual`: primero por id
/// exacto y después, entre las que sobran, por EDID. `None` si alguna se queda sin pareja.
fn emparejar<'a, 'b>(
    de_escena: &[&'a OutputConfig],
    de_actual: &[&'b OutputConfig],
) -> Option<Vec<(&'a OutputConfig, &'b OutputConfig)>> {
    let mut parejas: Vec<Option<usize>> = vec![None; de_escena.len()];
    let mut usada = vec![false; de_actual.len()];
    for (i, s) in de_escena.iter().enumerate() {
        if let Some(j) = (0..de_actual.len())
            .find(|&j| !usada[j] && de_actual[j].display_id == s.display_id)
        {
            parejas[i] = Some(j);
            usada[j] = true;
        }
    }
    for (i, s) in de_escena.iter().enumerate() {
        if parejas[i].is_some() {
            continue;
        }
        let libre_y_mismo = |j: usize| !usada[j] && mismo_monitor(&de_actual[j].display_id, &s.display_id);
        let j = (0..de_actual.len())
            .find(|&j| libre_y_mismo(j) && de_actual[j].primary == s.primary)
            .or_else(|| (0..de_actual.len()).find(|&j| libre_y_mismo(j)))?;
        parejas[i] = Some(j);
        usada[j] = true;
    }
    Some(
        de_escena
            .iter()
            .zip(parejas)
            .map(|(s, j)| (*s, de_actual[j.unwrap_or(0)]))
            .collect(),
    )
}

/// `true` si las pantallas de `actual` están como dice `escena`: las mismas prendidas, la misma
/// principal y cada una en el mismo lugar respecto de la principal.
pub fn coincide(escena: &Layout, actual: &Layout) -> bool {
    let de_escena: Vec<&OutputConfig> = escena.outputs.iter().filter(|o| o.enabled).collect();
    let de_actual: Vec<&OutputConfig> = actual.outputs.iter().filter(|o| o.enabled).collect();
    if de_escena.is_empty() || de_escena.len() != de_actual.len() {
        return false;
    }
    let Some(parejas) = emparejar(&de_escena, &de_actual) else {
        return false;
    };
    let (Some(principal_escena), Some(principal_actual)) =
        (principal_de(&de_escena), principal_de(&de_actual))
    else {
        return false;
    };
    let pareja_de_la_principal = parejas
        .iter()
        .find(|(s, _)| std::ptr::eq(*s, principal_escena))
        .map(|(_, a)| *a);
    if !pareja_de_la_principal.is_some_and(|a| std::ptr::eq(a, principal_actual)) {
        return false;
    }
    parejas.iter().all(|(s, a)| {
        s.position.x - principal_escena.position.x == a.position.x - principal_actual.position.x
            && s.position.y - principal_escena.position.y
                == a.position.y - principal_actual.position.y
    })
}

/// La escena "puesta ahora": a lo sumo UNA. Si coinciden varias gana `activa` (la que la app
/// aplicó y confirmó); si ninguna de las que coinciden es esa, la primera en el orden de Guido.
pub fn escena_puesta(escenas: &[Profile], actual: &Layout, activa: Option<&str>) -> Option<String> {
    let mut coinciden = escenas.iter().filter(|p| coincide(&p.layout, actual));
    let primera = coinciden.next()?;
    if let Some(nombre) = activa {
        if primera.name == nombre {
            return Some(primera.name.clone());
        }
        if coinciden.any(|p| p.name == nombre) {
            return Some(nombre.to_string());
        }
    }
    Some(primera.name.clone())
}

/// Prefijo del id de cada ítem del submenú "Escenas" de la bandeja.
pub const PREFIJO_MENU: &str = "tray_escena:";

/// El id de un ítem del menú: su lugar en la lista y el nombre (`tray_escena:<lugar>:<nombre>`).
pub fn id_de_menu(_lugar: usize, _nombre: &str) -> String {
    String::new()
}

/// De un clic en el menú a la escena a aplicar: `None` si el id no es de una escena o si esa
/// escena ya no existe en `nombres` (la lista de hoy). Manda el nombre; el lugar es el que
/// tenía en el menú, que pudo haberse corrido si se reordenó.
pub fn escena_del_menu(_id: &str, _nombres: &[String]) -> Option<String> {
    None
}
