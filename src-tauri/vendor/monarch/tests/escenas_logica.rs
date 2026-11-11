//! Encargo 01 de escenas, sub-paso 2: la lógica del vendor (guardar, renombrar, duplicar,
//! reordenar, probar un borrador) contra el backend mock.
//!
//! Cada regla que decide lleva su caso de "sí" y su caso de "no". Lo que más se cuida:
//! que un error no deje NADA guardado, que cada operación guarde UNA sola vez y que durante
//! una confirmación pendiente (cambio común o PRUEBA) no se pueda escribir ninguna escena.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use monarch::{
    ActionV2, AppConfig, AudioTarget, ConfigStore, DisplayBackend, DisplayId, DisplayInfo, Layout, ManagerError,
    MemoryConfigStore, MockBackend, MonarchDisplayManager, OutputConfig, PerfilAcciones, Position,
    Profile, Resolution, SceneData, PRUEBA_PENDIENTE,
};

/// Un store en memoria que cuenta cuántas veces se guardó.
#[derive(Clone, Default)]
struct CountingStore {
    inner: MemoryConfigStore,
    saves: Arc<AtomicUsize>,
}

impl ConfigStore for CountingStore {
    fn load(&self) -> Result<AppConfig, ManagerError> {
        self.inner.load()
    }

    fn save(&self, config: &AppConfig) -> Result<(), ManagerError> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        self.inner.save(config)
    }
}

type Manager = MonarchDisplayManager<MockBackend, CountingStore>;

fn id(target: u32) -> DisplayId {
    DisplayId {
        adapter_luid: 1,
        target_id: target,
        edid_hash: Some(target as u64),
    }
}

fn salida(target: u32, enabled: bool, primary: bool, x: i32) -> OutputConfig {
    OutputConfig {
        display_id: id(target),
        enabled,
        position: Position { x, y: 0 },
        resolution: Resolution {
            width: 1920,
            height: 1080,
        },
        refresh_rate_mhz: 60_000,
        primary,
    }
}

/// Las dos pantallas, prendidas, la 1 principal.
fn layout_dos() -> Layout {
    Layout {
        outputs: vec![salida(1, true, true, 0), salida(2, true, false, 1920)],
    }
}

/// Solo la pantalla 1 prendida.
fn layout_una() -> Layout {
    Layout {
        outputs: vec![salida(1, true, true, 0), salida(2, false, false, 1920)],
    }
}

fn displays() -> Vec<DisplayInfo> {
    [1u32, 2]
        .iter()
        .map(|t| DisplayInfo {
            id: id(*t),
            friendly_name: format!("Pantalla {t}"),
            is_active: true,
            is_primary: *t == 1,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            refresh_rate_mhz: 60_000,
        })
        .collect()
}

fn audio() -> AudioTarget {
    AudioTarget {
        endpoint_id: "ep-tv".to_string(),
        friendly_name: "TV".to_string(),
    }
}

fn acciones() -> PerfilAcciones {
    PerfilAcciones::desde_v2(
        vec![
            ActionV2::Lanzar {
                destino: "steam://open/bigpicture".to_string(),
                args: vec![],
                etiqueta: Some("Big Picture".to_string()),
            },
            ActionV2::Volumen { nivel: 40 },
        ],
        vec![ActionV2::Lanzar {
            destino: "steam://close/bigpicture".to_string(),
            args: vec![],
            etiqueta: None,
        }],
    )
}

/// Cuatro escenas (A, B, C, D) con atajo, sonido, acciones, emoji y arranque, como el
/// archivo semilla del spec. "A" es la de arranque y tiene todo.
fn semilla() -> AppConfig {
    let mut config = AppConfig::default();
    for (nombre, layout) in [
        ("A", layout_dos()),
        ("B", layout_una()),
        ("C", layout_dos()),
        ("D", layout_una()),
    ] {
        config.profiles.push(Profile {
            name: nombre.to_string(),
            layout,
        });
    }
    let s = &mut config.settings;
    s.profile_shortcuts.insert("A".to_string(), "Ctrl+Shift+1".to_string());
    s.profile_shortcuts.insert("C".to_string(), "Ctrl+Shift+3".to_string());
    s.profile_audio.insert("A".to_string(), audio());
    s.profile_actions.insert("A".to_string(), acciones());
    s.profile_icons.insert("A".to_string(), "🎮".to_string());
    s.startup_profile_name = Some("A".to_string());
    config
}

