---
name: estado
description: La vista corta del proyecto, o la de un módulo, armada por script: lo que le espera al dueño arriba, una línea por módulo activo con el avance medido, qué pestañas puede cerrar, las esperas con su fecha y el uso de contexto. Usar cuando el dueño dice "estado", "¿cómo vamos?", "¿qué me espera?", "¿en qué está el módulo X?" o "¿cómo terminamos?" (esta última trae también el resumen del día). No usar para retomar una sesión (eso es /inicio), para cerrarla (eso es /cierre) ni para decidir nada: solo informa y nunca pregunta.
---

# /estado — cómo vamos

Solo información. No decide, no pregunta cuál módulo, no frena nada: las cifras las calcula un script desde la ficha, `tiempos.md` y git, nunca la memoria de nadie.

## Pasos

1. **Elegir la vista, sin preguntar.** Con un nombre en el pedido (`/estado <x>`), o si esta pestaña es la de un módulo (la rama `modulo/<x>` o `modulo/<x>--NN` lo dice), corré `node .claude/scripts/estado.cjs <x>`. Si no, `node .claude/scripts/estado.cjs`: la vista corta del proyecto. Nunca preguntes "¿de cuál?". Si no hay `.kit-rol` (el rol es `humano`: el dueño), antes de la vista corré **siempre** `node .claude/scripts/noche.cjs volvi` (borra la marca de la noche que el director dejó en su worktree): si borró alguna, una línea; si dice que ya era de día, nada. Con otro rol, no lo corras.
2. **Mostrar la salida tal cual**, en ese orden: `TE ESPERA` primero. No la resumas, no la reordenes, no le sumes cifras. `avance —` quiere decir que la ficha no tiene tareas de dónde medir: dejalo así. `NO VERIFICADO` también se muestra como viene.
3. **El resumen del día, una sola vez.** Si la última línea dice `resumen del día: falta … corré: <comando>` (son las 18 h o más), o el dueño pregunta "¿cómo terminamos?", corré ese comando (`node .claude/scripts/resumen.cjs`, con el módulo si la línea lo trae) y mostralo. Si el script dice que el de hoy ya existe, decí dónde está y no lo repitas.
4. **Líneas propias.** Si el dueño pide "agregá tal línea al estado", sumá un renglón con esa frase, tal cual la dijo, a `.claude/estado-lineas.md` (se muestra siempre, en cualquier pestaña y PC). Quitarla es borrar el renglón.

## Reglas

- Lo que el dueño tiene que hacer está en `TE ESPERA` (de las fichas); no lo repitas al pie de nada.
- Las cifras salen del script. Si algo no cuadra con lo que ves en git, decíselo al dueño, no lo corrijas a mano.
- El uso (plan y contexto) es informativo: ningún tope frena ni cambia lo que hacés.

<!-- kit:propio -->
## Lo propio de este proyecto

*Las vistas y los avisos que agrega este proyecto. El kit no pisa esta zona al actualizar.*
<!-- /kit:propio -->
