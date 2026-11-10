# Encargo <ID> · <x> · cierre del tramo <N>
- Partida: rama modulo/<x>--<ID> desde modulo/<x>@<sha7> · <AAAA-MM-DDTHH:MM±HH:MM>
- Spec: docs/modulos/<x>/SPEC[-N].md:<línea>[-<línea>]
- Skill: obrero
- Modelo: sonnet · Esfuerzo: low · Por qué: documentación
- Riesgo: bajo · Por qué: no toca código
- Apertura: director
- Suscripción: —
<!-- El obrero de cierre de tramo (SPEC-paquete-8c c1): el director lo copia como cualquier encargo (paso 3 de /director), lo lanza,
lo verifica y lo mergea; nunca escribe la ficha él. Cuándo: lo dice `- Cierre de tramo:` de la ficha (sin el renglón, cada encargo).
Llená <x>, <ID>, <N> (el tramo que se cierra: el de `- Tramo:` + 1, o 1 si no está), la Partida (la línea de `encargo.cjs partida`)
y el Spec (la línea de la Ejecución que cita este tramo). Con `carpeta-docs:` en la ficha, `docs/` es esa carpeta en todo el encargo. -->
## Toca
- docs/modulos/<x>/README.md
- docs/modulos/<x>/bitacora/**
- docs/modulos/<x>/tiempos.md
## Alcance
1. `node .claude/scripts/tiempos.cjs tiempos <x>` (escribe `tiempos.md` desde git) y `node .claude/scripts/tiempos.cjs contador <x>` (sub-pasos y desvíos; nunca frena).
2. La ficha, de lo que dicen git, esos dos y este encargo (nunca de memoria): cada tarea del tramo tildada con su commit; `- Próximo paso:` uno, concreto; `- Tramo: <N> cerrado <AAAA-MM-DD>` (hoy); Parado y Te espera al día; `## Sesiones vivas` con las de abajo (`- <nombre> · <id de sesión o —> · <ruta> · <rama> · <modo>`).
3. La bitácora del tramo, `docs/modulos/<x>/bitacora/<AAAA-MM-DD>-tramo-<N>.md`: los encargos cerrados con su merge, los desvíos del contador y las alarmas de abajo.
4. Si son las 18 h o más: `node .claude/scripts/resumen.cjs <x>` (el resumen del día, en la bitácora).
- Sesiones vivas (las pasa el director): <una por renglón, o —>
- Alarmas de los CIERRE del tramo (`tiempos.cjs alarma`: más de 3 intervenciones del dueño), tal cual: <sus líneas, o —>
## NO SE TOCA
- El código del proyecto.
- La carpeta de papeles fuera de `docs/modulos/<x>/`.
- `.claude/`.
## AUTORIZADO
- Bash(node .claude/scripts/tiempos.cjs tiempos <x>)
- Bash(node .claude/scripts/tiempos.cjs contador <x>)
- Bash(node .claude/scripts/resumen.cjs <x>)
## GATE
- `node .claude/scripts/estructura.cjs raiz rutas topes mesa estados lecturas barreras datos`
<!-- el candado, si está prendido (`piezas.candado` de la ficha no es `no`); si no, el renglón es - (nada). Sin estado-viejo: mira el
"## Próximo paso" del handoff de la rama por defecto, que en modulo/<x> no cambia y que este obrero no toca (chequeo frío de la rc.6). -->
