'use strict';
// mesa.cjs — la lógica de la mesa entre directores de dos proyectos (SPEC-0 5.9, crit. 13 del kit; G §5-§9, §12, §19): el formato
// del mensaje (cabecera, tope, nombre), la lectura de los mensajes de los dos repos por git (nunca por el disco), lo abierto, lo
// acordado (una sola firma: G §7.1), la huella de un conjunto (G §8.3) y `candado:mesa`. Vive en hooks/lib/ porque decide un freno
// (r4-3). La usan scripts/mesa.cjs, candado.cjs (candado:mesa) y scripts/encargo.cjs (`mensaje` con un tipo de mesa).
// El otro repo es el remoto de git que se llama como su alias (`git remote add <alias> <url>`; la URL vive en el MAPA, B §12).
// El vocabulario es la tabla de encargo.cjs (una sola, dos columnas: G §6.1); acá se usa la columna `mesa`.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const git = require('./git.cjs');
const E = require('./encargo.cjs');
const topes = require('./topes.cjs');
const ficha = require('./ficha.cjs');
const docsRuta = require('./docs-ruta.cjs');

const TIPOS = E.VOCABULARIO.filter((v) => v.mesa).map((v) => v.tipo); // HECHO PEDIDO RESPUESTA PROPUESTA ALERTA PRESENTACION
const ESPERAN = ['PEDIDO', 'PROPUESTA', 'ALERTA']; // los que esperan una RESPUESTA (HECHO informa; PRESENTACION también)
const TOPE = topes.MESA_BYTES; // ≤ 2 KB (G §5.5): el mismo número que topes
const TRABADO_MS = 2 * 24 * 60 * 60 * 1000; // G §9.2: "trabado por mesa" a los 2 días
const ROLES = ['director', 'sesion']; // G §12.3: <alias>/director o <alias>/sesion (una sesión plana)
const CLAVES = ['tipo', 'de', 'para', 'tema', 'responde-a', 'resultado', 'hechos'];
const T_GIT = 60000;
const T_FETCH = 60000;

const ALIAS = '[a-z0-9]+(?:-[a-z0-9]+)*';
const RE_ALIAS = new RegExp(`^${ALIAS}$`);
const RE_DIRECCION = new RegExp(`^(${ALIAS})/(${ROLES.join('|')})$`);
// 8r3 i1: el árbol del método vive en la carpeta de papeles (docs, o la `carpeta-docs:` de la ficha). Lo MÍO se arma con la mía
// (docs-ruta, de la ficha vigente); lo del OTRO repo, con la de su ficha en esa ref (carpetaEn): cada repo tiene la suya.
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rutaMesa = (patron) => new RegExp(`^${patron}/modulos/(${ALIAS})/mesa/(${ALIAS})/(\\d{4}-\\d{2}-\\d{2})-(\\d+)-([A-Z]+)\\.md$`);
const reRuta = (carpeta) => rutaMesa(escRe(carpeta));
const RE_RUTA = reRuta('docs');
// Una cita apunta al repo de <alias>, que puede tener otra carpeta: la forma de cualquier carpeta-docs (minúsculas, cifras, . _ -, con
// /) seguida de /modulos/. La carpeta exacta la comprueba citaEnRepo contra la ficha de ese commit.
const CARPETA_CUALQUIERA = '[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*';
const RE_CITA = new RegExp(`^(${ALIAS}):(${CARPETA_CUALQUIERA}/modulos/[^\\s@]+\\.md)@([0-9a-f]{7,40})$`);
const RE_RUTA_CUALQUIERA = rutaMesa(CARPETA_CUALQUIERA);
const RE_HECHO = new RegExp(`^${ALIAS}:[^\\s@]+@[0-9a-f]{7,40}$`);
const RE_RESULTADO = new RegExp(`^(aceptado|rechazado \\S.*|devuelto \\S.*|hecho ${ALIAS}:[0-9a-f]{7,40})$`);
const esRutaMesa = (rel, carpeta = 'docs') => new RegExp(`^${escRe(carpeta)}/modulos/[^/]+/mesa/`).test(rel);

const sinBom = (t) => String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const dos = (n) => String(n).padStart(2, '0');
const dia = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;

// ---------------------------------------------------------------- el mensaje (G §5.3)

