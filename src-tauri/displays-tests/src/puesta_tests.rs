//! Encargo 04 de escenas, sub-paso 1: la "puesta ahora" (`displays/puesta.rs`). Casos de sí y
//! de no de la comparación de la foto actual con cada escena, y de la elección de UNA sola.

use monarch::{DisplayId, Layout, OutputConfig, Position, Profile, Resolution};

use crate::displays::puesta::{coincide, escena_puesta};

fn id(luid: u64, target: u32, edid: Option<u64>) -> DisplayId {
    DisplayId {
        adapter_luid: luid,
        target_id: target,
        edid_hash: edid,
    }
}

/// Una pantalla con EDID `100 + target` en el adaptador `luid`.
fn pantalla(luid: u64, target: u32, prendida: bool, principal: bool, x: i32, y: i32) -> OutputConfig {
    OutputConfig {
        display_id: id(luid, target, Some(100 + target as u64)),
        enabled: prendida,
        position: Position { x, y },
        resolution: Resolution {
            width: 1920,
            height: 1080,
        },
        refresh_rate_mhz: 60_000,
        primary: principal,
    }
}

fn layout(outputs: Vec<OutputConfig>) -> Layout {
    Layout { outputs }
}

fn escena(nombre: &str, l: Layout) -> Profile {
    Profile {
        name: nombre.to_string(),
        layout: l,
    }
}

/// Dos monitores lado a lado: el 1 principal en (0,0), el 2 a su derecha.
fn dos_lado_a_lado(luid: u64) -> Layout {
    layout(vec![
        pantalla(luid, 1, true, true, 0, 0),
        pantalla(luid, 2, true, false, 1920, 0),
    ])
}

// --- coincide: casos de sí ---------------------------------------------------------------------

#[test]
fn igual_a_la_foto_coincide() {
    assert!(coincide(&dos_lado_a_lado(1), &dos_lado_a_lado(1)));
}

#[test]
fn el_adaptador_cambio_de_luid_pero_el_edid_es_el_mismo_coincide() {
    // Ids crudos distintos (otro arranque), mismos monitores: ADR-012.
    assert!(coincide(&dos_lado_a_lado(1), &dos_lado_a_lado(99)));
}

#[test]
fn el_orden_de_las_pantallas_en_la_lista_no_importa() {
    let al_reves = layout(vec![
        pantalla(1, 2, true, false, 1920, 0),
        pantalla(1, 1, true, true, 0, 0),
    ]);
    assert!(coincide(&dos_lado_a_lado(1), &al_reves));
}

#[test]
fn la_posicion_se_compara_respecto_de_la_principal() {
    // Misma acomodación con la principal corrida de lugar: coincide.
    let corrida = layout(vec![
        pantalla(1, 1, true, true, 500, 200),
        pantalla(1, 2, true, false, 2420, 200),
    ]);
    assert!(coincide(&dos_lado_a_lado(1), &corrida));
}

#[test]
fn una_pantalla_apagada_en_la_escena_y_apagada_en_la_foto_coincide() {
    let escena_l = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, false, false, 0, 0),
    ]);
    let foto = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, false, false, 5, 5),
    ]);
    assert!(coincide(&escena_l, &foto));
}

#[test]
fn una_pantalla_apagada_que_la_foto_ni_enumera_coincide() {
    // La TV apagada no aparece en la foto: la escena la tiene apagada, no falta nada.
    let escena_l = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, false, false, 0, 0),
    ]);
    let foto = layout(vec![pantalla(1, 1, true, true, 0, 0)]);
    assert!(coincide(&escena_l, &foto));
}

#[test]
fn sin_principal_marcada_en_la_escena_vale_la_primera_prendida() {
    let sin_marcar = layout(vec![
        pantalla(1, 1, true, false, 0, 0),
        pantalla(1, 2, true, false, 1920, 0),
    ]);
    assert!(coincide(&sin_marcar, &dos_lado_a_lado(1)));
}

#[test]
fn dos_monitores_iguales_se_emparejan_uno_a_uno() {
    // Mismo modelo, mismo EDID: cada uno de la escena toma uno distinto de la foto.
    let gemelo = |luid: u64, target: u32, principal: bool, x: i32| OutputConfig {
        display_id: id(luid, target, Some(777)),
        ..pantalla(luid, target, true, principal, x, 0)
    };
    let escena_l = layout(vec![gemelo(1, 1, true, 0), gemelo(1, 2, false, 1920)]);
    let foto = layout(vec![gemelo(9, 7, true, 0), gemelo(9, 8, false, 1920)]);
    assert!(coincide(&escena_l, &foto));
}

