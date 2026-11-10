'use strict';
// noche.cjs — "me voy", el checklist de la noche y el despertador (SPEC-0 RF-11 y P6.4; delta 5 crit. 16, D5-12, D5-16; D §9.3-§9.5,
// §11). Uso, desde el repo:
//   node .claude/scripts/noche.cjs me-voy [--hasta HH:MM]
//   node .claude/scripts/noche.cjs volvi
//   node .claude/scripts/noche.cjs despertador [--modulo <x>] [--cada <seg>] [--una-vez]
// `me-voy` corre en el worktree del director (rama modulo/<x>): escribe la marca .kit-noche en su raíz (desde ese momento los hooks,
// el pre-commit, `db migrar` y `verificar` tratan como nocturno al director y a sus obreros: contexto.deNoche) e imprime el checklist
// armado por script, sin preguntar nada: encargos abiertos y su obrero, cuáles abre Guido (esos paran de noche), la red, lo que vence
// y el contexto del director (≥ 40 %: "mudate antes de irte", D §11). `volvi` borra la marca de este checkout y de todos los
// worktrees del repo (lo llaman /inicio y /estado de Guido SIEMPRE, en el principal: la marca vive en el worktree del director;
// sin marca dice "ya era de día" y sale 0). `--hasta` es informativo (queda en la marca y en el checklist; no lo lee nadie): la noche
// termina con `volvi`. `despertador` mira git — las ramas modulo/<x>--<ID> de SU módulo, locales y de origin (tras `fetch --prune`),
// y la rama por defecto local y de origin (CM-79: un commit en main también despierta) — contra la foto anterior de ese módulo
// (`<git-dir común>/kit-despertador-<x>.json`, sin versionar; una por módulo, RF-fix 3: con una sola, la vuelta de un director se
// comía lo que tenía que ver otro) y SOLO imprime cuando algo cambió: `DESPERTAR · <motivo> · <rama>@<sha7>`. El <x> sale de la rama
// del director (modulo/<x>) o de --modulo <x>. `me-voy` saca la foto de su módulo de nuevo: la primera vuelta de la noche no
// despierta por lo que pasó de día. Motivos: `PARADA` (la punta de la rama del obrero trae su evidencia empezando con "PARADA:",
// NUCLEO §8), `commit`, `commit en <defecto>` y `sin red` (una vez, cuando el fetch empieza a fallar). La PARADA de `presentar` no commitea (NUCLEO §8): esa no deja rastro en git y el despertador no la ve.
// Cómo despierta de verdad al director (Monitor de Claude Code, tarea programada): NO VERIFICADO, piloto.
// Salidas: 0 anduvo · 1 negado (una línea con qué hacer) · 2 mal llamado. Node estándar, cero dependencias. Es .cjs a propósito.

const fs = require('fs');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/noche.cjs <comando> …   (desde el repo)',
  '  me-voy [--hasta HH:MM]                    desde el worktree del director: escribe .kit-noche, saca la foto del despertador e imprime el checklist',
  '                                            (--hasta es informativo: la noche termina con volvi)',
  '  volvi                                     borra .kit-noche (de este checkout y de los worktrees del repo)',
  '  despertador [--modulo <x>] [--cada <seg>] [--una-vez]   "DESPERTAR · <motivo> · <rama>@<sha7>" solo si hay commit nuevo o PARADA',
  '                                            (una foto por módulo; <x>: la rama del director o --modulo)',
  '  (el despertador va en un Monitor de Claude Code o en una tarea fuera del director; cómo despierta al director: NO VERIFICADO)',
].join('\n');

const ARCHIVO_NOCHE = '.kit-noche';
// Una foto por módulo (RF-fix 3): con una sola para todos, la vuelta de un director se comía los cambios que tenía que ver otro.
const fotoDe = (x) => `kit-despertador-${x}.json`;
const RE_X = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UMBRAL_MUDANZA = 40; // % de la ventana del director: más que esto, se muda antes de irse (D §9.5, §11)
const CADA_DEFECTO = 300;
const CADA_MINIMO = 10;
const T_RED = 15000; // ls-remote y fetch: un plazo corto, sin red no se cuelga
const RE_OBRERO = /^modulo\/([a-z0-9]+(?:-[a-z0-9]+)*)--([0-9]{2})$/;

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

