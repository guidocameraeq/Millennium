'use strict';
// mesa.cjs — la mesa entre directores de dos proyectos, por git (SPEC-0 5.9, crit. 13 del kit; G §5-§9, §12, §19). Uso:
//   node .claude/scripts/mesa.cjs nuevo <TIPO> <alias>/<rol> <x> [--archivo <ruta>] [--de <alias>]
//   node .claude/scripts/mesa.cjs abiertos [--hilo <id>]
//   node .claude/scripts/mesa.cjs acordados [--hoy]
//   node .claude/scripts/mesa.cjs huella <alias>@<sha> <carpeta> [--copia <dir>] | huella --copia <dir>
// `nuevo`: primero el archivo, después el aviso (crit. 13). Escribe docs/modulos/<x>/mesa/<alias>/<fecha>-<n>-<TIPO>.md con la
// cabecera que pone el script (tipo, de, para) y, abajo, lo de --archivo (o la entrada estándar): `tema:` y, si van, `responde-a:`,
// `resultado:` (solo en RESPUESTA) y `hechos:`, después la prosa. ≤ 2 KB y un tipo de la mesa, o no escribe nada. Lo commitea por
// ruta, lo sube a origin (si no sube, no hay aviso: salida 1) e imprime al final el aviso de una línea para mandar por el canal:
// `<TIPO> · <yo> → <alias> · <tema> · <yo>:<ruta>@<sha12>`. Una RESPUESTA tiene que citar un mensaje que git tenga, y un acuerdo
// (`resultado: aceptado` a una PROPUESTA) no se firma dos veces. `de:` es `<yo>/director` en la rama modulo/<x> y `<yo>/sesion` en
// otra; un obrero no escribe en la mesa. <yo>: --de, o vars.proyecto de la ficha, o el nombre del repo de origin.
// El otro proyecto es el remoto de git con su alias (`git remote add <alias> <url>`; la URL está en el MAPA).
// `abiertos`: trae (fetch) origin y cada remoto alias y lista los PEDIDO/PROPUESTA/ALERTA sin RESPUESTA, de los dos lados
// ("esperás" o "te toca"), con "esperando desde <fecha>" y "trabado por mesa" a los 2 días; sin nada, `— (nada abierto)`.
// --hilo <id> (el nombre del archivo, la ruta o <alias>:<ruta>): el mensaje y sus respuestas.
// `acordados`: una línea por acuerdo (PROPUESTA con una RESPUESTA `aceptado`), y si no hay, `— (sin acuerdos)`; salida 0. No
// trae nada (lee lo que ya trajo `abiertos`): lo llama el resumen del día. --hoy: los firmados hoy.
// `huella`: solo si guardás una copia de un recurso compartido (G §8.3): el hash del conjunto <carpeta> en <alias>@<sha>; con
// --copia, también el de tu copia, y si no coinciden, salida 1.
// Salidas: 0 anduvo · 1 negado (una línea por qué y qué hacer) · 2 mal llamado. Un error propio: "mesa rota: corré doctor", 1.
// docs/ es la carpeta de papeles: la `carpeta-docs:` de la ficha vigente si la hay (SPEC-paquete-8r3 i1; lib/docs-ruta.cjs).
// La lógica vive en .claude/hooks/lib/mesa.cjs (decide un freno: candado:mesa). Node estándar, cero dependencias.

const fs = require('fs');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/mesa.cjs <comando> …   (desde el repo)',
  '  nuevo <TIPO> <alias>/<rol> <x> [--archivo <ruta>] [--de <alias>]   escribe, commitea y sube el mensaje; imprime el aviso',
  '  abiertos [--hilo <id>]                    lo que espera respuesta, de los dos lados (trae antes)',
  '  acordados [--hoy]                         los acuerdos, una línea cada uno ("— (sin acuerdos)" si no hay)',
  '  huella <alias>@<sha> <carpeta> [--copia <dir>] | huella --copia <dir>   el hash de un conjunto compartido',
].join('\n');

const ROTO = 'mesa rota: corré doctor';
const COMANDOS = ['nuevo', 'abiertos', 'acordados', 'huella'];

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

function libs() {
  return {
    M: require('../hooks/lib/mesa.cjs'),
    E: require('../hooks/lib/encargo.cjs'),
    contexto: require('../hooks/lib/contexto.cjs'),
    git: require('../hooks/lib/git.cjs'),
    docs: require('../hooks/lib/docs-ruta.cjs'), // 8r3 i1: la carpeta de papeles (docs sin la clave)
  };
}

// ---------------------------------------------------------------- argumentos

