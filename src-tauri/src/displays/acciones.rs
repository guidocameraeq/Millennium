// Motor de acciones — Displays v2, Fase 4 (perfiles como escenas).
//
// Cuando un perfil-escena queda COMMITTEADO (ver el ciclo de escena en `mod.rs`),
// se corren sus acciones de ENTRADA; al pasar a otro perfil, las de SALIDA del
// anterior. Este módulo solo sabe EJECUTAR una lista de acciones; el "cuándo" y
// el "de quién" lo decide el enganche del ciclo.
//
// # Dos vías de lanzamiento, ninguna por shell
//
// - **`.exe` + args**: `std::process::Command` con los args EN LISTA (nunca un
//   string de shell ni `cmd /c`) y `CREATE_NO_WINDOW` para no abrir una consola.
//   Un nombre pelado (`chrome.exe`) que no esté en el PATH se resuelve por el
//   registro (App Paths). Sin concatenación ⇒ sin inyección (Riesgos del spec).
// - **URI de protocolo (`steam://…`) o `.lnk`**: van por `ShellExecuteW` con el
//   verbo `"open"`, que delega en el handler del SO (y arranca la app si está
//   cerrada). `Command` NO puede lanzar ni una URI ni un `.lnk` (CreateProcess
//   solo corre `.exe`), de ahí el dispatch por tipo de destino.
//
// Se usa el crate `windows` (no `tauri-plugin-opener`) a propósito: este módulo,
// como el resto del motor de displays, **no menciona a Tauri**, así se type-checkea
// en un crate scratch con solo `windows` (ver la cabecera de `mod.rs` y
// `docs/DECISIONS.md`). Es el mismo criterio que `audio.rs`.
//
// # Volumen (COM)
//
// `IAudioEndpointVolume` sobre la salida por default actual. Mismo molde RAII de
// apartment COM que `audio.rs` (Fase 3).
//
// # panic="abort" ⇒ best-effort a rajatabla
//
// Un panic acá se lleva puesto TODO el proceso (clipboard + discovery). NADA de
// `unwrap`/`expect`: cada acción que falla se loguea y se SIGUE con la próxima.
// El cambio de monitores/audio ya aplicado NUNCA se revierte porque una acción
// falló (Supuestos [ALTO] del spec).
#![cfg(target_os = "windows")]

use std::os::windows::process::CommandExt;
use std::process::Command;

use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
    SW_SHOWNORMAL, WM_CLOSE,
};

use super::cola::Ejecutor;
use super::escenas::exe_prohibido;

/// Flag de `CreateProcess` para no abrir ventana de consola al lanzar un `.exe`.
/// Constante estable de Win32 (`winbase.h`); se hardcodea para no tipar el
/// `PROCESS_CREATION_FLAGS` del crate `windows` solo para esto.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Los pasos de verdad, para la cola de acciones (`cola.rs`): corre en el hilo de la cola, así
/// que las llamadas COM y el `spawn` van en línea. Un paso que falla se loguea y la cola sigue.
pub struct EjecutorReal;

impl Ejecutor for EjecutorReal {
    fn lanzar(&mut self, destino: &str, args: &[String]) {
        lanzar(destino, args);
    }

    fn volumen(&mut self, nivel: u8) {
        fijar_volumen(nivel);
    }

    fn cerrar(&mut self, exe: &str) {
        cerrar(exe);
    }
}

// ── Cerrar un programa ───────────────────────────────────────────────────────

/// Cuánto se espera, después del cierre amable, a que el programa se vaya.
const ESPERA_DE_CIERRE: Duration = Duration::from_secs(5);

