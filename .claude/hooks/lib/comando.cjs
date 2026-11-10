'use strict';
// comando.cjs — el recorrido de comandos: parte el texto de un comando de Bash o de PowerShell en los comandos simples que
// de verdad se invocan, para que los hooks miren LO QUE SE INVOCA y no un pedazo de texto (`git commit -m "git stash"` no es un
// stash: es un solo comando, argv ['git','commit','-m','git stash']). Es el port a node del recorrido de Hermes
// (.claude/hooks/bloquear_python_stdin.py y bloquear_git_destructivo.py, CM-64 y CM-65) más PowerShell; SPEC-paquete-3, «Base ·
// lib/comando.cjs». Es el ÚNICO que parte comandos: lo usan git-seguro, sensible, secretos y la medición de los frenos.
// Node estándar, cero dependencias. Es .cjs a propósito: corre igual en proyectos con "type": "module".
//
// NO ES UNA FRONTERA DE SEGURIDAD (Lo que esto no cierra): un comando armado a propósito (alias, variables, base64, scripts
// intermedios, `xargs`, `find -exec`, una expansión de llaves) lo esquiva. Es un freno contra el accidente, y ante la duda
// cada hook decide qué hace con el `incompleto`.
//
// FORMA
//   partir(texto, {ps}) → { comandos: [{argv, redirecciones, asignaciones}], incompleto }
//     Bash por defecto; {ps: true} es PowerShell. Nunca tira: un texto que no se puede partir devuelve lo que se pudo y
//     `incompleto: true` (comilla, `$(` o comilla invertida sin cerrar; `<redir` sin destino; here-string o `<# #>` sin cerrar; o más
//     de MAX_PROFUNDIDAD niveles de `-c` / `$( )` adentro de otros). Un texto que no es string da { comandos: [], incompleto: false }.
//   programa(comando | argv0) → el programa que se invoca: sin ruta, sin .exe/.cmd/.bat/.com y en minúscula
//     (`/usr/bin/git.exe` → 'git', `C:\Program Files\Git\cmd\GIT.EXE` → 'git'). Con '' si no hay.
//   igual(a, b) → comparación sin mayúsculas (PowerShell no las distingue: `Get-Content` = `get-content`).
//   variablesAsignadas(resultado) → Set con los nombres que se asignan en cualquier punto del resultado (ver asignaciones).
//   MAX_PROFUNDIDAD → 4.
//
// QUÉ SALE
//   - argv: las palabras ya sin comillas ni escapes, SIN los prefijos que no son el programa (asignaciones `X=1`, `env [-i] [-u N]
//     [X=1…]`, `time`, `nohup`, `sudo`, `doas`, `command`, `exec`, `builtin`, `nice`, `ionice`, `stdbuf`, `chrt`, `timeout <n>`,
//     `setsid`, `unbuffer`, `winpty`, `call`, las palabras de control `if then else do fi done ! { }`, `function f`, y en PowerShell el
//     `&` y el `.` de llamada y `$x =`): argv[0] es lo que se invoca. Si después del prefijo no queda nada (`env`, `sudo`, `time`),
//     el prefijo ES el comando y queda (así «env sin argumentos» se ve). `command -v x` no invoca nada: queda tal cual.
//     Una sustitución (`$(…)`, comilla invertida, `<(…)`) deja `$()` en la palabra; `$VAR` y `${VAR}` quedan como texto.
//   - asignaciones: [{nombre, valor}] de ese comando, en orden: las `X=1` / `X+=1` de delante del programa, las de `env X=1`, las de
//     `export|declare|typeset|readonly|local X=1`, `set X=1` en cmd, `setx X 1` y, en PowerShell, `$x = …`, `$env:X = …`,
//     `Set-Item|New-Item|Set-Content|Add-Content Env:X v` y `Set-Variable|New-Variable X v` (el nombre sin `$` ni ámbito:
//     `$env:X` → 'X'; el valor es el texto tal cual, `$()` si es una sustitución). Una sentencia que solo asigna (`X=1`,
//     `$env:X = '1'`) sale como comando con argv []; `export X=1` sale con su argv propio Y la asignación: así el que llama ve
//     "se exportó X antes, en la misma llamada". Un comando sin asignaciones trae []. Los prefijos se siguen salteando para argv[0].
//     `X=1 cmd` solo es asignación en Bash (en PowerShell es un programa llamado `X=1`); en PowerShell `$x = git stash` asigna Y
//     corre git, y `$x = 1` / `$x = 'a'` / `$x = $y` asignan sin invocar nada. Los nombres van como se escribieron.
//   - redirecciones: {op, destino} en el orden en que están: `>`, `>>`, `<`, `2>`, `&>`, `>|`, `<>`, `<<<` (destino = el texto del
//     here-string, no un archivo), `<<`/`<<-` (destino = la marca del heredoc, no un archivo) y en PowerShell `>`, `>>`, `2>`, `*>`.
//     Duplicar un descriptor (`2>&1`, `>&2`, `<&0`, `>&-`) no toca ningún archivo y NO sale. Un comando que solo redirige
//     (`> archivo`, `X=1 > archivo`) sale con argv [].
//   - lo de adentro sale como comandos simples propios, a continuación del que lo contiene: `( … )`, `{ … }`, `$( … )`, comillas
//     invertidas, `<( … )`, `${x:-$( … )}`, el cuerpo de un heredoc SIN comillar la marca (Bash lo expande: `$(…)` corre), un
//     here-string `@" … "@` de PowerShell, y lo de adentro de `bash|sh|zsh|dash|ksh|ash -c`, `cmd /c`, `powershell|pwsh -Command`,
//     `eval` e `iex` (el comando que invoca al shell sale también). Los comandos `{ … }` y `( … )` no abren nivel.
//   - el cuerpo de un heredoc con la marca comillada (`<<'EOF'`), los comentarios `#` y `<# #>`, y los here-strings `@' '@` son TEXTO.
//
// DECISIONES (cada una con su razón)
//   - La barra invertida de Bash escapa solo lo que el shell trata como especial; ante cualquier otro carácter se queda
//     (`C:\Python314\python.exe` es una ruta de Windows y no debe perder las barras). En PowerShell el escape es la comilla invertida.
//   - `cmd /c` se parte con las reglas de cmd (la `'` no es comilla, la `\` no escapa, `^` sí, `;` no separa): partirlo como Bash
//     se comía el resto del comando con una `'` suelta (`cmd /c "echo it's & git stash"`).
//   - Los `$'…'` de Bash se decodifican (`git $'sta\x73h'` es `git stash`).
//   - `programa()` baja a minúscula siempre: el kit corre en Windows.

