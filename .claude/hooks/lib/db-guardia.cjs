'use strict';
// db-guardia.cjs — la guardia de `db migrar` (SPEC-0 6.6 y criterio 19; F §13; RT3-4; SPEC-paquete-3 P6.6 y D-4). La llama el
// comando `db` de cada stack ANTES de aplicar una migración; no toca ninguna base. Contra un entorno de clase `real`:
//   1. pide un veredicto aprobado del revisor para ESE plan: `.claude/revisiones/<hash>.md` commiteado en HEAD (se lee con
//      `git show`, nunca del disco), con `veredicto: aprobado` y `hash: <hash>`; si no, `db:sin-veredicto` (hasta que exista el
//      revisor, orden 5, toda migración real se niega: está bien);
//   2. si el SQL borra datos reales (DELETE/DROP TABLE/TRUNCATE/ALTER … DROP sobre una `tabla:<x>` de `sensible.datos-reales`, o
//      DROP SCHEMA/DATABASE siempre): con `pregunta:borrar-datos-reales` quitado y vigente sigue; de noche (un rol sin persona, o
//      la marca `.kit-noche`: contexto.deNoche)
//      `db:borra-de-noche` con PARADA; de día, sin `--borra-datos-reales`, `db:borra-datos-reales` con la línea lista; con la
//      bandera pasa (la ventana la pone el hook `sensible`, D-4).
// La ficha es la VIGENTE (regla 4.7: lo de la rama por defecto, no lo del worktree). Sin ficha, ficha rota o entorno no declarado
// → se trata como `real` (ruidoso antes que mudo) y, sin lista legible de tablas, toda tabla cuenta como datos reales.
// Los `db:*` no se quitan con `frenos.quitados`: lo único quitable es la pregunta de A (`pregunta:borrar-datos-reales`).
// NO ES FRONTERA: un script que llama a la base por otro lado (psql, un cliente, el panel) no pasa por acá. Es el cinturón del
// camino de siempre; la frontera son los permisos de la base y el `deny` del molde.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const contexto = require('./contexto.cjs');
const ficha = require('./ficha.cjs');
const git = require('./git.cjs');

const CARPETA_REVISIONES = '.claude/revisiones';
const BANDERA = '--borra-datos-reales';
const QUITABLE = 'pregunta:borrar-datos-reales';
// Los roles con una persona del otro lado (de día). Lo demás (nocturno, actualizador, desconocido) es "de noche".
const ROLES_DE_DIA = ['humano', 'director', 'obrero'];
const ROTO = 'freno roto: corré doctor';

// ---------------------------------------------------------------- el hash del plan

// hashPlan(plan) → 12 hexa: ficha.hash de `ruta\0texto\0` de cada archivo, ordenados por ruta (orden de código, no de idioma).
// La ruta va con `/` (en Windows llega con `\`): el mismo plan da el mismo hash en las dos PCs.
function hashPlan(plan) {
  const archivos = validarPlan(plan);
  const orden = archivos.slice().sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
  return ficha.hash(orden.map((a) => `${a.ruta}\0${a.texto}\0`).join(''));
}

// Lista de {ruta, texto} con textos de verdad y rutas sin repetir; si no, tira (juzgar lo traduce a db:plan-roto).
function validarPlan(plan) {
  if (!Array.isArray(plan)) throw new TypeError('el plan no es una lista de archivos');
  const vistas = new Set();
  return plan.map((a, i) => {
    if (!a || typeof a !== 'object' || typeof a.ruta !== 'string' || typeof a.texto !== 'string' || a.ruta.trim() === '') {
      throw new TypeError(`el archivo ${i + 1} del plan no es {ruta, texto}`);
    }
    const ruta = a.ruta.replace(/\\/g, '/');
    if (vistas.has(ruta)) throw new TypeError(`la ruta ${ruta} está dos veces en el plan`);
    vistas.add(ruta);
    return { ruta, texto: a.texto };
  });
}

// ---------------------------------------------------------------- ¿borra datos reales?

