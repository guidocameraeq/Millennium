'use strict';
// encargo.cjs — la lógica del encargo (SPEC-paquete-5 P5.4, P3.4, P6.3, P6.5, P5.3bis; D5-6, D5-7, D5-8, D5-9, D5-10; red team
// r1-2, r1-4, r1-10, r1-11): el nombre, el vocabulario de los mensajes, la plantilla del encargo, el validador de AUTORIZADO, la base
// fija de --allowedTools, la ubicación del encargo y del spec por git (nunca por el disco) y el juicio del sello y de un mensaje.
// Vive en hooks/lib/ porque decide un freno o un permiso (r4-3). La usa scripts/encargo.cjs; E2 suma `autorizado` y `verificar`
// encima de estas mismas funciones. Node estándar, cero dependencias. Es .cjs a propósito: corre igual con "type": "module".

const path = require('path');
const git = require('./git.cjs');
const sello = require('./sello.cjs');
const ficha = require('./ficha.cjs');
const docsRuta = require('./docs-ruta.cjs');

const RE_X = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RE_ID = /^[0-9]{2}$/;
const RE_SHA = /^[0-9a-f]{4,40}$/i;
const T_GIT = 60000; // ls-tree, show y merge-base en un repo grande pasan los 5 s de git.cjs
const GATE = 'gate:entorno-prueba';
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// La forma de cualquier `carpeta-docs:` (8r3 i1): minúsculas, cifras, . _ -, con / (la exacta la valida ficha.cjs).
const CARPETA_CUALQUIERA = '[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*';

// ---------------------------------------------------------------- el nombre

// nombreEncargo("<x>--<ID>") → { x, id, rama, madre, carpeta } o null (mismas reglas que worktree.cjs: x ≤ 20, ID de dos dígitos).
function nombreEncargo(token) {
  const m = /^(.*?)--([^-].*)$/.exec(String(token || ''));
  if (!m || !RE_X.test(m[1]) || m[1].length > 20 || !RE_ID.test(m[2])) return null;
  return { x: m[1], id: m[2], rama: `modulo/${m[1]}--${m[2]}`, madre: `modulo/${m[1]}`, carpeta: `modulo--${m[1]}--${m[2]}` };
}

// ---------------------------------------------------------------- el vocabulario (P5.4, G §6.1; congelado)

// La primera línea del mensaje es el tipo, en mayúsculas y sin tilde. `conRuta`: lleva `<ruta>@<sha7>` que tiene que existir en
// modulo/<x>. Dos columnas, una sola tabla (G §6.1): la de director y obreros, y la de la mesa (`mesa: true`, entre directores de
// dos proyectos), que lleva `<alias>:<ruta>@<sha>` del archivo de mesa commiteado en el repo del que escribe (crit. 13 del kit).
// RESPUESTA y PRESENTACION están en las dos columnas: las separa la cita de mesa (ver juzgarMensaje).
const VOCABULARIO = [
  { tipo: 'PRESENTACION', de: 'obrero', a: 'director', conRuta: false },
  { tipo: 'AVANCE', de: 'obrero', a: 'director', conRuta: false },
  { tipo: 'CONSULTA', de: 'obrero', a: 'director', conRuta: false },
  { tipo: 'PARADA', de: 'obrero', a: 'director', conRuta: false },
  { tipo: 'CIERRE', de: 'obrero', a: 'director', conRuta: false },
  { tipo: 'ENCARGO', de: 'director', a: 'obrero', conRuta: true },
  { tipo: 'RESPUESTA', de: 'director', a: 'obrero', conRuta: false },
  { tipo: 'CORRECCION', de: 'director', a: 'obrero', conRuta: true },
  { tipo: 'HECHO', de: 'director', a: 'director', conRuta: false, mesa: true },
  { tipo: 'PEDIDO', de: 'director', a: 'director', conRuta: false, mesa: true },
  { tipo: 'RESPUESTA', de: 'director', a: 'director', conRuta: false, mesa: true },
  { tipo: 'PROPUESTA', de: 'director', a: 'director', conRuta: false, mesa: true },
  { tipo: 'ALERTA', de: 'director', a: 'director', conRuta: false, mesa: true },
  { tipo: 'PRESENTACION', de: 'director', a: 'director', conRuta: false, mesa: true },
];

// sinTilde("CORRECCIÓN") → "CORRECCION": saca solo el acento agudo (la Ñ queda; D5-6: la tilde es un alias).
const sinTilde = (t) => String(t).normalize('NFD').replace(/\u0301/g, '').normalize('NFC');

// tipoDe(palabra[, filtro]) → la primera fila del vocabulario con ese tipo (con filtro, la primera que además lo cumple; si
// ninguna lo cumple, la primera con ese tipo), o null (en minúsculas no vale: el tipo va en mayúsculas).
function tipoDe(palabra, filtro) {
  const t = sinTilde(palabra);
  const filas = VOCABULARIO.filter((v) => v.tipo === t);
  return (filtro && filas.find(filtro)) || filas[0] || null;
}

