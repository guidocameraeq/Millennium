'use strict';
// kit-githook.cjs — el runner de .githooks/pre-commit, pre-merge-commit y pre-push (SPEC-paquete-3 P4.6; F §10; RT1-7, RT2-4,
// RT2-9; r4-3, rf-7, rf-10; r1-2, r1-6, r1-19). Lo llama el `sh` de tres renglones de cada hook: node .githooks/kit-githook.cjs <cuál> "$@".
//
// pre-commit: gitleaks sobre lo staged; candado:barreras SOLO del índice (lo del disco sin `git add` no traba, rf-10); el hook previo.
// pre-merge-commit (un merge automático no corre pre-commit): gitleaks y el previo, SIN candado (rf3-1): git no escribe MERGE_HEAD
// antes de este hook, así que el candado juzgaría el merge solo contra HEAD y frenaría lo aprobado en la otra rama; el merge lo
// juzga el pre-push, contra cada padre. (Un merge con conflictos se cierra con git commit: ahí corre el pre-commit, con MERGE_HEAD.)
// pre-push, antes que nada (h11, D8c-1/D8c-2): lo que sube cada rol — el obrero (también sin .kit-rol, por la rama) solo su
// modulo/<x>--<ID>; nocturno y desconocido solo modulo/*; humano, director y actualizador todo. Si no, 1: a la rama por defecto
// sube solo el director (worktree.cjs integrar). Los borrados no se miran (los decide git-seguro).
// pre-push: por cada ref que sube, lo que el remoto no tiene
// (`<remoto>..<local>`, o para una ref nueva `<ceros>..<local>`: lo que ningún remoto tiene): gitleaks y `barreras --rango` (rf-7).
// El candado corre DOS veces (r4-3, r1-2 a): la versión de la ref vigente (con remoto origin/<rama por defecto>; sin remoto la rama
// local), sacada con UN `git cat-file --batch` a un temporal fuera del repo y corrida con el cwd en el repo, y la del disco. Rojo si
// cualquiera da rojo. La ref sin ficha (nunca tuvo kit): solo la del disco, y lo dice. La ref con ficha y sin candado, o el de la ref
// que sale 2 por otra cosa que "no conoce --indice/--rango", rojo. Si no conoce la bandera (es del orden 2): sin ella, y lo dice.
// El actualizador en su clon (D6-6, crit. 17 del delta 6): SOLO con .kit-rol = actualizador y KIT_MOLDE una carpeta que existe, los dos
// candados van con --molde KIT_MOLDE (y --molde-viejo KIT_MOLDE_VIEJO, si es una carpeta); si no, se ignoran y lo dice (sin valores).
// La ref con ficha y sin candado (un v2.4.2) corre ahí el candado del molde; el de la ref que no conoce una de esas, sin ella.
// gitleaks: plazo de 60 s y un reintento (47 s en frío con Defender, r1-6, r2-10); dos veces colgado = "sin escáner (colgado)". Sin
// escáner: humano, director y obrero pasan EN ROJO (con aviso y renglón); nocturno, actualizador y desconocido → 1. Uno de día con
// la marca .kit-noche (la propia o la del director de un obrero) cuenta como nocturno (crit. 16 del delta 5).
// Lo que ve gitleaks lo arma el runner (rf2-1): `gitleaks git` le pide el diff a git, y un `.gitattributes` con `-diff` (o un
// `git -c core.attributesFile=…`) lo vuelve "binario" y la clave pasa. El runner saca él las líneas agregadas — pre-commit
// `git diff --cached` (con MERGE_HEAD, `git diff --cc <árbol del índice> HEAD <MERGE_HEAD…>`, u9), pre-push `git log -p --cc
// <local> --not <remoto> <vigente>` (también lo que agrega un merge; nueva = agregada contra todos los padres), siempre con --text --no-textconv
// --no-ext-diff — y las escribe en un temporal, cada una en su archivo y su línea (más un renglón de cabecera, para que gitleaks no
// tome el archivo por binario); corre `gitleaks dir .` ahí, con el cwd en el temporal (las rutas que ve son las del repo: sus
// allowlist de rutas valen igual) y mapea cada hallazgo a su archivo:línea (y commit) de verdad.
// La configuración de gitleaks (rf3-2, rf2-6): la que se juzga, no la del disco — el .gitleaks.toml del índice (en el pre-push, el de
// lo que sube) va con -c (sin él, uno que solo extiende el de fábrica) y su .gitleaksignore lo aplica el runner (archivo:regla:línea
// o commit:archivo:regla:línea); gitleaks no lee nada del repo. Lo del disco sin `git add` no cambia nada (ni traba).
// Entorno (rf3-3, rf2-1, rf2-4): el sh deshace las funciones env, sed, command y echo que bash importa del entorno
// (BASH_FUNC_env%%) y borra toda NODE_* antes de llamar a node; el runner saca NODE_*, GITLEAKS_* y las GIT_CONFIG_* de un `git -c`
// del entorno de todo lo que lanza (git, los dos candados, gitleaks y el previo).
// frenos.log (rf3-6, rf2-3): todo lo que el hook agrega a .claude/frenos.log (verde o ROJO, el runner o los candados) se muda a
// <git-common-dir>/kit-frenos.log, sin versionar: un githook nunca ensucia el árbol (si no, el `git pull --rebase` que pide falla).
// Todo error del runner → 1 con motivo (r1-19). Lo que imprime: `archivo:línea` y la regla; NUNCA un valor ni la salida de gitleaks.
// El runner corre del disco (D-12): solo necesita node y git; las librerías del kit las usa la versión del candado que corre.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CUALES = Object.freeze(['pre-commit', 'pre-merge-commit', 'pre-push']);
const PLAZO_GITLEAKS = 60000;
const REINTENTOS_GITLEAKS = 1;
const ROLES_PASAN_SIN_ESCANER = Object.freeze(['humano', 'director', 'obrero']);
const ROLES = ['director', 'obrero', 'nocturno', 'actualizador'];
const RUTA_FICHA = '.claude/kit.md';
const RUTA_ESTRUCTURA = '.claude/scripts/estructura.cjs';
// Lo que hace falta para correr la versión de la ref: el script y sus librerías (las fichas de fábrica incluidas).
const RUTAS_CANDADO = Object.freeze([RUTA_ESTRUCTURA, '.claude/hooks/lib']);
const RUTA_FRENOS_LOG = '.claude/frenos.log';
// Las rutas de barrera (las categorías de cambios.categoriaDe), para ver si un índice aparte (commit -a, commit <rutas>) las cambia.
const RUTAS_BARRERA = Object.freeze([
  RUTA_FICHA,
  '.claude/settings*.json',
  '.claude/hooks',
  '.claude/scripts/estructura.cjs',
  '.claude/scripts/cambios.cjs',
  '.githooks',
  '.gitleaksignore',
  '.gitleaks.toml',
]);
const SIN_ESCANER = '⚠️ sin escáner en esta PC: corré "preparame esta PC"';
// h11: la rama de un obrero (contexto.pestana) y el corazón del texto (el mismo que el de git-seguro push-otra-rama).
const RE_RAMA_OBRERO = /^modulo\/([^/]+?)--([^/]+)$/;
const SOLO_EL_DIRECTOR = 'a la rama por defecto sube solo el director (worktree.cjs integrar) o vos desde la carpeta principal';
const ROTO = 'error interno — corré doctor';
const CEROS = /^0+$/;
const RE_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Variables que, heredadas del hook, hacen que git mire otro repo que el del cwd (las de lib/git.cjs). El índice no: es el del commit.
const DESVIAN = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
// rf3-3, rf3-2 y rf2-1: las que meten código en un node (NODE_OPTIONS --require, NODE_PATH…), cambian lo que gitleaks busca
// (GITLEAKS_CONFIG, GITLEAKS_CONFIG_TOML…) o le meten configuración a git (las de `git -c`: GIT_CONFIG_PARAMETERS, y
// GIT_CONFIG_COUNT con sus GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n). Sin distinguir mayúsculas: en Windows node_options vale como NODE_OPTIONS.
const INYECTAN = /^(node|gitleaks)_|^git_config_(parameters|count|key_\d+|value_\d+)$/i;
// Las que cambian el diff que el runner le pide a git (además, va con --no-ext-diff y -U0).
const DESVIAN_DIFF = ['GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_DIFF_PATH_COUNTER', 'GIT_DIFF_PATH_TOTAL'];
// rf2-1: las banderas del diff que se le muestra a gitleaks — texto siempre (ni -diff, ni binary, ni bigFileThreshold), sin textconv
// ni diff externo, sin renombres (un archivo movido trae todas sus líneas), sin relative, sin contexto y con los prefijos fijos.
const DIFF_TEXTO = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-renames', '--no-relative', '-U0', '--src-prefix=a/', '--dst-prefix=b/']);
const MARCA_COMMIT = '\x01kit-commit ';
// El renglón 1 de cada archivo que ve gitleaks: así ninguno empieza con la firma de un binario (gitleaks salta un PK\x03\x04).
const CABECERA = 'kit-githook';
// Sin .gitleaks.toml en lo que se juzga: el de fábrica, explícito (sin -c, gitleaks buscaría uno en el cwd).
const TOML_DE_FABRICA = '[extend]\nuseDefault = true\n';
// Lo que gitleaks levanta solo de la raíz que escanea: un archivo agregado con ese nombre va a un cajón aparte.
const LEE_GITLEAKS = /^\.?gitleaks(ignore|\.toml)$|^\.gitleaksbaseline/i;
const CAJON = '.kit-githook-';
const LOG_SIN_VERSIONAR = 'kit-frenos.log';

