'use strict';
// arbol.cjs — el árbol de docs/ (o de la `carpeta-docs:` de la ficha: 8r3 i1) en cuatro capas (B §4) y la regla 1 del candado (B §14) sobre UNA ruta.
// Lo usan el hook de escritura (P4.2) y `candado:raiz` (P6.1). Juzga solo la ruta: no mira el disco ni el contenido.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const SEIS = ['NORTE.md', 'MAPA.md', 'SESSION_HANDOFF.md', 'TODO.md', 'CHANGELOG.md', 'README.md'];
const TRES = ['modulos', 'referencia', 'archive'];
const ID = 'candado:raiz';

const minus = (s) => s.toLowerCase();
const SEIS_MIN = SEIS.map(minus);
const TRES_MIN = TRES.map(minus);

// Windows ignora los puntos y espacios del final de cada nombre ("docs." y "docs " son "docs"): se sacan antes de juzgar.
function limpiarNombre(s) {
  const t = s.replace(/[. ]+$/, '');
  return t === '' ? s : t;
}

// Ruta → lista de segmentos absolutos, con \ como /, y . y .. resueltos. La unidad (C:) queda como primer segmento.
function segmentos(ruta, base) {
  let r = String(ruta).replace(/\\/g, '/');
  const absoluta = r.startsWith('/') || /^[A-Za-z]:\//.test(r) || /^[A-Za-z]:$/.test(r);
  if (!absoluta) r = `${String(base).replace(/\\/g, '/')}/${r}`;
  const fuera = [];
  for (const crudo of r.split('/')) {
    if (crudo === '' || crudo === '.') continue;
    if (crudo === '..') {
      if (fuera.length > 0) fuera.pop();
      continue;
    }
    fuera.push(limpiarNombre(crudo));
  }
  return fuera;
}

// ¿`todo` empieza con `prefijo`? Sin distinguir mayúsculas.
function empiezaCon(todo, prefijo) {
  if (prefijo.length > todo.length) return false;
  for (let i = 0; i < prefijo.length; i++) if (minus(todo[i]) !== minus(prefijo[i])) return false;
  return true;
}

const esWorktree = (segs, i) =>
  segs.length > i + 3 && minus(segs[i]) === '.claude' && minus(segs[i + 1]) === 'worktrees';

// Lo relativo a la raíz que corresponde, saltando `.claude/worktrees/<x>/` (la raíz de ese worktree manda).
function relativa(raiz, ruta) {
  const abs = segmentos(ruta, raiz);
  const base = segmentos(raiz, '/');
  const bases = [base];
  // Si la raíz es un worktree (<principal>/.claude/worktrees/<x>), lo escrito en el principal también se juzga.
  const n = base.length;
  if (n >= 3 && minus(base[n - 3]) === '.claude' && minus(base[n - 2]) === 'worktrees') bases.push(base.slice(0, n - 3));
  for (const b of bases) {
    if (!empiezaCon(abs, b)) continue;
    let rel = abs.slice(b.length);
    while (esWorktree(rel, 0)) rel = rel.slice(3);
    return rel;
  }
  return null;
}

// juzgarRuta(raiz, ruta, carpeta) → null si pasa, o { id: 'candado:raiz', mensaje, ruta } si es un archivo suelto en la raíz de la
// carpeta de papeles que no es de los seis, o algo adentro de una carpeta que no es de las tres. Lo de afuera (o del repo) → null.
// `carpeta`: la `carpeta-docs:` de la ficha vigente (docs-ruta.cjs; 8r3 i1), `docs` sin ella. La pasa quien llama: así esto sigue
// sin mirar el disco ni git. Sin distinguir mayúsculas (Docs/x.md y DOCS\x.md son docs/x.md en Windows).
function juzgarRuta(raiz, ruta, carpeta) {
  if (typeof raiz !== 'string' || raiz === '' || typeof ruta !== 'string' || ruta.trim() === '') return null;
  const c = (typeof carpeta === 'string' && carpeta ? carpeta : 'docs').split('/');
  const n = c.length;
  const rel = relativa(raiz, ruta);
  if (!rel || rel.length < n + 1 || !empiezaCon(rel, c)) return null;
  const mostrar = rel.join('/');
  const papeles = rel.slice(0, n).join('/');
  if (rel.length === n + 1) {
    if (SEIS_MIN.includes(minus(rel[n]))) return null;
    return { id: ID, mensaje: `\`${papeles}/${rel[n]}\` no va ahí: a \`modulos/<x>/\` o a \`referencia/\``, ruta: mostrar };
  }
  if (TRES_MIN.includes(minus(rel[n]))) return null;
  return { id: ID, mensaje: `\`${papeles}/${rel[n]}/\` no va ahí: a \`modulos/<x>/\` o a \`referencia/\``, ruta: mostrar };
}

// carpetaDelDisco(raiz) → la `carpeta-docs:` del .claude/kit.md DEL DISCO, o null (sin ficha, sin la clave o con un valor que no se
// acepta). NO es la vigente (esa sale de git, docs-ruta.cjs): es una pista barata para lo que decide sin git (el atajo del hook de
// escritura; el arranque cuando git no respondió a tiempo). Una línea de arriba, cruda, como el arranque de emergencia (8r3 i1).
const RE_CLAVE_DISCO = /^carpeta-docs:[ \t]*(?:"([^"\r\n]*)"|([^\s"#]+))[ \t]*(?:#[^\r\n]*)?\r?$/m;
function carpetaDelDisco(raiz) {
  if (typeof raiz !== 'string' || raiz === '') return null;
  let t;
  try {
    t = require('fs').readFileSync(require('path').join(raiz, '.claude', 'kit.md'), 'utf8');
  } catch (e) {
    return null;
  }
  const m = RE_CLAVE_DISCO.exec(t);
  const v = m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  return v && require('./ficha.cjs').RE_CARPETA_DOCS.test(v) ? v : null;
}

module.exports = { SEIS, TRES, ID, juzgarRuta, carpetaDelDisco };
