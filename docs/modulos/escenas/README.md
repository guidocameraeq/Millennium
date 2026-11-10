# Escenas de Displays más fáciles de armar
- Estado: EN OBRA
- director: sí
- rama: modulo/escenas
- Próximo paso: esperar a que puesta-a-punto se mergee a main; después, el director arma el encargo 00 (contrato y gate)
- Cierre de tramo: cada 2 encargos

## Qué es
Pedido del 2026-11-10: crear escenas sin tenerlas aplicadas, duplicarlas y cambiarlas, en una pantalla de escenas más clara que muestre de un vistazo qué hace cada una. Suma resolución por pantalla, acciones nuevas (cerrar programa, esperar, HDR, Steam/Chrome de una lista), escenas en la bandeja, "puesta ahora" y emoji. Lo corre un director con obreros, de noche.

## Fase y próximo paso
Spec en `SPEC.md` y pantalla aprobada en `prototipo/index.html`. Arranca después del refactor de `puesta-a-punto` (parte `lib.rs`, `main.js` y `styles.css`).

## Tareas
- [ ] 00 Contrato de comandos + mock + gate
- [ ] 01 Escenas en papel (guardar desde borrador, duplicar, renombrar, orden, emoji, checkpoint)
- [ ] 02 Resoluciones por pantalla (modos recordados)
- [ ] 03 Acciones nuevas + cola + listas de Steam/Chrome (sin HDR)
- [ ] 04 Puesta ahora + bandeja
- [ ] 03b HDR (último; necesita la prueba de Guido en la TV)
- [ ] 05 Pestaña ESCENAS contra el mock
- [ ] 06 Cablear la pantalla a los comandos reales

## Decisiones cerradas
(ver `SPEC.md`, Riesgos y decisiones)

## Pendientes y "te espera"
- Guido, de día: probar en sus pantallas y la TV (criterios 1, 3, 4, 5 y 6) y decidir la versión nueva.

## Sesiones vivas
