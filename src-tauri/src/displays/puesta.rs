//! "Puesta ahora" (módulo escenas, encargo 04). Esqueleto: todavía no reconoce nada.

use monarch::{Layout, Profile};

pub fn coincide(_escena: &Layout, _actual: &Layout) -> bool {
    false
}

pub fn escena_puesta(_escenas: &[Profile], _actual: &Layout, _activa: Option<&str>) -> Option<String> {
    None
}
