'use strict';
// worktree.cjs — los worktrees de los módulos: nacen, se abren y se cierran por script (SPEC-paquete-4 P6.2; H §10; F §9;
// RT1-3, RT1-14, RT2-5, RT2-9, RT2-12; RF-11; red team r1-1, r1-2, r1-4, r1-5, r1-8, r1-9, r1-10). Uso, desde el repo:
//   node .claude/scripts/worktree.cjs crear  <x>[--<ID>] [--noche] [--model <m>]
//   node .claude/scripts/worktree.cjs abrir  <x>[--<ID>] [--noche] [--model <m>]
//   node .claude/scripts/worktree.cjs sync-env
//   node .claude/scripts/worktree.cjs cerrar <x>[--<ID>]
//   node .claude/scripts/worktree.cjs cerrar <x>--<ID> --cancelado
//   node .claude/scripts/worktree.cjs integrar <x> [--ok-de-guido]
//   node .claude/scripts/worktree.cjs integrados
//   node .claude/scripts/worktree.cjs donde <x>[--<ID>]
//   node .claude/scripts/worktree.cjs traer-main <x>
// Rama modulo/<x> → carpeta .claude/worktrees/modulo--<x> (director); modulo/<x>--<ID> → .claude/worktrees/modulo--<x>--<ID> (obrero).
// Las carpetas van SIEMPRE bajo el checkout principal (el padre del git-common-dir), también corrido desde el worktree del director.
// `crear`/`abrir` escriben .kit-rol (ASCII, sin BOM, LF: los mismos bytes desde PowerShell o Bash), copian lo que lista
// .worktreeinclude (sin él: los .env y .env.* ignorados) SACANDO todo renglón cuyo nombre esté en el almacén del proyecto
// (~/.config/kit-secretos/<proyecto>.env: de ahí se leen solo los NOMBRES; ningún valor sale por pantalla), suman al
// .claude/settings.local.json del worktree Y al del principal (8r4 rt-1) un deny absoluto al .env del principal, corren
// vars.comando-setup e imprimen la apertura: primero la vía de una ventana (8r4 u1: una sesión nueva en la ventana de siempre, con el
// primer mensaje `/director <x>` —módulo, también con --noche; D8r.4-2— o `/obrero <x>--<ID>`, que entra sola con `donde` + EnterWorktree), después
// `o en otra ventana: code "<ruta>"` y la pestaña de Claude, la línea de terminal solo si hay `claude` (rf-1): la de PowerShell con
// el del PATH, o la de Git Bash con el binario de la extensión de VS Code (D-b de D5.1).
// `donde` (8r4 u1; rt-4, rt-6): solo mira; `adentro:` (0), `entrar: <ruta>` (0), `no hay worktree` (1) o `PARADA:` (1).
// `traer-main` (8r4 u2; rt-3, rt-7): en el worktree del director, merge --no-ff --no-commit de origin/<def>, barreras --indice,
// commit --no-edit y push de modulo/<x>; choca o rojo → merge --abort y 1. Nunca --force, nunca otra rama.
// El filtro falla cerrado: almacén ilegible, o un .env* trackeado con un nombre del almacén → 1 sin crear nada.
// `cerrar`: fetch de origin (rf-5), todos los chequeos primero (desde adentro, sin mergear en su madre local u origin, sucio;
// frenos.log mudado al <git-common-dir>/kit-frenos.log), después `git worktree remove` sin --force, y solo si anduvo,
// `git branch -D`; la de origin, solo si el fetch anduvo y está en origin/<madre> (8r, rt-2). Una carpeta sin registro con solo lo
// ignorado se borra y sigue (rf-6). Con `--cancelado` (rf-1 del revisor frío
// de D5.1): sin mergear, con el renglón "cancelado <ID> @<sha7>" commiteado en la ficha; borra worktree (--force), rama y la de origin.
// `integrar` (SPEC-paquete-5; D4-2, D4-3, D5-3, D5-11, D5-14, r1-1): el módulo terminado a la rama por defecto de origin. Todos los
// chequeos primero (origin, encargo abierto, la ficha vigente, el temporal, el worktree del director); después el commit de su
// frenos.log y modulo/<x> igual a la de origin; un temporal desprendido en origin/<defecto>, equipado como `equipar`, con el merge
// --no-ff, el gate (barreras del rango, el candado, comando-test) y el push sin --force. Nada sube si algo falla; el temporal se
// borra siempre (con --force: es suyo). Si el push anduvo, sale 0 aunque el temporal no se borre (un aviso). Sin /cierre: termina en
// "después: /cierre en tu carpeta principal …" (D5-3; 8r, 5). `integrados` (8r, 5): los merges "integrar: módulo <x>" de la rama por
// defecto local posteriores al último commit que tocó docs/SESSION_HANDOFF.md, una línea cada uno; sale 0 siempre.
// docs/ es la carpeta de papeles: la `carpeta-docs:` de la ficha vigente si la hay (SPEC-paquete-8r3 i1; lib/docs-ruta.cjs).
// Salidas: 0 anduvo · 1 negado o con fallas (una línea por qué) · 2 mal llamado. Un error propio: "worktree roto: corré doctor", 1.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const USO = [
  'Uso: node .claude/scripts/worktree.cjs <comando> …   (desde el repo)',
  '  crear  <x>[--<ID>] [--noche] [--model <m>]   rama y carpeta nuevas (x: módulo; --<ID>: encargo de dos dígitos)',
  '  abrir  <x>[--<ID>] [--noche] [--model <m>]   la rama ya existe (acá o en origin) y la carpeta no está en esta PC',
  '  sync-env                                      saca de los .env de los worktrees vivos lo que está en el almacén',
  '  cerrar <x>[--<ID>]                            borra carpeta y rama, solo si está mergeada y limpia',
  '  cerrar <x>--<ID> --cancelado                  cancela el encargo: con "cancelado <ID> @<sha7>" commiteado en la ficha',
  '  integrar <x> [--ok-de-guido]                  merge --no-ff de modulo/<x> en la rama por defecto de origin, con el gate',
  '  integrados                                    los módulos integrados después del último handoff (para el /inicio; sale 0)',
  '  donde <x>[--<ID>]                             solo mira: ¿estás adentro de ese worktree, o a qué ruta entrar? (/obrero, /director)',
  '  traer-main <x>                                en el worktree del director: trae la rama por defecto de origin a modulo/<x>',
].join('\n');

const ROTO = 'worktree roto: corré doctor';
const CARPETAS = '.claude/worktrees';
const RE_X = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RE_ID = /^[0-9]{2}$/;
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/;
const RE_ENV = /^\.env(\..+)?$/;
const RE_PLANTILLA = /^\.env\.(example|sample|template)$/i;
// .kit-noche (RF-fix 13): la marca de la noche que me-voy escribe en el worktree del director; sin versionar, como .kit-rol.
const IGNORADOS = ['.claude/worktrees/', '.kit-rol', '.kit-noche', '.claude/settings.local.json'];
const LOG = '.claude/frenos.log';
const LOG_COMUN = 'kit-frenos.log';
const T_GIT = 60000; // worktree add, fetch, remove y ls-files en un repo grande pasan los 5 s de git.cjs

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

// ---------------------------------------------------------------- argumentos y nombres

// "<x>" o "<x>--<ID>" → { x, id, rama, carpeta (el nombre), madre (solo encargos) }. Otro nombre → mal llamado (2).
function nombreDe(token) {
  const m = /^(.*?)(?:--([^-].*))?$/.exec(String(token || ''));
  const x = m ? m[1] : '';
  const id = m && m[2] !== undefined ? m[2] : null;
  if (!RE_X.test(x) || x.length > 20) malLlamado(`Nombre inválido: "${token}" — <x> es minúsculas, números y guiones simples, hasta 20.`);
  if (id !== null && !RE_ID.test(id)) malLlamado(`Encargo inválido: "${token}" — el <ID> son dos dígitos (x--01).`);
  if (id === null) return { x, id, rama: `modulo/${x}`, carpeta: `modulo--${x}`, madre: null };
  return { x, id, rama: `modulo/${x}--${id}`, carpeta: `modulo--${x}--${id}`, madre: `modulo/${x}` };
}

function leerArgumentos(argv) {
  const [comando, ...resto] = argv;
  if (!comando) malLlamado('Falta el comando.');
  if (!['crear', 'abrir', 'sync-env', 'cerrar', 'integrar', 'integrados', 'donde', 'traer-main'].includes(comando)) malLlamado(`Comando desconocido: ${comando}`);
  const conOpciones = comando === 'crear' || comando === 'abrir';
  const a = { comando, nombre: null, noche: false, modelo: null, okDeGuido: false, cancelado: false };
  const pos = [];
  for (let i = 0; i < resto.length; i++) {
    const v = resto[i];
    if (conOpciones && v === '--noche') {
      if (a.noche) malLlamado('--noche va una sola vez.');
      a.noche = true;
    } else if (conOpciones && v === '--model') {
      if (i + 1 >= resto.length) malLlamado('--model pide un valor.');
      if (a.modelo !== null) malLlamado('--model va una sola vez.');
      a.modelo = resto[++i];
      if (!RE_MODELO.test(a.modelo)) malLlamado(`Modelo inválido: "${a.modelo}".`);
    } else if (comando === 'integrar' && v === '--ok-de-guido') {
      if (a.okDeGuido) malLlamado('--ok-de-guido va una sola vez.');
      a.okDeGuido = true;
    } else if (comando === 'cerrar' && v === '--cancelado') {
      if (a.cancelado) malLlamado('--cancelado va una sola vez.');
      a.cancelado = true;
    } else if (v.startsWith('--')) {
      malLlamado(`Argumento desconocido: ${v}`);
    } else {
      pos.push(v);
    }
  }
  const cuantos = comando === 'sync-env' || comando === 'integrados' ? 0 : 1;
  if (pos.length !== cuantos) malLlamado(`${comando} lleva ${cuantos} argumento(s) además de las banderas.`);
  if (cuantos) a.nombre = nombreDe(pos[0]);
  if (comando === 'integrar' && a.nombre.id !== null) malLlamado('integrar va con el módulo (<x>), no con un encargo: el encargo se mergea en modulo/<x>.');
  if (comando === 'traer-main' && a.nombre.id !== null) malLlamado('traer-main va con el módulo (<x>), no con un encargo: lo corre el director en modulo/<x>.');
  if (a.cancelado && a.nombre.id === null) malLlamado('--cancelado va con un encargo (<x>--<ID>): un módulo no se cancela así.');
  return a;
}

// ---------------------------------------------------------------- utilidades

function libs() {
  return {
    git: require('../hooks/lib/git.cjs'),
    contexto: require('../hooks/lib/contexto.cjs'),
    ficha: require('../hooks/lib/ficha.cjs'),
    frenosLog: require('../hooks/lib/frenos-log.cjs'),
    fabrica: require('../hooks/lib/fabrica.cjs'),
    docs: require('../hooks/lib/docs-ruta.cjs'), // 8r3 i1: la carpeta de papeles (docs sin la clave)
  };
}

const WIN = process.platform === 'win32';
const norm = (p) => {
  const r = path.resolve(p);
  return WIN ? r.toLowerCase() : r;
};
const mismaRuta = (a, b) => norm(a) === norm(b);
function dentroDe(hijo, padre) {
  const rel = path.relative(norm(padre), norm(hijo));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// Con '/' (Windows acepta las dos), para que la línea se pegue igual en PowerShell y en Bash.
const barras = (p) => path.resolve(p).split(path.sep).join('/');

function escribirAtomico(abs, contenido) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, abs);
}

// git con su tiempo; nunca tira: { ok, codigo, stdout, salida, stderr, error }.
const G = (L, args, cwd, extra = {}) => L.git.correr(args, { cwd, tiempo: T_GIT, ...extra });
const existeRef = (L, cwd, ref) => G(L, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd).ok;
const sha = (L, cwd, ref) => {
  const r = G(L, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd);
  return r.ok ? r.stdout.trim() : null;
};
const primeraLinea = (s) => (String(s || '').trim().split('\n')[0] || '').trim();

