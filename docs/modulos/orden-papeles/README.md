# Ordenar los papeles y la raíz
- Estado: EN OBRA
- director: no
- Próximo paso: ejecutar el SPEC.md en un chat nuevo (está READY)

## Qué es
Pedido del 2026-11-10: dejar los docs (`CLAUDE.md`, NORTE, MAPA, TODO, specs viejos) y la raíz del repo al día con el combo Clipboard + Displays, sin tocar código. Prepara el terreno para la sesión que ordenará el código por dentro, que se planea aparte.

## Fase y próximo paso
Diseño sellado; falta la ejecución (una sesión).

## Tareas
- [ ] `CLAUDE.md` al día con el combo (reglas intactas)
- [ ] `docs/MAPA.md` completo
- [ ] `docs/TODO.md` ordenado por prioridad, sin pendientes perdidos
- [ ] Archivar `SPEC-displays.md` y `remediation/windows/SPEC.md`; arreglar rutas del README de remediation
- [ ] Mover `_archive/mockup/` a `docs/archive/mockup/`; tabla de mudanza
- [ ] Corregir el handoff (nombre y carpeta)

## Decisiones cerradas
- SPEC-displays se cierra; las 3 pruebas físicas pasan al TODO (Guido).
- `_archive/mockup` va a `docs/archive/mockup/` (Guido).
- El código por dentro queda fuera: sesión aparte, a planear (Guido).

## Pendientes y "te espera"
- Planear el módulo de ordenar el código (ahí se cambia `vars.comando-test` por el `cargo test` real).
