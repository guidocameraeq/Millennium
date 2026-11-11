//! Encargo 03 de escenas, sub-paso 4: las listas para elegir (`displays/listas.rs`), probadas con
//! archivos de muestra inventados en una carpeta temporal. Ningún dato real de Guido.

use std::path::{Path, PathBuf};

use crate::displays::listas::*;

/// Una carpeta temporal propia de cada prueba, que se borra sola.
struct Carpeta(PathBuf);

impl Carpeta {
    fn nueva(nombre: &str) -> Self {
        let ruta = std::env::temp_dir().join(format!(
            "millennium-listas-{}-{}",
            std::process::id(),
            nombre
        ));
        let _ = std::fs::remove_dir_all(&ruta);
        std::fs::create_dir_all(&ruta).unwrap();
        Carpeta(ruta)
    }

    fn escribir(&self, relativa: &str, texto: &str) {
        let destino = self.0.join(relativa);
        std::fs::create_dir_all(destino.parent().unwrap()).unwrap();
        std::fs::write(destino, texto).unwrap();
    }

    fn ruta(&self) -> &Path {
        &self.0
    }
}

impl Drop for Carpeta {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn manifest(app_id: &str, nombre: &str) -> String {
    format!(
        "\"AppState\"\n{{\n\t\"appid\"\t\t\"{app_id}\"\n\t\"name\"\t\t\"{nombre}\"\n\t\"installdir\"\t\t\"x\"\n}}\n"
    )
}

#[test]
fn las_bibliotecas_se_leen_del_formato_nuevo_con_barras_dobles() {
    let texto = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps"
		{
			"228980"		"1234"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
	"contentstatsid"		"123"
}
"#;
    assert_eq!(
        bibliotecas_de_steam(texto),
        vec![
            PathBuf::from(r"C:\Program Files (x86)\Steam"),
            PathBuf::from(r"D:\SteamLibrary")
        ]
    );
}

#[test]
fn las_bibliotecas_se_leen_tambien_del_formato_viejo() {
    let texto = "\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\t\"1\"\n\t\"1\"\t\t\"E:\\\\Juegos\"\n}\n";
    assert_eq!(bibliotecas_de_steam(texto), vec![PathBuf::from(r"E:\Juegos")]);
}

#[test]
fn un_vdf_roto_o_vacio_no_es_un_error() {
    assert!(bibliotecas_de_steam("").is_empty());
    assert!(bibliotecas_de_steam("\"libraryfolders\" {{{{ \"0\" ").is_empty());
    assert!(bibliotecas_de_steam("basura sin comillas").is_empty());
    assert_eq!(juego_de_manifest("\"AppState\" { \"appid\" "), None);
}

#[test]
fn un_manifest_da_su_id_y_su_nombre() {
    assert_eq!(
        juego_de_manifest(&manifest("1145350", "Hades II")),
        Some(("1145350".to_string(), "Hades II".to_string()))
    );
}

#[test]
fn un_manifest_sin_nombre_o_con_id_raro_no_entra() {
    let sin_nombre = "\"AppState\"\n{\n\t\"appid\"\t\"7\"\n}\n";
    assert_eq!(juego_de_manifest(sin_nombre), None);
    assert_eq!(juego_de_manifest(&manifest("abc", "X")), None);
    assert_eq!(juego_de_manifest(&manifest("5", "  ")), None);
}

#[test]
fn los_juegos_salen_de_todas_las_bibliotecas_ordenados_y_sin_repetir() {
    let steam = Carpeta::nueva("steam");
    let otra = Carpeta::nueva("steam-otra");
    steam.escribir(
        "steamapps/libraryfolders.vdf",
        &format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}\n",
            otra.ruta().to_string_lossy().replace('\\', "\\\\")
        ),
    );
    steam.escribir("steamapps/appmanifest_1.acf", &manifest("1", "zeta juego"));
    steam.escribir("steamapps/appmanifest_2.acf", &manifest("2", "Alfa"));
    // El instalador de librerías de Steam no es un juego.
    steam.escribir(
        "steamapps/appmanifest_228980.acf",
        &manifest("228980", "Steamworks Common Redistributables"),
    );
    otra.escribir("steamapps/appmanifest_3.acf", &manifest("3", "beta"));
    // Repetido en las dos bibliotecas: sale una vez.
    otra.escribir("steamapps/appmanifest_2.acf", &manifest("2", "Alfa"));
    // Roto: se saltea sin romper nada.
    otra.escribir("steamapps/appmanifest_9.acf", "no es un manifest");

    let juegos = juegos_de_steam(steam.ruta());
    let nombres: Vec<&str> = juegos.iter().map(|j| j.name.as_str()).collect();
    assert_eq!(nombres, ["Alfa", "beta", "zeta juego"], "por nombre, sin mayúsculas");
    assert_eq!(juegos[0].app_id, "2");
}

#[test]
fn sin_steam_la_lista_sale_vacia() {
    let nada = Carpeta::nueva("sin-steam");
    assert!(juegos_de_steam(&nada.ruta().join("no-existe")).is_empty());
    assert!(juegos_de_steam(nada.ruta()).is_empty());
}

#[test]
fn las_cuentas_de_chrome_salen_de_info_cache() {
    let texto = r#"{
        "profile": {
            "info_cache": {
                "Profile 1": {"name": "Trabajo", "shortcut_name": "x"},
                "Default": {"name": "Personal"},
                "Profile 2": {}
            },
            "last_used": "Default"
        },
        "otra_cosa": 1
    }"#;
    assert_eq!(
        cuentas_de_chrome(texto),
        vec![
            ChromeProfile {
                directory: "Default".to_string(),
                name: "Personal".to_string()
            },
            ChromeProfile {
                directory: "Profile 2".to_string(),
                name: "Profile 2".to_string()
            },
            ChromeProfile {
                directory: "Profile 1".to_string(),
                name: "Trabajo".to_string()
            },
        ],
        "sin nombre usa la carpeta; ordenadas por nombre visible"
    );
}

#[test]
fn sin_chrome_o_con_un_local_state_roto_no_hay_cuentas() {
    assert!(cuentas_de_chrome("").is_empty());
    assert!(cuentas_de_chrome("{ roto").is_empty());
    assert!(cuentas_de_chrome(r#"{"profile": {}}"#).is_empty());
    assert!(cuentas_de_chrome(r#"{"profile": {"info_cache": []}}"#).is_empty());
}

fn v(exe: &str, titulo: &str) -> (String, String) {
    (exe.to_string(), titulo.to_string())
}

#[test]
fn los_programas_abiertos_van_uno_por_exe_sin_los_prohibidos() {
    let lista = programas_abiertos(
        vec![
            v("Steam.exe", "Steam"),
            v("steam.exe", "Otra ventana de Steam"),
            v("explorer.exe", "Este equipo"),
            v("DWM.EXE", "dwm"),
            v("millennium-clipboard.exe", "Millennium"),
            v("mi-app-renombrada.exe", "Yo mismo"),
            v("chrome.exe", "Google Chrome"),
            v("sinTitulo.exe", "   "),
        ],
        "mi-app-renombrada.exe",
    );
    assert_eq!(
        lista,
        vec![
            RunningProgram {
                exe: "chrome.exe".to_string(),
                title: "Google Chrome".to_string()
            },
            RunningProgram {
                exe: "steam.exe".to_string(),
                title: "Steam".to_string()
            },
        ]
    );
}