fn manager() -> (Manager, MockBackend, CountingStore) {
    let backend = MockBackend::new(displays(), layout_dos()).unwrap();
    let store = CountingStore {
        inner: MemoryConfigStore::new(semilla()),
        saves: Arc::new(AtomicUsize::new(0)),
    };
    let manager = MonarchDisplayManager::new(backend.clone(), store.clone()).unwrap();
    // Lo que `new` haya guardado por su cuenta no cuenta: se mide desde acá.
    store.saves.store(0, Ordering::SeqCst);
    (manager, backend, store)
}

fn guardados(store: &CountingStore) -> usize {
    store.saves.load(Ordering::SeqCst)
}

fn nombres(manager: &Manager) -> Vec<String> {
    manager.list_profiles().into_iter().map(|p| p.name).collect()
}

fn texto(error: ManagerError) -> String {
    match error {
        ManagerError::Validation(m) | ManagerError::NotFound(m) => m,
        otro => otro.to_string(),
    }
}

fn escena(nombre: &str, layout: Layout) -> SceneData {
    SceneData {
        name: nombre.to_string(),
        layout,
        emoji: None,
        audio: None,
        entrada: vec![],
        salida: vec![],
        shortcut: None,
        startup: false,
    }
}

// --- renombrar -------------------------------------------------------------------------

#[test]
fn renombrar_mueve_las_cinco_claves_en_un_solo_guardado() {
    let (mut m, _backend, store) = manager();
    let nuevo = m.rename_scene("A", "Jugar").unwrap();
    assert_eq!(nuevo, "Jugar");
    assert_eq!(guardados(&store), 1, "el renombre guarda una sola vez");

    let s = m.settings();
    assert_eq!(s.profile_shortcuts.get("Jugar").map(String::as_str), Some("Ctrl+Shift+1"));
    assert_eq!(s.profile_audio.get("Jugar"), Some(&audio()));
    assert_eq!(s.profile_actions.get("Jugar"), Some(&acciones()));
    assert_eq!(s.profile_icons.get("Jugar").map(String::as_str), Some("🎮"));
    assert_eq!(s.startup_profile_name.as_deref(), Some("Jugar"));
    // Y no queda NADA colgando del nombre viejo.
    assert!(!s.profile_shortcuts.contains_key("A"));
    assert!(!s.profile_audio.contains_key("A"));
    assert!(!s.profile_actions.contains_key("A"));
    assert!(!s.profile_icons.contains_key("A"));
    // Mismo lugar en el orden.
    assert_eq!(nombres(&m), vec!["Jugar", "B", "C", "D"]);
    // Lo guardado en disco es lo mismo que lo de memoria.
    assert_eq!(store.inner.snapshot().unwrap().settings.profile_icons.get("Jugar").map(String::as_str), Some("🎮"));
}

#[test]
fn renombrar_limpia_los_espacios_de_los_costados() {
    let (mut m, _b, _s) = manager();
    assert_eq!(m.rename_scene("B", "  Cine  ").unwrap(), "Cine");
    assert_eq!(nombres(&m), vec!["A", "Cine", "C", "D"]);
}

#[test]
fn renombrar_con_un_nombre_malo_no_guarda_nada() {
    let (mut m, _b, store) = manager();
    let antes = m.config().clone();

    assert_eq!(texto(m.rename_scene("A", "   ").unwrap_err()), "poné un nombre para la escena");
    assert_eq!(
        texto(m.rename_scene("A", "B").unwrap_err()),
        "ya hay una escena que se llama \"B\""
    );
    assert_eq!(
        texto(m.rename_scene("Fantasma", "Z").unwrap_err()),
        "no existe la escena \"Fantasma\""
    );
    assert_eq!(guardados(&store), 0);
    assert_eq!(m.config(), &antes);
}

#[test]
fn renombrar_al_mismo_nombre_no_escribe() {
    let (mut m, _b, store) = manager();
    assert_eq!(m.rename_scene("A", " A ").unwrap(), "A");
    assert_eq!(guardados(&store), 0);
}

// --- duplicar --------------------------------------------------------------------------

