//! Poller del portapapeles: vigila el portapapeles del sistema y reparte los cambios a los peers con sync prendido.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::{clipboard_sync, discovery, runtime_log};
#[cfg(not(target_os = "android"))]
use crate::{http_client, net_ifaces, udp_discovery};
use std::sync::Arc;

#[cfg(not(target_os = "android"))]
enum ClipSnapshot {
    Text(String),
    Image { png_base64: String },
}

#[cfg(target_os = "android")]
pub(crate) fn spawn_clipboard_poller(
    _peers: discovery::PeerMap,
    _store: Arc<clipboard_sync::ClipboardSyncStore>,
    _my_alias: String,
    _my_fingerprint: String,
) {
    // Android: clipboard polling in background is restricted by the
    // OS since Android 10. We'll wire this up via tauri-plugin-clipboard-manager
    // in a later iteration when the foreground service lands.
    runtime_log::info("[clipboard] poller disabled on Android (handled by foreground service later)");
}

// Windows increments this global u32 on every clipboard change, so
// reading it is the cheapest possible "did anything change?" gate.
// Declared by hand instead of pulling the whole `windows` crate in.
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetClipboardSequenceNumber() -> u32;
}

#[cfg(not(target_os = "android"))]
fn is_syncable_text(t: &str) -> bool {
    !t.is_empty() && t.len() <= 1_000_000
}

#[cfg(not(target_os = "android"))]
enum PollOutcome {
    /// Fresh, syncable content ready to fan out to peers.
    Send(ClipSnapshot),
    /// The clipboard was read fine but there's nothing to send (echo,
    /// unchanged, oversize, or non-syncable content like copied files).
    Handled,
    /// The clipboard was momentarily locked by another process — leave
    /// the change unconsumed so the next tick retries instead of losing it.
    ReadFailed,
}