function leerArgumentos(argv, L) {
  const [comando, ...resto] = argv;
  if (!comando) malLlamado('Falta el comando.');
  if (!COMANDOS.includes(comando)) malLlamado(`Comando desconocido: ${comando}`);
  const a = { comando, pos: [] };
  const valor = (i, b) => {
    if (i + 1 >= resto.length || resto[i + 1] === '' || resto[i + 1].startsWith('--')) malLlamado(`${b} pide un valor.`);
    return resto[i + 1];
  };
  const banderas = { nuevo: ['--archivo', '--de'], abiertos: ['--hilo'], acordados: ['--hoy'], huella: ['--copia'] }[comando];
  for (let i = 0; i < resto.length; i++) {
    const v = resto[i];
    if (v.startsWith('--')) {
      if (!banderas.includes(v)) malLlamado(`${comando} no lleva ${v}.`);
      const k = v.slice(2);
      if (k in a) malLlamado(`${v} va una sola vez.`);
      if (v === '--hoy') a.hoy = true;
      else a[k] = valor(i++, v);
    } else a.pos.push(v);
  }
  if (comando === 'nuevo') {
    if (a.pos.length !== 3) malLlamado('nuevo pide <TIPO> <alias>/<rol> <x>.');
    const tipo = L.M.tipoMesa(a.pos[0]);
    if (!tipo || L.E.sinTilde(a.pos[0]) !== tipo) malLlamado(`"${a.pos[0]}" no es un tipo de la mesa: ${L.M.TIPOS.join(', ')}.`);
    if (!L.M.RE_DIRECCION.test(a.pos[1])) malLlamado(`"${a.pos[1]}" no es <alias>/<rol> (rol: ${L.M.ROLES.join(' o ')}).`);
    if (!L.E.RE_X.test(a.pos[2]) || a.pos[2].length > 20) malLlamado(`"${a.pos[2]}" no es un módulo (minúsculas, números y guiones simples, hasta 20).`);
    if (a.de !== undefined && !L.M.RE_ALIAS.test(a.de)) malLlamado(`--de "${a.de}" no es un alias (minúsculas, números y guiones).`);
    Object.assign(a, { tipo, para: a.pos[1], x: a.pos[2] });
  } else if (comando === 'huella') {
    if (a.pos.length === 0 && a.copia !== undefined) return a;
    if (a.pos.length !== 2) malLlamado('huella pide <alias>@<sha> <carpeta> (o solo --copia <dir>).');
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)@([0-9a-f]{7,40})$/.exec(a.pos[0]);
    if (!m) malLlamado(`"${a.pos[0]}" no es <alias>@<sha>.`);
    Object.assign(a, { alias: m[1], sha: m[2], carpeta: a.pos[1] });
  } else if (a.pos.length) malLlamado(`${comando} no lleva "${a.pos[0]}".`);
  return a;
}

// ---------------------------------------------------------------- nuevo

const G = (L, cwd, args, tiempo = 60000) => L.git.correr(args, { cwd, tiempo });

// <yo>: --de, o vars.proyecto de la ficha en minúsculas y con guiones, o el nombre del repo de origin.
function miAlias(L, raiz, de) {
  if (de) return de;
  const slug = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fv = L.contexto.fichaVigente(raiz);
  const p = fv.estado === 'ok' && fv.datos.vars ? slug(fv.datos.vars.proyecto) : '';
  if (L.M.RE_ALIAS.test(p)) return p;
  const url = L.git.texto(['remote', 'get-url', 'origin'], { cwd: raiz });
  const b = url ? slug(path.posix.basename(url.replace(/\\/g, '/').replace(/\/+$/, '')).replace(/\.git$/, '')) : '';
  return L.M.RE_ALIAS.test(b) ? b : null;
}