#[test]
fn duplicar_copia_todo_menos_el_atajo_y_el_arranque() {
    let (mut m, _b, store) = manager();
    let copia = m.duplicate_scene("A").unwrap();
    assert_eq!(copia, "A (copia)");
    assert_eq!(guardados(&store), 1);
    // Va al final.
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D", "A (copia)"]);

    let s = m.settings();
    assert_eq!(s.profile_audio.get("A (copia)"), Some(&audio()));
    assert_eq!(s.profile_actions.get("A (copia)"), Some(&acciones()));
    assert_eq!(s.profile_icons.get("A (copia)").map(String::as_str), Some("🎮"));
    assert!(!s.profile_shortcuts.contains_key("A (copia)"), "un atajo no puede repetirse");
    assert_eq!(s.startup_profile_name.as_deref(), Some("A"), "el arranque sigue siendo la original");
    // La original quedó como estaba.
    assert_eq!(s.profile_shortcuts.get("A").map(String::as_str), Some("Ctrl+Shift+1"));
    // Y las pantallas son iguales.
    let perfiles = m.list_profiles();
    assert_eq!(perfiles[0].layout, perfiles[4].layout);
}

#[test]
fn duplicar_dos_veces_numera_las_copias() {
    let (mut m, _b, _s) = manager();
    assert_eq!(m.duplicate_scene("B").unwrap(), "B (copia)");
    assert_eq!(m.duplicate_scene("B").unwrap(), "B (copia 2)");
    assert_eq!(m.duplicate_scene("B").unwrap(), "B (copia 3)");
}

#[test]
fn duplicar_una_que_no_existe_falla_sin_guardar() {
    let (mut m, _b, store) = manager();
    assert_eq!(
        texto(m.duplicate_scene("Fantasma").unwrap_err()),
        "no existe la escena \"Fantasma\""
    );
    assert_eq!(guardados(&store), 0);
}

#[test]
fn editar_la_copia_no_cambia_la_original() {
    let (mut m, _b, _s) = manager();
    let copia = m.duplicate_scene("A").unwrap();
    let mut datos = escena(&copia, layout_una());
    datos.audio = None;
    datos.emoji = Some("🎬".to_string());
    m.upsert_scene(Some(&copia), datos).unwrap();

    let s = m.settings();
    assert_eq!(s.profile_icons.get("A").map(String::as_str), Some("🎮"));
    assert_eq!(s.profile_audio.get("A"), Some(&audio()));
    assert!(!s.profile_audio.contains_key(&copia));
    assert_eq!(m.list_profiles()[0].layout, layout_dos());
}

// --- reordenar -------------------------------------------------------------------------

#[test]
fn reordenar_con_el_mismo_conjunto_cambia_el_orden_y_guarda_una_vez() {
    let (mut m, _b, store) = manager();
    let orden: Vec<String> = ["D", "C", "B", "A"].iter().map(|s| s.to_string()).collect();
    m.reorder_scenes(&orden).unwrap();
    assert_eq!(nombres(&m), vec!["D", "C", "B", "A"]);
    assert_eq!(guardados(&store), 1);
    // Los datos por nombre no se mueven con el orden.
    assert_eq!(m.settings().profile_shortcuts.get("A").map(String::as_str), Some("Ctrl+Shift+1"));
}

#[test]
fn reordenar_con_un_conjunto_distinto_falla_sin_guardar() {
    let (mut m, _b, store) = manager();
    let casos: Vec<Vec<&str>> = vec![
        vec!["A", "B", "C"],           // falta una
        vec!["A", "B", "C", "D", "E"], // sobra una
        vec!["A", "A", "C", "D"],      // se repite una (y falta otra)
        vec!["A", "B", "C", "X"],      // una que no existe
        vec![],
    ];
    for caso in casos {
        let orden: Vec<String> = caso.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            texto(m.reorder_scenes(&orden).unwrap_err()),
            "la lista de escenas cambió mientras la ordenabas; volvé a intentar",
            "caso {caso:?}"
        );
    }
    assert_eq!(guardados(&store), 0);
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D"]);
}

// --- guardar una escena completa -------------------------------------------------------

