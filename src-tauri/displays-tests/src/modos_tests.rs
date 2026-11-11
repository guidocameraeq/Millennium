//! Encargo 02 de escenas: las reglas puras de `displays/modos.rs` (de un DEVMODE a un modo,
//! qué lista ve cada pantalla del selector).

use std::collections::BTreeMap;

use monarch::manager::display_modes_key;
use monarch::model::DisplayMode;
use monarch::{
    DisplayFingerprint, DisplayId, DisplayInfo, Layout, OutputConfig, Position, Profile,
    Resolution,
};

use crate::displays::modos::*;

fn id(target: u32) -> DisplayId {
    DisplayId {
        adapter_luid: 1,
        target_id: target,
        edid_hash: Some(target as u64 + 100),
    }
}

fn info(target: u32, nombre: &str, activa: bool) -> DisplayInfo {
    DisplayInfo {
        id: id(target),
        friendly_name: nombre.to_string(),
        is_active: activa,
        is_primary: target == 1,
        resolution: Resolution {
            width: 1920,
            height: 1080,
        },
        refresh_rate_mhz: 60_000,
    }
}

fn modo(width: u32, height: u32, refresh_mhz: u32) -> DisplayMode {
    DisplayMode {
        width,
        height,
        refresh_mhz,
    }
}

fn huella(target: u32, nombre: &str) -> DisplayFingerprint {
    DisplayFingerprint {
        display_id: id(target),
        friendly_name: nombre.to_string(),
        edid_fingerprint: display_modes_key(&id(target), nombre),
    }
}

fn escena_con(targets: &[u32]) -> Profile {
    Profile {
        name: "Jugar".to_string(),
        layout: Layout {
            outputs: targets
                .iter()
                .map(|t| OutputConfig {
                    display_id: id(*t),
                    enabled: true,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 1920,
                        height: 1080,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: *t == 1,
                })
                .collect(),
        },
    }
}

fn recordados_de(target: u32, nombre: &str, modos: Vec<DisplayMode>) -> BTreeMap<String, Vec<DisplayMode>> {
    let mut mapa = BTreeMap::new();
    mapa.insert(display_modes_key(&id(target), nombre).unwrap(), modos);
    mapa
}

// --- de un DEVMODE a un modo -----------------------------------------------------------

#[test]
fn un_devmode_normal_es_un_modo_en_mhz() {
    assert_eq!(modo_de_devmode(3840, 2160, 60, false), Some(modo(3840, 2160, 60_000)));
}

#[test]
fn frecuencia_cero_o_uno_entrelazado_o_tamano_cero_no_son_modos() {
    assert_eq!(modo_de_devmode(1920, 1080, 0, false), None);
    assert_eq!(modo_de_devmode(1920, 1080, 1, false), None, "1 = la del hardware");
    assert_eq!(modo_de_devmode(1920, 1080, 60, true), None, "entrelazado");
    assert_eq!(modo_de_devmode(0, 1080, 60, false), None);
    assert_eq!(modo_de_devmode(1920, 0, 60, false), None);
}

// --- qué lista ve cada pantalla --------------------------------------------------------

#[test]
fn una_pantalla_prendida_muestra_lo_que_contesto_windows() {
    let leidos = vec![ModosLeidos {
        id: id(1),
        nombre: "Monitor".to_string(),
        modos: vec![modo(1920, 1080, 60_000), modo(2560, 1440, 144_000), modo(1920, 1080, 60_000)],
    }];
    let recordados = recordados_de(1, "Monitor", vec![modo(800, 600, 60_000)]);
    let pantallas = pantallas_con_modos(&[info(1, "Monitor", true)], &[], &[], &recordados, &leidos);
    assert_eq!(pantallas.len(), 1);
    let p = &pantallas[0];
    assert!(p.conectada && p.activa);
    assert!(!p.recordados, "viene de Windows, no de memoria");
    assert_eq!(p.modos, vec![modo(2560, 1440, 144_000), modo(1920, 1080, 60_000)]);
}

#[test]
fn la_tv_apagada_muestra_lo_recordado() {
    let recordados = recordados_de(2, "LG TV", vec![modo(3840, 2160, 60_000)]);
    let pantallas = pantallas_con_modos(&[info(2, "LG TV", false)], &[], &[], &recordados, &[]);
    let p = &pantallas[0];
    assert!(p.conectada && !p.activa);
    assert!(p.recordados);
    assert_eq!(p.modos, vec![modo(3840, 2160, 60_000)]);
}

#[test]
fn si_windows_contesta_vacio_sale_lo_recordado() {
    let leidos = vec![ModosLeidos {
        id: id(2),
        nombre: "LG TV".to_string(),
        modos: vec![],
    }];
    let recordados = recordados_de(2, "LG TV", vec![modo(3840, 2160, 60_000)]);
    let pantallas = pantallas_con_modos(&[info(2, "LG TV", true)], &[], &[], &recordados, &leidos);
    assert!(pantallas[0].recordados);
    assert_eq!(pantallas[0].modos, vec![modo(3840, 2160, 60_000)]);
}