// Dónde estamos: la raíz del checkout del cwd y el principal (el padre del git-common-dir). null fuera de un repo.
function ubicar(L, cwd) {
  const g = L.contexto.datosGit(cwd);
  if (!g) return null;
  return { ...g, cwd, principal: path.dirname(g.gitComun) };
}

// `git worktree list --porcelain` → [{ ruta, rama ('refs/heads/…' o null) }].
function worktrees(L, principal) {
  const r = G(L, ['worktree', 'list', '--porcelain'], principal);
  if (!r.ok) return [];
  const lista = [];
  let actual = null;
  for (const l of r.stdout.split('\n')) {
    const s = l.replace(/\r$/, '');
    if (s.startsWith('worktree ')) {
      actual = { ruta: path.resolve(s.slice('worktree '.length)), rama: null };
      lista.push(actual);
    } else if (actual && s.startsWith('branch ')) {
      actual.rama = s.slice('branch '.length);
    }
  }
  return lista;
}

// ---------------------------------------------------------------- lo ignorado (r1-5, D4-13)

function noIgnorados(L, principal) {
  return IGNORADOS.filter((p) => G(L, ['check-ignore', '-q', '--', p], principal).codigo !== 0);
}
const lineaIgnorados = (faltan) =>
  `${faltan.join(', ')} no ${faltan.length === 1 ? 'está ignorado' : 'están ignorados'} — pegá en el .gitignore del principal el ` +
  'gitignore.snippet del kit ENTERO (trae /.claude/worktrees/, /.kit-rol, /.kit-noche y /.claude/settings.local.json) y commitealo';

// ---------------------------------------------------------------- el almacén y el filtro de credenciales (RT1-3, RT2-5, D4-5, r1-4)

// <proyecto>: la regla de cargar-secreto.sh aplicada al checkout PRINCIPAL (si no, desde el worktree del director saldría
// "modulo--x" y no encontraría el almacén): vars.proyecto de .claude/kit.md del disco, si no el nombre de la carpeta; en
// minúsculas ASCII y todo byte que no sea a-z0-9 → "-".
function proyectoDe(principal) {
  let p = '';
  let texto = null;
  try {
    texto = fs.readFileSync(path.join(principal, '.claude', 'kit.md'), 'utf8');
  } catch (e) {
    texto = null;
  }
  if (texto !== null) {
    let enVars = false;
    for (const crudo of texto.split('\n')) {
      const l = crudo.replace(/\r$/, '');
      if (/^vars:[ \t]*(#.*)?$/.test(l)) {
        enVars = true;
        continue;
      }
      if (!enVars) continue;
      if (/^[^ \t#]/.test(l)) {
        enVars = false;
        continue;
      }
      const m = /^[ \t]+proyecto:[ \t]*(.*)$/.exec(l);
      if (m) {
        let v = m[1];
        const c = /[ \t]#/.exec(v);
        if (c) v = v.slice(0, c.index);
        v = v.replace(/^[ \t]+|[ \t]+$/g, '');
        v = v.replace(/^["']/, '').replace(/["']$/, '');
        p = v;
        break;
      }
    }
  }
  if (p === '') p = path.basename(principal);
  const bytes = Buffer.from(p, 'utf8');
  let s = '';
  for (const b of bytes) {
    const c = b >= 0x41 && b <= 0x5a ? b + 32 : b;
    s += (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ? String.fromCharCode(c) : '-';
  }
  return s === '' ? 'proyecto' : s;
}

function casa() {
  return process.env.HOME && process.env.HOME.trim() !== '' ? process.env.HOME : os.homedir();
}
const rutaAlmacen = (proyecto) => path.join(casa(), '.config', 'kit-secretos', `${proyecto}.env`);

// UTF-16 (BOM o bytes nulos): no se puede leer como texto. Se niega, nunca se adivina.
function ilegible(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  return buf.includes(0);
}

// → { estado: 'sin' | 'ok' | 'ilegible', nombres: Set (en mayúsculas), ruta, proyecto }. Del almacén SOLO se guardan los nombres.
function leerAlmacen(principal) {
  const proyecto = proyectoDe(principal);
  const ruta = rutaAlmacen(proyecto);
  const nombres = new Set();
  let buf;
  try {
    buf = fs.readFileSync(ruta);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { estado: 'sin', nombres, ruta, proyecto };
    return { estado: 'ilegible', nombres, ruta, proyecto, motivo: 'no se puede leer' };
  }
  if (ilegible(buf)) return { estado: 'ilegible', nombres, ruta, proyecto, motivo: 'está en UTF-16' };
  const lineas = buf.toString('utf8').replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].replace(/\r$/, '');
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l);
    if (!m) return { estado: 'ilegible', nombres: new Set(), ruta, proyecto, motivo: `el renglón ${i + 1} no es NOMBRE=…` };
    nombres.add(m[1].toUpperCase());
  }
  return { estado: 'ok', nombres, ruta, proyecto };
}

// ¿Dónde cierra la comilla q en s? (la doble admite \" escapada).
function cierra(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) return true;
  }
  return false;
}

// Un .env en bloques: cada asignación con sus renglones de continuación (valor entre comillas que sigue abajo), y el resto
// (comentarios, vacíos, basura) de a uno. Acepta `export `, espacios alrededor del `=` y CRLF.
function bloquesEnv(texto) {
  const lineas = texto.split('\n');
  const bloques = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].replace(/\r$/, '');
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(.*)$/.exec(l);
    if (!m) {
      bloques.push({ nombre: null, desde: i, hasta: i, vacio: true });
      continue;
    }
    const valor = m[2];
    let hasta = i;
    const q = valor[0];
    if (q === '"' || q === "'" || q === '`') {
      let cerrada = cierra(valor.slice(1), q);
      while (!cerrada && hasta + 1 < lineas.length) {
        hasta++;
        cerrada = cierra(lineas[hasta].replace(/\r$/, ''), q);
      }
    }
    const vacio = hasta === i && /^(""|''|``)?[ \t]*(#.*)?$/.test(valor.trim());
    bloques.push({ nombre: m[1], desde: i, hasta, vacio });
    i = hasta; // los renglones de continuación son de este bloque, no asignaciones nuevas
  }
  return { lineas, bloques };
}

// filtrarEnv(texto, nombres) → { texto, sacados: [NOMBRE…] }. Saca entero cada bloque cuyo nombre esté en el almacén.
function filtrarEnv(texto, nombres) {
  const bom = texto.startsWith('\uFEFF');
  const { lineas, bloques } = bloquesEnv(bom ? texto.slice(1) : texto);
  const quedan = [];
  const sacados = [];
  for (const b of bloques) {
    if (b.nombre !== null && nombres.has(b.nombre.toUpperCase())) {
      sacados.push(b.nombre);
      continue;
    }
    for (let i = b.desde; i <= b.hasta; i++) quedan.push(lineas[i]);
  }
  return { texto: (bom ? '\uFEFF' : '') + quedan.join('\n'), sacados };
}

const esEnv = (rel) => RE_ENV.test(rel.split('/').pop());

// Un .env* trackeado llega por el checkout, no por la copia: si trae un valor para un nombre del almacén → 1 (r1-4).
// Un nombre con el valor vacío (NOMBRE= en un .env.example) no lleva credencial y pasa.
function trackeadosConNombre(L, principal, base, alm) {
  const r = G(L, ['ls-tree', '-r', '-z', '--name-only', base], principal);
  if (!r.ok) return { error: `no pude listar los archivos de ${base}` };
  const malos = [];
  if (alm.nombres.size === 0) return { malos };
  for (const rel of r.stdout.split('\0').filter(Boolean)) {
    if (!esEnv(rel)) continue;
    const s = G(L, ['show', `${base}:${rel}`], principal);
    if (!s.ok) return { error: `no pude leer ${rel} de ${base}` };
    if (ilegible(s.salida)) {
      malos.push(`${rel} (UTF-16: no lo puedo revisar) — guardalo en UTF-8`);
      continue;
    }
    const t = s.salida.toString('utf8').replace(/^\uFEFF/, '');
    const con = bloquesEnv(t).bloques.filter((b) => b.nombre !== null && !b.vacio && alm.nombres.has(b.nombre.toUpperCase()));
    if (!con.length) continue;
    const nombres = [...new Set(con.map((b) => b.nombre))];
    // Una plantilla se queda en el repo con el valor vacío (rf-9); el resto, afuera del repo o vacío.
    const consejo = RE_PLANTILLA.test(rel.split('/').pop())
      ? `es una plantilla: dejá ${nombres.map((x) => `${x}=`).join(', ')} vacío en la plantilla`
      : 'sacalo del repo (git rm --cached) o vacía ese valor';
    malos.push(`${rel} (${nombres.join(', ')}) — ${consejo}`);
  }
  return { malos };
}

// Lo que se copia del principal: lo que lista .worktreeinclude Y está ignorado por git (como el -w nativo); sin el archivo, los
// .env y .env.* ignorados. Nunca lo que está adentro de .claude/worktrees/.
function listaACopiar(L, principal) {
  const wti = path.join(principal, '.worktreeinclude');
  const tiene = fs.existsSync(wti);
  const args = tiene ? ['ls-files', '-z', '-o', '-i', `--exclude-from=${wti}`] : ['ls-files', '-z', '-o', '-i', '--exclude=.env', '--exclude=.env.*'];
  const r = G(L, args, principal);
  if (!r.ok) return { error: 'no pude listar lo que se copia' };
  const cand = r.stdout.split('\0').filter((s) => s && !s.startsWith(`${CARPETAS}/`));
  let lista = [];
  if (cand.length) {
    const ci = G(L, ['check-ignore', '-z', '--stdin'], principal, { entrada: `${cand.join('\0')}\0` });
    if (ci.codigo !== 0 && ci.codigo !== 1) return { error: 'no pude ver qué está ignorado' };
    const ign = new Set(ci.stdout.split('\0').filter(Boolean));
    lista = cand.filter((s) => ign.has(s));
  }
  return { lista, tiene };
}

// Arma en memoria lo que se va a escribir, ANTES de crear nada: un .env* que no se puede filtrar → error (falla cerrado).
function prepararCopia(L, principal, alm) {
  const l = listaACopiar(L, principal);
  if (l.error) return l;
  const lineas = [];
  if (!l.tiene) lineas.push('sin .worktreeinclude: copio los .env y .env.* ignorados del principal');
  if (alm.estado === 'sin') lineas.push(`sin almacén para ${alm.proyecto}: no saqué nada`);
  const archivos = [];
  for (const rel of l.lista) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(principal, ...rel.split('/')));
    } catch (e) {
      if (esEnv(rel)) return { error: `no pude leer ${rel}: no copié nada` };
      lineas.push(`no pude leer ${rel}: no lo copié`);
      continue;
    }
    if (esEnv(rel)) {
      if (ilegible(buf)) return { error: `${rel} está en UTF-16: no lo puedo filtrar y no copié nada — guardalo en UTF-8` };
      const f = filtrarEnv(buf.toString('utf8'), alm.nombres);
      for (const n of f.sacados) lineas.push(`no copié ${n} de ${rel}: vive en el almacén`);
      buf = Buffer.from(f.texto, 'utf8');
    } else if (alm.nombres.size && !ilegible(buf)) {
      // h9 (8r4, D8c): lo que lista .worktreeinclude además de los .env (un config.local.ini con SECRET_KEY = …) pasa por el mismo
      // filtro: un nombre del almacén no llega a ningún worktree, venga en el archivo que venga. Sin nada que sacar, los bytes tal cual.
      const f = filtrarEnv(buf.toString('utf8'), alm.nombres);
      if (f.sacados.length) {
        for (const n of f.sacados) lineas.push(`no copié ${n} de ${rel}: vive en el almacén`);
        buf = Buffer.from(f.texto, 'utf8');
      }
    }
    archivos.push({ rel, buf });
  }
  return { archivos, lineas };
}

