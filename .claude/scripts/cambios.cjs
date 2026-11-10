'use strict';
// cambios.cjs — el registro de cambios de método del proyecto (SPEC-paquete-2 P6.8a y D2.2 F3; ADR-026). Uso, desde el repo:
//   node .claude/scripts/cambios.cjs nuevo --slug <s> --clase 2|3-barrera --toca <a,b> [--id <x>]… (--origen "<t>" | --cita "<alias> <id>")
//                                          [--cicatriz <c>] [--chico sí|no] [--chico-por "<t>"] [--urgente sí|no] [--cuerpo <archivo>]
//   node .claude/scripts/cambios.cjs listar [--te-espera | --aprobados-nuevos]
//   node .claude/scripts/cambios.cjs verificar
//   node .claude/scripts/cambios.cjs anotar-sha <id> <sha> [--aplico <archivo>]
//   node .claude/scripts/cambios.cjs rechazar <id> "<motivo>"
//   node .claude/scripts/cambios.cjs aprobar <id>
//   node .claude/scripts/cambios.cjs subio-al-kit <id> <N.N.N>
// `aprobar` es EL ÚNICO camino a `aprobado` (el OK de Guido para tocar un freno): pasa por la ventana de permiso (la `ask` del
// settings.json y el hook niega-aprobar.cjs) y además se niega solo, sin escribir nada, desde una carpeta de agente, fuera del
// checkout principal o de la rama por defecto, con el archivo sin commitear o con la ficha rota. `nuevo`, `aprobar` y
// `subio-al-kit` hacen su propio commit por rutas. `subio-al-kit` (SPEC-paquete-7 P6.8b-1): un aplicado que el kit ya cubre pasa a
// subio-al-kit con la versión del kit que lo trajo (lo corre el actualizador; a mano, solo si sabés que subió). anotar-sha y
// rechazar también lo aceptan (r1-5: no es callejón). La lógica (formato, sello, verificar, toca) vive en
// .claude/hooks/lib/cambios.cjs: es barrera.
// Salidas: 0 anduvo · 1 negado o con fallas (una línea por qué) · 2 mal llamado. Un error propio: "cambios roto: corré doctor", 1.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const fs = require('fs');
const path = require('path');

const USO = [
  'Uso: node .claude/scripts/cambios.cjs <comando> …   (desde el repo)',
  '  nuevo --slug <s> --clase 2|3-barrera --toca <a,b> [--id <x>]… (--origen "<t>" | --cita "<alias> <id>")',
  '        [--cicatriz seguridad|produccion|plata|no] [--chico sí|no] [--chico-por "<t>"] [--urgente sí|no] [--cuerpo <archivo>]',
  '        (sin --cuerpo, el cuerpo llega por la entrada estándar: ## Caso de origen · ## Regla · ## Dónde vive · ## Medición)',
  '  listar [--te-espera | --aprobados-nuevos]',
  '  verificar',
  '  anotar-sha <id> <sha> [--aplico <archivo>]',
  '  rechazar <id> "<motivo>"',
  '  aprobar <id>',
  '  subio-al-kit <id> <N.N.N>   (un aplicado que el kit ya cubre; N.N.N = la versión del kit que lo trajo)',
].join('\n');

const ROTO = 'cambios roto: corré doctor';

class MalLlamado extends Error {}
const malLlamado = (m) => {
  throw new MalLlamado(m);
};

// ---------------------------------------------------------------- argumentos

// Las banderas con valor de cada comando; --id se repite. Lo que no está acá es mal llamado.
const BANDERAS = {
  nuevo: ['--slug', '--clase', '--toca', '--id', '--origen', '--cita', '--cicatriz', '--chico', '--chico-por', '--urgente', '--cuerpo'],
  listar: [],
  verificar: [],
  'anotar-sha': ['--aplico'],
  rechazar: [],
  aprobar: [],
  'subio-al-kit': [],
};
const SUELTAS = { listar: ['--te-espera', '--aprobados-nuevos'] };
const POSICIONALES = { nuevo: 0, listar: 0, verificar: 0, 'anotar-sha': 2, rechazar: 2, aprobar: 1, 'subio-al-kit': 2 };

