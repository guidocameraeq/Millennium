'use strict';
// topes.cjs — los números del paquete 2, escritos una sola vez (B §5, §8, §9; G §21; SPEC-paquete-2 "Las librerías
// compartidas"), y la revisión del handoff (P3.5) y de todos los topes de un checkout (`revisarTopes`, que llama a inyeccion.armar).
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

// ---------------------------------------------------------------- los números

// Lo que inyecta el hook de arranque, en caracteres (`.length` de JS). 10.000 es el corte de la plataforma.
const PRESUPUESTO = 9700;
const CORTE = 10000;

// Tope de cada bloque de la inyección, en caracteres (B §9). Suman el presupuesto.
const BLOQUES = Object.freeze({
  cabecera: 250,
  lineasF: 500,
  edades: 100,
  handoff: 5000,
  modulos: 300,
  cabeceraFichaModulo: 1000,
  cabeceraTodo: 1500,
  git: 800,
  titulosYHuella: 250,
});

// Topes de archivos, en bytes.
const HANDOFF_BYTES = 5000; // B §8
const FICHA_ACTIVA_BYTES = 5000; // ficha de módulo EN OBRA o PAUSADO (B §5)
const MAPA_BYTES = 5000; // docs/MAPA.md (G §21)
const MESA_BYTES = 2000; // cada archivo de la mesa (orden 5)

// ---------------------------------------------------------------- el handoff (P3.5)

// Las secciones, en este orden. Se reconocen por el principio del título.
const SECCIONES_HANDOFF = Object.freeze([
  '# Handoff',
  '## Estado',
  '## Próximo paso',
  '## Bloqueos',
  '## Te espera',
  '## En curso',
  '## Contexto',
]);

// Lo que se fue del handoff v2: lo imprime el hook o lo dice git.
const PROHIBIDAS = Object.freeze(['Qué se hizo', 'Archivos tocados']);

// El título "empieza con" la sección: después viene el fin, un espacio o un signo (no otra letra: "## Estados" no es "## Estado").
function empiezaConTitulo(linea, titulo) {
  if (!linea.startsWith(titulo)) return false;
  const sig = linea.slice(titulo.length, titulo.length + 1);
  return sig === '' || !/[\p{L}\p{N}_]/u.test(sig);
}

const nivelDe = (linea) => {
  const m = /^(#{1,6})\s/.exec(linea);
  return m ? m[1].length : 0;
};

// revisarHandoff(texto, nivel) → lista de fallas [{ tipo, mensaje }]; vacía = pasa.
// tipo: 'tamano' · 'falta' · 'desordenada' · 'repetida' · 'prohibida' · 'produccion'.
// Los mensajes no repiten el contenido del handoff: dicen qué pasa y qué hacer.
function revisarHandoff(texto, nivel) {
  const fallas = [];
  const crudo = Buffer.isBuffer(texto) ? texto : Buffer.from(String(texto == null ? '' : texto), 'utf8');
  if (crudo.length > HANDOFF_BYTES) {
    fallas.push({
      tipo: 'tamano',
      mensaje: `el handoff pesa ${crudo.length} bytes y el tope es ${HANDOFF_BYTES} — mandá el detalle al CHANGELOG, las trampas a referencia/trampas.md y los pendientes viejos al TODO`,
    });
  }
  const lineas = crudo.toString('utf8').replace(/^\uFEFF/, '').normalize('NFC').split(/\r?\n/);

  // Títulos fuera de los bloques de código.
  const titulos = [];
  let enCodigo = false;
  lineas.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) {
      enCodigo = !enCodigo;
      return;
    }
    if (enCodigo) return;
    const prohibidaLinea = /^\s*(\*\*|__)?Cierre(\*\*|__)?\s*:/.test(l);
    if (prohibidaLinea) {
      fallas.push({ tipo: 'prohibida', linea: i + 1, mensaje: `línea ${i + 1}: la línea "Cierre:" ya no va — la fecha y el commit los imprime el hook; borrala` });
    }
    if (nivelDe(l) > 0) titulos.push({ texto: l.replace(/\s+$/, ''), n: i + 1 });
  });

  const vistas = []; // índice de sección en orden de aparición
  let iEstado = -1;
  for (const t of titulos) {
    const sinNumerales = t.texto.replace(/^#{1,6}\s+/, '');
    for (const p of PROHIBIDAS) {
      if (empiezaConTitulo(sinNumerales, p)) {
        fallas.push({ tipo: 'prohibida', linea: t.n, mensaje: `línea ${t.n}: la sección "${p}" ya no va en el handoff — eso vive en el CHANGELOG o en git; sacala` });
      }
    }
    // "# Handoff" no es el principio de "## Handoff", ni "## Estado" el de "### Estado": el nivel va en el prefijo.
    const k = SECCIONES_HANDOFF.findIndex((s) => empiezaConTitulo(t.texto, s));
    if (k < 0) continue;
    if (vistas.includes(k)) {
      fallas.push({ tipo: 'repetida', linea: t.n, mensaje: `línea ${t.n}: "${SECCIONES_HANDOFF[k]}" está dos veces — dejá una sola` });
      continue;
    }
    vistas.push(k);
    if (k === 1) iEstado = t.n - 1;
  }

  SECCIONES_HANDOFF.forEach((s, k) => {
    if (!vistas.includes(k)) fallas.push({ tipo: 'falta', mensaje: `falta la sección "${s}" — agregala en su lugar (${SECCIONES_HANDOFF.join(' · ')})` });
  });
  for (let j = 1; j < vistas.length; j++) {
    if (vistas[j] < vistas[j - 1]) {
      fallas.push({
        tipo: 'desordenada',
        mensaje: `"${SECCIONES_HANDOFF[vistas[j]]}" está después de "${SECCIONES_HANDOFF[vistas[j - 1]]}" — el orden es ${SECCIONES_HANDOFF.join(' · ')}`,
      });
      break;
    }
  }

  // En estandar, `- Producción: …` adentro de ## Estado (B §8: estado · fecha · cómo se verificó, o REPORTADO POR EL USUARIO, o no hay).
  if (nivel === 'estandar') {
    let tiene = false;
    if (iEstado >= 0) {
      for (let i = iEstado + 1; i < lineas.length; i++) {
        if (nivelDe(lineas[i]) > 0) break;
        if (/^- Producción:\s*\S/.test(lineas[i])) {
          tiene = true;
          break;
        }
      }
    }
    if (!tiene) {
      fallas.push({
        tipo: 'produccion',
        mensaje: 'en nivel estandar, "## Estado" lleva "- Producción: <estado> · <fecha> · <cómo se verificó>" (o REPORTADO POR EL USUARIO, o no hay) — agregala',
      });
    }
  }
  return fallas;
}