#[test]
fn una_escena_nueva_va_al_final_con_todo_en_un_guardado() {
    let (mut m, _b, store) = manager();
    let mut datos = escena("Cine", layout_una());
    datos.emoji = Some(" 🎬 ".to_string());
    datos.audio = Some(audio());
    datos.entrada = vec![ActionV2::Volumen { nivel: 20 }, ActionV2::Desconocida];
    datos.shortcut = Some("Ctrl+Shift+5".to_string());
    datos.startup = true;

    assert_eq!(m.upsert_scene(None, datos).unwrap(), "Cine");
    assert_eq!(guardados(&store), 1);
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D", "Cine"]);

    let s = m.settings();
    assert_eq!(s.profile_icons.get("Cine").map(String::as_str), Some("🎬"));
    assert_eq!(s.profile_audio.get("Cine"), Some(&audio()));
    assert_eq!(s.profile_shortcuts.get("Cine").map(String::as_str), Some("Ctrl+Shift+5"));
    assert_eq!(s.startup_profile_name.as_deref(), Some("Cine"), "pasa a ser la de arranque");
    let acc = s.profile_actions.get("Cine").unwrap();
    assert_eq!(acc.entrada_v2, Some(vec![ActionV2::Volumen { nivel: 20 }]), "la Desconocida se descarta");
    assert_eq!(acc.entrada.len(), 1);
}

#[test]
fn editar_una_escena_la_deja_en_su_lugar_y_limpia_lo_que_se_saco() {
    let (mut m, _b, store) = manager();
    // "A" tenía atajo, sonido, acciones, emoji y arranque: el borrador no trae ninguno.
    let datos = escena("A", layout_una());
    m.upsert_scene(Some("A"), datos).unwrap();
    assert_eq!(guardados(&store), 1);
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D"]);
    let s = m.settings();
    assert!(!s.profile_shortcuts.contains_key("A"));
    assert!(!s.profile_audio.contains_key("A"));
    assert!(!s.profile_actions.contains_key("A"));
    assert!(!s.profile_icons.contains_key("A"));
    assert_eq!(s.startup_profile_name, None, "startup:false y era la de arranque → sin arranque");
    assert_eq!(m.list_profiles()[0].layout, layout_una());
}

#[test]
fn editar_y_renombrar_a_la_vez_mueve_las_claves_y_aplica_lo_nuevo() {
    let (mut m, _b, store) = manager();
    let mut datos = escena("Jugar", layout_dos());
    datos.shortcut = Some("Ctrl+Shift+1".to_string()); // el que ya tenía "A"
    datos.audio = Some(audio());
    datos.startup = true;
    assert_eq!(m.upsert_scene(Some("A"), datos).unwrap(), "Jugar");
    assert_eq!(guardados(&store), 1);
    assert_eq!(nombres(&m), vec!["Jugar", "B", "C", "D"]);
    let s = m.settings();
    assert_eq!(s.profile_shortcuts.get("Jugar").map(String::as_str), Some("Ctrl+Shift+1"));
    assert!(!s.profile_shortcuts.contains_key("A"));
    assert_eq!(s.startup_profile_name.as_deref(), Some("Jugar"));
}

#[test]
fn guardar_rechaza_lo_que_no_se_puede_y_no_deja_nada_a_medias() {
    let (mut m, _b, store) = manager();
    let antes = m.config().clone();

    // Nombre vacío.
    assert_eq!(
        texto(m.upsert_scene(None, escena("  ", layout_dos())).unwrap_err()),
        "poné un nombre para la escena"
    );
    // Nombre de otra escena, tanto nueva como editando otra.
    assert_eq!(
        texto(m.upsert_scene(None, escena("B", layout_dos())).unwrap_err()),
        "ya hay una escena que se llama \"B\""
    );
    assert_eq!(
        texto(m.upsert_scene(Some("A"), escena("B", layout_dos())).unwrap_err()),
        "ya hay una escena que se llama \"B\""
    );
    // La escena que se editaba ya no existe.
    assert_eq!(
        texto(m.upsert_scene(Some("Fantasma"), escena("Z", layout_dos())).unwrap_err()),
        "no existe la escena \"Fantasma\""
    );
    // Todas las pantallas apagadas.
    let apagadas = Layout {
        outputs: vec![salida(1, false, false, 0), salida(2, false, false, 1920)],
    };
    assert_eq!(
        texto(m.upsert_scene(None, escena("Z", apagadas)).unwrap_err()),
        "tiene que quedar al menos una pantalla prendida"
    );
    // La principal apagada.
    let principal_apagada = Layout {
        outputs: vec![salida(1, false, true, 0), salida(2, true, false, 1920)],
    };
    assert_eq!(
        texto(m.upsert_scene(None, escena("Z", principal_apagada)).unwrap_err()),
        "la pantalla principal tiene que estar prendida"
    );
    // Dos principales / ninguna.
    let dos_principales = Layout {
        outputs: vec![salida(1, true, true, 0), salida(2, true, true, 1920)],
    };
    assert_eq!(
        texto(m.upsert_scene(None, escena("Z", dos_principales)).unwrap_err()),
        "elegí una sola pantalla principal"
    );
    let sin_principal = Layout {
        outputs: vec![salida(1, true, false, 0), salida(2, true, false, 1920)],
    };
    assert_eq!(
        texto(m.upsert_scene(None, escena("Z", sin_principal)).unwrap_err()),
        "elegí una sola pantalla principal"
    );
    // Atajo que ya usa otra escena (sin importar mayúsculas).
    let mut con_atajo = escena("Z", layout_dos());
    con_atajo.shortcut = Some("ctrl+shift+3".to_string());
    assert_eq!(
        texto(m.upsert_scene(None, con_atajo).unwrap_err()),
        "ese atajo ya lo usa la escena \"C\""
    );

    assert_eq!(guardados(&store), 0);
    assert_eq!(m.config(), &antes, "ningún rechazo dejó la memoria cambiada");
}

