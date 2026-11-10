'use strict';
// cambios.cjs — el registro de cambios de método del proyecto: formato, sello, `verificar` y `toca` (SPEC-paquete-2 P6.8a y
// D2.2 F3; ADR-026; red team rondas 1 a 5). Lo usan scripts/cambios.cjs (el CLI) y el candado (F4, `candado:barreras`).
// Vive bajo .claude/hooks/** a propósito: el formato y el sello son barrera (r4-3).
//
// Un archivo por cambio, .claude/cambios/<AAAA-MM-DD>-<slug>.md: cabecera con la gramática de la ficha (ficha.leerCabecera)
// hasta el primer `---`, y un cuerpo con cuatro secciones: ## Caso de origen · ## Regla · ## Dónde vive · ## Medición.
// El sello (`aprobo:`) lo escribe solo `cambios aprobar`, con su renglón en frenos.log y su propio commit en la rama por
// defecto; `verificar` lo da por bueno solo si todo eso se ve en la historia --first-parent de refs/heads/<rama por defecto>.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const ficha = require('./ficha.cjs');
const git = require('./git.cjs');
const contexto = require('./contexto.cjs');
const frenosLog = require('./frenos-log.cjs');
const ruta = require('./cambios-ruta.cjs');
const { normalizarId, reglas, leerJsonSinDuplicados } = require('./zona-propia.cjs');

// ---------------------------------------------------------------- el formato (tabla de P6.8a, más `ids` de F3)

const ESTADOS = ['propuesto', 'aprobado', 'aplicado', 'rechazado', 'subio-al-kit'];
const CLASES = ['2', '3-barrera'];
// La lista cerrada de `toca` en un 3-barrera: las barreras de candado:barreras. Se compara por igualdad.
const BARRERAS = ['frenos', 'sensible', 'autorizado', 'settings', 'hooks', 'githooks', 'gitleaks'];
const CICATRICES = ['seguridad', 'produccion', 'plata', 'no'];
const SI_NO = ['sí', 'no'];
const SECCIONES = ['Caso de origen', 'Regla', 'Dónde vive', 'Medición'];
// En el orden en que los escribe el script (los de después del clic, al final).
const CAMPOS = ['estado', 'clase', 'toca', 'ids', 'origen', 'cita', 'cicatriz', 'chico', 'chico-por', 'urgente', 'motivo', 'version', 'sha', 'aplico', 'aprobo'];
const CAMPOS_SELLO = ['sesion', 'fecha', 'carpeta', 'rol', 'hash', 'freno'];
// Lo que cambia después del clic y por eso no entra al hash del sello (RT-p2 r2-4): todo lo demás, sí. `version` la pone
// subio-al-kit (SPEC-paquete-7 r1-2: si no, un 3-barrera subido daría "el sello no coincide" para siempre); no mueve ningún hash
// de antes, porque `version` va solo con subio-al-kit.
const FUERA_DEL_HASH = ['estado', 'aprobo', 'sha', 'aplico', 'version'];
// Los estados que llevan el commit que aplicó el cambio: subio-al-kit es un aplicado que además cubre el kit (P6.8b-1, r1-5).
const CON_SHA = ['aplicado', 'subio-al-kit'];
// El renglón que escribe `aprobar` en frenos.log.
const ID_APROBAR = 'cambios:aprobar';
const HERRAMIENTA_APROBAR = 'cambios.cjs';

const RE_PIEZA = /^[a-z0-9][a-z0-9-]*$/;
const RE_CITA = /^[a-z0-9-]+ \S+$/;
const RE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RE_HASH = /^[0-9a-f]{12}$/;
const RE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const tiene = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const esTexto = (v) => typeof v === 'string';
const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unicos = (xs) => [...new Set(xs)].sort();

