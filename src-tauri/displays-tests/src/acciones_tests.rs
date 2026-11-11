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
        r"C:\Juegos\steam.exe",
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

#[test]
fn la_lista_de_salida_se_valida_igual_que_la_de_entrada() {
    let con_salida = |salida: serde_json::Value| {
        let mut borrador = borrador_con(serde_json::json!([]));
        borrador.salida_v2 = serde_json::from_value(salida).unwrap();
        datos_de_borrador(&borrador)
    };
    let datos = con_salida(serde_json::json!([
        {"tipo": "esperar", "segundos": 3},
        {"tipo": "cerrar", "exe": "Steam.exe"}
    ]))
    .unwrap();
    assert_eq!(
        datos.salida,
        vec![
            ActionV2::Esperar { segundos: 3 },
            ActionV2::Cerrar {
                exe: "steam.exe".to_string()
            },
        ]
    );
    assert_eq!(
        con_salida(serde_json::json!([{"tipo": "cerrar", "exe": "explorer.exe"}])).unwrap_err(),
        "no se puede cerrar explorer.exe: lo necesita Windows o es esta app"
    );
    assert_eq!(
        con_salida(serde_json::json!([{"tipo": "esperar", "segundos": 0}])).unwrap_err(),
        "esperar va de 1 a 30 segundos"
    );
}

// ── Sub-paso 3: cerrar nunca mata ───────────────────────────────────────────────────

/// Cerrar manda el cierre amable y nada más. Esta prueba no corre Windows: mira el texto de
/// `acciones.rs` y falla si aparece cualquier forma de terminar un proceso a la fuerza.
#[test]
fn cerrar_un_programa_no_tiene_ninguna_forma_de_matar_el_proceso() {
    let fuente = include_str!("../../src/displays/acciones.rs");
    let codigo: String = fuente
        .lines()
        .filter(|linea| !linea.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("
")
        .to_lowercase();
    for prohibido in ["terminateprocess", "taskkill", ".kill(", "killprocess", "exitprocess"] {
        assert!(
            !codigo.contains(prohibido),
            "acciones.rs no puede usar {prohibido}: cerrar es solo el cierre amable"
        );
    }
    assert!(
        codigo.contains("wm_close"),
        "el cierre amable es WM_CLOSE; si cambió, esta prueba tiene que enterarse"
    );
}

#[test]
fn el_ejecutor_vuelve_a_preguntar_si_se_puede_cerrar() {
    assert!(se_puede_cerrar("steam.exe", "millennium-clipboard.exe"));
    assert!(se_puede_cerrar(" Steam.EXE ", "otra.exe"));
    for no in ["explorer.exe", " Explorer.EXE", "dwm.exe", "csrss.exe", "winlogon.exe", "", "  "] {
        assert!(!se_puede_cerrar(no, "x.exe"), "con {no:?}");
    }
    // Esta app, aunque la hayan renombrado.
    assert!(!se_puede_cerrar("mi-app-renombrada.exe", "Mi-App-Renombrada.exe"));
}

/// El orden de `confirm` no se puede probar sin Windows: se lee su texto. La escena queda activa
/// antes, el aviso de confirmado sale después y recién ahí se encolan las acciones.
#[test]
fn confirm_avisa_antes_de_encolar_y_fija_la_escena_antes() {
    let fuente = include_str!("../../src/displays/mod.rs");
    let desde = fuente.find("pub fn confirm(&self)").expect("no está confirm");
    let cuerpo = &fuente[desde..];
    let cuerpo = &cuerpo[..cuerpo.find("pub fn revert(").expect("no está revert")];
    let fijar = cuerpo.find("self.confirmar_escena_pendiente()").expect("no fija la escena");
    let aviso = cuerpo.find("\"kind\": \"confirmed\"").expect("no avisa confirmed");
    let encolar = cuerpo.find("self.0.cola.encolar(").expect("no encola");
    assert!(fijar < aviso && aviso < encolar, "el orden es fijar, avisar, encolar");

    let ciclo = fuente.find("fn preparar_ciclo_de_escena").expect("no está preparar_ciclo");
    let ciclo: String = fuente[ciclo..].chars().take(1500).collect();
    assert!(ciclo.contains("salida_completa()") && ciclo.contains("entrada_completa()"));
    assert!(!ciclo.contains(".salida.clone()") && !ciclo.contains(".entrada.clone()"));
}