// "//c/Users/…" (Windows) o "//home/…": la ruta absoluta de las reglas de permisos de Claude Code.
function rutaPermiso(abs) {
  const p = barras(abs);
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  if (m) return `//${m[1].toLowerCase()}/${m[2]}`.replace(/\/$/, '');
  return `/${p}`.replace(/\/$/, '');
}
// Read y Edit, sin Write: claude.exe 2.1.312+ avisa que una regla Write(ruta) no la mira el chequeo de archivos ("only Edit(path)
// rules are"; Edit cubre todas las herramientas que escriben). Un settings.local.json viejo con las Write de más sigue andando:
// encargo.cjs verificar exige que estén estas, no que falten las otras.
function reglasDeny(principal) {
  const base = rutaPermiso(principal);
  const reglas = [];
  for (const h of ['Read', 'Edit']) for (const f of ['.env', '.env.*']) reglas.push(`${h}(${base}/${f})`);
  return reglas;
}

// Suma los deny al settings.local.json del worktree sin pisar lo que tenía (ahí van las allow de AUTORIZADO, P6.5).
function sumarDeny(wt, principal) {
  const archivo = path.join(wt, '.claude', 'settings.local.json');
  let datos = {};
  if (fs.existsSync(archivo)) {
    try {
      datos = JSON.parse(fs.readFileSync(archivo, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      return false;
    }
  }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return false;
  if (datos.permissions === undefined) datos.permissions = {};
  if (!datos.permissions || typeof datos.permissions !== 'object' || Array.isArray(datos.permissions)) return false;
  if (datos.permissions.deny === undefined) datos.permissions.deny = [];
  if (!Array.isArray(datos.permissions.deny)) return false;
  for (const r of reglasDeny(principal)) if (!datos.permissions.deny.includes(r)) datos.permissions.deny.push(r);
  escribirAtomico(archivo, `${JSON.stringify(datos, null, 2)}\n`);
  return true;
}

// ---------------------------------------------------------------- crear y abrir

const rolDe = (n, noche) => (noche ? 'nocturno' : n.id === null ? 'director' : 'obrero');

// Cómo se llama a `claude` (el del PATH o el de la extensión de VS Code), el vigía y la shell de los comandos de la ficha (Git Bash
// en Windows, con el guardia de `cmd /c` / `cmd //c`; D8r.2 t6, rt-2): viven en hooks/lib/proceso.cjs (los comparte con encargo.cjs).
// Las pruebas inyectan la shell con opciones.shell.
const { comandoClaude, argsVigia, shellDeComandos, comandoQueNoCorre } = require('../hooks/lib/proceso.cjs');
const shellDe = (opciones) => (opciones && opciones.shell !== undefined ? opciones.shell : shellDeComandos());

// La apertura (rf-1; SPEC-paquete-8r4 u1): primero la vía de una ventana (una sesión nueva en la ventana de siempre, que entra sola
// al worktree con `donde` + EnterWorktree); después, como alternativa, otra ventana de VS Code; la de terminal, solo si hay `claude`:
// el del PATH (PowerShell o Bash) o, si no, el binario de la extensión de VS Code, entre comillas y en la forma de Git Bash (D-b de
// D5.1). El primer mensaje sale del nombre (no del rol: `crear x --noche` es el director de noche; 8r T2, rt-5).
function lineasApertura(wt, n, modelo, opciones) {
  const sesion = n.id === null ? `director-${n.x}` : `obrero-${n.x}--${n.id}`;
  const m = modelo || (n.id === null ? 'opus' : 'sonnet');
  const nombre = /^[a-z]+$/.test(m) ? m[0].toUpperCase() + m.slice(1) : m;
  // Con el módulo (D8r.4-2: con dos módulos, la skill adivinaba el <x> de `donde`).
  const primero = n.id === null ? `/director ${n.x}` : `/obrero ${n.x}--${n.id}`;
  const lineas = [
    `en tu ventana de siempre, una sesión nueva de Claude; primer mensaje: ${primero} (entra sola al worktree)`,
    `o en otra ventana: code "${barras(wt)}"`,
    `en esa ventana, abrí la pestaña de Claude y elegí ${nombre}, con el mismo primer mensaje (nombre sugerido para la sesión: ${sesion})`,
  ];
  const claude = comandoClaude(opciones);
  if (claude === 'claude') lineas.push(`o en una terminal: cd "${barras(wt)}"; claude --name ${sesion} --model ${m}`);
  else if (claude) lineas.push(`o en una terminal de Git Bash: cd "${barras(wt)}" && ${claude} --name ${sesion} --model ${m}`);
  return lineas;
}

// La rama por defecto LOCAL (la base de un módulo): el nombre de la regla de 4.7, como rama de esta PC.
function porDefectoLocal(L, cwd) {
  const nombre = L.contexto.ramaPorDefecto(cwd);
  if (!nombre || !existeRef(L, cwd, `refs/heads/${nombre}`)) return null;
  return nombre;
}

// Las negativas que comparten crear y abrir sobre una base ya resuelta: almacén, .env trackeado y la copia en memoria.
function chequeosDeCredenciales(L, principal, base, cmd) {
  const alm = leerAlmacen(principal);
  const no = (m) => ({ codigo: 1, lineas: [`worktree ${cmd}: no — ${m}`] });
  if (alm.estado === 'ilegible') return no(`el almacén de ${alm.proyecto} ${alm.motivo}: no copié ningún .env — rehacelo con cargar-secreto (UTF-8, NOMBRE=…)`);
  const t = trackeadosConNombre(L, principal, base, alm);
  if (t.error) return no(t.error);
  if (t.malos.length) return no(`hay un .env trackeado con un nombre del almacén: ${t.malos.join('; ')}`);
  const c = prepararCopia(L, principal, alm);
  if (c.error) return no(c.error);
  return { codigo: 0, copia: c };
}

const escribirRol = (wt, rol) => fs.writeFileSync(path.join(wt, '.kit-rol'), Buffer.from(`${rol}\n`, 'ascii'));

// La copia ya filtrada (de chequeosDeCredenciales) al worktree, sin pisar lo que vino con el checkout. → las líneas.
function copiarArchivos(wt, copia) {
  const lineas = [...copia.lineas];
  for (const { rel, buf } of copia.archivos) {
    const destino = path.join(wt, ...rel.split('/'));
    if (fs.existsSync(destino)) {
      lineas.push(`${rel} ya vino con el checkout: no lo pisé`);
      continue;
    }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buf);
  }
  if (copia.archivos.length) lineas.push(`copié ${copia.archivos.length} archivo(s) del principal`);
  return lineas;
}

// Lo que sigue a `git worktree add`, igual en crear y abrir: .kit-rol, copia, deny, comando-setup, la línea.
function equipar(L, wt, principal, n, a, copia, opciones) {
  const lineas = [];
  let codigo = 0;
  const rol = rolDe(n, a.noche);
  escribirRol(wt, rol);
  lineas.push(...copiarArchivos(wt, copia));
  if (!sumarDeny(wt, principal)) {
    lineas.push('no pude sumar el deny al .env del principal: .claude/settings.local.json del worktree no es un JSON de objeto — arreglalo y corré abrir de nuevo');
    codigo = 1;
  }
  // SPEC-paquete-8r4 rt-1: con EnterWorktree la sesión nace en el principal y el .env del principal es un PADRE del worktree (las
  // reglas ./** del settings.json no lo cubren): las mismas cuatro absolutas también en el settings.local.json del principal.
  const localP = `${barras(principal)}/.claude/settings.local.json`;
  if (sumarDeny(principal, principal)) {
    lineas.push(`deny del .env del principal: en ${localP} (no viaja por git: cada PC lo arma con su primer crear o abrir)`);
  } else {
    lineas.push(`no pude sumar el deny al .env del principal: ${localP} no es un JSON de objeto — arreglalo y corré abrir de nuevo`);
    codigo = 1;
  }
  const s = correrSetup(L, wt, opciones);
  lineas.push(s.linea, ...(s.extra || []));
  if (s.falla) codigo = 1;
  lineas.push(`worktree ${a.comando}: ${n.rama} en ${CARPETAS}/${n.carpeta} (rol ${rol})`);
  lineas.push(...lineasApertura(wt, n, a.modelo, opciones));
  return { codigo, lineas };
}

function correrSetup(L, wt, opciones) {
  const archivo = path.join(wt, '.claude', 'kit.md');
  if (!fs.existsSync(archivo)) return { linea: 'sin ficha: no corrí comando-setup' };
  let datos;
  try {
    datos = L.ficha.leerArchivo(archivo).datos;
  } catch (e) {
    const motivo = `la ficha está rota (${e.message || e})`;
    return { linea: `${motivo}: no corrí comando-setup; no borré nada`, falla: true, motivo };
  }
  const cmd = datos && datos.vars ? datos.vars['comando-setup'] : undefined;
  if (typeof cmd !== 'string' || cmd.trim() === '') return { linea: 'la ficha no tiene vars.comando-setup: no corrí nada' };
  const shell = shellDe(opciones);
  const niega = comandoQueNoCorre(cmd, shell);
  if (niega) {
    const motivo = `comando-setup no se corre (${niega})`;
    return { linea: `${motivo}: corregilo en la ficha y corrélo a mano adentro del worktree; no borré nada`, falla: true, motivo };
  }
  const antes = estadoDelArbol(L, wt);
  const r = spawnSync(cmd, { cwd: wt, shell, stdio: opciones.heredar === false ? 'pipe' : 'inherit', windowsHide: true });
  if (r.error || r.status !== 0) {
    const como = r.error ? r.error.code || r.error.message : `salida ${r.status}`;
    const motivo = `comando-setup falló (${como})`;
    return { linea: `${motivo}: corrélo a mano adentro del worktree; no borré nada`, falla: true, motivo };
  }
  const extra = antes ? limpiarLoDelSetup(L, wt, antes) : [];
  return { linea: `comando-setup anduvo: ${cmd}`, extra };
}

// RF-fix 3 (D8r.1): lo que deja el setup en el árbol (un package-lock.json nuevo, uno reescrito) traba cerrar e integrar ("sucio").
// Lo sin trackear que apareció va al info/exclude del repo (el del git-common-dir: vale para todos sus worktrees); un trackeado que
// el setup cambió vuelve a HEAD con `git checkout --`. Cada cosa con su línea. Si git no responde, no se toca nada.
function estadoDelArbol(L, wt) {
  const o = G(L, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'], wt);
  const m = G(L, ['diff', '--name-only', '-z'], wt);
  if (!o.ok || !m.ok) return null;
  const lista = (s) => s.split('\0').filter(Boolean);
  return { sueltos: new Set(lista(o.stdout)), cambiados: new Set(lista(m.stdout)) };
}

function limpiarLoDelSetup(L, wt, antes) {
  const despues = estadoDelArbol(L, wt);
  if (!despues) return [];
  const lineas = [];
  const sueltos = [...despues.sueltos].filter((f) => !antes.sueltos.has(f));
  if (sueltos.length) {
    const comun = G(L, ['rev-parse', '--git-common-dir'], wt);
    const exclude = comun.ok ? path.join(path.resolve(wt, comun.stdout.trim()), 'info', 'exclude') : null;
    try {
      if (!exclude) throw new Error('sin git-common-dir');
      const previo = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      const ya = new Set(previo.split(/\r?\n/).map((l) => l.trim()));
      const nuevas = sueltos.map((f) => `/${f}`).filter((l) => !ya.has(l));
      if (nuevas.length) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.writeFileSync(exclude, `${previo}${previo && !previo.endsWith('\n') ? '\n' : ''}${nuevas.join('\n')}\n`);
      }
      lineas.push(`comando-setup dejó sin trackear ${sueltos.join(', ')}: lo sumé al info/exclude del repo (así no traba cerrar ni integrar)`);
    } catch (e) {
      lineas.push(`comando-setup dejó sin trackear ${sueltos.join(', ')} y no pude sumarlo al info/exclude (${e.message || e}): sacalo a mano antes de cerrar`);
    }
  }
  for (const f of [...despues.cambiados].filter((x) => !antes.cambiados.has(x))) {
    const c = G(L, ['checkout', '--', f], wt);
    lineas.push(c.ok
      ? `comando-setup cambió ${f} (trackeado): lo volví a como estaba con git checkout -- ${f}`
      : `comando-setup cambió ${f} (trackeado) y git checkout -- ${f} falló: volvelo a mano antes de cerrar`);
  }
  return lineas;
}

function crear(L, u, n, a, opciones) {
  const no = (m) => ({ codigo: 1, lineas: [`worktree crear: no — ${m}`] });
  const P = u.principal;
  const faltan = noIgnorados(L, P);
  if (faltan.length) return no(lineaIgnorados(faltan));
  const def = porDefectoLocal(L, P);
  if (!def) return no('no encuentro la rama por defecto en esta PC (main o master)');
  const fichaModulo = L.docs.rel(L.docs.deRaiz(P), `modulos/${n.x}/README.md`);
  if (!G(L, ['cat-file', '-e', `refs/heads/${def}:${fichaModulo}`], P).ok) {
    return no(`${fichaModulo} no está commiteado en ${def} — primero el commit del módulo (H §8.2)`);
  }
  const wt = path.join(P, ...CARPETAS.split('/'), n.carpeta);
  if (existeRef(L, P, `refs/heads/${n.rama}`) || existeRef(L, P, `refs/remotes/origin/${n.rama}`)) return no(`la rama ${n.rama} ya existe — eso es abrir`);
  if (fs.existsSync(wt) || worktrees(L, P).some((w) => mismaRuta(w.ruta, wt))) return no(`la carpeta ${CARPETAS}/${n.carpeta} ya existe — eso es abrir`);
  const base = n.madre ? `refs/heads/${n.madre}` : `refs/heads/${def}`;
  if (n.madre && !existeRef(L, P, base)) return no(`no existe ${n.madre} en esta PC — el encargo nace de la punta del módulo (worktree abrir ${n.x})`);
  // RF-fix 8 (D8r.1): el freno de la tarea 0, el mismo que el de presentar y autorizado, antes de crear nada: con el sello de tarea 0
  // en el spec vigente del módulo, un encargo ≠ 00 espera a que la ficha de la punta de modulo/<x> tenga el entorno de prueba.
  if (n.id !== null) {
    const E = require('../hooks/lib/encargo.cjs');
    const ref = E.refMasNueva(P, n.madre);
    if (ref.ok) {
      const t0 = E.tareaCeroPendiente(P, n, ref, E.leerEn(P, ref.sha, E.specVigente(P, ref.sha, n.x)));
      if (t0) return no(t0);
    }
  }
  const ch = chequeosDeCredenciales(L, P, base, 'crear');
  if (ch.codigo) return ch;
  // Pasó todo: recién ahora se toca algo.
  if (WIN) G(L, ['config', 'core.longpaths', 'true'], P);
  const add = G(L, ['worktree', 'add', '-b', n.rama, wt, base], P);
  if (!add.ok) return no(`git worktree add falló: ${primeraLinea(add.stderr) || add.error}`);
  return equipar(L, wt, P, n, a, ch.copia, opciones);
}

function abrir(L, u, n, a, opciones) {
  const lineas = [];
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree abrir: no — ${m}`] });
  const P = u.principal;
  const faltan = noIgnorados(L, P);
  if (faltan.length) return no(lineaIgnorados(faltan));
  const remotos = (G(L, ['remote'], P).stdout || '').split('\n').map((s) => s.trim());
  if (remotos.includes('origin')) {
    const f = G(L, ['fetch', '-q', 'origin'], P);
    if (!f.ok) lineas.push(`no pude hacer fetch de origin (${primeraLinea(f.stderr) || f.error}): sigo con lo que hay en esta PC`);
  }
  G(L, ['worktree', 'prune'], P);
  const wt = path.join(P, ...CARPETAS.split('/'), n.carpeta);
  const lista = worktrees(L, P);
  if (lista.some((w) => mismaRuta(w.ruta, wt))) {
    return { codigo: 1, lineas: [...lineas, `worktree abrir: no — ${CARPETAS}/${n.carpeta} ya está abierto en esta PC:`, ...lineasApertura(wt, n, a.modelo, opciones)] };
  }
  if (fs.existsSync(wt)) return no(`${CARPETAS}/${n.carpeta} existe pero no es un worktree: movela o borrala a mano`);
  const ocupada = lista.find((w) => w.rama === `refs/heads/${n.rama}`);
  if (ocupada) return no(`${n.rama} está abierta en ${barras(ocupada.ruta)}`);
  const local = sha(L, P, `refs/heads/${n.rama}`);
  const remota = sha(L, P, `refs/remotes/origin/${n.rama}`);
  if (!local && !remota) return no(`no existe ${n.rama} ni acá ni en origin — eso es crear`);
  let destino = local;
  let adelantar = false;
  if (local && remota && local !== remota) {
    if (G(L, ['merge-base', '--is-ancestor', local, remota], P).ok) {
      destino = remota;
      adelantar = true;
    } else if (!G(L, ['merge-base', '--is-ancestor', remota, local], P).ok) {
      return no(`${n.rama} divergió de origin/${n.rama}: integralas a mano antes de abrir`);
    }
  } else if (!local) {
    destino = remota;
  }
  const ch = chequeosDeCredenciales(L, P, destino, 'abrir');
  if (ch.codigo) return { codigo: 1, lineas: [...lineas, ...ch.lineas] };
  if (WIN) G(L, ['config', 'core.longpaths', 'true'], P);
  if (!local) {
    const b = G(L, ['branch', '--track', n.rama, `refs/remotes/origin/${n.rama}`], P);
    if (!b.ok) return no(`no pude crear ${n.rama} desde origin: ${primeraLinea(b.stderr) || b.error}`);
  } else if (adelantar) {
    const b = G(L, ['update-ref', `refs/heads/${n.rama}`, destino, local], P);
    if (!b.ok) return no(`no pude adelantar ${n.rama}: ${primeraLinea(b.stderr) || b.error}`);
    lineas.push(`adelanté ${n.rama} hasta origin/${n.rama}`);
  }
  const add = G(L, ['worktree', 'add', wt, n.rama], P);
  if (!add.ok) return no(`git worktree add falló: ${primeraLinea(add.stderr) || add.error}`);
  const r = equipar(L, wt, P, n, a, ch.copia, opciones);
  return { codigo: r.codigo, lineas: [...lineas, ...r.lineas] };
}

// ---------------------------------------------------------------- sync-env (R-33, r1-8): solo saca, nunca vuelve a copiar

function syncEnv(L, u) {
  const P = u.principal;
  const alm = leerAlmacen(P);
  if (alm.estado === 'ilegible') return { codigo: 1, lineas: [`worktree sync-env: no — el almacén de ${alm.proyecto} ${alm.motivo}: no toqué nada`] };
  if (alm.estado === 'sin') return { codigo: 0, lineas: [`sin almacén para ${alm.proyecto}: no saqué nada`] };
  const raizWt = path.join(P, ...CARPETAS.split('/'));
  const vivos = worktrees(L, P).filter((w) => mismaRuta(path.dirname(w.ruta), raizWt) && /^modulo--/.test(path.basename(w.ruta)) && fs.existsSync(w.ruta));
  const lineas = [];
  let codigo = 0;
  for (const w of vivos) {
    const nombre = path.basename(w.ruta);
    const r = G(L, ['ls-files', '-z', '-o', '-i', '--exclude=.env', '--exclude=.env.*'], w.ruta);
    if (!r.ok) {
      lineas.push(`${nombre}: no pude listar sus .env`);
      codigo = 1;
      continue;
    }
    for (const rel of r.stdout.split('\0').filter(Boolean)) {
      const abs = path.join(w.ruta, ...rel.split('/'));
      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch (e) {
        lineas.push(`${nombre}/${rel}: no lo pude leer`);
        codigo = 1;
        continue;
      }
      if (ilegible(buf)) {
        lineas.push(`${nombre}/${rel} está en UTF-16: no lo pude filtrar — guardalo en UTF-8 y corré sync-env de nuevo`);
        codigo = 1;
        continue;
      }
      const f = filtrarEnv(buf.toString('utf8'), alm.nombres);
      if (!f.sacados.length) continue;
      escribirAtomico(abs, Buffer.from(f.texto, 'utf8'));
      for (const s of f.sacados) lineas.push(`saqué ${s} de ${nombre}/${rel}: vive en el almacén`);
    }
  }
  if (!lineas.length) lineas.push(`worktree sync-env: nada que sacar (${vivos.length} worktree(s) de módulo)`);
  return { codigo, lineas };
}

// ---------------------------------------------------------------- cerrar (R-22, D4-3, r1-1, r1-2, r1-9)

// frenos.log del disco contra el de HEAD del worktree, los dos lados normalizados a LF (con core.autocrlf=true el archivo sale con
// CRLF y los hooks agregan LF) → { estado: 'nada' (no está en el disco) | 'igual' | 'agregado' (la base más renglones al final, o
// no está en HEAD: lo creó un hook) | 'cambiado', extra, enHead }. Lo usan la mudanza de cerrar y el commit de integrar (D5-11).
function frenosContraHead(L, wt) {
  let disco;
  try {
    disco = fs.readFileSync(path.join(wt, ...LOG.split('/')));
  } catch (e) {
    return { estado: 'nada', extra: '', enHead: null };
  }
  const aLF = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
  const base = G(L, ['show', `HEAD:${LOG}`], wt);
  const D = aLF(disco);
  if (!base.ok) return { estado: 'agregado', extra: D, enHead: false };
  const B = aLF(base.salida);
  if (D === B) return { estado: 'igual', extra: '', enHead: true };
  if (D.startsWith(B)) return { estado: 'agregado', extra: D.slice(B.length).replace(/^\n/, ''), enHead: true };
  return { estado: 'cambiado', extra: '', enHead: true };
}

// La mudanza de frenos.log (r1-1): lo agregado sobre HEAD va al <git-common-dir>/kit-frenos.log y el archivo vuelve a HEAD (o se
// borra, si no estaba). → 'nada' | 'mudado' | 'cambiado'. quien: el subcomando que muda (la cabecera del renglón).
function mudarFrenos(L, wt, gitComun, nombre, quien = 'cerrar') {
  const archivo = path.join(wt, ...LOG.split('/'));
  const f = frenosContraHead(L, wt);
  if (f.estado === 'nada') return 'nada'; // no está en el disco: si estaba en HEAD, el status lo cuenta como sucio
  if (f.estado === 'cambiado') return 'cambiado';
  const extra = f.extra;
  if (extra.trim() !== '') {
    const comun = path.join(gitComun, LOG_COMUN);
    let previo = '';
    try {
      const t = fs.readFileSync(comun);
      if (t.length && t[t.length - 1] !== 0x0a) previo = '\n';
    } catch (e) {
      /* todavía no existe */
    }
    const cabeza = `# worktree ${quien} ${nombre} · ${L.frenosLog.fechaConZona(new Date())}\n`;
    fs.appendFileSync(comun, `${previo}${cabeza}${extra.endsWith('\n') ? extra : `${extra}\n`}`);
  }
  if (!f.enHead) fs.rmSync(archivo);
  else G(L, ['checkout', '--', LOG], wt);
  return 'mudado';
}