#[test]
fn una_pantalla_que_nunca_vimos_prendida_sale_con_la_lista_vacia() {
    let pantallas =
        pantallas_con_modos(&[info(2, "LG TV", false)], &[], &[], &BTreeMap::new(), &[]);
    assert!(pantallas[0].modos.is_empty());
    assert!(!pantallas[0].recordados, "sin lista no hay nada recordado");
}

#[test]
fn una_pantalla_que_solo_nombra_una_escena_sale_no_conectada_con_lo_recordado() {
    let recordados = recordados_de(3, "Proyector", vec![modo(1280, 720, 60_000)]);
    let pantallas = pantallas_con_modos(
        &[info(1, "Monitor", true)],
        &[escena_con(&[1, 3])],
        &[huella(3, "Proyector")],
        &recordados,
        &[],
    );
    assert_eq!(pantallas.len(), 2, "el monitor 1 no se repite");
    let p = &pantallas[1];
    assert_eq!(p.nombre, "Proyector");
    assert!(!p.conectada && !p.activa);
    assert!(p.recordados);
    assert_eq!(p.modos, vec![modo(1280, 720, 60_000)]);
}

#[test]
fn la_misma_pantalla_con_otro_luid_no_se_repite() {
    // El adaptador cambió de LUID entre arranques: la escena guarda el id viejo.
    let mut escena = escena_con(&[1]);
    escena.layout.outputs[0].display_id.adapter_luid = 99;
    let pantallas =
        pantallas_con_modos(&[info(1, "Monitor", true)], &[escena], &[], &BTreeMap::new(), &[]);
    assert_eq!(pantallas.len(), 1);
}

#[test]
fn la_vista_sale_con_los_nombres_del_contrato() {
    let p = ModosDePantalla {
        id: id(2),
        nombre: "LG TV".to_string(),
        conectada: true,
        activa: false,
        recordados: true,
        modos: vec![modo(3840, 2160, 60_000)],
    };
    let json = serde_json::to_value(p.a_vista()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "displayId": "1:2:102", "name": "LG TV", "connected": true, "active": false,
            "remembered": true,
            "modes": [ { "width": 3840, "height": 2160, "refreshMhz": 60000 } ]
        })
    );
}

// --- GUARDAR: solo modos de la lista (sub-paso 3) --------------------------------------

fn salida(target: u32, enabled: bool, width: u32, height: u32, refresh_mhz: u32) -> OutputConfig {
    OutputConfig {
        display_id: id(target),
        enabled,
        position: Position { x: 0, y: 0 },
        resolution: Resolution { width, height },
        refresh_rate_mhz: refresh_mhz,
        primary: target == 1,
    }
}

fn tv_con(modos: Vec<DisplayMode>) -> Vec<ModosDePantalla> {
    vec![ModosDePantalla {
        id: id(2),
        nombre: "LG TV".to_string(),
        conectada: true,
        activa: false,
        recordados: true,
        modos,
    }]
}

fn layout_de(salidas: Vec<OutputConfig>) -> Layout {
    Layout { outputs: salidas }
}

#[test]
fn guardar_acepta_un_modo_de_la_lista() {
    let layout = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    assert_eq!(
        validar_resoluciones(&layout, None, &tv_con(vec![modo(3840, 2160, 60_000)])),
        Ok(())
    );
}

#[test]
fn guardar_acepta_la_frecuencia_exacta_de_un_modo_en_hz_enteros() {
    // Windows lista 60 Hz y la topología trae 59,94: es el mismo modo.
    let layout = layout_de(vec![salida(2, true, 3840, 2160, 59_940)]);
    assert_eq!(
        validar_resoluciones(&layout, None, &tv_con(vec![modo(3840, 2160, 60_000)])),
        Ok(())
    );
}

#[test]
fn guardar_rechaza_un_modo_que_no_esta_en_la_lista() {
    let layout = layout_de(vec![salida(2, true, 2560, 1440, 60_000)]);
    let error = validar_resoluciones(&layout, None, &tv_con(vec![modo(3840, 2160, 60_000)]))
        .unwrap_err();
    assert_eq!(
        error,
        "LG TV no reporta 2560×1440 a 60 Hz: elegí una de su lista o \"Dejar la que tenga\""
    );
}

#[test]
fn guardar_rechaza_otra_frecuencia_de_la_misma_resolucion() {
    let layout = layout_de(vec![salida(2, true, 3840, 2160, 120_000)]);
    assert!(validar_resoluciones(&layout, None, &tv_con(vec![modo(3840, 2160, 60_000)])).is_err());
}

#[test]
fn guardar_sin_modos_conocidos_dice_que_hay_que_prenderla() {
    let layout = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let error = validar_resoluciones(&layout, None, &tv_con(vec![])).unwrap_err();
    assert!(error.starts_with("todavía no sé qué resoluciones acepta LG TV"), "{error}");
    // Y una pantalla que el selector ni conoce, igual.
    assert!(validar_resoluciones(&layout, None, &[]).is_err());
}

