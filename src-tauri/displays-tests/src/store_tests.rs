//! Encargo 01 de escenas, sub-paso 3 (criterio 8): la copia cruda `displays.pre-escenas.json`.
//!
//! Todo en carpetas temporales propias: nunca el `%APPDATA%` real.

use std::fs;
use std::path::PathBuf;

use monarch::{AppConfig, ConfigStore, Profile};

use crate::displays::store::MillenniumConfigStore;

fn carpeta(tag: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("millennium-checkpoint-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Un archivo "de Guido": formato raro a propósito (espacios, orden de claves) para que
/// una copia que pasara por el parser y se reescribiera NO sea idéntica byte a byte.
const SEMILLA: &str = "{\n   \"profiles\" : [ { \"name\":\"TV sola\", \"layout\": {\"outputs\":[]} } ],\n\"settings\":{\"revert_timeout_secs\":8}\n}";

#[test]
fn el_checkpoint_es_identico_byte_a_byte_al_archivo_de_antes() {
    let dir = carpeta("identico");
    fs::write(dir.join("displays.json"), SEMILLA).unwrap();

    let store = MillenniumConfigStore::new(&dir).unwrap();
    // Guardar algo distinto: el displays.json cambia, el checkpoint no.
    let mut config = store.load().unwrap();
    config.profiles.push(Profile {
        name: "Otra".to_string(),
        layout: Default::default(),
    });
    store.save(&config).unwrap();

    let checkpoint = fs::read(dir.join("displays.pre-escenas.json")).unwrap();
    assert_eq!(checkpoint, SEMILLA.as_bytes());
    assert_ne!(fs::read(dir.join("displays.json")).unwrap(), SEMILLA.as_bytes());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn una_segunda_apertura_no_pisa_el_checkpoint() {
    let dir = carpeta("unavez");
    fs::write(dir.join("displays.json"), SEMILLA).unwrap();
    {
        let store = MillenniumConfigStore::new(&dir).unwrap();
        store.save(&AppConfig::default()).unwrap();
    }
    // El displays.json ya es el de la versión nueva; abrir otra vez no lo resguarda encima.
    let _store = MillenniumConfigStore::new(&dir).unwrap();
    assert_eq!(
        fs::read(dir.join("displays.pre-escenas.json")).unwrap(),
        SEMILLA.as_bytes()
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn un_checkpoint_que_ya_existe_nunca_se_pisa() {
    let dir = carpeta("existente");
    fs::write(dir.join("displays.pre-escenas.json"), "el primero").unwrap();
    fs::write(dir.join("displays.json"), SEMILLA).unwrap();
    let _store = MillenniumConfigStore::new(&dir).unwrap();
    assert_eq!(
        fs::read(dir.join("displays.pre-escenas.json")).unwrap(),
        b"el primero"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn un_archivo_corrupto_tambien_se_resguarda() {
    let dir = carpeta("corrupto");
    let roto = b"{ esto no es json \xff\xfe";
    fs::write(dir.join("displays.json"), roto).unwrap();
    // Con bytes que ni son UTF-8 el store no abre (el `Result` se ignora); el checkpoint ya se
    // hizo antes de leer y conserva los bytes tal cual.
    let _ = MillenniumConfigStore::new(&dir);
    assert_eq!(fs::read(dir.join("displays.pre-escenas.json")).unwrap(), roto);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn sin_archivo_previo_no_hay_nada_que_resguardar() {
    let dir = carpeta("vacio");
    let store = MillenniumConfigStore::new(&dir).unwrap();
    store.save(&AppConfig::default()).unwrap();
    assert!(!dir.join("displays.pre-escenas.json").exists());
    let _ = fs::remove_dir_all(&dir);
}
