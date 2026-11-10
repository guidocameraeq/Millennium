'use strict';
// sensible.cjs — las 5 preguntas de A (DISENO-A §2: borrar datos reales, tocar plata, manejar claves, mandar algo hacia afuera,
// publicar un release), leídas de `sensible:` de la ficha VIGENTE (SPEC-0 4.5, 4.7 y 6.7; SPEC-paquete-3 «P4.5 y P6.7», D-1, D-4,
// D-9; red team r1-10, r1-11, r1-17). PreToolUse sobre Bash y PowerShell.
//
// CÓMO MATCHEA (el contrato)
//   - Cada entrada de `sensible.<clave>` se parte con lib/comando.cjs. Matchea si ALGÚN comando simple del comando de la herramienta
//     (también lo de adentro de `bash -c`, `$( )`, `powershell -Command`…) EMPIEZA con las palabras de la entrada, palabra entera
//     (`npm run release-notes` no es `npm run release`). La primera palabra se compara como programa: sin ruta, sin .exe/.cmd y sin
//     mayúsculas (`/usr/bin/npm`, `NPM.CMD`); si las dos traen ruta, alcanza con que una termine en la otra (`scripts/x.cjs` y
//     `D:/repo/scripts/x.cjs`). Las demás, tal cual en Bash y sin mayúsculas en PowerShell. Las banderas (palabras de 2+ caracteres
//     que empiezan con `-`) no fijan la posición (rf3-9): las palabras de la entrada que NO son banderas, en orden, tienen que ser el
//     principio de las del comando que no son banderas, y cada bandera de la entrada tiene que estar tal cual en algún lugar del
//     comando (`git push --tags` pregunta en `git push origin --tags`; `--follow-tags` no es `--tags`: si duele, va como otra entrada).
//     Por lo mismo, una entrada que es solo programa + banderas no fija subcomando (rf2-9): `vercel --prod` pregunta también en
//     `vercel logs --prod` y `vercel env pull --prod` (y en `vercel deploy --prod`, que es lo que se quería). Se deja así: atarla a
//     "sin subcomando" callaría `vercel deploy --prod`; si pregunta de más, la entrada va con su subcomando (`vercel deploy --prod`).
//     Un lanzador de paquetes (`npx`, `pnpm dlx`, `bunx`) NO es intérprete: `npx vercel --prod` no matchea `vercel --prod`;
//     si se usa así, va como otra entrada (`npx vercel --prod`).
//     Un intérprete (`node`, `bash`, `python`, `pwsh`…) también se mira sin él: `node scripts/x.cjs` y `./scripts/x.cjs` son lo mismo.
//     Lo que no cierra: una opción con valor antes del subcomando corre las palabras (`git -C x push --tags` no matchea).
//   - NO matchean nada: las `"tabla:<nombre>"` (son para la guardia de `db migrar`, F §13), una entrada que no es UN comando simple
//     (vacía, con `&&`, `|`, `;`, o que no se puede partir) y la PROSA. Regla de prosa: una entrada es prosa si su primera palabra
//     tiene un carácter que no va en un nombre de programa (tilde, ñ, signos: fuera de [A-Za-z0-9._+/\\:~@-]) o si tiene dos palabras
//     o más, NINGUNA con pinta de opción o de ruta (sin `-` adelante y sin `/`, `\`, `.`, `=` ni `:`), y alguna es un conector del
//     castellano (a, al, de, del, el, la, los, las, en, por, para, con, sin, que, y, una, unos, unas). Así "tabla clientes de la base
//     real" y "mails a gerencia" son prosa; "db borrar", "npm run release" y "stripe" son comandos. Equivocarse para el lado de
//     "comando" no cuesta nada (solo matchea un comando que empiece con esas mismas palabras); `doctor:sensible-prosa` avisa igual.
//   - Toda palabra `--borra-datos-reales` (o `--borra-datos-reales=…`, sin mayúsculas) en cualquier comando cuenta como
//     `datos-reales`, haya ficha o no y diga lo que diga la lista (D-4: con la bandera, la guardia de `db migrar` deja pasar porque
//     la ventana la puso este hook).
//
// QUÉ DEVUELVE
//   - Ids: `datos-reales` → `pregunta:borrar-datos-reales`; las otras, `pregunta:<clave>`. Un id quitado en `frenos.quitados` con
//     `hasta:` vigente (siempre, o una fecha que no pasó, el día incluido) apaga esa clave y nada más.
//   - De noche (`contexto.deNoche`: `.kit-rol` `nocturno`, o la marca `.kit-noche` del checkout o, en un obrero, la del worktree
//     de su director; el motivo dice cuál), o `permission_mode` `bypassPermissions`/`dontAsk`/ausente/desconocido (r1-17) → `deny` con PARADA.
//   - `default`, `acceptEdits`, `plan`, `auto`, cualquier otro rol → `ask`, con cuál de las 5 es y qué entrada de la ficha la marca.
//   - Los dos dejan renglón en .claude/frenos.log: id · herramienta · detalle = la clave (`preguntó <clave>` en el ask; `<clave>
//     (<por qué no hay ventana>)` en el deny). NUNCA el comando.
//
// DE DÓNDE SALE LA LISTA (4.7, RT2-3)
//   - La ficha vigente (`contexto.fichaVigente`: `origin/<defecto>`; sin remoto, la rama local por defecto; sin ficha, nada pregunta
//     salvo la bandera). Editar `sensible:` en el disco o en un commit sin mergear (o sin subir, con remoto) no cambia nada.
//   - Ficha ROTA: `sensible:` sale de la última ficha que se lee en la ref (hasta 20 commits atrás que la tocaron, como rf-14), sin
//     NINGÚN quitado (fábrica), y el motivo suma «ficha rota: <archivo>:<línea> — corré doctor».
//   - CACHÉ (r1-10): `<git-dir común>/kit-sensible.json`, con clave = huella sacada por fs SIN LANZAR PROCESOS: el contenido de la
//     config del repo, la global y la del sistema (rutas de siempre) con lo que incluyen (`include.path`, `includeIf.*.path`,
//     recursivo), las variables GIT_* del entorno, el `refs/remotes/origin/HEAD`
//     simbólico y el sha (archivo suelto o `packed-refs`) de
//     `refs/remotes/origin/<n>` y `refs/heads/<n>` para cada rama candidata (las de `contexto.candidatas`, guardadas en el caché).
//     Todo lo que puede cambiar cuál es la ref vigente o a qué commit apunta cambia la huella. Solo si cambió se lanza git. Sin
//     huella por fs (fuera de un repo, reftable, un `.git` que no se entiende) se cae a `contexto` en cada llamada: lento pero
//     correcto. Escritura atómica (temporal + renombre); un caché roto se ignora y se rehace; un git que falla no se cachea.
//
// Es un hook que NIEGA: regla 4.7, onFailure "block" y timeout 20 en el settings.json (lo registra el molde). `principal()`: ante
// cualquier error, deny "freno roto: corré doctor"; si ni eso, sale 2. NO corre ningún .propio.sh. Las librerías se cargan adentro
// de `decidir`, así una que falta es "freno roto" y no un hook que no arranca.
// LO QUE NO CIERRA: es un patrón (F §21): un alias, una variable o un script intermedio lo esquivan; y el caché es un archivo del
// git-dir común que un agente podría reescribir a propósito (lo cuida el corrector, `frenos-del-proyecto`, si lo suma a su lista).
// La huella sigue los `include.path`/`includeIf.*.path` (por fs, recursivo), pero no una config del sistema en una ruta rara ni
// un `include` armado por `GIT_CONFIG_PARAMETERS` hacia un archivo que después cambia: si ahí cambia init.defaultBranch, el caché
// sigue con la rama de antes hasta que se mueva una ref (una ficha vieja, no un freno apagado: la ficha la elige git).
// Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');

