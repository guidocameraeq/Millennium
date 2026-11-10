---
name: cierre
description: Ritual de cierre de sesión del proyecto. Cruza lo anunciado con lo anotado, deja handoff, TODO y CHANGELOG al día, corre los chequeos y commitea por rutas. Usar cuando el dueño dice "cierre", "cerrá la sesión", "guardá todo", "voy a comprimir", "compact ya" o "cierre parcial". No usar cuando "cierre" es parte del trabajo (cierre de mes, de caja).
---

# /cierre — cerrar la sesión (después el chat se descarta)

Dos modos: **`cierre`** (completo) y **`cierre parcial`** (el contexto se llenó a mitad de la misión; al final).

**Proponelo vos, en una línea, cuando pasa una de tres**: la tarea pedida quedó hecha y verificada · el contexto se está llenando · el dueño dice que se va. La línea dice qué surgió en la charla y dónde quedó anotado (TODO, ficha). No cierres sola: proponé.

**Sin `node`, o si un script no imprime nada o sale con un código que no es el esperado: no se commitea.** Decí cuál y por qué.

## Pasos (modo completo, en este orden)

`docs/` es la carpeta de papeles: la `carpeta-docs:` de la ficha si la hay (el arranque la nombra en `papeles:`).

1. **¿Cambió algo?** `git status --short` (ignorá `.claude/frenos.log`, que los hooks ensucian) y los commits desde el último que tocó el handoff. Nada → una línea, *"Nada que cerrar"*, y terminá sin tocar el handoff.
2. **Cruce anunciado contra anotado.** Cada pendiente que el handoff nombra tiene su ítem en el TODO o en la ficha de su módulo, y en uno solo (ninguno huérfano: cada pendiente dice adónde va, TODO, un módulo, o *"descartado: por qué"*); cada 🔴 que el handoff da por resuelto se borra; cada tarea terminada está tildada en la ficha con su commit. Si se tocó un entorno externo, verificá su estado real: la realidad gana.
3. **Docs al día, leyendo lo mínimo.** Del CHANGELOG y de `docs/referencia/DECISIONS.md`, solo las primeras 20 líneas; del TODO, la cabecera y los ítems que tocaste. Entero, solo el handoff y las fichas.
   - `docs/SESSION_HANDOFF.md`: sobreescribilo entero, secciones fijas y en este orden: `# Handoff — <proyecto>` · `## Estado` (`- Rama · entorno: …`, accesos temporales a producción con su fecha de borrado, y `- Producción: <estado> · <fecha> · <cómo se verificó>`, o `REPORTADO POR EL USUARIO`, o `no hay`) · `## Próximo paso` (una acción ejecutable, nunca "seguir avanzando") · `## Bloqueos` · `## Te espera` (`node .claude/scripts/cambios.cjs listar --te-espera`, las `.claude/fusiones/*.md` sin responder y lo que decide el dueño) · `## En curso` · `## Contexto`. Sin "Qué se hizo", "Archivos tocados" ni "Cierre:". **Tope 5.000 bytes** (`wc -c`): lo que no entra va al CHANGELOG, las trampas a `docs/referencia/trampas.md`, los pendientes al TODO.
   - `docs/CHANGELOG.md`: entrada nueva al tope, `## AAAA-MM-DD — <tema>`; con `## [Unreleased]`, renglones en su `### Método (kit)` (o donde diga la zona propia), sin `## AAAA-MM-DD`. **Primer `/cierre` después de las 18 h:** el resumen del día, `node .claude/scripts/resumen.cjs [<x>]` (con módulo con director, lo escribe en su `bitacora/`; sin director, imprime el bloque y va pegado a esta entrada). Si dice que el de hoy ya se mostró y el bloque hace falta para la entrada, `--forzar`.
   - `docs/TODO.md`: lo completado sale; lo nuevo entra bajo su 🔴 🟠 🟡 🟢. Sin fechas a mano.
   - Ficha del módulo en que trabajaste: `Estado:` y `Próximo paso:` al día. Con código nuevo desde el cierre anterior, el candado exige que cambien el Próximo paso del handoff y el `Estado:` de la ficha.
   - ADR en `docs/referencia/DECISIONS.md` (+ su línea en el índice) si hubo decisión con alternativas; `docs/referencia/REJECTED.md` si se descartó algo. Si cambió un hecho estructural, la memoria persistente. Si la sesión cambió cómo trabaja el proyecto (un freno, una regla, un paso de un ritual), lo anota: `node .claude/scripts/cambios.cjs nuevo --slug <s> --clase 2|3-barrera --toca <a,b> --origen "<qué pasó>"` (el cuerpo por la entrada estándar). Una lección del método va al TODO, para el dueño: el kit no se edita desde acá.
   - Si lo chico creció y ya lleva dos sesiones, crear el módulo desde acá llega con un kit posterior: por ahora anotalo en el TODO y avisale al dueño.
