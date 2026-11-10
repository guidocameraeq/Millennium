'use strict';
// escritura-docs.cjs — el hook de escritura en docs/ del molde v3 (SPEC-paquete-2 P4.2; B §7, §14 regla 1). Node directo.
// PreToolUse sobre Write: juzga SOLO la ruta (tool_input.file_path) con lib/arbol.cjs contra la raíz del checkout del cwd de la
// entrada. Suelto en la raíz de docs/ (que no es de los seis) o carpeta que no es de las tres → deny con el mensaje de B §7 y un
// renglón en .claude/frenos.log (candado:raiz · Write). Lo demás pasa sin salida. "docs/" es la carpeta de papeles: la
// `carpeta-docs:` de la ficha vigente si la hay (8r3 i1: con arti-docs, el docs/ de otro proyecto pasa y arti-docs/suelto.md frena).
// Prendido si la ficha vigente (regla de 4.7) tiene piezas.hook-escritura distinto de `no`; sin ficha o sin la pieza, apagado.
// candado:raiz quitado con hasta: vigente → pasa. Ficha rota → frena igual y suma "corré doctor".
// SI EL HOOK FALLA, DEJA PASAR (salida 0, sin JSON): no está en la lista de 4.7; su red es el candado del cierre (B §7).
// Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');

const HERRAMIENTA = 'Write';
const PIEZA = 'hook-escritura';
const DOCTOR = 'corré doctor';

function leerEntrada() {
  const t = fs.readFileSync(0, 'utf8');
  const e = t.trim() ? JSON.parse(t) : {};
  return e && typeof e === 'object' && !Array.isArray(e) ? e : {};
}

// ¿La ruta tiene los segmentos de `carpeta` seguidos ("docs" sin ella)? (sin distinguir mayúsculas; Windows ignora puntos y
// espacios del final, como arbol.cjs). Atajo antes de git: sin esos segmentos, juzgarRuta jamás frena (lo relativo a la raíz sale
// de la misma ruta), y se ahorra el git de ~150 ms en cada Write de la sesión.
function nombraDocs(ruta, carpeta = 'docs') {
  const c = String(carpeta).split('/');
  const s = String(ruta)
    .split(/[\\/]+/)
    .map((x) => x.replace(/[. ]+$/, '').toLowerCase());
  for (let i = 0; i + c.length <= s.length; i++) if (c.every((x, k) => s[i + k] === x)) return true;
  return false;
}

// La raíz por el disco (la primera carpeta hacia arriba con un `.git`), sin git: para la pista de la carpeta antes del atajo.
function raizPorDisco(cwd) {
  const path = require('path');
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

// 8r3 i1: las carpetas que el atajo deja pasar a git: `docs` y la `carpeta-docs:` del .claude/kit.md del disco (una pista barata;
// la que juzga es la de la ficha vigente, de git). Una vigente que no está en el disco se le escapa al hook: su red es el candado.
function candidatas(cwd) {
  const out = ['docs'];
  try {
    const raiz = raizPorDisco(cwd);
    const c = raiz ? require('./lib/arbol.cjs').carpetaDelDisco(raiz) : null;
    if (c && c !== 'docs') out.push(c);
  } catch (e) {
    /* sin pista: docs */
  }
  return out;
}

// La fecha de hoy, local, AAAA-MM-DD: la misma forma que hasta:, así se comparan como texto.
const dos = (n) => String(n).padStart(2, '0');
const hoyLocal = (ahora) => `${ahora.getFullYear()}-${dos(ahora.getMonth() + 1)}-${dos(ahora.getDate())}`;

// ¿candado:raiz está quitado y vigente? hasta: siempre, o una fecha que todavía no pasó (el día de hasta: incluido).
// Solo se compara lo que tiene forma de fecha: como texto, "siempre" o cualquier palabra quedaría "después" de 2026.
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
function quitadoVigente(datos, ahora = new Date()) {
  const quitados = datos && datos.frenos && Array.isArray(datos.frenos.quitados) ? datos.frenos.quitados : [];
  const hoy = hoyLocal(ahora);
  return quitados.some((q) => q && q.id === 'candado:raiz' && (q.hasta === 'siempre' || (RE_FECHA.test(q.hasta) && q.hasta >= hoy)));
}

// El estado de la pieza: texto suelto o {estado, hash}. null si no está.
function estadoPieza(datos) {
  const p = datos && datos.piezas ? datos.piezas[PIEZA] : undefined;
  if (p == null) return null;
  if (typeof p === 'string') return p;
  return typeof p === 'object' && typeof p.estado === 'string' ? p.estado : null;
}

// La salida de PreToolUse que niega (doc oficial de hooks: hookSpecificOutput, exit 0, JSON solo en stdout).
function negar(motivo) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: motivo,
    },
  };
}

