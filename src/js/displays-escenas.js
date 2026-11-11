// Millennium Clipboard // GRID — frontend. Displays (2/2): pestaña ESCENAS (lista de tarjetas), atajos, ajustes, lienzo y conexión de eventos. Ojo: al final está el ESC global que cierra los modales de Clipboard.
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
// El editor en borrador de una escena vive en displays-editor.js.
'use strict';

  // ── Pestaña ESCENAS: lista de tarjetas (contrato: tools/ui-capturas/contrato-escenas.md) ──

  let scenesData = null;          // SceneView[] de displays_list_scenes; null = todavía no cargadas
  let scenesShortcutsOn = true;   // interruptor general de atajos (AJUSTES), para el chip "(apagado)"
  let scenesListenerReady = false;
  let sceneDragName = null;       // tarjeta que se está arrastrando
  // Estado de UI de la lista; sobrevive al re-render por diff.
  const scenesUi = { menu: null, rename: null, confirmDel: null, confirmUpd: null, chooser: null };

  // Helper mínimo: todo texto entra por textContent (CLAUDE.md regla 6).
  function mkEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function mkBtn(cls, text, title) {
    const b = mkEl('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }

  // Por qué no se puede tocar algo, en texto visible (no en un tooltip). null = se puede.
  function sceneBlockReason() {
    if (!state.displaysPending) return null;
    return displaysPendingIsTest
      ? 'esperando que confirmes la prueba'
      : 'Hay un cambio esperando confirmación.';
  }

  // Etiqueta legible de una acción (ActionV2) para el chip.
  function actionLabelV2(a, outputs) {
    if (!a || typeof a !== 'object') return '?';
    if (a.tipo === 'volumen') return `🔊 Volumen ${a.nivel}%`;
    if (a.tipo === 'cerrar') return `✕ Cerrar ${a.exe}`;
    if (a.tipo === 'esperar') return `⏳ Esperar ${a.segundos} s`;
    if (a.tipo === 'hdr') {
      const o = (outputs || []).find((x) => x.displayId === a.pantalla);
      return `🌈 HDR ${o ? o.name : 'una pantalla'}: ${a.prender ? 'prender' : 'apagar'}`;
    }
    if (a.tipo === 'lanzar') {
      const d = String(a.destino || '');
      const low = d.toLowerCase();
      const et = typeof a.etiqueta === 'string' ? a.etiqueta : '';
      if (low.includes('steam://open/bigpicture')) return '🎮 Big Picture';
      if (low.includes('steam://close/bigpicture')) return '⏹ Cerrar Big Picture';
      const game = low.match(/steam:\/\/rungameid\/(\d+)/);
      if (game) return `🎮 Juego: ${et || game[1]}`;
      if (low.includes('chrome')) {
        if (et) return `🌐 ${et}`;
        const args = Array.isArray(a.args) ? a.args : [];
        const pd = args.find((x) => typeof x === 'string' && x.startsWith('--profile-directory='));
        return pd ? `🌐 Chrome · ${pd.slice('--profile-directory='.length)}` : '🌐 Chrome';
      }
      return `▶ ${et || d.split(/[\\/]/).pop() || d}`;
    }
    return '❔ acción que esta versión no conoce';
  }

  const SCENE_DEFAULT_W = 1920;
  const SCENE_DEFAULT_H = 1080;

  // Mini-mapa de pantallas: prendida / apagada (punteada) / principal (marcada).
  function buildMiniMap(outputs, boxW, boxH) {
    const wrap = mkEl('div', 'scene-mini');
    wrap.style.width = `${boxW}px`;
    wrap.style.height = `${boxH}px`;
    const list = (outputs || []).map((o) => ({
      o, x: o.x || 0, y: o.y || 0, w: o.width || SCENE_DEFAULT_W, h: o.height || SCENE_DEFAULT_H,
    }));
    if (!list.length) return wrap;
    const x0 = Math.min(...list.map((b) => b.x));
    const y0 = Math.min(...list.map((b) => b.y));
    const x1 = Math.max(...list.map((b) => b.x + b.w));
    const y1 = Math.max(...list.map((b) => b.y + b.h));
    const pad = 6;
    const f = Math.min((boxW - pad * 2) / (x1 - x0), (boxH - pad * 2) / (y1 - y0));
    const ox = (boxW - (x1 - x0) * f) / 2;
    const oy = (boxH - (y1 - y0) * f) / 2;
    list.forEach((b) => {
      const i = mkEl('i', `${b.o.enabled ? '' : 'off '}${b.o.enabled && b.o.primary ? 'pri' : ''}`.trim());
      i.title = b.o.name;
      i.style.left = `${Math.round(ox + (b.x - x0) * f)}px`;
      i.style.top = `${Math.round(oy + (b.y - y0) * f)}px`;
      i.style.width = `${Math.max(3, Math.round(b.w * f))}px`;
      i.style.height = `${Math.max(3, Math.round(b.h * f))}px`;
      wrap.appendChild(i);
    });
    return wrap;
  }

  function sceneSentence(outputs) {
    const on = outputs.filter((o) => o.enabled).map((o) => o.name);
    const off = outputs.filter((o) => !o.enabled).map((o) => o.name);
    const pri = outputs.find((o) => o.enabled && o.primary);
    return `Prende: ${on.join(', ') || 'nada'} · Apaga: ${off.join(', ') || 'nada'} · Principal: ${pri ? pri.name : '—'}`;
  }

  function sceneChips(s) {
    const chips = [];
    chips.push({ text: s.audio ? `🔊 ${s.audio.friendlyName}` : '🔊 Audio: no toca' });
    if (s.shortcut) chips.push({ text: `⌨ ${s.shortcut}${scenesShortcutsOn ? '' : ' (apagado)'}` });
    const entrada = (s.entradaV2 || []).map((a) => actionLabelV2(a, s.outputs));
    const salida = (s.salidaV2 || []).map((a) => actionLabelV2(a, s.outputs));
    if (entrada.length) chips.push({ text: `🎬 Al entrar: ${entrada.join(' · ')}` });
    if (salida.length) chips.push({ text: `🎬 Al salir: ${salida.join(' · ')}` });
    if (s.startup) chips.push({ text: '⏻ arranca con Windows', good: true });
    return chips;
  }

  function buildSceneCard(s) {
    const li = mkEl('li', 'scene-card');
    li.dataset.name = s.name;
    li.innerHTML = `
      <span class="scene-handle" title="Arrastrá para ordenar">⠿</span>
      <div class="scene-ico"></div>
      <div class="scene-mini-slot"></div>
      <div class="scene-info">
        <div class="scene-name"><span class="scene-name-text"></span><span class="scene-badge" hidden>PUESTA AHORA</span></div>
        <div class="scene-sentence mono"></div>
        <div class="scene-chips"></div>
      </div>
      <div class="scene-acts">
        <button class="modal-btn small accept scene-apply" type="button">APLICAR</button>
        <div class="scene-acts-row">
          <button class="modal-btn small scene-edit" type="button">EDITAR</button>
          <button class="modal-btn small scene-more" type="button" title="Más opciones">⋯</button>
        </div>
        <div class="scene-moves">
          <button class="modal-btn small scene-up" type="button" title="Subir">↑</button>
          <button class="modal-btn small scene-down" type="button" title="Bajar">↓</button>
        </div>
        <p class="mono scene-reason" hidden></p>
      </div>
      <div class="scene-menu" hidden></div>
      <div class="scene-inline" hidden></div>`;
    li.addEventListener('mousedown', (e) => {
      // Solo se arrastra desde el asa ⠿.
      li.draggable = !!(e.target.closest && e.target.closest('.scene-handle'));
    });
    updateSceneCard(li, s, 0, 1);
    return li;
  }

  function updateSceneCard(li, s, idx, total) {
    const busy = !!state.displaysBusy;
    const reason = sceneBlockReason();
    const locked = busy || !!reason;
    li.classList.toggle('is-current', !!s.isCurrent);
    setText(li.querySelector('.scene-ico'), s.emoji || '▫');
    setText(li.querySelector('.scene-name-text'), s.name);
    li.querySelector('.scene-badge').hidden = !s.isCurrent;
    setText(li.querySelector('.scene-sentence'), sceneSentence(s.outputs || []));
    li.querySelector('.scene-mini-slot').replaceChildren(buildMiniMap(s.outputs, 160, 70));
    li.querySelector('.scene-chips').replaceChildren(...sceneChips(s).map((c) => mkEl('span', c.good ? 'scene-chip good' : 'scene-chip', c.text)));

    const apply = li.querySelector('.scene-apply');
    apply.disabled = locked || !!s.isCurrent;
    apply.textContent = s.isCurrent ? 'PUESTA' : 'APLICAR';
    li.querySelector('.scene-edit').disabled = busy;
    li.querySelector('.scene-more').disabled = locked;
    li.querySelector('.scene-up').disabled = locked || idx === 0;
    li.querySelector('.scene-down').disabled = locked || idx === total - 1;
    const why = li.querySelector('.scene-reason');
    why.hidden = !reason;
    why.textContent = reason || '';

    // Menú ⋯ y la línea de confirmación/renombrar junto a la tarjeta.
    const menu = li.querySelector('.scene-menu');
    const abierto = scenesUi.menu === s.name;
    menu.hidden = !abierto;
    if (abierto && !menu.firstChild) {
      menu.replaceChildren(
        mkBtn('modal-btn small scene-dup', 'DUPLICAR'),
        mkBtn('modal-btn small scene-rename', 'RENOMBRAR'),
        mkBtn('modal-btn small scene-upd', '↻ ACTUALIZAR CON LO PUESTO', 'Pisa solo las pantallas de esta escena con lo que está puesto ahora'),
        mkBtn('modal-btn small reject scene-del', 'BORRAR'));
    } else if (!abierto) {
      menu.replaceChildren();
    }
    menu.querySelectorAll('button').forEach((b) => { b.disabled = locked; });
    const inline = li.querySelector('.scene-inline');
    const modo = scenesUi.rename === s.name ? 'rename'
      : (scenesUi.confirmDel === s.name ? 'del' : (scenesUi.confirmUpd === s.name ? 'upd' : ''));
    inline.hidden = !modo;
    inline.classList.toggle('is-danger', modo === 'del' || modo === 'upd');
    if (inline.dataset.modo !== modo) {
      inline.dataset.modo = modo;
      inline.replaceChildren();
      if (modo === 'del') {
        inline.append(
          mkEl('span', 'scene-inline-text', `¿Borrar "${s.name}"? No se puede deshacer.`),
          mkBtn('modal-btn small reject scene-del-yes', 'SÍ, BORRAR'),
          mkBtn('modal-btn small scene-del-no', 'NO'));
      } else if (modo === 'upd') {
        inline.append(
          mkEl('span', 'scene-inline-text', `¿Pisar las pantallas de "${s.name}" con lo que está puesto ahora? El sonido, las acciones y el atajo no cambian.`),
          mkBtn('modal-btn small reject scene-upd-yes', 'SÍ, ACTUALIZAR'),
          mkBtn('modal-btn small scene-upd-no', 'NO'));
      } else if (modo === 'rename') {
        const inp = mkEl('input', 'scene-rename-input');
        inp.type = 'text';
        inp.maxLength = 60;
        inp.value = s.name;
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inline.append(inp,
          mkBtn('modal-btn small accept scene-rename-ok', 'RENOMBRAR'),
          mkBtn('modal-btn small scene-rename-no', 'CANCELAR'));
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      }
    }
    inline.querySelectorAll('button, input').forEach((b) => { b.disabled = locked; });
  }

  function renderSceneChooser() {
    if (!scenesChooser) return;
    const modo = scenesUi.chooser;
    scenesChooser.hidden = !modo;
    scenesChooser.replaceChildren();
    if (!modo) return;
    scenesChooser.appendChild(mkEl('b', 'scene-inline-text', '¿De dónde arranco?'));
    if (modo === 'open') {
      scenesChooser.append(
        mkBtn('modal-btn small scene-from-current', 'DE LO QUE ESTÁ PUESTO AHORA'),
        mkBtn('modal-btn small scene-from-copy', 'COPIA DE OTRA ESCENA…'),
        mkBtn('modal-btn small scene-from-blank', 'EN BLANCO'));
    } else {
      scenesChooser.appendChild(mkEl('span', 'scene-inline-text mono', 'Elegí cuál copiar:'));
      (scenesData || []).forEach((s) => {
        const b = mkBtn('modal-btn small scene-copy-pick', s.name);
        b.dataset.name = s.name;
        scenesChooser.appendChild(b);
      });
    }
    scenesChooser.appendChild(mkBtn('modal-btn small scene-chooser-close', 'CANCELAR'));
  }

  // Render por diff, como renderDisplays: se reusa el <li> por data-name.
  function renderScenes() {
    if (!scenesList || scenesData === null) return;
    const items = scenesData;
    const existing = new Map();
    Array.from(scenesList.querySelectorAll('li.scene-card')).forEach((li) => {
      if (li.dataset.name) existing.set(li.dataset.name, li);
    });
    const seen = new Set();
    items.forEach((s, idx) => {
      seen.add(s.name);
      try {
        let li = existing.get(s.name);
        if (li) updateSceneCard(li, s, idx, items.length);
        else { li = buildSceneCard(s); updateSceneCard(li, s, idx, items.length); }
        if (scenesList.children[idx] !== li) scenesList.insertBefore(li, scenesList.children[idx] || null);
      } catch (err) {
        console.error('[displays] escena malformada', err);
      }
    });
    existing.forEach((li, name) => { if (!seen.has(name)) li.remove(); });
    if (scenesEmpty) scenesEmpty.hidden = items.length > 0;
    if (scenesNewBtn) scenesNewBtn.disabled = !!state.displaysBusy;
    const reason = sceneBlockReason();
    if (scenesBlockReason) {
      scenesBlockReason.hidden = !reason;
      scenesBlockReason.textContent = reason || '';
    }
    renderSceneChooser();
  }

  async function loadScenes() {
    if (displaysError) displaysError.hidden = true;
    try {
      const [lista, ajustes] = await Promise.all([
        invoke('displays_list_scenes'),
        invoke('displays_get_settings').catch(() => null),
      ]);
      scenesData = Array.isArray(lista) ? lista : [];
      if (ajustes) scenesShortcutsOn = !!ajustes.globalShortcutsEnabled;
    } catch (err) {
      scenesData = [];
      showDisplaysError(err);
    }
    renderScenes();
  }

  // Un comando que escribe escenas devuelve ScenesResult: la lista queda al día.
  function takeScenesResult(res) {
    if (res && Array.isArray(res.scenes)) scenesData = res.scenes;
    if (res && Array.isArray(res.warnings)) {
      res.warnings.forEach((w) => setStatus(`DISPLAYS · ${w}`, { priority: 'warn', ttl: 9000 }));
    }
    return res;
  }

  // Corre un comando que toca escenas con el bloqueo de siempre (displaysBusy).
  async function sceneFlow(command, args, okMsg) {
    if (state.displaysBusy) return null;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    renderScenes();
    try {
      const res = takeScenesResult(await invoke(command, args));
      if (okMsg) setStatus(`DISPLAYS · ${typeof okMsg === 'function' ? okMsg(res) : okMsg}`, { force: true });
      return res || {};
    } catch (err) {
      showDisplaysError(err);
      return null;
    } finally {
      state.displaysBusy = false;
      renderScenes();
    }
  }

  // APLICAR = cargar el layout de la escena con la MISMA red que el detach: el
  // snapshot vuelve con la cuenta regresiva, y si no confirmás vuelve solo.
  async function applySceneFlow(name) {
    if (state.displaysBusy || state.displaysPending) return;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    renderScenes();
    blip(660, 0.06);
    setStatus(`DISPLAYS · aplicando "${name}"…`, { force: true });
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

  async function deleteSceneFlow(name) {
    if (state.displaysBusy) return; // la confirmación queda abierta: el botón está apagado y dice por qué
    state.displaysBusy = true;
    renderScenes();
    let borro = false;
    try {
      await invoke('displays_delete_profile', { name });
      borro = true;
      scenesUi.confirmDel = null;
      setStatus(`DISPLAYS · escena "${name}" borrada`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
    }
    // Si falló, el cartel de error se queda: no se relee la lista (eso lo escondería).
    if (borro) await loadScenes();
    else renderScenes();
  }

  // ↻ actualizar con lo puesto: pisa SOLO el layout de la escena (replace: true, contrato).
  async function updateSceneFlow(name) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    renderScenes();
    let ok = false;
    try {
      await invoke('displays_save_profile', { name, replace: true });
      ok = true;
      scenesUi.confirmUpd = null;
      setStatus(`DISPLAYS · "${name}" actualizada con lo que está puesto`, { force: true });
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
    }
    if (ok) await loadScenes();
    else renderScenes();
  }

  function reorderScene(name, delta) {
    const names = (scenesData || []).map((s) => s.name);
    const i = names.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    names.splice(j, 0, names.splice(i, 1)[0]);
    sceneFlow('displays_reorder_scenes', { names }, 'orden guardado');
  }

  function onScenesClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const li = t.closest('li.scene-card');
    const name = li && li.dataset ? li.dataset.name : null;
    if (!name) return;
    const hit = (sel) => { const b = t.closest(sel); return b && !b.disabled ? b : null; };
    if (hit('.scene-apply')) applySceneFlow(name);
    else if (hit('.scene-edit')) openSceneEditor({ from: 'scene', name });
    else if (hit('.scene-more')) {
      scenesUi.menu = scenesUi.menu === name ? null : name;
      scenesUi.rename = null; scenesUi.confirmDel = null; scenesUi.confirmUpd = null;
      renderScenes();
    } else if (hit('.scene-up')) reorderScene(name, -1);
    else if (hit('.scene-down')) reorderScene(name, 1);
    else if (hit('.scene-dup')) {
      scenesUi.menu = null;
      sceneFlow('displays_duplicate_scene', { name }, (r) => `escena duplicada: "${r.name}"`);
    } else if (hit('.scene-rename')) {
      scenesUi.menu = null; scenesUi.rename = name; scenesUi.confirmDel = null;
      renderScenes();
    } else if (hit('.scene-del')) {
      scenesUi.menu = null; scenesUi.confirmDel = name; scenesUi.rename = null;
      renderScenes();
    } else if (hit('.scene-del-yes')) deleteSceneFlow(name);
    else if (hit('.scene-del-no')) { scenesUi.confirmDel = null; renderScenes(); }
    else if (hit('.scene-upd')) {
      scenesUi.menu = null; scenesUi.confirmUpd = name; scenesUi.confirmDel = null; scenesUi.rename = null;
      renderScenes();
    } else if (hit('.scene-upd-yes')) updateSceneFlow(name);
    else if (hit('.scene-upd-no')) { scenesUi.confirmUpd = null; renderScenes(); }
    else if (hit('.scene-rename-ok')) submitSceneRename(li, name);
    else if (hit('.scene-rename-no')) { scenesUi.rename = null; renderScenes(); }
  }

  async function submitSceneRename(li, name) {
    const inp = li.querySelector('.scene-rename-input');
    const newName = inp ? inp.value : '';
    const res = await sceneFlow('displays_rename_scene', { name, newName }, (r) => `escena renombrada a "${r.name}"`);
    if (res) scenesUi.rename = null;
    renderScenes();
  }

  function onScenesDrag(e) {
    const li = e.target.closest ? e.target.closest('li.scene-card') : null;
    if (e.type === 'dragstart' && li) {
      sceneDragName = li.dataset.name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sceneDragName);
    } else if (e.type === 'dragover' && li && sceneDragName) {
      e.preventDefault();
      scenesList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
      li.classList.add('drag-over');
    } else if (e.type === 'drop' && li && sceneDragName) {
      e.preventDefault();
      const names = (scenesData || []).map((s) => s.name);
      const from = names.indexOf(sceneDragName);
      const to = names.indexOf(li.dataset.name);
      sceneDragName = null;
      scenesList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
      if (from >= 0 && to >= 0 && from !== to && !state.displaysPending) {
        names.splice(to, 0, names.splice(from, 1)[0]);
        sceneFlow('displays_reorder_scenes', { names }, 'orden guardado');
      }
    } else if (e.type === 'dragend') {
      sceneDragName = null;
      if (scenesList) scenesList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
      scenesList.querySelectorAll('.scene-card').forEach((x) => { x.draggable = false; });
    }
  }

  function onChooserClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.scene-from-current')) { scenesUi.chooser = null; renderSceneChooser(); openSceneEditor({ from: 'current' }); }
    else if (t.closest('.scene-from-blank')) { scenesUi.chooser = null; renderSceneChooser(); openSceneEditor({ from: 'blank' }); }
    else if (t.closest('.scene-from-copy')) { scenesUi.chooser = 'copy'; renderSceneChooser(); }
    else if (t.closest('.scene-copy-pick')) {
      const name = t.closest('.scene-copy-pick').dataset.name;
      scenesUi.chooser = null; renderSceneChooser();
      openSceneEditor({ from: 'copy', name });
    } else if (t.closest('.scene-chooser-close')) { scenesUi.chooser = null; renderSceneChooser(); }
  }

  // Los eventos se escuchan recién al entrar a Displays (así Clipboard no registra nada de esto).
  async function listenSceneEvents() {
    if (scenesListenerReady) return;
    scenesListenerReady = true;
    try {
      await listen('displays-scenes-changed', () => { if (state.section === 'displays') loadScenes(); });
      await listen('displays-confirmation', (event) => {
        const p = event.payload || {};
        if (p.kind === 'applied') displaysPendingIsTest = !!p.isTest;
        else if (p.kind === 'confirmed' || p.kind === 'reverted') displaysPendingIsTest = false;
        displaysLastShownSec = -1; // que el reloj se reescriba con el texto de PRUEBA
        refreshDisplaysUi();
      });
    } catch (err) {
      console.warn('[displays] no se pudo escuchar los eventos de escenas', err);
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
    // El selector de startup necesita la lista de escenas AL DÍA (se renombra, se crea y se
    // borra desde ESCENAS): sin releerla, un nombre nuevo no estaría entre las opciones y
    // guardar un ajuste borraría la escena de arranque.
    try { await loadProfiles(); } catch (_) {}
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
      scenesData = null;
      scenesUi.menu = scenesUi.rename = scenesUi.confirmDel = scenesUi.confirmUpd = scenesUi.chooser = null;
      if (scenesList) scenesList.replaceChildren();
      listenSceneEvents();
      displaysSettingsLoaded = false; // AJUSTES se re-carga al entrar a su pestaña
      state.displaysDraft = [];
      canvasDirty = false;
      canvasDrag = null;
      switchDisplaysTab('scenes'); // ESCENAS es la primera y la de siempre al arrancar
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
  // Pestaña ESCENAS: delegación en la lista (tarjetas), en ＋ NUEVA ESCENA y en el selector de origen.
  if (scenesList) {
    scenesList.addEventListener('click', onScenesClick);
    scenesList.addEventListener('keydown', (e) => {
      const inp = e.target && e.target.closest ? e.target.closest('.scene-rename-input') : null;
      if (!inp) return;
      const li = inp.closest('li.scene-card');
      if (e.key === 'Enter') {
        e.preventDefault();
        if (state.displaysBusy || sceneBlockReason()) return; // bloqueado: el motivo ya está escrito en la tarjeta
        submitSceneRename(li, li.dataset.name);
      }
      else if (e.key === 'Escape') { e.stopPropagation(); scenesUi.rename = null; renderScenes(); }
    });
    ['dragstart', 'dragover', 'drop', 'dragend'].forEach((t) => scenesList.addEventListener(t, onScenesDrag));
  }
  if (scenesNewBtn) {
    scenesNewBtn.addEventListener('click', () => {
      blip(880, 0.05);
      scenesUi.chooser = scenesUi.chooser ? null : 'open';
      renderSceneChooser();
    });
  }
  if (scenesChooser) scenesChooser.addEventListener('click', onChooserClick);
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
