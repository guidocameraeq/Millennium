//! Tests del medidor de mDNS (`src/mdns_meter.rs`, encargo 01 de
//! puesta-a-punto): de dos fotos de las métricas del daemon sale la línea del
//! minuto, o nada si no hubo tráfico.

use crate::mdns_meter::minute_report;
use std::collections::HashMap;

fn snap(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

#[test]
fn minuto_sin_trafico_no_escribe_nada() {
    let a = snap(&[("browse", 5), ("respond", 40), ("cached-ptr", 2)]);
    assert_eq!(minute_report(&a, &a, 1), None);
    assert_eq!(minute_report(&HashMap::new(), &HashMap::new(), 1), None);
}

#[test]
fn cuenta_solo_lo_del_minuto_no_el_acumulado() {
    let prev = snap(&[("respond", 100), ("browse", 3)]);
    let now = snap(&[("respond", 130), ("browse", 4)]);
    let t = minute_report(&prev, &now, 1).expect("hubo tráfico");
    assert_eq!(t.responses, 30);
    assert_eq!(t.queries, 1);
    assert_eq!(t.sent, 31);
}

#[test]
fn las_preguntas_salen_por_cada_placa_las_respuestas_no() {
    // 2 placas: cada pregunta y cada anuncio sale 2 veces; cada respuesta, 1.
    let prev = HashMap::new();
    let now = snap(&[
        ("respond", 10),
        ("browse", 1),
        ("cache-refresh-ptr", 2),
        ("register", 1),
        ("register-resend", 2),
    ]);
    let t = minute_report(&prev, &now, 2).expect("hubo tráfico");
    assert_eq!(t.queries, 3);
    assert_eq!(t.announces, 3);
    assert_eq!(t.sent, 10 + (1 + 2 + 1) * 2 + 2);
}

#[test]
fn ignora_los_medidores_de_estado_y_claves_desconocidas() {
    // cached-*, dns-registry-*, timer y known-answer-suppression no son envíos.
    let prev = HashMap::new();
    let now = snap(&[
        ("cached-ptr", 9),
        ("dns-registry-active", 1),
        ("timer", 12),
        ("known-answer-suppression", 4),
        ("otra-cosa", 7),
    ]);
    assert_eq!(minute_report(&prev, &now, 1), None);
}

#[test]
fn un_contador_que_baja_no_da_negativo() {
    let prev = snap(&[("respond", 50)]);
    let now = snap(&[("respond", 10), ("browse", 1)]);
    let t = minute_report(&prev, &now, 1).expect("hubo tráfico");
    assert_eq!(t.responses, 0);
    assert_eq!(t.sent, 1);
}

#[test]
fn la_linea_dice_el_numero_a_mirar() {
    let t = minute_report(&HashMap::new(), &snap(&[("respond", 7), ("browse", 1)]), 1)
        .expect("hubo tráfico");
    let line = t.line();
    assert!(line.starts_with("[mdns] meter 60s: sent~8 packets on 1 adapter(s)"), "{line}");
    assert!(line.contains("queries heard 7"), "{line}");
}