function leerArgumentos(argv) {
  const [comando, ...resto] = argv;
  if (!comando) malLlamado('Falta el comando.');
  if (!Object.prototype.hasOwnProperty.call(BANDERAS, comando)) malLlamado(`Comando desconocido: ${comando}`);
  const banderas = {};
  const sueltas = [];
  const pos = [];
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (BANDERAS[comando].includes(a)) {
      if (i + 1 >= resto.length) malLlamado(`${a} pide un valor.`);
      const v = resto[++i];
      if (a === '--id') (banderas[a] = banderas[a] || []).push(v);
      else if (Object.prototype.hasOwnProperty.call(banderas, a)) malLlamado(`${a} va una sola vez.`);
      else banderas[a] = v;
    } else if ((SUELTAS[comando] || []).includes(a)) {
      sueltas.push(a);
    } else if (a.startsWith('--')) {
      malLlamado(`Argumento desconocido: ${a}`);
    } else {
      pos.push(a);
    }
  }
  if (pos.length !== POSICIONALES[comando]) malLlamado(`${comando} lleva ${POSICIONALES[comando]} argumento(s) además de las banderas.`);
  if (sueltas.length > 1) malLlamado('listar lleva una sola de --te-espera o --aprobados-nuevos.');
  return { comando, banderas, sueltas, pos };
}

// ---------------------------------------------------------------- utilidades

function libs() {
  return {
    git: require('../hooks/lib/git.cjs'),
    contexto: require('../hooks/lib/contexto.cjs'),
    ficha: require('../hooks/lib/ficha.cjs'),
    frenosLog: require('../hooks/lib/frenos-log.cjs'),
    ruta: require('../hooks/lib/cambios-ruta.cjs'),
    cambios: require('../hooks/lib/cambios.cjs'),
    zona: require('../hooks/lib/zona-propia.cjs'),
  };
}

const dos = (n) => String(n).padStart(2, '0');
const hoy = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const siNo = (v) => (v === 'si' ? 'sí' : v);

// Escritura atómica: a un temporal al lado y rename (E §6.4).
function escribirAtomico(abs, texto) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, texto, 'utf8');
  fs.renameSync(tmp, abs);
}

function mergeAMedias(L, raiz) {
  const gd = L.contexto.gitDir(raiz);
  return !!gd && fs.existsSync(path.join(gd, 'MERGE_HEAD'));
}

// La primera línea del error de git, sin rutas de más.
const primeraLinea = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || 'sin detalle';

// Las marcas de sesión del git-dir (H §11), de la más nueva a la más vieja: [{ nombre, ms }].
function marcas(L, raiz) {
  const gd = L.contexto.gitDir(raiz);
  if (!gd) return [];
  const dir = path.join(gd, 'kit-sesiones');
  let nombres;
  try {
    nombres = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const res = [];
  for (const n of nombres) {
    if (!/^[A-Za-z0-9-]+$/.test(n)) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile()) res.push({ nombre: n, ms: st.mtimeMs });
    } catch (e) {
      /* se fue mientras se leía */
    }
  }
  return res.sort((a, b) => b.ms - a.ms || (a.nombre < b.nombre ? 1 : -1));
}

// Un cambio por id, ya leído: { c } o { problema }.
function cambio(L, raiz, id) {
  if (!L.ruta.esId(id)) return { problema: `"${id}" no es un id de cambio (<AAAA-MM-DD>-<slug>)` };
  const abs = L.ruta.rutaAbsoluta(raiz, id);
  if (!fs.existsSync(abs)) return { problema: `no existe ${L.ruta.rutaRelativa(id)}` };
  const c = L.cambios.cargar({ id, rel: L.ruta.rutaRelativa(id), abs });
  if (c.error) return { problema: `${c.rel}:${c.error.linea}: ${c.error.mensaje} — corré verificar` };
  return { c };
}

// ---------------------------------------------------------------- nuevo

