// Mock de window.__TAURI__ para el banco de capturas (tools/ui-capturas).
// Datos fijos: nada de Date.now() ni azar en lo que se ve.
(function () {
  'use strict';

  const peers = [
    { id: 'aa11bb22cc33dd44', name: 'DRACOSSSLAPTOP', hexId: '0xA1B2', ip: '192.168.1.20', port: 53317,
      status: 'online', favorite: true, iconType: 'laptop', manual: false, clipboardSync: true },
    { id: 'ee55ff66aa77bb88', name: 'SALA-TV', hexId: '0xC3D4', ip: '192.168.1.31', port: 53317,
      status: 'online', favorite: false, iconType: 'media', manual: false, clipboardSync: false },
  ];

  const displays = [
    { id: 'mon-1', name: 'DELL U2723QE', active: true, primary: true, width: 2560, height: 1440, refreshMhz: 59951,
      positionX: 0, positionY: 0, adapterLuid: '0:1', targetId: 1, edidHash: null, canDetach: true },
    { id: 'mon-2', name: 'LG TV OLED', active: true, primary: false, width: 1920, height: 1080, refreshMhz: 60000,
      positionX: 2560, positionY: 0, adapterLuid: '0:1', targetId: 2, edidHash: null, canDetach: true },
  ];

  const profiles = [
    { name: 'ESCRITORIO', activeCount: 2, summary: '2 monitores · 2560×1440, 1920×1080',
      shortcut: 'Ctrl+Alt+1', audio: { endpointId: 'ep-1', friendlyName: 'Parlantes' },
      actions: { entrada: [], salida: [] } },
    { name: 'SOLO TV', activeCount: 1, summary: '1 monitor · 1920×1080',
      shortcut: null, audio: null, actions: { entrada: [], salida: [] } },
  ];

  const settings = {
    downloadDir: 'C:\\Users\\demo\\Downloads\\Millennium', autoAcceptFavorites: true,
    notificationsEnabled: true, startWithWindows: false, closeToTray: true,
  };

  const handlers = {
    get_local_info: () => ({ alias: 'MILLENNIUM-PC', hostIdHex: '0xFFFF', ip: '192.168.1.10', port: 53317,
      fingerprint: 'deadbeef', version: '0.0.0-mock' }),
    list_peers: () => peers,
    get_settings: () => settings,
    take_update_failure: () => null,
    get_runtime_log: () => [],
    displays_get_snapshot: () => ({ source: 'windows', displays, pending: null }),
    displays_list_profiles: () => profiles,
    displays_list_audio_outputs: () => [{ endpointId: 'ep-1', friendlyName: 'Parlantes' },
      { endpointId: 'ep-2', friendlyName: 'TV HDMI' }],
    displays_get_settings: () => ({ revertTimeoutSecs: 15, startupProfileName: null, globalShortcutsEnabled: true }),
  };

  // --- Escenas (contrato: tools/ui-capturas/contrato-escenas.md) -------------
  // Estado en memoria: guardar, duplicar, renombrar y reordenar cambian lo que
  // devuelve displays_list_scenes. La pantalla de hoy no llama a nada de esto,
  // así que sus capturas no se enteran.

  const clon = (o) => JSON.parse(JSON.stringify(o));

  // Ids en el formato de ids.rs, con EDID más grande que 2^53 a propósito.
  const ID_IZQ = '81234:4352:16045690984833335023';
  const ID_CEN = '81234:4353:12297829382473034410';
  const ID_TV = '81234:4357:9223372036854775809';

  // Las 3 pantallas que "ve Windows": dos monitores prendidos y la TV apagada.
  const pantallas = [
    { displayId: ID_IZQ, name: 'Monitor izquierdo', connected: true, active: true },
    { displayId: ID_CEN, name: 'Monitor central', connected: true, active: true },
    { displayId: ID_TV, name: 'LG TV OLED', connected: true, active: false },
  ];
  const nombreDe = (id) => (pantallas.find((p) => p.displayId === id) || {}).name || 'Pantalla';

  const modos = {
    [ID_IZQ]: { remembered: false, modes: [{ width: 1920, height: 1080, refreshMhz: 60000 }] },
    [ID_CEN]: { remembered: false, modes: [
      { width: 2560, height: 1440, refreshMhz: 144000 }, { width: 2560, height: 1440, refreshMhz: 60000 },
      { width: 1920, height: 1080, refreshMhz: 60000 }] },
    // La TV está apagada: lo que recuerdo de la última vez que estuvo prendida.
    [ID_TV]: { remembered: true, modes: [
      { width: 3840, height: 2160, refreshMhz: 60000 }, { width: 1920, height: 1080, refreshMhz: 60000 }] },
  };

  const salida = (displayId, enabled, primary, x, y, width, height, refreshMhz) =>
    ({ displayId, enabled, primary, x, y, width, height, refreshMhz });
  // Lo que está puesto ahora (= la escena Trabajo).
  const puesto = [
    salida(ID_IZQ, true, false, -1920, 360, 1920, 1080, 60000),
    salida(ID_CEN, true, true, 0, 0, 2560, 1440, 144000),
    salida(ID_TV, false, false, 2560, 0, 0, 0, 60000),
  ];

  const AUDIO_PARLANTES = { endpointId: 'ep-1', friendlyName: 'Parlantes' };
  const AUDIO_TV = { endpointId: 'ep-2', friendlyName: 'TV HDMI' };

  let escenas = [
    { name: 'Trabajo', emoji: '💼', outputs: clon(puesto), audio: AUDIO_PARLANTES,
      shortcut: 'Ctrl+Alt+1', startup: false, entradaV2: [], salidaV2: [] },
    { name: 'Jugar en la TV', emoji: '🎮',
      outputs: [salida(ID_IZQ, false, false, -1920, 360, 1920, 1080, 60000),
        salida(ID_CEN, false, false, -2560, 0, 2560, 1440, 144000),
        salida(ID_TV, true, true, 0, 0, 3840, 2160, 60000)],
      audio: AUDIO_TV, shortcut: 'Ctrl+Alt+2', startup: false,
      entradaV2: [{ tipo: 'lanzar', destino: 'steam://open/bigpicture', args: [] },
        { tipo: 'volumen', nivel: 40 }, { tipo: 'esperar', segundos: 5 },
        { tipo: 'hdr', pantalla: ID_TV, prender: true }],
      salidaV2: [{ tipo: 'lanzar', destino: 'steam://close/bigpicture', args: [] },
        { tipo: 'cerrar', exe: 'steam.exe' }, { tipo: 'hdr', pantalla: ID_TV, prender: false }] },
    { name: 'Película', emoji: '🍿',
      outputs: [salida(ID_IZQ, false, false, -1920, 360, 1920, 1080, 60000),
        salida(ID_CEN, true, true, 0, 0, 2560, 1440, 60000),
        salida(ID_TV, true, false, 2560, 0, 1920, 1080, 60000)],
      audio: AUDIO_TV, shortcut: null, startup: true,
      entradaV2: [{ tipo: 'lanzar', destino: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--profile-directory=Profile 2', 'https://netflix.com'], etiqueta: 'Chrome Casa → netflix.com' }],
      salidaV2: [] },
    { name: 'Solo central', emoji: '🖥️',
      outputs: [salida(ID_IZQ, false, false, -1920, 360, 1920, 1080, 60000),
        salida(ID_CEN, true, true, 0, 0, 2560, 1440, 144000),
        salida(ID_TV, false, false, 2560, 0, 0, 0, 60000)],
      audio: null, shortcut: null, startup: false, entradaV2: [], salidaV2: [] },
  ];
  let puestaAhora = 'Trabajo';
  let prueba = null; // { remainingMs } mientras dura un PROBAR

  function resumen(outputs) {
    const on = outputs.filter((o) => o.enabled);
    const res = on.map((o) => (o.width ? `${o.width}×${o.height}` : 'la que tenga')).join(', ');
    return `${on.length} ${on.length === 1 ? 'monitor' : 'monitores'} · ${res}`;
  }
  const conNombres = (outputs) => outputs.map((o) => ({
    displayId: o.displayId, name: nombreDe(o.displayId),
    connected: pantallas.some((p) => p.displayId === o.displayId),
    enabled: o.enabled, primary: o.primary, x: o.x, y: o.y,
    width: o.width, height: o.height, refreshMhz: o.refreshMhz,
  }));
  const vista = (e) => ({
    name: e.name, emoji: e.emoji, outputs: conNombres(e.outputs), summary: resumen(e.outputs),
    audio: e.audio, shortcut: e.shortcut, startup: e.startup, isCurrent: e.name === puestaAhora,
    entradaV2: clon(e.entradaV2), salidaV2: clon(e.salidaV2),
  });
  const lista = () => escenas.map(vista);
  const buscar = (name) => escenas.find((e) => e.name === name);
  const borradorDe = (e) => {
    const d = clon(vista(e));
    delete d.summary; delete d.isCurrent;
    return d;
  };

  // Eventos: el mock guarda quién escucha para poder avisar displays-scenes-changed.
  const oyentes = {};
  function emitir(nombre, payload) {
    (oyentes[nombre] || []).forEach((cb) => cb({ event: nombre, payload }));
  }
  function resultado(kind, name) {
    emitir('displays-scenes-changed', { kind });
    const warnings = MOCK.avisoAtajo
      ? ['se guardó, pero el atajo Ctrl+Alt+2 no se pudo activar (¿lo usa otro programa?)'] : [];
    return { scenes: lista(), name, warnings };
  }

  // Ganchos para las vistas del banco (capturar.cjs los ajusta con pasos { mock: '...' }).
  const MOCK = window.__MOCK__ = {
    windowsPoneOtra: false, // APLICAR y PROBAR avisan "Windows la dejó en otra resolución"
    sinJuegos: false,       // Steam sin juegos instalados
    borrarFalla: false,     // BORRAR responde error
    avisoAtajo: false,      // GUARDAR responde con warnings (el atajo no se pudo activar)
    conProyector() {        // una pantalla que Windows ve pero nunca vimos prendida, usada por Película
      if (pantallas.some((p) => p.displayId === ID_PROY)) return;
      pantallas.push({ displayId: ID_PROY, name: 'Proyector', connected: true, active: false });
      modos[ID_PROY] = { remembered: false, modes: [] };
      buscar('Película').outputs.push(salida(ID_PROY, true, false, 4480, 0, 1280, 720, 60000));
    },
  };
  const ID_PROY = '81234:4361:7777777777777777777';
  let escenaPendiente = null; // la escena que APLICAR dejó esperando confirmación

  // Los textos son los del backend (displays_cmds.rs / vendor manager.rs).
  function exigirSinPrueba() {
    if (prueba) throw prueba.isTest ? 'esperando que confirmes la prueba' : 'ya hay un cambio esperando que lo confirmes';
  }
  const hz = (mhz) => String(Math.round(mhz / 10) / 100);
  const textoModo = (o) => `${o.width}×${o.height} a ${hz(o.refreshMhz)} Hz`;
  // Como modos::validar_resoluciones: un modo de los que la pantalla reportó, "Dejar la que tenga"
  // o lo que la misma escena ya tenía guardado. Las apagadas no se miran.
  function validarResoluciones(outputs, original) {
    outputs.filter((o) => o.enabled).forEach((o) => {
      if (!o.width && !o.height) return;
      const yaLaTenia = original && original.outputs.some((v) => v.displayId === o.displayId
        && v.width === o.width && v.height === o.height && v.refreshMhz === o.refreshMhz);
      if (yaLaTenia) return;
      const m = modos[o.displayId];
      if (m && m.modes.some((x) => x.width === o.width && x.height === o.height && Math.abs(x.refreshMhz - o.refreshMhz) < 1000)) return;
      const nombre = nombreDe(o.displayId);
      if (!m || !m.modes.length) {
        throw `todavía no sé qué resoluciones acepta ${nombre}: prendela una vez o elegí "Dejar la que tenga"`;
      }
      throw `${nombre} no reporta ${textoModo(o)}: elegí una de su lista o "Dejar la que tenga"`;
    });
  }
  // El aviso de resolución distinta de aplicarEscena/probar (modos::avisos_tras_aplicar).
  function avisosDeResolucion(outputs) {
    if (!MOCK.windowsPoneOtra) return [];
    return outputs.filter((o) => o.enabled && o.width > 0).map((o) =>
      `pediste ${textoModo(o)} para ${nombreDe(o.displayId)}, pero Windows la dejó en 1920×1080 a 60 Hz`);
  }
  function avisarAplicado(outputs, esPrueba) {
    const ev = { kind: 'applied', timeoutMs: 15000 };
    if (esPrueba) ev.isTest = true;
    const avisos = avisosDeResolucion(outputs);
    if (avisos.length) ev.warnings = avisos;
    emitir('displays-confirmation', ev);
  }
  function exigirEscena(name) {
    const e = buscar(name);
    if (!e) throw `no existe la escena "${name}"`;
    return e;
  }
  function limpiarNombre(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw 'poné un nombre para la escena';
    return n;
  }
  const PROHIBIDOS = ['millennium-clipboard.exe', 'explorer.exe', 'dwm.exe', 'csrss.exe', 'winlogon.exe'];
  function validarAcciones(lista) {
    return (lista || []).filter((a) => a.tipo !== 'desconocida').map((a) => {
      if (a.tipo === 'volumen' && !(a.nivel >= 0 && a.nivel <= 100)) throw 'el volumen va de 0 a 100';
      if (a.tipo === 'esperar' && !(a.segundos >= 1 && a.segundos <= 30)) throw 'esperar va de 1 a 30 segundos';
      if (a.tipo === 'cerrar') {
        const exe = String(a.exe || '').toLowerCase();
        if (!/^[^\\/:]+\.exe$/.test(exe)) throw 'el programa a cerrar va como nombre.exe, sin carpeta';
        if (PROHIBIDOS.includes(exe)) throw `no se puede cerrar ${exe}: lo necesita Windows o es esta app`;
        return { tipo: 'cerrar', exe };
      }
      if (a.tipo === 'lanzar' && !String(a.destino || '').trim()) throw 'falta qué abrir';
      return clon(a);
    });
  }
  function validarPantallas(outputs) {
    const on = (outputs || []).filter((o) => o.enabled);
    if (!on.length) throw 'tiene que quedar al menos una pantalla prendida';
    const pri = (outputs || []).filter((o) => o.primary);
    if (pri.length !== 1) throw 'elegí una sola pantalla principal';
    if (!pri[0].enabled) throw 'la pantalla principal tiene que estar prendida';
    (outputs || []).forEach((o) => {
      if (!o.refreshMhz) throw `elegí una frecuencia para ${nombreDe(o.displayId)}`;
    });
    return outputs.map((o) => salida(o.displayId, !!o.enabled, !!o.primary, o.x, o.y, o.width, o.height, o.refreshMhz));
  }
  function nombreDeCopia(name) {
    let n = `${name} (copia)`;
    for (let i = 2; buscar(n); i += 1) n = `${name} (copia ${i})`;
    return n;
  }
  // Pantallas que Windows ve y la escena no nombra: se agregan apagadas.
  function completar(outputs) {
    const out = clon(outputs);
    pantallas.forEach((p) => {
      if (!out.some((o) => o.displayId === p.displayId)) out.push(salida(p.displayId, false, false, 0, 0, 0, 0, 60000));
    });
    return out;
  }
  const ajustes = { revertTimeoutSecs: 15, globalShortcutsEnabled: true };
  const perfiles = () => escenas.map((e) => ({
    name: e.name, activeCount: e.outputs.filter((o) => o.enabled).length, summary: resumen(e.outputs),
    shortcut: e.shortcut, audio: e.audio, actions: { entrada: [], salida: [] },
  }));
  const snapshotDeEscenas = () => ({ source: 'windows', displays, pending: prueba ? clon(prueba) : null });

  Object.assign(handlers, {
    displays_list_scenes: () => lista(),

    displays_scene_draft: ({ from, name } = {}) => {
      const vacio = { name: 'Escena nueva', emoji: null, audio: null, entradaV2: [], salidaV2: [], shortcut: null, startup: false };
      if (from === 'current') return { ...vacio, outputs: conNombres(puesto) };
      if (from === 'blank') {
        return { ...vacio, outputs: conNombres(pantallas.map((p) => (p.displayId === ID_CEN
          ? salida(p.displayId, true, true, 0, 0, 2560, 1440, 144000)
          : salida(p.displayId, false, false, 0, 0, 0, 0, 60000)))) };
      }
      if (from === 'scene' || from === 'copy') {
        const e = exigirEscena(name);
        const d = borradorDe({ ...e, outputs: completar(e.outputs) });
        if (from === 'copy') { d.name = nombreDeCopia(e.name); d.shortcut = null; d.startup = false; }
        return d;
      }
      throw 'no sé de dónde armar la escena';
    },

    displays_save_scene: ({ draft, originalName } = {}) => {
      exigirSinPrueba();
      const d = draft || {};
      const name = limpiarNombre(d.name);
      const original = originalName == null ? null : exigirEscena(originalName);
      if (buscar(name) && buscar(name) !== original) throw `ya hay una escena que se llama "${name}"`;
      const outputs = validarPantallas(d.outputs);
      validarResoluciones(outputs, original);
      const entradaV2 = validarAcciones(d.entradaV2);
      const salidaV2 = validarAcciones(d.salidaV2);
      const shortcut = d.shortcut || null;
      const otraConAtajo = shortcut && escenas.find((e) => e.shortcut === shortcut && e !== original);
      if (otraConAtajo) throw `ese atajo ya lo usa la escena "${otraConAtajo.name}"`;
      if (d.startup) escenas.forEach((e) => { e.startup = false; });
      const nueva = { name, emoji: d.emoji || null, outputs, audio: d.audio ? clon(d.audio) : null,
        shortcut, startup: !!d.startup, entradaV2, salidaV2 };
      if (original) {
        if (puestaAhora === original.name) puestaAhora = name;
        escenas[escenas.indexOf(original)] = nueva;
      } else {
        escenas.push(nueva);
      }
      return resultado(original && original.name !== name ? 'renamed' : 'saved', name);
    },

    displays_duplicate_scene: ({ name } = {}) => {
      exigirSinPrueba();
      const e = exigirEscena(name);
      const copia = { ...clon(e), name: nombreDeCopia(e.name), shortcut: null, startup: false };
      escenas.push(copia);
      return resultado('duplicated', copia.name);
    },

    displays_rename_scene: ({ name, newName } = {}) => {
      exigirSinPrueba();
      const e = exigirEscena(name);
      const nuevo = limpiarNombre(newName);
      if (nuevo === e.name) return { scenes: lista(), name: nuevo, warnings: [] };
      if (buscar(nuevo)) throw `ya hay una escena que se llama "${nuevo}"`;
      if (puestaAhora === e.name) puestaAhora = nuevo;
      e.name = nuevo;
      return resultado('renamed', nuevo);
    },

    displays_reorder_scenes: ({ names } = {}) => {
      exigirSinPrueba();
      const pedidos = Array.isArray(names) ? names : [];
      const mismos = pedidos.length === escenas.length && new Set(pedidos).size === pedidos.length
        && pedidos.every((n) => buscar(n));
      if (!mismos) throw 'la lista de escenas cambió mientras la ordenabas; volvé a intentar';
      escenas = pedidos.map(buscar);
      return resultado('reordered', null);
    },

    displays_test_draft: ({ draft } = {}) => {
      if (prueba) throw 'ya hay un cambio esperando que lo confirmes';
      const outputs = (draft && draft.outputs) || [];
      if (!outputs.some((o) => o.enabled)) throw 'tiene que quedar al menos una pantalla prendida';
      const ausente = outputs.find((o) => o.enabled && !pantallas.some((p) => p.displayId === o.displayId));
      if (ausente) throw `${nombreDe(ausente.displayId)} no está conectada: conectala o apagala en la escena para probar`;
      prueba = { remainingMs: 15000, isTest: true };
      avisarAplicado(outputs, true);
      return snapshotDeEscenas();
    },

    displays_confirm: () => {
      prueba = null;
      if (escenaPendiente) { puestaAhora = escenaPendiente; escenaPendiente = null; }
      emitir('displays-confirmation', { kind: 'confirmed' });
      return snapshotDeEscenas();
    },

    displays_revert: () => {
      prueba = null;
      escenaPendiente = null;
      emitir('displays-confirmation', { kind: 'reverted', reason: 'manual' });
      return snapshotDeEscenas();
    },

    displays_list_display_modes: () => pantallas.map((p) => ({
      displayId: p.displayId, name: p.name, connected: p.connected, active: p.active,
      remembered: modos[p.displayId].remembered, modes: clon(modos[p.displayId].modes),
    })),

    displays_list_steam_games: () => (MOCK.sinJuegos ? [] : [
      { appId: '1245620', name: 'Elden Ring' },
      { appId: '1145350', name: 'Hades II' },
      { appId: '252950', name: 'Rocket League' },
    ]),

    // APLICAR (de hoy): pone la escena con la cuenta regresiva; las acciones corren al confirmar.
    displays_load_profile: ({ name } = {}) => {
      exigirSinPrueba();
      const e = exigirEscena(name);
      prueba = { remainingMs: 15000, isTest: false };
      escenaPendiente = e.name;
      avisarAplicado(e.outputs, false);
      return snapshotDeEscenas();
    },

    // BORRAR (de hoy): devuelve ProfileView[]; la pantalla vuelve a pedir la lista con el evento.
    displays_delete_profile: ({ name } = {}) => {
      if (MOCK.borrarFalla) throw 'ya hay un cambio esperando que lo confirmes';
      exigirSinPrueba();
      const e = exigirEscena(name);
      escenas = escenas.filter((x) => x !== e);
      if (puestaAhora === name) puestaAhora = null;
      emitir('displays-scenes-changed', { kind: 'deleted' });
      return perfiles();
    },

    // La lista de hoy sigue a las escenas (renombrar, crear y borrar la cambian, como en el backend).
    displays_list_profiles: () => perfiles(),

    displays_get_settings: () => {
      const arranque = escenas.find((e) => e.startup);
      return { revertTimeoutSecs: ajustes.revertTimeoutSecs, startupProfileName: arranque ? arranque.name : null,
        globalShortcutsEnabled: ajustes.globalShortcutsEnabled };
    },
    displays_update_settings: ({ settings: nuevos } = {}) => {
      ajustes.revertTimeoutSecs = Number(nuevos.revertTimeoutSecs) || 15;
      ajustes.globalShortcutsEnabled = !!nuevos.globalShortcutsEnabled;
      escenas.forEach((e) => { e.startup = e.name === nuevos.startupProfileName; });
      return handlers.displays_get_settings();
    },

    displays_list_chrome_profiles: () => ({
      chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      profiles: [
        { directory: 'Default', name: 'Guido' },
        { directory: 'Profile 2', name: 'Casa' },
        { directory: 'Profile 1', name: 'Trabajo' },
      ],
    }),

    displays_list_running_programs: () => [
      { exe: 'chrome.exe', title: 'Google Chrome' },
      { exe: 'hades2.exe', title: 'Hades II' },
      { exe: 'steam.exe', title: 'Steam' },
      { exe: 'vlc.exe', title: 'VLC media player' },
    ],
  });

  // displays_get_snapshot es de hoy: sin una prueba en curso devuelve lo mismo
  // que siempre (pending: null); con PROBAR andando, trae el pending con isTest.
  const snapshotDeHoy = handlers.displays_get_snapshot;
  handlers.displays_get_snapshot = () => (prueba ? snapshotDeEscenas() : snapshotDeHoy());

  // El placeholder que se tipea solo usa Math.random: fijo, para que dos
  // corridas den el mismo DOM.
  Math.random = () => 0.5;

  // Todo comando invocado y evento escuchado queda anotado: capturar.cjs lo
  // guarda y lo compara, así un invoke/listen que se pierde al mover código
  // se nota aunque el DOM salga igual.
  window.__LLAMADAS__ = [];

  // Un handler que tira un string = el Err(String) del backend: invoke lo
  // rechaza con ese texto, como Tauri.
  async function invoke(cmd, args) {
    window.__LLAMADAS__.push('invoke ' + cmd);
    const h = handlers[cmd];
    return h ? h(args || {}) : null;
  }

  async function listen(nombre, cb) {
    window.__LLAMADAS__.push('listen ' + nombre);
    (oyentes[nombre] = oyentes[nombre] || []).push(cb);
    return () => { oyentes[nombre] = oyentes[nombre].filter((x) => x !== cb); };
  }

  window.__TAURI__ = {
    core: { invoke },
    event: { listen },
    dialog: { open: async () => null },
    notification: {
      isPermissionGranted: async () => true,
      requestPermission: async () => 'granted',
      sendNotification: async () => {},
    },
  };
})();
