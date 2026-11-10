'use strict';
// tiempos.cjs — lo mecánico del módulo, desde git y desde los transcripts; nunca la cabeza del director (SPEC-0 6.9; D §13.5). Uso:
//   node .claude/scripts/tiempos.cjs tiempos <x> [--ver]
//   node .claude/scripts/tiempos.cjs alarma [--transcript <ruta>]
//   node .claude/scripts/tiempos.cjs contador <x>
// `tiempos <x>`: por cada encargo del módulo (ramas modulo/<x>--<ID>, locales o de origin) el primer y el último commit, la duración
// (desde la - Partida: del encargo si se lee; si no, desde el primer commit) y los sub-pasos (los commits del obrero desde la partida del encargo); lo escribe en docs/modulos/<x>/tiempos.md, en un bloque
// entre marcas (el resto del archivo, la estimación y el "por qué" del director, no se pisa). Un encargo cuya rama ya no está
// conserva su renglón de la vez anterior. --ver imprime sin escribir.
// `alarma`: cuenta las intervenciones de Guido en la pestaña (los mensajes de usuario reales del transcript .jsonl: sin los
// tool_result, sin lo que inyectan los hooks y los comandos, sin los subagentes). Más de 3: imprime la línea obligatoria para las
// notas del CIERRE y sale 1. Sin --transcript toma el .jsonl más nuevo de la carpeta de transcripts de esta carpeta de trabajo.
// `contador <x>`: sub-pasos y desvíos por encargo (un desvío = un commit del obrero que toca algo fuera de ## Toca de su encargo,
// con la misma regla de `encargo.cjs verificar`, línea 4). NUNCA frena: va al director y a /estado.
// docs/ es la carpeta de papeles: la `carpeta-docs:` de la ficha vigente si la hay (SPEC-paquete-8r3 i1; lib/docs-ruta.cjs).
// Salidas: 0 anduvo (o la alarma en 3 o menos) · 1 la alarma saltó (más de 3), o no hay módulo para escribir · 2 mal llamado.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../hooks/lib/git.cjs');
const E = require('../hooks/lib/encargo.cjs');
const frenosLog = require('../hooks/lib/frenos-log.cjs');
const docsRuta = require('../hooks/lib/docs-ruta.cjs');

const USO = [
  'Uso: node .claude/scripts/tiempos.cjs <comando> …   (desde el repo)',
  '  tiempos <x> [--ver]                 por encargo: primer y último commit, duración y sub-pasos; escribe docs/modulos/<x>/tiempos.md',
  '  alarma [--transcript <ruta>]        intervenciones de Guido en esta pestaña (más de 3: línea para las notas del CIERRE, salida 1)',
  '  contador <x>                        sub-pasos y desvíos por encargo (nunca frena)',
  '  (docs/ es la carpeta de papeles: la carpeta-docs: de la ficha si la hay)',
].join('\n');

const UMBRAL_ALARMA = 3;
const T_GIT = 60000;
const MARCA_ABRE = '<!-- tiempos:inicio (lo genera tiempos.cjs: no editar a mano) -->';
const MARCA_CIERRA = '<!-- tiempos:fin -->';
const TOTAL_RE = /^- Total: (\d+) encargo\(s\) · (\d+) sub-paso\(s\) · (\d+) min$/m;

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

