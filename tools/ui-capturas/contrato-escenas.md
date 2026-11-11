# Contrato de comandos — módulo escenas

Encargo 00 · 2026-11-10 · base `modulo/escenas@05ea520`. Fuente: `docs/modulos/escenas/SPEC.md` (AGREGA :38-53, MODIFICA :55-62, pantalla :30-36) y el prototipo aprobado. Lo implementan el carril backend (01, 02, 03, 04, 03b) y lo consume el carril pantalla (05 contra `mock-tauri.js`, 06 contra lo real). Si el código y este archivo no coinciden, se corrige uno de los dos en un commit con su nombre; nadie inventa una tercera forma.

## Reglas que valen para todo

- **Nombres**: comandos `displays_*` en snake_case; argumentos y campos de respuesta en **camelCase** (Tauri convierte los argumentos; las respuestas llevan `#[serde(rename_all = "camelCase")]`). Las acciones conservan su forma de hoy: tag `tipo` en snake_case y campos en castellano (`destino`, `args`, `nivel`).
- **Los `u64` viajan como texto** (ADR-006). Un monitor se nombra siempre con su **id de `ids.rs`**: `"{adapterLuid}:{targetId}:{edidHash|none}"`, todo decimal (ej. `"81234:4357:16045690984833335023"`, `"81234:4357:none"`). El backend lo lee con `parse_display_id` (estricto: un id mal formado es error, nunca se adivina).
- **Los comandos de hoy no cambian de nombre ni de forma.** Lo único que se les suma son campos **opcionales** (ver "Cambios a comandos de hoy"). `displays_list_profiles` sigue devolviendo `ProfileView` tal cual; la pantalla nueva lee `displays_list_scenes`.
- **Todos los comandos nuevos** se declaran siempre (también en Android) y fuera de Windows responden el error de hoy (`displays_no_disponible`). Trabajo de Windows o de disco → `spawn_blocking`.
- **Errores**: `Err(String)` en castellano, para mostrarle a Guido tal cual. Un error nunca deja medio guardado: o se guarda todo, o nada.
- **Prueba pendiente**: mientras hay una confirmación pendiente (cambio común o PROBAR), los comandos que escriben escenas (`save_scene`, `rename_scene`, `duplicate_scene`, `reorder_scenes`, `delete_profile`, `save_profile`) se rechazan. Si lo pendiente es una prueba, el texto es exactamente **`esperando que confirmes la prueba`**; si es un cambio común, el de hoy del vendor.
- **Nombres de escena**: se limpian los espacios de los costados (como `save_profile`). Vacío → `poné un nombre para la escena`. Se comparan exactos (mayúsculas cuentan, como hoy).

## Tipos que se repiten

### `SceneOutput` — una pantalla dentro de una escena o un borrador

```json
{
  "displayId": "81234:4357:16045690984833335023",
  "name": "LG TV OLED",
  "connected": true,
  "enabled": true,
  "primary": false,
  "x": 2560, "y": 0,
  "width": 3840, "height": 2160,
  "refreshMhz": 60000
}
```
- `name` y `connected` son **solo de salida** (el backend los completa con la enumeración y `display_fingerprints`; al entrar se ignoran). `connected: false` = la escena la guarda pero Windows no la ve hoy (el "Proyector (no conectado)" del prototipo).
- `width: 0, height: 0` = **"Dejar la que tenga"** (SPEC :43). Va con el `refreshMhz` que tenía; `refreshMhz: 0` nunca se guarda (el backend lo rechaza: `elegí una frecuencia para <name>`).
- `x`/`y` en píxeles de escritorio. Al guardar y al probar, el vendor normaliza el principal a (0,0) como hoy.
- Una pantalla apagada (`enabled: false`) se guarda con su última resolución y posición, como hoy.

### `ActionV2` — una acción (listas `entradaV2`/`salidaV2`)

Enum nuevo del vendor (no es `Accion`, que no cambia; SPEC :58 y :140). Tag `tipo`, snake_case:

| `tipo` | Campos | Ejemplo | Notas |
|---|---|---|---|
| `lanzar` | `destino`, `args` (opcional, `[]`), `etiqueta` (opcional) | `{"tipo":"lanzar","destino":"steam://rungameid/1145350","args":[],"etiqueta":"Hades II"}` | Igual que hoy más `etiqueta`: el texto que muestra el chip (nombre del juego, "Chrome Trabajo → netflix.com"). Sin `etiqueta`, la pantalla la deduce del destino como hoy. Big Picture sigue siendo `steam://open/bigpicture` / `steam://close/bigpicture`. |
| `volumen` | `nivel` (0–100) | `{"tipo":"volumen","nivel":40}` | Igual que hoy. |
| `cerrar` | `exe` | `{"tipo":"cerrar","exe":"steam.exe"}` | Nombre de `.exe` sin ruta, en minúsculas (03). |
| `esperar` | `segundos` (1–30) | `{"tipo":"esperar","segundos":5}` | (03). |
| `hdr` | `pantalla` (id de monitor), `prender` (bool) | `{"tipo":"hdr","pantalla":"81234:4357:16045690984833335023","prender":true}` | (03b). Se remapea por EDID al correr. |
| `desconocida` | — | `{"tipo":"desconocida"}` | Solo de salida (`#[serde(other)]`): una acción de una versión más nueva. La pantalla la muestra como chip "acción que esta versión no conoce" y avisa en el editor que **al guardar se pierde**. |

- Chrome con cuenta = `lanzar` con `destino` = la ruta de `chrome.exe` que devuelve `displays_list_chrome_profiles` y `args` = `["--profile-directory=<directory>", "<link>"]` (sin link, solo el primero).
- Al guardar, el backend escribe `entrada_v2`/`salida_v2` completas y las `entrada`/`salida` viejas **solo con `lanzar` y `volumen`** (sin `etiqueta`, que `Accion` no tiene). Al leer usa `_v2` si existe; si no, las viejas.

Validación al guardar (error y nada se escribe): `nivel` > 100 → `el volumen va de 0 a 100`; `segundos` fuera de 1–30 → `esperar va de 1 a 30 segundos`; `cerrar` con un exe de la lista prohibida (la propia app `millennium-clipboard.exe`, `explorer.exe`, `dwm.exe`, `csrss.exe`, `winlogon.exe`) → `no se puede cerrar <exe>: lo necesita Windows o es esta app`; `cerrar` con ruta o sin `.exe` → `el programa a cerrar va como nombre.exe, sin carpeta`; `hdr` con id mal formado → el error de `parse_display_id`; `lanzar` con `destino` vacío → `falta qué abrir`; `desconocida` → se descarta sin error.

### `SceneView` — una escena en la lista nueva

```json
{
  "name": "Jugar en la TV",
  "emoji": "🎮",
  "outputs": [ /* SceneOutput, en el orden de la escena */ ],
  "summary": "1 monitor · 3840×2160",
  "audio": { "endpointId": "ep-tv", "friendlyName": "TV LG (HDMI)" },
  "shortcut": "Ctrl+Alt+2",
  "startup": false,
  "isCurrent": false,
  "entradaV2": [ /* ActionV2 */ ],
  "salidaV2": [ /* ActionV2 */ ]
}
```
- `emoji`: `null` = sin ícono. `audio`: `null` = "No tocar el audio" (mismo `AudioView` de hoy). `shortcut`: `null` = sin atajo. `summary`: el mismo texto que arma hoy `ProfileView`.
- `startup`: es la escena de arranque (`startup_profile_name`). A lo sumo una en `true`.
- `isCurrent`: el sello **PUESTA AHORA**. **A lo sumo una** en `true` en toda la lista (SPEC :50). Hasta el encargo 04 vale `true` solo para `escena_activa` (si existe); desde el 04, lo que diga la comparación con las pantallas.
- `entradaV2`/`salidaV2`: siempre presentes; si la escena solo tiene listas viejas, salen convertidas.
- La frase "Prende: … · Apaga: … · Principal: …" y el mini-mapa los arma la pantalla con `outputs` (nombre, prendida, principal, posición, tamaño). Con `width: 0` el mini-mapa usa 1920×1080.

### `SceneDraft` — el borrador del editor (ida y vuelta)

```json
{
  "name": "Escena nueva",
  "emoji": null,
  "outputs": [ /* SceneOutput */ ],
  "audio": null,
  "entradaV2": [],
  "salidaV2": [],
  "shortcut": null,
  "startup": false
}
```
Mismos campos que `SceneView` menos `summary` e `isCurrent`. Vive solo en la pantalla hasta GUARDAR; el backend no guarda borradores.