// ---------------------------------------------------------------- la plantilla del encargo (P3.4, D §15.2; congelada)

const CAMPOS = ['Partida', 'Spec', 'Skill', 'Modelo', 'Riesgo', 'Apertura', 'Suscripción'];
const SECCIONES = ['Toca', 'Alcance', 'NO SE TOCA', 'AUTORIZADO', 'GATE'];
const MODELOS = ['sonnet', 'opus'];
const ESFUERZOS = ['low', 'medium', 'high'];
const NADA = '(nada)';

// Saca los comentarios HTML (también los de varios renglones) y deja los renglones en su lugar.
function sinComentarios(lineas) {
  const r = [];
  let dentro = false;
  for (const l of lineas) {
    let s = l;
    let out = '';
    while (s.length) {
      if (dentro) {
        const k = s.indexOf('-->');
        if (k < 0) {
          s = '';
        } else {
          s = s.slice(k + 3);
          dentro = false;
        }
      } else {
        const k = s.indexOf('<!--');
        if (k < 0) {
          out += s;
          s = '';
        } else {
          out += s.slice(0, k);
          s = s.slice(k + 4);
          dentro = true;
        }
      }
    }
    r.push(out.replace(/[ \t]+$/, ''));
  }
  return r;
}

// "<valor> · Por qué: <razón>" → { valor, porque } o null.
function conPorque(v) {
  const k = v.indexOf(' · Por qué: ');
  if (k < 0) return null;
  const porque = v.slice(k + ' · Por qué: '.length).trim();
  if (!porque) return null;
  return { valor: v.slice(0, k).trim(), porque };
}

// Cada campo: valor crudo → { ok, datos } o { ok: false, por }. `n` es el nombre del encargo (para que rama y spec coincidan).
const LECTORES = {
  Partida(v, n) {
    const re = /^rama (\S+) desde (\S+)@([0-9a-f]{7,40}) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2})$/;
    const m = re.exec(v);
    if (!m) return { ok: false, por: 'no es "rama modulo/<x>--<ID> desde modulo/<x>@<sha7> · <fecha ISO con zona>": pegá la línea de partida' };
    if (n && (m[1] !== n.rama || m[2] !== n.madre)) return { ok: false, por: `dice ${m[1]} desde ${m[2]}, y el encargo es ${n.rama} desde ${n.madre}` };
    return { ok: true, datos: { rama: m[1], madre: m[2], sha: m[3], fecha: m[4] } };
  },
  Spec(v, n, carpeta) {
    const c = carpeta ? escRe(carpeta) : CARPETA_CUALQUIERA;
    const m = new RegExp(`^(${c}/modulos/([^/]+)/SPEC(?:-\\d+)?\\.md):(\\d+)(?:-(\\d+))?$`).exec(v);
    if (!m) return { ok: false, por: `no es "${carpeta || 'docs'}/modulos/<x>/SPEC[-N].md:<línea>[-<línea>]"` };
    if (n && m[2] !== n.x) return { ok: false, por: `el spec es del módulo ${m[2]}, y el encargo es de ${n.x}` };
    return { ok: true, datos: { ruta: m[1], desde: Number(m[3]), hasta: m[4] ? Number(m[4]) : Number(m[3]) } };
  },
  Skill(v) {
    return v === 'obrero' ? { ok: true, datos: v } : { ok: false, por: 'tiene que decir obrero' };
  },
  Modelo(v) {
    const p = v.split(' · ');
    const m = /^Esfuerzo: (.*)$/.exec(p[1] || '');
    const pq = /^Por qué: (.+)$/.exec(p.slice(2).join(' · '));
    if (p.length < 3 || !MODELOS.includes(p[0]) || !m || !ESFUERZOS.includes(m[1]) || !pq || !pq[1].trim()) {
      return { ok: false, por: 'no es "sonnet | opus · Esfuerzo: low | medium | high · Por qué: <razón>"' };
    }
    return { ok: true, datos: { modelo: p[0], esfuerzo: m[1], porque: pq[1].trim() } };
  },
  Riesgo(v) {
    const c = conPorque(v);
    if (!c || !['bajo', 'alto'].includes(c.valor)) return { ok: false, por: 'no es "bajo | alto · Por qué: <razón>"' };
    return { ok: true, datos: { riesgo: c.valor, porque: c.porque } };
  },
  Apertura(v) {
    return ['Guido', 'director'].includes(v) ? { ok: true, datos: v } : { ok: false, por: 'tiene que ser Guido o director' };
  },
  'Suscripción'(v) {
    return v.trim() ? { ok: true, datos: v.trim() } : { ok: false, por: 'va una línea o —' };
  },
};