function leerCuerpo(a, opciones) {
  if (a.archivo !== undefined) {
    try {
      return fs.readFileSync(path.resolve(opciones.cwd || process.cwd(), a.archivo), 'utf8');
    } catch (e) {
      return null;
    }
  }
  if (opciones.entrada !== undefined) return opciones.entrada;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

// El <n> del nombre (RF-fix 5): el mayor de ese día entre el disco y git — la carpeta en cada rama local y en cada una de origin
// (lo que ya trajo el último fetch: no trae nada) — más uno. Solo con el disco, dos sesiones del mismo día (otra rama, otra PC)
// elegían el mismo número y los nombres chocaban.
function siguienteN(L, raiz, carpeta, abs, fecha) {
  const nombres = [];
  try {
    nombres.push(...fs.readdirSync(abs));
  } catch (e) {
    /* la carpeta todavía no existe en el disco */
  }
  const refs = G(L, raiz, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/']);
  for (const ref of refs.ok ? refs.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !/\/HEAD$/.test(s)) : []) {
    const r = G(L, raiz, ['ls-tree', '-z', '--name-only', ref, '--', `${carpeta}/`]);
    if (r.ok) nombres.push(...r.stdout.split('\0').filter(Boolean).map((p) => path.posix.basename(p)));
  }
  let n = 1;
  for (const f of nombres) {
    const m = /^(\d{4}-\d{2}-\d{2})-(\d+)-/.exec(f);
    if (m && m[1] === fecha) n = Math.max(n, Number(m[2]) + 1);
  }
  return n;
}

function nuevo(L, g, a, opciones) {
  const no = (...lineas) => ({ codigo: 1, lineas });
  const raiz = g.raiz;
  const pest = L.contexto.pestana(L.contexto.rama(raiz));
  if (pest.tipo === 'obrero') return no('mesa: un obrero no escribe en la mesa — es entre directores: pasale el tema a tu director (CONSULTA)');
  if (pest.tipo === 'director' && pest.modulo !== a.x) return no(`mesa: sos el director de ${pest.modulo} y el mensaje es del módulo ${a.x} — escribí en tu módulo`);
  const modulo = L.docs.rel(L.docs.deRaiz(raiz), `modulos/${a.x}`);
  if (!fs.existsSync(path.join(raiz, ...modulo.split('/'), 'README.md'))) return no(`mesa: no está ${modulo}/README.md — el mensaje va en el módulo dueño de la conexión`);
  const yo = miAlias(L, raiz, a.de);
  if (!yo) return no('mesa: no sé tu alias — pasalo con --de <alias> (o poné vars.proyecto en la ficha)');
  const cuerpo = leerCuerpo(a, opciones);
  if (cuerpo === null) return no(`mesa: no pude leer ${a.archivo}`);
  const c = L.M.leerCabecera(cuerpo).campos;
  for (const k of ['tipo', 'de', 'para']) if (k in c) return no(`mesa: el cuerpo trae "${k}:" — eso lo pone el script; sacalo`);
  const de = `${yo}/${pest.tipo === 'director' ? 'director' : 'sesion'}`;
  const texto = L.M.armar({ tipo: a.tipo, de, para: a.para, cuerpo });
  const aliasPara = a.para.split('/')[0];
  const ahora = opciones.ahora || new Date();
  const fecha = L.M.dia(ahora);
  const carpeta = `${modulo}/mesa/${aliasPara}`;
  const abs = path.join(raiz, ...carpeta.split('/'));
  const n = siguienteN(L, raiz, carpeta, abs, fecha);
  const ruta = `${carpeta}/${fecha}-${n}-${a.tipo}.md`;
  const fallas = L.M.validar(texto, { ruta, carpeta: L.docs.deRaiz(raiz) });
  if (fallas.length) return no(...fallas.map((f) => `mesa: no lo escribo — ${f.que} — ${f.hacer}`));

  const avisos = [];
  // Una RESPUESTA cita algo que git tiene (un mensaje es dato hasta que git lo respalda); un acuerdo se firma una vez (G §7.1).
  if (a.tipo === 'RESPUESTA') {
    avisos.push(...L.M.traer(raiz, [...conOrigin(L, raiz), ...L.M.remotosAlias(raiz)]));
    const msgs = L.M.todos(raiz);
    const k = (() => {
      const p = L.M.parsearCita(c['responde-a']);
      return p ? `${p.alias}:${p.ruta}` : null;
    })();
    const citado = msgs.find((m) => m.clave === k);
    if (!citado) return no(...avisos, `mesa: responde-a cita ${c['responde-a']}, que git no tiene — traelo (git remote add <alias> <url>; git fetch <alias>) o corregí la cita`);
    if (c.resultado === 'aceptado' && citado.tipo === 'PROPUESTA') {
      const ya = (L.M.estado(msgs).respuestasA.get(k) || []).find((r) => r.cab.resultado === 'aceptado');
      if (ya) return no(...avisos, `mesa: esa PROPUESTA ya está aceptada en ${ya.clave}@${ya.sha.slice(0, 12)} — un acuerdo se firma una sola vez (G §7.1)`);
    }
  }

  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(raiz, ...ruta.split('/')), texto, { flag: 'wx' });
  const add = G(L, raiz, ['add', '--', ruta]);
  const tema = c.tema;
  const cm = add.ok ? G(L, raiz, ['commit', '-q', '-m', `mesa: ${a.tipo} a ${aliasPara} · ${tema}`, '--', ruta]) : add;
  if (!cm.ok) {
    return no(...avisos, `mesa: escribí ${ruta} pero no lo pude commitear (${(cm.stderr || cm.error || '').trim().split('\n').pop()}) — arreglalo y commitealo antes de mandar el aviso`);
  }
  const sha = L.git.texto(['rev-parse', 'HEAD'], { cwd: raiz });
  if (L.git.correr(['remote', 'get-url', 'origin'], { cwd: raiz }).ok) {
    const p = G(L, raiz, ['push', '-q', 'origin', 'HEAD'], 120000);
    if (!p.ok) return no(...avisos, `mesa: ${ruta} quedó commiteado (@${sha.slice(0, 12)}) pero no subió a origin — subilo (git push) antes de mandar el aviso: sin push el otro lado no lo ve`);
  } else avisos.push('mesa: este repo no tiene origin — el otro lado no lo va a ver hasta que lo subas');
  return { codigo: 0, lineas: [...avisos, `${a.tipo} · ${yo} → ${aliasPara} · ${tema} · ${yo}:${ruta}@${sha.slice(0, 12)}`] };
}