const MAX_PROFUNDIDAD = 4;
const SUSTITUCION = '$()';

// ---------------------------------------------------------------- el programa invocado

function programa(x) {
  const palabra =
    typeof x === 'string' ? x : x && Array.isArray(x.argv) && typeof x.argv[0] === 'string' ? x.argv[0] : '';
  return palabra
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, '');
}

const igual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------- lo que cierra y lo que se salta

// Índice de la comilla invertida de Bash que cierra la de s[i] (o -1).
function cierreBacktick(s, i) {
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '`') return k;
  }
  return -1;
}
// Adentro de una comilla invertida solo `\`` , `\\` y `\$` son escapes del shell.
const desescaparBacktick = (t) => t.replace(/\\([`\\$])/g, '$1');

const RE_MARCA = /'([^']*)'|"([^"]*)"|\\?([^\s;|&<>()'"]+)/y;
const RE_HERESTRING = /@(['"])[ \t]*\n/y;

// El `$'…'` de Bash en s[i] ('$') → { texto, fin, cerrada }: fin es el índice que sigue a la comilla que cierra.
const ESCAPES_ANSI = Object.assign(Object.create(null), {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
});
function ansiC(s, i) {
  let k = i + 2;
  let buf = '';
  while (k < s.length) {
    const ch = s[k];
    if (ch === "'") return { texto: buf, fin: k + 1, cerrada: true };
    if (ch === '\\' && k + 1 < s.length) {
      const resto = s.slice(k + 1, k + 11);
      const nx = resto[0];
      let m;
      if (nx in ESCAPES_ANSI) {
        buf += ESCAPES_ANSI[nx];
        k += 2;
      } else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(resto))) {
        buf += String.fromCharCode(parseInt(m[1], 16));
        k += 1 + m[0].length;
      } else if ((m = /^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})/.exec(resto))) {
        buf += String.fromCodePoint(parseInt(m[1] || m[2], 16) % 0x110000);
        k += 1 + m[0].length;
      } else if ((m = /^([0-7]{1,3})/.exec(resto))) {
        buf += String.fromCharCode(parseInt(m[1], 8) & 255);
        k += 1 + m[0].length;
      } else {
        buf += '\\' + nx;
        k += 2;
      }
      continue;
    }
    buf += ch;
    k++;
  }
  return { texto: buf, fin: s.length + 1, cerrada: false };
}

// s[j] es '(' (o el '(' de un `$(`): el índice del ')' que lo cierra, o -1 si no cierra. Una pila de contextos ('(' y '"') en vez
// de recursión: un texto con miles de `"$(` no revienta la pila. Sabe de comillas, comilla invertida, `$'…'`, heredocs de Bash
// (su cuerpo es texto: un `)` suelto no cierra nada), comentarios y here-strings de PowerShell.
function cierreParen(s, j, modo) {
  const ps = modo === 'ps';
  const n = s.length;
  const escape = ps ? '`' : '\\';
  const pila = ['('];
  let pendientes = [];
  let i = j + 1;
  while (i < n) {
    const ch = s[i];
    if (pila[pila.length - 1] === '"') {
      if (ch === escape) i += 2;
      else if (ch === '"') {
        pila.pop();
        i++;
      } else if (ch === '$' && s[i + 1] === '(') {
        pila.push('(');
        i += 2;
      } else if (!ps && ch === '`') {
        const e = cierreBacktick(s, i);
        i = e < 0 ? n : e + 1;
      } else i++;
      continue;
    }
    if (ch === escape) {
      i += 2;
      continue;
    }
    if (!ps && ch === '<' && s[i + 1] === '<') {
      let k = i + 2;
      const guion = s[k] === '-';
      if (guion) k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      RE_MARCA.lastIndex = k;
      const m = RE_MARCA.exec(s);
      if (m) {
        pendientes.push({ guion, delim: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] });
        i = RE_MARCA.lastIndex;
      } else i += 2;
      continue;
    }
    if (ch === '\n' && pendientes.length) {
      i = saltarCuerpos(s, i + 1, pendientes);
      pendientes = [];
      continue;
    }
    if (ch === "'") {
      const k = s.indexOf("'", i + 1);
      i = k < 0 ? n : k + 1;
    } else if (ch === '"') {
      pila.push('"');
      i++;
    } else if (!ps && ch === '`') {
      const e = cierreBacktick(s, i);
      i = e < 0 ? n : e + 1;
    } else if (!ps && ch === '$' && s[i + 1] === "'") {
      i = ansiC(s, i).fin;
    } else if (ps && ch === '@' && (s[i + 1] === "'" || s[i + 1] === '"')) {
      RE_HERESTRING.lastIndex = i;
      const m = RE_HERESTRING.exec(s);
      if (m) {
        const fin = s.indexOf('\n' + m[1] + '@', i + m[0].length - 1);
        i = fin < 0 ? n : fin + 3;
      } else i++;
    } else if (ps && ch === '<' && s[i + 1] === '#') {
      const k = s.indexOf('#>', i + 2);
      i = k < 0 ? n : k + 2;
    } else if (ch === '#' && /[\s;|&(]/.test(s[i - 1])) {
      const k = s.indexOf('\n', i);
      i = k < 0 ? n : k;
    } else if (ch === '(') {
      pila.push('(');
      i++;
    } else if (ch === ')') {
      pila.pop();
      if (pila.length === 0) return i;
      i++;
    } else i++;
  }
  return -1;
}

// Salta los cuerpos de los heredocs pendientes desde i (el inicio de un renglón); devuelve el índice que sigue al último.
// Con `cuerpos`, además junta el texto de cada cuerpo (para los heredocs con la marca sin comillar).
function saltarCuerpos(s, i, pendientes, cuerpos) {
  const n = s.length;
  for (const h of pendientes) {
    const lineas = [];
    while (i < n) {
      const k = s.indexOf('\n', i);
      const linea = k < 0 ? s.slice(i) : s.slice(i, k);
      i = k < 0 ? n : k + 1;
      if ((h.guion ? linea.replace(/^\t+/, '') : linea) === h.delim) break;
      lineas.push(linea);
    }
    if (cuerpos) cuerpos.push({ h, texto: lineas.join('\n') });
  }
  return i;
}

// El '{' de un `${…}` (s[j]) → el índice de su '}' (o -1). Cuenta llaves y salta los `$( )` de adentro. En PowerShell no anida.
function cierreLlave(s, j, modo) {
  const ps = modo === 'ps';
  const n = s.length;
  let prof = 0;
  for (let i = j; i < n; i++) {
    const ch = s[i];
    if (ch === (ps ? '`' : '\\')) i++;
    else if (!ps && ch === '$' && s[i + 1] === '(') {
      const e = cierreParen(s, i + 1, modo);
      if (e < 0) return -1;
      i = e;
    } else if (ch === '{' && !ps) prof++;
    else if (ch === '}') {
      prof--;
      if (prof <= 0) return i;
    }
  }
  return -1;
}

// Busca `$( … )` y comillas invertidas (Bash) en un texto que se expande pero no se parte en palabras (cuerpo de un heredoc sin
// comillar, `${…}`, `arr=( … )`, `@" … "@`) y los suma a `destino` para recorrerlos aparte. Sin saber de comillas: de más, no de menos.
function sustituciones(t, modo, destino, res) {
  const ps = modo === 'ps';
  const n = t.length;
  let i = 0;
  while (i < n) {
    const ch = t[i];
    if (ch === (ps ? '`' : '\\')) i += 2;
    else if (ch === '$' && t[i + 1] === '(') {
      const e = cierreParen(t, i + 1, modo);
      if (e < 0) res.incompleto = true;
      const fin = e < 0 ? n : e;
      destino.push({ texto: t.slice(i + 2, fin), modo });
      i = fin + 1;
    } else if (!ps && ch === '`') {
      const e = cierreBacktick(t, i);
      if (e < 0) res.incompleto = true;
      const fin = e < 0 ? n : e;
      destino.push({ texto: desescaparBacktick(t.slice(i + 1, fin)), modo });
      i = fin + 1;
    } else i++;
  }
}

// ---------------------------------------------------------------- paso 1: del texto a las palabras de cada comando

const RE_REDIR_BASH = /(&>>|&>|>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)/y;
const RE_REDIR_PS = /(>>|>&|>)/y;
const RE_REDIR_CMD = /(>>|>&|>|<&|<)/y;
const RE_CORRIDA = {
  bash: /[^\s'"\\$`;|&<>()]+/y,
  ps: /[^\s'"`$;|&<>(){}#@]+/y,
  cmd: /[^\s"^&|<>()]+/y,
};
const RE_CORRIDA_DQ = /[^"\\$`]+/y;
const RE_CORRIDA_DQ_PS = /[^"`$]+/y;
const ESCAPABLES = new Set([...' \t"\'$`\\;|&<>()#*?[]{}']);
const ESCAPES_PS = { 0: '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

// Devuelve los comandos "crudos": { palabras, citadas, redirs, anid } con anid = [{texto, modo}] de lo que va adentro.
function tokenizar(s, modo, res) {
  const ps = modo === 'ps';
  const cmd = modo === 'cmd';
  const bash = modo === 'bash';
  const n = s.length;
  const crudos = [];
  const heredocs = [];
  let c = { palabras: [], citadas: [], redirs: [], anid: [] };
  let actual = null; // la palabra que se está armando (null: ninguna)
  let comillado = false; // ¿tuvo comillas o escapes? (decide si la marca de un heredoc expande)
  let redir = null; // el operador de redirección que espera su destino
  let i = 0;

  const agregar = (t, comillada) => {
    actual = (actual === null ? '' : actual) + t;
    if (comillada) comillado = true;
  };
  const cerrarPalabra = () => {
    if (actual === null) return;
    if (redir !== null) {
      const sinFd = redir.replace(/^(\d+|\*)/, '');
      if (sinFd === '<<' || sinFd === '<<-') {
        heredocs.push({ guion: sinFd === '<<-', delim: actual, expandible: !comillado, crudo: c });
        c.redirs.push({ op: redir, destino: actual });
      } else if (sinFd.endsWith('&') && /^(\d+|-)$/.test(actual)) {
        // 2>&1, >&2, <&0, >&-: duplica un descriptor, no toca ningún archivo
      } else c.redirs.push({ op: redir, destino: actual });
      redir = null;
    } else {
      c.palabras.push(actual);
      c.citadas.push(comillado);
    }
    actual = null;
    comillado = false;
  };
  const cerrarComando = () => {
    cerrarPalabra();
    if (redir !== null) {
      c.redirs.push({ op: redir, destino: '' });
      redir = null;
      res.incompleto = true;
    }
    if (c.palabras.length || c.redirs.length) crudos.push(c);
    c = { palabras: [], citadas: [], redirs: [], anid: [] };
  };
  // Una sustitución `$( … )` que arranca en s[desde] (el '(' está en s[parenIdx]): la anota y devuelve el índice que sigue.
  const sustitucionParen = (parenIdx, m) => {
    const e = cierreParen(s, parenIdx, m);
    if (e < 0) res.incompleto = true;
    const fin = e < 0 ? n : e;
    c.anid.push({ texto: s.slice(parenIdx + 1, fin), modo: m });
    return fin + 1;
  };
  const sustitucionBacktick = (idx) => {
    const e = cierreBacktick(s, idx);
    if (e < 0) res.incompleto = true;
    const fin = e < 0 ? n : e;
    c.anid.push({ texto: desescaparBacktick(s.slice(idx + 1, fin)), modo });
    return fin + 1;
  };
  // `${…}` en s[idx] = '$': la palabra se queda con el texto crudo; lo de adentro que se ejecuta, aparte.
  const variableLlave = (idx) => {
    const e = cierreLlave(s, idx + 1, modo);
    if (e < 0) res.incompleto = true;
    const fin = e < 0 ? n : e;
    const crudo = s.slice(idx, fin + 1);
    if (!ps) sustituciones(crudo.slice(2, -1), modo, c.anid, res);
    return { crudo, fin: fin + 1 };
  };

  while (i < n) {
    const ch = s[i];

    // continuación de línea y escape de PowerShell
    if (ch === '\\' && bash && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '`' && ps) {
      const nx = s[i + 1];
      if (nx === undefined) {
        agregar('`');
        i++;
      } else if (nx === '\n') i += 2;
      else {
        agregar(nx, true);
        i += 2;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      cerrarPalabra();
      i++;
      continue;
    }
    if (ch === '\n') {
      cerrarComando();
      i++;
      if (heredocs.length) {
        const cuerpos = [];
        i = saltarCuerpos(s, i, heredocs, cuerpos);
        for (const { h, texto } of cuerpos) if (h.expandible) sustituciones(texto, 'bash', h.crudo.anid, res);
        heredocs.length = 0;
      }
      continue;
    }

    // comentarios
    if (!cmd && ch === '#' && actual === null) {
      const k = s.indexOf('\n', i);
      i = k < 0 ? n : k;
      continue;
    }
    if (ps && ch === '<' && s[i + 1] === '#' && actual === null) {
      const k = s.indexOf('#>', i + 2);
      if (k < 0) {
        res.incompleto = true;
        i = n;
      } else i = k + 2;
      continue;
    }

    // here-string de PowerShell: @' … '@ y @" … "@ → un texto opaco (el segundo expande $( ))
    if (ps && ch === '@' && actual === null) {
      RE_HERESTRING.lastIndex = i;
      const m = RE_HERESTRING.exec(s);
      if (m) {
        const ini = i + m[0].length;
        const fin = s.indexOf('\n' + m[1] + '@', ini - 1);
        const cuerpo = fin < 0 ? s.slice(ini) : s.slice(ini, fin);
        if (fin < 0) res.incompleto = true;
        if (m[1] === '"') sustituciones(cuerpo, 'ps', c.anid, res);
        agregar(cuerpo, true);
        i = fin < 0 ? n : fin + 3;
        continue;
      }
    }

    // comillas simples
    if (ch === "'" && !cmd) {
      if (ps) {
        let k = i + 1;
        let buf = '';
        for (;;) {
          const f = s.indexOf("'", k);
          if (f < 0) {
            res.incompleto = true;
            buf += s.slice(k);
            k = n;
            break;
          }
          buf += s.slice(k, f);
          if (s[f + 1] === "'") {
            buf += "'";
            k = f + 2;
            continue;
          }
          k = f + 1;
          break;
        }
        agregar(buf, true);
        i = k;
      } else {
        const f = s.indexOf("'", i + 1);
        if (f < 0) {
          res.incompleto = true;
          agregar(s.slice(i + 1), true);
          i = n;
        } else {
          agregar(s.slice(i + 1, f), true);
          i = f + 1;
        }
      }
      continue;
    }

    // comillas dobles
    if (ch === '"') {
      let k = i + 1;
      let buf = '';
      let cerrada = false;
      const corrida = ps ? RE_CORRIDA_DQ_PS : RE_CORRIDA_DQ;
      while (k < n) {
        const d = s[k];
        if (d === '"') {
          if (ps && s[k + 1] === '"') {
            buf += '"';
            k += 2;
            continue;
          }
          cerrada = true;
          break;
        }
        if (ps && d === '`' && k + 1 < n) {
          const nx = s[k + 1];
          buf += Object.prototype.hasOwnProperty.call(ESCAPES_PS, nx) ? ESCAPES_PS[nx] : nx;
          k += 2;
          continue;
        }
        if (bash && d === '\\' && k + 1 < n) {
          const nx = s[k + 1];
          if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') {
            buf += nx;
            k += 2;
          } else if (nx === '\n') k += 2;
          else {
            buf += d;
            k++;
          }
          continue;
        }
        if (!cmd && d === '$' && s[k + 1] === '(') {
          k = sustitucionParen(k + 1, modo);
          buf += SUSTITUCION;
          continue;
        }
        if (!cmd && d === '$' && s[k + 1] === '{') {
          const v = variableLlave(k);
          buf += v.crudo;
          k = v.fin;
          continue;
        }
        if (bash && d === '`') {
          k = sustitucionBacktick(k);
          buf += SUSTITUCION;
          continue;
        }
        corrida.lastIndex = k;
        const m = corrida.exec(s);
        if (m) {
          buf += m[0];
          k += m[0].length;
        } else {
          buf += d;
          k++;
        }
      }
      if (!cerrada) res.incompleto = true;
      agregar(buf, true);
      i = k + 1;
      continue;
    }

    // el dólar: $( ), ${ }, $'…', $"…"
    if (!cmd && ch === '$') {
      const nx = s[i + 1];
      if (nx === '(') {
        i = sustitucionParen(i + 1, modo);
        agregar(SUSTITUCION);
        continue;
      }
      if (nx === '{') {
        const v = variableLlave(i);
        agregar(v.crudo);
        i = v.fin;
        continue;
      }
      if (bash && nx === "'") {
        const a = ansiC(s, i);
        if (!a.cerrada) res.incompleto = true;
        agregar(a.texto, true);
        i = Math.min(a.fin, n);
        continue;
      }
      if (bash && nx === '"') {
        i++; // $"…" es "…": sigue con la comilla
        continue;
      }
    }
    if (bash && ch === '`') {
      i = sustitucionBacktick(i);
      agregar(SUSTITUCION);
      continue;
    }
    if (bash && (ch === '<' || ch === '>') && s[i + 1] === '(') {
      i = sustitucionParen(i + 1, modo);
      agregar(SUSTITUCION);
      continue;
    }

    // redirecciones (antes que los separadores: `&>` y `2>&1` empiezan con & o con un dígito)
    if (ch === '<' || ch === '>' || (ch === '&' && s[i + 1] === '>')) {
      const re = cmd ? RE_REDIR_CMD : ps ? RE_REDIR_PS : RE_REDIR_BASH;
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) {
        let op = m[1];
        if (actual !== null && !comillado && (/^\d+$/.test(actual) || (ps && actual === '*'))) {
          op = actual + op; // `2>`: el número es el descriptor, no una palabra
          actual = null;
        } else cerrarPalabra();
        redir = op;
        i += m[1].length;
        continue;
      }
    }

    // el escape de Bash fuera de comillas, y el de cmd
    if (bash && ch === '\\') {
      const nx = s[i + 1];
      // tras `<<` el delimitador del heredoc: una barra delante de cualquier carácter lo comilla (`<<\EOF`)
      if (nx !== undefined && (ESCAPABLES.has(nx) || (redir !== null && /^\d*<<-?$/.test(redir)))) {
        agregar(nx, true);
        i += 2;
      } else {
        agregar('\\'); // una barra de ruta de Windows: se queda
        i++;
      }
      continue;
    }
    if (cmd && ch === '^') {
      if (s[i + 1] !== undefined) {
        agregar(s[i + 1], true);
        i += 2;
      } else i++;
      continue;
    }

    // separadores
    if (ch === '&') {
      // `&&` son dos separadores seguidos; en PowerShell el `&` de llamada (`& git stash`) es uno delante de un comando vacío
      cerrarComando();
      i++;
      continue;
    }
    if (ch === '|') {
      cerrarComando();
      i++; // `||` y `|&` son dos separadores seguidos
      continue;
    }
    if (ch === ';' && !cmd) {
      cerrarComando();
      i++; // `;;` también
      continue;
    }
    if (ch === '(' && bash && actual !== null && actual.endsWith('=')) {
      // asignación de arreglo `arr=(a b)`: son datos, no un comando (salvo lo que se sustituya adentro)
      const e = cierreParen(s, i, modo);
      if (e < 0) res.incompleto = true;
      const fin = e < 0 ? n : e;
      sustituciones(s.slice(i + 1, fin), modo, c.anid, res);
      agregar('()');
      i = fin + 1;
      continue;
    }
    if (ch === '(' || ch === ')' || (ps && (ch === '{' || ch === '}'))) {
      cerrarComando();
      i++;
      continue;
    }

    const re = RE_CORRIDA[modo];
    re.lastIndex = i;
    const m = re.exec(s);
    if (m) {
      agregar(m[0]);
      i += m[0].length;
    } else {
      agregar(ch);
      i++;
    }
  }
  cerrarComando();
  return crudos;
}

// ---------------------------------------------------------------- paso 2: quitar los prefijos y ver qué se invoca

const CONTROL = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'fi', 'done']);
const RE_ASIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const RE_ASIGN_PS = /^\$[A-Za-z_][\w:]*[-+*/%]?=/;
const RE_VAR_PS = /^\$[A-Za-z_][\w:]*$/;
// Prefijos que no cambian QUÉ programa corre. `con`: opciones que llevan su valor en la palabra siguiente; `pos`: posicionales que
// van antes del comando (`timeout 5 git …`). xargs NO está: agrega argumentos y le da a su hijo la entrada vacía; es el programa.
const PREFIJOS = new Map([
  ['time', {}], ['nohup', {}], ['builtin', {}], ['winpty', {}], ['call', {}], ['unbuffer', {}], ['setsid', {}],
  ['exec', { con: ['-a'] }],
  ['sudo', { con: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt'] }],
  ['doas', { con: ['-u', '-C'] }],
  ['nice', { con: ['-n', '--adjustment'] }],
  ['ionice', { con: ['-c', '-n', '--class', '--classdata'] }],
  ['stdbuf', { con: ['-i', '-o', '-e'] }],
  ['chrt', { pos: 1 }],
  ['timeout', { con: ['-k', '-s', '--kill-after', '--signal'], pos: 1 }],
]);
const ENV_CON = ['-u', '-C', '--unset', '--chdir'];
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// Desde w[i] (opciones tipo `-x`) → el índice de la primera palabra que no es opción. `--` termina las opciones.
function saltarOpciones(w, i, con) {
  while (i < w.length) {
    const a = w[i];
    if (a === '--') return i + 1;
    if (a[0] !== '-') return i;
    i += con.includes(a) ? 2 : 1;
  }
  return i;
}

// 'X=1' / 'X+=1' → { nombre: 'X', valor: '1' }
function asignacion(palabra) {
  const k = palabra.indexOf('=');
  return { nombre: palabra.slice(0, k).replace(/\+$/, ''), valor: palabra.slice(k + 1) };
}
// '$x' / '$env:X' / '$script:x' → el nombre sin el `$` ni el ámbito: 'x', 'X', 'x'
const nombreVarPs = (v) => v.slice(1).replace(/^.*:/, '');

// Lo que un comando YA pelado asigna sin ser una asignación suelta: `export X=1` y compañía (Bash), `set X=1` (cmd), `setx X 1`,
// y en PowerShell `Set-Item Env:X 1`, `New-Item -Path Env:X -Value 1`, `Set-Variable X 1`. El comando queda tal cual en el argv.
const DECLARA = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const VARIABLES_PS = new Set(['set-variable', 'new-variable']);
const ENTORNO_PS = new Set(['set-item', 'new-item', 'set-content', 'add-content']);
const PARAM_CON_VALOR_PS = /^-(scope|itemtype|option|description|visibility|type|encoding)$/i;
function asignacionesDeArgv(argv, modo) {
  const b = programa(argv[0]);
  const args = argv.slice(1);
  if (modo === 'ps' && (VARIABLES_PS.has(b) || ENTORNO_PS.has(b))) {
    const variable = VARIABLES_PS.has(b);
    let nombre;
    let valor;
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-(path|name|literalpath)$/i.test(a)) nombre = args[++i];
      else if (/^-value$/i.test(a)) valor = args[++i];
      else if (PARAM_CON_VALOR_PS.test(a)) i++;
      else if (a[0] !== '-') pos.push(a);
    }
    if (nombre === undefined) nombre = pos.shift();
    if (valor === undefined) valor = pos.shift();
    if (!variable) {
      if (!/^env:/i.test(nombre)) return []; // Set-Item de un archivo o del registro: no es una variable
      nombre = nombre.slice(4).replace(/^[\\/]/, '');
    }
    return nombre ? [{ nombre, valor: valor === undefined ? '' : valor }] : [];
  }
  if (modo === 'cmd' && b === 'set') {
    const a = args.find((x) => x.includes('='));
    return a && a[0] !== '=' ? [asignacion(a)] : [];
  }
  if (b === 'setx') {
    const [nombre, valor] = args.filter((x) => x[0] !== '/');
    return nombre ? [{ nombre, valor: valor === undefined ? '' : valor }] : [];
  }
  if (DECLARA.has(b)) return args.filter((a) => RE_ASIGN.test(a)).map(asignacion);
  return [];
}

// Las palabras de un comando → { argv, asignaciones }: el argv sin asignaciones, palabras de control ni prefijos (ver la cabecera);
// las asignaciones, las `X=1` de delante del programa y las de `env`, más las de `export X=1`.
function pelar(w, citadas, modo, prof, res) {
  const ps = modo === 'ps';
  const n = w.length;
  const asignaciones = [];
  let i = 0;
  let desde = -1; // dónde empieza el último prefijo pelado: si no queda nada detrás, el comando ES ese prefijo
  while (i < n) {
    const x = w[i];
    const clave = ps ? x.toLowerCase() : x;
    if (CONTROL.has(clave)) {
      i++;
      continue;
    }
    if (ps && x === '.') {
      i++;
      continue;
    }
    if (ps) {
      // `$x=…` (pegado) o `$x = …` (suelto): asigna; lo que sigue al `=` es un valor (`'1'`, `1`, `$y`) y la sentencia no invoca
      // nada, o es un comando (`$x = git stash` lo corre).
      const m = RE_ASIGN_PS.exec(x);
      const suelta = !m && RE_VAR_PS.test(x) && /^[-+*/%]?=$/.test(w[i + 1] === undefined ? '' : w[i + 1]);
      if (m || suelta) {
        const nombre = nombreVarPs(m ? m[0].replace(/[-+*/%]?=$/, '') : x);
        const resto = m ? x.slice(m[0].length) : '';
        const ini = m ? (resto ? i : i + 1) : i + 2; // dónde empieza el valor
        const primero = resto || w[ini];
        asignaciones.push({ nombre, valor: (resto ? [resto, ...w.slice(i + 1)] : w.slice(ini)).join(' ') });
        if (citadas[resto ? i : ini] || /^[\d.$@+-]/.test(primero)) i = n;
        else if (resto) {
          w = w.slice();
          w[i] = resto; // `$x=git stash`: lo que sigue al `=` es el comando
        } else i = ini;
        continue;
      }
    }
    if (!ps && RE_ASIGN.test(x)) {
      asignaciones.push(asignacion(x));
      i++;
      continue;
    }
    if (clave === 'function' && !ps) {
      i += 2; // `function nombre { … }`
      continue;
    }
    const b = programa(x);
    if (b === 'command') {
      if (w[i + 1] === '-v' || w[i + 1] === '-V') break; // pregunta dónde está algo: no lo invoca
      desde = i;
      i++;
      while (i < n && (w[i] === '-p' || w[i] === '--')) i++;
      continue;
    }
    if (b === 'env') {
      desde = i;
      i++;
      while (i < n) {
        const a = w[i];
        if (a === '-S' || a === '--split-string') {
          // env -S 'git stash': el valor es un comando entero
          recorrer([w[i + 1], ...w.slice(i + 2)].join(' '), 'bash', prof + 1, res);
          i = n;
          break;
        }
        // las `X=1` que siguen las pela el ciclo de afuera, que las anota
        if (ENV_CON.includes(a)) i += 2;
        else if (a[0] === '-') i++; // -i, -0, y el `--`
        else break;
      }
      continue;
    }
    const p = PREFIJOS.get(b);
    if (p) {
      desde = i;
      i = saltarOpciones(w, i + 1, p.con || []) + (p.pos || 0);
      continue;
    }
    break;
  }
  const argv = i >= n ? (desde >= 0 ? w.slice(desde) : []) : w.slice(i);
  if (argv.length) asignaciones.push(...asignacionesDeArgv(argv, modo));
  return { argv, asignaciones };
}

const RE_PS_COMANDO = /^[-/](c|co|com|comm|comma|comman|command|commandwithargs)$/i;
const comillar = (x) => (/\s/.test(x) ? `"${x}"` : x);
const unir = (r) => (r.length === 1 ? r[0] : r.map(comillar).join(' '));

// Si el comando invoca un shell o un evaluador, el texto que lleva adentro y cómo se parte: { texto, modo } o null.
function scriptAnidado(argv, modo) {
  const b = programa(argv[0]);
  const args = argv.slice(1);
  if (SHELLS.has(b)) {
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '-o' || a === '+o' || a === '-O' || a === '+O' || a === '--rcfile' || a === '--init-file') {
        j++; // el valor va aparte
      } else if (a.startsWith('-') && !a.startsWith('--') && a.includes('c')) {
        return { texto: args[j + 1], modo: 'bash' }; // sin script (`bash -c` solo): recorrer ignora el texto vacío
      } else if (a[0] !== '-' && a[0] !== '+') break; // el primer posicional es un script: lo de después es suyo
    }
    return null;
  }
  if (b === 'cmd') {
    const j = args.findIndex((a) => ['/c', '//c', '/k', '//k', '/r', '//r'].includes(a.toLowerCase()));
    return j >= 0 ? { texto: unir(args.slice(j + 1)), modo: 'cmd' } : null;
  }
  if (b === 'powershell' || b === 'pwsh') {
    const j = args.findIndex((a) => RE_PS_COMANDO.test(a));
    return j >= 0 ? { texto: unir(args.slice(j + 1)), modo: 'ps' } : null;
  }
  if (b === 'eval') return { texto: args.join(' '), modo };
  if (modo === 'ps' && (b === 'iex' || b === 'invoke-expression')) return { texto: args.join(' '), modo: 'ps' };
  return null;
}

// ---------------------------------------------------------------- el recorrido

function recorrer(texto, modo, prof, res) {
  if (!texto) return;
  if (prof > MAX_PROFUNDIDAD) {
    res.incompleto = true; // hay algo adentro que no se miró
    return;
  }
  for (const c of tokenizar(texto.replace(/\r\n/g, '\n'), modo, res)) {
    const { argv, asignaciones } = pelar(c.palabras, c.citadas, modo, prof, res);
    if (argv.length || c.redirs.length || asignaciones.length) res.comandos.push({ argv, redirecciones: c.redirs, asignaciones });
    for (const a of c.anid) recorrer(a.texto, a.modo, prof + 1, res);
    const anidado = scriptAnidado(argv, modo);
    if (anidado) recorrer(anidado.texto, anidado.modo, prof + 1, res);
  }
}

function partir(texto, opciones) {
  const res = { comandos: [], incompleto: false };
  if (typeof texto !== 'string') return res;
  recorrer(texto, opciones && opciones.ps ? 'ps' : 'bash', 0, res);
  return res;
}

// El conjunto de nombres que se asignan en cualquier punto del resultado: `X=1 cmd`, `env X=1 cmd`, `export X=1`, `$env:X = 'v'`,
// `Set-Item Env:X v`… Los nombres van como se escribieron: PowerShell y Windows no distinguen mayúsculas, así que quien compara
// contra una lista baja a minúscula los dos lados (o usa igual()).
function variablesAsignadas(resultado) {
  const nombres = new Set();
  const comandos = resultado && Array.isArray(resultado.comandos) ? resultado.comandos : [];
  for (const c of comandos) for (const a of (c && c.asignaciones) || []) nombres.add(a.nombre);
  return nombres;
}

module.exports = { partir, programa, igual, variablesAsignadas, MAX_PROFUNDIDAD };
