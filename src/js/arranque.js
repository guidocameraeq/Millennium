// Millennium Clipboard // GRID — frontend. Arranque: boot() y escuchas de eventos del backend.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  // ---------- Boot ----------------------------------------------------------
  async function boot() {
    // PANEL_OPEN lives in the backend process, which survives a webview
    // reload (F5 / tauri dev hot-reload). The log modal starts hidden, so
    // reset the flag to match — otherwise the backend keeps emitting a
    // log-line IPC event per line into a closed panel.
    invoke('set_log_panel_open', { open: false }).catch(() => {});
    try {
      const info = await invoke('get_local_info');
      window.__LOCAL_INFO = info;
      hudHost.textContent = info.alias;
      hudIp.textContent = `${info.ip}:${info.port}`;
      hudVersion.textContent = `v${info.version}`;
    } catch (err) {
      hudHost.textContent = 'ERR';
      setStatus(`ERR get_local_info · ${err}`);
      console.error(err);
      return;
    }

    try {
      const peers = await invoke('list_peers');
      applyPeers(peers, /* initial = */ true);
    } catch (err) {
      setStatus(`ERR list_peers · ${err}`);
      console.error(err);
    }

    // Live updates from the mDNS daemon (Fase 3+)
    await listen('peers-changed', (event) => {
      applyPeers(event.payload, /* initial = */ false);
    });

    // Backend failures (HTTPS server bind, etc.) — surface a big
    // persistent banner over the peer list so this can't be missed.
    await listen('backend-error', (event) => {
      const msg = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
      showBackendBanner('error', msg);
      setStatus(`BACKEND ERR · ${msg}`);
      console.error('[backend-error]', event.payload);
    });


    // Live runtime log lines — append into the in-page buffer so when
    // the user opens the LOG modal they see everything that happened.
    await listen('log-line', (event) => {
      if (typeof event.payload === 'string') {
        appendLogLine(event.payload);
      }
    });

    // System tray menu actions. The tray itself is built in Rust; the
    // menu items emit a `tray-action` event with a string payload so
    // we can react from the same place the in-app buttons do.
    await listen('tray-action', async (event) => {
      const action = event.payload;
      if (action === 'log') {
        openLogModal();
      } else if (action === 'send') {
        // Focus the peer list — user picks a peer manually for now.
        setStatus('Pick a peer to send to.');
      } else if (action === 'toggle-clipboard') {
        // Best-effort: flip clipboard sync for every peer that already has it.
        const onPeers = (state.peers || []).filter((p) => p.clipboardSync);
        if (onPeers.length === 0) {
          setStatus('No peer has clipboard sync enabled.');
        } else {
          for (const p of onPeers) {
            try {
              await invoke('set_clipboard_sync', { peerId: p.id, enabled: false });
            } catch (_) {}
          }
          setStatus(`Clipboard sync disabled for ${onPeers.length} peer(s).`);
        }
      }
    });

    // Incoming text from a peer (Fase 5)
    await listen('incoming-text', (event) => {
      const { text, senderAlias, senderFingerprint, senderIp, senderPort } = event.payload;
      showIncomingText(text, senderAlias, senderFingerprint, senderIp, senderPort);
      blip(1320, 0.12);
      setTimeout(() => blip(1760, 0.1), 130);
      const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
      notify(`✉ Text from ${senderAlias}`, preview);
    });

    // Incoming file transfer request — show modal (Fase 7)
    await listen('incoming-files-request', (event) => {
      const payload = event.payload;
      if (payload.autoAccepted) {
        setStatus(`RX · auto-accepting ${payload.fileCount} file(s) from ${payload.senderAlias}`);
        notify(
          `⇣ ${payload.senderAlias} — ${payload.fileCount} file(s)`,
          `${formatBytes(payload.totalSize)} · auto-accepted (favorite)`
        );
        return;
      }
      openIncomingModal(payload);
      notify(
        `? ${payload.senderAlias} wants to send ${payload.fileCount} file(s)`,
        `${formatBytes(payload.totalSize)} · waiting for your decision`
      );
    });

    await listen('incoming-files-timeout', () => {
      closeIncomingModal();
      setStatus('RX · timed out (no decision in 60 s)');
    });

    await listen('incoming-files-approved', () => {
      setStatus('RX · accepted, receiving...');
    });

    // Progress events (Fase 7)
    await listen('transfer-progress-sender', (event) => {
      const { bytesSent, total } = event.payload;
      if (total > 0) {
        const pct = Math.min(99, Math.round((bytesSent / total) * 100));
        setProgress(pct);
        progressText.textContent = `TRANSMITTING // ${formatBytes(bytesSent)} / ${formatBytes(total)}`;
      }
    });

    await listen('transfer-progress-receiver', (event) => {
      const { bytesReceived, total, sessionId } = event.payload;
      if (!total || total <= 0) return;
      // Key RX by session so a concurrent send (which drives the TX bar) can't
      // make the two flows fight over one bar.
      if (!state.activeReceive || state.activeReceive.sessionId !== sessionId) {
        state.activeReceive = { sessionId };
      }
      const pct = Math.min(99, Math.round((bytesReceived / total) * 100));
      setRxProgress(pct);
      rxProgressBlock.hidden = false;
      rxProgressText.textContent = `RECEIVING // ${formatBytes(bytesReceived)} / ${formatBytes(total)}`;
      // Info + no TTL barrier: routine RX progress, must keep updating and
      // must not block errors from showing.
      setStatus(`RX · ${formatBytes(bytesReceived)} received`, { priority: 'info', ttl: 0 });
    });

    await listen('file-completed', (event) => {
      const { name, verified } = event.payload;
      if (!verified) {
        setStatus(`WARN · ${name} hash mismatch`);
      }
    });

    await listen('session-completed', (event) => {
      const { senderAlias, fileCount, totalSize, destinationDir } = event.payload;
      // This is a RECEIVER event — clear the RX bar, never the TX bar.
      rxProgressBlock.hidden = true;
      setRxProgress(0);
      state.activeReceive = null;
      // On Android the backend publishes the final file to /Downloads/
      // via MediaStore (see http_server.rs), so the user-visible
      // location is "Downloads" regardless of the app-scoped staging
      // path that came in the event.
      const isAndroid = /android/i.test(navigator.userAgent);
      const visibleLocation = isAndroid ? 'Downloads (open from Files / Gallery)' : destinationDir;
      setStatus(`RX OK · ${fileCount} file(s) from ${senderAlias} saved`);
      showToast(`${senderAlias} → ${fileCount} FILE(S) · ${formatBytes(totalSize)} · saved to ${visibleLocation}`);
      blip(1760, 0.12);
      setTimeout(() => blip(2200, 0.16), 130);
      notify(
        `✓ ${fileCount} file(s) received from ${senderAlias}`,
        `${formatBytes(totalSize)} saved to ${visibleLocation}`
      );
    });

    await listen('session-cancelled', () => {
      // Receiver-side cancel — clear the RX bar, leave the TX bar alone.
      rxProgressBlock.hidden = true;
      setRxProgress(0);
      state.activeReceive = null;
      setStatus('Transfer cancelled.');
    });

    // Clipboard sync is desktop-only. On Android we skip both the
    // notify and the status update so the feature is invisible to
    // mobile users (it's also gated by mutual-consent so peers can't
    // actually push to us if no toggle was ever flipped, which on
    // Android can't even be flipped because the UI hides it).
    const _clipboardIsAndroid = /android/i.test(navigator.userAgent);
    await listen('clipboard-received', (event) => {
      if (_clipboardIsAndroid) return;
      const { senderAlias, text } = event.payload;
      const preview = text.length > 40 ? text.slice(0, 40) + '...' : text;
      setStatus(`📋 ${senderAlias} → clipboard: ${preview}`);
      blip(880, 0.06);
      notify(`📋 Clipboard from ${senderAlias}`, preview);
    });
    await listen('clipboard-image-received', (event) => {
      if (_clipboardIsAndroid) return;
      const { senderAlias, width, height } = event.payload;
      setStatus(`🖼 ${senderAlias} → image clipboard: ${width}×${height}`);
      blip(1320, 0.06);
      notify(`🖼 Image clipboard from ${senderAlias}`, `${width}×${height} ready to paste`);
    });

    // Monitores. La topologia cambio: puede ser un attach/detach nuestro o un
    // cable que alguien movio. Se relee SOLO con la sección Displays a la vista —
    // en Clipboard el snapshot no lo mira nadie (la enumeración no corre sola).
    await listen('displays-changed', () => {
      if (state.section === 'displays') loadDisplays();
    });

    // Displays v2, Fase 3: aviso puntual del audio por perfil. La salida asignada
    // no estaba presente (TV apagada) o falló el cambio; el video se aplicó igual.
    await listen('displays-audio', (event) => {
      const payload = event.payload || {};
      const device = typeof payload.device === 'string' ? payload.device : '';
      if (payload.kind === 'unavailable') {
        setStatus(`DISPLAYS · la salida "${device}" no está (¿TV apagada?); el audio no se cambió`,
          { priority: 'warn', ttl: 8000 });
      } else if (payload.kind === 'error') {
        setStatus(`DISPLAYS · no se pudo cambiar el audio a "${device}"`,
          { priority: 'warn', ttl: 8000 });
      }
    });

    // Ciclo de confirmacion. El reloj es del backend; esto solo lo dibuja. El
    // banner del pending es global: se refresca siempre; loadDisplays (la lista)
    // solo si la sección está a la vista.
    await listen('displays-confirmation', (event) => {
      const payload = event.payload || {};
      const displaysVisible = state.section === 'displays';
      if (payload.kind === 'applied') {
        const ms = Number(payload.timeoutMs);
        startDisplaysCountdown(Number.isFinite(ms) && ms > 0 ? ms : 10000);
        refreshDisplaysUi();
        setStatus('DISPLAYS · confirmá el cambio o vuelve solo', { priority: 'warn', ttl: 12000 });
      } else if (payload.kind === 'confirmed') {
        clearDisplaysPending();
        refreshDisplaysUi();
        if (displaysVisible) loadDisplays();
        setStatus('DISPLAYS · cambio confirmado', { force: true });
      } else if (payload.kind === 'reverted') {
        clearDisplaysPending();
        refreshDisplaysUi();
        if (displaysVisible) loadDisplays();
        // El "por que" importa: revertir a mano y quedarse sin confirmar a
        // tiempo se ven identicos en pantalla, y no son lo mismo.
        const why = payload.reason === 'timeout' ? 'nadie confirmó a tiempo'
          : payload.reason === 'error' ? 'el cambio falló'
          : 'lo revertiste vos';
        setStatus(`DISPLAYS · volvió atrás (${why})`, { priority: 'warn', ttl: 8000 });
      }
    });

    // Preload settings (used by transmit + settings modal)
    try {
      state.settings = await invoke('get_settings');
    } catch (err) {
      console.error('settings load:', err);
    }

    // Surface a previous failed auto-update swap. Pull model (not a pushed
    // event): the backend holds the marker until we ask for it here, once the
    // UI is ready, so a slow webview can never miss the notice.
    try {
      const upErr = await invoke('take_update_failure');
      if (upErr) showBackendBanner('error', upErr);
    } catch (_) {}

    setTimeout(() => {
      if (statusMsg.textContent.startsWith('GRID ONLINE')
          || statusMsg.textContent.startsWith('GRID · waiting')) {
        setStatus('SYS READY · awaiting input');
      }
    }, 2200);
  }

  // Backend is the source of truth for `favorite` (Fase 6 persistence).
  function applyPeers(wirePeers, initial) {
    // Normalize status at ingestion so no downstream consumer has to defend
    // against a missing/unknown status. The backend only ever emits
    // "online"/"offline"; anything else maps to "offline" (never dropped).
    const VALID_STATUS = new Set(['online', 'offline']);
    state.peers = wirePeers.map((p) => {
      const status = VALID_STATUS.has(p.status) ? p.status : 'offline';
      return { ...p, status };
    });

    // The selected peer vanished from the snapshot: DO NOT silently re-point
    // to another peer (you could end up transmitting a secret to the wrong
    // one). Surface TARGET LOST and make the user re-select consciously.
    if (state.selectedPeerId && !state.peers.find((p) => p.id === state.selectedPeerId)) {
      state.selectedPeerId = null;
      state.targetLost = true;
      setText(targetName, 'TARGET LOST');
      setText(targetHex, '—');
      if (sendBtn) sendBtn.disabled = true;
      setStatus('TARGET LOST · peer went offline. Pick another.', { priority: 'warn', ttl: 6000 });
    }

    // Render the list ALWAYS so it stays in sync with state.peers.
    renderPeers();

    // Auto-select the first peer ONLY on the initial load — never on later
    // snapshots, and never right after losing the target.
    if (initial && !state.selectedPeerId && !state.targetLost && state.peers.length > 0) {
      // Auto-select the first peer VISIBLE under the active filter (the UI starts
      // on FAVORITES), not blindly peers[0] — otherwise it can lock onto a peer
      // that isn't shown. Mirrors renderPeers' filter predicate exactly.
      const firstVisible = state.peers.find((p) =>
        state.filter === 'favorites' ? p.favorite : p.status !== 'offline'
      );
      if (firstVisible) {
        state.selectedPeerId = firstVisible.id;
        selectPeer(state.selectedPeerId);
      }
    }

    if (state.peers.length === 0) {
      setStatus('GRID · waiting for peers...');
    } else if (initial) {
      setStatus(`GRID ONLINE · ${state.peers.length} peer(s) detected.`);
    } else {
      setStatus(`GRID · ${state.peers.length} peer(s) online.`);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
