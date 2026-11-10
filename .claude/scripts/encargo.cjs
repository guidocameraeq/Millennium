'use strict';
// encargo.cjs — el encargo por script (SPEC-paquete-5 P6.3, P6.5, P5.3bis y el corrector "spec sin sello"; A §6-§7; D §7.3, §9.3,
// §12; F §14). Uso, desde el repo:
//   node .claude/scripts/encargo.cjs partida    <x>--<ID>
//   node .claude/scripts/encargo.cjs presentar  <x>--<ID> [--sin-base] | --spec
//   node .claude/scripts/encargo.cjs mensaje    <TIPO> [<ruta>[@<sha>]]
//   node .claude/scripts/encargo.cjs autorizado <x>--<ID>
//   node .claude/scripts/encargo.cjs verificar  <x>--<ID> [--plazo <min>]
// El encargo y el spec se leen de git, nunca del disco: de la más nueva entre modulo/<x> local y origin/modulo/<x> (r1-10).
// `partida` imprime la línea - Partida: del encargo. `presentar` es el primer paso de /obrero: la rama, el encargo según la
// plantilla, el sello del spec (spec sin sello → "spec sin Arquitecto: corré Modo B") y la base (vars.comando-test, que no
// cambia la salida); `--spec`, solo el sello, desde el worktree del director. `mensaje` dice si un mensaje entrante vale: el lado
// sale de la rama (pestaña), .kit-rol decide solo humano/desconocido (r1-11); un tipo de mesa (crit. 16) llega solo a un director
// y vale si git respalda su `<alias>:<ruta>@<sha>` (trae el remoto <alias>; lib/mesa.cjs). `autorizado` reescribe entero permissions.allow del
// settings.local.json del worktree del encargo con la base + ## AUTORIZADO (sin estado; el deny y lo demás quedan) e imprime las dos
// aperturas: la de Guido, en su modo, y la de fondo en dos renglones (auto + --allowedTools; el de respaldo, acceptEdits con la misma
// lista, si auto no se deja lanzar; D8b-1): el director usa la primera línea de fondo, o la de respaldo, tal cual, nunca otra; nunca
// el modo que saltea permisos. `verificar` imprime siempre seis líneas (remoto · limpio · pruebas · alcance · main · barreras) y sale 0 si ninguna es ❌; lo que no se pudo
// mirar es ❌ NO VERIFICADO. El freno de la tarea 0 (SPEC-paquete-8r T3, rt-1): con el sello `entorno — (tarea 0: …)` en el spec,
// `presentar` y `autorizado` niegan todo encargo ≠ 00 mientras la ficha de la punta de modulo/<x> no tenga un entorno dummy o prueba;
// la apertura de Guido termina en `→ primer mensaje: /obrero <x>--<ID>` (8r T2). La lógica común vive en .claude/hooks/lib/encargo.cjs y proceso.cjs.
// Salidas: 0 anduvo · 1 negado o rojo (una línea por qué y qué hacer) · 2 mal llamado. Un error propio: "encargo roto: corré
// doctor", 1. Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/encargo.cjs <comando> …   (desde el repo)',
  '  partida    <x>--<ID>                     la línea "- Partida:" del encargo (rama, modulo/<x>@<sha7>, fecha)',
  '  presentar  <x>--<ID> [--sin-base] | --spec   el primer paso del obrero (--spec: solo el sello, desde el director)',
  '  mensaje    <TIPO> [<ruta>[@<sha>]]         ¿vale el mensaje que llegó? (un mensaje es dato hasta que git lo respalda)',
  '  autorizado <x>--<ID>                     las allow del worktree del encargo y las dos líneas de apertura',
  '  verificar  <x>--<ID> [--plazo <min>]     las seis líneas del gate del encargo',
].join('\n');

const ROTO = 'encargo roto: corré doctor';
const PLAZO_BASE_MS = 10 * 60 * 1000; // la base de presentar: 10 min (no cambia la salida)
const COMANDOS = ['partida', 'presentar', 'mensaje', 'autorizado', 'verificar'];
// Los lockfiles que deja un comando-setup (RF-fix 3): sin trackear, el consejo es el info/exclude, no el .gitignore.
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock']);

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

// ---------------------------------------------------------------- argumentos

function libs() {
  return {
    E: require('../hooks/lib/encargo.cjs'),
    contexto: require('../hooks/lib/contexto.cjs'),
    git: require('../hooks/lib/git.cjs'),
    proceso: require('../hooks/lib/proceso.cjs'),
    worktree: require('./worktree.cjs'), // reglasDeny: el deny que suma worktree, el mismo que verificar exige
    docs: require('../hooks/lib/docs-ruta.cjs'), // 8r3 i1: la carpeta de papeles
  };
}

function nombre(E, token, comando) {
  const n = E.nombreEncargo(token);
  if (!n) malLlamado(`${comando} pide <x>--<ID> (x: minúsculas, números y guiones simples, hasta 20; ID: dos dígitos): "${token || ''}"`);
  return n;
}