// Un texto del usuario que va a la cabecera: la gramática no escapa nada, así que ni ", ni \, ni saltos de línea.
function textoValido(s) {
  return typeof s === 'string' && s.trim() !== '' && !/["\\\r\n]/.test(s) && s.length <= 300;
}

// ---------------------------------------------------------------- leer y escribir

// Texto normalizado (sin BOM, LF) partido en renglones, con el índice del `---` que cierra la cabecera (-1 si no cierra).
function partir(texto) {
  let t = String(texto);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n');
  const lineas = t.split('\n');
  let cierre = -1;
  if (lineas[0] === '---') {
    for (let i = 1; i < lineas.length; i++) {
      if (lineas[i] === '---') {
        cierre = i;
        break;
      }
    }
  }
  return { lineas, cierre };
}

// leer(texto) → { datos, cuerpo }. Un error de gramática tira ficha.ErrorFicha con su línea (igual que la ficha).
function leer(texto) {
  const { datos } = ficha.leerCabecera(texto);
  const { lineas, cierre } = partir(texto);
  return { datos, cuerpo: lineas.slice(cierre + 1).join('\n') };
}

// Los renglones de la cabecera que son de un campo de arriba (y lo que cuelga de él, con sangría): { campo: [i, …] }.
function renglonesDeCampos(lineas, cierre) {
  const res = {};
  let actual = null;
  for (let i = 1; i < cierre; i++) {
    const l = lineas[i];
    const m = /^([a-z0-9][a-z0-9_-]*):(?:\s|$)/.exec(l);
    if (m) {
      actual = m[1];
      (res[actual] = res[actual] || []).push(i);
    } else if (actual && /^\s/.test(l)) {
      res[actual].push(i);
    } else {
      actual = null;
    }
  }
  return res;
}

// El hash del sello: ficha.hash del archivo ENTERO (cabecera y cuerpo, LF) sin los renglones de estado, aprobo, sha y aplico.
// Lo que Guido lee en "te espera" (la regla, el caso, los ids) no se puede editar después del clic sin que esto cambie.
function hashSello(texto) {
  const { lineas, cierre } = partir(texto);
  if (cierre < 0) return ficha.hash(lineas.join('\n'));
  const fuera = new Set();
  const porCampo = renglonesDeCampos(lineas, cierre);
  for (const c of FUERA_DEL_HASH) for (const i of porCampo[c] || []) fuera.add(i);
  return ficha.hash(lineas.filter((_, i) => !fuera.has(i)).join('\n'));
}

// Un valor de la cabecera, escrito como lo escribe el script: textos entre comillas dobles (salvo los de vocabulario cerrado),
// listas en línea, mapas en línea. Tira si un texto trae algo que la gramática no puede llevar.
function comillas(s) {
  if (typeof s !== 'string' || /["\\\r\n]/.test(s)) throw new Error('un texto con ", \\ o salto de línea no se puede escribir en la cabecera');
  return `"${s}"`;
}
const listaCruda = (xs) => `[${xs.join(', ')}]`;
const listaComillas = (xs) => `[${xs.map(comillas).join(', ')}]`;

// Pone (o saca, con null) campos de arriba en la cabecera, renglón por renglón: lo demás queda byte por byte igual, que es
// lo que mantiene el hash del sello. Un campo que no estaba va al final de la cabecera. → el texto nuevo, con LF.
function ponerCampos(texto, cambios) {
  const { lineas, cierre } = partir(texto);
  if (cierre < 0) throw new Error('la cabecera no se cierra');
  const porCampo = renglonesDeCampos(lineas, cierre);
  const reemplazo = new Map();
  const borrar = new Set();
  const agregar = [];
  for (const [campo, valor] of Object.entries(cambios)) {
    const donde = porCampo[campo];
    const renglon = valor === null ? null : `${campo}: ${valor}`;
    if (donde && donde.length) {
      donde.forEach((i, k) => (k === 0 && renglon !== null ? reemplazo.set(i, renglon) : borrar.add(i)));
    } else if (renglon !== null) {
      agregar.push(renglon);
    }
  }
  const out = [];
  lineas.forEach((l, i) => {
    if (i === cierre) out.push(...agregar);
    if (borrar.has(i)) return;
    out.push(reemplazo.has(i) ? reemplazo.get(i) : l);
  });
  return out.join('\n');
}

// armar({...}) → el texto de un cambio nuevo, `propuesto`. ids normalizados y siempre entre comillas (r5-4: "nuevo escribe
// entre comillas dobles todo id que tenga coma"; acá todos, que es lo mismo y más simple).
function armar(c) {
  const r = ['---', 'estado: propuesto', `clase: ${c.clase}`, `toca: ${listaCruda(c.toca)}`];
  if (c.ids && c.ids.length) r.push(`ids: ${listaComillas(c.ids.map(normalizarId))}`);
  if (c.origen != null) r.push(`origen: ${comillas(c.origen)}`);
  if (c.cita != null) r.push(`cita: ${comillas(c.cita)}`);
  r.push(`cicatriz: ${c.cicatriz}`, `chico: ${c.chico}`);
  if (c.chicoPor != null) r.push(`chico-por: ${comillas(c.chicoPor)}`);
  r.push(`urgente: ${c.urgente}`, '---', '');
  const cuerpo = String(c.cuerpo).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `${r.join('\n')}\n${cuerpo}\n`;
}

// El sello en una línea: aprobo: {sesion: …, fecha: "…", carpeta: ., rol: …, hash: …, freno: "…"}. freno SIEMPRE entre comillas
// (la gramática corta el mapa en las comas, y una rama puede tener comas).
function textoSello(s) {
  return `{sesion: ${s.sesion}, fecha: ${comillas(s.fecha)}, carpeta: ${s.carpeta}, rol: ${s.rol}, hash: ${s.hash}, freno: ${comillas(s.freno)}}`;
}

// aSubioAlKit(texto, version) → el texto nuevo (SPEC-paquete-7 P6.8b-1, r1-8): pura, sin git ni disco. Solo desde `aplicado`:
// pone `estado: subio-al-kit` y `version`, y conserva sha, aplico y aprobo byte a byte (el sello sigue valiendo: estado y version
// están fuera del hash). Tira con otro estado o una versión que no es N.N.N: quien llama lo mira antes.
function aSubioAlKit(texto, version) {
  if (typeof version !== 'string' || !RE_VERSION.test(version)) throw new Error('la versión del kit tiene que ser N.N.N');
  const { datos } = leer(texto);
  if (datos.estado !== 'aplicado') throw new Error(`es ${datos.estado}: sube al kit solo un aplicado`);
  return ponerCampos(texto, { estado: 'subio-al-kit', version });
}

// ---------------------------------------------------------------- el cuerpo

// Las secciones del cuerpo: { títulos: Set, regla: la primera línea no vacía de ## Regla (o null) }.
function secciones(cuerpo) {
  const titulos = new Set();
  let regla = null;
  let enRegla = false;
  for (const l of String(cuerpo).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m && !/^#/.test(m[1])) {
      titulos.add(m[1]);
      enRegla = m[1] === 'Regla';
      continue;
    }
    if (enRegla && regla === null && l.trim() !== '') regla = l.trim();
  }
  return { titulos, regla };
}

const faltanSecciones = (cuerpo) => {
  const { titulos } = secciones(cuerpo);
  return SECCIONES.filter((s) => !titulos.has(s));
};
const reglaEnUnaLinea = (cuerpo) => secciones(cuerpo).regla;

// ---------------------------------------------------------------- validar (lo que se ve sin git)

// validar(datos, cuerpo) → [{campo, que, hacer}]. Vacía = en orden. Ningún mensaje repite un valor del archivo.
function validar(datos, cuerpo) {
  const f = [];
  const mal = (campo, que, hacer) => f.push({ campo, que, hacer });
  const d = esMapa(datos) ? datos : {};
  const uno = (k, opciones, obligatorio = true) => {
    if (!tiene(d, k)) {
      if (obligatorio) mal(k, `falta "${k}"`, `agregalo: ${opciones.join(' · ')}`);
      return;
    }
    if (!esTexto(d[k]) || !opciones.includes(d[k])) mal(k, `"${k}" tiene un valor que no se acepta`, `tiene que ser uno de: ${opciones.join(', ')}`);
  };
  const texto = (k) => {
    if (!esTexto(d[k]) || d[k].trim() === '') mal(k, `"${k}" tiene que ser un texto no vacío`, 'escribilo entre comillas dobles');
  };

  for (const k of Object.keys(d)) if (!CAMPOS.includes(k)) mal(k, `campo desconocido "${k}"`, `los que valen son: ${CAMPOS.join(', ')}`);

  uno('estado', ESTADOS);
  uno('clase', CLASES);
  const estado = esTexto(d.estado) && ESTADOS.includes(d.estado) ? d.estado : null;
  const clase = esTexto(d.clase) && CLASES.includes(d.clase) ? d.clase : null;
  const barrera = clase === '3-barrera';

  if (!tiene(d, 'toca')) mal('toca', 'falta "toca"', `poné la lista: en un 3-barrera, de ${BARRERAS.join(', ')}`);
  else if (!Array.isArray(d.toca) || !d.toca.length || !d.toca.every(esTexto)) mal('toca', '"toca" tiene que ser una lista no vacía [a, b]', 'escribila entre corchetes');
  else if (barrera) {
    if (!d.toca.every((t) => BARRERAS.includes(t))) mal('toca', '"toca" de un 3-barrera tiene algo que no es una barrera', `la lista cerrada es: ${BARRERAS.join(', ')}`);
  } else if (clase === '2') {
    if (d.toca.some((t) => BARRERAS.includes(t))) mal('toca', 'un cambio de clase 2 nombra una barrera en "toca"', 'si toca una barrera es 3-barrera: rehacelo con cambios nuevo');
    else if (!d.toca.every((t) => RE_PIEZA.test(t))) mal('toca', '"toca" tiene un nombre de pieza que no se acepta', 'minúsculas, números y guiones');
  }

  if (tiene(d, 'ids')) {
    if (!Array.isArray(d.ids) || !d.ids.every((x) => esTexto(x) && x.trim() !== '')) mal('ids', '"ids" tiene que ser una lista de textos', 'uno por id, entre comillas dobles');
    else if (barrera && !d.ids.length) mal('ids', 'un 3-barrera sin ids', 'declarás los ids que cambia: rehacelo con cambios nuevo --id …');
  } else if (barrera) mal('ids', 'un 3-barrera sin "ids"', 'declarás los ids que cambia: rehacelo con cambios nuevo --id …');

  if (tiene(d, 'origen') === tiene(d, 'cita')) mal('origen', 'tiene que haber "origen" o "cita", uno solo', 'origen: "<texto>" o cita: "<alias> <id>"');
  else if (tiene(d, 'origen')) texto('origen');
  else if (!esTexto(d.cita) || !RE_CITA.test(d.cita)) mal('cita', '"cita" no tiene la forma "<alias> <id>"', 'escribila así, entre comillas dobles');

  uno('cicatriz', CICATRICES);
  uno('chico', SI_NO);
  if (tiene(d, 'chico-por')) texto('chico-por');
  else if (d.chico === 'sí' && esTexto(d.cicatriz) && d.cicatriz !== 'no') mal('chico-por', '"chico: sí" va contra la cicatriz y no dice por qué', 'agregá chico-por: "<razón>" (RT2-8)');
  uno('urgente', SI_NO, false);

  // Los datos de cada estado.
  const soloCon = (k, estados) => {
    if (tiene(d, k) && estado && !estados.includes(estado)) mal(k, `"${k}" en un cambio ${estado}`, `"${k}" va solo con ${estados.join(' o ')}`);
  };
  soloCon('sha', ['aplicado', 'subio-al-kit']);
  soloCon('aplico', ['aplicado', 'subio-al-kit']);
  soloCon('motivo', ['rechazado']);
  soloCon('version', ['subio-al-kit']);
  soloCon('aprobo', ['aprobado', 'aplicado', 'rechazado', 'subio-al-kit']);
  if (CON_SHA.includes(estado) && !tiene(d, 'sha')) mal('sha', `${estado} sin "sha"`, 'anotá el commit que lo aplicó: cambios anotar-sha <id> <sha>');
  if (tiene(d, 'sha') && (!esTexto(d.sha) || !RE_SHA.test(d.sha))) mal('sha', '"sha" no es un SHA completo', 'anotalo con cambios anotar-sha (lo completa solo)');
  if (estado === 'rechazado') {
    if (!tiene(d, 'motivo')) mal('motivo', 'rechazado sin "motivo"', 'cambios rechazar <id> "<motivo>"');
    else texto('motivo');
  }
  if (estado === 'subio-al-kit' && (!esTexto(d.version) || !RE_VERSION.test(d.version))) mal('version', 'subio-al-kit sin "version" N.N.N', 'poné la versión del kit que lo trajo');
  if (tiene(d, 'aplico')) {
    const a = d.aplico;
    if (!esMapa(a) || Object.keys(a).sort().join() !== 'archivo,hash' || !esTexto(a.archivo) || !esTexto(a.hash) || !RE_HASH.test(a.hash)) {
      mal('aplico', '"aplico" no es {archivo, hash} con 12 hexa', 'anotalo con cambios anotar-sha <id> <sha> --aplico <archivo>');
    }
  }

  // El sello: su forma (lo de git y frenos.log lo mira validarSello).
  if (estado === 'aprobado' && clase === '2') mal('estado', 'aprobado en un cambio de clase 2', 'aprobado es solo para 3-barrera: un clase 2 pasa de propuesto a aplicado');
  if (barrera && (estado === 'aprobado' || CON_SHA.includes(estado)) && !tiene(d, 'aprobo')) {
    mal('aprobo', `3-barrera ${estado} sin sello`, 'el único camino a aprobado es cambios aprobar <id>, desde tu checkout principal');
  }
  if (tiene(d, 'aprobo') && formaSello(d.aprobo)) mal('aprobo', `el sello está mal formado (${formaSello(d.aprobo)})`, 'el sello lo escribe solo cambios aprobar: no se arregla a mano');

  // El cuerpo.
  for (const s of faltanSecciones(cuerpo)) mal('cuerpo', `falta la sección "## ${s}"`, 'el cuerpo lleva las cuatro: Caso de origen, Regla, Dónde vive, Medición');
  if (!faltanSecciones(cuerpo).includes('Regla') && reglaEnUnaLinea(cuerpo) === null) mal('cuerpo', 'la sección "## Regla" está vacía', 'su primera línea es la regla en una línea');
  return f;
}

// null si el sello tiene la forma; si no, qué le pasa (sin repetir valores).
function formaSello(s) {
  if (!esMapa(s)) return 'no es un mapa en línea';
  const claves = Object.keys(s).sort().join();
  if (claves !== [...CAMPOS_SELLO].sort().join()) return `tiene que tener exactamente ${CAMPOS_SELLO.join(', ')}`;
  if (!CAMPOS_SELLO.every((k) => esTexto(s[k]) && s[k] !== '')) return 'cada campo es un texto';
  if (!RE_HASH.test(s.hash)) return 'el hash no son 12 hexa';
  if (!RE_FECHA.test(s.fecha) || Number.isNaN(Date.parse(s.fecha))) return 'la fecha no es AAAA-MM-DDTHH:MM:SS±hh:mm';
  return null;
}

// ---------------------------------------------------------------- git: utilidades

const ARBOL_VACIO_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function shaDe(raiz, rev) {
  return git.texto(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { cwd: raiz });
}
function padres(raiz, sha) {
  const t = git.texto(['rev-list', '--parents', '-n', '1', sha], { cwd: raiz });
  return t ? t.split(/\s+/).slice(1) : [];
}
// El contenido de <rev>:<ruta> como Buffer, o null si no está.
function blob(raiz, rev, rel) {
  const r = git.correr(['cat-file', 'blob', `${rev}:${rel}`], { cwd: raiz });
  return r.ok ? r.salida : null;
}
const partirZ = (t) => (t ? t.split('\0').filter((x) => x !== '') : []);
function esAncestro(raiz, a, b) {
  return git.correr(['merge-base', '--is-ancestor', a, b], { cwd: raiz }).ok;
}

// cat-file --batch-check y --batch en una llamada cada uno: [entrada] → [{tipo, contenido (Buffer, solo con conContenido)} | null].
function lotes(raiz, entradas, conContenido) {
  if (!entradas.length) return [];
  const r = git.correr(['cat-file', conContenido ? '--batch' : '--batch-check'], { cwd: raiz, entrada: `${entradas.join('\n')}\n`, tiempo: 20000 });
  if (!r.ok) throw new Error('git cat-file no anduvo');
  const b = r.salida;
  const res = [];
  let i = 0;
  for (let k = 0; k < entradas.length; k++) {
    const fin = b.indexOf(0x0a, i);
    if (fin < 0) throw new Error('git cat-file cortado');
    const cab = b.subarray(i, fin).toString('utf8');
    i = fin + 1;
    if (/ missing$/.test(cab) || / ambiguous$/.test(cab)) {
      res.push(null);
      continue;
    }
    const m = /^([0-9a-f]+) (\S+) (\d+)$/.exec(cab);
    if (!m) throw new Error('git cat-file: salida inesperada');
    const item = { objeto: m[1], tipo: m[2], tam: Number(m[3]) };
    if (conContenido) {
      item.contenido = b.subarray(i, i + item.tam);
      i += item.tam + 1;
    }
    res.push(item);
  }
  return res;
}

// La rama por defecto LOCAL (refs/heads/<x>, donde corre aprobar; r4-5): { nombre, ref } o null.
function ramaLocal(raiz) {
  const nombre = contexto.ramaPorDefecto(raiz);
  if (!nombre) return null;
  const ref = `refs/heads/${nombre}`;
  return shaDe(raiz, ref) ? { nombre, ref } : null;
}

// ---------------------------------------------------------------- toca: qué barreras toca un commit (o lo pendiente)

// La categoría de barrera de una ruta (candado:barreras, P6.1; más los dos scripts del candado en `hooks`, r4-3), o null.
// 'ficha' es .claude/kit.md: sus categorías (frenos, sensible, autorizado) salen de comparar el contenido. Sin mayúsculas:
// en Windows .Claude/Hooks es la misma carpeta.
function categoriaDe(rel) {
  const r = String(rel).replace(/\\/g, '/').toLowerCase();
  if (r === contexto.RUTA_FICHA) return 'ficha';
  if (/^\.claude\/settings[^/]*\.json$/.test(r)) return 'settings';
  if (r === '.claude/hooks' || r.startsWith('.claude/hooks/')) return 'hooks';
  if (r === '.claude/scripts/estructura.cjs' || r === '.claude/scripts/cambios.cjs') return 'hooks';
  if (r === '.githooks' || r.startsWith('.githooks/')) return 'githooks';
  if (r === '.gitleaksignore' || r === '.gitleaks.toml') return 'gitleaks';
  return null;
}

// Igualdad de valores JSON: el orden de las claves no importa; el de las listas, sí.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (esMapa(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const aTexto = (b) => (b == null ? null : Buffer.isBuffer(b) ? b.toString('utf8') : String(b));

// La ficha de un lado: null (no está), { rota: true } o { datos }.
function ladoFicha(b) {
  const t = aTexto(b);
  if (t === null) return null;
  try {
    return { datos: ficha.leer(t).datos };
  } catch (e) {
    return { rota: true };
  }
}

const PIEZAS_FRENO = ['candado', 'hook-escritura'];
const estadoPieza = (datos, p) => {
  const v = datos && esMapa(datos.piezas) ? datos.piezas[p] : undefined;
  if (v == null) return null;
  if (esTexto(v)) return v;
  return esMapa(v) && esTexto(v.estado) ? v.estado : null;
};
// Los frenos de la ficha por id: {id → canon del ítem}. quitados por su id; opcionales por su texto (o su id si es un mapa).
function frenosPorId(datos) {
  const m = new Map();
  const fr = datos && esMapa(datos.frenos) ? datos.frenos : {};
  const poner = (id, v) => {
    if (!esTexto(id) || id === '') return;
    const k = normalizarId(id);
    m.set(k, `${m.has(k) ? `${m.get(k)}|` : ''}${canon(v)}`);
  };
  for (const lista of ['quitados', 'opcionales']) {
    for (const it of Array.isArray(fr[lista]) ? fr[lista] : []) poner(esMapa(it) ? it.id : it, [lista, it]);
  }
  return m;
}
// Todos los ids de una ficha (borrarla los cambia todos; r4-2).
function todosLosIds(datos) {
  const ids = [...frenosPorId(datos).keys()];
  const fr = datos && esMapa(datos.frenos) ? datos.frenos : {};
  for (const k of Object.keys(fr)) if (k !== 'quitados' && k !== 'opcionales') ids.push(`frenos:${k}`);
  for (const k of Object.keys(datos && esMapa(datos.sensible) ? datos.sensible : {})) ids.push(`sensible:${k}`);
  for (const k of Object.keys(datos && esMapa(datos.autorizado) ? datos.autorizado : {})) ids.push(`autorizado:${k}`);
  for (const k of ['secretos', 'publicas']) for (const x of nombresDe(datos, k)) ids.push(`${k}:${x}`);
  if (tiene(datos, 'datos-de-prueba')) ids.push('datos-de-prueba');
  ids.push('nivel', ...PIEZAS_FRENO.map((p) => `pieza:${p}`));
  return ids;
}
// Los nombres de secretos: o publicas: (D-3): la lista de textos, o [] si no está o no es lista (eso lo dice ficha.cjs).
const nombresDe = (datos, k) => [...new Set(datos && Array.isArray(datos[k]) ? datos[k].filter(esTexto) : [])];

// Un par categoría·id en un texto (la clave de los conjuntos que se intersecan en un merge; rf-3): el mismo id puede ser de dos
// categorías (`deny:X` en frenos.quitados es frenos, en el settings es settings), así que se cruzan los pares, no los ids sueltos.
const SEP_PAR = '\u0000';
const par = (cat, id) => `${cat}${SEP_PAR}${normalizarId(id)}`;
// { categorias, ids } a partir de un conjunto de pares.
function desdePares(pares) {
  const cats = new Set();
  const ids = new Set();
  for (const p of pares) {
    const i = p.indexOf(SEP_PAR);
    cats.add(p.slice(0, i));
    ids.add(p.slice(i + 1));
  }
  return { categorias: unicos([...cats]), ids: unicos([...ids]) };
}
const TRES_FICHA = ['frenos', 'sensible', 'autorizado'];

// idsFicha(antes, después) → { categorias, ids, pares }. Cuentan los frenos, sensible y autorizado que cambian, y nivel y las dos
// piezas SOLO cuando aflojan (r5-3): la pieza pasa de algo distinto de `no` a `no` o a no estar; el nivel, de estandar a otro.
// Igual, en frenos, secretos:<NOMBRE>, publicas:<NOMBRE> y datos-de-prueba (D-3), y van en el `ids:` de un 3-barrera con toca frenos.
// pares: cada id con su categoría (lo que no se lee, o la ficha borrada, cuenta en las tres).
function idsFicha(antesB, despuesB) {
  const a = ladoFicha(antesB);
  const d = ladoFicha(despuesB);
  const pares = new Set();
  const salida = () => ({ ...desdePares(pares), pares });
  if (!a && !d) return salida();
  const enLasTres = (ids) => ids.forEach((id) => TRES_FICHA.forEach((c) => pares.add(par(c, id))));
  if ((a && a.rota) || (d && d.rota)) {
    // Lo que no se lee no se compara: el lado que se lee cuenta entero; si ninguno se lee, `ficha:rota` hay que declararlo.
    const sano = a && !a.rota ? a : d && !d.rota ? d : null;
    enLasTres(sano ? todosLosIds(sano.datos) : ['ficha:rota']);
    return salida();
  }
  if (a && !d) {
    enLasTres(todosLosIds(a.datos));
    return salida();
  }
  const A = a ? a.datos : {};
  const D = d.datos;
  // frenos
  const fa = frenosPorId(A);
  const fd = frenosPorId(D);
  for (const id of new Set([...fa.keys(), ...fd.keys()])) {
    if (fa.get(id) !== fd.get(id)) pares.add(par('frenos', id));
  }
  const fra = esMapa(A.frenos) ? A.frenos : {};
  const frd = esMapa(D.frenos) ? D.frenos : {};
  for (const k of new Set([...Object.keys(fra), ...Object.keys(frd)])) {
    if (k === 'quitados' || k === 'opcionales') continue;
    if (canon(fra[k]) !== canon(frd[k])) pares.add(par('frenos', `frenos:${k}`));
  }
  if (a) {
    if (A.nivel === 'estandar' && D.nivel !== 'estandar') pares.add(par('frenos', 'nivel'));
    for (const p of PIEZAS_FRENO) {
      const ea = estadoPieza(A, p);
      const ed = estadoPieza(D, p);
      if (ea !== null && ea !== 'no' && (ed === null || ed === 'no')) pares.add(par('frenos', `pieza:${p}`));
    }
  }
  // D-3: secretos:, publicas: y datos-de-prueba:, en frenos y SOLO cuando aflojan: sacar un nombre de secretos: (el corrector deja
  // de cuidarlo), sumar uno a publicas: (deja de frenarlo) o cambiar datos-de-prueba: (otra lista de lo que se deja pasar; ponerlo
  // donde no estaba también). Sumar a secretos:, sacar de publicas: o sacar datos-de-prueba: aprieta y no cuenta.
  const secretosD = new Set(nombresDe(D, 'secretos'));
  for (const x of nombresDe(A, 'secretos')) if (!secretosD.has(x)) pares.add(par('frenos', `secretos:${x}`));
  const publicasA = new Set(nombresDe(A, 'publicas'));
  for (const x of nombresDe(D, 'publicas')) if (!publicasA.has(x)) pares.add(par('frenos', `publicas:${x}`));
  if (tiene(D, 'datos-de-prueba') && canon(A['datos-de-prueba']) !== canon(D['datos-de-prueba'])) pares.add(par('frenos', 'datos-de-prueba'));
  // 8r3 i1: carpeta-docs: en los dos sentidos (ponerla, sacarla o cambiarla): mueve lo que miran el candado y la base de barreras.
  // Cuenta el valor que vale (sin la clave, docs): escribir `carpeta-docs: docs` donde no estaba no mueve nada.
  if (ficha.carpetaDocs(A) !== ficha.carpetaDocs(D)) pares.add(par('frenos', 'carpeta-docs'));
  // sensible y autorizado, por clave
  for (const cat of ['sensible', 'autorizado']) {
    const ma = esMapa(A[cat]) ? A[cat] : {};
    const md = esMapa(D[cat]) ? D[cat] : {};
    for (const k of new Set([...Object.keys(ma), ...Object.keys(md)])) {
      if (canon(ma[k]) !== canon(md[k])) pares.add(par(cat, `${cat}:${k}`));
    }
  }
  return salida();
}

// Un settings de un lado: { valor } (null = no está, como {}) o { roto: true }.
function ladoSettings(b) {
  const t = aTexto(b);
  if (t === null) return { valor: {} };
  const r = leerJsonSinDuplicados(t);
  return r.ok && esMapa(r.valor) ? { valor: r.valor } : { roto: true };
}
function reglasPorId(valor) {
  const m = new Map();
  for (const r of reglas(valor)) {
    const c = r.tipo === 'hook' ? canon(r.entrada) : r.texto;
    if (!m.has(r.id)) m.set(r.id, []);
    m.get(r.id).push(c);
  }
  for (const [k, v] of m) m.set(k, v.sort().join('\n'));
  return m;
}

// idsSettings(antes, después, rel) → los ids que cambian: las reglas (id de zona-propia.reglas, normalizado) que aparecen,
// desaparecen o cambian (un hook con el mismo id y otro timeout u onFailure cuenta), y `settings:<clave>` por cualquier otra
// clave (`settings:permissions.<clave>` adentro de permissions). Un lado que no abre como JSON: `settings:<archivo>` y todo lo del otro.
function idsSettings(antesB, despuesB, rel) {
  const a = ladoSettings(antesB);
  const d = ladoSettings(despuesB);
  const ids = [];
  const A = a.roto ? {} : a.valor;
  const D = d.roto ? {} : d.valor;
  if (a.roto || d.roto) ids.push(`settings:${rel}`);
  const ra = reglasPorId(A);
  const rd = reglasPorId(D);
  let hookCambio = false;
  for (const id of new Set([...ra.keys(), ...rd.keys()])) {
    if (ra.get(id) !== rd.get(id)) {
      ids.push(id);
      if (id.startsWith('hook:')) hookCambio = true;
    }
  }
  // Lo de hooks que reglas() no ve (un grupo con otra forma, otro orden): que no se escape callado.
  if (!hookCambio && canon(A.hooks) !== canon(D.hooks)) ids.push('settings:hooks');
  for (const k of new Set([...Object.keys(A), ...Object.keys(D)])) {
    if (k === 'hooks') continue;
    if (k === 'permissions' && esMapa(A[k] || {}) && esMapa(D[k] || {})) {
      const pa = A[k] || {};
      const pd = D[k] || {};
      for (const j of new Set([...Object.keys(pa), ...Object.keys(pd)])) {
        if (['allow', 'ask', 'deny'].includes(j)) continue;
        if (canon(pa[j]) !== canon(pd[j])) ids.push(`settings:permissions.${j}`);
      }
      continue;
    }
    if (canon(A[k]) !== canon(D[k])) ids.push(`settings:${k}`);
  }
  return unicos(ids.map(normalizarId));
}

// Lo ignorado que igual es barrera (rf-6 b): un hook, un script o un githook ignorado (un .propio.sh en .gitignore) corre y el
// candado no lo veía. Cuenta como pendiente. Con :(icase): en Windows .Claude/Hooks es la misma carpeta.
const IGNORADOS_BARRERA = [':(icase).claude/hooks', ':(icase).claude/scripts', ':(icase).githooks'];
function ignoradosDeBarrera(raiz) {
  const r = git.correr(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORADOS_BARRERA], { cwd: raiz });
  if (!r.ok) throw new Error('git ls-files no anduvo');
  return partirZ(r.stdout);
}

// 8r3 i3 (rt-1): el caché de bytecode de Python ignorado bajo esas tres carpetas no se exceptúa (los hooks de Hermes lo LEEN al
// cargar otro .py, y la cabecera se calca): se borra. Solo un .pyc cuya carpeta madre es __pycache__ (sin mirar mayúsculas) y que es
// un archivo común (lstat: nunca un enlace ni una carpeta). Uno borrado se rehace del .py seguido; uno fabricado deja de estar.
// → [rel] borrados; el que no se puede borrar no va y sigue contando en ignoradosDeBarrera (rojo, como rf-6 b).
function limpiarCachePython(raiz) {
  const r = git.correr(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORADOS_BARRERA], { cwd: raiz });
  if (!r.ok) throw new Error('git ls-files no anduvo');
  const borrados = [];
  for (const rel of partirZ(r.stdout)) {
    const partes = rel.split('/');
    if (!rel.endsWith('.pyc') || partes.length < 2 || partes[partes.length - 2].toLowerCase() !== '__pycache__') continue;
    const abs = path.join(raiz, ...partes);
    try {
      if (!fs.lstatSync(abs).isFile()) continue;
      fs.unlinkSync(abs);
      borrados.push(rel);
    } catch {
      // no se pudo: sigue ahí y cuenta como pendiente
    }
  }
  return borrados;
}

