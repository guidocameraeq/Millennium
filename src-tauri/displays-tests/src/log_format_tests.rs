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
fn el_token_de_la_url_no_aparece_pero_la_ip_el_puerto_y_la_ruta_si() {
    let url = "https://192.168.0.20:53317/upload/sesion1/archivo2?token=SECRETO";
    let r = redact_query(url);
    assert!(!r.contains("SECRETO"), "el token sigue en la URL: {r}");
    assert_eq!(r, "https://192.168.0.20:53317/upload/sesion1/archivo2?token=***");
}

#[test]
fn el_token_no_aparece_en_el_error_de_reqwest_que_cita_la_url() {
    let causa = "POST https://192.168.0.20:53317/upload/s/f?token=SECRETO: error sending request for url (https://192.168.0.20:53317/upload/s/f?token=SECRETO): connection reset";
    let l = send_failed_line("upload a.txt", "Notebook", "192.168.0.20", 53317, causa);
    assert!(!l.contains("SECRETO"), "la línea filtra el token: {l}");
    assert!(l.contains("192.168.0.20:53317/upload/s/f?token=***"));
    assert!(l.contains("connection reset"));
}

#[test]
fn cualquier_parametro_de_query_se_tapa_y_los_nombres_quedan() {
    assert_eq!(
        redact_query("http://x:1/p?a=1&token=zzz&b=dos tres"),
        "http://x:1/p?a=***&token=***&b=*** tres"
    );
    assert_eq!(redact_query("(http://x:1/p?token=zzz)"), "(http://x:1/p?token=***)");
}

#[test]
fn un_texto_sin_query_queda_igual() {
    assert_eq!(redact_query("connection refused"), "connection refused");
    assert_eq!(redact_query("https://10.0.0.1:1/info"), "https://10.0.0.1:1/info");
    assert_eq!(redact_query("¿falló? sí"), "¿falló? sí");
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

#[test]
fn el_diagnostico_de_arranque_lleva_version_ip_puerto_y_placas() {
    use crate::net_ifaces::classify_ifaces;
    use std::net::IpAddr;
    let ifaces: Vec<(String, IpAddr)> = vec![
        ("Wi-Fi".to_string(), "192.168.0.15".parse().unwrap()),
        ("vEthernet (WSL)".to_string(), "172.20.80.1".parse().unwrap()),
        ("Loopback Pseudo-Interface 1".to_string(), "127.0.0.1".parse().unwrap()),
    ];
    let choice = classify_ifaces(&ifaces);
    let lines = startup_diagnostic("1.5.3", &choice, "192.168.0.15", 53319);
    assert_eq!(lines.len(), 4);
    assert!(lines[0].contains("v1.5.3"));
    assert!(lines[0].contains("announced ip 192.168.0.15"));
    assert!(lines[0].contains("server port 53319"));
    assert!(lines[0].contains("1 used, 2 discarded"));
    assert!(lines[1].contains("'Wi-Fi' 192.168.0.15 -> used"));
    assert!(lines[2].contains("'vEthernet (WSL)' 172.20.80.1 -> discarded: virtual adapter"));
    assert!(lines[3].contains("-> discarded: loopback"));
}

#[test]
fn el_diagnostico_sin_placas_igual_dice_la_ip_y_el_puerto() {
    let lines = startup_diagnostic("1.5.3", &Default::default(), "10.0.0.2", 53319);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("0 used, 0 discarded"));
}

#[test]
fn las_direcciones_ipv6_no_se_cuentan_como_placas_descartadas() {
    use crate::net_ifaces::classify_ifaces;
    use std::net::IpAddr;
    let ifaces: Vec<(String, IpAddr)> = vec![
        ("Wi-Fi".to_string(), "192.168.0.15".parse().unwrap()),
        ("Wi-Fi".to_string(), "fe80::1".parse().unwrap()),
        ("Loopback Pseudo-Interface 1".to_string(), "::1".parse().unwrap()),
    ];
    let lines = startup_diagnostic("1.5.3", &classify_ifaces(&ifaces), "192.168.0.15", 53319);
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("1 used, 0 discarded, 2 ipv6 addresses ignored"));
    assert!(!lines[0].contains("fallback"));
    assert!(!lines.iter().any(|l| l.contains("fe80")));
}

#[test]
fn sin_placas_que_pasen_la_regla_dice_que_la_ip_es_de_respaldo() {
    use crate::net_ifaces::classify_ifaces;
    use std::net::IpAddr;
    let ifaces: Vec<(String, IpAddr)> =
        vec![("vEthernet (External)".to_string(), "192.168.0.15".parse().unwrap())];
    let lines = startup_diagnostic("1.5.3", &classify_ifaces(&ifaces), "192.168.0.15", 53319);
    assert!(lines[0].contains("announced ip 192.168.0.15 (fallback: no adapter passed the rule)"));
    assert!(lines[0].contains("0 used, 1 discarded"));
    assert!(lines[1].contains("discarded: virtual adapter"));
}