// leerCabecera(texto) → { campos: { clave: valor }, hechos: [..], repetidas: [..], desconocidas: [..] }. La cabecera son los
// renglones `clave: valor` de arriba; termina en el primer renglón que no lo es (un renglón en blanco, la prosa).
function leerCabecera(texto) {
  const campos = {};
  const hechos = [];
  const repetidas = [];
  const desconocidas = [];
  for (const l of sinBom(texto).split('\n')) {
    const m = /^([a-z][a-z-]*):[ \t]*(.*?)[ \t]*$/.exec(l);
    if (!m) break;
    const [, k, v] = m;
    if (!CLAVES.includes(k)) desconocidas.push(k);
    else if (k === 'hechos') hechos.push(v);
    else if (k in campos) repetidas.push(k);
    else campos[k] = v;
  }
  return { campos, hechos, repetidas, desconocidas };
}

const tipoMesa = (t) => {
  const s = E.sinTilde(String(t || '').trim());
  return TIPOS.includes(s) ? s : null;
};
const parsearCita = (t) => {
  const m = RE_CITA.exec(String(t || '').trim());
  return m ? { alias: m[1], ruta: m[2], sha: m[3] } : null;
};

// validar(texto, { ruta, bytes }) → [{ que, hacer }]: lo que candado:mesa frena y `mesa nuevo` no deja escribir. El tope se cuenta
// sin los \r (RF-fix 4): con core.autocrlf=true el mismo mensaje sale con CRLF y crecía en otra PC hasta pasar los 2000 B.
// `carpeta`: la carpeta de papeles del repo donde vive `ruta` (8r3 i1): con ella, la ruta tiene que estar ahí (revisar y mensajesDe
// la pasan); sin ella, vale el nombre de la mesa en la forma de cualquier `carpeta-docs:` (la ruta la arma `mesa nuevo` con la suya).
function validar(texto, { ruta = null, bytes = null, carpeta = null } = {}) {
  const f = [];
  const mal = (que, hacer) => f.push({ que, hacer });
  const n = bytes === null ? Buffer.byteLength(String(texto).replace(/\r/g, ''), 'utf8') : bytes;
  if (n > TOPE) mal(`pesa ${n} B (el tope es ${TOPE})`, 'pasá el detalle a un documento del módulo (planes/ o el spec) y citalo');
  const c = leerCabecera(texto);
  for (const k of c.desconocidas) mal(`la cabecera trae "${k}:", que no es de la mesa`, `usá solo ${CLAVES.join(', ')}`);
  for (const k of c.repetidas) mal(`la cabecera trae "${k}:" dos veces`, 'dejá uno');
  const tipo = tipoMesa(c.campos.tipo);
  if (!tipo) mal(`tipo "${c.campos.tipo || ''}" no es de la mesa`, `usá uno de ${TIPOS.join(', ')}`);
  for (const k of ['de', 'para']) {
    if (!RE_DIRECCION.test(c.campos[k] || '')) mal(`"${k}:" no es <alias>/<rol> ("${c.campos[k] || ''}")`, `escribí <alias>/${ROLES.join(' o <alias>/')}`);
  }
  if (!c.campos.tema) mal('falta "tema:"', 'una línea con el tema');
  if (tipo === 'RESPUESTA') {
    if (!parsearCita(c.campos['responde-a'])) mal('la RESPUESTA no trae "responde-a: <alias>:<ruta>@<sha>"', 'citá el mensaje que contesta');
    if (!RE_RESULTADO.test(c.campos.resultado || '')) mal(`"resultado:" no vale ("${c.campos.resultado || ''}")`, 'aceptado · rechazado <razón> · devuelto <razón> · hecho <alias>:<sha>');
  } else {
    if ('resultado' in c.campos) mal('"resultado:" va solo en una RESPUESTA', 'sacalo, o mandá una RESPUESTA');
    if ('responde-a' in c.campos && !parsearCita(c.campos['responde-a'])) mal('"responde-a:" no es <alias>:<ruta>@<sha>', 'corregí la cita');
  }
  for (const h of c.hechos) if (!RE_HECHO.test(h)) mal(`el hecho "${h}" no es <alias>:<archivo>[:<línea>]@<sha>`, 'un hecho sin cita no es un hecho: citalo');
  if (ruta !== null) {
    const m = (carpeta ? reRuta(carpeta) : RE_RUTA_CUALQUIERA).exec(ruta);
    if (!m) mal(`${ruta} no tiene el nombre de la mesa`, `lo nombra \`mesa nuevo\`: ${carpeta || 'docs'}/modulos/<x>/mesa/<alias>/<fecha>-<n>-<TIPO>.md`);
    else {
      if (tipo && m[5] !== tipo) mal(`el nombre dice ${m[5]} y la cabecera ${tipo}`, 'un mensaje no cambia de tipo: escribí otro');
      const para = RE_DIRECCION.exec(c.campos.para || '');
      if (para && para[1] !== m[2]) mal(`está en mesa/${m[2]}/ y es para ${para[1]}`, 'la carpeta es el alias del destinatario');
    }
  }
  return f;
}

