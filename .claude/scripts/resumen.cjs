'use strict';
// resumen.cjs — el resumen del día (SPEC-0 5.3ter; C §2.1, §3bis; RF-4). Uso, desde el checkout principal:
//   node .claude/scripts/resumen.cjs [<x>] [--forzar]
// Lo arma el script, no la cabeza de nadie. Con un módulo con director (`director: sí` en su ficha) lo escribe en
// docs/modulos/<x>/bitacora/<fecha>-resumen.md; sin director (o sin nombre) imprime el bloque para la entrada del CHANGELOG, que
// pega /cierre: este script no toca el CHANGELOG. Secciones fijas: qué se hizo · qué sigue · qué te espera · qué está trabado · los
// `aprobado` nuevos del día (de git: los commits "cambios: aprobado <id>" de hoy, con quién los corrió) · hablado con otros
// directores (de mesa.cjs acordados; "— (sin mesa todavía)" si no hay mesa) · lo que medimos y aprendimos · lo que el método atajó
// hoy, en números (los renglones de hoy de .claude/frenos.log, por tipo). "Se muestra una vez": si el de hoy ya existe (el archivo,
// o la marca .git/kit-resumen-del-dia cuando no hay archivo) no lo pisa, dice dónde está y sale 0; --forzar lo rehace.
// docs/ es la carpeta de papeles: la `carpeta-docs:` de la ficha vigente si la hay (SPEC-paquete-8r3 i1; lib/docs-ruta.cjs).
// Salidas: 0 anduvo (o ya estaba) · 1 el módulo no existe · 2 mal llamado. Node estándar, cero dependencias.
// Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const git = require('../hooks/lib/git.cjs');
const E = require('../hooks/lib/encargo.cjs');
const frenosLog = require('../hooks/lib/frenos-log.cjs');
const T = require('./tiempos.cjs');
const S = require('./estado.cjs');

const USO = [
  'Uso: node .claude/scripts/resumen.cjs [<x>] [--forzar]   (desde el checkout principal)',
  '  <x>        con director: escribe docs/modulos/<x>/bitacora/<fecha>-resumen.md y lo muestra; sin director: imprime el bloque del CHANGELOG',
  '  (sin <x>)  imprime el bloque para la entrada del CHANGELOG de hoy (no lo edita: lo pega /cierre)',
  '  --forzar   rehace el de hoy aunque ya exista (sin él, "se muestra una vez": dice dónde está y sale 0)',
  '  --ayuda    este texto',
  '  (docs/ es la carpeta de papeles: la carpeta-docs: de la ficha si la hay)',
].join('\n');

const MARCA = 'kit-resumen-del-dia'; // dentro de la carpeta común de git: no viaja y no ensucia el árbol
function rutaMarca(raiz) {
  const c = git.texto(['rev-parse', '--git-common-dir'], { cwd: raiz });
  return c ? path.resolve(raiz, c, MARCA) : null;
}
const T_GIT = 60000;
const G = (cwd, args) => git.correr(args, { cwd, tiempo: T_GIT });
const dos = (n) => String(n).padStart(2, '0');
const hoyDe = S.hoyDe;
const diaDe = (segundos) => hoyDe(new Date(segundos * 1000));

