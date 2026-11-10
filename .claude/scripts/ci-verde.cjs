'use strict';
// ci-verde.cjs — ¿el CI de GitHub está verde para este commit? (puesta-a-punto, SPEC.md:48). Uso, desde el repo:
//   node .claude/scripts/ci-verde.cjs <sha|HEAD> [--esperar] [--merge]
// Consulta los check-runs del commit en api.github.com (solo LEE). Dueño/repo salen del remote `origin`.
// Salidas: 0 todos los checks terminaron en success/skipped/neutral y hay al menos uno · 1 alguno falló (una línea por check
// fallado) o, con --esperar, no apareció ningún check en 3 min · 2 siguen corriendo (o aún no hay checks, sin --esperar).
// Error de red/API: 1 con `NO VERIFICADO: <por qué>` (regla 5 del gate). --esperar reconsulta cada 30 s hasta 25 min; pasado el
// tope, 2. La última línea es siempre el resumen. Credencial: `git credential fill`; el token va SOLO en el header Authorization
// hacia api.github.com y nunca se imprime. Sin credencial, intenta sin ella (repo público).
// --merge: si el commit es un merge que GitHub no conoce (422, aún sin pushear), mira el CI de su último padre (la punta mergeada).
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const { execFileSync } = require('child_process');
const https = require('https');

const OK = new Set(['success', 'skipped', 'neutral']);
const SIN_CHECKS_MS = 3 * 60 * 1000;
const TOPE_MS = 25 * 60 * 1000;
const CADA_MS = 30 * 1000;

// --- lógica pura (probada en ci-verde.test.cjs) ---

function veredicto(checkRuns) {
  const fallados = [];
  let corriendo = 0;
  for (const c of checkRuns) {
    if (c.status !== 'completed') corriendo++;
    else if (!OK.has(c.conclusion)) fallados.push(c.name);
  }
  const total = checkRuns.length;
  let codigo = 2;
  if (fallados.length) codigo = 1;
  else if (total > 0 && corriendo === 0) codigo = 0;
  return { codigo, total, fallados, corriendo };
}

function dueñoRepo(url) {
  const m = /^\s*(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(String(url));
  return m ? { dueño: m[1], repo: m[2] } : null;
}

function sinChecksVencido(total, transcurridoMs) {
  return total === 0 && transcurridoMs >= SIN_CHECKS_MS;
}

// Qué hacer tras una consulta: { codigo } si ya se puede salir, { seguir: true } si toca reconsultar.
function decidir(v, esperar, pasadoMs) {
  if (v.codigo !== 2 || !esperar) return { codigo: v.codigo };
  if (sinChecksVencido(v.total, pasadoMs)) return { codigo: 1, aviso: 'no apareció ningún check en 3 min' };
  if (pasadoMs < TOPE_MS) return { seguir: true };
  return { codigo: 2 };
}

function textoHttp(status) {
  const t = {
    401: 'la credencial no sirve (venció o es inválida)',
    403: 'GitHub rechazó la consulta (límite de consultas sin credencial o falta de permiso)',
    404: 'GitHub no ve el repo (privado sin credencial)',
    422: 'GitHub no conoce ese commit (¿falta el git push?)',
  };
  return `la API contestó ${status}${t[status] ? ': ' + t[status] : ''}`;
}

// Si el commit es un merge local sin pushear (--merge, 2+ padres, GitHub contestó 422) → { sha: último padre, aviso }; si no, null.
function objetivoMerge({ sha, padres, status, merge }) {
  if (!merge || status !== 422 || !Array.isArray(padres) || padres.length < 2) return null;
  const punta = padres[padres.length - 1];
  return { sha: punta, aviso: `ci-verde: ${String(sha).slice(0, 7)} es un merge sin pushear; miro su punta ${String(punta).slice(0, 7)}` };
}

// Salida de `git rev-list --parents -n 1 <sha>` ("<sha> <padre1> <padre2>…") → los padres.
function padresDe(salida) {
  return String(salida).trim().split(/[ \t\r\n]+/).filter(Boolean).slice(1);
}

function resumen(sha, total, codigo) {
  const estado = codigo === null ? 'sin verificar' : codigo === 0 ? 'verde' : codigo === 1 ? 'rojo' : 'corriendo';
  return `ci-verde @${String(sha).slice(0, 7)}: ${total} checks · ${estado}`;
}

// --- lo que toca el mundo ---

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function token() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      timeout: 10000,
    });
    const m = /^password=(.*)$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function pedir(ruta, tk) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'ci-verde', Accept: 'application/vnd.github+json' };
    if (tk) headers.Authorization = `Bearer ${tk}`;
    const req = https.get({ host: 'api.github.com', path: ruta, headers, timeout: 20000 }, (res) => {
      let cuerpo = '';
      res.on('data', (d) => (cuerpo += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(textoHttp(res.statusCode)), { status: res.statusCode }));
        try { resolve(JSON.parse(cuerpo)); } catch { reject(new Error('respuesta que no es JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('sin respuesta en 20 s')));
    req.on('error', reject);
  });
}

async function checkRuns(dueño, repo, sha, tk) {
  const todos = [];
  for (let pag = 1; pag <= 20; pag++) {
    const r = await pedir(`/repos/${dueño}/${repo}/commits/${sha}/check-runs?per_page=100&page=${pag}`, tk);
    const lote = Array.isArray(r.check_runs) ? r.check_runs : [];
    todos.push(...lote);
    if (todos.length >= (r.total_count || 0) || lote.length === 0) break;
  }
  return todos;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function noVerificado(sha, porque) {
  console.log(`NO VERIFICADO: ${porque}`);
  console.log(resumen(sha || '0000000', 0, null));
  return 1;
}

async function main(argv) {
  const esperar = argv.includes('--esperar');
  const merge = argv.includes('--merge');
  const ref = argv.find((a) => !a.startsWith('--')) || 'HEAD';
  let sha;
  let dr;
  let padres = [];
  try {
    sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
    if (merge) padres = padresDe(git(['rev-list', '--parents', '-n', '1', sha]));
    dr = dueñoRepo(git(['remote', 'get-url', 'origin']));
  } catch (e) {
    return noVerificado(sha, `no pude resolver ${ref} o el remote origin`);
  }
  if (!dr) return noVerificado(sha, 'el remote origin no es un repo de github.com');
  const tk = token();
  const inicio = Date.now();
  for (;;) {
    let v;
    try {
      v = veredicto(await checkRuns(dr.dueño, dr.repo, sha, tk));
    } catch (e) {
      const o = objetivoMerge({ sha, padres, status: e.status, merge });
      if (o) {
        console.log(o.aviso);
        sha = o.sha;
        padres = [];
        continue;
      }
      return noVerificado(sha, e.message);
    }
    const d = decidir(v, esperar, Date.now() - inicio);
    if (d.seguir) {
      await dormir(CADA_MS);
      continue;
    }
    if (d.aviso) console.log(d.aviso);
    for (const n of v.fallados) console.log(`FALLÓ: ${n}`);
    console.log(resumen(sha, v.total, d.codigo));
    return d.codigo;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((e) => noVerificado(null, e && e.message ? e.message : 'error inesperado'))
    .then((c) => process.exit(c));
}

module.exports = { veredicto, dueñoRepo, sinChecksVencido, resumen, decidir, textoHttp, objetivoMerge, padresDe };