function libs() {
  return {
    contexto: require('../hooks/lib/contexto.cjs'),
    git: require('../hooks/lib/git.cjs'),
    E: require('../hooks/lib/encargo.cjs'),
    uso: require('./contexto.cjs'),
    docs: require('../hooks/lib/docs-ruta.cjs'), // 8r3 i1: la carpeta de papeles (docs sin la clave)
  };
}

// ---------------------------------------------------------------- argumentos

function leerArgumentos(argv) {
  const comando = argv[0];
  if (!['me-voy', 'volvi', 'despertador'].includes(comando)) malLlamado(comando ? `no conozco "${String(comando).slice(0, 40)}"` : 'falta el comando');
  const a = { comando, hasta: null, cada: CADA_DEFECTO, unaVez: false, modulo: null };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (comando === 'me-voy' && x === '--hasta') {
      const v = argv[++i];
      if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v || '')) malLlamado(`--hasta pide una hora HH:MM (00:00 a 23:59): "${v || ''}"`);
      a.hasta = v;
    } else if (comando === 'despertador' && x === '--cada') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < CADA_MINIMO) malLlamado(`--cada pide segundos, ${CADA_MINIMO} o más`);
      a.cada = v;
    } else if (comando === 'despertador' && x === '--una-vez') a.unaVez = true;
    else if (comando === 'despertador' && x === '--modulo') {
      const v = argv[++i];
      if (!RE_X.test(v || '') || v.length > 20) malLlamado(`--modulo pide un módulo (minúsculas, números y guiones simples): "${v || ''}"`);
      a.modulo = v;
    }
    else malLlamado(`${comando} no lleva "${String(x).slice(0, 40)}"`);
  }
  return a;
}

// ---------------------------------------------------------------- ayudantes de git

const G = (L, cwd, args, tiempo) => L.git.correr(args, { cwd, tiempo: tiempo || 60000 });
const sha7 = (s) => (s ? s.slice(0, 7) : '-------');
const dos = (n) => String(n).padStart(2, '0');
function isoLocal(d) {
  const z = -d.getTimezoneOffset();
  const s = z >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}${s}${dos(Math.floor(Math.abs(z) / 60))}:${dos(Math.abs(z) % 60)}`;
}
function hace(segundos, ahora) {
  const m = Math.max(0, Math.round((ahora.getTime() / 1000 - segundos) / 60));
  if (m < 60) return `hace ${m} min`;
  if (m < 48 * 60) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} días`;
}

// La bitácora del módulo, en la carpeta de papeles (8r3 i1): docs/modulos/<x>/bitacora sin la clave.
const bitacoraDe = (L, cwd, x) => L.docs.rel(L.docs.deRaiz(cwd), `modulos/${x}/bitacora`);

// La evidencia del encargo en un commit: el texto de docs/modulos/<x>/bitacora/*-evidencia-<ID>.md, o null.
function evidenciaEn(L, cwd, sha, x, id) {
  const dir = bitacoraDe(L, cwd, x);
  const r = G(L, cwd, ['ls-tree', '-z', '--name-only', sha, '--', `${dir}/`]);
  if (!r.ok) return null;
  const ruta = r.stdout.split('\0').find((p) => path.posix.dirname(p) === dir && new RegExp(`^.+-evidencia-${id}\\.md$`).test(path.posix.basename(p)));
  if (!ruta) return null;
  const t = G(L, cwd, ['show', `${sha}:${ruta}`]);
  return t.ok ? t.stdout : null;
}
// "PARADA: <por qué>" si la evidencia arranca así (NUCLEO §8); null si no.
function paradaDe(texto) {
  if (texto === null) return null;
  const l = texto.replace(/^﻿/, '').split(/\r?\n/).find((s) => s.trim() !== '');
  return l && /^PARADA:/.test(l.trim()) ? l.trim() : null;
}