// decidir(entrada, {ahora, anotar}) → { decision: 'pasa', porque } · { decision: 'frena', salida, juicio, renglon }.
// Tira solo si algo se rompe adentro: el que llama lo traduce a "pasa".
function decidir(entrada, opciones = {}) {
  const ahora = opciones.ahora || new Date();
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  if (typeof e.tool_name === 'string' && e.tool_name !== HERRAMIENTA) return { decision: 'pasa', porque: 'otra herramienta' };
  const ruta = e.tool_input && e.tool_input.file_path;
  if (typeof ruta !== 'string' || ruta.trim() === '') return { decision: 'pasa', porque: 'sin ruta' };
  const contexto = require('./lib/contexto.cjs');
  const cwd = contexto.cwdDe(e);
  if (!candidatas(cwd).some((c) => nombraDocs(ruta, c))) return { decision: 'pasa', porque: 'fuera de docs' };

  const arbol = require('./lib/arbol.cjs');
  const g = contexto.datosGit(cwd);
  if (!g) return { decision: 'pasa', porque: 'sin git' };
  // La ficha (cuesta varios git) recién con una ruta que nombra los papeles: su carpeta-docs: decide qué se juzga (8r3 i1).
  const ficha = contexto.fichaVigente(g.raiz);
  const juicio = arbol.juzgarRuta(g.raiz, ruta, require('./lib/docs-ruta.cjs').deVigente(ficha, g.raiz));
  if (!juicio) return { decision: 'pasa', porque: 'ruta en orden' };

  let motivo = juicio.mensaje;
  if (ficha.estado === 'sin-ficha') return { decision: 'pasa', porque: 'sin ficha' };
  if (ficha.estado === 'rota') motivo += ` — ficha rota: ${ficha.donde} — ${DOCTOR}`;
  else {
    const estado = estadoPieza(ficha.datos);
    if (estado === null || estado === 'no') return { decision: 'pasa', porque: 'pieza apagada' };
    if (quitadoVigente(ficha.datos, ahora)) return { decision: 'pasa', porque: 'quitado vigente' };
  }

  // El renglón es rastro: si no se puede escribir, el freno vale igual.
  let renglon = null;
  try {
    const frenosLog = require('./lib/frenos-log.cjs');
    const anotar = opciones.anotar || frenosLog.anotar;
    renglon = anotar(
      g.raiz,
      { id: juicio.id, herramienta: HERRAMIENTA, detalle: juicio.ruta, rol: contexto.rol(g.raiz), rama: contexto.rama(g.raiz) },
      ahora,
    );
  } catch (err) {
    /* sin registro: el freno sigue */
  }
  return { decision: 'frena', salida: negar(motivo), juicio, renglon };
}

function principal() {
  let r;
  try {
    r = decidir(leerEntrada());
  } catch (e) {
    return; // falla → deja pasar
  }
  if (r.decision === 'frena') process.stdout.write(JSON.stringify(r.salida) + '\n');
}

if (require.main === module) {
  try {
    principal();
  } catch (e) {
    /* jamás tira */
  }
  process.exitCode = 0;
} else {
  module.exports = { HERRAMIENTA, PIEZA, nombraDocs, candidatas, hoyLocal, quitadoVigente, estadoPieza, negar, decidir };
}
