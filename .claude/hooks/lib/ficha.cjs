'use strict';
// ficha.cjs — lee y valida la ficha del kit (.claude/kit.md). Node estándar, cero dependencias.
// Es .cjs a propósito: corre igual en proyectos con "type": "module".
// La gramática es CERRADA: lo que no está en la lista da error con número de línea. Nunca "lo mejor que pude".

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------- errores

class ErrorFicha extends Error {
  constructor(linea, mensaje, archivo) {
    super(armar(linea, mensaje, archivo));
    this.name = 'ErrorFicha';
    this.linea = linea;
    this.mensaje = mensaje;
    this.archivo = archivo || null;
  }
}

function armar(linea, mensaje, archivo) {
  return archivo ? `${archivo}:${linea}: ${mensaje}` : `línea ${linea}: ${mensaje}`;
}

function E(linea, mensaje) {
  throw new ErrorFicha(linea, mensaje);
}

// ---------------------------------------------------------------- utilidades

const RE_CLAVE = /^[a-z0-9][a-z0-9_-]*$/;
// La versión del kit: N.N.N o N.N.N-rc.N (D8b-3). Una sola gramática; sello, actualizar, flota y doctor usan esta.
const RE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const MAX_PROFUNDIDAD = 3;

const tiene = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const esTexto = (v) => typeof v === 'string';
const esLista = (v) => Array.isArray(v);
const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tipoDe = (v) => (esTexto(v) ? 'un texto' : esLista(v) ? 'una lista' : 'un mapa');
const esItemLista = (t) => /^-(\s|$)/.test(t);

// Corta el comentario: '#' al principio o después de un espacio, fuera de comillas dobles.
function sinComentario(s) {
  let comillas = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') comillas = !comillas;
    else if (c === '#' && !comillas && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

// ---------------------------------------------------------------- valores

function parseComillas(s, n) {
  const cierre = s.indexOf('"', 1);
  if (cierre < 0) E(n, 'comilla sin cerrar — cerrala con otra " al final del texto');
  if (cierre !== s.length - 1) E(n, 'hay texto después de la comilla de cierre — dejá solo el texto entre comillas');
  const dentro = s.slice(1, cierre);
  if (dentro.includes('\\')) E(n, 'barra \\ dentro de comillas — no se aceptan escapes, sacala o escribí otra cosa');
  return dentro;
}

// Texto sin comillas (ya recortado).
function parseTextoCrudo(s, n) {
  const c = s[0];
  if (c === "'") E(n, "comillas simples — usá comillas dobles (\") o ninguna");
  if (c === '&' || c === '*') E(n, 'ancla o alias (& o *) — no se aceptan, escribí el valor entero');
  if (c === '!') E(n, 'etiqueta (!) — no se aceptan, sacala');
  if (c === '|' || c === '>') E(n, 'texto en varias líneas (| o >) — ponelo en una sola línea, entre comillas si hace falta');
  if (s.includes('"')) E(n, 'comillas en medio del texto — poné el texto entero entre comillas dobles o sacalas');
  if (/[[\]{}]/.test(s)) E(n, 'corchete o llave suelta dentro del texto — poné el texto entre comillas dobles');
  if (/:(\s|$)/.test(s)) E(n, 'dos puntos seguidos de espacio dentro de un texto — ponelo entre comillas dobles');
  return s;
}

// Parte por comas fuera de comillas.
function dividirComas(s, n) {
  const partes = [];
  let ini = 0;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ',' && !q) {
      partes.push(s.slice(ini, i));
      ini = i + 1;
    }
  }
  if (q) E(n, 'comilla sin cerrar — cerrala con otra " antes de la coma o del cierre');
  partes.push(s.slice(ini));
  return partes;
}

function parseElemento(t, n) {
  if (t[0] === '[') E(n, 'lista dentro de otra lista — no se acepta anidar, dejá una lista plana');
  if (t[0] === '{') E(n, 'mapa dentro de una lista en línea — no se acepta anidar; usá un mapa por renglón con "- {a: x}"');
  if (t[0] === '"') return parseComillas(t, n);
  return parseTextoCrudo(t, n);
}

function parseListaLinea(s, n) {
  if (!s.endsWith(']')) E(n, 'corchete sin cerrar (o texto después del ]) — cerrá la lista con ] al final del renglón');
  const dentro = s.slice(1, -1);
  if (dentro.trim() === '') return [];
  return dividirComas(dentro, n).map((p) => {
    const t = p.trim();
    if (t === '') E(n, 'elemento vacío en la lista — sacá la coma de más');
    return parseElemento(t, n);
  });
}

