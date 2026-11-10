'use strict';
// agents.cjs — el AGENTS.md opt-in (SPEC-paquete-2 P3.10 / F5). Uso:
//   node agents.cjs generar [--raiz <dir>]
// Sin --raiz, la raíz del checkout donde se corre (git rev-parse --show-toplevel).
// Si la ficha vigente (la de la rama por defecto, no la del disco) dice `multi-llm: sí`, escribe AGENTS.md en la raíz:
//   <!-- generado desde CLAUDE.md: no editar -->, un renglón vacío y el CLAUDE.md tal cual (con LF).
// Con `no`, sin el campo, sin ficha o con la ficha rota, no escribe nada. Un AGENTS.md que no trae esa primera línea no es del kit y no se pisa.
// Imprime siempre una sola línea de resultado.
// Salidas: 0 hecho o nada que hacer · 1 hay uno existente que no se pisa (o no se pudo escribir) · 2 mal llamado · 3 sin CLAUDE.md cuando hace falta.
// Node estándar, cero dependencias.

const fs = require('fs');
const path = require('path');
const git = require('../hooks/lib/git.cjs');
const contexto = require('../hooks/lib/contexto.cjs');

const ARCHIVO = 'AGENTS.md';
const FUENTE = 'CLAUDE.md';
const MARCA = '<!-- generado desde CLAUDE.md: no editar -->';

// El BOM de adelante, que algunos editores de Windows agregan.
const SIN_BOM = new RegExp('^' + String.fromCharCode(0xFEFF));

const USO = 'Uso: node agents.cjs generar [--raiz <dir>]';

function mal(mensaje) {
  process.stderr.write(`${mensaje}\n${USO}\n`);
  return 2;
}

function leerArgumentos(argv) {
  if (argv[0] !== 'generar') return { error: argv.length ? `Comando desconocido: ${argv[0]}` : 'Falta el comando.' };
  let raiz = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--raiz') {
      if (raiz !== null) return { error: '--raiz va una sola vez.' };
      if (i + 1 >= argv.length || argv[i + 1] === '' || argv[i + 1].startsWith('-')) return { error: '--raiz pide una carpeta.' };
      raiz = argv[++i];
    } else {
      return { error: `Argumento desconocido: ${argv[i]}` };
    }
  }
  return { raiz };
}

// Lo que se escribe: la marca, un renglón vacío y el CLAUDE.md tal cual (sin BOM, con LF).
function armar(claude) {
  return `${MARCA}\n\n${claude.replace(SIN_BOM, '').replace(/\r\n?/g, '\n')}`;
}

// ¿La primera línea es la marca del kit? (tolera CRLF y BOM: alguien pudo abrirlo y guardarlo en Windows)
function esDelKit(texto) {
  const primera = texto.replace(SIN_BOM, '').split('\n', 1)[0].replace(/\r$/, '');
  return primera === MARCA;
}

// Escritura atómica: temporal en la misma carpeta y renombre.
function escribirAtomico(destino, texto) {
  const tmp = path.join(path.dirname(destino), `.${path.basename(destino)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, texto, 'utf8');
    fs.renameSync(tmp, destino);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ya no estaba */
    }
    throw e;
  }
}

function decir(linea) {
  process.stdout.write(`${linea}\n`);
}

function generar(raiz) {
  const f = contexto.fichaVigente(raiz);
  if (f.estado === 'rota') {
    decir(`ficha rota: ${f.donde} — corré doctor`);
    return 0;
  }
  if (f.estado !== 'ok') {
    decir(`${ARCHIVO}: sin ficha en la rama por defecto: no genero nada`);
    return 0;
  }
  if (f.datos['multi-llm'] !== 'sí') {
    decir(`${ARCHIVO}: la ficha no pide multi-llm (multi-llm: sí): no genero nada`);
    return 0;
  }

  const destino = path.join(raiz, ARCHIVO);
  let existente = null;
  if (fs.existsSync(destino)) {
    try {
      existente = fs.readFileSync(destino, 'utf8');
    } catch (e) {
      existente = ''; // existe pero no se lee (una carpeta, permisos): no es nuestro
    }
    if (!esDelKit(existente)) {
      decir(`${ARCHIVO} ya existe y no lo generó el kit: no lo toco; si querés que lo genere, borralo o movelo`);
      return 1;
    }
  }

  let claude;
  try {
    claude = fs.readFileSync(path.join(raiz, FUENTE), 'utf8');
  } catch (e) {
    process.stderr.write(`No encuentro ${FUENTE} en ${raiz}: sin él no hay desde dónde generar ${ARCHIVO}.\n`);
    return 3;
  }

  const nuevo = armar(claude);
  if (existente === nuevo) {
    decir(`${ARCHIVO}: ya estaba al día, no lo toqué`);
    return 0;
  }
  try {
    escribirAtomico(destino, nuevo);
  } catch (e) {
    process.stderr.write(`No pude escribir ${ARCHIVO}: ${e.code || e.message}\n`);
    return 1;
  }
  decir(existente === null ? `${ARCHIVO}: creado desde ${FUENTE}` : `${ARCHIVO}: regenerado desde ${FUENTE}`);
  return 0;
}

function main(argv) {
  const a = leerArgumentos(argv);
  if (a.error) return mal(a.error);
  let raiz;
  if (a.raiz !== null) {
    raiz = path.resolve(a.raiz);
    let esCarpeta = false;
    try {
      esCarpeta = fs.statSync(raiz).isDirectory();
    } catch (e) {
      /* no existe */
    }
    if (!esCarpeta) return mal(`--raiz "${a.raiz}" no es una carpeta.`);
  } else {
    raiz = git.texto(['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
    if (!raiz) return mal('No estoy dentro de un repo de git: corrélo desde el repo o pasá --raiz.');
    raiz = path.resolve(raiz);
  }
  return generar(raiz);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, generar, leerArgumentos, armar, esDelKit, escribirAtomico, MARCA };
