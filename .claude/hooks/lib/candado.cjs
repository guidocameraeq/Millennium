'use strict';
// candado.cjs — el candado de estructura (B §14; SPEC-0 6.1; SPEC-paquete-2 P6.1 y F4): los diez chequeos (el décimo, `portada`, solo si la ficha lo prende) y quién corre.
// Cada chequeo es (raiz, opciones) → [{ id, que, hacer, detalle, soloLista? }]: corrector, no pregunta (dice qué pasa y qué hacer).
// `barreras` vive aparte, en lib/barreras.cjs. correr() decide qué corre según la ficha vigente (regla de 4.7) y anota cada
// frenada en .claude/frenos.log (herramienta `estructura`, detalle = ruta relativa o texto fijo). Lo usa scripts/estructura.cjs.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const git = require('./git.cjs');
const contexto = require('./contexto.cjs');
const arbol = require('./arbol.cjs');
const topes = require('./topes.cjs');
const frenosLog = require('./frenos-log.cjs');
const ficha = require('./ficha.cjs');
const { datosFichaModulo } = require('./inyeccion.cjs');
const barreras = require('./barreras.cjs');
const cambiosRuta = require('./cambios-ruta.cjs');
const mesaLib = require('./mesa.cjs');
const docsRuta = require('./docs-ruta.cjs');

const IDS = ['raiz', 'rutas', 'topes', 'mesa', 'estados', 'lecturas', 'estado-viejo', 'barreras', 'datos', 'portada'];
const PARCIAL = ['topes', 'barreras']; // en `cierre parcial`: el handoff y las barreras
const HERRAMIENTA = 'estructura';
const LECTURA_GRANDE = 100 * 1024; // B §11.3
const RUTA_CLAUDE = 'CLAUDE.md';
const CARPETA_SKILLS = '.claude/skills';

const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sinBom = (t) => String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// 8r3 i1: la carpeta de papeles (docs/ o la `carpeta-docs:` de la ficha vigente). correr() la pone en las opciones (de la misma
// ficha que decide qué corre); un chequeo llamado suelto la lee de docs-ruta. Ningún chequeo mira el docs/ de otro proyecto.
const carpetaDe = (raiz, op) => (op && typeof op.carpeta === 'string' && op.carpeta ? op.carpeta : docsRuta.deRaiz(raiz));
const rutaHandoff = (carpeta) => docsRuta.rel(carpeta, 'SESSION_HANDOFF.md');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- utilidades

// git ls-files de lo commiteado y lo nuevo sin ignorar, con '/', sin repetidos.
function archivos(raiz, specs = []) {
  const r = git.correr(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs], { cwd: raiz, tiempo: 20000 });
  if (!r.ok) throw new Error('git ls-files no anduvo');
  return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
}
function leer(raiz, rel) {
  try {
    return fs.readFileSync(path.join(raiz, ...rel.split('/')));
  } catch (e) {
    return null;
  }
}
const esBinario = (b) => b.includes(0);
function blob(raiz, rev, rel) {
  const r = git.correr(['cat-file', 'blob', `${rev}:${rel}`], { cwd: raiz });
  return r.ok ? r.salida.toString('utf8') : null;
}

// Los módulos: las carpetas de <carpeta>/modulos/ que tienen algo adentro (según git ls-files).
function modulos(lista, carpeta = docsRuta.POR_DEFECTO) {
  const re = new RegExp(`^${escRe(carpeta)}/modulos/([^/]+)/.`);
  const s = new Set();
  for (const rel of lista) {
    const m = re.exec(rel);
    if (m) s.add(m[1]);
  }
  return [...s].sort();
}

// "x — y" → { que: x, hacer: y } (los mensajes de topes y del árbol traen las dos partes así).
function partirMensaje(m) {
  const i = m.indexOf(' — ');
  return i < 0 ? { que: m, hacer: 'corregilo' } : { que: m.slice(0, i), hacer: m.slice(i + 3) };
}

// ---------------------------------------------------------------- candado:raiz

