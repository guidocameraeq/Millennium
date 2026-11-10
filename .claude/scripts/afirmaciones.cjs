'use strict';
// afirmaciones.cjs — el corrector de afirmaciones en prosa por script (SPEC-0 6.10; A §5 y §6; SPEC-paquete-5, K5). Uso, desde el repo:
//   node .claude/scripts/afirmaciones.cjs <sha-base> [--frenar]
// Corre las reglas de hooks/lib/afirmaciones.cjs sobre los renglones AGREGADOS de `git diff <sha-base> HEAD`: lo commiteado, así
// cubre igual lo que se escribió con Bash, PowerShell, Write o Edit (A §5 paso 3). Mira comentarios, docstrings, textos de error y
// viñetas de CHANGELOG; el Markdown común queda afuera (la medición: 4,1% de renglones con hallazgo en los .md de Hermes).
// AVISA, NO FRENA (K5 y RF-fix, medido contra Hermes: sobre la mitad nueva caza 5 de 9 sobre-afirmaciones de la muestra y marca 34 de 1.386
// renglones buenos; con falsos positivos, la receta dice que no se instala como freno). Sin --frenar: lista los hallazgos como
// "⚠️ a mirar" y sale 0. Con --frenar (para cuando las reglas den 0 falsos positivos): sale 1 y deja un renglón en frenos.log.
// Salidas: 0 limpio o solo avisos · 1 frena (solo con --frenar), o no se pudo leer el diff o algún archivo (NO VERIFICADO) · 2 mal llamado. Node estándar, cero
// dependencias. Es .cjs a propósito (proyectos con "type": "module").

const USO = [
  'Uso: node .claude/scripts/afirmaciones.cjs <sha-base> [--frenar]   (desde el repo)',
  '  Revisa la prosa agregada desde <sha-base> (comentarios, docstrings, textos de error, viñetas de CHANGELOG).',
  '  Sin --frenar: avisa ("⚠️ a mirar") y sale 0 · con --frenar: sale 1 si hay hallazgos y lo anota en .claude/frenos.log.',
].join('\n');

const ID_FRENO = 'gate:afirmaciones';
const HERRAMIENTA = 'afirmaciones.cjs';

class MalLlamado extends Error {}

function leerArgumentos(argv) {
  const o = { base: null, frenar: false };
  for (const a of argv) {
    if (a === '--frenar') o.frenar = true;
    else if (a.startsWith('--')) throw new MalLlamado(`opción desconocida: ${a}`);
    else if (o.base === null) o.base = a;
    else throw new MalLlamado(`sobra "${a}": un solo <sha-base>`);
  }
  if (!o.base) throw new MalLlamado('falta el <sha-base>');
  return o;
}

// La ruta de un renglón "+++ b/…": git le agrega un TAB al final si la ruta tiene espacios, y la entrecomilla al estilo C si
// tiene comillas, barras o caracteres de control (core.quotepath=false deja los acentos tal cual). Pide el diff con
// --dst-prefix=b/, así diff.noprefix o diff.mnemonicPrefix de la PC no cambian el prefijo.
function rutaDelDiff(resto) {
  const r = resto.replace(/\t$/, '');
  if (!r.startsWith('"')) return r.startsWith('b/') ? r.slice(2) : null;
  const bytes = [];
  const ESC = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 1; i < r.length - 1; i++) {
    if (r[i] !== '\\') { bytes.push(...Buffer.from(r[i], 'utf8')); continue; }
    const o = /^[0-7]{3}/.exec(r.slice(i + 1));
    if (o) { bytes.push(parseInt(o[0], 8)); i += 3; } else { bytes.push(ESC[r[i + 1]] ?? r.charCodeAt(i + 1)); i++; }
  }
  const s = Buffer.from(bytes).toString('utf8');
  return s.startsWith('b/') ? s.slice(2) : null;
}

// Los renglones agregados de un diff -U0: Map<ruta nueva, Set<número>>. Los archivos borrados no traen nada.
function agregadosDelDiff(diff) {
  const fuera = new Map();
  let ruta = null;
  let n = 0;
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('diff --git')) { ruta = null; continue; }
    if (l.startsWith('+++ ')) { ruta = l === '+++ /dev/null' ? null : rutaDelDiff(l.slice(4)); if (ruta) fuera.set(ruta, new Set()); continue; }
    if (l.startsWith('--- ')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { n = Number(m[1]); continue; }
    if (ruta && l.startsWith('+')) fuera.get(ruta).add(n++);
  }
  return fuera;
}

// juntar(agregados, leer) → { ok: true, hallazgos, archivos, sinLeer }: corre las reglas sobre cada archivo con prosa y renglones
// agregados. `leer(ruta)` → el contenido en HEAD, o null si git no lo pudo dar: ese archivo va a `sinLeer` (NO VERIFICADO, no limpio).
function juntar(agregados, leer) {
  const A = require('../hooks/lib/afirmaciones.cjs');
  const hallazgos = [];
  const sinLeer = [];
  let archivos = 0;
  for (const [ruta, numeros] of agregados) {
    if (numeros.size === 0) continue;
    if (!A.lenguaje(ruta) && !A.RE_NOTAS.test(ruta.split('/').pop())) continue;
    const contenido = leer(ruta);
    if (contenido == null) { sinLeer.push(ruta); continue; }
    archivos++;
    for (const h of A.revisar(ruta, contenido, numeros)) hallazgos.push({ ruta, ...h });
  }
  return { ok: true, hallazgos, archivos, sinLeer };
}

