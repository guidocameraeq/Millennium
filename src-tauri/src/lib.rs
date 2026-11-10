// Millennium Clipboard — backend (Fase 7)
//
// Wires identity, persisted prefs/settings, HTTPS server, mDNS discovery,
// and the HTTPS client used to talk to peers. Commands invoked from JS
// are at the bottom.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use app::crash_log::install_panic_hook;
#[cfg(desktop)]
use app::tray::build_tray;
#[cfg(target_os = "windows")]
use app::displays_cmds::resync_profile_shortcuts;
#[cfg(target_os = "windows")]
use app::displays_cmds::aplicar_atajo_de_perfil;
use app::clipboard_poller::spawn_clipboard_poller;

mod aliases;
mod app;
mod clipboard_sync;
mod discovery;
mod displays;
mod http_client;
mod http_server;
mod icon_overrides;
mod identity;
mod json_store;
mod log_format;
mod manual_peers;
mod mdns_meter;
mod net_ifaces;
mod preferences;
mod runtime_log;
mod settings;
mod thumbnails;
mod udp_discovery;
mod updater;
#[cfg(target_os = "android")]
mod android_fs_bridge;
#[cfg(target_os = "windows")]
mod windows_integration;

// (El `mod ccd_link_smoke` de la Fase 0 vivía acá. Era un canario de linkeo:
// referenciaba una función CCD raw-dylib real para que el CI probara que el
// crate `windows` enlaza en el runner MSVC. La Fase 1 lo reemplaza por el motor
// de verdad — `mod displays`, que llama esa misma familia de funciones —, así
// que el canario ya no aporta nada y se fue.)

// ---------------------------------------------------------------------------
// Wire types shared with the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    pub alias: String,
    pub host_id_hex: String,
    pub ip: String,
    pub port: u16,
    pub fingerprint: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub download_dir: String,
    pub auto_accept_favorites: bool,
    pub notifications_enabled: bool,
    pub start_with_windows: bool,
    pub close_to_tray: bool,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AppState {
    discovery: discovery::DiscoveryState,
    identity: identity::Identity,
    prefs: Arc<preferences::PreferencesStore>,
    settings: Arc<settings::SettingsStore>,
    manual: Arc<manual_peers::ManualPeerStore>,
    aliases: Arc<aliases::AliasStore>,
    clipboard: Arc<clipboard_sync::ClipboardSyncStore>,
    icons: Arc<icon_overrides::IconOverrideStore>,
    server_port: u16,
}