const HERRAMIENTAS = ['Bash', 'PowerShell'];
const SIN_VENTANA = ['bypassPermissions', 'dontAsk'];
const CON_VENTANA = ['default', 'acceptEdits', 'plan', 'auto'];
const ROTO = 'freno roto: corré doctor';
const CLAVES = ['datos-reales', 'plata', 'sale-afuera', 'claves', 'release'];
const PREGUNTAS = {
  'datos-reales': 'borrar datos reales',
  plata: 'tocar plata',
  'sale-afuera': 'mandar algo hacia afuera a tu nombre',
  claves: 'manejar claves',
  release: 'publicar un release',
};
const BANDERA = '--borra-datos-reales';
const ARCHIVO_CACHE = 'kit-sensible.json';
const VERSION_CACHE = 1;
const ATRAS = 20;
const RUTA_FICHA = '.claude/kit.md';

const idDe = (clave) => (clave === 'datos-reales' ? 'pregunta:borrar-datos-reales' : `pregunta:${clave}`);
const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- las entradas de la ficha

const CONECTORES = new Set(['a', 'al', 'de', 'del', 'el', 'la', 'los', 'las', 'en', 'por', 'para', 'con', 'sin', 'que', 'y', 'una', 'unos', 'unas']);
const RE_PROGRAMA = /^[A-Za-z0-9._+/\\:~@-]+$/;
const pareceOpcionORuta = (w) => w.startsWith('-') || /[/\\.=:]/.test(w);