const porcelana = (L, wt) => {
  const r = G(L, ['status', '--porcelain', '--untracked-files=all'], wt);
  return r.ok ? r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean) : null;
};

// Los archivos de una carpeta (rutas con '/', relativas a ella), sin el `.git` de arriba (el puntero de un worktree). null si son
// demasiados para revisarlos.
function archivosDe(dir, tope = 2000) {
  const out = [];
  const pila = [''];
  while (pila.length) {
    const rel = pila.pop();
    for (const e of fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === '.git') continue;
      if (e.isDirectory()) pila.push(r);
      else out.push(r);
      if (out.length > tope) return null;
    }
  }
  return out;
}

// rf-6: una carpeta que ya no es worktree (remove borró el registro y no la carpeta: la tenía abierta VS Code) se puede borrar si
// está vacía o tiene solo lo que el principal ignora en la misma ruta (.env, .kit-rol, node_modules…). → true si la borró.
function borrarSiSobra(L, P, wt) {
  let archivos;
  try {
    archivos = archivosDe(wt);
  } catch (e) {
    return false;
  }
  if (archivos === null) return false;
  if (archivos.length) {
    const ci = G(L, ['check-ignore', '-z', '--stdin'], P, { entrada: `${archivos.join('\0')}\0` });
    if (ci.codigo !== 0) return false; // 1: alguno no está ignorado; otro: no se pudo ver
    const ign = new Set(ci.stdout.split('\0').filter(Boolean));
    if (!archivos.every((a) => ign.has(a))) return false;
  }
  try {
    fs.rmSync(wt, { recursive: true, force: true });
  } catch (e) {
    return false;
  }
  return !fs.existsSync(wt);
}