### `ScenesResult` — respuesta de los comandos que escriben escenas

```json
{ "scenes": [ /* SceneView, en el orden de Guido */ ], "name": "Jugar en la TV (copia)", "warnings": [] }
```
- `name`: el nombre con que quedó la escena tocada (el final tras limpiar espacios o tras duplicar); `null` en `reorder_scenes`.
- `warnings`: cosas que se guardaron igual pero Guido tiene que saber, en castellano (ej. `se guardó, pero el atajo Ctrl+Alt+2 no se pudo activar (¿lo usa otro programa?)`). Vacío casi siempre.

## Comandos nuevos

### `displays_list_scenes` — la lista de la pestaña ESCENAS · encargo 01
- Argumentos: ninguno.
- Respuesta: `SceneView[]` en el orden de Guido (el de `profiles`; arranca en el orden de hoy).
- Errores: solo "no disponible".

### `displays_scene_draft` — armar un borrador sin tocar nada · encargo 01
- Argumentos: `{ from: "current" | "blank" | "scene" | "copy", name?: string }` (`name` hace falta en `scene` y `copy`).
- Respuesta: `SceneDraft`.
  - `current`: lo que está puesto ahora (`get_layout` + nombres). Nombre `Escena nueva`, sin emoji, sonido, acciones, atajo ni arranque. Lo usa también "Copiar lo que está puesto ahora" del editor (la pantalla toma solo `outputs`).
  - `blank`: todas las pantallas que Windows ve (prendidas y conectadas-apagadas); prendida solo la principal de ahora, en (0,0), con su resolución actual; las demás apagadas con "Dejar la que tenga". Nombre `Escena nueva`, el resto vacío.
  - `scene`: la escena `name` entera, para EDITAR (atajo y arranque incluidos). La pantalla guarda `name` como `originalName`.
  - `copy`: la escena `name` con las reglas de duplicar (SPEC :41): pantallas, sonido, acciones y emoji; **sin** atajo ni arranque; nombre `X (copia)` o `X (copia N)` libre. Es "Copia de otra escena…" de ＋ NUEVA ESCENA: no guarda nada.
  - En `scene`/`copy`, las pantallas que la escena guarda y hoy no están salen con `connected: false`; las que Windows ve y la escena no nombra **se agregan** apagadas, con "Dejar la que tenga" (así el editor muestra todas).
- Errores: `from` desconocido → `no sé de dónde armar la escena`; `scene`/`copy` sin `name` → `decime de qué escena partir`; escena que no existe → `no existe la escena "<name>"`; `current` sin poder leer Windows → el error del backend.
- No lo frena una prueba pendiente (no escribe nada).

### `displays_save_scene` — GUARDAR un borrador (crear o editar) · encargo 01
- Argumentos: `{ draft: SceneDraft, originalName: string | null }`. `null` = escena nueva (va **al final**). Un nombre = editar esa escena (queda en su lugar).
- Hace, en **un solo guardado** (`upsert_scene` del vendor): el layout (`outputs` → `Layout`), sonido, acciones (v2 + viejas filtradas), atajo, emoji y arranque. Si `name` ≠ `originalName`, es además un renombre con todas sus reglas (ver `displays_rename_scene`). Después re-registra los atajos y rearma la bandeja. **No toca ninguna pantalla.**
- `startup: true` → esta pasa a ser la de arranque (la anterior deja de serlo). `startup: false` y era la de arranque → queda sin escena de arranque.
- Respuesta: `ScenesResult`.
- Errores (no guarda nada):
  - `poné un nombre para la escena`
  - `ya hay una escena que se llama "<name>"` (nombre de otra escena)
  - `no existe la escena "<originalName>"` (la borraron mientras se editaba)
  - `tiene que quedar al menos una pantalla prendida`
  - `elegí una sola pantalla principal` (cero o más de una principal entre las prendidas)
  - `la pantalla principal tiene que estar prendida`
  - `ese atajo ya lo usa la escena "<otra>"`
  - los de validación de `ActionV2` y de `SceneOutput`
  - (02) las resoluciones: cada pantalla **prendida** con una resolución elegida tiene que llevar un modo de los que esa pantalla reportó (`displays_list_display_modes`), o ser la que **esa misma escena ya tenía guardada** para esa pantalla (por eso editar una escena de antes no falla), o "Dejar la que tenga" (0×0). Si no: `todavía no sé qué resoluciones acepta <name>: prendela una vez o elegí "Dejar la que tenga"` (la pantalla nunca se vio prendida) / `<name> no reporta <ancho>×<alto> a <N> Hz: elegí una de su lista o "Dejar la que tenga"`. Las apagadas no se miran. Ojo con las **escenas nuevas** (`originalName: null`, también las que salen de "Copia de otra escena…"): no tienen "escena original" contra la que comparar, así que una resolución heredada de otra escena para una pantalla que nunca se vio prendida da el primer error. Por eso la pantalla, en un borrador de copia, pasa esas pantallas a "Dejar la que tenga" antes de ofrecerlo (ver la pantalla, `displays-editor.js`).
  - (02) `la resolución de <name> no es válida` (ancho 0 con alto distinto de 0, o al revés) y `elegí una frecuencia para <name>` (resolución elegida con frecuencia 0)
  - `esperando que confirmes la prueba` / el de cambio pendiente (`ya hay un cambio esperando que lo confirmes`)
