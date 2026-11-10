'use strict';
// zona-propia.cjs — la zona propia (E §5; SPEC-paquete-2 P3.2, D2.2 F2): lo que escribió el proyecto y el molde no pisa.
// Tres formas, según la pieza: en los textos, lo que va entre <!-- kit:propio --> y <!-- /kit:propio -->; en los hooks, el
// hermano <nombre>.propio.sh; en settings.json, la mezcla A TRES PUNTAS POR REGLA (molde viejo, molde nuevo, proyecto).
// Funciones puras: leen texto o datos y devuelven datos. NO escriben archivos (eso es del que llama, atómico, E §6.4).
// Ante la duda no se toca: una marca rota, una clave repetida o un JSON que no abre dan { ok: false, problema } y nada más.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".

const path = require('path');
const { hash } = require('./ficha.cjs');

const MARCA_ABRE = '<!-- kit:propio -->';
const MARCA_CIERRA = '<!-- /kit:propio -->';

const tiene = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const AUSENTE = Symbol('ausente');

// ---------------------------------------------------------------- textos

// Parte en renglones (CRLF -> LF) y ubica las zonas. Adentro los índices son 0-based; afuera se dan 1-based.
// Una marca vale sola en su renglón (trim: espacios y tabs alrededor); metida en una línea de texto no es marca.
function analizar(texto) {
  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  const zs = [];
  let abierta = -1;
  for (let i = 0; i < lineas.length; i++) {
    const t = lineas[i].trim();
    if (t === MARCA_ABRE) {
      if (abierta >= 0) {
        return { lineas, linea: i + 1, problema: `zona anidada: se abre otra antes de cerrar la del renglón ${abierta + 1} — cerrá la primera con ${MARCA_CIERRA}` };
      }
      abierta = i;
    } else if (t === MARCA_CIERRA) {
      if (abierta < 0) return { lineas, linea: i + 1, problema: `cierre sin apertura — falta ${MARCA_ABRE} antes, o sobra este cierre` };
      zs.push({ a: abierta, c: i });
      abierta = -1;
    }
  }
  if (abierta >= 0) return { lineas, linea: abierta + 1, problema: `apertura sin cierre — falta ${MARCA_CIERRA} después` };
  return { lineas, zonas: zs };
}

// zonas(texto) → { ok: true, zonas: [{desde, hasta, contenido}] } (renglones de las marcas; contenido = lo de adentro, con LF)
// o { ok: false, problema, linea }.
function zonas(texto) {
  const r = analizar(texto);
  if (r.problema) return { ok: false, problema: r.problema, linea: r.linea };
  return {
    ok: true,
    zonas: r.zonas.map(({ a, c }) => ({ desde: a + 1, hasta: c + 1, contenido: r.lineas.slice(a + 1, c).join('\n') })),
  };
}

// El molde nuevo, con el contenido de cada zona del proyecto en la zona del mismo número (por orden: las zonas no tienen nombre).
// Sale con LF. Si cualquiera de los dos tiene una marca rota, o no tienen la misma cantidad de zonas, no se adivina.
function mezclarTexto(moldeNuevo, proyecto) {
  const m = analizar(moldeNuevo);
  const p = analizar(proyecto);
  if (m.problema) return { ok: false, problema: `el molde nuevo, renglón ${m.linea}: ${m.problema}` };
  if (p.problema) return { ok: false, problema: `el proyecto, renglón ${p.linea}: ${p.problema}` };
  if (m.zonas.length !== p.zonas.length) {
    return {
      ok: false,
      problema: `el molde nuevo trae ${m.zonas.length} zona(s) propia(s) y el proyecto ${p.zonas.length}: no se sabe qué va dónde — juntalas a mano`,
    };
  }
  const out = [];
  let desde = 0;
  m.zonas.forEach((z, i) => {
    const q = p.zonas[i];
    out.push(...m.lineas.slice(desde, z.a + 1), ...p.lineas.slice(q.a + 1, q.c));
    desde = z.c;
  });
  out.push(...m.lineas.slice(desde));
  return { ok: true, texto: out.join('\n') };
}

// ficha.hash del texto con lo de ADENTRO de cada zona vaciado (las marcas quedan): el hash dice qué molde se escribió, y lo
// propio no lo mueve. Con una marca rota, el hash del texto entero: no explota, y el guardia lo verá distinto.
function hashPieza(texto) {
  const s = Buffer.isBuffer(texto) ? texto.toString('utf8') : String(texto);
  const r = analizar(s);
  if (r.problema) return hash(s);
  const out = [];
  let desde = 0;
  for (const z of r.zonas) {
    out.push(...r.lineas.slice(desde, z.a + 1));
    desde = z.c;
  }
  out.push(...r.lineas.slice(desde));
  return hash(out.join('\n'));
}