function parseMapaLinea(s, n, prof, st, ruta) {
  if (!s.endsWith('}')) E(n, 'llave sin cerrar (o texto después de la }) — cerrá el mapa con } al final del renglón');
  if (prof + 1 > MAX_PROFUNDIDAD) E(n, 'más de tres niveles — aplaná la ficha, no se acepta tanta profundidad');
  const dentro = s.slice(1, -1);
  if (dentro.trim() === '') E(n, 'mapa vacío {} — poné al menos una clave o sacá el campo');
  const mapa = {};
  for (const p of dividirComas(dentro, n)) {
    const t = p.trim();
    if (t === '') E(n, 'elemento vacío en el mapa — sacá la coma de más');
    const idx = t.indexOf(':');
    if (idx < 0) E(n, 'un elemento del mapa en línea no es "clave: valor" — escribilo así dentro de las llaves');
    const clave = t.slice(0, idx);
    if (!RE_CLAVE.test(clave)) E(n, 'clave inválida en el mapa en línea — usá minúsculas, números, - y _');
    const resto = t.slice(idx + 1);
    if (resto !== '' && resto[0] !== ' ') E(n, 'falta un espacio después de los dos puntos de una clave del mapa en línea — escribí "clave: valor"');
    const v = resto.trim();
    if (v === '') E(n, 'una clave del mapa en línea no tiene valor — escribí el valor o sacá la clave');
    if (tiene(mapa, clave)) E(n, 'clave repetida en el mapa en línea — dejá una sola');
    if (v[0] === '[' || v[0] === '{') E(n, 'lista o mapa dentro de un mapa en línea — no se acepta anidar');
    mapa[clave] = v[0] === '"' ? parseComillas(v, n) : parseElemento(v, n);
    st.lineas.set(`${ruta}.${clave}`, n);
  }
  return mapa;
}

function parseValor(s, n, prof, st, ruta) {
  if (s[0] === '"') return parseComillas(s, n);
  if (s[0] === '[') return parseListaLinea(s, n);
  if (s[0] === '{') return parseMapaLinea(s, n, prof, st, ruta);
  return parseTextoCrudo(s, n);
}

// ---------------------------------------------------------------- estructura

function partirClave(it) {
  const t = it.texto;
  const idx = t.indexOf(':');
  if (idx < 0) E(it.n, 'no entiendo este renglón — tiene que ser "clave: valor"');
  const clave = t.slice(0, idx);
  if (!RE_CLAVE.test(clave)) E(it.n, 'clave inválida — usá minúsculas, números, - y _ (y dos puntos con espacio después)');
  const despues = t.slice(idx + 1);
  if (despues !== '' && despues[0] !== ' ') E(it.n, 'falta un espacio después de los dos puntos — escribí "clave: valor"');
  return { clave, resto: despues.trim() };
}

function parseMapa(st, indent, prof, ruta) {
  const mapa = {};
  while (st.i < st.items.length) {
    const it = st.items[st.i];
    if (it.indent < indent) break;
    if (it.indent > indent) E(it.n, 'sangría de más — alineá el renglón con el anterior (o poné arriba una clave sin valor)');
    if (esItemLista(it.texto)) E(it.n, 'ítem de lista "-" sin clave arriba — poné la clave y los ítems debajo, o usá [a, b]');
    const { clave, resto } = partirClave(it);
    if (tiene(mapa, clave)) E(it.n, 'clave repetida en el mismo mapa — dejá una sola');
    if (prof > MAX_PROFUNDIDAD) E(it.n, 'más de tres niveles — aplaná la ficha, no se acepta tanta profundidad');
    const rutaClave = ruta ? `${ruta}.${clave}` : clave;
    st.lineas.set(rutaClave, it.n);
    st.i++;
    if (resto === '') {
      const sig = st.items[st.i];
      if (!sig || sig.indent <= indent) E(it.n, 'campo vacío, sin valor ni nada debajo — poné [] o un valor');
      if (sig.indent > indent + 2) E(sig.n, 'salto de más de un nivel de sangría — usá exactamente 2 espacios más que la clave de arriba');
      mapa[clave] = esItemLista(sig.texto)
        ? parseListaBloque(st, indent + 2, prof, rutaClave)
        : parseMapa(st, indent + 2, prof + 1, rutaClave);
    } else {
      mapa[clave] = parseValor(resto, it.n, prof, st, rutaClave);
    }
  }
  return mapa;
}