function nuevo(L, raiz, b, entradaEstandar) {
  const C = L.cambios;
  const slug = b['--slug'];
  if (!slug || !L.ruta.RE_SLUG.test(slug)) malLlamado('--slug: minúsculas, números y guiones (sin guion al principio ni al final).');
  const clase = b['--clase'];
  if (!C.CLASES.includes(clase)) malLlamado(`--clase: ${C.CLASES.join(' o ')}.`);
  if (!b['--toca']) malLlamado('--toca: la lista separada por comas.');
  const tocaL = b['--toca'].split(',').map((s) => s.trim()).filter(Boolean);
  if (!tocaL.length) malLlamado('--toca: la lista separada por comas.');
  const ids = (b['--id'] || []).map((x) => {
    if (typeof x !== 'string' || x.trim() === '' || /[\r\n]/.test(x)) malLlamado('--id: un id por bandera, sin saltos de línea.');
    return L.zona.normalizarId(x.trim());
  });
  if (clase === '3-barrera' && !ids.length) malLlamado('un 3-barrera declara los ids que cambia: --id <x>, uno por id (es obligatorio).');
  const tieneOrigen = Object.prototype.hasOwnProperty.call(b, '--origen');
  const tieneCita = Object.prototype.hasOwnProperty.call(b, '--cita');
  if (tieneOrigen === tieneCita) malLlamado('va --origen "<texto>" o --cita "<alias> <id>", uno solo.');
  for (const k of ['--origen', '--cita', '--chico-por']) {
    if (Object.prototype.hasOwnProperty.call(b, k) && !C.textoValido(b[k])) malLlamado(`${k}: un texto no vacío, sin ", \\ ni saltos de línea (hasta 300 caracteres).`);
  }
  const cicatriz = b['--cicatriz'] || 'no';
  if (!C.CICATRICES.includes(cicatriz)) malLlamado(`--cicatriz: ${C.CICATRICES.join(', ')}.`);
  const chico = siNo(b['--chico'] || (cicatriz === 'no' ? 'sí' : 'no'));
  if (!['sí', 'no'].includes(chico)) malLlamado('--chico: sí o no.');
  const urgente = siNo(b['--urgente'] || 'no');
  if (!['sí', 'no'].includes(urgente)) malLlamado('--urgente: sí o no.');

  let cuerpo;
  if (b['--cuerpo']) {
    try {
      cuerpo = fs.readFileSync(path.resolve(b['--cuerpo']), 'utf8');
    } catch (e) {
      return { codigo: 1, lineas: [`cambios nuevo: no — no pude leer ${b['--cuerpo']}`] };
    }
  } else cuerpo = entradaEstandar();

  const texto = C.armar({ clase, toca: tocaL, ids, origen: b['--origen'], cita: b['--cita'], cicatriz, chico, chicoPor: b['--chico-por'], urgente, cuerpo });
  const leido = C.leer(texto);
  const fallas = C.validar(leido.datos, leido.cuerpo);
  if (fallas.length) return { codigo: 1, lineas: fallas.map((f) => `cambios nuevo: no — ${f.que} · ${f.hacer}`) };

  const id = `${hoy(new Date())}-${slug}`;
  const rel = L.ruta.rutaRelativa(id);
  const abs = L.ruta.rutaAbsoluta(raiz, id);
  if (fs.existsSync(abs)) return { codigo: 1, lineas: [`cambios nuevo: no — ya existe ${rel}: elegí otro --slug`] };
  if (mergeAMedias(L, raiz)) return { codigo: 1, lineas: ['cambios nuevo: no — hay un merge a medio hacer: terminá el merge primero'] };

  escribirAtomico(abs, texto);
  const g = (args) => L.git.correr(args, { cwd: raiz, tiempo: 30000 });
  let r = g(['add', '--', rel]);
  if (r.ok) r = g(['commit', '-q', '-m', `cambios: propuesto ${id}`, '--', rel]);
  if (!r.ok) {
    g(['reset', '-q', '--', rel]);
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      /* ya no estaba */
    }
    return { codigo: 1, lineas: [`cambios nuevo: no — git no pudo commitear (${primeraLinea(r.stderr || r.error)}); no quedó nada escrito`] };
  }
  const sha = L.git.texto(['rev-parse', '--short', 'HEAD'], { cwd: raiz }) || '?';
  const lineas = [`cambios: propuesto ${id} · commit ${sha}`];
  if (clase === '3-barrera') lineas.push(`te espera: ${lineaTeEspera(L, { id, texto, datos: leido.datos, cuerpo: leido.cuerpo })}`);
  return { codigo: 0, lineas };
}