#[test]
fn el_primario_se_normaliza_al_origen_al_guardar() {
    let (mut m, _b, _s) = manager();
    let layout = Layout {
        outputs: vec![salida(1, true, true, 500), salida(2, true, false, 2420)],
    };
    m.upsert_scene(None, escena("Corrido", layout)).unwrap();
    let guardada = m.list_profiles().into_iter().find(|p| p.name == "Corrido").unwrap();
    assert_eq!(guardada.layout.outputs[0].position, Position { x: 0, y: 0 });
    assert_eq!(guardada.layout.outputs[1].position, Position { x: 1920, y: 0 });
}

// --- guardar lo puesto (save_profile) --------------------------------------------------

#[test]
fn save_profile_ya_no_ordena_y_no_pisa_en_silencio() {
    let (mut m, _b, store) = manager();
    m.save_profile("Zeta", false).unwrap();
    m.save_profile("Alfa", false).unwrap();
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D", "Zeta", "Alfa"], "lo nuevo va al final");

    let antes = guardados(&store);
    assert_eq!(
        texto(m.save_profile("Zeta", false).unwrap_err()),
        "ya hay una escena que se llama \"Zeta\""
    );
    assert_eq!(guardados(&store), antes);
}

#[test]
fn save_profile_con_replace_pisa_solo_el_layout() {
    let (mut m, backend, _s) = manager();
    // Lo puesto ahora es "una sola pantalla".
    backend.apply_layout(layout_una()).unwrap();
    m.save_profile("A", true).unwrap();
    let a = m.list_profiles().into_iter().find(|p| p.name == "A").unwrap();
    assert_eq!(a.layout, layout_una());
    // Todo lo demás de "A" sigue.
    let s = m.settings();
    assert_eq!(s.profile_shortcuts.get("A").map(String::as_str), Some("Ctrl+Shift+1"));
    assert_eq!(s.profile_actions.get("A"), Some(&acciones()));
    assert_eq!(nombres(&m), vec!["A", "B", "C", "D"]);
}

// --- confirmación pendiente ------------------------------------------------------------

/// Corre las siete formas de escribir escenas y devuelve el mensaje de cada rechazo.
fn intentar_escribir(m: &mut Manager) -> Vec<ManagerError> {
    let orden: Vec<String> = ["D", "C", "B", "A"].iter().map(|s| s.to_string()).collect();
    vec![
        m.upsert_scene(None, escena("Nueva", layout_dos())).unwrap_err(),
        m.rename_scene("A", "Otra").unwrap_err(),
        m.duplicate_scene("A").unwrap_err(),
        m.reorder_scenes(&orden).unwrap_err(),
        m.delete_profile("A").unwrap_err(),
        m.save_profile("Nueva", false).unwrap_err(),
    ]
}

#[test]
fn con_un_cambio_comun_pendiente_no_se_escribe_ninguna_escena() {
    let (mut m, _b, store) = manager();
    m.apply_layout(layout_una()).unwrap();
    assert!(m.has_pending_confirmation() && !m.pending_is_test());
    let antes = m.config().clone();
    let guardados_antes = guardados(&store);

    for error in intentar_escribir(&mut m) {
        assert!(matches!(error, ManagerError::ConfirmationPending), "{error:?}");
    }
    assert_eq!(guardados(&store), guardados_antes);
    assert_eq!(m.config(), &antes);
}