// La raíz de docs/ con los seis archivos y las tres carpetas (juzgarRuta sobre lo que lista git), y cada docs/modulos/<x>/ con su
// README.md con `Estado:`.
function raiz_(raiz, op) {
  const carpeta = carpetaDe(raiz, op);
  const n = carpeta.split('/').length;
  const fallas = [];
  const lista = archivos(raiz, [carpeta]);
  const vistos = new Set();
  for (const rel of lista) {
    const j = arbol.juzgarRuta(raiz, rel, carpeta);
    if (!j) continue;
    const donde = j.ruta.split('/').length > n + 1 ? `${j.ruta.split('/').slice(0, n + 1).join('/')}/` : j.ruta;
    if (vistos.has(donde)) continue;
    vistos.add(donde);
    const i = j.mensaje.indexOf(' no va ahí: ');
    fallas.push({ id: 'raiz', que: `${j.mensaje.slice(0, i)} no va ahí`, hacer: `movelo ${j.mensaje.slice(i + ' no va ahí: '.length)}`, detalle: donde });
  }
  for (const x of modulos(lista, carpeta)) {
    const rel = `${carpeta}/modulos/${x}/README.md`;
    const b = leer(raiz, rel);
    if (b === null) fallas.push({ id: 'raiz', que: `el módulo ${carpeta}/modulos/${x}/ no tiene su README.md`, hacer: 'escribí la ficha del módulo con su renglón Estado:', detalle: `${carpeta}/modulos/${x}/` });
    else if (datosFichaModulo(b.toString('utf8')).estado === null) fallas.push({ id: 'raiz', que: `${rel} no tiene el renglón Estado:`, hacer: 'agregalo arriba (EN OBRA, PAUSADO, COMPLETO o ABANDONADO)', detalle: rel });
  }
  return fallas;
}

// ---------------------------------------------------------------- las rutas citadas (candado:rutas y candado:lecturas)

const RE_LINK = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const RE_CODIGO = /`([^`\n]+)`/g;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_HISTORICO = /^\s*>\s*Histórico/;
const RE_TITULO = /^#{1,6}\s/;

// Lo que se saltea: URLs y `<alias>:` (todo lo que empieza con "algo:"), anclas, <placeholder>, comodines y lo que no es una ruta.
function limpiarCita(crudo) {
  let t = crudo.trim().replace(/:\d+(?:-\d+)?$/, ''); // docs/x.md:12 → docs/x.md
  if (t === '' || t.startsWith('#')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return null;
  t = t.replace(/#.*$/, '');
  if (t === '' || /[\s<>*?{}[\]$%|\\~=@!"'`,;…]|\.\.\./.test(t)) return null;
  if (t.startsWith('/')) return null;
  t = t.replace(/^(\.\/)+/, '');
  return t === '' || t === '.' ? null : t;
}

// Las citas de un texto markdown: [{ linea, tipo: 'enlace' | 'codigo', cita }]. Sin bloques de código; un `> Histórico` en los
// primeros 10 renglones saca el archivo entero (B §5), y más abajo, hasta el próximo título.
function citas(texto) {
  const lineas = sinBom(texto).split('\n');
  if (lineas.slice(0, 10).some((l) => RE_HISTORICO.test(l))) return [];
  const out = [];
  let enCodigo = false;
  let historico = false;
  lineas.forEach((l, i) => {
    if (RE_FENCE.test(l)) {
      enCodigo = !enCodigo;
      return;
    }
    if (enCodigo) return;
    if (RE_TITULO.test(l)) historico = false;
    if (RE_HISTORICO.test(l)) historico = true;
    if (historico) return;
    for (const m of l.matchAll(RE_LINK)) out.push({ linea: i + 1, tipo: 'enlace', cita: m[1] });
    const sinEnlaces = l.replace(RE_LINK, ' ');
    for (const m of sinEnlaces.matchAll(RE_CODIGO)) out.push({ linea: i + 1, tipo: 'codigo', cita: m[1] });
  });
  return out;
}

// Las entradas de la raíz del repo según git ls-files (en minúsculas: en Windows CLAUDE.md y claude.md son lo mismo).
function entradasRaiz(lista) {
  return new Set(lista.map((r) => r.split('/')[0].toLowerCase()));
}