// ---------------------------------------------------------------- listar

// La línea lista de "te espera" (r3-3): la regla en una línea y los primeros 8 del hash, lo que Guido mira antes del clic.
function lineaTeEspera(L, c) {
  const ids = Array.isArray(c.datos.ids) ? c.datos.ids.map(L.zona.normalizarId) : [];
  return `${c.id} · ${L.cambios.reglaEnUnaLinea(c.cuerpo) || '(sin regla)'} · toca: ${(c.datos.toca || []).join(', ')} · ids: ${ids.join(', ')} · hash ${L.cambios.hashSello(c.texto).slice(0, 8)}`;
}

function listar(L, raiz, modo) {
  const lineas = [];
  let codigo = 0;
  let desde = -Infinity;
  if (modo === '--aprobados-nuevos') {
    const m = marcas(L, raiz);
    if (m.length >= 2) desde = m[1].ms; // la marca de la sesión anterior a la más nueva (la más nueva es esta)
  }
  for (const a of L.cambios.listarArchivos(raiz)) {
    const id = a.id || a.nombre;
    const c = a.id ? L.cambios.cargar(a) : { error: { linea: 0, mensaje: 'nombre inválido' } };
    if (c.error) {
      lineas.push(`${id} · no se lee — corré verificar`);
      codigo = 1;
      continue;
    }
    const d = c.datos;
    if (modo === '--te-espera') {
      if (d.estado === 'propuesto' && d.clase === '3-barrera') lineas.push(lineaTeEspera(L, c));
    } else if (modo === '--aprobados-nuevos') {
      const s = d.aprobo;
      if (!s || L.cambios.formaSello(s)) continue;
      if (Date.parse(s.fecha) > desde) lineas.push(`${id} · ${d.estado} · sellado ${s.fecha} · carpeta ${s.carpeta} · rol ${s.rol} · sesión ${s.sesion}`);
    } else {
      lineas.push(`${id} · ${d.estado} · clase ${d.clase} · toca: ${Array.isArray(d.toca) ? d.toca.join(', ') : '?'}`);
    }
  }
  if (!modo && !lineas.length) lineas.push('cambios: no hay ninguno');
  return { codigo, lineas };
}

// ---------------------------------------------------------------- verificar

function verificar(L, raiz) {
  const fallas = L.cambios.verificar(raiz);
  if (!fallas.length) {
    const n = L.cambios.listarArchivos(raiz).length;
    return { codigo: 0, lineas: [`cambios: ${n} en orden`] };
  }
  return { codigo: 1, lineas: fallas.map((f) => `${f.id} · ${f.que} · ${f.hacer}`) };
}

// ---------------------------------------------------------------- anotar-sha y rechazar