// clasificar(texto, comando) → { tipo: 'comando', argv } · { tipo: 'tabla' } · { tipo: 'prosa' } · { tipo: 'invalida' }.
function clasificar(texto, comando) {
  if (typeof texto !== 'string') return { tipo: 'invalida' };
  const t = texto.trim();
  if (t === '') return { tipo: 'invalida' };
  if (/^tabla:/i.test(t)) return { tipo: 'tabla' };
  const r = comando.partir(t);
  if (r.incompleto || r.comandos.length !== 1 || r.comandos[0].argv.length === 0) return { tipo: 'invalida' };
  const argv = r.comandos[0].argv;
  if (!RE_PROGRAMA.test(argv[0])) return { tipo: 'prosa' };
  if (argv.length >= 2 && !argv.some(pareceOpcionORuta) && argv.some((w) => CONECTORES.has(w.toLowerCase()))) return { tipo: 'prosa' };
  return { tipo: 'comando', argv };
}

// ---------------------------------------------------------------- la comparación

const INTERPRETES = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'py', 'pwsh', 'powershell', 'deno', 'bun']);

// Los segmentos de una palabra-programa: sin ./, con / y sin mayúsculas; el último, sin .exe/.cmd/.bat/.com.
function segmentos(w) {
  const s = String(w).replace(/\\/g, '/').toLowerCase().split('/').filter((x) => x !== '' && x !== '.');
  if (s.length) s[s.length - 1] = s[s.length - 1].replace(/\.(exe|cmd|bat|com)$/, '');
  return s;
}
function mismoPrograma(a, b) {
  const x = segmentos(a);
  const y = segmentos(b);
  if (!x.length || !y.length) return false;
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  for (let i = 1; i <= corto.length; i++) if (corto[corto.length - i] !== largo[largo.length - i]) return false;
  return true;
}
// Las formas de un argv: él mismo y, si arranca con un intérprete, desde el script (sin el intérprete ni sus opciones).
function formas(argv, comando) {
  const f = [argv];
  if (argv.length && INTERPRETES.has(comando.programa(argv[0]))) {
    let i = 1;
    while (i < argv.length && argv[i].startsWith('-')) i++;
    if (i < argv.length) f.push(argv.slice(i));
  }
  return f;
}
// rf3-9: las banderas no fijan la posición. Las palabras de la entrada que no son banderas, en orden, son el principio de las del
// comando que no son banderas; y cada bandera de la entrada está, tal cual, en algún lugar del comando (`git push --tags` pregunta
// en `git push origin --tags`; `--follow-tags` no es `--tags`). Si el comando empieza literalmente con la entrada, también matchea.
const esOpcion = (w) => w.length > 1 && w.startsWith('-');
function empiezaCon(cmd, ent, ps) {
  if (!cmd.length || !ent.length || !mismoPrograma(cmd[0], ent[0])) return false;
  const eq = ps ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const pc = cmd.slice(1).filter((w) => !esOpcion(w));
  const pe = ent.slice(1).filter((w) => !esOpcion(w));
  if (pc.length < pe.length) return false;
  for (let i = 0; i < pe.length; i++) if (!eq(pc[i], pe[i])) return false;
  return ent.slice(1).filter(esOpcion).every((f) => cmd.slice(1).some((w) => eq(w, f)));
}
function matchea(argvComando, argvEntrada, ps, comando) {
  const fc = formas(argvComando, comando);
  const fe = formas(argvEntrada, comando);
  return fc.some((c) => fe.some((e) => empiezaCon(c, e, ps)));
}
const esBandera = (w) => {
  const l = String(w).toLowerCase();
  return l === BANDERA || l.startsWith(`${BANDERA}=`);
};

