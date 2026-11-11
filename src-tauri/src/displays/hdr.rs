// La acción HDR prender/apagar de las escenas (módulo escenas, encargo 07: la "03b" del spec).
//
// Corre SOLO como acción, en la cola (`cola.rs`), después de confirmar la escena; su único
// llamador es `EjecutorReal::hdr` (prueba `hdr_no_entra_al_camino_de_aplicar`). El HDR no pasa
// por `SetDisplayConfig` ni por el motor (`apply.rs`, `topology.rs`).
//
// Este archivo es PURO: no nombra a `windows` ni a `tauri`. Las llamadas de verdad entran por
// el trait `PantallasHdr`; en el programa lo implementa `acciones.rs`, y en las pruebas
// (`displays-tests`) una pantalla falsa.
//
// Reglas (spec, "Acciones nuevas" y encargo 07):
// - La pantalla se busca entre las PRENDIDAS: el id exacto o, si el adaptador cambió de LUID,
//   la única con el mismo EDID (sin EDID, el plan B del motor: mismo target en una sola placa).
//   Apagada, no conectada o ambigua: se saltea y va al log.
// - Sin soporte de HDR: log y sigue. Si ya está como se pide, no se toca.
// - Se pide con la llamada nueva (`SET_HDR_STATE`, 24H2) y, si no quedó, con la vieja
//   (`SET_ADVANCED_COLOR_STATE`). Doctrina: el código de retorno va solo al log; lo que decide
//   es RE-LEER el estado después de cada pedido, y si no quedó como se pidió: "HDR no cambió en
//   <pantalla>" (pruebas `si_la_nueva_dice_que_si_pero_no_cambio_nada...`, `si_ninguna_cambio...`).
// - Un paso que falla no frena a los demás: esto loguea y vuelve.
//
// panic="abort": nada de `unwrap`/`expect` acá.
#![cfg(target_os = "windows")]

use std::time::Duration;

use monarch::DisplayId;

use super::ids::parse_display_id;

/// Lo que Windows dice del HDR de una pantalla.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EstadoHdr {
    pub soportado: bool,
    pub prendido: bool,
}

/// Con qué llamada se pide el cambio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Llamada {
    /// `DISPLAYCONFIG_DEVICE_INFO_SET_HDR_STATE` (Windows 11 24H2 en adelante).
    Nueva,
    /// `DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE` (la de siempre).
    Vieja,
}

/// Lo que de verdad toca la PC.
pub trait PantallasHdr {
    /// Las pantallas prendidas ahora, con su nombre para el log.
    fn prendidas(&mut self) -> Result<Vec<(DisplayId, String)>, String>;
    /// El estado de HDR de una pantalla prendida; `None` si Windows no lo informa.
    fn leer(&mut self, id: &DisplayId) -> Option<EstadoHdr>;
    /// Pide el cambio; devuelve el código de Windows (solo para el log: no decide nada).
    fn pedir(&mut self, id: &DisplayId, prender: bool, llamada: Llamada) -> i32;
    fn dormir(&mut self, dur: Duration);
}

/// Cómo terminó una acción HDR (para el log y las pruebas).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desenlace {
    IdMalFormado,
    /// Apagada, no conectada o Windows no dijo qué pantallas hay.
    NoSeVe,
    /// Dos pantallas prendidas con el mismo EDID y ninguna con el id exacto.
    Ambigua,
    SinLectura,
    NoSoporta,
    YaEstaba,
    Cambio(Llamada),
    NoCambio,
}

/// Cuánto se espera, después de cada pedido, a que el cambio se vea al re-leer.
pub const ESPERA_DE_RELECTURA: Duration = Duration::from_secs(2);
const PAUSA_ENTRE_LECTURAS: Duration = Duration::from_millis(250);

