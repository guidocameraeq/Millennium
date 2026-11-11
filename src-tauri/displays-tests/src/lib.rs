//! Andamio para correr los tests de los archivos reales de `src/displays/`.
//!
//! Ver el `Cargo.toml` de al lado para el porqué. Acá solo se reproduce el
//! entorno que esos archivos esperan: `crate::runtime_log`, `crate::json_store`
//! y `super::diagnostics`.
//!
//! **Los `#[path]` son relativos**, no absolutos: tienen que funcionar igual en
//! la máquina del dueño y en el runner del CI. Ojo con el nivel: adentro de
//! `mod displays { ... }` la base pasa a ser `src/displays/`, no `src/`, así que
//! los de adentro llevan un `../` más que el de `json_store`.
//!
//! El `allow(dead_code)` es del andamio, no del código real: acá nadie *usa* el
//! watchdog fuera de sus tests, así que sin esto cada corrida escupe una decena
//! de "never used" que no significan nada. En el crate de la app esos mismos
//! archivos sí tienen consumidor, y ahí las advertencias siguen valiendo.
#![allow(dead_code)]

/// Doble del `runtime_log` de Millennium. Misma firma exacta —`impl Into<String>`,
/// y `err`, no `error`—, así un cambio de firma allá rompe acá y se nota.
pub mod runtime_log {
    pub fn info(msg: impl Into<String>) {
        let _ = msg.into();
    }
    pub fn warn(msg: impl Into<String>) {
        let _ = msg.into();
    }
    pub fn err(msg: impl Into<String>) {
        let _ = msg.into();
    }
}

// El store atómico real: `displays::store` se apoya en él, y de paso sus propios
// tests entran al gate.
#[path = "../../src/json_store.rs"]
pub mod json_store;

// La regla de "placa real" (encargo 01 de puesta-a-punto): pura, sin red.
#[path = "../../src/net_ifaces.rs"]
pub mod net_ifaces;

#[cfg(test)]
mod net_ifaces_tests;

// La dirección buena del peer entre las que anuncia mDNS (encargo 03).
#[cfg(test)]
mod peer_addr_tests;

// El medidor de mDNS (mismo encargo): de las métricas del daemon, la línea del minuto.
#[path = "../../src/mdns_meter.rs"]
pub mod mdns_meter;

#[cfg(test)]
mod mdns_meter_tests;

// El formato del log y la regla de rotación (encargo 02 de puesta-a-punto): puro.
#[path = "../../src/log_format.rs"]
pub mod log_format;

#[cfg(test)]
mod log_format_tests;

// La vista de un monitor y sus funciones puras (encargo 06): antes sus tests vivían
// en `displays/mod.rs` bajo `cfg(not(windows))` y no corrían en ningún lado.
#[cfg(test)]
mod displays_view_tests;

// El checkpoint crudo de displays.json (encargo 01 de escenas, criterio 8).
#[cfg(test)]
mod store_tests;

#[cfg(test)]
mod escenas_tests;

// Resoluciones por pantalla (encargo 02 de escenas): de un DEVMODE a un modo y qué lista
// ve cada pantalla del selector.
#[cfg(test)]
mod modos_tests;

pub mod displays {
    /// Doble del shim de logging de `displays/mod.rs` (misma firma exacta).
    pub(crate) mod diagnostics {
        pub fn log(message: impl AsRef<str>) {
            let _ = message.as_ref();
        }
    }

    #[path = "../../../src/displays/ids.rs"]
    pub mod ids;

    // Las conversiones de escenas (encargo 01): puras, sin `windows` ni `tauri`.
    #[path = "../../../src/displays/escenas.rs"]
    pub mod escenas;

    // Las reglas puras de los modos de pantalla (encargo 02): sin `windows` ni `tauri`.
    #[path = "../../../src/displays/modos.rs"]
    pub mod modos;

    #[path = "../../../src/displays/store.rs"]
    pub mod store;

    #[path = "../../../src/displays/view.rs"]
    pub mod view;

    #[path = "../../../src/displays/watchdog.rs"]
    pub mod watchdog;
}