function leerArgumentos(argv, E) {
  const [comando, ...resto] = argv;
  if (!comando) malLlamado('Falta el comando.');
  if (!COMANDOS.includes(comando)) malLlamado(`Comando desconocido: ${comando}`);
  const a = { comando, nombre: null, sinBase: false, spec: false, plazoMin: null, texto: null };
  if (comando === 'mensaje') {
    // El mensaje es texto: la primera línea tal cual, en uno o varios argumentos (no hay banderas).
    const t = resto.join(' ').trim();
    if (!t) malLlamado('mensaje pide el tipo (y, si lleva, la ruta).');
    a.texto = t.split(/\r?\n/)[0];
    return a;
  }
  const pos = [];
  for (let i = 0; i < resto.length; i++) {
    const v = resto[i];
    if (comando === 'presentar' && v === '--sin-base') {
      if (a.sinBase) malLlamado('--sin-base va una sola vez.');
      a.sinBase = true;
    } else if (comando === 'presentar' && v === '--spec') {
      if (a.spec) malLlamado('--spec va una sola vez.');
      a.spec = true;
    } else if (comando === 'verificar' && v === '--plazo') {
      if (a.plazoMin !== null) malLlamado('--plazo va una sola vez.');
      if (i + 1 >= resto.length) malLlamado('--plazo pide los minutos.');
      const m = resto[++i];
      if (!/^[1-9][0-9]{0,3}$/.test(m)) malLlamado(`--plazo son minutos, un entero de 1 a 9999: "${m}"`);
      a.plazoMin = Number(m);
    } else if (v.startsWith('--')) {
      malLlamado(`Argumento desconocido: ${v}`);
    } else {
      pos.push(v);
    }
  }
  if (a.spec) {
    if (a.sinBase || pos.length) malLlamado('presentar --spec va solo: lee el SPEC[-N].md más nuevo de la rama del director.');
    return a;
  }
  if (pos.length !== 1) malLlamado(`${comando} lleva un <x>--<ID>.`);
  a.nombre = nombre(E, pos[0], comando);
  return a;
}

// ---------------------------------------------------------------- utilidades

const dos = (k) => String(k).padStart(2, '0');