// ---------------------------------------------------------------- abiertos, acordados, huella

const conOrigin = (L, raiz) => (L.git.correr(['remote', 'get-url', 'origin'], { cwd: raiz }).ok ? ['origin'] : []);

function abiertos(L, g, a, opciones) {
  const raiz = g.raiz;
  const ahora = opciones.ahora || new Date();
  const avisos = L.M.traer(raiz, [...conOrigin(L, raiz), ...L.M.remotosAlias(raiz)]);
  const msgs = L.M.todos(raiz);
  if (a.hilo !== undefined) {
    const h = L.M.hilo(msgs, a.hilo);
    if (!h) return { codigo: 1, lineas: [...avisos, `mesa: no encuentro el hilo ${a.hilo} — pasá el nombre del archivo, la ruta o <alias>:<ruta>`] };
    const est = L.M.estado(msgs);
    return {
      codigo: 0,
      lineas: [...avisos, ...h.map((m) => {
        if (est.abiertos.includes(m)) return L.M.lineaAbierto(m, ahora);
        const r = m.tipo === 'RESPUESTA' ? ` · ${m.cab.resultado}` : '';
        return `${L.M.dia(m.fecha)} · ${m.tipo} · ${m.de} → ${m.para} · ${m.cab.tema} · ${m.clave}@${m.sha.slice(0, 12)}${r}`;
      })],
    };
  }
  const ab = L.M.estado(msgs).abiertos;
  return { codigo: 0, lineas: [...avisos, ...(ab.length ? ab.map((m) => L.M.lineaAbierto(m, ahora)) : ['— (nada abierto)'])] };
}

function acordados(L, g, a, opciones) {
  const hoy = L.M.dia(opciones.ahora || new Date());
  const ac = L.M.estado(L.M.todos(g.raiz)).acordados.filter((x) => !a.hoy || L.M.dia(x.firma.fecha) === hoy);
  return { codigo: 0, lineas: ac.length ? ac.map(L.M.lineaAcordado) : ['— (sin acuerdos)'] };
}

function huella(L, g, a, opciones) {
  const lineas = [];
  let ref = null;
  if (a.sha) {
    ref = L.M.huellaEnRef(g.raiz, a.sha, a.carpeta);
    if (!ref.ok && L.M.remotosAlias(g.raiz).includes(a.alias)) {
      lineas.push(...L.M.traer(g.raiz, [a.alias]));
      ref = L.M.huellaEnRef(g.raiz, a.sha, a.carpeta);
    }
    if (!ref.ok) return { codigo: 1, lineas: [...lineas, `mesa: ${ref.por}`] };
    lineas.push(`huella ${a.alias}@${a.sha.slice(0, 12)} ${a.carpeta}: ${ref.hash} (${ref.n} archivos)`);
  }
  if (a.copia !== undefined) {
    const c = L.M.huellaEnCarpeta(path.resolve(opciones.cwd || process.cwd(), a.copia));
    if (!c.ok) return { codigo: 1, lineas: [...lineas, `mesa: ${c.por}`] };
    lineas.push(`huella copia ${a.copia}: ${c.hash} (${c.n} archivos)`);
    if (ref) {
      if (ref.hash !== c.hash) return { codigo: 1, lineas: [...lineas, 'NO coinciden: tu copia no es la del dueño a ese SHA — traé la copia de nuevo'] };
      lineas.push('coinciden');
    }
  }
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- main

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  let r;
  try {
    const L = libs();
    const a = leerArgumentos(argv, L);
    const g = L.contexto.datosGit(opciones.cwd || process.cwd());
    if (!g) r = { codigo: 1, lineas: ['mesa: no estás dentro de un repo git'] };
    else r = { nuevo, abiertos, acordados, huella }[a.comando](L, g, a, opciones);
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    if (opciones.depurar) throw e;
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

module.exports = { USO, ROTO, leerArgumentos, main };
