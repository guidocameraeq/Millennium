'use strict';
// portada.cjs — la portada del repo: el README.md de la raíz, armado por un script y no por el modelo (SPEC-paquete-7 P3.8; B §12bis; D7-6).
//   node .claude/scripts/portada.cjs armar [--plan] [--raiz <dir>]
//   node .claude/scripts/portada.cjs chequear [--raiz <dir>]
// `armar` escribe README.md desde docs/NORTE.md ("## Qué es", hasta 3 líneas) y la ficha .claude/kit.md (vars.proyecto,
// vars.comando-setup, vars.comando-test): título, banner, qué es, cómo correrlo y los enlaces al NORTE, al MAPA y al índice
// de docs/. Sin pendientes, historial ni versión (ADR-023): eso vive en el TODO, el CHANGELOG y la ficha. Si "## Qué es" sigue con el
// marcador {{…}} de la plantilla, lo dice y no escribe nada: el texto no se inventa. escribe además assets/banner.svg con el
// nombre: el banner va siempre (decisión de Guido, 2026-11-02). Si ya hay un assets/banner.svg que no armó este script, no lo pisa y lo dice;
// el README igual lo enlaza. --banner se sigue aceptando y no cambia nada (compatibilidad con lo que ya está escrito). --plan dice qué haría.
// Lo que escribe lleva al pie `<!-- kit:portada <hash> -->` (hash de lo generado, ficha.hash). Con esa marca y el hash igual al contenido,
// el archivo es del script y se puede rehacer; sin marca, o con el hash distinto (lo tocaron a mano), NO se pisa y se dice. Repetir
// con todo igual da "sin cambios". El actualizador nunca crea un README (r1-4): solo este comando.
// `chequear` corre el mismo chequeo que candado:portada (hooks/lib/candado.cjs): 0 si cumple, 1 con una línea por lo que falta.
// Las dos plantillas viajan ACÁ ADENTRO porque en un proyecto instalado no existe kit/molde/: kit/molde/README.md y
// kit/molde/assets/banner.svg son su versión legible y portada.test.cjs verifica que coinciden letra por letra.
// docs/ es la carpeta de papeles (SPEC-paquete-8r3 i1): la `carpeta-docs:` de la MISMA ficha que lee `armar` (la del disco, de donde
// salen el nombre y los comandos; así corre bien en el clon de la adopción antes del push): el NORTE se lee de <carpeta>/NORTE.md y
// los tres enlaces van a <carpeta>/. `chequear` es el del candado (lee la vigente).
// Salidas: 0 anduvo · 1 no pisó algo propio, falta lo que hay que llenar o chequear no cumple · 2 mal llamado o sin ficha.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');
const ficha = require('../hooks/lib/ficha.cjs');
const docsRuta = require('../hooks/lib/docs-ruta.cjs');

const USO = [
  'Uso: node .claude/scripts/portada.cjs armar [--plan] [--raiz <dir>]   (desde la raíz del repo)',
  '     node .claude/scripts/portada.cjs chequear [--raiz <dir>]',
  '  armar     arma README.md desde docs/NORTE.md y la ficha  y assets/banner.svg; --plan solo dice qué haría',
  '  chequear  0 si hay README en la raíz que enlaza a docs/NORTE.md (y ese archivo existe); 1 con qué falta',
  '  (docs/ es la carpeta de papeles: la carpeta-docs: de la ficha si la hay)',
].join('\n');

const RUTA_FICHA = '.claude/kit.md';
// El NORTE, en la carpeta de papeles (8r3 i1): docs/NORTE.md sin la clave.
const rutaNorte = (carpeta) => docsRuta.rel(carpeta, 'NORTE.md');
const RUTA_BANNER = 'assets/banner.svg';
const MAX_LINEAS = 3;

// ---------------------------------------------------------------- las plantillas (versión legible: kit/molde/README.md y assets/banner.svg)

const PLANTILLA_README = `# {{PROYECTO}}

{{BANNER}}

{{QUE_ES}}

## Cómo correrlo

{{COMO_CORRERLO}}

## Más

- [Qué es y para quién](docs/NORTE.md)
- [Mapa del proyecto](docs/MAPA.md)
- [Índice de la documentación](docs/README.md)
`;