/// Cierre amable: le manda `WM_CLOSE` a las ventanas visibles de los procesos de `exe`, espera
/// hasta 5 s y, si alguno sigue vivo, lo dice en el log. No termina ningún proceso: ni
/// `TerminateProcess` ni nada parecido. Un programa que se va a la bandeja con la X o que corre
/// como administrador puede no cerrarse; queda en el log.
fn cerrar(exe: &str) {
    let exe = exe.trim().to_lowercase();
    // La lista prohibida se pregunta de nuevo acá: un displays.json tocado a mano no pasa por
    // la validación del guardado.
    if exe.is_empty() || exe_prohibido(&exe) || es_esta_app(&exe) {
        crate::runtime_log::warn(format!("[displays] no se cierra «{exe}»: está prohibido"));
        return;
    }
    let pids = pids_de(&exe);
    if pids.is_empty() {
        crate::runtime_log::info(format!("[displays] cerrar: «{exe}» no estaba abierto"));
        return;
    }
    let mut avisadas = 0usize;
    for (hwnd, pid) in ventanas_visibles() {
        if pids.contains(&pid) {
            // SAFETY: `hwnd` salió recién de EnumWindows; si ya no existe, PostMessageW devuelve error.
            let ok = unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok();
            if ok {
                avisadas += 1;
            }
        }
    }
    crate::runtime_log::info(format!(
        "[displays] cerrar «{exe}»: cierre amable a {avisadas} ventana/s"
    ));
    let limite = Instant::now() + ESPERA_DE_CIERRE;
    while Instant::now() < limite {
        if pids_de(&exe).is_empty() {
            crate::runtime_log::info(format!("[displays] cerrado: «{exe}»"));
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if pids_de(&exe).is_empty() {
        crate::runtime_log::info(format!("[displays] cerrado: «{exe}»"));
    } else {
        crate::runtime_log::warn(format!("[displays] no cerró: {exe}"));
    }
}

/// El nombre del ejecutable de esta misma app, en minúsculas (aunque lo hayan renombrado).
pub fn nombre_de_esta_app() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

/// `true` si `exe` (en minúsculas) es el ejecutable de esta misma app.
fn es_esta_app(exe: &str) -> bool {
    let propio = nombre_de_esta_app();
    !propio.is_empty() && propio == exe
}

// ── Dónde están Steam y Chrome ───────────────────────────────────────────────

/// La carpeta de instalación de Steam: el registro (HKCU `SteamPath`; HKLM `InstallPath`, de 32
/// y de 64 bits) y, de último, la ruta de siempre. `None` si no hay ninguna que exista.
pub fn carpeta_de_steam() -> Option<std::path::PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut candidatas: Vec<String> = Vec::new();
    let claves = [
        (HKEY_CURRENT_USER, r"SOFTWARE\Valve\Steam", "SteamPath"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];
    for (hive, sub, valor) in claves {
        if let Ok(clave) = RegKey::predef(hive).open_subkey(sub) {
            if let Ok(ruta) = clave.get_value::<String, _>(valor) {
                candidatas.push(ruta);
            }
        }
    }
    candidatas.push(r"C:\Program Files (x86)\Steam".to_string());
    candidatas
        .into_iter()
        .map(|ruta| std::path::PathBuf::from(ruta.trim()))
        .find(|ruta| ruta.join("steamapps").is_dir())
}

/// La ruta de `chrome.exe`: App Paths (HKCU y HKLM) y, si no, las carpetas de siempre.
pub fn ruta_de_chrome() -> Option<std::path::PathBuf> {
    let mut candidatas: Vec<std::path::PathBuf> = Vec::new();
    if let Some(ruta) = buscar_app_paths("chrome.exe") {
        candidatas.push(ruta.into());
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            candidatas.push(
                std::path::PathBuf::from(base)
                    .join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
    }
    candidatas.into_iter().find(|ruta| ruta.is_file())
}

/// El texto del `Local State` de Chrome (donde están sus cuentas). `None` si no se puede leer.
pub fn local_state_de_chrome() -> Option<String> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let ruta = std::path::PathBuf::from(base)
        .join("Google")
        .join("Chrome")
        .join("User Data")
        .join("Local State");
    std::fs::read_to_string(ruta).ok()
}

/// Un proceso vivo: su id y el nombre de su `.exe` (sin ruta, en minúsculas).
struct Proceso {
    pid: u32,
    exe: String,
}

fn procesos() -> Vec<Proceso> {
    let mut lista = Vec::new();
    // SAFETY: la foto de procesos es un handle propio que se cierra al salir; `entrada` lleva su
    // `dwSize` como pide la API.
    unsafe {
        let Ok(foto) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return lista;
        };
        let mut entrada = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(foto, &mut entrada).is_ok() {
            loop {
                let largo = entrada
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entrada.szExeFile.len());
                lista.push(Proceso {
                    pid: entrada.th32ProcessID,
                    exe: String::from_utf16_lossy(&entrada.szExeFile[..largo]).to_lowercase(),
                });
                if Process32NextW(foto, &mut entrada).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(foto);
    }
    lista
}

fn pids_de(exe: &str) -> Vec<u32> {
    procesos()
        .into_iter()
        .filter(|p| p.exe == exe)
        .map(|p| p.pid)
        .collect()
}

/// Callback de `EnumWindows`: junta las ventanas visibles con el proceso dueño.
unsafe extern "system" fn juntar_ventana(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` es el puntero al `Vec` que `ventanas_visibles` deja vivo durante la llamada.
    let lista = &mut *(lparam.0 as *mut Vec<(HWND, u32)>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        lista.push((hwnd, pid));
    }
    BOOL(1)
}

fn ventanas_visibles() -> Vec<(HWND, u32)> {
    let mut lista: Vec<(HWND, u32)> = Vec::new();
    // SAFETY: el puntero al `Vec` solo se usa dentro de esta llamada (EnumWindows es síncrona).
    unsafe {
        let _ = EnumWindows(Some(juntar_ventana), LPARAM(&mut lista as *mut _ as isize));
    }
    lista
}

/// Los programas abiertos con alguna ventana visible y con título: `(exe, título)`, un renglón
/// por ventana. Lo ordena y lo filtra `listas.rs`.
pub fn programas_con_ventana() -> Vec<(String, String)> {
    let por_pid: std::collections::HashMap<u32, String> =
        procesos().into_iter().map(|p| (p.pid, p.exe)).collect();
    let mut salida = Vec::new();
    for (hwnd, pid) in ventanas_visibles() {
        let Some(exe) = por_pid.get(&pid) else {
            continue;
        };
        let mut buffer = [0u16; 256];
        // SAFETY: `buffer` es propio y GetWindowTextW no escribe más de su largo.
        let largo = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if largo > 0 {
            let titulo = String::from_utf16_lossy(&buffer[..largo as usize]);
            salida.push((exe.clone(), titulo));
        }
    }
    salida
}

// ── Lanzar ───────────────────────────────────────────────────────────────────

fn lanzar(destino: &str, args: &[String]) {
    let destino = destino.trim();
    if destino.is_empty() {
        crate::runtime_log::warn("[displays] acción Lanzar con destino vacío; se saltea");
        return;
    }

    // URI de protocolo (steam://…) o acceso directo .lnk: los abre el handler del
    // SO. `Command` no puede con ninguno de los dos. Los args no aplican acá.
    if destino.contains("://") || termina_en(destino, ".lnk") {
        shell_open(destino);
        return;
    }

    // Ejecutable: args EN LISTA (sin shell), ventana oculta.
    let programa = resolver_ejecutable(destino);
    let mut cmd = Command::new(&programa);
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(_) => crate::runtime_log::info(format!(
            "[displays] acción: lanzado «{programa}» ({} arg/s)",
            args.len()
        )),
        Err(e) => crate::runtime_log::warn(format!(
            "[displays] no se pudo lanzar «{destino}»: {e}"
        )),
    }
}

/// Abre una URI de protocolo o un `.lnk` con el verbo `"open"` (ShellExecuteW).
/// El retorno `HINSTANCE` > 32 = ok; ≤ 32 = error (contrato de ShellExecute).
fn shell_open(destino: &str) {
    let file = a_wide(destino);
    let verb = a_wide("open");
    unsafe {
        let hinst = ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if (hinst.0 as isize) <= 32 {
            crate::runtime_log::warn(format!(
                "[displays] no se pudo abrir «{destino}» (ShellExecute={})",
                hinst.0 as isize
            ));
        } else {
            crate::runtime_log::info(format!("[displays] acción: abierto «{destino}»"));
        }
    }
}

/// `true` si `s` termina en `suf` sin distinguir mayúsculas (ASCII).
fn termina_en(s: &str, suf: &str) -> bool {
    let s = s.as_bytes();
    let suf = suf.as_bytes();
    s.len() >= suf.len() && s[s.len() - suf.len()..].eq_ignore_ascii_case(suf)
}

/// Resuelve el ejecutable a lanzar. Si `destino` trae separador de ruta es una
/// ruta explícita y se usa tal cual; si es un nombre pelado (`chrome.exe`) se
/// intenta resolver por App Paths del registro (así el preset de Chrome anda sin
/// pedir la ruta completa). Si no resuelve, se devuelve el nombre y `Command`
/// lo buscará en el PATH.
fn resolver_ejecutable(destino: &str) -> String {
    if destino.contains('\\') || destino.contains('/') {
        return destino.to_string();
    }
    buscar_app_paths(destino).unwrap_or_else(|| destino.to_string())
}

/// Ruta completa de un `.exe` registrado en App Paths (Chrome, Steam, etc.),
/// buscando primero en HKCU y después en HKLM. `None` si no está registrado.
fn buscar_app_paths(exe: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let sub = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}");
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        let Ok(key) = root.open_subkey(&sub) else {
            continue;
        };
        // El valor por default (nombre "") de la clave es la ruta completa.
        if let Ok(ruta) = key.get_value::<String, _>("") {
            let ruta = ruta.trim().trim_matches('"').trim().to_string();
            if !ruta.is_empty() {
                return Some(ruta);
            }
        }
    }
    None
}

// ── Volumen (COM) ─────────────────────────────────────────────────────────────

/// Apartment COM RAII (mismo criterio que `audio::ComApartment` / la sesión de
/// wallpaper en `apply.rs`): inicializa COM en el hilo de turno y lo desinicializa
/// en el `Drop`. Copiado a propósito (reuso por copia en v1, spec).
struct ComApartment {
    should_uninitialize: bool,
}

impl ComApartment {
    fn enter() -> Self {
        let mut should_uninitialize = false;
        unsafe {
            // S_OK o S_FALSE ⇒ is_ok() ⇒ hay que pagar el CoUninitialize.
            // RPC_E_CHANGED_MODE ⇒ is_err() ⇒ no tocar el balance.
            if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() {
                should_uninitialize = true;
            }
        }
        Self {
            should_uninitialize,
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.should_uninitialize {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

/// Fija el volumen (0–100) de la salida de audio por default actual. Best-effort:
/// si no hay salida o COM falla, se loguea y sigue. Corre DESPUÉS del ruteo de
/// audio de Fase 3, así que la salida por default ya es la del perfil.
fn fijar_volumen(nivel: u8) {
    let nivel = nivel.min(100);
    let scalar = nivel as f32 / 100.0;
    let _com = ComApartment::enter();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(e) => {
                    crate::runtime_log::warn(format!(
                        "[displays] volumen: no se pudo crear el enumerador de audio: {e}"
                    ));
                    return;
                }
            };
        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(e) => {
                crate::runtime_log::warn(format!(
                    "[displays] volumen: no hay salida de audio por default: {e}"
                ));
                return;
            }
        };
        let volume: IAudioEndpointVolume = match device.Activate(CLSCTX_ALL, None) {
            Ok(v) => v,
            Err(e) => {
                crate::runtime_log::warn(format!(
                    "[displays] volumen: no se pudo activar el control de volumen: {e}"
                ));
                return;
            }
        };
        // El contexto de evento va en null: no escuchamos callbacks de cambio.
        if let Err(e) = volume.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) {
            crate::runtime_log::warn(format!(
                "[displays] volumen: no se pudo fijar el nivel {nivel}%: {e}"
            ));
        } else {
            crate::runtime_log::info(format!("[displays] acción: volumen fijado en {nivel}%"));
        }
    }
}

/// UTF-16 NUL-terminado para pasar como `PCWSTR`. El `Vec` debe seguir vivo
/// mientras el `PCWSTR` se use.
fn a_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
