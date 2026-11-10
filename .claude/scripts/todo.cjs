'use strict';
// todo.cjs — el cierre del TODO (SPEC-paquete-2 P3.6). Uso, desde la raíz del repo:
//   node todo.cjs cierre [--base <ref>]
// Poda docs/TODO.md (a 🟢 lo que lleva 90 días sin tocarse, por la edad que da git blame), escribe el resultado e imprime
//   TODO: +n −m · k ítems · j bajaron a 🟢
// Base de la comparación: --base, o el último commit que tocó docs/SESSION_HANDOFF.md (el cierre anterior).
// docs/ es la carpeta de papeles: la `carpeta-docs:` de la ficha vigente si la hay (SPEC-paquete-8r3 i1; lib/docs-ruta.cjs).
// Salidas: 0 anduvo · 2 mal llamado · 3 sin docs/TODO.md. Node estándar, cero dependencias.

const fs = require('fs');
const path = require('path');
const git = require('../hooks/lib/git.cjs');
const todo = require('../hooks/lib/todo.cjs');
const docsRuta = require('../hooks/lib/docs-ruta.cjs');

// Las dos rutas, dentro de la carpeta de papeles del checkout (8r3 i1): docs/TODO.md y docs/SESSION_HANDOFF.md sin la clave.
const rutas = (cwd) => {
  const c = docsRuta.deRaiz(cwd);
  return { RUTA_TODO: docsRuta.rel(c, 'TODO.md'), RUTA_HANDOFF: docsRuta.rel(c, 'SESSION_HANDOFF.md') };
};

const USO = 'Uso: node todo.cjs cierre [--base <ref>]   (desde la raíz del repo)';

function mal(mensaje) {
  process.stderr.write(`${mensaje}\n${USO}\n`);
  return 2;
}

function leerArgumentos(argv) {
  if (argv[0] !== 'cierre') return { error: argv.length ? `Comando desconocido: ${argv[0]}` : 'Falta el comando.' };
  let base = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--base') {
      if (i + 1 >= argv.length || argv[i + 1] === '' || argv[i + 1].startsWith('-')) return { error: '--base pide una referencia de git.' };
      base = argv[++i];
    } else {
      return { error: `Argumento desconocido: ${argv[i]}` };
    }
  }
  return { base };
}

function cierre(cwd, baseArg) {
  const { RUTA_TODO, RUTA_HANDOFF } = rutas(cwd);
  const archivo = path.join(cwd, ...RUTA_TODO.split('/'));
  let despues;
  try {
    despues = fs.readFileSync(archivo, 'utf8');
  } catch (e) {
    process.stderr.write(`No encuentro ${RUTA_TODO} en ${cwd}. Correlo desde la raíz del repo.\n`);
    return 3;
  }

  // La base: el TODO como estaba en el cierre anterior.
  let ref = baseArg;
  if (ref !== null) {
    const ok = git.correr(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    if (!ok.ok) return mal(`La referencia --base "${ref}" no existe en este repo.`);
  } else {
    ref = git.texto(['log', '-1', '--format=%H', '--', RUTA_HANDOFF], { cwd });
    if (!ref) {
      process.stdout.write(`Sin cierre anterior (${RUTA_HANDOFF} no está commiteado): comparo contra un TODO vacío.\n`);
      ref = null;
    }
  }
  let antes = '';
  if (ref) {
    const r = git.correr(['show', `${ref}:${RUTA_TODO}`], { cwd });
    if (r.ok) antes = r.stdout; // si en esa base no había TODO, se compara contra vacío
  }

  // La poda, con la edad de cada renglón.
  const edades = git.edades(RUTA_TODO, { cwd });
  if (edades === null) process.stderr.write(`No pude leer la edad de ${RUTA_TODO} (git blame falló, ¿no está commiteado?): no podo nada.\n`);
  const podado = todo.podar(despues, edades, new Date());
  if (podado.texto !== despues) fs.writeFileSync(archivo, podado.texto, 'utf8');

  process.stdout.write(`${todo.linea(todo.balance(antes, podado.texto))}\n`);
  return 0;
}

function main(argv) {
  const a = leerArgumentos(argv);
  if (a.error) return mal(a.error);
  return cierre(process.cwd(), a.base);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, cierre, leerArgumentos };
