// Millennium Clipboard // GRID — frontend. Clipboard: peers, filtros, modos, envío, modales de entrada/ajustes/log/QR. Ojo: acá viven también reportToBackend (errores de JS al log del backend) y el manejador de .hud-btn, que atiende acciones de Displays.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  // ---------- Peer rendering -----------------------------------------------
  // Millennium Items — each peer-card icon is one of the 7 Items of the
  // Millennium (Yu-Gi-Oh!). The Puzzle is reserved for the app itself.
  // We keep the original semantic keys (desktop/laptop/phone/...) so peers
  // running older clients still announce a valid icon_type; we just paint
  // them with the Millennium Item visuals.
  const peerIconImg = (key, file, alt) =>
    `<img src="assets/peer-icons/${file}" alt="${alt}" class="peer-item-img" data-icon-key="${key}" />`;
  const ICON_SVG = {
    desktop: peerIconImg('desktop', 'eye.png',   'Millennium Eye'),
    laptop:  peerIconImg('laptop',  'ring.png',  'Millennium Ring'),
    phone:   peerIconImg('phone',   'rod.png',   'Millennium Rod'),
    tablet:  peerIconImg('tablet',  'tauk.png',  'Millennium Tauk'),
    server:  peerIconImg('server',  'key.png',   'Millennium Key'),
    gaming:  peerIconImg('gaming',  'scale.png', 'Millennium Scale'),
    media:   peerIconImg('media',   'tauk.png',  'Millennium Tauk'),
  };
  // Safe lookup: iconType comes from a peer (mDNS TXT / UDP hello, un-
  // validated), so NEVER interpolate it into HTML. This returns a trusted
  // local icon string for a known key, else the desktop default — and uses
  // hasOwnProperty so a key like "constructor"/"__proto__" can't reach a
  // prototype value.
  function iconSvg(key) {
    return Object.prototype.hasOwnProperty.call(ICON_SVG, key)
      ? ICON_SVG[key]
      : ICON_SVG.desktop;
  }
  const ICON_KEYS = ['desktop', 'laptop', 'phone', 'server', 'gaming', 'media'];
  const ICON_LABELS = {
    desktop: 'EYE',
    laptop:  'RING',
    phone:   'ROD',
    server:  'KEY',
    gaming:  'SCALE',
    media:   'TAUK',
  };

  function renderPeers() {
    const filtered = state.peers.filter((p) => {
      if (state.filter === 'favorites') return p.favorite;
      return p.status !== 'offline';
    });

    const onlineCount = state.peers.filter((p) => p.status !== 'offline').length;

    // Empty / placeholder states use a full wipe — fine, they don't flap
    // because there's nothing to keep alive.
    if (state.peers.length === 0 || filtered.length === 0) {
      peerList.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'peer-empty';
      if (state.peers.length === 0) {
        li.innerHTML = '— SCANNING NETWORK —<br><small style="opacity:0.6;letter-spacing:1px;font-size:9px">peers appear within seconds</small>';
      } else if (state.filter === 'favorites') {
        li.innerHTML = '— NO FAVORITES YET —<br><small style="opacity:0.6;letter-spacing:1px;font-size:9px">switch to ALL and click ★ to add one</small>';
      } else {
        li.innerHTML = '— NO PEERS ONLINE —<br><small style="opacity:0.6;letter-spacing:1px;font-size:9px">waiting on the grid</small>';
      }
      peerList.appendChild(li);
    } else {
      // Incremental diff: reuse existing <li> nodes by data-id so the
      // peer rows don't visibly flicker every time the backend pushes
      // a peers-changed snapshot (which can be every 5s from UDP).
      const empty = peerList.querySelector('.peer-empty');
      if (empty) empty.remove();

      const existing = new Map();
      Array.from(peerList.querySelectorAll('li.peer-item')).forEach((li) => {
        if (li.dataset.id) existing.set(li.dataset.id, li);
      });

      const seen = new Set();
      filtered.forEach((p, idx) => {
        seen.add(p.id);
        // Guard each row so one malformed peer can't tumble the whole list
        // (the forEach would otherwise abort and freeze the grid). Next
        // snapshot retries the skipped row.
        try {
          let li = existing.get(p.id);
          if (li) {
            updatePeerItem(li, p);
          } else {
            li = buildPeerItem(p);
          }
          if (peerList.children[idx] !== li) {
            peerList.insertBefore(li, peerList.children[idx] || null);
          }
        } catch (err) {
          console.error('renderPeers: peer render failed', p && p.id, err);
        }
      });

      existing.forEach((li, id) => {
        if (!seen.has(id)) li.remove();
      });
    }

    const favCount = state.peers.filter((p) => p.favorite).length;
    setText(peerCount, String(filtered.length).padStart(2, '0'));
    setText(statusPeers, String(onlineCount).padStart(2, '0'));
    setText(statusFav, String(favCount).padStart(2, '0'));
    setText(filterHint, `${String(filtered.length).padStart(2, '0')} visible`);
  }

  function updatePeerItem(li, p) {
    li.classList.toggle('selected', p.id === state.selectedPeerId);
    li.dataset.status = p.status;
    li.dataset.manual = p.manual ? 'true' : 'false';

    // Don't clobber an in-progress inline rename (only the name is held;
    // status/ip/hex/icons/toggles below still refresh).
    if (li.dataset.renaming !== 'true') {
      setText(li.querySelector('.peer-name'), p.name);
    }
    setText(li.querySelector('.peer-hex'), p.hexId);
    setText(li.querySelector('.peer-ip'), p.ip);

    const iconWrap = li.querySelector('.peer-icon');
    if (iconWrap && iconWrap.dataset.icon !== p.iconType) {
      iconWrap.innerHTML = iconSvg(p.iconType);
      iconWrap.dataset.icon = p.iconType;
    }

    const favBtn = li.querySelector('.fav-toggle');
    if (favBtn) {
      favBtn.classList.toggle('active', !!p.favorite);
      favBtn.setAttribute('aria-pressed', p.favorite ? 'true' : 'false');
    }
    const clipBtn = li.querySelector('.clip-toggle');
    if (clipBtn) {
      clipBtn.classList.toggle('active', !!p.clipboardSync);
      clipBtn.setAttribute('aria-pressed', p.clipboardSync ? 'true' : 'false');
    }

    const statusEl = li.querySelector('.peer-status');
    if (statusEl) {
      // 'reaching' is never emitted by the backend; 'away' has stale CSS we
      // clear defensively. Only 'online'/'offline' are real.
      statusEl.classList.remove('online', 'offline', 'away');
      statusEl.classList.add(p.status);
    }
    const statusLabel = li.querySelector('.status-label');
    if (statusLabel) statusLabel.textContent = String(p.status || 'offline').toUpperCase();
  }

  function buildPeerItem(p) {
    const li = document.createElement('li');
    li.className = 'peer-item';
    if (p.id === state.selectedPeerId) li.classList.add('selected');
    li.dataset.id = p.id;
    li.dataset.status = p.status;
    li.dataset.manual = p.manual ? 'true' : 'false';

    li.innerHTML = `
      <div class="peer-icon"></div>
      <div class="peer-info">
        <div class="peer-name-row">
          <span class="peer-name" title="Double-click to rename"></span>
          <button class="peer-action-btn details-btn" title="Peer details">⋯</button>
        </div>
        <div class="peer-meta">
          <span class="peer-hex mono"></span>
          <span class="peer-ip mono"></span>
        </div>
        <div class="peer-status-row">
          <div class="peer-status">
            <span class="status-dot"></span><span class="status-label"></span>
          </div>
          <div class="peer-toggles">
            <button class="peer-toggle fav-toggle" title="Toggle favorite" aria-pressed="false">★</button>
            <button class="peer-toggle clip-toggle" title="Toggle clipboard sync" aria-pressed="false">📋</button>
          </div>
        </div>
      </div>
    `;

    // Icon: trusted local SVG chosen by a SAFE lookup; data-icon set via
    // dataset (does NOT parse HTML) so a malicious iconType can't inject.
    const iconWrap = li.querySelector('.peer-icon');
    if (iconWrap) {
      iconWrap.innerHTML = iconSvg(p.iconType);
      iconWrap.dataset.icon = p.iconType;
    }

    setText(li.querySelector('.peer-name'), p.name);
    setText(li.querySelector('.peer-hex'), p.hexId);
    setText(li.querySelector('.peer-ip'), p.ip);

    const favBtn = li.querySelector('.fav-toggle');
    if (p.favorite) {
      favBtn.classList.add('active');
      favBtn.setAttribute('aria-pressed', 'true');
    }
    const clipBtn = li.querySelector('.clip-toggle');
    if (p.clipboardSync) {
      clipBtn.classList.add('active');
      clipBtn.setAttribute('aria-pressed', 'true');
    }

    const statusEl = li.querySelector('.peer-status');
    if (statusEl) statusEl.classList.add(p.status);
    const statusLabel = li.querySelector('.status-label');
    if (statusLabel) statusLabel.textContent = String(p.status || 'offline').toUpperCase();

    return li;
  }

  function selectPeer(id) {
    const peer = state.peers.find((p) => p.id === id);
    if (!peer) return;
    state.selectedPeerId = id;
    state.targetLost = false; // conscious re-selection clears the lost state
    setText(targetName, peer.name);
    setText(targetHex, peer.hexId);
    const isOffline = peer.status === 'offline';
    if (sendBtn) sendBtn.disabled = isOffline;
    setStatus(isOffline
      ? `PEER OFFLINE · ${peer.name} (waiting on grid)`
      : `PEER LOCKED · ${peer.name}`, { force: true });
    blip(660, 0.06);
    document.querySelectorAll('.peer-item').forEach((el) => {
      el.classList.toggle('selected', el.dataset.id === id);
    });
  }

  // ---------- Peer list events (delegated) ---------------------------------
  peerList.addEventListener('click', async (e) => {
    const detailsBtn = e.target.closest('.details-btn');
    if (detailsBtn) {
      e.stopPropagation();
      const item = detailsBtn.closest('.peer-item');
      const id = item?.dataset.id;
      if (!id) return;
      const peer = state.peers.find((p) => p.id === id);
      if (peer) openPeerDetails(peer);
      return;
    }
    const favBtn = e.target.closest('.fav-toggle');
    if (favBtn) {
      e.stopPropagation();
      const item = favBtn.closest('.peer-item');
      const id = item?.dataset.id;
      if (!id) return;
      const peer = state.peers.find((p) => p.id === id);
      const newVal = !(peer && peer.favorite);
      try {
        await invoke('toggle_favorite', { peerId: id, value: newVal });
        blip(newVal ? 1320 : 660, 0.06);
      } catch (err) {
        setStatus(`ERR favorite · ${err}`, { priority: 'err' });
      }
      return;
    }
    const clipBtn = e.target.closest('.clip-toggle');
    if (clipBtn) {
      e.stopPropagation();
      const item = clipBtn.closest('.peer-item');
      const id = item?.dataset.id;
      if (!id) return;
      const peer = state.peers.find((p) => p.id === id);
      const newVal = !(peer && peer.clipboardSync);
      try {
        await invoke('set_clipboard_sync', { peerId: id, enabled: newVal });
        blip(newVal ? 1760 : 880, 0.06);
      } catch (err) {
        setStatus(`ERR clipboard sync · ${err}`, { priority: 'err' });
      }
      return;
    }
    const item = e.target.closest('.peer-item');
    if (item && item.dataset.id) selectPeer(item.dataset.id);
  });

  // Double-click on the name also opens inline rename
  peerList.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('.peer-name');
    if (!nameEl) return;
    e.stopPropagation();
    const item = nameEl.closest('.peer-item');
    if (item) startInlineRename(item);
  });

  function startInlineRename(item) {
    const nameEl = item.querySelector('.peer-name');
    if (!nameEl || nameEl.querySelector('input')) return;
    // Mark the row so a peers-changed re-render skips updating the name
    // (only the name) and doesn't destroy the <input> mid-type.
    item.dataset.renaming = 'true';
    const id = item.dataset.id;
    const original = nameEl.textContent;
    nameEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = original;
    input.maxLength = 64;
    nameEl.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      delete item.dataset.renaming; // clear on EVERY exit (Enter/Escape/blur/catch)
      const newName = input.value.trim();
      nameEl.textContent = commit && newName ? newName : original;
      if (commit && newName && newName !== original) {
        try {
          await invoke('rename_peer', { peerId: id, newName });
          blip(1100, 0.06);
        } catch (err) {
          nameEl.textContent = original;
          setStatus(`ERR rename · ${err}`, { priority: 'err' });
        }
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- Filter buttons -----------------------------------------------
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderPeers();
      blip(880, 0.05);
    });
  });

  // ---------- Mode switch (TEXT / FILE) ------------------------------------
  // Activate a mode (TEXT / FILE) programmatically: sets state.mode, toggles the
  // .mode-btn active class and shows/hides the matching .mode-panel. Reused by
  // the click handler and by the drag-drop handler (T2: drops must reveal FILE).
  function activateMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.querySelectorAll('.mode-panel').forEach((p) => {
      const active = p.id === `mode-${mode}`;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
  }

  // Move keyboard focus into a modal when it opens (T3), so Tab/Escape reach its
  // controls and screen readers land inside it instead of on the trigger button.
  function focusFirstControl(modal) {
    if (!modal) return;
    const el = modal.querySelector(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (el) el.focus();
  }

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateMode(btn.dataset.mode);
      blip(550, 0.04);
    });
  });

  // ---------- File dropzone (real: picker + Tauri drag-drop) --------------
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function renderQueue() {
    fileQueue.textContent = '';
    const n = state.queuedFiles.length;
    if (dropzoneCount) {
      dropzoneCount.hidden = n === 0;
      dropzoneCount.textContent =
        n === 0 ? '' : `${n} archivo${n === 1 ? '' : 's'} listo${n === 1 ? '' : 's'}`;
    }
    if (n === 0) {
      fileQueue.hidden = true;
      return;
    }
    fileQueue.hidden = false;
    // Built with createElement + textContent only — the file name never touches
    // innerHTML, so no escaping helper is needed and no markup can be injected.
    state.queuedFiles.forEach((f, idx) => {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'q-name';
      name.textContent = `▸ ${f.name}`;
      name.title = f.name;

      const meta = document.createElement('span');
      meta.className = 'q-meta';

      if (f.size > 0) {
        const size = document.createElement('span');
        size.className = 'q-size';
        size.textContent = formatBytes(f.size);
        meta.appendChild(size);
      }

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'queue-remove';
      rm.dataset.remove = String(idx);
      rm.setAttribute('aria-label', `Quitar ${f.name}`);
      rm.textContent = '✕';
      meta.appendChild(rm);

      li.appendChild(name);
      li.appendChild(meta);
      fileQueue.appendChild(li);
    });
  }

  fileQueue.addEventListener('click', (e) => {
    const a = e.target.closest('[data-remove]');
    if (!a) return;
    e.preventDefault();
    const idx = parseInt(a.dataset.remove, 10);
    if (!isNaN(idx)) {
      state.queuedFiles.splice(idx, 1);
      renderQueue();
    }
  });

  async function pickFiles() {
    if (!dialog || !dialog.open) {
      setStatus('ERR · dialog plugin not available');
      return;
    }
    try {
      const result = await dialog.open({ multiple: true, directory: false });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      for (const path of paths) {
        await addPathToQueue(path);
      }
      blip(1100, 0.05);
    } catch (err) {
      setStatus(`ERR picker · ${err}`);
    }
  }

  async function addPathToQueue(path) {
    // Android Storage Access Framework returns content:// URIs from the
    // file picker that tokio::fs can't open directly. The backend's
    // `prepare_file_for_send` command runs them through
    // tauri-plugin-android-fs, which copies the content stream into our
    // app cache and returns a real filesystem path. On desktop and on
    // plain Android paths it's a passthrough.
    let realPath = path;
    if (typeof path === 'string' && path.startsWith('content://')) {
      try {
        setStatus('Reading file from Android storage…');
        realPath = await invoke('prepare_file_for_send', { path });
      } catch (err) {
        setStatus(`ERR · could not read file: ${err}`);
        blip(440, 0.1);
        return;
      }
    }
    const name = realPath.split(/[\\/]/).pop() || 'file';
    state.queuedFiles.push({ path: realPath, name, size: 0 });
    renderQueue();
  }

  dropzone.addEventListener('click', pickFiles);

  // Tauri's webview drag-drop event delivers real filesystem paths.
  listen('tauri://drag-enter', () => {
    dropzone.style.background = 'rgba(0, 240, 255, 0.08)';
  });
  listen('tauri://drag-leave', () => {
    dropzone.style.background = '';
  });
  listen('tauri://drag-drop', async (event) => {
    dropzone.style.background = '';
    const paths = event.payload?.paths || [];
    if (paths.length > 0) activateMode('file');
    for (const path of paths) {
      await addPathToQueue(path);
    }
    if (paths.length > 0) blip(1320, 0.05);
  });

  // ---------- Transmit / send ----------------------------------------------
  async function transmit() {
    if (!state.selectedPeerId) {
      setStatus(
        state.targetLost ? 'ERR · TARGET LOST — select a peer.' : 'ERR · no peer selected.',
        { priority: 'err' }
      );
      blip(220, 0.12);
      return;
    }
    const peer = state.peers.find((p) => p.id === state.selectedPeerId);
    if (!peer || peer.status === 'offline') {
      setStatus('ERR · peer offline');
      blip(220, 0.12);
      return;
    }

    if (state.mode === 'text') {
      await transmitText(peer);
    } else {
      await transmitFiles(peer);
    }
  }

  async function transmitText(peer) {
    if (!textarea.value.trim()) {
      setStatus('ERR · empty payload. Type something first.');
      blip(220, 0.12);
      return;
    }
    const chars = textarea.value.length;
    sendBtn.disabled = true;
    progressBlock.hidden = false;
    setProgress(0);
    progressText.textContent = `TRANSMITTING // ${peer.name}`;
    setStatus(`TX → ${peer.name}...`);
    blip(880, 0.05);

    // Tiny payload — no granular events. Quick animated fill.
    let pct = 0;
    const tick = setInterval(() => {
      pct = Math.min(95, pct + 10 + Math.random() * 10);
      setProgress(pct);
    }, 80);

    try {
      await invoke('send_text', { peerId: peer.id, text: textarea.value });
      clearInterval(tick);
      setProgress(100);
      progressText.textContent = 'COMPLETE';
      blip(1760, 0.12);
      setTimeout(() => blip(2200, 0.16), 130);
      setTimeout(() => {
        progressBlock.hidden = true;
        sendBtn.disabled = false;
        setProgress(0);
        setStatus(`OK · delivered to ${peer.name}.`, { force: true });
        showToast(`${peer.name} · ${chars} CHARS · ACK`);
        textarea.value = '';
      }, 600);
    } catch (err) {
      clearInterval(tick);
      progressBlock.hidden = true;
      sendBtn.disabled = false;
      setStatus(`ERR transmit · ${err}`, { priority: 'err' });
      blip(220, 0.2);
    }
  }

  async function transmitFiles(peer) {
    if (state.queuedFiles.length === 0) {
      setStatus('ERR · queue empty. Drop a file first.');
      blip(220, 0.12);
      return;
    }
    const filePaths = state.queuedFiles.map((f) => f.path);

    sendBtn.disabled = true;
    progressBlock.hidden = false;
    setProgress(0);
    progressText.textContent = `WAITING // ${peer.name}`;
    setStatus(`TX → ${peer.name} · awaiting accept...`);
    blip(880, 0.05);

    // The backend drives the progress events from this call.
    state.activeTransfer = {
      sessionId: null,
      totalBytes: 0,
      bytesSent: 0,
    };

    try {
      const sessionId = await invoke('send_files', {
        peerId: peer.id,
        filePaths,
      });
      state.activeTransfer.sessionId = sessionId;
      setProgress(100);
      progressText.textContent = 'COMPLETE';
      blip(1760, 0.12);
      setTimeout(() => blip(2200, 0.16), 130);
      setTimeout(() => {
        progressBlock.hidden = true;
        sendBtn.disabled = false;
        setProgress(0);
        const count = state.queuedFiles.length;
        setStatus(`OK · ${count} file(s) delivered to ${peer.name}.`, { force: true });
        showToast(`${peer.name} · ${count} FILE(S) · ACK`);
        state.queuedFiles = [];
        renderQueue();
        state.activeTransfer = null;
      }, 700);
    } catch (err) {
      progressBlock.hidden = true;
      sendBtn.disabled = false;
      setStatus(`ERR transmit · ${err}`, { priority: 'err' });
      state.activeTransfer = null;
      blip(220, 0.2);
    }
  }

  sendBtn.addEventListener('click', transmit);
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      transmit();
    }
  });

  // ---------- HUD action buttons -------------------------------------------
  document.querySelectorAll('.hud-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      blip(880, 0.06);
      if (action === 'refresh') {
        setStatus('SCAN · probing the network...');
        try {
          const peers = await invoke('rescan_peers');
          applyPeers(peers, /* initial */ false);
          setStatus(`OK · ${peers.length} peer(s) on the grid.`);
        } catch (err) {
          setStatus(`ERR rescan · ${err}`);
        }
      } else if (action === 'history') {
        openLogModal();
      } else if (action === 'qr') {
        openQrModal();
      } else if (action === 'settings') {
        openClipboardSettingsModal();
      } else if (action === 'app-settings') {
        openAppSettingsModal();
      } else if (action === 'section-clipboard') {
        switchSection('clipboard');
      } else if (action === 'section-displays') {
        switchSection('displays');
      } else if (action === 'displays-refresh') {
        // REFRESH de la barra de Displays (antes era un listener directo del
        // botón dentro de la sección; movido al top bar por el SPEC-shell).
        await loadDisplays();
      }
    });
  });

  // ---------- Incoming files modal -----------------------------------------
  function openIncomingModal(payload) {
    state.pendingIncoming = payload;
    incomingSenderName.textContent = payload.senderAlias || '—';
    incomingSenderHex.textContent = (payload.senderFingerprint || '').slice(0, 12);
    incomingFileCount.textContent = String(payload.fileCount).padStart(2, '0');
    incomingTotalSize.textContent = formatBytes(payload.totalSize);
    incomingFileList.innerHTML = '';
    (payload.files || []).forEach((f) => {
      const li = document.createElement('li');
      li.className = 'incoming-file-li';
      // Thumbnail comes from the peer. Only accept a data:image/... URL
      // (what thumbnails.rs actually produces); reject anything else
      // (javascript:, data:text/html, ...) and fall back to the icon.
      let thumb;
      if (f.thumbnail && /^data:image\/(png|jpeg|gif|webp);base64,/.test(f.thumbnail)) {
        thumb = document.createElement('img');
        thumb.className = 'incoming-thumb';
        thumb.alt = '';
        thumb.src = f.thumbnail; // validated as data:image/...
      } else {
        thumb = document.createElement('span');
        thumb.className = 'incoming-thumb incoming-thumb-empty';
        thumb.textContent = '📄';
      }
      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = f.name;            // textContent, no HTML parsing
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatBytes(f.size);
      li.replaceChildren(thumb, nameEl, sizeEl);
      incomingFileList.appendChild(li);
    });

    // First-contact banner — offer to save the sender if we don't know them yet.
    const banner = document.getElementById('incoming-firstcontact');
    if (banner) banner.remove();
    if (payload.senderFingerprint && !isKnownPeer(payload.senderFingerprint) && payload.senderIp) {
      const b = document.createElement('div');
      b.id = 'incoming-firstcontact';
      b.className = 'modal-firstcontact';
      // senderIp/senderPort come from the peer — build with textContent so
      // a malicious value can't inject markup.
      const label = document.createElement('div');
      label.className = 'settings-label';
      label.style.cssText = 'color:var(--neon-magenta);text-shadow:0 0 6px var(--neon-magenta-glow);margin-bottom:6px';
      label.textContent = 'FIRST CONTACT';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;justify-content:space-between';
      const addr = document.createElement('span');
      addr.className = 'mono';
      addr.style.cssText = 'font-size:11px;color:var(--text-mute)';
      addr.textContent = `${payload.senderIp}:${payload.senderPort || 53319}`;
      const saveBtn = document.createElement('button');
      saveBtn.className = 'modal-btn small';
      saveBtn.id = 'firstcontact-save';
      saveBtn.textContent = '+ SAVE PEER';
      row.append(addr, saveBtn);
      b.replaceChildren(label, row);
      incomingFileList.parentNode.insertBefore(b, incomingFileList);
      b.querySelector('#firstcontact-save').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = '◷ SAVING...';
        try {
          await invoke('add_peer_by_ip', {
            ip: payload.senderIp,
            port: payload.senderPort || 53319,
          });
          btn.textContent = '✓ SAVED';
          blip(1320, 0.08);
        } catch (err) {
          btn.textContent = 'ERR';
          btn.disabled = false;
        }
      });
    }

    incomingModal.hidden = false;
    blip(880, 0.1);
    setTimeout(() => blip(660, 0.08), 130);

    // Countdown — backend timeout is 60 s.
    const deadline = Date.now() + 60_000;
    if (state.incomingTimerHandle) clearInterval(state.incomingTimerHandle);
    state.incomingTimerHandle = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      incomingTimer.textContent = `awaiting decision · ${left}s`;
      if (left <= 0) clearInterval(state.incomingTimerHandle);
    }, 250);
  }

  function closeIncomingModal() {
    incomingModal.hidden = true;
    state.pendingIncoming = null;
    if (state.incomingTimerHandle) {
      clearInterval(state.incomingTimerHandle);
      state.incomingTimerHandle = null;
    }
  }

  incomingAcceptBtn.addEventListener('click', async () => {
    if (!state.pendingIncoming) return;
    const sid = state.pendingIncoming.sessionId;
    blip(1320, 0.1);
    closeIncomingModal();
    try {
      await invoke('approve_session', { sessionId: sid });
      setStatus('RX · accepting transfer...');
    } catch (err) {
      setStatus(`ERR approve · ${err}`);
    }
  });

  incomingRejectBtn.addEventListener('click', async () => {
    if (!state.pendingIncoming) return;
    const sid = state.pendingIncoming.sessionId;
    blip(220, 0.12);
    closeIncomingModal();
    try {
      await invoke('reject_session', { sessionId: sid });
      setStatus('RX rejected.');
    } catch (err) {
      setStatus(`ERR reject · ${err}`);
    }
  });

  // ---------- Settings modals (SPEC-shell: App + Clipboard) ----------------
  // Los ajustes viven en el MISMO store; solo se re-ubicaron en dos paneles. Un
  // helper carga el store una vez (cacheado en state.settings), y cada open
  // rellena sólo lo suyo. La persistencia (invoke al backend) no cambió.
  async function ensureSettings() {
    if (state.settings) return true;
    try {
      state.settings = await invoke('get_settings');
      return true;
    } catch (err) {
      setStatus(`ERR settings · ${err}`);
      return false;
    }
  }

  // ⚙ APP: apariencia (FX) + arranque/bandeja (desktop-only) + actualizador.
  async function openAppSettingsModal() {
    if (!(await ensureSettings())) return;
    if (settingsAutostart) {
      const v = !!state.settings.startWithWindows;
      settingsAutostart.checked = v;
      settingsAutostartLabel.textContent = v ? 'ON' : 'OFF';
    }
    if (settingsCloseTray) {
      const v = state.settings.closeToTray !== false;
      settingsCloseTray.checked = v;
      settingsCloseTrayLabel.textContent = v ? 'ON' : 'OFF';
    }
    if (settingsFx) {
      const fxOn = !fxDisabled();
      settingsFx.checked = fxOn;
      settingsFxLabel.textContent = fxOn ? 'ON' : 'OFF';
    }
    // Reset update UI to a known state each time the modal opens
    settingsUpdateStatus.textContent = `current v${(window.__LOCAL_INFO || {}).version || '?'}`;
    settingsUpdateAction.hidden = true;
    settingsApplyUpdate.disabled = false;
    settingsApplyUpdate.textContent = /android/i.test(navigator.userAgent)
      ? '▸ DOWNLOAD & INSTALL'
      : '▸ DOWNLOAD & RESTART';
    appSettingsModal.hidden = false;
    focusFirstControl(appSettingsModal);
  }

  // AJUSTES de Clipboard: carpeta de descargas + auto-aceptar + notificaciones.
  async function openClipboardSettingsModal() {
    if (!(await ensureSettings())) return;
    settingsDownloadDir.textContent = state.settings.downloadDir;
    settingsAutoAccept.checked = state.settings.autoAcceptFavorites;
    settingsAutoAcceptLabel.textContent = state.settings.autoAcceptFavorites ? 'ON' : 'OFF';
    if (settingsNotifications) {
      const notifOn = state.settings.notificationsEnabled !== false;
      settingsNotifications.checked = notifOn;
      settingsNotificationsLabel.textContent = notifOn ? 'ON' : 'OFF';
    }
    clipboardSettingsModal.hidden = false;
    focusFirstControl(clipboardSettingsModal);
  }

  function closeAppSettingsModal() {
    appSettingsModal.hidden = true;
  }
  function closeClipboardSettingsModal() {
    clipboardSettingsModal.hidden = true;
  }

  appSettingsCloseBtn.addEventListener('click', closeAppSettingsModal);
  clipboardSettingsCloseBtn.addEventListener('click', closeClipboardSettingsModal);

  // ---------- Runtime log modal --------------------------------------------
  const logModal = document.getElementById('log-modal');
  const logPane = document.getElementById('log-pane');
  const logLineCount = document.getElementById('log-line-count');
  const logAutoscroll = document.getElementById('log-autoscroll');
  const logCopyBtn = document.getElementById('log-copy');
  const logExportBtn = document.getElementById('log-export');
  const logClearBtn = document.getElementById('log-clear');
  const logCloseBtn = document.getElementById('log-close');

  // Ring of at most LOG_CAP lines — a flat string that grows forever is
  // a slow RAM leak and makes every repaint O(total history).
  const LOG_CAP = 2000;
  let logRing = [];
  let logLines = 0; // total real (para el "N lines"), NO el tamaño del ring

  function classifyLogLine(line) {
    if (line.includes('[ERR ]') || line.includes('[ERR]')) return 'lvl-err';
    if (line.includes('[WARN]')) return 'lvl-warn';
    return 'lvl-info';
  }

  function appendLogLine(line) {
    logRing.push(line);
    if (logRing.length > LOG_CAP) logRing.shift();
    logLines += 1;
    if (logModal && !logModal.hidden) {
      const span = document.createElement('span');
      span.className = classifyLogLine(line);
      span.textContent = (logPane.childElementCount ? '\n' : '') + line;
      logPane.appendChild(span);
      if (logLineCount) logLineCount.textContent = `${logLines} lines`;
      if (logAutoscroll && logAutoscroll.checked) {
        logPane.scrollTop = logPane.scrollHeight;
      }
    }
  }

  function repaintLog() {
    if (!logPane) return;
    logPane.innerHTML = '';
    for (let i = 0; i < logRing.length; i++) {
      const span = document.createElement('span');
      span.className = classifyLogLine(logRing[i]);
      span.textContent = (i ? '\n' : '') + logRing[i];
      logPane.appendChild(span);
    }
    if (logLineCount) logLineCount.textContent = `${logLines} lines`;
    if (logAutoscroll && logAutoscroll.checked) {
      logPane.scrollTop = logPane.scrollHeight;
    }
  }

  async function openLogModal() {
    // Tell the backend to start emitting live log-line events; while the
    // panel was closed nothing was lost — get_runtime_log below brings
    // the buffered history.
    invoke('set_log_panel_open', { open: true }).catch(() => {});
    try {
      const full = await invoke('get_runtime_log');
      const lines = full ? full.split('\n') : [];
      logRing = lines.slice(-LOG_CAP);
      logLines = lines.length;
    } catch (err) {
      logRing = [`[ui] failed to fetch log: ${err}`];
      logLines = 1;
    }
    logModal.hidden = false;
    focusFirstControl(logModal);
    repaintLog();
  }

  function closeLogModal() {
    logModal.hidden = true;
    invoke('set_log_panel_open', { open: false }).catch(() => {});
  }

  if (logCloseBtn) logCloseBtn.addEventListener('click', closeLogModal);

  // COPY/EXPORT pull the full backend buffer (up to 5000 lines) rather
  // than the 2000-line display ring, so the diagnostic the user pastes
  // back matches the "N lines" counter and isn't silently truncated.
  async function fullLogText() {
    try {
      return (await invoke('get_runtime_log')) || logRing.join('\n');
    } catch (_) {
      return logRing.join('\n');
    }
  }

  if (logCopyBtn) {
    logCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(await fullLogText());
        const orig = logCopyBtn.textContent;
        logCopyBtn.textContent = '✓ COPIED';
        setTimeout(() => { logCopyBtn.textContent = orig; }, 1400);
      } catch (err) {
        setStatus(`ERR copy · ${err}`);
      }
    });
  }

  if (logExportBtn) {
    logExportBtn.addEventListener('click', async () => {
      const blob = new Blob([await fullLogText()], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `millennium-log-${stamp}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (logClearBtn) {
    logClearBtn.addEventListener('click', async () => {
      try {
        await invoke('clear_runtime_log');
        logRing = [];
        logLines = 0;
        repaintLog();
      } catch (err) {
        setStatus(`ERR clear · ${err}`);
      }
    });
  }

  // ---------- QR pairing modal ----------------------------------------------
  const qrModal = document.getElementById('qr-modal');
  const qrCanvas = document.getElementById('qr-canvas');
  const qrPayload = document.getElementById('qr-payload');
  const qrPasteInput = document.getElementById('qr-paste-input');
  const qrAddError = document.getElementById('qr-add-error');
  const qrCopyBtn = document.getElementById('qr-copy-payload');
  const qrAddSubmit = document.getElementById('qr-add-submit');
  const qrCloseBtn = document.getElementById('qr-close');
  let qrCurrentPayload = '';

  async function openQrModal() {
    if (!qrModal) return;
    qrModal.hidden = false;
    focusFirstControl(qrModal);
    setQrTab('show');
    try {
      const data = await invoke('generate_pair_qr');
      // data.svg is produced locally by the qrcode crate (trusted, not
      // peer data) — safe to inject. The error branch below is NOT: err
      // can carry arbitrary text, so use textContent.
      qrCanvas.innerHTML = data.svg || '';
      qrCurrentPayload = data.payload || '';
      setText(qrPayload, qrCurrentPayload);
    } catch (err) {
      qrCanvas.replaceChildren();
      const e = document.createElement('div');
      e.style.cssText = 'padding:24px;color:#ff4d6b';
      e.textContent = String(err);
      qrCanvas.appendChild(e);
      qrCurrentPayload = '';
    }
  }
  function closeQrModal() { if (qrModal) qrModal.hidden = true; }

  function setQrTab(name) {
    document.querySelectorAll('.qr-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.qrTab === name);
    });
    document.getElementById('qr-pane-show').hidden = name !== 'show';
    document.getElementById('qr-pane-add').hidden = name !== 'add';
    if (qrCopyBtn) qrCopyBtn.hidden = name !== 'show';
    if (qrAddSubmit) qrAddSubmit.hidden = name !== 'add';
    if (qrAddError) qrAddError.hidden = true;
  }
  document.querySelectorAll('.qr-tab').forEach((t) => {
    t.addEventListener('click', () => setQrTab(t.dataset.qrTab));
  });
  if (qrCloseBtn) qrCloseBtn.addEventListener('click', closeQrModal);
  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) closeQrModal();
    });
  }
  if (qrCopyBtn) {
    qrCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(qrCurrentPayload);
        const orig = qrCopyBtn.textContent;
        qrCopyBtn.textContent = '✓ COPIED';
        setTimeout(() => { qrCopyBtn.textContent = orig; }, 1400);
      } catch (err) {
        setStatus(`ERR copy · ${err}`);
      }
    });
  }
  // QR camera scan — Android-only path via tauri-plugin-barcode-scanner.
  // Reveal the scan button when the plugin is available; if not, the
  // "Paste QR contents" textarea remains the only option (desktop case).
  const qrScanBlock = document.getElementById('qr-scan-block');
  const qrScanBtn = document.getElementById('qr-scan-btn');
  const barcodeScanner = window.__TAURI__ && window.__TAURI__.barcodeScanner;
  if (qrScanBlock && barcodeScanner && /android/i.test(navigator.userAgent)) {
    qrScanBlock.hidden = false;
  }
  if (qrScanBtn) {
    qrScanBtn.addEventListener('click', async () => {
      if (!barcodeScanner) {
        setStatus('Camera scanner not available on this device.');
        return;
      }
      try {
        // Make sure the user has granted CAMERA permission first.
        if (barcodeScanner.checkPermissions && barcodeScanner.requestPermissions) {
          const cur = await barcodeScanner.checkPermissions();
          if (cur !== 'granted') {
            const req = await barcodeScanner.requestPermissions();
            if (req !== 'granted') {
              qrAddError.textContent = 'Camera permission denied.';
              qrAddError.hidden = false;
              return;
            }
          }
        }
        qrScanBtn.disabled = true;
        qrScanBtn.textContent = '▸ POINT AT QR…';
        const res = await barcodeScanner.scan({ formats: ['QrCode'] });
        const content = (res && res.content) ? res.content : '';
        if (!content) {
          qrAddError.textContent = 'Empty QR scan.';
          qrAddError.hidden = false;
          return;
        }
        // Try to peek at the alias inside the QR payload so the
        // confirmation prompt mentions the peer by name. Best-effort —
        // a malformed payload still goes through pair_with_qr_payload
        // for validation.
        let confirmLabel = 'this peer';
        try {
          const parsed = JSON.parse(content);
          if (parsed && (parsed.alias || parsed.ip)) {
            confirmLabel = parsed.alias
              ? `${parsed.alias}${parsed.ip ? ` (${parsed.ip})` : ''}`
              : parsed.ip;
          }
        } catch (_) {}
        // Close the modal first so the native confirm() sits on top of
        // the regular app screen, not behind the QR overlay (which is
        // what made the previous flow feel stuck).
        closeQrModal();
        const ok = confirm(`Pair with ${confirmLabel}?\n\nIt will be added as a favourite peer.`);
        if (!ok) {
          setStatus('QR pairing cancelled.');
          return;
        }
        const msg = await invoke('pair_with_qr_payload', { payload: content });
        setStatus(msg);
        // The camera intent backgrounded the WebView while it was
        // scanning, which on some Android builds drops the
        // `peers-changed` event the backend emits after pair. Pull
        // the snapshot directly so the new peer appears without
        // forcing the user to tap SCAN.
        try {
          const peers = await invoke('list_peers');
          applyPeers(peers, /* initial */ false);
        } catch (_) {}
        notify('▣ Paired', confirmLabel);
      } catch (err) {
        qrAddError.textContent = `Scan failed: ${err}`;
        qrAddError.hidden = false;
      } finally {
        qrScanBtn.disabled = false;
        qrScanBtn.textContent = '▸ SCAN WITH CAMERA';
      }
    });
  }

  if (qrAddSubmit) {
    qrAddSubmit.addEventListener('click', async () => {
      const txt = (qrPasteInput.value || '').trim();
      if (!txt) {
        qrAddError.textContent = 'Paste the QR contents first.';
        qrAddError.hidden = false;
        return;
      }
      qrAddSubmit.disabled = true;
      qrAddError.hidden = true;
      try {
        const msg = await invoke('pair_with_qr_payload', { payload: txt });
        setStatus(msg);
        try {
          const peers = await invoke('list_peers');
          applyPeers(peers, /* initial */ false);
        } catch (_) {}
        closeQrModal();
      } catch (err) {
        qrAddError.textContent = String(err);
        qrAddError.hidden = false;
      } finally {
        qrAddSubmit.disabled = false;
      }
    });
  }

  // Wire frontend error catchers to also ship into the backend buffer so
  // a UI crash leaves a trace in the same log the user is going to paste.
  function reportToBackend(level, msg) {
    try {
      invoke('record_frontend_log', { level, msg }).catch(() => {});
    } catch (_) {}
  }
  window.addEventListener('error', (e) => {
    reportToBackend('ERR', `uncaught ${e.message} @ ${e.filename?.split(/[\\/]/).pop()}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason?.message || e.reason || 'unknown';
    reportToBackend('ERR', `unhandled rejection: ${reason}`);
  });