// Una cita → la ruta relativa a la raíz que hay que mirar, o null si no se mira. Los enlaces son relativos al archivo que los trae;
// las rutas entre comillas invertidas, a la raíz, y solo si su primer tramo es una entrada de la raíz.
function aRuta(c, archivo, raicesRepo) {
  const t = limpiarCita(c.cita);
  if (!t) return null;
  if (c.tipo === 'codigo') {
    if (!raicesRepo.has(t.split('/')[0].toLowerCase())) return null;
    const n = path.posix.normalize(t);
    return n.startsWith('..') ? null : n.replace(/\/$/, '');
  }
  const n = path.posix.normalize(path.posix.join(path.posix.dirname(archivo), t));
  return n.startsWith('..') ? null : n.replace(/\/$/, '');
}

const existe = (raiz, rel) => fs.existsSync(path.join(raiz, ...rel.split('/')));

// Lo que el árbol del molde crea a demanda: citarlo antes de que exista no es una ruta rota. Las tres carpetas de docs/ (git no
// guarda carpetas vacías: un repo recién montado no las tiene) y el MAPA, que es opcional (B §4); frenos.log lo crean los hooks y el
// candado en la primera frenada, y .claude/cambios/ lo crea `cambios nuevo`. Lo de ADENTRO de esas carpetas se sigue exigiendo.
// aDemanda(carpeta): lo mismo en la carpeta de papeles (8r3 i1); A_DEMANDA es el de docs/.
const aDemanda = (carpeta) => new Set([...arbol.TRES.map((x) => `${carpeta}/${x}`), `${carpeta}/MAPA.md`, frenosLog.RUTA, cambiosRuta.CARPETA].map((x) => x.toLowerCase()));
const A_DEMANDA = aDemanda(docsRuta.POR_DEFECTO);

// candado:rutas — en CLAUDE.md, docs/README.md, el TODO, el handoff, las fichas de módulo y docs/referencia/**, cada ruta citada existe.
function rutas(raiz, op) {
  const carpeta = carpetaDe(raiz, op);
  const demanda = carpeta === docsRuta.POR_DEFECTO ? A_DEMANDA : aDemanda(carpeta);
  const todos = archivos(raiz);
  const raices = entradasRaiz(todos);
  const docs = todos.filter((r) => r.startsWith(`${carpeta}/`));
  const mirar = [RUTA_CLAUDE, `${carpeta}/README.md`, `${carpeta}/TODO.md`, rutaHandoff(carpeta)]
    .concat(modulos(docs, carpeta).map((x) => `${carpeta}/modulos/${x}/README.md`))
    .concat(docs.filter((r) => r.startsWith(`${carpeta}/referencia/`) && /\.md$/i.test(r)));
  const fallas = [];
  for (const archivo of mirar) {
    const b = leer(raiz, archivo);
    if (b === null || esBinario(b)) continue;
    const vistos = new Set();
    for (const c of citas(b.toString('utf8'))) {
      const r = aRuta(c, archivo, raices);
      if (r === null || vistos.has(r) || demanda.has(r.toLowerCase()) || existe(raiz, r)) continue;
      vistos.add(r);
      fallas.push({ id: 'rutas', que: `${archivo}:${c.linea} cita ${r}, que no existe`, hacer: 'corregí la ruta o sacala; si es registro, marcalo > Histórico', detalle: archivo });
    }
  }
  return fallas;
}

// ---------------------------------------------------------------- candado:topes

// revisarTopes (el handoff, las fichas activas, el MAPA y lo que inyectaría el hook); en parcial, solo el handoff.
function topes_(raiz, opciones = {}) {
  if (opciones.parcial) {
    const rh = rutaHandoff(carpetaDe(raiz, opciones));
    const h = leer(raiz, rh);
    if (h === null) return [];
    const fv = opciones.fichaVigente;
    const nivel = fv && fv.estado === 'ok' ? fv.datos.nivel : undefined;
    return topes.revisarHandoff(h, nivel).map((f) => ({ id: 'topes', ...partirMensaje(f.mensaje), detalle: rh }));
  }
  return topes.revisarTopes(raiz, { home: opciones.home, ahora: opciones.ahora }).map((f) => ({ id: 'topes', ...partirMensaje(f.mensaje), detalle: f.archivo || 'lo que inyecta el hook' }));
}