class Falla extends Error {}
const falla = (m) => {
  throw new Falla(m);
};

// ---------------------------------------------------------------- git

// El entorno sin lo que inyecta (INYECTAN): el de todo lo que el runner lanza.
function sinInyectadas(env) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (!INYECTAN.test(k)) e[k] = v;
  return e;
}
function entornoGit(env, conIndice) {
  const e = { ...env };
  for (const k of Object.keys(e)) if (DESVIAN.includes(k.toUpperCase()) || DESVIAN_DIFF.includes(k.toUpperCase())) delete e[k];
  if (!conIndice) delete e.GIT_INDEX_FILE;
  e.GIT_TERMINAL_PROMPT = '0';
  return e;
}
// git(args, {cwd, env, entrada, indice}) → { ok, codigo, stdout (texto), salida (Buffer), stderr }. Tira (Falla) si git no corre.
function git(args, o) {
  const r = spawnSync('git', args, {
    cwd: o.cwd,
    env: entornoGit(o.env, o.indice),
    input: o.entrada,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  });
  if (r.error) falla(r.error.code === 'ENOENT' ? 'no hay git en esta PC' : `git ${args[0]} no corrió (${r.error.code || r.error.message})`);
  const salida = r.stdout || Buffer.alloc(0);
  return { ok: r.status === 0, codigo: r.status, salida, stdout: salida.toString('utf8'), stderr: r.stderr ? r.stderr.toString('utf8') : '' };
}
const gitTexto = (args, o) => {
  const r = git(args, o);
  return r.ok ? r.stdout.replace(/\s+$/, '') : null;
};
const existeCommit = (sha, o) => git(['cat-file', '-e', `${sha}^{commit}`], o).ok;
const existeBlob = (ref, rel, o) => git(['cat-file', '-e', `${ref}:${rel}`], o).ok;
// Los otros padres de un merge en curso (los SHA de MERGE_HEAD, como barreras.mergeHeads), o [] si no hay merge. Tira si no se leen.
function mergeHeads(o) {
  const donde = gitTexto(['rev-parse', '--git-path', 'MERGE_HEAD'], o);
  if (!donde) falla('git rev-parse no anduvo');
  let t;
  try {
    t = fs.readFileSync(path.resolve(o.raiz, donde), 'utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const l of t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const sha = gitTexto(['rev-parse', '-q', '--verify', `${l}^{commit}`], o);
    if (!sha) falla('MERGE_HEAD no se lee');
    if (!out.includes(sha)) out.push(sha);
  }
  return out;
}

// ---------------------------------------------------------------- dónde estamos (sin las librerías del kit: el runner es autónomo)

function datosRepo(cwd, env) {
  const t = gitTexto(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd, env });
  if (!t) falla('no estoy dentro de un repo git');
  const [raiz, gitDir, gitComun] = t.split('\n').map((s) => path.resolve(s.trim()));
  return { raiz, gitDir, gitComun };
}