// ---------------------------------------------------------------- me-voy

function encargosAbiertos(L, raiz, x, ahora) {
  const dir = bitacoraDe(L, raiz, x);
  const r = G(L, raiz, ['ls-tree', '-z', '--name-only', 'HEAD', '--', `${dir}/`]);
  if (!r.ok) return [];
  const ids = [];
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    const m = /^.+-encargo-([0-9]{2})\.md$/.exec(path.posix.basename(p));
    if (m && path.posix.dirname(p) === dir && !ids.some((e) => e.id === m[1])) ids.push({ id: m[1], ruta: p });
  }
  const abiertos = [];
  for (const { id, ruta } of ids) {
    // Cerrado = su evidencia ya está en la rama del director (el CIERRE se mergeó) y no es una PARADA.
    const ev = evidenciaEn(L, raiz, 'HEAD', x, id);
    if (ev !== null && !paradaDe(ev)) continue;
    const rama = `modulo/${x}--${id}`;
    const local = L.E.shaDe(raiz, `refs/heads/${rama}`);
    const remoto = L.E.shaDe(raiz, `refs/remotes/origin/${rama}`);
    const punta = local || remoto;
    const t = G(L, raiz, ['show', `HEAD:${ruta}`]);
    const e = t.ok ? L.E.leerEncargo(t.stdout) : null;
    const apertura = e && e.campos.apertura ? e.campos.apertura : '?';
    const recursos = e && e.secciones && e.secciones.toca ? e.secciones.toca.recursos : [];
    let obrero = 'sin rama: el obrero no arrancó';
    let parada = null;
    if (punta) {
      const lg = G(L, raiz, ['log', '-1', '--format=%ct%x09%s', punta]);
      const [ct, ...asunto] = lg.ok ? lg.stdout.trim().split('\t') : ['', ''];
      obrero = `${rama}@${sha7(punta)}${local && remoto && local !== remoto ? ' (local y origin distintas)' : !remoto ? ' (sin subir)' : ''}` +
        (ct ? ` · ${hace(Number(ct), ahora)}: ${asunto.join('\t').slice(0, 80)}` : '');
      parada = paradaDe(evidenciaEn(L, raiz, punta, x, id));
    }
    abiertos.push({ id, apertura, recursos, obrero, parada });
  }
  return abiertos;
}