// La fecha ISO con la zona de esta PC, al minuto: 2026-10-30T14:05-03:00.
function isoConZona(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error('fecha inválida');
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}${signo}${dos(Math.floor(a / 60))}:${dos(a % 60)}`;
}

function plazoBase(opciones) {
  if (Number.isFinite(opciones.plazoBaseMs) && opciones.plazoBaseMs > 0) return opciones.plazoBaseMs;
  const v = Number(process.env.ENCARGO_PLAZO_BASE_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : PLAZO_BASE_MS;
}

// La ficha vigente (de git, regla de 4.7): sus datos, o null si no hay o está rota.
function datosFicha(L, raiz) {
  const f = L.contexto.fichaVigente(raiz);
  return f.estado === 'ok' ? f.datos : null;
}

// La base (P5.6 paso 2): vars.comando-test en el worktree, sin mostrar su salida. No cambia la salida de presentar. Corre adentro
// del vigía (rf-8): pasado el plazo muere con todo lo que lanzó, y no queda un node con el puerto tomado en el worktree del obrero.
function lineaBase(L, datos, raiz, opciones) {
  const ct = datos && datos.vars ? datos.vars['comando-test'] : undefined;
  if (typeof ct !== 'string' || ct.trim() === '') return 'base: NO VERIFICADO (la ficha vigente no tiene vars.comando-test)';
  const ms = plazoBase(opciones);
  const r = L.proceso.correrConPlazo(ct, { cwd: raiz, plazoMs: ms });
  if (r.estado === 'colgado') return `base: NO VERIFICADO (${ct} pasó los ${Math.round(ms / 1000)} s; lo maté con todo lo que lanzó)`;
  if (r.estado === 'no-corrio') return `base: NO VERIFICADO (${ct} no corrió: ${r.como})`;
  return r.estado === 'verde' ? `base: verde (${ct})` : `base: ROJA (ya estaba roto: ${ct} ${r.como.replace(/^salida /, 'salió ')})`;
}

// rf-3: el encargo, la ficha o una CORRECCION pueden venir de la otra PC. Antes de leer modulo/<x>, `fetch --prune` de origin; sin
// remoto, nada; si falla, se sigue con lo que hay en esta PC y se dice en una línea (→ esa línea, o null).
function traerOrigin(L, raiz) {
  const remotos = (G(L, raiz, ['remote']).stdout || '').split('\n').map((s) => s.trim());
  if (!remotos.includes('origin')) return null;
  const f = G(L, raiz, ['fetch', '-q', '--prune', 'origin']);
  if (f.ok) return null;
  return `sin fetch de origin (${(f.stderr || '').trim().split('\n')[0] || f.error}): sigo con lo que hay en esta PC`;
}

// El sello de un spec leído de git: { ok, buf } o { ok: false, por }.
function chequearSpec(L, raiz, ref, ruta) {
  const buf = L.E.leerEn(raiz, ref.sha, ruta);
  if (!buf) return { ok: false, por: `el spec ${ruta} no está en ${ref.nombre}: que el director lo commitee` };
  const hayFicha = fs.existsSync(path.join(raiz, '.claude', 'kit.md'));
  const j = L.E.juzgarSpec(buf, { hayFicha, datosFicha: datosFicha(L, raiz) });
  return j.ok ? { ...j, buf } : j;
}

// ---------------------------------------------------------------- partida

function partida(L, g, n, opciones) {
  const sha = L.E.shaDe(g.raiz, `refs/heads/${n.madre}`);
  if (!sha) return { codigo: 1, lineas: [`partida: no — no existe ${n.madre} en esta PC: el módulo nace con worktree crear ${n.x} (o abrir)`] };
  const ahora = opciones.ahora !== undefined ? opciones.ahora : new Date();
  return { codigo: 0, lineas: [`- Partida: rama ${n.rama} desde ${n.madre}@${sha.slice(0, 7)} · ${isoConZona(ahora)}`] };
}

// ---------------------------------------------------------------- presentar

// rf-4: juzga el SPEC[-N].md de N más alto del módulo (el SPEC.md es N=1): el que va a citar el encargo.
function presentarSpec(L, g, rama) {
  const avisos = [];
  const no = (m) => ({ codigo: 1, lineas: [...avisos, `presentar --spec: no — ${m}`] });
  const p = L.contexto.pestana(rama);
  if (p.tipo !== 'director') return no(`esta pestaña está en ${rama || '(sin rama)'}: --spec corre desde el worktree del director (modulo/<x>)`);
  const f = traerOrigin(L, g.raiz);
  if (f) avisos.push(f);
  const ref = L.E.refMasNueva(g.raiz, `modulo/${p.modulo}`);
  if (!ref.ok) return no(ref.por);
  const ruta = L.E.specVigente(g.raiz, ref.sha, p.modulo);
  const s = chequearSpec(L, g.raiz, ref, ruta);
  if (!s.ok) return no(`${ruta}: ${s.por}`);
  const lineas = [...avisos, `presentar --spec: ${ruta} en ${ref.nombre} @${ref.sha.slice(0, 7)} · sellado y READY: se puede repartir`];
  // RF-fix 8 (D8r.1): con el sello de tarea 0 y la ficha de la punta sin entorno de prueba, el director lo sabe antes de repartir
  // (la misma regla que frena presentar, autorizado y worktree crear de todo encargo ≠ 00).
  if (L.E.tareaCeroPendiente(g.raiz, { id: '01', madre: ref.nombre }, ref, s.buf)) lineas.push('tarea 0 pendiente: el primer encargo es el 00');
  return { codigo: 0, lineas };
}

function presentar(L, g, a, opciones) {
  const rama = L.contexto.rama(g.raiz);
  if (a.spec) return presentarSpec(L, g, rama);
  const n = a.nombre;
  const avisos = [];
  const no = (m) => ({ codigo: 1, lineas: [...avisos, `presentar: no — ${m}`] });
  // 1. La rama del cwd.
  if (rama !== n.rama) return no(`esta pestaña está en ${rama || '(sin rama)'}, el encargo es de ${n.rama}: abrí la del worktree`);
  const f = traerOrigin(L, g.raiz);
  if (f) avisos.push(f);
  // 2. El encargo, commiteado y según la plantilla.
  const u = L.E.ubicarEncargo(g.raiz, n);
  if (!u.ok) return no(u.por);
  const e = L.E.leerEncargo(u.texto, n, u.carpeta);
  if (e.errores.length) return no(`el encargo ${u.ruta} no sigue la plantilla: ${e.errores.join('; ')}: que el director lo corrija y lo commitee`);
  // 3. El spec de - Spec:, con su sello y READY.
  const s = chequearSpec(L, g.raiz, u.ref, e.campos.spec.ruta);
  if (!s.ok) return no(s.por);
  // SPEC-paquete-8r T3 (rt-1): con el sello de tarea 0, solo el 00 hasta que la ficha de modulo/<x> tenga el entorno de prueba.
  const t0 = L.E.tareaCeroPendiente(g.raiz, n, u.ref, s.buf);
  if (t0) return no(t0);
  // 4. Lo que se presenta, y la base.
  const head = L.E.shaDe(g.raiz, 'HEAD');
  const c = e.campos;
  const lineas = [
    ...avisos,
    `${n.rama} · @${head ? head.slice(0, 7) : '???????'} · encargo ${u.ruta} · ${c.modelo.modelo} ${c.modelo.esfuerzo} · riesgo ${c.riesgo.riesgo} · apertura ${c.apertura}`,
  ];
  if (!a.sinBase) lineas.push(lineaBase(L, datosFicha(L, g.raiz), g.raiz, opciones));
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- mensaje

// rf-3: el fetch, solo si el mensaje trae una ruta que git tiene que respaldar (la CORRECCION de la otra PC llega por origin).
function mensaje(L, g, a) {
  const rama = L.contexto.rama(g.raiz);
  const avisos = [];
  const r = L.E.juzgarMensaje({
    texto: a.texto,
    rol: L.contexto.rol(g.raiz),
    pestana: L.contexto.pestana(rama),
    rutaEnModulo: (x, ruta, sha) => {
      const f = traerOrigin(L, g.raiz);
      if (f) avisos.push(f);
      return L.E.rutaEnModulo(g.raiz, x, ruta, sha);
    },
    // Un tipo de mesa: el archivo vive en el repo del otro, que es el remoto con su alias (G §5.6); se trae y se mira el SHA.
    citaDeMesa: (alias, ruta, sha) => {
      const M = require('../hooks/lib/mesa.cjs');
      if (M.remotosAlias(g.raiz).includes(alias)) avisos.push(...M.traer(g.raiz, [alias]));
      else avisos.push(`no hay un remoto ${alias} (git remote add ${alias} <url>): miro solo lo que ya está en este repo`);
      return M.citaEnRepo(g.raiz, alias, ruta, sha);
    },
  });
  return { codigo: r.codigo, lineas: [...avisos, r.linea] };
}

// ---------------------------------------------------------------- lo común de autorizado y verificar

// Las formas de las reglas, contra la doc oficial (leída el 2026-10-31):
//   https://code.claude.com/docs/en/permissions — "The `:*` suffix is an equivalent way to write a trailing wildcard, so
//   `Bash(ls:*)` matches the same commands as `Bash(ls *)`"; "PowerShell permission rules use the same shape as Bash rules"; un `*`
//   final con un espacio antes también toma el comando pelado; en Read/Edit, `//ruta` es absoluta, `~/` el home y `/ruta` es
//   relativa al settings (por eso el validador de AUTORIZADO rechaza `//` y `~`).
//   https://code.claude.com/docs/en/cli-reference — `--allowedTools` va con una regla por argumento, cada una entre comillas:
//   `"Bash(git log *)" "Bash(git diff *)" "Read"`.
// Por eso la base de hooks/lib/encargo.cjs se queda como está, en `:*` (equivalente; el diálogo "no preguntar más" escribe la forma
// con espacio y las dos conviven), y la línea de fondo pasa cada regla como un argumento propio, AL FINAL: la opción toma todos los
// argumentos que siguen. El pedido no va como argumento sino por stdin (`cat file | claude -p "query"`, la misma doc; D-a de D5.1).
const LOG = '.claude/frenos.log';
const SETTINGS = '.claude/settings.local.json';
const CARPETAS = '.claude/worktrees';
const PLAZO_VERIFICAR_MIN = 30; // pruebas de verificar: 30 min por comando, salvo --plazo