#[test]
fn con_una_prueba_pendiente_se_rechaza_con_el_texto_de_la_prueba() {
    let (mut m, _b, store) = manager();
    m.apply_draft(layout_una()).unwrap();
    assert!(m.pending_is_test());
    let antes = m.config().clone();
    let guardados_antes = guardados(&store);

    for error in intentar_escribir(&mut m) {
        assert_eq!(texto(error), "esperando que confirmes la prueba");
    }
    assert_eq!(PRUEBA_PENDIENTE, "esperando que confirmes la prueba");
    assert_eq!(guardados(&store), guardados_antes);
    assert_eq!(m.config(), &antes);

    // Confirmada la prueba, se puede escribir de nuevo.
    m.confirm_current_layout().unwrap();
    m.rename_scene("A", "Otra").unwrap();
}

// --- PROBAR un borrador ----------------------------------------------------------------

#[test]
fn probar_un_borrador_aplica_las_pantallas_sin_escribir_ninguna_escena() {
    let (mut m, backend, store) = manager();
    let escenas_antes = m.list_profiles();
    let ajustes_antes = m.settings().clone();
    let guardados_antes = guardados(&store);

    m.apply_draft(layout_una()).unwrap();

    assert_eq!(backend.current_layout().unwrap().enabled_output_count(), 1, "las pantallas cambiaron");
    assert!(m.has_pending_confirmation());
    assert!(m.pending_is_test(), "lo pendiente es una prueba");
    assert_eq!(m.list_profiles(), escenas_antes, "no se escribió ninguna escena");
    assert_eq!(m.settings(), &ajustes_antes);
    // `apply_layout` guarda el layout previo como red (como siempre); escenas, no.
    assert!(guardados(&store) <= guardados_antes + 1);
}

#[test]
fn si_no_se_confirma_la_prueba_vuelve_atras() {
    let (mut m, backend, _s) = manager();
    m.apply_draft(layout_una()).unwrap();
    m.rollback_pending().unwrap();
    assert_eq!(backend.current_layout().unwrap().enabled_output_count(), 2);
    assert!(!m.has_pending_confirmation());
    assert!(!m.pending_is_test());
}

#[test]
fn probar_algo_que_ya_esta_puesto_no_deja_nada_pendiente() {
    let (mut m, _b, _s) = manager();
    m.apply_draft(layout_dos()).unwrap();
    assert!(!m.has_pending_confirmation());
}

#[test]
fn aplicar_una_escena_guardada_no_es_una_prueba() {
    let (mut m, _b, _s) = manager();
    m.apply_profile("B").unwrap();
    assert!(m.has_pending_confirmation());
    assert!(!m.pending_is_test(), "APLICAR sigue siendo un cambio común");
}

#[test]
fn no_se_prueban_dos_cosas_a_la_vez() {
    let (mut m, _b, _s) = manager();
    m.apply_draft(layout_una()).unwrap();
    assert!(matches!(m.apply_draft(layout_dos()), Err(ManagerError::ConfirmationPending)));
    assert!(matches!(m.apply_profile("A"), Err(ManagerError::ConfirmationPending)));
}

#[test]
fn una_pantalla_prendida_que_windows_no_ve_se_detecta_antes_de_tocar_nada() {
    let (m, backend, _s) = manager();
    let antes = backend.current_layout().unwrap();
    let con_fantasma = Layout {
        outputs: vec![salida(1, true, true, 0), salida(9, true, false, 1920)],
    };
    let faltan = m.unresolved_enabled_outputs(&con_fantasma).unwrap();
    assert_eq!(faltan, vec![id(9)]);
    // Una apagada que Windows no ve no molesta.
    let apagada = Layout {
        outputs: vec![salida(1, true, true, 0), salida(9, false, false, 1920)],
    };
    assert!(m.unresolved_enabled_outputs(&apagada).unwrap().is_empty());
    assert_eq!(backend.current_layout().unwrap(), antes, "solo mira");
}

// --- trampa #1 -------------------------------------------------------------------------

#[test]
fn guardar_ajustes_no_borra_los_emojis() {
    let (mut m, _b, _s) = manager();
    let mut ajustes = m.settings().clone();
    ajustes.revert_timeout_secs = 7;
    m.update_settings(ajustes).unwrap();
    assert_eq!(
        m.settings().profile_icons.get("A").map(String::as_str),
        Some("🎮"),
        "trampa #1: update_settings vació profile_icons"
    );
}
