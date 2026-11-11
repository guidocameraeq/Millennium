//! Encargo 07 de escenas (la "03b" del spec), sub-paso 2: la acción HDR (`displays/hdr.rs`)
//! con pantallas falsas. Nada de esto toca la PC: lo de Windows (las llamadas de verdad) lo
//! prueba Guido en la TV después del release.

use std::time::Duration;

use monarch::DisplayId;

use crate::displays::hdr::*;

fn id(luid: u64, target: u32, edid: Option<u64>) -> DisplayId {
    DisplayId {
        adapter_luid: luid,
        target_id: target,
        edid_hash: edid,
    }
}

/// Una pantalla falsa: qué se ve prendido, su estado de HDR y qué llamada "funciona".
struct Falsa {
    prendidas: Result<Vec<(DisplayId, String)>, String>,
    estado: Option<EstadoHdr>,
    /// Qué llamadas cambian de verdad el estado (las otras devuelven su código y no hacen nada).
    funcionan: Vec<Llamada>,
    /// El código que devuelve cada llamada (0 = "éxito" según Windows).
    codigo_nueva: i32,
    codigo_vieja: i32,
    /// Cuántas lecturas tarda en verse el cambio después de pedirlo.
    tarda: u32,
    pendiente: Option<(bool, u32)>,
    pedidos: Vec<(DisplayId, bool, Llamada)>,
    lecturas: u32,
    dormido: Duration,
}

impl Falsa {
    fn tele(soportado: bool, prendido: bool) -> Self {
        Self {
            prendidas: Ok(vec![
                (id(1, 1, Some(101)), "Monitor".to_string()),
                (id(1, 2, Some(202)), "TV".to_string()),
            ]),
            estado: Some(EstadoHdr {
                soportado,
                prendido,
            }),
            funcionan: vec![Llamada::Nueva, Llamada::Vieja],
            codigo_nueva: 0,
            codigo_vieja: 0,
            tarda: 0,
            pendiente: None,
            pedidos: Vec::new(),
            lecturas: 0,
            dormido: Duration::ZERO,
        }
    }
}

impl PantallasHdr for Falsa {
    fn prendidas(&mut self) -> Result<Vec<(DisplayId, String)>, String> {
        self.prendidas.clone()
    }

    fn leer(&mut self, _id: &DisplayId) -> Option<EstadoHdr> {
        self.lecturas += 1;
        if let Some((prender, faltan)) = self.pendiente {
            if faltan == 0 {
                if let Some(e) = self.estado.as_mut() {
                    e.prendido = prender;
                }
                self.pendiente = None;
            } else {
                self.pendiente = Some((prender, faltan - 1));
            }
        }
        self.estado
    }

    fn pedir(&mut self, id: &DisplayId, prender: bool, llamada: Llamada) -> i32 {
        self.pedidos.push((id.clone(), prender, llamada));
        if self.funcionan.contains(&llamada) {
            self.pendiente = Some((prender, self.tarda));
        }
        match llamada {
            Llamada::Nueva => self.codigo_nueva,
            Llamada::Vieja => self.codigo_vieja,
        }
    }

    fn dormir(&mut self, dur: Duration) {
        self.dormido += dur;
    }
}

const TV: &str = "1:2:202";

// ── La pantalla: id, apagada, remapeo por EDID ──────────────────────────────────────

#[test]
fn un_id_mal_formado_no_toca_nada() {
    let mut tv = Falsa::tele(true, false);
    assert_eq!(correr_hdr(&mut tv, "basura", true), Desenlace::IdMalFormado);
    assert!(tv.pedidos.is_empty());
    assert_eq!(tv.lecturas, 0);
}

#[test]
fn con_la_pantalla_apagada_o_no_conectada_se_saltea() {
    let mut tv = Falsa::tele(true, false);
    tv.prendidas = Ok(vec![(id(1, 1, Some(101)), "Monitor".to_string())]);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::NoSeVe);
    assert!(tv.pedidos.is_empty(), "a una pantalla apagada no se le pide nada");
    assert_eq!(tv.lecturas, 0, "ni se le lee el estado");
}

#[test]
fn si_windows_no_dice_que_pantallas_hay_se_saltea() {
    let mut tv = Falsa::tele(true, false);
    tv.prendidas = Err("QueryDisplayConfig falló".to_string());
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::NoSeVe);
    assert!(tv.pedidos.is_empty());
}

