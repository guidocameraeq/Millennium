'use strict';
// git.cjs — corre git sin shell y con tiempo límite, y saca la edad de cada renglón con `git blame --line-porcelain`.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".
// Nunca tira por un git que falla: devuelve { ok: false, … } (o null en los atajos) y el que llama decide.

const { spawnSync } = require('child_process');

// Un hook entero tiene 20 s (settings.json); un git solo no se puede comer más de 5.
const TIEMPO_GIT = 5000;
const BUFFER_MAX = 32 * 1024 * 1024;

// El plazo del hook ENTERO (E4b): ~15 gits de ~250 ms en Windows suman 10-24 s con la PC cargada, y si Claude Code mata el
// hook la sesión arranca sin nada. Con plazo fijado, cada git corre con lo que quede (nunca más que lo pedido) y, si queda
// menos que el mínimo, ni se lanza: { ok: false, error: 'plazo' }. Sin plazo (doctor, revisarTopes), como siempre.
const TIEMPO_MINIMO = 300;
let plazo = null; // ms epoch, o null
let reloj = Date.now;
let salteadas = 0; // las consultas que el plazo no dejó correr (o cortó) desde que se fijó

// fijarPlazo(msEpoch, reloj) — null lo saca. `reloj` (para las pruebas): una función que da ms epoch. La cuenta arranca de cero.
function fijarPlazo(fin, otroReloj) {
  plazo = Number.isFinite(fin) ? fin : null;
  reloj = typeof otroReloj === 'function' ? otroReloj : Date.now;
  salteadas = 0;
}
// Lo que queda del plazo, en ms (Infinity sin plazo).
const plazoRestante = () => (plazo === null ? Infinity : plazo - reloj());
// tiempoPara(pedido) → el tope de un proceso: lo pedido, o lo que quede si es menos; null si lo que queda no llega al mínimo.
function tiempoPara(pedido) {
  const queda = plazoRestante();
  if (queda < TIEMPO_MINIMO) return null;
  return Math.floor(Math.min(pedido, queda)); // spawnSync solo acepta enteros (el inicio del proceso viene con decimales)
}
const salteadasPorPlazo = () => salteadas;

// Variables que, si vienen heredadas (un hook de git, otra herramienta), hacen que git mire OTRO repo que el del cwd.
const VARIABLES_QUE_DESVIAN = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
];

function entorno() {
  const env = { ...process.env };
  for (const v of VARIABLES_QUE_DESVIAN) delete env[v];
  env.GIT_OPTIONAL_LOCKS = '0'; // leer no traba el índice de una sesión que está escribiendo
  env.GIT_TERMINAL_PROMPT = '0'; // jamás pregunta usuario o clave
  return env;
}

// correr(args, {cwd, tiempo, entrada}) → { ok, codigo, stdout (texto), salida (Buffer), stderr, error }
// Con plazo, error 'plazo': no se lanzó por falta de tiempo, o se cortó con el tope que el plazo le achicó. Se cuenta.
function correr(args, opciones = {}) {
  const pedido = opciones.tiempo || TIEMPO_GIT;
  const tiempo = tiempoPara(pedido);
  if (tiempo === null) {
    salteadas++;
    return { ok: false, codigo: null, stdout: '', salida: Buffer.alloc(0), stderr: '', error: 'plazo' };
  }
  const r = spawnSync('git', args, {
    cwd: opciones.cwd || process.cwd(),
    timeout: tiempo,
    input: opciones.entrada,
    env: entorno(),
    windowsHide: true,
    maxBuffer: BUFFER_MAX,
    shell: false,
  });
  const salida = r.stdout || Buffer.alloc(0);
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  let error = null;
  if (r.error) error = r.error.code === 'ETIMEDOUT' ? 'tiempo' : r.error.code === 'ENOENT' ? 'sin-git' : String(r.error.code || r.error.message);
  else if (r.signal) error = 'tiempo';
  if (error === 'tiempo' && tiempo < pedido) {
    error = 'plazo';
    salteadas++;
  }
  return {
    ok: !error && r.status === 0,
    codigo: r.status,
    stdout: salida.toString('utf8'),
    salida,
    stderr,
    error,
  };
}

// Atajo: la salida recortada si anduvo, null si no.
function texto(args, opciones) {
  const r = correr(args, opciones);
  return r.ok ? r.stdout.replace(/\s+$/, '') : null;
}

const SHA_CERO = /^0+$/;

// edades(archivo, {cwd, rev}) → [{ linea, sha, fecha, fechaCommit, sinCommitear, texto }] o null si git no puede.
// `fecha` es la del autor (cuándo se escribió el renglón); `fechaCommit`, la del commit. Un renglón sin commitear trae
// sinCommitear: true y fechas null. Con `rev`, el blame es de esa revisión (sin lo del disco).
function edades(archivo, opciones = {}) {
  const args = ['blame', '--line-porcelain'];
  if (opciones.rev) args.push(opciones.rev);
  args.push('--', archivo);
  const r = correr(args, opciones);
  if (!r.ok) return null;
  const lineas = r.stdout.split('\n');
  const res = [];
  let actual = null;
  for (const l of lineas) {
    if (actual === null) {
      const m = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(l);
      if (m) actual = { linea: Number(m[2]), sha: m[1], autor: null, commit: null };
      continue;
    }
    if (l.startsWith('\t')) {
      const sinCommitear = SHA_CERO.test(actual.sha);
      res.push({
        linea: actual.linea,
        sha: actual.sha,
        fecha: sinCommitear || actual.autor === null ? null : new Date(actual.autor * 1000),
        fechaCommit: sinCommitear || actual.commit === null ? null : new Date(actual.commit * 1000),
        sinCommitear,
        texto: l.slice(1).replace(/\r$/, ''),
      });
      actual = null;
      continue;
    }
    const a = /^author-time (\d+)$/.exec(l);
    if (a) actual.autor = Number(a[1]);
    const c = /^committer-time (\d+)$/.exec(l);
    if (c) actual.commit = Number(c[1]);
  }
  return res;
}

module.exports = { TIEMPO_GIT, TIEMPO_MINIMO, fijarPlazo, plazoRestante, tiempoPara, salteadasPorPlazo, correr, texto, edades };