// ---------------------------------------------------------------- candado:mesa (SPEC-0 5.9; G §5.5, §7.1)

// Cada archivo de docs/modulos/*/mesa/: nombre de `mesa nuevo`, ≤ 2 KB, cabecera válida con un tipo de la mesa; ninguno
// reescrito después de commiteado o del push; ningún acuerdo firmado dos veces. La regla vive en lib/mesa.cjs.
const mesa = (raiz, op) => {
  const carpeta = carpetaDe(raiz, op);
  return mesaLib.revisar(raiz, { archivos: archivos(raiz, [`${carpeta}/modulos`]), carpeta }).map((f) => ({ id: 'mesa', ...f }));
};

// ---------------------------------------------------------------- candado:estados

const RE_ESTADO_SPEC = /^[\s>*_-]*Estado[*_]*\s*:[*_\s]*(.+)$/;
const RE_SPEC = /^SPEC(?:-(\d+))?\.md$/i;
const limpio = (s) => s.replace(/^[`*_"\s]+|[`*_"\s]+$/g, '');
const esCompleto = (s) => /^COMPLETO\b/i.test(s);

function estadoDeSpec(texto) {
  for (const l of sinBom(texto).split('\n')) {
    const m = RE_ESTADO_SPEC.exec(l);
    if (m) return limpio(m[1]);
  }
  return null;
}

// El spec más nuevo de cada módulo (SPEC.md = 1, SPEC-2.md…) contra el Estado: de su ficha; COMPLETO con `- [ ]` en la ficha → rojo.
function estados(raiz, op) {
  const carpeta = carpetaDe(raiz, op);
  const n = carpeta.split('/').length; // <carpeta>/modulos/<x>/SPEC.md: n + 3 tramos
  const lista = archivos(raiz, [`${carpeta}/modulos`]);
  const fallas = [];
  for (const x of modulos(lista, carpeta)) {
    const rel = `${carpeta}/modulos/${x}/README.md`;
    const b = leer(raiz, rel);
    if (b === null) continue; // eso lo dice candado:raiz
    const texto = b.toString('utf8');
    const est = datosFichaModulo(texto).estado;
    if (!est) continue;
    let spec = null;
    for (const r of lista) {
      const p = r.split('/');
      if (p.length !== n + 3 || p[n + 1] !== x) continue;
      const m = RE_SPEC.exec(p[n + 2]);
      if (m && (!spec || Number(m[1] || 1) > spec.n)) spec = { n: Number(m[1] || 1), rel: r };
    }
    const sb = spec ? leer(raiz, spec.rel) : null;
    const es = sb === null ? null : estadoDeSpec(sb.toString('utf8'));
    if (es && esCompleto(es) && /^EN OBRA\b/i.test(est)) {
      fallas.push({ id: 'estados', que: `${spec.rel} está COMPLETO y el módulo sigue EN OBRA`, hacer: `pasá ${rel} a COMPLETO, o abrí el spec que sigue (SPEC-${spec.n + 1}.md)`, detalle: rel });
    }
    if (esCompleto(est)) {
      if (es && !esCompleto(es)) fallas.push({ id: 'estados', que: `${rel} está COMPLETO y su spec más nuevo (${spec.rel}) no`, hacer: 'cerrá el spec (COMPLETO <fecha>) o volvé el módulo a EN OBRA', detalle: rel });
      if (sinBom(texto).split('\n').some((l) => /^\s*- \[ \]/.test(l))) {
        fallas.push({ id: 'estados', que: `${rel} está COMPLETO con tareas sin tildar`, hacer: 'tildá las tareas hechas (con su commit) o volvé el módulo a EN OBRA', detalle: rel });
      }
    }
  }
  return fallas;
}

// ---------------------------------------------------------------- candado:lecturas (solo lista, nunca frena)

// Lo de más de 100 KB que cita una skill de .claude/skills/** (relativo a la raíz o a la skill).
function lecturas(raiz) {
  const todos = archivos(raiz);
  const raices = entradasRaiz(todos);
  const out = [];
  const vistos = new Set();
  for (const skill of todos.filter((r) => r.startsWith(`${CARPETA_SKILLS}/`))) {
    const b = leer(raiz, skill);
    if (b === null || esBinario(b)) continue;
    for (const c of citas(b.toString('utf8'))) {
      const candidatas = [aRuta({ ...c, tipo: 'enlace' }, skill, raices), aRuta({ ...c, tipo: 'codigo' }, skill, raices)].filter(Boolean);
      for (const r of candidatas) {
        if (vistos.has(r)) continue;
        let st;
        try {
          st = fs.statSync(path.join(raiz, ...r.split('/')));
        } catch (e) {
          continue;
        }
        if (!st.isFile() || st.size <= LECTURA_GRANDE) continue;
        vistos.add(r);
        out.push({ id: 'lecturas', soloLista: true, que: `${r} pesa ${Math.round(st.size / 1024)} KB y lo cita ${skill}`, hacer: 'si la skill manda a leerlo entero, que lo lea por índice, grep o extracto', detalle: r });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- candado:estado-viejo

// La sección "## Próximo paso" del handoff (sin el título), o null si no está.
function proximoPaso(texto) {
  if (texto === null) return null;
  const l = sinBom(texto).split('\n');
  const i = l.findIndex((x) => /^## Próximo paso(?![\p{L}\p{N}_])/u.test(x));
  if (i < 0) return null;
  let j = i + 1;
  while (j < l.length && !/^#{1,2}\s/.test(l[j])) j++;
  return l.slice(i + 1, j).join('\n').trim();
}
const lineaEstado = (texto) => {
  if (texto === null) return null;
  const d = datosFichaModulo(texto);
  return d.iEstado < 0 ? null : sinBom(texto).split('\n')[d.iEstado].trim();
};

// Con cambios de código (fuera de docs/ y .claude/) desde la base de todo.cjs hasta el disco, "## Próximo paso" del handoff tuvo que
// cambiar en ese tramo; y un módulo con rama: igual a la rama actual, su Estado:. Sin base, verde.
function estadoViejo(raiz, op) {
  const carpeta = carpetaDe(raiz, op);
  const rh = rutaHandoff(carpeta);
  const base = git.texto(['log', '-1', '--format=%H', '--', rh], { cwd: raiz });
  if (!base) return [];
  const d = git.correr(['diff', '--no-renames', '--name-only', '-z', base], { cwd: raiz, tiempo: 20000 });
  const o = git.correr(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: raiz, tiempo: 20000 });
  if (!d.ok || !o.ok) throw new Error('git diff no anduvo');
  const cambiados = [...d.stdout.split('\0'), ...o.stdout.split('\0')].filter(Boolean);
  // Código = fuera de la carpeta de papeles y de .claude/ (con arti-docs, el docs/ de otro proyecto ES código; 8r3 i1).
  const papeles = new RegExp(`^(${escRe(carpeta)}|\\.claude)/`, 'i');
  if (!cambiados.some((r) => !papeles.test(r))) return [];
  const fallas = [];
  const hd = leer(raiz, rh);
  const ahora = hd === null ? null : hd.toString('utf8');
  if (ahora === null || proximoPaso(ahora) === proximoPaso(blob(raiz, base, rh))) {
    fallas.push({ id: 'estado-viejo', que: 'hubo cambios de código desde el último cierre y "## Próximo paso" del handoff sigue igual', hacer: 'reescribí el próximo paso con lo que sigue de verdad', detalle: rh });
  }
  const rama = contexto.rama(raiz);
  if (rama) {
    for (const x of modulos(archivos(raiz, [`${carpeta}/modulos`]), carpeta)) {
      const rel = `${carpeta}/modulos/${x}/README.md`;
      const b = leer(raiz, rel);
      if (b === null) continue;
      const t = b.toString('utf8');
      if (datosFichaModulo(t).rama !== rama) continue;
      if (lineaEstado(t) === lineaEstado(blob(raiz, base, rel))) {
        fallas.push({ id: 'estado-viejo', que: `hubo cambios de código en la rama ${rama} y el Estado: de ${rel} sigue igual`, hacer: 'actualizá el Estado: del módulo (y su próximo paso)', detalle: rel });
      }
    }
  }
  return fallas;
}

// ---------------------------------------------------------------- candado:datos (crit. 14)

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DATOS = [
  { tipo: 'una ruta absoluta', re: /(?<![A-Za-z0-9])[A-Za-z]:\\|\/[A-Za-z]\/Users\/|\/home\/|\/Users\// },
  { tipo: 'un id de sesión', re: /\blocal_[0-9a-f]{4,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { tipo: 'una rama concreta', re: /\bmodulo\/[A-Za-z0-9_]/ },
];
// Las URLs se sacan antes de mirar (una URL no es una ruta de la PC ni un SHA suelto), salvo file://, que sí es una ruta.
const RE_URL = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const RE_HEXA = /\b[0-9a-f]{7,40}\b/gi;
const esSha = (t) => /[a-f]/i.test(t) && /[0-9]/.test(t);

// En .claude/skills/** (zonas propias incluidas): cero rutas absolutas, ids de sesión, ramas concretas y SHAs fuera de una URL.
function datos(raiz) {
  const fallas = [];
  for (const rel of archivos(raiz, [CARPETA_SKILLS])) {
    const b = leer(raiz, rel);
    if (b === null || esBinario(b)) continue;
    sinBom(b.toString('utf8')).split('\n').forEach((crudo, i) => {
      const l = crudo.replace(RE_URL, ' ');
      const tipos = DATOS.filter((x) => x.re.test(l)).map((x) => x.tipo);
      if ((l.replace(RE_UUID, ' ').match(RE_HEXA) || []).some(esSha)) tipos.push('un SHA');
      for (const tipo of tipos) {
        fallas.push({ id: 'datos', que: `${rel}:${i + 1} trae ${tipo}`, hacer: 'sacalo o cambialo por un <placeholder>: las skills no llevan datos de ningún proyecto', detalle: rel });
      }
    });
  }
  return fallas;
}

// ---------------------------------------------------------------- candado:portada (P3.8; B §12bis)

// Las definiciones de enlace estilo referencia (`[norte]: ./docs/NORTE.md#ancla "título"`): citas() no las ve, y la portada puede
// enlazar así. Se miran solo acá (sumarlas a citas() ensancharía candado:rutas). Sin bloques de código.
const RE_REFERENCIA = /^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+.*)?$/;
function citasPortada(texto) {
  const out = citas(texto).filter((c) => c.tipo === 'enlace');
  let enCodigo = false;
  sinBom(texto).split('\n').forEach((l, i) => {
    if (RE_FENCE.test(l)) enCodigo = !enCodigo;
    else if (!enCodigo) {
      const m = RE_REFERENCIA.exec(l);
      if (m) out.push({ linea: i + 1, tipo: 'enlace', cita: m[1] });
    }
  });
  return out;
}

// Corre solo si la ficha tiene piezas.portada y no es `no` (r1-4: el apagado es por repo, así ningún repo viejo se pone rojo al
// actualizarse). README en la raíz (sin mirar mayúsculas, como entradasRaiz), que enlace a docs/NORTE.md (resuelto con aRuta: vale
// ./docs/NORTE.md, con ancla o estilo referencia) y que ese archivo exista (r1-10). Nada más: barato. Con `carpeta-docs:`, el
// NORTE es <carpeta>/NORTE.md (8r3 i1: el README de la raíz no se mueve).
function portada(raiz, op) {
  const RUTA_NORTE = docsRuta.rel(carpetaDe(raiz, op), 'NORTE.md');
  const todos = archivos(raiz);
  const readme = todos.find((r) => !r.includes('/') && r.toLowerCase() === 'readme.md');
  const falla = (que, hacer, detalle) => [{ id: 'portada', que, hacer, detalle }];
  if (!readme) return falla('no hay README.md en la raíz', 'armalo con `node .claude/scripts/portada.cjs armar`', 'README.md');
  const b = leer(raiz, readme);
  const raices = entradasRaiz(todos);
  const enlaza = b !== null && citasPortada(b.toString('utf8')).some((c) => {
    const r = aRuta(c, readme, raices);
    return r !== null && r.toLowerCase() === RUTA_NORTE.toLowerCase();
  });
  if (!enlaza) return falla(`${readme} no enlaza a ${RUTA_NORTE}`, 'agregá el enlace al NORTE (o rehacé la portada con `portada.cjs armar`)', readme);
  if (!existe(raiz, RUTA_NORTE)) return falla(`${readme} enlaza a ${RUTA_NORTE}, que no existe`, 'escribí el NORTE o corregí el enlace', RUTA_NORTE);
  return [];
}

// ---------------------------------------------------------------- candado:barreras

// indice / rango (P4.6): solo el índice (pre-commit) o solo los commits de un rango ya resuelto (pre-push); sin ellos, como siempre.
const barreras_ = (raiz, opciones = {}) =>
  barreras.revisarBarreras(raiz, { molde: opciones.molde, moldeViejo: opciones.moldeViejo, indice: opciones.indice, rango: opciones.rango }).map((f) => ({ ...f, id: 'barreras' }));

const CHEQUEOS = {
  raiz: raiz_,
  rutas,
  topes: topes_,
  mesa,
  estados,
  lecturas,
  'estado-viejo': estadoViejo,
  barreras: barreras_,
  datos,
  portada,
};

// ---------------------------------------------------------------- quién corre

const dos = (n) => String(n).padStart(2, '0');
const hoyLocal = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Los ids del candado quitados con hasta: vigente (siempre, o una fecha que no pasó; el día de hasta incluido). barreras no se quita.
function quitadosVigentes(datosFicha, ahora = new Date()) {
  const q = datosFicha && esMapa(datosFicha.frenos) && Array.isArray(datosFicha.frenos.quitados) ? datosFicha.frenos.quitados : [];
  const hoy = hoyLocal(ahora);
  const s = new Set();
  for (const x of q) {
    if (!esMapa(x) || typeof x.id !== 'string' || !x.id.startsWith('candado:')) continue;
    if (x.hasta === 'siempre' || (RE_FECHA.test(x.hasta) && x.hasta >= hoy)) s.add(x.id.slice('candado:'.length));
  }
  s.delete('barreras');
  return s;
}

// piezas.portada presente y distinta de `no` (texto suelto o {estado, hash}); ausente = el chequeo no corre (r1-4).
function portadaPrendida(datosFicha) {
  const p = datosFicha && esMapa(datosFicha.piezas) ? datosFicha.piezas.portada : undefined;
  const e = typeof p === 'string' ? p : esMapa(p) && typeof p.estado === 'string' ? p.estado : null;
  return e !== null && e !== 'no';
}

// piezas.candado presente y distinto de `no` (texto suelto o {estado, hash}); ausente = apagado (Cruces 8).
function prendido(datosFicha) {
  const p = datosFicha && esMapa(datosFicha.piezas) ? datosFicha.piezas.candado : undefined;
  const e = typeof p === 'string' ? p : esMapa(p) && typeof p.estado === 'string' ? p.estado : null;
  return e !== null && e !== 'no';
}

const linea = (f) => `candado:${f.id} · ${f.que} · ${f.hacer}`;

// correr(raiz, {modo: 'todo' | 'parcial' | 'ids', ids, molde, moldeViejo, indice, rango, log, ahora, home}) → { codigo, lineas, fallas, corrieron }.
// codigo: 0 verde · 1 alguna falla (lecturas no cuenta). La ficha vigente rota no da 1 sola: se avisa y corre todo con los frenos de
// fábrica (rf-9). indice (true) o rango ({desde, hasta}, de resolverRango) solo con ids = [barreras], y no los dos (P4.6).
// Tira si algo interno falla o si lo llaman mal (el script lo vuelve "candado roto").
function correr(raiz, opciones = {}) {
  const modo = opciones.modo || 'todo';
  // Los dos juntos los frena barreras.revisarBarreras.
  if ((opciones.indice || opciones.rango) && (modo !== 'ids' || (opciones.ids || []).join() !== 'barreras')) throw new Error('indice y rango van solo con barreras');
  const alcance = opciones.indice ? ' · solo el índice' : opciones.rango ? ` · el rango ${opciones.rango.desde === null ? 'nuevo ' : opciones.rango.desde.slice(0, 12)}..${opciones.rango.hasta.slice(0, 12)}` : '';
  const ahora = opciones.ahora || new Date();
  const log = opciones.log !== false;
  const anotar = (id, detalle) => {
    if (log) frenosLog.anotar(raiz, { id, herramienta: HERRAMIENTA, detalle, rol: contexto.rol(raiz), rama: contexto.rama(raiz) }, ahora);
  };

  const fv = contexto.fichaVigente(raiz);
  // rf-9: la ficha vigente rota no traba sola (si no, el commit que la arregla no puede pasar): se avisa y se corre con los frenos de
  // fábrica: ningún freno quitado. Qué corre (piezas.candado) sale de la última ficha que se lee (rf-14: si el proyecto lo tenía
  // apagado, prenderlo traba el arreglo); sin ninguna que se lea, entero. barreras compara cada commit contra la última que lee.
  const rota = fv.estado === 'rota';
  const avisos = [];
  if (rota) {
    anotar('candado:ficha', contexto.RUTA_FICHA);
    avisos.push(`ficha rota: ${fv.donde} — corré doctor (corro con los frenos de fábrica)`);
  }
  const datosFicha = fv.estado === 'ok' ? fv.datos : null;
  if (!rota && !datosFicha && !barreras.fichaEnAlgunLado(raiz, { rango: opciones.rango })) return { codigo: 0, lineas: ['sin ficha: candado apagado'], fallas: [], corrieron: [] };

  let encendido = prendido(datosFicha);
  let conPortada = portadaPrendida(datosFicha);
  if (rota) {
    const u = fv.ref ? barreras.ultimaFichaQueSeLee(raiz, fv.ref) : null;
    const previa = u ? ficha.leer(u.texto.toString('utf8')).datos : null;
    encendido = u ? prendido(previa) : true;
    conPortada = portadaPrendida(previa); // sin ficha que se lea, la portada no corre (no hay con qué saber que la tenía)
  }
  const quitados = rota ? new Set() : quitadosVigentes(datosFicha, ahora);
  const pedidos = modo === 'parcial' ? PARCIAL : modo === 'ids' ? IDS.filter((x) => (opciones.ids || []).includes(x)) : IDS;
  const corrieron = pedidos.filter((id) => id === 'barreras' || (encendido && !quitados.has(id) && (id !== 'portada' || conPortada)));
  // La carpeta de papeles de la misma ficha (rota: la última que se lee, como piezas.candado arriba; 8r3 i1, rt-10).
  const carpeta = docsRuta.deVigente(fv, raiz);
  const op = { parcial: modo === 'parcial', molde: opciones.molde, moldeViejo: opciones.moldeViejo, indice: !!opciones.indice, rango: opciones.rango, fichaVigente: fv, ahora, home: opciones.home, carpeta };
  const fallas = [];
  for (const id of corrieron) fallas.push(...CHEQUEOS[id](raiz, op));

  const frenan = fallas.filter((f) => !f.soloLista);
  for (const f of frenan) anotar(`candado:${f.id}`, f.detalle);
  const lineas = [...avisos, ...fallas.map(linea)];
  if (!frenan.length) {
    const nota = encendido ? '' : ' · candado apagado en la ficha (piezas.candado): solo barreras';
    lineas.push(corrieron.length ? `candado: en verde (${corrieron.join(', ')})${alcance}${nota}` : `candado: no corrió nada de lo pedido${nota}`);
  }
  return { codigo: frenan.length ? 1 : 0, lineas, fallas, corrieron };
}

module.exports = {
  IDS,
  PARCIAL,
  HERRAMIENTA,
  CHEQUEOS,
  citas,
  limpiarCita,
  quitadosVigentes,
  prendido,
  portadaPrendida,
  correr,
  resolverRango: barreras.resolverRango,
};
