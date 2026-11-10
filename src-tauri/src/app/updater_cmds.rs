//! Comandos del auto-update: buscar versión, bajarla/instalarla y avisar si el reemplazo falló.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::updater;
#[cfg(target_os = "windows")]
use crate::runtime_log;
#[cfg(target_os = "android")]
use crate::android_fs_bridge;
#[cfg(target_os = "android")]
use tauri::Manager;

#[tauri::command]
pub(crate) async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    updater::check_for_update().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn apply_update(
    app: tauri::AppHandle,
    download_url: String,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        updater::download_and_stage(&download_url, expected_sha256.as_deref())
            .await
            .map_err(|e| format!("{e:#}"))?;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        app.exit(0);
        Ok(String::new())
    }
    #[cfg(target_os = "android")]
    {
        // Stage the APK directly into the user's public Downloads
        // folder via MediaStore (tauri-plugin-android-fs). The system
        // package installer can't be reliably launched from Tauri 2
        // on Android — every plugin-opener variant we tried hit the
        // OpenArgs deserialization bug — so we make the manual path
        // a pleasant one: the APK lands in /Downloads/, the user
        // taps it from Files / their notifications, Android shows
        // its standard "Install app?" dialog.
        // First download to a temp blob, then publish via MediaStore.
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("resolve cache dir: {e}"))?;
        let staged = updater::download_and_stage_apk(&download_url, &cache_dir, expected_sha256.as_deref())
            .await
            .map_err(|e| format!("{e:#}"))?;
        let bytes = tokio::fs::read(&staged)
            .await
            .map_err(|e| format!("read staged apk: {e}"))?;
        // Best-effort cleanup of the cache copy (the public URI is
        // what we care about going forward).
        let _ = tokio::fs::remove_file(&staged).await;
        let filename = format!(
            "Millennium Clipboard v{}.apk",
            updater::version_for_filename(&download_url)
        );
        let uri = android_fs_bridge::save_to_public_downloads(
            &app,
            &filename,
            &bytes,
            Some("application/vnd.android.package-archive"),
        )
        .await
        .map_err(|e| format!("publish apk to Downloads: {e}"))?;
        // Return the public URI so the frontend can show it.
        Ok(uri)
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = (app, download_url);
        Err("auto-update not supported on this platform".to_string())
    }
}

/// Consume the "previous update swap failed" marker written by the update
/// batch (updater.rs) when it couldn't replace the running exe after all
/// retries. Returns the message ONCE, then deletes the marker so it shows
/// exactly one time. The frontend calls this at boot AFTER its UI is ready,
/// so a slow/late webview can never lose the notice to an early emit.
#[tauri::command]
pub(crate) fn take_update_failure() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let marker = std::env::temp_dir().join("millennium-update-failed.txt");
        if marker.exists() {
            let detail = std::fs::read_to_string(&marker).unwrap_or_default();
            let _ = std::fs::remove_file(&marker);
            runtime_log::err(format!(
                "[updater] previous update swap failed: {}",
                detail.trim()
            ));
            return Some(
                "Update failed: the new version could not replace the running app (the file was locked). Please retry the update."
                    .to_string(),
            );
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}