// ---------------------------------------------------------------- git por fs (sin lanzar procesos)

const leer = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
};
const RE_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// Desde el cwd, para arriba: { raiz, gitDir, comun } o null. Un `.git` carpeta, o un archivo `gitdir: <ruta>` (worktree).
function gitPorFs(cwd) {
  let d = path.resolve(cwd);
  for (let i = 0; i < 100; i++) {
    const g = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(g);
    } catch (e) {
      st = null;
    }
    if (st) {
      let gitDir = null;
      if (st.isDirectory()) gitDir = g;
      else if (st.isFile()) {
        const m = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(leer(g) || '');
        if (!m) return null;
        gitDir = path.resolve(d, m[1]);
      }
      if (!gitDir || leer(path.join(gitDir, 'HEAD')) === null) return null;
      const cd = leer(path.join(gitDir, 'commondir'));
      const comun = cd !== null && cd.trim() !== '' ? path.resolve(gitDir, cd.trim()) : gitDir;
      return { raiz: d, gitDir, comun };
    }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
  return null;
}

// packed-refs → Map(ref → sha). Las líneas ^ (pelados) y los comentarios no cuentan.
function empaquetadas(comun) {
  const m = new Map();
  const t = leer(path.join(comun, 'packed-refs'));
  if (t === null) return m;
  for (const l of t.split('\n')) {
    const x = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)\r?$/.exec(l);
    if (x) m.set(x[2], x[1]);
  }
  return m;
}
// El sha de una ref (suelta, simbólica hasta 5 saltos, o empaquetada); '-' si no existe. null si algo no se entiende.
function shaDe(comun, ref, paquete, saltos = 0) {
  if (saltos > 5) return null;
  const t = leer(path.join(comun, ...ref.split('/')));
  if (t !== null) {
    const v = t.trim();
    if (RE_SHA.test(v)) return v;
    const s = /^ref:\s*(\S+)$/.exec(v);
    if (s) return shaDe(comun, s[1], paquete, saltos + 1);
    return null;
  }
  return paquete.has(ref) ? paquete.get(ref) : '-';
}
function configsGlobales() {
  const env = process.env;
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const home = env.HOME || env.USERPROFILE || '';
  const xdg = env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : '');
  return [xdg ? path.join(xdg, 'git', 'config') : null, home ? path.join(home, '.gitconfig') : null].filter(Boolean);
}
// La del sistema: Git for Windows guarda ahí el init.defaultBranch que eligió el instalador. Las rutas de siempre (sin lanzar git).
function configsSistema() {
  const env = process.env;
  if (env.GIT_CONFIG_NOSYSTEM) return [];
  if (env.GIT_CONFIG_SYSTEM) return [env.GIT_CONFIG_SYSTEM];
  const l = ['/etc/gitconfig'];
  if (env.ProgramFiles || env.PROGRAMFILES) l.push(path.join(env.ProgramFiles || env.PROGRAMFILES, 'Git', 'etc', 'gitconfig'));
  if (env.ProgramData || env.PROGRAMDATA) l.push(path.join(env.ProgramData || env.PROGRAMDATA, 'Git', 'config'));
  return l;
}
// Las variables GIT_* del entorno (GIT_CONFIG_COUNT/_KEY_n/_VALUE_n, GIT_CONFIG_PARAMETERS, GIT_DIR…) también cambian lo que lee git.
const entornoGit = () =>
  Object.keys(process.env)
    .filter((k) => /^GIT_/i.test(k))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .join('\0');

