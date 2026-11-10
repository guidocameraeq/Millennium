// Millennium Clipboard // GRID — frontend. Displays (2/2): escenas, atajos, ajustes, lienzo y conexión de eventos. Ojo: al final está el ESC global que cierra los modales de Clipboard.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
'use strict';

  // ── Displays v2, Fase 4: editor de escena (acciones por perfil) ──────────

  // Qué editores de escena están abiertos (por nombre de perfil). Sobrevive al
  // re-render por diff: como shortcutCaptureName, es estado de UI local.
  const sceneEditorOpen = new Set();

  // Etiqueta legible de una acción, para el chip. SIEMPRE por textContent (el
  // destino puede venir del backend / de lo que tipeó el usuario: nunca innerHTML).
  function actionLabel(a) {
    if (!a || typeof a !== 'object') return '?';
    if (a.tipo === 'volumen') return `🔊 Volumen ${a.nivel}%`;
    if (a.tipo === 'lanzar') {
      const d = String(a.destino || '');
      const low = d.toLowerCase();
      if (low.includes('steam://open/bigpicture')) return '🎮 Big Picture';
      if (low.includes('steam://close/bigpicture')) return '⏹ Cerrar Big Picture';
      const game = low.match(/steam:\/\/rungameid\/(\d+)/);
      if (game) return `🎮 Juego ${game[1]}`;
      if (low.includes('chrome')) {
        const args = Array.isArray(a.args) ? a.args : [];
        const pd = args.find((x) => typeof x === 'string' && x.startsWith('--profile-directory='));
        const carpeta = pd ? pd.slice('--profile-directory='.length) : '';
        return carpeta ? `🍿 Chrome · ${carpeta}` : '🍿 Chrome';
      }
      const base = d.split(/[\\/]/).pop() || d;
      return `▶ ${base}`;
    }
    return '?';
  }

  function mkChipBtn(txt, chipAction, title, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'displays-scene-chip-btn';
    b.dataset.chipAction = chipAction;
    b.textContent = txt;
    b.title = title;
    if (disabled) b.disabled = true;
    return b;
  }

  // Rearma los chips de una columna desde la lista de acciones (backend = verdad).
  function renderSceneChips(ul, acciones, locked) {
    ul.replaceChildren();
    if (!acciones.length) {
      const li = document.createElement('li');
      li.className = 'displays-scene-empty';
      li.textContent = '(nada)';
      ul.appendChild(li);
      return;
    }
    acciones.forEach((a, idx) => {
      const li = document.createElement('li');
      li.className = 'displays-scene-chip';
      li.dataset.index = String(idx);
      const label = document.createElement('span');
      label.className = 'displays-scene-chip-label';
      label.textContent = actionLabel(a);
      li.appendChild(label);
      li.appendChild(mkChipBtn('↑', 'up', 'Subir', locked || idx === 0));
      li.appendChild(mkChipBtn('↓', 'down', 'Bajar', locked || idx === acciones.length - 1));
      li.appendChild(mkChipBtn('✕', 'remove', 'Quitar', locked));
      ul.appendChild(li);
    });
  }

  // Guarda las dos listas de un perfil (entrada + salida). Mismo patrón que
  // setProfileAudioFlow: bloquea, invoca, re-renderiza desde la respuesta.
  async function setProfileActionsFlow(name, entrada, salida) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      const profiles = await invoke('displays_set_profile_actions', { name, entrada, salida });
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
      setStatus(`DISPLAYS · "${name}": escena actualizada`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }

  // Copia mutable de las acciones actuales del perfil (desde el estado, que es la
  // última respuesta del backend). Se edita y se manda entero de vuelta.
  function currentProfileActions(name) {
    const p = (state.displaysProfiles || []).find((x) => x.name === name);
    const a = (p && p.actions) ? p.actions : {};
    return {
      entrada: Array.isArray(a.entrada) ? a.entrada.slice() : [],
      salida: Array.isArray(a.salida) ? a.salida.slice() : [],
    };
  }

  function addSceneAction(name, which, accion) {
    if (!accion) return;
    const cur = currentProfileActions(name);
    if (!Array.isArray(cur[which])) return;
    cur[which].push(accion);
    setProfileActionsFlow(name, cur.entrada, cur.salida);
  }

  function removeSceneAction(name, which, index) {
    const cur = currentProfileActions(name);
    if (!Array.isArray(cur[which]) || index < 0 || index >= cur[which].length) return;
    cur[which].splice(index, 1);
    setProfileActionsFlow(name, cur.entrada, cur.salida);
  }

  function moveSceneAction(name, which, index, delta) {
    const cur = currentProfileActions(name);
    const arr = cur[which];
    if (!Array.isArray(arr)) return;
    const j = index + delta;
    if (j < 0 || j >= arr.length) return;
    const tmp = arr[index]; arr[index] = arr[j]; arr[j] = tmp;
    setProfileActionsFlow(name, cur.entrada, cur.salida);
  }

  // Un preset elegido en el <select>: los sin-parámetros se agregan directo; los
  // que piden datos abren un formulario inline en la columna.
  function handleScenePreset(li, col, preset) {
    const name = li.dataset.name;
    const which = col.dataset.list;
    if (preset === 'bigpicture') {
      addSceneAction(name, which, { tipo: 'lanzar', destino: 'steam://open/bigpicture', args: [] });
      return;
    }
    if (preset === 'close_bp') {
      addSceneAction(name, which, { tipo: 'lanzar', destino: 'steam://close/bigpicture', args: [] });
      return;
    }
    showSceneForm(col, preset);
  }

  function showSceneForm(col, preset) {
    const form = col.querySelector('.displays-scene-form');
    if (!form) return;
    form.replaceChildren();
    form.hidden = false;
    form.dataset.preset = preset;
    const addInput = (ph, kind) => {
      const inp = document.createElement(kind === 'area' ? 'textarea' : 'input');
      if (kind === 'num') { inp.type = 'number'; inp.min = '0'; inp.max = '100'; }
      else if (kind !== 'area') inp.type = 'text';
      inp.className = 'displays-scene-input';
      inp.placeholder = ph;
      form.appendChild(inp);
      return inp;
    };
    if (preset === 'game') addInput('ID del juego (nº de steam://rungameid)', 'text');
    else if (preset === 'chrome') {
      addInput('carpeta de la cuenta (Default, Profile 1…)', 'text');
      addInput('link (https://…)', 'text');
    } else if (preset === 'volume') addInput('nivel 0–100', 'num');
    else if (preset === 'custom') {
      addInput('programa (.exe / steam://… / .lnk)', 'text');
      addInput('argumentos (uno por línea)', 'area');
    }
    const row = document.createElement('div');
    row.className = 'displays-scene-form-row';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'modal-btn small accept displays-scene-form-ok';
    ok.textContent = '＋ agregar';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'modal-btn small displays-scene-form-cancel';
    cancel.textContent = '✕';
    row.appendChild(ok);
    row.appendChild(cancel);
    form.appendChild(row);
    const first = form.querySelector('.displays-scene-input');
    if (first) first.focus();
  }

  function hideSceneForm(col) {
    const form = col.querySelector('.displays-scene-form');
    if (!form) return;
    form.hidden = true;
    form.replaceChildren();
    delete form.dataset.preset;
  }

  function submitSceneForm(li, col) {
    const form = col.querySelector('.displays-scene-form');
    if (!form) return;
    const preset = form.dataset.preset;
    const inputs = Array.from(form.querySelectorAll('.displays-scene-input'));
    const accion = buildPresetAction(preset, inputs);
    if (!accion) return; // faltó un dato: el aviso lo dio buildPresetAction
    hideSceneForm(col);
    addSceneAction(li.dataset.name, col.dataset.list, accion);
  }

  function buildPresetAction(preset, inputs) {
    const val = (i) => (inputs[i] ? String(inputs[i].value || '').trim() : '');
    const warn = (msg) => setStatus(`DISPLAYS · ${msg}`, { priority: 'warn', ttl: 3500 });
    if (preset === 'game') {
      const id = val(0).replace(/[^0-9]/g, '');
      if (!id) { warn('poné el ID del juego'); return null; }
      return { tipo: 'lanzar', destino: `steam://rungameid/${id}`, args: [] };
    }
    if (preset === 'chrome') {
      const carpeta = val(0);
      const url = val(1);
      if (!url) { warn('poné el link'); return null; }
      const args = [];
      if (carpeta) args.push(`--profile-directory=${carpeta}`);
      args.push('--new-window', '--start-fullscreen', url);
      return { tipo: 'lanzar', destino: 'chrome.exe', args };
    }
    if (preset === 'volume') {
      let n = parseInt(val(0), 10);
      if (isNaN(n)) { warn('poné un nivel 0–100'); return null; }
      n = Math.max(0, Math.min(100, n));
      return { tipo: 'volumen', nivel: n };
    }
    if (preset === 'custom') {
      const destino = val(0);
      if (!destino) { warn('poné el programa o la URI'); return null; }
      const raw = inputs[1] ? String(inputs[1].value || '') : '';
      const args = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      return { tipo: 'lanzar', destino, args };
    }
    return null;
  }

  function toggleScene(li, name) {
    const editor = li.querySelector('.displays-scene-editor');
    if (!editor) return;
    const abrir = editor.hidden;
    editor.hidden = !abrir;
    if (abrir) sceneEditorOpen.add(name);
    else sceneEditorOpen.delete(name);
  }

  // Maneja un clic dentro del editor de escena. Devuelve true si lo consumió.
  function handleSceneClick(el, li, name) {
    const toggle = el.closest('.displays-scene-toggle');
    if (toggle) {
      if (!toggle.disabled) toggleScene(li, name);
      return true;
    }
    const chipBtn = el.closest('.displays-scene-chip-btn');
    if (chipBtn) {
      if (!chipBtn.disabled) {
        const chip = chipBtn.closest('.displays-scene-chip');
        const col = chipBtn.closest('.displays-scene-col');
        if (chip && col) {
          const idx = parseInt(chip.dataset.index, 10);
          const which = col.dataset.list;
          const act = chipBtn.dataset.chipAction;
          if (act === 'remove') removeSceneAction(name, which, idx);
          else if (act === 'up') moveSceneAction(name, which, idx, -1);
          else if (act === 'down') moveSceneAction(name, which, idx, 1);
        }
      }
      return true;
    }
    const okBtn = el.closest('.displays-scene-form-ok');
    if (okBtn) {
      const col = okBtn.closest('.displays-scene-col');
      if (col) submitSceneForm(li, col);
      return true;
    }
    const cancelBtn = el.closest('.displays-scene-form-cancel');
    if (cancelBtn) {
      const col = cancelBtn.closest('.displays-scene-col');
      if (col) hideSceneForm(col);
      return true;
    }
    return false;
  }

  // El banner de confirmacion se reusa para pisar y para borrar. Tus perfiles son
  // tus datos: ninguna de las dos corre sin que aprietes SÍ.
  function hideProfileConfirm() {
    pendingProfileAction = null;
    if (displaysProfileConfirm) displaysProfileConfirm.hidden = true;
  }

  function askProfileConfirm(action, message) {
    pendingProfileAction = action;
    if (displaysProfileConfirmText) displaysProfileConfirmText.textContent = message;
    if (displaysProfileConfirm) displaysProfileConfirm.hidden = false;
  }

  async function runPendingProfileAction() {
    const action = pendingProfileAction;
    hideProfileConfirm();
    if (!action) return;
    if (action.type === 'overwrite') await doSaveProfile(action.name);
    else if (action.type === 'delete') await doDeleteProfile(action.name);
  }

  function saveProfileFlow() {
    hideProfileConfirm();
    const typed = (displaysProfileName && displaysProfileName.value || '').trim();
    if (!typed) {
      setStatus('DISPLAYS · poné un nombre para el perfil', { priority: 'warn', ttl: 4000 });
      if (displaysProfileName) displaysProfileName.focus();
      return;
    }
    // Guarda anti-pisado a ciegas: sin la lista cargada no se puede saber si el
    // nombre ya existe, y guardar igual pisaría un perfil sin mostrar el banner.
    if (state.displaysProfiles === null) {
      setStatus('DISPLAYS · esperá, cargando perfiles…', { priority: 'warn', ttl: 3000 });
      return;
    }
    // Pisar un perfil que ya existe = transformar tus datos: se pide OK antes. El
    // match es sin distinguir mayúsculas, PERO se pisa el nombre CANÓNICO ya
    // guardado (no la capitalización tipeada): el backend hace upsert por nombre
    // exacto, así que "trabajo" sobre "Trabajo" tiene que reemplazar "Trabajo",
    // no crear un duplicado.
    const existing = (state.displaysProfiles || []).find(
      (p) => p.name.toLowerCase() === typed.toLowerCase()
    );
    if (existing) {
      askProfileConfirm(
        { type: 'overwrite', name: existing.name },
        `Ya existe "${existing.name}". Guardar reemplaza su layout guardado por el actual.`
      );
      return;
    }
    doSaveProfile(typed);
  }

  async function doSaveProfile(name) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      const profiles = await invoke('displays_save_profile', { name });
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
      if (displaysProfileName) displaysProfileName.value = '';
      setStatus(`DISPLAYS · perfil "${name}" guardado`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }

  // Cargar = aplicar el layout del perfil, con la MISMA red que el detach: el
  // snapshot vuelve con la cuenta regresiva, y si no confirmás vuelve solo.
  async function loadProfileFlow(name) {
    if (state.displaysBusy || state.displaysPending) return;
    hideProfileConfirm();
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    renderProfiles();
    blip(660, 0.06);
    setStatus(`DISPLAYS · cargando "${name}"…`, { force: true });
    try {
      applyDisplaysSnapshot(await invoke('displays_load_profile', { name }));
    } catch (err) {
      try { await loadDisplays(); } catch (_) {}
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  function deleteProfileFlow(name) {
    if (state.displaysBusy) return;
    askProfileConfirm({ type: 'delete', name }, `¿Borrar el perfil "${name}"? No se puede deshacer.`);
  }

  async function doDeleteProfile(name) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      const profiles = await invoke('displays_delete_profile', { name });
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
      setStatus(`DISPLAYS · perfil "${name}" borrado`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }

  // --- Displays v2, Fase 1: actualizar perfil + atajos ----------------------

  // "↻ actualizar": pisar el perfil con el layout actual. Es tu dato → se pide
  // OK por el mismo banner que el guardado, y se reusa doSaveProfile (upsert por
  // nombre exacto).
  function updateProfileFlow(name) {
    if (state.displaysBusy || state.displaysPending) return;
    askProfileConfirm(
      { type: 'overwrite', name },
      `Pisar "${name}" con el layout actual (monitores, posiciones y primario de ahora).`
    );
  }

  // Captura de un atajo: al clickear el botón se escucha el próximo keydown y se
  // arma el accelerator ("Ctrl+Shift+1"). Requiere al menos un modificador
  // (Ctrl/Shift/Alt). Esc cancela; Supr/Backspace borra el atajo del perfil.
  function startShortcutCapture(name) {
    if (state.displaysBusy) return;
    cancelShortcutCapture(); // por si había otra fila capturando
    shortcutCaptureName = name;
    if (displaysProfilesList) {
      // Buscar la fila por dataset.name (no por selector con el valor inyectado).
      const li = Array.from(displaysProfilesList.querySelectorAll('li.displays-profile-item'))
        .find((x) => x.dataset && x.dataset.name === name);
      const btn = li ? li.querySelector('.displays-profile-shortcut') : null;
      if (btn) { btn.textContent = '⌨ apretá teclas…'; btn.classList.add('capturing'); }
    }
    setStatus('DISPLAYS · apretá una combinación con Ctrl/Shift/Alt · Supr borra · Esc cancela', { force: true, ttl: 8000 });
    shortcutKeyHandler = onShortcutCaptureKey;
    document.addEventListener('keydown', shortcutKeyHandler, true);
  }

  function cancelShortcutCapture() {
    if (shortcutKeyHandler) {
      document.removeEventListener('keydown', shortcutKeyHandler, true);
      shortcutKeyHandler = null;
    }
    const wasCapturing = shortcutCaptureName !== null;
    shortcutCaptureName = null;
    // Restaurar el texto del botón desde el estado (limpia la clase 'capturing').
    if (wasCapturing) renderProfiles();
  }

  function onShortcutCaptureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    const key = e.key;
    if (key === 'Escape') {
      cancelShortcutCapture();
      setStatus('DISPLAYS · captura cancelada', { ttl: 2500 });
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      const name = shortcutCaptureName;
      cancelShortcutCapture();
      if (name) clearShortcut(name);
      return;
    }
    // Un modificador suelto no cierra la captura: se espera una tecla real.
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.shiftKey) mods.push('Shift');
    if (e.altKey) mods.push('Alt');
    if (mods.length === 0) {
      setStatus('DISPLAYS · usá al menos Ctrl, Shift o Alt', { priority: 'warn', ttl: 3000 });
      return; // se sigue capturando
    }
    const token = accelKeyToken(e);
    if (!token) {
      setStatus('DISPLAYS · esa tecla no sirve (usá letras, números o F1–F24)', { priority: 'warn', ttl: 3500 });
      return; // se sigue capturando
    }
    const accelerator = mods.concat(token).join('+');
    const name = shortcutCaptureName;
    cancelShortcutCapture();
    if (name) assignShortcut(name, accelerator);
  }

  // Traduce el keydown a un token que el parser de Tauri acepta ("A","1","F1"…).
  // Se usa e.code (físico) para no depender del layout de teclado.
  function accelKeyToken(e) {
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);       // KeyA -> A
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);     // Digit1 -> 1
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;  // F1..F24
    return null;
  }

  async function assignShortcut(name, accelerator) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      const profiles = await invoke('displays_set_profile_shortcut', { name, accelerator });
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
      setStatus(`DISPLAYS · atajo ${accelerator} → "${name}"`, { force: true });
    } catch (err) {
      // Conflicto (la combinación la usa otro programa) o inválida: el backend
      // ya deshizo el guardado; acá solo se avisa.
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }

  async function clearShortcut(name) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    renderProfiles();
    try {
      const profiles = await invoke('displays_clear_profile_shortcut', { name });
      state.displaysProfiles = Array.isArray(profiles) ? profiles : [];
      setStatus(`DISPLAYS · atajo de "${name}" borrado`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      renderProfiles();
    }
  }

  // --- Fase 3: ajustes ------------------------------------------------------

  // Rellena el <select> del perfil de arranque desde la lista de perfiles, sin
  // innerHTML (createElement + textContent). Preserva la selección si el perfil
  // sigue existiendo; si no, cae a "ninguno".
  function populateStartupOptions() {
    if (!displaysStartupSelect) return;
    const current = displaysStartupSelect.value;
    const profiles = Array.isArray(state.displaysProfiles) ? state.displaysProfiles : [];
    displaysStartupSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— ninguno —';
    displaysStartupSelect.appendChild(none);
    profiles.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      displaysStartupSelect.appendChild(opt);
    });
    displaysStartupSelect.value = profiles.some((p) => p.name === current) ? current : '';
  }

  async function loadSettings() {
    if (displaysError) displaysError.hidden = true;
    displaysSettingsLoaded = false; // hasta poblar, saveSettings NO debe correr
    // El selector de startup necesita la lista de perfiles: se pide si no está.
    if (state.displaysProfiles === null) { try { await loadProfiles(); } catch (_) {} }
    populateStartupOptions();
    try {
      const settings = await invoke('displays_get_settings');
      const secs = Number(settings && settings.revertTimeoutSecs);
      if (displaysRevertSecsInput && Number.isFinite(secs)) displaysRevertSecsInput.value = String(secs);
      const startup = settings && settings.startupProfileName;
      if (displaysStartupSelect) displaysStartupSelect.value = (typeof startup === 'string') ? startup : '';
      const shortcutsOn = !!(settings && settings.globalShortcutsEnabled);
      if (displaysShortcutsToggle) displaysShortcutsToggle.checked = shortcutsOn;
      if (displaysShortcutsToggleLabel) displaysShortcutsToggleLabel.textContent = shortcutsOn ? 'ON' : 'OFF';
      displaysSettingsLoaded = true; // ahora sí: los controles reflejan el backend
    } catch (err) {
      showDisplaysError(err);
    }
  }

  // Guarda LOS TRES ajustes juntos (plazo + perfil de arranque + interruptor de
  // atajos). Se manda siempre el objeto completo para no pisar dato del usuario
  // con un default; el backend preserva el resto (mapa de atajos, bases, etc.).
  async function saveSettings() {
    // No guardar hasta que loadSettings haya poblado los controles: si no, se
    // mandarían los defaults vacíos y se borraría el perfil de arranque (dato del
    // usuario). Y no reentrar mientras hay un guardado en vuelo.
    if (state.displaysBusy || !displaysSettingsLoaded) return;
    const raw = Number(displaysRevertSecsInput && displaysRevertSecsInput.value);
    if (!Number.isFinite(raw)) {
      setStatus('DISPLAYS · el plazo tiene que ser un número', { priority: 'warn', ttl: 4000 });
      return;
    }
    // El backend igual pone un piso de 1s; acá se acota a un rango con sentido.
    const secs = Math.min(120, Math.max(3, Math.round(raw)));
    const startupProfileName = (displaysStartupSelect && displaysStartupSelect.value) || null;
    const globalShortcutsEnabled = !!(displaysShortcutsToggle && displaysShortcutsToggle.checked);
    state.displaysBusy = true;
    // Desactivar los tres controles durante el round-trip: cierra la carrera de
    // tocar otro control (o el mismo dos veces) antes de que el guardado vuelva.
    if (displaysSettingsSaveBtn) displaysSettingsSaveBtn.disabled = true;
    if (displaysStartupSelect) displaysStartupSelect.disabled = true;
    if (displaysShortcutsToggle) displaysShortcutsToggle.disabled = true;
    try {
      const settings = await invoke('displays_update_settings', {
        settings: { revertTimeoutSecs: secs, startupProfileName, globalShortcutsEnabled },
      });
      const saved = Number(settings && settings.revertTimeoutSecs);
      const shown = Number.isFinite(saved) ? saved : secs;
      if (displaysRevertSecsInput) displaysRevertSecsInput.value = String(shown);
      // Reflejar lo que quedó (el backend normaliza startup vacío → null).
      const savedStartup = settings && settings.startupProfileName;
      if (displaysStartupSelect) displaysStartupSelect.value = (typeof savedStartup === 'string') ? savedStartup : '';
      const savedShortcuts = !!(settings && settings.globalShortcutsEnabled);
      if (displaysShortcutsToggle) displaysShortcutsToggle.checked = savedShortcuts;
      if (displaysShortcutsToggleLabel) displaysShortcutsToggleLabel.textContent = savedShortcuts ? 'ON' : 'OFF';
      setStatus('DISPLAYS · ajustes guardados', { force: true });
    } catch (err) {
      showDisplaysError(err);
      // Falló el guardado: recargar la verdad para que los controles (y el label
      // ON/OFF) no queden divergentes de lo que quedó en disco.
      try { await loadSettings(); } catch (_) {}
    } finally {
      state.displaysBusy = false;
      if (displaysSettingsSaveBtn) displaysSettingsSaveBtn.disabled = false;
      if (displaysStartupSelect) displaysStartupSelect.disabled = false;
      if (displaysShortcutsToggle) displaysShortcutsToggle.disabled = false;
    }
  }

  // --- Fase 3: lienzo de arrastre (opción A — espejo de Windows) ------------

  function monKey(m) { return `${m.adapterLuid}:${m.targetId}`; }

  // El borrador arranca de los monitores ACTIVOS del snapshot, con su posición
  // actual. Solo se acomodan los activos (los apagados no tienen lugar).
  function initCanvasDraft() {
    const active = (state.displays || []).filter((d) => d.active);
    state.displaysDraft = active.map((d) => ({
      adapterLuid: d.adapterLuid,
      targetId: d.targetId,
      name: d.name,
      primary: !!d.primary,
      w: d.width > 0 ? d.width : 1920,
      h: d.height > 0 ? d.height : 1080,
      x: Number.isFinite(d.positionX) ? d.positionX : 0,
      y: Number.isFinite(d.positionY) ? d.positionY : 0,
    }));
    canvasDirty = false;
  }

  function positionCanvasMonitor(div, m) {
    if (!canvasView) return;
    const { scale, minX, minY, offsetX, offsetY } = canvasView;
    div.style.left = `${offsetX + (m.x - minX) * scale}px`;
    div.style.top = `${offsetY + (m.y - minY) * scale}px`;
    div.style.width = `${Math.max(8, m.w * scale)}px`;
    div.style.height = `${Math.max(8, m.h * scale)}px`;
  }

  function renderCanvas() {
    if (!displaysCanvas) return;
    const mons = state.displaysDraft || [];
    const busy = !!state.displaysBusy;
    const pending = !!state.displaysPending;
    if (displaysCanvasApplyBtn) displaysCanvasApplyBtn.disabled = busy || pending || mons.length === 0;
    if (displaysCanvasResetBtn) displaysCanvasResetBtn.disabled = busy || mons.length === 0;
    if (displaysCanvasEmpty) displaysCanvasEmpty.hidden = mons.length > 0;
    if (mons.length === 0) { displaysCanvas.replaceChildren(); canvasView = null; return; }

    const pad = 16;
    const cw = displaysCanvas.clientWidth || 400;
    const chh = displaysCanvas.clientHeight || 240;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    mons.forEach((m) => {
      minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.w); maxY = Math.max(maxY, m.y + m.h);
    });
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const availW = Math.max(1, cw - 2 * pad);
    const availH = Math.max(1, chh - 2 * pad);
    const scale = Math.min(availW / bw, availH / bh);
    const offsetX = pad + (availW - bw * scale) / 2;
    const offsetY = pad + (availH - bh * scale) / 2;
    canvasView = { scale, minX, minY, offsetX, offsetY };

    const nodes = mons.map((m) => {
      const div = document.createElement('div');
      div.className = 'displays-canvas-monitor' + (m.primary ? ' is-primary' : '');
      div.dataset.mon = monKey(m);
      positionCanvasMonitor(div, m);
      // textContent, nunca innerHTML: el nombre viene del backend.
      const label = document.createElement('div');
      label.className = 'displays-canvas-label';
      label.textContent = m.name;
      const meta = document.createElement('div');
      meta.className = 'displays-canvas-meta mono';
      meta.textContent = `${m.w}×${m.h}${m.primary ? ' · P' : ''}`;
      div.appendChild(label);
      div.appendChild(meta);
      return div;
    });
    displaysCanvas.replaceChildren(...nodes);
  }

  function onCanvasMouseDown(e) {
    const div = e.target && e.target.closest ? e.target.closest('.displays-canvas-monitor') : null;
    if (!div || state.displaysBusy || state.displaysPending || !canvasView) return;
    const key = div.dataset.mon;
    const m = (state.displaysDraft || []).find((x) => monKey(x) === key);
    if (!m) return;
    e.preventDefault();
    canvasDrag = {
      m, div,
      startX: e.clientX, startY: e.clientY,
      origX: m.x, origY: m.y,
      scale: canvasView.scale,
    };
    div.classList.add('is-dragging');
    document.addEventListener('mousemove', onCanvasMouseMove);
    document.addEventListener('mouseup', onCanvasMouseUp);
  }

  function onCanvasMouseMove(e) {
    if (!canvasDrag) return;
    const { m, div, startX, startY, origX, origY, scale } = canvasDrag;
    // Píxeles de pantalla → coordenadas virtuales, con la escala CONGELADA al
    // empezar el arrastre (no se re-renderiza, así no rescala bajo el cursor).
    m.x = Math.round(origX + (e.clientX - startX) / scale);
    m.y = Math.round(origY + (e.clientY - startY) / scale);
    canvasDirty = true;
    positionCanvasMonitor(div, m);
  }

  function onCanvasMouseUp() {
    document.removeEventListener('mousemove', onCanvasMouseMove);
    document.removeEventListener('mouseup', onCanvasMouseUp);
    if (!canvasDrag) return;
    const { m, div } = canvasDrag;
    div.classList.remove('is-dragging');
    canvasDrag = null;
    snapMonitor(m);   // pegar al borde de un vecino, sin huecos ni superposición
    renderCanvas();   // recomputa escala/centro con la posición final
  }

  function nearest(v, opts) {
    let best = opts[0], bestD = Infinity;
    opts.forEach((o) => { const d = Math.abs(o - v); if (d < bestD) { bestD = d; best = o; } });
    return best;
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    // Tocarse por el borde (ax+aw === bx) NO es superponerse.
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // Opción A: al soltar, el monitor se pega flush al borde de algún vecino y se
  // alinea en el eje perpendicular, eligiendo la ubicación más cercana a donde
  // se lo soltó y que no se superponga con nadie.
  function snapMonitor(dragged) {
    const others = (state.displaysDraft || []).filter((x) => x !== dragged);
    if (!others.length) return;
    const dropX = dragged.x, dropY = dragged.y;
    const candidates = [];
    others.forEach((o) => {
      const alignY = nearest(dropY, [o.y, o.y + o.h - dragged.h]);
      const alignX = nearest(dropX, [o.x, o.x + o.w - dragged.w]);
      candidates.push({ x: o.x + o.w, y: alignY });        // a la derecha de O
      candidates.push({ x: o.x - dragged.w, y: alignY });  // a la izquierda
      candidates.push({ x: alignX, y: o.y + o.h });        // abajo
      candidates.push({ x: alignX, y: o.y - dragged.h });  // arriba
    });
    const valid = candidates.filter((c) =>
      !others.some((o) => rectsOverlap(c.x, c.y, dragged.w, dragged.h, o.x, o.y, o.w, o.h))
    );
    const pool = valid.length ? valid : candidates;
    let best = pool[0], bestD = Infinity;
    pool.forEach((c) => {
      const d = Math.hypot(c.x - dropX, c.y - dropY);
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best) { dragged.x = best.x; dragged.y = best.y; }
  }

  function canvasResetDraft() {
    if (state.displaysBusy) return;
    initCanvasDraft();
    renderCanvas();
    setStatus('DISPLAYS · acomodo deshecho', { force: true });
  }

  // APLICAR: el acomodo es un SetDisplayConfig, así que vuelve con la misma red
  // (cuenta regresiva + auto-revert) que el toggle o el cargar perfil.
  async function canvasApplyFlow() {
    if (state.displaysBusy || state.displaysPending) return;
    const mons = state.displaysDraft || [];
    if (!mons.length) return;
    const positions = mons.map((m) => ({
      adapterLuid: m.adapterLuid, targetId: m.targetId, x: m.x, y: m.y,
    }));
    // Se manda al sistema: deja de ser una edición local suelta. Así, cuando la
    // confirmación se resuelva, el lienzo re-sincroniza con la realidad.
    canvasDirty = false;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    refreshDisplaysUi();
    blip(660, 0.06);
    setStatus('DISPLAYS · aplicando el acomodo…', { force: true });
    try {
      applyDisplaysSnapshot(await invoke('displays_apply_layout', { positions }));
    } catch (err) {
      try { await loadDisplays(); } catch (_) {}
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  // Displays v2 Fase 2: cambiar de sección de nivel superior. OCULTA (no
  // desmonta) cada sección por CSS → un transfer en curso del clipboard
  // sobrevive el ida y vuelta. El reloj de un pending corre independiente de la
  // sección (banner global), así que salir de Displays NO lo frena.
  function switchSection(section) {
    if (section !== 'clipboard' && section !== 'displays') return;
    if (section === 'displays' && !displaysEnabled) return; // Android: no existe
    if (state.section === section) return;                  // ya estás ahí
    state.section = section;
    // Color por app (SPEC-shell): marca el acento activo en <body> → el chrome y
    // el bloque Displays viran cyan⇄violeta por CSS (var(--app-accent)). El boot
    // no pasa por acá (early-return), pero no hace falta: sin data-app, :root ya
    // da cyan (Clipboard). Al volver a 'clipboard', data-app deja de matchear la
    // regla violeta y cae al cyan de :root.
    document.body.dataset.app = section;
    const showDisplays = section === 'displays';
    if (clipboardSectionEl) clipboardSectionEl.hidden = showDisplays;
    if (displaysSectionEl) displaysSectionEl.hidden = !showDisplays;
    hudSectionBtns.forEach((b) => {
      const active = b.dataset.section === section;
      b.classList.toggle('is-active', active);
      // role="tab" del switch → mantener aria-selected en sync para lectores de
      // pantalla (SPEC-shell: si no, anuncian "pestaña" pero nunca "seleccionada").
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (showDisplays) enterDisplaysSection();
    else leaveDisplaysSection();
  }

  async function enterDisplaysSection() {
    if (!displaysSectionEl) return;
    if (!displaysSectionMounted) {
      // Reseteo de montaje (una sola vez, o al arrancar): vaciar la lista,
      // olvidar perfiles/ajustes cacheados y el borrador del lienzo, y arrancar
      // en la sub-pestaña activa (state.displaysTab; 'list' al arrancar). En
      // re-entradas NO se resetea: se conserva la sub-pestaña donde estabas
      // (criterio #3). Vaciar antes del await: si no, se verían los monitores
      // del snapshot anterior como si fueran los de ahora.
      displaysSectionMounted = true;
      state.displays = [];
      renderDisplays();
      state.displaysProfiles = null;
      if (displaysProfilesList) displaysProfilesList.replaceChildren();
      if (displaysProfileName) displaysProfileName.value = '';
      displaysSettingsLoaded = false; // AJUSTES se re-carga al entrar a su pestaña
      hideProfileConfirm();
      state.displaysDraft = [];
      canvasDirty = false;
      canvasDrag = null;
      switchDisplaysTab(state.displaysTab || 'list');
      if (displaysCount) displaysCount.textContent = 'LEYENDO…';
      // renderDisplays() con la lista vacia prende el "Sin monitores"; durante la
      // lectura todavia no sabemos eso.
      if (displaysEmpty) displaysEmpty.hidden = true;
    }
    // load-on-enter-section: releer el snapshot cada vez que entrás (acción del
    // usuario; la enumeración nunca corre sola). El reloj de un pending ya está
    // corriendo si corresponde, independiente de la sección, y loadDisplays lo
    // reconcilia con el número del backend.
    // NO focusFirstControl a ciegas: si hay un cambio pendiente, el foco va a
    // CONFIRMAR (en el banner global); si no, a REFRESH.
    const firstFocus = (state.displaysPending && displaysConfirmBtn) ? displaysConfirmBtn : displaysRefreshBtn;
    if (firstFocus) firstFocus.focus();
    else if (displaysSectionEl) focusFirstControl(displaysSectionEl);
    await loadDisplays();
  }

  function leaveDisplaysSection() {
    // Salir de la sección NO frena el reloj del pending: el banner global lo
    // sigue mostrando desde Clipboard (por eso NO se llama stopDisplaysCountdown).
    // Solo se corta una captura de atajo a medias, que depende del teclado.
    cancelShortcutCapture();
  }

  // #displays-close ya no existe (switch) y REFRESH se maneja por el dispatch
  // genérico de .hud-btn (data-action="displays-refresh", más abajo el blip ya lo
  // hace ese handler). Acá quedan solo CONFIRMAR/REVERTIR del banner global.
  if (displaysConfirmBtn) {
    displaysConfirmBtn.addEventListener('click', () => {
      blip(1100, 0.05);
      resolveDisplaysPending('displays_confirm', 'cambio confirmado');
    });
  }
  if (displaysRevertBtn) {
    displaysRevertBtn.addEventListener('click', () => {
      blip(440, 0.08);
      resolveDisplaysPending('displays_revert', 'cambio revertido');
    });
  }
  // Delegacion: el listener vive en la <ul>, no en cada boton. Con render por
  // diff las filas se reusan y se borran solas; enganchar por fila seria
  // acumular listeners o perderlos.
  if (displaysList) {
    displaysList.addEventListener('click', (e) => {
      const el = e.target;
      if (!el || !el.closest) return;
      const li = el.closest('.display-item');
      const id = li && li.dataset ? li.dataset.id : null;
      if (!id) return;
      const toggleBtn = el.closest('.display-toggle-btn');
      const primBtn = el.closest('.display-primary-btn');
      if (toggleBtn && !toggleBtn.disabled) toggleDisplay(id);
      else if (primBtn && !primBtn.disabled) setPrimaryDisplay(id);
    });
  }

  // --- Fase 3: pestañas, perfiles y ajustes --------------------------------
  if (displaysTabs) {
    displaysTabs.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.displays-tab') : null;
      if (!btn || !btn.dataset.tab) return;
      blip(720, 0.04);
      switchDisplaysTab(btn.dataset.tab);
    });
  }
  if (displaysSaveProfileBtn) {
    displaysSaveProfileBtn.addEventListener('click', () => { blip(880, 0.05); saveProfileFlow(); });
  }
  if (displaysProfileName) {
    displaysProfileName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveProfileFlow(); }
    });
  }
  if (displaysProfileConfirmYes) {
    displaysProfileConfirmYes.addEventListener('click', () => { blip(1100, 0.05); runPendingProfileAction(); });
  }
  if (displaysProfileConfirmNo) {
    displaysProfileConfirmNo.addEventListener('click', () => { blip(440, 0.06); hideProfileConfirm(); });
  }
  // Delegacion en la lista de perfiles: CARGAR / BORRAR.
  if (displaysProfilesList) {
    displaysProfilesList.addEventListener('click', (e) => {
      const el = e.target;
      if (!el || !el.closest) return;
      const li = el.closest('.displays-profile-item');
      const name = li && li.dataset ? li.dataset.name : null;
      if (!name) return;
      // Fase 4: el editor de escena tiene sus propios botones (toggle, chips,
      // form). Si el clic fue en uno de ellos, lo consume y no sigue.
      if (handleSceneClick(el, li, name)) return;
      const loadBtn = el.closest('.displays-profile-load');
      const delBtn = el.closest('.displays-profile-delete');
      const updateBtn = el.closest('.displays-profile-update');
      const scBtn = el.closest('.displays-profile-shortcut');
      if (loadBtn && !loadBtn.disabled) loadProfileFlow(name);
      else if (delBtn && !delBtn.disabled) deleteProfileFlow(name);
      else if (updateBtn && !updateBtn.disabled) updateProfileFlow(name);
      else if (scBtn && !scBtn.disabled) startShortcutCapture(name);
    });
    // Los <select> emiten 'change', no 'click': listener aparte para el audio y
    // para el preset de escena (Fase 4).
    displaysProfilesList.addEventListener('change', (e) => {
      const el = e.target;
      if (!el || !el.classList) return;
      const li = el.closest && el.closest('.displays-profile-item');
      const name = li && li.dataset ? li.dataset.name : null;
      if (!name) return;
      if (el.classList.contains('displays-profile-audio-select')) {
        setProfileAudioFlow(name, el.value);
      } else if (el.classList.contains('displays-scene-preset')) {
        const col = el.closest('.displays-scene-col');
        const preset = el.value;
        el.value = ''; // resetear el select al placeholder
        if (col && preset) handleScenePreset(li, col, preset);
      }
    });
  }
  if (displaysSettingsSaveBtn) {
    displaysSettingsSaveBtn.addEventListener('click', () => { blip(880, 0.05); saveSettings(); });
  }
  if (displaysRevertSecsInput) {
    displaysRevertSecsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveSettings(); }
    });
  }
  // Displays v2, Fase 1: el selector de startup y el interruptor de atajos
  // guardan al cambiar (no tienen botón GUARDAR propio).
  if (displaysStartupSelect) {
    displaysStartupSelect.addEventListener('change', () => { blip(720, 0.04); saveSettings(); });
  }
  if (displaysShortcutsToggle) {
    displaysShortcutsToggle.addEventListener('change', () => {
      blip(720, 0.04);
      // Reflejar el ON/OFF ya mismo, así el label y el checkbox nunca se
      // contradicen aunque saveSettings se descarte; saveSettings lo re-confirma
      // con lo que devuelve el backend.
      if (displaysShortcutsToggleLabel) {
        displaysShortcutsToggleLabel.textContent = displaysShortcutsToggle.checked ? 'ON' : 'OFF';
      }
      saveSettings();
    });
  }
  // Lienzo: arrastre (delegado en el contenedor) + APLICAR / DESHACER.
  if (displaysCanvas) displaysCanvas.addEventListener('mousedown', onCanvasMouseDown);
  if (displaysCanvasApplyBtn) {
    displaysCanvasApplyBtn.addEventListener('click', () => { blip(880, 0.05); canvasApplyFlow(); });
  }
  if (displaysCanvasResetBtn) {
    displaysCanvasResetBtn.addEventListener('click', () => { blip(440, 0.06); canvasResetDraft(); });
  }

  // Displays ya NO es un modal con backdrop → no hay "clic afuera" que cerrar.

  // Close any modal on ESC (defensive layer in case a stray JS error elsewhere
  // skips listeners). Displays es una SECCIÓN, no un modal: ESC la devuelve a
  // Clipboard — pero SOLO si no había un modal encima (si lo había, ESC ya lo
  // cerró). Nunca deja la pantalla en blanco (criterio #8).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      let modalClosed = false;
      if (!appSettingsModal.hidden) { closeAppSettingsModal(); modalClosed = true; }
      if (!clipboardSettingsModal.hidden) { closeClipboardSettingsModal(); modalClosed = true; }
      if (!incomingModal.hidden) { closeIncomingModal(); modalClosed = true; }
      if (!addPeerModal.hidden) { closeAddPeerModal(); modalClosed = true; }
      if (!peerDetailsModal.hidden) { closePeerDetailsModal(); modalClosed = true; }
      if (logModal && !logModal.hidden) { closeLogModal(); modalClosed = true; }
      if (qrModal && !qrModal.hidden) { closeQrModal(); modalClosed = true; }
      if (!modalClosed && state.section === 'displays') switchSection('clipboard');
    }
  });