/// Read the OS clipboard once and decide what to do. Only touches the
/// clipboard; the caller owns the sequence-number gate and the fan-out.
#[cfg(not(target_os = "android"))]
fn poll_clipboard_once(
    cb: &mut arboard::Clipboard,
    last_text: &mut Option<String>,
    last_image_hash: &mut Option<String>,
    store: &clipboard_sync::ClipboardSyncStore,
) -> PollOutcome {
    let text_res = cb.get_text();
    if let Ok(text) = &text_res {
        if !text.is_empty() {
            if last_text.as_deref() == Some(text.as_str()) {
                return PollOutcome::Handled;
            }
            *last_text = Some(text.clone());
            if !is_syncable_text(text) {
                // BUG FIX: oversize text is dropped explicitly instead of
                // falling through to the image branch.
                runtime_log::warn(format!(
                    "[clipboard] text too large ({} bytes) — skipped",
                    text.len()
                ));
                return PollOutcome::Handled;
            }
            *last_image_hash = None;
            let hash = clipboard_sync::hash_text(text);
            if store.is_recent(&hash) {
                return PollOutcome::Handled;
            }
            store.note_synced(hash);
            return PollOutcome::Send(ClipSnapshot::Text(text.clone()));
        }
    }

    let img_res = cb.get_image();
    let img_occupied = matches!(&img_res, Err(arboard::Error::ClipboardOccupied));
    if let Ok(img) = img_res {
        let w = img.width as u32;
        let h = img.height as u32;
        if w == 0 || h == 0 || w > 8192 || h > 8192 {
            return PollOutcome::Handled;
        }
        // GATE 3: hash the raw RGBA — same image as last tick means no
        // PNG encode at all.
        let raw_hash = clipboard_sync::hash_bytes(&img.bytes);
        if last_image_hash.as_deref() == Some(raw_hash.as_str()) {
            return PollOutcome::Handled;
        }
        *last_image_hash = Some(raw_hash);
        *last_text = None;

        let raw: Vec<u8> = img.bytes.into_owned();
        let buf = match image::RgbaImage::from_raw(w, h, raw) {
            Some(b) => b,
            None => return PollOutcome::Handled,
        };
        let mut png_bytes: Vec<u8> = Vec::with_capacity(256 * 1024);
        {
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            if image::DynamicImage::ImageRgba8(buf)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .is_err()
            {
                return PollOutcome::Handled;
            }
        }
        if png_bytes.len() > 32 * 1024 * 1024 {
            return PollOutcome::Handled;
        }
        // The anti-echo store keys off the PNG hash: it must match what
        // the /clipboard/image receive path notes (hash of the PNG
        // bytes). The RGBA hash above is only the local "don't re-encode"
        // gate.
        let png_hash = clipboard_sync::hash_bytes(&png_bytes);
        if store.is_recent(&png_hash) {
            return PollOutcome::Handled;
        }
        store.note_synced(png_hash);
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let png_base64 = B64.encode(&png_bytes);
        return PollOutcome::Send(ClipSnapshot::Image { png_base64 });
    }

    // Neither text nor image gave us content. A transient clipboard lock
    // must be retried (ReadFailed); genuinely non-syncable content
    // (copied files, exotic formats) is just seen and dropped (Handled).
    let text_occupied = matches!(&text_res, Err(arboard::Error::ClipboardOccupied));
    if text_occupied || img_occupied {
        PollOutcome::ReadFailed
    } else {
        PollOutcome::Handled
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn spawn_clipboard_poller(
    peers: discovery::PeerMap,
    store: Arc<clipboard_sync::ClipboardSyncStore>,
    my_alias: String,
    my_fingerprint: String,
) {
    // The blocking thread hands over snapshots that already passed every
    // gate (peers enabled, changed, not an echo); the async side only
    // fans them out to peers.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ClipSnapshot>(4);

    // ---- Dedicated thread: owns ONE arboard::Clipboard for its whole
    //      life. arboard handles must not cross an .await, so this stays
    //      a std::thread, never a tokio task.
    std::thread::spawn({
        let store = store.clone();
        move || {
            let mut cb = match arboard::Clipboard::new() {
                Ok(c) => c,
                Err(e) => {
                    runtime_log::err(format!("[clipboard] arboard init failed: {e}"));
                    return;
                }
            };
            let mut last_text: Option<String> = None;
            let mut last_image_hash: Option<String> = None;
            // Prime the sequence number with whatever is already on the
            // clipboard so content copied BEFORE the app launched isn't
            // sent the moment a peer is enabled.
            #[cfg(target_os = "windows")]
            let mut last_seq: u32 = unsafe { GetClipboardSequenceNumber() };

            loop {
                std::thread::sleep(std::time::Duration::from_millis(1200));

                let has_peers = !store.enabled_snapshot().is_empty();

                // GATE 2 (Windows): clipboard unchanged since last tick →
                // zero reads, zero encodes. Read the seq up front but only
                // CONSUME it once we've actually handled the change (below).
                #[cfg(target_os = "windows")]
                let seq = unsafe { GetClipboardSequenceNumber() };
                #[cfg(target_os = "windows")]
                if seq == last_seq {
                    continue;
                }

                // GATE 1: nobody opted into sync → don't read the
                // clipboard. But mark this change as seen so content
                // copied while sync was OFF isn't retroactively sent when
                // the user later enables a peer.
                if !has_peers {
                    #[cfg(target_os = "windows")]
                    {
                        last_seq = seq;
                    }
                    continue;
                }

                match poll_clipboard_once(&mut cb, &mut last_text, &mut last_image_hash, &store)
                {
                    PollOutcome::Send(snap) => {
                        #[cfg(target_os = "windows")]
                        {
                            last_seq = seq;
                        }
                        if tx.blocking_send(snap).is_err() {
                            return; // runtime gone — app is shutting down
                        }
                    }
                    PollOutcome::Handled => {
                        #[cfg(target_os = "windows")]
                        {
                            last_seq = seq;
                        }
                    }
                    // Transient lock: don't consume the seq — retry next tick.
                    PollOutcome::ReadFailed => {}
                }
            }
        }
    });

    // ---- Async side: fan each snapshot out to the opted-in peers.
    tauri::async_runtime::spawn(async move {
        while let Some(snap) = rx.recv().await {
            // (receiver_fp, ip, port). The enabled set holds the fingerprints
            // of the peers we sync with — i.e. the RECEIVERS — so we carry
            // each one to pin the TLS handshake to the right destination
            // (Fase 3, Tarea 3.1).
            let targets: Vec<(String, String, u16)> = {
                let enabled = store.enabled_snapshot();
                if enabled.is_empty() {
                    Vec::new()
                } else {
                    // A favorite kept past the TTL (offline) stays in the map
                    // but is not a sync target.
                    let ttl = udp_discovery::BROADCAST_INTERVAL_SECS.saturating_mul(3);
                    let p = peers.lock().unwrap();
                    enabled
                        .into_iter()
                        .filter(|fp| fp != &my_fingerprint)
                        .filter_map(|fp| {
                            p.get(&fp)
                                .filter(|r| {
                                    net_ifaces::receives_clipboard_sync(
                                        r.last_seen.elapsed().as_secs(),
                                        ttl,
                                    )
                                })
                                .map(|r| (fp.clone(), r.ip.clone(), r.port))
                        })
                        .collect()
                }
            };
            if targets.is_empty() {
                continue;
            }

            for (receiver_fp, ip, port) in targets {
                let alias = my_alias.clone();
                let fp = my_fingerprint.clone(); // sender's own fp (goes in the payload)
                match &snap {
                    ClipSnapshot::Text(t) => {
                        let text = t.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                http_client::post_clipboard(&ip, port, &text, &alias, &fp, &receiver_fp).await
                            {
                                runtime_log::warn(format!(
                                    "[clipboard] text sync to {}:{} failed: {:#}",
                                    ip, port, e
                                ));
                            }
                        });
                    }
                    ClipSnapshot::Image { png_base64 } => {
                        let b64 = png_base64.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = http_client::post_clipboard_image(
                                &ip, port, &b64, &alias, &fp, &receiver_fp,
                            )
                            .await
                            {
                                runtime_log::warn(format!(
                                    "[clipboard] image sync to {}:{} failed: {:#}",
                                    ip, port, e
                                ));
                            }
                        });
                    }
                }
            }
        }
    });
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversize_text() {
        assert!(!is_syncable_text(&"x".repeat(1_000_001)));
        assert!(is_syncable_text("hola"));
        assert!(!is_syncable_text(""));
    }
}