// rf-1 (revisor frío de D5.1): cancelar un encargo. La rama no está mergeada (por eso `cerrar` común la niega) y puede estar
// abierta en su worktree (por eso `git branch -D` a mano falla). Exige el renglón `cancelado <ID> @<sha7>` commiteado en la ficha
// (docs/modulos/<x>/README.md) de la más nueva entre modulo/<x> local y origin, con el SHA de la punta (local u origin): el trabajo
// se recupera por ese SHA. Recién ahí: frenos.log mudado, `worktree remove --force` (si está), `branch -D` (si está) y
// `push origin --delete` (si origin la tiene). Se puede correr de nuevo: lo que ya no está, se saltea.
function cancelar(L, u, n, lineas, conOrigin) {
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree cerrar --cancelado: no — ${m}`] });
  const E = require('../hooks/lib/encargo.cjs');
  const P = u.principal;
  const wt = path.join(P, ...CARPETAS.split('/'), n.carpeta);
  const local = sha(L, P, `refs/heads/${n.rama}`);
  const remota = sha(L, P, `refs/remotes/origin/${n.rama}`);
  // 1. El renglón en la ficha commiteada.
  const ref = E.refMasNueva(P, n.madre);
  if (!ref.ok) return no(ref.por);
  const rutaFicha = L.docs.rel(L.docs.deRaiz(P), `modulos/${n.x}/README.md`);
  const buf = E.leerEn(P, ref.sha, rutaFicha);
  const re = new RegExp(`(?:^|[\\s(\`*-])cancelado ${n.id}(?![0-9])(?:[^@\\n]*@([0-9a-f]{7,40}))?`, 'm');
  const m = buf ? re.exec(buf.toString('utf8')) : null;
  const puntas = [local, remota].filter(Boolean);
  const puntaTexto = puntas.length ? ` (la punta: @${puntas[0].slice(0, 7)})` : '';
  if (!m) return no(`anotá el cancelado en la ficha y commitealo primero: "cancelado ${n.id} @<sha7 de la punta>: por qué" en ${rutaFicha} de ${n.madre}${puntaTexto} — nada borrado`);
  if (puntas.length && !(m[1] && puntas.some((s) => s.startsWith(m[1].toLowerCase())))) {
    return no(`el renglón "cancelado ${n.id}" de ${rutaFicha} no tiene el SHA de la punta${puntaTexto}: corregilo y commitealo (el trabajo se recupera por ese SHA) — nada borrado`);
  }
  // 2. El worktree del encargo, si está en esta PC.
  const entrada = worktrees(L, P).find((w) => w.rama === `refs/heads/${n.rama}`);
  if (entrada && !mismaRuta(entrada.ruta, wt)) return no(`${n.rama} está abierta en ${barras(entrada.ruta)}, no en ${CARPETAS}/${n.carpeta}: cerrala a mano`);
  if (entrada && fs.existsSync(wt)) {
    const mf = mudarFrenos(L, wt, u.gitComun, n.carpeta, 'cerrar --cancelado');
    if (mf === 'mudado') lineas.push(`mudé lo nuevo de ${LOG} a ${LOG_COMUN} del repo`);
    const rm = G(L, ['worktree', 'remove', '--force', wt], P, { tiempo: 120000 });
    if (!rm.ok) return no(`git worktree remove --force falló (${primeraLinea(rm.stderr) || rm.error}): cerrá la pestaña o el claude de ese worktree y corré de nuevo; la rama ${n.rama} sigue`);
    lineas.push(`borré ${CARPETAS}/${n.carpeta}`);
  } else if (entrada) {
    G(L, ['worktree', 'prune'], P);
  } else if (fs.existsSync(wt)) {
    if (!borrarSiSobra(L, P, wt)) return no(`${CARPETAS}/${n.carpeta} existe pero no es el worktree de ${n.rama}: revisala a mano`);
    lineas.push(`${CARPETAS}/${n.carpeta} ya no era un worktree y tenía solo lo ignorado: la borré`);
  }
  // 3. Las ramas.
  if (local) {
    const b = G(L, ['branch', '-D', n.rama], P);
    if (!b.ok) return no(`no pude borrar la rama ${n.rama}: ${primeraLinea(b.stderr) || b.error}`);
    lineas.push(`borré la rama ${n.rama}`);
  }
  if (!conOrigin) lineas.push('sin remoto: no hay rama en origin que borrar');
  else if (remota) {
    const d = G(L, ['push', '-q', 'origin', '--delete', n.rama], P, { tiempo: 120000 });
    if (!d.ok) return no(`no pude borrar ${n.rama} de origin (${primeraLinea(d.stderr) || d.error}): corré de nuevo`);
    lineas.push(`borré ${n.rama} de origin`);
  }
  if (!local && !remota) lineas.push(`${n.rama} ya no estaba ni acá ni en origin`);
  lineas.push(`worktree cerrar: ${n.rama} cancelada (el trabajo se recupera por @${m[1] || '—'}, anotado en ${rutaFicha})`);
  return { codigo: 0, lineas };
}

function cerrar(L, u, n, cancelado = false) {
  const lineas = [];
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree cerrar: no — ${m}`] });
  const P = u.principal;
  const wt = path.join(P, ...CARPETAS.split('/'), n.carpeta);
  if (mismaRuta(u.raiz, wt) || dentroDe(u.cwd, wt)) return no(`estás adentro de ${CARPETAS}/${n.carpeta}: corré cerrar desde el principal o desde el director`);
  // rf-5: lo mergeado en GitHub se ve recién después del fetch; rf-6 (revisor frío de D5.1): con --prune, una rama borrada en
  // origin desde la otra PC deja de verse. Sin remoto, o si falla, se sigue con lo que hay.
  const remotos = (G(L, ['remote'], P).stdout || '').split('\n').map((s) => s.trim());
  const conOrigin = remotos.includes('origin');
  let fetchOk = false;
  if (conOrigin) {
    const f = G(L, ['fetch', '-q', '--prune', 'origin'], P);
    fetchOk = f.ok;
    if (!f.ok) lineas.push(`no pude hacer fetch de origin (${primeraLinea(f.stderr) || f.error}): sigo con lo que hay en esta PC`);
  }
  if (cancelado) return cancelar(L, u, n, lineas, conOrigin);
  if (!existeRef(L, P, `refs/heads/${n.rama}`)) return no(`no existe la rama ${n.rama} en esta PC`);
  const madre = n.madre || L.contexto.ramaPorDefecto(P);
  if (!madre) return no('no encuentro la rama por defecto (main o master)');
  const refs = [`refs/heads/${madre}`, `refs/remotes/origin/${madre}`].filter((r) => existeRef(L, P, r));
  if (!refs.length) return no(`no existe ${madre}, ni acá ni en origin`);
  const mergeada = refs.some((r) => G(L, ['merge-base', '--is-ancestor', `refs/heads/${n.rama}`, r], P).ok);
  if (!mergeada) {
    return no(
      `${n.rama} no está mergeada en ${madre} (ni en la local ni en la de origin) — nada borrado. ¿Lo mergeaste en GitHub? hacé \`git pull\`; ` +
        `con squash, borrá la rama a mano (\`git branch -D ${n.rama}\`)`,
    );
  }
  const lista = worktrees(L, P);
  const entrada = lista.find((w) => w.rama === `refs/heads/${n.rama}`);
  if (entrada && !mismaRuta(entrada.ruta, wt)) return no(`${n.rama} está abierta en ${barras(entrada.ruta)}, no en ${CARPETAS}/${n.carpeta}`);
  if (!fs.existsSync(wt)) {
    // Carpeta borrada a mano: prune (si seguía registrada) y la rama, con las mismas condiciones.
    if (entrada) {
      G(L, ['worktree', 'prune'], P);
      lineas.push(`${CARPETAS}/${n.carpeta} ya no estaba: hice prune`);
    }
  } else if (!entrada) {
    // rf-6: sin registro y vacía (o con solo lo ignorado) → se borra y sigue a la rama; con cualquier otra cosa, a mano.
    if (!borrarSiSobra(L, P, wt)) return no(`${CARPETAS}/${n.carpeta} existe pero no es el worktree de ${n.rama}: revisala a mano`);
    lineas.push(`${CARPETAS}/${n.carpeta} ya no era un worktree y tenía solo lo ignorado: la borré`);
  } else {
    const antes = porcelana(L, wt);
    if (antes === null) return no('no pude leer el estado del worktree');
    const otros = antes.filter((l) => l.slice(3).replace(/^"|"$/g, '') !== LOG);
    const hasta5 = (xs) => `${xs.slice(0, 5).join(' | ')}${xs.length > 5 ? ` … (${xs.length} en total)` : ''}`;
    const sueltos = otros.filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
    const cambiados = otros.filter((l) => !l.startsWith('?? '));
    if (cambiados.length) return no(`el worktree tiene cambios sin commitear: ${hasta5(otros)}`);
    // Solo lo sin trackear (lo deja la suite: coverage/, un .log; verificar ya lo marca ⚠️, rf-10): se dice qué hacer, no se borra
    // acá (borrar es de una persona o del director).
    if (sueltos.length) {
      // RF-fix 8: `-e .claude/frenos.log` en los dos (así -nd muestra lo mismo que borra -fd): un frenos.log sin trackear tiene
      // renglones que cerrar muda al log común, y un clean pelado se los llevaba.
      const c = `git -C "${barras(wt)}"`;
      return no(
        `el worktree tiene archivos sin trackear: ${hasta5(sueltos)} — nada borrado. Miralos con \`${c} clean -nd -e ${LOG}\`; si sobran, ` +
          `los borrás vos (o el director) con \`${c} clean -fd -e ${LOG}\`, y si van a volver (ej. coverage/), sumalos al .gitignore y commitealo. ` +
          'Después, cerrar de nuevo',
      );
    }
    const m = mudarFrenos(L, wt, u.gitComun, n.carpeta);
    if (m === 'cambiado') return no(`${LOG} cambió en el medio (no solo renglones al final): no lo toqué — commitealo o revisalo`);
    const despues = porcelana(L, wt);
    if (despues === null || despues.length) return no(`el worktree sigue sucio: ${(despues || []).slice(0, 5).join(' | ')}`);
    if (m === 'mudado') lineas.push(`mudé lo nuevo de ${LOG} a ${LOG_COMUN} del repo`);
    const rm = G(L, ['worktree', 'remove', wt], P, { tiempo: 120000 });
    if (!rm.ok) {
      return {
        codigo: 1,
        lineas: [...lineas, `worktree cerrar: no — git worktree remove falló (${primeraLinea(rm.stderr) || rm.error}): cerrá la pestaña o el claude de ese worktree y corré cerrar de nuevo; la rama ${n.rama} sigue`],
      };
    }
    lineas.push(`borré ${CARPETAS}/${n.carpeta}`);
  }
  const b = G(L, ['branch', '-D', n.rama], P);
  if (!b.ok) return { codigo: 1, lineas: [...lineas, `worktree cerrar: no pude borrar la rama ${n.rama}: ${primeraLinea(b.stderr) || b.error}`] };
  if (conOrigin) lineas.push(...cerrarEnOrigin(L, P, n, madre, fetchOk));
  lineas.push(`worktree cerrar: ${n.rama} cerrada (estaba mergeada en ${madre})`);
  return { codigo: 0, lineas };
}

