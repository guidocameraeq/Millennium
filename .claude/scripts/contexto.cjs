'use strict';
// contexto.cjs — cuánto contexto lleva usado ESTA sesión y cuánto le falta (SPEC-0 P6.4; D §11: "dos umbrales medidos por un script
// que lee el transcript de la propia sesión y la ventana real del modelo"). No es hooks/lib/contexto.cjs (ese es el rol y la rama).
// Uso, desde la carpeta de la sesión (el worktree del director, del obrero o el checkout):
//   node .claude/scripts/contexto.cjs [--sesion <id> | --sesion <ruta.jsonl>] [--json] [--cwd <carpeta>]
//
// El transcript: <config>/projects/<carpeta>/<id>.jsonl, con <config> = CLAUDE_CONFIG_DIR si está, si no ~/.claude, y <carpeta> = la
// ruta de la sesión con todo lo que no es letra o número cambiado por "-" (medido en esta PC: "C:\x\(1) y" → "C--x--1--y"). Se prueba
// el cwd y, si no está, la raíz del checkout; sin distinguir mayúsculas (la letra del disco). Sin --sesion, el .jsonl más reciente de
// esa carpeta (la sesión que está escribiendo ahora; un subagente vive en <id>/subagents/ y se mide con --sesion <ruta>).
// Usado = input_tokens + cache_read_input_tokens + cache_creation_input_tokens del ÚLTIMO mensaje del asistente con usage (los
// sintéticos, sin tokens, no cuentan). La ventana sale del modelo de ese mensaje: [1m] en el id → 1M; si no, la tabla VENTANAS (la doc
// de la API, tabla del 2026-10-06); un modelo que no está ahí → 200k y NO VERIFICADO en la línea. Ojo: es la ventana de la API; la
// plataforma compacta antes (97% medido en la app de escritorio, D §11) y dónde compacta la terminal: NO VERIFICADO.
//
// CONTRATO (lo leen /estado y /director: no se cambia):
//   contexto: <usado>k de <ventana>k (<pct>%) · faltan <falta>k · <modelo>[ · NO VERIFICADO: <por qué>]   → salida 0
//   contexto: NO VERIFICADO · <por qué>                                                                  → salida 1
//   --json: {"usado","ventana","pct","falta","modelo","sesion"} (tokens enteros, pct entero; + "nota" si la ventana no es segura)
// Salidas: 0 medido · 1 NO VERIFICADO · 2 mal llamado. Node estándar, cero dependencias. Es .cjs: corre igual con "type": "module".

const fs = require('fs');
const os = require('os');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/contexto.cjs [--sesion <id> | --sesion <ruta.jsonl>] [--json] [--cwd <carpeta>]',
  '  (sin --sesion: el transcript más reciente de la carpeta de esta sesión)',
  '  contexto: <usado>k de <ventana>k (<pct>%) · faltan <falta>k · <modelo>   salida 0',
  '  contexto: NO VERIFICADO · <por qué>                                      salida 1',
  '  la ventana es la del modelo según la doc de la API; dónde compacta la plataforma: NO VERIFICADO',
].join('\n');

const MIL = 1000;
const UN_MILLON = 1000000;
const POR_DEFECTO = 200000;
// La ventana por modelo, de la doc de la API (skill claude-api, "Current Models", tabla cacheada el 2026-10-06). El id se compara
// por prefijo (un id con fecha o sufijo sigue siendo ese modelo). Lo que no está acá: 200k y NO VERIFICADO.
const VENTANAS = [
  ['claude-fable-5-1', UN_MILLON],
  ['claude-mythos-5-1', UN_MILLON],
  ['claude-fable-5', UN_MILLON],
  ['claude-opus-5-5', UN_MILLON],
  ['claude-opus-5', UN_MILLON],
  ['claude-opus-4-8', UN_MILLON],
  ['claude-opus-4-7', UN_MILLON],
  ['claude-opus-4-6', UN_MILLON],
  ['claude-sonnet-5-5', UN_MILLON],
  ['claude-sonnet-5', UN_MILLON],
  ['claude-sonnet-4-6', UN_MILLON],
  ['claude-haiku-5-5', UN_MILLON],
  ['claude-haiku-4-5', POR_DEFECTO],
];
const COLA = 4 * 1024 * 1024; // se lee el final del transcript; si ahí no hay un mensaje con usage, el archivo entero