const PLANTILLA_BANNER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 400" width="1280" height="400" role="img" aria-labelledby="t d">
  <title id="t">{{PROYECTO}}</title>
  <desc id="d">{{LINEA}}</desc>
  <defs>
    <pattern id="g1" width="16" height="16" patternUnits="userSpaceOnUse">
      <path d="M16 0H0V16" fill="none" stroke="#ffffff" stroke-opacity=".05" stroke-width="1"/>
    </pattern>
    <pattern id="g2" width="80" height="80" patternUnits="userSpaceOnUse">
      <rect width="80" height="80" fill="url(#g1)"/>
      <path d="M80 0H0V80" fill="none" stroke="#ffffff" stroke-opacity=".11" stroke-width="1"/>
    </pattern>
    <radialGradient id="glow" cx="30%" cy="45%" r="75%">
      <stop offset="0" stop-color="#1d5aa6"/>
      <stop offset="1" stop-color="#0f3466"/>
    </radialGradient>
  </defs>

  <rect width="1280" height="400" fill="url(#glow)"/>
  <rect width="1280" height="400" fill="url(#g2)"/>
  <rect x="16" y="16" width="1248" height="368" fill="none" stroke="#e8f1ff" stroke-opacity=".55" stroke-width="1"/>
  <rect x="24" y="24" width="1232" height="352" fill="none" stroke="#e8f1ff" stroke-opacity=".9" stroke-width="2"/>

  <g fill="#e8f1ff" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif">
    <text x="64" y="92" font-family="'Cascadia Mono',Consolas,'SFMono-Regular',Menlo,monospace" font-size="14" letter-spacing="3" fill-opacity=".72">PLANO Nº 01</text>
    <text x="60" y="206" font-size="{{TAMANO}}" font-weight="700" letter-spacing="-2">{{PROYECTO}}</text>
    <text x="64" y="262" font-size="26" font-weight="600">{{LINEA}}</text>
  </g>

  <!-- rótulo del plano -->
  <g stroke="#e8f1ff" stroke-width="1.2" fill="none">
    <rect x="64" y="318" width="300" height="38"/>
    <path d="M214 318V356"/>
  </g>
  <g fill="#e8f1ff" font-family="'Cascadia Mono',Consolas,Menlo,monospace">
    <text x="72" y="331" font-size="8.5" fill-opacity=".6" letter-spacing="1.5">PROYECTO</text>
    <text x="72" y="348" font-size="12" font-weight="700">{{PROYECTO}}</text>
    <text x="222" y="331" font-size="8.5" fill-opacity=".6" letter-spacing="1.5">ESC.</text>
    <text x="222" y="348" font-size="12" font-weight="700">1:1</text>
  </g>

  <!-- la planta: un ambiente por pieza -->
  <g fill="#ffffff" fill-opacity=".04">
    <rect x="860" y="84" width="170" height="110"/>
    <rect x="1030" y="84" width="190" height="110"/>
    <rect x="860" y="194" width="360" height="106"/>
  </g>
  <g stroke="#e8f1ff" stroke-width="4" stroke-linecap="square" fill="none">
    <path d="M860 300V84H1220V300H940"/>
    <path d="M1030 84V130M1030 160V194"/>
    <path d="M860 194H980M1010 194H1220"/>
  </g>
  <g transform="translate(1180 128)" stroke="#e8f1ff" fill="none" stroke-width="1.2">
    <circle r="20" stroke-opacity=".6"/>
    <path d="M0 -26V26M-26 0H26" stroke-opacity=".35"/>
    <path d="M0 -17L6 6L0 1L-6 6Z" fill="#e8f1ff" stroke="none"/>
  </g>
</svg>
`;

// ---------------------------------------------------------------- utilidades

const lf = (t) => String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const esMarcador = (t) => /\{\{[^}]*\}\}/.test(t);
const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RE_MARCA = /^([\s\S]*\n)<!-- kit:portada ([0-9a-f]{12}) -->\n?$/;

// "## Qué es" del NORTE → { lineas (hasta 3, sin vacías), recortado } o null si no hay sección.
function queEs(norte) {
  const l = lf(norte).split('\n');
  const i = l.findIndex((x) => /^##\s+Qué es\s*$/i.test(x));
  if (i < 0) return null;
  let j = i + 1;
  while (j < l.length && !/^#{1,2}\s/.test(l[j])) j++;
  const todas = l.slice(i + 1, j).map((x) => x.trim()).filter(Boolean);
  return { lineas: todas.slice(0, MAX_LINEAS), recortado: todas.length > MAX_LINEAS };
}

function comoCorrerlo(datos) {
  const v = datos.vars || {};
  const out = [];
  if (v['comando-setup']) out.push(`- Preparar: \`${v['comando-setup']}\``);
  if (v['comando-test']) out.push(`- Probar: \`${v['comando-test']}\``);
  return out.length ? out.join('\n') : 'La ficha del kit (`.claude/kit.md`) no declara `comando-setup` ni `comando-test`: agregalos en `vars` y rehacé la portada.';
}