// Lista en bloque: solo de mapas en línea, un ítem por renglón.
function parseListaBloque(st, indent, prof, ruta) {
  const lista = [];
  while (st.i < st.items.length) {
    const it = st.items[st.i];
    if (it.indent < indent) break;
    if (it.indent > indent) E(it.n, 'sangría de más — los ítems de la lista van todos alineados');
    if (!esItemLista(it.texto)) E(it.n, 'en una lista todos los renglones empiezan con "- {…}" — alineá o sacá este renglón');
    const cuerpo = it.texto.slice(1).trim();
    if (cuerpo[0] === '{') {
      const rutaItem = `${ruta}.${lista.length}`;
      st.lineas.set(rutaItem, it.n);
      lista.push(parseMapaLinea(cuerpo, it.n, prof, st, rutaItem));
    } else if (cuerpo[0] === '[') {
      E(it.n, 'lista dentro de una lista — no se acepta anidar');
    } else {
      E(it.n, 'lista de texto en bloque ("- texto") — no se acepta; escribila en una línea: [a, b]');
    }
    st.i++;
  }
  return lista;
}

function prepararItems(cabecera, primeraLinea) {
  const items = [];
  for (let k = 0; k < cabecera.length; k++) {
    const n = primeraLinea + k;
    const limpio = sinComentario(cabecera[k]).replace(/\s+$/, '');
    if (limpio.trim() === '') continue;
    const sangria = /^\s*/.exec(limpio)[0];
    if (/[^ \t]/.test(sangria)) E(n, 'espacio raro en la sangría (no es un espacio común) — usá espacios comunes');
    if (sangria.includes('\t')) E(n, 'tabulador en la sangría — usá espacios (2 por nivel)');
    if (sangria.length % 2 !== 0) E(n, 'sangría impar — usá múltiplos de 2 espacios');
    items.push({ n, indent: sangria.length, texto: limpio.slice(sangria.length) });
  }
  return items;
}

// ---------------------------------------------------------------- validación

const ESTADOS = ['molde', 'molde+propio', 'adaptada', 'adaptada (desvío detectado)', 'propia', 'sí', 'no'];
const CON_POR = ['adaptada', 'adaptada (desvío detectado)', 'propia']; // los estados que llevan su porqué (piezas.<id>.por)
const CON_DESDE = ['adaptada', 'adaptada (desvío detectado)']; // los que llevan la base de la próxima oferta (piezas.<id>.desde)
const CLASES = ['real', 'prueba', 'dummy'];
const SENSIBLES = ['datos-reales', 'plata', 'sale-afuera', 'claves', 'release'];
const CONOCIDOS = ['kit', 'nivel', 'vars', 'piezas', 'frenos', 'autorizado', 'sensible', 'secretos', 'publicas',
  'herramientas', 'entornos', 'datos-de-prueba', 'push-publica', 'aprueba', 'mesa', 'multi-llm', 'carpeta-docs', 'andamiaje'];
// `andamiaje:` (SPEC-paquete-8r4 u7, D8r4-8): quién toca CLAUDE.md, skills y agentes. Sin la clave, `agentes` (como siempre); con
// `con-ok-de-guido`, NUCLEO.md §9.4 lo hace clase 3. Es texto que se lee, no un hook.
const ANDAMIAJES = ['agentes', 'con-ok-de-guido'];
// vars.plazo-test (u8): los minutos que el sello le da a comando-test, un entero de 1 a 60 sin ceros a la izquierda.
const RE_PLAZO_TEST = /^(?:[1-9]|[1-5]\d|60)$/;

// La carpeta de papeles del método (SPEC-paquete-8r3, i1): `carpeta-docs:`, `docs` sin ella. Una ruta relativa con `/`: segmentos de
// [a-z0-9._-] (solo minúsculas: `Docs` es `docs` en el disco de Windows y otra ruta para git; rt-2) que empiezan con letra o número y
// no terminan en punto (Windows los ignora), sin `..`, sin `/` en las puntas, ≤ 80, y ningún nombre reservado de Windows (rt-10).
const RE_CARPETA_DOCS = /^(?=.{1,80}$)(?!(?:.*\/)?(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^/]*)?(?:\/|$))[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?)*$/;
const CARPETA_DOCS = 'docs';
// carpetaDocs(datos) → la carpeta de papeles de una ficha ya leída (sin la clave, o sin ficha: `docs`).
const carpetaDocs = (datos) => (datos && typeof datos['carpeta-docs'] === 'string' ? datos['carpeta-docs'] : CARPETA_DOCS);