// Las rutas de lo pendiente: el índice y el disco contra HEAD (o todo el índice sin commits), lo no seguido y lo ignorado de barrera.
function rutasPendientes(raiz, head) {
  const rutas = new Set();
  if (head) {
    for (const args of [['diff', '--no-renames', '--name-only', '-z', 'HEAD'], ['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD']]) {
      const r = git.correr(args, { cwd: raiz });
      if (!r.ok) throw new Error('git diff no anduvo');
      partirZ(r.stdout).forEach((x) => rutas.add(x));
    }
  } else {
    const r = git.correr(['ls-files', '-z'], { cwd: raiz });
    if (!r.ok) throw new Error('git ls-files no anduvo');
    partirZ(r.stdout).forEach((x) => rutas.add(x));
  }
  const o = git.correr(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: raiz });
  if (!o.ok) throw new Error('git ls-files no anduvo');
  partirZ(o.stdout).forEach((x) => rutas.add(x));
  ignoradosDeBarrera(raiz).forEach((x) => rutas.add(x));
  return [...rutas].sort();
}

// Las rutas que cambian de <padre> (null: el commit raíz) a <sha>.
function rutasContra(raiz, sha, padre) {
  const r = padre
    ? git.correr(['diff', '--no-renames', '--name-only', '-z', padre, sha], { cwd: raiz })
    : git.correr(['diff-tree', '--root', '--no-renames', '--no-commit-id', '-r', '--name-only', '-z', sha], { cwd: raiz });
  if (!r.ok) throw new Error('git diff no anduvo');
  return partirZ(r.stdout).sort();
}

