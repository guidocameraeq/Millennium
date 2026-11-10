//! Tests del formato del log (`src/log_format.rs`, encargo 02 de
//! puesta-a-punto): la línea con fecha y hora, y cuándo rota el archivo.

use crate::log_format::*;

fn stamp(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Stamp {
    Stamp { year: y, month: mo, day: d, hour: h, minute: mi, second: s }
}

#[test]
fn la_linea_lleva_fecha_hora_nivel_y_mensaje() {
    let line = format_line(&stamp(2026, 11, 10, 23, 14, 5), "ERR ", "[send] fallo");
    assert_eq!(line, "2026-11-10 23:14:05 [ERR ] [send] fallo");
}

#[test]
fn la_fecha_rellena_con_ceros() {
    assert_eq!(format_stamp(&stamp(2026, 1, 2, 3, 4, 5)), "2026-01-02 03:04:05");
}

#[test]
fn de_segundos_unix_sale_la_fecha_utc() {
    assert_eq!(format_stamp(&stamp_from_unix(0)), "1970-01-01 00:00:00");
    // 2026-11-10 23:14:05 UTC
    assert_eq!(format_stamp(&stamp_from_unix(1_794_352_445)), "2026-11-10 23:14:05");
    // bisiesto: 2024-02-29 12:00:00 UTC
    assert_eq!(format_stamp(&stamp_from_unix(1_709_208_000)), "2024-02-29 12:00:00");
    // fin de año: 2025-12-31 23:59:59 UTC
    assert_eq!(format_stamp(&stamp_from_unix(1_767_225_599)), "2025-12-31 23:59:59");
}

#[test]
fn no_rota_mientras_entre_justo_en_el_limite() {
    assert!(!should_rotate(0, 100));
    assert!(!should_rotate(MAX_FILE_BYTES - 100, 100));
}

#[test]
fn rota_cuando_la_linea_pasa_el_limite() {
    assert!(should_rotate(MAX_FILE_BYTES - 99, 100));
    assert!(should_rotate(MAX_FILE_BYTES, 1));
    assert!(should_rotate(MAX_FILE_BYTES + 1, 0));
}

#[test]
fn no_se_desborda_con_tamanos_enormes() {
    assert!(should_rotate(u64::MAX, 10));
}

#[test]
fn el_limite_es_5_mb_y_hay_3_respaldos() {
    assert_eq!(MAX_FILE_BYTES, 5 * 1024 * 1024);
    assert_eq!(BACKUPS, 3);
}

#[test]
fn los_respaldos_se_llaman_runtime_log_n() {
    assert_eq!(backup_name(1), "runtime.log.1");
    assert_eq!(backup_name(3), "runtime.log.3");
}

#[test]
fn la_rotacion_pierde_el_mas_viejo_y_corre_los_demas_en_orden() {
    let (deletes, renames) = rotation_plan();
    assert_eq!(deletes, vec!["runtime.log.3".to_string()]);
    assert_eq!(
        renames,
        vec![
            ("runtime.log.2".to_string(), "runtime.log.3".to_string()),
            ("runtime.log.1".to_string(), "runtime.log.2".to_string()),
            ("runtime.log".to_string(), "runtime.log.1".to_string()),
        ]
    );
}

#[test]
fn un_texto_secreto_no_aparece_en_ninguna_linea_de_envio() {
    let secreto = "clave-super-secreta-123";
    let largo = secreto.chars().count();
    let lines = [
        send_text_line("PC-Guido", "192.168.0.15", 53317, largo),
        text_received_line("PC-Guido", "192.168.0.15", largo),
        send_failed_line("text", "PC-Guido", "192.168.0.15", 53317, "connection refused"),
    ];
    for l in lines {
        assert!(!l.contains(secreto), "la línea filtra el texto: {l}");
        assert!(!l.contains("secreta"), "la línea filtra el texto: {l}");
    }
}

#[test]
fn la_linea_de_envio_lleva_peer_y_tamano() {
    assert_eq!(
        send_text_line("Notebook", "192.168.0.20", 53317, 23),
        "[send] text -> Notebook (192.168.0.20:53317) chars=23"
    );
    assert_eq!(
        send_files_line("Notebook", "192.168.0.20", 53317, 2, "0123456789abcdef"),
        "[send] files -> Notebook (192.168.0.20:53317) files=2 session=01234567"
    );
}

#[test]
fn la_linea_de_fallo_lleva_peer_y_causa() {
    assert_eq!(
        send_failed_line("prepare", "Notebook", "192.168.0.20", 53317, "timed out"),
        "[send] FAILED prepare -> Notebook (192.168.0.20:53317): timed out"
    );
}

#[test]
fn un_alias_con_saltos_de_linea_no_falsifica_otra_linea() {
    let l = send_failed_line("text", "Malo\n2026-01-01 00:00:00 [INFO] fake", "10.0.0.1", 1, "x\r\ny");
    assert!(!l.contains('\n') && !l.contains('\r'));
    assert_eq!(one_line("a\tb\nc"), "a b c");
}

#[test]
fn la_linea_de_recepcion_lleva_quien_y_cuanto() {
    assert_eq!(
        text_received_line("Notebook", "192.168.0.20", 5),
        "[http] /text received chars=5 from Notebook (192.168.0.20)"
    );
}

#[test]
fn un_mensaje_de_varias_lineas_queda_en_una_sola_linea_con_fecha() {
    let line = format_line(&stamp(2026, 11, 10, 23, 14, 5), "ERR ", "falló\nCaused by: timeout");
    assert_eq!(line, "2026-11-10 23:14:05 [ERR ] falló Caused by: timeout");
}
