'use strict';
// estructura.cjs — el candado de estructura (B §14; SPEC-0 6.1; SPEC-paquete-2 P6.1 y F4). Uso, desde el repo:
//   node .claude/scripts/estructura.cjs [todo | parcial | <id>…] [--molde <dir> [--molde-viejo <dir>]] [--sin-log]
//   node .claude/scripts/estructura.cjs barreras (--indice | --rango <a>..<b>) [--molde <dir> [--molde-viejo <dir>]] [--sin-log]
// Los diez ids: raiz · rutas · topes · mesa · estados · lecturas · estado-viejo · barreras · datos · portada (con o sin "candado:").
// `todo` (o nada) = los nueve de siempre y, solo si la ficha tiene piezas.portada (y no es `no`), el décimo, portada; `parcial` = topes (solo el handoff) y barreras. Entero si piezas.candado de la ficha vigente no es
// `no`; si no, solo barreras, que corre desde que hay ficha. Quitables con hasta: vigente en frenos.quitados, salvo barreras.
// --molde: el molde de afuera para la exención (a) de barreras; lo pasa SOLO rehacer.sh (r3-1; y el actualizador del orden 6).
// --molde-viejo (solo junto con --molde; sin él, mal llamado): el molde del que viene el proyecto. Con él, lo que el molde nuevo
// retira (una regla del settings, un archivo) puede irse si el proyecto lo tenía igual al molde viejo; sin él, eso frena (no se
// distingue de algo propio). --sin-log: solo para pruebas.
// Los githooks (P4.6), solo con `barreras` (con otro chequeo, o los dos juntos, es mal llamado): --indice juzga SOLO el índice, lo que
// lleva el commit en curso (pre-commit y pre-merge-commit; lo del disco sin `git add` no traba, rf-10); --rango <a>..<b> juzga cada
// commit de a..b, lo que sube el push (pre-push; rf-7): vacío = verde, y un extremo que no es un commit del repo = mal llamado (2).
// Una ref nueva va con el sha de ceros que le da git al pre-push (<ceros>..<b>): los commits de b que ningún remoto tiene, sin el
// primer commit del repo (no tenía un antes).
// Salidas: 0 verde · 1 una línea `candado:<id> · qué pasa · qué hacer` por falla (candado:lecturas lista y no cambia la salida),
// o `candado roto: corré doctor` si algo propio falla (nunca 0) · 2 mal llamado. La ficha vigente rota no da 1 sola: imprime
// `ficha rota: <archivo>:<línea> — corré doctor (corro con los frenos de fábrica)` y corre todo, sin frenos quitados (rf-9). Sin node no arranca y no da 0:
// /cierre no commitea sin la salida de este script (lo dice la skill). Cada frenada deja su renglón en .claude/frenos.log.
// La lógica vive en .claude/hooks/lib/ (candado.cjs, barreras.cjs): es barrera, y este script también (r4-3).
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');

const USO =
  'Uso: node .claude/scripts/estructura.cjs [todo | parcial | <id>…] [--molde <dir> [--molde-viejo <dir>]] [--sin-log]   (desde el repo)\n' +
  '     node .claude/scripts/estructura.cjs barreras (--indice | --rango <a>..<b>) [--molde <dir> [--molde-viejo <dir>]] [--sin-log]';
const ROTO = 'candado roto: corré doctor';
const IDS = ['raiz', 'rutas', 'topes', 'mesa', 'estados', 'lecturas', 'estado-viejo', 'barreras', 'datos', 'portada'];

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