// Las bases de un merge entre <a> y <b> (git merge-base --all): [sha]. Vacía si no tienen ancestro común.
function basesDeMerge(raiz, a, b) {
  const r = git.correr(['merge-base', '--all', a, b], { cwd: raiz });
  if (!r.ok) {
    if (r.codigo === 1 && !r.error) return [];
    throw new Error('git merge-base no anduvo');
  }
  return String(r.stdout || '').split(/\s+/).filter(Boolean);
}

// Los pares categoría·id que cambian de <desde> (null: nada) a <hasta>, dos commits.
function paresEntre(raiz, desde, hasta) {
  const s = new Set();
  for (const rel of rutasContra(raiz, hasta, desde)) {
    const cat = categoriaDe(rel);
    if (!cat) continue;
    const conContenido = cat === 'ficha' || cat === 'settings';
    paresArchivo(cat, rel, conContenido && desde ? blob(raiz, desde, rel) : null, conContenido ? [blob(raiz, hasta, rel)] : []).forEach((p) => s.add(p));
  }
  return s;
}

// descontarMerge(juzgar, otros) → lo que queda por juzgar de un merge contra UNO de sus padres (rf-3, rf-13; se hace contra cada
// padre, rf-18). juzgar: los pares que cambian contra ese padre. otros: por cada otro padre { distinto: pares en que el merge difiere de ese padre, cambio: pares que ese padre cambió
// respecto de TODAS las bases del merge, o null si no se puede saber (sin base, o una ficha que no se lee) }. Un par se descuenta
// solo si el merge quedó igual a un padre QUE LO CAMBIÓ: eso lo trajo la rama y lo juzgan sus commits. Si el merge quedó igual a un
// padre que no lo tocó (igual a la base), el merge deshace lo del primer padre: se juzga como un commit común.
function descontarMerge(juzgar, otros) {
  const queda = new Set(juzgar);
  for (const o of otros) {
    if (!o.cambio) continue;
    for (const x of juzgar) if (!o.distinto.has(x) && o.cambio.has(x)) queda.delete(x);
  }
  return queda;
}

