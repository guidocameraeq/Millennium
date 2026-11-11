# Escenas de Displays más fáciles de armar
- Estado: EN OBRA
- director: sí
- rama: modulo/escenas
- Próximo paso: corre el 02 resoluciones; después 03 acciones nuevas
- Tramo: 1 cerrado 2026-11-10
- Cierre de tramo: cada 2 encargos

## Qué es
Pedido del 2026-11-10: crear escenas sin tenerlas aplicadas, duplicarlas y cambiarlas, en una pantalla de escenas más clara que muestre de un vistazo qué hace cada una. Suma resolución por pantalla, acciones nuevas (cerrar programa, esperar, HDR, Steam/Chrome de una lista), escenas en la bandeja, "puesta ahora" y emoji. Lo corre un director con obreros, de noche.

## Fase y próximo paso
Spec en `SPEC.md` y pantalla aprobada en `prototipo/index.html`. Tramo 1 cerrado (00, 01, 05); sigue el carril backend con el 02.

## Tareas
- [x] 00 Contrato de comandos + mock + gate (merge 562f41b)
- [x] 01 Escenas en papel (guardar desde borrador, duplicar, renombrar, orden, emoji, checkpoint) (merge f7fea45)
- [ ] 02 Resoluciones por pantalla (modos recordados)
- [ ] 03 Acciones nuevas + cola + listas de Steam/Chrome (sin HDR)
- [ ] 04 Puesta ahora + bandeja
- [ ] 03b HDR (último; necesita la prueba de Guido en la TV)
- [x] 05 Pestaña ESCENAS contra el mock (merge 56aa8e3)
- [ ] 06 Cablear la pantalla a los comandos reales

## Decisiones cerradas
(ver `SPEC.md`, Riesgos y decisiones). Del tramo 1:
- El gate de CLIP ignora la sección Displays.
- `capturar.cjs --comparar` captura en temporal (la corrección 00 la absorbió el 05).
- PROBAR con las pantallas ya iguales no cambia el sonido (no hay cuenta regresiva que lo devuelva).
- Frecuencia 0 solo se rechaza con resolución elegida.

## Parado
- Nada.

## Te espera
- Guido, de día: probar en la app real lo que no se pudo sin monitores: PROBAR no marca escena pendiente, renombrar sigue a la escena puesta, aviso de prueba, atajo que no se registra, arrastrar tarjetas y pantallas.
- Guido, de día: probar en sus pantallas y la TV (criterios 1, 3, 4, 5 y 6) y decidir la versión nueva.

## Pendientes para el 06
- El banco no guarda argumentos de `invoke`.
- Vistas sin ejercer: renombrar→AJUSTES, volumen vacío, juego sin lista, BORRAR que falla, nombre repetido, renombrar durante una prueba.
- En el lienzo del editor las pantallas apagadas se apilan una sobre otra.
- El selector de emoji se ve chiquito.

## Sesiones vivas
- director-escenas · local (sesión de Arquitecto que pasó a director) · .claude/worktrees/modulo--escenas · modulo/escenas · auto
- obrero 02 (resoluciones) · — · .claude/worktrees/modulo--escenas--02 · modulo/escenas--02 · fondo