function anotarSha(L, raiz, id, shaArg, archivoAplico) {
  const C = L.cambios;
  const no = (m) => ({ codigo: 1, lineas: [`cambios anotar-sha: no — ${m}`] });
  const r = cambio(L, raiz, id);
  if (r.problema) return no(r.problema);
  const c = r.c;
  const fallas = C.validar(c.datos, c.cuerpo);
  if (fallas.length) return no(`${fallas[0].que} — corré verificar`);
  const d = c.datos;
  const barrera = d.clase === '3-barrera';
  // rf-2: un aplicado se reapunta SOLO si su sha ya no es de la historia de HEAD (un pull --rebase lo reescribió); si sigue ahí,
  // reapuntarlo taparía otro commit (r5-1). El sha nuevo cumple lo mismo que con un aprobado. Un subio-al-kit, igual (r1-5), y
  // sigue subio-al-kit.
  const reapuntar = C.CON_SHA.includes(d.estado);
  if (!reapuntar && (barrera ? d.estado !== 'aprobado' : d.estado !== 'propuesto')) {
    return no(barrera ? `es ${d.estado}: anotar-sha va sobre un 3-barrera aprobado` : `es ${d.estado}: anotar-sha va sobre un clase 2 propuesto`);
  }
  if (shaArg.startsWith('-') || !/^[A-Za-z0-9._/~^-]+$/.test(shaArg)) return no('eso no es un commit');
  const sha = L.git.texto(['rev-parse', '--verify', '-q', `${shaArg}^{commit}`], { cwd: raiz });
  if (!sha) return no('ese commit no existe en este repo');
  if (reapuntar) {
    const head = L.git.texto(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: raiz });
    const viejo = L.git.texto(['rev-parse', '--verify', '-q', `${d.sha}^{commit}`], { cwd: raiz });
    if (viejo && head && L.git.correr(['merge-base', '--is-ancestor', viejo, head], { cwd: raiz }).ok) {
      return no(`es ${d.estado} y su sha (${d.sha.slice(0, 12)}) sigue en la historia: se reapunta solo si un rebase lo reescribió`);
    }
    if (!head || !L.git.correr(['merge-base', '--is-ancestor', sha, head], { cwd: raiz }).ok) return no('ese commit no está en la historia de HEAD');
  }
  if (barrera) {
    const v = C.validarSello(raiz, c, C.ramaLocal(raiz));
    if (v.fallas.length) return no(`el sello no vale (${v.fallas[0].que}) — corré verificar`);
    if (sha === v.sello || !L.git.correr(['merge-base', '--is-ancestor', v.sello, sha], { cwd: raiz }).ok) return no('ese commit no viene después del sello');
    const primero = C.primerQueToca(raiz, v.sello, sha, d.toca);
    if (primero !== sha) {
      return no(primero ? `el primer commit después del sello que toca lo de "toca" es ${primero.slice(0, 12)}: un aprobado sirve para ese, no para otro` : 'ese commit no toca nada de lo de "toca"');
    }
  }
  const campos = { estado: reapuntar ? d.estado : 'aplicado', sha };
  if (archivoAplico != null) {
    if (!C.textoValido(archivoAplico)) return no('--aplico: una ruta relativa sin ", \\ ni saltos de línea');
    const b = L.git.correr(['cat-file', 'blob', `${sha}:${archivoAplico}`], { cwd: raiz });
    if (!b.ok) return no(`${archivoAplico} no está en ese commit`);
    const z = L.zona.zonas(b.salida.toString('utf8'));
    if (!z.ok) return no(`la zona propia de ${archivoAplico} está rota (renglón ${z.linea})`);
    if (!z.zonas.length) return no(`${archivoAplico} no tiene zona propia`);
    campos.aplico = `{archivo: ${C.comillas(archivoAplico)}, hash: ${L.ficha.hash(z.zonas.map((x) => x.contenido).join('\n'))}}`;
  }
  const nuevoTexto = C.ponerCampos(c.texto, campos);
  const leido = C.leer(nuevoTexto);
  const f2 = C.validar(leido.datos, leido.cuerpo);
  if (f2.length) return no(`quedaría mal: ${f2[0].que}`);
  escribirAtomico(c.abs, nuevoTexto);
  return { codigo: 0, lineas: [`cambios: ${campos.estado} ${id} · sha ${sha.slice(0, 12)}${campos.aplico ? ` · aplico ${archivoAplico}` : ''}`] };
}

function rechazar(L, raiz, id, motivo) {
  const C = L.cambios;
  const no = (m) => ({ codigo: 1, lineas: [`cambios rechazar: no — ${m}`] });
  if (!C.textoValido(motivo)) return no('el motivo: un texto no vacío, sin ", \\ ni saltos de línea (hasta 300 caracteres)');
  const r = cambio(L, raiz, id);
  if (r.problema) return no(r.problema);
  const d = r.c.datos;
  // rf-1: también un aplicado (un sello que un merge sacó de la historia de primer padre queda trabado si no), y un subio-al-kit
  // (r1-5). Es seguro: rechazado le quita cobertura a lo que cubría, nunca la da. sha, aplico y version van solo con aplicado o
  // subio-al-kit: salen (quedan en git).
  if (!['propuesto', 'aprobado', 'aplicado', 'subio-al-kit'].includes(d.estado)) return no(`es ${d.estado}: se rechaza un propuesto, un aprobado, un aplicado o un subio-al-kit`);
  const nuevoTexto = C.ponerCampos(r.c.texto, { estado: 'rechazado', motivo: C.comillas(motivo), sha: null, aplico: null, version: null });
  escribirAtomico(r.c.abs, nuevoTexto);
  return { codigo: 0, lineas: [`cambios: rechazado ${id}`] };
}

