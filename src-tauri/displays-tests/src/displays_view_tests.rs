//! Tests de la vista de displays (`src/displays/view.rs`): el orden, la guarda
//! de "el último monitor no se apaga" y los u64 como string. Movidos tal cual de
//! `displays/mod.rs`, donde no corrían en ningún lado.

use crate::displays::view::*;

#[test]
fn mock_displays_ordena_primario_activos_y_despues_desconectados() {
    let views = mock_displays();
    assert_eq!(views.len(), 3);
    assert!(views[0].primary, "el primario va primero");
    assert!(views[1].active && !views[1].primary);
    assert!(!views[2].active, "el desconectado va último");
}

#[test]
fn el_desconectado_usa_el_centinela_cero_por_cero() {
    let views = mock_displays();
    let detached = views.iter().find(|v| !v.active).expect("hay uno inactivo");
    assert_eq!((detached.width, detached.height), (0, 0));
}

#[test]
fn los_u64_viajan_como_string_para_no_perder_precision_en_js() {
    // 2^53 + 1: el primer entero que un Number de JS NO puede representar.
    let big = (1u64 << 53) + 1;
    let view = DisplayView {
        id: "x".to_string(),
        name: "x".to_string(),
        active: true,
        primary: true,
        width: 1,
        height: 1,
        refresh_mhz: 60_000,
        position_x: 0,
        position_y: 0,
        adapter_luid: big.to_string(),
        target_id: 1,
        edid_hash: Some(big.to_string()),
        can_detach: true,
    };
    let json = serde_json::to_string(&view).expect("serializa");
    assert!(
        json.contains(&format!("\"adapterLuid\":\"{big}\"")),
        "adapterLuid tiene que ir entre comillas, no como número: {json}"
    );
    assert!(json.contains(&format!("\"edidHash\":\"{big}\"")));
}

#[test]
fn el_ultimo_monitor_prendido_no_se_puede_apagar() {
    // El mock tiene dos activos, así que los dos se pueden apagar.
    let views = mock_displays();
    for view in views.iter().filter(|v| v.active) {
        assert!(view.can_detach, "con dos prendidos, {} se puede apagar", view.name);
    }
    // Y ninguno apagado ofrece DETACH.
    for view in views.iter().filter(|v| !v.active) {
        assert!(!view.can_detach);
    }

    // Con uno solo prendido, ese uno NO se puede apagar: es la guarda que
    // impide dejar la máquina a ciegas.
    let mut solo_uno: Vec<DisplayView> = views
        .into_iter()
        .map(|mut v| {
            v.active = v.primary;
            v
        })
        .collect();
    mark_can_detach(&mut solo_uno);
    assert!(
        solo_uno.iter().all(|v| !v.can_detach),
        "con un solo monitor prendido, nadie puede apagarse"
    );
}
