//! Comandos de identidad y peers: info local, listado, favoritos, emparejar por QR, IP manual, alias e iconos.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

use crate::{AppState, LocalInfo, discovery, http_client, manual_peers, preferences, runtime_log};
use serde::Deserialize;

#[tauri::command]
pub(crate) fn get_local_info(state: tauri::State<AppState>) -> LocalInfo {
    let id = &state.identity;
    LocalInfo {
        alias: id.alias.clone(),
        host_id_hex: id.hex_id.clone(),
        // Live IP (updated on a network roam), not the boot-time one.
        ip: state.discovery.current_local_ip(),
        port: state.server_port,
        fingerprint: id.fingerprint.clone(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

#[tauri::command]
pub(crate) fn list_peers(state: tauri::State<AppState>) -> Vec<discovery::WirePeer> {
    state.discovery.peers_for_wire()
}

#[tauri::command]
pub(crate) fn rescan_peers(state: tauri::State<AppState>) -> Result<Vec<discovery::WirePeer>, String> {
    discovery::rebrowse(&state.discovery).map_err(|e| e.to_string())?;
    // Also kick the probe scheduler so absent manual/favorite peers get
    // re-probed now instead of waiting out their backoff (up to 5 min).
    state.discovery.wake_probes();
    Ok(state.discovery.peers_for_wire())
}

#[tauri::command]
pub(crate) fn toggle_favorite(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
    value: bool,
) -> Result<(), String> {
    if value {
        let fav = state
            .discovery
            .favorite_from_peer(&peer_id)
            .ok_or_else(|| format!("peer {} is not on the grid right now", &peer_id[..8]))?;
        state.prefs.add_favorite(fav).map_err(|e| format!("{e:#}"))?;
    } else {
        state.prefs.remove_favorite(&peer_id).map_err(|e| format!("{e:#}"))?;
    }
    runtime_log::info(format!("[backend] toggle_favorite → peer={} value={}", peer_id, value));
    state.discovery.emit_snapshot(&app);
    Ok(())
}

/// Build the JSON payload we encode into the QR. Kept minimal so the
/// QR can stay scannable at small sizes:
///   { v: 1, fp: "<full fingerprint>", alias, hex, ip, port }
fn build_pair_payload(state: &AppState) -> String {
    let id = &state.identity;
    serde_json::json!({
        "v": 1,
        "type": "millennium-pair",
        "fp": id.fingerprint,
        "alias": id.alias,
        "hex": id.hex_id,
        // Live IP (updated on a network roam), not the boot-time one, so a
        // freshly scanned QR points the phone at the address we're on now.
        "ip": state.discovery.current_local_ip(),
        "port": state.server_port,
    })
    .to_string()
}

#[tauri::command]
pub(crate) fn generate_pair_qr(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;

    let payload = build_pair_payload(&state);
    let code = QrCode::new(payload.as_bytes()).map_err(|e| format!("qr build: {e}"))?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(320, 320)
        .dark_color(svg::Color("#00f0ff"))
        .light_color(svg::Color("#050a14"))
        .quiet_zone(true)
        .build();
    Ok(serde_json::json!({
        "svg": svg,
        "payload": build_pair_payload(&state),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairPayload {
    #[serde(default)]
    v: u32,
    #[serde(default, rename = "type")]
    msg_type: String,
    fp: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    hex: String,
    ip: String,
    port: u16,
}

#[tauri::command]
pub(crate) async fn pair_with_qr_payload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: String,
) -> Result<String, String> {
    let parsed: PairPayload = serde_json::from_str(payload.trim())
        .map_err(|e| format!("not a valid Millennium QR payload: {e}"))?;
    if parsed.msg_type != "millennium-pair" || parsed.v != 1 {
        return Err("QR doesn't look like a Millennium pair payload".into());
    }
    if parsed.fp == state.identity.fingerprint {
        return Err("That's our own QR — scan one from another peer.".into());
    }

    // Reuse the manual-peer path: probe first, then save with the real
    // fingerprint returned by /info. This mirrors add_peer_by_ip.
    let info = http_client::fetch_info(&parsed.ip, parsed.port)
        .await
        .map_err(|e| format!("probe {}:{}: {e:#}", parsed.ip, parsed.port))?;
    if info.fingerprint != parsed.fp {
        return Err(format!(
            "QR claimed fp {} but {}:{} answered with {} — refusing to pair",
            &parsed.fp[..16.min(parsed.fp.len())],
            parsed.ip,
            parsed.port,
            &info.fingerprint[..16.min(info.fingerprint.len())]
        ));
    }

    let manual = manual_peers::ManualPeer {
        fingerprint: info.fingerprint.clone(),
        alias: if parsed.alias.is_empty() { info.alias.clone() } else { parsed.alias.clone() },
        hex_id: if parsed.hex.is_empty() { info.hex_id.clone() } else { parsed.hex.clone() },
        icon_type: "desktop".to_string(),
        ip: parsed.ip.clone(),
        port: parsed.port,
    };
    state
        .manual
        .add(manual.clone())
        .map_err(|e| format!("save manual: {e:#}"))?;

    // Also mark favorite so the new peer is immediately visible in the
    // default FAVORITES filter.
    let fav = preferences::FavoritePeer {
        fingerprint: info.fingerprint.clone(),
        alias: manual.alias.clone(),
        hex_id: manual.hex_id.clone(),
        icon_type: manual.icon_type.clone(),
        last_ip: parsed.ip.clone(),
        last_port: parsed.port,
    };
    let _ = state.prefs.add_favorite(fav);

    state.discovery.emit_snapshot(&app);
    Ok(format!("Paired with {} ({}:{})", manual.alias, parsed.ip, parsed.port))
}

#[tauri::command]
pub(crate) async fn add_peer_by_ip(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ip: String,
    port: Option<u16>,
) -> Result<manual_peers::ManualPeer, String> {
    let port = port.unwrap_or(discovery::DEFAULT_PORT);
    let info = http_client::fetch_info(&ip, port)
        .await
        .map_err(|e| format!("could not reach {}:{} — {e:#}", ip, port))?;

    if info.fingerprint == state.identity.fingerprint {
        return Err("that's your own machine".into());
    }

    let icon_type = if info.protocol.contains("phone") || info.protocol.contains("mobile") {
        "phone".to_string()
    } else {
        "desktop".to_string()
    };
    let peer = manual_peers::ManualPeer {
        fingerprint: info.fingerprint.clone(),
        alias: info.alias,
        hex_id: info.hex_id,
        icon_type,
        ip,
        port,
    };
    state.manual.add(peer.clone()).map_err(|e| format!("{e:#}"))?;
    state.discovery.emit_snapshot(&app);
    runtime_log::info(format!(
        "[backend] add_peer_by_ip → {} {}:{}",
        peer.alias, peer.ip, peer.port
    ));
    Ok(peer)
}

#[tauri::command]
pub(crate) fn remove_manual_peer(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
) -> Result<(), String> {
    state.manual.remove(&peer_id).map_err(|e| format!("{e:#}"))?;
    // Also drop it from the live peer cache so the offline ghost
    // disappears without waiting for the reaper.
    state.discovery.peers.lock().unwrap().remove(&peer_id);
    state.discovery.emit_snapshot(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn rename_peer(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        state.aliases.clear(&peer_id).map_err(|e| format!("{e:#}"))?;
    } else {
        state
            .aliases
            .set(peer_id, trimmed.to_string())
            .map_err(|e| format!("{e:#}"))?;
    }
    state.discovery.emit_snapshot(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn set_peer_icon(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
    icon: String,
) -> Result<(), String> {
    if icon.trim().is_empty() {
        state.icons.clear(&peer_id).map_err(|e| format!("{e:#}"))?;
    } else {
        state
            .icons
            .set(peer_id, icon.trim().to_string())
            .map_err(|e| format!("{e:#}"))?;
    }
    state.discovery.emit_snapshot(&app);
    Ok(())
}

/// Wipe every trace of a peer from local state: live cache, manual
/// entry, favorite flag, alias override, icon override, clipboard-sync
/// setting. The peer will reappear in ALL if mDNS/UDP see it again,
/// but with default name, default icon, no flags.
#[tauri::command]
pub(crate) fn forget_peer(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    peer_id: String,
) -> Result<(), String> {
    runtime_log::info(format!(
        "[forget] wiping all state for peer {}",
        &peer_id[..16.min(peer_id.len())]
    ));
    state.discovery.peers.lock().unwrap().remove(&peer_id);
    let _ = state.manual.remove(&peer_id);
    let _ = state.prefs.remove_favorite(&peer_id);
    let _ = state.aliases.clear(&peer_id);
    let _ = state.icons.clear(&peer_id);
    let _ = state.clipboard.set(peer_id.clone(), false);
    state.discovery.emit_snapshot(&app);
    Ok(())
}
