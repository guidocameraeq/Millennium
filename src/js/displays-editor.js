// Millennium Clipboard // GRID — frontend. Displays (3/3): editor en borrador de una escena (pestaña ESCENAS).
// Script clásico: comparte el ámbito global con los demás de src/js/ (orden en index.html).
// Nada se guarda ni se aplica hasta GUARDAR / PROBAR. Contrato: tools/ui-capturas/contrato-escenas.md.
'use strict';

  const SCENE_EMOJIS = ['💼', '🎮', '🍿', '📺', '🖥️', '🎧', '🌙', '☀️', '🎬', '📚', '🕹️', '⭐'];

  // Estado del editor: vive solo en la pantalla hasta GUARDAR.
  const sceneEd = {
    open: false,
    draft: null,          // SceneDraft en edición
    baseline: '',         // JSON del borrador al abrir, para "cambios sin guardar"
    originalName: null,   // null = escena nueva
    confirmCancel: false,
    error: '',            // error del backend al probar/guardar, tal cual
    busy: false,
    editAct: null,        // { list: 'entradaV2'|'salidaV2', i } con el formulario abierto
    editValues: null,     // valores del formulario abierto
    recording: false,     // grabando un atajo
    modes: [],            // displays_list_display_modes
    games: [],            // displays_list_steam_games
    chrome: { chromePath: null, profiles: [] },
    programs: [],         // displays_list_running_programs
    listErrors: {},       // qué lista no se pudo leer (para decirlo en el formulario)
    shortcutsOn: true,
  };
  let sceneShortcutHandler = null;

  // ── Tipos de acción (los 9 del prototipo) ───────────────────────────────

  const DESTINO_BP_ABRIR = 'steam://open/bigpicture';
  const DESTINO_BP_CERRAR = 'steam://close/bigpicture';

  function chromeArgs(a) { return Array.isArray(a.args) ? a.args.filter((x) => typeof x === 'string') : []; }
  function chromeDir(a) {
    const pd = chromeArgs(a).find((x) => x.startsWith('--profile-directory='));
    return pd ? pd.slice('--profile-directory='.length) : '';
  }

  const ACTION_KINDS = [
    { key: 'bigpicture', label: 'Abrir Big Picture de Steam', fields: [],
      match: (a) => a.tipo === 'lanzar' && String(a.destino).toLowerCase().includes(DESTINO_BP_ABRIR),
      defaults: () => ({}), toAction: () => ({ tipo: 'lanzar', destino: DESTINO_BP_ABRIR, args: [] }) },
    { key: 'juego', label: 'Abrir un juego de Steam…',
      fields: [{ k: 'appId', label: 'Juego', type: 'select', options: () => sceneEd.games.map((g) => ({ value: g.appId, label: g.name })), list: 'games' }],
      match: (a) => a.tipo === 'lanzar' && /steam:\/\/rungameid\/\d+/i.test(String(a.destino)),
      values: (a) => ({ appId: (String(a.destino).match(/rungameid\/(\d+)/i) || [])[1] || '', etiqueta: a.etiqueta || '' }),
      defaults: () => ({ appId: sceneEd.games.length ? sceneEd.games[0].appId : '' }),
      toAction: (v) => {
        const g = sceneEd.games.find((x) => x.appId === v.appId);
        const a = { tipo: 'lanzar', destino: `steam://rungameid/${v.appId}`, args: [] };
        const et = g ? g.name : v.etiqueta;
        if (et) a.etiqueta = et;
        return a;
      } },
    { key: 'chrome', label: 'Chrome con una cuenta y un link…',
      fields: [
        { k: 'cuenta', label: 'Cuenta de Chrome', type: 'select', options: () => sceneEd.chrome.profiles.map((p) => ({ value: p.directory, label: p.name })), list: 'chrome' },
        { k: 'link', label: 'Link que se abre (ej: https://…)', type: 'text' }],
      match: (a) => a.tipo === 'lanzar' && String(a.destino).toLowerCase().includes('chrome'),
      values: (a) => ({ cuenta: chromeDir(a), link: chromeArgs(a).find((x) => !x.startsWith('--')) || '', destino: a.destino }),
      defaults: () => ({ cuenta: sceneEd.chrome.profiles.length ? sceneEd.chrome.profiles[0].directory : '', link: '', destino: '' }),
      toAction: (v) => {
        const p = sceneEd.chrome.profiles.find((x) => x.directory === v.cuenta);
        const args = [];
        if (v.cuenta) args.push(`--profile-directory=${v.cuenta}`);
        if (v.link) args.push(v.link);
        const a = { tipo: 'lanzar', destino: sceneEd.chrome.chromePath || v.destino || 'chrome.exe', args };
        a.etiqueta = `Chrome ${p ? p.name : (v.cuenta || '')}${v.link ? ` → ${v.link.replace(/^https?:\/\//i, '')}` : ''}`.trim();
        return a;
      } },
    { key: 'cerrarbp', label: 'Cerrar Big Picture', fields: [],
      match: (a) => a.tipo === 'lanzar' && String(a.destino).toLowerCase().includes(DESTINO_BP_CERRAR),
      defaults: () => ({}), toAction: () => ({ tipo: 'lanzar', destino: DESTINO_BP_CERRAR, args: [] }) },
    { key: 'cerrar', label: 'Cerrar un programa…', note: 'Se cierra amable, como tocar la X. Si no cierra, queda en el log; nunca se fuerza.',
      fields: [{ k: 'exe', label: 'Programa', type: 'select', options: () => sceneEd.programs.map((p) => ({ value: p.exe, label: `${p.title} (${p.exe})` })), list: 'programs' }],
      match: (a) => a.tipo === 'cerrar',
      values: (a) => ({ exe: a.exe || '' }),
      defaults: () => ({ exe: sceneEd.programs.length ? sceneEd.programs[0].exe : '' }),
      toAction: (v) => ({ tipo: 'cerrar', exe: v.exe }) },
    { key: 'esperar', label: 'Esperar unos segundos…',
      fields: [{ k: 'segundos', label: 'segundos (de 1 a 30)', type: 'number', min: 1, max: 30 }],
      match: (a) => a.tipo === 'esperar',
      values: (a) => ({ segundos: a.segundos }),
      defaults: () => ({ segundos: 5 }),
      toAction: (v) => ({ tipo: 'esperar', segundos: Number(v.segundos) }) },
    { key: 'hdr', label: 'HDR de una pantalla…',
      fields: [
        { k: 'pantalla', label: 'Pantalla', type: 'select', options: () => ((sceneEd.draft && sceneEd.draft.outputs) || []).map((o) => ({ value: o.displayId, label: o.name })) },
        { k: 'modo', label: 'Qué hacer', type: 'select', options: () => [{ value: 'prender', label: 'Prender' }, { value: 'apagar', label: 'Apagar' }] }],
      match: (a) => a.tipo === 'hdr',
      values: (a) => ({ pantalla: a.pantalla, modo: a.prender ? 'prender' : 'apagar' }),
      defaults: () => {
        const o = ((sceneEd.draft && sceneEd.draft.outputs) || [])[0];
        return { pantalla: o ? o.displayId : '', modo: 'prender' };
      },
      toAction: (v) => ({ tipo: 'hdr', pantalla: v.pantalla, prender: v.modo === 'prender' }) },
    { key: 'volumen', label: 'Poner el volumen en…',
      fields: [{ k: 'nivel', label: 'Volumen de 0 a 100', type: 'number', min: 0, max: 100 }],
      match: (a) => a.tipo === 'volumen',
      values: (a) => ({ nivel: a.nivel }),
      defaults: () => ({ nivel: 40 }),
      toAction: (v) => ({ tipo: 'volumen', nivel: Number(v.nivel) }) },
    { key: 'programa', label: 'Abrir un programa…',
      fields: [{ k: 'destino', label: 'Dónde está el programa (ej: C:\\Programas\\algo.exe)', type: 'text' }],
      match: (a) => a.tipo === 'lanzar',
      values: (a) => ({ destino: a.destino || '', args: Array.isArray(a.args) ? a.args : [] }),
      defaults: () => ({ destino: '', args: [] }),
      toAction: (v) => ({ tipo: 'lanzar', destino: v.destino, args: v.args || [] }) },
  ];

  // Qué tipo es una acción guardada; las que esta versión no conoce no se editan.
  function kindOf(a) {
    if (!a || typeof a !== 'object') return null;
    return ACTION_KINDS.find((k) => k.match(a)) || null;
  }
  function kindValues(kind, a) { return kind.values ? kind.values(a) : kind.defaults(); }

  // ── Utilidades del borrador ─────────────────────────────────────────────

  function cleanDraft() {
    const d = JSON.parse(JSON.stringify(sceneEd.draft));
    d.entradaV2 = (d.entradaV2 || []).filter((a) => a && a.tipo !== 'desconocida');
    d.salidaV2 = (d.salidaV2 || []).filter((a) => a && a.tipo !== 'desconocida');
    return d;
  }
  function sceneEdDirty() { return !!sceneEd.draft && JSON.stringify(cleanDraft()) !== sceneEd.baseline; }
  function hasUnknownActions() {
    const d = sceneEd.draft;
    return !!d && [...d.entradaV2, ...d.salidaV2].some((a) => a && a.tipo === 'desconocida');
  }

  // Exactamente una principal, y prendida (el backend lo exige).
  function fixPrimary(d) {
    const on = d.outputs.filter((o) => o.enabled);
    const cur = on.find((o) => o.primary);
    d.outputs.forEach((o) => { o.primary = false; });
    const win = cur || on.find((o) => o.connected) || on[0];
    if (win) win.primary = true;
  }

  // Lo que impide GUARDAR, escrito (no en un tooltip). Lista vacía = se puede.
  function sceneEdProblems() {
    const d = sceneEd.draft;
    const out = [];
    if (!d) return out;
    if (!d.outputs.some((o) => o.enabled)) out.push('Tiene que quedar al menos una pantalla prendida');
    const name = String(d.name || '').trim();
    if (!name) out.push('Poné un nombre para la escena');
    else if ((scenesData || []).some((s) => s.name === name && s.name !== sceneEd.originalName)) {
      out.push(`Ya hay una escena que se llama "${name}"`);
    }
    if (d.shortcut) {
      const otra = (scenesData || []).find((s) => s.shortcut === d.shortcut && s.name !== sceneEd.originalName);
      if (otra) out.push(`Ese atajo ya lo usa la escena "${otra.name}"`);
    }
    return out;
  }

  // ── Abrir / cerrar ──────────────────────────────────────────────────────

  async function readList(key, command, assign) {
    try {
      assign(await invoke(command));
      delete sceneEd.listErrors[key];
    } catch (err) {
      sceneEd.listErrors[key] = String(err);
      assign(null);
    }
  }

  async function openSceneEditor({ from, name }) {
    if (state.displaysBusy) return;
    state.displaysBusy = true;
    if (displaysError) displaysError.hidden = true;
    renderScenes();
    try {
      const args = { from };
      if (name !== undefined) args.name = name;
      const draft = await invoke('displays_scene_draft', args);
      await Promise.all([
        readList('modes', 'displays_list_display_modes', (r) => { sceneEd.modes = Array.isArray(r) ? r : []; }),
        readList('games', 'displays_list_steam_games', (r) => { sceneEd.games = Array.isArray(r) ? r : []; }),
        readList('chrome', 'displays_list_chrome_profiles', (r) => {
          sceneEd.chrome = r && Array.isArray(r.profiles) ? r : { chromePath: null, profiles: [] };
        }),
        readList('programs', 'displays_list_running_programs', (r) => { sceneEd.programs = Array.isArray(r) ? r : []; }),
        loadAudioOutputs(),
        invoke('displays_get_settings').then((s) => { sceneEd.shortcutsOn = !!(s && s.globalShortcutsEnabled); }).catch(() => {}),
      ]);
      sceneEd.draft = draft;
      sceneEd.originalName = from === 'scene' ? name : null;
      sceneEd.baseline = JSON.stringify(cleanDraft());
      sceneEd.confirmCancel = false;
      sceneEd.error = '';
      sceneEd.editAct = null;
      sceneEd.editValues = null;
      sceneEd.recording = false;
      sceneEd.open = true;
      scenesListView.hidden = true;
      scenesEditorView.hidden = false;
      renderSceneEditor();
    } catch (err) {
      showDisplaysError(err);
    } finally {
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  function closeSceneEditor() {
    cancelShortcutCapture();
    sceneEd.open = false;
    sceneEd.draft = null;
    scenesEditorView.hidden = true;
    scenesEditorView.replaceChildren();
    scenesListView.hidden = false;
    renderScenes();
  }

  // ── Armado del DOM ──────────────────────────────────────────────────────

  function mkSection(title) {
    const sec = mkEl('section', 'scene-sec');
    sec.appendChild(mkEl('h3', 'scene-sec-title', title));
    return sec;
  }

  function mkSelect(options, value) {
    const sel = mkEl('select', 'displays-setting-select scene-select');
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = value;
    return sel;
  }

  function markDirty() {
    const e = scenesEditorView.querySelector('.scene-dirty');
    if (e) e.textContent = sceneEdDirty() ? '• cambios sin guardar' : '';
    renderSceneBar();
  }

  function renderSceneEditor() {
    if (!sceneEd.open || !sceneEd.draft) return;
    const d = sceneEd.draft;
    const root = scenesEditorView;
    root.replaceChildren();
    const back = mkBtn('modal-btn small scene-back', '← VOLVER A ESCENAS');
    back.addEventListener('click', () => requestCancel());
    root.appendChild(mkEl('div', 'scene-back-row')).appendChild(back);
    root.appendChild(mkEl('div', 'scene-banner', 'Estás editando en borrador: nada cambia en tus pantallas hasta que toques PROBAR.'));
    root.appendChild(buildNameSection(d));
    root.appendChild(buildScreensSection(d));
    root.appendChild(buildSoundSection(d));
    root.appendChild(buildActionsSection(d));
    root.appendChild(buildShortcutSection(d));
    root.appendChild(buildStartupSection(d));
    root.appendChild(mkEl('div', 'scene-bar'));
    renderSceneBar();
    drawSceneCanvas();
  }

  // 1 · Nombre + ícono
  function buildNameSection(d) {
    const sec = mkSection('1 · Nombre');
    const inp = mkEl('input', 'scene-name-input');
    inp.type = 'text';
    inp.id = 'scene-ed-name';
    inp.maxLength = 60;
    inp.placeholder = 'Cómo querés llamar a esta escena';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.value = d.name || '';
    inp.addEventListener('input', () => { d.name = inp.value; markDirty(); });
    sec.appendChild(inp);
    const row = mkEl('div', 'scene-emoji-row');
    row.appendChild(mkEl('span', 'mono scene-hint', 'Ícono:'));
    SCENE_EMOJIS.forEach((em) => {
      const b = mkBtn('modal-btn small scene-emoji' + (d.emoji === em ? ' is-on' : ''), em);
      b.addEventListener('click', () => { d.emoji = em; renderSceneEditor(); });
      row.appendChild(b);
    });
    const none = mkBtn('modal-btn small scene-emoji-none' + (d.emoji ? '' : ' is-on'), 'SIN ÍCONO');
    none.addEventListener('click', () => { d.emoji = null; renderSceneEditor(); });
    row.appendChild(none);
    sec.appendChild(row);
    return sec;
  }

  // 2 · Pantallas
  function modesFor(displayId) { return sceneEd.modes.find((m) => m.displayId === displayId) || null; }
  const modeValue = (m) => `${m.width}x${m.height}@${m.refreshMhz}`;
  const modeLabel = (m) => `${m.width}×${m.height} · ${Math.round((m.refreshMhz / 1000) * 100) / 100} Hz`;

  function buildScreensSection(d) {
    const sec = mkSection('2 · Pantallas');
    const copy = mkBtn('modal-btn small scene-copy-live', 'COPIAR LO QUE ESTÁ PUESTO AHORA');
    copy.addEventListener('click', copyLiveOutputs);
    sec.appendChild(copy);
    sec.appendChild(mkEl('p', 'mono scene-hint', 'Arrastrá las pantallas para acomodarlas como están en tu escritorio. Se pegan solas por los bordes.'));
    sec.appendChild(mkEl('div', 'scene-canvas'));
    const table = mkEl('table', 'scene-screens');
    d.outputs.forEach((o) => table.appendChild(buildScreenRow(d, o)));
    sec.appendChild(table);
    if (!d.outputs.some((o) => o.enabled)) sec.appendChild(mkEl('p', 'scene-err', 'Tiene que quedar al menos una pantalla prendida'));
    return sec;
  }

  function buildScreenRow(d, o) {
    const tr = mkEl('tr', o.enabled ? '' : 'is-off');
    const info = mkEl('td');
    info.appendChild(mkEl('b', '', o.connected === false ? `${o.name} (no conectado)` : o.name));
    const entry = modesFor(o.displayId);
    if (o.connected === false) {
      info.appendChild(mkEl('div', 'mono scene-hint', 'No está conectado: esta escena lo deja como estaba guardado; si lo prende, no se va a poder aplicar hasta que lo conectes.'));
    } else if (entry && entry.remembered && entry.modes.length) {
      info.appendChild(mkEl('div', 'mono scene-hint', 'Resoluciones que recuerdo de la última vez que estuvo prendida'));
    } else if (!entry || !entry.modes.length) {
      info.appendChild(mkEl('div', 'mono scene-hint', 'Nunca la vi prendida: solo puedo dejar la resolución que tenga.'));
    }
    tr.appendChild(info);

    const sw = mkEl('td');
    const swBox = mkEl('span', 'scene-sw');
    const bOn = mkBtn('scene-sw-btn' + (o.enabled ? ' is-on' : ''), 'PRENDIDA');
    const bOff = mkBtn('scene-sw-btn' + (!o.enabled ? ' is-on is-off' : ''), 'APAGADA');
    bOn.addEventListener('click', () => { o.enabled = true; fixPrimary(d); renderSceneEditor(); markDirty(); });
    bOff.addEventListener('click', () => { o.enabled = false; fixPrimary(d); renderSceneEditor(); markDirty(); });
    swBox.append(bOn, bOff);
    sw.appendChild(swBox);
    tr.appendChild(sw);

    const pri = mkEl('td');
    const lab = mkEl('label', 'scene-pri');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'scene-primary';
    radio.checked = !!(o.enabled && o.primary);
    radio.disabled = !o.enabled || o.connected === false;
    radio.addEventListener('change', () => {
      d.outputs.forEach((x) => { x.primary = x === o; });
      renderSceneEditor();
      markDirty();
    });
    lab.append(radio, document.createTextNode(' ★ principal'));
    pri.appendChild(lab);
    tr.appendChild(pri);

    const res = mkEl('td');
    const opts = [{ value: 'dejar', label: 'Dejar la que tenga' }];
    const modes = entry ? entry.modes : [];
    modes.forEach((m) => opts.push({ value: modeValue(m), label: modeLabel(m) }));
    let cur = 'dejar';
    if (o.width > 0 && o.height > 0) {
      cur = modeValue(o);
      if (!modes.some((m) => modeValue(m) === cur)) opts.push({ value: cur, label: `${modeLabel(o)} (guardada)` });
    }
    const sel = mkSelect(opts, cur);
    sel.disabled = !o.enabled || o.connected === false;
    sel.addEventListener('change', () => {
      if (sel.value === 'dejar') { o.width = 0; o.height = 0; }
      else {
        const m = /^(\d+)x(\d+)@(\d+)$/.exec(sel.value);
        if (m) { o.width = Number(m[1]); o.height = Number(m[2]); o.refreshMhz = Number(m[3]); }
      }
      renderSceneEditor();
      markDirty();
    });
    res.appendChild(sel);
    tr.appendChild(res);
    return tr;
  }

  async function copyLiveOutputs() {
    try {
      const live = await invoke('displays_scene_draft', { from: 'current' });
      if (live && Array.isArray(live.outputs)) {
        sceneEd.draft.outputs = live.outputs;
        fixPrimary(sceneEd.draft);
        renderSceneEditor();
        markDirty();
      }
    } catch (err) {
      sceneEd.error = String(err);
      renderSceneBar();
    }
  }

  // Lienzo del editor: arrastrar pantallas del borrador (coordenadas de escritorio).
  function drawSceneCanvas() {
    const cv = scenesEditorView.querySelector('.scene-canvas');
    const d = sceneEd.draft;
    if (!cv || !d) return;
    cv.replaceChildren();
    const size = (o) => ({ w: o.width || SCENE_DEFAULT_W, h: o.height || SCENE_DEFAULT_H });
    const cw = cv.getBoundingClientRect().width || 700;
    const ch = cv.getBoundingClientRect().height || 260;
    const pad = 16;
    const minX = Math.min(...d.outputs.map((o) => o.x));
    const minY = Math.min(...d.outputs.map((o) => o.y));
    const maxX = Math.max(...d.outputs.map((o) => o.x + size(o).w));
    const maxY = Math.max(...d.outputs.map((o) => o.y + size(o).h));
    // Margen de una pantalla extra a cada lado para poder moverlas.
    const bx = Math.max(maxX - minX, 1);
    const by = Math.max(maxY - minY, 1);
    const scale = Math.min((cw - pad * 2) / (bx * 1.6), (ch - pad * 2) / (by * 1.6), 0.25);
    const ox = (cw - bx * scale) / 2;
    const oy = (ch - by * scale) / 2;
    const toScreen = (o) => ({ l: ox + (o.x - minX) * scale, t: oy + (o.y - minY) * scale, w: size(o).w * scale, h: size(o).h * scale });
    const overlaps = (o, x, y) => d.outputs.some((p) => {
      if (p === o || !p.enabled || !o.enabled) return false;
      const a = size(o); const b = size(p);
      return x < p.x + b.w && x + a.w > p.x && y < p.y + b.h && y + a.h > p.y;
    });
    d.outputs.forEach((o) => {
      const r = toScreen(o);
      const div = mkEl('div', `scene-mon${o.enabled ? '' : ' is-off'}${o.enabled && o.primary ? ' is-pri' : ''}`);
      div.style.left = `${r.l}px`; div.style.top = `${r.t}px`;
      div.style.width = `${r.w}px`; div.style.height = `${r.h}px`;
      div.appendChild(mkEl('span', '', `${o.enabled && o.primary ? '★ ' : ''}${o.name}`));
      div.appendChild(mkEl('span', 'mono scene-hint', o.width ? `${o.width}×${o.height}` : 'la que tenga'));
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        div.setPointerCapture(e.pointerId);
        const sx = e.clientX; const sy = e.clientY;
        const x0 = o.x; const y0 = o.y;
        let nx = x0; let ny = y0;
        const move = (ev) => {
          nx = Math.round(x0 + (ev.clientX - sx) / scale);
          ny = Math.round(y0 + (ev.clientY - sy) / scale);
          // Se pega a los bordes de las otras pantallas (a ~10 px de pantalla).
          const T = 10 / scale;
          d.outputs.forEach((p) => {
            if (p === o) return;
            const a = size(o); const b = size(p);
            [p.x + b.w, p.x - a.w, p.x].forEach((t) => { if (Math.abs(t - nx) < T) nx = t; });
            [p.y + b.h, p.y - a.h, p.y].forEach((t) => { if (Math.abs(t - ny) < T) ny = t; });
          });
          div.style.left = `${r.l + (nx - x0) * scale}px`;
          div.style.top = `${r.t + (ny - y0) * scale}px`;
          div.classList.toggle('is-bad', overlaps(o, nx, ny));
        };
        const up = () => {
          div.removeEventListener('pointermove', move);
          div.removeEventListener('pointerup', up);
          if (!overlaps(o, nx, ny)) { o.x = nx; o.y = ny; }
          renderSceneEditor();
          markDirty();
        };
        div.addEventListener('pointermove', move);
        div.addEventListener('pointerup', up);
      });
      cv.appendChild(div);
    });
  }

  // 3 · Sonido
  function buildSoundSection(d) {
    const sec = mkSection('3 · Sonido');
    const outs = Array.isArray(state.audioOutputs) ? state.audioOutputs : [];
    const opts = [{ value: '', label: 'No tocar el audio' }];
    outs.forEach((o) => opts.push({ value: o.endpointId, label: o.friendlyName }));
    const saved = d.audio && d.audio.endpointId;
    if (saved && !outs.some((o) => o.endpointId === saved)) {
      opts.push({ value: saved, label: `${d.audio.friendlyName || saved} (no disponible)` });
    }
    const sel = mkSelect(opts, saved || '');
    sel.addEventListener('change', () => {
      const o = outs.find((x) => x.endpointId === sel.value);
      d.audio = sel.value ? { endpointId: sel.value, friendlyName: o ? o.friendlyName : ((d.audio && d.audio.friendlyName) || '') } : null;
      markDirty();
    });
    sec.append(sel, mkEl('span', 'mono scene-hint', ' Adónde sale el sonido cuando ponés esta escena.'));
    return sec;
  }

  // 4 · Al entrar / Al salir
  function buildActionsSection(d) {
    const sec = mkSection('4 · Qué hacer al entrar y al salir');
    if (hasUnknownActions()) {
      sec.appendChild(mkEl('p', 'scene-reason', 'Hay acciones de una versión más nueva que esta no conoce: al guardar se pierden.'));
    }
    const cols = mkEl('div', 'scene-cols');
    cols.append(buildActionColumn(d, 'entradaV2', 'Al entrar'), buildActionColumn(d, 'salidaV2', 'Al salir'));
    sec.appendChild(cols);
    return sec;
  }

  function buildActionColumn(d, list, title) {
    const col = mkEl('div', 'scene-col');
    col.appendChild(mkEl('h4', 'scene-col-head', title));
    const arr = d[list];
    if (!arr.length) col.appendChild(mkEl('p', 'mono scene-hint', 'Nada por ahora.'));
    arr.forEach((a, i) => {
      const kind = kindOf(a);
      const row = mkEl('div', 'scene-act');
      const label = mkEl('span', 'scene-act-label', actionLabelV2(a, d.outputs));
      label.dataset.list = list; label.dataset.i = String(i);
      if (kind && kind.fields.length) {
        label.title = 'Tocá para editar';
        label.addEventListener('click', () => toggleActionForm(list, i));
      }
      row.appendChild(label);
      const up = mkBtn('modal-btn small', '↑', 'Subir'); up.disabled = i === 0;
      const down = mkBtn('modal-btn small', '↓', 'Bajar'); down.disabled = i === arr.length - 1;
      const del = mkBtn('modal-btn small reject', '✕', 'Quitar');
      up.addEventListener('click', () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; sceneEd.editAct = null; renderSceneEditor(); markDirty(); });
      down.addEventListener('click', () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; sceneEd.editAct = null; renderSceneEditor(); markDirty(); });
      del.addEventListener('click', () => { arr.splice(i, 1); sceneEd.editAct = null; renderSceneEditor(); markDirty(); });
      row.append(up, down, del);
      col.appendChild(row);
      if (kind && sceneEd.editAct && sceneEd.editAct.list === list && sceneEd.editAct.i === i) {
        col.appendChild(buildActionForm(d, list, i, kind));
      }
    });
    const opts = [{ value: '', label: '＋ agregar acción' }].concat(ACTION_KINDS.map((k) => ({ value: k.key, label: k.label })));
    const add = mkSelect(opts, '');
    add.addEventListener('change', () => {
      const kind = ACTION_KINDS.find((k) => k.key === add.value);
      if (!kind) return;
      const values = kind.defaults();
      arr.push(kind.toAction(values));
      sceneEd.editAct = kind.fields.length ? { list, i: arr.length - 1 } : null;
      sceneEd.editValues = kind.fields.length ? values : null;
      renderSceneEditor();
      markDirty();
    });
    col.appendChild(add);
    return col;
  }

  function toggleActionForm(list, i) {
    const same = sceneEd.editAct && sceneEd.editAct.list === list && sceneEd.editAct.i === i;
    if (same) { sceneEd.editAct = null; sceneEd.editValues = null; }
    else {
      const a = sceneEd.draft[list][i];
      const kind = kindOf(a);
      sceneEd.editAct = { list, i };
      sceneEd.editValues = kind ? kindValues(kind, a) : null;
    }
    renderSceneEditor();
  }

  function buildActionForm(d, list, i, kind) {
    const form = mkEl('div', 'scene-form');
    form.appendChild(mkEl('b', 'mono scene-hint', kind.label));
    if (!sceneEd.editValues) sceneEd.editValues = kindValues(kind, d[list][i]);
    const values = sceneEd.editValues;
    const apply = () => {
      d[list][i] = kind.toAction(values);
      const lbl = scenesEditorView.querySelector(`.scene-act-label[data-list="${list}"][data-i="${i}"]`);
      if (lbl) lbl.textContent = actionLabelV2(d[list][i], d.outputs);
      markDirty();
    };
    kind.fields.forEach((f) => {
      form.appendChild(mkEl('label', 'mono scene-hint', f.label));
      if (f.type === 'select') {
        const opts = f.options();
        if (values[f.k] && !opts.some((o) => o.value === values[f.k])) opts.push({ value: values[f.k], label: `${values[f.k]} (no está en la lista)` });
        const sel = mkSelect(opts, values[f.k] === undefined ? (opts[0] ? opts[0].value : '') : values[f.k]);
        sel.addEventListener('change', () => { values[f.k] = sel.value; apply(); });
        form.appendChild(sel);
        if (f.list && sceneEd.listErrors[f.list]) form.appendChild(mkEl('span', 'mono scene-err', `No pude leer la lista: ${sceneEd.listErrors[f.list]}`));
        else if (f.list && !opts.length) form.appendChild(mkEl('span', 'mono scene-hint', 'La lista está vacía.'));
      } else {
        const inp = mkEl('input', 'scene-form-input');
        inp.type = f.type;
        if (f.min !== undefined) inp.min = String(f.min);
        if (f.max !== undefined) inp.max = String(f.max);
        inp.value = values[f.k] === undefined || values[f.k] === null ? '' : String(values[f.k]);
        inp.addEventListener('input', () => { values[f.k] = inp.value; apply(); });
        form.appendChild(inp);
      }
    });
    if (kind.note) form.appendChild(mkEl('span', 'mono scene-hint', kind.note));
    const ok = mkBtn('modal-btn small accept', 'LISTO');
    ok.addEventListener('click', () => { sceneEd.editAct = null; sceneEd.editValues = null; renderSceneEditor(); });
    form.appendChild(ok);
    return form;
  }

  // 5 · Atajo
  function sceneAccelToken(e) {
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return null;
  }

  function onSceneShortcutKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cancelShortcutCapture(); renderSceneEditor(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      sceneEd.draft.shortcut = null; cancelShortcutCapture(); renderSceneEditor(); markDirty(); return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.shiftKey) mods.push('Shift');
    if (e.altKey) mods.push('Alt');
    if (!mods.length) { setStatus('DISPLAYS · usá al menos Ctrl, Shift o Alt', { priority: 'warn', ttl: 3000 }); return; }
    const token = sceneAccelToken(e);
    if (!token) { setStatus('DISPLAYS · esa tecla no sirve (usá letras, números o F1–F24)', { priority: 'warn', ttl: 3500 }); return; }
    sceneEd.draft.shortcut = mods.concat(token).join('+');
    cancelShortcutCapture();
    renderSceneEditor();
    markDirty();
  }

  function startSceneShortcutCapture() {
    cancelShortcutCapture();
    sceneEd.recording = true;
    sceneShortcutHandler = onSceneShortcutKey;
    document.addEventListener('keydown', sceneShortcutHandler, true);
    renderSceneEditor();
  }

  // Lo llaman también el cambio de pestaña y la salida de la sección.
  function cancelShortcutCapture() {
    if (sceneShortcutHandler) {
      document.removeEventListener('keydown', sceneShortcutHandler, true);
      sceneShortcutHandler = null;
    }
    sceneEd.recording = false;
  }

  async function enableShortcutsFromEditor() {
    try {
      const cur = (await invoke('displays_get_settings')) || {};
      await invoke('displays_update_settings', { settings: {
        revertTimeoutSecs: Number.isFinite(Number(cur.revertTimeoutSecs)) ? Number(cur.revertTimeoutSecs) : 15,
        startupProfileName: typeof cur.startupProfileName === 'string' ? cur.startupProfileName : null,
        globalShortcutsEnabled: true,
      } });
      sceneEd.shortcutsOn = true;
      scenesShortcutsOn = true;
      displaysSettingsLoaded = false; // AJUSTES se vuelve a leer al entrar
      renderSceneEditor();
    } catch (err) {
      sceneEd.error = String(err);
      renderSceneBar();
    }
  }

  function buildShortcutSection(d) {
    const sec = mkSection('5 · Atajo');
    const row = mkEl('div', 'scene-row');
    if (sceneEd.recording) row.appendChild(mkEl('b', 'scene-reason', 'Tocá las teclas ahora… (Supr borra · Esc cancela)'));
    else if (d.shortcut) row.appendChild(mkEl('kbd', 'scene-kbd', d.shortcut));
    else row.appendChild(mkEl('span', 'mono scene-hint', 'Sin atajo'));
    const rec = mkBtn('modal-btn small', 'GRABAR ATAJO');
    rec.addEventListener('click', startSceneShortcutCapture);
    const clr = mkBtn('modal-btn small reject', 'QUITAR');
    clr.disabled = !d.shortcut;
    clr.addEventListener('click', () => { d.shortcut = null; renderSceneEditor(); markDirty(); });
    row.append(rec, clr);
    sec.appendChild(row);
    if (!sceneEd.shortcutsOn) {
      const r = mkEl('p', 'scene-reason', 'Los atajos están apagados — ');
      const on = mkBtn('modal-btn small', 'PRENDERLOS');
      on.addEventListener('click', enableShortcutsFromEditor);
      r.appendChild(on);
      sec.appendChild(r);
    }
    return sec;
  }

  // 6 · Al arrancar Windows
  function buildStartupSection(d) {
    const sec = mkSection('6 · Al arrancar');
    const lab = mkEl('label', 'scene-pri');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.startup;
    cb.addEventListener('change', () => { d.startup = cb.checked; renderSceneEditor(); markDirty(); });
    lab.append(cb, document.createTextNode(' Poner esta escena cuando arranca Windows'));
    sec.appendChild(lab);
    const other = (scenesData || []).find((s) => s.startup && s.name !== sceneEd.originalName);
    if (d.startup && other) sec.appendChild(mkEl('p', 'scene-reason', `Antes era: ${other.name}`));
    sec.appendChild(mkEl('p', 'mono scene-hint', 'Solo una escena puede arrancar con Windows.'));
    return sec;
  }

  // ── Barra fija: CANCELAR · PROBAR · GUARDAR ─────────────────────────────

  function renderSceneBar() {
    const bar = scenesEditorView.querySelector('.scene-bar');
    if (!bar || !sceneEd.draft) return;
    bar.replaceChildren();
    const problems = sceneEdProblems();
    const reason = sceneBlockReason();
    bar.appendChild(mkEl('span', 'scene-dirty', sceneEdDirty() ? '• cambios sin guardar' : ''));
    if (sceneEd.confirmCancel) {
      const yes = mkBtn('modal-btn small reject', 'SÍ, DESCARTAR');
      const no = mkBtn('modal-btn small', 'NO, SEGUIR');
      yes.addEventListener('click', closeSceneEditor);
      no.addEventListener('click', () => { sceneEd.confirmCancel = false; renderSceneBar(); });
      bar.append(mkEl('span', 'mono', '¿Descartar los cambios?'), yes, no);
      return;
    }
    const cancel = mkBtn('modal-btn small', 'CANCELAR');
    cancel.addEventListener('click', requestCancel);
    const probar = mkBtn('modal-btn small scene-test', 'PROBAR');
    probar.disabled = sceneEd.busy || state.displaysBusy || !!state.displaysPending || !sceneEd.draft.outputs.some((o) => o.enabled);
    probar.addEventListener('click', testDraft);
    const guardar = mkBtn('modal-btn small accept scene-save', 'GUARDAR');
    guardar.disabled = sceneEd.busy || state.displaysBusy || !!state.displaysPending || problems.length > 0;
    guardar.addEventListener('click', saveDraft);
    bar.append(cancel, probar, guardar);
    const msgs = problems.slice();
    if (reason) msgs.push(reason);
    msgs.forEach((m) => bar.appendChild(mkEl('span', 'scene-err mono', m)));
    if (sceneEd.error) bar.appendChild(mkEl('span', 'scene-err mono', sceneEd.error));
  }

  function requestCancel() {
    if (sceneEdDirty()) { sceneEd.confirmCancel = true; renderSceneBar(); }
    else closeSceneEditor();
  }

  // Lo llama refreshDisplaysUi: la barra sigue lo que pasa con la cuenta regresiva.
  function refreshSceneEditor() {
    if (sceneEd.open) renderSceneBar();
  }

  async function testDraft() {
    if (sceneEd.busy || state.displaysBusy || state.displaysPending) return;
    sceneEd.busy = true;
    state.displaysBusy = true;
    sceneEd.error = '';
    renderSceneBar();
    blip(660, 0.06);
    try {
      applyDisplaysSnapshot(await invoke('displays_test_draft', { draft: cleanDraft() }));
      setStatus('DISPLAYS · probando la escena: ME QUEDO o vuelve sola', { priority: 'warn', ttl: 12000 });
    } catch (err) {
      sceneEd.error = String(err);
    } finally {
      sceneEd.busy = false;
      state.displaysBusy = false;
      refreshDisplaysUi();
    }
  }

  async function saveDraft() {
    if (sceneEd.busy || state.displaysBusy || state.displaysPending || sceneEdProblems().length) return;
    sceneEd.busy = true;
    state.displaysBusy = true;
    sceneEd.error = '';
    renderSceneBar();
    try {
      const res = takeScenesResult(await invoke('displays_save_scene', { draft: cleanDraft(), originalName: sceneEd.originalName }));
      setStatus(`DISPLAYS · escena "${(res && res.name) || sceneEd.draft.name}" guardada`, { force: true });
      sceneEd.busy = false;
      state.displaysBusy = false;
      closeSceneEditor();
    } catch (err) {
      sceneEd.error = String(err);
      sceneEd.busy = false;
      state.displaysBusy = false;
      renderSceneBar();
    } finally {
      refreshDisplaysUi();
    }
  }
