'use strict';
// session-start.cjs — el hook de arranque del molde v3 (SPEC-paquete-2 P4.1; B §9; H §10.3, §11). Node directo, sin .sh.
// Lee la entrada JSON por stdin, imprime lo que arma lib/inyeccion.cjs, deja la marca de sesión en el git-dir propio del
// checkout, pone core.hooksPath=.githooks si el repo trae .githooks/ (P4.6) y corre el hermano session-start.propio.sh con bash si
// existe. SALE SIEMPRE CON 0: no niega nada.
// Fallas (P4.1): ficha rota → arriba, y sigue · error interno → una línea de error, el handoff crudo (hasta 5.000 bytes) y la
// huella · sin remoto ni ficha → entero · sin git → lo dice. Es .cjs a propósito: corre igual con "type": "module".
// Plazo (E4b): todo lo que lanza procesos (git, la búsqueda de bash, lo propio) tiene que terminar a los 10 s del arranque del
// proceso; lo que no entra se saltea, degrada y se dice ("arranque lento: …"). El timeout del hook en settings.json es 20 s:
// los 10 de margen son para levantar node, escribir y la marca. Si Claude Code lo mata, la sesión arranca SIN nada.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ERROR_INTERNO = 'hook de arranque: error interno — corré doctor';
const RE_SESION = /^[A-Za-z0-9-]{1,128}$/;
const CARPETA_MARCAS = 'kit-sesiones';
const PROPIO = path.join(__dirname, 'session-start.propio.sh');
const TIEMPO_PROPIO = 5000;
const HANDOFF_CRUDO_BYTES = 5000;
const PLAZO_ARRANQUE = 10000;
// Solo para pruebas y mediciones: otro plazo, en ms desde el arranque del proceso. Más chico, para ver la degradación; más
// grande, para que las pruebas del hook entero no dependan de lo cargada que esté la PC. Nadie lo pone en un settings.json.
const VAR_PLAZO = 'KIT_PLAZO_ARRANQUE_MS';

const miles = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function leerEntrada() {
  try {
    const t = fs.readFileSync(0, 'utf8');
    const e = t.trim() ? JSON.parse(t) : {};
    return e && typeof e === 'object' && !Array.isArray(e) ? e : {};
  } catch (err) {
    return {};
  }
}

const cwdDe = (entrada) => (entrada && typeof entrada.cwd === 'string' && entrada.cwd.trim() !== '' ? entrada.cwd : process.cwd());

// La librería de git (con el plazo), o null si no carga: de emergencia no se depende de ella.
function libGit() {
  try {
    return require('./lib/git.cjs');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- el plazo (E4b)

// plazoDelArranque(env, inicio) → ms epoch: 10 s desde el arranque del proceso, u otro si VAR_PLAZO trae un entero (≥ 0).
function plazoDelArranque(env = process.env, inicio = Date.now() - process.uptime() * 1000) {
  const pedido = env && typeof env[VAR_PLAZO] === 'string' && /^\d+$/.test(env[VAR_PLAZO].trim()) ? Number(env[VAR_PLAZO].trim()) : null;
  return inicio + (pedido === null ? PLAZO_ARRANQUE : pedido);
}

// ---------------------------------------------------------------- lo propio (E §5: el hermano, al final)

// En Windows, el `bash` del PATH puede ser el de WSL (C:\Windows\System32 o WindowsApps): se prefiere el de Git for Windows.
// `git --exec-path` pasa por git.correr: respeta el plazo (sin tiempo, el bash del PATH).
function buscarBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const git = libGit();
    const r = git ? git.correr(['--exec-path']) : { ok: false };
    if (r.ok && r.stdout.trim()) {
      const raizGit = path.resolve(r.stdout.trim(), '..', '..', '..');
      for (const c of [path.join(raizGit, 'bin', 'bash.exe'), path.join(raizGit, 'usr', 'bin', 'bash.exe')]) {
        if (fs.existsSync(c)) return c;
      }
    }
  } catch (e) {
    /* sin git: el bash del PATH */
  }
  return 'bash';
}