// El rol, como contexto.rol: sin .kit-rol, humano; uno de los cuatro, tal cual; otra cosa (o ilegible), desconocido.
function rolDe(raiz) {
  let t;
  try {
    t = fs.readFileSync(path.join(raiz, '.kit-rol'), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'humano' : 'desconocido';
  }
  t = t.replace(/^﻿/, '').trim();
  return ROLES.includes(t) ? t : 'desconocido';
}

// De noche, como contexto.deNoche (crit. 16 del delta 5): la marca .kit-noche en la raíz de este checkout o, si la rama es de un
// obrero (modulo/<x>--<ID>), en la del worktree del director (la rama modulo/<x>, por `git worktree list --porcelain`). Si git
// falla, no inventa noche. El .kit-rol nocturno ya lo mira rolDe.
function marcaDeNoche(raiz, o) {
  const hay = (dir) => {
    try {
      fs.statSync(path.join(dir, '.kit-noche'));
      return true;
    } catch (e) {
      return !!e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR';
    }
  };
  if (hay(raiz)) return true;
  try {
    const m = RE_RAMA_OBRERO.exec(ramaHead(o) || '');
    if (!m) return false;
    const t = gitTexto(['worktree', 'list', '--porcelain'], o);
    if (!t) return false;
    let ruta = null;
    for (const l of t.split('\n').map((s) => s.replace(/\r$/, ''))) {
      if (l.startsWith('worktree ')) ruta = l.slice('worktree '.length);
      else if (ruta && l === `branch refs/heads/modulo/${m[1]}`) return hay(path.resolve(ruta));
    }
  } catch (e) {
    /* sin git no hay noche que mirar: decide el .kit-rol */
  }
  return false;
}

// La rama del HEAD de este checkout (null con HEAD suelto o sin git).
function ramaHead(o) {
  return gitTexto(['symbolic-ref', '--short', '-q', 'HEAD'], o) || null;
}

// El rol con el que se juzga: el de .kit-rol; sin .kit-rol (o humano) en una rama de obrero (modulo/<x>--<ID>), obrero (h11 rt-6,
// como agente.cjs: un obrero que borra su .kit-rol sigue siendo obrero); y uno de día (humano, director, obrero) con la marca
// .kit-noche pasa a nocturno.
function rolEfectivo(raiz, o) {
  let rol = rolDe(raiz);
  if (rol === 'humano' && RE_RAMA_OBRERO.test(ramaHead(o) || '')) rol = 'obrero';
  return ROLES_PASAN_SIN_ESCANER.includes(rol) && marcaDeNoche(raiz, o) ? 'nocturno' : rol;
}

// h11 (D8c-2): lo que sube cada rol, por la ref remota. obrero: solo refs/heads/<su HEAD>, si es modulo/<x>--<ID>; nocturno y
// desconocido: solo refs/heads/modulo/*; humano, director y actualizador: todo (los demás frenos deciden). → true si puede.
function puedeSubir(rol, refRemota, rama) {
  if (rol === 'obrero') return !!rama && RE_RAMA_OBRERO.test(rama) && refRemota === `refs/heads/${rama}`;
  if (rol === 'nocturno' || rol === 'desconocido') return /^refs\/heads\/modulo\/[^/]/.test(refRemota);
  return true;
}

// El texto de h11, con el sujeto del rol.
function textoSoloElDirector(refRemota, rol, rama) {
  const quien = rol === 'obrero' ? 'un obrero' : rol === 'nocturno' ? 'el turno de noche (nocturno)' : 'un rol desconocido (.kit-rol ilegible)';
  const tuya = rol === 'obrero' ? (rama && RE_RAMA_OBRERO.test(rama) ? rama : 'modulo/<x>--<ID>') : 'modulo/<x> o modulo/<x>--<ID>';
  return `pre-push: a ${refRemota} no sube ${quien}: ${SOLO_EL_DIRECTOR}; vos pusheás ${tuya}`;
}

// La ref vigente, como contexto.refVigente (regla de 4.7): origin/HEAD si apunta a una candidata; si no origin/<candidata>; sin
// remoto (o sin ninguna en origin), la rama local. Candidatas: init.defaultBranch (si no es modulo/* ni worktree-*), main, master.
function refVigente(o) {
  const cands = [];
  const conf = gitTexto(['config', '--get', 'init.defaultBranch'], o);
  if (conf && conf.trim() && !/^(modulo\/|worktree-)/i.test(conf.trim())) cands.push(conf.trim());
  for (const n of ['main', 'master']) if (!cands.includes(n)) cands.push(n);
  const remotos = (gitTexto(['remote'], o) || '').split('\n').map((s) => s.trim());
  if (remotos.includes('origin')) {
    const head = gitTexto(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], o);
    if (head && head.startsWith('refs/remotes/origin/')) {
      const apunta = head.slice('refs/remotes/origin/'.length);
      if (cands.includes(apunta) && existeCommit(`refs/remotes/origin/${apunta}`, o)) return { nombre: `origin/${apunta}`, ref: `refs/remotes/origin/${apunta}` };
    }
    for (const n of cands) if (existeCommit(`refs/remotes/origin/${n}`, o)) return { nombre: `origin/${n}`, ref: `refs/remotes/origin/${n}` };
  }
  for (const n of cands) if (existeCommit(`refs/heads/${n}`, o)) return { nombre: n, ref: `refs/heads/${n}` };
  return null;
}

// ---------------------------------------------------------------- el renglón de frenos.log (formato de D2.1; la librería del disco)

function anotar(raiz, rol, cual, id, detalle, o) {
  try {
    const lib = path.join(raiz, '.claude', 'hooks', 'lib', 'frenos-log.cjs');
    if (!fs.existsSync(lib)) return;
    const rama = gitTexto(['symbolic-ref', '--short', '-q', 'HEAD'], o);
    require(lib).anotar(raiz, { id, herramienta: cual, detalle, rol, rama }, o.ahora || new Date());
  } catch (e) {
    /* el renglón es rastro, no freno: sin él, la salida igual dice lo que pasó */
  }
}

// rf3-6 y rf2-3: frenos.log está versionado; si el hook le agrega renglones (los del runner, la ficha rota de los candados), el árbol
// queda sucio (pull --rebase falla —el que pide el rojo remoto-adelantado—, worktree remove también). Se saca una foto al empezar y,
// al terminar (verde, ROJO o error), lo agregado se muda a <git-common-dir>/kit-frenos.log (sin versionar; el común, para que
// sobreviva a un worktree remove) y frenos.log vuelve a como estaba. Solo lo agregado al final: si alguien lo reescribió en el medio, no se toca.
function fotoLog(raiz) {
  const archivo = path.join(raiz, ...RUTA_FRENOS_LOG.split('/'));
  try {
    return { archivo, antes: fs.readFileSync(archivo) };
  } catch (e) {
    return { archivo, antes: null };
  }
}
function mudarLoDelPase(foto, gitComun) {
  try {
    let ahora;
    try {
      ahora = fs.readFileSync(foto.archivo);
    } catch (e) {
      return;
    }
    const antes = foto.antes || Buffer.alloc(0);
    if (ahora.length <= antes.length || !ahora.subarray(0, antes.length).equals(antes)) return;
    const nuevo = ahora.subarray(antes.length).toString('utf8').replace(/^\n/, '');
    fs.appendFileSync(path.join(gitComun, LOG_SIN_VERSIONAR), nuevo);
    if (foto.antes === null) fs.rmSync(foto.archivo);
    else fs.writeFileSync(foto.archivo, foto.antes);
  } catch (e) {
    /* rastro, no freno */
  }
}

// ---------------------------------------------------------------- rf2-1: lo que ve gitleaks

// Un archivo de lo que se juzga (ref = '' para el índice del commit; si no, un commit) → Buffer, o null si no está.
function blobDe(ref, rel, o) {
  const r = git(['cat-file', 'blob', `${ref}:${rel}`], { ...o, indice: ref === '' });
  return r.ok ? r.salida : null;
}