// Los `path` de las secciones [include] e [includeIf "…"] de un texto de config (sin mayúsculas en sección y clave; con o sin
// comillas; sin el comentario `#`/`;` de la cola). Todas las includeIf, se cumpla o no su condición: de más solo rehace el caché.
function rutasIncluidas(texto) {
  const out = [];
  let dentro = false;
  for (let l of String(texto).split(/\r?\n/)) {
    l = l.trim();
    const sec = /^\[([^\]]*)\](.*)$/.exec(l);
    if (sec) {
      dentro = /^\s*include(?:if(?:\s+".*"|\..*))?\s*$/i.test(sec[1]); // [include] · [includeIf "…"] · [includeIf.…] (forma vieja)
      l = sec[2].trim(); // `[include] path = x` en el mismo renglón también vale
    }
    if (!dentro) continue;
    const m = /^path\s*=\s*(.*)$/i.exec(l);
    if (!m) continue;
    let v = m[1].trim();
    if (v.startsWith('"')) {
      let f = 1;
      while (f < v.length && v[f] !== '"') f += v[f] === '\\' ? 2 : 1; // la comilla que cierra, salteando las escapadas
      v = v.slice(1, f);
    } else v = v.replace(/\s[#;].*$/, '').trim();
    v = v.replace(/\\(["\\])/g, '$1');
    if (v !== '') out.push(v);
  }
  return out;
}
// incluidas(archivo, texto) → [[ruta, texto|null]] de lo que incluye, recursivo (hasta 10 niveles, como git), cada archivo una
// vez. Relativa: a la carpeta de la config que la nombra; `~/`: el HOME. Solo fs: ningún proceso.
function incluidas(archivo, texto, prof = 0, vistos = new Set()) {
  const res = [];
  if (texto === null || prof >= 10) return res;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const r of rutasIncluidas(texto)) {
    let p = r;
    if (/^~[\\/]/.test(p)) {
      if (!home) continue;
      p = path.join(home, p.slice(2));
    }
    p = path.resolve(path.dirname(archivo), p);
    if (vistos.has(p)) continue;
    vistos.add(p);
    const t = leer(p);
    res.push([p, t]);
    res.push(...incluidas(p, t, prof + 1, vistos));
  }
  return res;
}

// huella(g, candidatas) → texto, o null si por fs no se puede.
function huella(g, candidatas) {
  if (!g || !Array.isArray(candidatas) || !candidatas.length) return null;
  try {
    if (fs.existsSync(path.join(g.comun, 'reftable'))) return null;
  } catch (e) {
    return null;
  }
  const partes = [`v${VERSION_CACHE}`];
  // Por contenido, no por ruta: el caché es uno para el principal y todos sus worktrees.
  const configs = [
    ['config', path.join(g.comun, 'config')],
    ['config.worktree', path.join(g.gitDir, 'config.worktree')],
    ...configsGlobales().map((c, i) => [`global${i}`, c]),
    ...configsSistema().map((c, i) => [`sistema${i}`, c]),
  ];
  for (const [nombre, c] of configs) {
    const t = leer(c);
    partes.push(`${nombre}=${t === null ? '-' : t}`);
    // Lo que esa config incluye (`include.path`, `includeIf.*.path`), por contenido y recursivo, como lo lee git.
    for (const [ruta, ti] of incluidas(c, t)) partes.push(`${nombre}<${ruta}=${ti === null ? '-' : ti}`);
  }
  partes.push(`entorno=${entornoGit()}`);
  partes.push(`origin/HEAD=${(leer(path.join(g.comun, 'refs', 'remotes', 'origin', 'HEAD')) || '-').trim()}`);
  const paquete = empaquetadas(g.comun);
  for (const n of candidatas) {
    for (const ref of [`refs/remotes/origin/${n}`, `refs/heads/${n}`]) {
      const s = shaDe(g.comun, ref, paquete);
      if (s === null) return null;
      partes.push(`${ref}=${s}`);
    }
  }
  return require('crypto').createHash('sha256').update(partes.join('\n')).digest('hex');
}

function algunaEnDisco(g, candidatas) {
  const paquete = empaquetadas(g.comun);
  return candidatas.some((n) =>
    [`refs/remotes/origin/${n}`, `refs/heads/${n}`].some((ref) => {
      const s = shaDe(g.comun, ref, paquete);
      return s !== null && s !== '-';
    }),
  );
}

const ramaPorFs = (g) => {
  const m = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(leer(path.join(g.gitDir, 'HEAD')) || '');
  return m ? m[1] : null;
};

// ---------------------------------------------------------------- la lista vigente (con caché)

// De los datos de una ficha: { listas: {clave: [texto]}, quitados: [{id, hasta}] }.
function extraer(datos, conQuitados) {
  const listas = {};
  const s = datos && esMapa(datos.sensible) ? datos.sensible : {};
  for (const k of CLAVES) listas[k] = Array.isArray(s[k]) ? s[k].filter((x) => typeof x === 'string') : [];
  const q = conQuitados && datos && esMapa(datos.frenos) && Array.isArray(datos.frenos.quitados) ? datos.frenos.quitados : [];
  const quitados = q.filter((x) => esMapa(x) && typeof x.id === 'string' && typeof x.hasta === 'string').map((x) => ({ id: x.id, hasta: x.hasta }));
  return { listas, quitados };
}

// La última ficha que se lee yendo para atrás desde <ref> (hasta ATRAS commits que la tocaron): los datos o null.
function ultimaQueSeLee(cwd, ref) {
  const git = require('./lib/git.cjs');
  const ficha = require('./lib/ficha.cjs');
  const l = git.correr(['rev-list', '-n', String(ATRAS), ref, '--', RUTA_FICHA], { cwd });
  if (!l.ok) throw new Error('no se pudo recorrer la historia de la ficha');
  for (const sha of l.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const r = git.correr(['cat-file', 'blob', `${sha}:${RUTA_FICHA}`], { cwd });
    if (!r.ok) continue;
    try {
      return ficha.leer(r.salida.toString('utf8')).datos;
    } catch (e) {
      /* rota también: la anterior */
    }
  }
  return null;
}

// Lee la ficha vigente con git (lo lento). → { estado, donde, listas, quitados }. Un git que falla tira (y no se cachea).
function leerConGit(cwd) {
  const contexto = require('./lib/contexto.cjs');
  const f = contexto.fichaVigente(cwd);
  if (f.estado === 'ok') return { estado: 'ok', donde: null, ...extraer(f.datos, true) };
  if (f.estado === 'rota') {
    const u = ultimaQueSeLee(cwd, f.ref);
    return { estado: 'rota', donde: f.donde, ...extraer(u, false) };
  }
  // sin ficha: si fue git el que falló (tiempo, sin git), es un freno roto, no "no hay ficha"
  if (typeof f.motivo === 'string' && f.motivo.startsWith('git: ')) throw new Error(`no se pudo leer la ficha (${f.motivo})`);
  return { estado: 'sin-ficha', donde: null, ...extraer(null, false), sinRama: f.motivo === 'no hay rama por defecto' };
}

function cacheValido(c) {
  if (!esMapa(c) || c.v !== VERSION_CACHE || typeof c.clave !== 'string') return false;
  if (!Array.isArray(c.candidatas) || !c.candidatas.length || !c.candidatas.every((x) => typeof x === 'string')) return false;
  if (!['ok', 'rota', 'sin-ficha'].includes(c.estado)) return false;
  if (c.estado === 'rota' ? typeof c.donde !== 'string' : c.donde !== null) return false;
  if (!esMapa(c.listas) || !CLAVES.every((k) => Array.isArray(c.listas[k]) && c.listas[k].every((x) => typeof x === 'string'))) return false;
  return Array.isArray(c.quitados) && c.quitados.every((x) => esMapa(x) && typeof x.id === 'string' && typeof x.hasta === 'string');
}
function leerCache(archivo) {
  try {
    const c = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return cacheValido(c) ? c : null;
  } catch (e) {
    return null;
  }
}
function escribirCache(archivo, c) {
  const tmp = `${archivo}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(c)}\n`);
    fs.renameSync(tmp, archivo);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* nada que limpiar */
    }
  }
}

