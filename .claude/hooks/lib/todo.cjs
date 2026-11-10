'use strict';
// todo.cjs — el TODO que no miente (B §10; SPEC-paquete-2 P3.6). Funciones puras: leen texto, devuelven texto o datos.
// Las edades entran como dato (la forma que da git.edades), así se prueban sin git. Node estándar, cero dependencias.
// Es .cjs a propósito: corre igual en proyectos con "type": "module".

// A los cuántos días sin tocarse un ítem baja solo a 🟢.
const DIAS_PODA = 90;
const MS_DIA = 24 * 60 * 60 * 1000;

// Los emojis de las secciones, por código (el título es libre; se reconoce por el emoji).
const EMOJI = Object.freeze({
  rojo: '\u{1F534}', // 🔴
  naranja: '\u{1F7E0}', // 🟠
  amarillo: '\u{1F7E1}', // 🟡
  verde: '\u{1F7E2}', // 🟢
});
const ORDEN_BAJADA = ['rojo', 'naranja', 'amarillo']; // de dónde se "baja" a 🟢

const RE_ITEM = /^- \[([ xX])\]\s(.*)$/;
const RE_DETALLE = /^[ \t]+\S/;
const RE_TITULO = /^(#{1,6})\s+(.*)$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_REPORTADO = /^Reportado por el usuario/i;
const RE_ESPERA = /espera hasta:/i;
const RE_ESPERA_FECHA = /espera hasta:\s*(\d{4}-\d{2}-\d{2})/i;

// Lo que identifica a un ítem entre dos versiones del archivo: su primer renglón, sin el checkbox y con los espacios colapsados.
function normalizar(primerRenglon) {
  return String(primerRenglon)
    .replace(/^- \[[ xX]\]/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tipoDeSeccion(titulo) {
  for (const k of Object.keys(EMOJI)) if (titulo.includes(EMOJI[k])) return k;
  if (RE_REPORTADO.test(titulo)) return 'reportado';
  return null;
}

// analizar(texto) → { lineas, eol, items, secciones }. Una sola lectura que usan todas las funciones.
function analizar(texto) {
  const crudo = String(texto === undefined || texto === null ? '' : texto);
  const eol = crudo.includes('\r\n') ? '\r\n' : '\n';
  const lineas = crudo.split(/\r?\n/);
  const secciones = [];
  const items = [];
  let tipo = null;
  let enCodigo = false;
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (RE_FENCE.test(l)) {
      enCodigo = !enCodigo;
      i++;
      continue;
    }
    if (enCodigo) {
      i++;
      continue;
    }
    const t = RE_TITULO.exec(l);
    if (t && t[1].length <= 2) {
      // Un título de nivel 1 o 2 abre sección (los de nivel 3 en adelante son subtítulos de la sección vigente).
      tipo = t[1].length === 2 ? tipoDeSeccion(t[2]) : null;
      if (secciones.length) secciones[secciones.length - 1].fin = i;
      secciones.push({ tipo, titulo: l, inicio: i, fin: lineas.length });
      i++;
      continue;
    }
    const m = RE_ITEM.exec(l);
    if (m) {
      let fin = i + 1;
      while (fin < lineas.length && RE_DETALLE.test(lineas[fin])) fin++;
      const bloque = lineas.slice(i, fin);
      const junto = bloque.join('\n');
      const dFecha = RE_ESPERA_FECHA.exec(junto);
      items.push({
        seccion: tipo,
        inicio: i,
        fin,
        lineas: bloque,
        hecho: m[1] !== ' ',
        primero: normalizar(l),
        tieneEspera: RE_ESPERA.test(junto),
        espera: dFecha ? dFecha[1] : null,
      });
      i = fin;
      continue;
    }
    i++;
  }
  return { lineas, eol, items, secciones };
}

// items(texto) → [{ seccion, inicio, fin, lineas, hecho, primero, tieneEspera, espera }]
// seccion: 'rojo' | 'naranja' | 'amarillo' | 'verde' | 'reportado' | null (afuera de toda sección conocida).
// inicio/fin: índices de renglón, base 0, fin exclusivo.
function items(texto) {
  return analizar(texto).items;
}

// ---------------------------------------------------------------- la cabecera (lo que ve el hook)

// cabecera(texto, tope, ruta) → el texto de 🔴 y luego 🟠 (solo ítems abiertos), cortado en ítem entero; nunca más de `tope`
// caracteres. Si se corta, el último renglón dice cuántos ítems quedaron afuera (cuenta para el tope).
// Sin tope, el de topes.BLOQUES.cabeceraTodo. `ruta`: la del TODO en la carpeta de papeles, para la marca (8r3 i1; docs sin ella).
function cabecera(texto, tope, ruta = 'docs/TODO.md') {
  if (tope === undefined || tope === null) tope = require('./topes.cjs').BLOQUES.cabeceraTodo;
  const a = analizar(texto);
  const grupos = [];
  for (const tipo of ['rojo', 'naranja']) {
    const abiertos = a.items.filter((it) => it.seccion === tipo && !it.hecho);
    if (!abiertos.length) continue;
    const sec = a.secciones.find((s) => s.tipo === tipo);
    grupos.push({ titulo: sec ? sec.titulo : '## ' + EMOJI[tipo], items: abiertos });
  }
  const total = grupos.reduce((n, g) => n + g.items.length, 0);
  const marca = (n) => `… (${n} más en ${ruta})`;

  // Los bloques en orden de prioridad (🔴 antes que 🟠): cada uno con el título de su sección si es el primero de ella.
  const bloques = [];
  for (const g of grupos) {
    g.items.forEach((it, j) => {
      const lineas = it.lineas.map((r) => r.replace(/\s+$/, ''));
      bloques.push({ titulo: j === 0 ? g.titulo : null, lineas });
    });
  }
  // El prefijo más largo de ítems enteros que entra; si no entran todos, con la marca de lo que quedó afuera.
  for (let k = total; k >= 0; k--) {
    const renglones = [];
    bloques.slice(0, k).forEach((b, i) => {
      if (b.titulo !== null) {
        if (i > 0) renglones.push('');
        renglones.push(b.titulo);
      }
      renglones.push(...b.lineas);
    });
    if (k < total) renglones.push(marca(total - k));
    const res = renglones.join('\n');
    if (res.length <= tope) return res;
  }
  return '';
}

// ---------------------------------------------------------------- la poda

// Lo que da git.edades trae `fecha` como Date; aceptamos también un número (ms) o un texto ISO.
function aMs(f) {
  if (f === null || f === undefined) return null;
  const n = f instanceof Date ? f.getTime() : typeof f === 'number' ? f : Date.parse(f);
  return Number.isFinite(n) ? n : null;
}

// Edad del ítem = la del renglón más nuevo. Devuelve los ms de la fecha más nueva, o null si no se sabe
// (un renglón sin dato: ante la duda, no se baja nada). Un renglón sin commitear es de ahora.
function ultimoToque(it, porLinea, ahora) {
  let max = null;
  for (let i = it.inicio; i < it.fin; i++) {
    const e = porLinea.get(i + 1);
    if (!e) return null;
    if (e.texto !== undefined && e.texto !== it.lineas[i - it.inicio]) return null; // blame de otro texto: no se confía
    const f = e.sinCommitear ? ahora : aMs(e.fecha);
    if (f === null) return null;
    if (max === null || f > max) max = f;
  }
  return max;
}

// podar(texto, edades, hoy) → { texto, bajados: [primer renglón normalizado, …] }
// `edades` es la lista de git.edades (o null: sin dato, no se poda). `hoy`, un Date (o ms / ISO).
// A 🟢 baja lo que lleva DIAS_PODA días o más sin tocarse, salvo 🔴, los de `espera hasta:`, "Reportado" y lo que ya está en 🟢.
function podar(texto, edades, hoy) {
  const original = String(texto === undefined || texto === null ? '' : texto);
  const ahora = aMs(hoy);
  if (!Array.isArray(edades) || ahora === null) return { texto: original, bajados: [] };
  const porLinea = new Map();
  for (const e of edades) if (e && Number.isInteger(e.linea)) porLinea.set(e.linea, e);

  const a = analizar(original);
  const baja = a.items.filter((it) => {
    if (it.seccion !== 'naranja' && it.seccion !== 'amarillo') return false; // 🔴, 🟢, "Reportado" y lo suelto no bajan
    if (it.tieneEspera) return false;
    const toque = ultimoToque(it, porLinea, ahora);
    return toque !== null && ahora - toque >= DIAS_PODA * MS_DIA;
  });
  if (!baja.length) return { texto: original, bajados: [] };

  // Se sacan de abajo hacia arriba (los índices de arriba no se mueven).
  let lineas = a.lineas.slice();
  for (const it of baja.slice().reverse()) {
    let fin = it.fin;
    const antesVacio = it.inicio > 0 && lineas[it.inicio - 1].trim() === '';
    const despuesVacio = fin < lineas.length && lineas[fin].trim() === '';
    if (antesVacio && despuesVacio) fin++; // que no quede un doble blanco
    lineas.splice(it.inicio, fin - it.inicio);
  }

  const movidos = [].concat(...baja.map((it) => it.lineas));
  const b = analizar(lineas.join('\n'));
  const verde = b.secciones.find((s) => s.tipo === 'verde');
  if (verde) {
    let ultimo = verde.inicio; // el último renglón con algo de la sección 🟢
    for (let i = verde.inicio; i < verde.fin; i++) if (b.lineas[i].trim() !== '') ultimo = i;
    const vacia = ultimo === verde.inicio;
    const pegar = vacia ? [''].concat(movidos) : movidos;
    lineas = b.lineas.slice(0, ultimo + 1).concat(pegar, b.lineas.slice(ultimo + 1));
    // Sección vacía pegada al título siguiente: que quede un blanco antes de él.
    if (vacia && verde.fin < b.lineas.length && b.lineas[verde.inicio + 1] !== '') lineas.splice(ultimo + 1 + pegar.length, 0, '');
  } else {
    // No hay 🟢: se crea, antes de "Reportado" si existe, si no al final.
    const rep = b.secciones.find((s) => s.tipo === 'reportado');
    const nueva = ['## ' + EMOJI.verde + ' Ideas / algún día', ''].concat(movidos, ['']);
    if (rep) {
      lineas = b.lineas.slice(0, rep.inicio).concat(nueva, b.lineas.slice(rep.inicio));
    } else {
      const base = b.lineas.slice();
      while (base.length && base[base.length - 1] === '') base.pop();
      lineas = base.concat([''], nueva);
    }
  }
  return { texto: lineas.join(a.eol), bajados: baja.map((it) => it.primero) };
}

// ---------------------------------------------------------------- el balance

// balance(antes, despues) → { mas, menos, total, bajaron }. Los ítems se comparan por su primer renglón normalizado.
// mas: están ahora y no estaban · menos: estaban y ya no · total: los de ahora ·
// bajaron: de 🔴/🟠/🟡 a 🟢 (esos no cuentan como mas ni como menos).
function balance(antes, despues) {
  const a = items(antes);
  const d = items(despues);
  const previos = new Map(); // primero → [secciones], una por cada ítem con ese mismo primer renglón
  for (const it of a) {
    if (!previos.has(it.primero)) previos.set(it.primero, []);
    previos.get(it.primero).push(it.seccion);
  }
  let mas = 0;
  let bajaron = 0;
  for (const it of d) {
    const lista = previos.get(it.primero);
    if (!lista || !lista.length) {
      mas++;
      continue;
    }
    // Con repetidos, se empareja primero con uno de la misma sección.
    const k = lista.indexOf(it.seccion);
    const sec = lista.splice(k >= 0 ? k : 0, 1)[0];
    if (it.seccion === 'verde' && ORDEN_BAJADA.includes(sec)) bajaron++;
  }
  let menos = 0;
  for (const lista of previos.values()) menos += lista.length;
  return { mas, menos, total: d.length, bajaron };
}

// La línea que imprime el cierre. Exacta: − es U+2212, · es U+00B7.
function linea(b) {
  return `TODO: +${b.mas} −${b.menos} · ${b.total} ítems · ${b.bajaron} bajaron a ${EMOJI.verde}`;
}

module.exports = { DIAS_PODA, EMOJI, normalizar, items, cabecera, podar, balance, linea };
