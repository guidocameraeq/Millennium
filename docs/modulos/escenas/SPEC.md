# SPEC: Escenas de Displays más fáciles de armar — Millennium
Crear escenas sin aplicarlas, duplicarlas y editarlas en una pantalla más clara.
- Estado: READY
- Fecha: 2026-11-10
- Sello del Arquitecto: `arquitecto: 2026-11-10 · kit 3.0.0-rc.6 · chequeos: tamaño ✅ · entorno ✅ · tope ✅ · hash d2c6174ce5c4`

## Pedido original, textual
> "la parte de displays, eventualmente, la tenemos que mejorar. Para eso también quiero lanzar otra subsesión que me ayude a planificar qué mejoras le podemos hacer a la parte de displays para poder, por ejemplo, no sé, cosas básicas como crear escenas nuevas sin tener que tenerla aplicada y de ahí poder crearla, poder duplicar actuales y hacerles cambios. La interfaz para las escenas y eso es media mala para usar."

## Por qué (el dolor)
Guido marcó tres dolores (entrevista 2026-11-10): **armar una escena nueva** obliga a poner las pantallas así primero y recién ahí guardarla; **las opciones de cada escena están desparramadas** (audio, acciones, atajo y cuatro botones en un renglón; el interruptor del atajo y la escena de arranque en AJUSTES); y **mirando la lista no se ve qué hace cada escena** (qué prende/apaga, qué abre).

## Contexto del código (de la exploración — nombres REALES, con archivo:línea)
Explorado 2026-11-10 sobre `d58b0c8`. Rutas de `src-tauri/` salvo `src/` del frontend. **Los rangos de `lib.rs`, `main.js` y `styles.css` van a cambiar** con el refactor del módulo `puesta-a-punto` (ver Supuestos): buscar por nombre de función.
- **Una escena = `Profile { name, layout }`** y nada más (`vendor/monarch/src/model.rs:86-90`, sin `serde(default)`). El `Layout` es la lista de `OutputConfig` (monitor, prendido, posición, resolución, refresco, primario) (`model.rs:43-56`); `ensure_valid` pide al menos uno prendido (`model.rs:63-77`).
- **Todo lo demás de la escena cuelga del NOMBRE**, en mapas de `AppSettings` (`model.rs:141-163`): `profile_shortcuts`, `profile_audio`, `profile_actions`, más `startup_profile_name`. Renombrar o duplicar = mover/copiar esas claves. No existe ícono, orden manual ni id.
- Todo vive en `<appdata>/com.guidocameraeq.millennium/displays.json` vía `MillenniumConfigStore` sobre `JsonStore` (atómico, backup si está corrupto) (`src/displays/store.rs:74-143`; ADR-010).
- **Crear solo captura lo que está puesto**: `save_profile` lee `backend.get_layout()`, frena si hay un cambio esperando confirmación y pisa en silencio un nombre igual; ordena alfabético (`vendor/monarch/src/manager.rs:239-269`). Ningún comando acepta un `Layout` armado desde la pantalla. No hay renombrar, duplicar, reordenar ni editar el layout guardado.
- Audio y acciones **ya se editan sin aplicar** (solo escriben los mapas): `asignar_audio`/`asignar_acciones` (`src/displays/mod.rs:1583`, `:1625`). Borrar limpia atajo/audio/acciones/arranque (`mod.rs:924`).
- **Aplicar**: `cargar_perfil` (`mod.rs:1007`) → `apply_profile` (`manager.rs:275-297`: valida, normaliza primario a (0,0), remapea ids por EDID) → `aplicar_con_red` con watchdog de auto-revert; las acciones corren solo al confirmar (ADR-014). Un monitor que la escena prende y **no está conectado** hace fallar el apply antes de tocar nada (`manager.rs:363-366`).
- **Monitores que se pueden usar en papel**: los que Windows enumera (prendidos + conectados-apagados como la TV, `enumerate.rs:144-278`). Un monitor apagado no tiene resolución conocida (centinela 0x0, `enumerate.rs:231-234`): al prenderlo, Windows elige el modo (`apply.rs:692-698`). **No hay lista de resoluciones soportadas** en ningún lado. Hay huellas persistidas de todo monitor visto (`display_fingerprints`, `manager.rs:576-607`), sin geometría.
- **Pantalla hoy** (`src/index.html:230-325`, `src/main.js` desde `renderProfiles`): pestañas LISTA · PERFILES · AJUSTES · LIENZO. En PERFILES cada escena es un renglón con nombre, "Sonido a:", "🎬 escena…" (editor de acciones entrada/salida, chips que no se editan), CARGAR · ↻ actualizar · ⌨ atajo · BORRAR. "＋ GUARDAR EL ACTUAL" crea. El LIENZO (arrastrar monitores) solo edita lo que está puesto y no se conecta con las escenas. Nombres mezclados (PERFILES/escena/CARGAR, DETACH/ATTACH). El atajo se prende en AJUSTES, la escena de arranque también.
- Estilo: violeta `--app-accent #b45cff`, fondo `--bg-base #050513`, Orbitron + JetBrains Mono, esquinas rectas con brillo neón (`src/styles.css:42-95`, `:3735-3740`).

