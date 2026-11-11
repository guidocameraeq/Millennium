//! Comandos de envío: texto y archivos, sesiones de transferencia, resolución de rutas y sync del portapapeles por peer.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::{AppState, http_client, http_server, log_format, runtime_log, thumbnails};
#[cfg(target_os = "android")]
use crate::android_fs_bridge;
use uuid::Uuid;
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn send_text(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let target = state
        .discovery
        .peers
        .lock()
        .unwrap()
        .get(&peer_id)
        .cloned()
        .ok_or_else(|| format!("peer {} not on the grid", peer_id))?;

    runtime_log::info(log_format::send_text_line(
        &target.name,
        &target.ip,
        target.port,
        text.chars().count(),
    ));

    // No pre-send /info probe anymore: the TLS handshake is pinned to
    // peer_id (Fase 3, Tarea 3.1), so post_text only completes if the cert
    // at (ip, port) hashes to the expected fingerprint. The old probe ran on
    // a DIFFERENT socket than the payload, so a MITM could pass it and then
    // serve from another cert — the pin closes that window.
    http_client::post_text(
        &target.ip,
        target.port,
        text,
        state.identity.alias.clone(),
        state.identity.fingerprint.clone(),
        state.server_port,
        &peer_id,
    )
    .await
    .map_err(|e| {
        runtime_log::err(log_format::send_failed_line(
            "text",
            &target.name,
            &target.ip,
            target.port,
            &format!("{e:#}"),
        ));
        format!("send failed: {e:#}")
    })?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn send_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    peer_id: String,
    file_paths: Vec<String>,
) -> Result<String, String> {
    if file_paths.is_empty() {
        return Err("no files to send".into());
    }

    let target = state
        .discovery
        .peers
        .lock()
        .unwrap()
        .get(&peer_id)
        .cloned()
        .ok_or_else(|| format!("peer {} not on the grid", peer_id))?;

    // Identity is enforced at the TLS layer now: prepare_upload/upload_file
    // are pinned to peer_id (Fase 3, Tarea 3.1). The old /info cross-check
    // ran on a separate socket and was spoofable — dropped.

    // Gather metadata for each file.
    let session_id = Uuid::new_v4().simple().to_string();
    let mut prepare_files: Vec<http_client::PrepareFile> = Vec::new();
    let mut upload_plan: Vec<(String, PathBuf, u64)> = Vec::new();

    for path_str in &file_paths {
        let p = PathBuf::from(path_str);
        let meta = tokio::fs::metadata(&p)
            .await
            .map_err(|e| format!("stat {}: {}", p.display(), e))?;
        if !meta.is_file() {
            return Err(format!(
                "{} is not a regular file (folder transfer arrives later)",
                p.display()
            ));
        }
        let size = meta.len();
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("invalid file name: {}", p.display()))?;
        let mime = mime_guess::from_path(&p)
            .first()
            .map(|m| m.essence_str().to_string());
        let file_id = Uuid::new_v4().simple().to_string();
        // Best-effort thumbnail. Failures (corrupt image, unsupported
        // format, oversize) just produce None and the receiver shows a
        // generic icon — never blocks the transfer.
        let thumbnail = thumbnails::generate_for(&p, size).unwrap_or(None);
        prepare_files.push(http_client::PrepareFile {
            file_id: file_id.clone(),
            name: name.clone(),
            size,
            mime,
            sha256: None, // MVP: skip hashing big files; add in Fase 8 polish
            rel_path: None,
            thumbnail,
        });
        upload_plan.push((file_id, p, size));
    }

    runtime_log::info(log_format::send_files_line(
        &target.name,
        &target.ip,
        target.port,
        upload_plan.len(),
        &session_id,
    ));

    // Ask the peer; this blocks until the user accepts/rejects/times out.
    let prep = http_client::prepare_upload(
        &target.ip,
        target.port,
        &session_id,
        &state.identity.alias,
        &state.identity.fingerprint,
        state.server_port,
        &prepare_files,
        &peer_id,
    )
    .await
    .map_err(|e| {
        runtime_log::err(log_format::send_failed_line(
            "prepare",
            &target.name,
            &target.ip,
            target.port,
            &format!("{e:#}"),
        ));
        format!("prepare: {e:#}")
    })?;

    // Upload each file (sequential; same Client → keep-alive).
    for (file_id, path, size) in &upload_plan {
        let token = prep
            .files
            .get(file_id)
            .ok_or_else(|| format!("no token for {}", &file_id[..8]))?;
        http_client::upload_file(
            app.clone(),
            &target.ip,
            target.port,
            &session_id,
            file_id,
            token,
            path,
            *size,
            &peer_id,
        )
        .await
        .map_err(|e| {
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?");
            runtime_log::err(log_format::send_failed_line(
                &format!("upload {}", file_name),
                &target.name,
                &target.ip,
                target.port,
                &format!("{e:#}"),
            ));
            format!(
                "upload {}: {}",
                path.display(),
                log_format::redact_query(&format!("{e:#}"))
            )
        })?;
    }

    Ok(session_id)
}

#[tauri::command]
pub(crate) fn approve_session(session_id: String) -> Result<(), String> {
    if http_server::resolve_approval(&session_id, true) {
        Ok(())
    } else {
        Err("no pending session with that id".into())
    }
}

#[tauri::command]
pub(crate) fn reject_session(session_id: String) -> Result<(), String> {
    if http_server::resolve_approval(&session_id, false) {
        Ok(())
    } else {
        Err("no pending session with that id".into())
    }
}

#[tauri::command]
pub(crate) async fn cancel_session(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    session_id: String,
) -> Result<(), String> {
    let target = state
        .discovery
        .peers
        .lock()
        .unwrap()
        .get(&peer_id)
        .cloned()
        .ok_or_else(|| format!("peer {} not on the grid", peer_id))?;
    http_client::cancel_upload(&target.ip, target.port, &session_id, &peer_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn set_clipboard_sync(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .clipboard
        .set(peer_id.clone(), enabled)
        .map_err(|e| format!("{e:#}"))?;
    runtime_log::info(format!("[backend] set_clipboard_sync → peer={} enabled={}", peer_id, enabled));
    state.discovery.emit_snapshot(&app);
    Ok(())
}

/// Resolve a (possibly Android `content://`) path string to something
/// `tokio::fs::File::open` can read. On non-Android targets and on
/// Android paths that already look like filesystem paths, this is a
/// passthrough.
#[tauri::command]
pub(crate) async fn prepare_file_for_send(
    #[allow(unused_variables)] app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        if path.starts_with("content://") {
            let resolved = android_fs_bridge::resolve_content_uri(&app, path).await?;
            return Ok(resolved.to_string_lossy().to_string());
        }
    }
    Ok(path)
}