// Los nombres que elige el usuario (piezas, entornos, alias de la mesa…) no van a los mensajes: se muestran como <nombre>.
const CON_NOMBRE_DEL_USUARIO = { piezas: '<nombre>', herramientas: '<nombre>', entornos: '<nombre>', mesa: '<alias>', autorizado: '<clave>' };
const nom = (ruta) => {
  const seg = ruta.split('.');
  if (seg.length > 1) {
    if (tiene(CON_NOMBRE_DEL_USUARIO, seg[0])) seg[1] = CON_NOMBRE_DEL_USUARIO[seg[0]];
    else if (seg[0] === 'vars' && !['proyecto', 'lenguajes', 'plazo-test'].includes(seg[1])) seg[1] = '<clave>';
  }
  return seg.join('.').replace(/\.(\d+)/g, '[$1]');
};

// Regla de oro de los mensajes: jamás repiten un valor de la ficha (el hook los imprime en el chat y ahí puede haber un secreto).
// Dicen el campo, la línea y qué se acepta.
function validar(datos, st, cierre, avisos) {
  const L = (ruta) => (st.lineas.has(ruta) ? st.lineas.get(ruta) : cierre);
  const mapa = (ruta, v) => {
    if (!esMapa(v)) E(L(ruta), `"${nom(ruta)}" tiene que ser un mapa (con sus claves debajo), no ${tipoDe(v)} — corregilo`);
  };
  const lista = (ruta, v) => {
    if (!esLista(v)) E(L(ruta), `"${nom(ruta)}" tiene que ser una lista [a, b], no ${tipoDe(v)} — escribilo entre corchetes`);
  };
  const texto = (ruta, v) => {
    if (!esTexto(v)) E(L(ruta), `"${nom(ruta)}" tiene que ser un texto, no ${tipoDe(v)} — escribí un solo valor`);
  };
  const noVacio = (ruta, v) => {
    if (v.trim() === '') E(L(ruta), `"${nom(ruta)}" está vacío — completalo`);
  };
  const uno = (ruta, v, opciones) => {
    texto(ruta, v);
    if (!opciones.includes(v)) E(L(ruta), `"${nom(ruta)}" tiene un valor que no se acepta — tiene que ser uno de: ${opciones.join(', ')}`);
  };
  const patron = (ruta, v, re, ayuda) => {
    texto(ruta, v);
    if (!re.test(v)) E(L(ruta), `"${nom(ruta)}" tiene un valor que no se acepta — ${ayuda}`);
  };
  // Clave de más: error si el mapa es cerrado (estricto), aviso si no (una PC atrasada no se tiene que trabar).
  const soloClaves = (ruta, obj, permitidas, estricto) => {
    for (const k of Object.keys(obj)) {
      if (permitidas.includes(k)) continue;
      if (estricto) E(L(`${ruta}.${k}`), `clave desconocida en "${nom(ruta)}" — las que valen son: ${permitidas.join(', ')}`);
      avisos.push(`línea ${L(`${ruta}.${k}`)}: clave desconocida \`${k}\` en \`${nom(ruta)}\` — ¿un error de tipeo? Las que se conocen son: ${permitidas.join(', ')}`);
    }
  };
  const falta = (ruta, clave) => E(L(ruta), `falta "${clave}" en "${nom(ruta)}" — agregala`);
  const requerido = (ruta, obj, clave) => {
    if (!tiene(obj, clave)) falta(ruta, clave);
  };

  // kit, nivel, vars: obligatorios
  if (!tiene(datos, 'kit')) E(cierre, 'falta "kit" — poné la versión del kit, por ejemplo "kit: 2.4.3"');
  patron('kit', datos.kit, RE_VERSION, 'tienen que ser N.N.N o N.N.N-rc.N, sin ceros a la izquierda, por ejemplo 2.4.3 o 3.0.0-rc.1');
  if (!tiene(datos, 'nivel')) E(cierre, 'falta "nivel" — poné "nivel: liviano" o "nivel: estandar"');
  uno('nivel', datos.nivel, ['liviano', 'estandar']);
  if (!tiene(datos, 'vars')) E(cierre, 'falta "vars" — poné el mapa con al menos "proyecto"');
  mapa('vars', datos.vars);
  if (!tiene(datos.vars, 'proyecto')) E(L('vars'), 'falta "proyecto" en "vars" — poné el nombre del proyecto');
  texto('vars.proyecto', datos.vars.proyecto);
  noVacio('vars.proyecto', datos.vars.proyecto);
  for (const [k, v] of Object.entries(datos.vars)) {
    const r = `vars.${k}`;
    if (k === 'lenguajes') lista(r, v);
    else if (k === 'plazo-test') patron(r, v, RE_PLAZO_TEST, 'tienen que ser los minutos del test, un entero de 1 a 60 (por ejemplo 10)');
    else if (esMapa(v)) E(L(r), `"${nom(r)}" no puede ser un mapa — dejalo como texto o lista`);
  }

  if (tiene(datos, 'piezas')) {
    mapa('piezas', datos.piezas);
    for (const [k, v] of Object.entries(datos.piezas)) {
      const r = `piezas.${k}`;
      if (esTexto(v)) uno(r, v, ESTADOS);
      else if (esMapa(v)) {
        soloClaves(r, v, ['estado', 'hash', 'por', 'desde'], false);
        requerido(r, v, 'estado');
        uno(`${r}.estado`, v.estado, ESTADOS);
        if (tiene(v, 'hash')) patron(`${r}.hash`, v.hash, /^[0-9a-f]{12}$/, 'tiene que tener 12 caracteres hexa en minúscula (0-9, a-f)');
        // por: el porqué de una adaptación (D6-19: con él, la fusión con el molde nuevo va sola) o de una pieza propia
        if (tiene(v, 'por')) {
          texto(`${r}.por`, v.por);
          noVacio(`${r}.por`, v.por);
          if (!CON_POR.includes(v.estado)) E(L(`${r}.por`), `"${nom(r)}.por" va solo en una pieza ${CON_POR.join(', ')} — sacalo o cambiá el estado`);
        }
        // desde: la versión del molde desde la que se vuelve a ofrecer una adaptada que se quedó con la suya (D8b, r1-1; lo escribe resolver)
        if (tiene(v, 'desde')) {
          patron(`${r}.desde`, v.desde, RE_VERSION, 'tiene que ser N.N.N o N.N.N-rc.N, por ejemplo 3.0.0-rc.1');
          if (!CON_DESDE.includes(v.estado)) E(L(`${r}.desde`), `"${nom(r)}.desde" va solo en una pieza ${CON_DESDE.join(', ')} — sacalo o cambiá el estado`);
        }
      } else E(L(r), `"${nom(r)}" tiene que ser un estado o {estado: …, hash: …}, no una lista — corregilo`);
    }
  }

  if (tiene(datos, 'frenos')) {
    mapa('frenos', datos.frenos);
    soloClaves('frenos', datos.frenos, ['opcionales', 'quitados'], false);
    if (tiene(datos.frenos, 'opcionales')) lista('frenos.opcionales', datos.frenos.opcionales);
    if (tiene(datos.frenos, 'quitados')) {
      lista('frenos.quitados', datos.frenos.quitados);
      const vistos = new Set();
      datos.frenos.quitados.forEach((q, i) => {
        const r = `frenos.quitados.${i}`;
        if (!esMapa(q)) E(L('frenos.quitados'), 'cada freno quitado es {id: …, por: "…", hasta: …} — escribilo así, uno por renglón');
        soloClaves(r, q, ['id', 'por', 'hasta'], false);
        for (const c of ['id', 'por', 'hasta']) {
          requerido(r, q, c);
          texto(`${r}.${c}`, q[c]);
          noVacio(`${r}.${c}`, q[c]);
        }
        patron(`${r}.id`, q.id, /^[a-z]+:\S(.*\S)?$/, 'tiene que ser <clase>:<resto> (la clase en minúsculas, el resto sin espacios al principio ni al final), por ejemplo hook:git-seguro/push-force');
        if (vistos.has(q.id)) E(L(`${r}.id`), `"${nom(r)}.id" está repetido — cada freno quitado va una sola vez`);
        vistos.add(q.id);
        if (q.hasta !== 'siempre') {
          patron(`${r}.hasta`, q.hasta, /^\d{4}-\d{2}-\d{2}$/, 'tiene que ser "siempre" o una fecha AAAA-MM-DD');
          const [a, m, d] = q.hasta.split('-').map(Number);
          const f = new Date(Date.UTC(a, m - 1, d));
          if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) {
            E(L(`${r}.hasta`), `"${nom(r)}.hasta" no es una fecha real — corregila (AAAA-MM-DD)`);
          }
        }
      });
    }
  }

  if (tiene(datos, 'sensible')) {
    mapa('sensible', datos.sensible);
    soloClaves('sensible', datos.sensible, SENSIBLES, true);
    for (const [k, v] of Object.entries(datos.sensible)) {
      const r = `sensible.${k}`;
      if (esTexto(v)) {
        if (v !== 'no') E(L(r), `"${r}" tiene que ser "no" o una lista [a, b]`);
      } else lista(r, v);
    }
  }

  for (const k of ['secretos', 'publicas']) {
    if (!tiene(datos, k)) continue;
    lista(k, datos[k]);
    datos[k].forEach((nombre, i) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(nombre)) {
        E(L(k), `el elemento ${i + 1} de "${k}" no es un nombre de variable — usá MAYUSCULAS_CON_GUION_BAJO`);
      }
    });
  }

  // herramientas: lo que se puede usar, con su chequeo de una línea; cada entorno nombra las suyas (más abajo).
  if (tiene(datos, 'herramientas')) {
    mapa('herramientas', datos.herramientas);
    for (const [k, v] of Object.entries(datos.herramientas)) {
      const r = `herramientas.${k}`;
      mapa(r, v);
      soloClaves(r, v, ['chequeo', 'necesita-guido'], false);
      requerido(r, v, 'chequeo');
      texto(`${r}.chequeo`, v.chequeo);
      noVacio(`${r}.chequeo`, v.chequeo);
      requerido(r, v, 'necesita-guido');
      uno(`${r}.necesita-guido`, v['necesita-guido'], ['sí', 'no']);
    }
  }
  const declaradas = tiene(datos, 'herramientas') ? datos.herramientas : {};

  if (tiene(datos, 'entornos')) {
    mapa('entornos', datos.entornos);
    for (const [k, v] of Object.entries(datos.entornos)) {
      const r = `entornos.${k}`;
      mapa(r, v);
      soloClaves(r, v, ['clase', 'herramientas', 'acceso'], false);
      requerido(r, v, 'clase');
      uno(`${r}.clase`, v.clase, CLASES);
      if (tiene(v, 'herramientas')) {
        lista(`${r}.herramientas`, v.herramientas);
        v.herramientas.forEach((nombre, i) => {
          if (!tiene(declaradas, nombre)) {
            E(L(`${r}.herramientas`), `el elemento ${i + 1} de "${nom(r)}.herramientas" no está declarado en "herramientas" — agregalo arriba`);
          }
        });
      }
      if (tiene(v, 'acceso')) texto(`${r}.acceso`, v.acceso);
    }
  }

  if (tiene(datos, 'mesa')) {
    mapa('mesa', datos.mesa);
    for (const [k, v] of Object.entries(datos.mesa)) {
      const r = `mesa.${k}`;
      mapa(r, v);
      soloClaves(r, v, ['contacto', 'transporte'], false);
      requerido(r, v, 'contacto');
      texto(`${r}.contacto`, v.contacto);
      noVacio(`${r}.contacto`, v.contacto);
      // transporte es opcional: si falta, quien la usa asume git (G §12)
      if (tiene(v, 'transporte')) uno(`${r}.transporte`, v.transporte, ['git', 'buzon']);
    }
  }

  for (const k of ['push-publica', 'multi-llm']) {
    if (tiene(datos, k)) uno(k, datos[k], ['sí', 'no']);
  }
  if (tiene(datos, 'andamiaje')) uno('andamiaje', datos.andamiaje, ANDAMIAJES);
  if (tiene(datos, 'aprueba')) patron('aprueba', datos.aprueba, /^[a-z0-9-]+$/, 'tiene que ser un alias en minúsculas (a-z, 0-9, -), nunca un nombre real');
  if (tiene(datos, 'autorizado')) {
    mapa('autorizado', datos.autorizado);
    for (const [k, v] of Object.entries(datos.autorizado)) texto(`autorizado.${k}`, v);
  }
  if (tiene(datos, 'datos-de-prueba')) texto('datos-de-prueba', datos['datos-de-prueba']);
  if (tiene(datos, 'carpeta-docs')) {
    patron('carpeta-docs', datos['carpeta-docs'], RE_CARPETA_DOCS,
      'tiene que ser una carpeta del repo con / (como docs o arti-docs): minúsculas, números, . _ -, cada parte empieza con letra o número, sin .. ni / en las puntas ni nombres reservados de Windows (con, nul…), hasta 80');
  }

  // Campos de arriba desconocidos: aviso, no error (una PC atrasada no se tiene que trabar).
  for (const k of Object.keys(datos)) {
    if (!CONOCIDOS.includes(k)) avisos.push(`línea ${L(k)}: campo desconocido \`${k}\` — ¿un error de tipeo?`);
  }
}