const G = (cwd, args) => git.correr(args, { cwd, tiempo: T_GIT });
const dos = (n) => String(n).padStart(2, '0');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// La carpeta del módulo, relativa y con '/' (8r3 i1): docs/modulos/<x> sin la clave.
const moduloRel = (raiz, x) => docsRuta.rel(docsRuta.deRaiz(raiz), `modulos/${x}`);
// Hora local, sin zona: 2026-11-02 10:05.
function fechaHora(segundos) {
  const d = new Date(segundos * 1000);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

// ---------------------------------------------------------------- git: los encargos de un módulo

function raizDe(cwd) {
  return git.texto(['rev-parse', '--show-toplevel'], { cwd });
}

// Las ramas modulo/<x>--<ID> (locales y de origin), una por ID, la más nueva si están las dos. → [{ id, rama, sha }] por ID.
function ramasDeObrero(raiz, x) {
  const r = G(raiz, ['for-each-ref', '--format=%(refname)', 'refs/heads/modulo/', 'refs/remotes/origin/modulo/']);
  if (!r.ok) return [];
  const ids = new Set();
  const re = new RegExp(`^refs/(?:heads|remotes/origin)/modulo/${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--([0-9]{2})$`);
  for (const l of r.stdout.split('\n')) {
    const m = re.exec(l.trim());
    if (m) ids.add(m[1]);
  }
  const out = [];
  for (const id of [...ids].sort()) {
    const rama = `modulo/${x}--${id}`;
    let ref = E.refMasNueva(raiz, rama);
    if (!ref.ok) {
      const sha = E.shaDe(raiz, `refs/heads/${rama}`) || E.shaDe(raiz, `refs/remotes/origin/${rama}`);
      ref = { ok: !!sha, sha };
    }
    if (ref.ok && ref.sha) out.push({ id, rama, sha: ref.sha });
  }
  return out;
}

// El encargo del obrero, leído de git: { texto-leído, toca[], partida } o null si no se puede leer.
function encargoDe(raiz, x, id) {
  try {
    const n = E.nombreEncargo(`${x}--${id}`);
    if (!n) return null;
    const u = E.ubicarEncargo(raiz, n);
    if (!u.ok) return null;
    const e = E.leerEncargo(u.texto, n);
    if (e.errores.length || !e.secciones.toca) return null;
    const fecha = e.campos.partida ? Date.parse(e.campos.partida.fecha) : NaN;
    return { toca: e.secciones.toca.rutas, partida: e.campos.partida ? e.campos.partida.sha : null, partidaS: Number.isFinite(fecha) ? Math.floor(fecha / 1000) : null, madre: u.ref };
  } catch (e) {
    return null;
  }
}

// La base de los commits del obrero: el merge-base con modulo/<x> (igual que `verificar`); si la rama ya se mergeó y no queda nada
// por delante, la partida del encargo (si es antecesora de la punta). → { base, viaPartida } o null.
function baseDe(raiz, x, punta, enc) {
  try {
    const madre = E.refMasNueva(raiz, `modulo/${x}`);
    if (madre.ok && madre.sha) {
      const mb = G(raiz, ['merge-base', madre.sha, punta]);
      if (mb.ok && mb.stdout.trim() !== punta) return { base: mb.stdout.trim(), viaPartida: false };
    }
    if (enc && enc.partida) {
      const p = E.shaDe(raiz, enc.partida);
      if (p && E.esAncestro(raiz, p, punta)) return { base: p, viaPartida: true };
    }
    if (madre.ok && madre.sha) {
      const mb = G(raiz, ['merge-base', madre.sha, punta]);
      if (mb.ok) return { base: mb.stdout.trim(), viaPartida: false };
    }
  } catch (e) {
    /* sin base: queda null */
  }
  return null;
}

// Los commits del obrero, del más viejo al más nuevo: [{ sha, t (segundos), autor, asunto }]. null si no se pudo leer.
function commitsDe(raiz, base, punta) {
  const r = G(raiz, ['log', '--reverse', '--no-merges', '--format=%H%x09%ct%x09%an%x09%s', `${base}..${punta}`]);
  if (!r.ok) return null;
  return r.stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => {
      const p = l.split('\t');
      return { sha: p[0], t: Number(p[1]), autor: p[2], asunto: p.slice(3).join('\t') };
    });
}