- Si el atajo se guardó pero Windows no lo deja registrar: **se guarda igual sin atajo** y va un `warnings` (no se deja un atajo muerto, como hoy en `displays_set_profile_shortcut`).

### `displays_duplicate_scene` — DUPLICAR del menú ⋯ · encargo 01
- Argumentos: `{ name: string }`.
- Copia completa e independiente (SPEC :41): pantallas, sonido, acciones y emoji; **no** atajo ni arranque. Nombre `X (copia)`; si existe, `X (copia 2)`, `X (copia 3)`… Va **al final** (como todo lo nuevo, SPEC :56). Un solo guardado; rearma la bandeja.
- Respuesta: `ScenesResult` con `name` = el nombre de la copia.
- Errores: `no existe la escena "<name>"` · prueba/cambio pendiente.

### `displays_rename_scene` — RENOMBRAR del menú ⋯ · encargo 01
- Argumentos: `{ name: string, newName: string }`.
- Mueve en **un solo guardado** el atajo, sonido, acciones, emoji y arranque al nombre nuevo; re-registra los atajos; actualiza `escena_activa`/`escena_pendiente` en memoria (así el "Al salir" y el sello siguen andando); rearma la bandeja. Mismo lugar en el orden.
- Respuesta: `ScenesResult` con `name` = el nombre nuevo limpio.
- Errores: `poné un nombre para la escena` · `ya hay una escena que se llama "<newName>"` · `no existe la escena "<name>"` · prueba/cambio pendiente. Renombrar al mismo nombre no es error: no escribe y devuelve la lista.

### `displays_reorder_scenes` — ↑/↓ y arrastrar · encargo 01
- Argumentos: `{ names: string[] }` — **todos** los nombres, en el orden nuevo.
- Respuesta: `ScenesResult` con `name: null`.
- Errores: si `names` no es exactamente el conjunto de escenas de hoy (falta, sobra o se repite una) → `la lista de escenas cambió mientras la ordenabas; volvé a intentar` y no guarda · prueba/cambio pendiente.

### `displays_test_draft` — PROBAR un borrador · encargo 01
- Argumentos: `{ draft: SceneDraft }`.
- Hace `apply_draft(layout)` del vendor (mismo cuerpo que `apply_profile`: validar, normalizar primario, remapeo por EDID, `apply_layout`) con la red de auto-revert de siempre, y aplica el **sonido** del borrador con la misma red. **No** escribe `profiles` ni ajustes, **no** corre acciones, **no** marca `escena_pendiente` ni `escena_activa`.
- Respuesta: `DisplaysSnapshot` de hoy, con `pending.isTest: true` (campo opcional nuevo, ver abajo). Emite `displays-confirmation` `applied` como hoy, con `isTest: true`.
- **ME QUEDO** = `displays_confirm` de hoy; **VOLVER AHORA** = `displays_revert` de hoy. Confirmar una prueba deja las pantallas así y no corre nada; el borrador sigue sin guardar.
- Errores (no toca nada): `tiene que quedar al menos una pantalla prendida` · `<name> no está conectada: conectala o apagala en la escena para probar` (SPEC :87, antes de tocar Windows) · `ya hay un cambio esperando que lo confirmes` · el error del apply.