// ---------------------------------------------------------------- hooks

// El hermano de un hook: session-start.cjs → session-start.propio.sh, en la misma carpeta. Solo el de arranque lo corre (D2.1);
// los que niegan y el de escritura no (F2 ⚠️: un .propio.sh que imprime un allow destrabaría un freno sin pasar por barreras).
function rutaPropia(rutaHook) {
  const r = String(rutaHook);
  return path.join(path.dirname(r), `${path.basename(r, path.extname(r))}.propio.sh`);
}

// ---------------------------------------------------------------- JSON sin duplicados

// El renglón (1-based) de una posición del texto.
function renglon(s, pos) {
  let n = 1;
  for (let i = 0; i < pos; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Recorre un JSON YA VALIDADO por JSON.parse y devuelve la primera clave repetida en un mismo objeto, o null.
// Las claves se comparan decodificadas ("a" y "a" son la misma, como para JSON.parse).
function buscarDuplicada(s) {
  let i = 0;
  const BLANCOS = ' \t\n\r';
  const blanco = () => {
    while (i < s.length && BLANCOS.includes(s[i])) i++;
  };
  const cadena = () => {
    const ini = i++;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1; // con tope: nunca un bucle sin fin
    i++;
    return JSON.parse(s.slice(ini, i));
  };
  const valor = (donde) => {
    blanco();
    const c = s[i];
    if (c === '{') {
      i++;
      blanco();
      if (s[i] === '}') return (i++, null);
      const vistas = new Set();
      for (;;) {
        blanco();
        const pos = i;
        const k = cadena();
        if (vistas.has(k)) return { clave: k, donde, linea: renglon(s, pos) };
        vistas.add(k);
        blanco();
        i++; // los dos puntos
        const d = valor(donde ? `${donde}.${k}` : k);
        if (d) return d;
        blanco();
        if (s[i++] === '}') return null; // si no, era una coma
      }
    }
    if (c === '[') {
      i++;
      blanco();
      if (s[i] === ']') return (i++, null);
      for (let n = 0; ; n++) {
        const d = valor(`${donde}[${n}]`);
        if (d) return d;
        blanco();
        if (s[i++] === ']') return null;
      }
    }
    if (c === '"') return (cadena(), null);
    while (i < s.length && !',]} \t\n\r'.includes(s[i])) i++; // número, true, false, null
    return null;
  };
  return valor('');
}

// { ok: true, valor } o { ok: false, problema }. Acepta lo que acepta JSON.parse (más un BOM al principio, que no es contenido) y
// además NIEGA una clave repetida en el mismo objeto, a cualquier profundidad: JSON.parse se queda con la última sin avisar, y
// mezclar sobre eso borraría en silencio lo que el proyecto escribió primero.
function leerJsonSinDuplicados(texto) {
  const s = String(texto).replace(/^\uFEFF/, '');
  let valor;
  try {
    valor = JSON.parse(s);
  } catch (e) {
    return { ok: false, problema: `el JSON no abre (${e.message}) — corregilo a mano; así no se toca` };
  }
  let dup;
  try {
    dup = buscarDuplicada(s);
  } catch (e) {
    return { ok: false, problema: `no se pudo revisar si hay claves repetidas (${e.message}) — así no se toca` };
  }
  if (dup) {
    return {
      ok: false,
      problema: `clave "${dup.clave}" repetida en ${dup.donde || 'la raíz'} (renglón ${dup.linea}): JSON.parse se queda con la última sin avisar — dejá una sola`,
    };
  }
  return { ok: true, valor };
}

// ---------------------------------------------------------------- settings: reglas

const LISTAS = ['allow', 'ask', 'deny'];

// Los ids se NORMALIZAN (red team r5-4): sin comillas dobles y con \ → /. Así un id de frenos.quitados escrito a mano (la
// gramática de la ficha no deja comillas ni \ adentro de un texto) casa con la regla: `node "$CLAUDE_PROJECT_DIR/x.cjs"` y
// `node $CLAUDE_PROJECT_DIR/x.cjs` son la misma. Toda comparación de reglas (entre las tres puntas y con quitados) va por id.
const normalizarId = (id) => String(id).replace(/"/g, '').replace(/\\/g, '/');

// El comando de un hook; los de tipo prompt/agent no traen command y se reconocen por su prompt.
const comandoDe = (h) => (typeof h.command === 'string' ? [h.command, ...(Array.isArray(h.args) ? h.args.map(String) : [])].join(' ') : typeof h.prompt === 'string' ? h.prompt : '');
const matcherDe = (g) => (g.matcher == null ? '' : String(g.matcher)); // sin matcher = '' (Claude Code los trata igual)
const idHook = (evento, matcher, h) => normalizarId(`hook:${evento}/${matcher}/${comandoDe(h)}`);

// Las reglas de un settings (valor ya leído): cada texto de permissions.allow|ask|deny y cada hook. Lo que no tiene la forma
// esperada se saltea acá (la mezcla lo frena antes con forma()).
function reglas(settings) {
  const out = [];
  const s = esMapa(settings) ? settings : {};
  const perm = esMapa(s.permissions) ? s.permissions : {};
  for (const tipo of LISTAS) {
    for (const texto of Array.isArray(perm[tipo]) ? perm[tipo] : []) {
      if (typeof texto === 'string') out.push({ id: normalizarId(`${tipo}:${texto}`), tipo, texto });
    }
  }
  const hooks = esMapa(s.hooks) ? s.hooks : {};
  for (const evento of Object.keys(hooks)) {
    (Array.isArray(hooks[evento]) ? hooks[evento] : []).forEach((g, grupo) => {
      if (!esMapa(g) || !Array.isArray(g.hooks)) return;
      const matcher = matcherDe(g);
      for (const h of g.hooks) {
        if (esMapa(h)) out.push({ id: idHook(evento, matcher, h), tipo: 'hook', evento, matcher, comando: comandoDe(h), grupo, entrada: h });
      }
    });
  }
  return out;
}

// Lo que la mezcla necesita para no adivinar. null = está bien.
function forma(v) {
  if (!esMapa(v)) return 'no es un objeto { … }';
  if (tiene(v, 'permissions')) {
    if (!esMapa(v.permissions)) return '"permissions" no es un objeto';
    for (const l of LISTAS) {
      if (tiene(v.permissions, l) && !(Array.isArray(v.permissions[l]) && v.permissions[l].every((t) => typeof t === 'string'))) {
        return `"permissions.${l}" no es una lista de textos`;
      }
    }
  }
  if (tiene(v, 'hooks')) {
    if (!esMapa(v.hooks)) return '"hooks" no es un objeto';
    for (const ev of Object.keys(v.hooks)) {
      if (!Array.isArray(v.hooks[ev])) return `"hooks.${ev}" no es una lista`;
      for (const g of v.hooks[ev]) {
        if (!esMapa(g) || !Array.isArray(g.hooks) || !g.hooks.every(esMapa)) return `un grupo de "hooks.${ev}" no tiene la forma { matcher, hooks: [ … ] }`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- settings: utilidades

// Igualdad de valores JSON: el orden de las claves no importa; el de las listas, sí.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (esMapa(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const igual = (a, b) => canon(a) === canon(b);
const copia = (v) => JSON.parse(JSON.stringify(v));

// Asignar sin que "__proto__" cambie el prototipo: una clave de settings es un dato, nunca código.
function poner(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// Las claves en el orden del molde nuevo y después las propias del proyecto.
const ordenClaves = (n, p) => [...Object.keys(n || {}), ...Object.keys(p || {}).filter((k) => !tiene(n, k))];

function idsQuitados(quitados) {
  return new Set((Array.isArray(quitados) ? quitados : []).map((q) => (typeof q === 'string' ? q : q && q.id)).filter((x) => typeof x === 'string').map(normalizarId));
}

// La serialización estable: dos espacios, LF, salto final. El orden de las claves lo pone el que arma el valor.
function textoSettings(valor) {
  return `${JSON.stringify(valor, null, 2)}\n`;
}

// ---------------------------------------------------------------- settings: la mezcla

// Una clave que no es una regla, a tres puntas. Decisión (F2 deja lugar): la mira el proyecto y no el molde.
// - El proyecto la tiene igual que el molde viejo → no la tocó: manda el nuevo (y si el nuevo ya no la trae, se va).
// - El proyecto la tiene distinta (o el viejo no la traía) → gana el proyecto, aunque sea [] o {}.
// - El proyecto NO la tiene y el viejo sí → la borró a propósito: no vuelve (igual que una regla borrada).
// - Ninguno de los dos la tiene y el nuevo sí → es nueva: entra.
function tresPuntas(ruta, k, V, N, P, inf) {
  const enV = tiene(V, k);
  const enN = tiene(N, k);
  if (tiene(P, k)) {
    if (enV && igual(P[k], V[k])) {
      if (!enN) return (inf.retiradas.push(`clave:${ruta}`), AUSENTE);
      if (!igual(N[k], V[k])) inf.actualizadas.push(`clave:${ruta}`);
      return copia(N[k]);
    }
    if (enN && (!enV || !igual(N[k], V[k])) && !igual(N[k], P[k])) inf.respetadas.push(`clave:${ruta}`);
    return copia(P[k]);
  }
  if (enV) return (enN && inf.respetadas.push(`clave:${ruta}`), AUSENTE);
  if (enN) return (inf.sumadas.push(`clave:${ruta}`), copia(N[k]));
  return AUSENTE;
}

// Una lista de permisos, por regla.
function mezclarLista(tipo, v, n, p, q, inf) {
  const idDe = (t) => normalizarId(`${tipo}:${t}`);
  const enV = new Set(v.map(idDe));
  const enN = new Set(n.map(idDe));
  const res = [];
  for (const t of p) {
    const id = idDe(t);
    if (enV.has(id) && !enN.has(id)) {
      inf.retiradas.push(id); // el molde la sacó y el proyecto la seguía teniendo tal cual
      continue;
    }
    res.push(t);
  }
  const enP = new Set(p.map(idDe));
  for (const t of n) {
    const id = idDe(t);
    if (enP.has(id)) continue;
    if (enV.has(id) || q.has(id)) {
      // la había borrado el proyecto, o está en frenos.quitados (vigente o vencido): no vuelve
      if (!inf.respetadas.includes(id)) inf.respetadas.push(id);
      continue;
    }
    res.push(t);
    enP.add(id);
    inf.sumadas.push(id);
  }
  return res;
}

function mezclarPermisos(V, N, P, q, inf) {
  const v = esMapa(V) ? V : {};
  const n = esMapa(N) ? N : {};
  const p = esMapa(P) ? P : {};
  const res = {};
  for (const k of ordenClaves(n, p)) {
    if (LISTAS.includes(k)) {
      const l = mezclarLista(k, v[k] || [], n[k] || [], p[k] || [], q, inf);
      if (tiene(p, k) || l.length) poner(res, k, l);
    } else {
      const x = tresPuntas(`permissions.${k}`, k, v, n, p, inf);
      if (x !== AUSENTE) poner(res, k, x);
    }
  }
  return P !== undefined || Object.keys(res).length ? res : AUSENTE;
}

// id → { evento, grupo, entrada }, la primera aparición de cada id.
function mapaHooks(h) {
  const m = new Map();
  for (const r of reglas({ hooks: h || {} })) if (!m.has(r.id)) m.set(r.id, { evento: r.evento, grupo: h[r.evento][r.grupo], entrada: r.entrada });
  return m;
}

// Los hooks, por regla. Una entrada del proyecto igual a la del viejo y que el nuevo cambió (timeout, onFailure…) toma la del
// nuevo: el proyecto no la tocó. Una que el nuevo ya no trae se retira solo si el proyecto la tiene IGUAL a la del viejo; si la
// retocó, queda (y se informa como respetada). Un grupo o un evento que quedan vacíos por lo retirado se van; uno que el proyecto
// ya tenía vacío, queda.
function mezclarHooks(V, N, P, q, inf) {
  const hv = mapaHooks(V);
  const hn = mapaHooks(N);
  const hp = mapaHooks(P);
  const p = esMapa(P) ? P : {};
  const res = {};
  for (const ev of Object.keys(p)) {
    const grupos = [];
    for (const g of p[ev]) {
      const entradas = [];
      let retiro = false;
      for (const h of g.hooks) {
        const id = idHook(ev, matcherDe(g), h);
        const viejo = hv.get(id);
        const nuevo = hn.get(id);
        if (viejo && !nuevo) {
          if (igual(h, viejo.entrada)) {
            inf.retiradas.push(id);
            retiro = true;
            continue;
          }
          inf.respetadas.push(id);
        } else if (viejo && nuevo && igual(h, viejo.entrada) && !igual(h, nuevo.entrada)) {
          entradas.push(copia(nuevo.entrada));
          inf.actualizadas.push(id);
          continue;
        }
        entradas.push(copia(h));
      }
      if (retiro && !entradas.length) continue;
      const g2 = {};
      for (const k of Object.keys(g)) poner(g2, k, k === 'hooks' ? entradas : copia(g[k]));
      grupos.push(g2);
    }
    if (p[ev].length && !grupos.length) continue;
    poner(res, ev, grupos);
  }
  for (const [id, { evento, grupo, entrada }] of hn) {
    if (hp.has(id)) continue;
    if (hv.has(id) || q.has(id)) {
      if (!inf.respetadas.includes(id)) inf.respetadas.push(id);
      continue;
    }
    if (!tiene(res, evento)) poner(res, evento, []);
    const destino = res[evento].find((g) => matcherDe(g) === matcherDe(grupo));
    if (destino) destino.hooks.push(copia(entrada));
    else {
      const g2 = {};
      for (const k of Object.keys(grupo)) poner(g2, k, k === 'hooks' ? [copia(entrada)] : copia(grupo[k]));
      res[evento].push(g2);
    }
    inf.sumadas.push(id);
  }
  const final = {};
  for (const ev of ordenClaves(N, p)) if (tiene(res, ev)) poner(final, ev, res[ev]);
  return P !== undefined || Object.keys(final).length ? final : AUSENTE;
}

// mezclarSettings({ viejo, nuevo, proyecto, quitados }) → { ok: true, settings, texto, informe } o { ok: false, problema }.
// viejo, nuevo y proyecto son TEXTOS (pasan por leerJsonSinDuplicados). viejo null = primera instalación (como {}: todo lo del
// nuevo es nuevo). proyecto null = el proyecto no tiene settings.json (como {}). quitados = frenos.quitados de la ficha: se
// mira solo el id, vigente o vencido (lo quitado no vuelve). informe: ids que se sumaron, se retiraron, se respetaron (lo
// quitado o borrado por el proyecto, y las claves donde el proyecto ganó contra un cambio del molde) y se actualizaron (lo que
// el proyecto no había tocado y el molde cambió). Las claves sueltas van en el informe como "clave:<ruta>".
function mezclarSettings({ viejo = null, nuevo, proyecto = null, quitados = [] } = {}) {
  const leidos = [];
  for (const [quien, texto] of [['el molde viejo', viejo], ['el molde nuevo', nuevo], ['el proyecto', proyecto]]) {
    if (texto == null && quien !== 'el molde nuevo') {
      leidos.push({});
      continue;
    }
    if (typeof texto !== 'string') return { ok: false, problema: `${quien}: no llegó un texto — así no se toca` };
    const r = leerJsonSinDuplicados(texto);
    if (!r.ok) return { ok: false, problema: `${quien}: ${r.problema}` };
    const mal = forma(r.valor);
    if (mal) return { ok: false, problema: `${quien}: ${mal} — así no se toca` };
    leidos.push(r.valor);
  }
  const [V, N, P] = leidos;
  const q = idsQuitados(quitados);
  const informe = { sumadas: [], retiradas: [], respetadas: [], actualizadas: [] };
  const settings = {};
  for (const k of ordenClaves(N, P)) {
    let v;
    if (k === 'permissions') v = mezclarPermisos(V.permissions, N.permissions, P.permissions, q, informe);
    else if (k === 'hooks') v = mezclarHooks(V.hooks, N.hooks, P.hooks, q, informe);
    else v = tresPuntas(k, k, V, N, P, informe);
    if (v !== AUSENTE) poner(settings, k, v);
  }
  return { ok: true, settings, texto: textoSettings(settings), informe };
}

// Un settings como valor: el objeto tal cual, o el texto leído sin duplicados (si no abre, tira con el problema).
function comoValor(x, quien) {
  if (x == null) return {};
  if (typeof x !== 'string') return x;
  const r = leerJsonSinDuplicados(x);
  if (!r.ok) throw new Error(`${quien}: ${r.problema}`);
  return r.valor;
}

// Las reglas del molde (por id) que faltan en el proyecto sin estar en frenos.quitados. molde y proyecto: valor o texto.
// Es lo que dice si el proyecto sigue teniendo lo del molde (el hash de piezas.settings dice solo qué molde se escribió).
function desviosSettings({ molde, proyecto, quitados = [] } = {}) {
  const m = comoValor(molde, 'el molde');
  const ids = new Set(reglas(comoValor(proyecto, 'el proyecto')).map((r) => r.id));
  const q = idsQuitados(quitados);
  const vistos = new Set();
  return reglas(m).filter((r) => {
    if (ids.has(r.id) || q.has(r.id) || vistos.has(r.id)) return false;
    vistos.add(r.id);
    return true;
  });
}

module.exports = {
  MARCA_ABRE,
  MARCA_CIERRA,
  normalizarId,
  zonas,
  mezclarTexto,
  hashPieza,
  rutaPropia,
  leerJsonSinDuplicados,
  reglas,
  mezclarSettings,
  desviosSettings,
  textoSettings,
};