function leerDisco(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return Buffer.from(fs.readlinkSync(abs), 'utf8');
    if (!st.isFile()) return null;
    return fs.readFileSync(abs);
  } catch (e) {
    return null;
  }
}

// paresArchivo(cat, rel, antes, [después…]) → Set de pares categoría·id que cambian en ese archivo (cualquiera de los después).
function paresArchivo(cat, rel, antes, despues) {
  const s = new Set();
  if (cat === 'ficha') {
    for (const d of despues) idsFicha(antes, d).pares.forEach((p) => s.add(p));
  } else if (cat === 'settings') {
    for (const d of despues) idsSettings(antes, d, rel).forEach((id) => s.add(par('settings', id)));
  } else s.add(par(cat, `${cat}:${rel}`));
  return s;
}

// La intersección de varios conjuntos (null = "todo": el neutro).
function interseccion(conjuntos) {
  let r = null;
  for (const c of conjuntos) r = r === null ? new Set(c) : new Set([...r].filter((x) => c.has(x)));
  return r || new Set();
}

// toca(raiz, sha | 'pendiente') → { categorias, ids }: qué barreras toca un commit o lo pendiente (el índice y el disco contra HEAD,
// sin lo ignorado salvo lo de barrera). Un commit común, contra su padre; un merge, contra CADA padre menos lo que trajo otro padre
// que lo cambió respecto de las bases (descontarMerge; rf-3, rf-13, rf-18), y cuenta la unión. Ids normalizados (r5-4). Tira si git no puede.
function toca(raiz, cual) {
  if (cual === 'pendiente') {
    const head = shaDe(raiz, 'HEAD');
    const s = new Set();
    for (const rel of rutasPendientes(raiz, head)) {
      const cat = categoriaDe(rel);
      if (!cat) continue;
      const conContenido = cat === 'ficha' || cat === 'settings';
      // Lo que se commitearía (el índice) y lo del disco: se juzgan los dos, así no se escapa lo que está solo en uno.
      const despues = conContenido ? [blob(raiz, '', rel), leerDisco(path.join(raiz, ...rel.split('/')))] : [];
      paresArchivo(cat, rel, conContenido && head ? blob(raiz, head, rel) : null, despues).forEach((p) => s.add(p));
    }
    return desdePares(s);
  }
  const sha = shaDe(raiz, cual);
  if (!sha) throw new Error('ese commit no existe');
  const ps = padres(raiz, sha);
  if (ps.length < 2) return desdePares(paresEntre(raiz, ps.length ? ps[0] : null, sha));
  // rf-18: contra CADA padre (si no, la rama vieja como primer padre y un fast-forward después lavan lo que deshace el merge).
  const contra = ps.map((p) => paresEntre(raiz, p, sha));
  const bases = new Map();
  const basesDe = (i, j) => {
    const k = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (!bases.has(k)) bases.set(k, basesDeMerge(raiz, ps[i], ps[j]));
    return bases.get(k);
  };
  const total = new Set();
  ps.forEach((_, i) => {
    const otros = [];
    ps.forEach((pj, j) => {
      if (j === i) return;
      const bs = basesDe(i, j);
      otros.push({ distinto: contra[j], cambio: bs.length ? interseccion(bs.map((b) => paresEntre(raiz, b, pj))) : null });
    });
    descontarMerge(contra[i], otros).forEach((x) => total.add(x));
  });
  return desdePares(total);
}

