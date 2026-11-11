# Escenas de Displays más fáciles de armar
- Estado: COMPLETO 2026-11-10
- director: sí
- rama: modulo/escenas
- Próximo paso: Guido prueba la v1.6.0 en sus pantallas
- Tramo: 2 cerrado 2026-11-10
- Cierre de tramo: cada 2 encargos

## Qué es
Manual del módulo. Pedido del 2026-11-10: crear escenas sin tenerlas aplicadas, duplicarlas y cambiarlas, en una pantalla que muestre de un vistazo qué hace cada una. Spec en `SPEC.md`, pantalla aprobada en `prototipo/index.html`, contrato de comandos en `contrato-escenas.md`. La versión que lo lleva es la **1.6.0** (encargo 08).

## Qué hace
- **Pestaña ESCENAS** (la de entrada a Displays): una tarjeta por escena con emoji, nombre y un resumen de qué hace. Arrastrando se cambia el orden. La que está puesta ahora lleva el sello.
- **Editor en borrador**: se arma o se cambia una escena sin aplicarla. **PROBAR** la aplica con cuenta regresiva y vuelve sola; **GUARDAR** la deja guardada. Se puede duplicar, renombrar, borrar y elegir emoji. Una copia con una pantalla nunca vista queda en "Dejar la que tenga" y el editor lo explica.
- **Resoluciones por pantalla**: cada pantalla prendida elige un modo de su lista (o "Dejar la que tenga"). La app **recuerda los modos** de cada pantalla (por su huella EDID) y así los ofrece aunque la TV esté apagada. 59,94 y 60 Hz cuentan como la misma frecuencia (tolerancia < 1 Hz). Si Windows deja otra resolución que la pedida, avisa en palabras.
- **Acciones nuevas** (entrada y salida de cada escena): **Cerrar programa** (cierre amable; nunca mata el proceso; solo programas con ventana con título; no la lista prohibida ni esta app), **Esperar** (1 a 30 s), **Steam** y **Chrome** elegidos de una lista real, **HDR prender/apagar** por pantalla. Siguen Lanzar y Volumen. Todo corre en una cola: una escena nueva corta los Esperar que quedaban de la anterior; tope de 60 s por lista; un paso que falla no frena al resto.
- **HDR**: pide el cambio con la llamada nueva de Windows y, si no queda, con la vieja; después **re-lee el estado** para saber si cambió de verdad. Si no cambió, lo dice en el log.
- **Bandeja**: submenú "Escenas" (emoji + nombre, ✓ en la puesta ahora). El clic aplica con cuenta regresiva; si ya hay un cambio pendiente, no apila y avisa al log.
- **Puesta ahora**: la escena "puesta" se calcula comparando prendidas, principal y posiciones con lo que hay (no resolución). Si dos coinciden, gana la activa y si no la primera en tu orden.
- **Checkpoint**: antes de tocar los datos queda `displays.pre-escenas.json`, para volver atrás.

## Cómo se usa
Displays → ESCENAS → NUEVA (o duplicar una) → armar pantallas, resoluciones y acciones → PROBAR si querés ver cómo queda → GUARDAR. Aplicar se hace desde la tarjeta o desde la bandeja.

## Qué no toca
El Clipboard, el motor de topología/apply/watchdog de Monarch, ni el formato de red. Las listas viejas de acciones (Lanzar y Volumen) siguen leyéndose igual; los archivos con acciones nuevas los abre esta versión sin tratarlos de corruptos.

## Decisiones cerradas
Del tramo 1:
- El gate de CLIP ignora la sección Displays.
- `capturar.cjs --comparar` captura en temporal (la corrección 00 la absorbió el 05).
- PROBAR con las pantallas ya iguales no cambia el sonido (no hay cuenta regresiva que lo devuelva).
- Frecuencia 0 solo se rechaza con resolución elegida.

Del dueño (`bitacora/2026-11-10-decision-release.md`): release final con todo, sin prueba de hardware previa, como **v1.6.0**; la prueba de hardware pasa a después y lo que falle se arregla con otra versión.

De las evidencias:
- 02: los modos se recuerdan por pantalla; 59,94 vs 60 Hz es la misma frecuencia.
- 03: los programas a cerrar son solo los que tienen ventana con título; nunca se mata un proceso.
- 04: la bandeja valida por nombre (no por lugar) y sus avisos van al log.
- 06: una copia con una pantalla nunca vista pasa a "Dejar la que tenga".
- 07: HDR con la llamada nueva y respaldo en la vieja, siempre re-leyendo el estado.

## Parado
- Nada.

## Te espera
- Guido, después del release: probar en hardware los criterios 1, 3, 4, 5 y 6 con lo NO VERIFICADO de cada evidencia:
  - HDR en la TV, confirmado en la Configuración de Windows (07).
  - Cerrar Steam de verdad y ver si se va a la bandeja con la X (03).
  - Listas reales de Steam y Chrome (03).
  - Bandeja: verla, clic, ✓ que no quede invertido, cuenta regresiva desde la bandeja (04).
  - Arrastrar tarjetas y pantallas; PROBAR no marca escena pendiente; renombrar sigue a la escena puesta; atajo que no se registra (01, 05, 06).
  - Aviso de resolución distinta cuando Windows no respeta lo pedido (02).
  - 59,94 Hz contra la lista real de modos (02).

## Pendientes
Del módulo, para otra vez:
- Un HDR pendiente de la escena anterior no se cancela al cambiar de escena (07; recomendación: cancelarlo como un Esperar).
- El tope de 60 s se puede pasar unos segundos si un Cerrar arranca cerca del final (03).
- El aviso de resolución no se ve si se aplicó desde la bandeja sin haber entrado nunca a Displays (06).
- Prender una pantalla que cae encima de otra no se chequea (06).
- El banco de capturas no guarda los argumentos de `invoke`.
- `capturas/despues/disp-perfiles.*` es de una corrida vieja (la vista ya no existe).
- Del kit: el contador de desvíos no ve los de clase 1 que están en las evidencias.

## Sesiones vivas
- director-escenas · local · .claude/worktrees/modulo--escenas · modulo/escenas · auto
- obrero 08 (versión) · — · .claude/worktrees/modulo--escenas--08 · modulo/escenas--08 · fondo
