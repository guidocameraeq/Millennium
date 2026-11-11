//! Encargo 01 de escenas, sub-paso 4: las conversiones puras de `displays/escenas.rs`
//! (borrador ↔ vendor, vista de escena, formas JSON del contrato).

use monarch::{
    Accion, ActionV2, AppSettings, AudioTarget, DisplayFingerprint, DisplayId, DisplayInfo,
    Layout, OutputConfig, PerfilAcciones, Position, Profile, Resolution,
};

use crate::displays::escenas::*;

fn id(target: u32) -> DisplayId {
    DisplayId {
        adapter_luid: 1,
        target_id: target,
        edid_hash: Some(target as u64 + 100),
    }
}

fn texto_id(target: u32) -> String {
    format!("1:{}:{}", target, target as u64 + 100)
}

fn salida(target: u32, enabled: bool, primary: bool) -> OutputConfig {
    OutputConfig {
        display_id: id(target),
        enabled,
        position: Position {
            x: if primary { 0 } else { 1920 },
            y: 0,
        },
        resolution: Resolution {
            width: 1920,
            height: 1080,
        },
        refresh_rate_mhz: 60_000,
        primary,
    }
}

fn info(target: u32, nombre: &str) -> DisplayInfo {
    DisplayInfo {
        id: id(target),
        friendly_name: nombre.to_string(),
        is_active: true,
        is_primary: target == 1,
        resolution: Resolution {
            width: 1920,
            height: 1080,
        },
        refresh_rate_mhz: 60_000,
    }
}

fn borrador_valido() -> SceneDraft {
    serde_json::from_value(serde_json::json!({
        "name": "  Jugar  ",
        "emoji": "🎮",
        "outputs": [
            {"displayId": texto_id(1), "name": "Monitor", "connected": true, "enabled": true,
             "primary": true, "x": 0, "y": 0, "width": 2560, "height": 1440, "refreshMhz": 144000},
            {"displayId": texto_id(2), "enabled": false, "primary": false, "x": 2560, "y": 0,
             "width": 0, "height": 0, "refreshMhz": 0}
        ],
        "audio": {"endpointId": "ep-tv", "friendlyName": "TV"},
        "entradaV2": [
            {"tipo": "lanzar", "destino": " steam://open/bigpicture ", "etiqueta": "Big Picture"},
            {"tipo": "volumen", "nivel": 40},
            {"tipo": "desconocida"}
        ],
        "salidaV2": [],
        "shortcut": "Ctrl+Alt+2",
        "startup": true
    }))
    .unwrap()
}

#[test]
fn un_borrador_valido_se_convierte_a_lo_que_guarda_el_vendor() {
    let datos = datos_de_borrador(&borrador_valido()).unwrap();
    assert_eq!(datos.name, "Jugar");
    assert_eq!(datos.layout.outputs.len(), 2);
    assert_eq!(datos.layout.outputs[0].display_id, id(1));
    assert_eq!(datos.layout.outputs[0].resolution.width, 2560);
    assert_eq!(datos.layout.outputs[0].refresh_rate_mhz, 144_000);
    // "Dejar la que tenga": 0×0 pasa tal cual aunque la frecuencia sea 0.
    assert_eq!(datos.layout.outputs[1].resolution.width, 0);
    assert_eq!(
        datos.entrada,
        vec![
            ActionV2::Lanzar {
                destino: "steam://open/bigpicture".to_string(),
                args: vec![],
                etiqueta: Some("Big Picture".to_string()),
            },
            ActionV2::Volumen { nivel: 40 },
        ],
        "la Desconocida se descarta y el destino se recorta"
    );
    assert_eq!(datos.audio.unwrap().endpoint_id, "ep-tv");
    assert!(datos.startup);
}