// El primer commit de <desde>..<hasta> (en orden, del más viejo) que toca alguna de las categorías de `tocaLista`, o null.
// Un `aprobado` sirve para un solo commit: este (r5-1).
function primerQueToca(raiz, desde, hasta, tocaLista) {
  const t = git.texto(['rev-list', '--reverse', '--topo-order', `${desde}..${hasta}`], { cwd: raiz });
  if (t === null) throw new Error('git rev-list no anduvo');
  for (const c of t.split('\n').filter(Boolean)) {
    if (toca(raiz, c).categorias.some((x) => tocaLista.includes(x))) return c;
  }
  return null;
}

// ---------------------------------------------------------------- el sello contra git (RT-p2 1, r2-2, r4-5)

const lineaAprobo = (texto) => {
  if (texto == null) return null;
  const { lineas, cierre } = partir(texto);
  if (cierre < 0) return null;
  const i = (renglonesDeCampos(lineas, cierre).aprobo || [])[0];
  return i === undefined ? null : lineas[i];
};

// commitDelSello(raiz, rel, renglonAprobo, ramaRef) → { sha } o { falla: qué pasa }.
// El commit que dejó el `aprobo:` de hoy, buscado en la historia --first-parent de la rama por defecto local: tiene que ser un
// commit común (no un merge: así llega un sello hecho en un worktree), cuyo padre no tenía sello, que toca solo el archivo del
// cambio y frenos.log, y que agrega a frenos.log el renglón que dice el sello.
function commitDelSello(raiz, rel, renglonAprobo, ramaRef, freno) {
  const t = git.texto(['rev-list', '--first-parent', '--reverse', ramaRef], { cwd: raiz });
  if (!t) return { falla: 'no se pudo leer la historia de la rama por defecto' };
  const commits = t.split('\n').filter(Boolean);
  const check = lotes(raiz, commits.map((c) => `${c}:${rel}`), false);
  const objetos = [...new Set(check.filter((x) => x && x.tipo === 'blob').map((x) => x.objeto))];
  const contenidos = new Map();
  lotes(raiz, objetos, true).forEach((x, k) => contenidos.set(objetos[k], x ? x.contenido.toString('utf8') : null));
  const valores = check.map((x) => (x && x.tipo === 'blob' ? lineaAprobo(contenidos.get(x.objeto)) : null));
  let k = -1;
  for (let i = valores.length - 1; i >= 0; i--) {
    if (valores[i] === renglonAprobo && (i === 0 || valores[i - 1] !== renglonAprobo)) {
      k = i;
      break;
    }
  }
  if (k < 0) return { falla: 'el sello no está en la historia --first-parent de la rama por defecto (¿se escribió a mano o vino de otra rama?)' };
  const sha = commits[k];
  if (k > 0 && valores[k - 1] !== null) return { falla: 'el sello reemplazó a otro sello', sha };
  const p = padres(raiz, sha);
  if (p.length !== 1) return { falla: p.length > 1 ? 'el sello llegó por un merge, no por cambios aprobar en este checkout' : 'el sello está en el primer commit del repo', sha };
  const r = git.correr(['diff', '--no-renames', '--name-only', '-z', p[0], sha], { cwd: raiz });
  if (!r.ok) return { falla: 'no se pudo leer el commit del sello', sha };
  const tocados = partirZ(r.stdout);
  if (tocados.some((x) => x !== rel && x !== frenosLog.RUTA)) return { falla: 'el commit del sello toca algo más que el cambio y frenos.log', sha };
  const conLog = (rev) => {
    const b = blob(raiz, rev, frenosLog.RUTA);
    return b ? b.toString('utf8').replace(/\r\n/g, '\n').split('\n') : [];
  };
  if (!conLog(sha).includes(freno) || conLog(p[0]).includes(freno)) return { falla: 'el renglón del sello no lo agregó a frenos.log el commit del sello', sha };
  return { sha };
}

