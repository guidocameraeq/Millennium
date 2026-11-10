'use strict';
// git-seguro.cjs — el hook de git que borra trabajo, falsifica referencias o esquiva el pre-commit (SPEC-paquete-3, P4.4 y
// P4.7; F §6; A §6). PreToolUse sobre Bash y PowerShell. Port de la forma y los casos del hook de Hermes (CM-65), con la falla
// dada vuelta: un error propio FRENA.
//
// QUÉ MIRA: cada comando simple que sale de lib/comando.cjs (lo que se invoca, no un pedazo de texto: `git commit -m "git
// stash"` es un commit). Si el programa es git, salta sus opciones globales (-C, -c, --git-dir, --work-tree, --config-env,
// --no-pager, …) hasta el subcomando y aplica cada fila de la tabla de P4.4. También los no-git de la tabla (taskkill /IM, pkill,
// killall, Stop-Process -Name, y cd/pushd/Set-Location en sesión de agente) y las asignaciones de variables peligrosas.
// Ids: hook:git-seguro/<caso>. Cada fila dice qué frena, qué no y la alternativa (en el mensaje).
//
// REGLAS COMUNES (P4.7)
//   - decidir(entrada, {anotar, memo, git}) → { decision: 'nada' } · { decision: 'ask'|'deny', salida, casos, detalle, renglones }.
//     Tira solo si algo se rompe adentro: principal() lo traduce al deny "freno roto: corré doctor"; si ni eso, sale 2.
//   - Barato cuando no frena: ni la ficha ni git hasta que algo de fábrica frenaría. Las consultas a git que necesita un caso
//     (¿mergeada?, ¿publicado?, core.hooksPath) corren solo cuando el texto ya calzó con ese caso.
//   - frenos.quitados de la ficha vigente: un id hook:git-seguro/<caso> con hasta: vigente apaga ese caso y nada más. Sin
//     ficha, nada quitado. Rota: nada quitado y el motivo suma "ficha rota: <dónde> — corré doctor".
//   - Un renglón en .claude/frenos.log por caso negado (detalle = el caso; un ask: "preguntó: <caso>"). NUNCA el comando.
//   - Texto que comando.cjs marca incompleto: se juzga lo que salió.
//   - Las filas "en sesión de agente" usan lib/agente.cjs. Las demás, todo rol y todo modo (también bypassPermissions).
// ALIAS (rf3-4, rf2-2): `-c alias.*`/`--config-env=alias.*` frenan; guardar uno de shell o con --no-verify/commit -n frena en
// todo rol (las dos formas: `alias.<x>` y `alias.<x>.command`); un `git <x>` con x que no es subcomando de git (con su caja: `git
// STATUS` es un alias) se busca en la config (un `git config --get-regexp`) y se juzga lo que corre.
// NO ES UNA FRONTERA (Lo que esto no cierra): variables, base64, un script, `xargs git`, `find -exec git`, `submodule foreach`
// o `Start-Process git` lo esquivan; la red es el candado.
// Es .cjs a propósito: corre igual en proyectos con "type": "module". NO corre ningún .propio.sh.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HERRAMIENTAS = ['Bash', 'PowerShell'];
const CON_VENTANA = ['default', 'acceptEdits', 'plan', 'auto'];
const PREFIJO = 'hook:git-seguro/';
const ROTO = 'freno roto: corré doctor';

// ---------------------------------------------------------------- los mensajes (qué, por qué y la alternativa)

const MENSAJES = {
  stash:
    '`git stash` saca del árbol el trabajo sin commitear de TODAS las sesiones de este checkout. Alternativa: un commit de trabajo en curso por rutas (`git add -- <rutas>` y `git commit -m "wip: …" -- <rutas>`). `git stash list` y `git stash show` pasan.',
  'reset-hard':
    '`git reset --hard` se lleva puesto el trabajo sin commitear. Alternativa: un commit de trabajo en curso por rutas; para deshacer un commit tuyo sin pushear, `git reset --soft HEAD~1`.',
  'clean-f':
    '`git clean -f` borra archivos sin seguimiento sin vuelta atrás. Mirá con `git clean -n` y borrá por nombre lo que sea tuyo.',
  'restaurar-arbol':
    'restaurar el árbol entero, una carpeta o un patrón (o un checkout/switch forzado) pisa el trabajo sin commitear de otras sesiones. Nombrá el archivo concreto (`git restore -- <archivo>`); para sacar del índice, `git restore --staged <rutas>`.',
  'push-force':
    'un push forzado (`--force`, `-f`, `--force-with-lease`, refspec con `+`) reescribe la historia de origin. Solo se fuerza sobre ramas `kit/*` (ahí: borrala y subila de nuevo). Si origin avanzó: `git pull --rebase` y `git push`.',
  'push-borrar':
    'borrar ramas de origin (`--delete`, `:rama`, `--prune`, `--mirror`) pierde trabajo si no están mergeadas, y la rama por defecto no se borra nunca. Si ya está mergeada pasa; si no, `worktree cerrar` (con `git fetch` antes, para que se vea lo último de origin).',
  'push-punto': '`git push .` mueve refs locales por la puerta de atrás. Usá `git merge` o `git switch` comunes.',
  'push-otra-rama':
    'a esa ref no sube un obrero (ni una sesión de agente): a la rama por defecto sube solo el director (worktree.cjs integrar) o vos desde la carpeta principal; vos pusheás `modulo/<x>--<ID>` (`git push -u origin HEAD` desde tu worktree). Tampoco `--all`, `--branches` ni `--tags`; el pre-push lo frena igual.',
  'update-ref': '`git update-ref` escribe refs a mano (falsifica la historia que leen los frenos). Usá commit, merge o branch.',
  replace: '`git replace` cambia lo que git muestra de un commit sin que se note. No se usa en el kit.',
  'symbolic-ref':
    '`git symbolic-ref` con valor o `-d` mueve HEAD (o una ref) a mano. Para cambiar de rama, `git switch <rama>`; leer (`git symbolic-ref -q HEAD`) pasa.',
  'branch-f':
    'mover o pisar una rama a la fuerza (`branch -f`/`-M`/`-C`, `checkout -B`, `switch -C`) o borrar una sin mergear (`branch -D`) pierde commits. `git branch -d` borra la que ya está mergeada; para una rama nueva, `git switch -c <nombre>`.',
  'fetch-a-remotes':
    'un fetch que escribe en `refs/remotes/*` falsifica lo que dice origin (y la ficha que leen los frenos sale de ahí). Usá `git fetch` sin refspec.',
  'remote-set-head': '`git remote set-head` cambia cuál es la rama por defecto para los frenos. Lo hace Guido a mano.',
  'remote-set-url': '`git remote set-url` cambia a dónde van los push y de dónde sale la ficha. Lo hace Guido a mano.',
  'remote-remove': '`git remote remove` borra el remoto (y con él la ficha vigente). Lo hace Guido a mano.',
  'config-default-branch': '`init.defaultBranch` decide cuál es la rama por defecto para los frenos. Lo cambia Guido a mano.',
  'hooks-path':
    '`core.hooksPath` apaga o desvía el pre-commit, y `core.attributesFile` (o `--attr-source`) cambia qué archivos ve como texto (por `config`, `-c` o `--config-env`). Lo único que pasa es reponer el primero: `git config core.hooksPath .githooks`; los atributos van en el `.gitattributes` del repo, a la vista.',
  'hooks-path-ausente':
    'este repo tiene `.githooks/` pero `core.hooksPath` no apunta ahí: el pre-commit no correría: reponelo: `git config core.hooksPath .githooks`, y repetí.',
  'variables-peligrosas':
    'esa variable cambia qué repo, qué config (también `HOME`/`XDG_CONFIG_HOME`: otra config global) o qué programa usa git (esquiva los frenos y el pre-commit). Corré git sin ella. `GIT_EDITOR`, `GIT_PAGER`, `GIT_SEQUENCE_EDITOR`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` y `GIT_TERMINAL_PROMPT` pasan.',
  'config-include':
    '`include.*`/`includeIf.*` mete config de otro archivo (puede apagar los hooks). No se escribe desde una sesión; si hace falta, Guido a mano.',
  'config-agente':
    'en una sesión de agente no se escribe la config de git. En vez de `pull.rebase`, `git pull --rebase` (o `--no-rebase`); en vez de `push.autoSetupRemote`, `git push -u origin HEAD`; `safe.directory` lo pone Guido; la identidad en un clon de prueba, por comando: `git -c user.name=… -c user.email=… commit`. `core.longpaths` y `rerere.*` pasan.',
  plomeria:
    'plomería de git (objetos, índice o remotos a mano) desde una sesión de agente. Usá los comandos comunes: add, commit, merge; el remoto lo arma el director.',
  'no-verify':
    '`--no-verify` (o `commit -n`) esquiva el pre-commit. Si el pre-commit frena, se arregla lo que dice; una falsa alarma del escáner va a `.gitleaksignore` (pide aprobado). `push -n` es `--dry-run` y pasa.',
  alias:
    'un alias de git esconde el comando de verdad (`-c alias.x=…` o `--config-env=alias.…` en la llamada; o guardar uno de shell `!…`, con `--no-verify`, con `commit -n` o con `-c` de hooks). Escribí el comando entero: `git push`, `git commit -m …`. Un alias común (`git config alias.st status`) pasa.',
  'rm-forzado':
    '`git rm -f` sobre `.`, una carpeta o un patrón borra cambios sin commitear de todo ese árbol. Commiteá antes lo que sea tuyo y nombrá los archivos (`git rm <archivo>`); para dejar de seguir algo sin borrarlo, `git rm --cached`.',
  'red-de-rescate':
    'vencer ya los objetos sueltos o el reflog (`gc --prune=now`, `prune`, `reflog expire --expire=now`, `reflog delete`, `gc.*Expire` cortos) borra la red que rescata un commit o un stash perdido. `git gc` a secas pasa (respeta las dos semanas y los 90 días).',
  'rama-huerfana':
    'una rama sin padre (`checkout --orphan`, `switch --orphan`, `worktree add --orphan`) se sube sin que el candado juzgue su raíz. Desde una sesión de agente se trabaja sobre la rama que te dieron; para una nueva, `git switch -c <nombre>`. Si hace falta una huérfana, la crea Guido o el director.',
  'worktree-remove-force':
    '`git worktree remove -f` borra un worktree con trabajo sin commitear. Commiteá o mirá su `git status`; después `git worktree remove` sin `-f`.',
  'matar-por-nombre':
    'matar por nombre (`taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`) mata los procesos de TODAS las sesiones. Matá por PID: `taskkill /PID <n>`, `kill <pid>`, `Stop-Process -Id <n>`.',
  'update-index':
    '`--skip-worktree`/`--assume-unchanged` esconden cambios de `git status` y del pre-commit. Si un archivo no va, `.gitignore`; `--no-skip-worktree`, `--no-assume-unchanged` y `--chmod` pasan.',
  'historia-defecto':
    'reescribir la rama por defecto (reset/rebase) tiraría commits que ya están en origin. Para deshacer lo publicado, `git revert <commit>`. `reset --soft HEAD~1` de lo tuyo sin pushear, `pull --rebase`, `rebase origin/<defecto>` y `--continue`/`--abort` pasan.',
  'historia-defecto-sin-remoto':
    'sin remoto no se puede saber si esos commits de la rama por defecto ya los tiene otra PC o alguien más. Confirmá solo si son tuyos y no salieron de esta PC; para deshacer lo publicado, `git revert <commit>`.',
  'salir-del-worktree':
    'desde una sesión de agente se trabaja en el propio worktree: ni el principal ni otro repo (ni por `cd`, `-C`, `--git-dir` o `--work-tree`, ni con un `.git` que apunta a otro lado). Quedate en tu worktree; el merge al principal lo hace el director.',
};

