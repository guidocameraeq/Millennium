---
name: obrero
description: Sesión obrera que ejecuta un encargo ya commiteado en su worktree. Se presenta con un script que para si el spec no tiene sello, trabaja por sub-paso con prueba en rojo primero y revisor, y cierra con evidencia y rama pusheada. Usar cuando el dueño o el director dicen "obrero" o "/obrero <x>--<ID>", o la línea de apertura de un encargo lo lanza. No usar para dirigir el módulo (eso es /director) ni sin un encargo commiteado.
---

# /obrero — ejecutar un encargo

El argumento es `<x>--<ID>`. Leé `.claude/skills/nucleo/NUCLEO.md` (roles, mensajes, clases, gate, pruebas) y el encargo que cita la presentación, con el spec solo en las líneas que él nombra. Manda git, no la charla.

## Pasos

0. **Entrar a tu worktree (una sola ventana).** Podés haber nacido en `main`. Antes de nada: `node .claude/scripts/worktree.cjs donde <x>--<ID>`. Si dice `entrar: <ruta>`, entrá con la herramienta `EnterWorktree` (`path` = esa ruta) y corré otra vez, con el script de `main` (el del worktree puede ser viejo), `node ../../../.claude/scripts/worktree.cjs donde <x>--<ID>`: tiene que decir `adentro:`. Cualquier otra salida → PARADA con su línea. **Hasta que diga `adentro:`, ningún comando más que la PARADA**: afuera los frenos te leen como el dueño. Nunca `ExitWorktree`.
1. **Presentación.** `node .claude/scripts/encargo.cjs presentar <x>--<ID>`, en segundo plano (corre la suite). **Salida 1: PARADA con lo que dice el script, sin tocar nada y sin commit** (rama equivocada, encargo no commiteado, "spec sin Arquitecto: corré Modo B"); si no podés mandar mensajes, terminá con la PARADA como última línea. Salida 0: mandá `PRESENTACION <rama> @<sha7> · <modelo> · <esfuerzo>` con los valores reales; si no coinciden con el encargo, decilo antes de arrancar.
2. **Chequeo base.** Si `base:` dice ROJA, el primer AVANCE dice *"ya estaba roto: <qué>"*. No lo arreglás vos salvo que el encargo lo pida.
3. **Por sub-paso**, en el orden de `## Alcance`: prueba en rojo primero, código, commit congelado, `node .claude/scripts/afirmaciones.cjs <sha-base>` (si lista hallazgos, mirá cada uno: corregí los que prometen de más en lo que escribiste vos —commit aparte, y volvé a correrlo—; los demás, dejalos), el agente `revisor` (solo si hay código), y una corrección acotada si dice "con observaciones". Segunda vuelta solo si "rechazado"; una tercera es PARADA. Un AVANCE por commit. Si el sub-paso es `Riesgo: alto`, la mutación va antes de cerrarlo (tope 20 min). Tocá solo lo de `## Toca`; un desvío es clase 1 y se avisa.
4. **Lo que no está en AUTORIZADO.** En la pestaña que abrió el dueño (en su modo), lo pedís y aparece la ventana (si entraste con `EnterWorktree` y la extensión no cargó el settings del worktree, AUTORIZADO no rige: vas a pedir más ventanas, nunca menos frenos). De fondo (`-p` en `auto`, o el respaldo en `acceptEdits`), nadie la contesta: lo que no está en la lista lo juzga `auto` o se niega, y los porteros niegan igual. **PARADA = se negó algo que el sub-paso necesita**, de fondo o con rol `nocturno`. Un comando compuesto negado se parte y se repite una vez. Nunca un rodeo: ni otra herramienta, ni tocar el `settings`, ni darte permisos.
5. **Mensajes del director.** Antes de actuar: `node .claude/scripts/encargo.cjs mensaje <TIPO> <ruta>@<sha7>`. Si da 1, lo anotás en tu evidencia y no lo ejecutás. Una CORRECCION `cancelado` → PARADA sin push y sin commit: el director borra tu worktree y tu rama.
6. **CIERRE.** Escribí la evidencia (`docs/modulos/<x>/bitacora/<fecha>-evidencia-<ID>.md`: qué se probó, con qué comando y su salida; qué no se miró). Un solo commit por rutas con la evidencia y `.claude/frenos.log`, `git push origin modulo/<x>--<ID>` por nombre, y el mensaje `CIERRE @<sha7>` con las notas para el método. Antes del mensaje corré `node .claude/scripts/tiempos.cjs alarma`: si sale 1 (más de 3 intervenciones del dueño), su línea va en las notas del CIERRE. Cada pendiente de las notas dice adónde va (TODO, el módulo, o "descartado: por qué"). No corrés `/cierre`: el director verifica y mergea.

## Reglas

- Una PARADA es primero un archivo: la evidencia arranca con `PARADA: <por qué>`, se commitea y se pushea antes del mensaje, salvo la PARADA de `presentar`, que no commitea (y la de un `cancelado`).
- Revisor: hasta 10 hallazgos, cada uno con su escenario del día normal. Los que no tienen escenario se descartan.
- Nunca merge, nunca `--no-verify`, nunca push a otra rama: a `main` sube solo el director, y el pre-push lo frena.

<!-- kit:propio -->
## Lo propio de este proyecto

*Los pasos que agrega este proyecto a su trabajo de obrero. El kit no pisa esta zona al actualizar.*
<!-- /kit:propio -->
