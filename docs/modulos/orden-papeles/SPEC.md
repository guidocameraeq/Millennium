# SPEC: Ordenar los papeles y la raíz — Millennium
Poner los docs y la raíz del repo al día con lo que la app es hoy (el combo Clipboard + Displays), sin tocar código.
- Estado: COMPLETO 2026-11-10
- Fecha: 2026-11-10
- Sello del Arquitecto: `arquitecto: 2026-11-10 · kit 3.0.0-rc.6 · chequeos: tamaño ✅ · entorno ✅ · tope ✅ · hash 4905e03c0799`

## Pedido original, textual
> "trae al arquitecto y q organice todo el repo"
>
> (aclaración, misma charla) "Ordena los papeles, la raíz y la carpeta y depues vamos a lanzar una sesion para q arregle el codigo por dentro en esa y varias otras cosas, despues planeamos eso, por ahora hace las otras 2"

## Por qué (el dolor)
Los papeles todavía describen la app vieja ("Millennium Clipboard", sin Displays), los docs del kit nacieron vacíos (NORTE, MAPA) y el TODO mezcla secciones de distintas épocas con cosas ya hechas. Una sesión nueva, en especial la que va a ordenar el código después, arranca leyendo información vieja. Este módulo deja el terreno limpio para esa sesión.

## Contexto del código (de la exploración — nombres REALES, con archivo:línea)
- `CLAUDE.md:1` y `CLAUDE.md:9` dicen "Millennium Clipboard", describen solo la parte de clipboard y dan tamaños viejos ("~5.5k LOC" Rust, "~5k LOC" frontend). Hoy hay ~13k líneas de Rust (Displays en `src-tauri/src/displays/`, 11 archivos) y `src/main.js` (4.051) + `src/styles.css` (3.764) + `src/index.html` (759).
- `docs/SESSION_HANDOFF.md:1` y `:5` dicen "Millennium Clipboard" y que "la carpeta local sigue con el nombre viejo". **Falso hoy**: la carpeta ya es `C:/Users/guido/Desktop/(1) Claude/Millennium` y `origin` apunta a `guidocameraeq/Millennium.git`.
- `docs/NORTE.md` y `docs/MAPA.md` son el molde del kit sin completar (`[completar: …]`).
- `docs/TODO.md` (11 KB): mezcla 🟢 "HECHO" (`:7`), 🔵 Displays con "misión activa" (`:15`), 🟣 Displays v2 (`:21`), 🔴/🟠/🟡/🟢 por prioridad (`:42` en adelante). Hay ítems de Displays repartidos en 3 secciones y un ítem viejo sobre el CI de `feat/displays` (`:18`), una rama que ya no existe.
- `docs/SPEC-displays.md`: `Estado: EN CURSO` (`:4`), con fases 0-3 verificadas y tres chequeos físicos chicos pendientes (los mismos de `docs/TODO.md:16`).
- `docs/remediation/`: las 4 fases de Windows ya están archivadas en `docs/archive/phase-0..3-*.md` (cada una con su `ESTADO: COMPLETADA` en la línea 3), pero `docs/remediation/windows/SPEC.md` (el índice de esas fases) sigue en la carpeta viva y `docs/remediation/README.md:15-18` apunta a rutas `windows/phase-*.md` que ya no existen. Android (A, B, C + `android/SPEC.md`) está pendiente y vivo.
- `docs/CHANGELOG.md` (72 KB, 21 entradas) y `docs/DECISIONS.md` (34 KB, ADR-001..014): grandes pero ordenados.
- `docs/README.md`: índice del kit con la tabla "Mudanza de rutas" vacía.
- Raíz: `_archive/mockup/` (3 archivos, maqueta HTML previa a Tauri, último toque `93246d1` 2026-05-12, nadie la referencia). `assets/screenshot.png` la usa `README.md:7` (se queda). `README.md` ya está al día con el combo.

## AGREGA (lo nuevo)
- `docs/MAPA.md` completo: un diagrama con las dos apps (Clipboard: discovery + server/cliente HTTPS + clipboard_sync; Displays: enumerate/topology/apply/watchdog/store) y el frontend; la tabla "Con otras apps" con `MillenniumClipboard` (comparte el núcleo de clipboard por historia de git, no por código vivo) y el hub `../` (ADRs). Tope 5.000 bytes.
- Filas en la tabla "Mudanza de rutas" de `docs/README.md`, una por cada archivo que este módulo mueve.
- Un ítem en `docs/TODO.md` con las 3 pruebas físicas de Displays que quedan (plazo del auto-revert desde AJUSTES, lista que se actualiza sola al enchufar, CPU en reposo ~0 %).
- Un ítem en `docs/TODO.md`: "cuando se planee el ordenamiento del código, cambiar `vars.comando-test` de la ficha por el `cargo test` real" (ver Riesgos).