// revisar({ cwd, base }) → { ok: true, hallazgos: [{ ruta, linea, regla, frase, texto, alternativa }], archivos, sinLeer } | { ok: false, por }
// El diff: -M para que un `git mv` no sea prosa nueva, -w para que reindentar un bloque tampoco, y los prefijos a mano.
function revisar({ cwd, base }) {
  const git = require('../hooks/lib/git.cjs');
  const G = (args) => git.correr(['-c', 'core.quotepath=false', ...args], { cwd, tiempo: 60000 });
  const rev = G(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!rev.ok) return { ok: false, por: `la base "${base}" no es un commit de este repo` };
  const diff = G(['diff', '--no-color', '--no-ext-diff', '-M', '-w', '--src-prefix=a/', '--dst-prefix=b/', '-U0', base, 'HEAD']);
  if (!diff.ok) return { ok: false, por: 'git no pudo armar el diff' };
  return juntar(agregadosDelDiff(diff.stdout), (ruta) => {
    const c = G(['show', `HEAD:${ruta}`]);
    return c.ok ? c.stdout : null;
  });
}

// Los renglones del informe, para la terminal y para la sección del paquete del revisor.
// `tope`: cuántos hallazgos lista como mucho (el paquete corta en TOPE_PAQUETE para no tapar el diff); el resto, contado.
const TOPE_PAQUETE = 30;
function lineas(r, frenar, tope = Infinity) {
  const A = require('../hooks/lib/afirmaciones.cjs');
  if (!r.ok) return [`afirmaciones: NO VERIFICADO (${r.por})`];
  const sinLeer = r.sinLeer || [];
  const noLeidos = sinLeer.length ? [`afirmaciones: NO VERIFICADO en ${sinLeer.length} archivo(s) que git no pudo leer: ${sinLeer.join(', ')}`] : [];
  if (r.hallazgos.length === 0) {
    return sinLeer.length ? [...noLeidos, `(el resto sin hallazgos: ${r.archivos} archivo(s) con prosa revisados)`] : [`afirmaciones: limpio (${r.archivos} archivo(s) con prosa revisados)`];
  }
  const marca = frenar ? '' : '⚠️ a mirar · ';
  return [
    frenar
      ? `afirmaciones: frena · ${r.hallazgos.length} hallazgo(s): corregí la prosa o citá la evidencia (SHA, prueba, archivo:línea, cifra, NO VERIFICADO)`
      : `afirmaciones: ${r.hallazgos.length} hallazgo(s) a mirar (avisa, no frena: las reglas tienen falsos positivos medidos)`,
    ...noLeidos,
    ...r.hallazgos.slice(0, tope).map((h) => `${marca}${A.mensaje(h.ruta, h, { frenar })}`),
    ...(r.hallazgos.length > tope ? [`(+${r.hallazgos.length - tope} más, no listados)`] : []),
  ];
}

// La sección `## Afirmaciones` del paquete del revisor (la suma paquete.cjs; no cambia sus salidas).
function seccion({ cwd, base }) {
  return ['## Afirmaciones', '', ...lineas(revisar({ cwd, base }), false, TOPE_PAQUETE), ''].join('\n');
}

function main(argv, { cwd = process.cwd(), ahora = new Date() } = {}) {
  let o;
  try {
    o = leerArgumentos(argv);
  } catch (e) {
    if (!(e instanceof MalLlamado)) throw e;
    return { codigo: 2, salida: `${e.message}\n${USO}\n` };
  }
  const r = revisar({ cwd, base: o.base });
  const salida = `${lineas(r, o.frenar).join('\n')}\n`;
  if (!r.ok) return { codigo: 1, salida };
  if (!o.frenar || r.hallazgos.length === 0) return { codigo: r.sinLeer.length ? 1 : 0, salida };
  const contexto = require('../hooks/lib/contexto.cjs');
  const frenosLog = require('../hooks/lib/frenos-log.cjs');
  const raiz = contexto.raiz(cwd);
  if (raiz) {
    const rutas = [...new Set(r.hallazgos.map((h) => h.ruta))];
    frenosLog.anotar(
      raiz,
      { id: ID_FRENO, herramienta: HERRAMIENTA, detalle: `${r.hallazgos.length} hallazgo(s) en ${rutas.join(', ')}`, rol: contexto.rol(raiz), rama: contexto.rama(cwd) },
      ahora,
    );
  }
  return { codigo: 1, salida };
}

if (require.main === module) {
  let codigo = 1;
  try {
    const r = main(process.argv.slice(2));
    process.stdout.write(r.salida);
    codigo = r.codigo;
  } catch (e) {
    process.stdout.write('afirmaciones roto: corré doctor\n');
  }
  process.exitCode = codigo;
}

module.exports = { USO, ID_FRENO, HERRAMIENTA, TOPE_PAQUETE, leerArgumentos, rutaDelDiff, agregadosDelDiff, juntar, revisar, lineas, seccion, main };
