# Ordenar los papeles y la raíz
- Estado: COMPLETO 2026-11-10
- director: no

## Qué es
Pedido del 2026-11-10: dejar los docs y la raíz del repo al día con el combo Clipboard + Displays, sin tocar código. Preparó el terreno para la sesión que ordenará el código por dentro (a planear con el Arquitecto; está en el TODO).

## Qué hizo
- `CLAUDE.md`, `docs/NORTE.md` y `docs/MAPA.md` describen la app de hoy.
- `docs/TODO.md` ordenado solo por prioridad, con etiquetas [Clipboard]/[Displays]/[Android]/[General].
- Specs terminados en `docs/archive/`; las rutas viejas se leen en la tabla de `docs/README.md`.

## Qué no tocó
Código, workflows, `README.md`, `docs/CHANGELOG.md` (salvo su entrada), `docs/DECISIONS.md`, `docs/remediation/android/` y `00-SHARED-CONTEXT.md`.

## Decisiones cerradas
- SPEC-displays cerrado; sus 3 pruebas físicas pasaron al TODO (Guido).
- `_archive/mockup` va a `docs/archive/mockup/` (Guido).
- El ítem del CI con docs **no** se borró (el spec lo daba por muerto): `build.yml` sigue corriendo con cada push a `main`; quedó reescrito.
