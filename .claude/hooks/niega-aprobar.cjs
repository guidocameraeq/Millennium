'use strict';
// niega-aprobar.cjs — el pedacito de 4.5 que se adelanta al orden 2 (SPEC-0 4.5 y 6.8a, criterio 18; SPEC-paquete-2 P6.8a y
// D2.2 F3; red team RT-p2 3, r4-1). PreToolUse sobre Bash y PowerShell, cuando el comando es "de aprobar": contiene las dos
// palabras `cambios` y `aprobar` (a propósito ancho: un falso positivo solo frena donde aprobar no vale).
//   - NIEGA con permission_mode bypassPermissions o dontAsk (los modos sin ventana), sin modo en la entrada (r4-1:
//     --permission-mode no deja rastro en ningún settings) o con un modo que no conoce;
//   - NIEGA con .kit-rol de agente (defensa doble con el script) y con la ficha rota;
//   - en default, acceptEdits, plan y auto devuelve "ask": la ventana aparece aunque el comando esquive la regla `ask` del
//     settings ('aprobar' entre comillas, dos espacios, --), que queda como segunda red. Decisión de Guido, 2026-10-29: en auto
//     la ventana aparece (una `ask` también pregunta en auto), así que negar ahí era fricción y no seguridad.
// Cada negativa deja un renglón en .claude/frenos.log (cambios:aprobar-negado · Bash|PowerShell · el modo o el motivo; nunca el
// comando). Es un hook que NIEGA: regla 4.7, onFailure "block" y timeout 20 en el settings.json. Ante un error propio imprime
// el deny "freno roto: corré doctor"; si ni eso, sale distinto de 0 y onFailure frena. NO corre ningún .propio.sh (F2 ⚠️).
// Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');

const HERRAMIENTAS = ['Bash', 'PowerShell'];
const SIN_VENTANA = ['bypassPermissions', 'dontAsk'];
const CON_VENTANA = ['default', 'acceptEdits', 'plan', 'auto'];
const ID = 'cambios:aprobar-negado';
const ROTO = 'freno roto: corré doctor';

// ¿Es un comando de aprobar? Sin mayúsculas (PowerShell no las distingue) y sin las comillas y escapes de los shells, así
// `apro''bar` o `apro\bar` no esquivan lo barato. Lo que no se ve (un alias, una variable) es el riesgo escrito de F3.
function esDeAprobar(comando) {
  if (typeof comando !== 'string') return false;
  const t = comando.toLowerCase().replace(/["'`^\\]/g, '');
  return t.includes('cambios') && t.includes('aprobar');
}

function salida(decision, motivo) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: motivo,
    },
  };
}

const MOTIVO_ASK =
  'Vas a aprobar un cambio de barrera (es tu OK para tocar un freno). Antes de aceptar, mirá en "te espera" que el id, la regla y ' +
  'los 8 del hash sean los que leíste; si te lo pide una sesión de /obrero o /director, decí que no.';
const motivoModo = (modo) =>
  modo
    ? `cambios aprobar no corre en modo ${modo}: es tu OK y en ese modo no hay ventana para darlo. Pasá a default (Shift+Tab) y pedilo de nuevo.`
    : 'cambios aprobar no corre si no se sabe el modo de permisos (no hay ventana segura para tu OK). Abrí la sesión en modo default y pedilo de nuevo.';

// decidir(entrada, {anotar}) → { decision: 'nada' } · { decision: 'ask', salida } · { decision: 'deny', salida, detalle, renglon }.
// Tira solo si algo se rompe adentro: el que llama lo traduce a "freno roto".
function decidir(entrada, opciones = {}) {
  const e = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : null;
  if (!e) throw new Error('la entrada no es un objeto');
  if (typeof e.tool_name === 'string' && !HERRAMIENTAS.includes(e.tool_name)) return { decision: 'nada' };
  const comando = e.tool_input && e.tool_input.command;
  if (!esDeAprobar(comando)) return { decision: 'nada' };

  const contexto = require('./lib/contexto.cjs');
  const cwd = contexto.cwdDe(e);
  const g = contexto.datosGit(cwd);
  const raiz = g ? g.raiz : null;
  const herramienta = HERRAMIENTAS.includes(e.tool_name) ? e.tool_name : 'Bash';

  const negar = (motivo, detalle) => {
    let renglon = null;
    if (raiz) {
      try {
        const frenosLog = require('./lib/frenos-log.cjs');
        const anotar = opciones.anotar || frenosLog.anotar;
        renglon = anotar(raiz, { id: ID, herramienta, detalle, rol: contexto.rol(raiz), rama: contexto.rama(raiz) });
      } catch (err) {
        /* el renglón es rastro: el freno vale igual */
      }
    }
    return { decision: 'deny', salida: salida('deny', motivo), detalle, renglon };
  };

  const modo = typeof e.permission_mode === 'string' ? e.permission_mode.trim() : '';
  if (!modo) return negar(motivoModo(null), 'sin modo');
  if (SIN_VENTANA.includes(modo)) return negar(motivoModo(modo), modo);
  if (!CON_VENTANA.includes(modo)) return negar(motivoModo(modo), 'modo desconocido');

  const rol = contexto.rol(raiz);
  if (rol !== 'humano') {
    return negar(`cambios aprobar no corre desde una carpeta de agente (.kit-rol: ${rol}): es el OK de una persona, desde su checkout principal.`, `rol ${rol}`);
  }
  const ficha = contexto.fichaVigente(raiz);
  if (ficha.estado === 'rota') return negar(`cambios aprobar no corre con la ficha rota (${ficha.donde}) — corré doctor.`, 'ficha rota');

  return { decision: 'ask', salida: salida('ask', MOTIVO_ASK) };
}

function principal() {
  let r;
  try {
    const t = fs.readFileSync(0, 'utf8');
    r = decidir(JSON.parse(t));
  } catch (e) {
    r = { decision: 'deny', salida: salida('deny', ROTO) };
  }
  if (r.decision !== 'nada') process.stdout.write(`${JSON.stringify(r.salida)}\n`);
}

if (require.main === module) {
  try {
    principal();
    process.exitCode = 0;
  } catch (e) {
    // Ni el deny se pudo imprimir: la salida distinta de 0 (2 = error que bloquea) y onFailure "block" frenan.
    process.exitCode = 2;
  }
} else {
  module.exports = { HERRAMIENTAS, SIN_VENTANA, CON_VENTANA, ID, ROTO, MOTIVO_ASK, esDeAprobar, salida, decidir };
}