// Los renglones de lista de una sección: [{ texto, n }] y los que no son lista (sin contar vacíos).
function itemsDe(cuerpo) {
  const items = [];
  const sueltos = [];
  for (const { l, n } of cuerpo) {
    if (l.trim() === '') continue;
    const m = /^- (.*)$/.exec(l);
    if (m) items.push({ texto: m[1].trim(), n });
    else sueltos.push({ texto: l.trim(), n });
  }
  return { items, sueltos };
}

// leerEncargo(texto, nombre?) → { titulo, campos, secciones, errores }: el encargo según la plantilla. `errores` vacío = se lee.
// campos: { partida, spec, skill, modelo, riesgo, apertura, suscripcion } ya leídos; secciones: { toca: { rutas, recursos },
// alcance, noSeToca (renglones crudos), autorizado: [reglas] ([] si es (nada)), gate: [comandos] }.
// `carpeta`: la carpeta de papeles del repo (8r3 i1; la da ubicarEncargo, o docs-ruta.deRaiz): con ella, el `- Spec:` tiene que vivir
// ahí; sin ella, en la forma de cualquier `carpeta-docs:` (<c>/modulos/<x>/SPEC[-N].md).
function leerEncargo(texto, nombre, carpeta) {
  const errores = [];
  let t = Buffer.isBuffer(texto) ? texto.toString('utf8') : String(texto);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const lineas = sinComentarios(t.replace(/\r\n/g, '\n').split('\n'));
  // El título: el primer renglón con texto.
  const k0 = lineas.findIndex((l) => l.trim() !== '');
  let titulo = null;
  const mt = k0 >= 0 ? /^# Encargo (\S+) · (\S+) · (.+)$/.exec(lineas[k0]) : null;
  if (!mt) errores.push('el primer renglón no es "# Encargo <ID> · <x> · <título>"');
  else {
    titulo = { id: mt[1], x: mt[2], titulo: mt[3].trim() };
    if (nombre && (titulo.id !== nombre.id || titulo.x !== nombre.x)) errores.push(`el título dice ${titulo.x}--${titulo.id}, y el encargo es ${nombre.x}--${nombre.id}`);
  }
  // Las secciones ##, y antes de la primera, los campos `- Nombre: valor`.
  const crudos = {};
  const cuerpos = {};
  let actual = null;
  lineas.forEach((l, i) => {
    if (i === k0 && mt) return;
    const s = /^## (.+)$/.exec(l);
    if (s) {
      const nom = s[1].trim();
      actual = SECCIONES.includes(nom) ? nom : '(otra)';
      if (actual !== '(otra)') {
        if (cuerpos[actual]) errores.push(`## ${nom} está dos veces`);
        cuerpos[actual] = [];
      }
      return;
    }
    if (actual === null) {
      const c = /^- ([^:]+): ?(.*)$/.exec(l);
      if (c && CAMPOS.includes(c[1])) {
        if (Object.prototype.hasOwnProperty.call(crudos, c[1])) errores.push(`- ${c[1]}: está dos veces`);
        crudos[c[1]] = c[2].trim();
      }
      return;
    }
    if (actual !== '(otra)') cuerpos[actual].push({ l, n: i + 1 });
  });
  const faltan = CAMPOS.filter((c) => !Object.prototype.hasOwnProperty.call(crudos, c)).map((c) => `- ${c}:`);
  faltan.push(...SECCIONES.filter((s) => !cuerpos[s]).map((s) => `## ${s}`));
  if (faltan.length) errores.push(`faltan ${faltan.join(', ')}`);
  const campos = {};
  for (const c of CAMPOS) {
    if (!Object.prototype.hasOwnProperty.call(crudos, c)) continue;
    const r = LECTORES[c](crudos[c], nombre, carpeta);
    if (!r.ok) errores.push(`- ${c}: ${r.por}`);
    else campos[c === 'Suscripción' ? 'suscripcion' : c.toLowerCase()] = r.datos;
  }
  const secciones = {};
  if (cuerpos.Toca) {
    const { items } = itemsDe(cuerpos.Toca);
    const toca = { rutas: [], recursos: [] };
    for (const it of items) {
      const r = /^recurso: (.*)$/.exec(it.texto);
      if (!r) toca.rutas.push(it.texto.replace(/^`(.*)`$/, '$1'));
      else if (/^(suite|navegador|puerto \d+)$/.test(r[1].trim())) toca.recursos.push(r[1].trim());
      else errores.push(`## Toca, renglón ${it.n}: el recurso es suite, puerto N o navegador`);
    }
    secciones.toca = toca;
  }
  if (cuerpos.Alcance) secciones.alcance = cuerpos.Alcance.map((x) => x.l);
  if (cuerpos['NO SE TOCA']) secciones.noSeToca = cuerpos['NO SE TOCA'].map((x) => x.l);
  // AUTORIZADO y GATE deciden un permiso y un gate: un renglón que no es lista no se adivina, se rechaza.
  if (cuerpos.AUTORIZADO) {
    const { items, sueltos } = itemsDe(cuerpos.AUTORIZADO);
    for (const s of sueltos) errores.push(`## AUTORIZADO, renglón ${s.n}: va una regla por renglón, "- <regla>"`);
    const reglas = items.map((it) => it.texto.replace(/^`(.*)`$/, '$1'));
    if (!reglas.length) errores.push(`## AUTORIZADO está vacía: si no autoriza nada, escribí - ${NADA}`);
    else if (reglas.includes(NADA) && reglas.length > 1) errores.push(`## AUTORIZADO: - ${NADA} va sola`);
    secciones.autorizado = reglas.includes(NADA) ? [] : reglas;
  }
  if (cuerpos.GATE) {
    const { items, sueltos } = itemsDe(cuerpos.GATE);
    for (const s of sueltos) errores.push(`## GATE, renglón ${s.n}: va un comando por renglón, - \`<comando>\``);
    const comandos = [];
    for (const it of items) {
      if (it.texto === NADA) continue;
      const m = /^`([^`]+)`$/.exec(it.texto);
      if (!m || !m[1].trim()) errores.push(`## GATE, renglón ${it.n}: el comando va entre comillas invertidas, - \`<comando>\``);
      else comandos.push(m[1].trim());
    }
    if (items.some((it) => it.texto === NADA) && items.length > 1) errores.push(`## GATE: - ${NADA} va sola`);
    secciones.gate = comandos;
  }
  return { titulo, campos, secciones, errores };
}