function meVoy(L, g, a, o) {
  const rama = L.contexto.rama(g.raiz);
  const p = L.contexto.pestana(rama);
  if (p.tipo !== 'director') {
    return { codigo: 1, lineas: [`me-voy corre desde el worktree del director (rama modulo/<x>) y acá la rama es ${rama || '(ninguna)'}: abrí la pestaña del director y corrélo ahí`] };
  }
  const ahora = o.ahora instanceof Date ? o.ahora : new Date();
  const lineas = [];
  fs.writeFileSync(path.join(g.raiz, ARCHIVO_NOCHE), `desde ${isoLocal(ahora)}\nhasta ${a.hasta || '—'}\n`);
  lineas.push(`noche: ${ARCHIVO_NOCHE} escrita en el worktree del director de ${p.modulo} (desde ${isoLocal(ahora)}${a.hasta ? `, hasta ${a.hasta}` : ''}): el director y sus obreros quedan nocturnos hasta "volvi"`);
  if (G(L, g.raiz, ['check-ignore', '-q', '--', ARCHIVO_NOCHE]).codigo !== 0) {
    lineas.push(`⚠️ ${ARCHIVO_NOCHE} no está ignorado: pegá en el .gitignore del principal el gitignore.snippet del kit ENTERO y commitealo`);
  }
  // 1. los encargos abiertos y su obrero
  const abiertos = encargosAbiertos(L, g.raiz, p.modulo, ahora);
  if (!abiertos.length) lineas.push('encargos abiertos: ninguno (nada queda andando de noche)');
  for (const e of abiertos) {
    const para = e.apertura === 'director' ? '' : ` · ⚠️ Apertura: ${e.apertura} — de noche para (no lo abre el director)`;
    lineas.push(`encargo ${e.id} · ${e.obrero}${e.parada ? ` · ${e.parada}` : ''}${para}`);
  }
  // 2. la red: sin red no trabaja nadie y el despertador no ve nada (D §9.5, CM-86)
  const remotos = (L.git.texto(['remote'], { cwd: g.raiz }) || '').split('\n').map((s) => s.trim());
  if (!remotos.includes('origin')) lineas.push('red: sin remoto origin — nadie ve los commits de la noche desde otra PC');
  else {
    const r = G(L, g.raiz, ['ls-remote', '--heads', 'origin'], T_RED);
    lineas.push(r.ok ? 'red: origin responde' : `red: ❌ origin no responde (${r.error || (r.stderr || '').trim().split('\n')[0].slice(0, 80) || `salió ${r.codigo}`}) — sin red no trabaja nadie y el despertador no ve nada: arreglalo antes de irte`);
  }
  // 3. lo que vence: el script no lo sabe; los recursos de los encargos abiertos sí
  const recursos = [...new Set(abiertos.flatMap((e) => e.recursos))];
  lineas.push(`vence: VPN, credenciales y dispositivos no los ve el script: miralos vos${recursos.length ? ` (los encargos abiertos usan: ${recursos.join(', ')})` : ''}`);
  lineas.push('permisos: lo que no esté en el AUTORIZADO del encargo, de noche es PARADA (predecirlo: NO VERIFICADO)');
  // 4. el contexto del director (D §11): ≥ 40 %, mudate antes de irte
  const m = L.uso.medir({ cwd: g.raiz, env: o.env });
  if (!m.ok) lineas.push(`${L.uso.linea(m)} — medilo antes de irte`);
  else lineas.push(`${L.uso.linea(m)}${m.pct >= UMBRAL_MUDANZA ? ` — pasa del ${UMBRAL_MUDANZA}%: mudate antes de irte` : ''}`);
  // 5. la foto del despertador de este módulo, de nuevo: la primera vuelta de la noche compara contra el "me voy", no contra el día.
  guardarFoto(path.join(g.gitComun, fotoDe(p.modulo)), fotoDeAhora(L, g, p.modulo));
  lineas.push(`despertador: node .claude/scripts/noche.cjs despertador --modulo ${p.modulo} --cada 300 (en un Monitor o una tarea fuera del director: con --modulo corre desde cualquier checkout)`);
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- volvi

function volvi(L, g) {
  const carpetas = [g.raiz];
  const lista = L.contexto.worktrees(g.raiz) || [];
  for (const w of lista) if (!carpetas.some((c) => path.resolve(c).toLowerCase() === w.ruta.toLowerCase())) carpetas.push(w.ruta);
  const borradas = [];
  for (const c of carpetas) {
    const p = path.join(c, ARCHIVO_NOCHE);
    if (!fs.existsSync(p)) continue;
    fs.rmSync(p, { force: true, recursive: true });
    const w = lista.find((x) => x.ruta.toLowerCase() === path.resolve(c).toLowerCase());
    borradas.push(w && w.rama ? w.rama : c);
  }
  if (!borradas.length) return { codigo: 0, lineas: ['volví: no había ninguna .kit-noche (ya era de día)'] };
  return { codigo: 0, lineas: [`volví: borré ${ARCHIVO_NOCHE} de ${borradas.join(', ')} — de día otra vez`] };
}

// ---------------------------------------------------------------- despertador

// La foto de ahora: { refs: { 'refs/...': sha }, red: true|false|null }.
function fotoDeAhora(L, g, x) {
  const def = L.contexto.ramaPorDefecto(g.raiz);
  let red = null;
  if ((L.git.texto(['remote'], { cwd: g.raiz }) || '').split('\n').map((s) => s.trim()).includes('origin')) {
    red = G(L, g.raiz, ['fetch', '--prune', '--quiet', 'origin'], 4 * T_RED).ok;
  }
  const r = G(L, g.raiz, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/origin/']);
  const refs = {};
  if (r.ok) {
    for (const l of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const [ref, sha] = l.split(' ');
      const corta = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
      const m = RE_OBRERO.exec(corta);
      if ((m && m[1] === x) || (def && corta === def)) refs[ref] = sha;
    }
  }
  return { refs, red, def };
}

function leerFoto(archivo) {
  try {
    const f = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return f && typeof f.refs === 'object' && f.refs ? f : null;
  } catch (e) {
    return null;
  }
}
function guardarFoto(archivo, f) {
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, refs: f.refs, red: f.red }));
  fs.renameSync(tmp, archivo);
}