// listasVigentes(cwd) → { estado, donde, listas, quitados, origen: 'cache' | 'git' | 'contexto', git: {raiz, gitDir, comun} | null }.
function listasVigentes(cwd) {
  const g = gitPorFs(cwd);
  if (!g) return { ...leerConGit(cwd), origen: 'contexto', git: null };
  const archivo = path.join(g.comun, ARCHIVO_CACHE);
  const c = leerCache(archivo);
  if (c) {
    const h = huella(g, c.candidatas);
    if (h !== null && h === c.clave) return { estado: c.estado, donde: c.donde, listas: c.listas, quitados: c.quitados, origen: 'cache', git: g };
  }
  const contexto = require('./lib/contexto.cjs');
  const candidatas = contexto.candidatas(g.raiz);
  const antes = huella(g, candidatas);
  const r = leerConGit(g.raiz);
  const despues = huella(g, candidatas);
  // git dice que no hay rama por defecto y en el disco hay una (un git que no anda, safe.directory): freno roto, no "sin ficha"
  if (r.sinRama && algunaEnDisco(g, candidatas)) throw new Error('git no ve la rama por defecto que está en el disco');
  const v = { estado: r.estado, donde: r.donde, listas: r.listas, quitados: r.quitados };
  if (antes === null) return { ...v, origen: 'contexto', git: g };
  if (antes === despues) escribirCache(archivo, { v: VERSION_CACHE, clave: antes, candidatas, ...v });
  return { ...v, origen: 'git', git: g };
}