// Las líneas agregadas del diff que dio git (pre-commit) o del log -p --cc (pre-push, con MARCA_COMMIT). El texto viene en latin1
// (un char = un byte: las líneas vuelven a escribirse tal cual). → [{ commit, archivo, linea, texto }]. Tira (Falla) si no lo entiende.
function agregadas(texto) {
  const out = [];
  let commit = null;
  let archivo = null;
  let hunk = null; // { n (padres), nueva (la línea que sigue), quedan: { nueva, viejas[] } }
  for (const l of texto.split('\n')) {
    if (hunk) {
      if (l.startsWith('\\')) continue; // "\ No newline at end of file"
      const pre = l.slice(0, hunk.n).padEnd(hunk.n, ' '); // diff.suppressBlankEmpty: un contexto vacío viene sin el espacio
      if (!/^[ +-]*$/.test(pre)) falla('no entendí el diff de git (una línea rara adentro de un bloque)');
      const enResultado = !pre.includes('-');
      if (enResultado) {
        // u9 (rt-u9-4): nueva es la agregada contra TODOS los padres ('+' en cada columna); la que está en un padre (' ' en su
        // columna) vino de ahí, y la juzgó el commit de ese lado.
        if (!pre.includes(' ') && archivo !== null) out.push({ commit, archivo, linea: hunk.nueva, texto: l.slice(hunk.n) });
        hunk.nueva++;
        hunk.quedan.nueva--;
      }
      // en el padre i: la quitó ('-'), o está en el resultado y no la agregó ese padre (' ')
      for (let i = 0; i < hunk.n; i++) if (pre[i] === '-' || (pre[i] === ' ' && enResultado)) hunk.quedan.viejas[i]--;
      if (hunk.quedan.nueva <= 0 && hunk.quedan.viejas.every((x) => x <= 0)) hunk = null;
      continue;
    }
    if (l.startsWith(MARCA_COMMIT)) {
      commit = l.slice(MARCA_COMMIT.length).trim();
      if (!RE_SHA.test(commit)) falla('no entendí el log de git (un commit sin sha)');
      archivo = null;
    } else if (l.startsWith('diff ')) archivo = null;
    else if (l.startsWith('+++ ')) archivo = rutaDelDiff(l.slice(4));
    else if (l.startsWith('@@')) {
      const m = /^(@{2,}) (.+?) \1(?: |$)/.exec(l);
      if (!m) falla('no entendí el diff de git (un encabezado de bloque raro)');
      const n = m[1].length - 1;
      const rangos = m[2].split(' ');
      const cuenta = (r, signo) => {
        const x = new RegExp(`^\\${signo}(\\d+)(?:,(\\d+))?$`).exec(r || '');
        if (!x) falla('no entendí el diff de git (un rango raro)');
        return { desde: Number(x[1]), largo: x[2] === undefined ? 1 : Number(x[2]) };
      };
      if (rangos.length !== n + 1) falla('no entendí el diff de git (un rango raro)');
      const viejas = rangos.slice(0, n).map((r) => cuenta(r, '-').largo);
      const nueva = cuenta(rangos[n], '+');
      hunk = { n, nueva: nueva.desde, quedan: { nueva: nueva.largo, viejas } };
      if (nueva.largo <= 0 && viejas.every((x) => x <= 0)) hunk = null;
    }
  }
  return out;
}

// "+++ b/ruta", "+++ /dev/null" o entre comillas a lo C (core.quotePath). → la ruta (utf8) o null (se borró).
function rutaDelDiff(s) {
  s = s.replace(/\t$/, ''); // git le agrega un tab a un nombre con espacios
  if (s === '/dev/null') return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) falla('no entendí el diff de git (una ruta entre comillas rota)');
    const ESC = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    s = s.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, c) => (c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : ESC[c] !== undefined ? ESC[c] : c));
  }
  if (!s.startsWith('b/')) falla('no entendí el diff de git (una ruta sin b/)');
  return Buffer.from(s.slice(2), 'latin1').toString('utf8');
}

// Un pedazo de ruta que se pueda escribir en cualquier PC (Windows: sin <>:"|?*, sin nombres reservados, sin punto o espacio al final).
function segmentoSeguro(s) {
  let t = s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
  if (t === '' || t === '.' || t === '..' || /[. ]$/.test(t)) t += '_';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(t)) t = `_${t}`;
  return t;
}

// Escribe las líneas agregadas en <dir>/<ruta> (renglón 1: CABECERA; la línea L del repo es la L+1 del archivo). Si dos chocan (la
// misma línea del mismo archivo en dos commits, dos rutas que solo difieren en mayúsculas, un archivo y una carpeta con el mismo
// nombre, o un archivo que gitleaks leería como su configuración), el segundo va a un cajón .kit-githook-N/. → Map(ruta escrita →
// { archivo, lineas: Map(línea escrita → { linea, commit }) }).
function materializar(lineas, dir) {
  const cajones = []; // [{ archivos: Map(clave → {escrita, archivo, contenido: Map}), carpetas: Set(clave) }]
  const mapa = new Map();
  for (const x of lineas) {
    const segs = x.archivo.split('/').map(segmentoSeguro);
    const raizDe = segs[0].toLowerCase();
    const aparte = (segs.length === 1 && LEE_GITLEAKS.test(segs[0])) || raizDe.startsWith(CAJON);
    for (let c = aparte ? 1 : 0; ; c++) {
      if (!cajones[c]) cajones[c] = { archivos: new Map(), carpetas: new Set() };
      const cajon = cajones[c];
      const escrita = (c === 0 ? segs : [`${CAJON}${c}`, ...segs]).join('/');
      const clave = escrita.toLowerCase();
      const padres = [];
      for (let i = 1; i < segs.length; i++) padres.push((c === 0 ? segs.slice(0, i) : [`${CAJON}${c}`, ...segs.slice(0, i)]).join('/').toLowerCase());
      const ya = cajon.archivos.get(clave);
      const choca = ya ? ya.archivo !== x.archivo || ya.contenido.has(x.linea) : cajon.carpetas.has(clave) || padres.some((p) => cajon.archivos.has(p));
      if (choca) continue;
      let f = ya;
      if (!f) {
        f = { escrita, archivo: x.archivo, contenido: new Map(), commits: new Map() };
        cajon.archivos.set(clave, f);
        for (const p of padres) cajon.carpetas.add(p);
      }
      f.contenido.set(x.linea, x.texto);
      f.commits.set(x.linea, x.commit);
      break;
    }
  }
  const base = path.resolve(dir);
  for (const cajon of cajones) {
    if (!cajon) continue;
    for (const f of cajon.archivos.values()) {
      const destino = path.join(base, ...f.escrita.split('/'));
      if (!destino.startsWith(base + path.sep)) falla('una ruta rara en lo que se le muestra a gitleaks');
      let max = 0;
      for (const i of f.contenido.keys()) if (i > max) max = i;
      const renglones = [CABECERA];
      const lineas = new Map();
      for (let i = 1; i <= max; i++) {
        renglones.push(f.contenido.has(i) ? f.contenido.get(i) : '');
        if (f.contenido.has(i)) lineas.set(i + 1, { linea: i, commit: f.commits.get(i) });
      }
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, Buffer.from(renglones.join('\n') + '\n', 'latin1'));
      mapa.set(f.escrita, { archivo: f.archivo, lineas });
    }
  }
  return mapa;
}

// El .gitleaksignore de lo que se juzga → Set de huellas (archivo:regla:línea o commit:archivo:regla:línea).
function huellasIgnoradas(buf) {
  const s = new Set();
  if (!buf) return s;
  for (const l of buf.toString('utf8').replace(/^\uFEFF/, '').split('\n')) {
    const t = l.trim();
    if (t && !t.startsWith('#')) s.add(t);
  }
  return s;
}