// Una vuelta: compara con la foto guardada, la reemplaza y devuelve las líneas DESPERTAR (sin foto anterior: ninguna).
function vuelta(L, g, x) {
  const archivo = path.join(g.gitComun, fotoDe(x));
  const antes = leerFoto(archivo);
  const ahora = fotoDeAhora(L, g, x);
  const lineas = [];
  if (antes) {
    if (ahora.red === false && antes.red !== false) {
      const ref = ahora.def ? `refs/remotes/origin/${ahora.def}` : null;
      lineas.push(`DESPERTAR · sin red · origin@${sha7(ref ? ahora.refs[ref] : null)}`);
    }
    // Por rama (local u origin, da igual): un commit que la foto ya tenía en esa rama no despierta otra vez (el push de lo visto).
    const corta = (ref) => ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
    const vistas = new Set(Object.entries(antes.refs).map(([ref, sha]) => `${corta(ref)}@${sha}`));
    for (const [ref, sha] of Object.entries(ahora.refs)) {
      const c = corta(ref);
      if (vistas.has(`${c}@${sha}`)) continue;
      vistas.add(`${c}@${sha}`);
      let motivo = `commit en ${c}`;
      const m = RE_OBRERO.exec(c);
      if (m) motivo = paradaDe(evidenciaEn(L, g.raiz, sha, m[1], m[2])) ? 'PARADA' : 'commit';
      lineas.push(`DESPERTAR · ${motivo} · ${c}@${sha7(sha)}`);
    }
  }
  guardarFoto(archivo, ahora);
  return lineas;
}

function despertador(L, g, a, o) {
  const salida = o.salida;
  let x = a.modulo;
  if (!x) {
    const p = L.contexto.pestana(L.contexto.rama(g.raiz));
    if (p.tipo !== 'director') return { codigo: 1, lineas: ['despertador: no sé de qué módulo — corrélo desde el worktree del director (rama modulo/<x>) o pasale --modulo <x>'] };
    x = p.modulo;
  }
  if (a.unaVez) return { codigo: 0, lineas: vuelta(L, g, x) };
  // En loop: imprime solo lo que cambió; nunca termina solo (lo corta quien lo lanzó).
  const tic = () => {
    try {
      const ls = vuelta(L, g, x);
      if (ls.length) salida(`${ls.join('\n')}\n`);
    } catch (e) {
      /* una vuelta rota no corta el loop: la próxima vuelve a mirar */
    }
  };
  tic();
  setInterval(tic, a.cada * 1000);
  return { codigo: 0, lineas: [], sigue: true };
}

// ---------------------------------------------------------------- main

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  let r;
  try {
    const a = leerArgumentos(argv);
    const L = libs();
    const g = L.contexto.datosGit(opciones.cwd || process.cwd());
    if (!g) r = { codigo: 1, lineas: ['noche: no estás dentro de un repo git'] };
    else if (a.comando === 'me-voy') r = meVoy(L, g, a, opciones);
    else if (a.comando === 'volvi') r = volvi(L, g);
    else r = despertador(L, g, a, { ...opciones, salida });
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    salida('noche roto: corré doctor\n');
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
    process.stdout.write('noche roto: corré doctor\n');
  }
  process.exitCode = codigo;
}

module.exports = { USO, ARCHIVO_NOCHE, fotoDe, UMBRAL_MUDANZA, leerArgumentos, paradaDe, vuelta, main };