// ---------------------------------------------------------------- el validador de AUTORIZADO (P3.4; criterio 4)

const HERRAMIENTAS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'WebFetch'];
const INTERPRETES = ['node', 'python', 'py', 'bash', 'sh', 'pwsh', 'powershell', 'cmd', 'npx'];

// "Node.exe", "python3.12" → "node", "python"; otra palabra → null.
function interprete(palabra) {
  const n = String(palabra).toLowerCase().replace(/\.exe$/, '').replace(/^python\d+(\.\d+)*$/, 'python');
  return INTERPRETES.includes(n) ? n : null;
}

// ¿La regla de Bash/PowerShell es un intérprete o una shell abierto? Termina en `*` o `:*` y antes solo va el intérprete y,
// a lo sumo, banderas (`node:*`, `node *`, `python -c *`, `cmd /c *`). `node .claude/x.cjs:*` no: lo que corre está nombrado.
function interpreteAbierto(spec) {
  let s = spec.trim();
  if (s.endsWith(':*')) s = s.slice(0, -2);
  else if (s.endsWith('*')) s = s.slice(0, -1);
  else return null;
  const p = s.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return null;
  const n = interprete(p[0]);
  if (!n || !p.slice(1).every((x) => /^[-/]/.test(x))) return null;
  return n;
}