// armar({ tipo, de, para, cuerpo }) → el texto del mensaje: la cabecera que pone el script y, abajo, lo que trajo --archivo.
function armar({ tipo, de, para, cuerpo }) {
  const c = sinBom(cuerpo).replace(/^\n+/, '');
  return `tipo: ${tipo}\nde: ${de}\npara: ${para}\n${c.endsWith('\n') || c === '' ? c : `${c}\n`}`;
}

// ---------------------------------------------------------------- los mensajes, por git (G §5.6)

const G = (cwd, args, tiempo = T_GIT) => git.correr(args, { cwd, tiempo });

// Los remotos que son otro proyecto: todos menos origin, con nombre de alias.
function remotosAlias(cwd) {
  const r = G(cwd, ['remote']);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'origin' && RE_ALIAS.test(s)) : [];
}

// traer(cwd, remotos) → avisos: un `git fetch --prune` por remoto; el que falla se dice y se sigue con lo que hay.
function traer(cwd, remotos) {
  const avisos = [];
  for (const r of remotos) {
    const f = G(cwd, ['fetch', '--prune', '--quiet', r], T_FETCH);
    if (!f.ok) avisos.push(`no pude traer ${r} (${f.error || (f.stderr.trim().split('\n').pop() || 'git fetch falló')}): NO VERIFICADO, muestro lo que ya estaba`);
  }
  return avisos;
}

// Las refs de un lado: lo mío (ramas locales y origin/*) o lo de un alias (<alias>/*).
function refsDe(cwd, lado) {
  const donde = lado === null ? ['refs/heads', 'refs/remotes/origin'] : [`refs/remotes/${lado}`];
  const r = G(cwd, ['for-each-ref', '--format=%(refname)', ...donde]);
  return r.ok ? r.stdout.split('\n').filter((s) => s && !/\/HEAD$/.test(s)) : [];
}

// mensajesDe(cwd, lado) → [{ lado, ruta, sha, fecha (Date), cab, tipo, de, para, clave }]: cada mensaje de mesa una vez (la primera
// ref que lo trae), con el commit que lo agregó. Los que no pasan validar() se saltean (los frena el candado de su repo).
// carpetaEn(cwd, ref) → la carpeta de papeles de la ficha que trae ese commit (docs sin ficha, sin la clave o rota): la del otro repo.
function carpetaEn(cwd, ref) {
  const r = G(cwd, ['cat-file', 'blob', `${ref}:.claude/kit.md`]);
  if (!r.ok) return docsRuta.POR_DEFECTO;
  try {
    return docsRuta.deDatos(ficha.leer(r.salida.toString('utf8')).datos);
  } catch (e) {
    return docsRuta.POR_DEFECTO;
  }
}

