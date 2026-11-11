//! Encargo 01 de escenas, sub-paso 1: los datos nuevos (`ActionV2`, `_v2`, `profile_icons`).
//!
//! La regla que cuidan (criterio 7 del spec): un `displays.json` guardado con la versión
//! nueva lo abre la versión de HOY sin tratarlo de corrupto y con las escenas iguales; y un
//! `displays.json` de hoy abre igual en la nueva. `hoy` es una copia de los structs que
//! tenía el modelo antes de este encargo: si alguien toca `Accion` o agrega un campo sin
//! `serde(default)`, estas pruebas lo ven.

use monarch::{
    Accion, ActionV2, AppConfig, DisplayId, Layout, OutputConfig, PerfilAcciones, Position,
    Profile, Resolution,
};

/// El modelo tal como estaba antes del encargo 01 (solo lo que cambia: ajustes y acciones).
mod hoy {
    use std::collections::BTreeMap;

    use monarch::{AudioTarget, DisplayFingerprint, Layout, Profile};
    use serde::{Deserialize, Serialize};

    fn d_true() -> bool {
        true
    }

    #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "tipo", rename_all = "snake_case")]
    pub enum Accion {
        Lanzar {
            destino: String,
            #[serde(default)]
            args: Vec<String>,
        },
        Volumen {
            nivel: u8,
        },
    }

    #[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    pub struct PerfilAcciones {
        pub entrada: Vec<Accion>,
        pub salida: Vec<Accion>,
    }

    #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    pub struct AppSettings {
        pub revert_timeout_secs: u64,
        pub start_with_windows: bool,
        pub startup_profile_name: Option<String>,
        #[serde(default = "d_true")]
        pub global_shortcuts_enabled: bool,
        pub profile_shortcut_base: Option<String>,
        pub display_toggle_shortcut_base: Option<String>,
        pub profile_shortcuts: BTreeMap<String, String>,
        pub display_toggle_shortcuts: BTreeMap<String, String>,
        pub profile_audio: BTreeMap<String, AudioTarget>,
        pub profile_actions: BTreeMap<String, PerfilAcciones>,
    }

    impl Default for AppSettings {
        fn default() -> Self {
            Self {
                revert_timeout_secs: 10,
                start_with_windows: false,
                startup_profile_name: None,
                global_shortcuts_enabled: true,
                profile_shortcut_base: Some("Ctrl+Shift".to_string()),
                display_toggle_shortcut_base: Some("Ctrl+Alt".to_string()),
                profile_shortcuts: BTreeMap::new(),
                display_toggle_shortcuts: BTreeMap::new(),
                profile_audio: BTreeMap::new(),
                profile_actions: BTreeMap::new(),
            }
        }
    }

    #[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    pub struct AppConfig {
        pub profiles: Vec<Profile>,
        pub display_fingerprints: Vec<DisplayFingerprint>,
        pub last_known_good_layout: Option<Layout>,
        pub last_restorable_layout: Option<Layout>,
        pub settings: AppSettings,
    }
}

fn layout() -> Layout {
    Layout {
        outputs: vec![OutputConfig {
            display_id: DisplayId {
                adapter_luid: 1,
                target_id: 7,
                edid_hash: Some(99),
            },
            enabled: true,
            position: Position { x: 0, y: 0 },
            resolution: Resolution {
                width: 3840,
                height: 2160,
            },
            refresh_rate_mhz: 60_000,
            primary: true,
        }],
    }
}

fn config_nuevo() -> AppConfig {
    let mut config = AppConfig::default();
    config.profiles.push(Profile {
        name: "Jugar".to_string(),
        layout: layout(),
    });
    config
        .settings
        .profile_shortcuts
        .insert("Jugar".to_string(), "Ctrl+Alt+2".to_string());
    config
        .settings
        .profile_icons
        .insert("Jugar".to_string(), "🎮".to_string());
    config.settings.profile_actions.insert(
        "Jugar".to_string(),
        PerfilAcciones::desde_v2(
            vec![
                ActionV2::Lanzar {
                    destino: "steam://rungameid/1145350".to_string(),
                    args: vec![],
                    etiqueta: Some("Hades II".to_string()),
                },
                ActionV2::Desconocida,
                ActionV2::Volumen { nivel: 40 },
            ],
            vec![ActionV2::Lanzar {
                destino: "steam://close/bigpicture".to_string(),
                args: vec![],
                etiqueta: None,
            }],
        ),
    );
    config
}

#[test]
fn el_modelo_de_hoy_abre_un_archivo_guardado_con_acciones_nuevas() {
    let nuevo = config_nuevo();
    // Como lo escribe el store: JSON bonito.
    let json = serde_json::to_vec_pretty(&nuevo).unwrap();

    let leido: hoy::AppConfig = serde_json::from_slice(&json)
        .expect("la versión de hoy tiene que abrir el archivo sin tratarlo de corrupto");

    assert_eq!(leido.profiles, nuevo.profiles, "las escenas tienen que ser iguales");
    assert_eq!(
        leido.settings.profile_shortcuts.get("Jugar").map(String::as_str),
        Some("Ctrl+Alt+2")
    );
    let acciones = leido.settings.profile_actions.get("Jugar").unwrap();
    assert_eq!(
        acciones.entrada,
        vec![
            hoy::Accion::Lanzar {
                destino: "steam://rungameid/1145350".to_string(),
                args: vec![],
            },
            hoy::Accion::Volumen { nivel: 40 },
        ],
        "las listas viejas llevan solo Lanzar y Volumen (la Desconocida no se escribe)"
    );
    assert_eq!(acciones.salida.len(), 1);
}