// validarRegla(regla) → null si vale, o el por qué (una línea). Las negativas de la plantilla: herramienta fuera de la lista, sin
// paréntesis, `*` solo, intérprete o shell abierto, ruta absoluta (`//`, `~` o `C:`), con `..`, o toda la carpeta (`**` sola).
function validarRegla(regla) {
  const r = String(regla).trim();
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(r);
  if (!m) return 'no es Herramienta(regla), con la sintaxis de settings';
  const [, h, spec] = m;
  if (!HERRAMIENTAS.includes(h)) return `${h} no está entre las que se autorizan (${HERRAMIENTAS.join(', ')})`;
  if (spec === undefined) return `${h} sin paréntesis autoriza todo: escribí ${h}(<regla estrecha>)`;
  const s = spec.trim();
  if (s === '') return `${h}() vacío: escribí la regla adentro`;
  if (h === 'Bash' || h === 'PowerShell') {
    if (/^[*:\s]+$/.test(s)) return `${h} con * solo autoriza todo`;
    const n = interpreteAbierto(s);
    if (n) return `${n} seguido de * corre cualquier cosa: nombrá el script (${h}(${n} <script>))`;
    return null;
  }
  if (h === 'WebFetch') {
    const d = /^domain:(.+)$/.exec(s);
    if (!d) return 'WebFetch va con un dominio: WebFetch(domain:<dominio>)';
    if (/^[*.\s]+$/.test(d[1])) return 'WebFetch con * solo autoriza todos los dominios';
    return null;
  }
  // Read, Edit, Write: rutas relativas al proyecto.
  if (s.startsWith('//') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) return `ruta absoluta (${s}): va relativa al proyecto`;
  if (s.split(/[/\\]/).includes('..')) return `ruta con .. (${s}): sale del proyecto`;
  const resto = s.replace(/^\.?\//, '');
  if (resto === '' || resto === '.' || /^[*/]+$/.test(resto)) return `${s} es toda la carpeta: nombrá la parte que toca`;
  return null;
}

// validarAutorizado(reglas) → [{ regla, por }] con las que no valen ([] = todas valen).
function validarAutorizado(reglas) {
  const malas = [];
  for (const regla of reglas || []) {
    const por = validarRegla(regla);
    if (por) malas.push({ regla, por });
  }
  return malas;
}

// aPermiso(regla) → la regla de AUTORIZADO como va en las allow y en --allowedTools (RF-fix 14). Para archivos la plataforma solo mira
// Edit(<ruta>): con una regla Write(<ruta>) avisa "`Write(...)` is not matched" (el aviso por el que W0 de D5.2 sacó las Write del
// deny de worktree; con ellas fuera, la sesión real 1 ya no lo mostró). Por eso un Write(<ruta>) del encargo se escribe Edit(<ruta>),
// sin duplicar si el encargo ya lo trae. `Write` solo, el nombre de la herramienta (la base), queda igual. El validador no cambia.
function aPermiso(regla) {
  const m = /^Write\((.+)\)$/.exec(String(regla).trim());
  return m ? `Edit(${m[1]})` : regla;
}

// ---------------------------------------------------------------- la base fija de --allowedTools (r1-2, r1-4)

// Las formas (`:*`, equivalente a ` *`) son las de la doc oficial, con la cita en scripts/encargo.cjs:
// https://code.claude.com/docs/en/permissions ("The `:*` suffix is an equivalent way to write a trailing wildcard").
const BASE_HERRAMIENTAS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Agent', 'Skill'];
const BASE_LECTURA = ['ls', 'cat', 'head', 'wc', 'grep', 'find', 'mkdir']; // los medidos en D4.2 (D4.2-2)
const BASE_GIT = ['status', 'diff', 'log', 'show', 'add', 'commit', 'push'];
const SCRIPT_ENCARGO = 'node .claude/scripts/encargo.cjs';

// base(comandoTest) → la lista de reglas de la base: herramientas, lectura (Bash), y git, encargo.cjs y el test en Bash Y en
// PowerShell; el test exacto y con ` *`. Sin comandoTest (vacío o no texto), sin las reglas del test.
function base(comandoTest) {
  const r = [...BASE_HERRAMIENTAS, ...BASE_LECTURA.map((c) => `Bash(${c}:*)`)];
  const ct = typeof comandoTest === 'string' ? comandoTest.trim() : '';
  for (const shell of ['Bash', 'PowerShell']) {
    for (const g of BASE_GIT) r.push(`${shell}(git ${g}:*)`);
    r.push(`${shell}(${SCRIPT_ENCARGO}:*)`);
    if (ct) r.push(`${shell}(${ct})`, `${shell}(${ct} *)`);
  }
  return r;
}

// ---------------------------------------------------------------- git: la más nueva entre local y origin (r1-10)

class ErrorGit extends Error {}

const G = (cwd, args) => git.correr(args, { cwd, tiempo: T_GIT });
// shaDe(cwd, ref) → el SHA completo del commit de `ref`, o null si no existe.
function shaDe(cwd, ref) {
  const r = G(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}
// esAncestro(cwd, a, b) → true/false; git que falla de otro modo → ErrorGit (nunca se adivina "divergió").
function esAncestro(cwd, a, b) {
  const r = G(cwd, ['merge-base', '--is-ancestor', a, b]);
  if (r.codigo === 0 && !r.error) return true;
  if (r.codigo === 1 && !r.error) return false;
  throw new ErrorGit(`git merge-base: ${r.error || r.stderr.trim()}`);
}

// refMasNueva(cwd, rama) → { ok: true, sha, nombre ('modulo/x' u 'origin/modulo/x') } · { ok: false, por }. Local y origin/<rama>
// (lo que dice el último fetch: no sale a la red): si una contiene a la otra, la más nueva; iguales, la local; divergidas → no.
function refMasNueva(cwd, rama) {
  const local = shaDe(cwd, `refs/heads/${rama}`);
  const remoto = shaDe(cwd, `refs/remotes/origin/${rama}`);
  if (!local && !remoto) return { ok: false, por: `no existe ${rama} (ni en esta PC ni en origin)` };
  const L = { ok: true, sha: local, nombre: rama };
  const O = { ok: true, sha: remoto, nombre: `origin/${rama}` };
  if (!remoto) return L;
  if (!local) return O;
  if (local === remoto) return L;
  if (esAncestro(cwd, local, remoto)) return O;
  if (esAncestro(cwd, remoto, local)) return L;
  return { ok: false, por: `${rama} divergió de origin: que el director lo arregle (pull o push) antes de seguir` };
}

// tipoEn(cwd, sha, ruta) → 'blob' · 'tree' · null (no está).
function tipoEn(cwd, sha, ruta) {
  const r = G(cwd, ['cat-file', '-t', `${sha}:${ruta}`]);
  return r.ok ? r.stdout.trim() : null;
}

// leerEn(cwd, sha, ruta) → Buffer, o null si no está.
function leerEn(cwd, sha, ruta) {
  if (tipoEn(cwd, sha, ruta) !== 'blob') return null;
  const r = G(cwd, ['show', `${sha}:${ruta}`]);
  return r.ok ? r.salida : null;
}

// ubicarEncargo(cwd, nombre) → { ok: true, ref, ruta, texto, carpeta } · { ok: false, por }: el único
// docs/modulos/<x>/bitacora/*-encargo-<ID>.md de la más nueva entre modulo/<x> local y origin (ninguno o dos → no). `docs` es la
// carpeta de papeles de la ficha vigente (8r3 i1); `carpeta` sale en la respuesta para leerEncargo.
function ubicarEncargo(cwd, n) {
  const ref = refMasNueva(cwd, n.madre);
  if (!ref.ok) return ref;
  const carpeta = docsRuta.deRaiz(cwd);
  const dir = `${carpeta}/modulos/${n.x}/bitacora`;
  const r = G(cwd, ['ls-tree', '-z', ref.sha, '--', `${dir}/`]);
  if (!r.ok && r.error) throw new ErrorGit(`git ls-tree: ${r.error}`);
  const re = new RegExp(`^.+-encargo-${n.id}\\.md$`);
  const rutas = r.stdout
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t');
      return { tipo: e.slice(0, tab).split(' ')[1], ruta: e.slice(tab + 1) };
    })
    .filter((e) => e.tipo === 'blob' && path.posix.dirname(e.ruta) === dir && re.test(path.posix.basename(e.ruta)))
    .map((e) => e.ruta);
  if (!rutas.length) return { ok: false, por: `no hay encargo ${n.id} commiteado en ${ref.nombre} (${dir}/<fecha>-encargo-${n.id}.md): que el director lo commitee` };
  if (rutas.length > 1) return { ok: false, por: `hay ${rutas.length} encargos ${n.id} en ${ref.nombre} (${rutas.join(', ')}): que el director deje uno` };
  return { ok: true, ref, ruta: rutas[0], texto: leerEn(cwd, ref.sha, rutas[0]).toString('utf8'), carpeta };
}