// ---------------------------------------------------------------- decidir

const dos = (n) => String(n).padStart(2, '0');
const hoyLocal = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
function quitadoVigente(quitados, id, ahora) {
  const hoy = hoyLocal(ahora);
  return quitados.some((q) => q.id === id && (q.hasta === 'siempre' || (/^\d{4}-\d{2}-\d{2}$/.test(q.hasta) && q.hasta >= hoy)));
}

function salida(decision, motivo) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: motivo } };
}

const porQue = (m) => (m.bandera ? `el comando lleva ${BANDERA}` : `la ficha lo marca en sensible.${m.clave}: "${m.entrada}"`);
const notaRota = (v) => (v.estado === 'rota' ? ` · ficha rota: ${v.donde} — corré doctor` : '');
const motivoAsk = (m, v) =>
  `Esto es «${PREGUNTAS[m.clave]}», una de las 5 preguntas de A: ${porQue(m)}. Si es lo que querés, aceptá; si no, rechazalo.${notaRota(v)}`;
const SIN_VENTANA_TEXTO = {
  nocturno: 'de noche: .kit-rol nocturno',
  'kit-noche': 'de noche: .kit-noche',
  'sin modo': 'no se sabe el modo de permisos, así que no hay ventana segura',
  'modo desconocido': 'un modo de permisos que el kit no conoce, así que no hay ventana segura',
};
const SI_SOS_VOS = ' Si sos vos, pasá a default (Shift+Tab) y pedilo de nuevo.';
const motivoParada = (m, v, sinVentana) =>
  `esto es «${PREGUNTAS[m.clave]}» y sin una persona no se hace: dejá PARADA en tu bitácora y pará (${porQue(m)}; ${sinVentana}).` +
  `${sinVentana === SIN_VENTANA_TEXTO.nocturno || sinVentana === SIN_VENTANA_TEXTO['kit-noche'] ? '' : SI_SOS_VOS}${notaRota(v)}`;

// Lo que matchea, en el orden de las 5: [{clave, entrada, bandera}].
function coincidencias(comandos, listas, ps, comando) {
  const res = [];
  if (comandos.some((c) => c.argv.some(esBandera))) res.push({ clave: 'datos-reales', entrada: null, bandera: true });
  for (const clave of CLAVES) {
    for (const texto of listas[clave] || []) {
      const e = clasificar(texto, comando);
      if (e.tipo !== 'comando') continue;
      if (comandos.some((c) => matchea(c.argv, e.argv, ps, comando))) {
        res.push({ clave, entrada: texto.trim(), bandera: false });
        break;
      }
    }
  }
  return res;
}

