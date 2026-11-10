'use strict';
// paquete.cjs — el paquete del revisor por script (SPEC-0 6.10; D §6 regla 9 y §10). El revisor no tiene shell: lo que no está en
// un archivo, no lo ve y pide papeles en vez de revisar código. Este script los arma en UN archivo. Uso, desde el repo:
//   node .claude/scripts/paquete.cjs <sha-base> [--salida <archivo>] [--plazo <min>] [--pruebas <cmd> | --sin-pruebas]
// Arma: el diff de <sha-base> contra HEAD (el commit congelado del sub-paso), el `git status`, los avisos de afirmaciones.cjs (la
// prosa que promete de más, K5) y la salida de las pruebas, que corren
// adentro del vigía de proceso.cjs: las de --pruebas <cmd> (las de lo tocado: /tramo se las pasa en cada sub-paso, RF-fix 10) o, sin
// él, el vars.comando-test de la ficha vigente (el mismo que lee `encargo.cjs verificar`: la suite entera). --sin-pruebas no corre
// ninguna (el paquete lo dice como NO VERIFICADO). Sin --salida, el archivo va a .claude/paquetes/<sha7 de HEAD>.md DENTRO del
// checkout (RF-fix 7: el revisor solo tiene Read/Grep/Glob y en un -p no lee fuera del proyecto sin permiso; el gitignore.snippet
// trae /.claude/paquetes/). Imprime la ruta en la última línea. Si las pruebas no se pueden correr (sin comando-test, colgadas), el
// paquete lo dice como NO VERIFICADO: nunca como verde.
// Salidas: 0 el paquete está armado (aunque las pruebas den rojo: el rojo es dato para el revisor) · 1 no se pudo armar (la base
// no existe, no es un repo) · 2 mal llamado. Node estándar, cero dependencias. Es .cjs a propósito (proyectos con "type": "module").

const fs = require('fs');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/paquete.cjs <sha-base> [--salida <archivo>] [--plazo <min>] [--pruebas <cmd> | --sin-pruebas]   (desde el repo)',
  '  Arma en un archivo el diff contra <sha-base>, el git status y la salida de las pruebas, e imprime la ruta.',
  '  Sin --salida: .claude/paquetes/<sha7>.md dentro del checkout (el revisor lo lee sin permisos de más).',
  '  --pruebas <cmd>: las de lo tocado en vez de la suite (vars.comando-test) · --sin-pruebas: no corre ninguna (NO VERIFICADO).',
].join('\n');

const PLAZO_MIN = 10;
const CARPETA = '.claude/paquetes';

class MalLlamado extends Error {}

function leerArgumentos(argv) {
  const o = { base: null, salida: null, plazoMin: PLAZO_MIN, pruebas: null, sinPruebas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--salida' || a === '--plazo' || a === '--pruebas') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--') || v.trim() === '') throw new MalLlamado(`${a} pide un valor`);
      if (a === '--salida') o.salida = v;
      else if (a === '--pruebas') o.pruebas = v.trim();
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new MalLlamado('--plazo pide minutos (un número mayor que 0)');
        o.plazoMin = n;
      }
    } else if (a === '--sin-pruebas') o.sinPruebas = true;
    else if (a.startsWith('--')) throw new MalLlamado(`opción desconocida: ${a}`);
    else if (o.base === null) o.base = a;
    else throw new MalLlamado(`sobra "${a}": un solo <sha-base>`);
  }
  if (!o.base) throw new MalLlamado('falta el <sha-base>');
  if (o.pruebas !== null && o.sinPruebas) throw new MalLlamado('--pruebas y --sin-pruebas no van juntas');
  return o;
}