// → { modo: 'todo' | 'parcial' | 'ids', ids, molde, log } y, solo si vinieron, moldeViejo (texto), indice: true o rango: { desde,
// hasta } (texto).
function leerArgumentos(argv) {
  let molde = null;
  let moldeViejo = null;
  let log = true;
  let indice = false;
  let rango = null;
  const sueltos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--molde') {
      if (molde !== null) malLlamado('--molde va una sola vez.');
      if (i + 1 >= argv.length || argv[i + 1] === '' || argv[i + 1].startsWith('-')) malLlamado('--molde pide una carpeta.');
      molde = argv[++i];
    } else if (a === '--molde-viejo') {
      if (moldeViejo !== null) malLlamado('--molde-viejo va una sola vez.');
      if (i + 1 >= argv.length || argv[i + 1] === '' || argv[i + 1].startsWith('-')) malLlamado('--molde-viejo pide una carpeta.');
      moldeViejo = argv[++i];
    } else if (a === '--sin-log') {
      log = false;
    } else if (a === '--indice') {
      if (indice) malLlamado('--indice va una sola vez.');
      indice = true;
    } else if (a === '--rango') {
      if (rango !== null) malLlamado('--rango va una sola vez.');
      rango = partirRango(argv[++i]); // sin valor: undefined, que no tiene la forma
      if (!rango) malLlamado('--rango pide <a>..<b> (dos puntos, sin lados vacíos).');
    } else if (a.startsWith('-')) {
      malLlamado(`Argumento desconocido: ${a}`);
    } else sueltos.push(a);
  }
  if (moldeViejo !== null && molde === null) malLlamado('--molde-viejo va solo junto con --molde (el molde nuevo).');
  const r = sueltosA(sueltos);
  if (indice || rango) {
    if (indice && rango) malLlamado('--indice y --rango no van juntos: uno es el pre-commit y el otro el pre-push.');
    if (r.modo !== 'ids' || r.ids.join() !== 'barreras') malLlamado('--indice y --rango van solo con barreras (y nada más).');
  }
  return { ...r, molde, log, ...(moldeViejo !== null ? { moldeViejo } : {}), ...(indice ? { indice } : {}), ...(rango ? { rango } : {}) };
}
// <a>..<b> → { desde, hasta } o null (ni a...b, ni un lado vacío, con espacios o que empiece con -).
function partirRango(texto) {
  const s = String(texto);
  if (s.includes('...')) return null;
  const p = s.split('..');
  if (p.length !== 2 || p.some((x) => x === '' || x.startsWith('-') || /\s/.test(x))) return null;
  return { desde: p[0], hasta: p[1] };
}
function sueltosA(sueltos) {
  if (!sueltos.length || (sueltos.length === 1 && sueltos[0] === 'todo')) return { modo: 'todo', ids: IDS.slice() };
  if (sueltos.length === 1 && sueltos[0] === 'parcial') return { modo: 'parcial', ids: [] };
  const ids = [];
  for (const s of sueltos) {
    const id = s.startsWith('candado:') ? s.slice('candado:'.length) : s;
    if (!IDS.includes(id)) malLlamado(`Id desconocido: ${s} (los que hay: ${IDS.join(', ')})`);
    if (!ids.includes(id)) ids.push(id);
  }
  return { modo: 'ids', ids };
}

function libs() {
  return {
    contexto: require('../hooks/lib/contexto.cjs'),
    candado: require('../hooks/lib/candado.cjs'),
  };
}

// main(argv, {cwd, salida, error, ahora, home}) → la salida (0 · 1 · 2).
function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  const cwd = opciones.cwd || process.cwd();
  let a;
  try {
    a = leerArgumentos(argv);
    for (const [k, bandera] of [['molde', '--molde'], ['moldeViejo', '--molde-viejo']]) {
      if (a[k] === null || a[k] === undefined) continue;
      const abs = path.resolve(cwd, a[k]);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        st = null;
      }
      if (!st || !st.isDirectory()) malLlamado(`${bandera}: esa carpeta no existe.`);
      a[k] = abs;
    }
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    salida(`${ROTO}\n`);
    return 1;
  }
  let r;
  try {
    const L = libs();
    const raiz = L.contexto.raiz(cwd);
    let rango;
    if (raiz && a.rango) {
      // Los dos extremos tienen que ser commits de este repo: si no, es mal llamado (el pre-push pasó algo que no sirve).
      const v = L.candado.resolverRango(raiz, a.rango);
      if (v.error) {
        error(`${v.error}\n${USO}\n`);
        return 2;
      }
      rango = v;
    }
    if (!raiz) r = { codigo: 1, lineas: ['estructura: no estás dentro de un repo git'] };
    else r = L.candado.correr(raiz, { modo: a.modo, ids: a.ids, molde: a.molde || undefined, moldeViejo: a.moldeViejo || undefined, indice: !!a.indice, rango, log: a.log, ahora: opciones.ahora, home: opciones.home });
    if (!r || ![0, 1].includes(r.codigo) || !Array.isArray(r.lineas)) throw new Error('salida inesperada');
  } catch (e) {
    salida(`${ROTO}\n`);
    return 1;
  }
  if (r.lineas.length) salida(`${r.lineas.join('\n')}\n`);
  return r.codigo;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USO, ROTO, IDS, leerArgumentos, partirRango, libs, main };