// ---------------------------------------------------------------- biblioteca

// La gramática sola: parte la cabecera (hasta el primer --- en la columna 0) y la parsea. Sin ninguna regla de campos.
function parsearCabecera(texto) {
  let t = String(texto);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n');
  const lineas = t.split('\n');

  if (lineas[0] !== '---') E(1, 'la ficha tiene que empezar con --- en la primera línea — agregala');
  let cierre = -1;
  for (let i = 1; i < lineas.length; i++) {
    if (lineas[i] === '---') {
      cierre = i;
      break;
    }
  }
  if (cierre < 0) E(1, 'la cabecera no se cierra — agregá una línea con solo --- después de los campos');

  const items = prepararItems(lineas.slice(1, cierre), 2);
  const st = { items, i: 0, lineas: new Map() };
  const datos = parseMapa(st, 0, 1, '');
  return { datos, st, lineas, cierre };
}

// Para los archivos que usan la gramática de la ficha sin ser la ficha (los cambios de método): {datos, avisos} sin validar nada
// más que la gramática. Un error de gramática da ErrorFicha con su línea, igual que leer; los avisos de campos desconocidos son de leer.
function leerCabecera(texto) {
  const { datos } = parsearCabecera(texto);
  return { datos, avisos: [] };
}

function leer(texto) {
  const { datos, st, lineas, cierre } = parsearCabecera(texto);
  const avisos = [];
  validar(datos, st, cierre + 1, avisos);
  return { datos, prosa: lineas.slice(cierre + 1).join('\n'), avisos };
}

