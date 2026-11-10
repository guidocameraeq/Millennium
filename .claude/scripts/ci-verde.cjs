'use strict';
// ci-verde.cjs — ¿el CI de GitHub está verde para este commit? (puesta-a-punto, SPEC.md:48). Uso, desde el repo:
//   node .claude/scripts/ci-verde.cjs <sha|HEAD> [--esperar]
// Consulta los check-runs del commit en api.github.com (solo LEE). Dueño/repo salen del remote `origin`.
// Salidas: 0 todos los checks terminaron en success/skipped/neutral y hay al menos uno · 1 alguno falló (una línea por check
// fallado) o, con --esperar, no apareció ningún check en 3 min · 2 siguen corriendo (o aún no hay checks, sin --esperar).
// Error de red/API: 1 con `NO VERIFICADO: <por qué>` (regla 5 del gate). --esperar reconsulta cada 30 s hasta 25 min; pasado el
// tope, 2. La última línea es siempre el resumen. Credencial: `git credential fill`; el token va SOLO en el header Authorization
// hacia api.github.com y nunca se imprime. Sin credencial, intenta sin ella (repo público).
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

function resumen(sha, total, codigo) {
  const estado = codigo === 0 ? 'verde' : codigo === 1 ? 'rojo' : 'corriendo';
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
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
        if (res.statusCode !== 200) return reject(new Error(`la API contestó ${res.statusCode}`));
        try { resolve(JSON.parse(cuerpo)); } catch { reject(new Error('respuesta que no es JSON')); }
      });
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

async function main(argv) {
  const esperar = argv.includes('--esperar');
  const ref = argv.find((a) => !a.startsWith('--')) || 'HEAD';
  let sha;
  let dr;
  try {
    sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
    dr = dueñoRepo(git(['remote', 'get-url', 'origin']));
  } catch (e) {
    console.log(`NO VERIFICADO: no pude resolver ${ref} o el remote origin`);
    return 1;
  }
  if (!dr) {
    console.log('NO VERIFICADO: el remote origin no es un repo de github.com');
    return 1;
  }
  const tk = token();
  const inicio = Date.now();
  for (;;) {
    let v;
    try {
      v = veredicto(await checkRuns(dr.dueño, dr.repo, sha, tk));
    } catch (e) {
      console.log(`NO VERIFICADO: ${e.message}`);
      return 1;
    }
    const pasado = Date.now() - inicio;
    let codigo = v.codigo;
    if (esperar && codigo === 2) {
      if (sinChecksVencido(v.total, pasado)) {
        console.log('no apareció ningún check en 3 min');
        codigo = 1;
      } else if (pasado < TOPE_MS) {
        await dormir(CADA_MS);
        continue;
      }
    }
    for (const n of v.fallados) console.log(`FALLÓ: ${n}`);
    console.log(resumen(sha, v.total, codigo));
    return codigo;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

module.exports = { veredicto, dueñoRepo, sinChecksVencido, resumen };