// ---------------------------------------------------------------- utilidades

function salida(decision, motivo) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: motivo } };
}

const esOpcion = (a) => typeof a === 'string' && a.length > 1 && a.startsWith('-');
const sinRefsHeads = (r) => r.replace(/^refs\/heads\//, '');

// Las variables que desvían git (D-13, r1-1, r2-6) o lo que corre en sus hooks (rf3-2: GITLEAKS_*; rf3-3: NODE_OPTIONS,
// NODE_PATH; rf2-2: HOME y compañía, que mudan la config global). Las de SOLO_CON_GIT cuentan solo si alcanzan a un git (ver
// alcanzaAGit): `NODE_OPTIONS=… npm run build && git push` es de todos los días (rf2-10).
const SOLO_CON_GIT = new Set(['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']);
function esPeligrosa(nombre) {
  const n = String(nombre).toUpperCase();
  if (n.startsWith('GIT_CONFIG') || n.startsWith('GIT_TRACE') || n.startsWith('GITLEAKS_')) return true;
  if (SOLO_CON_GIT.has(n)) return true;
  return [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_EXEC_PATH',
    'GIT_CURL_VERBOSE',
    'GIT_ATTR_SOURCE',
    'PATH',
  ].includes(n);
}
// ¿Este comando simple es git? Por el nombre del programa sin carpeta ni `.exe` y sin mayúsculas (comando.programa), y también
// sin los escapes de Bash que comando.cjs deja en la palabra (`g\it` es `git` para Bash; rf3-10).
function esGit(x) {
  const comando = require('./lib/comando.cjs');
  if (comando.programa(x) === 'git') return true;
  const a0 = x && Array.isArray(x.argv) && typeof x.argv[0] === 'string' ? x.argv[0] : '';
  return a0.includes('\\') && comando.programa(a0.replace(/\\(.)/gs, '$1')) === 'git';
}
// ¿La asignación de una variable de SOLO_CON_GIT en el comando x alcanza a un git? Sí si es la del mismo git (`NODE_OPTIONS=… git
// commit`); si es suelta o exportada (`export X=…`, `$env:X = …`, `set`, `Set-Item Env:`) o va a un shell que corre otro texto
// (`X=… bash -c "git …"`), cuando hay un git en la llamada. La de delante de otro programa (`X=… npm run build`) es de ese programa.
const ALCANZAN = new Set([
  'export', 'declare', 'typeset', 'readonly', 'local', 'set', 'setx', 'set-item', 'si', 'new-item', 'ni', 'set-variable', 'sv',
  'new-variable', 'nv', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'cmd', 'powershell', 'pwsh', 'eval', 'source', '.',
]);
function alcanzaAGit(lista, x) {
  if (esGit(x)) return true;
  if (x.argv.length && !ALCANZAN.has(require('./lib/comando.cjs').programa(x))) return false;
  return lista.some(esGit);
}
const reEscapar =(s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Una ruta de cd / -C: null si no se puede saber (variables, sustituciones, comodines).
function resolverRuta(base, destino) {
  if (base === null || typeof destino !== 'string') return null;
  let d = destino;
  if (d === '' || /[$`%*?]|\$\(\)/.test(d)) return null;
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(os.homedir(), d.slice(1));
  if (process.platform === 'win32') {
    const m = /^\/([A-Za-z])(\/.*)?$/.exec(d);
    if (m) d = `${m[1].toUpperCase()}:${m[2] || '/'}`;
    else if (/^\/(?!\/)/.test(d)) return null; // /tmp de Git Bash: no se sabe a qué carpeta de Windows va
  }
  try {
    return path.resolve(base, d);
  } catch (e) {
    return null;
  }
}
const esCarpeta = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
};

// ---------------------------------------------------------------- git: opciones globales y subcomando

const GLOBALES_CON_VALOR = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--list-cmds']);

// partirGit(argv) → { dirs, configs: [clave en minúscula], gitDir, workTree, execPath, namespace, attrSource, sub (en minúscula),
// subCrudo (como se tipeó), rest }
function partirGit(argv) {
  const g = { dirs: [], configs: [], gitDir: null, workTree: null, execPath: null, namespace: null, attrSource: null, sub: null, subCrudo: null, previo: argv.slice(0, 1), rest: [] };
  let i = 1;
  const clave = (kv) => String(kv == null ? '' : kv).split('=')[0].trim().toLowerCase();
  while (i < argv.length) {
    const a = argv[i];
    const conIgual = /^(--[a-z-]+)=(.*)$/s.exec(a);
    if (conIgual && GLOBALES_CON_VALOR.has(conIgual[1])) {
      aplicarGlobal(g, conIgual[1], conIgual[2], clave);
      i += 1;
      continue;
    }
    if (GLOBALES_CON_VALOR.has(a)) {
      aplicarGlobal(g, a, argv[i + 1], clave);
      i += 2;
      continue;
    }
    if (/^--exec-path=/.test(a)) {
      g.execPath = a.slice('--exec-path='.length);
      i += 1;
      continue;
    }
    if (esOpcion(a)) {
      i += 1; // --no-pager, -p, --bare, --no-optional-locks, --literal-pathspecs, --version, …
      continue;
    }
    g.sub = a.toLowerCase();
    g.subCrudo = a; // git distingue la caja: `git STATUS` no es status, es el alias `status` (rf2-2)
    g.previo = argv.slice(0, i); // git y sus opciones globales: lo que se conserva al expandir un alias
    g.rest = argv.slice(i + 1);
    break;
  }
  return g;
}
function aplicarGlobal(g, op, valor, clave) {
  if (op === '-C') g.dirs.push(valor == null ? '' : valor);
  else if (op === '-c' || op === '--config-env') g.configs.push(clave(valor));
  else if (op === '--git-dir') g.gitDir = valor == null ? '' : valor;
  else if (op === '--work-tree') g.workTree = valor == null ? '' : valor;
  else if (op === '--namespace') g.namespace = valor == null ? '' : valor;
  else if (op === '--attr-source') g.attrSource = valor == null ? '' : valor;
}

// Los subcomandos que no escriben nada (para el `.git` roto de un worktree de agente). Lo demás, escribe.
const LECTURA = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'grep', 'describe', 'cat-file',
  'rev-list', 'shortlog', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged', 'version', 'help', 'var',
  'check-ignore', 'check-attr', 'diff-tree', 'diff-index', 'diff-files', 'count-objects', 'verify-commit', 'verify-tag',
  'range-diff', 'cherry', 'show-branch', 'check-ref-format', 'get-tar-commit-id', 'annotate', 'reflog',
]);
function esLectura(sub, rest) {
  if (!sub) return true;
  if (sub === 'reflog') return !rest.some((a) => ['expire', 'delete', 'drop'].includes(a));
  if (LECTURA.has(sub)) return true;
  const pos = rest.filter((a) => !esOpcion(a));
  if (sub === 'branch') return !rest.some((a) => /^-(d|D|f|m|M|c|C|u)$|^--(delete|force|move|copy|set-upstream-to|unset-upstream|edit-description)/.test(a)) && (pos.length === 0 || rest.some((a) => /^(--list|-l|--contains|--merged|--no-merged|--points-at|-a|-r|--all|--remotes|-v|-vv)$/.test(a)));
  if (sub === 'tag') return pos.length === 0 || rest.some((a) => /^(-l|--list|-v|--verify)$/.test(a));
  if (sub === 'remote') return pos.length === 0 || ['show', 'get-url'].includes(pos[0]);
  if (sub === 'worktree') return pos[0] === 'list';
  if (sub === 'stash') return ['list', 'show'].includes(pos[0]);
  if (sub === 'config') return !analizarConfig(rest).escribe;
  if (sub === 'symbolic-ref') return pos.length <= 1 && !rest.some((a) => a === '-d' || a === '--delete');
  return false;
}

// ---------------------------------------------------------------- config

// analizarConfig(rest) → { escribe, clave (minúscula o null), valores: [..] }. Las dos sintaxis: la vieja (`config k v`,
// `--unset k`, `--get k`) y la de subcomandos (`config set|unset|get|list|edit|rename-section|remove-section`).
const CONFIG_CON_VALOR = new Set(['--file', '-f', '--blob', '--type', '--default', '--comment', '--value', '--url']);
const CONFIG_LEE = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list']);
const CONFIG_ESCRIBE = new Set(['--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section', '--edit', '-e']);
const CONFIG_SUBS = { list: false, get: false, set: true, unset: true, 'rename-section': true, 'remove-section': true, edit: true };
function analizarConfig(rest) {
  const pos = [];
  let lee = false;
  let escribe = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      pos.push(...rest.slice(i + 1));
      break;
    }
    const base = a.split('=')[0];
    if (CONFIG_CON_VALOR.has(a)) {
      i++;
      continue;
    }
    if (CONFIG_CON_VALOR.has(base)) continue;
    if (CONFIG_LEE.has(base)) lee = true;
    else if (CONFIG_ESCRIBE.has(base)) escribe = true;
    else if (esOpcion(a)) continue;
    else {
      pos.push(a);
      // la sintaxis vieja deja de leer opciones en la primera palabra (`git config alias.x '-c … commit'` guarda ese valor)
      if (pos.length === 1 && !(Object.prototype.hasOwnProperty.call(CONFIG_SUBS, a.toLowerCase()) && !lee && !escribe)) {
        pos.push(...rest.slice(i + 1));
        break;
      }
    }
  }
  if (pos.length && Object.prototype.hasOwnProperty.call(CONFIG_SUBS, pos[0].toLowerCase()) && !lee && !escribe) {
    const s = pos.shift().toLowerCase();
    if (CONFIG_SUBS[s]) escribe = true;
    else lee = true;
    if (s === 'edit') return { escribe: true, clave: null, valores: [] };
  }
  const clave = pos.length ? pos[0].toLowerCase() : null;
  if (!lee && !escribe && pos.length >= 2) escribe = true;
  if (lee && !escribe) return { escribe: false, clave, valores: [] };
  return { escribe, clave, valores: pos.slice(1) };
}
const esIncludeKey = (k) => typeof k === 'string' && (k.startsWith('include.') || k.startsWith('includeif.') || k === 'include' || k === 'includeif');
const LIBRES_EN_AGENTE = (k) => typeof k === 'string' && (k === 'core.longpaths' || k.startsWith('rerere.'));

// `git config core.hooksPath .githooks`, exacto (con --local, que es lo mismo): pasa en todo rol y modo (r2-3).
function esReponerHooksPath(rest) {
  const r = rest.filter((a) => a !== '--local');
  return r.length === 2 && r[0].toLowerCase() === 'core.hookspath' && r[1] === '.githooks';
}

// ---------------------------------------------------------------- alias, --no-verify y la red de rescate (rf3-4, rf3-13)

const esAliasKey = (k) => typeof k === 'string' && k.startsWith('alias.');
// core.hooksPath apaga el pre-commit; core.attributesFile puede marcar como binario lo que el escáner mira (rf2-1).
const esDesvioHooks = (k) => k === 'core.hookspath' || k === 'core.attributesfile';
// gc.pruneExpire, gc.reflogExpire, gc.reflogExpireUnreachable, gc.<patrón>.reflogExpire…: acortarlos apaga la red de rescate.
const esExpireKey = (k) => typeof k === 'string' && /^gc\..*expire/.test(k);

// `--no-verify` en cualquier subcomando; `commit -n` (también `-an`). push -n es --dry-run.
function noVerify(g) {
  const { sub, rest } = g;
  if (rest.some((a) => /^--no-veri(f|fy)?$/.test(a))) return true;
  if (sub !== 'commit') return false;
  // -n suelto o en un grupo (-an); el valor de -m/-F/-C/-c/-t (y sus largos) no es una opción
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (/^(-[mFCct]|--(message|file|reuse-message|reedit-message|template|author|date|fixup|squash|trailer|cleanup))$/.test(a)) {
      i++;
      continue;
    }
    if (letraCorta(a, 'n', 'mFCctSu') === 'n') return true;
  }
  return false;
}

// El valor que se le da a un alias (`git config alias.x <valor>`): de shell (`!`), o con --no-verify / commit -n / opciones
// globales que tocan hooks o alias adentro → el motivo; si no, null. Lo demás lo mira el uso (resolverAlias).
function aliasPeligroso(valor) {
  if (typeof valor !== 'string') return null;
  const v = valor.trim();
  if (v.startsWith('!')) return 'un alias de shell (`!`)';
  const { comandos } = require('./lib/comando.cjs').partir(v, { ps: false });
  const argv = comandos.length ? comandos[0].argv : [];
  if (!argv.length) return null;
  const g = partirGit(['git', ...argv]);
  if (noVerify(g)) return 'un alias con --no-verify o commit -n';
  if (g.execPath !== null || g.attrSource !== null || g.configs.some((k) => esDesvioHooks(k) || esIncludeKey(k) || esAliasKey(k) || esExpireKey(k))) return 'un alias con -c de hooks, include o alias';
  return null;
}

// El valor de una opción larga: null si no está; true si está sola; el texto si va con `=` (o, con `separado`, en la que sigue).
function valorDe(rest, op, separado = true) {
  let v = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a.startsWith(`${op}=`)) v = a.slice(op.length + 1);
    else if (a === op) v = separado && i + 1 < rest.length && !esOpcion(rest[i + 1]) ? rest[++i] : true;
  }
  return v;
}
// ¿Esa fecha de vencimiento se lleva lo de las últimas semanas? (now, all, horas, días, una fecha…) Las de semanas, meses, años o
// never no.
const expiraCorto = (v) => !/^(never|false)$|weeks?|months?|years?/i.test(String(v).trim());

// `git rm -f`/`--force` (sin --cached ni -n) sobre `.`, una carpeta, un comodín o un pathspec mágico: borra cambios sin commitear
// de un árbol entero (CM-65, rf3-11). Un archivo nombrado pasa, como en restaurar-arbol.
function rmForzado(rest, base) {
  let forzado = false;
  const paths = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      paths.push(...rest.slice(i + 1));
      break;
    }
    if (a === '--cached' || a === '--dry-run') return false;
    if (a === '--force') forzado = true;
    else if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) {
      paths.push('*');
      if (a === '--pathspec-from-file') i++;
    } else if (esOpcion(a) && !a.startsWith('--')) {
      if (a.includes('n')) return false;
      if (a.includes('f')) forzado = true;
    } else if (!esOpcion(a)) paths.push(a);
  }
  return forzado && paths.some((p) => esAmplio(p, base));
}

// Los subcomandos de git (`git --list-cmds=main`, 2.54): un alias no los puede tapar (git lo ignora). Cualquier otro puede ser un
// alias ya guardado en la config (.git/config, el global): se lee y se juzga lo que corre de verdad (rf3-4).
const SUBCOMANDOS = new Set(
  ('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap ' +
    'check-ref-format checkout checkout--worker checkout-index cherry cherry-pick citool clean clone column commit commit-graph ' +
    'commit-tree config count-objects credential credential-cache credential-cache--daemon credential-store credential-wincred ' +
    'daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool difftool--helper fast-export fast-import ' +
    'fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc ' +
    'get-tar-commit-id grep gui gui--askpass gui--askyesno gui.tcl hash-object help history hook http-backend http-fetch ' +
    'http-push imap-send index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo ' +
    'mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours merge-recursive ' +
    'merge-recursive-ours merge-recursive-theirs merge-resolve merge-subtree merge-tree mergetool mktag mktree multi-pack-index ' +
    'mv name-rev notes pack-objects pack-redundant pack-refs patch-id pickaxe prune prune-packed pull push quiltimport ' +
    'range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd remote-ftp remote-ftps remote-http ' +
    'remote-https repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack ' +
    'sh-i18n--envsubst shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule ' +
    'submodule--helper subtree survey switch symbolic-ref tag unpack-file unpack-objects update update-index update-ref ' +
    'update-server-info upload-archive upload-archive--writer upload-pack var verify-commit verify-pack verify-tag version ' +
    'web--browse whatchanged worktree write-tree').split(' '),
);
const MAX_ALIAS = 8;

// resolverAlias(g, dir, ctx, hallar) → { g } con el subcomando ya expandido (alias de alias incluidos), o { shell: texto } para
// un alias `!…` (lo juzga quien llama, como un comando más), o { g } igual si no es alias. Solo corre git si el subcomando no es
// de git: lo normal no paga nada. Lee TODOS los alias de una vez (`git config -z --get-regexp ^alias\.`, una llamada) y busca como
// git 2.54 (rf2-2): `alias.<x>` sin importar la caja y `alias.<x>.command` (`[alias "x"] command = …`) con la caja exacta; gana el
// último que aparece. Cualquier nombre (`_`, `.`, mayúsculas): si no está, no es un alias.
function leerAlias(raiz, ctx) {
  const r = ctx.git().correr(['config', '-z', '--get-regexp', '^alias\\.'], { cwd: raiz });
  if (r.error) return null;
  if (!r.ok) return []; // 1: ningún alias; otro código: git mismo falla con esa config
  return r.stdout
    .split('\0')
    .filter((e) => e !== '')
    .map((e) => {
      const k = e.indexOf('\n');
      return k === -1 ? { clave: e, valor: '' } : { clave: e.slice(0, k), valor: e.slice(k + 1) };
    });
}
function buscarAlias(lista, nombre) {
  let hallado = null;
  for (const { clave, valor } of lista) {
    const corta = !nombre.includes('.') && clave.toLowerCase() === `alias.${nombre.toLowerCase()}`;
    if (corta || clave === `alias.${nombre}.command`) hallado = valor;
  }
  return hallado;
}
function resolverAlias(g, dir, ctx, hallar) {
  let actual = g;
  let lista = null;
  for (let n = 0; n < MAX_ALIAS && actual.sub && !SUBCOMANDOS.has(actual.subCrudo); n++) {
    if (lista === null) lista = leerAlias(ctx.raizDe(dir) || ctx.cwd, ctx);
    if (lista === null) {
      hallar('alias', 'deny', `no se pudo leer si ${actual.subCrudo} es un alias`);
      return { g: actual };
    }
    const hallado = buscarAlias(lista, actual.subCrudo);
    if (hallado === null) return { g: actual }; // no es un alias: un git-<algo> externo o un error de tipeo
    const valor = hallado.trim();
    const comillas = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    if (valor.startsWith('!')) return { shell: [valor.slice(1), ...actual.rest.map(comillas)].join(' ') };
    const { comandos } = require('./lib/comando.cjs').partir(valor, { ps: false });
    if (comandos.length !== 1 || !comandos[0].argv.length) {
      hallar('alias', 'deny', `no se pudo leer el alias ${actual.subCrudo}`);
      return { g: actual };
    }
    actual = partirGit([...actual.previo, ...comandos[0].argv, ...actual.rest]);
  }
  return { g: actual };
}

// ---------------------------------------------------------------- restaurar el árbol (port de Hermes, CM-65)

const AMPLIOS = new Set(['.', './', '..', '../', '*', '**', ':/', ':/.', '.\\', '..\\']);
function esAmplio(p, base) {
  if (AMPLIOS.has(p)) return true;
  if (p.startsWith(':/')) {
    const resto = p.slice(2);
    return resto === '' || resto === '.' || /[/\\]$/.test(resto) || /[*?[]/.test(resto);
  }
  if (/^:\(/.test(p)) return true; // pathspec mágico (:(glob)…, :(top)): no es un archivo nombrado
  if (/[/\\]$/.test(p)) return true;
  if (/[*?[]/.test(p)) return true;
  if (base && esCarpeta(path.resolve(base, p))) return true;
  return false;
}
// `-f` entre las letras de un grupo de opciones cortas; `-b`/`-B`/`-c`/`-C` llevan el nombre pegado (`-bfix`).
function forzadoCorto(a) {
  if (!a.startsWith('-') || a.startsWith('--')) return false;
  for (const ch of a.slice(1)) {
    if ('bBcC'.includes(ch)) return false;
    if (ch === 'f') return true;
  }
  return false;
}
// La primera letra de un grupo corto entre `letras` (o null), cortando en las que llevan valor pegado.
function letraCorta(a, letras, conValor = '') {
  if (!a.startsWith('-') || a.startsWith('--') || a.length < 2) return null;
  for (const ch of a.slice(1)) {
    if (letras.includes(ch)) return ch;
    if (conValor.includes(ch)) return null;
  }
  return null;
}

function restaurarArbol(sub, rest, base) {
  if (sub === 'switch') return rest.some((a) => a !== '--' && (a === '--force' || a === '--discard-changes' || forzadoCorto(a)));
  if (sub === 'checkout' && rest.some((a) => a !== '--' && (a === '--force' || forzadoCorto(a)))) return true;
  let paths;
  let staged = false;
  let worktree = false;
  if (rest.includes('--')) {
    const k = rest.indexOf('--');
    paths = rest.slice(k + 1);
    for (const a of rest.slice(0, k)) {
      if (a === '--staged' || letraCorta(a, 'S', 's')) staged = true;
      if (a === '--worktree' || letraCorta(a, 'W', 's')) worktree = true;
      if (/^--pathspec-from-file/.test(a)) paths.push('*');
    }
  } else if (sub === 'checkout') {
    paths = rest.filter((a) => AMPLIOS.has(a) || (a.startsWith(':/') && esAmplio(a, null)));
    const posicionales = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (['-b', '-B', '--orphan', '--conflict'].includes(a)) {
        i++;
        continue;
      }
      if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) {
        paths.push('*');
        if (a === '--pathspec-from-file') i++;
        continue;
      }
      if (esOpcion(a)) continue;
      posicionales.push(a);
    }
    paths.push(...posicionales.slice(1).filter((a) => esAmplio(a, base)));
  } else {
    paths = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-s' || a === '--source') {
        i++;
        continue;
      }
      if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) {
        paths.push('*');
        if (a === '--pathspec-from-file') i++;
        continue;
      }
      if (a === '--staged') staged = true;
      else if (a === '--worktree') worktree = true;
      else if (esOpcion(a) && !a.startsWith('--')) {
        // grupo corto: S, W; `s` lleva la fuente (pegada o en el siguiente)
        const letras = a.slice(1);
        const k = letras.indexOf('s');
        const antes = k === -1 ? letras : letras.slice(0, k);
        if (antes.includes('S')) staged = true;
        if (antes.includes('W')) worktree = true;
        if (k !== -1 && k === letras.length - 1) i++;
        continue;
      }
      if (esOpcion(a)) continue;
      paths.push(a);
    }
  }
  if (!paths.length) return false;
  if (sub === 'restore' && staged && !worktree) return false; // r1-18: sacar del índice no toca el árbol
  return paths.some((p) => esAmplio(p, base));
}

// ---------------------------------------------------------------- el contexto perezoso (git y fs solo si hace falta)

function nuevoContexto(entrada, opciones) {
  const cwd = require('./lib/contexto.cjs').cwdDe(entrada);
  const memo = new Map();
  const una = (k, f) => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k);
  };
  const ctx = {
    cwd,
    opciones,
    modo: typeof entrada.permission_mode === 'string' ? entrada.permission_mode.trim() : '',
    contexto: () => require('./lib/contexto.cjs'),
    git: () => opciones.git || require('./lib/git.cjs'), // opciones.git: solo las pruebas (una falla de git a mano)
    agente: () => require('./lib/agente.cjs'),
    sesion: () => una('sesion', () => ctx.agente().sesionDeAgente(cwd)),
    // la raíz del repo que contiene `dir` (fs), o la del cwd si dir no se sabe
    raizDe: (dir) => una(`raiz:${dir}`, () => ctx.agente().raizDe(dir === null ? cwd : dir)),
    refVigente: (raiz) => una(`rv:${raiz}`, () => ctx.contexto().refVigente(raiz)),
    rama: (raiz) => una(`rama:${raiz}`, () => ctx.contexto().rama(raiz)),
    hayOrigin: (raiz) =>
      una(`origin:${raiz}`, () => {
        const t = ctx.git().texto(['remote'], { cwd: raiz });
        return !!t && t.split('\n').map((s) => s.trim()).includes('origin');
      }),
    resuelve: (raiz, ref) => ctx.git().correr(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: raiz }).ok,
    ancestro: (raiz, a, b) => ctx.git().correr(['merge-base', '--is-ancestor', a, b], { cwd: raiz }),
    contar: (raiz, args) => {
      const t = ctx.git().texto(['rev-list', '--count', ...args], { cwd: raiz });
      return t !== null && /^\d+$/.test(t) ? Number(t) : null;
    },
  };
  return ctx;
}

// ¿`tip` está contenida en origin/<defecto> (o la rama por defecto local, sin remoto) o en `upstream`?
// → true · false · null (no se pudo saber: frena).
function mergeada(ctx, raiz, tip, upstream) {
  const rv = ctx.refVigente(raiz);
  const bases = [];
  if (rv) bases.push(rv.ref);
  if (upstream) bases.push(upstream);
  let supo = false;
  for (const b of bases) {
    const r = ctx.ancestro(raiz, tip, b);
    if (r.ok) return true;
    if (r.codigo === 1 && !r.error) supo = true;
  }
  return supo ? false : null;
}

// ---------------------------------------------------------------- los casos de cada subcomando

// Cada hallazgo: { caso, tipo: 'deny'|'ask', extra (texto que se suma al motivo) }.
function casosGit(g, dir, ctx, hallar) {
  const { sub, rest } = g;
  const base = dir === null ? null : dir;
  const raiz = () => ctx.raizDe(dir) || ctx.raizDe(null) || ctx.cwd;

  // variables equivalentes por opción (--exec-path=, --namespace): mismas que GIT_EXEC_PATH / GIT_NAMESPACE.
  if (g.execPath !== null || g.namespace !== null) hallar('variables-peligrosas', 'deny', g.execPath !== null ? 'opción --exec-path' : 'opción --namespace');
  if (g.attrSource !== null) hallar('hooks-path', 'deny', 'opción --attr-source');
  for (const k of g.configs) {
    if (esDesvioHooks(k)) hallar('hooks-path', 'deny', k);
    if (esIncludeKey(k)) hallar('config-include', 'deny');
    if (esAliasKey(k)) hallar('alias', 'deny', `-c/--config-env ${k}`);
    if (esExpireKey(k)) hallar('red-de-rescate', 'deny', k);
  }

  if (!sub) return;

  if (noVerify(g)) hallar('no-verify', 'deny');

  switch (sub) {
    case 'stash': {
      for (const a of rest) {
        if (a === '-h' || a === '--help') return;
        if (!esOpcion(a)) {
          if (a !== 'list' && a !== 'show') hallar('stash', 'deny');
          return;
        }
      }
      hallar('stash', 'deny');
      return;
    }
    case 'reset': {
      if (rest.includes('--hard')) {
        hallar('reset-hard', 'deny');
        return;
      }
      historia(g, dir, ctx, hallar, 'reset');
      return;
    }
    case 'rebase':
      historia(g, dir, ctx, hallar, 'rebase');
      return;
    case 'clean': {
      let forzado = false;
      let seco = false;
      for (const a of rest) {
        if (a === '--') break;
        if (a === '--force') forzado = true;
        else if (a === '--dry-run') seco = true;
        else if (esOpcion(a) && !a.startsWith('--')) {
          if (a.includes('f')) forzado = true;
          if (a.includes('n')) seco = true;
        }
      }
      if (forzado && !seco) hallar('clean-f', 'deny');
      return;
    }
    case 'checkout':
    case 'switch':
    case 'restore': {
      if (sub === 'checkout' && rest.some((a) => a === '-B' || letraCorta(a, 'B', 'bcC') === 'B')) hallar('branch-f', 'deny');
      if (sub === 'switch' && rest.some((a) => a === '--force-create' || letraCorta(a, 'C', 'c') === 'C')) hallar('branch-f', 'deny');
      if (sub !== 'restore' && rest.some(esOrphan)) enAgente(ctx, () => hallar('rama-huerfana', 'deny', `${sub} --orphan`));
      if (restaurarArbol(sub, rest, base)) hallar('restaurar-arbol', 'deny');
      return;
    }
    case 'commit':
      hooksPathAusente(dir, ctx, hallar);
      return;
    case 'rm':
      if (rmForzado(rest, base)) hallar('rm-forzado', 'deny');
      return;
    case 'gc': {
      const v = valorDe(rest, '--prune');
      if (v !== null && v !== true && expiraCorto(v)) hallar('red-de-rescate', 'deny', `gc --prune=${v}`);
      return;
    }
    case 'prune':
      if (!rest.some((a) => a === '-n' || a === '--dry-run' || letraCorta(a, 'n') === 'n')) {
        const v = valorDe(rest, '--expire');
        if (v === null || v === true || expiraCorto(v)) hallar('red-de-rescate', 'deny', 'git prune');
      }
      return;
    case 'reflog': {
      const pos = rest.filter((a) => !esOpcion(a));
      const s = (pos[0] || '').toLowerCase();
      if (s === 'delete' || s === 'drop') hallar('red-de-rescate', 'deny', `reflog ${s}`);
      else if (s === 'expire') {
        for (const op of ['--expire', '--expire-unreachable']) {
          const v = valorDe(rest, op);
          if (v !== null && v !== true && expiraCorto(v)) hallar('red-de-rescate', 'deny', `reflog expire ${op}=${v}`);
        }
      }
      return;
    }
    case 'merge':
      hooksPathAusente(dir, ctx, hallar);
      return;
    case 'push':
      push(g, dir, ctx, hallar, raiz);
      hooksPathAusente(dir, ctx, hallar);
      return;
    case 'update-ref':
      hallar('update-ref', 'deny');
      return;
    case 'replace':
      hallar('replace', 'deny');
      return;
    case 'symbolic-ref': {
      const pos = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-m') {
          i++;
          continue;
        }
        if (!esOpcion(rest[i])) pos.push(rest[i]);
      }
      if (pos.length >= 2 || rest.some((a) => a === '-d' || a === '--delete')) hallar('symbolic-ref', 'deny');
      return;
    }
    case 'branch':
      branch(rest, dir, ctx, hallar, raiz);
      return;
    case 'fetch': {
      const pos = rest.filter((a) => !esOpcion(a));
      for (const r of pos.slice(1)) {
        const k = r.indexOf(':');
        if (k === -1) continue;
        const dst = r.slice(k + 1);
        if (/^(refs\/)?remotes\//.test(dst)) hallar('fetch-a-remotes', 'deny');
      }
      return;
    }
    case 'remote': {
      const pos = rest.filter((a) => !esOpcion(a));
      const s = (pos[0] || '').toLowerCase();
      if (s === 'set-head') hallar('remote-set-head', 'deny');
      else if (s === 'set-url') hallar('remote-set-url', 'deny');
      else if (s === 'remove' || s === 'rm') hallar('remote-remove', 'deny');
      else if (s === 'add' || s === 'rename') enAgente(ctx, () => hallar('plomeria', 'deny'));
      return;
    }
    case 'config': {
      const c = analizarConfig(rest);
      if (!c.escribe) return;
      if (esReponerHooksPath(rest)) return; // por encima de config-agente (r2-3)
      if (esDesvioHooks(c.clave)) hallar('hooks-path', 'deny', c.clave);
      if (esIncludeKey(c.clave) || c.valores.some(esIncludeKey)) hallar('config-include', 'deny');
      if (c.clave === 'init.defaultbranch') hallar('config-default-branch', 'deny');
      if (esExpireKey(c.clave)) hallar('red-de-rescate', 'deny', c.clave);
      if (esAliasKey(c.clave)) {
        const motivo = aliasPeligroso(c.valores[0]);
        if (motivo) hallar('alias', 'deny', motivo);
      }
      if (!LIBRES_EN_AGENTE(c.clave)) enAgente(ctx, () => hallar('config-agente', 'deny'));
      return;
    }
    case 'update-index': {
      if (rest.some((a) => a === '--skip-worktree' || a === '--assume-unchanged')) hallar('update-index', 'deny');
      if (rest.some((a) => a === '--index-info' || a === '--cacheinfo' || a.startsWith('--cacheinfo='))) enAgente(ctx, () => hallar('plomeria', 'deny'));
      return;
    }
    case 'hash-object':
      if (rest.some((a) => a === '-w' || letraCorta(a, 'w', 't') === 'w')) enAgente(ctx, () => hallar('plomeria', 'deny'));
      return;
    case 'commit-tree':
    case 'mktree':
    case 'read-tree':
    case 'fast-import':
      enAgente(ctx, () => hallar('plomeria', 'deny'));
      return;
    case 'worktree': {
      const pos = rest.filter((a) => !esOpcion(a));
      if (pos[0] === 'add' && rest.some(esOrphan)) enAgente(ctx, () => hallar('rama-huerfana', 'deny', 'worktree add --orphan'));
      if (pos[0] === 'remove' && rest.some((a) => a === '--force' || (esOpcion(a) && !a.startsWith('--') && a.includes('f')))) hallar('worktree-remove-force', 'deny');
      return;
    }
    default:
  }
}

// `--orphan` y sus abreviaturas únicas (git acepta `--or`, `--orph`…), con o sin `=` (rf2-5).
const esOrphan = (a) => /^--or(p(h(a(n)?)?)?)?(=|$)/.test(a);

function enAgente(ctx, f) {
  if (ctx.sesion().agente) f();
}

function hooksPathAusente(dir, ctx, hallar) {
  const raiz = ctx.raizDe(dir);
  if (!raiz || !esCarpeta(path.join(raiz, '.githooks'))) return;
  const r = ctx.git().correr(['config', '--get', 'core.hooksPath'], { cwd: raiz });
  if (r.error) return hallar('hooks-path-ausente', 'deny', 'no se pudo leer core.hooksPath');
  const v = r.ok ? r.stdout.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : '';
  if (v !== '.githooks') hallar('hooks-path-ausente', 'deny');
}

function push(g, dir, ctx, hallar, raiz) {
  const { rest } = g;
  let force = false;
  let borrar = false;
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      pos.push(...rest.slice(i + 1));
      break;
    }
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) {
      i++;
      continue;
    }
    if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') force = true;
    else if (a === '--delete') borrar = true;
    else if (a === '--prune' || a === '--mirror') hallar('push-borrar', 'deny');
    else if (esOpcion(a) && !a.startsWith('--')) {
      const l = a.slice(1);
      const k = l.indexOf('o');
      const antes = k === -1 ? l : l.slice(0, k);
      if (antes.includes('f')) force = true;
      if (antes.includes('d')) borrar = true;
      if (k !== -1 && k === l.length - 1) i++;
    } else if (!esOpcion(a)) pos.push(a);
  }
  const remoto = pos[0];
  if (remoto === '.') hallar('push-punto', 'deny');
  const refspecs = pos.slice(1);
  const todas = rest.some((a) => ['--all', '--branches', '--tags', '--mirror'].includes(a));

  // h11 (D8c-1): en sesión de agente, el aviso temprano — un destino explícito fuera de modulo/* (main, HEAD:main,
  // x:refs/heads/main, un tag) o --all/--branches/--tags. `git push` a secas no se adivina: lo ataja el pre-push.
  if (!borrar) {
    enAgente(ctx, () => {
      for (const a of rest) if (['--all', '--branches', '--tags'].includes(a)) hallar('push-otra-rama', 'deny', a);
      for (const r of refspecs) {
        const s = r.replace(/^\+/, '');
        if (!s || s.startsWith(':')) continue; // borrar: lo juzga push-borrar
        const k = s.indexOf(':');
        let destino = k === -1 ? s : s.slice(k + 1);
        if (destino === 'HEAD' || destino === '@') destino = ctx.rama(raiz()) || '';
        if (!destino) continue; // HEAD suelto: git no sabe a dónde (y el pre-push mira lo que suba)
        destino = sinRefsHeads(destino);
        if (!/^modulo\/[^/]/.test(destino)) hallar('push-otra-rama', 'deny', destino);
      }
    });
  }

  // force: solo sobre kit/*
  const forzadas = refspecs.filter((r) => r.startsWith('+'));
  if (force || forzadas.length) {
    const lista = force ? refspecs : forzadas;
    let destinos = lista.map((r) => {
      const s = r.replace(/^\+/, '');
      const k = s.indexOf(':');
      return sinRefsHeads(k === -1 ? s : s.slice(k + 1));
    });
    if (force && !refspecs.length) destinos = todas ? [null] : ['HEAD'];
    const r = raiz();
    const actual = destinos.includes('HEAD') ? ctx.rama(r) : null;
    const ok = destinos.every((d) => (d === 'HEAD' ? actual && /^kit\//.test(actual) : d && /^kit\//.test(d)));
    if (!ok) hallar('push-force', 'deny');
  }

  // borrar: :rama o --delete
  const aBorrar = [];
  for (const r of refspecs) {
    const s = r.replace(/^\+/, '');
    if (borrar) aBorrar.push(s);
    else if (s.startsWith(':') && s.length > 1) aBorrar.push(s.slice(1));
  }
  if (!aBorrar.length) return;
  const r = raiz();
  const rv = ctx.refVigente(r);
  for (const nombre of aBorrar) {
    const corto = sinRefsHeads(nombre);
    if (rv && corto === rv.nombre) {
      hallar('push-borrar', 'deny', `${corto} es la rama por defecto`);
      continue;
    }
    if (/^kit\//.test(corto)) continue; // kit/*: "borrala y subila de nuevo" (F §6), como el force
    const tip = nombre.startsWith('refs/') && !nombre.startsWith('refs/heads/')
      ? nombre
      : [`refs/remotes/${remoto || 'origin'}/${corto}`, `refs/heads/${corto}`].find((t) => ctx.resuelve(r, t));
    if (!tip || !ctx.resuelve(r, tip)) {
      hallar('push-borrar', 'deny', 'no se encontró la rama para ver si está mergeada');
      continue;
    }
    if (mergeada(ctx, r, tip, null) !== true) hallar('push-borrar', 'deny');
  }
}

function branch(rest, dir, ctx, hallar, raiz) {
  let borrar = false;
  let fuerza = false;
  let moverFuerte = false;
  let remotas = false;
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (['-u', '--set-upstream-to', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color', '--column'].includes(a)) {
      i++;
      continue;
    }
    if (a === '--delete') borrar = true;
    else if (a === '--force') fuerza = true;
    else if (a === '--remotes') remotas = true;
    else if (esOpcion(a) && !a.startsWith('--')) {
      for (const ch of a.slice(1)) {
        if (ch === 'u') break;
        if (ch === 'd') borrar = true;
        else if (ch === 'D') {
          borrar = true;
          fuerza = true;
        } else if (ch === 'f') fuerza = true;
        else if (ch === 'M' || ch === 'C') moverFuerte = true;
        else if (ch === 'r') remotas = true;
      }
    } else if (!esOpcion(a)) pos.push(a);
  }
  if (moverFuerte || (fuerza && !borrar)) {
    hallar('branch-f', 'deny');
    return;
  }
  if (!(borrar && fuerza)) return; // branch -d: git mismo se niega si no está mergeada
  const r = raiz();
  for (const nombre of pos) {
    const tip = remotas ? `refs/remotes/${nombre}` : `refs/heads/${nombre}`;
    if (!ctx.resuelve(r, tip)) continue; // no existe: git va a fallar solo
    const up = remotas ? null : `${nombre}@{upstream}`; // con el nombre corto: refs/heads/x@{upstream} no resuelve
    const upOk = up && ctx.resuelve(r, up) ? up : null;
    if (mergeada(ctx, r, tip, upOk) !== true) hallar('branch-f', 'deny', `branch -D de ${nombre}, que no está mergeada`);
  }
}

// historia-defecto (D-15, r1-5, r2-4): reset <x> / rebase en la rama por defecto.
function historia(g, dir, ctx, hallar, sub) {
  const { rest } = g;
  if (sub === 'rebase' && rest.some((a) => ['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch'].includes(a))) return;
  const r = ctx.raizDe(dir) || ctx.cwd;
  let destino;
  let ramaReescrita = null;
  let raizTotal = false;
  if (sub === 'reset') {
    if (rest.some((a) => a === '-p' || a === '--patch' || a.startsWith('--pathspec-from-file'))) return;
    let pos;
    if (rest.includes('--')) {
      const k = rest.indexOf('--');
      if (rest.slice(k + 1).length) return; // reset de rutas: no mueve HEAD
      pos = rest.slice(0, k).filter((a) => !esOpcion(a));
    } else pos = rest.filter((a) => !esOpcion(a));
    if (pos.length === 0) return; // git reset = HEAD: no tira nada
    if (pos.length > 1) return; // reset <commit> <rutas>
    destino = pos[0];
  } else {
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'].includes(a)) {
        i++;
        continue;
      }
      if (a === '--root') raizTotal = true;
      if (!esOpcion(a)) pos.push(a);
    }
    destino = raizTotal ? null : pos[0] || '@{upstream}';
    ramaReescrita = raizTotal ? pos[0] || null : pos[1] || null;
  }
  const rv = ctx.refVigente(r);
  if (!rv) return; // sin rama por defecto: no hay qué proteger
  const actual = ramaReescrita ? sinRefsHeads(ramaReescrita) : ctx.rama(r);
  if (actual !== rv.nombre) return;
  const cabeza = ramaReescrita ? `refs/heads/${actual}` : 'HEAD';
  if (!raizTotal && !ctx.resuelve(r, destino)) return; // no resuelve: git va a fallar solo
  const rango = raizTotal ? [cabeza] : [`${destino}..${cabeza}`];
  const total = ctx.contar(r, rango);
  if (total === null) return hallar('historia-defecto', 'deny', 'no se pudo contar los commits');
  if (total === 0) return;
  const remota = `refs/remotes/origin/${rv.nombre}`;
  if (ctx.hayOrigin(r) && ctx.resuelve(r, remota)) {
    const propios = ctx.contar(r, [...rango, '--not', remota]);
    if (propios === null) return hallar('historia-defecto', 'deny', 'no se pudo contar los commits');
    if (propios !== total) hallar('historia-defecto', 'deny', `${total - propios} de ${total} ya están en origin/${rv.nombre}`);
    return;
  }
  hallar('historia-defecto', CON_VENTANA.includes(ctx.modo) ? 'ask' : 'deny', MENSAJES['historia-defecto-sin-remoto']);
}

// ---------------------------------------------------------------- los no-git

const KILL_PS = new Set(['stop-process', 'spps']);
function matarPorNombre(argv, prog, ps, todos) {
  const args = argv.slice(1);
  if (prog === 'pkill' || prog === 'killall') return true;
  if (prog === 'taskkill') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i].replace(/^(\/\/?|-)/, '/').toLowerCase();
      if (a === '/im') return true;
      if (a === '/fi' && /imagename/i.test(args[i + 1] || '')) return true;
    }
    return false;
  }
  if (prog === 'wmic') return /\bprocess\b/i.test(args.join(' ')) && /name\s*=/i.test(args.join(' ')) && /\b(delete|terminate)\b/i.test(args.join(' '));
  if (KILL_PS.has(prog) || (ps && prog === 'kill')) {
    if (args.some((a) => /^-(n|na|nam|name|processname)$/i.test(a))) return true;
    const porId = args.some((a) => /^-(i|id)$/i.test(a) || /^-inputobject$/i.test(a) || /^\d+(,\d+)*$/.test(a));
    if (porId) return false;
    // `Get-Process node | Stop-Process`: por nombre, por la tubería
    return todos.some((c) => ['get-process', 'gps', 'ps'].includes(require('./lib/comando.cjs').programa(c)) && c.argv.slice(1).some((a) => /^-(n|na|nam|name|processname)$/i.test(a) || (!esOpcion(a) && !/^\d+$/.test(a))));
  }
  return false;
}

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POPD = new Set(['popd', 'pop-location']);
function destinoCd(argv) {
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(path|literalpath|lp|pspath)$/i.test(a)) return args[i + 1];
    if (/^-(stackname|passthru)$/i.test(a)) {
      if (/^-stackname$/i.test(a)) i++;
      continue;
    }
    if (a === '-P' || a === '-L' || a === '-e' || a === '-@' || a === '--') continue;
    return a;
  }
  return '~';
}

// ---------------------------------------------------------------- decidir

function decidir(entrada, opciones = {}) {
  const e = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : null;
  if (!e) throw new Error('la entrada no es un objeto');
  if (typeof e.tool_name === 'string' && !HERRAMIENTAS.includes(e.tool_name)) return { decision: 'nada' };
  const texto = e.tool_input && e.tool_input.command;
  if (typeof texto !== 'string' || texto.trim() === '') return { decision: 'nada' };
  const ps = e.tool_name === 'PowerShell';
  const comando = require('./lib/comando.cjs');
  const { comandos } = comando.partir(texto, { ps });

  const hallazgos = [];
  const hallar = (caso, tipo, extra) => hallazgos.push({ caso, tipo, extra: extra || null });

  let ctx = null;
  const c = () => (ctx = ctx || nuevoContexto(e, opciones));

  // ---- variables peligrosas (r1-1, r2-8): la asignación misma, en cualquier punto de la llamada
  const hayGit = comandos.some(esGit);
  for (const x of comandos) {
    for (const a of x.asignaciones || []) {
      if (!esPeligrosa(a.nombre)) continue;
      if (ps) {
        const n = reEscapar(a.nombre);
        const esEntorno = new RegExp(`env:[\\\\/]?${n}\\b`, 'i').test(texto) || new RegExp(`\\bsetx?\\s+"?${n}[\\s=]`, 'i').test(texto);
        if (!esEntorno) continue; // `$path = …` es una variable de PowerShell, no del entorno
      }
      if (SOLO_CON_GIT.has(a.nombre.toUpperCase()) && !alcanzaAGit(comandos, x)) continue;
      hallar('variables-peligrosas', 'deny', `la variable ${a.nombre.toUpperCase()}`);
    }
  }
  const setEnv = /SetEnvironmentVariable\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/gi;
  for (let m = setEnv.exec(texto); m; m = setEnv.exec(texto)) {
    if (esPeligrosa(m[1]) && (!SOLO_CON_GIT.has(m[1].toUpperCase()) || hayGit)) hallar('variables-peligrosas', 'deny', `la variable ${m[1].toUpperCase()}`);
  }

  // ---- comando por comando, con el directorio efectivo (los cd en secuencia). `inicio`: null = el cwd. `prof` > 0: el texto de
  // un alias de shell (`!…`), que git corre desde la raíz del repo.
  const revisar = (lista, inicio, prof) => {
    let dir = inicio; // null hasta que haga falta: se arranca en el cwd
    let dirSabido = true;
    const pila = [];
    const dirActual = () => (dirSabido ? (dir === null ? c().cwd : dir) : null);

    if (prof > 0) {
      for (const x of lista) {
        for (const a of x.asignaciones || []) {
          if (esPeligrosa(a.nombre) && (!SOLO_CON_GIT.has(a.nombre.toUpperCase()) || alcanzaAGit(lista, x))) hallar('variables-peligrosas', 'deny', `la variable ${a.nombre.toUpperCase()} (en un alias)`);
        }
      }
    }

    for (const x of lista) {
      const prog = comando.programa(x);
      if (!prog && !esGit(x)) continue;

      if (CD.has(prog)) {
        const antes = dirActual();
        const d = resolverRuta(antes, destinoCd(x.argv));
        if (prog === 'pushd' || prog === 'push-location') pila.push({ dir, dirSabido });
        dir = d;
        dirSabido = d !== null;
        if (d !== null) salirDelWorktree(c(), d, null, hallar);
        continue;
      }
      if (POPD.has(prog)) {
        const p = pila.pop();
        if (p) ({ dir, dirSabido } = p);
        else dirSabido = false;
        continue;
      }

      if (matarPorNombre(x.argv, prog, ps && prof === 0, lista)) hallar('matar-por-nombre', 'deny');
      if (!esGit(x)) continue;

      let g = partirGit(x.argv);
      // el directorio de ESTE git: el efectivo, más sus -C encadenados
      let d = dirActual();
      for (const extra of g.dirs) d = resolverRuta(d, extra);
      if (g.dirs.length) {
        if (d !== null) salirDelWorktree(c(), d, null, hallar);
      }
      for (const op of [g.gitDir, g.workTree]) {
        if (op === null || !enSesion(c())) continue;
        const s = c().sesion();
        const a = c().agente();
        const r = resolverRuta(d === null ? c().cwd : d, op);
        const propio = r !== null && (a.dentroDe(r, s.raiz) || (s.gitDir && a.dentroDe(r, s.gitDir)));
        if (propio) continue;
        if (r !== null && s.principal && a.dentroDe(r, s.principal)) hallar('salir-del-worktree', 'deny', 'una ruta del principal, fuera de tu worktree');
        else if (g.sub && ['commit', 'push', 'merge'].includes(g.sub)) hallar('salir-del-worktree', 'deny', '--git-dir/--work-tree a otro repo');
      }
      if (g.sub && !SUBCOMANDOS.has(g.subCrudo)) {
        const al = resolverAlias(g, d, c(), hallar);
        if (al.shell !== undefined) {
          casosGit({ ...g, sub: null }, d, c(), hallar); // las opciones globales de afuera (-c, --exec-path) valen igual
          if (prof >= 3) hallar('alias', 'deny', 'alias de shell anidados');
          else revisar(require('./lib/comando.cjs').partir(al.shell, { ps: false }).comandos, c().raizDe(d) || d, prof + 1);
          continue;
        }
        g = al.g;
      }
      casosGit(g, d, c(), hallar);
      // repo efectivo de commit/push/merge, y el `.git` del worktree (en sesión de agente)
      if (g.sub && enSesion(c())) {
        const s = c().sesion();
        if (['commit', 'push', 'merge'].includes(g.sub) && g.gitDir === null && g.workTree === null) {
          const efectivo = d === null ? null : c().agente().raizDe(d);
          if (efectivo === null || !c().agente().mismaRuta(efectivo, s.raiz)) {
            hallar('salir-del-worktree', 'deny', d === null ? 'no se sabe a qué carpeta va el cd: usá la ruta literal' : `${g.sub} en otro repo`);
          }
        }
        if (s.enlace === 'roto' && !esLectura(g.sub, g.rest)) hallar('salir-del-worktree', 'deny', 'el .git de este checkout no apunta al principal esperado');
      }
    }
  };
  revisar(comandos, null, 0);

  if (!hallazgos.length) return { decision: 'nada' };
  return resolver(e, c(), hallazgos, opciones);
}

const enSesion = (ctx) => ctx.sesion().agente;

// cd / -C / --git-dir / --work-tree a una ruta bajo el principal y no bajo la propia (sesión de agente).
function salirDelWorktree(ctx, destino, _x, hallar) {
  const s = ctx.sesion();
  if (!s.agente || !s.principal) return;
  const a = ctx.agente();
  if (a.dentroDe(destino, s.principal) && !a.dentroDe(destino, s.raiz)) hallar('salir-del-worktree', 'deny', 'una ruta del principal, fuera de tu worktree');
}

// La ficha (solo acá: algo ya frena), los quitados, el motivo y los renglones.
// opciones.memo (un Map, para quien llama muchas veces sobre el mismo repo quieto: las pruebas) guarda raíz, ficha, rol y rama.
function resolver(e, ctx, hallazgos, opciones) {
  const contexto = ctx.contexto();
  const memo = opciones.memo instanceof Map ? opciones.memo : new Map();
  const una = (k, f) => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k);
  };
  const g = una(`git:${ctx.cwd}`, () => contexto.datosGit(ctx.cwd));
  const raiz = g ? g.raiz : null;
  let quitados = new Set();
  let rota = null;
  if (raiz) {
    const f = una(`ficha:${raiz}`, () => contexto.fichaVigente(raiz));
    if (f.estado === 'rota') rota = f.donde;
    else if (f.estado === 'ok') quitados = quitadosVigentes(f.datos);
  }
  const vivos = hallazgos.filter((h) => !quitados.has(`${PREFIJO}${h.caso}`));
  if (!vivos.length) return { decision: 'nada', quitados: [...new Set(hallazgos.map((h) => h.caso))] };
  const niega = vivos.some((h) => h.tipo === 'deny');
  const decision = niega ? 'deny' : 'ask';
  const usados = vivos.filter((h) => h.tipo === decision);
  const casos = [...new Set(usados.map((h) => h.caso))];
  const partes = casos.map((caso) => {
    const extras = [...new Set(usados.filter((h) => h.caso === caso && h.extra).map((h) => h.extra))];
    return `git-seguro (${PREFIJO}${caso})${extras.length ? ` [${extras.join('; ')}]` : ''}: ${MENSAJES[caso]}`;
  });
  if (rota) partes.push(`ficha rota: ${rota} — corré doctor`);
  const motivo = partes.join(' — ');

  const renglones = [];
  if (raiz) {
    const herramienta = HERRAMIENTAS.includes(e.tool_name) ? e.tool_name : 'Bash';
    const anotar = opciones.anotar || require('./lib/frenos-log.cjs').anotar;
    for (const caso of casos) {
      try {
        renglones.push(
          anotar(raiz, {
            id: `${PREFIJO}${caso}`,
            herramienta,
            detalle: decision === 'ask' ? `preguntó: ${caso}` : caso,
            rol: contexto.rol(raiz),
            rama: una(`rama:${raiz}`, () => contexto.rama(raiz)),
          }),
        );
      } catch (err) {
        /* el renglón es rastro: el freno vale igual */
      }
    }
  }
  return { decision, salida: salida(decision, motivo), casos, detalle: casos.join(', '), renglones };
}

