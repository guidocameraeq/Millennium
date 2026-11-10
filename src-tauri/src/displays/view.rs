//! La vista de un monitor para el frontend y las funciones puras que la arman.
//!
//! Vive aparte de `mod.rs` y **sin ninguna dependencia de Windows** para que sus
//! tests corran en el crate `displays-tests` (ver su `Cargo.toml`). Es un movimiento
//! de código: la lógica es la misma que tenía `mod.rs`.

use serde::Serialize;

/// Un monitor, tal como lo ve el frontend.
///
/// Todo `u64` viaja como **string**: `adapter_luid` y `edid_hash` superan
/// `Number.MAX_SAFE_INTEGER` (2^53) y JavaScript los redondearía en silencio,
/// rompiendo la identidad del monitor justo en el campo que la define.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayView {
    /// Clave estable para el render por diff del frontend (`li.dataset.id`).
    pub id: String,
    pub name: String,
    pub active: bool,
    pub primary: bool,
    /// `0` en ambos ⇒ Windows no reporta modo para este monitor (está conectado
    /// pero apagado). La UI lo muestra como "—", no como "0x0".
    pub width: u32,
    pub height: u32,
    /// Refresco en **miliherz**, tal como lo entrega la CCD API (60000 = 60 Hz).
    /// El formateo a Hz lo hace el frontend.
    pub refresh_mhz: u32,
    pub position_x: i32,
    pub position_y: i32,
    pub adapter_luid: String,
    pub target_id: u32,
    pub edid_hash: Option<String>,
    /// `false` cuando apagar este monitor dejaría la máquina sin ninguna
    /// pantalla. La UI deshabilita el botón DETACH; el manager además lo rechaza
    /// por su cuenta, así que la guarda existe por duplicado a propósito: acá
    /// para no ofrecer un botón que no puede funcionar, allá para que ninguna
    /// otra vía de entrada se saltee la regla.
    ///
    /// Solo habla de **apagar**. En una fila ya apagada no se mira: si se
    /// interpretara ahí, ATTACH quedaría muerto y el monitor no se podría
    /// volver a prender nunca.
    pub can_detach: bool,
}

/// Marca qué monitores se pueden apagar: solo los activos, y solo si no son el
/// último que queda prendido.
///
/// Se calcula sobre la lista ya armada en vez de preguntarle al manager, así
/// vale igual para el camino de lectura de la Fase 1 (que no tiene manager) y
/// para el del apply.
pub(crate) fn mark_can_detach(views: &mut [DisplayView]) {
    let activos = views.iter().filter(|v| v.active).count();
    for view in views.iter_mut() {
        view.can_detach = view.active && activos > 1;
    }
}

/// Orden estable y con sentido para la UI: primario, después el resto de los
/// activos, después los desconectados. Dentro de cada grupo, por `target_id`.
///
/// Importa que sea determinista: el frontend renderiza por diff, y un orden que
/// baila haría saltar las filas en cada refresco.
pub(crate) fn sort_for_display(views: &mut [DisplayView]) {
    views.sort_by_key(|view| {
        let rank = if view.primary {
            0
        } else if view.active {
            1
        } else {
            2
        };
        (rank, view.target_id)
    });
}

/// Los tres monitores de mentira, copiados de `build_mock_backend()` de Monarch:
/// uno primario 1080p, uno lateral 1440p/144 Hz y uno vertical DESCONECTADO
/// (para poder ver el badge de detached sin desenchufar nada).
pub(crate) fn mock_displays() -> Vec<DisplayView> {
    let mut views = vec![
        DisplayView {
            id: "1:1:1".to_string(),
            name: "Primary Panel (Mock)".to_string(),
            active: true,
            primary: true,
            width: 1920,
            height: 1080,
            refresh_mhz: 60_000,
            position_x: 0,
            position_y: 0,
            adapter_luid: "1".to_string(),
            target_id: 1,
            edid_hash: Some("1".to_string()),
            can_detach: false, // lo calcula mark_can_detach
        },
        DisplayView {
            id: "1:2:2".to_string(),
            name: "Side Display (Mock)".to_string(),
            active: true,
            primary: false,
            width: 2560,
            height: 1440,
            refresh_mhz: 144_000,
            position_x: 1920,
            position_y: 0,
            adapter_luid: "1".to_string(),
            target_id: 2,
            edid_hash: Some("2".to_string()),
            can_detach: false,
        },
        DisplayView {
            id: "1:3:3".to_string(),
            name: "Portrait Display (Mock)".to_string(),
            active: false,
            primary: false,
            // Mismo centinela que el motor real para un monitor sin modo activo.
            width: 0,
            height: 0,
            refresh_mhz: 60_000,
            position_x: -1080,
            position_y: 0,
            adapter_luid: "1".to_string(),
            target_id: 3,
            edid_hash: Some("3".to_string()),
            can_detach: false,
        },
    ];
    mark_can_detach(&mut views);
    sort_for_display(&mut views);
    views
}