## MODIFICA (lo existente que se toca)
- `CLAUDE.md`: título y "Qué es esto" pasan a describir el combo (Clipboard + Displays), con tamaños de hoy, y que el `.exe` sale del CI. **Efecto a cuidar**: las secciones de reglas (restricciones duras, evidencia, operativas, comunicación, tamaño del pedido) quedan con el mismo texto; solo se agregan menciones a Displays donde una regla hoy dice "la app" pensando solo en clipboard, y se marca con "esto cambio / esto preservo" en el commit.
- `docs/TODO.md`: se reordena **solo por prioridad** (🔴 → 🟠 → 🟡 → 🟢), con Displays junto en un bloque; se borran la sección 🟢 "HECHO" y el ítem del CI de `feat/displays` (rama que no existe). **Efecto a cuidar**: ningún pendiente abierto se pierde ni cambia de texto salvo para sacar referencias a rutas movidas.
- `docs/SPEC-displays.md`: `Estado:` → `COMPLETO 2026-11-10 (quedan 3 pruebas físicas en el TODO)` y se mueve a `docs/archive/`.
- `docs/remediation/windows/SPEC.md` → `docs/archive/remediation-windows-SPEC.md` con su estado en la línea 1 (las 4 fases ya están archivadas). `docs/remediation/README.md` actualiza las rutas de Windows a `docs/archive/`. **Efecto a cuidar**: lo de Android (`android/*` y `00-SHARED-CONTEXT.md`) queda intacto (restricción dura #3 del `CLAUDE.md`).
- `_archive/mockup/` → `docs/archive/mockup/` (decidido por Guido); la carpeta `_archive/` desaparece de la raíz.
- `docs/SESSION_HANDOFF.md`: se corrige el nombre ("Millennium") y el dato de la carpeta local (ya se llama `Millennium`). El resto lo reescribe el `/cierre`.

## NO SE TOCA (obligatoria — el seguro de no romper)
- Todo el código: `src/`, `src-tauri/` (incluido `gen/android/` y `vendor/`), `package.json`, `.github/workflows/`, `.cargo/`. Ni una línea.
- `README.md` (ya al día) y `assets/screenshot.png` (lo usa `README.md:7`).
- `docs/CHANGELOG.md` y `docs/DECISIONS.md`: solo se agrega la entrada de esta sesión al CHANGELOG; lo escrito no se reescribe.
- `docs/archive/` existente: no se renombra ni edita ningún archivo que ya esté ahí.
- `docs/remediation/00-SHARED-CONTEXT.md` y `docs/remediation/android/`: intactos.
- `.claude/` (skills, hooks, scripts, settings) salvo la línea `comando-test` ya agregada a `.claude/kit.md`.
- El nombre del binario `millennium-clipboard.exe`, el identifier y el `name` de `package.json`: no se tocan (romperían el updater).

## Criterios de aceptación (3-8, verificables)
1. `git diff --stat main...HEAD` no muestra ningún archivo fuera de `CLAUDE.md`, `docs/` y `_archive/` (lo de NO SE TOCA sigue igual).
2. `grep -rn "\[completar" CLAUDE.md docs/NORTE.md docs/MAPA.md` no devuelve nada.
3. `grep -n "Millennium Clipboard" CLAUDE.md docs/TODO.md docs/SESSION_HANDOFF.md` no devuelve nada (salvo citas al repo `MillenniumClipboard`).
4. CUANDO se listan `docs/` y la raíz, `docs/SPEC-displays.md`, `docs/remediation/windows/` y `_archive/` ya no existen, y cada archivo movido figura en la tabla "Mudanza de rutas".
5. Cada pendiente abierto del `docs/TODO.md` de antes (`git show main:docs/TODO.md`) sigue en el nuevo, contado ítem por ítem en la evidencia (menos el de `feat/displays` y los de la sección HECHO).
6. `node .claude/scripts/estructura.cjs` sale en 0.
7. SI una ruta citada en `CLAUDE.md`, `docs/README.md` o `docs/remediation/README.md` no existe, ENTONCES el criterio falla: todas las rutas citadas en esos tres archivos existen.

## Ejecución
Tamaño: módulo solo
- Sesiones: una.
- Para abrir: en un chat NUEVO en `C:\Users\guido\Desktop\(1) Claude\Millennium`, pegá `inicio — ejecutá docs/modulos/orden-papeles/SPEC.md (está READY)`.
- Cómo se prueba: ver "Entorno de prueba".

## Entorno de prueba
- Cómo se levanta: no aplica, el módulo no toca código ni corre la app.
- Datos semilla: no aplica. Cómo se resetea: `git checkout main -- docs CLAUDE.md`.
- Chequeo base (verde antes de tocar nada): `node .claude/scripts/estructura.cjs` (sale 0).
- Compartido entre carriles o por worktree: no aplica (una sesión).
- Herramientas: `git` y `node` (`node --version`). No hace falta Rust.

## Supuestos
- [BAJO] "La carpeta" del pedido es la carpeta local del proyecto: ya se llama `Millennium`, así que solo se corrige el dato viejo del handoff. (Si era otra carpeta, se suma en un cambio chico).
- [BAJO] El TODO se ordena solo por prioridad y no por app. (Si lo querés por app, es un reordenamiento sin pérdida).
- [BAJO] CHANGELOG (72 KB) y DECISIONS (34 KB) quedan enteros: grandes pero ordenados, y nadie los inyecta al arranque.
- [BAJO] `docs/referencia/PRUEBA.md` y `trampas.md` quedan como están.

## Riesgos y decisiones ⚠️
- ⚠️ SPEC-displays se cierra con 3 pruebas físicas sin hacer (decidido por Guido). Consecuencia: si una falla, es un arreglo chico aparte, no un retome del spec.
- ⚠️ `_archive/mockup` se mueve a `docs/archive/mockup/` (decidido por Guido). Consecuencia: `docs/archive/` pasa a tener algo que no es un papel; se acepta.
- ⚠️ `vars.comando-test` de la ficha queda en `node .claude/scripts/estructura.cjs` (chequeo de estructura de docs), porque esta PC no tiene Rust y el test de verdad (`cargo test` en `src-tauri/displays-tests`) corre en el CI. Consecuencia: el sello no prueba código hasta que el módulo de ordenar el código lo cambie por el `cargo test` (queda en el TODO).

### Alternativas evaluadas y descartadas
- Ordenar también el código por dentro en este módulo: descartado por Guido. Va en una sesión aparte que se planea después.
