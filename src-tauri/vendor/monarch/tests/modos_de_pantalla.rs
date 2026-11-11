//! Encargo 02 de escenas, sub-paso 1: el mapa de modos de pantalla (`display_modes`) del
//! vendor. Lo que más se cuida (SPEC :43, criterio 4): que una lista vacía NUNCA vacíe lo
//! recordado, que un arranque con la TV apagada no borre sus modos y que `update_settings`
//! los copie tal cual (la TRAMPA #1).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use monarch::manager::display_modes_key;
use monarch::model::{normalize_display_modes, DisplayMode};
use monarch::{
    AppConfig, AppSettings, ConfigStore, DisplayId, DisplayInfo, Layout, ManagerError,
    MemoryConfigStore, MockBackend, MonarchDisplayManager, OutputConfig, Position, Resolution,
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
        edid_hash: Some(target as u64 + 100),
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

fn layout_solo_monitor() -> Layout {
    Layout {
        outputs: vec![OutputConfig {
            display_id: id(1),
            enabled: true,
            position: Position { x: 0, y: 0 },
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            refresh_rate_mhz: 60_000,
            primary: true,
        }],
    }
}

fn modo(width: u32, height: u32, refresh_mhz: u32) -> DisplayMode {
    DisplayMode {
        width,
        height,
        refresh_mhz,
    }
}

fn modos_tv() -> Vec<DisplayMode> {
    vec![modo(3840, 2160, 60_000), modo(1920, 1080, 60_000)]
}

fn clave_tv() -> String {
    display_modes_key(&id(2), "LG TV").expect("la TV tiene EDID")
}

/// Un manager con el monitor 1 solo (la TV, target 2, apagada y fuera de la lista de Windows).
fn manager_con(config: AppConfig) -> (Manager, CountingStore) {
    let backend = MockBackend::new(vec![info(1, "Monitor")], layout_solo_monitor()).unwrap();
    let store = CountingStore {
        inner: MemoryConfigStore::new(config),
        saves: Arc::new(AtomicUsize::new(0)),
    };
    let manager = MonarchDisplayManager::new(backend, store.clone()).unwrap();
    store.saves.store(0, Ordering::SeqCst);
    (manager, store)
}

fn guardados(store: &CountingStore) -> usize {
    store.saves.load(Ordering::SeqCst)
}

fn config_con_modos_de_la_tv() -> AppConfig {
    let mut config = AppConfig::default();
    config.settings.display_modes.insert(clave_tv(), modos_tv());
    config
}

// --- normalizar ------------------------------------------------------------------------

#[test]
fn normalizar_ordena_de_mayor_a_menor_sin_repetidos_ni_frecuencia_cero() {
    let crudos = vec![
        modo(1920, 1080, 60_000),
        modo(3840, 2160, 30_000),
        modo(1920, 1080, 60_000),
        modo(3840, 2160, 60_000),
        modo(1280, 720, 0),
        modo(0, 0, 60_000),
        modo(1920, 1080, 120_000),
    ];
    assert_eq!(
        normalize_display_modes(crudos),
        vec![
            modo(3840, 2160, 60_000),
            modo(3840, 2160, 30_000),
            modo(1920, 1080, 120_000),
            modo(1920, 1080, 60_000),
        ]
    );
}

#[test]
fn normalizar_una_lista_buena_la_deja_igual() {
    assert_eq!(normalize_display_modes(modos_tv()), modos_tv());
}

#[test]
fn la_clave_es_la_huella_edid_y_sin_edid_no_hay_clave() {
    assert_eq!(
        display_modes_key(&id(2), "  lg tv "),
        display_modes_key(&id(2), "LG TV"),
        "misma huella que display_fingerprints: el nombre se normaliza"
    );
    let sin_edid = DisplayId {
        adapter_luid: 1,
        target_id: 9,
        edid_hash: None,
    };
    assert_eq!(display_modes_key(&sin_edid, "Panel"), None);
}

// --- recordar --------------------------------------------------------------------------

#[test]
fn recordar_una_lista_nueva_la_guarda_una_vez() {
    let (mut manager, store) = manager_con(AppConfig::default());
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), modos_tv())])
        .unwrap();
    assert!(cambio);
    assert_eq!(guardados(&store), 1);
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
    assert_eq!(
        store.inner.load().unwrap().settings.display_modes.get(&clave_tv()),
        Some(&modos_tv()),
        "quedó en el disco"
    );
}

