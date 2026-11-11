//! Encargo 03 de escenas: las acciones nuevas (Cerrar, Esperar), la cola y las listas de
//! Steam y Chrome. Todo puro: la parte de Windows (cerrar ventanas de verdad) no entra acá.

use monarch::ActionV2;

use crate::displays::escenas::*;

// ── Sub-paso 1: los datos y su validación ───────────────────────────────────────────

fn borrador_con(entrada: serde_json::Value) -> SceneDraft {
    serde_json::from_value(serde_json::json!({
        "name": "Jugar",
        "outputs": [
            {"displayId": "1:1:101", "enabled": true, "primary": true, "x": 0, "y": 0,
             "width": 1920, "height": 1080, "refreshMhz": 60000}
        ],
        "entradaV2": entrada,
        "salidaV2": []
    }))
    .unwrap()
}

fn guardar(entrada: serde_json::Value) -> Result<Vec<ActionV2>, String> {
    datos_de_borrador(&borrador_con(entrada)).map(|d| d.entrada)
}

#[test]
fn cerrar_y_esperar_ahora_se_guardan() {
    let lista = guardar(serde_json::json!([
        {"tipo": "cerrar", "exe": "  Steam.EXE "},
        {"tipo": "esperar", "segundos": 5}
    ]))
    .unwrap();
    assert_eq!(
        lista,
        vec![
            ActionV2::Cerrar {
                exe: "steam.exe".to_string()
            },
            ActionV2::Esperar { segundos: 5 },
        ],
        "el exe se guarda sin mayúsculas ni espacios"
    );
}

#[test]
fn esperar_va_de_1_a_30() {
    for bueno in [1, 15, 30] {
        assert!(guardar(serde_json::json!([{"tipo": "esperar", "segundos": bueno}])).is_ok());
    }
    for malo in [0, 31, 255] {
        assert_eq!(
            guardar(serde_json::json!([{"tipo": "esperar", "segundos": malo}])).unwrap_err(),
            "esperar va de 1 a 30 segundos"
        );
    }
}

#[test]
fn cerrar_pide_un_nombre_de_exe_sin_carpeta() {
    let sin_carpeta = "el programa a cerrar va como nombre.exe, sin carpeta";
    for malo in [
        "C:\Juegos\steam.exe",
        "carpeta/steam.exe",
        "steam",
        "steam.bat",
        ".exe",
        "",
        "   ",
    ] {
        assert_eq!(
            guardar(serde_json::json!([{"tipo": "cerrar", "exe": malo}])).unwrap_err(),
            sin_carpeta,
            "con {malo:?}"
        );
    }
}

#[test]
fn cerrar_no_deja_elegir_la_lista_prohibida() {
    for prohibido in [
        "millennium-clipboard.exe",
        "explorer.exe",
        "dwm.exe",
        "csrss.exe",
        "winlogon.exe",
        "Explorer.EXE",
    ] {
        let error = guardar(serde_json::json!([{"tipo": "cerrar", "exe": prohibido}])).unwrap_err();
        assert_eq!(
            error,
            format!(
                "no se puede cerrar {}: lo necesita Windows o es esta app",
                prohibido.trim().to_lowercase()
            ),
            "con {prohibido:?}"
        );
    }
    // Un programa parecido pero distinto sí se puede.
    assert!(guardar(serde_json::json!([{"tipo": "cerrar", "exe": "explorer2.exe"}])).is_ok());
}

#[test]
fn cerrar_y_esperar_vuelven_igual_a_la_pantalla() {
    let datos = datos_de_borrador(&borrador_con(serde_json::json!([
        {"tipo": "cerrar", "exe": "steam.exe"},
        {"tipo": "esperar", "segundos": 30}
    ])))
    .unwrap();
    let salida = serde_json::to_value(
        datos
            .entrada
            .iter()
            .map(accion_a_dto)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(
        salida,
        serde_json::json!([
            {"tipo": "cerrar", "exe": "steam.exe"},
            {"tipo": "esperar", "segundos": 30}
        ])
    );
}