// Los comandos de Tauri, el poller del portapapeles, la bandeja y el gancho de pánico
// viven en `app/`; acá queda el armado (`run()`) y el `generate_handler!`.

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the panic hook BEFORE anything else so we capture
    // crashes that happen during Tauri's own bootstrap, not just our
    // `setup` callback. Release binaries use windows_subsystem="windows"
    // which swallows stderr — without this hook every panic is invisible.
    install_panic_hook();

    // Install ring as the process-wide rustls crypto provider ONCE, before any
    // TLS work. axum-server (server) and our pinned reqwest clients (Fase 3,
    // Tarea 3.1) both build rustls configs via ClientConfig/ServerConfig
    // builder(), which panic with "no process-level CryptoProvider available"
    // if none is installed. Idempotent: .ok() swallows the "already set" error.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Best-effort: clean up any millennium-clipboard.exe processes left
    // behind by a previous crashed launch BEFORE tauri tries to bind
    // anything. The single-instance plugin handles the normal "second
    // launch" case; this is for zombies that own the port but no longer
    // respond.
    #[cfg(target_os = "windows")]
    windows_integration::kill_other_millennium_processes();

    let mut builder = tauri::Builder::default();

    // Desktop-only plugins. single-instance and autostart don't have an
    // Android backend, and the tray icon lives in build_tray() further
    // down which is already cfg'd desktop.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = argv;
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ));
    }

    // Atajos de teclado globales por perfil (Displays v2, Fase 1). Windows-only a
    // propósito: el plugin vive en la tabla windows del Cargo.toml, así que su
    // registro va bajo `#[cfg(target_os = "windows")]`, NO `#[cfg(desktop)]` (que
    // incluiría mac/linux sin la dep y rompería el build ahí). Los atajos se
    // registran/limpian después (setup + comandos) vía `resync_profile_shortcuts`;
    // acá solo se cablea el handler que aplica el perfil al dispararse uno.
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // El handler se dispara en Pressed Y Released; actuar solo al
                    // apretar, si no el perfil se aplicaría dos veces.
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Corre en el hilo de eventos del plugin: mantenerlo liviano.
                    // El trabajo real (Mutex + syscalls CCD) va a un hilo propio,
                    // como el watchdog — nada de bloquear el hilo del plugin.
                    let app = app.clone();
                    let disparado = shortcut.clone();
                    std::thread::spawn(move || {
                        aplicar_atajo_de_perfil(&app, &disparado);
                    });
                })
                .build(),
        );
    }

    // Mobile-only plugins. barcode-scanner requires a camera and Android
    // permissions; not buildable for desktop targets.
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_fs::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 0a. Bind the in-memory runtime log to the AppHandle so each
            //     log line is emitted live to the frontend log panel.
            //     Also bind a file appender at <data_dir>/runtime.log so
            //     logs survive app crashes / restarts.
            runtime_log::bind_app(app.handle().clone());
            if let Ok(data_dir_for_log) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir_for_log);
                runtime_log::bind_file(&data_dir_for_log);
            }
            runtime_log::info(format!(
                "[boot] Millennium Clipboard v{} starting",
                env!("CARGO_PKG_VERSION")
            ));

            // 0a.1 Register an AppUserModelID in HKCU so Windows accepts
            //      toast notifications from this portable .exe.
            //      Also drop the legacy Send To shortcut from v0.10.0.
            #[cfg(target_os = "windows")]
            {
                let icon_candidate = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                windows_integration::register_aumid_for_notifications(
                    icon_candidate.as_deref(),
                );
                windows_integration::cleanup_legacy_send_to_shortcut();
            }

            // 0a.3 A previous auto-update swap that failed after all retries
            //      leaves a marker (see updater.rs). It is surfaced on demand
            //      by the `take_update_failure` command, which the frontend
            //      calls at boot once its UI is ready — a pull, so the message
            //      can never be lost to an emit the webview wasn't yet
            //      listening for. Nothing to do here.

            // 0a.2 Force the window header icon to use our embedded .ico
            //      so it doesn't fall back to the Tauri default glyph.
            #[cfg(desktop)]
            {
                if let Some(main_win) = app.get_webview_window("main") {
                    let icon = tauri::include_image!("icons/icon.png");
                    let _ = main_win.set_icon(icon);

                    #[cfg(target_os = "windows")]
                    {
                        if let Ok(hwnd) = main_win.hwnd() {
                            windows_integration::apply_window_icon_win32(hwnd.0 as isize);
                        } else {
                            runtime_log::warn("[boot] could not resolve hwnd for main window");
                        }
                    }
                } else {
                    runtime_log::warn("[boot] no webview window 'main' to set icon on");
                }
            }

            // 0a.3 System tray. The window-close handler (see bottom of
            //      this setup) hides the window instead of quitting if
            //      `close_to_tray` is on. The tray menu is the only way
            //      to fully exit when that mode is active.
            #[cfg(desktop)]
            build_tray(app.handle())?;

            // 0a.4 If launched by Windows autostart (--autostart flag),
            //      keep the window hidden so we just sit in the tray.
            let launched_hidden = std::env::args().any(|a| a == "--autostart");
            if launched_hidden {
                if let Some(main_win) = app.get_webview_window("main") {
                    let _ = main_win.hide();
                }
                runtime_log::info("[boot] launched via autostart — window hidden, tray-only");
            }


            // 0b. Logging — enabled only when RUST_LOG is set, so it's
            //     silent by default but can be flipped on for debug.
            let _ = env_logger::Builder::from_env(
                env_logger::Env::default().default_filter_or("warn"),
            )
            .try_init();

            // 0c. Install the rustls crypto provider before anything uses TLS.
            let _ = rustls::crypto::ring::default_provider().install_default();

            // 0d. Snapshot every IPv4 NIC so we can tell from the log
            //     whether local_ip resolved to the right one.
            runtime_log::log_network_interfaces();

            // 1. Identity + prefs + settings.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not get app data dir");
            let identity = identity::Identity::load_or_generate(&data_dir)
                .expect("failed to setup identity");
            let prefs = Arc::new(
                preferences::PreferencesStore::load_or_new(&data_dir)
                    .expect("failed to setup preferences"),
            );
            let manual = Arc::new(
                manual_peers::ManualPeerStore::load_or_new(&data_dir)
                    .expect("failed to setup manual peers"),
            );
            let alias_store = Arc::new(
                aliases::AliasStore::load_or_new(&data_dir)
                    .expect("failed to setup aliases"),
            );
            let clipboard_store = Arc::new(
                clipboard_sync::ClipboardSyncStore::load_or_new(&data_dir)
                    .expect("failed to setup clipboard sync"),
            );

            // Compute a sensible default for incoming files. Avoid the
            // Tauri path API here — calling desktop_dir() inside the
            // setup callback can stall on Windows because the shell
            // known-folder lookup runs before COM is fully ready.
            // Default download dir is platform-specific:
            //   - Windows/Linux/Mac: ~/Desktop (so received files land
            //     where the user can see them).
            //   - Android: app-scoped Download folder. The "public"
            //     `/storage/emulated/0/Download` path looks writable
            //     (Rust's create_dir_all returns Ok if it already
            //     exists) but scoped storage on Android 11+ rejects
            //     the actual file write later, which turned into a
            //     500 at receive time. The app-scoped folder
            //     `Android/data/<pkg>/files/Download` always works,
            //     no permissions needed, and Files app shows it. For
            //     images we additionally publish to Pictures/Millennium
            //     after the transfer completes (see http_server.rs).
            #[cfg(target_os = "android")]
            let default_download = app
                .path()
                .app_local_data_dir()
                .ok()
                .map(|p| p.join("Download"))
                .or_else(|| app.path().app_cache_dir().ok().map(|p| p.join("Download")))
                .unwrap_or_else(std::env::temp_dir);

            // Pre-create + check writability on Android. If the dir the
            // OS handed us isn't actually writable, fall back to a temp
            // dir so we don't blow up at receive time with a 500.
            #[cfg(target_os = "android")]
            let default_download = {
                let _ = std::fs::create_dir_all(&default_download);
                let probe = default_download.join(".write_probe");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    default_download
                } else {
                    runtime_log::warn(format!(
                        "[setup] default_download_dir {} not writable, falling back to temp",
                        default_download.display()
                    ));
                    std::env::temp_dir()
                }
            };

            #[cfg(not(target_os = "android"))]
            let default_download = std::env::var_os("USERPROFILE")
                .map(|p| PathBuf::from(p).join("Desktop"))
                .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Desktop")))
                .unwrap_or_else(std::env::temp_dir);

            runtime_log::info(format!(
                "[setup] default_download_dir = {}",
                default_download.display()
            ));
            let settings_store = Arc::new(
                settings::SettingsStore::load_or_default(&data_dir, default_download.clone())
                    .expect("failed to setup settings"),
            );
            runtime_log::info("[setup] settings loaded");

            // 0a.5 Heal stale autostart: the HKCU\...\Run entry keeps the
            //      exe path from whenever enable() last ran, so after an
            //      update it can point at a binary that no longer exists.
            //      With the pref on, disable()+enable() rewrites it to
            //      current_exe(); with the pref off, drop any ghost entry
            //      a previous version left behind.
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                if settings_store.loaded_from_corrupt() {
                    // settings.json didn't parse → start_with_windows is a
                    // fallback default, not the user's choice. Touching the
                    // Run entry now could wipe a working autostart, so skip.
                    runtime_log::warn(
                        "[autostart] settings unreadable — skipping heal to avoid clobbering the Run entry",
                    );
                } else {
                    let want_autostart = settings_store.snapshot().start_with_windows;
                    let manager = app.autolaunch();
                    if want_autostart {
                        let _ = manager.disable(); // best-effort: may not exist yet
                        if let Err(e) = manager.enable() {
                            runtime_log::err(format!("[autostart] re-register failed: {e}"));
                        } else {
                            runtime_log::info("[autostart] re-registered to current exe path");
                        }
                    } else if let Ok(true) = manager.is_enabled() {
                        let _ = manager.disable();
                        runtime_log::info("[autostart] removed stale entry (pref is off)");
                    }
                }
            }

            // Android migration: if the persisted download_dir (from
            // v0.13.0 or earlier) points at a path that's no longer
            // writable (e.g. /storage/emulated/0/Download/Millennium
            // under scoped storage), reset it to the safe default so
            // file receives don't fail with 500 at write time.
            #[cfg(target_os = "android")]
            {
                let current = settings_store.snapshot().download_dir;
                let _ = std::fs::create_dir_all(&current);
                let probe = current.join(".write_probe");
                if std::fs::write(&probe, b"ok").is_err() {
                    runtime_log::warn(format!(
                        "[setup] persisted download_dir {} not writable, reverting to {}",
                        current.display(),
                        default_download.display()
                    ));
                    let _ = settings_store.set_download_dir(default_download.clone());
                } else {
                    let _ = std::fs::remove_file(&probe);
                }
            }

            let icon_store = Arc::new(
                icon_overrides::IconOverrideStore::load_or_new(&data_dir)
                    .expect("failed to setup icon overrides"),
            );

            // Identity / network / store diagnostic dump.
            runtime_log::info(format!(
                "[diag] identity fp={} alias='{}' local_ip={}",
                &identity.fingerprint[..16.min(identity.fingerprint.len())],
                identity.alias,
                identity.local_ip
            ));
            let manual_snap = manual.snapshot();
            runtime_log::info(format!(
                "[diag] manual-peers count = {}",
                manual_snap.len()
            ));
            for m in &manual_snap {
                runtime_log::info(format!(
                    "[diag]   manual: fp={} alias='{}' {}:{}",
                    &m.fingerprint[..16.min(m.fingerprint.len())],
                    m.alias,
                    m.ip,
                    m.port
                ));
            }

            // 2. HTTPS server.
            let info = http_server::InfoResponse {
                alias: identity.alias.clone(),
                fingerprint: identity.fingerprint.clone(),
                hex_id: identity.hex_id.clone(),
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: "millennium/1".into(),
            };
            let cert_pem = identity.cert_pem.clone();
            let key_pem = identity.key_pem.clone();
            let server_app = app.handle().clone();
            let prefs_for_server = prefs.clone();
            let settings_for_server = settings_store.clone();
            let clipboard_for_server = clipboard_store.clone();

            // Port auto-fallback. If 53319 is already taken (another
            // instance, dev double-launch, OneDrive sync zombie) we try
            // 53320..53328. mDNS/UDP carry the actual port in their
            // payloads, so picking a different one is transparent to
            // remote peers.
            let requested_port = discovery::local_port();

            // The single-instance plugin + the zombie-kill we ran above
            // before Tauri started should mean port 53319 is free now.
            // Fallback below still tries 53319..53328 just in case.

            let server_port = http_server::find_free_tcp_port(requested_port, 10)
                .unwrap_or_else(|| {
                    runtime_log::err(format!(
                        "[setup] no free TCP port found in {}..{} — bind WILL fail",
                        requested_port,
                        requested_port + 10
                    ));
                    let _ = app.handle().emit(
                        "backend-error",
                        format!(
                            "No free TCP port in {}..{}. Close other Millennium instances and reopen.",
                            requested_port,
                            requested_port + 9
                        ),
                    );
                    requested_port
                });
            if server_port != requested_port {
                runtime_log::warn(format!(
                    "[setup] port {} was taken — using {} instead",
                    requested_port, server_port
                ));
            }
            runtime_log::log_startup_diagnostic(&identity.local_ip, server_port);
            runtime_log::info(format!(
                "[setup] spawning HTTPS server on 0.0.0.0:{}",
                server_port
            ));
            tauri::async_runtime::spawn(async move {
                let err_handle = server_app.clone();
                if let Err(e) = http_server::run(
                    server_app,
                    server_port,
                    info,
                    cert_pem,
                    key_pem,
                    prefs_for_server,
                    settings_for_server,
                    clipboard_for_server,
                )
                .await
                {
                    runtime_log::err(format!("[http] server error: {e:?}"));
                    let _ = err_handle.emit("backend-error", format!("HTTPS server failed: {e}"));
                }
            });

            // Self-ping the HTTPS server after a brief delay to confirm
            // it bound successfully. If this fails the user knows port
            // 53319 is unusable on this machine without having to read
            // stderr.
            let selfping_port = server_port;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                match tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    crate::http_client::fetch_info("127.0.0.1", selfping_port),
                )
                .await
                {
                    Ok(Ok(info)) => runtime_log::info(format!(
                        "[selfping] OK — local /info responded fp={} alias='{}'",
                        &info.fingerprint[..16.min(info.fingerprint.len())],
                        info.alias
                    )),
                    Ok(Err(e)) => runtime_log::err(format!(
                        "[selfping] FAILED — local /info errored: {e:?}"
                    )),
                    Err(_) => runtime_log::err(
                        "[selfping] FAILED — local /info timed out (server didn't bind?)",
                    ),
                }
            });

            // 3. mDNS discovery — announces with the *real* tcp port
            //    we ended up bound to.
            runtime_log::info("[setup] starting mDNS discovery...");
            let handle = app.handle().clone();
            let discovery_state = discovery::start(
                handle,
                &identity,
                server_port,
                prefs.clone(),
                manual.clone(),
                alias_store.clone(),
                clipboard_store.clone(),
                icon_store.clone(),
            )
            .expect("failed to start mDNS discovery");
            runtime_log::info("[setup] mDNS discovery started");

            // 4. UDP broadcast discovery — also carries the real tcp port.
            let udp_info = udp_discovery::LocalInfo {
                alias: identity.alias.clone(),
                fingerprint: identity.fingerprint.clone(),
                hex_id: identity.hex_id.clone(),
                tcp_port: server_port,
                local_ip: identity.local_ip.clone(),
            };
            udp_discovery::spawn(
                app.handle().clone(),
                udp_info,
                discovery_state.peers.clone(),
                prefs.clone(),
                manual.clone(),
                alias_store.clone(),
                clipboard_store.clone(),
                icon_store.clone(),
            );

            // 5. Clipboard-sync poller. Watches the OS clipboard on a
            //    dedicated thread (gated: only when peers opted in and
            //    the clipboard actually changed) and broadcasts to them.
            spawn_clipboard_poller(
                discovery_state.peers.clone(),
                clipboard_store.clone(),
                identity.alias.clone(),
                identity.fingerprint.clone(),
            );

            app.manage(AppState {
                discovery: discovery_state,
                identity,
                prefs,
                settings: settings_store,
                manual,
                aliases: alias_store,
                clipboard: clipboard_store,
                icons: icon_store,
                server_port,
            });

            // 6. Motor de displays (SPEC-displays, Fase 2). `.manage()` PROPIO y
            //    gateado, no un campo en `AppState`: así el `#[cfg]` vive en un
            //    solo lugar (ADR-005). El arranque es **no-fatal** — si el motor
            //    CCD no levanta, se anota y Millennium sigue andando sin la
            //    sección de monitores; el clipboard no depende de esto.
            #[cfg(target_os = "windows")]
            {
                match app.path().app_data_dir() {
                    Ok(data_dir) => {
                        // El emisor es el único punto donde el módulo de displays
                        // toca Tauri. Vive acá para que `src/displays/` quede
                        // libre de Tauri y se pueda type-checkear local.
                        let emisor_handle = app.handle().clone();
                        let emisor: displays::Emisor =
                            Box::new(move |nombre, payload| {
                                let _ = emisor_handle.emit(nombre, payload);
                            });
                        match displays::init(&data_dir, emisor) {
                            Ok(estado) => {
                                app.manage(estado.clone());
                                runtime_log::info("[displays] motor de monitores listo");

                                // Displays v2, Fase 1: registrar los atajos
                                // globales de perfil (si el interruptor general
                                // está prendido). Necesita el estado ya `manage`ado.
                                resync_profile_shortcuts(app.handle());

                                // Aplicar el perfil de arranque SOLO si se lanzó
                                // con --autostart (caso de Guido: dejó la TV
                                // prendida). Directo, sin la red, en un hilo propio
                                // y **no-fatal**: si falla, se loguea y la app sigue.
                                if launched_hidden {
                                    match estado.leer_ajustes() {
                                        Ok(ajustes) => {
                                            if let Some(nombre) = ajustes.startup_profile_name {
                                                let estado_startup = estado.clone();
                                                std::thread::spawn(move || {
                                                    match estado_startup.aplicar_perfil_directo(&nombre) {
                                                        Ok(()) => runtime_log::info(format!(
                                                            "[displays] perfil de arranque «{nombre}» aplicado"
                                                        )),
                                                        Err(e) => runtime_log::warn(format!(
                                                            "[displays] no se pudo aplicar el perfil de arranque «{nombre}»: {e}"
                                                        )),
                                                    }
                                                });
                                            }
                                        }
                                        Err(e) => runtime_log::warn(format!(
                                            "[displays] no se pudieron leer los ajustes para el perfil de arranque: {e}"
                                        )),
                                    }
                                }
                            }
                            Err(e) => runtime_log::warn(format!(
                                "[displays] el motor de monitores no arrancó: {e} — el resto de Millennium anda igual"
                            )),
                        }
                    }
                    Err(e) => runtime_log::warn(format!(
                        "[displays] sin carpeta de datos ({e}): el motor de monitores no arranca"
                    )),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::peers_cmds::get_local_info,
            app::peers_cmds::list_peers,
            app::peers_cmds::rescan_peers,
            app::clipboard_cmds::send_text,
            app::clipboard_cmds::send_files,
            app::clipboard_cmds::approve_session,
            app::clipboard_cmds::reject_session,
            app::clipboard_cmds::cancel_session,
            app::peers_cmds::toggle_favorite,
            app::settings_cmds::get_settings,
            app::settings_cmds::set_download_dir,
            app::settings_cmds::set_auto_accept_favorites,
            app::peers_cmds::add_peer_by_ip,
            app::peers_cmds::remove_manual_peer,
            app::peers_cmds::rename_peer,
            app::updater_cmds::check_for_update,
            app::updater_cmds::apply_update,
            app::clipboard_cmds::set_clipboard_sync,
            app::runtime_log_cmds::get_runtime_log,
            app::runtime_log_cmds::clear_runtime_log,
            app::runtime_log_cmds::set_log_panel_open,
            app::updater_cmds::take_update_failure,
            app::runtime_log_cmds::record_frontend_log,
            app::peers_cmds::set_peer_icon,
            app::peers_cmds::forget_peer,
            app::settings_cmds::set_notifications_enabled,
            app::settings_cmds::set_start_with_windows,
            app::settings_cmds::set_close_to_tray,
            app::peers_cmds::generate_pair_qr,
            app::peers_cmds::pair_with_qr_payload,
            app::clipboard_cmds::prepare_file_for_send,
            app::displays_cmds::displays_get_snapshot,
            app::displays_cmds::displays_toggle,
            app::displays_cmds::displays_confirm,
            app::displays_cmds::displays_revert,
            app::displays_cmds::displays_list_profiles,
            app::displays_cmds::displays_save_profile,
            app::displays_cmds::displays_load_profile,
            app::displays_cmds::displays_delete_profile,
            app::displays_cmds::displays_get_settings,
            app::displays_cmds::displays_update_settings,
            app::displays_cmds::displays_apply_layout,
            app::displays_cmds::displays_set_primary,
            app::displays_cmds::displays_set_profile_shortcut,
            app::displays_cmds::displays_clear_profile_shortcut,
            app::displays_cmds::displays_list_audio_outputs,
            app::displays_cmds::displays_set_profile_audio,
            app::displays_cmds::displays_clear_profile_audio,
            app::displays_cmds::displays_set_profile_actions,
            app::displays_cmds::displays_clear_profile_actions,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Read the current close_to_tray setting; if ON, hide
                // the window and keep the process alive in the tray.
                let state = window.app_handle().state::<AppState>();
                if state.settings.snapshot().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