// specVigente(cwd, sha, x) → la ruta del SPEC[-N].md de N más alto de docs/modulos/<x>/ en ese commit (el SPEC.md es N=1), o
// docs/modulos/<x>/SPEC.md si no hay ninguno (rf-4: un cambio aprobado va como SPEC-2.md en el mismo módulo). docs: la carpeta de
// papeles de la ficha vigente (8r3 i1).
function specVigente(cwd, sha, x) {
  const dir = `${docsRuta.deRaiz(cwd)}/modulos/${x}`;
  const r = G(cwd, ['ls-tree', '-z', '--name-only', sha, '--', `${dir}/`]);
  if (!r.ok && r.error) throw new ErrorGit(`git ls-tree: ${r.error}`);
  let mejor = { n: 0, ruta: `${dir}/SPEC.md` };
  for (const ruta of (r.stdout || '').split('\0').filter(Boolean)) {
    const m = /^SPEC(?:-(\d+))?\.md$/.exec(path.posix.basename(ruta));
    if (!m || path.posix.dirname(ruta) !== dir) continue;
    const n = m[1] ? Number(m[1]) : 1;
    if (n > mejor.n) mejor = { n, ruta };
  }
  return mejor.ruta;
}

// ---------------------------------------------------------------- el sello (P5.6, el corrector "spec sin sello"; A §6)

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

// gateQuitadoEl(datosFicha, 'AAAA-MM-DD') → ¿gate:entorno-prueba estaba quitado ese día? (la regla de arquitecto.cjs, rf-3).
function gateQuitadoEl(datos, dia) {
  const q = datos && datos.frenos && Array.isArray(datos.frenos.quitados) ? datos.frenos.quitados : [];
  return q.some((x) => x && x.id === GATE && (x.hasta === 'siempre' || (RE_DIA.test(String(x.hasta)) && x.hasta >= dia)));
}

const SIN_SELLO = 'spec sin Arquitecto: corré Modo B';

// juzgarSpec(buf, { hayFicha, datosFicha }) → { ok: true } · { ok: false, por }: el sello con revisarSello (la copia del molde) y,
// si vale, que el Estado diga READY. `datosFicha`: los datos de la ficha vigente (o null), para el gate quitado el día del sello.
function juzgarSpec(buf, { hayFicha, datosFicha }) {
  const r = sello.revisarSello(buf, { hayFicha: !!hayFicha, gateQuitado: (c) => gateQuitadoEl(datosFicha, c.fecha) });
  if (r.estado === 'sin') return { ok: false, por: SIN_SELLO };
  if (r.estado === 'invalido') return { ok: false, por: `sello inválido: ${r.error}: que el director llame al Arquitecto` };
  if (r.estado === 'cambio') return { ok: false, por: 'el spec cambió después del sello: que el director corra sello de nuevo' };
  if (r.estado !== 'ok') return { ok: false, por: `sello en un estado que no conozco (${r.estado}): que el director llame al Arquitecto` };
  const lineas = sello.renglones(buf);
  const u = sello.ubicar(lineas);
  if (u.estado < 0 || !sello.valorEstado(lineas[u.estado]).startsWith('READY')) return { ok: false, por: 'spec sin READY: falta el OK de Guido y `ready`' };
  return { ok: true };
}