// --- coincide: casos de no ---------------------------------------------------------------------

#[test]
fn una_pantalla_prendida_de_mas_en_la_foto_no_coincide() {
    let escena_l = layout(vec![pantalla(1, 1, true, true, 0, 0)]);
    assert!(!coincide(&escena_l, &dos_lado_a_lado(1)));
}

#[test]
fn una_pantalla_prendida_de_menos_en_la_foto_no_coincide() {
    let foto = layout(vec![pantalla(1, 1, true, true, 0, 0)]);
    assert!(!coincide(&dos_lado_a_lado(1), &foto));
}

#[test]
fn la_pantalla_que_la_escena_prende_y_no_esta_conectada_no_coincide() {
    let escena_l = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 3, true, false, 1920, 0),
    ]);
    assert!(!coincide(&escena_l, &dos_lado_a_lado(1)));
}

#[test]
fn otra_principal_no_coincide() {
    let foto = layout(vec![
        pantalla(1, 1, true, false, -1920, 0),
        pantalla(1, 2, true, true, 0, 0),
    ]);
    assert!(!coincide(&dos_lado_a_lado(1), &foto));
}

#[test]
fn otra_posicion_no_coincide() {
    let abajo = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, true, false, 0, 1080),
    ]);
    assert!(!coincide(&dos_lado_a_lado(1), &abajo));
}

#[test]
fn la_que_la_escena_apaga_y_la_foto_tiene_prendida_no_coincide() {
    let escena_l = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, false, false, 0, 0),
    ]);
    assert!(!coincide(&escena_l, &dos_lado_a_lado(1)));
}

#[test]
fn una_escena_sin_pantallas_prendidas_nunca_coincide() {
    let todas_apagadas = layout(vec![pantalla(1, 1, false, false, 0, 0)]);
    assert!(!coincide(&todas_apagadas, &todas_apagadas));
    assert!(!coincide(&layout(vec![]), &layout(vec![])));
}

#[test]
fn otro_lado_en_horizontal_no_coincide() {
    // Misma altura, la TV pasó de la derecha a la izquierda: solo difiere en x.
    let a_la_izquierda = layout(vec![
        pantalla(1, 1, true, true, 0, 0),
        pantalla(1, 2, true, false, -1920, 0),
    ]);
    assert!(!coincide(&dos_lado_a_lado(1), &a_la_izquierda));
}

#[test]
fn duplicadas_con_otra_principal_no_coincide() {
    // Modo duplicar: las dos en (0,0); lo único que cambia es cuál es la principal.
    let duplicadas = |principal: u32| {
        layout(vec![
            pantalla(1, 1, true, principal == 1, 0, 0),
            pantalla(1, 2, true, principal == 2, 0, 0),
        ])
    };
    assert!(coincide(&duplicadas(1), &duplicadas(1)));
    assert!(!coincide(&duplicadas(1), &duplicadas(2)));
}

#[test]
fn gemelos_listados_al_reves_se_emparejan_por_la_principal() {
    let gemelo = |luid: u64, target: u32, principal: bool, x: i32| OutputConfig {
        display_id: id(luid, target, Some(777)),
        ..pantalla(luid, target, true, principal, x, 0)
    };
    let escena_l = layout(vec![gemelo(1, 1, true, 0), gemelo(1, 2, false, 1920)]);
    let al_reves = layout(vec![gemelo(9, 8, false, 1920), gemelo(9, 7, true, 0)]);
    assert!(coincide(&escena_l, &al_reves));
}

// --- coincide: el monitor sin EDID -------------------------------------------------------------

fn sin_edid(luid: u64, target: u32, principal: bool, x: i32) -> OutputConfig {
    OutputConfig {
        display_id: id(luid, target, None),
        ..pantalla(luid, target, true, principal, x, 0)
    }
}

#[test]
fn sin_edid_y_con_el_mismo_id_coincide() {
    let l = layout(vec![sin_edid(1, 4, true, 0)]);
    assert!(coincide(&l, &l));
}

#[test]
fn sin_edid_y_con_otro_luid_no_se_adivina() {
    // Sin EDID no hay con qué reconocerlo si cambió el adaptador: no coincide, no se supone.
    let escena_l = layout(vec![sin_edid(1, 4, true, 0)]);
    let foto = layout(vec![sin_edid(2, 4, true, 0)]);
    assert!(!coincide(&escena_l, &foto));
}

#[test]
fn un_monitor_sin_edid_no_se_confunde_con_uno_que_si_lo_tiene() {
    let escena_l = layout(vec![sin_edid(1, 4, true, 0)]);
    let foto = layout(vec![pantalla(1, 4, true, true, 0, 0)]);
    assert!(!coincide(&escena_l, &foto));
}