// SPEC-paquete-8r (1; rt-2, D8r-7): después de la rama local, la de origin. Se borra (`push origin --delete`) solo si el fetch de
// esta corrida anduvo y la punta de origin/<rama> es ancestro de origin/<madre> (no de la local: puede no estar pusheada); si no,
// queda con una línea. Que no se pueda borrar no cambia la salida (la local ya se cerró). → las líneas.
function cerrarEnOrigin(L, P, n, madre, fetchOk) {
  const remota = sha(L, P, `refs/remotes/origin/${n.rama}`);
  if (!remota) return [];
  if (!fetchOk) return ['la de origin queda: no la borré: el fetch falló'];
  const def = L.contexto.ramaPorDefecto(P) || madre;
  const enMadre = existeRef(L, P, `refs/remotes/origin/${madre}`) && G(L, ['merge-base', '--is-ancestor', remota, `refs/remotes/origin/${madre}`], P).ok;
  if (!enMadre) {
    return [madre === def ? `la de origin queda: la flota la ignora cuando ${def} llegue a origin` : `la de origin queda: la flota la ignora cuando ${madre} llegue a ${def}`];
  }
  const d = G(L, ['push', '-q', 'origin', '--delete', n.rama], P, { tiempo: 120000 });
  if (!d.ok) return [`la de origin queda: no pude borrarla (${primeraLinea(d.stderr) || d.error})`];
  return [`borré ${n.rama} de origin (estaba en origin/${madre})`];
}

// ---------------------------------------------------------------- integrar (SPEC-paquete-5; D4-2, D4-3, D5-3, D5-11, D5-14, r1-1)

const PLAZO_TEST = 30 * 60 * 1000; // comando-test del gate: 30 min
const SIN_OK = ['con-gate-verde', 'libre']; // autorizado.merge-a-main que no pide el OK de Guido
const ES_RECHAZO = /\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/;

// comando-test corre adentro del vigía (VIGIA, de hooks/lib/proceso.cjs: pasado el plazo mata el ÁRBOL entero y sale con 124).

const sinPrefijo = (ref) => ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');

// Lo que la ficha vigente dice de merge-a-main (por nivel, de fábrica, si falta) → { valor } o { error }.
function mergeAMain(L, P) {
  const fv = L.contexto.fichaVigente(P);
  if (fv.estado === 'rota') return { error: `la ficha vigente está rota (${fv.donde}): corré doctor` };
  if (fv.estado !== 'ok') return { error: 'sin ficha vigente en origin: integrar es de los proyectos con ficha' };
  const aut = fv.datos.autorizado;
  if (aut && typeof aut['merge-a-main'] === 'string') return { valor: aut['merge-a-main'] };
  return { valor: L.fabrica.fabrica(fv.datos.nivel).autorizado['merge-a-main'] };
}

// El gate en el temporal (D4-3, D5-3): barreras del rango que sube, el candado sin estado-viejo ni lecturas, y vars.comando-test.
// estructura.cjs es el de al lado de este script (el que corre). → { verde, lineas }.
function gate(L, tmp, base, punta, opciones) {
  const E = require('./estructura.cjs');
  const lineas = [];
  let verde = true;
  for (const args of [['barreras', '--rango', `${base}..${punta}`], ['raiz', 'rutas', 'topes', 'estados', 'datos', 'mesa']]) {
    let out = '';
    const c = E.main(args, { cwd: tmp, salida: (s) => (out += s), error: (s) => (out += s) });
    lineas.push(...out.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean));
    if (c !== 0) verde = false;
  }
  if (!verde) return { verde, lineas: [...lineas, 'no corrí comando-test: el gate ya está rojo'] };
  let cmd;
  try {
    const d = L.ficha.leerArchivo(path.join(tmp, '.claude', 'kit.md')).datos;
    cmd = d && d.vars ? d.vars['comando-test'] : undefined;
  } catch (e) {
    return { verde: false, lineas: [...lineas, `NO VERIFICADO: la ficha del merge no se lee (${e.message || e}): no corrí comando-test`] };
  }
  if (typeof cmd !== 'string' || cmd.trim() === '') return { verde: false, lineas: [...lineas, 'NO VERIFICADO: la ficha no tiene vars.comando-test — sumalo'] };
  const plazo = opciones.plazoTest || PLAZO_TEST;
  const shell = shellDe(opciones);
  const niega = comandoQueNoCorre(cmd, shell);
  if (niega) return { verde: false, lineas: [...lineas, `NO VERIFICADO: comando-test no se corre (${niega}): ${cmd}`] };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argsVigia(cmd, plazo, shell), {
    cwd: tmp,
    stdio: opciones.heredar === false ? 'pipe' : 'inherit',
    windowsHide: true,
    timeout: plazo + 60000,
  });
  if ((r.error && r.error.code === 'ETIMEDOUT') || (r.status === 124 && Date.now() - t0 >= plazo)) {
    return { verde: false, lineas: [...lineas, `NO VERIFICADO: comando-test no terminó en ${Math.round(plazo / 60000)} min (${cmd})`] };
  }
  if (r.error || r.status !== 0) {
    const como = r.error ? r.error.code || r.error.message : r.signal ? `señal ${r.signal}` : `salida ${r.status}`;
    return { verde: false, lineas: [...lineas, `comando-test en rojo (${como}): ${cmd}`] };
  }
  return { verde: true, lineas: [...lineas, `comando-test en verde: ${cmd}`] };
}

// Borra el temporal: primero muda al común lo que el gate anotó en su frenos.log y después `worktree remove --force` (rf-2: el
// temporal es de integrar, está desprendido y no guarda nada propio; un comando-setup que reescribe el package-lock o un test que
// deja coverage/ lo ensucian, y sin --force quedaba registrado). → null si anduvo, o la línea.
function borrarTemporal(L, P, gitComun, tmp, nombre) {
  if (!fs.existsSync(tmp)) {
    G(L, ['worktree', 'prune'], P);
    return null;
  }
  mudarFrenos(L, tmp, gitComun, nombre, 'integrar');
  const rm = G(L, ['worktree', 'remove', '--force', tmp], P, { tiempo: 120000 });
  if (rm.ok) return null;
  return `no pude borrar el temporal ${CARPETAS}/${nombre} (${primeraLinea(rm.stderr) || rm.error}): cerrá lo que lo tenga abierto y corré git worktree remove --force "${barras(tmp)}"`;
}