#[test]
fn los_errores_del_borrador_son_para_guido() {
    let con = |f: &dyn Fn(&mut serde_json::Value)| -> String {
        let mut valor = serde_json::to_value(borrador_valido()).unwrap();
        f(&mut valor);
        let borrador: SceneDraft = serde_json::from_value(valor).unwrap();
        datos_de_borrador(&borrador).unwrap_err()
    };

    // Id mal formado: error, nunca se adivina.
    assert!(con(&|v| v["outputs"][0]["displayId"] = "basura".into()).contains("mal formado"));
    // Resolución elegida sin frecuencia.
    assert_eq!(
        con(&|v| v["outputs"][0]["refreshMhz"] = 0.into()),
        "elegí una frecuencia para Monitor"
    );
    // Solo una de las dos medidas en cero.
    assert!(con(&|v| v["outputs"][0]["height"] = 0.into()).contains("no es válida"));
    // Acciones.
    assert_eq!(
        con(&|v| v["entradaV2"][1]["nivel"] = 101.into()),
        "el volumen va de 0 a 100"
    );
    assert_eq!(
        con(&|v| v["entradaV2"][0]["destino"] = "   ".into()),
        "falta qué abrir"
    );
    assert_eq!(
        con(&|v| v["entradaV2"] = serde_json::json!([{"tipo": "cerrar", "exe": "steam.exe"}])),
        "esta versión todavía no sabe guardar acciones cerrar"
    );
    assert_eq!(
        con(&|v| v["salidaV2"] = serde_json::json!([{"tipo": "esperar", "segundos": 5}])),
        "esta versión todavía no sabe guardar acciones esperar"
    );
    assert_eq!(
        con(&|v| v["salidaV2"] =
            serde_json::json!([{"tipo": "hdr", "pantalla": texto_id(1), "prender": true}])),
        "esta versión todavía no sabe guardar acciones hdr"
    );
}