// ---------------------------------------------------------------- subio-al-kit (SPEC-paquete-7 P6.8b-1)

// Un aplicado → subio-al-kit con <version> (la transición pura de la lib, aSubioAlKit) y SU commit por rutas, como nuevo. Desde
// otro estado, con un cambio que no valida o un merge a medias → 1 sin escribir. El sello de un 3-barrera no se toca (version y
// estado están fuera de su hash).
function subioAlKit(L, raiz, id, version) {
  const C = L.cambios;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) malLlamado('subio-al-kit: la versión del kit es N.N.N (sin ceros a la izquierda).');
  const no = (m) => ({ codigo: 1, lineas: [`cambios subio-al-kit: no — ${m}`] });
  const r = cambio(L, raiz, id);
  if (r.problema) return no(r.problema);
  const c = r.c;
  const fallas = C.validar(c.datos, c.cuerpo);
  if (fallas.length) return no(`${fallas[0].que} — corré verificar`);
  if (c.datos.estado !== 'aplicado') return no(`es ${c.datos.estado}: sube al kit solo un aplicado`);
  if (mergeAMedias(L, raiz)) return no('hay un merge a medio hacer: terminá el merge primero');
  const nuevoTexto = C.aSubioAlKit(c.texto, version);
  const leido = C.leer(nuevoTexto);
  const f2 = C.validar(leido.datos, leido.cuerpo);
  if (f2.length) return no(`quedaría mal: ${f2[0].que}`);
  escribirAtomico(c.abs, nuevoTexto);
  const g = (args) => L.git.correr(args, { cwd: raiz, tiempo: 30000 });
  let res = g(['add', '--', c.rel]);
  if (res.ok) res = g(['commit', '-q', '-m', `cambios: subio-al-kit ${id} (kit ${version})`, '--', c.rel]);
  if (!res.ok) {
    g(['reset', '-q', '--', c.rel]);
    try {
      escribirAtomico(c.abs, c.texto);
    } catch (e) {
      /* lo dice el mensaje */
    }
    return no(`git no pudo commitear (${primeraLinea(res.stderr || res.error)}); quedó como estaba`);
  }
  const sha = L.git.texto(['rev-parse', '--short', 'HEAD'], { cwd: raiz }) || '?';
  return { codigo: 0, lineas: [`cambios: subio-al-kit ${id} · kit ${version} · commit ${sha}`] };
}

// ---------------------------------------------------------------- aprobar (el OK de Guido; RF-3)

// La última ficha que se lee de la rama vigente (hasta 20 commits atrás), para el mensaje de ficha rota. → sha corto o null.
function ultimaFichaQueSeLee(L, raiz, ref) {
  const t = L.git.texto(['rev-list', '-n', '20', ref, '--', L.contexto.RUTA_FICHA], { cwd: raiz });
  for (const sha of (t || '').split('\n').filter(Boolean)) {
    const b = L.git.correr(['cat-file', 'blob', `${sha}:${L.contexto.RUTA_FICHA}`], { cwd: raiz });
    if (!b.ok) continue;
    try {
      L.ficha.leer(b.salida.toString('utf8'));
      return sha.slice(0, 12);
    } catch (e) {
      /* rota también: más atrás */
    }
  }
  return null;
}