class MalLlamado extends Error {}

// ---------------------------------------------------------------- dónde está el transcript

const carpetaConfig = (env = process.env) =>
  env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() !== '' ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');

// La carpeta de proyecto de una ruta: todo lo que no es letra o número, "-".
const nombreCarpeta = (ruta) => path.resolve(ruta).replace(/[^A-Za-z0-9]/g, '-');

// La carpeta de proyectos que corresponde a alguna de las rutas (exacta, o sin distinguir mayúsculas). null si ninguna.
function carpetaDeSesion(proyectos, rutas) {
  let hay;
  try {
    hay = fs.readdirSync(proyectos);
  } catch (e) {
    return null;
  }
  for (const r of rutas) {
    if (!r) continue;
    const n = nombreCarpeta(r);
    if (hay.includes(n)) return path.join(proyectos, n);
    const parecida = hay.find((h) => h.toLowerCase() === n.toLowerCase());
    if (parecida) return path.join(proyectos, parecida);
  }
  return null;
}

// El .jsonl más reciente de la carpeta (solo el primer nivel: los subagentes viven más abajo).
function masReciente(carpeta) {
  let mejor = null;
  for (const e of fs.readdirSync(carpeta, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const p = path.join(carpeta, e.name);
    const t = fs.statSync(p).mtimeMs;
    if (!mejor || t > mejor.t) mejor = { p, t };
  }
  return mejor ? mejor.p : null;
}

// La raíz del checkout por fs (subiendo hasta un .git), sin lanzar git: este script lo corre el director a cada rato.
function raizPorFs(cwd) {
  let d = path.resolve(cwd);
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
  return null;
}

// ---------------------------------------------------------------- el último mensaje con usage

const entero = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Del texto de un transcript (renglones JSON), el último mensaje del asistente con tokens: { usado, modelo, pedido } o null.
function ultimoUso(texto) {
  const lineas = texto.split('\n');
  for (let i = lineas.length - 1; i >= 0; i--) {
    const l = lineas[i].trim();
    if (!l || l[0] !== '{') continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch (e) {
      continue; // el primer renglón de la cola puede venir cortado
    }
    if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') continue;
    const u = o.message.usage;
    if (!u || typeof u !== 'object') continue;
    const usado = entero(u.input_tokens) + entero(u.cache_read_input_tokens) + entero(u.cache_creation_input_tokens);
    if (usado === 0) continue; // los sintéticos (errores de API, "<synthetic>") no dicen nada del contexto
    const modelo = typeof o.message.model === 'string' ? o.message.model : '';
    return { usado, modelo, pedido: typeof o.requestedModel === 'string' ? o.requestedModel : '' };
  }
  return null;
}

function leerUso(archivo) {
  const tam = fs.statSync(archivo).size;
  const fd = fs.openSync(archivo, 'r');
  try {
    const leer = (desde) => {
      const b = Buffer.alloc(tam - desde);
      fs.readSync(fd, b, 0, b.length, desde);
      return b.toString('utf8');
    };
    if (tam > COLA) {
      const u = ultimoUso(leer(tam - COLA));
      if (u) return u;
    }
    return ultimoUso(leer(0));
  } finally {
    fs.closeSync(fd);
  }
}

// ventanaDe(modelo, pedido) → { ventana, segura }.
function ventanaDe(modelo, pedido = '') {
  if (/\[1m\]/i.test(modelo) || /\[1m\]/i.test(pedido)) return { ventana: UN_MILLON, segura: true };
  const id = modelo.toLowerCase();
  const fila = VENTANAS.find(([p]) => id === p || id.startsWith(`${p}-`) || id.startsWith(`${p}[`) || id.startsWith(`${p}@`));
  return fila ? { ventana: fila[1], segura: true } : { ventana: POR_DEFECTO, segura: false };
}

// ---------------------------------------------------------------- medir

// medir({cwd, sesion, env}) → { ok: true, usado, ventana, pct, falta, modelo, sesion, nota? } · { ok: false, por }.
function medir(o = {}) {
  const env = o.env || process.env;
  const cwd = path.resolve(o.cwd || process.cwd());
  const proyectos = path.join(carpetaConfig(env), 'projects');
  let archivo = null;
  const s = typeof o.sesion === 'string' ? o.sesion.trim() : '';
  if (s && (s.endsWith('.jsonl') || s.includes('/') || s.includes('\\'))) {
    archivo = path.resolve(cwd, s);
    if (!fs.existsSync(archivo)) return { ok: false, por: `no existe el transcript ${archivo}` };
  } else {
    const carpeta = carpetaDeSesion(proyectos, [cwd, raizPorFs(cwd)]);
    if (!carpeta) return { ok: false, por: `no encuentro la carpeta de esta sesión en ${proyectos} (buscada: ${nombreCarpeta(cwd)})` };
    if (s) {
      if (!/^[A-Za-z0-9-]+$/.test(s)) return { ok: false, por: `"${s}" no es un id de sesión` };
      archivo = path.join(carpeta, `${s}.jsonl`);
      if (!fs.existsSync(archivo)) return { ok: false, por: `no hay sesión ${s} en ${carpeta}` };
    } else {
      archivo = masReciente(carpeta);
      if (!archivo) return { ok: false, por: `no hay ningún transcript en ${carpeta}` };
    }
  }
  let u;
  try {
    u = leerUso(archivo);
  } catch (e) {
    return { ok: false, por: `no pude leer ${archivo} (${e.code || e.message})` };
  }
  if (!u) return { ok: false, por: `el transcript ${path.basename(archivo)} no tiene todavía un mensaje del asistente con tokens` };
  const modelo = u.modelo || u.pedido || '(sin modelo)';
  const v = ventanaDe(u.modelo, u.pedido);
  const r = {
    ok: true,
    usado: u.usado,
    ventana: v.ventana,
    pct: Math.round((u.usado * 100) / v.ventana),
    falta: Math.max(0, v.ventana - u.usado),
    modelo,
    sesion: path.basename(archivo, '.jsonl'),
  };
  if (!v.segura) r.nota = `la ventana de ${modelo} no la sé: supongo ${v.ventana / MIL}k`;
  return r;
}

const k = (n) => `${Math.round(n / MIL)}k`;
function linea(m) {
  if (!m.ok) return `contexto: NO VERIFICADO · ${m.por}`;
  return `contexto: ${k(m.usado)} de ${k(m.ventana)} (${m.pct}%) · faltan ${k(m.falta)} · ${m.modelo}${m.nota ? ` · NO VERIFICADO: ${m.nota}` : ''}`;
}

// ---------------------------------------------------------------- main

function leerArgumentos(argv) {
  const a = { json: false, sesion: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--sesion' || x === '--cwd') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new MalLlamado(`${x} pide un valor`);
      a[x.slice(2)] = v;
    } else if (x === '-h' || x === '--help' || x === '--ayuda') throw new MalLlamado('');
    else throw new MalLlamado(`no conozco "${String(x).slice(0, 40)}"`);
  }
  return a;
}

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  let a;
  try {
    a = leerArgumentos(argv);
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message ? `${e.message}\n` : ''}${USO}\n`);
      return 2;
    }
    throw e;
  }
  let m;
  try {
    m = medir({ cwd: a.cwd || opciones.cwd, sesion: a.sesion, env: opciones.env });
  } catch (e) {
    m = { ok: false, por: `contexto roto: ${e && e.message ? String(e.message).split('\n')[0].slice(0, 160) : 'algo falló'}` };
  }
  if (m.ok && a.json) {
    const j = { usado: m.usado, ventana: m.ventana, pct: m.pct, falta: m.falta, modelo: m.modelo, sesion: m.sesion };
    if (m.nota) j.nota = m.nota;
    salida(`${JSON.stringify(j)}\n`);
  } else salida(`${linea(m)}\n`);
  return m.ok ? 0 : 1;
}

if (require.main === module) {
  let codigo = 1;
  try {
    codigo = main(process.argv.slice(2));
  } catch (e) {
    process.stdout.write('contexto: NO VERIFICADO · contexto roto\n');
  }
  process.exitCode = codigo;
}

module.exports = { USO, VENTANAS, carpetaConfig, nombreCarpeta, carpetaDeSesion, ultimoUso, ventanaDe, medir, linea, main };
