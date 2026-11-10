// Millennium Clipboard // GRID — frontend. Displays (1/2): monitores, cuenta regresiva, pestañas y perfiles.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  // ---------- Displays modal (SPEC-displays, Fase 2) ------------------------
  // Lista los monitores que reporta Windows y deja prender/apagar uno. Todo
  // cambio entra "a prueba": el backend arranca un watchdog y vuelve al layout
  // anterior si nadie confirma. Este archivo NO revierte por su cuenta — solo
  // dibuja el reloj y le avisa al backend; el que decide siempre es el backend
  // (si la pantalla se apaga y el usuario no puede ni ver la ventana, el
  // rollback tiene que salir igual).
  // Displays v2 Fase 2: displays es una SECCIÓN, no un modal. Estas refs
  // reemplazan al viejo displaysModal/displaysBtn.
  const displaysSectionEl = document.getElementById('displays-section');
  const clipboardSectionEl = document.getElementById('clipboard-section');
  const hudSections = document.getElementById('hud-sections');
  const hudSectionBtns = hudSections ? Array.from(hudSections.querySelectorAll('.hud-section-btn')) : [];
  const displaysList = document.getElementById('displays-list');
  const displaysCount = document.getElementById('displays-count');
  const displaysError = document.getElementById('displays-error');
  const displaysEmpty = document.getElementById('displays-empty');
  const displaysMockWarning = document.getElementById('displays-mock-warning');
  const displaysRefreshBtn = document.getElementById('displays-refresh');
  // #displays-close se eliminó (SPEC-shell): el switch del top bar cumple "volver
  // a Clipboard". REFRESH pasó a la barra de Displays y se maneja por el dispatch
  // genérico de .hud-btn (data-action="displays-refresh"); displaysRefreshBtn se
  // conserva solo para el foco al entrar a la sección (enterDisplaysSection).
  const displaysPendingBar = document.getElementById('displays-pending');
  const displaysPendingText = document.getElementById('displays-pending-text');
  const displaysConfirmBtn = document.getElementById('displays-confirm');
  const displaysRevertBtn = document.getElementById('displays-revert');
  // Fase 3: pestañas, perfiles y ajustes.
  const displaysTabs = document.getElementById('displays-tabs');
  const displaysPanes = displaysSectionEl ? Array.from(displaysSectionEl.querySelectorAll('.displays-pane')) : [];
  const displaysProfilesList = document.getElementById('displays-profiles-list');
  const displaysProfilesEmpty = document.getElementById('displays-profiles-empty');
  const displaysProfileName = document.getElementById('displays-profile-name');
  const displaysSaveProfileBtn = document.getElementById('displays-save-profile');
  const displaysProfileConfirm = document.getElementById('displays-profile-confirm');
  const displaysProfileConfirmText = document.getElementById('displays-profile-confirm-text');
  const displaysProfileConfirmYes = document.getElementById('displays-profile-confirm-yes');
  const displaysProfileConfirmNo = document.getElementById('displays-profile-confirm-no');
  const displaysRevertSecsInput = document.getElementById('displays-revert-secs');
  const displaysSettingsSaveBtn = document.getElementById('displays-settings-save');
  // Displays v2, Fase 1: perfil de arranque + interruptor de atajos.
  const displaysStartupSelect = document.getElementById('displays-startup-profile');
  const displaysShortcutsToggle = document.getElementById('displays-shortcuts-enabled');
  const displaysShortcutsToggleLabel = document.getElementById('displays-shortcuts-enabled-label');
  const displaysCanvas = document.getElementById('displays-canvas');
  const displaysCanvasEmpty = document.getElementById('displays-canvas-empty');
  const displaysCanvasApplyBtn = document.getElementById('displays-canvas-apply');
  const displaysCanvasResetBtn = document.getElementById('displays-canvas-reset');

  // El modulo de monitores es Windows-only. En Android las pestañas de sección NO
  // se revelan → la app queda solo-clipboard, sin pestaña muerta ni hueco. Se usa
  // el userAgent como el resto del codebase, NO html.is-mobile (una ventana
  // angosta en Windows conserva Displays). displaysEnabled tambien gatea
  // switchSection('displays') como cinturon: la sección nunca se muestra en Android.
  const displaysEnabled = !/android/i.test(navigator.userAgent);
  if (hudSections && displaysEnabled) {
    hudSections.hidden = false;
  }

  // La CCD API entrega el refresco en miliherz (60000 = 60 Hz).
  function formatHz(mhz) {
    if (!Number.isFinite(mhz) || mhz <= 0) return '—';
    return `${Math.round((mhz / 1000) * 100) / 100} Hz`;
  }

  // 0x0 no es un bug: es el centinela de un monitor conectado pero sin modo
  // activo (Windows no reporta resolucion para el que esta apagado).
  function formatResolution(d) {
    if (!d.width || !d.height) return '—';
    return `${d.width} × ${d.height}`;
  }

  // El estado activo/detached sale SIEMPRE de d.active, para que el badge no
  // pueda contradecir al estilo .is-detached de la misma fila.
  function displayBadges(d) {
    const badges = [];
    if (d.primary) badges.push({ text: 'PRIMARY', cls: 'primary' });
    badges.push(d.active ? { text: 'ACTIVE', cls: 'active' } : { text: 'DETACHED', cls: 'detached' });
    return badges;
  }

  // --- Cuenta regresiva de confirmacion ------------------------------------
  // UN solo interval para todo el modulo, y se limpia siempre: al confirmar, al
  // revertir, al cerrar el modal y antes de arrancar otro. Un timer huerfano es
  // CPU en reposo, que es justo lo que este proyecto vigila.
  let displaysCountdownTimer = null;
  let displaysLastShownSec = -1;
  // Fase 3: acción destructiva de perfil esperando el OK del banner de confirmación.
  let pendingProfileAction = null; // { type: 'overwrite'|'delete', name }
  // Displays v2, Fase 1: captura de un atajo de teclado para un perfil.
  let shortcutCaptureName = null;  // perfil que está capturando, o null
  let shortcutKeyHandler = null;   // listener one-shot de keydown mientras se captura
  // Displays v2, Fase 1: AJUSTES recién es seguro de guardar cuando loadSettings
  // terminó de poblar los controles. Sin esto, un cambio disparado durante la
  // carga mandaría los defaults vacíos y borraría el perfil de arranque guardado.
  let displaysSettingsLoaded = false;
  // Displays v2 Fase 2: el reseteo de montaje (vaciar lista, olvidar perfiles,
  // arrancar en LISTA) corre UNA sola vez — la primera vez que entrás a la
  // sección, o al arrancar. En re-entradas se conserva la sub-pestaña activa.
  let displaysSectionMounted = false;
  // Fase 3: estado del lienzo de arrastre.
  let canvasView = null;   // { scale, minX, minY, offsetX, offsetY } del último render
  let canvasDirty = false; // hay un acomodo local sin aplicar (protege de refrescos)
  let canvasDrag = null;   // arrastre en curso: { m, div, startX, startY, origX, origY, scale }

  function stopDisplaysCountdown() {
    if (displaysCountdownTimer !== null) {
      clearInterval(displaysCountdownTimer);
      displaysCountdownTimer = null;
    }
    displaysLastShownSec = -1;
  }

  function renderDisplaysPending() {
    const pending = state.displaysPending;
    if (displaysPendingBar) displaysPendingBar.hidden = !pending;
    if (!pending) return;
    const remaining = Math.max(0, pending.deadlineAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    // Escribir en el DOM solo cuando cambia el segundo que se ve: el interval
    // corre mas fino que eso para no atrasarse, no para repintar.
    if (secs !== displaysLastShownSec) {
      displaysLastShownSec = secs;
      setText(displaysPendingText, secs > 0 ? `REVIERTE SOLO EN ${secs}s` : 'REVIRTIENDO…');
    }
    // Llego a cero: el reloj ya no tiene nada que contar. Quien avisa como
    // termino es el evento displays-confirmation del backend.
    if (remaining <= 0) stopDisplaysCountdown();
  }

  function startDisplaysCountdown(remainingMs) {
    stopDisplaysCountdown();
    const ms = Number(remainingMs);
    // Se guarda el DEADLINE, no un contador que se va restando: un setInterval
    // se atrasa (ventana en segundo plano, GC, un apply que trabo el hilo) y el
    // numero terminaria mintiendo sobre cuanto falta de verdad.
    state.displaysPending = { deadlineAt: Date.now() + (Number.isFinite(ms) && ms > 0 ? ms : 0) };
    renderDisplaysPending();
    // El reloj tickea mientras haya un cambio pendiente, SIN condición de sección:
    // el banner global lo muestra también desde Clipboard. Sin pending, cero timer
    // (CPU en reposo ~0%); el que revierte de verdad vive en el backend.
    if (state.displaysPending.deadlineAt > Date.now()) {
      displaysCountdownTimer = setInterval(renderDisplaysPending, 250);
    }
  }

  function clearDisplaysPending() {
    stopDisplaysCountdown();
    state.displaysPending = null;
    renderDisplaysPending();
  }

  function refreshDisplaysUi() {
    renderDisplays();
    renderDisplaysPending();
    // Los botones CARGAR/BORRAR/GUARDAR se apagan mientras hay un cambio en
    // vuelo o pendiente; renderProfiles se ocupa (no-op si no se cargaron).
    renderProfiles();
    // Lienzo: NO se toca en medio de un arrastre (re-renderizar re-escalaría y
    // sacaría el monitor de abajo del cursor). Si el estado ya se asentó (sin
    // pendiente) y no hay un acomodo local sin aplicar, se re-sincroniza con la
    // realidad; si el usuario tiene algo a medio acomodar, se respeta.
    if (state.displaysTab === 'canvas' && !canvasDrag) {
      // Re-sincroniza con la realidad SOLO en un estado asentado: sin arrastre,
      // sin acomodo local sin aplicar, sin cambio pendiente, y **sin un apply en
      // vuelo** — durante el apply `state.displays` todavía tiene lo VIEJO, y
      // re-inicializar ahí pisaría el acomodo recién mandado (se vería el layout
      // viejo justo mientras hay que confirmar o revertir).
      if (!canvasDirty && !state.displaysPending && !state.displaysBusy) initCanvasDraft();
      renderCanvas();
    }
  }

  function buildDisplayItem(d) {
    const li = document.createElement('li');
    li.className = 'display-item';
    li.dataset.id = d.id;
    // Template ESTATICO: cero interpolacion de datos del backend. Los valores
    // entran despues por setText/textContent (mismo patron que buildPeerItem).
    li.innerHTML = `
      <div class="display-glyph">▤</div>
      <div class="display-info">
        <div class="display-name"></div>
        <div class="display-meta mono">
          <span class="display-res"></span>
          <span class="display-sep">·</span>
          <span class="display-hz"></span>
        </div>
      </div>
      <div class="display-badges"></div>
      <div class="display-actions">
        <button class="modal-btn small display-primary-btn" type="button">★ primario</button>
        <button class="modal-btn small display-toggle-btn" type="button"></button>
      </div>`;
    updateDisplayItem(li, d);
    return li;
  }

  function updateDisplayItem(li, d) {
    li.dataset.active = d.active ? 'true' : 'false';
    li.classList.toggle('is-detached', !d.active);
    setText(li.querySelector('.display-name'), d.name);
    setText(li.querySelector('.display-res'), formatResolution(d));
    setText(li.querySelector('.display-hz'), formatHz(d.refreshMhz));

    const btn = li.querySelector('.display-toggle-btn');
    if (btn) {
      const detaching = !!d.active;
      btn.textContent = detaching ? 'DETACH' : 'ATTACH';
      btn.classList.toggle('reject', detaching);
      // canDetach habla SOLO de apagar. No se mira en una fila ya apagada: si
      // el backend alguna vez la marcara false ahi, ATTACH quedaria muerto para
      // siempre y el monitor no se podria volver a prender nunca.
      const lastOne = detaching && d.canDetach === false;
      const waiting = !!state.displaysPending;
      btn.disabled = lastOne || waiting || state.displaysBusy;
      // El title es el unico lugar donde se explica por que esta apagado.
      if (lastOne) {
        btn.title = 'Es el único monitor activo: apagarlo te deja la máquina a ciegas.';
      } else if (waiting) {
        btn.title = 'Hay un cambio esperando confirmación.';
      } else {
        btn.title = detaching ? 'Apagar este monitor' : 'Encender este monitor';
      }
    }

    // ★ primario: solo tiene sentido en un monitor ACTIVO que no sea ya el
    // primario. En una fila apagada o ya primaria se esconde (el badge PRIMARY
    // ya dice cuál es). Se apaga mientras hay un cambio en vuelo o pendiente.
    const primBtn = li.querySelector('.display-primary-btn');
    if (primBtn) {
      const canBePrimary = !!d.active && !d.primary;
      primBtn.hidden = !canBePrimary;
      if (canBePrimary) {
        const waiting = !!state.displaysPending;
        primBtn.disabled = waiting || state.displaysBusy;
        primBtn.title = waiting
          ? 'Hay un cambio esperando confirmación.'
          : 'Hacer este monitor el primario (pasa por la cuenta regresiva).';
      }
    }

    const badgeBox = li.querySelector('.display-badges');
    if (badgeBox) {
      const nodes = displayBadges(d).map((b) => {
        const span = document.createElement('span');
        span.className = `badge display-badge ${b.cls}`;
        span.textContent = b.text;
        return span;
      });
      badgeBox.replaceChildren(...nodes);
    }
  }

  // Render por diff, como renderPeers: se reutiliza el <li> existente por
  // data-id y se borran los que ya no estan.
  function renderDisplays() {
    if (!displaysList) return;
    const items = state.displays || [];
    const existing = new Map();
    Array.from(displaysList.querySelectorAll('li.display-item')).forEach((li) => {
      if (li.dataset.id) existing.set(li.dataset.id, li);
    });
    const seen = new Set();
    items.forEach((d, idx) => {
      seen.add(d.id);
      try {
        let li = existing.get(d.id);
        if (li) {
          updateDisplayItem(li, d);
        } else {
          li = buildDisplayItem(d);
        }
        if (displaysList.children[idx] !== li) {
          displaysList.insertBefore(li, displaysList.children[idx] || null);
        }
      } catch (err) {
        console.error('[displays] fila malformada', err);
      }
    });
    existing.forEach((li, id) => {
      if (!seen.has(id)) li.remove();
    });

    if (displaysEmpty) displaysEmpty.hidden = items.length > 0;
    if (displaysCount) {
      const active = items.filter((d) => d.active).length;
      displaysCount.textContent = `${items.length} monitor(es) · ${active} activo(s)`;
    }
  }

  // Un solo lugar donde se muestra un error de monitores, para que el cartel
  // del modal, la linea de status y el log del backend nunca cuenten historias
  // distintas del mismo problema.
  function showDisplaysError(err) {
    const msg = String(err);
    if (displaysError) {
      // textContent: el mensaje puede venir de Windows, nunca por innerHTML.
      displaysError.textContent = msg;
      displaysError.hidden = false;
    }
    setStatus(`ERR displays · ${msg}`, { priority: 'err' });
    reportToBackend('ERR', `displays: ${msg}`);
  }

  // Todo snapshot que llega del backend (lectura, toggle, confirm o revert)
  // entra por aca. El backend es el dueño del estado: la UI no adivina nada,
  // ni siquiera si sigue habiendo un cambio pendiente.
  function applyDisplaysSnapshot(snapshot) {
    state.displays = Array.isArray(snapshot?.displays) ? snapshot.displays : [];
    if (displaysMockWarning) displaysMockWarning.hidden = snapshot?.source !== 'mock';
    const remainingMs = Number(snapshot?.pending?.remainingMs);
    if (Number.isFinite(remainingMs) && remainingMs > 0) {
      // Rehidratacion: si el usuario cerro y reabrio el modal en el medio, la
      // cuenta reaparece con lo que quedaba segun el reloj del backend.
      startDisplaysCountdown(remainingMs);
    } else {
      clearDisplaysPending();
    }
    refreshDisplaysUi();
  }

  async function loadDisplays() {
    if (displaysError) displaysError.hidden = true;
    try {
      applyDisplaysSnapshot(await invoke('displays_get_snapshot'));
    } catch (err) {
      state.displays = [];
      clearDisplaysPending();
      if (displaysMockWarning) displaysMockWarning.hidden = true;
      refreshDisplaysUi();
      showDisplaysError(err);
    }
  }

  // Prender o apagar un monitor. El comando vuelve con el snapshot ya
  // verificado por el backend (re-enumerado, no "me devolvio 0 asi que anduvo").
  async function toggleDisplay(id) {
    if (state.displaysBusy || state.displaysPending) return;
    const target = (state.displays || []).find((d) => d.id === id);
    if (!target) return;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    refreshDisplaysUi(); // apaga los botones mientras Windows piensa
    blip(660, 0.06);
    setStatus(
      `DISPLAYS · ${target.active ? 'apagando' : 'encendiendo'} ${target.name}…`,
      { force: true }
    );
    try {
      applyDisplaysSnapshot(await invoke('displays_toggle', { displayId: id }));
    } catch (err) {
      // El apply pudo quedar a mitad de camino: lo unico confiable es volver a
      // leer la topologia antes de mostrar nada.
      try { await loadDisplays(); } catch (_) {}
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  // Hacer primario un monitor (Displays v2, Fase 1). Espejo de toggleDisplay: es
  // un cambio en vivo, así que vuelve con la MISMA red (cuenta regresiva) y el
  // backend ya re-enumeró antes de devolver el snapshot.
  async function setPrimaryDisplay(id) {
    if (state.displaysBusy || state.displaysPending) return;
    const target = (state.displays || []).find((d) => d.id === id);
    if (!target) return;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    refreshDisplaysUi();
    blip(660, 0.06);
    setStatus(`DISPLAYS · haciendo primario ${target.name}…`, { force: true });
    try {
      applyDisplaysSnapshot(await invoke('displays_set_primary', { displayId: id }));
    } catch (err) {
      try { await loadDisplays(); } catch (_) {}
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  // CONFIRMAR / REVERTIR AHORA: los dos hacen lo mismo salvo el comando.
  async function resolveDisplaysPending(command, doneMsg) {
    if (!state.displaysPending || state.displaysBusy) return;
    state.displaysBusy = true;
    // El reloj se frena ya (la decision esta tomada), pero la barra queda a la
    // vista con el numero congelado hasta que vuelva el snapshot.
    stopDisplaysCountdown();
    if (displaysConfirmBtn) displaysConfirmBtn.disabled = true;
    if (displaysRevertBtn) displaysRevertBtn.disabled = true;
    try {
      applyDisplaysSnapshot(await invoke(command));
      setStatus(`DISPLAYS · ${doneMsg}`, { force: true });
    } catch (err) {
      try { await loadDisplays(); } catch (_) {}
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      if (displaysConfirmBtn) displaysConfirmBtn.disabled = false;
      if (displaysRevertBtn) displaysRevertBtn.disabled = false;
      refreshDisplaysUi();
    }
  }

  // --- Fase 3: pestañas -----------------------------------------------------

  function switchDisplaysTab(tab) {
    state.displaysTab = tab;
    if (displaysTabs) {
      displaysTabs.querySelectorAll('.displays-tab').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.tab === tab);
      });
    }
    displaysPanes.forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    if (displaysError) displaysError.hidden = true;
    hideProfileConfirm();
    cancelShortcutCapture();
    // Los datos de perfiles/ajustes se piden recién al entrar a su pestaña.
    if (tab === 'profiles') loadProfiles();
    else if (tab === 'settings') loadSettings();
    // Lienzo: si hay un acomodo local sin aplicar, se conserva al volver a la
    // pestaña (mismo criterio que la re-sync); si no, se arranca de la realidad.
    else if (tab === 'canvas') { if (!canvasDirty) initCanvasDraft(); renderCanvas(); }
  }

  // --- Fase 3: perfiles -----------------------------------------------------

  function buildProfileItem(p) {
    const li = document.createElement('li');
    li.className = 'displays-profile-item';
    li.dataset.name = p.name;
    // Template ESTATICO; los datos entran por setText (mismo patron que las filas
    // de monitores y de peers: nunca innerHTML con strings del backend). El editor
    // de escena (Fase 4) tambien es 100% estatico: los chips y los inputs se
    // llenan despues por createElement/textContent, nunca por interpolacion.
    // `which`/`label` son literales fijos, asi que la interpolacion es segura.
    const sceneCol = (which, label) => `
            <div class="displays-scene-col" data-list="${which}">
              <div class="displays-scene-col-head">${label}</div>
              <ul class="displays-scene-chips"></ul>
              <div class="displays-scene-add">
                <select class="displays-setting-select displays-scene-preset">
                  <option value="">＋ acción…</option>
                  <option value="bigpicture">🎮 Big Picture</option>
                  <option value="game">🎮 Juego de Steam…</option>
                  <option value="chrome">🍿 Chrome (cuenta + link)…</option>
                  <option value="close_bp">⏹ Cerrar Big Picture</option>
                  <option value="volume">🔊 Volumen…</option>
                  <option value="custom">⚙ Comando…</option>
                </select>
                <div class="displays-scene-form" hidden></div>
              </div>
            </div>`;
    li.innerHTML = `
      <div class="displays-profile-info">
        <div class="displays-profile-name-text"></div>
        <div class="mono displays-profile-summary"></div>
        <div class="displays-profile-audio">
          <label class="displays-profile-audio-label">Sonido a:</label>
          <select class="displays-setting-select displays-profile-audio-select"></select>
        </div>
        <div class="displays-profile-scene">
          <button class="displays-scene-toggle" type="button">🎬 escena…</button>
          <div class="displays-scene-editor" hidden>
            ${sceneCol('entrada', 'Al entrar')}
            ${sceneCol('salida', 'Al salir')}
          </div>
        </div>
      </div>
      <div class="displays-profile-actions">
        <button class="modal-btn small accept displays-profile-load" type="button">CARGAR</button>
        <button class="modal-btn small displays-profile-update" type="button">↻ actualizar</button>
        <button class="modal-btn small displays-profile-shortcut" type="button">⌨ atajo</button>
        <button class="modal-btn small reject displays-profile-delete" type="button">BORRAR</button>
      </div>`;
    updateProfileItem(li, p);
    return li;
  }

  function updateProfileItem(li, p) {
    setText(li.querySelector('.displays-profile-name-text'), p.name);
    setText(li.querySelector('.displays-profile-summary'),
      (typeof p.summary === 'string' && p.summary) ? p.summary : '—');
    const busy = !!state.displaysBusy;
    const pending = !!state.displaysPending;
    const loadBtn = li.querySelector('.displays-profile-load');
    const delBtn = li.querySelector('.displays-profile-delete');
    if (loadBtn) {
      loadBtn.disabled = busy || pending;
      loadBtn.title = pending
        ? 'Hay un cambio esperando confirmación.'
        : 'Aplicar este perfil (vuelve solo si no lo confirmás).';
    }
    if (delBtn) delBtn.disabled = busy;

    // Displays v2, Fase 1: botón actualizar (pisa el perfil con el layout actual)
    // y botón de atajo (muestra la combinación asignada o "atajo").
    const updateBtn = li.querySelector('.displays-profile-update');
    if (updateBtn) {
      updateBtn.disabled = busy || pending;
      updateBtn.title = pending
        ? 'Hay un cambio esperando confirmación.'
        : 'Pisar este perfil con el layout actual (previa confirmación).';
    }
    const scBtn = li.querySelector('.displays-profile-shortcut');
    // Si esta fila está capturando un atajo, no se le pisa el texto (lo maneja
    // el flujo de captura); si no, refleja el atajo guardado.
    if (scBtn && shortcutCaptureName !== p.name) {
      scBtn.disabled = busy;
      // Esta fila NO está capturando: sacar el latido magenta si venía de una
      // captura anterior (renderProfiles reusa el <li>, la clase no se limpia sola).
      scBtn.classList.remove('capturing');
      const sc = (typeof p.shortcut === 'string' && p.shortcut) ? p.shortcut : '';
      scBtn.textContent = sc ? `⌨ ${sc}` : '⌨ atajo';
      scBtn.classList.toggle('has-shortcut', !!sc);
      scBtn.title = sc
        ? `Atajo: ${sc}. Clic para cambiarlo (Supr borra · Esc cancela).`
        : 'Asignar un atajo global para aplicar este perfil.';
    }

    // Displays v2, Fase 3: dropdown de salida de audio ("Sonido a:"). No se
    // repuebla mientras el usuario lo tiene abierto/enfocado (le pisaría la
    // selección); mismo cuidado que populateStartupOptions con 'current'.
    const audioSel = li.querySelector('.displays-profile-audio-select');
    if (audioSel) {
      if (document.activeElement !== audioSel) populateAudioSelect(audioSel, p);
      audioSel.disabled = busy || pending;
    }

    // Displays v2, Fase 4: editor de escena (acciones de entrada/salida). El
    // estado abierto/cerrado se recuerda en sceneEditorOpen para sobrevivir al
    // re-render por diff. Los chips se rearman desde p.actions (backend = verdad).
    const scene = li.querySelector('.displays-profile-scene');
    if (scene) {
      const editor = scene.querySelector('.displays-scene-editor');
      if (editor) editor.hidden = !sceneEditorOpen.has(p.name);
      const toggle = scene.querySelector('.displays-scene-toggle');
      const n = countActions(p);
      if (toggle) {
        toggle.textContent = n ? `🎬 escena (${n})` : '🎬 escena…';
        toggle.classList.toggle('has-scene', n > 0);
        toggle.disabled = busy || pending;
        toggle.title = 'Acciones que dispara este perfil al aplicarlo (y su limpieza al salir).';
      }
      scene.querySelectorAll('.displays-scene-col').forEach((col) => {
        const which = col.dataset.list;
        const acciones = (p.actions && Array.isArray(p.actions[which])) ? p.actions[which] : [];
        const ul = col.querySelector('.displays-scene-chips');
        if (ul) renderSceneChips(ul, acciones, busy || pending);
        const sel = col.querySelector('.displays-scene-preset');
        if (sel && document.activeElement !== sel) sel.disabled = busy || pending;
      });
    }
  }

  // Cuántas acciones tiene el perfil (entrada + salida), para el contador del toggle.
  function countActions(p) {
    const a = (p && p.actions) ? p.actions : {};
    const e = Array.isArray(a.entrada) ? a.entrada.length : 0;
    const s = Array.isArray(a.salida) ? a.salida.length : 0;
    return e + s;
  }

  // Puebla un <select> "Sonido a:" con No tocar + las salidas activas. Todo por
  // createElement/textContent (nombres del sistema: nunca innerHTML crudo).
  function populateAudioSelect(sel, p) {
    const outputs = Array.isArray(state.audioOutputs) ? state.audioOutputs : [];
    const assigned = (p.audio && typeof p.audio.endpointId === 'string') ? p.audio.endpointId : '';
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No tocar';
    sel.appendChild(none);
    let found = false;
    outputs.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.endpointId;
      opt.textContent = o.friendlyName;
      if (o.endpointId === assigned) found = true;
      sel.appendChild(opt);
    });
    // El perfil tiene una salida guardada que no está activa ahora (TV apagada):
    // mostrarla igual para no borrar visualmente la asignación.
    if (assigned && !found) {
      const opt = document.createElement('option');
      opt.value = assigned;
      const label = (p.audio && p.audio.friendlyName) ? p.audio.friendlyName : assigned;
      opt.textContent = `${label} (no disponible)`;
      sel.appendChild(opt);
    }
    sel.value = assigned;
  }

  // Render por diff, como renderDisplays: se reusa el <li> por data-name.
  function renderProfiles() {
    if (!displaysProfilesList) return;
    const items = state.displaysProfiles;
    if (items === null) return; // todavia no cargados: no tocar el DOM
    const existing = new Map();
    Array.from(displaysProfilesList.querySelectorAll('li.displays-profile-item')).forEach((li) => {
      if (li.dataset.name) existing.set(li.dataset.name, li);
    });
    const seen = new Set();
    items.forEach((p, idx) => {
      seen.add(p.name);
      try {
        let li = existing.get(p.name);
        if (li) updateProfileItem(li, p);
        else li = buildProfileItem(p);
        if (displaysProfilesList.children[idx] !== li) {
          displaysProfilesList.insertBefore(li, displaysProfilesList.children[idx] || null);
        }
      } catch (err) {
        console.error('[displays] perfil malformado', err);
      }
    });
    existing.forEach((li, name) => { if (!seen.has(name)) li.remove(); });
    if (displaysProfilesEmpty) displaysProfilesEmpty.hidden = items.length > 0;
    if (displaysSaveProfileBtn) displaysSaveProfileBtn.disabled = !!state.displaysBusy;
  }

  async function loadProfiles() {
    if (displaysError) displaysError.hidden = true;
    try {
      const profiles = await invoke('displays_list_profiles');
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
    } catch (err) {
      state.displaysProfiles = [];
      showDisplaysError(err);
    }
    await loadAudioOutputs();
    renderProfiles();
  }

  // Displays v2, Fase 3: lista de salidas de audio activas para poblar los
  // dropdowns "Sonido a:". Best-effort: si falla, los dropdowns quedan solo con
  // "No tocar" (+ la salida guardada de cada perfil, aunque no esté activa).
  async function loadAudioOutputs() {
    try {
      const outs = await invoke('displays_list_audio_outputs');
      state.audioOutputs = Array.isArray(outs) ? outs : [];
    } catch (err) {
      state.audioOutputs = [];
      console.warn('[displays] no se pudieron listar las salidas de audio', err);
    }
  }

  // Displays v2, Fase 3: guarda (o limpia) la salida de audio de un perfil. Vacío
  // = "No tocar". Devuelve la lista al día para re-renderizar.
  async function setProfileAudioFlow(name, endpointId) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      let profiles;
      if (!endpointId) {
        profiles = await invoke('displays_clear_profile_audio', { name });
        setStatus(`DISPLAYS · "${name}": audio en No tocar`, { force: true });
      } else {
        const out = (state.audioOutputs || []).find((o) => o.endpointId === endpointId);
        const friendlyName = out ? out.friendlyName : '';
        profiles = await invoke('displays_set_profile_audio', { name, endpointId, friendlyName });
        setStatus(`DISPLAYS · "${name}": sonido a "${friendlyName || 'esa salida'}"`, { force: true });
      }
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }
