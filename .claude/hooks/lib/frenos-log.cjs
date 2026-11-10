'use strict';
// frenos-log.cjs — el registro de frenos: un renglón por frenada, solo agregar (A §4; SPEC-paquete-2, Cruces 9).
//   <AAAA-MM-DDTHH:MM:SS±hh:mm> · <rol> · <rama> · <id> · <herramienta> · <detalle>
// UTF-8, LF. El detalle es una ruta relativa o un texto fijo, NUNCA un valor que escribió el usuario: igual se neutraliza
// todo lo que rompería el renglón (saltos de línea, controles y el separador " · ").
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');

// La ruta, relativa a la raíz del checkout. E0 confirmó que queda en .claude/ (si cambiara a .kit/, se cambia acá y nada más).
const RUTA = '.claude/frenos.log';
const SEP = ' · ';
const LARGO_MAX = 500; // por campo: un renglón del registro no es un lugar para textos largos

function rutaAbsoluta(raiz) {
  return path.join(raiz, ...RUTA.split('/'));
}

const dos = (n) => String(n).padStart(2, '0');

// Hora local con su desfasaje: 2026-10-28T14:03:09-03:00.
function fechaConZona(d) {
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}` +
    `T${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}` +
    `${signo}${dos(Math.floor(abs / 60))}:${dos(abs % 60)}`
  );
}

// Un campo seguro para el renglón: sin controles ni separadores de línea Unicode, sin "·", sin espacios de más, con tope.
function campo(valor, siVacio) {
  let s = valor == null ? '' : String(valor);
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  s = s.replace(/·/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > LARGO_MAX) s = `${s.slice(0, LARGO_MAX - 1)}…`;
  return s === '' ? siVacio : s;
}

// renglon({id, herramienta, detalle, rol, rama}, ahora) → el texto del renglón, sin el fin de línea.
function renglon(datos, ahora = new Date()) {
  const d = datos || {};
  return [
    fechaConZona(ahora),
    campo(d.rol, 'desconocido'),
    campo(d.rama, '(sin rama)'),
    campo(d.id, '(sin id)'),
    campo(d.herramienta, '-'),
    campo(d.detalle, '-'),
  ].join(SEP);
}

// anotar(raiz, {id, herramienta, detalle, rol, rama}, ahora) → el renglón escrito (sin el LF).
// Solo agrega. Si el archivo no termina en LF (lo tocó alguien a mano), primero cierra ese renglón para no pegarse.
function anotar(raiz, datos, ahora = new Date()) {
  if (typeof raiz !== 'string' || raiz === '') throw new Error('frenos-log: falta la raíz del checkout');
  const archivo = rutaAbsoluta(raiz);
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const linea = renglon(datos, ahora);
  let previo = '';
  try {
    const st = fs.statSync(archivo);
    if (st.size > 0) {
      const fd = fs.openSync(archivo, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) previo = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  fs.appendFileSync(archivo, `${previo}${linea}\n`, { encoding: 'utf8', flag: 'a' });
  return linea;
}

module.exports = { RUTA, SEP, LARGO_MAX, rutaAbsoluta, fechaConZona, renglon, anotar };