#[test]
fn recordar_la_misma_lista_no_guarda() {
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let desordenada = vec![modo(1920, 1080, 60_000), modo(3840, 2160, 60_000)];
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), desordenada)])
        .unwrap();
    assert!(!cambio, "es la misma lista una vez ordenada");
    assert_eq!(guardados(&store), 0);
}

#[test]
fn recordar_una_lista_vacia_nunca_vacia_lo_recordado() {
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), vec![])])
        .unwrap();
    assert!(!cambio);
    assert_eq!(guardados(&store), 0);
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
}

#[test]
fn recordar_solo_modos_con_frecuencia_cero_tampoco_vacia() {
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), vec![modo(1920, 1080, 0)])])
        .unwrap();
    assert!(!cambio);
    assert_eq!(guardados(&store), 0);
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
}

#[test]
fn recordar_una_lista_distinta_la_reemplaza() {
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let nueva = vec![modo(3840, 2160, 120_000), modo(3840, 2160, 60_000)];
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), nueva.clone())])
        .unwrap();
    assert!(cambio);
    assert_eq!(guardados(&store), 1);
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&nueva));
}

#[test]
fn recordar_varias_pantallas_guarda_una_sola_vez() {
    let (mut manager, store) = manager_con(AppConfig::default());
    manager
        .remember_display_modes(&[
            (id(1), "Monitor".to_string(), vec![modo(2560, 1440, 144_000)]),
            (id(2), "LG TV".to_string(), modos_tv()),
        ])
        .unwrap();
    assert_eq!(guardados(&store), 1);
    assert_eq!(manager.settings().display_modes.len(), 2);
}

#[test]
fn una_pantalla_sin_modos_no_frena_a_la_de_al_lado() {
    // El lector manda primero la TV (sin modos, o sin EDID) y después el monitor: el monitor
    // se anota igual y la TV conserva lo suyo.
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let sin_edid = DisplayId {
        adapter_luid: 1,
        target_id: 9,
        edid_hash: None,
    };
    let monitor = vec![modo(2560, 1440, 144_000)];
    let cambio = manager
        .remember_display_modes(&[
            (id(2), "LG TV".to_string(), vec![]),
            (sin_edid, "Panel".to_string(), modos_tv()),
            (id(1), "Monitor".to_string(), monitor.clone()),
        ])
        .unwrap();
    assert!(cambio);
    assert_eq!(guardados(&store), 1);
    let ajustes = manager.settings();
    assert_eq!(ajustes.display_modes.get(&clave_tv()), Some(&modos_tv()));
    assert_eq!(
        ajustes
            .display_modes
            .get(&display_modes_key(&id(1), "Monitor").unwrap()),
        Some(&monitor)
    );
}

#[test]
fn se_anotan_aunque_haya_una_confirmacion_pendiente() {
    // Aplicar una escena que prende la TV dispara WM_DISPLAYCHANGE durante la cuenta
    // regresiva: es la primera vez que la TV informa sus modos y no se puede perder.
    let (mut manager, store) = manager_con(AppConfig::default());
    let mut otra = layout_solo_monitor();
    otra.outputs[0].resolution = Resolution {
        width: 2560,
        height: 1440,
    };
    manager.apply_draft(otra).unwrap();
    assert!(manager.has_pending_confirmation());
    let cambio = manager
        .remember_display_modes(&[(id(2), "LG TV".to_string(), modos_tv())])
        .unwrap();
    assert!(cambio);
    assert_eq!(
        store.inner.load().unwrap().settings.display_modes.get(&clave_tv()),
        Some(&modos_tv())
    );
}