### `displays_list_display_modes` — el selector de resolución · encargo 02
- Argumentos: ninguno.
- Respuesta: una entrada por pantalla que Windows ve o que alguna escena nombra:
```json
[
  { "displayId": "81234:4357:16045690984833335023", "name": "LG TV OLED", "connected": true, "active": false,
    "remembered": true,
    "modes": [ { "width": 3840, "height": 2160, "refreshMhz": 60000 }, { "width": 1920, "height": 1080, "refreshMhz": 60000 } ] }
]
```
- `modes`: los que la pantalla reportó la última vez que estuvo prendida (mapa `display_modes` por huella EDID), de mayor a menor (ancho, alto, frecuencia), sin repetidos, nunca con `refreshMhz: 0`. Lista vacía = nunca la vimos prendida: el editor ofrece solo "Dejar la que tenga".
- `remembered: true` = la lista viene de memoria (la pantalla está apagada o no conectada ahora). La pantalla lo dice con el texto del prototipo ("Resoluciones que recuerdo de la última vez que estuvo prendida").
- "Dejar la que tenga" **no** viene en la lista: es siempre la primera opción del selector y se guarda como `width: 0, height: 0`.
- Errores: solo "no disponible". Si Windows no contesta los modos de una pantalla, esa entrada sale con lo recordado.

### `displays_list_steam_games` — elegir un juego · encargo 03
- Argumentos: ninguno.
- Respuesta: `[ { "appId": "1145350", "name": "Hades II" } ]`, ordenada por nombre. `appId` como texto. Sin Steam instalado → `[]` (no es error).
- La pantalla guarda `lanzar` con `destino: "steam://rungameid/<appId>"` y `etiqueta: <name>`.

### `displays_list_chrome_profiles` — elegir una cuenta de Chrome · encargo 03
- Argumentos: ninguno.
- Respuesta: `{ "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "profiles": [ { "directory": "Profile 1", "name": "Trabajo" } ] }`. `name` = el nombre visible de la cuenta. Sin Chrome → `{ "chromePath": null, "profiles": [] }`.

### `displays_list_running_programs` — elegir qué cerrar · encargo 03
- Argumentos: ninguno.
- Respuesta: `[ { "exe": "steam.exe", "title": "Steam" } ]`: procesos con al menos una ventana visible **y con título** (decisión del director en la evidencia 03: queda así; un proceso sin ventana con título no aparece), un renglón por `exe` (en minúsculas), ordenado por `title`, **sin** los de la lista prohibida. `title` siempre trae texto: es el título de una de sus ventanas (no se rellena con el exe).

## Cambios a comandos de hoy (solo campos opcionales)

| Comando / tipo | Qué se suma | Quién | Por qué |
|---|---|---|---|
| `displays_save_profile` | argumento opcional `replace?: boolean` (falta = `false`) | 01 | SPEC :56: deja de pisar en silencio. Sin `replace`, un nombre repetido da `ya hay una escena que se llama "<name>"`. "↻ actualizar con lo puesto" manda `replace: true` y pisa **solo el layout**, como hoy. Ojo 01→06: el ↻ de la pantalla vieja manda solo `{ name }`, así que en la rama del módulo da ese error hasta que el 06 lo cablee (no llega a `main` así). |
| `PendingView` (en `DisplaysSnapshot.pending`) | `isTest: boolean` (el backend lo manda siempre; la pantalla trata "falta" como `false`) | 01 | La pantalla sabe si la cuenta regresiva es de PROBAR para bloquear GUARDAR/RENOMBRAR/BORRAR/DUPLICAR/↻ con el texto "esperando que confirmes la prueba". |
| evento `displays-confirmation` `applied` | `isTest?: boolean` (solo viaja cuando es `true`) y `warnings?: string[]` (solo viaja si hay algo que avisar) | 01 y 02 | `isTest`: lo mismo, por el evento. `warnings` (02): Windows dejó otra resolución o frecuencia de la elegida en la escena, en castellano y listo para mostrar (ej. `pediste 3840×2160 a 60 Hz para LG TV OLED, pero Windows la dejó en 1920×1080 a 60 Hz`; uno por pantalla). Lo llevan APLICAR (`displays_load_profile`), la cuenta regresiva de la bandeja y PROBAR. Los atajos y el arranque no abren cartel: ahí el aviso va solo al log. La pantalla lo muestra junto al cartel de confirmación, en texto visible, hasta que se confirma o se revierte. |
| `displays_delete_profile` | nada en la forma; además emite `displays-scenes-changed` y rearma la bandeja | 01 | Borrar se sigue haciendo con el comando de hoy, también desde la pantalla nueva; el emoji se limpia con el resto (`mod.rs` `borrar_perfil`). |
| `displays_confirm` | nada en la forma; avisa `confirmed` **antes** de correr las acciones | 03 | SPEC :60. |

