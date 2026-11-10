'use strict';
// agente.cjs — ¿la sesión es de un agente? (SPEC-paquete-3, P4.7 "Sesión de agente"). La usan git-seguro.cjs y el corrector de
// secretos de la PC (G5 la copia tal cual a pc/lib/, y la prueba anti-desvío exige que sea idéntica byte a byte).
// Node estándar, cero dependencias fuera de esta carpeta. Es .cjs a propósito: corre igual en proyectos con "type": "module".
//
// CONTRATO
//   sesionDeAgente(cwd) → { agente, rol, rama, raiz, principal, gitDir, comun, enlace }
//     agente     true si la pestaña es de obrero (rama `modulo/<x>--<ID>`, contexto.pestana) O el `.kit-rol` de la raíz es uno
//                de ROLES_AGENTE (obrero, nocturno, desconocido). Las dos, porque `.kit-rol` es justo lo que se protege: un
//                obrero que lo borra sigue siendo obrero por la rama. `actualizador`, `director` y `humano`, no.
//     rol        contexto.rol(raiz): humano sin archivo, uno de los cuatro tal cual, desconocido si no se entiende.
//     rama       la rama del HEAD de ESE checkout (null con HEAD suelto).
//     raiz       la raíz del checkout (la carpeta que tiene el `.git`, archivo o carpeta).
//     principal  la raíz del checkout principal: la carpeta que contiene el git-dir común (`<principal>/.git`).
//     gitDir     el git-dir de este checkout; comun: el git-dir común (en un worktree, `<principal>/.git`).
//     enlace     'principal' (el `.git` es una carpeta, fuera de `.claude/worktrees/`) · 'ok' (un worktree cuyo `.git` apunta a
//                `<principal>/.git/worktrees/<algo>`, y si vive en `<P>/.claude/worktrees/<x>`, ese P es el principal) ·
//                'roto' (cualquier otra cosa: un `.git` que apunta a otro repo, un clon adentro de `.claude/worktrees/`, un
//                `.git` que no se lee). Lo usa salir-del-worktree (r2-2 c).
//   Sin repo de git → { agente: false, rol: 'desconocido', rama: null, raiz: null, principal: null, … } y sin error.
//   raizDe(dir) → la raíz del checkout que contiene `dir` (lo mismo que arriba, solo por fs), o null.
//   dentroDe(ruta, carpeta) · mismaRuta(a, b): comparan rutas resueltas (sin mayúsculas en Windows).
//   ROLES_AGENTE: ['obrero', 'nocturno', 'desconocido'].
//
// BARATO: solo fs (sube carpeta por carpeta buscando `.git`, lee el `.git` archivo, `commondir` y `HEAD`). Solo si no encuentra
// ningún `.git` subiendo, prueba un `git rev-parse` (una ruta rara que git sí entiende). Nunca tira.

const fs = require('fs');
const path = require('path');
const contexto = require('./contexto.cjs');

const ROLES_AGENTE = ['obrero', 'nocturno', 'desconocido'];
const WIN = process.platform === 'win32';

const norm = (p) => {
  const r = path.resolve(p);
  return WIN ? r.toLowerCase() : r;
};
const mismaRuta = (a, b) => typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
function dentroDe(ruta, carpeta) {
  if (typeof ruta !== 'string' || typeof carpeta !== 'string') return false;
  const rel = path.relative(norm(carpeta), norm(ruta));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const leer = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return null;
  }
};
const esCarpeta = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
};

// Sube desde `dir` hasta encontrar un `.git`. → { raiz, tipo: 'dir'|'archivo'|'roto', gitDir } o null.
function buscarGit(dir) {
  let d;
  try {
    d = path.resolve(dir);
  } catch (e) {
    return null;
  }
  for (;;) {
    const p = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      st = null;
    }
    if (st) {
      if (st.isDirectory()) return { raiz: d, tipo: 'dir', gitDir: p };
      const t = leer(p);
      const m = t === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(t);
      if (!m) return { raiz: d, tipo: 'roto', gitDir: null };
      return { raiz: d, tipo: 'archivo', gitDir: path.resolve(d, m[1]) };
    }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

function raizDe(dir) {
  const b = buscarGit(dir);
  return b ? b.raiz : null;
}

// ¿La raíz vive en <P>/.claude/worktrees/<x>? → P, o null.
function principalPorRuta(raiz) {
  const wt = path.dirname(raiz);
  const cl = path.dirname(wt);
  if (path.basename(wt).toLowerCase() === 'worktrees' && path.basename(cl).toLowerCase() === '.claude') return path.dirname(cl);
  return null;
}

function ramaDe(gitDir) {
  const t = gitDir ? leer(path.join(gitDir, 'HEAD')) : null;
  const m = t === null ? null : /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(t);
  return m ? m[1] : null;
}

const VACIA = { agente: false, rol: 'desconocido', rama: null, raiz: null, principal: null, gitDir: null, comun: null, enlace: null };

function sesionDeAgente(cwd) {
  try {
    let b = buscarGit(cwd || process.cwd());
    if (!b) {
      const g = contexto.datosGit(cwd || process.cwd());
      if (!g) return { ...VACIA };
      b = { raiz: g.raiz, tipo: mismaRuta(g.gitDir, g.gitComun) ? 'dir' : 'archivo', gitDir: g.gitDir, comun: g.gitComun };
    }
    const rol = contexto.rol(b.raiz);
    let comun = null;
    let enlace = 'roto';
    if (b.tipo === 'dir') {
      comun = b.comun || b.gitDir;
      enlace = principalPorRuta(b.raiz) ? 'roto' : 'principal'; // un clon adentro de .claude/worktrees/ no es un worktree
    } else if (b.tipo === 'archivo') {
      const cd = b.comun ? null : leer(path.join(b.gitDir, 'commondir'));
      comun = b.comun || (cd === null ? b.gitDir : path.resolve(b.gitDir, cd.trim()));
      const esperado = principalPorRuta(b.raiz) || path.dirname(comun);
      const ok =
        mismaRuta(comun, path.join(esperado, '.git')) &&
        esCarpeta(comun) &&
        mismaRuta(path.dirname(b.gitDir), path.join(esperado, '.git', 'worktrees')) &&
        leer(path.join(b.gitDir, 'HEAD')) !== null;
      enlace = ok ? 'ok' : 'roto';
    }
    const principal = comun ? path.dirname(comun) : null;
    const rama = ramaDe(b.gitDir);
    const agente = contexto.pestana(rama).tipo === 'obrero' || ROLES_AGENTE.includes(rol);
    return { agente, rol, rama, raiz: b.raiz, principal, gitDir: b.gitDir, comun, enlace };
  } catch (e) {
    return { ...VACIA };
  }
}

module.exports = { ROLES_AGENTE, sesionDeAgente, raizDe, dentroDe, mismaRuta };
