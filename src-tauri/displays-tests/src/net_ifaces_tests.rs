//! Tests de la regla de "placa real" (`src/net_ifaces.rs`, encargo 01 de
//! puesta-a-punto). Casos de sí y de no con los nombres que Windows les pone de
//! verdad a las placas.

use crate::net_ifaces::{classify_ifaces, Discard, IfaceChoice};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}

fn one(name: &str, ip: IpAddr) -> IfaceChoice {
    classify_ifaces(&[(name.to_string(), ip)])
}

fn discarded_as(name: &str, ip: IpAddr) -> Option<Discard> {
    let c = one(name, ip);
    assert!(c.used.is_empty(), "{name} {ip} no debería usarse");
    c.discarded.first().map(|(_, _, why)| *why)
}

#[test]
fn wifi_real_se_usa() {
    let c = one("Wi-Fi", v4(192, 168, 1, 42));
    assert_eq!(c.used, vec![("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 42))]);
    assert!(c.discarded.is_empty());
}

#[test]
fn ethernet_real_se_usa() {
    let c = one("Ethernet", v4(10, 0, 5, 9));
    assert_eq!(c.used, vec![("Ethernet".to_string(), Ipv4Addr::new(10, 0, 5, 9))]);
}

#[test]
fn vethernet_wsl_se_descarta() {
    assert_eq!(discarded_as("vEthernet (WSL)", v4(172, 20, 0, 1)), Some(Discard::Virtual));
}

#[test]
fn hyper_v_se_descarta() {
    assert_eq!(
        discarded_as("vEthernet (Default Switch)", v4(172, 24, 16, 1)),
        Some(Discard::Virtual)
    );
    assert_eq!(
        discarded_as("Hyper-V Virtual Ethernet Adapter", v4(192, 168, 50, 1)),
        Some(Discard::Virtual)
    );
}

#[test]
fn docker_se_descarta() {
    assert_eq!(discarded_as("vEthernet (DockerNAT)", v4(10, 0, 75, 1)), Some(Discard::Virtual));
    assert_eq!(discarded_as("docker0", v4(172, 17, 0, 1)), Some(Discard::Virtual));
}

#[test]
fn vpn_se_descarta() {
    assert_eq!(discarded_as("ProtonVPN", v4(10, 2, 0, 2)), Some(Discard::Virtual));
    assert_eq!(discarded_as("OpenVPN TAP-Windows6", v4(10, 8, 0, 6)), Some(Discard::Virtual));
    assert_eq!(discarded_as("Tailscale", v4(100, 64, 1, 2)), Some(Discard::NotPrivate));
}

#[test]
fn apipa_se_descarta() {
    assert_eq!(discarded_as("Ethernet", v4(169, 254, 3, 3)), Some(Discard::LinkLocal));
}

#[test]
fn loopback_se_descarta() {
    assert_eq!(
        discarded_as("Loopback Pseudo-Interface 1", v4(127, 0, 0, 1)),
        Some(Discard::Loopback)
    );
}

#[test]
fn ip_publica_e_ipv6_se_descartan() {
    assert_eq!(discarded_as("Ethernet 2", v4(8, 8, 8, 8)), Some(Discard::NotPrivate));
    assert_eq!(
        discarded_as("Wi-Fi", IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1))),
        Some(Discard::NotIpv4)
    );
}

#[test]
fn pc_con_wsl_y_hyper_v_usa_solo_la_real_y_dice_por_que_descarto() {
    // Una PC típica: WSL y Hyper-V primero en el orden del sistema.
    let ifaces = vec![
        ("vEthernet (WSL)".to_string(), v4(172, 20, 0, 1)),
        ("vEthernet (Default Switch)".to_string(), v4(172, 24, 16, 1)),
        ("Wi-Fi".to_string(), v4(192, 168, 1, 42)),
        ("Loopback Pseudo-Interface 1".to_string(), v4(127, 0, 0, 1)),
    ];
    let c = classify_ifaces(&ifaces);
    assert_eq!(c.used, vec![("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 42))]);
    let why: Vec<(&str, Discard)> =
        c.discarded.iter().map(|(n, _, d)| (n.as_str(), *d)).collect();
    assert_eq!(
        why,
        vec![
            ("vEthernet (WSL)", Discard::Virtual),
            ("vEthernet (Default Switch)", Discard::Virtual),
            ("Loopback Pseudo-Interface 1", Discard::Loopback),
        ]
    );
}

#[test]
fn dos_placas_reales_se_usan_las_dos_en_orden() {
    let ifaces = vec![
        ("Ethernet".to_string(), v4(192, 168, 0, 10)),
        ("Wi-Fi".to_string(), v4(192, 168, 1, 42)),
    ];
    let c = classify_ifaces(&ifaces);
    assert_eq!(
        c.used,
        vec![
            ("Ethernet".to_string(), Ipv4Addr::new(192, 168, 0, 10)),
            ("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 42)),
        ]
    );
}

#[test]
fn sin_placas_reales_no_usa_ninguna() {
    let ifaces = vec![
        ("vEthernet (Default Switch)".to_string(), v4(172, 20, 0, 1)),
        ("lo".to_string(), v4(127, 0, 0, 1)),
    ];
    let c = classify_ifaces(&ifaces);
    assert!(c.used.is_empty());
    assert_eq!(c.discarded.len(), 2);
    assert!(classify_ifaces(&[]).used.is_empty());
}

// --- diff_ips: qué placas se fueron y cuáles llegaron (watcher de red) ---

use crate::net_ifaces::diff_ips;

#[test]
fn mismas_placas_en_otro_orden_no_es_cambio() {
    let a = [v4(192, 168, 1, 42), v4(192, 168, 0, 10)];
    let b = [v4(192, 168, 0, 10), v4(192, 168, 1, 42)];
    assert!(diff_ips(&a, &b).is_empty());
    assert!(diff_ips(&a, &a).is_empty());
}

#[test]
fn roam_de_wifi_saca_la_vieja_y_suma_la_nueva() {
    let d = diff_ips(&[v4(192, 168, 1, 42)], &[v4(10, 0, 0, 7)]);
    assert_eq!(d.gone, vec![v4(192, 168, 1, 42)]);
    assert_eq!(d.added, vec![v4(10, 0, 0, 7)]);
    assert!(!d.is_empty());
}

#[test]
fn enchufar_ethernet_solo_suma() {
    let d = diff_ips(&[v4(192, 168, 1, 42)], &[v4(192, 168, 0, 10), v4(192, 168, 1, 42)]);
    assert!(d.gone.is_empty());
    assert_eq!(d.added, vec![v4(192, 168, 0, 10)]);
}

#[test]
fn desenchufar_ethernet_solo_saca() {
    let d = diff_ips(&[v4(192, 168, 0, 10), v4(192, 168, 1, 42)], &[v4(192, 168, 1, 42)]);
    assert_eq!(d.gone, vec![v4(192, 168, 0, 10)]);
    assert!(d.added.is_empty());
}

#[test]
fn arrancar_sin_red_y_que_vuelva_suma_la_placa() {
    let d = diff_ips(&[], &[v4(192, 168, 1, 42)]);
    assert!(d.gone.is_empty());
    assert_eq!(d.added, vec![v4(192, 168, 1, 42)]);
    // Y al revés: se fueron todas.
    let d = diff_ips(&[v4(192, 168, 1, 42)], &[]);
    assert_eq!(d.gone, vec![v4(192, 168, 1, 42)]);
    assert!(d.added.is_empty());
    assert!(diff_ips(&[], &[]).is_empty());
}

// --- mdns_ip_list: placas del daemon, con respaldo ---

use crate::net_ifaces::mdns_ip_list;

fn used(pairs: &[(&str, [u8; 4])]) -> Vec<(String, Ipv4Addr)> {
    pairs.iter().map(|(n, o)| (n.to_string(), Ipv4Addr::from(*o))).collect()
}

#[test]
fn con_placas_reales_no_usa_el_respaldo() {
    let u = used(&[("Wi-Fi", [192, 168, 1, 42]), ("Ethernet", [192, 168, 0, 10])]);
    assert_eq!(
        mdns_ip_list(&u, "172.20.0.1"),
        vec![v4(192, 168, 1, 42), v4(192, 168, 0, 10)]
    );
}

#[test]
fn sin_placas_reales_usa_el_respaldo() {
    // Hyper-V con switch externo: la placa buena se llama "vEthernet (External)"
    // y la regla la descarta; el daemon no puede quedar sordo.
    assert_eq!(mdns_ip_list(&[], "192.168.1.42"), vec![v4(192, 168, 1, 42)]);
}

#[test]
fn sin_placas_y_sin_respaldo_queda_vacia() {
    assert!(mdns_ip_list(&[], "").is_empty());
    assert!(mdns_ip_list(&[], "no-es-una-ip").is_empty());
}

#[test]
fn la_misma_ip_dos_veces_cuenta_una() {
    let u = used(&[("Wi-Fi", [192, 168, 1, 42]), ("Wi-Fi", [192, 168, 1, 42])]);
    assert_eq!(mdns_ip_list(&u, ""), vec![v4(192, 168, 1, 42)]);
}

// --- classify_send_failure / drops_client: qué error tira el cliente cacheado ---

use crate::net_ifaces::{classify_send_failure, drops_client, SendFailure};

#[test]
fn ip_que_no_responde_es_conexion_y_tira_el_cliente() {
    let k = classify_send_failure(true, true, "error trying to connect: tcp connect error: timed out");
    assert_eq!(k, SendFailure::Connect);
    assert!(drops_client(k));
}

#[test]
fn conexion_rechazada_tira_el_cliente() {
    let k = classify_send_failure(true, false, "tcp connect error: Connection refused (os error 10061)");
    assert_eq!(k, SendFailure::Connect);
    assert!(drops_client(k));
}

#[test]
fn timeout_sin_conectar_tira_el_cliente() {
    let k = classify_send_failure(false, true, "operation timed out");
    assert_eq!(k, SendFailure::Timeout);
    assert!(drops_client(k));
}

#[test]
fn pin_que_no_coincide_no_tira_el_cliente() {
    // reqwest lo marca como error de conexión (falló el handshake), pero un
    // cliente nuevo con la misma huella fallaría igual: no se descarta.
    let k = classify_send_failure(
        true,
        false,
        "error trying to connect: invalid peer certificate: cert fingerprint mismatch: expected ab12, got cd34",
    );
    assert_eq!(k, SendFailure::Pin);
    assert!(!drops_client(k));
}

#[test]
fn otro_error_no_tira_el_cliente() {
    let k = classify_send_failure(false, false, "error decoding response body");
    assert_eq!(k, SendFailure::Other);
    assert!(!drops_client(k));
}