// Lo que pasa adentro del temporal ya creado: .kit-rol, merge, credenciales, copia, deny, setup, gate y push.
function enElTemporal(L, P, tmp, n, def, base, punta, okLinea, opciones) {
  const lineas = [];
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree integrar: no — ${m}`] });
  escribirRol(tmp, 'director');
  const msj = ['-m', `integrar: módulo ${n.x}`, ...(okLinea ? ['-m', okLinea] : [])];
  const m = G(L, ['merge', '--no-ff', '-q', ...msj, punta], tmp, { tiempo: 120000 });
  if (!m.ok) {
    const conflicto = (G(L, ['diff', '--name-only', '--diff-filter=U'], tmp).stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    G(L, ['merge', '--abort'], tmp);
    if (conflicto.length) return no(`conflicto en ${conflicto.join(', ')}: es un encargo a un obrero (nada subió)`);
    return no(`git merge falló (${primeraLinea(m.stderr) || m.error}): nada subió`);
  }
  const merge = sha(L, tmp, 'HEAD');
  // r1-1: el temporal se equipa como `equipar`, con la copia filtrada sobre lo que va a quedar en main.
  const ch = chequeosDeCredenciales(L, P, merge, 'integrar');
  if (ch.codigo) return { codigo: 1, lineas: [...lineas, ...ch.lineas] };
  lineas.push(...copiarArchivos(tmp, ch.copia));
  if (!sumarDeny(tmp, P)) return no('no pude sumar el deny al settings.local.json del temporal: nada subió');
  const s = correrSetup(L, tmp, opciones);
  if (s.falla) return no(`NO VERIFICADO — ${s.motivo} en el temporal: nada subió`);
  lineas.push(s.linea, ...(s.extra || []));
  const gt = gate(L, tmp, base, merge, opciones);
  lineas.push(...gt.lineas);
  if (!gt.verde) return no('el gate está en rojo: nada subió');
  const push = G(L, ['push', '-q', 'origin', `HEAD:refs/heads/${def}`], tmp, { tiempo: 120000 });
  if (!push.ok) {
    if (ES_RECHAZO.test(push.stderr)) return no('origin avanzó: corré integrar de nuevo');
    return no(`git push falló (${primeraLinea(push.stderr) || push.error}): nada subió`);
  }
  lineas.push(`worktree integrar: módulo ${n.x} en origin/${def} — merge ${merge}`);
  // SPEC-paquete-8r (5, R:39): los papeles de <def> quedaron atrás; los pone al día el /cierre de la carpeta principal.
  lineas.push(`después: /cierre en tu carpeta principal (los papeles de ${def} quedaron atrás del módulo ${n.x})`);
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- integrados (SPEC-paquete-8r 5; D8r-5)

const RE_INTEGRAR = /^integrar: módulo (\S+)$/;

// Los merges `integrar: módulo <x>` del primer padre de la rama por defecto LOCAL posteriores al último commit que tocó
// docs/SESSION_HANDOFF.md: una línea por módulo (del más viejo al más nuevo); nada si no hay. Sale 0 siempre: si algo falla, una
// línea y 0 (lo corre el /inicio después del pull; no frena nada).
function integrados(L, u) {
  const no = (m) => ({ codigo: 0, lineas: [`worktree integrados: no pude mirar (${m})`] });
  const P = u.principal;
  const def = porDefectoLocal(L, P);
  if (!def) return no('no hay rama por defecto local');
  const handoff = L.docs.rel(L.docs.deRaiz(P), 'SESSION_HANDOFF.md'); // 8r3 i1
  const ult = G(L, ['log', '-1', '--format=%H', `refs/heads/${def}`, '--', handoff], P);
  if (!ult.ok) return no(primeraLinea(ult.stderr) || ult.error || 'git log falló');
  const desde = ult.stdout.trim();
  const rango = desde ? `${desde}..refs/heads/${def}` : `refs/heads/${def}`;
  const r = G(L, ['log', '--first-parent', '--merges', '--reverse', '--format=%H%x09%s', rango], P);
  if (!r.ok) return no(primeraLinea(r.stderr) || r.error || 'git log falló');
  const lineas = [];
  for (const l of r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const tab = l.indexOf('\t');
    const m = RE_INTEGRAR.exec(l.slice(tab + 1));
    if (m) lineas.push(`módulo ${m[1]} integrado después del último handoff (@${l.slice(0, 7)}): corré /cierre para poner los papeles al día`);
  }
  return { codigo: 0, lineas };
}

function integrar(L, u, n, a, opciones) {
  const lineas = [];
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree integrar: no — ${m}`] });
  const P = u.principal;
  // 1. origin al día.
  const remotos = (G(L, ['remote'], P).stdout || '').split('\n').map((s) => s.trim());
  if (!remotos.includes('origin')) return no('integrar necesita origin; sin remoto, mergealo desde el checkout principal');
  const f = G(L, ['fetch', '-q', '--prune', 'origin'], P);
  if (!f.ok) return no(`no pude hacer fetch de origin (${primeraLinea(f.stderr) || f.error}): sin origin al día no integro`);
  const rv = L.contexto.refVigente(P);
  if (!rv || rv.origen === 'local') return no('origin no tiene la rama por defecto (main o master)');
  const def = rv.nombre;
  const faltan = noIgnorados(L, P);
  if (faltan.length) return no(lineaIgnorados(faltan));
  const madres = [`refs/heads/${n.rama}`, `refs/remotes/origin/${n.rama}`].filter((r) => existeRef(L, P, r));
  if (!madres.length) return no(`no existe ${n.rama} ni acá ni en origin`);
  // 2. Encargo abierto: una modulo/<x>--* (local u origin) que no está en modulo/<x> (local u origin).
  const fe = G(L, ['for-each-ref', '--format=%(refname)', `refs/heads/${n.rama}--*`, `refs/remotes/origin/${n.rama}--*`], P);
  if (!fe.ok) return no('no pude listar los encargos');
  const abiertos = new Set();
  for (const ref of fe.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (!madres.some((m) => G(L, ['merge-base', '--is-ancestor', ref, m], P).ok)) abiertos.add(sinPrefijo(ref).replace(/^origin\//, ''));
  }
  if (abiertos.size) return no(`hay un encargo abierto (${[...abiertos].join(', ')}) que no está en ${n.rama}: cerralo o cancelalo`);
  // 4. La ficha vigente (D5-14).
  const mm = mergeAMain(L, P);
  if (mm.error) return no(mm.error);
  const pideOk = !SIN_OK.includes(mm.valor);
  if (pideOk && !a.okDeGuido) return no(`la ficha pide el OK de Guido para mergear a main (merge-a-main: ${mm.valor}): preguntale (clase 3) y corré con --ok-de-guido`);
  const okLinea = pideOk ? `con --ok-de-guido (la ficha pide merge-a-main: ${mm.valor})` : null;
  // 5 (el chequeo). El temporal no puede existir.
  G(L, ['worktree', 'prune'], P);
  const nombreTmp = `integrar--${n.x}`;
  const tmp = path.join(P, ...CARPETAS.split('/'), nombreTmp);
  if (fs.existsSync(tmp) || worktrees(L, P).some((w) => mismaRuta(w.ruta, tmp))) {
    return no(`el temporal ${CARPETAS}/${nombreTmp} ya existe (¿otro integrar a medias?): borralo con git worktree remove --force "${barras(tmp)}" y corré integrar de nuevo`);
  }
  // 3. El worktree del director (el que tiene modulo/<x>), si está en esta PC: limpio salvo frenos.log con renglones agregados.
  const dir = worktrees(L, P).find((w) => w.rama === `refs/heads/${n.rama}` && fs.existsSync(w.ruta));
  let frenos = null;
  if (dir) {
    const st = porcelana(L, dir.ruta);
    if (st === null) return no('no pude leer el estado del worktree del director');
    const otros = st.filter((l) => l.slice(3).replace(/^"|"$/g, '') !== LOG);
    if (otros.length) return no(`el worktree del director tiene cambios sin commitear: ${otros.slice(0, 5).join(' | ')}${otros.length > 5 ? ' …' : ''} — commitealos`);
    frenos = frenosContraHead(L, dir.ruta);
    if (frenos.estado === 'cambiado' || (frenos.estado === 'nada' && st.length)) return no(`${LOG} del director cambió en el medio (no solo renglones al final): revisalo y commitealo a mano`);
  }
  let local = sha(L, P, `refs/heads/${n.rama}`);
  const remota = sha(L, P, `refs/remotes/origin/${n.rama}`);
  const ancestro = (x, y) => G(L, ['merge-base', '--is-ancestor', x, y], P).ok;
  if (local && remota && local !== remota && !ancestro(local, remota) && !ancestro(remota, local)) {
    return no(`${n.rama} divergió de origin/${n.rama}: integralas a mano (git pull en el worktree del director) y corré integrar de nuevo`);
  }
  // Pasaron los chequeos. D5-11: el commit de frenos.log, por ruta, en el worktree del director (su escritor).
  if (frenos && frenos.estado === 'agregado' && frenos.extra.trim() !== '') {
    const add = G(L, ['add', '--', LOG], dir.ruta);
    const c = add.ok ? G(L, ['commit', '-q', '-m', `frenos.log del módulo ${n.x}`, '--', LOG], dir.ruta, { tiempo: 120000 }) : add;
    if (!c.ok) return no(`no pude commitear ${LOG} en el worktree del director (${primeraLinea(c.stderr) || c.error})`);
    lineas.push(`commiteé ${LOG} del módulo ${n.x} en el worktree del director`);
    local = sha(L, P, `refs/heads/${n.rama}`);
  }
  // modulo/<x> igual en las dos puntas: local adelante → push por nombre; atrás → se adelanta; divergida → 1 (la regla de abrir).
  let punta = local || remota;
  if (local && local !== remota) {
    if (!remota || ancestro(remota, local)) {
      const p = G(L, ['push', '-q', 'origin', `refs/heads/${n.rama}:refs/heads/${n.rama}`], P, { tiempo: 120000 });
      if (!p.ok) return no(`no pude subir ${n.rama} a origin (${primeraLinea(p.stderr) || p.error}): nada se mergeó`);
      lineas.push(`subí ${n.rama} a origin`);
    } else if (ancestro(local, remota)) {
      const b = dir ? G(L, ['merge', '--ff-only', '-q', remota], dir.ruta, { tiempo: 120000 }) : G(L, ['update-ref', `refs/heads/${n.rama}`, remota, local], P);
      if (!b.ok) return no(`no pude adelantar ${n.rama} hasta origin (${primeraLinea(b.stderr) || b.error})`);
      lineas.push(`adelanté ${n.rama} hasta origin/${n.rama}`);
      punta = remota;
    } else {
      return no(`${n.rama} divergió de origin/${n.rama}: integralas a mano (git pull en el worktree del director) y corré integrar de nuevo`);
    }
  }
  const base = sha(L, P, `refs/remotes/origin/${def}`);
  if (ancestro(punta, base)) return { codigo: 0, lineas: [...lineas, `worktree integrar: ${n.rama} ya está en origin/${def} — nada que integrar`] };
  // 5. El temporal, desprendido en origin/<defecto>; desde acá se borra siempre.
  if (WIN) G(L, ['config', 'core.longpaths', 'true'], P);
  const add = G(L, ['worktree', 'add', '--detach', tmp, base], P, { tiempo: 120000 });
  if (!add.ok) {
    const b = borrarTemporal(L, P, u.gitComun, tmp, nombreTmp);
    return no(`git worktree add falló (${primeraLinea(add.stderr) || add.error})${b ? `; ${b}` : ''}`);
  }
  let r;
  try {
    r = enElTemporal(L, P, tmp, n, def, base, punta, okLinea, opciones);
  } catch (e) {
    borrarTemporal(L, P, u.gitComun, tmp, nombreTmp);
    throw e;
  }
  const b = borrarTemporal(L, P, u.gitComun, tmp, nombreTmp);
  const todas = [...lineas, ...r.lineas];
  // rf-2: si el push anduvo, el módulo ya está en origin: sale 0 aunque el temporal no se haya podido borrar (un aviso, no un 1
  // que haga creer que no se integró).
  if (b && r.codigo === 0) return { codigo: 0, lineas: [...todas, `aviso: ${b}`] };
  if (b) return { codigo: 1, lineas: [...todas, b] };
  return { codigo: r.codigo, lineas: todas };
}

// ---------------------------------------------------------------- donde (SPEC-paquete-8r4 u1; rt-4, rt-6)

const ramaDe = (L, cwd) => {
  const r = G(L, ['symbolic-ref', '-q', '--short', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() : null;
};
// Solo mira: --no-optional-locks para que el status no refresque el índice (donde no escribe nada).
const porcelanaSinEscribir = (L, wt) => {
  const r = G(L, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], wt);
  return r.ok ? r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean) : null;
};
const sinLog = (st) => st.filter((l) => l.slice(3).replace(/^"|"$/g, '') !== LOG);

// donde <x>[--<ID>]: ¿el cwd es el worktree de ese nombre, con su rama y su rol? Si no, ¿a qué ruta entrar? No escribe nada ni hace
// fetch. Con <ID> el rol esperado es obrero o nocturno; sin él, director o nocturno (rt-4: `crear … --noche` escribe nocturno).
// Un obrero con el árbol con cambios sin commitear (frenos.log no cuenta) → 1: puede haber otra sesión adentro (rt-6).
function donde(L, u, n) {
  const P = u.principal;
  const wt = path.join(P, ...CARPETAS.split('/'), n.carpeta);
  const roles = n.id === null ? ['director', 'nocturno'] : ['obrero', 'nocturno'];
  const parada = (m) => ({ codigo: 1, lineas: [`PARADA: ${m} — no toques nada y avisale al director`] });
  const adentro = mismaRuta(u.raiz, wt);
  if (adentro) {
    const rama = ramaDe(L, wt);
    if (rama !== n.rama) return parada(`${barras(wt)} tiene ${rama || 'un HEAD desprendido'}, no ${n.rama}`);
  } else {
    const w = worktrees(L, P).find((x) => mismaRuta(x.ruta, wt));
    if (!w || !fs.existsSync(wt)) {
      return { codigo: 1, lineas: [`no hay worktree: el director corre worktree crear ${n.id === null ? n.x : `${n.x}--${n.id}`} (o abrir, en otra PC)`] };
    }
    if (w.rama !== `refs/heads/${n.rama}`) return parada(`${barras(wt)} tiene ${w.rama ? sinPrefijo(w.rama) : 'un HEAD desprendido'}, no ${n.rama}`);
  }
  const rol = L.contexto.rol(wt);
  if (!roles.includes(rol)) {
    return parada(rol === 'humano' ? `${barras(wt)} no tiene .kit-rol (esperaba ${roles.join(' o ')})` : `.kit-rol de ${barras(wt)} dice ${rol}, no ${roles.join(' o ')}`);
  }
  if (n.id !== null) {
    const st = porcelanaSinEscribir(L, wt);
    if (st === null) return parada(`no pude leer el estado de ${barras(wt)}`);
    const otros = sinLog(st);
    if (otros.length) {
      return { codigo: 1, lineas: [`¿hay otra sesión en este worktree? ${barras(wt)} tiene cambios sin commitear (${otros.slice(0, 3).join(' | ')}${otros.length > 3 ? ' …' : ''}): no entres; avisale al director`] };
    }
  }
  if (adentro) return { codigo: 0, lineas: [`adentro: ${n.rama} · rol ${rol} · ${barras(wt)}`] };
  return { codigo: 0, lineas: [`entrar: ${barras(wt)}`, 'con la herramienta EnterWorktree (path = esa ruta); después volvé a correr donde'] };
}

// ---------------------------------------------------------------- traer-main (SPEC-paquete-8r4 u2; rt-3, rt-7; u9)

// frenos.log con renglones agregados no es "sucio" (rt-7 a, el trato de integrar): se aparta antes del merge y vuelve al final,
// sobre lo que quedó (commiteado con el merge, o en el disco si el merge se abortó). → { extra, enHead } o null si no hay nada.
function apartarFrenos(L, wt) {
  const f = frenosContraHead(L, wt);
  if (f.estado !== 'agregado' || f.extra === '') return null;
  const archivo = path.join(wt, ...LOG.split('/'));
  if (f.enHead) G(L, ['checkout', '--', LOG], wt);
  else fs.rmSync(archivo);
  return { extra: f.extra };
}
function devolverFrenos(wt, extra) {
  if (!extra) return;
  const archivo = path.join(wt, ...LOG.split('/'));
  let previo = '';
  try {
    previo = fs.readFileSync(archivo, 'utf8');
  } catch (e) {
    previo = '';
  }
  const sep = previo && !previo.endsWith('\n') ? '\n' : '';
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, `${previo}${sep}${extra.endsWith('\n') ? extra : `${extra}\n`}`);
}
// Lo que barreras escribió en frenos.log durante el merge en curso (su renglón de la frenada): se suma a lo apartado, el archivo
// vuelve a como está en el índice (si no, `merge --abort` no puede con un archivo que el merge cambió y el disco también).
function frenosDelMerge(L, wt) {
  const archivo = path.join(wt, ...LOG.split('/'));
  let disco;
  try {
    disco = fs.readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n');
  } catch (e) {
    return '';
  }
  // Sin la versión del índice (en conflicto, o no seguido) o con algo que no es solo agregado al final: no se toca (el abort decide).
  const idx = G(L, ['show', `:${LOG}`], wt);
  if (!idx.ok) return '';
  const base = idx.salida.toString('utf8').replace(/\r\n/g, '\n');
  if (disco === base || !disco.startsWith(base)) return '';
  G(L, ['checkout', '--', LOG], wt);
  return disco.slice(base.length).replace(/^\n/, '');
}