#[test]
fn la_pantalla_se_encuentra_por_edid_aunque_cambie_el_adaptador() {
    let mut tv = Falsa::tele(true, false);
    // Después de suspender, la misma TV vuelve con otro LUID de adaptador.
    tv.prendidas = Ok(vec![
        (id(1, 1, Some(101)), "Monitor".to_string()),
        (id(9, 7, Some(202)), "TV".to_string()),
    ]);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos, vec![(id(9, 7, Some(202)), true, Llamada::Nueva)]);
}

#[test]
fn el_id_exacto_gana_sobre_otra_con_el_mismo_edid() {
    let mut tv = Falsa::tele(true, false);
    tv.prendidas = Ok(vec![
        (id(9, 7, Some(202)), "TV gemela".to_string()),
        (id(1, 2, Some(202)), "TV".to_string()),
    ]);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos[0].0, id(1, 2, Some(202)));
}

#[test]
fn sin_edid_se_encuentra_por_target_si_hay_una_sola_placa() {
    // Una TV detrás de un receptor que no pasa el EDID: después de reiniciar cambia el LUID.
    let mut tv = Falsa::tele(true, false);
    tv.prendidas = Ok(vec![
        (id(9, 1, Some(101)), "Monitor".to_string()),
        (id(9, 2, None), "TV sin EDID".to_string()),
    ]);
    assert_eq!(correr_hdr(&mut tv, "1:2:none", true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos[0].0, id(9, 2, None));
}

#[test]
fn sin_edid_no_se_adivina_entre_dos_placas_ni_con_otro_target() {
    let mut dos_placas = Falsa::tele(true, false);
    dos_placas.prendidas = Ok(vec![
        (id(8, 2, None), "Una".to_string()),
        (id(9, 2, None), "Otra".to_string()),
    ]);
    assert_eq!(correr_hdr(&mut dos_placas, "1:2:none", true), Desenlace::NoSeVe);
    assert!(dos_placas.pedidos.is_empty());

    let mut otro_target = Falsa::tele(true, false);
    otro_target.prendidas = Ok(vec![(id(9, 3, None), "Otra".to_string())]);
    assert_eq!(correr_hdr(&mut otro_target, "1:2:none", true), Desenlace::NoSeVe);
    assert!(otro_target.pedidos.is_empty());

    // Una con EDID no la reemplaza aunque comparta el target.
    let mut con_edid = Falsa::tele(true, false);
    con_edid.prendidas = Ok(vec![(id(9, 2, Some(55)), "Con EDID".to_string())]);
    assert_eq!(correr_hdr(&mut con_edid, "1:2:none", true), Desenlace::NoSeVe);
}

#[test]
fn dos_gemelas_con_el_mismo_edid_y_ninguna_exacta_no_se_adivina() {
    let mut tv = Falsa::tele(true, false);
    tv.prendidas = Ok(vec![
        (id(8, 1, Some(202)), "TV A".to_string()),
        (id(9, 1, Some(202)), "TV B".to_string()),
    ]);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Ambigua);
    assert!(tv.pedidos.is_empty());
}

// ── El estado: soporte, ya estaba, lectura ──────────────────────────────────────────

#[test]
fn una_pantalla_sin_hdr_queda_en_el_log_y_no_se_le_pide_nada() {
    let mut tv = Falsa::tele(false, false);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::NoSoporta);
    assert!(tv.pedidos.is_empty());
}

#[test]
fn si_ya_estaba_como_se_pide_no_se_toca() {
    let mut prendida = Falsa::tele(true, true);
    assert_eq!(correr_hdr(&mut prendida, TV, true), Desenlace::YaEstaba);
    assert!(prendida.pedidos.is_empty());
    let mut apagada = Falsa::tele(true, false);
    assert_eq!(correr_hdr(&mut apagada, TV, false), Desenlace::YaEstaba);
    assert!(apagada.pedidos.is_empty());
}

#[test]
fn si_no_se_puede_leer_el_estado_no_se_toca() {
    let mut tv = Falsa::tele(true, false);
    tv.estado = None;
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::SinLectura);
    assert!(tv.pedidos.is_empty());
}

// ── Pedir y re-leer: decide lo que se re-lee, no el código de retorno ───────────────

