'use strict';
// sello.cjs — la línea del sello del Arquitecto (SPEC-paquete-4 P1.4; H §8.1, §12; D4-8): su gramática, su hash, las secciones
// que pide `ready`, el tope y el paso BORRADOR → READY. Funciones puras sobre el texto del spec: ni disco, ni git, ni la ficha
// (eso lo hace arquitecto.cjs). Node estándar, cero dependencias: el orden 5 la copia al molde con su prueba anti-desvío (D-12).
//
// La línea, en un solo renglón, en la lista de la cabecera (primeras 20 líneas):
//   - Sello del Arquitecto: `arquitecto: <AAAA-MM-DD> · kit <X.Y.Z> · chequeos: tamaño <c> · entorno <c> · tope <c> · hash <12 hexa>[ · <nota>]`
//   <c> = ✅ · — (<razón>) · y solo en tope ⚠️ (<KB> KB y <N> criterios; no partir: <quién>)

const crypto = require('crypto');

const VENTANA = 20; // la cabecera: las primeras 20 líneas
const PREFIJO = '- Sello del Arquitecto: ';
const RE_SELLO = /^- Sello del Arquitecto:/;
const RE_ESTADO = /^- Estado:/;
const RE_FECHA_CAB = /^- Fecha:/;
const SEP = ' · ';
const OK = '✅';
const NO = '—';
const AVISO = '⚠️';
// Misma gramática que ficha.cjs (D8b-3: N.N.N o N.N.N-rc.N); sello.cjs usa solo node estándar, así que la repite: copias.test.cjs las compara.
const RE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_FENCE = /^\s*(```|~~~)/;
const KB = 1024;
// SPEC-paquete-8r T3 (rt-1, rt-10): la tarea 0 del spec, y la razón del entorno que la acepta con ficha.
const RE_TAREA_CERO = /^(?:- )?(?:\*\*)?tarea 0(?:\*\*)?:/i;
const RAZON_TAREA_CERO = 'tarea 0: montar el entorno de prueba';

const T_EJECUCION = 'Ejecución';
const T_ENTORNO = 'Entorno de prueba';
const T_PEDIDO = 'Pedido original, textual';
const T_NO_SE_TOCA = 'NO SE TOCA';
const T_CRITERIOS = 'Criterios de aceptación';

// Los topes de H §12 (NO VERIFICADO: se calibran en el piloto). KB = 1.024 bytes del texto normalizado (el mismo de `hash`).
// Un SPEC-0 (H1 `# SPEC-0:`) va con el de 30 KB aunque su Ejecución diga módulo solo (rf-7).
const TOPES = {
  solo: { kb: 10, criterios: 8, nombre: 'módulo solo' },
  director: { kb: 30, criterios: null, nombre: 'módulo con director' },
  ninguno: { kb: 30, criterios: null, nombre: 'sin tamaño' },
  spec0: { kb: 30, criterios: null, nombre: 'SPEC-0' },
};

// ---------------------------------------------------------------- el texto

// Sin BOM y CRLF → LF, partido en renglones, sin espacios ni tabs al final de cada uno. Acepta Buffer o texto.
function renglones(contenido) {
  let t = Buffer.isBuffer(contenido) ? contenido.toString('utf8') : String(contenido);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
}

// En las primeras 20: el índice de la primera `- Sello del Arquitecto:`, cuántas hay, la primera `- Estado:` y la primera `- Fecha:`.
function ubicar(lineas) {
  const r = { sello: -1, sellos: 0, estado: -1, fecha: -1 };
  const tope = Math.min(VENTANA, lineas.length);
  for (let i = 0; i < tope; i++) {
    const l = lineas[i];
    if (RE_SELLO.test(l)) {
      if (r.sello < 0) r.sello = i;
      r.sellos++;
    } else if (RE_ESTADO.test(l)) {
      if (r.estado < 0) r.estado = i;
    } else if (RE_FECHA_CAB.test(l)) {
      if (r.fecha < 0) r.fecha = i;
    }
  }
  return r;
}

// El spec normalizado (D4-8, r1-7): sin BOM, CRLF → LF, sin espacios finales por renglón y sin saltos de línea al final; afuera
// SOLO la primera `- Estado:` y la línea del sello, las dos dentro de las primeras 20 líneas. Lo usan `hash` y el tope (rf-7).
function textoNormalizado(contenido) {
  const lineas = renglones(contenido);
  const u = ubicar(lineas);
  const quedan = lineas.filter((_, i) => i !== u.sello && i !== u.estado);
  return quedan.join('\n').replace(/\n+$/, '');
}

// Los 12 hexa del sha256 del spec normalizado.
function hash(contenido) {
  return crypto.createHash('sha256').update(Buffer.from(textoNormalizado(contenido), 'utf8')).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------- la línea

// Lo que puede ir adentro de una razón, un "no partir" o la nota: una línea, sin ` · ` y sin comillas invertidas.
function textoLibreValido(t) {
  return typeof t === 'string' && t.trim() !== '' && t === t.trim() && !t.includes(SEP) && !/[`\r\n]/.test(t);
}

const cOk = () => OK;
const cNo = (razon) => `${NO} (${razon})`;
const cAviso = (kb, criterios, quien) => `${AVISO} (${kb} KB y ${criterios} criterios; no partir: ${quien})`;

// armar({ fecha, kit, tamano, entorno, tope, hash, nota? }) → el renglón entero (los <c> ya armados).
function armar(c) {
  const partes = [`arquitecto: ${c.fecha}`, `kit ${c.kit}`, `chequeos: tamaño ${c.tamano}`, `entorno ${c.entorno}`, `tope ${c.tope}`, `hash ${c.hash}`];
  if (c.nota) partes.push(c.nota);
  return `${PREFIJO}\`${partes.join(SEP)}\``;
}

function diaReal(t) {
  const m = RE_DIA.exec(t);
  if (!m) return false;
  const [a, me, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(a, me - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === me - 1 && f.getUTCDate() === d;
}

// Un <c>: { tipo: 'ok' } · { tipo: 'no', razon } · { tipo: 'aviso', kb, criterios, quien } (solo si conAviso) · null si no se lee.
function leerC(t, conAviso) {
  if (t === OK) return { tipo: 'ok' };
  let m = /^— \((.*)\)$/.exec(t);
  if (m && m[1].trim() !== '') return { tipo: 'no', razon: m[1] };
  if (conAviso) {
    m = /^⚠️ \((\d+,\d) KB y (\d+) criterios; no partir: (.*)\)$/.exec(t);
    if (m && m[3].trim() !== '') return { tipo: 'aviso', kb: m[1], criterios: Number(m[2]), quien: m[3] };
  }
  return null;
}

// parsear(renglón) → { ok: true, campos } · { ok: false, error } (el error es el <qué> de "sello inválido: <qué>").
function parsear(linea) {
  const mal = (error) => ({ ok: false, error });
  if (!linea.startsWith(`${PREFIJO}\``) || !linea.endsWith('`') || linea.length <= PREFIJO.length + 1) {
    return mal('la línea tiene que ser - Sello del Arquitecto: `…` en un solo renglón');
  }
  const adentro = linea.slice(PREFIJO.length + 1, -1);
  if (adentro.includes('`')) return mal('la línea tiene una comilla invertida de más');
  const p = adentro.split(SEP);
  if (p.length < 6 || p.length > 7) return mal('las partes no son arquitecto · kit · chequeos: tamaño · entorno · tope · hash [· nota]');
  let m;
  if (!(m = /^arquitecto: (.*)$/.exec(p[0])) || !diaReal(m[1])) return mal('la fecha no es "arquitecto: AAAA-MM-DD" con un día real');
  const fecha = m[1];
  if (!(m = /^kit (.*)$/.exec(p[1])) || !RE_VERSION.test(m[1])) return mal('la versión no es "kit X.Y.Z"');
  const kit = m[1];
  if (!(m = /^chequeos: tamaño (.*)$/.exec(p[2]))) return mal('falta "chequeos: tamaño <c>"');
  const tamano = leerC(m[1], false);
  if (!tamano) return mal('tamaño no es ✅ ni — (razón)');
  if (!(m = /^entorno (.*)$/.exec(p[3]))) return mal('falta "entorno <c>"');
  const entorno = leerC(m[1], false);
  if (!entorno) return mal('entorno no es ✅ ni — (razón)');
  if (!(m = /^tope (.*)$/.exec(p[4]))) return mal('falta "tope <c>"');
  const tope = leerC(m[1], true);
  if (!tope) {
    if (m[1].startsWith(AVISO)) return mal('tope ⚠️ sin "(<KB> KB y <N> criterios; no partir: <quién>)"');
    return mal('tope no es ✅, — (razón) ni ⚠️ (… no partir: <quién>)');
  }
  if (!(m = /^hash ([0-9a-f]{12})$/.exec(p[5]))) return mal('el hash no son 12 hexa en minúscula');
  const h = m[1];
  let nota = null;
  if (p.length === 7) {
    if (p[6].trim() === '') return mal('la nota del final está vacía');
    nota = p[6];
  }
  return { ok: true, campos: { fecha, kit, tamano, entorno, tope, hash: h, nota } };
}

// Lo que vale según haya ficha (D4-8): `—` solo sin ficha; con ficha, entorno `— (quitado: …)` solo con gate:entorno-prueba
// quitado y vigente EL DÍA DEL SELLO (rf-3), y entorno `— (tarea 0: montar el entorno de prueba)` solo si el spec trae el renglón
// de la tarea 0 y es un módulo con director (SPEC-paquete-8r T3, rt-1). `gateQuitado`: un booleano, o una función (campos) →
// booleano que se llama solo si hace falta. `tareaCero`: ¿el spec trae la tarea 0? `director`: ¿su Ejecución dice módulo con
// director? (los dos los calcula revisarSello con el texto). → null si vale, o el <qué> de "sello inválido: <qué>".
function validar(campos, { hayFicha, gateQuitado, tareaCero, director }) {
  if (!hayFicha) return null;
  if (campos.tamano.tipo !== 'ok') return 'tamaño "— (razón)" vale solo sin ficha del kit, y este repo tiene .claude/kit.md';
  if (campos.tope.tipo === 'no') return 'tope "— (razón)" vale solo sin ficha del kit, y este repo tiene .claude/kit.md';
  if (campos.entorno.tipo === 'no' && campos.entorno.razon === RAZON_TAREA_CERO) {
    if (!tareaCero) return 'entorno dice tarea 0, pero el spec no trae el renglón "Tarea 0:" en ## Entorno de prueba';
    if (!director) return 'entorno dice tarea 0, y la tarea 0 vale solo en un módulo con director';
    return null;
  }
  if (campos.entorno.tipo === 'no') {
    if (!campos.entorno.razon.startsWith('quitado: ')) return `entorno "— (razón)" vale solo sin ficha del kit; con ficha, solo "— (quitado: <por>)" o "— (${RAZON_TAREA_CERO})"`;
    const vigente = typeof gateQuitado === 'function' ? gateQuitado(campos) : gateQuitado;
    if (!vigente) return `entorno dice quitado, pero gate:entorno-prueba no estaba vigente el ${campos.fecha} en frenos.quitados de la ficha`;
  }
  return null;
}

// ---------------------------------------------------------------- las secciones

// "## Título" empieza con el título y después viene el fin o un signo (no otra letra: "## Estados" no es "## Estado").
function esTitulo(linea, titulo) {
  const pre = `## ${titulo}`;
  if (!linea.startsWith(pre)) return false;
  const sig = linea.slice(pre.length, pre.length + 1);
  return sig === '' || !/[\p{L}\p{N}_]/u.test(sig);
}

// Los títulos `#`/`##` fuera de los bloques de código: [{ i, nivel, texto }].
function titulos(lineas) {
  const r = [];
  let enCodigo = false;
  lineas.forEach((l, i) => {
    if (RE_FENCE.test(l)) {
      enCodigo = !enCodigo;
      return;
    }
    if (enCodigo) return;
    const m = /^(#{1,2}) (.*)$/.exec(l);
    if (m) r.push({ i, nivel: m[1].length, texto: l });
  });
  return r;
}

// El cuerpo de una sección `##` (sin el título), hasta el siguiente `#`/`##`. null si no está.
function cuerpo(lineas, titulo) {
  const ts = titulos(lineas);
  const k = ts.findIndex((t) => t.nivel === 2 && esTitulo(t.texto, titulo));
  if (k < 0) return null;
  const fin = k + 1 < ts.length ? ts[k + 1].i : lineas.length;
  return { desde: ts[k].i + 1, hasta: fin, lineas: lineas.slice(ts[k].i + 1, fin) };
}

// ¿Es un delta? H1 `# SPEC:` o la ruta docs/modulos/<x>/SPEC.md (eso lo decide quien llama: `porRuta`).
function esDelta(lineas, porRuta) {
  if (porRuta) return true;
  const h1 = titulos(lineas).find((t) => t.nivel === 1);
  return !!h1 && h1.texto.startsWith('# SPEC:');
}

// Las secciones que pide `ready` (los títulos tienen que existir; su texto no se mira; r1-3). → [] si está todo, o los problemas.
function faltantes(lineas, delta) {
  const dos = titulos(lineas).filter((t) => t.nivel === 2);
  const hay = (t) => dos.some((x) => esTitulo(x.texto, t));
  const faltan = [T_EJECUCION, T_ENTORNO].concat(delta ? [T_PEDIDO, T_NO_SE_TOCA] : []).filter((t) => !hay(t));
  const r = faltan.length ? [`faltan secciones: ${faltan.map((t) => `## ${t}`).join(', ')}`] : [];
  if (delta && hay(T_PEDIDO) && !esTitulo(dos[0].texto, T_PEDIDO)) r.push(`## ${T_PEDIDO} tiene que ser la primera sección del delta`);
  return r;
}

// La Ejecución: { hay, tamano: 'solo' | 'director' | null }. El tamaño sale de su primera línea con texto.
function ejecucion(lineas) {
  const c = cuerpo(lineas, T_EJECUCION);
  if (!c) return { hay: false, tamano: null };
  const primera = c.lineas.find((l) => l.trim() !== '');
  if (primera === undefined) return { hay: true, tamano: null };
  const t = primera.toLowerCase();
  const solo = t.includes('módulo solo');
  const director = t.includes('módulo con director');
  return { hay: true, tamano: solo === director ? null : solo ? 'solo' : 'director' };
}

// tareaCero(lineas) → el primer renglón del cuerpo de ## Entorno de prueba, fuera de los bloques de código, que es la tarea 0
// (`- **Tarea 0**: …`, `- Tarea 0: …`, `Tarea 0: …`), o null (SPEC-paquete-8r T3, rt-10).
function tareaCero(lineas) {
  const c = cuerpo(lineas, T_ENTORNO);
  if (!c) return null;
  let enCodigo = false;
  for (const l of c.lineas) {
    if (RE_FENCE.test(l)) {
      enCodigo = !enCodigo;
      continue;
    }
    if (!enCodigo && RE_TAREA_CERO.test(l)) return l;
  }
  return null;
}

// ---------------------------------------------------------------- el tope (H §12: avisa, no corta)

const kbTexto = (bytes) => (bytes / KB).toFixed(1).replace('.', ',');

// medirTope(contenido, tamano) → { bytes, kb, criterios, tope, pasado, secciones: [{ titulo, bytes, kb }] (de mayor a menor) }.
// Los bytes son los del texto normalizado (CRLF, BOM y la línea del sello no suman); un SPEC-0 usa TOPES.spec0 (rf-7).
function medirTope(contenido, tamano) {
  const bytes = Buffer.byteLength(textoNormalizado(contenido), 'utf8');
  const lineas = renglones(contenido);
  const h1 = titulos(lineas).find((t) => t.nivel === 1);
  const spec0 = !!h1 && h1.texto.startsWith('# SPEC-0:');
  const crit = cuerpo(lineas, T_CRITERIOS);
  let criterios = 0;
  if (crit) {
    let enCodigo = false;
    for (const l of crit.lineas) {
      if (RE_FENCE.test(l)) enCodigo = !enCodigo;
      else if (!enCodigo && /^(- |\d+\. )/.test(l)) criterios++;
    }
  }
  const tope = spec0 ? TOPES.spec0 : TOPES[tamano] || TOPES.ninguno;
  const pasado = bytes > tope.kb * KB || (tope.criterios !== null && criterios > tope.criterios);
  const ts = titulos(lineas);
  const secciones = [];
  ts.forEach((t, k) => {
    if (t.nivel !== 2) return;
    const fin = k + 1 < ts.length ? ts[k + 1].i : lineas.length;
    const b = lineas.slice(t.i, fin).reduce((s, l) => s + Buffer.byteLength(l, 'utf8') + 1, 0);
    secciones.push({ titulo: t.texto, bytes: b, kb: kbTexto(b) });
  });
  secciones.sort((a, b) => b.bytes - a.bytes);
  return { bytes, kb: kbTexto(bytes), criterios, tope, pasado, secciones };
}

// Las líneas que imprime `tope` (y `sello` cuando se pasa).
function lineasTope(m) {
  const lim = m.tope.criterios === null ? `${m.tope.kb} KB` : `${m.tope.kb} KB y ${m.tope.criterios} criterios`;
  if (!m.pasado) return [`tope ${OK}: ${m.kb} KB y ${m.criterios} criterios (tope ${m.tope.nombre}: ${lim})`];
  return [
    `tope pasado: ${m.kb} KB y ${m.criterios} criterios (tope ${m.tope.nombre}: ${lim}) — proponé dónde cortar, o seguí entero con --no-partir "<quién>"`,
    'secciones, de mayor a menor:',
    ...m.secciones.map((s) => `  ${s.kb} KB · ${s.titulo}`),
  ];
}

// ---------------------------------------------------------------- el Estado

// El valor de `- Estado:` sin las marcas de Markdown del principio.
function valorEstado(linea) {
  return linea.replace(RE_ESTADO, '').trim().replace(/^[`*_"]+/, '');
}

// Los renglones del Buffer tal cual (con su \r si lo traen): [{ inicio, fin }] (fin sin el \n).
function cortesCrudos(buf) {
  const r = [];
  let inicio = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      r.push({ inicio, fin: i });
      inicio = i + 1;
    }
  }
  r.push({ inicio, fin: buf.length });
  return r;
}

// pasarAReady(buf) → { ya: true } · { nuevo: Buffer } (solo BORRADOR → READY en la primera `- Estado:`) · { error }.
function pasarAReady(buf) {
  const lineas = renglones(buf);
  const u = ubicar(lineas);
  if (u.estado < 0) return { error: 'el spec no tiene la línea - Estado: en sus primeras 20 líneas: agregala (- Estado: BORRADOR)' };
  const v = valorEstado(lineas[u.estado]);
  if (v.startsWith('READY')) return { ya: true };
  if (!v.startsWith('BORRADOR')) return { error: 'el Estado no dice BORRADOR: ready solo pasa un BORRADOR a READY' };
  const c = cortesCrudos(buf)[u.estado];
  const linea = buf.subarray(c.inicio, c.fin);
  const k = linea.indexOf(Buffer.from('BORRADOR', 'utf8'));
  if (k < 0) return { error: 'no encuentro BORRADOR en el renglón del Estado' };
  const nuevo = Buffer.concat([buf.subarray(0, c.inicio + k), Buffer.from('READY', 'utf8'), buf.subarray(c.inicio + k + 'BORRADOR'.length)]);
  return { nuevo };
}

// ---------------------------------------------------------------- poner la línea

// ponerLinea(buf, renglón) → { nuevo: Buffer } · { error }. Si hay sello en la cabecera, lo reemplaza (con los renglones
// sangrados que lo continúan: la línea va en uno solo); si no, la pone después de `- Fecha:` (y de su continuación).
function ponerLinea(buf, renglon) {
  const lineas = renglones(buf);
  const u = ubicar(lineas);
  if (u.sellos > 1) return { error: 'hay más de una línea de sello en la cabecera: dejá una sola y corré sello de nuevo' };
  const cortes = cortesCrudos(buf);
  const continua = (desde) => {
    let j = desde + 1;
    while (j < lineas.length && /^[ \t]/.test(lineas[j]) && lineas[j].trim() !== '') j++;
    return j; // el primer renglón que ya no es continuación
  };
  let desde;
  let hasta;
  let ancla;
  if (u.sello >= 0) {
    desde = u.sello;
    hasta = continua(u.sello);
    ancla = u.sello;
  } else {
    if (u.fecha < 0) return { error: 'no encuentro - Fecha: en las primeras 20 líneas: agregala a la cabecera y corré sello de nuevo' };
    desde = continua(u.fecha);
    hasta = desde;
    ancla = u.fecha;
  }
  const a = cortes[ancla];
  const conCR = a.fin > a.inicio && buf[a.fin - 1] === 0x0d;
  const fin = conCR ? '\r\n' : '\n';
  const antes = desde < cortes.length ? buf.subarray(0, cortes[desde].inicio) : buf;
  const despues = hasta < cortes.length ? buf.subarray(cortes[hasta].inicio) : Buffer.alloc(0);
  // Si el ancla es el último renglón y no tiene salto, el sello va en un renglón nuevo.
  const sinSalto = desde >= cortes.length;
  const nuevo = Buffer.concat([antes, Buffer.from(sinSalto ? `${fin}${renglon}` : `${renglon}${fin}`, 'utf8'), despues]);
  const v = ubicar(renglones(nuevo));
  if (v.sello < 0) return { error: 'la línea del sello quedaría fuera de las primeras 20 líneas: subí - Fecha: en la cabecera' };
  return { nuevo };
}

// El sello del spec, para `ready` y `--pendientes`: { estado: 'sin' | 'invalido' | 'cambio' | 'ok', error?, campos? }.
function revisarSello(buf, { hayFicha, gateQuitado }) {
  const lineas = renglones(buf);
  const u = ubicar(lineas);
  if (u.sello < 0) return { estado: 'sin' };
  if (u.sellos > 1) return { estado: 'invalido', error: 'hay más de una línea de sello en la cabecera' };
  const p = parsear(lineas[u.sello]);
  if (!p.ok) return { estado: 'invalido', error: p.error };
  const e = validar(p.campos, { hayFicha, gateQuitado, tareaCero: tareaCero(lineas) !== null, director: ejecucion(lineas).tamano === 'director' });
  if (e) return { estado: 'invalido', error: e, campos: p.campos };
  if (hash(buf) !== p.campos.hash) return { estado: 'cambio', campos: p.campos };
  return { estado: 'ok', campos: p.campos };
}

module.exports = {
  VENTANA, OK, NO, AVISO, TOPES, T_EJECUCION, T_ENTORNO, T_PEDIDO, T_NO_SE_TOCA, T_CRITERIOS, RE_TAREA_CERO, RAZON_TAREA_CERO,
  renglones, ubicar, textoNormalizado, hash, textoLibreValido, cOk, cNo, cAviso, armar, parsear, validar, esTitulo, titulos, cuerpo, esDelta,
  faltantes, ejecucion, tareaCero, kbTexto, medirTope, lineasTope, valorEstado, pasarAReady, ponerLinea, revisarSello,
};