// Con '/' (Windows acepta las dos), para que la línea se pegue igual en PowerShell y en Bash (la regla de worktree.cjs).
const barras = (p) => path.resolve(p).split(path.sep).join('/');

function escribirAtomico(abs, contenido) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, abs);
}

// git sin tirar, con el tiempo de los scripts (ls-files, diff y log en un repo grande pasan los 5 s de git.cjs).
const G = (L, cwd, args) => L.git.correr(args, { cwd, tiempo: 60000 });

// El worktree de una rama en esta PC (el que la tiene sacada y existe en el disco), o null.
function worktreeDe(L, raiz, rama) {
  const r = G(L, raiz, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return null;
  let actual = null;
  for (const l of r.stdout.split('\n').map((s) => s.replace(/\r$/, ''))) {
    if (l.startsWith('worktree ')) actual = path.resolve(l.slice('worktree '.length));
    else if (actual && l === `branch refs/heads/${rama}` && fs.existsSync(actual)) return actual;
  }
  return null;
}

function comandoTest(datos) {
  const ct = datos && datos.vars ? datos.vars['comando-test'] : undefined;
  return typeof ct === 'string' && ct.trim() !== '' ? ct.trim() : null;
}

// El encargo commiteado y leído según la plantilla: { ok: true, u, e } o { ok: false, por }.
function encargoLeido(L, raiz, n) {
  const u = L.E.ubicarEncargo(raiz, n);
  if (!u.ok) return { ok: false, por: u.por };
  const e = L.E.leerEncargo(u.texto, n, u.carpeta);
  if (e.errores.length) return { ok: false, por: `el encargo ${u.ruta} no sigue la plantilla: ${e.errores.join('; ')}: que el director lo corrija y lo commitee` };
  return { ok: true, u, e };
}

// Lo autorizado, sin estado (r1-3): la base + las reglas del encargo que valen, sin repetir, en ese orden. Un Write(<ruta>) del
// encargo va como Edit(<ruta>) (E.aPermiso, RF-fix 14: la plataforma no mira Write(<ruta>) para archivos).
function loAutorizado(L, ct, reglas) {
  const malas = new Set(L.E.validarAutorizado(reglas).map((m) => m.regla));
  const out = [];
  for (const r of [...L.E.base(ct || ''), ...(reglas || []).filter((x) => !malas.has(x)).map(L.E.aPermiso)]) if (!out.includes(r)) out.push(r);
  return out;
}

// El settings.local.json del worktree → { datos (un objeto; {} si no está), archivo, existia } o { error }.
function leerSettings(wt) {
  const archivo = path.join(wt, ...SETTINGS.split('/'));
  if (!fs.existsSync(archivo)) return { datos: {}, archivo, existia: false };
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(archivo, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { error: `${SETTINGS} del worktree no es un JSON válido` };
  }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return { error: `${SETTINGS} del worktree no es un JSON de objeto` };
  const p = datos.permissions;
  if (p !== undefined && (!p || typeof p !== 'object' || Array.isArray(p))) return { error: `permissions de ${SETTINGS} no es un objeto` };
  for (const k of ['allow', 'deny']) {
    if (p && p[k] !== undefined && !Array.isArray(p[k])) return { error: `permissions.${k} de ${SETTINGS} no es una lista` };
  }
  return { datos, archivo, existia: true };
}

// ---------------------------------------------------------------- autorizado (P6.5; r1-2, r1-3, r1-4, r1-5, r1-9; D5-2, D5-19)

// Una regla entre comillas que se pegan igual en PowerShell y en Bash: dobles si no lleva nada que alguna de las dos interprete
// adentro; si no, simples (las dos las toman literal); con una comilla simple adentro no hay forma común → null.
function citar(regla) {
  if (!/["$`\\!]/.test(regla)) return `"${regla}"`;
  if (!regla.includes("'")) return `'${regla}'`;
  return null;
}

// Las líneas de fondo (D5-2, D8b-1) → una lista de renglones: el primero en auto, el de respaldo en acceptEdits (la cuenta sin auto o
// el clasificador del director que lo frena), los dos con --allowedTools con la base + el encargo (la lista preaprueba sin el
// clasificador; auto juzga el resto y los porteros siguen negando); nunca el modo que saltea los permisos. Sin `claude` o con una
// regla que no se cita, un renglón solo. No depende del archivo. La corre el director desde su Bash, que en Windows es Git Bash: MSYS convierte un argumento que empieza con `/` en una
// ruta (`-p "/obrero x--01"` llegaba como `C:/Program Files/Git/obrero x--01`; D2.2). Por eso el pedido va por stdin con `printf`, un
// builtin (no se convierte), y ningún argumento suelto empieza con `/`. Nunca MSYS_NO_PATHCONV: la sesión lo heredaría. `claude` es
// el del PATH o el de la extensión de VS Code (hooks/lib/proceso.cjs comandoClaude; D-b); sin ninguno, la apertura es de Guido.
function lineaDeFondo(L, wt, n, modelo, reglas, opciones) {
  const claude = L.proceso.comandoClaude(opciones);
  if (!claude) return ['apertura de fondo: sin `claude` (ni en el PATH ni el de la extensión de VS Code): la apertura es de Guido'];
  const citadas = reglas.map(citar);
  const k = citadas.indexOf(null);
  if (k >= 0) return [`apertura de fondo: la regla ${reglas[k]} no se puede citar igual en PowerShell y en Bash: la apertura es de Guido`];
  const resto = (modo) =>
    `cd "${barras(wt)}" && printf '%s\\n' '/obrero ${n.x}--${n.id}' | ${claude} -p --model ${modelo} --permission-mode ${modo} --allowedTools ${citadas.join(' ')}`;
  return [`apertura de fondo: ${resto('auto')}`, `apertura de fondo (respaldo, si auto no está): ${resto('acceptEdits')}`];
}

function autorizado(L, g, n, opciones) {
  const no = (m) => ({ codigo: 1, lineas: [`autorizado: no — ${m}`] });
  const c = encargoLeido(L, g.raiz, n);
  if (!c.ok) return no(c.por);
  const { u, e } = c;
  // SPEC-paquete-8r T3 (rt-1): la tarea 0 primero (el spec que cita el encargo, de la punta de modulo/<x>; sin él, lo frena presentar).
  const t0 = L.E.tareaCeroPendiente(g.raiz, n, u.ref, L.E.leerEn(g.raiz, u.ref.sha, e.campos.spec.ruta));
  if (t0) return no(t0);
  const reglas = e.secciones.autorizado;
  const malas = L.E.validarAutorizado(reglas);
  if (malas.length) {
    const cuantas = malas.length === 1 ? 'una regla que no vale' : `${malas.length} reglas que no valen`;
    return { codigo: 1, lineas: [`autorizado: no — ## AUTORIZADO de ${u.ruta} tiene ${cuantas}; no escribí nada:`, ...malas.map((m) => `  ${m.regla}: ${m.por}`)] };
  }
  const wt = worktreeDe(L, g.raiz, n.rama);
  if (!wt) return no(`el worktree de ${n.rama} no está en esta PC: worktree crear ${n.x}--${n.id} (o abrir) y después autorizado`);
  const s = leerSettings(wt);
  if (s.error) return no(`${s.error}: arreglalo y corré autorizado de nuevo (no escribí nada)`);
  const ct = comandoTest(datosFicha(L, g.raiz));
  const allow = loAutorizado(L, ct, reglas);
  const antes = s.datos.permissions && Array.isArray(s.datos.permissions.allow) ? s.datos.permissions.allow : [];
  // r1-5: permissions.allow se reescribe ENTERO, sin estado; el deny de worktree y las demás claves quedan como estaban; ninguna
  // clave propia del kit (r1-3).
  if (s.datos.permissions === undefined) s.datos.permissions = {};
  s.datos.permissions.allow = allow;
  escribirAtomico(s.archivo, `${JSON.stringify(s.datos, null, 2)}\n`);
  const nBase = L.E.base(ct || '').length;
  const lineas = [`autorizado: ${allow.length} reglas en ${SETTINGS} de ${CARPETAS}/${n.carpeta} (la base, ${nBase}, + ${allow.length - nBase} de ${u.ruta}@${u.ref.sha.slice(0, 7)})`];
  if (!ct) lineas.push('la ficha vigente no tiene vars.comando-test: la base va sin las reglas del test');
  const sacadas = antes.filter((r) => !allow.includes(r));
  lineas.push(
    sacadas.length
      ? `saqué ${sacadas.length} que no venían de la base ni del encargo (lo sumado con "no preguntar más" se pierde cada vez que corre autorizado): ${sacadas.join(', ')}`
      : 'lo que se sume con "no preguntar más" se pierde la próxima vez que corra autorizado (allow se reescribe entero)',
  );
  if (!Array.isArray(s.datos.permissions.deny) || !s.datos.permissions.deny.length) lineas.push(`ojo: ${SETTINGS} no tiene el deny de worktree: corré worktree abrir (verificar lo marca ❌)`);
  const modelo = e.campos.modelo.modelo;
  // D5-19: la de Guido no fuerza el modo: la pestaña abre en el suyo.
  lineas.push(`apertura de Guido: code "${barras(wt)}" → en esa ventana, la pestaña de Claude con ${modelo[0].toUpperCase()}${modelo.slice(1)}, en tu modo (nombre sugerido: obrero-${n.x}--${n.id}) → primer mensaje: /obrero ${n.x}--${n.id}`);
  lineas.push(...lineaDeFondo(L, wt, n, modelo, allow, opciones));
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- verificar (P6.3; r1-3, r1-8; D5-4, D5-11, D5-12, D5-13)

const OK = '✅';
const MAL = '❌';
const OJO = '⚠️';
const NV = 'NO VERIFICADO';

// ¿La ruta cae en un renglón de ## Toca? `**` cualquier cosa, `*` y `?` sin cruzar '/'; sin comodines, el archivo o la carpeta
// (con o sin '/' al final).
function enToca(ruta, patron) {
  const p = String(patron).trim().replace(/^\.?\//, '');
  if (!p) return false;
  if (!/[*?]/.test(p)) {
    const s = p.replace(/\/+$/, '');
    return ruta === s || ruta.startsWith(`${s}/`);
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (p.endsWith('/')) re += '.*';
  return new RegExp(`^${re}$`).test(ruta);
}

// ¿El comando trae una tubería fuera de comillas? `| tail` tapa el código de salida (la regla 2 del gate).
const conTuberia = (cmd) => /\|/.test(String(cmd).replace(/"[^"]*"|'[^']*'/g, ''));

// frenos.log del disco contra el de HEAD, los dos a LF → { estado: 'nada' | 'igual' | 'agregado' (y cuántos renglones) |
// 'cambiado' }. La regla de frenosContraHead de worktree.cjs (que no la exporta), repetida.
function frenosContraHead(L, wt) {
  let disco;
  try {
    disco = fs.readFileSync(path.join(wt, ...LOG.split('/')));
  } catch (e) {
    return { estado: 'nada' };
  }
  const aLF = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
  const D = aLF(disco);
  const h = G(L, wt, ['show', `HEAD:${LOG}`]);
  const B = h.ok ? aLF(h.salida) : '';
  if (D === B) return { estado: 'igual' };
  if (!D.startsWith(B)) return { estado: 'cambiado' };
  return { estado: 'agregado', renglones: D.slice(B.length).split('\n').filter((l) => l.trim() !== '').length };
}

// 1. remoto (r1-8): la punta local, la que se mergea, es la de origin. Antes, fetch --prune (en la otra PC la ref de origin está
// vieja; revisor frío de D5.1); si falla, sigue con lo que hay y lo dice.
function lineaRemoto(L, c) {
  const p7 = c.punta.slice(0, 7);
  const remotos = (G(L, c.raiz, ['remote']).stdout || '').split('\n').map((s) => s.trim());
  if (!remotos.includes('origin')) return [OK, `punta @${p7} · sin remoto`];
  const f = G(L, c.raiz, ['fetch', '-q', '--prune', 'origin']);
  const nota = f.ok ? '' : ` (sin fetch: ${(f.stderr || '').trim().split('\n')[0] || f.error}; comparo con lo que hay en esta PC)`;
  const o = L.E.shaDe(c.raiz, `refs/remotes/origin/${c.n.rama}`);
  if (!o) return [MAL, `punta @${p7} · origin no tiene ${c.n.rama}: pusheá la rama${nota}`];
  if (o !== c.punta) {
    const como = L.E.esAncestro(c.raiz, o, c.punta) ? 'adelante de' : L.E.esAncestro(c.raiz, c.punta, o) ? 'atrás de' : 'divergida de';
    return [MAL, `punta @${p7} · ${como} origin/${c.n.rama} @${o.slice(0, 7)}: pusheá la rama${nota}`];
  }
  return [OK, `punta @${p7} = origin/${c.n.rama}${nota}`];
}

// 2. limpio: frenos.log con solo renglones agregados es ⚠️ (los muda cerrar, D4-3). rf-10: ❌ solo lo trackeado modificado y lo sin
// trackear que cae en ## Toca (es del encargo y no se commiteó); lo sin trackear de afuera (un coverage/ que deja la suite) es ⚠️:
// el merge va por SHA y no llega a modulo/<x>. Sin el encargo leído, todo lo sin trackear es ❌ (no se sabe qué es de ## Toca).
function lineaLimpio(L, c) {
  const r = G(L, c.wt, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) return [MAL, `${NV} — no pude leer el estado del worktree`];
  const st = r.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
  const ruta = (l) => l.slice(3).replace(/^"|"$/g, '');
  const otros = st.filter((l) => ruta(l) !== LOG);
  const toca = c.e ? c.e.secciones.toca.rutas : null;
  const afuera = otros.filter((l) => l.startsWith('?? ') && toca && !toca.some((p) => enToca(ruta(l), p)));
  const mal = otros.filter((l) => !afuera.includes(l));
  const lista = (ls) => `${ls.slice(0, 5).map(ruta).join(', ')}${ls.length > 5 ? ' …' : ''}`;
  if (mal.length) return [MAL, `sin commitear: ${lista(mal)}`];
  const ojo = [];
  if (st.length !== otros.length) {
    const f = frenosContraHead(L, c.wt);
    if (f.estado !== 'agregado') return [MAL, `${LOG} cambió en el medio o se borró (no solo renglones al final): revisalo`];
    ojo.push(`${LOG} con ${f.renglones} renglón(es) agregado(s) sin commitear (los muda worktree cerrar)`);
  }
  // RF-fix 3 (D8r.1): un lockfile sin trackear lo dejó comando-setup; al .gitignore no (es del proyecto): va al info/exclude.
  const locks = afuera.filter((l) => LOCKS.has(path.posix.basename(ruta(l))));
  const resto = afuera.filter((l) => !locks.includes(l));
  if (resto.length) ojo.push(`sin trackear fuera de ## Toca: ${lista(resto)} (el merge va por SHA: no llegan a modulo/${c.n.x}; si es de la suite, sumalo al .gitignore)`);
  if (locks.length) ojo.push(`lock sin trackear: ${lista(locks)} (lo dejó comando-setup; no va al .gitignore: sumalo al info/exclude del repo, como hace worktree crear)`);
  return ojo.length ? [OJO, ojo.join(' · ')] : [OK, 'el worktree está limpio'];
}

// 3. pruebas: comando-test y los de ## GATE, en el worktree, de a uno, sin tuberías, adentro del vigía (un colgado muere con todo
// lo que lanzó); el primero que no da verde corta.
function lineaPruebas(L, c, opciones) {
  const ct = comandoTest(c.datos);
  if (!ct) return [MAL, `${NV} — la ficha vigente no tiene vars.comando-test`];
  const comandos = [ct, ...c.e.secciones.gate.filter((x) => x !== ct)];
  const conTubo = comandos.find(conTuberia);
  if (conTubo) return [MAL, `${NV} — ${conTubo} tiene una tubería: el gate mira el código de salida (sacala)`];
  const plazoMs = opciones.plazoMs || (c.plazoMin || PLAZO_VERIFICAR_MIN) * 60000;
  for (const cmd of comandos) {
    const r = L.proceso.correrConPlazo(cmd, { cwd: c.wt, plazoMs });
    if (r.estado === 'colgado') return [MAL, `${NV} — ${cmd} ${r.como} (lo maté con todo lo que lanzó)`];
    if (r.estado === 'no-corrio') return [MAL, `${NV} — ${cmd} no corrió (${r.como})`];
    if (r.estado === 'rojo') return [MAL, `commit con la suite en rojo: ${cmd} (${r.como})`];
  }
  return [OK, `en verde: ${comandos.join(' · ')}`];
}

// 4. alcance (D5-13): lo de más es ⚠️, no ❌ (un desvío de clase 1 puede tocar otro archivo; el director decide).
function lineaAlcance(L, c) {
  const r = G(L, c.raiz, ['diff', '--name-only', '--no-renames', '-z', c.base, c.punta]);
  if (!r.ok) return [MAL, `${NV} — no pude listar los archivos de la rama`];
  const archivos = r.stdout.split('\0').filter(Boolean);
  // 8r3 i1: la evidencia vive en la carpeta de papeles (docs sin la clave)
  const bitacora = L.docs.rel(L.docs.deRaiz(c.raiz), `modulos/${c.n.x}/bitacora/`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const evidencia = new RegExp(`^${bitacora}[^/]+-evidencia-${c.n.id}\\.md$`);
  const toca = c.e.secciones.toca.rutas;
  const demas = archivos.filter((f) => f !== LOG && !evidencia.test(f) && !toca.some((p) => enToca(f, p)));
  if (demas.length) return [OJO, `${demas.length} fuera de ## Toca (el director decide): ${demas.slice(0, 10).join(', ')}${demas.length > 10 ? ' …' : ''}`];
  return [OK, `${archivos.length} archivo(s), todos en ## Toca, la evidencia o ${LOG}`];
}

// 5. main (CM-79, D5-12): commits de la rama por defecto (local y origin) posteriores a la partida, y el status del principal. De
// día ⚠️ (Guido trabaja en main); con el worktree del encargo de noche (.kit-rol nocturno o .kit-noche, la suya o la del
// director: contexto.deNoche), un commit es ❌. Si la noche es por la marca, cuentan como de noche solo los commits con fecha de
// commit ≥ el "desde" que escribe me-voy en ella (RF-fix 2: los de día anteriores al "me voy" son ⚠️, como de día); si la marca no
// trae una fecha legible (escrita a mano, o de antes de me-voy), cuentan todos, como antes, y la línea lo dice.
function lineaMain(L, c) {
  const desde = Date.parse(c.e.campos.partida.fecha);
  if (!Number.isFinite(desde)) return [MAL, `${NV} — la fecha de - Partida: no se lee`];
  const def = L.contexto.ramaPorDefecto(c.raiz);
  if (!def) return [MAL, `${NV} — no encuentro la rama por defecto`];
  // Desde el minuto SIGUIENTE a la partida: la partida va al minuto, y un commit de ese mismo minuto puede ser de antes.
  const limite = Math.floor(desde / 1000) + 60;
  const shas = new Map(); // sha → fecha de commit (segundos)
  for (const ref of [`refs/heads/${def}`, `refs/remotes/origin/${def}`]) {
    if (!L.E.shaDe(c.raiz, ref)) continue;
    const r = G(L, c.raiz, ['log', '-n', '2000', '--format=%H %ct', ref]);
    if (!r.ok) return [MAL, `${NV} — no pude leer el log de ${ref}`];
    for (const l of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const [sha, ct] = l.split(' ');
      if (Number(ct) >= limite) shas.set(sha, Number(ct));
    }
  }
  const st = G(L, path.dirname(c.gitComun), ['status', '-sb', '--untracked-files=all']);
  const lst = st.ok ? st.stdout.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean) : [];
  const sucios = Math.max(0, lst.length - 1);
  const principal = `principal: ${lst.length ? lst[0] : '(sin estado)'}${sucios ? ` · ${sucios} sin commitear` : ''}`;
  const commits = `${shas.size} commit(s) en ${def} después de la partida (${c.e.campos.partida.fecha})`;
  if (shas.size && c.noche && c.noche.noche) {
    if (c.noche.por !== 'kit-noche') return [MAL, `${commits}: commit en main de noche: PARADA · ${principal}`];
    const m = desdeMarca(L, c.wt, c.n.rama);
    if (!m) return [MAL, `${commits}: commit en main de noche: PARADA (.kit-noche: la marca no trae una fecha legible, cuentan todos) · ${principal}`];
    const deNoche = [...shas.values()].filter((ct) => ct >= Math.floor(m.ms / 1000)).length;
    if (deNoche) return [MAL, `${commits}: commit en main de noche: PARADA (.kit-noche: ${deNoche} desde el "me voy" de ${m.texto}) · ${principal}`];
    return [OJO, `${commits}, todos antes del "me voy" (${m.texto}) · ${principal}`];
  }
  if (shas.size || sucios || !st.ok) return [OJO, `${commits} · ${principal}`];
  return [OK, `${commits} · ${principal}`];
}

// El "desde" de la .kit-noche que hizo nocturno al encargo (la de su checkout o, si no tiene, la del worktree del director: la misma
// búsqueda que contexto.deNoche) → { ms, texto } o null si no se lee.
function desdeMarca(L, wt, rama) {
  const leer = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, L.contexto.ARCHIVO_NOCHE), 'utf8');
    } catch (e) {
      return null;
    }
  };
  let t = leer(wt);
  if (t === null) {
    const p = L.contexto.pestana(rama);
    const d = p.tipo === 'obrero' ? (L.contexto.worktrees(wt) || []).find((w) => w.rama === `modulo/${p.modulo}`) : null;
    t = d ? leer(d.ruta) : null;
  }
  const m = t === null ? null : /^\s*desde\s+(\S+)/m.exec(t.replace(/^﻿/, ''));
  const ms = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(ms) ? { ms, texto: m[1] } : null;
}

// 6. barreras: el candado de cada commit del rango, frenos.log sin bajas y el cruce de AUTORIZADO sin estado (r1-3): allow ⊆
// base + ## AUTORIZADO del encargo commiteado (de más → ⚠️, D5-4); el deny de worktree, entero (falta → ❌).
function lineaBarreras(L, c) {
  const mal = [];
  const ojo = [];
  let out = '';
  const k = require('./estructura.cjs').main(['barreras', '--rango', `${c.base}..${c.punta}`], { cwd: c.wt, salida: (s) => (out += s), error: (s) => (out += s) });
  const primera = (out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 300);
  if (k === 1) mal.push(`candado rojo: ${primera}`);
  else if (k !== 0) mal.push(`${NV} — estructura.cjs barreras salió ${k}: ${primera}`);
  const d = G(L, c.raiz, ['diff', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', '-U0', c.base, c.punta, '--', LOG]);
  if (!d.ok) mal.push(`${NV} — no pude leer el diff de ${LOG}`);
  else {
    const bajas = d.stdout.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    if (bajas) mal.push(`la rama borra ${bajas} renglón(es) de ${LOG}`);
  }
  const s = leerSettings(c.wt);
  if (s.error) mal.push(`${s.error}: no se ve el deny de worktree`);
  else {
    const p = s.datos.permissions || {};
    const permitido = loAutorizado(L, comandoTest(c.datos), c.e.secciones.autorizado);
    const deMas = (p.allow || []).filter((r) => !permitido.includes(r));
    if (deMas.length) ojo.push(`allow de más (ni en la base ni en ## AUTORIZADO): ${deMas.join(', ')}`);
    const faltan = L.worktree.reglasDeny(path.dirname(c.gitComun)).filter((r) => !(p.deny || []).includes(r));
    if (faltan.length) mal.push(`falta el deny de worktree (${faltan.length}): ${faltan.slice(0, 2).join(', ')}${faltan.length > 2 ? ' …' : ''}`);
  }
  if (mal.length) return [MAL, [...mal, ...ojo].join(' · ')];
  if (ojo.length) return [OJO, `candado verde · ${LOG} sin bajas · ${ojo.join(' · ')}`];
  return [OK, `candado verde · ${LOG} sin bajas · allow ⊆ base + AUTORIZADO · deny de worktree completo`];
}

// Las seis, en orden, cada una con lo que necesita: si le falta algo, ❌ NO VERIFICADO con el porqué; si tira, "encargo roto".
// Siempre las seis: el director lee la línea que falló sin adivinar cuál no corrió.
const LINEAS = [
  ['remoto', ['punta'], lineaRemoto],
  ['limpio', ['wt'], lineaLimpio],
  ['pruebas', ['wt', 'e'], lineaPruebas],
  ['alcance', ['punta', 'e', 'base'], lineaAlcance],
  ['main', ['e', 'wt'], lineaMain],
  ['barreras', ['punta', 'e', 'base', 'wt'], lineaBarreras],
];

function verificar(L, g, a, opciones) {
  const n = a.nombre;
  const c = { n, raiz: g.raiz, gitComun: g.gitComun, plazoMin: a.plazoMin, punta: null, wt: null, e: null, base: null, faltas: {} };
  try {
    c.datos = datosFicha(L, g.raiz);
    c.punta = L.E.shaDe(g.raiz, `refs/heads/${n.rama}`);
    if (!c.punta) c.faltas.punta = `no existe ${n.rama} en esta PC`;
    c.wt = worktreeDe(L, g.raiz, n.rama);
    if (!c.wt) c.faltas.wt = 'el worktree del encargo no está en esta PC: corré verificar en la PC del worktree';
    else c.noche = L.contexto.deNoche(c.wt, { rama: n.rama });
    const enc = encargoLeido(L, g.raiz, n);
    if (!enc.ok) c.faltas.e = enc.por;
    else c.e = enc.e;
    if (c.punta && c.e) {
      const mb = G(L, g.raiz, ['merge-base', enc.u.ref.sha, c.punta]);
      if (mb.ok) c.base = mb.stdout.trim();
      else c.faltas.base = `${n.rama} no tiene base común con ${enc.u.ref.nombre}`;
    } else c.faltas.base = c.faltas.punta || c.faltas.e;
  } catch (e) {
    for (const k of ['punta', 'wt', 'e', 'base']) if (!c[k] && !c.faltas[k]) c.faltas[k] = ROTO;
  }
  const lineas = [];
  let codigo = 0;
  LINEAS.forEach(([id, pide, fn], i) => {
    let r;
    const sin = pide.find((k) => !c[k]);
    if (sin) r = [MAL, `${NV} — ${c.faltas[sin] || ROTO}`];
    else {
      try {
        r = fn(L, c, opciones);
      } catch (e) {
        r = [MAL, `${NV} — ${ROTO}`];
      }
    }
    if (r[0] === MAL) codigo = 1;
    lineas.push(`${i + 1}. ${id} · ${r[0]} · ${r[1]}`);
  });
  return { codigo, lineas };
}

// ---------------------------------------------------------------- main

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  let r;
  try {
    const L = libs();
    const a = leerArgumentos(argv, L.E);
    const g = L.contexto.datosGit(opciones.cwd || process.cwd());
    if (!g) r = { codigo: 1, lineas: ['encargo: no estás dentro de un repo git'] };
    else if (a.comando === 'partida') r = partida(L, g, a.nombre, opciones);
    else if (a.comando === 'presentar') r = presentar(L, g, a, opciones);
    else if (a.comando === 'autorizado') r = autorizado(L, g, a.nombre, opciones);
    else if (a.comando === 'verificar') r = verificar(L, g, a, opciones);
    else r = mensaje(L, g, a);
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    // En verificar, un error propio es además NO VERIFICADO (nunca verde, nunca merge).
    salida(`${ROTO}\n${argv[0] === 'verificar' ? `${NV}\n` : ''}`);
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

module.exports = { USO, ROTO, PLAZO_BASE_MS, PLAZO_VERIFICAR_MIN, leerArgumentos, isoConZona, citar, enToca, conTuberia, main };