function mensajesDe(cwd, lado) {
  const out = [];
  const vistos = new Set();
  const mia = lado === null ? docsRuta.deRaiz(cwd) : null;
  for (const ref of refsDe(cwd, lado)) {
    const carpeta = mia || carpetaEn(cwd, ref);
    const re = reRuta(carpeta);
    const ls = G(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', `${carpeta}/modulos`]);
    if (!ls.ok) continue;
    for (const ruta of ls.stdout.split('\0').filter((s) => re.test(s))) {
      if (vistos.has(ruta)) continue;
      vistos.add(ruta);
      const b = G(cwd, ['cat-file', 'blob', `${ref}:${ruta}`]);
      if (!b.ok) continue;
      const texto = b.salida.toString('utf8');
      if (validar(texto, { ruta, bytes: b.salida.length, carpeta }).length) continue;
      const lg = G(cwd, ['log', '-1', '--format=%H %ct', '--diff-filter=A', ref, '--', ruta]);
      const [sha, ct] = lg.ok ? lg.stdout.trim().split(' ') : [];
      if (!sha) continue;
      const cab = leerCabecera(texto).campos;
      const de = RE_DIRECCION.exec(cab.de);
      out.push({ lado, ruta, sha, fecha: new Date(Number(ct) * 1000), cab, tipo: tipoMesa(cab.tipo), de: cab.de, para: cab.para, clave: `${de[1]}:${ruta}` });
    }
  }
  return out;
}

// todos(cwd) → los mensajes de mi repo y de cada remoto alias (sin fetch: eso es traer()).
function todos(cwd) {
  let out = mensajesDe(cwd, null);
  for (const a of remotosAlias(cwd)) out = out.concat(mensajesDe(cwd, a));
  return out;
}

const claveDeCita = (t) => {
  const c = parsearCita(t);
  return c ? `${c.alias}:${c.ruta}` : null;
};
const cita = (m) => `${m.clave}@${m.sha.slice(0, 12)}`;

// estado(mensajes) → { abiertos, acordados, respuestasA: Map(clave → [RESPUESTA…]) }. Un PEDIDO/PROPUESTA/ALERTA está abierto
// mientras ninguna RESPUESTA lo cite; una PROPUESTA está acordada cuando una RESPUESTA la cita con `aceptado` (G §5.3). Nadie
// escribe el estado: se calcula.
function estado(mensajes) {
  const respuestasA = new Map();
  for (const m of mensajes) {
    if (m.tipo !== 'RESPUESTA') continue;
    const k = claveDeCita(m.cab['responde-a']);
    if (!respuestasA.has(k)) respuestasA.set(k, []);
    respuestasA.get(k).push(m);
  }
  const porFecha = (a, b) => a.fecha - b.fecha || a.clave.localeCompare(b.clave);
  const abiertos = mensajes.filter((m) => ESPERAN.includes(m.tipo) && !respuestasA.has(m.clave)).sort(porFecha);
  const acordados = [];
  for (const m of mensajes.filter((x) => x.tipo === 'PROPUESTA').sort(porFecha)) {
    const si = (respuestasA.get(m.clave) || []).filter((r) => r.cab.resultado === 'aceptado').sort(porFecha);
    if (si.length) acordados.push({ propuesta: m, firma: si[0], firmas: si.length });
  }
  return { abiertos, acordados, respuestasA };
}

const diasDesde = (fecha, ahora) => Math.floor((ahora - fecha) / (24 * 60 * 60 * 1000));

// lineaAbierto(m, ahora) → "esperás · PEDIDO · a/director → b/director · <tema> · <cita> · esperando desde <día> (<n> días)[ · trabado por mesa]".
function lineaAbierto(m, ahora) {
  const quien = m.lado === null ? 'esperás' : 'te toca';
  const n = diasDesde(m.fecha, ahora);
  const trabado = ahora - m.fecha >= TRABADO_MS ? ' · trabado por mesa' : '';
  return `${quien} · ${m.tipo} · ${m.de} → ${m.para} · ${m.cab.tema} · ${cita(m)} · esperando desde ${dia(m.fecha)} (${n} día${n === 1 ? '' : 's'})${trabado}`;
}

// lineaAcordado(a) → "- <día> · <tema> · <de> ↔ <quien firmó> · <cita de la PROPUESTA> · aceptado en <cita de la RESPUESTA>".
function lineaAcordado(a) {
  const doble = a.firmas > 1 ? ` · ⚠️ firmado ${a.firmas} veces (vale la primera)` : '';
  return `- ${dia(a.firma.fecha)} · ${a.propuesta.cab.tema} · ${a.propuesta.de} ↔ ${a.firma.de} · ${cita(a.propuesta)} · aceptado en ${cita(a.firma)}${doble}`;
}

// hilo(mensajes, id) → los mensajes del hilo (la raíz y las RESPUESTAs que la citan, de a una vuelta por vez), o null. `id`: la
// clave (<alias>:<ruta>), la ruta o el nombre del archivo (con o sin .md).
function hilo(mensajes, id) {
  const t = String(id).replace(/\.md$/, '');
  const raiz = mensajes.find((m) => m.clave === id || m.ruta === id || path.posix.basename(m.ruta, '.md') === t);
  if (!raiz) return null;
  const out = [raiz];
  for (let i = 0; i < out.length; i++) {
    for (const m of mensajes) if (m.tipo === 'RESPUESTA' && claveDeCita(m.cab['responde-a']) === out[i].clave && !out.includes(m)) out.push(m);
  }
  return out.sort((a, b) => a.fecha - b.fecha);
}

// citaEnRepo(cwd, alias, ruta, sha) → { ok, sha12 } · { ok: false, por }: el archivo de mesa del aviso está commiteado en ese SHA
// y el SHA lo trae el remoto <alias> (o es de este repo). Es lo que hace que un mensaje de mesa deje de ser solo un dato.
// La carpeta es la de la ficha de ESE commit (el repo de <alias> puede tener otra: 8r3 i1).
function citaEnRepo(cwd, alias, ruta, sha) {
  if (!RE_RUTA_CUALQUIERA.test(ruta)) return { ok: false, por: `${ruta} no es un archivo de mesa` };
  const c = G(cwd, ['rev-parse', '--verify', '-q', `${sha}^{commit}`]);
  if (!c.ok) return { ok: false, por: `@${sha} no está en este repo: traelo (git fetch ${alias}) o pedí el aviso de nuevo` };
  const completo = c.stdout.trim();
  if (!reRuta(carpetaEn(cwd, completo)).test(ruta)) return { ok: false, por: `${ruta} no es un archivo de mesa` };
  const t = G(cwd, ['cat-file', '-t', `${completo}:${ruta}`]);
  if (!t.ok || t.stdout.trim() !== 'blob') return { ok: false, por: `@${sha.slice(0, 12)} no contiene ${ruta}` };
  const b = G(cwd, ['cat-file', 'blob', `${completo}:${ruta}`]);
  const tipo = b.ok ? tipoMesa(leerCabecera(b.salida.toString('utf8')).campos.tipo) : null;
  if (!tipo) return { ok: false, por: `${ruta} no tiene una cabecera de mesa` };
  return { ok: true, sha12: completo.slice(0, 12), tipo };
}

// ---------------------------------------------------------------- la huella (G §8.3: solo si hay copia)

// El hash de un conjunto: sha256 de "<ruta relativa>\0<sha256 del contenido con LF>\n" ordenado; los primeros 16.
function hashConjunto(entradas) {
  const h = crypto.createHash('sha256');
  for (const [rel, buf] of [...entradas].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const c = crypto.createHash('sha256').update(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');
    h.update(`${rel}\0${c}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

// huellaEnRef(cwd, sha, carpeta) → { ok, hash, n } · { ok: false, por }: el conjunto de la carpeta en ese commit.
function huellaEnRef(cwd, sha, carpeta) {
  const dir = carpeta.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const ls = G(cwd, ['ls-tree', '-r', '-z', '--name-only', sha, '--', `${dir}/`]);
  if (!ls.ok) return { ok: false, por: `@${sha} no es un commit de este repo (traelo con git fetch)` };
  const rutas = ls.stdout.split('\0').filter(Boolean);
  if (!rutas.length) return { ok: false, por: `${dir}/ no tiene archivos en @${sha}` };
  const entradas = [];
  for (const r of rutas) {
    const b = G(cwd, ['cat-file', 'blob', `${sha}:${r}`]);
    if (!b.ok) return { ok: false, por: `no pude leer ${r} en @${sha}` };
    entradas.push([r.slice(dir.length + 1), b.salida]);
  }
  return { ok: true, hash: hashConjunto(entradas), n: entradas.length };
}

// huellaEnCarpeta(dir) → { ok, hash, n } · { ok: false, por }: la copia en el disco, con la misma cuenta.
function huellaEnCarpeta(dir) {
  const entradas = [];
  const andar = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) andar(path.join(abs, e.name), r);
      else if (e.isFile()) entradas.push([r, fs.readFileSync(path.join(abs, e.name))]);
    }
  };
  try {
    andar(dir, '');
  } catch (e) {
    return { ok: false, por: `no pude leer la copia ${dir}` };
  }
  if (!entradas.length) return { ok: false, por: `la copia ${dir} está vacía` };
  return { ok: true, hash: hashConjunto(entradas), n: entradas.length };
}

// ---------------------------------------------------------------- candado:mesa

// revisar(raiz, { archivos, carpeta }) → [{ que, hacer, detalle }]. En cada archivo de <carpeta>/modulos/*/mesa/ (git ls-files: commiteado o
// nuevo): el nombre, el tope y la cabecera (validar); que no se haya reescrito ni borrado después de commiteado (contra HEAD) ni
// reescrito después del push (contra toda versión que tenga origin); y que ninguna PROPUESTA quede firmada dos veces en este repo.
function revisar(raiz, { archivos, carpeta = docsRuta.deRaiz(raiz) }) {
  const esMia = (rel) => esRutaMesa(rel, carpeta);
  const fallas = [];
  const add = (detalle, que, hacer) => fallas.push({ que, hacer, detalle });
  const lista = archivos.filter(esMia);
  const firmas = new Map();
  for (const rel of lista) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(raiz, ...rel.split('/')));
    } catch (e) {
      buf = null;
    }
    if (buf === null) continue; // borrado: lo dice el chequeo de abajo
    const texto = buf.toString('utf8');
    const sinCR = buf.length - buf.reduce((k, b) => k + (b === 0x0d ? 1 : 0), 0); // los bytes sin \r (RF-fix 4)
    for (const f of validar(texto, { ruta: rel, bytes: sinCR, carpeta })) add(rel, `${rel}: ${f.que}`, f.hacer);
    const c = leerCabecera(texto).campos;
    if (tipoMesa(c.tipo) === 'RESPUESTA' && c.resultado === 'aceptado') {
      const k = claveDeCita(c['responde-a']);
      if (k) firmas.set(k, (firmas.get(k) || []).concat(rel));
    }
  }
  for (const [k, rs] of firmas) {
    if (rs.length > 1) add(rs[1], `${k} está aceptado ${rs.length} veces (${rs.join(', ')})`, 'un acuerdo se firma una sola vez (G §7.1): borrá la firma de más antes de commitearla');
  }
  // Después de commiteado: lo del disco o del índice distinto de HEAD (o borrado).
  const st = G(raiz, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=no', '--', `${carpeta}/modulos`]);
  if (!st.ok) throw new Error('git status no anduvo');
  const reescritos = new Set();
  for (const e of st.stdout.split('\0').filter(Boolean)) {
    const rel = e.slice(3);
    if (!esMia(rel)) continue;
    reescritos.add(rel);
    add(rel, `${rel} cambió después de commiteado`, 'un mensaje de mesa no se edita nunca: volvelo atrás (git checkout -- <ruta>) y mandá otro mensaje');
  }
  // Después del push: lo de HEAD distinto de toda versión que tenga origin (los remotos alias son el repo del otro: no cuentan).
  const subidos = new Map();
  for (const ref of G(raiz, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).stdout.split('\n').filter((s) => s && !/\/HEAD$/.test(s))) {
    const ls = G(raiz, ['ls-tree', '-r', '-z', ref, '--', `${carpeta}/modulos`]);
    if (!ls.ok) continue;
    for (const e of ls.stdout.split('\0').filter(Boolean)) {
      const m = /^\S+ blob (\S+)\t(.*)$/s.exec(e);
      if (!m || !esMia(m[2])) continue;
      if (!subidos.has(m[2])) subidos.set(m[2], new Set());
      subidos.get(m[2]).add(m[1]);
    }
  }
  const head = G(raiz, ['ls-tree', '-r', '-z', 'HEAD', '--', `${carpeta}/modulos`]);
  const enHead = new Map();
  if (head.ok) {
    for (const e of head.stdout.split('\0').filter(Boolean)) {
      const m = /^\S+ blob (\S+)\t(.*)$/s.exec(e);
      if (m && esMia(m[2])) enHead.set(m[2], m[1]);
    }
  }
  for (const [rel, blobs] of subidos) {
    if (reescritos.has(rel) || !enHead.has(rel) || blobs.has(enHead.get(rel))) continue;
    add(rel, `${rel} se reescribió después del push`, 'un mensaje de mesa no se edita nunca: volvé el archivo a lo subido y mandá otro mensaje');
  }
  return fallas;
}

module.exports = {
  TIPOS, ESPERAN, TOPE, TRABADO_MS, ROLES, CLAVES, RE_ALIAS, RE_DIRECCION, RE_RUTA, RE_CITA, RE_RUTA_CUALQUIERA, reRuta, carpetaEn,
  esRutaMesa, leerCabecera, tipoMesa, parsearCita, validar, armar, remotosAlias, traer, refsDe, mensajesDe, todos, estado, hilo,
  lineaAbierto, lineaAcordado, citaEnRepo, hashConjunto, huellaEnRef, huellaEnCarpeta, revisar, dia,
};