#[test]
fn dejar_la_que_tenga_siempre_se_puede_guardar() {
    let layout = layout_de(vec![salida(2, true, 0, 0, 60_000)]);
    assert_eq!(validar_resoluciones(&layout, None, &tv_con(vec![])), Ok(()));
}

#[test]
fn una_pantalla_apagada_no_se_valida() {
    let layout = layout_de(vec![salida(2, false, 2560, 1440, 60_000)]);
    assert_eq!(validar_resoluciones(&layout, None, &tv_con(vec![])), Ok(()));
}

#[test]
fn editar_una_escena_de_antes_conserva_su_resolucion_aunque_no_haya_modos() {
    let original = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let mismo = original.clone();
    assert_eq!(validar_resoluciones(&mismo, Some(&original), &tv_con(vec![])), Ok(()));
    // Pero si la cambia por otra que la TV no reportó, no.
    let cambiada = layout_de(vec![salida(2, true, 1920, 1080, 60_000)]);
    assert!(validar_resoluciones(&cambiada, Some(&original), &tv_con(vec![])).is_err());
}

// --- después de aplicar ----------------------------------------------------------------

#[test]
fn si_windows_la_dejo_como_se_pidio_no_hay_aviso() {
    let deseado = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let quedo = layout_de(vec![salida(2, true, 3840, 2160, 59_940)]);
    assert!(avisos_tras_aplicar(&deseado, &quedo, &[info(2, "LG TV", true)]).is_empty());
}

#[test]
fn si_windows_puso_otra_resolucion_avisa_en_palabras() {
    let deseado = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let quedo = layout_de(vec![salida(2, true, 1920, 1080, 59_940)]);
    assert_eq!(
        avisos_tras_aplicar(&deseado, &quedo, &[info(2, "LG TV", true)]),
        vec!["pediste 3840×2160 a 60 Hz para LG TV, pero Windows la dejó en 1920×1080 a 59,94 Hz"
            .to_string()]
    );
}

#[test]
fn si_windows_puso_otra_frecuencia_tambien_avisa() {
    let deseado = layout_de(vec![salida(2, true, 3840, 2160, 120_000)]);
    let quedo = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    assert_eq!(avisos_tras_aplicar(&deseado, &quedo, &[]).len(), 1);
}

#[test]
fn dejar_la_que_tenga_y_las_apagadas_no_se_juzgan() {
    let deseado = layout_de(vec![salida(1, true, 0, 0, 60_000), salida(2, false, 3840, 2160, 60_000)]);
    let quedo = layout_de(vec![salida(1, true, 1920, 1080, 60_000)]);
    assert!(avisos_tras_aplicar(&deseado, &quedo, &[]).is_empty());
}

#[test]
fn la_frecuencia_en_palabras() {
    assert_eq!(texto_hz(60_000), "60");
    assert_eq!(texto_hz(59_940), "59,94");
    assert_eq!(texto_hz(59_500), "59,5");
    assert_eq!(texto_hz(59_999), "60");
}

// --- mutación (riesgo alto): los mutantes que sobrevivían ------------------------------

#[test]
fn ya_la_tenia_cuenta_tambien_la_frecuencia() {
    // Mutante: comparar solo ancho y alto con la escena original.
    let original = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let otra_frecuencia = layout_de(vec![salida(2, true, 3840, 2160, 120_000)]);
    assert!(validar_resoluciones(&otra_frecuencia, Some(&original), &tv_con(vec![])).is_err());
}

#[test]
fn un_hz_entero_de_diferencia_ya_es_otro_modo() {
    // Mutante: la tolerancia con `<=`. 59 Hz y 60 Hz son modos distintos.
    let layout = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    assert!(validar_resoluciones(&layout, None, &tv_con(vec![modo(3840, 2160, 59_000)])).is_err());
    let deseado = layout_de(vec![salida(2, true, 3840, 2160, 60_000)]);
    let quedo = layout_de(vec![salida(2, true, 3840, 2160, 59_000)]);
    assert_eq!(avisos_tras_aplicar(&deseado, &quedo, &[]).len(), 1);
}

#[test]
fn una_lista_vacia_en_el_archivo_no_cuenta_como_recordada() {
    // Un displays.json editado a mano (o de otra versión) con la lista vacía.
    let recordados = recordados_de(2, "LG TV", vec![]);
    let pantallas = pantallas_con_modos(&[info(2, "LG TV", false)], &[], &[], &recordados, &[]);
    assert!(pantallas[0].modos.is_empty());
    assert!(!pantallas[0].recordados);
}

#[test]
fn ya_la_tenia_es_de_la_misma_pantalla_no_de_otra() {
    // Mutante: `mismo_monitor` → `true`. El monitor 1 ya estaba a 4K; la TV (2), que nunca
    // contó sus modos, no hereda ese permiso.
    let original = layout_de(vec![salida(1, true, 3840, 2160, 60_000)]);
    let borrador = layout_de(vec![
        salida(1, true, 3840, 2160, 60_000),
        salida(2, true, 3840, 2160, 60_000),
    ]);
    assert!(validar_resoluciones(&borrador, Some(&original), &tv_con(vec![])).is_err());
}