function archivosDe(raiz, sha) {
  const r = G(raiz, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', '--root', sha]);
  return r.ok ? r.stdout.split('\0').filter(Boolean) : null;
}

// Los datos de un encargo: tiempos y desvíos. `desvios` es null si no se pudo juzgar (sin encargo commiteado o sin leer).
function datosEncargo(raiz, x, rama) {
  const enc = encargoDe(raiz, x, rama.id);
  const b = baseDe(raiz, x, rama.sha, enc);
  const base = b && b.base;
  const d = { id: rama.id, rama: rama.rama, punta: rama.sha, commits: [], primero: null, ultimo: null, minutos: 0, subpasos: 0, desvios: null, porQue: null };
  if (!base) {
    d.porQue = 'sin base común con modulo/<x>';
    return d;
  }
  let cs = commitsDe(raiz, base, rama.sha);
  if (cs && b.viaPartida) {
    // Desde la partida entran los commits del director que dejaron encargos (de este obrero o de otro): no son sub-pasos del obrero.
    const soloEncargo = new RegExp('^' + escRe(moduloRel(raiz, x)) + '/bitacora/[^/]*-encargo-[0-9]{2}\\.md$');
    cs = cs.filter((c) => {
      const f = archivosDe(raiz, c.sha);
      return !(f && f.length && f.every((r) => soloEncargo.test(r)));
    });
  }
  if (!cs) {
    d.porQue = 'no pude leer el log de la rama';
    return d;
  }
  d.commits = cs;
  d.subpasos = cs.length;
  if (cs.length) {
    d.primero = cs[0].t;
    d.ultimo = cs[cs.length - 1].t;
    // RF-fix 9: la duración arranca en la - Partida: del encargo si se lee y no es posterior al primer commit (un obrero que commitea
    // todo junto daba 0 min); si no, como antes: del primer al último commit.
    const min = Math.min(...cs.map((c) => c.t));
    const desde = enc && enc.partidaS !== null && enc.partidaS <= min ? enc.partidaS : min;
    d.minutos = Math.round((Math.max(...cs.map((c) => c.t)) - desde) / 60);
  }
  if (!enc) {
    d.porQue = 'sin encargo commiteado que se lea: los desvíos no se pueden juzgar';
    return d;
  }
  const { enToca } = require('./encargo.cjs'); // la misma regla de ## Toca que la línea 4 de `verificar`: se usa, no se reescribe
  const evidencia = new RegExp(`^${escRe(moduloRel(raiz, x))}/bitacora/[^/]+-evidencia-${rama.id}\\.md$`);
  d.desvios = [];
  for (const c of cs) {
    const archivos = archivosDe(raiz, c.sha);
    if (!archivos) {
      d.desvios = null;
      d.porQue = `no pude listar los archivos de ${c.sha.slice(0, 7)}`;
      return d;
    }
    const fuera = archivos.filter((f) => f !== frenosLog.RUTA && !evidencia.test(f) && !enc.toca.some((p) => enToca(f, p)));
    if (fuera.length) d.desvios.push({ sha: c.sha, asunto: c.asunto, fuera });
  }
  return d;
}

// Todos los encargos del módulo.
function datosModulo(raiz, x) {
  return ramasDeObrero(raiz, x).map((r) => datosEncargo(raiz, x, r));
}

// ---------------------------------------------------------------- tiempos.md

const rutaTiempos = (raiz, x) => path.join(raiz, ...moduloRel(raiz, x).split('/'), 'tiempos.md');

// Los renglones del bloque anterior: { id, celdas[] }.
function filasPrevias(texto) {
  const i = texto.indexOf(MARCA_ABRE);
  const f = texto.indexOf(MARCA_CIERRA);
  if (i < 0 || f < i) return [];
  const out = [];
  for (const l of texto.slice(i, f).split('\n')) {
    const m = /^\| (\d{2}) \|/.exec(l);
    if (m) out.push({ id: m[1], celdas: l.split('|').slice(1, -1).map((s) => s.trim()) });
  }
  return out;
}

// El bloque generado. `datos`: los encargos de ahora; las filas previas de IDs que ya no están se conservan.
function bloque(datos, previas) {
  const filas = new Map();
  for (const p of previas) filas.set(p.id, p.celdas);
  for (const d of datos) {
    if (!d.commits.length) {
      if (!filas.has(d.id)) filas.set(d.id, [d.id, '—', '—', '0', '0']);
      continue;
    }
    filas.set(d.id, [d.id, fechaHora(d.primero), fechaHora(d.ultimo), String(d.minutos), String(d.subpasos)]);
  }
  const ids = [...filas.keys()].sort();
  const lineas = [MARCA_ABRE, '| Encargo | Primer commit | Último commit | Duración (min) | Sub-pasos |', '|---|---|---|---|---|'];
  let sub = 0;
  let min = 0;
  for (const id of ids) {
    const c = filas.get(id);
    lineas.push(`| ${c.join(' | ')} |`);
    sub += Number(c[4]) || 0;
    min += Number(c[3]) || 0;
  }
  lineas.push('', `- Total: ${ids.length} encargo(s) · ${sub} sub-paso(s) · ${min} min`, MARCA_CIERRA);
  return { texto: lineas.join('\n'), encargos: ids.length, subpasos: sub, minutos: min };
}

// Pone el bloque en el archivo sin tocar el resto.
function conBloque(textoActual, x, b) {
  if (textoActual === null) {
    return `# Tiempos · ${x}\n\nLo mecánico lo escribe \`tiempos.cjs\` desde git; la estimación y el "por qué" los escribe el director, fuera del bloque.\n\n${b}\n`;
  }
  const t = textoActual.replace(/\r\n/g, '\n');
  const i = t.indexOf(MARCA_ABRE);
  const f = t.indexOf(MARCA_CIERRA);
  if (i >= 0 && f > i) return `${t.slice(0, i)}${b}${t.slice(f + MARCA_CIERRA.length)}`;
  return `${t.replace(/\n*$/, '\n')}\n${b}\n`;
}

// El total que dejó el script en tiempos.md: { encargos, subpasos, minutos } o null (sin archivo o sin bloque).
function totalGuardado(raiz, x) {
  let t;
  try {
    t = fs.readFileSync(rutaTiempos(raiz, x), 'utf8');
  } catch (e) {
    return null;
  }
  const i = t.indexOf(MARCA_ABRE);
  const m = i >= 0 ? TOTAL_RE.exec(t.slice(i)) : null;
  return m ? { encargos: Number(m[1]), subpasos: Number(m[2]), minutos: Number(m[3]) } : null;
}

function cmdTiempos(raiz, x, ver) {
  const datos = datosModulo(raiz, x);
  const rel = moduloRel(raiz, x);
  const carpeta = path.join(raiz, ...rel.split('/'));
  let actual = null;
  try {
    actual = fs.readFileSync(rutaTiempos(raiz, x), 'utf8').replace(/\r\n/g, '\n');
  } catch (e) {
    /* sin archivo todavía */
  }
  const b = bloque(datos, actual ? filasPrevias(actual) : []);
  const lineas = [];
  for (const d of datos) {
    lineas.push(
      d.commits.length
        ? `  ${d.id} · ${fechaHora(d.primero)} → ${fechaHora(d.ultimo)} · ${d.minutos} min · ${d.subpasos} sub-paso(s)`
        : `  ${d.id} · sin commits propios${d.porQue ? ` (${d.porQue})` : ''}`,
    );
  }
  if (ver) return { codigo: 0, lineas: [`tiempos ${x}: ${b.encargos} encargo(s) · ${b.subpasos} sub-paso(s) · ${b.minutos} min (sin escribir)`, ...lineas] };
  if (!fs.existsSync(carpeta)) return { codigo: 1, lineas: [`tiempos ${x}: no hay ${rel}/ (el módulo nace con el Arquitecto); no escribí nada`, ...lineas] };
  fs.writeFileSync(rutaTiempos(raiz, x), conBloque(actual, x, b.texto), 'utf8');
  return { codigo: 0, lineas: [`tiempos ${x}: ${b.encargos} encargo(s) · ${b.subpasos} sub-paso(s) · ${b.minutos} min · escrito ${rel}/tiempos.md`, ...lineas] };
}

function cmdContador(raiz, x) {
  const datos = datosModulo(raiz, x);
  let sub = 0;
  let desv = 0;
  let sinJuzgar = 0;
  const det = [];
  for (const d of datos) {
    sub += d.subpasos;
    if (d.desvios === null) {
      sinJuzgar++;
      det.push(`  ${d.id} · ${d.subpasos} sub-paso(s) · desvíos NO VERIFICADO (${d.porQue || 'sin datos'})`);
    } else {
      desv += d.desvios.length;
      det.push(`  ${d.id} · ${d.subpasos} sub-paso(s) · ${d.desvios.length} desvío(s)`);
      for (const v of d.desvios) det.push(`    - ${v.sha.slice(0, 7)} fuera de ## Toca: ${v.fuera.slice(0, 5).join(', ')}${v.fuera.length > 5 ? ' …' : ''}`);
    }
  }
  const nv = sinJuzgar ? ` · ${sinJuzgar} encargo(s) sin juzgar (NO VERIFICADO)` : '';
  return { codigo: 0, lineas: [`contador ${x}: ${datos.length} encargo(s) · ${sub} sub-paso(s) · ${desv} desvío(s)${nv}`, ...det] };
}

// ---------------------------------------------------------------- alarma

// ¿El texto lo inyectó un hook, un comando o el sistema, y no lo escribió Guido?
function esInyectado(t) {
  if (/^<(command-name|command-message|command-args|local-command-[a-z-]+|system-reminder|user-prompt-submit-hook|task-notification|bash-input|bash-stdout|bash-stderr)\b/.test(t)) return true;
  if (/^\[Request interrupted by user/.test(t) || /^Caveat: /.test(t) || /^This session is being continued from/.test(t)) return true;
  return /^<([a-z][\w-]*)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(t); // un bloque etiquetado entero: lo puso una herramienta
}

// contarIntervenciones(textoJsonl) → n: los mensajes de usuario reales.
function contarIntervenciones(textoJsonl) {
  let n = 0;
  for (const l of String(textoJsonl).split('\n')) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch (e) {
      continue;
    }
    if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) continue;
    const c = o.message && o.message.content;
    let texto = '';
    if (typeof c === 'string') texto = c;
    else if (Array.isArray(c)) texto = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    texto = texto.trim();
    if (!texto || esInyectado(texto)) continue;
    n++;
  }
  return n;
}