// ---------------------------------------------------------------- todos los topes de un checkout (candado:topes, B §14)

// revisarTopes(raiz, {home, ahora}) → lista de fallas [{ id: 'candado:topes', tipo, archivo, mensaje }]; vacía = pasa.
// tipo: 'handoff' (con `detalle` = el tipo de revisarHandoff) · 'ficha' · 'mapa' · 'inyeccion'.
// Lo que inyectaría el hook se calcula llamando a inyeccion.armar (el mismo código del hook): falla si se pasa de 9.700 o si
// algún documento no entra en su bloque y el hook lo tendría que cortar (el CORTADO es la red; el candado evita llegar a ella).
// Los require son perezosos: inyeccion.cjs requiere este archivo (el ciclo, como en todo.cjs).
function revisarTopes(raiz, opciones = {}) {
  const fs = require('fs');
  const path = require('path');
  const fallas = [];
  const falla = (tipo, archivo, mensaje, extra) => fallas.push({ id: 'candado:topes', tipo, archivo, mensaje, ...extra });
  const leer = (rel) => {
    try {
      return fs.readFileSync(path.join(raiz, ...rel.split('/')));
    } catch (e) {
      return null;
    }
  };

  // El nivel, de la ficha vigente (regla de 4.7); sin ficha o rota, no se exige la línea de Producción.
  // La carpeta de papeles (8r3 i1), de la misma ficha vigente: docs sin la clave.
  let nivel;
  let carpeta = 'docs';
  try {
    const fv = require('./contexto.cjs').fichaVigente(raiz);
    if (fv.estado === 'ok') nivel = fv.datos.nivel;
    carpeta = require('./docs-ruta.cjs').deVigente(fv, raiz);
  } catch (e) {
    nivel = undefined;
  }
  const rutaHandoff = `${carpeta}/SESSION_HANDOFF.md`;
  const rutaMapa = `${carpeta}/MAPA.md`;

  // 1 · el handoff (5.000 bytes y sus secciones)
  const h = leer(rutaHandoff);
  let handoffGrande = false;
  if (h !== null) {
    for (const f of revisarHandoff(h, nivel)) {
      if (f.tipo === 'tamano') handoffGrande = true;
      falla('handoff', rutaHandoff, f.mensaje, { detalle: f.tipo });
    }
  }

  // 2 · las fichas de módulo EN OBRA o PAUSADO (5.000 bytes)
  const iny = require('./inyeccion.cjs');
  let modulos = [];
  try {
    modulos = fs
      .readdirSync(path.join(raiz, ...carpeta.split('/'), 'modulos'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    modulos = [];
  }
  for (const x of modulos) {
    const rel = `${carpeta}/modulos/${x}/README.md`;
    const b = leer(rel);
    if (b === null || !iny.datosFichaModulo(b.toString('utf8')).activo) continue;
    if (b.length > FICHA_ACTIVA_BYTES) {
      falla('ficha', rel, `${rel} está activa y pesa ${b.length} bytes; el tope es ${FICHA_ACTIVA_BYTES} — mandá la historia a la bitácora del módulo y dejá en la ficha el estado y lo que sigue`);
    }
  }

  // 3 · MAPA.md (5.000 bytes; puede no existir)
  const m = leer(rutaMapa);
  if (m !== null && m.length > MAPA_BYTES) {
    falla('mapa', rutaMapa, `${rutaMapa} pesa ${m.length} bytes y el tope es ${MAPA_BYTES} — la arquitectura a fondo va a referencia/ARCHITECTURE.md; acá, una pantalla`);
  }

  // 4 · lo que inyectaría el hook
  const r = iny.armar({ cwd: raiz, entrada: { cwd: raiz }, home: opciones.home, ahora: opciones.ahora });
  if (r.texto.length > PRESUPUESTO) {
    falla('inyeccion', null, `el hook inyectaría ${r.texto.length} caracteres y el tope es ${PRESUPUESTO} — achicá el handoff, el TODO en rojo y naranja o las fichas activas`);
  } else {
    const cortes = r.cortes.filter((c) => !(handoffGrande && c.que === 'el handoff'));
    if (cortes.length) {
      falla('inyeccion', null, `el hook tendría que cortar ${cortes.map((c) => `${c.que} (${c.ruta})`).join(', ')} — achicalo hasta que entre en su bloque (B §9), así la sesión arranca viéndolo entero`);
    }
  }
  return fallas;
}

module.exports = {
  revisarTopes,
  PRESUPUESTO,
  CORTE,
  BLOQUES,
  HANDOFF_BYTES,
  FICHA_ACTIVA_BYTES,
  MAPA_BYTES,
  MESA_BYTES,
  SECCIONES_HANDOFF,
  PROHIBIDAS,
  revisarHandoff,
};