// correrPropio(raiz, bash) → null (no hay) · { salida, falla } (falla: null · 'sin-bash' · 'tiempo' · 'salió con N').
// Tope: 5 s o lo que quede del plazo, lo menor; si no queda ni el mínimo, no se corre y es falla 'tiempo'.
function correrPropio(raiz, bash, archivo = PROPIO) {
  if (!fs.existsSync(archivo)) return null;
  const elBash = bash || buscarBash();
  const git = libGit();
  const tope = git ? git.tiempoPara(TIEMPO_PROPIO) : TIEMPO_PROPIO;
  if (tope === null) return { salida: '', falla: 'tiempo' };
  const r = spawnSync(elBash, [archivo.split(path.sep).join('/')], {
    cwd: raiz,
    encoding: 'utf8',
    timeout: tope,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error && r.error.code === 'ENOENT') return { salida: '', falla: 'sin-bash' };
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) return { salida: r.stdout || '', falla: 'tiempo' };
  if (r.error) return { salida: '', falla: String(r.error.code || 'no corrió') };
  return { salida: r.stdout || '', falla: r.status === 0 ? null : `salió con ${r.status}` };
}

// ---------------------------------------------------------------- la marca de sesión (H §11)

// <git-dir>/kit-sesiones/<session_id>, con fecha nueva. Solo [A-Za-z0-9-]: otra cosa, no se deja. → la ruta o null.
function dejarMarca(entrada, gitDir) {
  const id = entrada && entrada.session_id;
  if (typeof id !== 'string' || !RE_SESION.test(id) || !gitDir) return null;
  const dir = path.join(gitDir, CARPETA_MARCAS);
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, id);
  fs.writeFileSync(archivo, ''); // escribir (aunque ya exista) le pone la fecha de ahora
  return archivo;
}

// Sin tiempo para preguntarle a git (E4b): el git-dir del disco — la carpeta .git, o el `gitdir:` del archivo .git de un
// worktree — buscando hacia arriba desde el cwd. → la ruta o null.
function gitDirPorDisco(cwd) {
  let d = path.resolve(cwd);
  for (;;) {
    const p = path.join(d, '.git');
    let s = null;
    try {
      s = fs.statSync(p);
    } catch (e) {
      /* acá no está: más arriba */
    }
    if (s && s.isDirectory()) return p;
    if (s) {
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(p, 'utf8'));
        return m ? path.resolve(d, m[1]) : null;
      } catch (e) {
        return null;
      }
    }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

// ---------------------------------------------------------------- core.hooksPath (P4.6; F §10)

const HOOKS_PATH = '.githooks';
const CLAVE_PREVIO = 'kit.hooksPathPrevio';

// ponerHooksPath(raiz) → { estado, valor, previo } (lo lee la línea "pre-commit:" de la inyección). Solo si el repo trae .githooks/:
// core.hooksPath vacío → .githooks (relativo: vale en cada worktree); ya .githooks → nada; otra cosa (husky, lefthook) → no se pierde:
// va a kit.hooksPathPrevio (el runner la encadena) y apunta a .githooks. Con su propio git (lib/git.cjs, con el plazo): un git cuando
// ya está, tres la primera vez. estado: 'sin-githooks' · 'ya' · 'puesto' · 'sin-tiempo' · 'no-pudo'.
function ponerHooksPath(raiz) {
  let st = null;
  try {
    st = fs.statSync(path.join(raiz, HOOKS_PATH));
  } catch (e) {
    st = null;
  }
  if (!st || !st.isDirectory()) return { estado: 'sin-githooks' };
  const git = require('./lib/git.cjs');
  const r = git.correr(['config', '--get', 'core.hooksPath'], { cwd: raiz });
  if (r.error === 'plazo') return { estado: 'sin-tiempo' };
  if (r.error || (r.codigo !== 0 && r.codigo !== 1)) return { estado: 'no-pudo' };
  const actual = r.codigo === 0 ? r.stdout.trim() : '';
  if (actual === HOOKS_PATH) return { estado: 'ya', valor: actual };
  const sinTiempo = (x) => (x.error === 'plazo' ? { estado: 'sin-tiempo' } : { estado: 'no-pudo' });
  if (actual) {
    const p = git.correr(['config', CLAVE_PREVIO, actual], { cwd: raiz });
    if (!p.ok) return sinTiempo(p);
  }
  const s = git.correr(['config', 'core.hooksPath', HOOKS_PATH], { cwd: raiz });
  if (!s.ok) return sinTiempo(s);
  return { estado: 'puesto', valor: HOOKS_PATH, previo: actual || null };
}

// ---------------------------------------------------------------- de emergencia (error interno)

