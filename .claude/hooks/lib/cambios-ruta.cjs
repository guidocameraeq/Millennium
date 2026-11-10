'use strict';
// cambios-ruta.cjs — dónde viven los cambios de método del proyecto (SPEC-paquete-2 P6.8a, D2.2 F3): UNA constante, que usan
// el script `cambios.cjs`, el candado y el `deny` de Write/Edit del settings.json del molde (su prueba compara contra esta).
// Si E0 hubiera mandado todo a `.kit/`, se cambia acá y nada más (r3-2). Está bajo .claude/hooks/**: tocarla es barrera.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const path = require('path');

const CARPETA = '.claude/cambios';
const EXTENSION = '.md';

// id = el nombre sin `.md`: <AAAA-MM-DD>-<slug>, el slug en minúsculas, números y guiones (sin guion al final ni dos seguidos).
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const esId = (id) => typeof id === 'string' && RE_ID.test(id) && id.length <= 120;

// La ruta relativa a la raíz del checkout, siempre con '/': `.claude/cambios/<id>.md`.
function rutaRelativa(id) {
  return `${CARPETA}/${id}${EXTENSION}`;
}

function rutaAbsoluta(raiz, id) {
  return path.join(raiz, ...rutaRelativa(id).split('/'));
}

function carpetaAbsoluta(raiz) {
  return path.join(raiz, ...CARPETA.split('/'));
}

// El id de una ruta relativa (con / o \), o null si no es un archivo de cambio de la carpeta (subcarpetas no cuentan).
function idDeRuta(rel) {
  const r = String(rel).replace(/\\/g, '/');
  const pre = `${CARPETA}/`;
  if (!r.startsWith(pre) || !r.endsWith(EXTENSION)) return null;
  const id = r.slice(pre.length, -EXTENSION.length);
  return esId(id) ? id : null;
}

module.exports = { CARPETA, EXTENSION, RE_SLUG, RE_ID, esId, rutaRelativa, rutaAbsoluta, carpetaAbsoluta, idDeRuta };
