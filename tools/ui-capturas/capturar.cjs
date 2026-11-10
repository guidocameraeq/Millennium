#!/usr/bin/env node
// Banco de capturas del frontend (encargo 05). Sin dependencias: usa el Edge
// instalado en modo headless, controlado por su puerto de depuración (CDP) con
// el WebSocket que trae Node, y un window.__TAURI__ falso (mock-tauri.js).
// (El msedge.exe de línea de comandos no devuelve --dump-dom en esta PC.)
//
//   node tools/ui-capturas/capturar.cjs [antes|despues]   guarda DOM + PNG de CLIP y DISP
//   node tools/ui-capturas/capturar.cjs --comparar        captura "despues" y la compara con "antes"
//
// Sin argumento guarda en "despues". La referencia ("antes") se commitea.
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AQUI = __dirname;
const SRC = path.resolve(AQUI, '..', '..', 'src');
const CAPTURAS = path.join(AQUI, 'capturas');
const EDGE = process.env.EDGE_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const VISTAS = ['clip', 'disp'];
// Los relojes de la app (diagnóstico a 1,5 s, status a 2,2 s) terminan antes.
const ESPERA_MS = 3500;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function aUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

// Copia de index.html en la carpeta temporal: mock antes de los scripts de la
// app, errores al DOM, y (para DISP) un clic en la pestaña Displays.
function armarHtml(tmp, vista) {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const base = '<base href="' + aUrl(SRC) + '/">';
  const errores = [
    '<script id="__banco_errores__">window.__ERRORES__=[];',
    'function __err(m){window.__ERRORES__.push(String(m));var d=document.getElementById("__errores__");',
    'if(!d){d=document.createElement("pre");d.id="__errores__";(document.body||document.documentElement).appendChild(d);}',
    'd.textContent=window.__ERRORES__.join("\\n");}',
    'window.onerror=function(m,f,l){__err("JS ERROR: "+m+" @"+String(f).split("/").pop()+":"+l);};',
    'window.addEventListener("unhandledrejection",function(e){__err("JS REJECT: "+(e.reason&&e.reason.message||e.reason));});</script>',
  ].join('\n');
  const mock = '<script id="__banco_mock__">' + fs.readFileSync(path.join(AQUI, 'mock-tauri.js'), 'utf8') + '</script>';
  html = html.replace(/<head>/i, () => '<head>' + base + errores + mock);
  if (vista === 'disp') {
    const clic = '<script id="__banco_clic__">window.addEventListener("load",function(){setTimeout(function(){' +
      'var b=document.querySelector(\'[data-action="section-displays"]\');if(b)b.click();},300);});</script>';
    html = html.replace(/<\/body>/i, () => clic + '</body>');
  }
  const out = path.join(tmp, vista + '.html');
  fs.writeFileSync(out, html);
  return out;
}

// El volcado incluye <base> y los scripts del banco (rutas del checkout, no de
// la app); se sacan para comparar solo la app.
function normalizar(s) {
  return s.replace(/\r\n/g, '\n')
    .replace(/<base href="[^"]*">/g, '')
    .replace(/<script id="__banco_[a-z]+__">[\s\S]*?<\/script>/g, '');
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
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && espera.has(d.id)) {
      const { ok, ko } = espera.get(d.id);
      espera.delete(d.id);
      if (d.error) ko(new Error(d.error.message)); else ok(d.result);
    }
  };
  const abierto = new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('WebSocket CDP')); });
  const llamar = (method, params = {}) => new Promise((ok, ko) => {
    const n = ++id;
    espera.set(n, { ok, ko });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { abierto, llamar, cerrar: () => ws.close() };
}

async function capturar(destino) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-capturas-'));
  const dir = path.join(CAPTURAS, destino);
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
    for (const vista of VISTAS) {
      await c.llamar('Page.navigate', { url: aUrl(armarHtml(tmp, vista)) });
      await dormir(ESPERA_MS);
      const r = await c.llamar('Runtime.evaluate',
        { expression: 'document.documentElement.outerHTML', returnByValue: true });
      fs.writeFileSync(path.join(dir, vista + '.dom.html'), normalizar(r.result.value));
      const sh = await c.llamar('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(dir, vista + '.png'), Buffer.from(sh.data, 'base64'));
      console.log('ok ' + destino + '/' + vista + ': dom + png');
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

function comparar() {
  let ok = true;
  for (const vista of VISTAS) {
    const a = path.join(CAPTURAS, 'antes', vista + '.dom.html');
    const d = path.join(CAPTURAS, 'despues', vista + '.dom.html');
    if (!fs.existsSync(a) || !fs.existsSync(d)) {
      console.error('falta ' + (!fs.existsSync(a) ? a : d));
      ok = false;
      continue;
    }
    const sa = fs.readFileSync(a, 'utf8');
    const sd = fs.readFileSync(d, 'utf8');
    const err = /id="__errores__"[^>]*>([^<]+)/.exec(sd);
    if (err) {
      console.error('[' + vista + '] hubo un error JS: ' + err[1].split('\n')[0]);
      ok = false;
    }
    if (sa === sd) {
      console.log('[' + vista + '] DOM igual');
      continue;
    }
    ok = false;
    const la = sa.split('\n');
    const ld = sd.split('\n');
    let n = 0;
    console.error('[' + vista + '] DOM distinto:');
    for (let i = 0; i < Math.max(la.length, ld.length) && n < 8; i++) {
      if (la[i] !== ld[i]) {
        console.error('  línea ' + (i + 1) + '\n    antes:   ' + (la[i] || '').slice(0, 160) +
          '\n    despues: ' + (ld[i] || '').slice(0, 160));
        n++;
      }
    }
  }
  return ok;
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--comparar') {
    if (!(await capturar('despues'))) process.exit(1);
    process.exit(comparar() ? 0 : 1);
  }
  process.exit((await capturar(arg === 'antes' ? 'antes' : 'despues')) ? 0 : 1);
})();
