'use strict';
// barreras.cjs — candado:barreras (SPEC-0 P4.6 y P6.1; SPEC-paquete-2 "D2.2 — AGREGA" P6.1 y el bloque F4; red team rondas 1 a 5):
// ningún commit toca un freno sin el `aprobado` sellado del dueño que lo nombre. Lo corre scripts/estructura.cjs (vía candado.cjs).
// Vive bajo .claude/hooks/** a propósito: su lógica es barrera (r4-3).
//
// Qué mira: el rango de la sesión (rango()) commit por commit, y lo pendiente (índice y disco) como un commit más. Dos modos más
// (P4.6, los githooks): con `indice`, SOLO el índice (lo que lleva el commit en curso; lo del disco sin `git add` no traba, rf-10),
// contra HEAD o, en un merge en curso (MERGE_HEAD), contra cada padre como un merge commiteado; con `rango` ({desde, hasta}), SOLO
// los commits de desde..hasta (lo que sube un push; rf-7), con la misma lógica por commit.
// Por commit: las barreras que toca, POR ARCHIVO (las categorías y los ids de cambios.cjs: categoriaDe, idsFicha, idsSettings),
// menos lo que cubre una exención; lo que queda lo tiene que cubrir la unión de los cambios válidos (toca ⊇ categorías, ids ⊇ ids).
// Cambio válido para un commit X: 3-barrera con el sello en orden (cambios.validar + cambios.validarSello, las reglas de verificar),
// sello anterior a X, y X es el PRIMER commit después del sello que toca su `toca` (un aprobado = un commit); con `aplicado`, además,
// su `sha` es X (r5-1: reapuntar el sha no tapa otro commit). Un `subio-al-kit` cuenta igual que un `aplicado` (SPEC-paquete-7 r1-7).
// Exenciones, solo dos: (a) con --molde, el archivo sin su zona propia es igual al del molde (el settings, regla por regla); con
// --molde-viejo, además, lo que el molde nuevo retira puede irse si el proyecto lo tenía igual al molde viejo; (b) el commit que
// crea la ficha por primera vez, con frenos, sensible y autorizado iguales a la fábrica del nivel EN EL ÁRBOL DEL PADRE.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const git = require('./git.cjs');
const contexto = require('./contexto.cjs');
const ficha = require('./ficha.cjs');
const C = require('./cambios.cjs');
const rutaCambio = require('./cambios-ruta.cjs');
const zona = require('./zona-propia.cjs');
const { NIVELES } = require('./fabrica.cjs');

const ID = 'candado:barreras';
const PENDIENTE = 'pendiente';
// Solo el índice (el pre-commit y el pre-merge-commit): un "commit más" como lo pendiente, sin el disco.
const INDICE = 'indice';
const esPendiente = (cual) => cual === PENDIENTE || cual === INDICE;
// La base de scripts/todo.cjs: el último commit que tocó el handoff (el cierre anterior). todo.cjs no la exporta: es este git log.
// Esta es la de docs/; la de cada corrida está en la carpeta de papeles de la ficha vigente (rutaHandoff; 8r3 i1).
const RUTA_HANDOFF = 'docs/SESSION_HANDOFF.md';
// Sin cache por proceso (docs-ruta.deRaiz guarda): rango() decide qué commits se juzgan y la ficha puede cambiar en la misma corrida.
const rutaHandoff = (raiz) => {
  const D = require('./docs-ruta.cjs'); // tardío: docs-ruta requiere este archivo cuando la ficha vigente está rota
  return D.rel(D.deVigente(contexto.fichaVigente(raiz), raiz), 'SESSION_HANDOFF.md');
};
// Las fichas de fábrica, como quedan instanciadas (kit/molde/hooks/lib/fabrica/ → .claude/hooks/lib/fabrica/; F1).
const CARPETA_FABRICA = '.claude/hooks/lib/fabrica';
// La ficha del padre rota: se compara contra la última que se lee, hasta tantos commits atrás.
const ATRAS = 20;