`displays_load_profile` (APLICAR), `displays_set_profile_shortcut`/`_clear_` y los de audio y acciones de hoy no cambian. La pantalla nueva los puede seguir usando, pero GUARDAR del editor va siempre por `displays_save_scene`.

**Ajustes del editor**: el interruptor general de atajos (bloque 5) sigue siendo `displays_get_settings`/`displays_update_settings` de hoy (`globalShortcutsEnabled`; mandar siempre los tres campos). El arranque (bloque 6) viaja en el borrador (`startup`), no por ajustes.

## Eventos

| Evento | Payload | Cuándo | Quién |
|---|---|---|---|
| `displays-scenes-changed` (nuevo) | `{ "kind": "saved" \| "renamed" \| "duplicated" \| "reordered" \| "deleted" \| "current" }` | Tras cada guardado de escenas (los 4 comandos nuevos que escriben, `save_profile`, `delete_profile`, y los de atajo/audio/acciones de hoy) y cuando cambia cuál está **puesta ahora** (`current`, desde el 04). | 01 (y 04 para `current`) |
| `displays-confirmation` (de hoy) | igual + `isTest?` en `applied` | igual que hoy | 01 |
| `displays-changed`, `displays-audio` (de hoy) | igual | igual | — |

La pantalla, al recibir `displays-scenes-changed`, vuelve a pedir `displays_list_scenes` (el payload no trae la lista). La **bandeja** no escucha eventos: el backend la rearma en los mismos puntos donde emite (04 agrega el submenú; hasta entonces no hay nada que rearmar).

## Quién implementa qué

| Encargo | Comandos / cambios |
|---|---|
| 01 Escenas en papel | `list_scenes`, `scene_draft`, `save_scene`, `duplicate_scene`, `rename_scene`, `reorder_scenes`, `test_draft`; `replace` en `save_profile`; `isTest`; evento `displays-scenes-changed`; emoji; `ActionV2` con `lanzar`/`volumen`/`desconocida` (lectura y escritura de `_v2`) |
| 02 Resoluciones | `list_display_modes`; validación de `width`/`height`/`refreshMhz` contra los modos al guardar (solo modos reportados o 0x0) |
| 03 Acciones nuevas | `cerrar` y `esperar` en `ActionV2`; `list_steam_games`, `list_chrome_profiles`, `list_running_programs`; `confirm` avisa antes |
| 04 Puesta ahora + bandeja | `isCurrent` de verdad; `kind: "current"`; submenú de bandeja |
| 03b HDR | `hdr` en `ActionV2` |

Hasta que un encargo implemente su tipo de acción, `save_scene` rechaza ese `tipo` con `esta versión todavía no sabe guardar acciones <tipo>` (así la pantalla 05/06 puede ofrecerlo contra el mock sin que el backend lo pierda en silencio).

## Decisiones de este contrato (clase 1, se deshacen editando este archivo)

- **Lista nueva aparte** (`displays_list_scenes`) en vez de agrandar `ProfileView`: la pantalla de hoy y sus capturas no se enteran, y la nueva tiene todo en una llamada.
- **`from: "copy"` en el backend**: las reglas de duplicar (sin atajo, sin arranque, "(copia N)") viven en un solo lugar para DUPLICAR y para "Copia de otra escena…".
- **Duplicar va al final**, como todo lo nuevo (SPEC :56 solo lo dice de `save_profile`; se extiende para no tener dos reglas).
- **`etiqueta` opcional en `lanzar` v2**: el chip dice "Juego: Hades II" sin pedir la lista de Steam en cada pantalla. `Accion` vieja no la tiene y no cambia.
- **El evento no trae la lista**: un solo camino de datos (`list_scenes`), y el payload no crece con las escenas.