// La carpeta de transcripts de una carpeta de trabajo: cada carácter que no es letra ni número, un guion.
function carpetaTranscripts(cwd, home) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(home || os.homedir(), '.claude');
  return path.join(base, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

function transcriptMasNuevo(cwd, home) {
  const dir = carpetaTranscripts(cwd, home);
  let nombres;
  try {
    nombres = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch (e) {
    return null;
  }
  let mejor = null;
  for (const n of nombres) {
    const t = fs.statSync(path.join(dir, n)).mtimeMs;
    if (!mejor || t > mejor.t) mejor = { ruta: path.join(dir, n), t };
  }
  return mejor ? mejor.ruta : null;
}

function cmdAlarma(cwd, transcript, home) {
  const ruta = transcript || transcriptMasNuevo(cwd, home);
  if (!ruta) return { codigo: 0, lineas: ['alarma: NO VERIFICADO · no encuentro el transcript de esta pestaña (pasalo con --transcript <ruta>)'] };
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    return { codigo: 0, lineas: [`alarma: NO VERIFICADO · no pude leer ${ruta}`] };
  }
  const n = contarIntervenciones(texto);
  if (n > UMBRAL_ALARMA) return { codigo: 1, lineas: [`ALARMA · ${n} intervenciones de Guido en esta pestaña: anotalo en las notas del CIERRE`] };
  return { codigo: 0, lineas: [`alarma: ${n} intervención(es) de Guido en esta pestaña (tope ${UMBRAL_ALARMA})`] };
}

// ---------------------------------------------------------------- principal

function leerArgumentos(argv) {
  const [comando, ...resto] = argv;
  if (!comando) malLlamado('Falta el comando.');
  if (!['tiempos', 'alarma', 'contador'].includes(comando)) malLlamado(`Comando desconocido: ${comando}`);
  const a = { comando, x: null, ver: false, transcript: null };
  for (let i = 0; i < resto.length; i++) {
    const v = resto[i];
    if (v === '--ver' && comando === 'tiempos') a.ver = true;
    else if (v === '--transcript' && comando === 'alarma') {
      if (!resto[i + 1] || resto[i + 1].startsWith('--')) malLlamado('--transcript pide la ruta del .jsonl.');
      a.transcript = resto[++i];
    } else if (!v.startsWith('-') && comando !== 'alarma' && !a.x) a.x = v;
    else malLlamado(`Argumento desconocido: ${v}`);
  }
  if (comando !== 'alarma') {
    if (!a.x) malLlamado(`${comando} pide el módulo: ${comando} <x>.`);
    if (!E.RE_X.test(a.x)) malLlamado(`"${a.x}" no es un nombre de módulo.`);
  }
  return a;
}

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  const cwd = opciones.cwd || process.cwd();
  let a;
  try {
    a = leerArgumentos(argv);
  } catch (e) {
    if (!(e instanceof MalLlamado)) throw e;
    error(`${e.message}\n${USO}\n`);
    return 2;
  }
  let r;
  if (a.comando === 'alarma') r = cmdAlarma(cwd, a.transcript, opciones.home);
  else {
    const raiz = raizDe(cwd);
    if (!raiz) {
      error('No estoy dentro de un repo git.\n');
      return 2;
    }
    r = a.comando === 'tiempos' ? cmdTiempos(raiz, a.x, a.ver) : cmdContador(raiz, a.x);
  }
  salida(`${r.lineas.join('\n')}\n`);
  return r.codigo;
}

if (require.main === module) {
  let codigo = 2;
  try {
    codigo = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`tiempos roto: ${e && e.message}\n`);
    if (process.argv[2] === 'contador') codigo = 0; // el contador nunca frena
  }
  process.exitCode = codigo;
}

module.exports = {
  USO, UMBRAL_ALARMA, MARCA_ABRE, MARCA_CIERRA, raizDe, ramasDeObrero, datosEncargo, datosModulo, bloque, conBloque, filasPrevias,
  totalGuardado, contarIntervenciones, carpetaTranscripts, transcriptMasNuevo, fechaHora, main,
};
