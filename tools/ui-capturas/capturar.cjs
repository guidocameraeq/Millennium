#!/usr/bin/env node
// Banco de capturas del frontend (encargo 05). Sin dependencias: usa el Edge
// instalado en modo headless, controlado por su puerto de depuración (CDP) con
// el WebSocket que trae Node, y un window.__TAURI__ falso (mock-tauri.js).
// (El msedge.exe de línea de comandos no devuelve --dump-dom en esta PC.)
//
//   node tools/ui-capturas/capturar.cjs antes            guarda la referencia (se niega si ya existe; --pisar la reemplaza)
//   node tools/ui-capturas/capturar.cjs despues          guarda la corrida de hoy
//   node tools/ui-capturas/capturar.cjs --comparar       captura en una carpeta temporal del sistema (no escribe en el repo) y la compara con "antes"
//   ... --vistas a,b                                      (con antes, despues o --comparar) limita a esas vistas
//
// Por vista guarda el DOM, una PNG y la lista de comandos invoke/listen que la
// app usó. UI_SRC=<carpeta> apunta a otra copia de src/ (p. ej. el código viejo).
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AQUI = __dirname;
const SRC = path.resolve(process.env.UI_SRC || path.join(AQUI, '..', '..', 'src'));
const CAPTURAS = path.join(AQUI, 'capturas');
const EDGE = process.env.EDGE_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// Cada vista: una lista de selectores a los que se les hace clic, en orden.
const VISTAS = {
  clip: [],
  'clip-all': ['.filter-btn[data-filter="all"]'],
  disp: ['[data-action="section-displays"]'],
  'disp-lista': ['[data-action="section-displays"]', '.displays-tab[data-tab="list"]'],
  // Pestaña ESCENAS (encargo 05). 'disp-perfiles' ya no existe: PERFILES pasó a ser ESCENAS (capturas/antes/ guarda la vieja).
  'esc-lista': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]'],
  'esc-menu': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more'],
  'esc-borrar': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-del'],
  'esc-nueva': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '#scenes-new'],
  'esc-editor': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-edit'],
  'esc-editor-apagadas': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(1) .scene-edit', '.scene-screens tr:nth-child(1) .scene-sw-btn:nth-child(2)', '.scene-screens tr:nth-child(2) .scene-sw-btn:nth-child(2)'],
  // Alto de ventana más grande (ver ALTO): el editor entero en una sola PNG.
  'esc-editor-largo': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-edit'],
  'esc-guardar-nueva': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '#scenes-new', '.scene-from-current', '.scene-save'],
  'esc-duplicar': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-dup'],
  'esc-renombrar': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(3) .scene-more', '.scene-card:nth-child(3) .scene-rename'],
  'esc-subir': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(3) .scene-up'],
  'esc-cancelar-sucio': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(1) .scene-edit', '.scene-emoji:nth-child(3)', '.scene-bar .modal-btn'],
  // Menú ⋯ abierto en una tarjeta, después una prueba: al volver, sus botones tienen que estar apagados.
  'esc-bloqueada': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(1) .scene-edit', '.scene-test', '.scene-back'],
  'esc-actualizar-si': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-upd', '.scene-card:nth-child(2) .scene-upd-yes'],
  'esc-actualizar': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-upd'],
  'esc-probando': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(1) .scene-edit', '.scene-test'],
  // Recorridos que el 05 no ejercía (encargo 06). Los pasos { set } y { mock } los entiende armarHtml.
  'esc-aplicar-aviso': [{ mock: '__MOCK__.windowsPoneOtra=true' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-apply'],
  'esc-guardar-aviso': [{ mock: '__MOCK__.avisoAtajo=true' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-edit', '.scene-save'],
  'esc-probar-aviso': [{ mock: '__MOCK__.windowsPoneOtra=true' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-edit', '.scene-test'],
  'esc-copia-editor': [{ mock: '__MOCK__.conProyector()' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '#scenes-new', '.scene-from-copy', '.scene-copy-pick[data-name="Película"]'],
  'esc-copia-guardar': [{ mock: '__MOCK__.conProyector()' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '#scenes-new', '.scene-from-copy', '.scene-copy-pick[data-name="Película"]', '.scene-save'],
  'esc-renombrar-ajustes': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(3) .scene-more', '.scene-card:nth-child(3) .scene-rename', { set: '.scene-rename-input', value: 'Cine' }, '.scene-rename-ok', '.displays-tab[data-tab="settings"]'],
  'esc-volumen-vacio': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '#scenes-new', '.scene-from-blank', { set: '.scene-col:nth-child(1) > select', value: 'volumen' }, { set: '.scene-form-input', value: '' }],
  'esc-juego-sin-lista': [{ mock: '__MOCK__.sinJuegos=true' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(1) .scene-edit', { set: '.scene-col:nth-child(1) > select', value: 'juego' }],
  'esc-borrar-falla': [{ mock: '__MOCK__.borrarFalla=true' }, '[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-del', '.scene-card:nth-child(2) .scene-del-yes'],
  'esc-nombre-repetido': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-edit', { set: '#scene-ed-name', value: 'Trabajo' }],
  'esc-renombrar-repetido': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-rename', { set: '.scene-rename-input', value: 'Trabajo' }, '.scene-rename-ok'],
  'esc-renombrar-prueba': ['[data-action="section-displays"]', '.displays-tab[data-tab="scenes"]', '.scene-card:nth-child(2) .scene-more', '.scene-card:nth-child(2) .scene-rename', '.scene-card:nth-child(1) .scene-edit', '.scene-test', '.scene-back'],
  'disp-ajustes': ['[data-action="section-displays"]', '.displays-tab[data-tab="settings"]'],
  'disp-lienzo': ['[data-action="section-displays"]', '.displays-tab[data-tab="canvas"]'],
};
// Los relojes de la app (diagnóstico a 1,5 s, status a 2,2 s) terminan antes;
// se cuenta desde que la página terminó de cargar.
// Vistas que se capturan con otra altura de ventana (por defecto 760).
const ALTO = { 'esc-editor-largo': 2300 };
const ESPERA_MS = 3500;
const PLAZO_LLAMADA_MS = 30000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function aUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

// Copia de index.html en la carpeta temporal: mock antes de los scripts de la
// app, errores al DOM (incluidos los de carga de un archivo) y los clics de la
// vista una vez cargada la página.
function armarHtml(tmp, vista) {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const base = '<base href="' + aUrl(SRC) + '/">';
  const errores = [
    '<script id="__banco_errores__">window.__ERRORES__=[];',
    'function __err(m){window.__ERRORES__.push(String(m));var d=document.getElementById("__errores__");',
    'if(!d){d=document.createElement("pre");d.id="__errores__";(document.body||document.documentElement).appendChild(d);}',
    'd.textContent=window.__ERRORES__.join("\\n");}',
    'window.onerror=function(m,f,l){__err("JS ERROR: "+m+" @"+String(f).split("/").pop()+":"+l);};',
    'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href))__err("NO CARGO: "+(t.src||t.href));},true);',
    'window.addEventListener("unhandledrejection",function(e){__err("JS REJECT: "+(e.reason&&e.reason.message||e.reason));});</script>',
  ].join('\n');
  const mock = '<script id="__banco_mock__">' + fs.readFileSync(path.join(AQUI, 'mock-tauri.js'), 'utf8') + '</script>';
  // Animaciones y transiciones apagadas solo en el banco: así la huella de
  // estilos y las PNG no dependen de en qué cuadro cae la captura.
  const quieto = '<style id="__banco_estilo__">*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>';
  html = html.replace(/<head>/i, () => '<head>' + base + errores + mock + quieto);
  const clics = VISTAS[vista];
  if (clics.length) {
    // Un paso es un selector (clic), { set: selector, value } (escribe en un campo) o
    // { mock: 'js' } (ajusta el mock: window.__MOCK__).
    const paso = (p) => {
      if (typeof p === 'string') {
        return 'var b=document.querySelector(' + JSON.stringify(p) + ');if(b)b.click();else __err("NO HAY: "+' + JSON.stringify(p) + ');';
      }
      if (p.mock) return 'try{' + p.mock + '}catch(e){__err("MOCK: "+e);}';
      return 'var i=document.querySelector(' + JSON.stringify(p.set) + ');if(i){i.value=' + JSON.stringify(p.value) +
        ';i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new Event("change",{bubbles:true}));}else __err("NO HAY: "+' + JSON.stringify(p.set) + ');';
    };
    const js = 'window.addEventListener("load",function(){' + clics.map((p, i) =>
      'setTimeout(function(){' + paso(p) + '},' + (300 + i * 300) + ');').join('') + '});';
    html = html.replace(/<\/body>/i, () => '<script id="__banco_clic__">' + js + '</script></body>');
  }
  const out = path.join(tmp, vista + '.html');
  fs.writeFileSync(out, html);
  return out;
}

// El volcado incluye <base> y los scripts del banco (rutas del checkout, no de
// la app); se sacan para comparar solo la app. También se sacan las etiquetas
// que CARGAN archivos (<script src>, <link rel=stylesheet>) y los comentarios:
// partir main.js/styles.css cambia cómo se cargan, no lo que se ve. Un archivo
// que no cargara se nota igual: el DOM quedaría vacío o con error.
function normalizar(s) {
  return s.replace(/\r\n/g, '\n')
    .replace(/<base href="[^"]*">/g, '')
    .replace(/<script id="__banco_[a-z]+__">[\s\S]*?<\/script>/g, '')
    .replace(/<style id="__banco_estilo__">[\s\S]*?<\/style>/g, '')
    .replace(/<script src="[^"]*"><\/script>/g, '')
    .replace(/<link rel="stylesheet"[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n[ \t]*(?=\n)/g, '');
}

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function conectar(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const lista = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pagina = lista.find((t) => t.type === 'page');
      if (pagina) return pagina.webSocketDebuggerUrl;
    } catch (_) { /* Edge todavía arrancando */ }
    await dormir(200);
  }
  throw new Error('Edge no abrió el puerto de depuración');
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const espera = new Map();
  const rechazarTodo = (e) => { for (const { ko } of espera.values()) ko(e); espera.clear(); };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && espera.has(d.id)) {
      const { ok, ko } = espera.get(d.id);
      espera.delete(d.id);
      if (d.error) ko(new Error(d.error.message)); else ok(d.result);
    }
  };
  ws.onclose = () => rechazarTodo(new Error('Edge cerró la conexión'));
  const abierto = new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('WebSocket CDP')); });
  const llamar = (method, params = {}) => new Promise((ok, ko) => {
    const n = ++id;
    const t = setTimeout(() => { espera.delete(n); ko(new Error('Edge no contestó ' + method)); }, PLAZO_LLAMADA_MS);
    espera.set(n, { ok: (r) => { clearTimeout(t); ok(r); }, ko: (e) => { clearTimeout(t); ko(e); } });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { abierto, llamar, cerrar: () => ws.close() };
}

async function evaluar(c, expression) {
  const r = await c.llamar('Runtime.evaluate', { expression, returnByValue: true });
  return r.result.value;
}

// Una línea por elemento (y por ::before/::after con contenido): ruta + huella
// de TODOS sus estilos calculados. Detecta una regla que cambió de orden o se
// perdió al partir styles.css, que el DOM solo no ve.
const HUELLA = `(() => {
  const h = (t) => { let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(16); };
  // Edge lista las variables --x en orden cambiante: se ordenan antes de hashear.
  const props = (cs) => Array.from(cs, (k) => k + ':' + cs.getPropertyValue(k)).sort().join(';').split(document.baseURI).join('~/');
  const out = [];
  // Sin <script> ni <link rel=stylesheet>: partir los archivos cambia cuántos hay.
  Array.from(document.querySelectorAll('*:not(script):not(link[rel="stylesheet"])')).forEach((el, i) => {
    const id = el.id ? '#' + el.id : '';
    const cl = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    let l = i + ' ' + el.tagName.toLowerCase() + id + cl + ' ' + h(props(getComputedStyle(el)));
    for (const p of ['::before', '::after']) {
      const cs = getComputedStyle(el, p);
      if (cs.content && cs.content !== 'none' && cs.content !== 'normal') l += ' ' + p + h(props(cs));
    }
    out.push(l);
  });
  return out.join('\\n');
})()`;

async function capturar(destino, dir, vistas) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-capturas-'));
  fs.mkdirSync(dir, { recursive: true });
  const port = await puertoLibre();
  const perfil = path.join(tmp, 'perfil'); // propio, nunca el de Guido
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--force-device-scale-factor=1', '--allow-file-access-from-files',
    '--window-size=1100,760', '--remote-debugging-port=' + port, '--user-data-dir=' + perfil,
    'about:blank',
  ], { stdio: 'ignore' });
  let c;
  try {
    c = cdp(await conectar(port));
    await c.abierto;
    await c.llamar('Page.enable');
    await c.llamar('Emulation.setDeviceMetricsOverride',
      { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    for (const vista of vistas) {
      await c.llamar('Emulation.setDeviceMetricsOverride',
        { width: 1100, height: ALTO[vista] || 760, deviceScaleFactor: 1, mobile: false });
      await c.llamar('Page.navigate', { url: aUrl(armarHtml(tmp, vista)) });
      for (let i = 0; i < 100 && (await evaluar(c, 'document.readyState')) !== 'complete'; i++) await dormir(100);
      await dormir(ESPERA_MS);
      const dom = await evaluar(c, 'document.documentElement.outerHTML');
      fs.writeFileSync(path.join(dir, vista + '.dom.html'), normalizar(dom));
      fs.writeFileSync(path.join(dir, vista + '.estilos.txt'), (await evaluar(c, HUELLA)) + '\n');
      // Estado de cada @font-face: una ruta de fuente rota queda en "error".
      const fuentes = await evaluar(c, 'Array.from(document.fonts).map((f) => f.family + " " + f.weight + " " + f.status).sort().join("\\n")');
      fs.writeFileSync(path.join(dir, vista + '.fuentes.txt'), fuentes + '\n');
      const llamadas = await evaluar(c, 'Array.from(new Set(window.__LLAMADAS__||[])).sort().join("\\n")');
      fs.writeFileSync(path.join(dir, vista + '.llamadas.txt'), llamadas + '\n');
      const sh = await c.llamar('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(dir, vista + '.png'), Buffer.from(sh.data, 'base64'));
      console.log('ok ' + destino + '/' + vista + ': dom + llamadas + png');
    }
    try { await c.llamar('Browser.close'); } catch (_) { /* ya cerró */ }
    return true;
  } catch (e) {
    console.error('FALLO el banco: ' + e.message);
    return false;
  } finally {
    if (c) c.cerrar();
    edge.kill();
    await dormir(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* perfil aún cerrándose */ }
  }
}

// El DOM comparado no lleva las etiquetas de carga (normalizar las saca), así
// que acá se mira aparte: todo archivo de src/js y src/css tiene su etiqueta.
function cargaCompleta() {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  let ok = true;
  for (const [carpeta, ext, etiqueta] of [['js', '.js', 'src="js/'], ['css', '.css', 'href="css/']]) {
    const dir = path.join(SRC, carpeta);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(ext))) {
      if (!html.includes(etiqueta + f + '"')) {
        console.error('index.html no carga ' + carpeta + '/' + f);
        ok = false;
      }
    }
  }
  if (ok) console.log('index.html carga todo src/js y src/css');
  return ok;
}

// Las vistas de Clipboard no miran la sección Displays (está oculta ahí): lo que
// se haga en esa pantalla no puede mover el gate de CLIP. Se saca su subárbol del
// DOM y las líneas de estilos de sus elementos (y el número de línea, que se corre).
function sinDisplaysDom(dom) {
  const a = dom.indexOf('<section class="displays-section"');
  const b = a < 0 ? -1 : dom.indexOf('</section>', a);
  return a < 0 || b < 0 ? dom : dom.slice(0, a) + dom.slice(b + '</section>'.length);
}
function sinDisplaysEstilos(estilos, dom) {
  const a = dom.indexOf('<section class="displays-section"');
  const b = a < 0 ? -1 : dom.indexOf('</section>', a);
  const lineas = estilos.split('\n');
  const k = lineas.findIndex((l) => /^\d+ section#displays-section\b/.test(l));
  if (a < 0 || b < 0 || k < 0) return estilos;
  const n = (dom.slice(a, b + '</section>'.length).match(/<[a-zA-Z][^\s>\/]*/g) || []).length;
  return lineas.slice(0, k).concat(lineas.slice(k + n)).map((l) => l.replace(/^\d+ /, '')).join('\n');
}

function comparar(dirDespues, vistas) {
  let ok = cargaCompleta();
  for (const vista of vistas) {
    const lf = (s) => s.replace(/\r\n/g, '\n');
    for (const [ext, norm] of [['dom.html', normalizar], ['llamadas.txt', lf], ['estilos.txt', lf], ['fuentes.txt', lf]]) {
      const a = path.join(CAPTURAS, 'antes', vista + '.' + ext);
      const d = path.join(dirDespues, vista + '.' + ext);
      if (!fs.existsSync(a) || !fs.existsSync(d)) {
        console.error('falta ' + (!fs.existsSync(a) ? a : d));
        ok = false;
        continue;
      }
      // normalizar también al leer: git puede haber pasado "antes" a CRLF al
      // clonar en Windows, y la referencia se guardó con reglas más cortas.
      let sa = norm(fs.readFileSync(a, 'utf8'));
      let sd = norm(fs.readFileSync(d, 'utf8'));
      if (vista.startsWith('clip') && (ext === 'dom.html' || ext === 'estilos.txt')) {
        const domDe = (dir) => normalizar(fs.readFileSync(path.join(dir, vista + '.dom.html'), 'utf8'));
        if (ext === 'dom.html') { sa = sinDisplaysDom(sa); sd = sinDisplaysDom(sd); }
        else {
          sa = sinDisplaysEstilos(sa, domDe(path.join(CAPTURAS, 'antes')));
          sd = sinDisplaysEstilos(sd, domDe(dirDespues));
        }
      }
      const err = ext === 'dom.html' && /id="__errores__"[^>]*>([^<]+)/.exec(sd);
      if (err) {
        console.error('[' + vista + '] hubo un error JS: ' + err[1].split('\n')[0]);
        ok = false;
      }
      if (sa === sd) {
        console.log('[' + vista + '] ' + ext + ' igual');
        continue;
      }
      ok = false;
      const la = sa.split('\n');
      const ld = sd.split('\n');
      let n = 0;
      console.error('[' + vista + '] ' + ext + ' distinto:');
      for (let i = 0; i < Math.max(la.length, ld.length) && n < 8; i++) {
        if (la[i] !== ld[i]) {
          console.error('  línea ' + (i + 1) + '\n    antes:   ' + (la[i] || '').slice(0, 160) +
            '\n    despues: ' + (ld[i] || '').slice(0, 160));
          n++;
        }
      }
    }
  }
  return ok;
}

(async () => {
  const args = process.argv.slice(2);
  const arg = args[0];
  // --vistas a,b: solo esas vistas (por defecto, todas).
  const iv = args.indexOf('--vistas');
  const vistas = iv >= 0 ? String(args[iv + 1] || '').split(',').filter(Boolean) : Object.keys(VISTAS);
  const desconocidas = vistas.filter((v) => !VISTAS[v]);
  if (!vistas.length || desconocidas.length) {
    console.error('vistas desconocidas: ' + (desconocidas.join(', ') || '(ninguna indicada)') +
      '. Hay: ' + Object.keys(VISTAS).join(', '));
    process.exit(arg === '--comparar' ? 1 : 2);
  }
  if (arg === '--comparar') {
    // Captura en una carpeta temporal del sistema: el árbol del repo queda como está.
    const tmpDespues = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-comparar-'));
    try {
      const capturo = await capturar('despues', tmpDespues, vistas);
      process.exitCode = capturo && comparar(tmpDespues, vistas) ? 0 : 1;
    } finally {
      try { fs.rmSync(tmpDespues, { recursive: true, force: true }); } catch (_) { /* ya no está */ }
    }
    return;
  }
  const guardar = async (destino) => {
    const dir = path.join(CAPTURAS, destino);
    fs.mkdirSync(dir, { recursive: true });
    return capturar(destino, dir, vistas);
  };
  if (arg === 'despues') process.exit((await guardar('despues')) ? 0 : 1);
  if (arg === 'antes') {
    const existe = fs.existsSync(path.join(CAPTURAS, 'antes', 'clip.dom.html'));
    if (existe && args[1] !== '--pisar') {
      console.error('capturas/antes ya existe y es la referencia: no se pisa sin --pisar.');
      process.exit(2);
    }
    process.exit((await guardar('antes')) ? 0 : 1);
  }
  console.error('uso: capturar.cjs antes [--pisar] | despues | --comparar  [--vistas a,b]');
  process.exit(2);
})();