// decidir(entrada, {anotar, ahora}) → { decision: 'nada', origen } · { decision: 'ask' | 'deny', salida, id, clave, detalle, renglon, origen }.
// Tira solo si algo se rompe adentro: el que llama lo traduce a "freno roto".
function decidir(entrada, opciones = {}) {
  const e = esMapa(entrada) ? entrada : null;
  if (!e) throw new Error('la entrada no es un objeto');
  if (typeof e.tool_name === 'string' && !HERRAMIENTAS.includes(e.tool_name)) return { decision: 'nada', origen: null };
  const texto = e.tool_input && e.tool_input.command;
  if (typeof texto !== 'string' || texto.trim() === '') return { decision: 'nada', origen: null };
  const comando = require('./lib/comando.cjs');
  const ps = e.tool_name === 'PowerShell';
  const herramienta = ps ? 'PowerShell' : 'Bash';
  const cwd = typeof e.cwd === 'string' && e.cwd.trim() !== '' ? e.cwd : process.cwd();

  const v = listasVigentes(cwd);
  const { comandos } = comando.partir(texto, { ps });
  const ahora = opciones.ahora instanceof Date ? opciones.ahora : new Date();
  const m = coincidencias(comandos, v.listas, ps, comando).find((x) => !quitadoVigente(v.quitados, idDe(x.clave), ahora));
  if (!m) return { decision: 'nada', origen: v.origen };

  // raíz, rol y rama: por fs si se pudo; si no, con contexto
  let raiz = v.git ? v.git.raiz : null;
  let rama = v.git ? ramaPorFs(v.git) : null;
  const contexto = require('./lib/contexto.cjs');
  if (!v.git) {
    const g = contexto.datosGit(cwd);
    raiz = g ? g.raiz : null;
    rama = raiz ? contexto.rama(raiz) : null;
  }
  const rol = contexto.rol(raiz);
  const modo = typeof e.permission_mode === 'string' ? e.permission_mode.trim() : '';
  // De noche: .kit-rol nocturno, o la marca .kit-noche (la propia, o la del director si esto es un obrero). La rama ya está.
  const noche = raiz ? contexto.deNoche(raiz, { rama }) : { noche: false, por: null };
  let sinVentana = null;
  if (noche.noche) sinVentana = noche.por === 'kit-noche' ? 'kit-noche' : 'nocturno';
  else if (!modo) sinVentana = 'sin modo';
  else if (SIN_VENTANA.includes(modo)) sinVentana = modo;
  else if (!CON_VENTANA.includes(modo)) sinVentana = 'modo desconocido';

  const id = idDe(m.clave);
  const decision = sinVentana ? 'deny' : 'ask';
  const detalle = sinVentana ? `${m.clave} (${sinVentana})` : `preguntó ${m.clave}`;
  let renglon = null;
  if (raiz) {
    try {
      const anotar = opciones.anotar || require('./lib/frenos-log.cjs').anotar;
      renglon = anotar(raiz, { id, herramienta, detalle, rol, rama });
    } catch (err) {
      /* el renglón es rastro: el freno vale igual */
    }
  }
  const motivo = sinVentana ? motivoParada(m, v, SIN_VENTANA_TEXTO[sinVentana] || `modo ${sinVentana}, sin ventana para preguntarte`) : motivoAsk(m, v);
  return { decision, salida: salida(decision, motivo), id, clave: m.clave, detalle, renglon, origen: v.origen };
}

function principal() {
  let r;
  try {
    const t = fs.readFileSync(0, 'utf8');
    r = decidir(JSON.parse(t));
  } catch (e) {
    r = { decision: 'deny', salida: salida('deny', ROTO) };
  }
  if (r.decision !== 'nada') process.stdout.write(`${JSON.stringify(r.salida)}\n`);
}

if (require.main === module) {
  try {
    principal();
    process.exitCode = 0;
  } catch (e) {
    // Ni el deny se pudo imprimir: la salida distinta de 0 (2 = error que bloquea) y onFailure "block" frenan.
    process.exitCode = 2;
  }
} else {
  module.exports = {
    HERRAMIENTAS,
    SIN_VENTANA,
    CON_VENTANA,
    ROTO,
    CLAVES,
    PREGUNTAS,
    BANDERA,
    ARCHIVO_CACHE,
    idDe,
    clasificar,
    mismoPrograma,
    matchea,
    gitPorFs,
    huella,
    rutasIncluidas,
    incluidas,
    listasVigentes,
    salida,
    decidir,
  };
}