// Lo que el merge en curso toca de barreras (el índice contra cada padre, con el descuento del merge): las categorías y los ids, para
// la línea de `cambios nuevo` (como resolver nueva en actualizar.cjs, i5 de la rc.4). Sin las exenciones: puede nombrar de más.
function tocaDelMerge(wt) {
  const B = require('../hooks/lib/barreras.cjs');
  const cats = new Set();
  const ids = new Set();
  const rutas = [];
  for (const f of B.archivosDe(wt, B.INDICE, {})) {
    const t = B.tocaArchivo(wt, f);
    if (!t.cats.size && !t.ids.size) continue;
    t.cats.forEach((x) => cats.add(x));
    t.ids.forEach((x) => ids.add(x));
    rutas.push(f.rel);
  }
  return { categorias: [...cats].sort(), ids: [...ids].sort(), rutas };
}
const entreComillas = (s) => `"${String(s).replace(/["\\$`]/g, '')}"`;

function lineaCambiosNuevo(L, u, n, def, corto, toca) {
  const slug = `traer-main-${n.x}`;
  const origen = `traer ${def} @${corto} a ${n.rama} (worktree.cjs traer-main) da rojo en barreras`;
  const cuerpo = path.join(u.gitComun, 'kit-traer-main', `${n.x}.md`);
  try {
    fs.mkdirSync(path.dirname(cuerpo), { recursive: true });
    fs.writeFileSync(cuerpo, [
      '## Caso de origen', origen, '',
      '## Regla', `lo que ${def} trae a ${n.rama} y el merge cambia de los frenos: ${toca.ids.join(', ') || '(ver barreras)'}`, '',
      '## Dónde vive', toca.rutas.join(', ') || '(ver barreras)', '',
      '## Medición', '| antes | después |', '|---|---|', `| ${n.rama} sin ${def} @${corto} | con ${def} @${corto} |`, '',
    ].join('\n'));
  } catch (e) {
    return null;
  }
  const args = [
    'node .claude/scripts/cambios.cjs nuevo', `--slug ${slug}`, '--clase 3-barrera', `--toca ${toca.categorias.join(',') || 'hooks'}`,
    ...toca.ids.map((x) => `--id ${entreComillas(x)}`), `--origen ${entreComillas(origen)}`, `--cuerpo ${entreComillas(barras(cuerpo))}`,
  ];
  return args.join(' ');
}

function traerMain(L, u, n) {
  const lineas = [];
  const no = (m) => ({ codigo: 1, lineas: [...lineas, `worktree traer-main: no — ${m}`] });
  const wt = u.raiz;
  const remotos = (G(L, ['remote'], wt).stdout || '').split('\n').map((s) => s.trim());
  if (!remotos.includes('origin')) return no('traer-main necesita origin');
  const f = G(L, ['fetch', '-q', 'origin'], wt);
  if (!f.ok) return no(`no pude hacer fetch de origin (${primeraLinea(f.stderr) || f.error}): no toqué nada`);
  const rama = ramaDe(L, wt);
  if (rama !== n.rama) return no(`estás en ${rama || 'un HEAD desprendido'}, no en ${n.rama}: traer-main se corre en el worktree del director (${CARPETAS}/${n.carpeta}); no toqué nada`);
  const rv = L.contexto.refVigente(wt);
  if (!rv || rv.origen === 'local') return no('origin no tiene la rama por defecto (main o master)');
  const def = rv.nombre;
  const st = porcelana(L, wt);
  if (st === null) return no('no pude leer el estado del worktree');
  const otros = sinLog(st);
  if (otros.length) return no(`el worktree tiene cambios sin commitear: ${otros.slice(0, 5).join(' | ')}${otros.length > 5 ? ' …' : ''} — commitealos (o esperá a que el obrero termine); no toqué nada`);
  const fr = frenosContraHead(L, wt);
  if (fr.estado === 'cambiado' || (fr.estado === 'nada' && st.length)) return no(`${LOG} cambió en el medio (no solo renglones al final): revisalo y commitealo a mano; no toqué nada`);
  const punta = sha(L, wt, `refs/remotes/origin/${def}`);
  const corto = punta.slice(0, 7);
  if (G(L, ['merge-base', '--is-ancestor', punta, 'HEAD'], wt).ok) return { codigo: 0, lineas: [`worktree traer-main: ${n.rama} ya al día con origin/${def} (@${corto})`] };
  const antes = sha(L, wt, 'HEAD');
  const apartado = apartarFrenos(L, wt);
  let extra = apartado ? apartado.extra : '';
  const abortar = () => {
    extra = [extra, frenosDelMerge(L, wt)].filter((s) => s.trim() !== '').map((s) => s.replace(/\n*$/, '\n')).join('');
    const ab = G(L, ['merge', '--abort'], wt);
    if (!ab.ok) lineas.push(`git merge --abort falló (${primeraLinea(ab.stderr) || ab.error}): corrélo a mano antes de seguir`);
    devolverFrenos(wt, extra);
  };
  // u9 (rt-u9-3 b): siempre --no-ff --no-commit y después commit --no-edit, así el pre-commit del proyecto corre con MERGE_HEAD.
  const m = G(L, ['merge', '--no-ff', '--no-commit', '-q', `refs/remotes/origin/${def}`], wt, { tiempo: 120000 });
  if (!m.ok) {
    const conflicto = (G(L, ['diff', '--name-only', '--diff-filter=U'], wt).stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    abortar();
    if (conflicto.length) return no(`traer ${def} choca en ${conflicto.join(', ')}: es un encargo del director (merge abortado: ${n.rama} quedó como estaba)`);
    return no(`git merge falló (${primeraLinea(m.stderr) || m.error}): merge abortado, ${n.rama} quedó como estaba`);
  }
  if (extra) {
    devolverFrenos(wt, extra);
    G(L, ['add', '--', LOG], wt);
  }
  // rt-3: barreras --indice (sin --molde) juzga el merge en curso contra cada padre; a secas compararía solo contra HEAD.
  const E = require('./estructura.cjs');
  let out = '';
  const c = E.main(['barreras', '--indice'], { cwd: wt, salida: (s) => (out += s), error: (s) => (out += s) });
  const salidaB = out.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
  if (c !== 0) {
    let toca = { categorias: [], ids: [], rutas: [] };
    try {
      toca = tocaDelMerge(wt);
    } catch (e) {
      /* sin los ids: la línea va igual con lo que dijo barreras */
    }
    const nuevo = lineaCambiosNuevo(L, u, n, def, corto, toca);
    abortar();
    lineas.push(...salidaB);
    lineas.push(`barreras en rojo${toca.ids.length ? `: ${toca.ids.join(', ')}` : ''} — merge abortado, ${n.rama} quedó como estaba`);
    if (nuevo) {
      lineas.push(`para el dueño, en su checkout principal y en ${def}: ${nuevo}`);
      lineas.push(`después cambios aprobar <el id que dé> (lo aprieta el dueño: un agente no aprueba) y traer-main ${n.x} de nuevo`);
    }
    return no('barreras en rojo: nada se commiteó ni subió');
  }
  if (fs.existsSync(path.join(wt, ...LOG.split('/')))) G(L, ['add', '--', LOG], wt);
  const ci = G(L, ['commit', '-q', '--no-edit', '-m', `módulo ${n.x}: trae ${def} @${corto}`], wt, { tiempo: 120000 });
  if (!ci.ok) {
    const salidaC = `${ci.stdout || ''}\n${ci.stderr || ''}`.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
    abortar();
    return { codigo: 1, lineas: [...lineas, ...salidaC.slice(0, 20), `worktree traer-main: no — el commit del merge falló (el pre-commit del proyecto): merge abortado, ${n.rama} quedó como estaba`] };
  }
  const merge = sha(L, wt, 'HEAD');
  lineas.push(`worktree traer-main: ${n.rama} trae ${def} @${corto} — merge ${merge.slice(0, 7)} (antes ${antes.slice(0, 7)})`);
  const push = G(L, ['push', '-q', 'origin', `refs/heads/${n.rama}:refs/heads/${n.rama}`], wt, { tiempo: 120000 });
  if (!push.ok) return { codigo: 1, lineas: [...lineas, `worktree traer-main: no pude subir ${n.rama} (${primeraLinea(push.stderr) || push.error}): el merge quedó en tu rama local; subilo con git push origin ${n.rama} (nunca --force)`] };
  lineas.push(`subí ${n.rama} a origin`);
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- principal

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  let r;
  try {
    const a = leerArgumentos(argv);
    const L = libs();
    const u = ubicar(L, opciones.cwd || process.cwd());
    if (!u) {
      r = { codigo: a.comando === 'integrados' ? 0 : 1, lineas: ['worktree: no estás dentro de un repo git'] };
    } else if (a.comando === 'integrados') {
      try {
        r = integrados(L, u);
      } catch (e) {
        r = { codigo: 0, lineas: ['worktree integrados: no pude mirar (error inesperado)'] };
      }
    } else if (a.comando === 'crear') {
      r = crear(L, u, a.nombre, a, opciones);
    } else if (a.comando === 'abrir') {
      r = abrir(L, u, a.nombre, a, opciones);
    } else if (a.comando === 'sync-env') {
      r = syncEnv(L, u);
    } else if (a.comando === 'integrar') {
      r = integrar(L, u, a.nombre, a, opciones);
    } else if (a.comando === 'donde') {
      r = donde(L, u, a.nombre);
    } else if (a.comando === 'traer-main') {
      r = traerMain(L, u, a.nombre);
    } else {
      r = cerrar(L, u, a.nombre, a.cancelado);
    }
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    salida(`${ROTO}\n`);
    return 1;
  }
  if (r.lineas.length) salida(`${r.lineas.join('\n')}\n`);
  return r.codigo;
}

if (require.main === module) {
  let codigo = 1;
  try {
    codigo = main(process.argv.slice(2));
  } catch (e) {
    try {
      process.stdout.write(`${ROTO}\n`);
    } catch (e2) {
      /* nada más que hacer: la salida 1 frena igual */
    }
  }
  process.exitCode = codigo;
}

module.exports = { USO, ROTO, nombreDe, leerArgumentos, proyectoDe, leerAlmacen, filtrarEnv, bloquesEnv, reglasDeny, rutaPermiso, main };