// En este orden, y se niega SIN ESCRIBIR NADA con: rol que no es humano; fuera del checkout principal; fuera de la rama por
// defecto; el archivo del cambio sin commitear (o con cambios); un cambio que no es propuesto 3-barrera; la ficha rota; un merge a
// medias; un renglón que no se puede sellar. frenos.log sucio no traba (r4-5): su commit lo lleva como esté.
function aprobar(L, raiz, id, ahora = new Date()) {
  const C = L.cambios;
  const X = L.contexto;
  const no = (m) => ({ codigo: 1, lineas: [`cambios aprobar: no — ${m}`] });

  const rol = X.rol(raiz);
  if (rol !== 'humano') return no(`esta carpeta es de un agente (.kit-rol: ${rol}): aprobar lo corre solo una persona, desde su checkout principal`);
  if (!X.principal(raiz)) return no('esto no es el checkout principal (es un worktree): aprobar se corre desde la carpeta principal del proyecto');
  const rama = X.rama(raiz);
  const porDefecto = X.ramaPorDefecto(raiz);
  if (!porDefecto || rama !== porDefecto) return no(`el checkout no está en la rama por defecto${porDefecto ? ` (${porDefecto})` : ''}: pasate a ella y volvé a correrlo`);

  const r = cambio(L, raiz, id);
  if (r.problema) return no(r.problema);
  const c = r.c;
  const enHead = L.git.correr(['cat-file', 'blob', `HEAD:${c.rel}`], { cwd: raiz });
  if (!enHead.ok) return no(`${c.rel} no está commiteado: commitealo antes (cambios nuevo ya lo hace)`);
  const st = L.git.correr(['status', '--porcelain', '-z', '--', c.rel], { cwd: raiz });
  if (!st.ok || st.stdout !== '' || enHead.salida.toString('utf8').replace(/\r\n/g, '\n') !== c.texto.replace(/\r\n/g, '\n')) {
    return no(`${c.rel} tiene cambios sin commitear: lo que se aprueba es lo commiteado`);
  }
  const d = c.datos;
  if (d.estado !== 'propuesto' || d.clase !== '3-barrera') return no(`es ${d.estado}, clase ${d.clase}: se aprueba solo un propuesto 3-barrera`);
  const fallas = C.validar(d, c.cuerpo);
  if (fallas.length) return no(`${fallas[0].que} — corré verificar`);

  const fv = X.fichaVigente(raiz);
  if (fv.estado === 'rota') {
    const ultima = ultimaFichaQueSeLee(L, raiz, fv.ref);
    return no(`ficha rota: ${fv.donde} — corré doctor; ${ultima ? `la última que se lee: git show ${ultima}:${X.RUTA_FICHA}` : 'no hay ninguna anterior que se lea'}`);
  }
  if (mergeAMedias(L, raiz)) return no('hay un merge a medio hacer: terminá el merge primero');
  const ignorado = L.git.correr(['check-ignore', '-q', '--', L.frenosLog.RUTA], { cwd: raiz });
  if (ignorado.ok) return no(`${L.frenosLog.RUTA} está ignorado en .gitignore: el sello necesita que se commitee, sacalo de ahí`);

  // Todo lo que se va a escribir, armado y releído ANTES de escribir.
  const datosRenglon = { id: C.ID_APROBAR, herramienta: C.HERRAMIENTA_APROBAR, detalle: id, rol, rama };
  const freno = L.frenosLog.renglon(datosRenglon, ahora);
  if (/["\\]/.test(freno)) return no('el renglón de frenos.log trae " o \\ (¿la rama?): así no se puede sellar');
  const m = marcas(L, raiz);
  const sello = {
    sesion: m.length ? m[0].nombre : 'sin-marca',
    fecha: L.frenosLog.fechaConZona(ahora),
    carpeta: X.carpetaRelativa(raiz),
    rol,
    hash: C.hashSello(c.texto),
    freno,
  };
  if (sello.carpeta !== '.') return no('esto no es el checkout principal');
  const nuevoTexto = C.ponerCampos(c.texto, { estado: 'aprobado', aprobo: C.textoSello(sello) });
  const leido = C.leer(nuevoTexto);
  const s2 = leido.datos.aprobo;
  if (C.validar(leido.datos, leido.cuerpo).length || C.hashSello(nuevoTexto) !== sello.hash || !s2 || s2.freno !== freno || s2.fecha !== sello.fecha) {
    return no('el sello no se relee igual: así no se escribe');
  }

  // Escribir: el cambio, el renglón y SU commit, solo con esos dos archivos. Si el commit falla, se vuelve todo atrás.
  const absLog = L.frenosLog.rutaAbsoluta(raiz);
  let tamLog = null;
  try {
    tamLog = fs.statSync(absLog).size;
  } catch (e) {
    /* no había frenos.log */
  }
  const g = (args) => L.git.correr(args, { cwd: raiz, tiempo: 30000 });
  const volverAtras = () => {
    g(['reset', '-q', '--', c.rel, L.frenosLog.RUTA]);
    try {
      escribirAtomico(c.abs, c.texto);
    } catch (e) {
      /* lo dice el mensaje */
    }
    try {
      if (tamLog === null) fs.unlinkSync(absLog);
      else fs.truncateSync(absLog, tamLog);
    } catch (e) {
      /* lo dice el mensaje */
    }
  };
  let escrito;
  try {
    escribirAtomico(c.abs, nuevoTexto);
    escrito = L.frenosLog.anotar(raiz, datosRenglon, ahora);
  } catch (e) {
    volverAtras();
    return no('no se pudo escribir el cambio o frenos.log; quedó como estaba');
  }
  if (escrito !== freno) {
    volverAtras();
    return no('el renglón escrito no es el del sello; quedó como estaba');
  }
  let res = g(['add', '--', c.rel, L.frenosLog.RUTA]);
  if (res.ok) res = g(['commit', '-q', '-m', `cambios: aprobado ${id}`, '--', c.rel, L.frenosLog.RUTA]);
  if (!res.ok) {
    volverAtras();
    return no(`git no pudo commitear (${primeraLinea(res.stderr || res.error)}); quedó como estaba`);
  }
  const sha = L.git.texto(['rev-parse', '--short', 'HEAD'], { cwd: raiz }) || '?';
  return { codigo: 0, lineas: [`cambios: aprobado ${id} · hash ${sello.hash.slice(0, 8)} · commit ${sha}`] };
}

// ---------------------------------------------------------------- principal

function main(argv, opciones = {}) {
  const salida = opciones.salida || ((s) => process.stdout.write(s));
  const error = opciones.error || ((s) => process.stderr.write(s));
  const entradaEstandar = opciones.entradaEstandar || (() => fs.readFileSync(0, 'utf8'));
  let r;
  try {
    const a = leerArgumentos(argv);
    const L = libs();
    const raiz = L.contexto.raiz(opciones.cwd || process.cwd());
    if (!raiz) {
      r = { codigo: 1, lineas: ['cambios: no estás dentro de un repo git'] };
    } else {
      const [p1, p2] = a.pos;
      switch (a.comando) {
        case 'nuevo':
          r = nuevo(L, raiz, a.banderas, entradaEstandar);
          break;
        case 'listar':
          r = listar(L, raiz, a.sueltas[0] || null);
          break;
        case 'verificar':
          r = verificar(L, raiz);
          break;
        case 'anotar-sha':
          r = anotarSha(L, raiz, p1, p2, Object.prototype.hasOwnProperty.call(a.banderas, '--aplico') ? a.banderas['--aplico'] : null);
          break;
        case 'rechazar':
          r = rechazar(L, raiz, p1, p2);
          break;
        case 'aprobar':
          r = aprobar(L, raiz, p1, opciones.ahora);
          break;
        case 'subio-al-kit':
          r = subioAlKit(L, raiz, p1, p2);
          break;
        default:
          malLlamado(`Comando desconocido: ${a.comando}`);
      }
    }
  } catch (e) {
    if (e instanceof MalLlamado) {
      error(`${e.message}\n${USO}\n`);
      return 2;
    }
    salida(`${ROTO}\n`);
    return 1;
  }
  if (r.lineas.length) salida(`${r.lineas.join('\n')}\n`);
  return r.codigo;
}

if (require.main === module) {
  let codigo = 1;
  try {
    codigo = main(process.argv.slice(2));
  } catch (e) {
    try {
      process.stdout.write(`${ROTO}\n`);
    } catch (e2) {
      /* nada más que hacer: la salida 1 frena igual */
    }
  }
  process.exitCode = codigo;
}

module.exports = { USO, ROTO, leerArgumentos, libs, main, aprobar, marcas };