function leerArchivo(ruta) {
  const bytes = fs.readFileSync(ruta);
  try {
    // UTF-16 (el "Guardar como" de algunos editores de Windows) se lee como basura: se frena con un mensaje claro.
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
      E(1, 'la ficha está guardada en UTF-16 — guardala en UTF-8');
    }
    return leer(bytes.toString('utf8'));
  } catch (e) {
    if (e instanceof ErrorFicha) throw new ErrorFicha(e.linea, e.mensaje, ruta);
    throw e;
  }
}

// sha256 sin BOM y con CRLF -> LF, 12 primeros caracteres hexa. Acepta string o Buffer.
function hash(contenido) {
  let buf;
  if (Buffer.isBuffer(contenido)) {
    const conBom = contenido.length >= 3 && contenido[0] === 0xef && contenido[1] === 0xbb && contenido[2] === 0xbf;
    buf = Buffer.from((conBom ? contenido.subarray(3) : contenido).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  } else {
    buf = Buffer.from(String(contenido).replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8');
  }
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// Orden: por los tres números; con los mismos, -rc.N antes que el final, y entre rc por N (3.0.0-rc.1 < 3.0.0-rc.2 < 3.0.0 < 3.0.1-rc.1).
function compararVersiones(a, b) {
  const p = [a, b].map((v) => {
    const m = typeof v === 'string' ? RE_VERSION.exec(v) : null;
    if (!m) throw new Error('versión inválida — tiene que ser N.N.N o N.N.N-rc.N (sin ceros a la izquierda)');
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  });
  for (let i = 0; i < 4; i++) {
    if (p[0][i] !== p[1][i]) return p[0][i] < p[1][i] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- línea de comandos

const USO = [
  'uso: node ficha.cjs <subcomando> ...',
  '  leer <archivo>            imprime los datos de la ficha en JSON (avisos por stderr)',
  '  campo <archivo> <a.b.c>   imprime un campo (texto plano, o JSON si es lista o mapa)',
  '  hash <archivo>            12 hexa del sha256 con fines de línea LF',
  '  version                   versión instalada, del proyecto y canónica',
  'salidas: 0 bien · 1 ficha malformada o inválida · 2 mal llamado · 3 no hay ficha · 4 campo ausente',
].join('\n');

function out(s) {
  process.stdout.write(s);
}
function err(s) {
  process.stderr.write(s);
}

function leerParaCli(archivo) {
  try {
    return { r: leerArchivo(archivo) };
  } catch (e) {
    if (e instanceof ErrorFicha) {
      err(`${e.message}\n`);
      return { codigo: 1 };
    }
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      err(`${archivo}: no hay ficha — valen los frenos de fábrica\n`);
      return { codigo: 3 };
    }
    err(`${archivo}: no se pudo leer la ficha (${e && e.code ? e.code : e}) — revisá la ruta y los permisos\n`);
    return { codigo: 1 };
  }
}

function raizGit(desde) {
  let d = path.resolve(desde);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const padre = path.dirname(d);
    if (padre === d) return null;
    d = padre;
  }
}

function versionDeArchivo(ruta) {
  let t;
  try {
    t = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    return { falta: e && e.code === 'ENOENT' ? `no existe ${ruta}` : `no se pudo leer ${ruta}` };
  }
  const primera = t.replace(/^﻿/, '').split(/\r?\n/)[0].trim();
  if (!RE_VERSION.test(primera)) return { falta: `${ruta} no tiene el formato N.N.N o N.N.N-rc.N` };
  return { valor: primera };
}

// La carpeta del usuario, como la ve Claude Code: USERPROFILE en Windows, HOME en POSIX (os.homedir respeta eso).
function carpetaDelUsuario() {
  try {
    return os.homedir() || '';
  } catch (e) {
    return '';
  }
}

function subVersion() {
  const home = carpetaDelUsuario();
  const instalada = home
    ? versionDeArchivo(path.join(home, '.claude', 'VERSION'))
    : { falta: 'no se sabe cuál es la carpeta del usuario' };
  const raiz = raizGit(process.cwd());
  let proyecto;
  let canonica;
  if (!raiz) {
    proyecto = { falta: 'no estás dentro de un repo git' };
    canonica = { falta: 'no estás dentro de un repo git' };
  } else {
    const fichaRuta = path.join(raiz, '.claude', 'kit.md');
    if (fs.existsSync(fichaRuta)) {
      const res = leerParaCli(fichaRuta);
      if (res.codigo) return res.codigo;
      proyecto = { valor: res.r.datos.kit };
    } else {
      proyecto = { falta: `este repo no tiene .claude/kit.md` };
    }
    const kitVersion = path.join(raiz, 'kit', 'VERSION');
    canonica = fs.existsSync(kitVersion) ? versionDeArchivo(kitVersion) : { falta: 'no hay kit/VERSION: no es el repo de vibe-kit' };
  }
  const f = (x) => x.valor || `— (${x.falta})`;
  let linea = `instalada: ${f(instalada)} · proyecto: ${f(proyecto)} · canónica: ${f(canonica)}`;
  if (instalada.valor && canonica.valor && compararVersiones(instalada.valor, canonica.valor) < 0) {
    linea += ' → esta PC está atrás: actualizate';
  }
  if (proyecto.valor && instalada.valor && compararVersiones(proyecto.valor, instalada.valor) < 0) {
    linea += ' → hay kit nuevo para este proyecto';
  }
  out(`${linea}\n`);
  return 0;
}

function cli(argv) {
  const [sub, ...args] = argv;
  const malLlamado = (porque) => {
    err(`${porque}\n${USO}\n`);
    return 2;
  };
  switch (sub) {
    case 'leer': {
      if (args.length !== 1) return malLlamado('leer necesita un archivo');
      const res = leerParaCli(args[0]);
      if (res.codigo) return res.codigo;
      out(`${JSON.stringify(res.r.datos, null, 2)}\n`);
      for (const a of res.r.avisos) err(`${args[0]}: ${a}\n`);
      return 0;
    }
    case 'campo': {
      if (args.length !== 2) return malLlamado('campo necesita un archivo y una ruta a.b.c');
      const res = leerParaCli(args[0]);
      if (res.codigo) return res.codigo;
      let v = res.r.datos;
      for (const p of args[1].split('.')) {
        if (esMapa(v) && tiene(v, p)) v = v[p];
        else if (esLista(v) && /^\d+$/.test(p) && Number(p) < v.length) v = v[Number(p)];
        else {
          err(`campo ausente: ${args[1]}\n`);
          return 4;
        }
      }
      out(typeof v === 'string' ? `${v}\n` : `${JSON.stringify(v)}\n`);
      return 0;
    }
    case 'hash': {
      if (args.length !== 1) return malLlamado('hash necesita un archivo');
      let buf;
      try {
        buf = fs.readFileSync(args[0]);
      } catch (e) {
        err(`${args[0]}: no se pudo leer el archivo\n`);
        return e && e.code === 'ENOENT' ? 3 : 1;
      }
      out(`${hash(buf)}\n`);
      return 0;
    }
    case 'version': {
      if (args.length !== 0) return malLlamado('version no lleva argumentos');
      return subVersion();
    }
    default:
      return malLlamado(sub ? `subcomando desconocido: ${sub}` : 'falta el subcomando');
  }
}

module.exports = { leer, leerCabecera, leerArchivo, hash, compararVersiones, RE_VERSION, ErrorFicha, RE_CARPETA_DOCS, CARPETA_DOCS, carpetaDocs };

if (require.main === module) {
  process.exitCode = cli(process.argv.slice(2));
}