/// Corre una acción HDR. No devuelve error: todo desenlace queda en el log y la cola sigue.
pub fn correr_hdr(io: &mut dyn PantallasHdr, pantalla: &str, prender: bool) -> Desenlace {
    let que = if prender { "prender" } else { "apagar" };
    let pedida = match parse_display_id(pantalla.trim()) {
        Ok(id) => id,
        Err(e) => {
            crate::runtime_log::warn(format!("[displays] HDR: se saltea, {e}"));
            return Desenlace::IdMalFormado;
        }
    };
    let prendidas = match io.prendidas() {
        Ok(lista) => lista,
        Err(e) => {
            crate::runtime_log::warn(format!(
                "[displays] HDR: se saltea, no se pudo saber qué pantallas están prendidas: {e}"
            ));
            return Desenlace::NoSeVe;
        }
    };
    let (id, nombre) = match buscar(&pedida, &prendidas) {
        Ok(encontrada) => encontrada,
        Err(desenlace) => {
            crate::runtime_log::info(format!(
                "[displays] HDR: se saltea {pantalla}: {}",
                if desenlace == Desenlace::Ambigua {
                    "hay dos pantallas iguales prendidas y no se adivina cuál"
                } else {
                    "la pantalla está apagada o no está conectada"
                }
            ));
            return desenlace;
        }
    };
    let Some(antes) = io.leer(&id) else {
        crate::runtime_log::warn(format!(
            "[displays] HDR: se saltea {nombre}: Windows no informa su estado de HDR"
        ));
        return Desenlace::SinLectura;
    };
    if !antes.soportado {
        crate::runtime_log::info(format!("[displays] HDR: {nombre} no soporta HDR; se saltea"));
        return Desenlace::NoSoporta;
    }
    if antes.prendido == prender {
        crate::runtime_log::info(format!("[displays] HDR: {nombre} ya estaba como se pide"));
        return Desenlace::YaEstaba;
    }
    for llamada in [Llamada::Nueva, Llamada::Vieja] {
        let codigo = io.pedir(&id, prender, llamada);
        if quedo_como_se_pidio(io, &id, prender) {
            crate::runtime_log::info(format!(
                "[displays] HDR: {que} en {nombre} (llamada {llamada:?}, código {codigo})"
            ));
            return Desenlace::Cambio(llamada);
        }
        crate::runtime_log::info(format!(
            "[displays] HDR: la llamada {llamada:?} no lo cambió en {nombre} (código {codigo})"
        ));
    }
    crate::runtime_log::warn(format!("[displays] HDR no cambió en {nombre}"));
    Desenlace::NoCambio
}

/// La pantalla pedida entre las prendidas: el id exacto; si no, la única con el mismo EDID.
/// Sin EDID, el plan B del motor (`topology.rs`): mismo `target_id`, también sin EDID, y solo si
/// esas candidatas están todas en UNA placa (iGPU y dGPU reusan los números de target).
fn buscar(
    pedida: &DisplayId,
    prendidas: &[(DisplayId, String)],
) -> Result<(DisplayId, String), Desenlace> {
    if let Some(exacta) = prendidas.iter().find(|(id, _)| id == pedida) {
        return Ok(exacta.clone());
    }
    let mismas: Vec<_> = match pedida.edid_hash {
        Some(edid) => prendidas
            .iter()
            .filter(|(id, _)| id.edid_hash == Some(edid))
            .collect(),
        None => {
            let por_target: Vec<_> = prendidas
                .iter()
                .filter(|(id, _)| id.edid_hash.is_none() && id.target_id == pedida.target_id)
                .collect();
            let una_placa = por_target
                .windows(2)
                .all(|par| par[0].0.adapter_luid == par[1].0.adapter_luid);
            if !una_placa {
                return Err(Desenlace::NoSeVe);
            }
            por_target
        }
    };
    match mismas.as_slice() {
        [una] => Ok((*una).clone()),
        [] => Err(Desenlace::NoSeVe),
        _ => Err(Desenlace::Ambigua),
    }
}

/// Re-lee hasta ver el estado pedido o hasta que pase `ESPERA_DE_RELECTURA`.
fn quedo_como_se_pidio(io: &mut dyn PantallasHdr, id: &DisplayId, prender: bool) -> bool {
    let mut esperado = Duration::ZERO;
    loop {
        if io.leer(id).map(|e| e.prendido) == Some(prender) {
            return true;
        }
        if esperado >= ESPERA_DE_RELECTURA || true { // MUTANTE 3: no espera a que se vea
            return false;
        }
        io.dormir(PAUSA_ENTRE_LECTURAS);
        esperado += PAUSA_ENTRE_LECTURAS;
    }
}