4. **Los chequeos, en este orden** (desde la raíz; ninguno commitea):
   1. `node .claude/scripts/todo.cjs cierre` → poda el TODO e imprime `TODO: +n −m · k ítems · j bajaron a 🟢`. Mostrala.
   2. `node .claude/scripts/agents.cjs generar` → escribe `AGENTS.md` solo si la ficha pide `multi-llm: sí`. Salida 1: hay un `AGENTS.md` ajeno que no se pisa; avisalo y dejalo afuera del commit.
   3. `node .claude/scripts/cambios.cjs verificar` → cada falla es `id · qué pasa · qué hacer`: hacelo y volvé a correr.
   4. `node .claude/scripts/estructura.cjs todo` → el candado. Rojo (salida 1, una línea `candado:<id> · qué pasa · qué hacer` por falla): arreglalo y **volvé a correrlo; nunca commitees encima de un rojo**. `candado:barreras` no lo arregla la sesión: pide un cambio aprobado por el dueño. `cambios aprobar` lo corre la sesión cuando el dueño lo pide, y su clic en la ventana es la firma; nunca por su cuenta.
5. `git fetch` y `git status -sb`: ¿origin avanzó? Si sí, el push va a pedir traerlo con `git pull --rebase` (paso 10).
6. **Commit por rutas**, nunca el árbol entero: `git add -- <cada archivo que tocó esta sesión> .claude/frenos.log` (el handoff, el CHANGELOG, el TODO, `AGENTS.md` si se generó; el log, si existe), mostrá `git status --short` (lo que quedó afuera, decí por qué) y `git commit -m "docs: cierre de sesión AAAA-MM-DD — <tema>" -- <las mismas rutas>`. **Si el pre-commit frena** (gitleaks con `archivo:línea`, `candado:barreras`, el hook previo), se arregla lo que dice y se vuelve a commitear: **nunca `--no-verify`** (el pre-push lo caza igual). Si avisa *"⚠️ sin escáner en esta PC"*, va al reporte.
7. **¿Quedó consumido un `aprobado`?** Si el commit tocó lo que un cambio aprobado declara en `toca` (`node .claude/scripts/cambios.cjs listar` los muestra): `node .claude/scripts/cambios.cjs anotar-sha <id> <sha del commit>` y otro commit por rutas con el archivo del cambio y `.claude/frenos.log`.
8. `node .claude/scripts/cambios.cjs verificar` de nuevo: tiene que dar verde.
9. **Push público.** Si la ficha (`.claude/kit.md`) dice `push-publica: sí`, una línea antes de pushear: *"este repo es público: lo que sube lo ve cualquiera"*. No preguntes.
10. `git push`. Si falla porque origin avanzó: `git pull --rebase`, **nunca un pull con merge sobre la rama por defecto** (un merge deja el sello fuera de la historia de primer padre y el `aprobado` queda en rojo). Si el rebase reescribió el commit de un `aplicado`, `cambios.cjs verificar` lo dice con el `anotar-sha` listo: correlo, commit por rutas con el archivo del cambio y pusheá. Si el conflicto no es trivial, pará y avisá. Nunca `--force`. Si el pre-push frena, como el pre-commit: se arregla, nunca `--no-verify`.
11. **Reporte**: SHA · archivos actualizados · próximo paso · bloqueos · *"Chat listo para descartar: la próxima misión arranca con /inicio en un chat nuevo."*

## Cierre parcial

Contexto lleno a mitad de misión: `node .claude/scripts/estructura.cjs parcial`, el handoff al día (el trabajo a medias en `## En curso`, el próximo paso concreto) y commit por rutas como el paso 6. Sin push, sin CHANGELOG. Avisá *"listo para /compact"*; el hook re-inyecta el handoff después, y asumí que no leíste ningún archivo.

## Reglas

- Cambios que el dueño no quiere commitear: commit selectivo, o quedan sin commitear y anotados en `## En curso`.
- Drift entre el entorno y el repo sin resolver: va al handoff como primer paso de la próxima sesión.

<!-- kit:propio -->
## Lo propio de este proyecto

*Los pasos que agrega este proyecto a su cierre. El kit no pisa esta zona al actualizar.*
<!-- /kit:propio -->