let vueltaGitleaks = 0;
// gitleaks sobre las líneas agregadas de `texto` (un diff o un log -p), con la configuración de `refConfig`. → lo de correrGitleaks,
// con los hallazgos ya en el archivo:línea (y commit) del repo y sin los del .gitleaksignore.
function escanearCambios(texto, refConfig, o) {
  if (!o.gitleaks) return { estado: 'sin-escaner', por: 'no está' };
  const lineas = agregadas(texto);
  if (!lineas.length) return { estado: 'verde' };
  const k = vueltaGitleaks++;
  const dir = path.join(o.tmp, `escaneo-${k}`);
  const conf = path.join(o.tmp, `conf-${k}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(conf, { recursive: true });
  const mapa = materializar(lineas, dir);
  const toml = path.join(conf, 'gitleaks.toml');
  fs.writeFileSync(toml, blobDe(refConfig, '.gitleaks.toml', o) || TOML_DE_FABRICA);
  const ignorar = huellasIgnoradas(blobDe(refConfig, '.gitleaksignore', o));
  // -i: una carpeta vacía (el .gitleaksignore lo aplica el runner, con las líneas del repo)
  const g = correrGitleaks(['dir', '.', '--config', toml, '--gitleaks-ignore-path', conf], { ...o, cwdGitleaks: dir });
  if (g.estado !== 'rojo') return g;
  const hallazgos = [];
  for (const h of g.hallazgos) {
    const f = mapa.get(h.archivo.replace(/^\.\//, ''));
    const l = f && f.lineas.get(h.linea);
    const x = { archivo: f ? f.archivo : '?', linea: l ? l.linea : '?', regla: h.regla, commit: l ? l.commit : null };
    if (l && (ignorar.has(`${x.archivo}:${x.regla}:${x.linea}`) || (x.commit && ignorar.has(`${x.commit}:${x.archivo}:${x.regla}:${x.linea}`)))) continue;
    hallazgos.push(x);
  }
  return hallazgos.length ? { estado: 'rojo', hallazgos } : { estado: 'verde' };
}

// ---------------------------------------------------------------- gitleaks

// El ejecutable, buscado en el PATH (no se corre para buscarlo). null si no está.
function buscarGitleaks(env) {
  const clave = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = clave ? String(env[clave]).split(path.delimiter).filter(Boolean) : [];
  const nombres = process.platform === 'win32' ? ['gitleaks.exe'] : ['gitleaks'];
  for (const d of dirs) {
    for (const n of nombres) {
      const p = path.join(d.replace(/^"|"$/g, ''), n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (e) {
        /* acá no está */
      }
    }
  }
  return null;
}

// Los hallazgos del reporte JSON: [{archivo, linea, regla, commit}] (nunca el valor). null si el reporte no se lee.
function leerReporte(archivo) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(archivo, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(j)) return null;
  return j.map((h) => ({
    archivo: typeof h.File === 'string' ? h.File.replace(/\\/g, '/') : '?',
    linea: Number.isInteger(h.StartLine) ? h.StartLine : '?',
    regla: typeof h.RuleID === 'string' ? h.RuleID.replace(/[^\w.:-]/g, '') : '?',
    commit: typeof h.Commit === 'string' && RE_SHA.test(h.Commit) ? h.Commit : null,
  }));
}

// correrGitleaks(args, {raiz, env, tmp, plazo, reintentos, gitleaks}) → { estado: 'verde' } · { estado: 'rojo', hallazgos } ·
// { estado: 'sin-escaner', por: 'no está' | 'colgado' }. Tira (Falla) si corre y no sale ni 0 ni 1 con reporte.
function correrGitleaks(args, o) {
  const exe = o.gitleaks === undefined ? buscarGitleaks(o.env) : o.gitleaks;
  if (!exe) return { estado: 'sin-escaner', por: 'no está' };
  const intentos = 1 + (Number.isInteger(o.reintentos) ? o.reintentos : REINTENTOS_GITLEAKS);
  for (let i = 0; i < intentos; i++) {
    const reporte = path.join(o.tmp, `gitleaks-${i}-${process.pid}.json`);
    const r = spawnSync(exe, [...args, '--redact', '--no-banner', '--report-format', 'json', '--report-path', reporte], {
      cwd: o.cwdGitleaks || o.raiz, // el temporal con lo que se juzga: gitleaks no lee nada del repo
      env: o.env,
      windowsHide: true,
      timeout: o.plazo || PLAZO_GITLEAKS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], // su salida no se muestra: el runner dice archivo:línea y la regla
    });
    if ((r.error && r.error.code === 'ETIMEDOUT') || (r.signal && !r.error)) continue;
    if (r.error && r.error.code === 'ENOENT') return { estado: 'sin-escaner', por: 'no está' };
    if (r.error) falla(`gitleaks no corrió (${r.error.code || r.error.message})`);
    if (r.status === 0) return { estado: 'verde' };
    const hallazgos = r.status === 1 ? leerReporte(reporte) : null;
    if (hallazgos && hallazgos.length) return { estado: 'rojo', hallazgos };
    falla(`gitleaks salió con ${r.status} sin hallazgos que se lean (¿versión vieja? hace falta ≥ 8.19)`);
  }
  return { estado: 'sin-escaner', por: 'colgado' };
}

// ---------------------------------------------------------------- el candado (dos versiones)

// Saca la versión de la ref del candado a <tmp>/ref/ con UN `git cat-file --batch`. → la ruta del estructura.cjs, o null si la ref no lo trae.
function extraerCandado(ref, o) {
  const ls = git(['ls-tree', '-r', '-z', ref, '--', ...RUTAS_CANDADO], o);
  if (!ls.ok) falla(`no pude listar el candado de ${ref}`);
  const blobs = [];
  for (const e of ls.stdout.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(e);
    if (m) blobs.push({ sha: m[1], rel: m[2] });
  }
  if (!blobs.some((b) => b.rel === RUTA_ESTRUCTURA)) return null;
  const r = git(['cat-file', '--batch'], { ...o, entrada: blobs.map((b) => b.sha).join('\n') + '\n' });
  if (!r.ok) falla(`no pude sacar el candado de ${ref}`);
  const b = r.salida;
  let p = 0;
  const base = path.join(o.tmp, 'ref');
  for (const x of blobs) {
    const fin = b.indexOf(0x0a, p);
    const cab = b.subarray(p, fin).toString('utf8').split(' ');
    if (fin < 0 || cab[0] !== x.sha || cab[1] !== 'blob') falla(`el candado de ${ref} no salió entero de git cat-file`);
    const largo = Number(cab[2]);
    const destino = path.join(base, ...x.rel.split('/'));
    if (!destino.startsWith(base + path.sep)) falla(`una ruta rara en el candado de ${ref}`);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, b.subarray(fin + 1, fin + 1 + largo));
    p = fin + 1 + largo + 1;
  }
  return path.join(base, ...RUTA_ESTRUCTURA.split('/'));
}

// Corre un estructura.cjs con el cwd en el repo. → { codigo, lineas (stdout), err (stderr) }.
function correrEstructura(script, args, o) {
  const r = spawnSync(process.execPath, [script, 'barreras', ...args], {
    cwd: o.raiz,
    env: entornoGit(o.env, false),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) falla(`el candado no corrió (${r.error.code || r.error.message})`);
  const lineas = (r.stdout || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  return { codigo: r.status, lineas, err: (r.stderr || '').trim() };
}

// (?![\w-]): "--molde" no es "--molde-viejo".
const noConoce = (err, bandera) => new RegExp(`Argumento desconocido: ${bandera}(?![\\w-])`).test(err);

// D6-6: el molde del actualizador, del entorno. → { args, dir, linea } (args vacío = sin molde; linea null = nada que decir). Solo
// con .kit-rol = actualizador (rolDe, el de la raíz) y KIT_MOLDE una carpeta que existe; KIT_MOLDE_VIEJO va solo con él, y si no es
// una carpeta se deja afuera (sin él la exención es más angosta, nunca más ancha). Lo que se ignora se dice, sin los valores.
function moldeDelActualizador(raiz, env) {
  const hay = (v) => typeof v === 'string' && v !== '';
  const esCarpeta = (p) => {
    try {
      return fs.statSync(path.resolve(raiz, p)).isDirectory();
    } catch (e) {
      return false;
    }
  };
  const molde = env.KIT_MOLDE;
  const viejo = env.KIT_MOLDE_VIEJO;
  if (!hay(molde) && !hay(viejo)) return { args: [], dir: null, linea: null };
  const rol = rolDe(raiz);
  const ignorar = (por) => ({ args: [], dir: null, linea: `KIT_MOLDE se ignora (${por}): los candados corren sin el molde` });
  if (rol !== 'actualizador') return ignorar(`.kit-rol es ${rol}, no actualizador`);
  if (!hay(molde)) return ignorar('KIT_MOLDE_VIEJO sin KIT_MOLDE');
  if (!esCarpeta(molde)) return ignorar('KIT_MOLDE no es una carpeta que exista');
  const dir = path.resolve(raiz, molde);
  const args = ['--molde', dir];
  let linea = 'actualizador: los candados corren con el molde de KIT_MOLDE';
  if (hay(viejo) && esCarpeta(viejo)) {
    args.push('--molde-viejo', path.resolve(raiz, viejo));
    linea += ' y el viejo de KIT_MOLDE_VIEJO';
  } else if (hay(viejo)) linea += ' (KIT_MOLDE_VIEJO no es una carpeta que exista: va sin él)';
  return { args, dir, linea };
}

// Corre un candado y, si sale 2 porque no conoce una de las banderas que se le pasan (la del hook: es del orden 2; las del molde: es
// de antes), la saca (con su valor) y lo vuelve a correr, y lo dice. Sacar una nunca ensancha: sin --molde(-viejo) frena más.
function correrSinLoQueNoConoce(script, bandera, args, quien, o) {
  const a = args.slice();
  let r = correrEstructura(script, a, o);
  for (const f of [bandera, '--molde-viejo', '--molde']) {
    if (r.codigo !== 2 || !a.includes(f) || !noConoce(r.err, f)) continue;
    a.splice(a.indexOf(f), f === '--indice' ? 1 : 2);
    if (f === '--molde' && a.includes('--molde-viejo')) a.splice(a.indexOf('--molde-viejo'), 2); // solo no va (mal llamado)
    quien +=f === bandera ? ` (no conoce ${bandera}: es del orden 2; corrió sin él)` : ` (no conoce ${f}: corrió sin él)`;
    r = correrEstructura(script, a, o);
  }
  return { r, quien };
}

// candado(bandera, valor, o) → { rojo, lineas }. bandera: '--indice' (valor null) o '--rango' (valor 'a..b').
// o.molde (D6-6): el de moldeDelActualizador; sus banderas van a los dos candados.
function candado(bandera, valor, o) {
  const lineas = [];
  let rojo = false;
  const molde = o.molde || { args: [], dir: null };
  const args = [...(valor === null ? [bandera] : [bandera, valor]), ...molde.args];
  const rv = refVigente(o);
  const fichaRef = !!rv && existeBlob(rv.ref, RUTA_FICHA, o);
  const disco = path.join(o.raiz, ...RUTA_ESTRUCTURA.split('/'));
  const hayDisco = fs.existsSync(disco);

  // 1 · la versión de la ref vigente
  if (!rv) lineas.push('candado de la rama por defecto: no hay rama por defecto todavía — corrió solo el del disco');
  else if (!fichaRef) lineas.push(`candado de ${rv.nombre}: no tiene ficha (nunca tuvo kit) — corrió solo el del disco`);
  else {
    let script = extraerCandado(rv.ref, o);
    let quien = `candado de ${rv.nombre}`;
    // D6-6: un proyecto de antes del candado (v2.4.2 con ficha) que pone al día el actualizador: en lugar del de la ref, el del molde
    // (de afuera del clon: lo que se commitea no lo cambia).
    const delMolde = molde.dir ? path.join(molde.dir, 'scripts', 'estructura.cjs') : null;
    if (!script && delMolde && fs.existsSync(delMolde)) {
      script = delMolde;
      quien = `candado del molde (${rv.nombre} tiene ficha y no tiene ${RUTA_ESTRUCTURA}: es de antes del candado)`;
    }
    if (!script) {
      rojo = true;
      lineas.push(`candado de ${rv.nombre}: tiene ficha y no tiene ${RUTA_ESTRUCTURA} — así no se juzga lo que sube · corré doctor`);
    } else {
      const c = correrSinLoQueNoConoce(script, bandera, args, quien, o);
      if (juzgar(c.quien, c.r, lineas)) rojo = true;
    }
  }

  // 2 · la del disco
  if (!hayDisco) {
    const fichaAca = fs.existsSync(path.join(o.raiz, ...RUTA_FICHA.split('/'))) || existeBlob('', RUTA_FICHA, o) || existeBlob('HEAD', RUTA_FICHA, o);
    if (fichaRef || fichaAca) {
      rojo = true;
      lineas.push(`candado del disco: falta ${RUTA_ESTRUCTURA} y hay ficha — reponelo (corré doctor)`);
    } else if (!fichaRef) lineas.push('candado del disco: no hay kit en este repo (sin ficha ni candado)');
  } else {
    if (juzgar('candado del disco', correrEstructura(disco, args, o), lineas)) rojo = true;
  }
  return { rojo, lineas };
}

// Lo que dijo una corrida del candado, con quién lo dijo adelante. → true si es rojo: 1, o cualquier otra salida que no sea 0.
function juzgar(quien, r, lineas) {
  if (r.codigo === 0 || r.codigo === 1) {
    lineas.push(...(r.lineas.length ? r.lineas : ['(no dijo nada)']).map((l) => `${quien}: ${l}`));
    return r.codigo === 1;
  }
  lineas.push(`${quien}: salió con ${r.codigo === null ? 'nada (lo cortaron)' : r.codigo} — ${(r.err.split('\n')[0] || 'sin motivo').slice(0, 200)}`);
  return true;
}

// commit -a y commit <rutas> commitean desde un índice aparte (GIT_INDEX_FILE = index.lock o next-index-*.lock), y el candado lee el
// índice de siempre: si los dos difieren en una ruta de barrera, el candado no vería lo que de verdad se commitea. → la ruta o null.
function indiceAparte(o) {
  const idx = o.env.GIT_INDEX_FILE;
  if (!idx) return null;
  if (path.resolve(o.raiz, idx) === path.resolve(o.gitDir, 'index')) return null;
  const ls = (conIndice) => git(['--icase-pathspecs', 'ls-files', '-s', '-z', '--', ...RUTAS_BARRERA], { ...o, indice: conIndice });
  const a = ls(true);
  const b = ls(false);
  if (!a.ok || !b.ok) falla('no pude comparar el índice del commit con el de siempre');
  if (a.stdout === b.stdout) return null;
  const partir = (t) => new Set(t.split('\0').filter(Boolean));
  const A = partir(a.stdout);
  const B = partir(b.stdout);
  const distinta = [...A].find((x) => !B.has(x)) || [...B].find((x) => !A.has(x));
  return distinta ? distinta.replace(/^\d+ [0-9a-f]+ \d+\t/, '') : '?';
}

// ---------------------------------------------------------------- el hook previo (husky, lefthook o el de .git/hooks)

function correrPrevio(cual, args, stdin, o) {
  const conf = gitTexto(['config', '--get', 'kit.hooksPathPrevio'], o);
  const dir = conf ? path.resolve(o.raiz, conf) : path.join(o.gitComun, 'hooks');
  const archivo = path.join(dir, cual);
  if (path.resolve(archivo) === path.resolve(o.raiz, '.githooks', cual)) return null; // no encadenarse a sí mismo
  let st;
  try {
    st = fs.statSync(archivo);
  } catch (e) {
    return null;
  }
  if (!st.isFile()) return null;
  let cabeza = '';
  try {
    const fd = fs.openSync(archivo, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    cabeza = b.toString('latin1');
  } catch (e) {
    falla(`no pude leer el hook previo ${archivo}`);
  }
  const [exe, argv] = cabeza === '#!' ? ['sh', [archivo.split(path.sep).join('/'), ...args]] : [archivo, args];
  const r = spawnSync(exe, argv, { cwd: o.raiz, env: o.env, input: stdin, windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) falla(r.error.code === 'ENOENT' ? `no hay ${exe === 'sh' ? 'sh' : 'cómo correr'} el hook previo ${archivo}` : `el hook previo ${archivo} no corrió (${r.error.code})`);
  const rel = path.relative(o.raiz, archivo).split(path.sep).join('/');
  return { codigo: r.status, ruta: rel && !rel.startsWith('..') ? rel : archivo, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

// ---------------------------------------------------------------- pre-push: lo que sube

// Las líneas que git le da al pre-push por stdin: <ref local> <sha local> <ref remota> <sha remoto>. → [{...}] (sin los borrados).
function refsQueSuben(stdin) {
  const out = [];
  for (const l of String(stdin || '').split(/\r?\n/)) {
    if (!l.trim()) continue;
    const p = l.trim().split(/\s+/);
    if (p.length !== 4 || !RE_SHA.test(p[1]) || !RE_SHA.test(p[3])) falla('el pre-push recibió una línea que no entiendo');
    if (CEROS.test(p[1])) continue; // borrar una ref remota no sube nada (git-seguro decide si se puede; h11 la mira en refsQueBorran)
    out.push({ refLocal: p[0], local: p[1], refRemota: p[2], remoto: p[3], nueva: CEROS.test(p[3]) });
  }
  return out;
}

// Los borrados de esas mismas líneas (sha local en ceros) → [refRemota]. h11 (chequeo frío de la rc.6): el borrado también va por la
// lista de cada rol, porque desde la terminal o un script no hay git-seguro (un obrero borraba modulo/<x> del director en origin).
function refsQueBorran(stdin) {
  const out = [];
  for (const l of String(stdin || '').split(/\r?\n/)) {
    const p = l.trim().split(/\s+/);
    if (p.length === 4 && CEROS.test(p[1])) out.push(p[2]);
  }
  return out;
}

// ---------------------------------------------------------------- el hook entero

// principal(argv, {cwd, env, stdin (el del pre-push), plazoGitleaks, reintentos, gitleaks, ahora}) → { codigo, lineas }. No imprime: lo hace el CLI.
function principal(argv, opciones = {}) {
  const cual = argv[0];
  const args = argv.slice(1);
  if (!CUALES.includes(cual)) falla(`no sé qué hook es "${String(cual).slice(0, 40)}" (los que hay: ${CUALES.join(', ')})`);
  const env = sinInyectadas(opciones.env || process.env);
  const cwd = opciones.cwd || process.cwd();
  const repo = datosRepo(cwd, env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-githook-'));
  const o = { ...repo, cwd: repo.raiz, env, tmp, ahora: opciones.ahora, plazo: opciones.plazoGitleaks, reintentos: opciones.reintentos };
  o.gitleaks = opciones.gitleaks === undefined ? buscarGitleaks(env) : opciones.gitleaks;
  const foto = fotoLog(repo.raiz);
  try {
    const stdin = cual === 'pre-push' ? (opciones.stdin !== undefined ? opciones.stdin : leerStdin()) : undefined;
    const rol = rolEfectivo(repo.raiz, o);
    const lineas = [];
    o.molde = moldeDelActualizador(repo.raiz, env);
    if (o.molde.linea) lineas.push(o.molde.linea);
    let rojo = false;
    const sinEscaner = (por) => {
      anotar(repo.raiz, rol, cual, 'githook:sin-escaner', por, o);
      if (ROLES_PASAN_SIN_ESCANER.includes(rol)) lineas.push(`${SIN_ESCANER} (${por}) — pasa por ser ${rol}, en rojo`);
      else {
        rojo = true;
        lineas.push(`${SIN_ESCANER} (${por}) — con rol ${rol} no se ${cual === 'pre-push' ? 'pushea' : 'commitea'} sin escáner`);
      }
    };
    const hallazgos = (hs, donde) => {
      rojo = true;
      anotar(repo.raiz, rol, cual, 'githook:gitleaks', hs[0].archivo, o);
      for (const h of hs.slice(0, 20)) lineas.push(`gitleaks: ${h.regla} en ${h.archivo}:${h.linea}${h.commit ? ` (commit ${h.commit.slice(0, 12)})` : ''}${donde}`);
      if (hs.length > 20) lineas.push(`gitleaks: y ${hs.length - 20} más`);
      lineas.push('gitleaks: sacá el valor (pedile al humano cargar-secreto NOMBRE); si ya se commiteó, rotalo. Falsa alarma → .gitleaksignore, con aprobado');
      // u9 (rt-u9-3 b): acá no hay MERGE_HEAD y se mira contra HEAD; git deja el merge a medias y git commit lo juzga con los dos.
      if (cual === 'pre-merge-commit') lineas.push('pre-merge-commit: el merge quedó a medias: git commit lo juzga contra los dos padres');
    };

    // gitleaks sobre las líneas agregadas (rf2-1), con la configuración de refConfig ('' = el índice; si no, lo que sube). → false si
    // no hay escáner (no se vuelve a probar).
    const escanear = (argsGit, conIndice, refConfig, donde) => {
      let g;
      if (!o.gitleaks) g = { estado: 'sin-escaner', por: 'no está' };
      else {
        const r = git(argsGit, { ...o, indice: conIndice });
        if (!r.ok) falla(`no pude sacar de git lo que se le muestra a gitleaks (git ${argsGit[0]} salió con ${r.codigo})`);
        g = escanearCambios(r.salida.toString('latin1'), refConfig, o);
      }
      if (g.estado === 'sin-escaner') {
        sinEscaner(g.por);
        return false;
      }
      if (g.estado === 'rojo') hallazgos(g.hallazgos, donde);
      return true;
    };

    if (cual === 'pre-push') {
      const head = gitTexto(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], o);
      const refs = refsQueSuben(stdin);
      let escaner = true;
      const rama = ramaHead(o);
      for (const ref of refsQueBorran(stdin)) {
        if (puedeSubir(rol, ref, rama)) continue;
        rojo = true;
        anotar(repo.raiz, rol, cual, 'githook:solo-el-director', ref, o);
        lineas.push(textoSoloElDirector(ref, rol, rama).replace(' no sube ', ' no la borra '));
      }
      for (const x of refs) {
        const donde = ` · ${x.refLocal}`;
        // h11 (D8c-2, rt-10): primero lo que sube cada rol; un obrero que apunta a main no recibe el "pull --rebase" del adelantado.
        if (!puedeSubir(rol, x.refRemota, rama)) {
          rojo = true;
          anotar(repo.raiz, rol, cual, 'githook:solo-el-director', x.refRemota, o);
          lineas.push(textoSoloElDirector(x.refRemota, rol, rama));
          continue;
        }
        if (!x.nueva && !existeCommit(x.remoto, o)) {
          rojo = true;
          anotar(repo.raiz, rol, cual, 'githook:remoto-adelantado', x.refRemota, o);
          lineas.push(`pre-push: ${args[0] || 'el remoto'} tiene en ${x.refRemota} commits que esta PC no tiene (avanzó o lo reescribieron) — hacé git fetch y git pull --rebase, y volvé a pushear`);
          continue;
        }
        // u9 (rt-u9-3 a): una rama ya subida que mergeó main no vuelve a escanear lo que ya está en la vigente del remoto (lo juzgó
        // su push); barreras --rango excluye lo mismo por su cuenta. Sin vigente del remoto, como antes.
        const rv = refVigente(o);
        const vigente = rv && rv.ref.startsWith('refs/remotes/') ? [rv.ref] : [];
        const rango = x.nueva ? [x.local, '--not', '--remotes'] : [x.local, '--not', x.remoto, ...vigente];
        if (escaner) escaner = escanear(['log', '-p', '--cc', '--root', '--no-notes', '--no-show-signature', `--format=${MARCA_COMMIT.replace('', '%x01')}%H`, ...DIFF_TEXTO, ...rango, '--'], false, x.local, donde);
        const c = candado('--rango', `${x.nueva ? '0'.repeat(x.local.length) : x.remoto}..${x.local}`, o);
        lineas.push(...c.lineas.map((l) => `${l}${donde}`));
        if (c.rojo) {
          rojo = true;
          // El candado lee los aprobados del disco (lo que tenés abierto): si lo que sube es otra rama, el aprobado puede vivir solo ahí.
          if (head && head !== x.local) lineas.push(`pre-push: ${x.refLocal} no es lo que tenés abierto — si su aprobado vive solo en esa rama, pusheala desde ella (git switch)`);
        }
      }
    } else {
      // u9 (rt-u9-4): en un merge en curso (MERGE_HEAD; el pre-commit que cierra un merge), el diff combinado del árbol del índice
      // contra HEAD y cada otro padre, como el pre-push juzga el merge commiteado: lo que vino igual de un padre no es nuevo.
      const otros = mergeHeads(o);
      if (otros.length) {
        const t = git(['write-tree'], { ...o, indice: true });
        if (!t.ok) falla('no pude armar el árbol del merge (git write-tree)');
        escanear(['diff', '--cc', ...DIFF_TEXTO, t.stdout.trim(), 'HEAD', ...otros, '--'], true, '', '');
      } else escanear(['diff', '--cached', ...DIFF_TEXTO], true, '', '');
      if (cual === 'pre-merge-commit') lineas.push('pre-merge-commit: el candado no corre acá (git todavía no dice cuál es el otro padre del merge) — el merge lo juzga el pre-push, contra cada padre');
      else {
        const aparte = indiceAparte(o);
        if (aparte) {
          rojo = true;
          anotar(repo.raiz, rol, cual, 'githook:indice-aparte', aparte, o);
          lineas.push(`pre-commit: este commit lleva ${aparte} desde un índice aparte (commit -a o commit <rutas>) y el candado lee el índice — hacé git add de lo que va (y git restore --staged de lo que no) y volvé a commitear`);
        } else {
          const c = candado('--indice', null, o);
          lineas.push(...c.lineas);
          if (c.rojo) rojo = true;
        }
      }
    }

    if (!rojo) {
      const p = correrPrevio(cual, args, stdin, o);
      if (p) {
        if (p.salida.trim()) lineas.push(...p.salida.replace(/\s+$/, '').split(/\r?\n/).map((l) => `(${p.ruta}) ${l}`));
        if (p.codigo !== 0) {
          rojo = true;
          lineas.push(`el hook previo ${p.ruta} salió con ${p.codigo === null ? 'nada (lo cortaron)' : p.codigo}`);
        } else lineas.push(`el hook previo ${p.ruta}: en verde`);
      }
    }
    lineas.push(rojo ? `kit ${cual}: ROJO — no pasa` : `kit ${cual}: en verde`);
    return { codigo: rojo ? 1 : 0, lineas };
  } finally {
    mudarLoDelPase(foto, repo.gitComun);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* el temporal es del sistema */
    }
  }
}

let stdinCache;
function leerStdin() {
  if (stdinCache === undefined) {
    try {
      stdinCache = fs.readFileSync(0, 'utf8');
    } catch (e) {
      stdinCache = '';
    }
  }
  return stdinCache;
}

// El CLI: imprime a stderr (git lo muestra) y sale 0 · 1. Todo error → 1 con motivo.
function cli(argv) {
  const cual = CUALES.includes(argv[0]) ? argv[0] : 'githook';
  try {
    const r = principal(argv);
    process.stderr.write(r.lineas.join('\n') + '\n');
    return r.codigo;
  } catch (e) {
    const motivo = e instanceof Falla ? e.message : `${e && e.message ? String(e.message).split('\n')[0].slice(0, 200) : 'algo falló'}`;
    try {
      process.stderr.write(`kit ${cual}: ${ROTO} (${motivo}) — no pasa\n`);
    } catch (err) {
      /* nada */
    }
    return 1;
  }
}

if (require.main === module) process.exitCode = cli(process.argv.slice(2));

module.exports = {
  CUALES,
  PLAZO_GITLEAKS,
  REINTENTOS_GITLEAKS,
  ROLES_PASAN_SIN_ESCANER,
  RUTAS_CANDADO,
  RUTAS_BARRERA,
  SIN_ESCANER,
  ROTO,
  Falla,
  INYECTAN,
  sinInyectadas,
  agregadas,
  rutaDelDiff,
  materializar,
  huellasIgnoradas,
  escanearCambios,
  rolDe,
  marcaDeNoche,
  rolEfectivo,
  puedeSubir,
  textoSoloElDirector,
  SOLO_EL_DIRECTOR,
  refVigente,
  buscarGitleaks,
  leerReporte,
  correrGitleaks,
  extraerCandado,
  candado,
  moldeDelActualizador,
  indiceAparte,
  correrPrevio,
  refsQueSuben,
  principal,
  cli,
};
