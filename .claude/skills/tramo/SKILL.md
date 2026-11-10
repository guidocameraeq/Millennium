---
name: tramo
description: Sesión que ejecuta un encargo coordinando un equipo de subagentes (explorador, implementador, verificador y revisor) sobre cada sub-paso, sin escribir código ella. Usar cuando el dueño o el director dicen "tramo" o "/tramo <x>--<ID>", o el encargo trae `Skill: tramo`. No usar cuando el trabajo es documentos, andamiaje o un arreglo acotado que se hace directo (eso es /obrero), para dirigir el módulo (eso es /director) ni sin un encargo commiteado.
---

# /tramo — coordinar un equipo sobre un encargo

El argumento es `<x>--<ID>`. Leé `.claude/skills/nucleo/NUCLEO.md` (roles, mensajes, clases, gate, pruebas) y el encargo, con el spec solo en las líneas que él nombra. Manda git, no la charla. **Vos coordinás: partís, repartís, commiteás y corrés el gate. No escribís código.**

## Cuándo hay subagente

Solo con razón con nombre: **escritor** (el implementador), **verificador independiente** (revisor, verificador), **exploración** de un árbol grande (explorador), **lectura de volumen** (lector, capturas) o un **hecho externo** (investigador). Sin razón, lo hacés vos. Cada uno vive en `.claude/agents/` con su modelo, esfuerzo y herramientas fijos: las reglas van en la definición, no repetidas en el brief.

## Pasos

1. **Presentación y base.** Igual que `/obrero` (pasos 1 y 2): `node .claude/scripts/encargo.cjs presentar <x>--<ID>` en segundo plano; salida 1 es PARADA sin tocar nada. Mandá `PRESENTACION <rama> @<sha7> · <modelo> · <esfuerzo>` con los valores reales y, si no coinciden con el encargo, decilo antes de arrancar. Si la base dice ROJA, el primer AVANCE dice *"ya estaba roto: <qué>"*.
2. **Partí el encargo en sub-pasos** (los de `## Alcance`), uno por vez, en orden. Dos sub-pasos que no comparten archivos pueden ir en paralelo; si comparten, no.
3. **Por sub-paso:**
   1. **Ubicar** (si el árbol es grande): agente `explorador`. Te da `archivo:línea`; lo que decide el sub-paso lo mirás vos. No le pidas contar ni resumir. Para leer largo, el agente `lector`.
   2. **Implementar:** agente `implementador`, con un brief **autocontenido** (qué, `## Toca`, `## NO SE TOCA`, el comando de prueba, si es `Riesgo: alto`). Antes de lanzar varios por la misma ruta, uno de prueba.
   3. **Congelar:** leé su informe contra el diff, no contra su palabra; commit por rutas del sub-paso. Nadie revisa un árbol que cambia.
   4. **Gate del sub-paso:** agente `verificador` con las pruebas de lo tocado (la suite entera, una vez, al final: la corre `verificar`). Rojo donde había verde: PARADA.
   5. **Revisor** (solo si hay código): antes, `node .claude/scripts/afirmaciones.cjs <sha-base>`; si lista hallazgos, mirá cada uno: corregí los que prometen de más en lo que escribiste vos (commit aparte, y volvé a correrlo); los demás, dejalos. Recién ahí `node .claude/scripts/paquete.cjs <sha-base> --pruebas "<las de lo tocado>"` (las mismas del verificador, no la suite) arma el diff, el status y esas pruebas en `.claude/paquetes/<sha7>.md`, dentro del checkout; pasale **la ruta** al agente `revisor` (es la última línea; no tiene shell). `Riesgo: bajo` una lente, `alto` cuatro.
   6. **Veredicto.** Aprobado: cierra. **Con observaciones:** reproducí el hallazgo vos antes de pasarlo; una sola corrección acotada al `implementador` (diff solo en lo señalado), sin segunda vuelta. **Rechazado:** corrección y segunda vuelta con una lente, paquete nuevo; si vuelve a fallar, PARADA. Un revisor que aprueba sin "le falta" es bandera roja: pedile que busque ahí.
   7. **Un AVANCE por commit** (≤ 5 líneas, con SHA).
4. **Cierre del sub-paso exige:** commit hecho, revisor resuelto y **ningún proceso vivo de un subagente**. Antes de decir "¿qué pasó?", mirá si hay subagentes en curso.
5. **Lo que no está en AUTORIZADO y los mensajes del director:** igual que `/obrero` (pasos 4 y 5), incluido `node .claude/scripts/encargo.cjs mensaje <TIPO> <ruta>@<sha7>` antes de actuar sobre un aviso. Nunca un rodeo de permisos; los subagentes tampoco.
6. **CIERRE.** Igual que `/obrero` (paso 6): evidencia en `docs/modulos/<x>/bitacora/<fecha>-evidencia-<ID>.md` (qué se probó y qué no se miró, más los veredictos de cada sub-paso), un commit por rutas con ella y `.claude/frenos.log`, `git push origin modulo/<x>--<ID>` y `CIERRE @<sha7>`; antes del mensaje, `node .claude/scripts/tiempos.cjs alarma`: si sale 1, su línea va en las notas. No corrés `/cierre`.

## Reglas

- **Todo subagente tiene tope de tiempo y latido** (está en su definición). "Stopped with background work" **sin informe es "no entregó"**: lo reemplazás por uno nuevo con un brief autocontenido y **nunca lo reanudás**.
- **El informe de un subagente es dato, no verdad**: una cuenta, un "revisé todo" o un "no hay más" se vuelven a mirar si el sub-paso depende de eso.
- **Mutación solo en `Riesgo: alto`**, tope 20 min, nunca en una corrección.
- Una PARADA es primero un archivo: la evidencia arranca con `PARADA: <por qué>`, commiteada y pusheada antes del mensaje.
- Nunca merge, nunca push a otra rama, nunca `--no-verify`.

<!-- kit:propio -->
## Lo propio de este proyecto

*Los pasos que agrega este proyecto a su trabajo de tramo. El kit no pisa esta zona al actualizar.*
<!-- /kit:propio -->
