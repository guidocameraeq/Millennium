// Millennium Clipboard // GRID — frontend. Comunes: helpers, referencias al DOM, estado global, barras, status, audio.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  const { invoke } = window.__TAURI__.core;

  // Startup diagnostic. Reports viewport + computed layout + ACTUAL
  // rendered dimensions, so we can tell from the log whether elements
  // are overflowing horizontally (which produces the "everything cut
  // off the right side" symptom even when the CSS layout is correct).
  setTimeout(() => {
    try {
      const vp = `${window.innerWidth}x${window.innerHeight}`;
      const dpr = window.devicePixelRatio;
      const docW = document.documentElement.clientWidth;
      const scrollW = document.documentElement.scrollWidth;
      const overflow = scrollW > docW ? `OVERFLOW:${scrollW}>${docW}` : 'noverflow';

      const dims = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return `${sel}=null`;
        return `${sel}=${Math.round(el.offsetWidth)}x${Math.round(el.offsetHeight)}`;
      };

      const isMobileClass = document.documentElement.classList.contains('is-mobile');
      invoke('record_frontend_log', {
        level: 'INFO',
        msg: `[viewport] inner=${vp} doc=${docW} scroll=${scrollW} ${overflow} dpr=${dpr} class=${isMobileClass} ${dims('.hud')} ${dims('.hud-right')} ${dims('.grid')} ${dims('.composer')}`
      }).catch(() => {});
    } catch (_) {}
  }, 1500);
  const { listen } = window.__TAURI__.event;
  const dialog = window.__TAURI__.dialog;
  const notification = window.__TAURI__.notification;

  // Native OS notification wrapper. Honors the settings toggle and falls
  // back silently if the user hasn't granted permission yet (we ask on
  // first use). Title + body keep it readable in the Windows toast.
  let nativePermissionAsked = false;
  async function notify(title, body) {
    if (!state.settings || state.settings.notificationsEnabled === false) return;
    if (!notification) return;
    try {
      let granted = await notification.isPermissionGranted();
      if (!granted && !nativePermissionAsked) {
        nativePermissionAsked = true;
        const perm = await notification.requestPermission();
        granted = perm === 'granted';
      }
      if (granted) {
        await notification.sendNotification({ title, body });
      }
    } catch (err) {
      console.warn('[notify]', err);
    }
  }

  // Null-safe textContent setter. If the target element disappears
  // (HTML rev mismatch, hot-reload, modal not yet rendered) we just log
  // instead of breaking the whole event chain with a TypeError.
  const setText = (el, value) => {
    if (el) {
      el.textContent = value;
    } else {
      console.warn('[setText] target element is null, value=', value);
    }
  };

  // Surface uncaught JS errors in the status bar so users can paste them
  // back. Without this, a release build hides every error.
  window.addEventListener('error', (e) => {
    console.error('[uncaught]', e);
    try {
      const sm = document.getElementById('status-msg');
      if (sm) sm.textContent = `JS ERR · ${e.message} @ ${e.filename?.split(/[\\/]/).pop()}:${e.lineno}`;
    } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e);
    try {
      const sm = document.getElementById('status-msg');
      const reason = e.reason?.message || e.reason || 'unknown';
      if (sm) sm.textContent = `JS REJECT · ${reason}`;
    } catch (_) {}
  });

  // ---------- DOM refs -----------------------------------------------------
  const textarea = document.getElementById('text-composer');
  const peerList = document.getElementById('peer-list');
  const targetName = document.getElementById('target-name');
  const targetHex = document.getElementById('target-hex');
  const statusMsg = document.getElementById('status-msg');
  const peerCount = document.getElementById('peer-count');
  const filterHint = document.getElementById('filter-hint');
  const statusPeers = document.getElementById('status-peers');
  const statusFav = document.getElementById('status-fav');
  const hudHost = document.getElementById('hud-host');
  const hudIp = document.getElementById('hud-ip');
  const hudVersion = document.getElementById('hud-version');
  const sendBtn = document.getElementById('send-btn');
  const progressBlock = document.getElementById('progress-block');
  const progressSegments = document.getElementById('progress-segments');
  const progressText = document.getElementById('progress-text');
  const progressPct = document.getElementById('progress-pct');
  const rxProgressBlock = document.getElementById('rx-progress-block');
  const rxProgressSegments = document.getElementById('rx-progress-segments');
  const rxProgressText = document.getElementById('rx-progress-text');
  const rxProgressPct = document.getElementById('rx-progress-pct');
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');
  const incomingToast = document.getElementById('incoming-toast');
  const incomingToastText = document.getElementById('incoming-toast-text');
  const dropzone = document.getElementById('dropzone');
  const fileQueue = document.getElementById('file-queue');
  const dropzoneCount = document.getElementById('dropzone-count');
  const soundToggle = document.getElementById('sound-toggle');

  // Modals
  const incomingModal = document.getElementById('incoming-modal');
  const incomingSenderName = document.getElementById('incoming-sender-name');
  const incomingSenderHex = document.getElementById('incoming-sender-hex');
  const incomingFileCount = document.getElementById('incoming-file-count');
  const incomingTotalSize = document.getElementById('incoming-total-size');
  const incomingFileList = document.getElementById('incoming-file-list');
  const incomingTimer = document.getElementById('incoming-timer');
  const incomingAcceptBtn = document.getElementById('incoming-accept');
  const incomingRejectBtn = document.getElementById('incoming-reject');

  // SPEC-shell: el viejo #settings-modal se partió en dos paneles. Los ids de los
  // CONTROLES no cambian (los handlers de guardado están atados por id), solo hay
  // dos contenedores y dos botones de cerrar.
  const appSettingsModal = document.getElementById('app-settings-modal');
  const clipboardSettingsModal = document.getElementById('clipboard-settings-modal');
  const settingsDownloadDir = document.getElementById('settings-download-dir');
  const settingsPickDir = document.getElementById('settings-pick-dir');
  const settingsAutoAccept = document.getElementById('settings-auto-accept');
  const settingsAutoAcceptLabel = document.getElementById('settings-auto-accept-label');
  const appSettingsCloseBtn = document.getElementById('app-settings-close');
  const clipboardSettingsCloseBtn = document.getElementById('clipboard-settings-close');
  const settingsNotifications = document.getElementById('settings-notifications');
  const settingsNotificationsLabel = document.getElementById('settings-notifications-label');
  const settingsAutostart = document.getElementById('settings-autostart');
  const settingsAutostartLabel = document.getElementById('settings-autostart-label');
  const settingsCloseTray = document.getElementById('settings-close-tray');
  const settingsCloseTrayLabel = document.getElementById('settings-close-tray-label');
  const settingsFx = document.getElementById('settings-fx');
  const settingsFxLabel = document.getElementById('settings-fx-label');

  const addPeerBtn = document.getElementById('add-peer-btn');
  const addPeerModal = document.getElementById('add-peer-modal');
  const addPeerIp = document.getElementById('add-peer-ip');
  const addPeerPort = document.getElementById('add-peer-port');
  const addPeerError = document.getElementById('add-peer-error');
  const addPeerSubmit = document.getElementById('add-peer-submit');

  const peerDetailsModal = document.getElementById('peer-details-modal');
  const peerDetailsTitle = document.getElementById('peer-details-title');
  const peerDetailsName = document.getElementById('peer-details-name');
  const peerDetailsFp = document.getElementById('peer-details-fp');
  const peerDetailsAddr = document.getElementById('peer-details-addr');
  const peerDetailsStatus = document.getElementById('peer-details-status');
  const peerDetailsFav = document.getElementById('peer-details-fav');
  const peerDetailsFavLabel = document.getElementById('peer-details-fav-label');
  const peerDetailsClip = document.getElementById('peer-details-clip');
  const peerDetailsClipLabel = document.getElementById('peer-details-clip-label');
  const peerDetailsRemove = document.getElementById('peer-details-remove');
  const peerDetailsCloseBtn = document.getElementById('peer-details-close');
  let peerDetailsCurrentId = null;

  const backendBanner = document.getElementById('backend-banner');
  const backendBannerMsg = document.getElementById('backend-banner-msg');
  const backendBannerClose = document.getElementById('backend-banner-close');

  function showBackendBanner(level, msg) {
    if (!backendBanner) return;
    backendBanner.dataset.level = level || 'error';
    setText(backendBannerMsg, msg || 'Unknown backend error');
    backendBanner.hidden = false;
  }
  function hideBackendBanner() {
    if (backendBanner) backendBanner.hidden = true;
  }
  if (backendBannerClose) {
    backendBannerClose.addEventListener('click', hideBackendBanner);
  }

  const settingsCheckUpdate = document.getElementById('settings-check-update');
  const settingsUpdateStatus = document.getElementById('settings-update-status');
  const settingsUpdateAction = document.getElementById('settings-update-action');
  const settingsUpdateBanner = document.getElementById('settings-update-banner');
  const settingsApplyUpdate = document.getElementById('settings-apply-update');
  let updateInfoCache = null;

  // ---------- App state ----------------------------------------------------
  const state = {
    peers: [],
    selectedPeerId: null,
    filter: 'favorites',
    mode: 'text',
    queuedFiles: [], // [{ path, name, size }]
    settings: null,
    pendingIncoming: null, // { sessionId, files, totalSize, deadlineAt }
    incomingTimerHandle: null,
    activeTransfer: null, // { sessionId, files: [{ fileId, name, size, bytes }], totalBytes }
    activeReceive: null, // { sessionId } — RX bar keying, independent of TX (2.2.e)
    targetLost: false, // the selected peer vanished from the snapshot (2.2.b)
    displays: [], // monitores del ultimo snapshot (SPEC-displays)
    displaysPending: null, // { deadlineAt } mientras un cambio espera confirmacion (Fase 2)
    displaysBusy: false, // hay un invoke de displays en vuelo: no encimar otro
    displaysProfiles: null, // perfiles guardados (Fase 3); null = todavia no cargados
    displaysTab: 'list', // pestaña activa del modal (Fase 3)
    displaysDraft: [], // borrador del lienzo: monitores activos con su posicion en edicion (Fase 3)
    section: 'clipboard', // sección de nivel superior activa: 'clipboard' | 'displays' (Displays v2 Fase 2)
  };

  // ---------- Progress bar segments ----------------------------------------
  const SEGMENTS = 28;
  for (let i = 0; i < SEGMENTS; i++) {
    const s = document.createElement('div');
    s.className = 'seg';
    progressSegments.appendChild(s);
  }
  const segs = [...progressSegments.children];

  function setProgress(pct) {
    const filled = Math.round((pct / 100) * SEGMENTS);
    segs.forEach((s, i) => s.classList.toggle('on', i < filled));
    progressPct.textContent = `${pct}%`;
  }

  // Receiver bar — independent segments/fill from the TX bar above.
  for (let i = 0; i < SEGMENTS; i++) {
    const s = document.createElement('div');
    s.className = 'seg';
    rxProgressSegments.appendChild(s);
  }
  const rxSegs = [...rxProgressSegments.children];

  function setRxProgress(pct) {
    const filled = Math.round((pct / 100) * SEGMENTS);
    rxSegs.forEach((s, i) => s.classList.toggle('on', i < filled));
    rxProgressPct.textContent = `${pct}%`;
  }

  // ---------- Status helpers -----------------------------------------------
  // Priority/TTL so a routine info line (e.g. the ~5s "GRID · N online")
  // can't clobber an error/warning the user still needs to read. Info
  // messages are suppressed while a higher-priority message is within its
  // TTL; warn/err messages always show and arm the TTL window.
  let statusPriorityUntil = 0;
  const STATUS_LEVEL = { info: 0, warn: 1, err: 2 };
  function setStatus(msg, opts) {
    const level = STATUS_LEVEL[(opts && opts.priority) || 'info'];
    const now = Date.now();
    // A conscious user action (opts.force) or any warn/err always shows; a
    // routine info is suppressed only while a higher-priority TTL is live.
    if (level === 0 && !(opts && opts.force) && now < statusPriorityUntil) return;
    setText(statusMsg, msg);
    if (level > 0) {
      const ttl = (opts && opts.ttl) != null ? opts.ttl : 5000;
      statusPriorityUntil = ttl > 0 ? now + ttl : 0;
    } else {
      statusPriorityUntil = 0;
    }
  }
  function showToast(text) {
    toastText.innerHTML = '';
    toastText.textContent = text;
    setToastTitle('TRANSMIT OK');
    toast.hidden = false;
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => (toast.hidden = true), 3800);
  }

  let toastHideTimer = null;

  function setToastTitle(t) {
    const el = document.querySelector('.alert-title');
    if (el) el.textContent = t;
  }

  function showIncomingText(text, alias, fingerprint, senderIp, senderPort) {
    // Incoming text renders into its OWN surface (#incoming-toast), never the
    // shared ACK toast — so a later 'TRANSMIT OK' ACK can't innerHTML='' this
    // node and destroy a received message before the user copies it.
    const titleEl = document.getElementById('incoming-toast-title');
    if (titleEl) titleEl.textContent = `◂ INCOMING FROM ${alias}`;
    incomingToastText.innerHTML = '';

    const body = document.createElement('div');
    body.className = 'incoming-body';
    body.textContent = text;
    incomingToastText.appendChild(body);

    const meta = document.createElement('div');
    meta.className = 'incoming-meta mono';
    meta.textContent = `${text.length} CHARS · ${String(fingerprint || '').slice(0, 16)}... · ${senderIp || '?'}`;
    incomingToastText.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'incoming-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'incoming-btn';
    copyBtn.textContent = '⎘ COPY';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✓ COPIED';
        blip(1760, 0.08);
      } catch (e) {
        copyBtn.textContent = 'ERR';
      }
    });
    actions.appendChild(copyBtn);

    const known = isKnownPeer(fingerprint);
    if (!known && senderIp) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'incoming-btn';
      saveBtn.textContent = '+ SAVE SENDER';
      saveBtn.title = `Register ${alias} (${senderIp}) as a known peer so you can send back`;
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '◷ SAVING...';
        try {
          await invoke('add_peer_by_ip', { ip: senderIp, port: senderPort || 53319 });
          saveBtn.textContent = '✓ SAVED';
          blip(1320, 0.08);
        } catch (err) {
          saveBtn.textContent = 'ERR';
          saveBtn.disabled = false;
        }
      });
      actions.appendChild(saveBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'incoming-btn';
    closeBtn.textContent = '✕ CLOSE';
    closeBtn.addEventListener('click', () => {
      incomingToast.hidden = true;
    });
    actions.appendChild(closeBtn);

    incomingToastText.appendChild(actions);
    incomingToast.hidden = false;
  }

  function isKnownPeer(fingerprint) {
    return state.peers.some((p) => p.id === fingerprint);
  }

  // ---------- Typewriter placeholder rotator -------------------------------
  const placeholderLines = [
    'TYPE OR PASTE > TRANSMIT TO PEER...',
    'TEXT, URL, SNIPPET — ANY PAYLOAD.',
    'PRESS CTRL+ENTER TO SEND.',
  ];
  let phTimer = null;
  let phIdx = 0;

  function typePh(line, i = 0) {
    // Starting a fresh line (i===0) cancels any chain still running, so
    // two callers can never leave two concurrent typewriters alive
    // (phTimer only ever tracks one timer).
    if (i === 0 && phTimer) { clearTimeout(phTimer); phTimer = null; }
    textarea.placeholder = line.slice(0, i) + (i < line.length ? '▌' : '');
    if (i <= line.length) {
      phTimer = setTimeout(() => typePh(line, i + 1), 35 + Math.random() * 45);
    } else {
      phTimer = setTimeout(() => {
        textarea.placeholder = line;
        // This inner timer must land in phTimer too — otherwise stopPh()
        // during the 1600ms pause can't cancel the chain and repeated
        // hide/show cycles pile up concurrent typewriters.
        phTimer = setTimeout(() => {
          phIdx = (phIdx + 1) % placeholderLines.length;
          typePh(placeholderLines[phIdx]);
        }, 1600);
      }, 600);
    }
  }
  function stopPh() {
    if (phTimer) { clearTimeout(phTimer); phTimer = null; }
    textarea.placeholder = '';
  }
  // syncFxPaused() below is the single boot entry point for the
  // typewriter — starting it here too would spawn a second chain.
  textarea.addEventListener('focus', () => { if (!textarea.value) stopPh(); });
  textarea.addEventListener('blur', () => {
    if (!textarea.value && !fxDisabled()) { phIdx = 0; typePh(placeholderLines[0]); }
  });

  // ---------- FX governance (fase 0) ----------------------------------------
  // Decorative CSS animations freeze while the window is hidden
  // (html.fx-paused, see styles.css) and the typewriter's setTimeout
  // chain stops too — otherwise the WebView keeps painting in the tray.
  function fxDisabled() {
    return document.documentElement.classList.contains('fx-off');
  }
  function syncFxPaused() {
    document.documentElement.classList.toggle('fx-paused', document.hidden);
    if (document.hidden) {
      stopPh();
    } else if (!textarea.value && document.activeElement !== textarea && !fxDisabled()) {
      phIdx = 0;
      typePh(placeholderLines[0]);
    }
  }
  document.addEventListener('visibilitychange', syncFxPaused);
  syncFxPaused();

  // ---------- Audio (click-clack + blips) ----------------------------------
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) audioCtx = new C();
    }
    return audioCtx;
  }
  function clack() {
    if (!soundToggle.checked) return;
    const ac = ctx(); if (!ac) return;
    const now = ac.currentTime;
    const buf = ac.createBuffer(1, 0.04 * ac.sampleRate, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.pow(1 - i / d.length, 3);
      d[i] = (Math.random() * 2 - 1) * env * 0.55;
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const flt = ac.createBiquadFilter();
    flt.type = 'bandpass'; flt.frequency.value = 2400; flt.Q.value = 2.5;
    const g = ac.createGain(); g.gain.value = 0.5;
    src.connect(flt); flt.connect(g); g.connect(ac.destination);
    src.start(now);
  }
  function blip(freq = 880, dur = 0.08) {
    if (!soundToggle.checked) return;
    const ac = ctx(); if (!ac) return;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'square'; osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.exponentialRampToValueAtTime(0.15, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(g); g.connect(ac.destination);
    osc.start(now); osc.stop(now + dur);
  }
  textarea.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') clack();
  });
