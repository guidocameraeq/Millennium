// Millennium Clipboard // GRID — frontend. Clipboard (2/2): detalle de peer, ajustes y alta de peer por IP.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  // ---------- Peer details modal -------------------------------------------
  function openPeerDetails(peer) {
    peerDetailsCurrentId = peer.id;
    peerDetailsTitle.textContent = `◈ ${peer.name}`;
    peerDetailsName.value = peer.name;
    peerDetailsFp.textContent = peer.id.slice(0, 32) + '…';
    peerDetailsFp.title = peer.id;
    peerDetailsAddr.textContent = `${peer.ip || '?'}:${peer.port}`;
    setText(peerDetailsStatus, peer.status === 'online' ? '● ONLINE' : '○ OFFLINE');

    // Tags row: MANUAL · OFFLINE FAVORITE · etc. (the stuff we removed
    // from the card so it doesn't clutter the small layout.)
    const tagsList = [];
    if (peer.manual) tagsList.push('MANUAL');
    if (peer.favorite && peer.status === 'offline') tagsList.push('OFFLINE FAVORITE');
    const tagsEl = document.getElementById('peer-details-tags');
    if (tagsEl) {
      if (tagsList.length) {
        tagsEl.textContent = tagsList.join(' · ');
        tagsEl.hidden = false;
      } else {
        tagsEl.hidden = true;
      }
    }

    // Render the big current icon + the 6-picker.
    const bigIcon = document.getElementById('peer-details-icon-current');
    if (bigIcon) bigIcon.innerHTML = iconSvg(peer.iconType);
    const picker = document.getElementById('peer-details-icon-picker');
    if (picker) {
      picker.innerHTML = ICON_KEYS.map((key) => `
        <button class="icon-pick ${key === peer.iconType ? 'active' : ''}" data-icon="${key}" title="${ICON_LABELS[key]}">
          ${ICON_SVG[key]}
        </button>
      `).join('');
    }

    peerDetailsFav.checked = !!peer.favorite;
    peerDetailsFavLabel.textContent = peer.favorite ? 'ON' : 'OFF';
    peerDetailsClip.checked = !!peer.clipboardSync;
    peerDetailsClipLabel.textContent = peer.clipboardSync ? 'ON' : 'OFF';

    // Forget button is always visible now (used to be only for manuals).
    peerDetailsRemove.hidden = false;
    peerDetailsRemove.textContent = '🗑 FORGET PEER';

    peerDetailsModal.hidden = false;
    focusFirstControl(peerDetailsModal);
  }

  function closePeerDetailsModal() {
    peerDetailsModal.hidden = true;
    peerDetailsCurrentId = null;
  }

  peerDetailsCloseBtn.addEventListener('click', closePeerDetailsModal);
  peerDetailsModal.addEventListener('click', (e) => {
    if (e.target === peerDetailsModal) closePeerDetailsModal();
  });

  async function submitDetailsName() {
    if (!peerDetailsCurrentId) return;
    const peer = state.peers.find((p) => p.id === peerDetailsCurrentId);
    if (!peer) return;
    const newName = peerDetailsName.value.trim();
    if (newName === peer.name) return;
    try {
      await invoke('rename_peer', { peerId: peer.id, newName });
      blip(1100, 0.05);
    } catch (err) {
      peerDetailsName.value = peer.name;
      setStatus(`ERR rename · ${err}`);
    }
  }
  peerDetailsName.addEventListener('blur', submitDetailsName);
  peerDetailsName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); peerDetailsName.blur(); }
  });

  peerDetailsFav.addEventListener('change', async () => {
    if (!peerDetailsCurrentId) return;
    const value = peerDetailsFav.checked;
    try {
      await invoke('toggle_favorite', { peerId: peerDetailsCurrentId, value });
      peerDetailsFavLabel.textContent = value ? 'ON' : 'OFF';
      blip(value ? 1320 : 440, 0.05);
    } catch (err) {
      peerDetailsFav.checked = !value;
      setStatus(`ERR fav · ${err}`);
    }
  });

  peerDetailsClip.addEventListener('change', async () => {
    if (!peerDetailsCurrentId) return;
    const enabled = peerDetailsClip.checked;
    try {
      await invoke('set_clipboard_sync', { peerId: peerDetailsCurrentId, enabled });
      peerDetailsClipLabel.textContent = enabled ? 'ON' : 'OFF';
      blip(enabled ? 1320 : 440, 0.05);
    } catch (err) {
      peerDetailsClip.checked = !enabled;
      setStatus(`ERR clipboard · ${err}`);
    }
  });

  peerDetailsRemove.addEventListener('click', async () => {
    if (!peerDetailsCurrentId) return;
    const peer = state.peers.find((p) => p.id === peerDetailsCurrentId);
    if (!peer) return;
    const ok = confirm(
      `Forget peer "${peer.name}"?\n\n` +
      'This clears:\n' +
      '  • manual entry (if any)\n' +
      '  • favorite flag\n' +
      '  • custom name\n' +
      '  • custom icon\n' +
      '  • clipboard sync setting\n' +
      '  • live cache\n\n' +
      'The peer will reappear in ALL if seen on the network again.'
    );
    if (!ok) return;
    try {
      await invoke('forget_peer', { peerId: peer.id });
      blip(440, 0.08);
      setStatus(`Forgot ${peer.name}`);
      closePeerDetailsModal();
    } catch (err) {
      setStatus(`ERR forget · ${err}`);
    }
  });

  // Icon picker — delegated click handler on the picker container.
  document.addEventListener('click', async (e) => {
    const pick = e.target.closest('#peer-details-icon-picker .icon-pick');
    if (!pick || !peerDetailsCurrentId) return;
    const icon = pick.dataset.icon;
    if (!icon) return;
    try {
      await invoke('set_peer_icon', { peerId: peerDetailsCurrentId, icon });
      // Visual update: mark this one active, others inactive.
      pick.parentElement.querySelectorAll('.icon-pick').forEach((b) => {
        b.classList.toggle('active', b === pick);
      });
      // Update the big preview too.
      const bigIcon = document.getElementById('peer-details-icon-current');
      if (bigIcon) bigIcon.innerHTML = iconSvg(icon);
      blip(880, 0.04);
    } catch (err) {
      setStatus(`ERR icon · ${err}`);
    }
  });
  appSettingsModal.addEventListener('click', (e) => {
    if (e.target === appSettingsModal) closeAppSettingsModal();
  });
  clipboardSettingsModal.addEventListener('click', (e) => {
    if (e.target === clipboardSettingsModal) closeClipboardSettingsModal();
  });
  incomingModal.addEventListener('click', (e) => {
    if (e.target === incomingModal) {
      // Treat click-outside on incoming as a reject (safer default).
      if (state.pendingIncoming) {
        const sid = state.pendingIncoming.sessionId;
        closeIncomingModal();
        invoke('reject_session', { sessionId: sid }).catch(() => {});
      }
    }
  });

  settingsPickDir.addEventListener('click', async () => {
    if (!dialog || !dialog.open) return;
    try {
      const result = await dialog.open({ directory: true, multiple: false });
      if (!result) return;
      await invoke('set_download_dir', { path: result });
      state.settings.downloadDir = result;
      settingsDownloadDir.textContent = result;
      blip(1100, 0.06);
    } catch (err) {
      setStatus(`ERR change dir · ${err}`);
    }
  });

  settingsCheckUpdate.addEventListener('click', async () => {
    settingsCheckUpdate.disabled = true;
    settingsCheckUpdate.textContent = '◷ ...';
    settingsUpdateAction.hidden = true;
    try {
      const info = await invoke('check_for_update');
      updateInfoCache = info;
      settingsUpdateStatus.textContent = `current v${info.currentVersion} · latest v${info.latestVersion}`;
      if (info.hasUpdate && info.downloadUrl) {
        settingsUpdateBanner.textContent = `Update available: v${info.latestVersion}`;
        settingsUpdateAction.hidden = false;
        blip(1320, 0.06);
      } else if (info.hasUpdate) {
        settingsUpdateBanner.textContent = `New version available, no portable asset found.`;
        settingsUpdateAction.hidden = false;
        settingsApplyUpdate.disabled = true;
      } else {
        settingsUpdateBanner.textContent = '';
        blip(660, 0.05);
      }
    } catch (err) {
      settingsUpdateStatus.textContent = `ERR · ${err}`;
    } finally {
      settingsCheckUpdate.disabled = false;
      settingsCheckUpdate.textContent = '▸ CHECK FOR UPDATE';
    }
  });

  settingsApplyUpdate.addEventListener('click', async () => {
    if (!updateInfoCache || !updateInfoCache.downloadUrl) return;
    const isAndroid = /android/i.test(navigator.userAgent);
    const promptMsg = isAndroid
      ? `Download v${updateInfoCache.latestVersion} and open the installer?`
      : `Download v${updateInfoCache.latestVersion} and restart the app?`;
    const ok = confirm(promptMsg);
    if (!ok) return;
    settingsApplyUpdate.disabled = true;
    settingsApplyUpdate.textContent = '◷ DOWNLOADING...';
    try {
      const result = await invoke('apply_update', {
        downloadUrl: updateInfoCache.downloadUrl,
        // Integrity check: the backend aborts if this is missing/mismatched.
        expectedSha256: updateInfoCache.downloadSha256 || null,
      });
      // On Windows the app exits before we get here. On Android the
      // command returns the public Downloads URI where the APK was
      // published via MediaStore. We don't try to launch the system
      // installer programmatically anymore — every variant of
      // plugin-opener we tried (3 shapes across 2 releases) hit the
      // same OpenArgs deserialization bug. Instead we tell the user
      // exactly where the APK landed and let them tap it from
      // Files / the download-complete notification Android shows
      // for MediaStore inserts.
      if (isAndroid && result && typeof result === 'string') {
        settingsApplyUpdate.textContent = '✓ DOWNLOADED — OPEN IT FROM FILES';
        settingsUpdateBanner.textContent = `APK saved to your Downloads folder. Open it from the Files app (or the download notification) and tap "Install".`;
        setStatus('APK downloaded — open it from Files / Downloads to install.');
        // Also fire a system notification so the user has a quick
        // tap-target even if they navigated away from Settings.
        notify('⬆ Update ready', 'Open Downloads to install the new APK.');
      }
    } catch (err) {
      settingsApplyUpdate.textContent = `ERR · ${err}`;
    }
  });

  settingsAutoAccept.addEventListener('change', async () => {
    const value = settingsAutoAccept.checked;
    try {
      await invoke('set_auto_accept_favorites', { value });
      state.settings.autoAcceptFavorites = value;
      settingsAutoAcceptLabel.textContent = value ? 'ON' : 'OFF';
      blip(value ? 1320 : 440, 0.06);
    } catch (err) {
      settingsAutoAccept.checked = !value;
      setStatus(`ERR toggle · ${err}`);
    }
  });

  if (settingsNotifications) {
    settingsNotifications.addEventListener('change', async () => {
      const value = settingsNotifications.checked;
      try {
        await invoke('set_notifications_enabled', { value });
        if (state.settings) state.settings.notificationsEnabled = value;
        settingsNotificationsLabel.textContent = value ? 'ON' : 'OFF';
        blip(value ? 1320 : 440, 0.06);
        if (value) notify('🔔 Notifications enabled', 'Millennium will now toast on activity.');
      } catch (err) {
        settingsNotifications.checked = !value;
        setStatus(`ERR notif · ${err}`);
      }
    });
  }

  if (settingsAutostart) {
    settingsAutostart.addEventListener('change', async () => {
      const value = settingsAutostart.checked;
      try {
        await invoke('set_start_with_windows', { value });
        if (state.settings) state.settings.startWithWindows = value;
        settingsAutostartLabel.textContent = value ? 'ON' : 'OFF';
        blip(value ? 1320 : 440, 0.06);
      } catch (err) {
        settingsAutostart.checked = !value;
        setStatus(`ERR autostart · ${err}`);
      }
    });
  }

  if (settingsFx) {
    settingsFx.addEventListener('change', () => {
      const fxOn = settingsFx.checked;
      document.documentElement.classList.toggle('fx-off', !fxOn);
      try { localStorage.setItem('fx', fxOn ? 'on' : 'off'); } catch (_) {}
      settingsFxLabel.textContent = fxOn ? 'ON' : 'OFF';
      if (!fxOn) {
        stopPh();
      } else if (!textarea.value && document.activeElement !== textarea) {
        phIdx = 0;
        typePh(placeholderLines[0]);
      }
      blip(fxOn ? 1320 : 440, 0.06);
    });
  }

  if (settingsCloseTray) {
    settingsCloseTray.addEventListener('change', async () => {
      const value = settingsCloseTray.checked;
      try {
        await invoke('set_close_to_tray', { value });
        if (state.settings) state.settings.closeToTray = value;
        settingsCloseTrayLabel.textContent = value ? 'ON' : 'OFF';
        blip(value ? 1320 : 440, 0.06);
      } catch (err) {
        settingsCloseTray.checked = !value;
        setStatus(`ERR close-tray · ${err}`);
      }
    });
  }


  // ---------- Add peer by IP (Fase 8) --------------------------------------
  function openAddPeerModal() {
    addPeerError.hidden = true;
    addPeerError.textContent = '';
    addPeerIp.value = '';
    addPeerPort.value = '53319';
    addPeerSubmit.disabled = false;
    addPeerSubmit.textContent = '▸ REGISTER';
    addPeerModal.hidden = false;
    focusFirstControl(addPeerModal);
    setTimeout(() => addPeerIp.focus(), 0);
  }

  function closeAddPeerModal() {
    addPeerModal.hidden = true;
  }

  addPeerBtn.addEventListener('click', () => {
    blip(880, 0.06);
    openAddPeerModal();
  });

  addPeerModal.addEventListener('click', (e) => {
    if (e.target === addPeerModal) closeAddPeerModal();
  });

  // CANCEL button — was an inline onclick in index.html; wired here now that
  // a strict CSP (Fase 3, Tarea 3.2) blocks inline handlers. The other two
  // modal-close buttons (settings-close, peer-details-close) already had
  // addEventListener handlers, so only this one needed wiring.
  const addPeerCancelBtn = document.getElementById('add-peer-cancel');
  if (addPeerCancelBtn) addPeerCancelBtn.addEventListener('click', closeAddPeerModal);

  const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  async function submitAddPeer() {
    const ip = addPeerIp.value.trim();
    const port = parseInt(addPeerPort.value, 10) || 53319;
    addPeerError.hidden = true;
    addPeerError.textContent = '';
    if (!IPV4_RE.test(ip)) {
      addPeerError.textContent = 'INVALID IP — use IPv4 (eg 192.168.1.42)';
      addPeerError.hidden = false;
      return;
    }
    if (port < 1 || port > 65535) {
      addPeerError.textContent = 'INVALID PORT';
      addPeerError.hidden = false;
      return;
    }
    addPeerSubmit.disabled = true;
    addPeerSubmit.textContent = '◷ PROBING...';
    try {
      const peer = await invoke('add_peer_by_ip', { ip, port });
      blip(1760, 0.1);
      setTimeout(() => blip(2200, 0.12), 130);
      setStatus(`OK · registered ${peer.alias} (${peer.hexId})`);
      closeAddPeerModal();
    } catch (err) {
      addPeerError.textContent = String(err).toUpperCase();
      addPeerError.hidden = false;
      addPeerSubmit.disabled = false;
      addPeerSubmit.textContent = '▸ RETRY';
      blip(220, 0.15);
    }
  }

  addPeerSubmit.addEventListener('click', submitAddPeer);
  addPeerIp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAddPeer(); });
  addPeerPort.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAddPeer(); });