// validarSello(raiz, {rel, id, texto, datos}, rama) → { fallas: [{que, hacer}], sello: sha | null }. Solo lo que necesita git y
// frenos.log; la forma ya la dijo validar(). `rama` = ramaLocal(raiz) (o null: sin rama por defecto local no hay sello que valga).
function validarSello(raiz, c, rama) {
  const fallas = [];
  const mal = (que, hacer = 'el sello lo escribe solo cambios aprobar <id> desde tu checkout principal: si no lo apretaste vos, rechazalo') => fallas.push({ que, hacer });
  const s = c.datos.aprobo;
  if (s.carpeta !== '.') mal('el sello dice otra carpeta que el checkout principal');
  if (s.rol !== 'humano') mal('el sello dice un rol que no es humano');
  const partes = String(s.freno).split(frenosLog.SEP);
  if (partes.length !== 6 || partes[3] !== ID_APROBAR || partes[4] !== HERRAMIENTA_APROBAR || partes[5] !== c.id || partes[0] !== s.fecha || partes[1] !== s.rol) {
    mal('el renglón del sello no es el que escribe cambios aprobar para este cambio');
  }
  if (hashSello(c.texto) !== s.hash) mal('el hash del sello no coincide con el archivo: alguien lo editó después del clic', 'volvé a proponerlo (cambios nuevo) y aprobalo de nuevo');
  if (!rama) {
    mal('no hay rama por defecto local donde buscar el sello', 'corré doctor');
    return { fallas, sello: null };
  }
  let r;
  try {
    r = commitDelSello(raiz, c.rel, lineaAprobo(c.texto), rama.ref, s.freno);
  } catch (e) {
    mal('no se pudo leer la historia de git', 'corré doctor');
    return { fallas, sello: null };
  }
  if (r.falla) mal(r.falla);
  return { fallas, sello: r.falla ? null : r.sha };
}

// ---------------------------------------------------------------- los cambios del disco

// listarArchivos(raiz) → [{ id, rel, abs }] de .claude/cambios/*.md (también los de nombre inválido: id null).
function listarArchivos(raiz) {
  let nombres;
  try {
    nombres = fs.readdirSync(ruta.carpetaAbsoluta(raiz), { withFileTypes: true });
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  return nombres
    .filter((e) => e.isFile() && e.name.endsWith(ruta.EXTENSION))
    .map((e) => {
      const rel = `${ruta.CARPETA}/${e.name}`;
      return { id: ruta.idDeRuta(rel), nombre: e.name.slice(0, -ruta.EXTENSION.length), rel, abs: path.join(ruta.carpetaAbsoluta(raiz), e.name) };
    })
    .sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0));
}

