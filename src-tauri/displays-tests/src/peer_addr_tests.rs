//! Tests de la dirección buena del peer (`net_ifaces::pick_peer_addr`, encargo
//! 03 de puesta-a-punto): de las direcciones que trae mDNS, la que está en la
//! misma subred que una placa propia; si ninguna, la primera como siempre.

use crate::net_ifaces::{pick_peer_addr, same_subnet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}

fn mine(ips: &[[u8; 4]]) -> Vec<Ipv4Addr> {
    ips.iter().map(|o| Ipv4Addr::from(*o)).collect()
}

#[test]
fn prefiere_la_de_la_subred_de_mi_placa_aunque_venga_segunda() {
    // El peer anuncia primero la de su WSL (172.x) y después la real.
    let cands = [v4(172, 20, 0, 1), v4(192, 168, 1, 77)];
    assert_eq!(
        pick_peer_addr(&cands, &mine(&[[192, 168, 1, 42]]), 24),
        Some(v4(192, 168, 1, 77))
    );
}

#[test]
fn con_dos_placas_mias_elige_la_que_coincide_con_alguna() {
    let cands = [v4(10, 9, 9, 9), v4(192, 168, 0, 50)];
    assert_eq!(
        pick_peer_addr(&cands, &mine(&[[192, 168, 1, 42], [192, 168, 0, 10]]), 24),
        Some(v4(192, 168, 0, 50))
    );
}

#[test]
fn si_ninguna_coincide_va_la_primera_como_hoy() {
    let cands = [v4(172, 20, 0, 1), v4(10, 9, 9, 9)];
    assert_eq!(
        pick_peer_addr(&cands, &mine(&[[192, 168, 1, 42]]), 24),
        Some(v4(172, 20, 0, 1))
    );
}

#[test]
fn sin_placas_propias_va_la_primera() {
    let cands = [v4(172, 20, 0, 1), v4(192, 168, 1, 77)];
    assert_eq!(pick_peer_addr(&cands, &[], 24), Some(v4(172, 20, 0, 1)));
}

#[test]
fn sin_candidatas_no_hay_direccion() {
    assert_eq!(pick_peer_addr(&[], &mine(&[[192, 168, 1, 42]]), 24), None);
}

#[test]
fn una_ipv6_no_gana_por_coincidir_y_la_ipv4_buena_si() {
    let v6 = IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1));
    let cands = [v6, v4(192, 168, 1, 77)];
    assert_eq!(
        pick_peer_addr(&cands, &mine(&[[192, 168, 1, 42]]), 24),
        Some(v4(192, 168, 1, 77))
    );
}

#[test]
fn misma_subred_segun_el_prefijo() {
    let a = Ipv4Addr::new(192, 168, 1, 42);
    assert!(same_subnet(a, Ipv4Addr::new(192, 168, 1, 200), 24));
    assert!(!same_subnet(a, Ipv4Addr::new(192, 168, 2, 42), 24));
    assert!(same_subnet(a, Ipv4Addr::new(192, 168, 2, 42), 16));
    assert!(!same_subnet(a, Ipv4Addr::new(192, 168, 1, 200), 0));
}