const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const aTexto = (b) => (b == null ? null : Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
const partirZ = (t) => (t ? t.split('\0').filter((x) => x !== '') : []);
const corto = (sha) => String(sha).slice(0, 12);

// Igualdad de valores JSON: el orden de las claves no importa; el de las listas, sí (la misma de cambios.cjs y zona-propia.cjs).
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (esMapa(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- git

function shaDe(raiz, rev) {
  return git.texto(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { cwd: raiz });
}
function padres(raiz, sha) {
  const t = git.texto(['rev-list', '--parents', '-n', '1', sha], { cwd: raiz });
  return t ? t.split(/\s+/).slice(1) : [];
}
// <rev>:<ruta> como Buffer, o null si no está. rev '' = el índice.
function blob(raiz, rev, rel) {
  const r = git.correr(['cat-file', 'blob', `${rev}:${rel}`], { cwd: raiz });
  return r.ok ? r.salida : null;
}
function esAncestro(raiz, a, b) {
  return git.correr(['merge-base', '--is-ancestor', a, b], { cwd: raiz }).ok;
}
function leerDisco(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return Buffer.from(fs.readlinkSync(abs), 'utf8');
    if (!st.isFile()) return null;
    return fs.readFileSync(abs);
  } catch (e) {
    return null;
  }
}
function lista(raiz, args) {
  const r = git.correr(args, { cwd: raiz, tiempo: 20000 });
  if (!r.ok) throw new Error(`git ${args[0]} no anduvo`);
  return r;
}

// Las rutas que cambian del commit <padre> al índice (sin HEAD, <padre> es el antes de la rama huérfana: antesVirtual).
function rutasIndice(raiz, padre) {
  return partirZ(lista(raiz, ['diff', '--cached', '--no-renames', '--name-only', '-z', padre]).stdout).sort();
}
// Los otros padres de un merge en curso: los SHA de MERGE_HEAD (uno por renglón; varios en un octopus), o [] si no hay merge.
function mergeHeads(raiz) {
  const donde = git.texto(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: raiz });
  if (!donde) throw new Error('git rev-parse no anduvo');
  let t;
  try {
    t = fs.readFileSync(path.resolve(raiz, donde), 'utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const l of t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const sha = shaDe(raiz, l);
    if (!sha) throw new Error('MERGE_HEAD no se lee');
    if (!out.includes(sha)) out.push(sha);
  }
  return out;
}

// ---------------------------------------------------------------- lo que no tiene padre (rf2-5)

// El antes de lo que no tiene padre: el índice y lo pendiente sin HEAD, o un commit raíz. "Sin ningún commit" es sin HEAD Y sin
// ninguna rama (refs/heads, refs/remotes): ahí no hay antes (null) y no se juzga (G6, r4-5). Con ramas (un checkout --orphan o un
// worktree add --orphan en un repo con historia), se juzga como un commit cualquiera cuyo padre es la ref vigente; sin vigente, la
// rama de commit más reciente (rf2-5: si no, la huérfana sube sin juzgar y un merge del lado del servidor no lo caza nadie).
// Un commit raíz que es de la historia de la vigente (el primer commit del repo) no tiene antes: null; sin vigente, solo tiene
// antes si alguna rama no lo contiene (el primer push de un proyecto nuevo queda verde).
function antesVirtual(raiz, cual, memo = {}) {
  if (!memo.virtuales) memo.virtuales = new Map();
  if (memo.virtuales.has(cual)) return memo.virtuales.get(cual);
  let v = null;
  const raizSha = esPendiente(cual) ? null : cual;
  if (raizSha ? padres(raiz, raizSha).length === 0 : !shaDe(raiz, 'HEAD')) {
    const rv = contexto.refVigente(raiz);
    const vig = rv ? shaDe(raiz, rv.ref) : null;
    if (vig) v = raizSha && esAncestro(raiz, raizSha, vig) ? null : vig;
    else {
      const args = ['for-each-ref', '--count=1', '--sort=-committerdate', '--format=%(objectname)'];
      if (raizSha) args.push(`--no-contains=${raizSha}`);
      const t = lista(raiz, [...args, 'refs/heads', 'refs/remotes']).stdout.trim();
      v = t ? shaDe(raiz, t) : null;
    }
  }
  memo.virtuales.set(cual, v);
  return v;
}
// Las rutas de lo pendiente contra <antes> sin HEAD (C.rutasPendientes compara con HEAD): el disco y el índice contra <antes>,
// lo no seguido y lo ignorado de barrera.
function rutasPendientesContra(raiz, antes) {
  const rutas = new Set();
  for (const args of [['diff', '--no-renames', '--name-only', '-z', antes], ['diff', '--cached', '--no-renames', '--name-only', '-z', antes], ['ls-files', '--others', '--exclude-standard', '-z']]) {
    partirZ(lista(raiz, args).stdout).forEach((x) => rutas.add(x));
  }
  C.ignoradosDeBarrera(raiz).forEach((x) => rutas.add(x));
  return [...rutas].sort();
}

// ---------------------------------------------------------------- el rango

// rango(raiz) → { commits: [sha] (del más viejo al más nuevo), desde, como }. Lo pendiente va siempre aparte.
//  · con remoto: origin/<rama por defecto>..HEAD (los commits anteriores de la sesión no se escapan);
//  · sin remoto, fuera de la rama por defecto: <rama por defecto>..HEAD;
//  · sin remoto, en la rama por defecto: desde la base de todo.cjs (el último commit que tocó el handoff) INCLUIDA (rf-4: si no, un
//    commit que toca el handoff y vacía los deny se lava solo), salvo que la base sea el primer commit del repo o el que creó la
//    ficha (la adopción): ahí, <base>..HEAD (r4-5: si no, el repo recién montado nace trabado); y nunca después del último commit
//    que cambió carpeta-docs: (8r3 rt-2: ese commit entra, con base o sin ella);
//  · sin base (o sin rama por defecto): solo lo pendiente (r4-5: si no, el commit que creó el settings da rojo siempre). Sin commits,
//    ni eso: lo pendiente sin HEAD se juzga contra la vigente si hay ramas (rf2-5) y, sin ninguna, no se juzga (D3.3).
function rango(raiz) {
  const head = shaDe(raiz, 'HEAD');
  if (!head) return { commits: [], desde: null, como: 'sin commits: solo lo pendiente' };
  const rv = contexto.refVigente(raiz);
  let desde = null;
  let como;
  if (rv && rv.origen !== 'local') {
    desde = rv.ref;
    como = `origin/${rv.nombre}..HEAD`;
  } else if (rv) {
    if (contexto.rama(raiz) !== rv.nombre) {
      desde = rv.ref;
      como = `${rv.nombre}..HEAD (sin remoto)`;
    } else {
      const base = git.texto(['log', '-1', '--format=%H', '--', rutaHandoff(raiz)], { cwd: raiz });
      if (base) {
        const ps = padres(raiz, base);
        if (!ps.length || esAdopcion(raiz, base, ps)) {
          desde = base;
          como = `desde el último cierre, sin él (${ps.length ? 'es el que creó la ficha' : 'es el primer commit'}; sin remoto)`;
        } else {
          desde = ps[0];
          como = 'desde el último cierre, con él (sin remoto)';
        }
      } else como = 'sin remoto y sin base: solo lo pendiente';
      // 8r3 rt-2: la base sale de <carpeta>/SESSION_HANDOFF.md, y la carpeta la decide la ficha: un commit que cambia carpeta-docs:
      // movería la base (a una carpeta sin handoff, o a un handoff creado después) y se sacaría solo del rango. La base nunca es
      // posterior a ese commit: entra al rango. La ficha que nace con la clave (la adopción) no cuenta: la cubre esAdopcion.
      const z = ultimoCambioDeCarpeta(raiz);
      const zp = z ? padres(raiz, z)[0] : null;
      if (zp && (!desde || !esAncestro(raiz, desde, zp))) {
        desde = !desde || esAncestro(raiz, zp, desde) ? zp : git.texto(['merge-base', desde, zp], { cwd: raiz }) || zp;
        como = `desde el último cambio de carpeta-docs:, con él (${corto(z)}; sin remoto)`;
      }
    }
  } else como = 'sin rama por defecto: solo lo pendiente';
  if (!desde) return { commits: [], desde: null, como };
  const r = lista(raiz, ['rev-list', '--reverse', '--topo-order', `${desde}..HEAD`]);
  return { commits: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean), desde, como };
}

// El sha de ceros que git le pasa al pre-push por una ref que el remoto no tiene (40 en sha1, 64 en sha256).
const esCeros = (x) => /^0+$/.test(String(x)) && [40, 64].includes(String(x).length);
// resolverRango(raiz, {desde, hasta}) → { desde: sha, hasta: sha } o { error }: los dos extremos tienen que ser commits del repo.
// Una ref nueva (desde = el sha de ceros, como lo da el pre-push): { desde: null, hasta }, y sus commits son los que ningún remoto
// tiene (`rev-list <hasta> --not --remotes`, P4.6).
function resolverRango(raiz, r) {
  const nueva = esCeros(r.desde);
  const desde = nueva ? null : shaDe(raiz, r.desde);
  if (nueva) {
    const h = shaDe(raiz, r.hasta);
    return h ? { desde: null, hasta: h } : { error: `--rango: ${r.hasta} no es un commit de este repo` };
  }
  if (!desde) return { error: `--rango: ${r.desde} no es un commit de este repo` };
  const hasta = shaDe(raiz, r.hasta);
  if (!hasta) return { error: `--rango: ${r.hasta} no es un commit de este repo` };
  return { desde, hasta };
}
// Los commits de desde..hasta (o, con desde null, los de hasta que ningún remoto tiene), del más viejo al más nuevo. u9 (D8r.4,
// rt-u9-3 a): con una ref vigente del remoto (origin/<rama por defecto>), tampoco lo que ya está en ella: lo juzgó su push (si no,
// el push de una rama ya subida que mergeó main trae todo main, con lo de antes de la adopción). Sin vigente del remoto, como antes.
function commitsDelRango(raiz, r) {
  const rv = contexto.refVigente(raiz);
  const vig = rv && rv.origen !== 'local' ? shaDe(raiz, rv.ref) : null;
  const que = r.desde === null ? [r.hasta, '--not', '--remotes'] : [r.hasta, '--not', r.desde, ...(vig ? [vig] : [])];
  return lista(raiz, ['rev-list', '--reverse', '--topo-order', ...que]).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ¿<sha> es el commit que creó la ficha (la adopción)? La tiene, ninguno de sus padres la tiene y ningún commit anterior la tocó
// (borrada y vuelta a crear no es la adopción: ese commit sí se juzga).
function esAdopcion(raiz, sha, ps) {
  const R = contexto.RUTA_FICHA;
  if (blob(raiz, sha, R) === null || ps.some((p) => blob(raiz, p, R) !== null)) return false;
  const t = git.texto(['rev-list', '--full-history', '-n', '2', sha, '--', R], { cwd: raiz });
  return t !== null && t.split('\n').filter(Boolean).every((x) => x === sha);
}

// La carpeta de papeles que vale en <rev> (8r3 i1): la de su ficha; sin ficha, docs; rota, la de la última que se lee (rt-10).
function carpetaEnRev(raiz, rev) {
  let l = leerFicha(blob(raiz, rev, contexto.RUTA_FICHA));
  if (l && l.rota) {
    const u = ultimaFichaQueSeLee(raiz, rev);
    l = u ? leerFicha(u.texto) : null;
  }
  return ficha.carpetaDocs(l && !l.rota ? l.datos : null);
}

// 8r3 rt-2: el último commit de HEAD que cambió la carpeta de papeles que vale (ponerla, sacarla, cambiarla; borrar o volver a crear
// la ficha con otra), o null. Los candidatos son los que tocan un renglón `carpeta-docs:` de la ficha (git log -G: un solo git; sin
// la clave en la historia, ninguno y todo como antes). La ficha que nace con la clave (esAdopcion) no cuenta.
function ultimoCambioDeCarpeta(raiz) {
  const t = lista(raiz, ['log', '--full-history', '--topo-order', '--format=%H', '-G', '^carpeta-docs:', 'HEAD', '--', contexto.RUTA_FICHA]).stdout;
  for (const c of t.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const ps = padres(raiz, c);
    if (carpetaEnRev(raiz, c) === (ps.length ? carpetaEnRev(raiz, ps[0]) : ficha.CARPETA_DOCS)) continue;
    if (esAdopcion(raiz, c, ps)) continue;
    return c;
  }
  return null;
}

// ¿La ficha está en algún lado? En el disco, el índice, HEAD, la ficha vigente o el padre de algún commit del rango (r4-2:
// borrarla no apaga el candado). Con un rango explícito, también sus commits y sus padres (un push puede subir otra rama que HEAD).
// Sin ninguna, el candado entero está apagado.
function fichaEnAlgunLado(raiz, opciones = {}) {
  const R = contexto.RUTA_FICHA;
  if (fs.existsSync(path.join(raiz, ...R.split('/')))) return true;
  if (blob(raiz, '', R) !== null) return true;
  if (shaDe(raiz, 'HEAD') && blob(raiz, 'HEAD', R) !== null) return true;
  const rv = contexto.refVigente(raiz);
  if (rv && blob(raiz, rv.ref, R) !== null) return true;
  for (const c of rango(raiz).commits) for (const p of padres(raiz, c)) if (blob(raiz, p, R) !== null) return true;
  if (opciones.rango) {
    for (const c of commitsDelRango(raiz, opciones.rango)) for (const x of [c, ...padres(raiz, c)]) if (blob(raiz, x, R) !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------- qué toca cada archivo

// Los archivos de barrera que cambian en un commit o en lo pendiente (índice y disco contra HEAD, sin lo ignorado salvo lo de
// barrera, rf-6 b): [{ rel, cat, antes: Buffer|null, despues: [Buffer|null], padre: sha|null, padres? }]. Es la misma enumeración
// que hace cambios.toca por dentro (rutasPendientes, rutasContra), con categoriaDe de cambios.cjs; acá, archivo por archivo.
// Un merge (rf-3, rf-13, rf-18): las rutas que cambian contra cualquier padre, con `padres` y `bases` (las de git merge-base
// --all entre cada par de padres); tocaArchivo lo juzga contra cada padre y descuenta solo lo que trajo otro padre que lo cambió.
function archivosDe(raiz, cual, memo = {}) {
  let rutas;
  let padre;
  let ps = [];
  let bases = [];
  let despuesDe;
  // Las rutas que cambian contra un padre p (en un merge, contra cada uno).
  let rutasContraPadre = null;
  // rf2-5: sin padre, el antes de la rama huérfana (null si no hay: todo es nuevo, como antes).
  const virtual = antesVirtual(raiz, cual, memo);
  if (cual === PENDIENTE) {
    padre = shaDe(raiz, 'HEAD') || virtual;
    // 8r3 i3: antes de juntar lo ignorado de barrera, el caché de Python ignorado se borra (una vez por corrida: memo); lo dice
    // revisarBarreras. Solo acá: el índice y un --rango no miran lo ignorado.
    if (!memo.cachePython) memo.cachePython = C.limpiarCachePython(raiz);
    rutas = virtual ? rutasPendientesContra(raiz, virtual) : C.rutasPendientes(raiz, padre);
    despuesDe = (rel) => [blob(raiz, '', rel), leerDisco(path.join(raiz, ...rel.split('/')))];
  } else if (cual === INDICE) {
    // Solo el índice (rf-10): ni el disco, ni lo no seguido, ni lo ignorado (no van en el commit; los mira barreras a secas).
    padre = shaDe(raiz, 'HEAD') || virtual;
    ps = [padre, ...mergeHeads(raiz)];
    rutasContraPadre = (p) => rutasIndice(raiz, p);
    rutas = rutasIndice(raiz, padre);
    despuesDe = (rel) => [blob(raiz, '', rel)];
  } else {
    ps = padres(raiz, cual);
    padre = ps.length ? ps[0] : virtual;
    rutasContraPadre = (p) => C.rutasContra(raiz, cual, p);
    rutas = C.rutasContra(raiz, cual, padre);
    despuesDe = (rel) => [blob(raiz, cual, rel)];
  }
  if (ps.length > 1) {
    // rf-18: un merge se juzga contra CADA padre, así que entran las rutas que cambian contra cualquiera.
    const s = new Set(rutas);
    for (const p of ps.slice(1)) rutasContraPadre(p).forEach((x) => s.add(x));
    rutas = [...s];
    bases = ps.map((pi, i) => ps.map((pj, j) => (j === i ? [] : j < i ? null : C.basesDeMerge(raiz, pi, pj))));
    bases.forEach((fila, i) => fila.forEach((x, j) => (x === null ? (fila[j] = bases[j][i]) : null)));
  }
  return rutas
    .sort()
    .map((rel) => ({ rel, cat: C.categoriaDe(rel) }))
    .filter((f) => f.cat)
    // Lo que la huérfana no tiene no lo borra (un merge de historias sin relación no lo saca; una gh-pages sin .claude/ no
    // afloja nada): contra el antes virtual se juzga solo lo que trae.
    .filter((f) => !virtual || despuesDe(f.rel).some((x) => x !== null))
    .map((f) => {
      const e = { ...f, padre, antes: padre ? blob(raiz, padre, f.rel) : null, despues: despuesDe(f.rel) };
      if (ps.length > 1) {
        // padres: el antes de cada padre; bases[i][j]: las bases del merge entre el padre i y el j, con su antes.
        e.padres = ps.map((p, i) => ({ sha: p, antes: i === 0 ? e.antes : blob(raiz, p, f.rel) }));
        e.bases = bases.map((fila) => fila.map((bs) => bs.map((x) => ({ sha: x, antes: blob(raiz, x, f.rel) }))));
      }
      return e;
    });
}

// Las versiones de después que cambian algo: una igual a la del padre (en lo pendiente, el índice sin tocar es HEAD, o el archivo
// nuevo que está solo en el disco no está en el índice) no cambió nada y no se juzga.
const igual = (a, b) => (a === null || b === null ? a === b : Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
const nuevas = (f) => f.despues.filter((d) => !igual(d, f.antes));

function leerFicha(b) {
  const t = aTexto(b);
  if (t === null) return null;
  try {
    return { datos: ficha.leer(t).datos };
  } catch (e) {
    return { rota: true };
  }
}

// La última ficha que se lee yendo para atrás desde <rev> (hasta ATRAS commits que la tocaron): { sha, texto } o null.
function ultimaFichaQueSeLee(raiz, rev) {
  const t = git.texto(['rev-list', '-n', String(ATRAS), rev, '--', contexto.RUTA_FICHA], { cwd: raiz });
  for (const sha of (t || '').split('\n').filter(Boolean)) {
    const b = blob(raiz, sha, contexto.RUTA_FICHA);
    const l = leerFicha(b);
    if (l && !l.rota) return { sha, texto: b };
  }
  return null;
}

// Lo que toca UN archivo contra UN padre (f.padre, f.antes): { pares: Set de categoría·id, imposible: texto | null }.
function tocaContraUno(raiz, f) {
  let imposible = null;
  if (f.cat === 'ficha') {
    let antes = f.antes;
    const a = leerFicha(antes);
    if (a && a.rota) {
      // La ficha del padre rota: se compara contra la última que se lee (F4); si no hay ninguna, rojo.
      const u = f.padre ? ultimaFichaQueSeLee(raiz, f.padre) : null;
      if (u) antes = u.texto;
      else imposible = `la ficha del padre está rota y no hay una anterior que se lea (${ATRAS} commits atrás)`;
    }
    return { pares: C.paresArchivo('ficha', f.rel, antes, nuevas(f)), imposible };
  }
  if (f.cat === 'settings') return { pares: C.paresArchivo('settings', f.rel, f.antes, f.despues), imposible };
  // u9 (D8r.4): un hook, githook o gitleaks igual al de este padre no cambia nada contra él (si no, en un merge el lado del que vino
  // igual no lo descuenta nunca, ni "lo que cambió el otro desde la base" deja de contar lo que nadie cambió: rf-13 sigue).
  return { pares: nuevas(f).length ? C.paresArchivo(f.cat, f.rel, null, []) : new Set(), imposible };
}

// Lo que toca UN archivo: { cats: Set, ids: Set, imposible: texto | null }. imposible = rojo que ningún cambio cubre.
// En un merge (rf-3, rf-13, rf-18): contra CADA padre, lo que cambia menos lo que quedó igual a otro padre QUE LO CAMBIÓ respecto
// de todas las bases (cambios.descontarMerge); cuenta la unión. Un lado cuya ficha no se lee no descuenta nada, y contra un padre
// cuya ficha no se lee (ni la última), imposible.
function tocaArchivo(raiz, f) {
  if (!f.padres) {
    const uno = tocaContraUno(raiz, f);
    const r = C.desdePares(uno.pares);
    return { cats: new Set(r.categorias), ids: new Set(r.ids), imposible: uno.imposible };
  }
  const contra = f.padres.map((p) => tocaContraUno(raiz, { ...f, padre: p.sha, antes: p.antes }));
  const total = new Set();
  let imposible = null;
  f.padres.forEach((_, i) => {
    const otros = [];
    f.padres.forEach((pj, j) => {
      if (j === i) return;
      const bs = f.bases[i][j];
      const desdeBases = bs.map((x) => tocaContraUno(raiz, { ...f, padre: x.sha, antes: x.antes, despues: [pj.antes] }));
      const sinSaber = !bs.length || contra[j].imposible || desdeBases.some((x) => x.imposible);
      otros.push({ distinto: contra[j].pares, cambio: sinSaber ? null : C.interseccion(desdeBases.map((x) => x.pares)) });
    });
    C.descontarMerge(contra[i].pares, otros).forEach((x) => total.add(x));
    if (contra[i].imposible && !imposible) imposible = contra[i].imposible;
  });
  const r = C.desdePares(total);
  return { cats: new Set(r.categorias), ids: new Set(r.ids), imposible };
}

// ---------------------------------------------------------------- exención (b): la ficha nace con los valores de fábrica

// Los commits que tocaron la ficha en la historia de la rama por defecto (la vigente y la local) y de HEAD. Una vez por corrida.
function tocaronLaFicha(raiz, memo) {
  if (!memo.tocaron) {
    // Sin HEAD (una rama huérfana), la historia de las otras ramas igual cuenta (rf2-5).
    const refs = shaDe(raiz, 'HEAD') ? ['HEAD'] : [];
    const rv = contexto.refVigente(raiz);
    if (rv) refs.push(rv.ref);
    const rl = C.ramaLocal(raiz);
    if (rl && !refs.includes(rl.ref)) refs.push(rl.ref);
    // Con --rango, también la historia de lo que se sube (puede ser otra rama que HEAD).
    for (const x of memo.refsExtra || []) if (!refs.includes(x)) refs.push(x);
    const t = refs.length ? lista(raiz, ['log', '--full-history', '--format=%H', ...refs, '--', contexto.RUTA_FICHA]).stdout : '';
    memo.tocaron = [...new Set(t.split('\n').map((s) => s.trim()).filter(Boolean))];
  }
  return memo.tocaron;
}

// ¿La ficha existió antes de <cual>? Algún commit que la tocó y no es <cual> ni posterior a él (r4-2: (b) solo la primera vez).
function fichaExistioAntes(raiz, cual, memo) {
  // rf2-5: lo que no tiene padre, con la historia de su antes virtual (sin vigente puede ser una rama que tocaronLaFicha no mira).
  const v = antesVirtual(raiz, cual, memo);
  if (v && lista(raiz, ['rev-list', '-n', '1', v, '--', contexto.RUTA_FICHA]).stdout.trim()) return true;
  const t = tocaronLaFicha(raiz, memo);
  if (esPendiente(cual)) return t.length > 0;
  return t.some((y) => y !== cual && !esAncestro(raiz, cual, y));
}

// (b): el archivo es la ficha, el padre no la tenía, nunca existió antes, y cada versión nueva trae frenos, sensible y autorizado
// iguales a los de ficha.<nivel>.md DEL ÁRBOL DEL PADRE (si el padre no la tiene, no hay exención: la del commit se certificaría sola).
function exencionB(raiz, f, cual, memo) {
  if (f.cat !== 'ficha' || f.antes !== null || !f.padre) return false;
  if (fichaExistioAntes(raiz, cual, memo)) return false;
  for (const d of nuevas(f)) {
    const l = leerFicha(d);
    if (!l || l.rota || !NIVELES.includes(l.datos.nivel)) return false;
    const fab = leerFicha(blob(raiz, f.padre, `${CARPETA_FABRICA}/ficha.${l.datos.nivel}.md`));
    if (!fab || fab.rota) return false;
    for (const k of ['frenos', 'sensible', 'autorizado']) if (canon(l.datos[k]) !== canon(fab.datos[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- exención (a): el commit del actualizador, contra un molde de afuera

// La ruta de un archivo de barrera en el molde (Cómo se instancia el molde, al revés). githooks y gitleaks todavía no están en el
// molde (orden 3): se buscan en githooks/** y en la raíz del molde; si no están, no hay exención para ellos.
function rutaEnMolde(rel) {
  const r = String(rel).replace(/\\/g, '/');
  const m = r.toLowerCase();
  if (m.startsWith('.claude/hooks/')) return `hooks/${r.slice('.claude/hooks/'.length)}`;
  if (m.startsWith('.claude/scripts/')) return `scripts/${r.slice('.claude/scripts/'.length)}`;
  if (/^\.claude\/settings[^/]*\.json$/.test(m)) return r.slice('.claude/'.length);
  if (m.startsWith('.githooks/')) return `githooks/${r.slice('.githooks/'.length)}`;
  if (m === '.gitleaksignore' || m === '.gitleaks.toml') return r;
  return null;
}

// Lo de adentro de las zonas propias de un texto, o null si una marca está rota.
function contenidoZonas(b) {
  const z = zona.zonas(aTexto(b));
  return z.ok ? z.zonas.map((x) => x.contenido) : null;
}

// ¿Dos textos son el mismo del molde? Igual sin la zona propia (hashPieza) y con lo de adentro de las zonas igual.
function mismoTexto(a, b) {
  if (zona.hashPieza(a) !== zona.hashPieza(b)) return false;
  const za = contenidoZonas(a);
  const zb = contenidoZonas(b);
  return za !== null && zb !== null && canon(za) === canon(zb);
}

// Un texto (hook, script, githook, gitleaks): sin su zona propia igual al del molde, y la zona propia igual a la de antes
// (si el archivo es nuevo, a la del molde). Un hermano .propio.sh es lo propio del hook: tocarlo nunca es el molde.
// Borrado (d null): sin molde viejo (v undefined), vale si el molde nuevo tampoco lo trae (como antes de --molde-viejo); con molde
// viejo, además el viejo lo traía y el proyecto lo tenía igual a él (con su zona propia como la del viejo): el molde lo retira.
// Un archivo propio (el viejo no lo traía) o cambiado respecto del viejo, borrado, ya no pasa por (a).
function textoComoElMolde(f, d, m, v) {
  if (/\.propio\.sh$/i.test(f.rel)) return false;
  if (d === null) {
    if (m !== null) return false;
    if (v === undefined) return true;
    return v !== null && f.antes !== null && mismoTexto(f.antes, v);
  }
  if (m === null) return false;
  if (zona.hashPieza(d) !== zona.hashPieza(m)) return false;
  const zd = contenidoZonas(d);
  const zr = contenidoZonas(f.antes !== null ? f.antes : m);
  return zd !== null && zr !== null && canon(zd) === canon(zr);
}

// Las reglas de un settings por id: Map(id → canon de lo que dice).
function reglasPorId(valor) {
  const m = new Map();
  for (const r of zona.reglas(valor)) {
    const c = r.tipo === 'hook' ? canon(r.entrada) : r.texto;
    m.set(r.id, m.has(r.id) ? `${m.get(r.id)}\n${c}` : c);
  }
  for (const [k, v] of m) m.set(k, v.split('\n').sort().join('\n'));
  return m;
}
const leerJson = (b) => {
  const t = aTexto(b);
  if (t === null) return { valor: null };
  const r = zona.leerJsonSinDuplicados(t);
  return r.ok && esMapa(r.valor) ? { valor: r.valor } : { roto: true };
};

// Un settings molde+propio (criterio 20): regla por regla, lo del molde está igual (salvo lo quitado, que queda como estaba o como
// el molde), lo propio (lo que el molde nuevo no trae) quedó igual que antes, y cada otra clave es la de antes o la del molde.
// Una regla que el molde nuevo retira (la trae el viejo y el nuevo no) solo puede irse con el molde viejo (v, de --molde-viejo) y si
// el proyecto la tenía IGUAL a la del viejo (lo que hace mezclarSettings: la retira solo así). Sin el molde viejo no se distingue
// de una regla del proyecto: cuenta como "lo propio cambió" y ese commit no pasa por (a). La que el proyecto había cambiado respecto
// del viejo, o la que el viejo no traía (propia), tiene que quedar igual que antes, con o sin molde viejo. v: undefined = sin
// --molde-viejo; null = el molde viejo no trae settings (no retira nada); que no se lea = no hay exención.
function settingsComoElMolde(f, d, m, quitados, v) {
  if (d === null) return m === null;
  if (m === null) return false;
  const D = leerJson(d);
  const M = leerJson(m);
  const A = f.antes === null ? { valor: {} } : leerJson(f.antes);
  const V = v === undefined ? { valor: null } : leerJson(v);
  if (D.roto || M.roto || A.roto || V.roto || !D.valor || !M.valor) return false;
  const rd = reglasPorId(D.valor);
  const rm = reglasPorId(M.valor);
  const ra = reglasPorId(A.valor);
  const rv = V.valor ? reglasPorId(V.valor) : new Map();
  for (const id of new Set([...rd.keys(), ...rm.keys(), ...ra.keys()])) {
    const vd = rd.get(id);
    if (rm.has(id)) {
      if (quitados.has(id) ? vd !== ra.get(id) && vd !== rm.get(id) : vd !== rm.get(id)) return false;
    } else if (vd !== ra.get(id)) {
      // Retirada por el molde: se fue entera, el viejo la traía y el proyecto la tenía como el viejo.
      if (!(vd === undefined && rv.has(id) && ra.get(id) === rv.get(id))) return false;
    }
  }
  // Las demás claves (y las de permissions que no son allow, ask ni deny): la de antes o la del molde.
  const claves = (o, sub) => (esMapa(o) ? Object.keys(o).filter((k) => (sub ? !['allow', 'ask', 'deny'].includes(k) : k !== 'hooks')) : []);
  const otra = (vd, va, vm) => canon(vd) === canon(va) || canon(vd) === canon(vm);
  for (const k of new Set([...claves(D.valor), ...claves(M.valor), ...claves(A.valor)])) {
    if (k === 'permissions' && [D, M, A].every((x) => x.valor[k] === undefined || esMapa(x.valor[k]))) {
      const pd = D.valor[k] || {};
      const pm = M.valor[k] || {};
      const pa = A.valor[k] || {};
      for (const j of new Set([...claves(pd, true), ...claves(pm, true), ...claves(pa, true)])) if (!otra(pd[j], pa[j], pm[j])) return false;
      continue;
    }
    if (!otra(D.valor[k], A.valor[k], M.valor[k])) return false;
  }
  return true;
}

// Los frenos quitados (ids normalizados) de la ficha que deja el commit (lo pendiente: la del disco, o la del índice).
function quitadosDe(raiz, cual) {
  const R = contexto.RUTA_FICHA;
  const b = cual === PENDIENTE ? leerDisco(path.join(raiz, ...R.split('/'))) || blob(raiz, '', R) : blob(raiz, cual === INDICE ? '' : cual, R);
  const l = leerFicha(b);
  const q = l && !l.rota && esMapa(l.datos.frenos) && Array.isArray(l.datos.frenos.quitados) ? l.datos.frenos.quitados : [];
  return new Set(q.map((x) => (esMapa(x) ? x.id : x)).filter((x) => typeof x === 'string').map(zona.normalizarId));
}

// (a): solo con --molde. La ficha no se compara contra el molde: lo que se le exige (frenos, sensible y autorizado iguales, y
// nivel y las dos piezas sin aflojar) ya es lo que miden sus ids; si cambia algo de eso, cuenta y lo tiene que cubrir un cambio.
// viejo (--molde-viejo, solo junto con molde): el molde del que viene el proyecto; deja ir lo que el nuevo retira (ver arriba).
function exencionA(raiz, f, cual, molde, memo, viejo) {
  if (!molde || f.cat === 'ficha') return false;
  const enMolde = rutaEnMolde(f.rel);
  if (!enMolde) return false;
  const m = leerDisco(path.join(molde, ...enMolde.split('/')));
  const v = viejo ? leerDisco(path.join(viejo, ...enMolde.split('/'))) : undefined;
  if (f.cat === 'settings') {
    if (!memo.quitados) memo.quitados = new Map();
    if (!memo.quitados.has(cual)) memo.quitados.set(cual, quitadosDe(raiz, cual));
    return nuevas(f).every((d) => settingsComoElMolde(f, d, m, memo.quitados.get(cual), v));
  }
  return nuevas(f).every((d) => textoComoElMolde(f, d, m, v));
}

// ---------------------------------------------------------------- los cambios válidos y a qué commit cubren

// Los 3-barrera aprobados o aplicados con el sello en orden (las reglas de verificar: validar y validarSello). Una vez por corrida.
// Un subio-al-kit entra como aplicado (r1-7): cubre su commit y solo ese, y el arreglo del rebase (rebaseados) lo ve igual.
function cambiosValidos(raiz, memo) {
  if (!memo.validos) {
    const rama = C.ramaLocal(raiz);
    memo.validos = [];
    for (const a of C.listarArchivos(raiz)) {
      if (!a.id) continue;
      const c = C.cargar(a);
      if (c.error) continue;
      const d = c.datos;
      if (d.clase !== '3-barrera' || (d.estado !== 'aprobado' && !C.CON_SHA.includes(d.estado))) continue;
      if (C.validar(d, c.cuerpo).length) continue;
      const v = C.validarSello(raiz, c, rama);
      if (v.fallas.length || !v.sello) continue;
      memo.validos.push({
        id: c.id,
        estado: C.CON_SHA.includes(d.estado) ? 'aplicado' : d.estado,
        sha: d.sha || null,
        sello: v.sello,
        toca: d.toca.slice(),
        ids: new Set((Array.isArray(d.ids) ? d.ids : []).map(zona.normalizarId)),
      });
    }
  }
  return memo.validos;
}

function primero(raiz, desde, hasta, toca, memo) {
  if (!memo.primeros) memo.primeros = new Map();
  const k = `${desde}|${hasta}|${toca.join(',')}`;
  if (!memo.primeros.has(k)) memo.primeros.set(k, C.primerQueToca(raiz, desde, hasta, toca));
  return memo.primeros.get(k);
}

// ¿El cambio cubre a <cual>? Un aprobado, el primer commit después del sello que toca su `toca` (lo pendiente: si todavía ninguno
// lo tocó); un aplicado, solo el commit de su sha, y solo si ese es el primero (r5-1). Lo que no tiene padre (rf2-5) se cubre como
// lo pendiente contra su antes virtual: el sello en su historia y ningún commit después del sello que toque su `toca`.
function cubre(raiz, c, cual, memo) {
  const virtual = antesVirtual(raiz, cual, memo);
  if (esPendiente(cual)) {
    if (c.estado !== 'aprobado') return false;
    const head = shaDe(raiz, 'HEAD') || virtual;
    return !!head && esAncestro(raiz, c.sello, head) && primero(raiz, c.sello, head, c.toca, memo) === null;
  }
  if (virtual) {
    if (c.estado === 'aplicado' && c.sha !== cual) return false;
    return esAncestro(raiz, c.sello, virtual) && primero(raiz, c.sello, virtual, c.toca, memo) === null;
  }
  if (cual === c.sello || !esAncestro(raiz, c.sello, cual)) return false;
  if (c.estado === 'aplicado' && c.sha !== cual) return false;
  return primero(raiz, c.sello, cual, c.toca, memo) === cual;
}

// ---------------------------------------------------------------- rf3-8: el aplicado que un rebase reescribió

// El patch-id estable de un commit de un solo padre (lo que un rebase sin conflictos conserva), o null (merge, raíz, git que falla).
function patchId(raiz, sha, memo) {
  if (!memo.patchIds) memo.patchIds = new Map();
  if (!memo.patchIds.has(sha)) {
    let v = null;
    if (padres(raiz, sha).length === 1) {
      const d = git.correr(['diff-tree', '-p', '--no-color', '--no-ext-diff', sha], { cwd: raiz, tiempo: 20000 });
      if (d.ok && d.salida.length) {
        const p = git.correr(['patch-id', '--stable'], { cwd: raiz, entrada: d.salida });
        const m = p.ok ? /^([0-9a-f]{40,64})\s/.exec(p.stdout) : null;
        v = m ? m[1] : null;
      }
    }
    memo.patchIds.set(sha, v);
  }
  return memo.patchIds.get(sha);
}

// Los aplicados que cubrirían a <cual> si su sha fuera <cual>: su sha existe pero ya no es de la historia de HEAD (un rebase lo
// reescribió), <cual> sí lo es, es el primer commit tras el sello que toca su `toca`, y los dos tienen el mismo patch-id. NO cubren
// (sigue rojo hasta el anotar-sha): solo cambian el "qué hacer", con el comando listo, el mismo que acepta anotar-sha.
function rebaseados(raiz, cual, memo) {
  const head = shaDe(raiz, 'HEAD');
  if (!head || !esAncestro(raiz, cual, head)) return [];
  return cambiosValidos(raiz, memo).filter((c) => {
    if (c.estado !== 'aplicado' || !c.sha || c.sha === cual) return false;
    if (shaDe(raiz, c.sha) !== c.sha || esAncestro(raiz, c.sha, head)) return false;
    if (cual === c.sello || !esAncestro(raiz, c.sello, cual) || primero(raiz, c.sello, cual, c.toca, memo) !== cual) return false;
    const a = patchId(raiz, c.sha, memo);
    return a !== null && a === patchId(raiz, cual, memo);
  });
}

// ---------------------------------------------------------------- revisar

const sinPunto = (s) => String(s).replace(/·/g, '-');
function listaCorta(xs, n = 4) {
  const v = xs.map(sinPunto);
  return v.length > n ? `${v.slice(0, n).join(', ')} y ${v.length - n} más` : v.join(', ');
}

// Lo que un commit (o lo pendiente) necesita que lo cubra: { cats, ids, imposibles, primerArchivo } después de las exenciones.
function lo(raiz, cual, opciones, memo) {
  const cats = new Set();
  const ids = new Set();
  const imposibles = [];
  let primerArchivo = null;
  const archivos = archivosDe(raiz, cual, memo);
  if (!archivos.length) return { cats, ids, imposibles, primerArchivo };
  // Fuera del alcance: un commit de antes de adoptar el kit (la ficha nunca existió antes y él no la toca) no tenía candado.
  if (!archivos.some((f) => f.cat === 'ficha') && !fichaExistioAntes(raiz, cual, memo)) return { cats, ids, imposibles, primerArchivo };
  for (const f of archivos) {
    const t = tocaArchivo(raiz, f);
    if (!t.cats.size && !t.ids.size && !t.imposible) continue;
    if (!t.imposible && (exencionB(raiz, f, cual, memo) || exencionA(raiz, f, cual, opciones.molde, memo, opciones.moldeViejo))) continue;
    if (t.imposible) imposibles.push(t.imposible);
    t.cats.forEach((x) => cats.add(x));
    t.ids.forEach((x) => ids.add(x));
    if (primerArchivo === null) primerArchivo = f.rel;
  }
  return { cats, ids, imposibles, primerArchivo };
}

// ---------------------------------------------------------------- lo de esta PC que el candado no veía (rf-6)

// (a) Un archivo de barrera con la marca skip-worktree (S en `git ls-files -v`) o assume-unchanged (letra minúscula): git deja de
// mirar el disco y lo pendiente no lo ve. Ningún aprobado cubre una marca: se saca.
function marcasOcultas(raiz) {
  const fallas = [];
  for (const e of partirZ(lista(raiz, ['ls-files', '-v', '-z']).stdout)) {
    const tag = e[0];
    const rel = e.slice(2);
    if (!C.categoriaDe(rel)) continue;
    const skip = tag === 'S' || tag === 's';
    const assume = tag !== tag.toUpperCase();
    if (!skip && !assume) continue;
    const marca = [skip && 'skip-worktree', assume && 'assume-unchanged'].filter(Boolean).join(' y ');
    const sacar = [skip && `git update-index --no-skip-worktree ${rel}`, assume && `git update-index --no-assume-unchanged ${rel}`].filter(Boolean).join(' y ');
    fallas.push({ id: ID, commit: PENDIENTE, detalle: rel, que: `${rel} tiene la marca ${marca}: git no mira lo que cambia en el disco y el candado tampoco`, hacer: `sacale la marca: ${sacar}` });
  }
  return fallas;
}

// (c) .claude/settings.local.json (ignorado: es de esta PC) con disableAllHooks o hooks apaga o cambia los frenos sin pasar por un
// aprobado; con env (rf-15), mete código en cada hook (NODE_OPTIONS: "--require ./x.js"), y Claude Code no la escribe solo.
// permissions no se juzga (la escribe Claude Code). Si no está ignorado, lo juzga lo pendiente como a cualquier settings.
const RUTA_SETTINGS_LOCAL = '.claude/settings.local.json';
const CLAVES_LOCALES = ['disableAllHooks', 'hooks', 'env'];
function settingsLocal(raiz) {
  const b = leerDisco(path.join(raiz, ...RUTA_SETTINGS_LOCAL.split('/')));
  if (b === null) return [];
  if (!git.correr(['check-ignore', '-q', '--', RUTA_SETTINGS_LOCAL], { cwd: raiz }).ok) return [];
  const sale = (que, hacer) => [{ id: ID, commit: PENDIENTE, detalle: RUTA_SETTINGS_LOCAL, que, hacer }];
  const r = zona.leerJsonSinDuplicados(aTexto(b));
  // Lo que no se lee (o trae claves repetidas, que JSON.parse esconde) no se puede juzgar: frena.
  if (!r.ok || !esMapa(r.valor)) return sale(`${RUTA_SETTINGS_LOCAL} no se lee como JSON sin claves repetidas`, 'arreglalo o borralo: así no se sabe si apaga los frenos');
  const malas = CLAVES_LOCALES.filter((k) => Object.prototype.hasOwnProperty.call(r.valor, k));
  if (!malas.length) return [];
  return sale(`${RUTA_SETTINGS_LOCAL} trae la clave ${malas.join(' y ')}`, 'sacá esa clave: apaga o cambia los frenos en esta PC sin pasar por un aprobado');
}

// revisarBarreras(raiz, {molde, moldeViejo, indice, rango}) → [{ id: 'candado:barreras', que, hacer, detalle, commit }]. Vacía = en
// orden. molde: carpeta ABSOLUTA del molde de afuera (exención a); sin ella, no hay exención (a). moldeViejo: carpeta ABSOLUTA del
// molde del que viene el proyecto (solo con molde; si no, tira): deja ir lo que el nuevo retira. Tira si git no puede.
// Sin indice ni rango: el rango de la sesión, lo pendiente y lo de esta PC (marcas y settings.local). indice: true → lo de esta PC y
// SOLO el índice (rf-10). rango: { desde, hasta } (resolverRango) → SOLO esos commits, lo que sube el push (rf-7); desde null = una
// ref nueva (lo que ningún remoto tiene). Lo que no tiene padre (el índice o lo pendiente sin HEAD, un commit raíz) se juzga contra
// su antes virtual (antesVirtual, rf2-5); sin antes (el repo sin ninguna rama, o el primer commit de la historia vigente) no se
// juzga, y a secas sale un renglón con soloLista (no frena) que lo dice. Al juzgar lo pendiente, antes borra el caché de Python
// ignorado de las carpetas de barrera (8r3 i3) y, si borró algo, lo dice primero en otro renglón soloLista.
function revisarBarreras(raiz, opciones = {}) {
  if (opciones.indice && opciones.rango) throw new Error('indice y rango no van juntos');
  if (opciones.moldeViejo && !opciones.molde) throw new Error('el molde viejo va solo con el molde');
  const memo = {};
  let fallas;
  let cuales;
  if (opciones.rango) {
    fallas = [];
    memo.refsExtra = [opciones.rango.hasta];
    // Un commit sin padre sin antes virtual (el primero del repo) no afloja nada (r4-5, como rango()); el de una rama huérfana en un
    // repo con historia, sí: se juzga contra la vigente (rf2-5).
    cuales = commitsDelRango(raiz, opciones.rango).filter((c) => padres(raiz, c).length > 0 || antesVirtual(raiz, c, memo) !== null);
  } else {
    fallas = [...marcasOcultas(raiz), ...settingsLocal(raiz)];
    // El índice del primer commit del repo no se juzga, como el primer commit en el rango: no había un antes y ningún aprobado puede
    // existir todavía (el sello es un commit); si no, el repo recién montado nace trabado (r4-5).
    // Lo mismo a secas (fuera del paquete b, D3.3): sin ningún commit, lo pendiente no se juzga y se dice en una línea que no frena
    // (soloLista); si no, el /cierre de un proyecto de Modo A que corre estructura.cjs todo antes de su primer commit queda trabado.
    // rf2-5: "sin ningún commit" es sin HEAD y sin ninguna rama; una rama huérfana en un repo con historia se juzga contra la vigente.
    const head = shaDe(raiz, 'HEAD');
    if (opciones.indice) cuales = head || antesVirtual(raiz, INDICE, memo) ? [INDICE] : [];
    else if (head) cuales = [...rango(raiz).commits, PENDIENTE];
    else if (antesVirtual(raiz, PENDIENTE, memo)) cuales = [PENDIENTE];
    else {
      cuales = [];
      fallas.push({ id: ID, commit: PENDIENTE, detalle: contexto.RUTA_FICHA, soloLista: true, que: 'sin ningún commit todavía: lo pendiente no se juzga (no hay un antes ni un aprobado posible)', hacer: 'se juzga desde el primer commit' });
    }
  }
  for (const cual of cuales) {
    const n = lo(raiz, cual, opciones, memo);
    if (!n.cats.size && !n.ids.size && !n.imposibles.length) continue;
    const v = antesVirtual(raiz, cual, memo);
    const quien = (cual === PENDIENTE ? 'lo que está por commitearse' : cual === INDICE ? 'lo que lleva este commit (el índice)' : `el commit ${corto(cual)}`) + (v ? ` (rama huérfana: contra ${corto(v)})` : '');
    const detalle = n.primerArchivo || contexto.RUTA_FICHA;
    if (n.imposibles.length) {
      fallas.push({ id: ID, commit: cual, detalle, que: `${quien}: ${n.imposibles[0]}`, hacer: 'arreglá la ficha (corré doctor): ningún aprobado cubre lo que no se puede leer' });
      continue;
    }
    const validos = cambiosValidos(raiz, memo).filter((c) => cubre(raiz, c, cual, memo));
    const toca = new Set(validos.flatMap((c) => c.toca));
    const cubiertos = new Set(validos.flatMap((c) => [...c.ids]));
    const faltanCats = [...n.cats].filter((x) => !toca.has(x)).sort();
    const faltanIds = [...n.ids].filter((x) => !cubiertos.has(x)).sort();
    if (!faltanCats.length && !faltanIds.length) continue;
    // rf3-8: si lo que falta lo cubren aplicados cuyo sha reescribió un rebase (mismo patch), el "qué hacer" es reapuntarlos.
    const reb = esPendiente(cual) ? [] : rebaseados(raiz, cual, memo);
    if (reb.length) {
      const conReb = [...validos, ...reb];
      const toca2 = new Set(conReb.flatMap((c) => c.toca));
      const ids2 = new Set(conReb.flatMap((c) => [...c.ids]));
      if ([...n.cats].every((x) => toca2.has(x)) && [...n.ids].every((x) => ids2.has(x))) {
        const ruts = reb.map((c) => rutaCambio.rutaRelativa(c.id)).join(' ');
        const cmds = reb.map((c) => `${C.COMANDO} anotar-sha ${c.id} ${cual}`).join(' y ');
        fallas.push({
          id: ID,
          commit: cual,
          detalle,
          que: `${quien} toca ${listaCorta([...n.cats].sort())} y su aplicado apunta al sha de antes de un rebase (${reb.map((c) => `${c.id}: ${corto(c.sha)}`).join(', ')}; el mismo cambio)`,
          hacer: `se rebaseó: ${cmds}, y commit por rutas (git commit -m "cambios: aplicado ${reb.map((c) => c.id).join(', ')}" -- ${ruts})`,
        });
        continue;
      }
    }
    const que = validos.length
      ? `${quien} toca ${listaCorta([...n.cats].sort())} y los aprobados que lo cubren no nombran ${listaCorta(faltanCats.length ? faltanCats : faltanIds)}`
      : `${quien} toca ${listaCorta([...n.cats].sort())} (${listaCorta(faltanIds)}) sin un aprobado sellado que lo cubra`;
    // u9 (rt-u9-2): en un merge en curso, cambios aprobar no anda (pide main y sin merge a medias): se dice cómo cerrarlo.
    const hacer =
      cual === INDICE && mergeHeads(raiz).length
        ? 'esto vino distinto de los dos lados: en el merge dejalo como el lado que lo cambió (casi siempre main: git checkout --theirs <archivo>), commiteá el merge, y tu cambio hacelo en un commit aparte con su aprobado'
        : esPendiente(cual)
        ? `proponelo con cambios nuevo (3-barrera, un --id por cada uno) y que el dueño lo apruebe con cambios aprobar antes de commitear; o sacalo${cual === INDICE ? ' del índice (git restore --staged <archivo>)' : ''}`
        : 'proponé el cambio (cambios nuevo), que el dueño lo apruebe (cambios aprobar) y rehacé ese commit después del sello; o revertilo';
    fallas.push({ id: ID, commit: cual, detalle, que, hacer });
  }
  // 8r3 i3: lo que se borró del caché de Python se dice en una línea que no frena, primera.
  const borrados = memo.cachePython || [];
  if (borrados.length) {
    const rutas = borrados.slice(0, 5).join(', ') + (borrados.length > 5 ? '…' : '');
    fallas.unshift({ id: ID, commit: PENDIENTE, detalle: borrados[0], soloLista: true, que: `borré ${borrados.length} ${borrados.length === 1 ? 'caché' : 'cachés'} de Python ${borrados.length === 1 ? 'ignorado' : 'ignorados'} (se rehacen solos del .py seguido): ${rutas}`, hacer: 'no hace falta nada' });
  }
  return fallas;
}

module.exports = {
  ID,
  PENDIENTE,
  INDICE,
  RUTA_HANDOFF,
  CARPETA_FABRICA,
  RUTA_SETTINGS_LOCAL,
  rango,
  resolverRango,
  commitsDelRango,
  mergeHeads,
  esAdopcion,
  marcasOcultas,
  settingsLocal,
  fichaEnAlgunLado,
  archivosDe,
  antesVirtual,
  tocaArchivo,
  ultimaFichaQueSeLee,
  rutaEnMolde,
  revisarBarreras,
};