// ---------------------------------------------------------------- la tarea 0 (SPEC-paquete-8r T3, el freno en script; rt-1)

const RUTA_FICHA = '.claude/kit.md';

// ¿El sello del spec dice `entorno — (tarea 0: montar el entorno de prueba)`? (sin sello o uno que no se lee: no).
function selloConTareaCero(buf) {
  const lineas = sello.renglones(buf);
  const u = sello.ubicar(lineas);
  if (u.sello < 0) return false;
  const p = sello.parsear(lineas[u.sello]);
  return p.ok && p.campos.entorno.tipo === 'no' && p.campos.entorno.razon === sello.RAZON_TAREA_CERO;
}

// ¿La ficha (.claude/kit.md) del commit `sha` declara un entorno clase dummy o prueba? Sin ficha, o una que no se lee: no.
function fichaConEntornoDePrueba(cwd, sha) {
  const buf = leerEn(cwd, sha, RUTA_FICHA);
  if (!buf) return false;
  let datos;
  try {
    datos = ficha.leer(buf.toString('utf8')).datos;
  } catch (e) {
    return false;
  }
  const entornos = datos && datos.entornos && typeof datos.entornos === 'object' ? Object.values(datos.entornos) : [];
  return entornos.some((v) => v && (v.clase === 'dummy' || v.clase === 'prueba'));
}

// tareaCeroPendiente(cwd, n, ref, specBuf) → null (sigue) o el por de la negativa: con el sello de tarea 0 en el spec del módulo,
// todo encargo con ID distinto de 00 espera a que la ficha de la PUNTA de modulo/<x> (`ref`: la más nueva entre local y origin; la
// vigente de origin/<def> no la ve hasta integrar) tenga un entorno dummy o prueba. El 00 es la tarea 0: monta el entorno y lo suma.
function tareaCeroPendiente(cwd, n, ref, specBuf) {
  if (n.id === '00' || !specBuf || !selloConTareaCero(specBuf)) return null;
  if (fichaConEntornoDePrueba(cwd, ref.sha)) return null;
  return `la tarea 0 (encargo 00) va primero: el entorno de prueba no está en la ficha de ${n.madre}`;
}

// ---------------------------------------------------------------- un mensaje (P5.3bis; r1-11)

const NO_RECIBE = 'esta sesión no recibe órdenes por mensaje';
const DEVUELTO = 'devuelto: el mensaje avisa, git manda';