#[test]
fn una_pantalla_sin_edid_no_se_recuerda() {
    let (mut manager, store) = manager_con(AppConfig::default());
    let sin_edid = DisplayId {
        adapter_luid: 1,
        target_id: 9,
        edid_hash: None,
    };
    let cambio = manager
        .remember_display_modes(&[(sin_edid, "Panel".to_string(), modos_tv())])
        .unwrap();
    assert!(!cambio);
    assert_eq!(guardados(&store), 0);
    assert!(manager.settings().display_modes.is_empty());
}

// --- lo que no los borra (criterio 4) --------------------------------------------------

#[test]
fn un_arranque_con_la_tv_apagada_no_borra_sus_modos() {
    // La TV no está en la lista de Windows: `new` sincroniza huellas y migra layouts (y guarda,
    // porque el config viene sin huellas ni layouts), pero el mapa de modos queda igual.
    let store = CountingStore {
        inner: MemoryConfigStore::new(config_con_modos_de_la_tv()),
        saves: Arc::new(AtomicUsize::new(0)),
    };
    let backend = MockBackend::new(vec![info(1, "Monitor")], layout_solo_monitor()).unwrap();
    let manager = MonarchDisplayManager::new(backend, store.clone()).unwrap();
    assert!(guardados(&store) >= 1, "el arranque escribió el archivo");
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
    assert_eq!(
        store.inner.load().unwrap().settings.display_modes.get(&clave_tv()),
        Some(&modos_tv()),
        "el archivo escrito al arrancar conserva los modos de la TV"
    );
}

#[test]
fn un_arranque_con_la_tv_enchufada_y_apagada_no_borra_sus_modos() {
    // El caso de todos los días: Windows ve la TV (conectada, sin fuente activa), así que el
    // arranque reescribe su huella en `display_fingerprints`; el mapa de modos queda igual.
    let store = CountingStore {
        inner: MemoryConfigStore::new(config_con_modos_de_la_tv()),
        saves: Arc::new(AtomicUsize::new(0)),
    };
    let mut tv = info(2, "LG TV");
    tv.is_active = false;
    tv.is_primary = false;
    let backend =
        MockBackend::new(vec![info(1, "Monitor"), tv], layout_solo_monitor()).unwrap();
    let manager = MonarchDisplayManager::new(backend, store.clone()).unwrap();
    assert!(
        manager
            .config()
            .display_fingerprints
            .iter()
            .any(|f| f.display_id == id(2)),
        "el arranque anotó la huella de la TV"
    );
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
    assert_eq!(
        store.inner.load().unwrap().settings.display_modes.get(&clave_tv()),
        Some(&modos_tv())
    );
}

#[test]
fn guardar_ajustes_conserva_los_modos() {
    let (mut manager, store) = manager_con(config_con_modos_de_la_tv());
    let mut ajustes = manager.settings().clone();
    ajustes.global_shortcuts_enabled = false;
    manager.update_settings(ajustes).unwrap();
    assert_eq!(manager.settings().display_modes.get(&clave_tv()), Some(&modos_tv()));
    assert_eq!(
        store.inner.load().unwrap().settings.display_modes.get(&clave_tv()),
        Some(&modos_tv())
    );
}

// --- el formato en displays.json --------------------------------------------------------

#[test]
fn un_archivo_sin_modos_abre_con_el_mapa_vacio() {
    let viejo = serde_json::json!({
        "profiles": [],
        "settings": { "revert_timeout_secs": 15 }
    });
    let config: AppConfig = serde_json::from_value(viejo).unwrap();
    assert!(config.settings.display_modes.is_empty());
    assert_eq!(config.settings.revert_timeout_secs, 15);
}

#[test]
fn los_modos_se_escriben_como_width_height_refresh_mhz() {
    let mut ajustes = AppSettings::default();
    ajustes.display_modes.insert("k".to_string(), vec![modo(1920, 1080, 60_000)]);
    let json = serde_json::to_value(&ajustes).unwrap();
    assert_eq!(
        json["display_modes"]["k"],
        serde_json::json!([{ "width": 1920, "height": 1080, "refreshMhz": 60000 }])
    );
    let vuelta: AppSettings = serde_json::from_value(json).unwrap();
    assert_eq!(vuelta, ajustes);
}