#[test]
fn un_archivo_de_hoy_abre_igual_en_el_modelo_nuevo() {
    let mut viejo = hoy::AppConfig::default();
    viejo.profiles.push(Profile {
        name: "Jugar".to_string(),
        layout: layout(),
    });
    viejo.settings.startup_profile_name = Some("Jugar".to_string());
    viejo.settings.profile_actions.insert(
        "Jugar".to_string(),
        hoy::PerfilAcciones {
            entrada: vec![hoy::Accion::Volumen { nivel: 25 }],
            salida: vec![hoy::Accion::Lanzar {
                destino: "x.exe".to_string(),
                args: vec!["-a".to_string()],
            }],
        },
    );
    let json = serde_json::to_vec_pretty(&viejo).unwrap();

    let leido: AppConfig = serde_json::from_slice(&json).unwrap();

    assert_eq!(leido.profiles, viejo.profiles);
    assert_eq!(leido.settings.startup_profile_name.as_deref(), Some("Jugar"));
    assert!(leido.settings.profile_icons.is_empty(), "el mapa nuevo nace vacío");
    let acciones = leido.settings.profile_actions.get("Jugar").unwrap();
    assert_eq!(acciones.entrada, vec![Accion::Volumen { nivel: 25 }]);
    assert!(acciones.entrada_v2.is_none() && acciones.salida_v2.is_none());
    // Sin `_v2`, la lista completa sale de las viejas.
    assert_eq!(
        acciones.entrada_completa(),
        vec![ActionV2::Volumen { nivel: 25 }]
    );
    assert_eq!(
        acciones.salida_completa(),
        vec![ActionV2::Lanzar {
            destino: "x.exe".to_string(),
            args: vec!["-a".to_string()],
            etiqueta: None,
        }]
    );
}

#[test]
fn una_escena_de_hoy_no_gana_claves_nuevas_al_reescribirse() {
    // "Nada se migra al abrir": reescribir el archivo sin editar la escena no le agrega `_v2`.
    let mut config = AppConfig::default();
    config.settings.profile_actions.insert(
        "Vieja".to_string(),
        PerfilAcciones {
            entrada: vec![Accion::Volumen { nivel: 10 }],
            ..Default::default()
        },
    );
    let json = serde_json::to_string(&config).unwrap();
    assert!(!json.contains("_v2"), "apareció una clave _v2 sin que se editara la escena: {json}");
}

#[test]
fn una_accion_de_una_version_mas_nueva_se_lee_como_desconocida() {
    let json = r#"{
        "entrada": [],
        "salida": [],
        "entrada_v2": [
            {"tipo":"cerrar","exe":"steam.exe"},
            {"tipo":"volumen","nivel":30},
            {"tipo":"hdr","pantalla":"1:2:3","prender":true}
        ],
        "salida_v2": []
    }"#;
    let acciones: PerfilAcciones = serde_json::from_str(json)
        .expect("una acción que esta versión no conoce no puede romper la lectura");
    assert_eq!(
        acciones.entrada_v2,
        Some(vec![
            ActionV2::Desconocida,
            ActionV2::Volumen { nivel: 30 },
            ActionV2::Desconocida,
        ])
    );
}

#[test]
fn la_escritura_doble_deja_completa_la_v2_y_filtradas_las_viejas() {
    let acciones = PerfilAcciones::desde_v2(
        vec![
            ActionV2::Desconocida,
            ActionV2::Lanzar {
                destino: "a.exe".to_string(),
                args: vec!["1".to_string()],
                etiqueta: Some("Mi A".to_string()),
            },
        ],
        vec![],
    );
    assert_eq!(
        acciones.entrada,
        vec![Accion::Lanzar {
            destino: "a.exe".to_string(),
            args: vec!["1".to_string()],
        }]
    );
    assert_eq!(acciones.entrada_v2.as_ref().map(Vec::len), Some(2));
    assert_eq!(acciones.salida_v2, Some(vec![]));
    assert!(!acciones.esta_vacia());
    assert!(PerfilAcciones::default().esta_vacia());
    assert!(PerfilAcciones::desde_v2(vec![], vec![]).esta_vacia());
}

#[test]
fn la_etiqueta_solo_se_escribe_si_existe() {
    let sin: ActionV2 = ActionV2::Lanzar {
        destino: "a.exe".to_string(),
        args: vec![],
        etiqueta: None,
    };
    assert!(!serde_json::to_string(&sin).unwrap().contains("etiqueta"));
    let con: ActionV2 = serde_json::from_str(
        r#"{"tipo":"lanzar","destino":"a.exe","etiqueta":"Mi A"}"#,
    )
    .unwrap();
    assert_eq!(
        con,
        ActionV2::Lanzar {
            destino: "a.exe".to_string(),
            args: vec![],
            etiqueta: Some("Mi A".to_string()),
        }
    );
}
