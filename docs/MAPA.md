# MAPA — Millennium

> Cómo se conecta, en una pantalla (tope 5.000 bytes). La arquitectura a fondo vive en `docs/remediation/00-SHARED-CONTEXT.md` (Clipboard) y `docs/DECISIONS.md` (Displays); acá se apunta.

## Por dentro
Un frontend (`src/`: `index.html` + `main.js` + `styles.css`, switch CLIP | DISP) habla por IPC de Tauri con `src-tauri/src/lib.rs`, que arma las dos apps:

```mermaid
flowchart LR
  UI[[Frontend src/ · CLIP | DISP]] -- IPC Tauri --> LIB[[lib.rs · comandos + AppState]]
  subgraph Clipboard
    DISC[[discovery · udp_discovery · manual_peers]]
    SRV[[http_server · axum + rustls]]
    CLI[[http_client · pooled + resume]]
    CLIP[[clipboard_sync · thumbnails]]
    ID[[identity · cert + fingerprint]]
  end
  subgraph Displays_Windows
    DSP[[displays/mod.rs]] --> ENUM[[enumerate · topology]]
    DSP --> APPLY[[apply · watchdog auto-revert]]
    DSP --> AUD[[audio · acciones de escena]]
    DSP --> EVT[[system_events · WM_DISPLAYCHANGE]]
    APPLY --> MON[(vendor/monarch · motor CCD)]
  end
  LIB --> DISC & SRV & CLI & CLIP & ID
  LIB --> DSP
  LIB --> STORE[(json_store · settings · preferences · aliases · icon_overrides · displays/store)]
  LIB --> UPD[[updater · GitHub releases]]
  SRV <-- HTTPS LAN --> PEER((otros peers Millennium))
```

- Los datos del usuario (favoritos, alias, iconos, ajustes, perfiles de Displays) son JSON en `%APPDATA%` (Roaming) — restricción dura #1 del `CLAUDE.md`.
- Android: el mismo Rust tras `#[cfg(target_os = "android")]` + `android_fs_bridge` y el proyecto a mano en `src-tauri/gen/android/`. Displays no existe ahí.

## Con otras apps

| App | Qué comparte | Quién escribe |
|---|---|---|
| Peers Millennium / MillenniumClipboard en la LAN | Protocolo: hello UDP, mDNS, JSON de `/info`, endpoints HTTPS | Cada app escribe lo suyo; **no romper el formato** (peers viejos) |
| Repo `guidocameraeq/MillenniumClipboard` | El núcleo de clipboard por historia de git (sembrado desde `5ffdfca`), no código vivo | Cada repo, por separado |
| GitHub Releases de `guidocameraeq/Millennium` | El `.exe` + digest que baja el updater | El CI (`.github/workflows/`) |
| Hub `../` | ADRs del ecosistema (p. ej. ADR-003 de la partición) | Sesiones del hub |