const dos = (n) => String(n).padStart(2, '0');
function quitadosVigentes(datos, ahora = new Date()) {
  const hoy = `${ahora.getFullYear()}-${dos(ahora.getMonth() + 1)}-${dos(ahora.getDate())}`;
  const q = datos && datos.frenos && Array.isArray(datos.frenos.quitados) ? datos.frenos.quitados : [];
  return new Set(q.filter((x) => x && typeof x.id === 'string' && (x.hasta === 'siempre' || (/^\d{4}-\d{2}-\d{2}$/.test(x.hasta) && x.hasta >= hoy))).map((x) => x.id));
}

function principal() {
  let r;
  try {
    require('./lib/git.cjs').fijarPlazo(Date.now() + 15000);
    const t = fs.readFileSync(0, 'utf8');
    r = decidir(JSON.parse(t));
  } catch (err) {
    r = { decision: 'deny', salida: salida('deny', ROTO) };
  }
  if (r.decision !== 'nada') process.stdout.write(`${JSON.stringify(r.salida)}\n`);
}

if (require.main === module) {
  try {
    principal();
    process.exitCode = 0;
  } catch (err) {
    // Ni el deny se pudo imprimir: la salida distinta de 0 (2 = error que bloquea) y onFailure "block" frenan.
    process.exitCode = 2;
  }
} else {
  module.exports = { HERRAMIENTAS, PREFIJO, ROTO, MENSAJES, salida, decidir, partirGit, analizarConfig, restaurarArbol, esPeligrosa, esLectura, quitadosVigentes };
}