## Qué robar y qué no (solo Modo B largo)
Investigador, 2026-11-10 (~10 búsquedas; casi ninguna fuente con fecha). **Ninguna herramienta de monitores revisada edita perfiles "en papel"**: DisplayFusion, Display Magician, Monitor Profile Switcher y MultiMonitorTool graban el layout real y lo guardan. Home Assistant tiene el problema opuesto (edita aplicando en vivo y los usuarios piden poder no hacerlo).
- **Se roba**: "Probar" separado de "Guardar" (DisplayFusion, Hue), con el auto-revert que Millennium ya tiene · duplicar = copia completa e independiente (OBS) · "actualizar con lo que tengo ahora" sobre una escena existente (Display Magician, DisplayFusion) · un monitor ausente al editar se marca "no conectado", no da error (Display Magician #203).
- **No se roba**: editar aplicando en vivo (HA: los cambios externos se cuelan en la escena) · editar el archivo a mano (MultiMonitorTool, displayplacer) · resoluciones libres sin validar (displayplacer cae a otra sin avisar).

## La pantalla aprobada
Prototipo `docs/modulos/escenas/prototipo/index.html` (aprobado por Guido el 2026-11-10: "todo lo que me mostrás acá está bueno y es útil"). Manda **qué hay y dónde**; la estética es la real de la app (`styles.css`), no la del prototipo. Resumen:
- Pestañas: **ESCENAS** (primera) · LISTA · LIENZO · AJUSTES. LISTA y LIENZO quedan como hoy.
- **Lista de tarjetas**, una por escena: emoji, nombre, mini-mapa de pantallas (prendida / apagada / principal), una frase ("Prende: … · Apaga: … · Principal: …"), chips (sonido, atajo, al entrar, al salir, arranca con Windows), sello **PUESTA AHORA**. Botones APLICAR · EDITAR · ⋯ (DUPLICAR, RENOMBRAR, BORRAR con confirmación al lado de la tarjeta). Se reordena arrastrando o con ↑/↓. Arriba, **＋ NUEVA ESCENA** pregunta de dónde arranca: lo que está puesto / copia de otra / en blanco.
- **Editor en borrador** (aviso fijo: "nada cambia en tus pantallas hasta que toques PROBAR"), en bloques: 1 Nombre + emoji · 2 Pantallas (lienzo para arrastrar, prendida/apagada, ★ principal, resolución, "copiar lo que está puesto ahora") · 3 Sonido · 4 Al entrar / Al salir (chips que se editan, ↑/↓, ✕) · 5 Atajo (con el interruptor general de atajos a mano) · 6 Al arrancar Windows. Barra fija: CANCELAR · PROBAR · GUARDAR, con "cambios sin guardar".
- **PROBAR**: aviso ámbar con cuenta regresiva, ✓ ME QUEDO / ↩ VOLVER AHORA; mientras dura, lo que no se puede tocar dice por qué en texto visible (no en un tooltip).
- **Bandeja** (ícono al lado del reloj): submenú "Escenas" con emoji y ✓ en la puesta ahora.

## AGREGA (lo nuevo)
- **Escenas en papel** (backend + comandos): leer lo que está puesto como borrador; guardar una escena completa desde un borrador (layout + sonido + acciones + atajo + emoji + arranque); duplicar; renombrar; reordenar; **PROBAR** un borrador sin guardarlo. Métodos nuevos del vendor (`upsert_scene`, `rename_scene`, `duplicate_scene`, `reorder_scenes`) que tocan `profiles` y `settings` y **guardan una sola vez**; limpian espacios del nombre como `save_profile`; se rechazan si hay una confirmación pendiente.
  - **Renombrar** mueve atajo, sonido, acciones, emoji y arranque, re-registra el atajo, actualiza `escena_activa`/`escena_pendiente` en memoria (`mod.rs:545`, `:1500`) y rearma la bandeja.
  - **Duplicar** copia pantallas, sonido, acciones y emoji; **no** copia atajo ni arranque (un atajo no puede repetirse, `mod.rs:969-977`). Nombre "X (copia)"; si existe, "X (copia 2)".
  - **PROBAR** = `apply_draft(layout)` en el vendor, que **comparte el cuerpo** de `apply_profile` (validar, normalizar primario, `remap_and_resolve_for_apply`, `apply_layout`) sin buscar por nombre. Aplica el sonido del borrador con red (vuelve atrás), **no** marca `escena_pendiente`, no corre acciones y no escribe `profiles`. Mientras dura, GUARDAR, RENOMBRAR, BORRAR, DUPLICAR y "↻ actualizar" quedan bloqueados con el texto "esperando que confirmes la prueba".
- **Resolución y frecuencia por pantalla**: cada vez que una pantalla está prendida, la app le pregunta a Windows qué modos acepta (fuera del lock del manager) y los guarda en un **mapa aparte con la huella EDID como clave**; solo se suman o reemplazan con una lista no vacía, **nunca se vacían**. El editor ofrece esos modos más "**Dejar la que tenga**" (= resolución 0x0 y la frecuencia que tenía: el único marcador que ya entiende `apply.rs:692-698`). Frecuencia 0 nunca se guarda.
- **Acciones nuevas** (entrada o salida):
  - **Cerrar un programa**: por nombre de `.exe` (sin ruta, sin mayúsculas), elegido de los procesos abiertos; manda el cierre amable a sus ventanas, espera 5 s y, si sigue vivo, el log dice "no cerró: <exe>". Nunca mata el proceso. Lista prohibida: la propia app, `explorer`, `dwm`, `csrss`, `winlogon`.
  - **Esperar N segundos** (1–30).
  - **HDR prender/apagar** en una pantalla (identificada con el remapeo por EDID): `DISPLAYCONFIG_DEVICE_INFO_SET_HDR_STATE` si el crate `windows` lo trae, si no `SET_ADVANCED_COLOR_STATE`. Con la pantalla apagada, se saltea y va al log.
  - **Elegir de una lista** el juego de Steam (de los instalados) y la cuenta de Chrome (por su nombre visible). Se guardan igual que hoy (`Lanzar` con `destino` y `args`).
- **Cola de acciones**: corren en **un hilo propio, en fila**. `confirm` avisa "confirmed" **antes** de correrlas; `escena_activa` se fija **antes** de empezar; una escena nueva cancela los Esperar que quedan de la anterior; tope total de 60 s por lista.
- **"Puesta ahora" de verdad**: reconoce qué escena coincide con cómo están las pantallas (prendidas, principal, posiciones, con el remapeo por EDID; ADR-012), aunque se hayan puesto a mano. Si coinciden varias, gana la `escena_activa`; si no es ninguna de ellas, la primera en el orden de Guido. **Nunca más de un sello.**
- **Escenas en la bandeja**: aplica **con cuenta regresiva**, como APLICAR (decisión de Guido; los atajos siguen directos). Al hacer clic re-valida el nombre; si ya no existe, avisa y no aplica.
- **Emoji por escena.**
- **Checkpoint**: en `MillenniumConfigStore::new`, **antes de cualquier escritura**, si no existe `displays.pre-escenas.json` se copian ahí los bytes crudos de `displays.json` tal como estaban (aunque estén corruptos). Una sola vez; nunca se pisa.

## MODIFICA (lo existente que se toca)
- `save_profile` (`manager.rs:239-269`): deja de ordenar alfabético (lo nuevo va al final) y **deja de pisar en silencio** un nombre repetido (lo frena la pantalla y el comando). Efecto: "↻ actualizar con lo puesto" sigue existiendo como acción explícita.
- Mapas por nombre de `AppSettings`: renombrar los mueve todos juntos en un solo guardado. `update_settings` copia `profile_icons` y el mapa de modos tal cual (la TRAMPA #1, `manager.rs:456-474`). Efecto a cuidar: un renombre a medias deja un atajo huérfano (test).
- `PerfilAcciones` (`model.rs:134-139`) suma `entrada_v2`/`salida_v2` con `serde(default)`: la lista **completa** con todos los tipos (un enum nuevo con `#[serde(other)] Desconocida`). Al guardar se escriben también `entrada`/`salida` viejas **solo con Lanzar y Volumen**. La versión nueva lee `_v2` si existe; si no, las viejas. **`Accion` no cambia**. Efecto: una versión vieja lee el archivo sin problema y solo ignora Cerrar/Esperar/HDR.
- `AppSettings` suma `profile_icons` (mapa por nombre) y `display_modes` (mapa por huella EDID), los dos con `serde(default)`. `DisplayFingerprint` no cambia (`sync_display_fingerprints` la reemplaza entera en cada arranque, `manager.rs:584-596`).
- `confirm` (`mod.rs:785-799`): avisa "confirmed" antes de correr las acciones, que pasan a la cola.
- Pestaña PERFILES → **ESCENAS** (primera); el interruptor de atajos y la escena de arranque también se manejan desde el editor (en AJUSTES queda el plazo de vuelta atrás). Etiquetas de la pestaña en castellano.
- Menú de la bandeja (`lib.rs`, `TrayIconBuilder`): suma el submenú, que se rearma al cambiar las escenas.

## Esto cambio / esto preservo (datos de Guido en `displays.json`)
| Qué | Cambio | Preservo |
|---|---|---|
| Escenas (`profiles`) | El orden pasa a ser el que Guido elija; arranca **en el orden de hoy** | Nombres, layouts y todo campo existente, tal cual |
| Atajo / sonido / acciones / arranque | Solo cambian si Guido edita o renombra esa escena | Todo lo de hoy; nada se migra al abrir |
| Acciones | Suman `entrada_v2`/`salida_v2` solo al guardar esa escena | `entrada`/`salida` de hoy, que siguen escritas (con Lanzar y Volumen) |
| Modos de pantalla | Mapa nuevo por huella EDID, se llena al ver cada pantalla prendida | Ids, nombres y huellas de monitores, sin cambios |
| Emoji | Mapa nuevo, vacío | — |
| El archivo | Se reescribe también al abrir y al aplicar (ya pasa hoy, `manager.rs:83-104`, `:156-158`) y al anotar modos | Copia cruda `displays.pre-escenas.json` al abrir la primera vez, antes de cualquier escritura |

## NO SE TOCA (obligatoria — el seguro de no romper)
- El motor de pantallas (`apply.rs`, `topology.rs`, `watchdog.rs`, `enumerate.rs`): la doctrina "PROHIBIDO simplificar" (`docs/DECISIONS.md`) entera. La resolución y PROBAR viajan por el mismo cuerpo de `apply_profile` de hoy; no se inventa otro camino a `SetDisplayConfig`. HDR va como acción, fuera de ese camino.
- Los atajos aplican **directo, sin cuenta regresiva**, como hoy (Guido los usa mucho).
- La vuelta atrás automática y su plazo; "no se apilan dos confirmaciones".
- Las acciones corren **solo al confirmar** (ADR-014) y nunca por shell; Lanzar y Volumen igual que hoy.
- Atajos globales (de escenas y de prender/apagar pantalla) y la escena de arranque: andan igual.
- Pestañas LISTA y LIENZO (control en vivo): igual.
- La ruta de `displays.json` y el test que vigila que no caiga en Monarch (ADR-010).
- Clipboard entero, el protocolo de red, el updater y los nombres internos (`millennium-clipboard.exe`, identifier).

## Criterios de aceptación (3-8, verificables)
1. Todo lo de NO SE TOCA sigue andando igual, y con el `displays.json` real de Guido la app abre con **todas** sus escenas iguales (nombre, pantallas, sonido, acciones, atajo, arranque).
2. CUANDO Guido crea una escena (desde lo puesto, copia o en blanco), la duplica, la renombra, le pone emoji o la reordena y toca GUARDAR, el sistema DEBE guardarla **sin que cambie ninguna pantalla** y seguir igual después de reiniciar la app; editar la copia no cambia la original; el atajo y el "Al salir" de una renombrada (aunque sea la puesta ahora) siguen andando.
3. CUANDO toca PROBAR, el sistema DEBE poner pantallas y sonido con la vuelta atrás de siempre, sin escribir la escena y sin correr acciones; si no toca ME QUEDO, vuelve solo; SI una pantalla del borrador no está conectada, ENTONCES avisa en palabras sin tocar nada.
4. CUANDO aplica una escena con una resolución elegida, la pantalla DEBE quedar en esa resolución (verificado re-leyendo lo que Windows dejó); SI Windows pone otra, ENTONCES la app lo dice en palabras. El editor solo ofrece modos que esa pantalla reportó o "Dejar la que tenga"; con la TV apagada, un arranque de la app no borra sus modos recordados (test).
5. CUANDO se confirma una escena con Esperar 30, Cerrar un programa y HDR, el aviso de confirmado DEBE llegar en menos de 2 s y las acciones correr en orden; SI una falla o un programa no cierra, ENTONCES las demás siguen y queda en el log; elegir la propia app para cerrar no se puede (test). Steam y Chrome se eligen de listas.
6. CUANDO las pantallas coinciden con una escena (aunque se pusieron a mano), el sistema DEBE marcar **una sola** PUESTA AHORA en la lista y con ✓ en la bandeja; aplicar desde la bandeja trae la cuenta regresiva y los atajos siguen directos.
7. SI todas las pantallas quedan apagadas o el nombre ya existe, ENTONCES GUARDAR no se deja tocar y dice por qué; un `displays.json` guardado con acciones nuevas lo abre la versión de hoy (`v1.5.2`) sin tratarlo de corrupto (test con el modelo de hoy).
8. La primera vez que abre la versión nueva existe `displays.pre-escenas.json`, idéntico byte a byte al `displays.json` de antes de abrirla (test: abrir + arrancar + aplicar sobre un archivo semilla).

## Ejecución
Tamaño: módulo con director
- Sesiones: director con sus obreros, en modo noche (Guido no está). Un encargo por tarea.
- Rama y worktree: `modulo/escenas` en `.claude/worktrees/modulo--escenas`, los crea `worktree.cjs crear escenas`.
- Para abrir: lo que imprime `worktree.cjs` (`primer mensaje: /director escenas`).
- Cómo se prueba: ver "Entorno de prueba".
- **Antes de todo**: el módulo `puesta-a-punto` tiene que estar mergeado a `main` (sus encargos 04 y 05 parten `lib.rs`, `main.js` y `styles.css`). Si no lo está, el director no reparte y lo anota como "te espera".
- **Orden y carriles**:
  - **00 Contrato y gate** (primero y solo): rebasar sobre `main` con el refactor, confirmar que el CI corre en `modulo/**`, y escribir en `docs/modulos/escenas/contrato.md` los comandos nuevos (nombre, argumentos, respuesta) y un mock de `__TAURI__` con datos falsos para la pantalla.
  - **Carril backend** (en fila, todos tocan `displays/` y los comandos): **01 Escenas en papel** (+ checkpoint, emoji, orden, renombrar, duplicar, PROBAR) → **02 Resoluciones** → **03 Acciones nuevas + cola + listas de Steam/Chrome** (sin HDR) → **04 Puesta ahora + bandeja** → **03b HDR** (último, fuera del camino de 04-06).
  - **Carril frontend** (a la vez, solo `src/`): **05 Pestaña ESCENAS** contra el mock del 00, con capturas antes/después (mock + Playwright) → **06 Cablear** a los comandos reales cuando lo que necesita esté en la rama.
- **Si la noche no alcanza**, lo mínimo es **01 + 05 + 06** (los tres dolores); 02, 03, 04 y 03b se mergean después, cada uno por separado.
- Win32 nuevo (modos de pantalla, HDR, cerrar ventanas): **sondar antes de escribir** (doctrina) con un investigador sobre la API. El CI de GitHub no tiene monitores reales: ahí se prueba que compila y la lógica con datos falsos; **lo de hardware lo prueba Guido de día** (HDR: prender/apagar en la TV y que lo confirme la Configuración de Windows). El módulo no va a `main` sin esa prueba de HDR; si falla, 03b se saca y el resto sigue.
- Cada obrero empuja su rama y espera `ci-verde.cjs --esperar`: sin verde no hay merge. Sin release de noche: la versión nueva la decide Guido de día, después de probar en sus pantallas.
- Cierre de tramo: cada 2 encargos.

## Entorno de prueba
- Cómo se levanta: no se levanta local (no hay Rust en la PC). Compila y testea el CI de GitHub sobre la rama pusheada; `node .claude/scripts/ci-verde.cjs --esperar <sha>` da el resultado.
- Datos semilla: un `displays.json` falso con 4 escenas (con atajo, sonido, acciones y arranque) en archivos temporales, para los tests de duplicar/renombrar/orden/checkpoint en `displays-tests`. Nunca se toca el `%APPDATA%` real de Guido.
- Chequeo base (verde antes de tocar código): el último commit de `main` tiene verde `displays-tests` en GitHub y `node .claude/scripts/estructura.cjs` sale 0.
- Compartido entre carriles o por worktree: el CI de GitHub es compartido. Cada obrero en su worktree y su rama.
- Herramientas, cada una con su chequeo de una línea:
  - git con credencial de GitHub: `git ls-remote origin HEAD` responde.
  - Node: `node --version` ≥ 18.
  - Playwright (encargos 05-06): `npx playwright --version`.
  - Las 3 pantallas y la TV de Guido: **necesita a Guido de día** (criterios 1, 3, 4, 5 y 6 en hardware).

## Supuestos
- [ALTO] La obra arranca **después** de que `puesta-a-punto` se mergee a `main`: los `archivo:línea` de `lib.rs`, `main.js` y `styles.css` de este spec van a quedar viejos; se busca por nombre de función.
- [ALTO] [SIN CONTRASTAR] Windows solo informa los modos de una pantalla mientras está prendida; con la TV apagada se usan los recordados o "la que elija Windows".
- [BAJO] PROBAR no corre acciones (no abre Steam en una prueba); sí cambia el sonido, que también vuelve atrás.
- [BAJO] El emoji se guarda como un mapa por nombre, igual que el atajo y el sonido.
- [BAJO] [SIN CONTRASTAR] Programas que se van a la bandeja con la X (Steam, Discord) o que corren como administrador pueden no cerrarse: queda en el log, no se fuerza.
- [BAJO] [SIN CONTRASTAR] No se verificó que el crate `windows` de hoy traiga `SET_HDR_STATE`; si no, se usa `SET_ADVANCED_COLOR_STATE`.
- [BAJO] Una versión vieja que guarde el archivo pierde emojis, modos recordados y `_v2` (vuelve a ordenar alfabético); no pierde escenas.
- [BAJO] El criterio 1 con el `displays.json` real lo prueba solo Guido; ningún test sube a GitHub nombres de monitores, juegos o cuentas reales.

## Riesgos y decisiones ⚠️
Decidido con Guido (2026-11-10):
- **Nueva escena: se elige de dónde arranca** cada vez (lo que está puesto / otra escena / en blanco).
- **Editar en borrador**: nada se guarda hasta GUARDAR; PROBAR aplica con el auto-revert de siempre; CANCELAR descarta.
- **Resolución y frecuencia por pantalla entran** en esta mejora (era el 🟢 del TODO); con la TV apagada, **se recuerdan los modos** de la última vez que estuvo prendida.
- **Orden manual** de las escenas.
- **Entran**: elegir Steam/Chrome de una lista, Cerrar un programa, Esperar, HDR, bandeja, "puesta ahora" de verdad, emoji. **Quedan afuera**: fondo de pantalla, plan de energía, probar una acción sola.
- **Director, de noche.**
- **Bandeja con cuenta regresiva; atajos directos como hoy** (Guido).
- ⚠️ **Acciones nuevas en listas `_v2` aparte**, no en `Accion`: si se metían en el enum de hoy, una versión vieja trataba todo `displays.json` como corrupto y arrancaba vacía (`json_store.rs:59`, `manager.rs:83-104`). Consecuencia: cada guardado escribe dos listas; la vieja solo con Lanzar y Volumen. Volver de versión pierde solo Cerrar/Esperar/HDR, emojis y modos.
- ⚠️ **Renombrar mueve claves** de cinco lugares más la escena activa en memoria. Consecuencia: va en un solo guardado, rechazado durante una confirmación pendiente, con test.
- ⚠️ **HDR toca la configuración de pantalla** por una llamada nueva de Windows. Consecuencia: va como acción después de confirmar, en un encargo último y separable, y sin la prueba de Guido no llega a `main`.
- ⚠️ **"Dejar la que tenga" en vez de "la que elija Windows"**: elegir el modo preferido de Windows obligaba a tocar `apply.rs` (NO SE TOCA). Consecuencia: si la TV quedó en una resolución rara, esa escena la mantiene hasta que Guido elija una.
- ⚠️ **`confirm` avisa antes de correr las acciones** (cambia el orden de ADR-014, no la regla). Consecuencia: el cartel se va al toque aunque haya Esperar; las acciones siguen en la cola.

## FUERA de alcance
- Fondo de pantalla, plan de energía, probar una acción sola (los eligió dejar afuera Guido).
- Control de la TV (encenderla por CEC/ADB), escala/DPI por pantalla, mover ventanas a una pantalla.
- Exportar/importar escenas. Escenas en Android.
- Rediseñar LISTA, LIENZO o AJUSTES más allá de lo dicho en MODIFICA.

### Alternativas evaluadas y descartadas
- Guardar cada cambio al toque (como hoy audio y acciones) — descartado por Guido: sin forma de arrepentirse.
- Nueva escena siempre desde lo puesto — descartado: Guido quiere elegir cada vez.
- Resolución solo con la pantalla prendida — descartado: Guido quiere elegirla con la TV apagada.
- Un id interno por escena en vez del nombre — descartado: cambiaría el formato de todo `displays.json`; renombrar moviendo claves alcanza.
- Editar aplicando en vivo (Home Assistant) — descartado: los cambios de afuera se cuelan en la escena.