const rutaResumen = (raiz, x, fecha) => path.join(raiz, ...S.papeles(raiz, `modulos/${x}/bitacora/${fecha}-resumen.md`).split('/'));
function yaMostrado(raiz, fecha) {
  try {
    return fs.readFileSync(rutaMarca(raiz), 'utf8').trim() === fecha;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- las partes

// Qué se hizo: los commits de hoy (con módulo: modulo/<x> y sus obreros; sin módulo: la rama actual).
// RF-fix 6: `--branches=modulo/<x>` no agarra refs/heads/modulo/<x> (sin comodín, git lo lee como modulo/<x>/*): la rama del director
// va explícita (si existe), y los obreros, locales y los que solo están en origin.
function queSeHizo(raiz, x, fecha) {
  const args = ['log', '--no-merges', `--since=${fecha}T00:00:00`, '--format=%h %s', '-n', '60'];
  if (x) {
    if (G(raiz, ['rev-parse', '--verify', '-q', `refs/heads/modulo/${x}^{commit}`]).ok) args.push(`refs/heads/modulo/${x}`);
    args.push(`--branches=modulo/${x}--*`, `--remotes=origin/modulo/${x}--*`);
  } else args.push('HEAD');
  const r = G(raiz, args);
  if (!r.ok) return ['— (NO VERIFICADO: no pude leer el log de git)'];
  const ls = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return ls.length ? [`${ls.length} commit(s) hoy:`, ...ls.map((l) => `- ${l}`)] : ['- ningún commit hoy'];
}

function todoAbiertos(raiz, n) {
  try {
    return fs
      .readFileSync(path.join(raiz, ...S.papeles(raiz, 'TODO.md').split('/')), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => /^- \[ \] /.test(l))
      .slice(0, n)
      .map((l) => `- ${l.replace(/^- \[ \] /, '').trim()}`);
  } catch (e) {
    return [];
  }
}

function queSigue(raiz, m) {
  if (m) {
    const f = m.ficha;
    const fase = S.seccion(f, /^Fase/i).map((l) => l.trim()).filter(Boolean);
    const pend = S.seccion(f, /^Tareas/i).filter((l) => /^- \[ \]/.test(l)).slice(0, 5).map((l) => `- ${l.replace(/^- \[ \] ?/, '').trim()}`);
    const out = [...fase.map((l) => (l.startsWith('- ') ? l : `- ${l}`)), ...pend];
    if (out.length) return out;
  }
  const t = todoAbiertos(raiz, 5);
  return t.length ? t : ['- —'];
}

// Los cambios `propuesto` de clase 3 (lo que lista cambios.cjs listar --te-espera), si el script está.
function cambiosPropuestos(raiz, opciones) {
  const script = opciones.cambios || path.join(__dirname, 'cambios.cjs');
  if (!fs.existsSync(script)) return [];
  const r = spawnSync(process.execPath, [script, 'listar', '--te-espera'], { cwd: raiz, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.status === 0 ? (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map((l) => `- cambio propuesto: ${l}`) : [];
}

function queTeEspera(raiz, ms, opciones) {
  const out = [];
  for (const m of ms) for (const t of S.bullets(S.seccion(m.ficha, /te espera/i))) out.push(`- [${m.x}] ${t}`);
  out.push(...cambiosPropuestos(raiz, opciones));
  return out.length ? out : ['- nada'];
}

function queTrabado(raiz, ms, fecha) {
  const out = [];
  for (const m of ms) for (const t of S.bullets(S.seccion(m.ficha, /^(Parado|Trabado)/i))) out.push(`- [${m.x}] ${t}`);
  for (const v of S.esperasVencidas(raiz, fecha)) out.push(`- TODO: ${v.texto} · espera vencida (hasta ${v.fecha})`);
  return out.length ? out : ['- nada'];
}

// Los `aprobado` de hoy: [{ id, sha, hora, autor, rol, rama, refs, sello }]. Salen de los commits "cambios: aprobado <id>".
function aprobadosDelDia(raiz, fecha) {
  const r = G(raiz, ['log', '--all', '--extended-regexp', '--grep=^cambios: aprobado ', '--format=%H%x09%ct%x09%an%x09%s']);
  if (!r.ok) return null;
  let sellos = new Map();
  try {
    const C = require('../hooks/lib/cambios.cjs');
    for (const a of C.listarArchivos(raiz)) {
      const c = a.id ? C.cargar(a) : null;
      if (c && !c.error && c.datos && c.datos.aprobo) sellos.set(a.id, c.datos.aprobo);
    }
  } catch (e) {
    sellos = new Map();
  }
  const out = [];
  for (const l of r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const p = l.split('\t');
    const ct = Number(p[1]);
    const m = /^cambios: aprobado (\S+)/.exec(p.slice(3).join('\t'));
    if (!m || !Number.isFinite(ct) || diaDe(ct) !== fecha) continue;
    const d = new Date(ct * 1000);
    const o = { id: m[1], sha: p[0].slice(0, 7), hora: `${dos(d.getHours())}:${dos(d.getMinutes())}`, autor: p[2], rol: null, rama: null, refs: '', sello: sellos.get(m[1]) || null };
    const fl = G(raiz, ['show', '-U0', '--format=', p[0], '--', frenosLog.RUTA]);
    if (fl.ok) {
      const add = fl.stdout.split('\n').find((x) => x.startsWith('+') && x.includes(' · cambios:aprobar · '));
      if (add) {
        const f = add.slice(1).split(' · ');
        o.rol = f[1];
        o.rama = f[2];
      }
    }
    const rf = G(raiz, ['for-each-ref', '--contains', p[0], '--format=%(refname:short)']);
    if (rf.ok) o.refs = rf.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(', ');
    out.push(o);
  }
  return out.reverse();
}

function lineasAprobados(raiz, fecha) {
  const a = aprobadosDelDia(raiz, fecha);
  if (a === null) return ['- NO VERIFICADO: no pude leer el log de git'];
  if (!a.length) return ['- ningún `aprobado` nuevo hoy'];
  return a.map((o) => {
    const quien = [`autor ${o.autor}`, o.rol ? `rol ${o.rol}` : null, o.rama ? `rama ${o.rama}` : null, o.sello ? `sesión ${o.sello.sesion} · carpeta ${o.sello.carpeta}` : null].filter(Boolean).join(' · ');
    return `- ${o.id} · commit ${o.sha} · ${o.hora} · ${quien}${o.refs ? ` · en ${o.refs}` : ''}`;
  });
}

function hablado(raiz, opciones) {
  const script = opciones.mesa || path.join(__dirname, 'mesa.cjs');
  if (!fs.existsSync(script)) return ['— (sin mesa todavía)'];
  const r = spawnSync(process.execPath, [script, 'acordados'], { cwd: raiz, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const ls = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (r.status !== 0 || !ls.length) return ['— (la mesa no trajo acordados)'];
  return ls.slice(0, 15).map((l) => (l.startsWith('- ') ? l : `- ${l}`));
}

function medimos(raiz, m) {
  if (!m || !m.conDirector) return ['— (sin mediciones: el módulo no tiene director)'];
  const g = T.totalGuardado(raiz, m.x);
  const enc = S.encargosDe(raiz, m.x);
  const desv = enc.filas.reduce((a, f) => a + (f.desvios ? f.desvios.length : 0), 0);
  const sin = enc.filas.filter((f) => f.desvios === null).length;
  return [
    g ? `- tiempos.md: ${g.encargos} encargo(s) · ${g.subpasos} sub-paso(s) · ${g.minutos} min` : '- tiempos.md: — (todavía no se generó)',
    `- desvíos: ${desv} en ${enc.filas.length} encargo(s)${sin ? ` (${sin} sin juzgar: NO VERIFICADO)` : ''}`,
  ];
}

// Los frenos de hoy por tipo (el id de cada renglón de frenos.log), sin el renglón de los `aprobar`, que no es un freno.
function frenosDelDia(raiz, fecha) {
  let t;
  try {
    t = fs.readFileSync(frenosLog.rutaAbsoluta(raiz), 'utf8');
  } catch (e) {
    return ['— (sin frenos.log)'];
  }
  const cuenta = new Map();
  for (const l of t.replace(/\r\n/g, '\n').split('\n')) {
    if (!l.startsWith(`${fecha}T`)) continue;
    const id = (l.split(frenosLog.SEP)[3] || '(sin id)').trim();
    if (id === 'cambios:aprobar') continue;
    cuenta.set(id, (cuenta.get(id) || 0) + 1);
  }
  const total = [...cuenta.values()].reduce((a, b) => a + b, 0);
  if (!total) return ['- 0 frenos hoy'];
  return [`- total: ${total} freno(s)`, ...[...cuenta.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, n]) => `- ${id}: ${n}`)];
}

// ---------------------------------------------------------------- armado

function armar(raiz, x, m, fecha, opciones) {
  const act = m ? [m] : S.fichas(raiz).filter((f) => S.activo(f.ficha));
  const L = [`# Resumen del día · ${fecha}${x ? ` · ${x}` : ''}`];
  const sec = (titulo, lineas) => L.push('', `## ${titulo}`, ...lineas);
  sec('Qué se hizo', queSeHizo(raiz, x, fecha));
  sec('Qué sigue', queSigue(raiz, m));
  sec('Qué te espera', queTeEspera(raiz, act, opciones));
  sec('Qué está trabado', queTrabado(raiz, act, fecha));
  sec('`aprobado` nuevos de hoy (quién los corrió)', lineasAprobados(raiz, fecha));
  sec('Hablado con otros directores', hablado(raiz, opciones));
  sec('Lo que medimos y aprendimos', medimos(raiz, m));
  sec('Lo que el método atajó hoy, en números', frenosDelDia(raiz, fecha));
  return `${L.join('\n')}\n`;
}

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  const cwd = opciones.cwd || process.cwd();
  const ahora = opciones.ahora || new Date();
  let x = null;
  let forzar = false;
  if (argv[0] === '--ayuda' || argv[0] === '-h') {
    salida(`${USO}
`);
    return 0;
  }
  for (const v of argv) {
    if (v === '--forzar') forzar = true;
    else if (!v.startsWith('-') && !x && E.RE_X.test(v)) x = v;
    else {
      error(`Argumento no válido: ${v}\n${USO}\n`);
      return 2;
    }
  }
  const raiz = T.raizDe(cwd);
  if (!raiz) {
    error(`No estoy dentro de un repo git.\n${USO}\n`);
    return 2;
  }
  const fecha = hoyDe(ahora);
  let m = null;
  if (x) {
    m = S.fichas(raiz).find((f) => f.x === x) || null;
    if (!m) {
      salida(`resumen: no hay ficha de "${x}" (${S.papeles(raiz, `modulos/${x}/README.md`)})\n`);
      return 1;
    }
  }
  const conArchivo = !!(m && m.conDirector);
  if (conArchivo) {
    const ruta = rutaResumen(raiz, x, fecha);
    if (fs.existsSync(ruta) && !forzar) {
      salida(`resumen de hoy ya existe: ${path.relative(raiz, ruta).replace(/\\/g, '/')} (se muestra una vez; --forzar lo rehace)\n`);
      return 0;
    }
    const texto = armar(raiz, x, m, fecha, opciones);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, texto, 'utf8');
    salida(`${texto}\nresumen escrito: ${path.relative(raiz, ruta).replace(/\\/g, '/')}\n`);
    return 0;
  }
  if (yaMostrado(raiz, fecha) && !forzar) {
    salida(`resumen de hoy ya mostrado (marca ${MARCA} en .git; se muestra una vez; --forzar lo arma de nuevo para pegarlo en el CHANGELOG)\n`);
    return 0;
  }
  const texto = armar(raiz, x, m, fecha, opciones);
  try {
    fs.writeFileSync(rutaMarca(raiz), `${fecha}\n`, 'utf8');
  } catch (e) {
    /* sin la marca, el resumen se vería más de una vez: no es un freno */
  }
  salida(texto);
  return 0;
}

if (require.main === module) {
  let codigo = 2;
  try {
    codigo = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`resumen roto: ${e && e.message}\n`);
  }
  process.exitCode = codigo;
}

module.exports = { USO, MARCA, rutaResumen, yaMostrado, aprobadosDelDia, frenosDelDia, armar, main };