// 8r3 i1 (rt-8): la carpeta de papeles sin las librerías: la `carpeta-docs:` del .claude/kit.md del disco, con una regex cruda de un
// renglón y la forma de ficha.RE_CARPETA_DOCS copiada (si cambia allá, cambia acá); lo que no se entiende, docs. Es la de emergencia:
// la vigente (de git) la lee lib/docs-ruta.cjs en el arranque normal.
const RE_CLAVE_CARPETA = /^carpeta-docs:[ \t]*(?:"([^"\r\n]*)"|([^\s"#]+))[ \t]*(?:#[^\r\n]*)?\r?$/m;
const RE_CARPETA_DOCS = /^(?=.{1,80}$)(?!(?:.*\/)?(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^/]*)?(?:\/|$))[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?)*$/;
function carpetaDeEmergencia(raiz) {
  try {
    const m = RE_CLAVE_CARPETA.exec(fs.readFileSync(path.join(raiz, '.claude', 'kit.md'), 'utf8'));
    const v = m ? (m[1] !== undefined ? m[1] : m[2]) : null;
    return v && RE_CARPETA_DOCS.test(v) ? v : 'docs';
  } catch (e) {
    return 'docs';
  }
}

// Sin las librerías: la línea de error, el handoff crudo hasta 5.000 bytes (cortado en renglón) y la huella.
function deEmergencia(entrada) {
  const lineas = [ERROR_INTERNO];
  let rel = 'docs/SESSION_HANDOFF.md';
  try {
    const cwd = cwdDe(entrada);
    let raiz = cwd;
    const env = { ...process.env };
    for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[v];
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    if (r.status === 0 && r.stdout && r.stdout.trim()) raiz = r.stdout.trim();
    rel = `${carpetaDeEmergencia(raiz)}/SESSION_HANDOFF.md`;
    let b = fs.readFileSync(path.join(raiz, ...rel.split('/')));
    let cortado = false;
    if (b.length > HANDOFF_CRUDO_BYTES) {
      b = b.subarray(0, HANDOFF_CRUDO_BYTES);
      const fin = b.lastIndexOf(0x0a);
      b = b.subarray(0, fin < 0 ? 0 : fin);
      cortado = true;
    }
    lineas.push('', b.toString('utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
    if (cortado) lineas.push(`… (CORTADO: sigue en ${rel})`);
  } catch (e) {
    lineas.push(`(no se pudo leer ${rel})`);
  }
  const pre = lineas.join('\n') + '\n';
  return pre + `inyectado: ${miles(pre.length)} de 9.700`;
}

// ---------------------------------------------------------------- el hook

function principal() {
  const entrada = leerEntrada();
  let texto;
  let gitDir = null;
  try {
    const git = require('./lib/git.cjs');
    git.fijarPlazo(plazoDelArranque());
    const contexto = require('./lib/contexto.cjs');
    const inyeccion = require('./lib/inyeccion.cjs');
    const cwd = contexto.cwdDe(entrada);
    const g = contexto.datosGit(cwd);
    gitDir = g ? g.gitDir : git.salteadasPorPlazo() > 0 ? gitDirPorDisco(cwd) : null;
    // Lo propio corre al final, con lo que sobre del plazo: primero lo de git, que es lo que la sesión necesita.
    const propio = () => correrPropio(g ? g.raiz : cwd);
    // core.hooksPath, antes de armar: la línea "pre-commit:" dice lo que quedó. Una falla acá no tira el arranque.
    let hooksPath;
    if (g) {
      try {
        hooksPath = ponerHooksPath(g.raiz);
      } catch (e) {
        hooksPath = { estado: 'no-pudo' };
      }
    }
    texto = inyeccion.armar({ cwd, entrada, home: os.homedir(), ahora: new Date(), propio, hooksPath }).texto;
  } catch (e) {
    texto = deEmergencia(entrada);
  }
  try {
    process.stdout.write(texto + '\n');
  } catch (e) {
    /* nada que hacer */
  }
  try {
    dejarMarca(entrada, gitDir);
  } catch (e) {
    /* la marca es rastro, no candado */
  }
}

if (require.main === module) {
  try {
    principal();
  } catch (e) {
    /* jamás tira */
  }
  process.exitCode = 0;
} else {
  module.exports = {
    ERROR_INTERNO,
    RE_SESION,
    CARPETA_MARCAS,
    PROPIO,
    PLAZO_ARRANQUE,
    VAR_PLAZO,
    HOOKS_PATH,
    CLAVE_PREVIO,
    ponerHooksPath,
    plazoDelArranque,
    gitDirPorDisco,
    buscarBash,
    correrPropio,
    dejarMarca,
    deEmergencia,
    carpetaDeEmergencia,
    RE_CARPETA_DOCS,
  };
}