// armar({ cwd, base, salida, plazoMin, pruebas, sinPruebas }) → { ok: true, ruta, pruebas } | { ok: false, por }.
function armar({ cwd, base, salida, plazoMin = PLAZO_MIN, pruebas: cmdPruebas = null, sinPruebas = false }) {
  const git = require('../hooks/lib/git.cjs');
  const proceso = require('../hooks/lib/proceso.cjs');
  const contexto = require('../hooks/lib/contexto.cjs');
  const G = (args) => git.correr(args, { cwd, tiempo: 60000 });

  const rev = G(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!rev.ok) return { ok: false, por: `la base "${base}" no es un commit de este repo` };
  const punta = G(['rev-parse', '--short=7', 'HEAD']);
  if (!punta.ok) return { ok: false, por: 'no pude leer HEAD' };
  const diff = G(['diff', '--no-color', base, 'HEAD']);
  const stat = G(['diff', '--no-color', '--stat', base, 'HEAD']);
  const status = G(['status', '--short']);
  if (!diff.ok || !stat.ok || !status.ok) return { ok: false, por: 'git no pudo armar el diff o el status' };

  let ruta;
  if (salida) ruta = path.resolve(cwd, salida);
  else {
    const top = G(['rev-parse', '--show-toplevel']);
    if (!top.ok) return { ok: false, por: 'no encuentro la raíz del checkout' };
    ruta = path.join(path.resolve(top.stdout.trim()), ...CARPETA.split('/'), `${punta.stdout.trim()}.md`);
  }
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  // La prosa que promete de más (K5): avisos para el revisor; si el corrector falla, el try lo anota y el paquete sale igual.
  let afirmaciones;
  try {
    afirmaciones = require('./afirmaciones.cjs').seccion({ cwd, base });
  } catch (e) {
    afirmaciones = '## Afirmaciones\n\nafirmaciones: NO VERIFICADO (el corrector no corrió)\n';
  }
  const trozo = (t) => (t.trim() === '' ? '(vacío)' : t.replace(/\s+$/, ''));
  fs.writeFileSync(
    ruta,
    [
      `# Paquete del revisor · ${rev.stdout.trim().slice(0, 7)}..${punta.stdout.trim()}`,
      '',
      '## Estado (git status --short)',
      trozo(status.stdout),
      '',
      '## Resumen (git diff --stat)',
      trozo(stat.stdout),
      '',
      '## Diff completo',
      '```diff',
      trozo(diff.stdout),
      '```',
      '',
      afirmaciones,
      '## Pruebas',
      '',
    ].join('\n'),
  );

  // Las pruebas: las de --pruebas (las de lo tocado) o el comando-test de la ficha vigente (de git, no del disco), con la salida al
  // mismo archivo; con --sin-pruebas, ninguna.
  let ct;
  let que;
  if (sinPruebas) ct = null;
  else if (cmdPruebas) {
    ct = cmdPruebas;
    que = 'las de lo tocado (--pruebas)';
  } else {
    const f = contexto.fichaVigente(cwd);
    const v = f.estado === 'ok' && f.datos && f.datos.vars ? f.datos.vars['comando-test'] : undefined;
    ct = typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    que = 'la suite (vars.comando-test)';
  }
  let pruebas;
  if (ct === null) {
    pruebas = 'NO VERIFICADO (--sin-pruebas: el paquete no corrió ninguna)';
    fs.appendFileSync(ruta, `${pruebas}\n`);
  } else if (ct === undefined) {
    pruebas = 'NO VERIFICADO (la ficha vigente no tiene vars.comando-test)';
    fs.appendFileSync(ruta, `${pruebas}\n`);
  } else {
    fs.appendFileSync(ruta, `Comando: ${ct} · ${que}\n\`\`\`\n`);
    const fd = fs.openSync(ruta, 'a');
    let r;
    try {
      r = proceso.correrConPlazo(ct, { cwd, plazoMs: Math.round(plazoMin * 60000), stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    pruebas = r.estado === 'verde' ? 'VERDE' : r.estado === 'rojo' ? `ROJO (${r.como})` : `NO VERIFICADO (${r.estado}: ${r.como})`;
    fs.appendFileSync(ruta, `\`\`\`\nResultado: ${pruebas}\n`);
  }
  return { ok: true, ruta, pruebas };
}

function main(argv, { cwd = process.cwd() } = {}) {
  let o;
  try {
    o = leerArgumentos(argv);
  } catch (e) {
    if (!(e instanceof MalLlamado)) throw e;
    return { codigo: 2, salida: `${e.message}\n${USO}\n` };
  }
  const r = armar({ cwd, base: o.base, salida: o.salida, plazoMin: o.plazoMin, pruebas: o.pruebas, sinPruebas: o.sinPruebas });
  if (!r.ok) return { codigo: 1, salida: `${r.por}\n` };
  return { codigo: 0, salida: `pruebas: ${r.pruebas}\n${r.ruta}\n` };
}

if (require.main === module) {
  let codigo = 1;
  try {
    const r = main(process.argv.slice(2));
    process.stdout.write(r.salida);
    codigo = r.codigo;
  } catch (e) {
    process.stdout.write('paquete roto: corré doctor\n');
  }
  process.exitCode = codigo;
}

module.exports = { USO, CARPETA, leerArgumentos, armar, main };