#[test]
fn una_accion_con_un_tipo_que_no_existe_llega_como_desconocida() {
    let accion: ActionV2Dto = serde_json::from_str(r#"{"tipo":"del_futuro","x":1}"#).unwrap();
    assert!(matches!(accion, ActionV2Dto::Desconocida));
}

#[test]
fn la_vista_de_una_escena_sigue_la_forma_del_contrato() {
    let perfil = Profile {
        name: "Jugar".to_string(),
        layout: Layout {
            outputs: vec![salida(1, true, true), salida(2, false, false)],
        },
    };
    let mut ajustes = AppSettings::default();
    ajustes.profile_icons.insert("Jugar".to_string(), "🎮".to_string());
    ajustes.profile_shortcuts.insert("Jugar".to_string(), "Ctrl+Alt+2".to_string());
    ajustes.profile_audio.insert(
        "Jugar".to_string(),
        AudioTarget {
            endpoint_id: "ep".to_string(),
            friendly_name: "TV".to_string(),
        },
    );
    ajustes.startup_profile_name = Some("Jugar".to_string());
    // Una escena de HOY: solo listas viejas. La vista las convierte a v2.
    ajustes.profile_actions.insert(
        "Jugar".to_string(),
        PerfilAcciones {
            entrada: vec![Accion::Volumen { nivel: 30 }],
            ..Default::default()
        },
    );
    let infos = vec![info(1, "Monitor")]; // la 2 no está conectada hoy
    let fps = vec![DisplayFingerprint {
        display_id: id(2),
        friendly_name: "Proyector".to_string(),
        edid_fingerprint: None,
    }];

    let vista = vista_de_escena(&perfil, &ajustes, &fps, &infos, Some("Jugar"));
    let json = serde_json::to_value(&vista).unwrap();

    assert_eq!(json["name"], "Jugar");
    assert_eq!(json["emoji"], "🎮");
    assert_eq!(json["summary"], "1 monitor · 1920×1080");
    assert_eq!(json["shortcut"], "Ctrl+Alt+2");
    assert_eq!(json["startup"], true);
    assert_eq!(json["isCurrent"], true);
    assert_eq!(json["audio"]["endpointId"], "ep");
    assert_eq!(json["entradaV2"][0], serde_json::json!({"tipo": "volumen", "nivel": 30}));
    assert_eq!(json["salidaV2"], serde_json::json!([]));
    assert_eq!(json["outputs"][0]["displayId"], texto_id(1));
    assert_eq!(json["outputs"][0]["name"], "Monitor");
    assert_eq!(json["outputs"][0]["connected"], true);
    assert_eq!(json["outputs"][1]["name"], "Proyector");
    assert_eq!(json["outputs"][1]["connected"], false);
    assert_eq!(json["outputs"][1]["refreshMhz"], 60_000);

    // Y sin escena activa, el sello no se pone.
    let sin_sello = vista_de_escena(&perfil, &ajustes, &fps, &infos, None);
    assert!(!sin_sello.is_current);
}

#[test]
fn el_borrador_de_una_escena_agrega_las_pantallas_que_ella_no_nombra() {
    let perfil = Profile {
        name: "Sola".to_string(),
        layout: Layout {
            outputs: vec![salida(1, true, true)],
        },
    };
    let actual = Layout {
        outputs: vec![salida(1, true, true), salida(2, true, false)],
    };
    let infos = vec![info(1, "Monitor"), info(2, "TV")];
    let borrador = borrador_de_escena(&perfil, &AppSettings::default(), &actual, &[], &infos);
    assert_eq!(borrador.outputs.len(), 2);
    let tv = &borrador.outputs[1];
    assert_eq!(tv.name, "TV");
    assert!(!tv.enabled && !tv.primary, "la que la escena no nombra sale apagada");
    assert_eq!((tv.width, tv.height), (0, 0), "con Dejar la que tenga");
    assert!(tv.connected);
}

#[test]
fn el_borrador_en_blanco_prende_solo_la_principal() {
    let actual = Layout {
        outputs: vec![salida(1, true, false), salida(2, true, true)],
    };
    let infos = vec![info(1, "Monitor"), info(2, "TV")];
    let b = borrador_en_blanco(&actual, &[], &infos);
    assert_eq!(b.name, "Escena nueva");
    assert!(b.outputs[1].enabled && b.outputs[1].primary);
    assert_eq!((b.outputs[1].x, b.outputs[1].y), (0, 0));
    assert_eq!(b.outputs[1].width, 1920, "con su resolución de ahora");
    assert!(!b.outputs[0].enabled && !b.outputs[0].primary);
    assert_eq!((b.outputs[0].width, b.outputs[0].height), (0, 0));
    assert!(b.audio.is_none() && b.shortcut.is_none() && !b.startup);
}

#[test]
fn el_borrador_actual_es_lo_puesto_sin_nada_mas() {
    let actual = Layout {
        outputs: vec![salida(1, true, true), salida(2, false, false)],
    };
    let b = borrador_actual(&actual, &[], &[info(1, "Monitor")]);
    assert_eq!(b.outputs.len(), 2);
    assert!(b.outputs[0].enabled && !b.outputs[1].enabled);
    assert!(b.emoji.is_none() && b.entrada_v2.is_empty() && !b.startup);
}

#[test]
fn la_copia_no_lleva_atajo_ni_arranque_pero_si_el_resto() {
    let perfil = Profile {
        name: "Jugar".to_string(),
        layout: Layout {
            outputs: vec![salida(1, true, true)],
        },
    };
    let mut ajustes = AppSettings::default();
    ajustes.profile_shortcuts.insert("Jugar".to_string(), "Ctrl+Alt+2".to_string());
    ajustes.profile_icons.insert("Jugar".to_string(), "🎮".to_string());
    ajustes.startup_profile_name = Some("Jugar".to_string());
    let b = borrador_de_copia(
        &perfil,
        &ajustes,
        &perfil.layout,
        &[],
        &[info(1, "Monitor")],
        "Jugar (copia)".to_string(),
    );
    assert_eq!(b.name, "Jugar (copia)");
    assert_eq!(b.emoji.as_deref(), Some("🎮"));
    assert!(b.shortcut.is_none());
    assert!(!b.startup);
}

#[test]
fn el_resumen_es_el_de_siempre() {
    let dos = Layout {
        outputs: vec![salida(1, true, true), salida(2, true, false)],
    };
    assert_eq!(resumen(&dos), "2 monitores · 1920×1080, 1920×1080");
    let ninguna = Layout {
        outputs: vec![salida(1, false, false)],
    };
    assert_eq!(resumen(&ninguna), "sin monitores");
}