#[test]
fn prender_con_la_llamada_nueva_y_no_hace_falta_la_vieja() {
    let mut tv = Falsa::tele(true, false);
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos.len(), 1);
    assert_eq!(tv.estado.map(|e| e.prendido), Some(true));
}

#[test]
fn apagar_tambien_anda() {
    let mut tv = Falsa::tele(true, true);
    assert_eq!(correr_hdr(&mut tv, TV, false), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos, vec![(id(1, 2, Some(202)), false, Llamada::Nueva)]);
}

#[test]
fn si_la_nueva_falla_cae_a_la_vieja() {
    let mut tv = Falsa::tele(true, false);
    tv.funcionan = vec![Llamada::Vieja];
    tv.codigo_nueva = 50; // ERROR_NOT_SUPPORTED: un Windows de antes de 24H2.
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Vieja));
    assert_eq!(
        tv.pedidos.iter().map(|p| p.2).collect::<Vec<_>>(),
        [Llamada::Nueva, Llamada::Vieja]
    );
}

#[test]
fn si_la_nueva_dice_que_si_pero_no_cambio_nada_igual_prueba_la_vieja() {
    let mut tv = Falsa::tele(true, false);
    tv.funcionan = vec![Llamada::Vieja];
    tv.codigo_nueva = 0;
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Vieja));
    assert_eq!(tv.pedidos.len(), 2);
}

#[test]
fn si_ninguna_cambio_nada_aunque_las_dos_digan_que_si_queda_en_el_log() {
    let mut tv = Falsa::tele(true, false);
    tv.funcionan = vec![];
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::NoCambio);
    assert_eq!(tv.pedidos.len(), 2, "probó las dos");
    assert_eq!(tv.estado.map(|e| e.prendido), Some(false));
}

#[test]
fn si_la_nueva_da_error_pero_igual_cambio_cuenta_lo_que_se_ve() {
    // Windows puede devolver un código raro y aplicar igual: manda lo que se re-lee.
    let mut tv = Falsa::tele(true, false);
    tv.codigo_nueva = 31;
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos.len(), 1);
}

#[test]
fn un_cambio_que_tarda_un_poco_en_verse_se_espera() {
    let mut tv = Falsa::tele(true, false);
    tv.tarda = 3;
    assert_eq!(correr_hdr(&mut tv, TV, true), Desenlace::Cambio(Llamada::Nueva));
    assert_eq!(tv.pedidos.len(), 1, "no hizo falta la vieja");
    assert!(tv.dormido > Duration::ZERO, "esperó entre lecturas");
}

#[test]
fn la_espera_de_la_relectura_tiene_tope() {
    let mut tv = Falsa::tele(true, false);
    tv.funcionan = vec![];
    correr_hdr(&mut tv, TV, true);
    assert!(
        tv.dormido <= ESPERA_DE_RELECTURA * 2,
        "dos llamadas, cada una con su espera de a lo sumo {ESPERA_DE_RELECTURA:?}: durmió {:?}",
        tv.dormido
    );
}

// ── HDR va solo como acción, fuera del camino de aplicar ────────────────────────────

/// Sin Windows no se puede correr el apply: se lee su texto. El motor no nombra al HDR nuevo
/// y la única entrada a `correr_hdr` es el ejecutor de la cola.
#[test]
fn hdr_no_entra_al_camino_de_aplicar() {
    let sin_comentarios = |fuente: &str| -> String {
        fuente
            .lines()
            .filter(|linea| !linea.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    for (nombre, fuente) in [
        ("apply.rs", include_str!("../../src/displays/apply.rs")),
        ("topology.rs", include_str!("../../src/displays/topology.rs")),
        ("watchdog.rs", include_str!("../../src/displays/watchdog.rs")),
        ("mod.rs", include_str!("../../src/displays/mod.rs")),
    ] {
        let codigo = sin_comentarios(fuente);
        for prohibido in ["correr_hdr", "hdr::", "SetDeviceInfo"] {
            assert!(
                !codigo.contains(prohibido),
                "{nombre} no puede usar {prohibido}: el HDR corre solo como acción, en la cola"
            );
        }
    }
    let acciones = sin_comentarios(include_str!("../../src/displays/acciones.rs"));
    assert_eq!(acciones.matches("correr_hdr(").count(), 1, "una sola entrada: EjecutorReal::hdr");
}