// El SQL sin comentarios. Un comentario se saca solo si cierra (`-- …` hasta el fin del renglón; `/* … */`, anidado como en
// Postgres): uno sin cerrar queda, y lo que sigue se mira. Los textos y nombres entre comillas se saltean para no confundir un
// `--` adentro con un comentario, pero QUEDAN: un `EXECUTE 'DELETE FROM clientes'` borra igual. `barra`: si `\` escapa adentro
// de '…' (MySQL, E'…'); `dolar`: si `$tag$…$tag$` es un texto (Postgres) y no código. Se corre con las tres lecturas y se suma
// lo que encuentra cada una (ruidoso antes que mudo): un `--` adentro de un texto nunca esconde lo que sigue.
function sinComentarios(sql, barra, dolar) {
  let out = '';
  let i = 0;
  const n = sql.length;
  const cierre = { "'": "'", '"': '"', '`': '`', '[': ']' };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const fin = sql.indexOf('\n', i);
      if (fin === -1) break;
      out += '\n';
      i = fin + 1;
      continue;
    }
    if (c === '/' && d === '*') {
      let prof = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          prof++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          prof--;
          j += 2;
          if (prof === 0) break;
        } else j++;
      }
      if (prof !== 0) return out + sql.slice(i); // sin cerrar: queda todo
      out += ' ';
      i = j;
      continue;
    }
    if (dolar && c === '$' && !/[a-z0-9_$À-￿]/i.test(sql[i - 1] || '')) {
      const t = sql.slice(i).match(/^\$([a-z_][a-z0-9_]*)?\$/i);
      if (t) {
        const fin = sql.indexOf(t[0], i + t[0].length);
        if (fin === -1) return out + sql.slice(i); // sin cerrar: queda todo
        out += sql.slice(i, fin + t[0].length);
        i = fin + t[0].length;
        continue;
      }
    }
    if (cierre[c]) {
      const fin = cierre[c];
      let j = i + 1;
      let cerro = false;
      while (j < n) {
        if (barra && c === "'" && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === fin) {
          if (fin !== ']' && sql[j + 1] === fin) {
            j += 2; // '' o "" escapadas
            continue;
          }
          cerro = true;
          j++;
          break;
        }
        j++;
      }
      if (!cerro) return out + sql.slice(i); // sin cerrar: queda todo
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const PARTE = '(?:"(?:[^"]|"")+"|\\[[^\\]]+\\]|`[^`]+`|[a-z_\\u00c0-\\uffff][a-z0-9_$\\u00c0-\\uffff]*)';
const NOMBRE = `${PARTE}(?:\\s*\\.\\s*${PARTE})*`;
const RE_NOMBRE = new RegExp(NOMBRE, 'g');
const RE_PARTE = new RegExp(PARTE, 'g');

// El nombre de la tabla sin esquema, sin comillas ni corchetes, en minúsculas: `public."Clientes"` → clientes.
function nombreSolo(calificado) {
  const partes = String(calificado).toLowerCase().match(RE_PARTE);
  if (!partes) return '';
  let p = partes[partes.length - 1];
  if (p.startsWith('"')) p = p.slice(1, -1).replace(/""/g, '"');
  else if (p.startsWith('[') || p.startsWith('`')) p = p.slice(1, -1);
  return p.trim();
}

// Las palabras de SQL que aparecen entre los nombres de un DELETE/DROP/TRUNCATE y que no son tablas (pesan cuando, sin ficha
// legible, toda tabla cuenta). Una tabla que se llame así entre comillas sigue contando: el filtro mira la palabra suelta.
const PALABRAS = new Set(
  ('from only top percent join inner left right full outer cross natural lateral on using as and or not in is null ' +
    'returning output cascade restrict restart continue identity if exists table with nolock').split(' '),
);

// Los nombres de tabla que aparecen en un pedazo de sentencia.
function nombresEn(pedazo) {
  return (pedazo.match(RE_NOMBRE) || []).filter((x) => !PALABRAS.has(x)).map(nombreSolo);
}

// Hasta el `;` siguiente (o el final).
function sentencia(texto, desde) {
  const fin = texto.indexOf(';', desde);
  return texto.slice(desde, fin === -1 ? texto.length : fin);
}

// Lo que borra un SQL ya sin comentarios y en minúsculas: lista de "<qué> <tabla>" (vacía si no borra).
function borraEn(t, cuenta) {
  const hallado = [];
  const anotar = (que, tabla) => {
    const s = tabla ? `${que} ${tabla}` : que;
    if (!hallado.includes(s)) hallado.push(s);
  };
  let m;

  // DROP SCHEMA / DROP DATABASE: siempre.
  const reBase = /\bdrop\s+(schema|database)\b/g;
  while ((m = reBase.exec(t))) anotar(`DROP ${m[1].toUpperCase()}`);

  // DELETE [TOP (n) [PERCENT]] [FROM] …: lo que está antes del WHERE (el destino, y los de un DELETE con JOIN o USING).
  const reDelete = /\bdelete\s+/g;
  while ((m = reDelete.exec(t))) {
    let s = sentencia(t, m.index + m[0].length);
    const w = s.search(/\bwhere\b/);
    if (w !== -1) s = s.slice(0, w);
    for (const x of nombresEn(s)) if (cuenta(x)) anotar('DELETE FROM', x);
  }

  // DROP TABLE [IF EXISTS] a, b … (el IF EXISTS cae solo: "if" y "exists" están en PALABRAS).
  const reDrop = /\bdrop\s+table\s+/g;
  while ((m = reDrop.exec(t))) {
    for (const x of nombresEn(sentencia(t, m.index + m[0].length))) if (cuenta(x)) anotar('DROP TABLE', x);
  }

  // TRUNCATE [TABLE] [ONLY] a, b … (no la función truncate(x, 0): pide un nombre, no un paréntesis).
  const reTrunc = /\btruncate\s+(?:table\s+)?(?=[^\s(])/g;
  while ((m = reTrunc.exec(t))) {
    for (const x of nombresEn(sentencia(t, m.index + m[0].length))) if (cuenta(x)) anotar('TRUNCATE', x);
  }

  // ALTER TABLE [IF EXISTS] [ONLY] <t> … DROP … (en la misma sentencia).
  const reAlter = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${NOMBRE})`, 'g');
  while ((m = reAlter.exec(t))) {
    const x = nombreSolo(m[1]);
    if (cuenta(x) && /\bdrop\b/.test(sentencia(t, m.index + m[0].length))) anotar('ALTER TABLE … DROP', x);
  }
  return hallado;
}

// Las tres lecturas: SQL estándar, `\` que escapa, `$$` que es texto.
const LECTURAS = [
  [false, false],
  [true, false],
  [false, true],
];

// borra(texto, tablas) → lista de lo que borra (vacía si no borra). `tablas`: nombres (con esquema o sin, con comillas o sin; se
// compara el último pedazo, sin mayúsculas). `null`: no hay lista legible y TODA tabla cuenta.
function borra(texto, tablas) {
  const set = tablas === null ? null : new Set((Array.isArray(tablas) ? tablas : []).map(nombreSolo).filter(Boolean));
  const cuenta = (x) => x !== '' && (set === null || set.has(x));
  const t = String(texto);
  const hallado = [];
  for (const [barra, dolar] of LECTURAS) {
    for (const s of borraEn(sinComentarios(t, barra, dolar).toLowerCase(), cuenta)) if (!hallado.includes(s)) hallado.push(s);
  }
  return hallado;
}

// Las tablas de `sensible.datos-reales` (las entradas `tabla:<nombre>`); null si no hay ficha legible.
function tablasDe(datos) {
  if (!datos) return null;
  const s = datos.sensible && typeof datos.sensible === 'object' ? datos.sensible['datos-reales'] : undefined;
  if (!Array.isArray(s)) return [];
  return s.filter((e) => typeof e === 'string' && e.startsWith('tabla:')).map((e) => e.slice('tabla:'.length));
}

// ---------------------------------------------------------------- el veredicto

const dos = (x) => String(x).padStart(2, '0');
const hoyLocal = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// ¿`pregunta:borrar-datos-reales` quitado con hasta: vigente (siempre, o una fecha que no pasó; el día de hasta incluido)?
function quitadoVigente(datos, ahora) {
  const q = datos && datos.frenos && Array.isArray(datos.frenos.quitados) ? datos.frenos.quitados : [];
  const hoy = hoyLocal(ahora);
  return q.some((x) => x && x.id === QUITABLE && (x.hasta === 'siempre' || (typeof x.hasta === 'string' && RE_FECHA.test(x.hasta) && x.hasta >= hoy)));
}

// El veredicto de <hash> en HEAD: null si vale; si no, el porqué (para el motivo).
function faltaVeredicto(raiz, h) {
  const rel = `${CARPETA_REVISIONES}/${h}.md`;
  const r = raiz ? git.correr(['show', `HEAD:${rel}`], { cwd: raiz }) : { ok: false };
  if (!r.ok) {
    let enDisco = false;
    try {
      enDisco = !!raiz && fs.existsSync(path.join(raiz, ...rel.split('/')));
    } catch (e) {
      /* da igual: falta */
    }
    return enDisco ? `${rel} está en el disco pero no commiteado: commitealo` : `no hay ${rel} commiteado`;
  }
  const renglones = r.salida.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const valores = (clave) =>
    renglones.map((l) => l.match(new RegExp(`^\\s*${clave}\\s*:\\s*(.*?)\\s*$`, 'i'))).filter(Boolean).map((x) => x[1]);
  const veredictos = valores('veredicto');
  const hashes = valores('hash');
  if (veredictos.length === 0 || veredictos.some((v) => v !== 'aprobado')) return `${rel} no dice "veredicto: aprobado"`;
  if (hashes.length === 0 || hashes.some((v) => v !== h)) return `${rel} no dice "hash: ${h}" (es de otro plan)`;
  return null;
}

// ---------------------------------------------------------------- juzgar

const niega = (id, motivo) => ({ ok: false, niega: true, id, motivo });

// juzgar({raiz, entorno, plan, rol, banderas, ahora}) → {ok: true} · {ok: false, niega: true, id, motivo}. Nunca tira.
function juzgar(pedido = {}) {
  try {
    return juzgarSinRed(pedido || {});
  } catch (e) {
    return niega('db:guardia-rota', `${ROTO} (la guardia de db no pudo juzgar: no se aplica nada).`);
  }
}

function juzgarSinRed({ raiz, entorno, plan, rol, banderas, ahora }) {
  let archivos;
  try {
    archivos = validarPlan(plan);
  } catch (e) {
    return niega('db:plan-roto', `la guardia de db no recibió un plan que entienda (${e.message}): no se aplica nada.`);
  }
  const r = raiz || (contexto.datosGit(process.cwd()) || {}).raiz || null;
  const fv = r ? contexto.fichaVigente(r) : { estado: 'sin-ficha' };
  const datos = fv.estado === 'ok' ? fv.datos : null;
  const nombre = typeof entorno === 'string' ? entorno.trim() : '';
  const entornos = datos && datos.entornos && typeof datos.entornos === 'object' ? datos.entornos : {};
  const declarado = nombre !== '' && Object.prototype.hasOwnProperty.call(entornos, nombre) ? entornos[nombre] : null;
  const clase = declarado && typeof declarado.clase === 'string' ? declarado.clase : 'real';
  if (clase !== 'real') return { ok: true };

  const porque = !datos
    ? fv.estado === 'rota'
      ? ` (la ficha está rota en ${fv.donde}: se trata como real)`
      : ' (no hay ficha vigente: se trata como real)'
    : !declarado
      ? ` (el entorno «${nombre || '(sin nombre)'}» no está en entornos: de la ficha: se trata como real)`
      : '';
  const cual = `«${nombre || '(sin nombre)'}»`;

  // 1. El veredicto del revisor para ESTE plan.
  const h = hashPlan(archivos);
  const falta = faltaVeredicto(r, h);
  if (falta) {
    return niega(
      'db:sin-veredicto',
      `esta migración va contra ${cual}, de clase real${porque}, y necesita un veredicto aprobado del revisor para este plan ` +
        `(hash ${h}): ${falta}. Probala antes contra un entorno dummy o prueba, y para la real pedí la revisión; ` +
        'si cambiás un archivo del plan, el hash cambia y hace falta otro veredicto.',
    );
  }

  // 2. ¿Borra datos reales?
  const tablas = tablasDe(datos);
  const lo = [];
  for (const a of archivos) for (const s of borra(a.texto, tablas)) if (!lo.includes(s)) lo.push(s);
  if (lo.length === 0) return { ok: true };
  const que = lo.join(', ');
  if (quitadoVigente(datos, ahora instanceof Date ? ahora : new Date())) return { ok: true };

  const quien = typeof rol === 'string' && rol.trim() !== '' ? rol.trim() : contexto.rol(r);
  // Con un rol de día, la marca .kit-noche (la del checkout o, en un obrero, la de su director) vale como nocturno (crit. 16).
  const noche = ROLES_DE_DIA.includes(quien) && r ? contexto.deNoche(r) : { noche: false };
  if (!ROLES_DE_DIA.includes(quien) || noche.noche) {
    const porque = noche.noche ? (noche.por === 'kit-noche' ? 'de noche: .kit-noche' : 'de noche: .kit-rol nocturno') : `rol ${quien}`;
    return niega(
      'db:borra-de-noche',
      `esta migración borra datos reales (${que}) en ${cual} y sin una persona no se hace (${porque}): dejá PARADA en tu ` +
        `bitácora ("borrar datos reales: ${que}") y pará. Lo decide Guido de día.`,
    );
  }
  const bs = Array.isArray(banderas) ? banderas : [];
  if (!bs.includes(BANDERA)) {
    return niega(
      'db:borra-datos-reales',
      `esta migración borra datos reales (${que}) en ${cual}. Si lo querés, corré \`db migrar ${BANDERA}\`: te va a aparecer la ventana.`,
    );
  }
  return { ok: true }; // con la bandera: la ventana la pone el hook sensible (D-4)
}

module.exports = { CARPETA_REVISIONES, BANDERA, QUITABLE, ROLES_DE_DIA, juzgar, hashPlan, borra, sinComentarios, nombreSolo, tablasDe };