// Texto armado (README o SVG: la marca es un comentario en los dos), con su marca al pie. El hash es el de todo lo de arriba de la marca.
const conMarca = (cuerpo) => `${cuerpo}<!-- kit:portada ${ficha.hash(cuerpo)} -->\n`;

function armarReadme({ proyecto, queEs: q, datos, banner }) {
  let t = PLANTILLA_README.replace('{{BANNER}}\n\n', banner ? `![${proyecto}](${RUTA_BANNER})\n\n` : '');
  // 8r3 i1: los tres enlaces van a la carpeta de papeles de la ficha (la plantilla dice docs/, la de fábrica)
  const carpeta = docsRuta.deDatos(datos);
  if (carpeta !== docsRuta.POR_DEFECTO) t = t.split('](docs/').join(`](${carpeta}/`);
  t = t.replace('{{QUE_ES}}', () => q.join('\n')).replace('{{COMO_CORRERLO}}', () => comoCorrerlo(datos));
  return conMarca(t.replace('{{PROYECTO}}', () => proyecto));
}

function armarBanner({ proyecto, linea }) {
  const corta = linea.replace(/[*_`[\]]/g, '').trim();
  const l = corta.length > 78 ? `${corta.slice(0, 77).trimEnd()}…` : corta;
  const tam = Math.max(40, Math.min(108, Math.floor(1120 / (Math.max(proyecto.length, 1) * 0.6))));
  const t = PLANTILLA_BANNER.split('{{PROYECTO}}').join(xml(proyecto)).split('{{LINEA}}').join(xml(l)).replace('{{TAMANO}}', String(tam));
  return conMarca(t);
}

// De quién es un archivo que ya existe: 'mio' (lo armó este script y nadie lo tocó) o 'ajeno'.
function duenio(texto) {
  const m = RE_MARCA.exec(lf(texto));
  return m && ficha.hash(m[1]) === m[2] ? 'mio' : 'ajeno';
}

// Escribe (o dice que escribiría) un archivo de la portada. → { linea, ok }
function poner(raiz, rel, nuevo, plan) {
  const abs = path.join(raiz, ...rel.split('/'));
  if (!fs.existsSync(abs)) {
    if (!plan) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, nuevo);
    }
    return { linea: `${rel}: ${plan ? 'lo crearía' : 'creado'}`, ok: true };
  }
  const actual = fs.readFileSync(abs, 'utf8');
  if (lf(actual) === lf(nuevo)) return { linea: `${rel}: sin cambios`, ok: true };
  if (duenio(actual) === 'ajeno') {
    return { linea: `${rel}: NO lo pisé — existe y no lo armó este script (o lo editaron a mano). Si querés la portada del kit, movelo y corré armar de nuevo`, ok: false };
  }
  if (!plan) fs.writeFileSync(abs, nuevo);
  return { linea: `${rel}: ${plan ? 'lo actualizaría' : 'actualizado'} (cambió el NORTE o la ficha)`, ok: true };
}

// El README de la raíz, sin mirar mayúsculas (Readme.md, readme.md…): el nombre con que ya está, o README.md.
function nombreReadme(raiz) {
  try {
    return fs.readdirSync(raiz).find((n) => /^readme\.md$/i.test(n)) || 'README.md';
  } catch (e) {
    return 'README.md';
  }
}

// ---------------------------------------------------------------- comandos

function armar(raiz, { plan }, salida) {
  let datos;
  try {
    datos = ficha.leerArchivo(path.join(raiz, ...RUTA_FICHA.split('/'))).datos;
  } catch (e) {
    salida(`sin ficha que se lea (${RUTA_FICHA}): ${e.code === 'ENOENT' ? 'no existe' : e.mensaje ? `línea ${e.linea}, ${e.mensaje}` : e.message} — la portada sale de ahí; corré doctor`);
    return 2;
  }
  const proyecto = datos.vars && typeof datos.vars.proyecto === 'string' ? datos.vars.proyecto.trim() : '';
  if (!proyecto) {
    salida(`la ficha no tiene vars.proyecto — agregalo en ${RUTA_FICHA} y volvé a correr`);
    return 2;
  }
  const RUTA_NORTE = rutaNorte(docsRuta.deDatos(datos));
  let norte;
  try {
    norte = fs.readFileSync(path.join(raiz, ...RUTA_NORTE.split('/')), 'utf8');
  } catch (e) {
    salida(`falta ${RUTA_NORTE} — la portada resume el NORTE; escribilo primero`);
    return 1;
  }
  const q = queEs(norte);
  if (!q || !q.lineas.length) {
    salida(`${RUTA_NORTE} no tiene texto en "## Qué es" — llenalo y volvé a correr (no lo invento)`);
    return 1;
  }
  if (q.lineas.some(esMarcador)) {
    salida(`${RUTA_NORTE} sigue con el marcador de la plantilla en "## Qué es" — llenalo y volvé a correr (no lo invento)`);
    return 1;
  }
  const nombre = nombreReadme(raiz);
  const res = [];
  res.push(poner(raiz, RUTA_BANNER, armarBanner({ proyecto, linea: q.lineas[0] }), plan));
  res.push(poner(raiz, nombre, armarReadme({ proyecto, queEs: q.lineas, datos, banner: true }), plan));
  for (const x of res) salida(plan ? `(plan) ${x.linea}` : x.linea);
  // (8) D8b: un README propio que no se pisó y no enlaza el banner (que quedó: creado, igual o propio): un renglón, para que Guido lo enlace
  if (!res[1].ok) {
    let enlaza = false;
    try {
      enlaza = fs.readFileSync(path.join(raiz, nombre), 'utf8').includes(RUTA_BANNER);
    } catch (e) { /* si no se lee, el renglón sobra poco: se da */ }
    if (!enlaza) salida(`${plan ? '(plan) ' : ''}el banner quedó en ${RUTA_BANNER}: enlazalo arriba del README si querés`);
  }
  if (q.recortado) salida(`(nota) "## Qué es" tiene más de ${MAX_LINEAS} líneas: la portada lleva las primeras ${MAX_LINEAS}`);
  return res.every((r) => r.ok) ? 0 : 1;
}

function chequear(raiz, salida) {
  let candado;
  try {
    candado = require('../hooks/lib/candado.cjs');
  } catch (e) {
    salida('portada roto: no encuentro hooks/lib/candado.cjs — corré doctor');
    return 2;
  }
  let fallas;
  try {
    fallas = candado.CHEQUEOS.portada(raiz);
  } catch (e) {
    salida('portada roto: el chequeo no pudo correr (¿es un repo git?) — corré doctor');
    return 2;
  }
  if (!fallas.length) {
    salida('portada: en verde');
    return 0;
  }
  for (const f of fallas) salida(`candado:${f.id} · ${f.que} · ${f.hacer}`);
  return 1;
}

// ---------------------------------------------------------------- línea de comandos

function leerArgumentos(argv) {
  const o = { cmd: null, banner: false, plan: false, raiz: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--banner') o.banner = true; // compatibilidad: el banner va siempre, esto ya no cambia nada
    else if (a === '--plan') o.plan = true;
    else if (a === '--raiz') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) return { error: '--raiz pide una carpeta.' };
      o.raiz = path.resolve(argv[++i]);
    } else if (a.startsWith('-')) return { error: `no conozco ${a}.` };
    else if (o.cmd === null) o.cmd = a;
    else return { error: `sobra "${a}".` };
  }
  if (o.cmd !== 'armar' && o.cmd !== 'chequear') return { error: 'falta el comando: armar o chequear.' };
  if (o.cmd === 'chequear' && (o.banner || o.plan)) return { error: '--banner y --plan van solo con armar.' };
  return o;
}

function cli(argv, salida = (t) => process.stdout.write(`${t}\n`)) {
  const o = leerArgumentos(argv);
  if (o.error) {
    salida(`${o.error}\n${USO}`);
    return 2;
  }
  try {
    return o.cmd === 'armar' ? armar(o.raiz, o, salida) : chequear(o.raiz, salida);
  } catch (e) {
    salida('portada rota: corré doctor');
    return 2;
  }
}

module.exports = { PLANTILLA_README, PLANTILLA_BANNER, queEs, armarReadme, armarBanner, duenio, cli };

if (require.main === module) {
  process.exitCode = cli(process.argv.slice(2));
}