// rf-9: el director escribe en markdown. Antes de juzgar, cada palabra sin comillas invertidas ni `*`, y sin la puntuación final
// (`ENCARGO \`<ruta>@<sha7>\`.` o `**ENCARGO**` son el mismo mensaje).
const limpiarPalabra = (t) => String(t || '').replace(/[`*]/g, '').replace(/[.,;:]+$/, '');

// "<ruta>[@<sha>]" → { ruta, sha (o null) }. El @ cuenta solo si lo que sigue es un SHA.
function rutaYSha(token) {
  const t = limpiarPalabra(token);
  const k = t.lastIndexOf('@');
  if (k > 0 && RE_SHA.test(t.slice(k + 1))) return { ruta: t.slice(0, k), sha: t.slice(k + 1) };
  return { ruta: t, sha: null };
}

// rutaEnModulo(cwd, x, ruta, sha) → { ok: true, sha7 } · { ok: false, por }: la ruta es un archivo en la más nueva de modulo/<x>
// y, con @sha, ese commit es de modulo/<x> y la contiene.
function rutaEnModulo(cwd, x, ruta, sha) {
  if (!ruta || ruta.startsWith('/') || /^[A-Za-z]:/.test(ruta) || ruta.split(/[/\\]/).includes('..')) return { ok: false, por: `${ruta || '(sin ruta)'} no es una ruta del repo` };
  const ref = refMasNueva(cwd, `modulo/${x}`);
  if (!ref.ok) return { ok: false, por: ref.por, divergio: /divergió/.test(ref.por) };
  if (tipoEn(cwd, ref.sha, ruta) !== 'blob') return { ok: false, por: `${ruta} no está en ${ref.nombre}` };
  if (!sha) return { ok: true, sha7: ref.sha.slice(0, 7) };
  const completo = shaDe(cwd, sha);
  if (!completo) return { ok: false, por: `@${sha} no es un commit de este repo` };
  if (!esAncestro(cwd, completo, ref.sha)) return { ok: false, por: `@${sha} no es de ${ref.nombre}` };
  if (tipoEn(cwd, completo, ruta) !== 'blob') return { ok: false, por: `@${sha} no contiene ${ruta}` };
  return { ok: true, sha7: completo.slice(0, 7) };
}

// La cita de mesa del aviso: `<alias>:docs/modulos/<x>/mesa/<alias>/<archivo>.md@<sha>` (G §5.7). El archivo vive en el repo de
// <alias>, que puede tener otra carpeta de papeles (8r3 i1): vale la forma de cualquier `carpeta-docs:`; la exacta la mira citaDeMesa
// (mesa.citaEnRepo, contra la ficha de ese commit).
const RE_CITA_MESA = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/modulos\/[^\s@]+\/mesa\/[^\s@]+\.md)@([0-9a-f]{7,40})$/;
function citaMesa(palabras) {
  for (const w of palabras) {
    const m = RE_CITA_MESA.exec(w);
    if (m) return { alias: m[1], ruta: m[2], sha: m[3] };
  }
  return null;
}

// juzgarMensaje({ texto, rol, pestana, rutaEnModulo, citaDeMesa }) → { codigo: 0 | 1, linea }. `texto`: la primera línea (tipo
// y, si va, la ruta); `rol`: el de contexto.rol; `pestana`: la de contexto.pestana(rama), que decide el lado; `rutaEnModulo(x, ruta,
// sha)` y `citaDeMesa(alias, ruta, sha)` → { ok, sha12 } · { ok: false, por }: los chequeos de git (inyectados: así se prueba la
// tabla sola). Un tipo de mesa llega solo a un director y vale si git respalda su archivo en el repo del otro (crit. 13 y 16).
function juzgarMensaje({ texto, rol, pestana, rutaEnModulo: enModulo, citaDeMesa }) {
  const no = (linea) => ({ codigo: 1, linea });
  if (rol === 'humano' || rol === 'desconocido') return no(`${NO_RECIBE} (rol ${rol})`);
  const lado = pestana && (pestana.tipo === 'director' || pestana.tipo === 'obrero') ? pestana.tipo : null;
  if (!lado) return no(`${NO_RECIBE} (la rama ${(pestana && pestana.rama) || '(ninguna)'} no es de un módulo)`);
  const p = String(texto || '').trim().split(/\s+/).map(limpiarPalabra).filter(Boolean);
  const cita = citaMesa(p.slice(1));
  // RESPUESTA y PRESENTACION están en las dos columnas: con cita de mesa es la de la mesa (y a un obrero no llega); sin cita, la
  // de director y obreros.
  const def = p.length ? tipoDe(p[0], (v) => !!v.mesa === !!cita) : null;
  if (!def) return no(`no vale: "${p[0] || ''}" no es un tipo del vocabulario: anotalo y no lo ejecutes`);
  if (def.a !== lado) return no(`no vale: ${def.tipo} no es para un ${lado}: anotalo y no lo ejecutes`);
  if (def.mesa) {
    if (!cita) return no(`${DEVUELTO} — ${def.tipo} de mesa sin <alias>:<ruta de mesa>@<sha>`);
    const r = citaDeMesa ? citaDeMesa(cita.alias, cita.ruta, cita.sha) : { ok: false, por: 'no hay cómo mirar el repo del otro' };
    if (!r.ok) return no(`${DEVUELTO} — ${r.por}`);
    return { codigo: 0, linea: `vale: leé ${cita.alias}:${cita.ruta}@${r.sha12}` };
  }
  if (!def.conRuta) return { codigo: 0, linea: 'vale: dato' };
  if (p.length < 2) return no(`${DEVUELTO} — ${def.tipo} sin <ruta>@<sha7>`);
  const { ruta, sha } = rutaYSha(p[1]);
  const r = enModulo(pestana.modulo, ruta, sha);
  if (!r.ok) return no(r.divergio ? r.por : `${DEVUELTO} — ${r.por}`);
  return { codigo: 0, linea: `vale: leé ${ruta}@${r.sha7}` };
}

module.exports = {
  RE_X, RE_ID, VOCABULARIO, CAMPOS, SECCIONES, HERRAMIENTAS, INTERPRETES, SCRIPT_ENCARGO, SIN_SELLO, NO_RECIBE, DEVUELTO, ErrorGit,
  nombreEncargo, sinTilde, tipoDe, leerEncargo, interprete, interpreteAbierto, validarRegla, validarAutorizado, aPermiso, base,
  shaDe, esAncestro, refMasNueva, tipoEn, leerEn, ubicarEncargo, specVigente, gateQuitadoEl, juzgarSpec, selloConTareaCero, fichaConEntornoDePrueba, tareaCeroPendiente, limpiarPalabra, rutaYSha,
  rutaEnModulo, juzgarMensaje, citaMesa, RE_CITA_MESA,
};