// --- escena_puesta: a lo sumo una --------------------------------------------------------------

#[test]
fn ninguna_coincide_no_hay_puesta() {
    let escenas = vec![escena("Solo", layout(vec![pantalla(1, 1, true, true, 0, 0)]))];
    assert_eq!(escena_puesta(&escenas, &dos_lado_a_lado(1), None), None);
    assert_eq!(escena_puesta(&[], &dos_lado_a_lado(1), Some("Solo")), None);
}

#[test]
fn una_puesta_a_mano_se_reconoce_sin_escena_activa() {
    let escenas = vec![
        escena("Solo", layout(vec![pantalla(1, 1, true, true, 0, 0)])),
        escena("Doble", dos_lado_a_lado(1)),
    ];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), None),
        Some("Doble".to_string())
    );
}

#[test]
fn dos_escenas_iguales_gana_la_activa() {
    let escenas = vec![
        escena("Primera", dos_lado_a_lado(1)),
        escena("Segunda", dos_lado_a_lado(1)),
    ];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), Some("Segunda")),
        Some("Segunda".to_string())
    );
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), Some("Primera")),
        Some("Primera".to_string())
    );
}

#[test]
fn dos_escenas_iguales_y_ninguna_activa_gana_la_primera_en_el_orden() {
    let escenas = vec![
        escena("Primera", dos_lado_a_lado(1)),
        escena("Segunda", dos_lado_a_lado(1)),
    ];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), None),
        Some("Primera".to_string())
    );
}

#[test]
fn la_activa_que_ya_no_coincide_no_gana() {
    // La app aplicó "Solo" pero después se cambió a mano a dos monitores: manda lo que se ve.
    let escenas = vec![
        escena("Solo", layout(vec![pantalla(1, 1, true, true, 0, 0)])),
        escena("Doble", dos_lado_a_lado(1)),
    ];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), Some("Solo")),
        Some("Doble".to_string())
    );
}

#[test]
fn la_activa_que_no_existe_mas_no_rompe() {
    let escenas = vec![escena("Doble", dos_lado_a_lado(1))];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(1), Some("Borrada")),
        Some("Doble".to_string())
    );
}

#[test]
fn la_puesta_se_reconoce_con_el_remapeo_por_edid() {
    let escenas = vec![escena("Doble", dos_lado_a_lado(1))];
    assert_eq!(
        escena_puesta(&escenas, &dos_lado_a_lado(42), None),
        Some("Doble".to_string())
    );
}

// --- el id de los ítems de la bandeja ----------------------------------------------------------

use crate::displays::puesta::{escena_del_menu, id_de_menu, PREFIJO_MENU};

fn nombres(lista: &[&str]) -> Vec<String> {
    lista.iter().map(|n| n.to_string()).collect()
}

#[test]
fn el_id_del_menu_lleva_el_prefijo_el_lugar_y_el_nombre() {
    assert_eq!(id_de_menu(2, "Jugar"), format!("{PREFIJO_MENU}2:Jugar"));
}

#[test]
fn un_clic_sobre_una_escena_que_existe_la_devuelve() {
    let lista = nombres(&["Trabajo", "Jugar"]);
    assert_eq!(
        escena_del_menu(&id_de_menu(1, "Jugar"), &lista),
        Some("Jugar".to_string())
    );
}

#[test]
fn un_nombre_con_dos_puntos_vuelve_entero() {
    let lista = nombres(&["Peli: noche"]);
    assert_eq!(
        escena_del_menu(&id_de_menu(0, "Peli: noche"), &lista),
        Some("Peli: noche".to_string())
    );
}

#[test]
fn un_clic_sobre_una_escena_borrada_no_aplica() {
    let lista = nombres(&["Trabajo"]);
    assert_eq!(escena_del_menu(&id_de_menu(1, "Jugar"), &lista), None);
}

#[test]
fn una_escena_que_cambio_de_lugar_se_sigue_encontrando_por_nombre() {
    let lista = nombres(&["Jugar", "Trabajo"]);
    assert_eq!(
        escena_del_menu(&id_de_menu(1, "Jugar"), &lista),
        Some("Jugar".to_string())
    );
}

#[test]
fn un_id_que_no_es_de_escena_o_esta_mal_formado_no_aplica() {
    let lista = nombres(&["Jugar"]);
    assert_eq!(escena_del_menu("tray_quit", &lista), None);
    assert_eq!(escena_del_menu("tray_escena:Jugar", &lista), None);
    assert_eq!(escena_del_menu("tray_escena:x:Jugar", &lista), None);
}