// cargar(archivo) → { id, rel, abs, texto, datos, cuerpo } o { …, error: {linea, mensaje} }.
function cargar(a) {
  const texto = fs.readFileSync(a.abs, 'utf8');
  try {
    const { datos, cuerpo } = leer(texto);
    return { ...a, texto, datos, cuerpo };
  } catch (e) {
    if (e instanceof ficha.ErrorFicha) return { ...a, texto, error: { linea: e.linea, mensaje: e.mensaje } };
    throw e;
  }
}

// ---------------------------------------------------------------- verificar

const COMANDO = 'node .claude/scripts/cambios.cjs';

// Lo que verificar lee una sola vez por corrida: HEAD y la rama por defecto local (perezosa: solo si hay un sello que mirar).
function contextoVerificar(raiz) {
  let rama;
  let ramaLeida = false;
  return {
    head: shaDe(raiz, 'HEAD'),
    laRama: () => {
      if (!ramaLeida) {
        rama = ramaLocal(raiz);
        ramaLeida = true;
      }
      return rama;
    },
  };
}

// verificarCambio(raiz, archivo, ctx) → [{ id, que, hacer }] de UN cambio (un { id, nombre, rel, abs } de listarArchivos). Lo usan
// verificar, por cada archivo, y el actualizador (SPEC-paquete-7 P6.8b-1: sube al kit solo lo que da verde). ctx: contextoVerificar.
function verificarCambio(raiz, a, ctx = contextoVerificar(raiz)) {
  const fallas = [];
  const { head, laRama } = ctx;
  const id = a.id || a.nombre;
  const mal = (que, hacer) => fallas.push({ id, que, hacer });
  if (!a.id) {
    mal('el nombre no es <AAAA-MM-DD>-<slug>.md', 'los cambios los crea solo cambios nuevo');
    return fallas;
  }
  const c = cargar(a);
  if (c.error) {
    mal(`la cabecera no se lee (línea ${c.error.linea}: ${c.error.mensaje})`, 'los cambios los escribe solo el script: si alguien lo tocó a mano, volvelo atrás con git');
    return fallas;
  }
  for (const f of validar(c.datos, c.cuerpo)) mal(f.que, f.hacer);
  const d = c.datos;
  const barrera = d.clase === '3-barrera';
  // subio-al-kit, con las mismas reglas que aplicado (P6.8b-1.3, crit. 3): el sello, el sha que existe y el primero tras el sello.
  const conSha = CON_SHA.includes(d.estado);
  const conSello = barrera && (d.estado === 'aprobado' || conSha) && tiene(d, 'aprobo') && !formaSello(d.aprobo);
  let sello = null;
  if (conSello) {
    const r = validarSello(raiz, c, laRama());
    r.fallas.forEach((f) => mal(f.que, f.hacer));
    sello = r.sello;
  }
  if (conSha && esTexto(d.sha) && RE_SHA.test(d.sha)) {
    const existe = shaDe(raiz, d.sha) === d.sha;
    // rf-2: un pull --rebase reescribe el commit y el sha anotado queda viejo (no está, o ya no es de la historia de HEAD).
    // Con el sello en orden, el comando listo para reapuntarlo al primer commit de ahora (anotar-sha lo acepta solo así).
    const reescrito = sello && head && (!existe || !esAncestro(raiz, d.sha, head));
    if (reescrito) {
      try {
        const primero = esAncestro(raiz, sello, head) ? primerQueToca(raiz, sello, head, Array.isArray(d.toca) ? d.toca : []) : null;
        mal(
          `${existe ? 'el sha de aplicado ya no está en la historia de HEAD' : 'el sha de aplicado no existe en este repo'} (¿un pull --rebase lo reescribió?)`,
          primero ? `${COMANDO} anotar-sha ${id} ${primero}` : `anotá el commit que lo aplicó: ${COMANDO} anotar-sha ${id} <sha>`,
        );
      } catch (e) {
        mal('no se pudo leer la historia de git', 'corré doctor');
      }
    } else if (!existe) {
      mal('el sha de aplicado no existe en este repo', `anotá el commit que lo aplicó: ${COMANDO} anotar-sha ${id} <sha>`);
    } else if (sello) {
      try {
        if (d.sha === sello || !esAncestro(raiz, sello, d.sha)) mal('el sha de aplicado no viene después del sello', 'anotá el primer commit después del sello que toca lo de "toca"');
        else {
          const primero = primerQueToca(raiz, sello, d.sha, d.toca);
          if (primero !== d.sha) {
            mal(
              primero ? 'el sha de aplicado no es el primer commit que toca lo de "toca" después del sello' : 'el commit de aplicado no toca nada de lo de "toca"',
              primero ? `${COMANDO} anotar-sha ${id} ${primero}` : 'anotá el commit que aplicó el cambio',
            );
          }
        }
      } catch (e) {
        mal('no se pudo leer la historia de git', 'corré doctor');
      }
    }
  }
  if (d.estado === 'aprobado' && sello && head) {
    try {
      if (esAncestro(raiz, sello, head)) {
        const primero = primerQueToca(raiz, sello, head, Array.isArray(d.toca) ? d.toca : []);
        if (primero) mal('consumido sin anotar: ya hay un commit después del sello que toca lo de "toca"', `${COMANDO} anotar-sha ${id} ${primero}`);
      }
    } catch (e) {
      mal('no se pudo leer la historia de git', 'corré doctor');
    }
  }
  return fallas;
}

// verificar(raiz) → [{ id, que, hacer }]. Vacía = en orden. Lo de "D2.2 — AGREGA" y F3: forma, estados, sello (carpeta,
// rol, frenos.log, hash, --first-parent, solo esos dos archivos), sha que existe, aplicado (y subio-al-kit) = el primer commit
// tras el sello que toca su `toca` (r5-1), y "consumido sin anotar" con el comando listo. Cada archivo, con verificarCambio.
function verificar(raiz) {
  const ctx = contextoVerificar(raiz);
  const fallas = [];
  for (const a of listarArchivos(raiz)) fallas.push(...verificarCambio(raiz, a, ctx));
  return fallas;
}

module.exports = {
  ESTADOS,
  CLASES,
  BARRERAS,
  CICATRICES,
  SECCIONES,
  CAMPOS,
  CAMPOS_SELLO,
  FUERA_DEL_HASH,
  CON_SHA,
  ID_APROBAR,
  HERRAMIENTA_APROBAR,
  COMANDO,
  RE_SHA,
  textoValido,
  partir,
  leer,
  hashSello,
  comillas,
  ponerCampos,
  armar,
  textoSello,
  aSubioAlKit,
  secciones,
  faltanSecciones,
  reglaEnUnaLinea,
  validar,
  formaSello,
  categoriaDe,
  idsFicha,
  idsSettings,
  par,
  desdePares,
  paresArchivo,
  interseccion,
  ignoradosDeBarrera,
  limpiarCachePython,
  rutasPendientes,
  rutasContra,
  basesDeMerge,
  paresEntre,
  descontarMerge,
  IGNORADOS_BARRERA,
  toca,
  primerQueToca,
  ramaLocal,
  lineaAprobo,
  commitDelSello,
  validarSello,
  listarArchivos,
  cargar,
  contextoVerificar,
  verificarCambio,
  verificar,
};
